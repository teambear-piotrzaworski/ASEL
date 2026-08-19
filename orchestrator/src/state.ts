/**
 * Run state, persisted in SQLite on the `state` volume.
 *
 * Three guarantees required by the spec:
 * 1. Never two concurrent runs for the same issue. Enforced by a partial
 *    unique index on (repo, issue) WHERE status = 'running', so the guarantee
 *    holds at the database level and not only in application code.
 * 2. Never two concurrent runs for the same plan, because every run of a plan
 *    commits to the same branch. Same mechanism, on `plan_key`.
 * 3. A restart loses nothing and duplicates nothing. Runs left in `running`
 *    after a crash are marked `interrupted` at startup; the trigger labels are
 *    still on the issues, so the next poll re-triggers them.
 */
import Database from "better-sqlite3";
import type { RunKind } from "./machine.js";

/**
 * "blocked" is a finished run like the other two: the agent ran cleanly and
 * stopped on a question for a human. It is kept apart from "failed" so the run
 * history says whether the factory broke or whether it was waiting for us.
 */
export type RunStatus = "running" | "succeeded" | "failed" | "blocked" | "interrupted";

export interface RunRecord {
  id: number;
  repo: string;
  issue: number;
  kind: RunKind;
  status: RunStatus;
  triggerLabel: string;
  /** Plan the run belongs to, null for runs that stand on their own. */
  planKey: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  result: string | null;
}

interface RunRow {
  id: number;
  repo: string;
  issue: number;
  kind: string;
  status: string;
  trigger_label: string;
  plan_key: string | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  result_json: string | null;
}

function toRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    repo: row.repo,
    issue: row.issue,
    kind: row.kind as RunKind,
    status: row.status as RunStatus,
    triggerLabel: row.trigger_label,
    // Rows written before the plan branch model have no plan key at all.
    planKey: row.plan_key ?? null,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    result: row.result_json,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repo          TEXT    NOT NULL,
  issue         INTEGER NOT NULL,
  kind          TEXT    NOT NULL,
  status        TEXT    NOT NULL,
  trigger_label TEXT    NOT NULL,
  started_at    TEXT    NOT NULL,
  finished_at   TEXT,
  error         TEXT,
  result_json   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_issue
  ON runs (repo, issue) WHERE status = 'running';

CREATE INDEX IF NOT EXISTS runs_repo_issue ON runs (repo, issue);
CREATE INDEX IF NOT EXISTS runs_status ON runs (status);
`;

/**
 * Indexes that depend on a column added by a migration, so they are created
 * after it. Existing databases carry plan_key = NULL on every old row, and NULL
 * plan keys are excluded from the unique index, so the migration cannot fail on
 * historical data.
 */
const PLAN_SCHEMA = `
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_plan
  ON runs (plan_key) WHERE status = 'running' AND plan_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS runs_plan_key ON runs (plan_key);
`;

export class StateStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
    this.db.exec(PLAN_SCHEMA);
  }

  /** Additive migrations only, so an existing state volume survives an upgrade. */
  private migrate(): void {
    const columns = this.db.prepare(`PRAGMA table_info(runs)`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "plan_key")) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN plan_key TEXT`);
    }
  }

  /**
   * Registers a new run. Returns the run id, or null when another run for the
   * same issue, or for the same plan, is already active (the dedup guarantee).
   * `planKey` is null for runs that belong to no plan: the fast track and task
   * issues written by hand without an ASEL_EPIC marker.
   */
  startRun(
    repo: string,
    issue: number,
    kind: RunKind,
    triggerLabel: string,
    planKey: string | null,
  ): number | null {
    try {
      const info = this.db
        .prepare(
          `INSERT INTO runs (repo, issue, kind, status, trigger_label, plan_key, started_at)
           VALUES (?, ?, ?, 'running', ?, ?, ?)`,
        )
        .run(repo, issue, kind, triggerLabel, planKey, new Date().toISOString());
      return Number(info.lastInsertRowid);
    } catch (error) {
      const code = (error as { code?: string }).code ?? "";
      if (code.startsWith("SQLITE_CONSTRAINT")) {
        return null;
      }
      throw error;
    }
  }

  finishRun(
    id: number,
    status: Exclude<RunStatus, "running">,
    options: { error?: string; result?: unknown } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE runs
            SET status = ?, finished_at = ?, error = ?, result_json = ?
          WHERE id = ?`,
      )
      .run(
        status,
        new Date().toISOString(),
        options.error ?? null,
        options.result === undefined ? null : JSON.stringify(options.result),
        id,
      );
  }

  activeRuns(): RunRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE status = 'running' ORDER BY id`)
      .all() as RunRow[];
    return rows.map(toRecord);
  }

  activeRunCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE status = 'running'`).get() as {
      n: number;
    };
    return row.n;
  }

  activeRunCountForRepo(repo: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM runs WHERE status = 'running' AND repo = ?`)
      .get(repo) as { n: number };
    return row.n;
  }

  /** Issue numbers of the runs currently active in one repository. */
  activeIssuesForRepo(repo: string): number[] {
    const rows = this.db
      .prepare(`SELECT issue FROM runs WHERE status = 'running' AND repo = ?`)
      .all(repo) as Array<{ issue: number }>;
    return rows.map((row) => row.issue);
  }

  /**
   * Plans with an active run, across every project. One plan is one branch, so
   * a plan listed here must not get a second run started against it.
   */
  activePlanKeys(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT plan_key FROM runs WHERE status = 'running' AND plan_key IS NOT NULL`,
      )
      .all() as Array<{ plan_key: string }>;
    return rows.map((row) => row.plan_key);
  }

  hasActivePlanRun(planKey: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS hit FROM runs WHERE status = 'running' AND plan_key = ?`)
      .get(planKey) as { hit: number } | undefined;
    return row !== undefined;
  }

  hasActiveRun(repo: string, issue: number): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS hit FROM runs WHERE status = 'running' AND repo = ? AND issue = ?`)
      .get(repo, issue) as { hit: number } | undefined;
    return row !== undefined;
  }

  lastRunForIssue(repo: string, issue: number): RunRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM runs WHERE repo = ? AND issue = ? ORDER BY id DESC LIMIT 1`)
      .get(repo, issue) as RunRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  /**
   * Startup reconciliation: everything still marked running belongs to a
   * process that no longer exists. Returns the affected runs so the caller can
   * log and comment on them.
   */
  markInterruptedRuns(): RunRecord[] {
    const stale = this.activeRuns();
    if (stale.length === 0) {
      return [];
    }
    this.db
      .prepare(
        `UPDATE runs
            SET status = 'interrupted', finished_at = ?, error = 'orchestrator restarted during run'
          WHERE status = 'running'`,
      )
      .run(new Date().toISOString());
    return stale;
  }

  close(): void {
    this.db.close();
  }
}
