/**
 * Plan identity and scheduling rules. One plan = one branch.
 *
 * A plan is everything that grows out of one epic issue: the ADRs, the PRD, the
 * sliced plan and every implementation task derived from it. All of that lands
 * on ONE branch, `asel/plan-<epic issue number>`. The orchestrator never opens
 * or merges pull requests: a human reads the commit history on the branch and
 * decides when and how to merge it into the default branch.
 *
 * Two consequences, both deliberate:
 *
 * 1. A task run has to find the branch of its plan. The orchestrator keeps no
 *    clone of the repository and never reads files out of it, so the link
 *    travels inside the task issue body as a marker line (`ASEL_EPIC: 42`).
 *    A task issue without that marker (a human wrote it by hand) falls back to
 *    a branch of its own, exactly like the fast track.
 * 2. Because every run of one plan shares one branch, at most ONE run per plan
 *    may be active at a time. Implementation is therefore sequential, ordered
 *    by the slice number carried in the issue body. Parallelism inside a plan
 *    is deliberately deferred.
 *
 * Everything in this file is pure: no GitHub, no SQLite, no clock. That is what
 * makes the branch layout, the marker parser and the scheduling rules testable.
 */
import type { IssueRole, RunKind } from "./machine.js";

/** Branch shared by every run of one plan. */
export const PLAN_BRANCH_PREFIX = "asel/plan-";

/** Branch used by runs that belong to no plan (fast track, orphan tasks). */
export const ISSUE_BRANCH_PREFIX = "asel/issue-";

/** Marker line written into every task issue by the tasks run. */
export const EPIC_MARKER_KEY = "ASEL_EPIC";

/** Marker line carrying the slice number, source of truth for ordering. */
export const SLICE_MARKER_KEY = "ASEL_SLICE";

export function planBranchFor(epicIssue: number): string {
  return `${PLAN_BRANCH_PREFIX}${epicIssue}`;
}

export function issueBranchFor(issueNumber: number): string {
  return `${ISSUE_BRANCH_PREFIX}${issueNumber}`;
}

/** Stable identity of a plan across repositories. */
export function planKeyFor(repo: string, epicIssue: number): string {
  return `${repo}#${epicIssue}`;
}

