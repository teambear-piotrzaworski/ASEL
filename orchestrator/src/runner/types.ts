/**
 * Run execution layer.
 *
 * The orchestrator never talks to Wayfinder or Sandcastle directly: it talks
 * to these interfaces. That keeps the state machine testable (DryRun
 * implementation) and lets the real adapters land in slice 3 without touching
 * the scheduler.
 *
 * One interface per run kind, because one run kind = one agent = one context
 * window. Every run of one plan (adr, prd, slices, tasks and the implementation
 * of every task derived from them) shares ONE branch; only runs that belong to
 * no plan (fast track, task issues without an ASEL_EPIC marker) get a branch of
 * their own. No run opens a pull request.
 */
import type { ProjectConfig } from "../config.js";
import type { IssueRole } from "../machine.js";
import type { Logger } from "../logger.js";

export interface RunIssue {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
}

export interface RunContext {
  project: ProjectConfig;
  /** "owner/name" */
  repo: string;
  issue: RunIssue;
  role: IssueRole;
  triggerLabel: string;
  /**
   * True when a human hung `asel:rework` on the issue: the same step runs
   * again, this time reading the review comments and correcting what is already
   * on the branch instead of starting over.
   */
  isRework: boolean;
  /** Working copy for this run, derived from the bare mirror in the repos volume. */
  repoPath: string;
  /**
   * Branch the run lands its commits on, and pushes to origin at the end.
   * Deterministic: every run of one plan gets the same name, so each run
   * continues the branch the previous ones left behind.
   */
  branch: string;
  /**
   * Epic issue whose plan this run belongs to, null when the run stands alone
   * (fast track, or a task issue without the ASEL_EPIC marker).
   */
  epicIssue: number | null;
  /** Slice number of a task issue, null when the issue carries no marker. */
  slice: number | null;
  log: Logger;
}

export interface RunResultBase {
  /** True only when the run delivered and the pipeline may move on. */
  ok: boolean;
  /**
   * True when the run finished CLEANLY but left a question for a human. The
   * agent asked it in a comment on the issue; the orchestrator hangs
   * `asel:blocked` and waits for an answer plus `asel:rework`. Never set
   * together with `error`: nothing went wrong here.
   */
  blocked?: boolean;
  /** One line summary, posted as an issue comment and used in push text. */
  summary: string;
  error?: string;
}

export interface WayfinderResult extends RunResultBase {
  /** Issue number of the Wayfinder map, when one was created. */
  mapIssueNumber?: number;
  /** Number of open decision tickets waiting for humans. */
  decisionCount?: number;
}

export interface AdrResult extends RunResultBase {
  /** Number of architecture decision records written. */
  adrCount?: number;
  /** Branch the agent reported pushing. */
  branch?: string;
}

export interface PrdResult extends RunResultBase {
  /** Number of files written under docs/prd. */
  prdFileCount?: number;
  branch?: string;
}

export interface SlicesResult extends RunResultBase {
  /** Number of vertical slices the plan was split into. */
  sliceCount?: number;
  branch?: string;
}

export interface TasksResult extends RunResultBase {
  /** Issue numbers of the created implementation tasks. */
  taskIssueNumbers?: number[];
  /** Number of slices those tasks were derived from. */
  sliceCount?: number;
}

/**
 * Phases of one implementation run. They all happen INSIDE the adapter, in one
 * container and on one worktree, so the orchestrator never learns about them:
 * `runImplement` stays a single call that either delivered or did not.
 *
 * - `red`    the agent writes tests only, and the harness requires them to fail
 * - `green`  the agent implements until the harness sees the suite pass
 * - `review` code review, then the full substrate of declared checks
 * - `single` the fallback for a project with no test command to gate on
 */
export type ImplementPhase = "red" | "green" | "review" | "single";

/** What the phases did, for the issue comment and the log. */
export interface ImplementPhaseReport {
  mode: "tdd" | "single-phase";
  /** The phase the run ended in, whether it delivered or stopped. */
  lastPhase: ImplementPhase;
  greenIterations: number;
  /** Substrate commands the orchestrator ran, with their exit codes. */
  checks: Array<{ name: string; exitCode: number }>;
}

export interface ImplementResult extends RunResultBase {
  branch?: string;
  commitCount?: number;
  phases?: ImplementPhaseReport;
}

/**
 * Result of a run that stopped on a question. `ok` is false because the
 * pipeline must not move on, but no error is set: nothing went wrong, the agent
 * asked a human and stopped, which is exactly what it was told to do. The
 * question itself is already a comment on the issue, posted by the agent.
 */
export function blockedResult(kind: string): RunResultBase {
  return {
    ok: false,
    blocked: true,
    summary: `The ${kind} stopped and asked a question, see the newest comment on this issue`,
  };
}

export interface WayfinderRunner {
  runWayfinder(context: RunContext): Promise<WayfinderResult>;
}

export interface AdrRunner {
  runAdr(context: RunContext): Promise<AdrResult>;
}

export interface PrdRunner {
  runPrd(context: RunContext): Promise<PrdResult>;
}

export interface SlicesRunner {
  runSlices(context: RunContext): Promise<SlicesResult>;
}

export interface TasksRunner {
  runTasks(context: RunContext): Promise<TasksResult>;
}

export interface ImplementRunner {
  runImplement(context: RunContext): Promise<ImplementResult>;
}

export interface Runners {
  wayfinder: WayfinderRunner;
  adr: AdrRunner;
  prd: PrdRunner;
  slices: SlicesRunner;
  tasks: TasksRunner;
  implement: ImplementRunner;
}