/** Dedup key of the existing "one run per issue" rule. */
export function issueKeyFor(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

export interface IssueMarkers {
  /** Epic issue backing the plan this issue belongs to. */
  epicIssue: number | null;
  /** Slice number, used to order the tasks of one plan. */
  slice: number | null;
}

const EPIC_PATTERN = /^asel[_-]?epic\s*[:=]\s*#?(\d{1,9})(?!\d)/i;
const SLICE_PATTERN = /^asel[_-]?slice\s*[:=]\s*#?(\d{1,9})(?!\d)/i;
/** Older tasks run wrote a bare "Slice: <n>" line; still accepted on read. */
const LEGACY_SLICE_PATTERN = /^slice\s*[:=]\s*#?(\d{1,9})(?!\d)/i;

/**
 * Strips the decoration a human (or an agent writing markdown) tends to put
 * around a marker line: list bullets, blockquote arrows, emphasis, backticks.
 * The marker is then matched at the start of what is left, so trailing prose
 * after the number is harmless.
 */
function stripDecoration(line: string): string {
  return line
    .replace(/^[\s>]+/, "")
    .replace(/^(?:[-*+]|\d{1,3}\.)\s+/, "")
    .replace(/[*_`]/g, "")
    .trim();
}

function matchNumber(line: string, pattern: RegExp): number | null {
  const match = pattern.exec(line);
  if (match === null) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Reads the markers out of an issue body. Line oriented on purpose: the markers
 * may sit anywhere in the body, a human may reorder or reword the text around
 * them, and a missing marker is a normal case, not an error. The first valid
 * occurrence wins.
 */
export function parseIssueMarkers(body: string): IssueMarkers {
  let epicIssue: number | null = null;
  let slice: number | null = null;
  let legacySlice: number | null = null;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = stripDecoration(rawLine);
    if (line === "") {
      continue;
    }
    if (epicIssue === null) {
      epicIssue = matchNumber(line, EPIC_PATTERN);
    }
    if (slice === null) {
      slice = matchNumber(line, SLICE_PATTERN);
    }
    if (legacySlice === null) {
      legacySlice = matchNumber(line, LEGACY_SLICE_PATTERN);
    }
  }

  return { epicIssue, slice: slice ?? legacySlice };
}

export interface PlanContext {
  /** Plan this run belongs to, null when the run stands on its own. */
  planKey: string | null;
  /** Epic issue backing that plan, null when the run stands on its own. */
  epicIssue: number | null;
  /** Branch the run commits to. */
  branch: string;
  /** Slice number of a task issue, null when there is no marker. */
  slice: number | null;
}

export interface PlanContextInput {
  /** "owner/name" */
  repo: string;
  issueNumber: number;
  issueBody: string;
  kind: RunKind;
  role: IssueRole;
}

/**
 * Branch and plan membership of a run.
 *
 * - wayfinder, adr, prd, slices, tasks: the issue IS the epic, so the plan
 *   branch comes from its own number. The wayfinder run writes issues rather
 *   than files, but it gets the same branch so it cannot leave an orphan one
 *   behind.
 * - implement on a task issue: the plan comes from the `ASEL_EPIC` marker. No
 *   marker means no plan, so the task gets a branch of its own and is not
 *   serialized against anything.
 * - implement on a fast issue: never part of a plan, always its own branch.
 */
export function planContextFor(input: PlanContextInput): PlanContext {
  if (input.kind !== "implement") {
    return {
      planKey: planKeyFor(input.repo, input.issueNumber),
      epicIssue: input.issueNumber,
      branch: planBranchFor(input.issueNumber),
      slice: null,
    };
  }

  if (input.role !== "task") {
    // Fast track: skips the pipeline, belongs to no plan, runs independently.
    return {
      planKey: null,
      epicIssue: null,
      branch: issueBranchFor(input.issueNumber),
      slice: null,
    };
  }

  const markers = parseIssueMarkers(input.issueBody);
  if (markers.epicIssue === null) {
    return {
      planKey: null,
      epicIssue: null,
      branch: issueBranchFor(input.issueNumber),
      slice: markers.slice,
    };
  }

  return {
    planKey: planKeyFor(input.repo, markers.epicIssue),
    epicIssue: markers.epicIssue,
    branch: planBranchFor(markers.epicIssue),
    slice: markers.slice,
  };
}

/** `ASEL_TASK_GATE=closed` is the emergency stop for task implementation runs. */
export function isTaskGateOpen(value: string | undefined): boolean {
  return (value ?? "open").trim().toLowerCase() !== "closed";
}

/** Everything the scheduling rules need to know about a pending run. */
export interface SchedulableRun {
  issueKey: string;
  issueNumber: number;
  planKey: string | null;
  kind: RunKind;
  role: IssueRole;
  slice: number | null;
}

/** Tasks without a slice marker sort after every numbered slice. */
const NO_SLICE = Number.MAX_SAFE_INTEGER;

/**
 * Ordering of pending runs inside one poll cycle:
 *
 * 1. pipeline runs (adr, prd, slices, tasks, wayfinder) before implementation
 *    runs, so a stage a human just unblocked is not starved by the tasks of an
 *    older plan
 * 2. implementation runs by slice number ascending, which is the execution
 *    order the slicing run wrote down
 * 3. ties broken by issue number ascending, so the order is deterministic
 */
export function compareRuns(a: SchedulableRun, b: SchedulableRun): number {
  const stageA = a.kind === "implement" ? 1 : 0;
  const stageB = b.kind === "implement" ? 1 : 0;
  if (stageA !== stageB) {
    return stageA - stageB;
  }
  const sliceA = a.slice ?? NO_SLICE;
  const sliceB = b.slice ?? NO_SLICE;
  if (sliceA !== sliceB) {
    return sliceA - sliceB;
  }
  return a.issueNumber - b.issueNumber;
}

export function sortRuns<T extends SchedulableRun>(runs: readonly T[]): T[] {
  return [...runs].sort(compareRuns);
}

export type SkipReason =
  | { code: "task_gate_closed" }
  | { code: "issue_busy" }
  | { code: "plan_busy"; planKey: string }
  | { code: "plan_stalled"; planKey: string; blockingIssue: number }
  | { code: "global_limit"; limit: number }
  | { code: "project_limit"; limit: number };

export function describeSkipReason(reason: SkipReason): string {
  switch (reason.code) {
    case "task_gate_closed":
      return "task gate is closed (ASEL_TASK_GATE=closed)";
    case "issue_busy":
      return "another run for this issue is already active";
    case "plan_busy":
      return `another run of plan ${reason.planKey} is active, one branch means one run at a time`;
    case "plan_stalled":
      return (
        `an earlier task (#${reason.blockingIssue}) of plan ${reason.planKey} failed or is ` +
        `blocked on a question, later slices wait until it is resolved`
      );
    case "global_limit":
      return `global concurrency limit reached (${reason.limit})`;
    case "project_limit":
      return `project concurrency limit reached (${reason.limit})`;
  }
}

/**
 * An open task issue that a run left stopped: it carries `asel:failed` or
 * `asel:blocked` and waits for a human. Such a task does not trigger anything
 * itself, but its EXISTENCE holds back every later slice of the same plan:
 * the slices build on one another, so running slice N on a branch where an
 * earlier slice is unresolved produces work that has to be reverted.
 */
export interface StalledTask {
  planKey: string;
  issueNumber: number;
  /** Slice marker of the stalled issue, null when it carries none. */
  slice: number | null;
}

export interface SchedulerSnapshot {
  /** Runs active across the whole factory. */
  activeTotal: number;
  /** Runs active in the project being polled. */
  activeInProject: number;
  /** Issue keys with an active run. */
  busyIssues: readonly string[];
  /** Plan keys with an active run. */
  busyPlans: readonly string[];
  /** Open plan tasks stopped on `asel:failed` or `asel:blocked`. */
  stalledTasks: readonly StalledTask[];
}

export interface SchedulerLimits {
  global: number;
  project: number;
  /** false = every task implementation run waits, whatever the rest says. */
  taskGateOpen: boolean;
}

export interface ScheduleDecision<T extends SchedulableRun> {
  run: T;
  start: boolean;
  reason?: SkipReason;
}

/**
 * The stalled task with the lowest (slice, issue) order that sits BEFORE the
 * run in its own plan. The comparison is strict, so the retry or rework of the
 * stalled issue itself is never held back by its own stop label.
 */
function stalledAhead(
  stalledTasks: readonly StalledTask[],
  run: SchedulableRun,
): StalledTask | null {
  const runSlice = run.slice ?? NO_SLICE;
  let ahead: StalledTask | null = null;
  for (const task of stalledTasks) {
    if (task.planKey !== run.planKey) {
      continue;
    }
    const taskSlice = task.slice ?? NO_SLICE;
    const isBeforeRun =
      taskSlice < runSlice || (taskSlice === runSlice && task.issueNumber < run.issueNumber);
    if (!isBeforeRun) {
      continue;
    }
    const aheadSlice = ahead === null ? NO_SLICE : (ahead.slice ?? NO_SLICE);
    if (
      ahead === null ||
      taskSlice < aheadSlice ||
      (taskSlice === aheadSlice && task.issueNumber < ahead.issueNumber)
    ) {
      ahead = task;
    }
  }
  return ahead;
}

/**
 * Decides which of the pending runs of ONE project may start now.
 *
 * Rules, applied in this order per run:
 * - task gate closed stops every task implementation run (emergency switch)
 * - one active run per issue (the existing dedup)
 * - one active run per plan, counting the epic runs and the task runs together,
 *   because all of them commit to the same branch
 * - a stalled plan starts no later task: while an earlier task of the plan is
 *   failed or blocked, only that task itself (its retry or rework) may run, so
 *   the factory stops instead of building later slices on a missing foundation
 * - the global and the per project concurrency limits, unchanged; the plan rule
 *   only tightens them inside a single plan
 *
 * Runs started here are accounted for immediately, so a second run of the same
 * plan in the same cycle waits instead of racing.
 */
export function scheduleRuns<T extends SchedulableRun>(
  runs: readonly T[],
  snapshot: SchedulerSnapshot,
  limits: SchedulerLimits,
): Array<ScheduleDecision<T>> {
  const busyIssues = new Set(snapshot.busyIssues);
  const busyPlans = new Set(snapshot.busyPlans);
  let activeTotal = snapshot.activeTotal;
  let activeInProject = snapshot.activeInProject;

  const decisions: Array<ScheduleDecision<T>> = [];
  for (const run of sortRuns(runs)) {
    const isTaskRun = run.kind === "implement" && run.role === "task";
    if (isTaskRun && !limits.taskGateOpen) {
      decisions.push({ run, start: false, reason: { code: "task_gate_closed" } });
      continue;
    }
    if (busyIssues.has(run.issueKey)) {
      decisions.push({ run, start: false, reason: { code: "issue_busy" } });
      continue;
    }
    if (run.planKey !== null && busyPlans.has(run.planKey)) {
      decisions.push({ run, start: false, reason: { code: "plan_busy", planKey: run.planKey } });
      continue;
    }
    if (isTaskRun && run.planKey !== null) {
      const blocking = stalledAhead(snapshot.stalledTasks, run);
      if (blocking !== null) {
        decisions.push({
          run,
          start: false,
          reason: {
            code: "plan_stalled",
            planKey: run.planKey,
            blockingIssue: blocking.issueNumber,
          },
        });
        continue;
      }
    }
    if (activeTotal >= limits.global) {
      decisions.push({ run, start: false, reason: { code: "global_limit", limit: limits.global } });
      continue;
    }
    if (activeInProject >= limits.project) {
      decisions.push({
        run,
        start: false,
        reason: { code: "project_limit", limit: limits.project },
      });
      continue;
    }

    busyIssues.add(run.issueKey);
    if (run.planKey !== null) {
      busyPlans.add(run.planKey);
    }
    activeTotal += 1;
    activeInProject += 1;
    decisions.push({ run, start: true });
  }
  return decisions;
}
