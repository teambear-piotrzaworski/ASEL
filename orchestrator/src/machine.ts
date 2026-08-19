/**
 * Label state machine.
 *
 * Every function here is pure: it takes labels in, gives decisions or label
 * updates out. No I/O, no GitHub calls, no clock. That is what makes the
 * lifecycle testable without a live repository.
 *
 * Issue roles:
 * - epic issue: the planning issue that walks the whole spec pipeline (and the
 *   fast shortcut)
 * - task issue: carries `asel:task`, created by the tasks run, implemented one
 *   by one via sandcastle
 *
 * Full flow (see SPEC.md, "Planning artifact pipeline"). Each stage is a
 * separate run, so each stage gets its own agent and its own context window,
 * and every stage of one epic commits to ONE branch (the plan branch). No
 * pull requests are involved: a human reviews the commits on that branch.
 *
 *   asel:plan            -> wayfinder run (map + decision tickets) -> asel:planned
 *   asel:approved        -> adr run    (docs/adr on the plan branch)-> asel:to-prd
 *   asel:to-prd          -> prd run    (docs/prd on the same branch)-> asel:spec-to-approve
 *   asel:spec-to-approve -> gate: a human reads the ADRs and the PRD
 *   asel:to-plan         -> slices run (docs/plans, same branch)    -> asel:plan-to-approve
 *   asel:plan-to-approve -> gate: a human reads the sliced plan (switchable off)
 *   asel:to-tasks        -> tasks run  (one issue per task)         -> asel:specced
 *   asel:task            -> implement run per task                  -> asel:in-review
 *   asel:fast            -> implement run, skipping the pipeline    -> asel:in-review
 *   asel:rework          -> repeats the step the neighbouring state label names
 *   any failure          -> asel:failed plus an explanatory comment
 *   a blocking question  -> asel:blocked plus the question in a comment
 *
 * Trigger labels are removed when the run FINISHES, not when it starts (per
 * spec). Double execution is prevented by the SQLite dedup on repo#issue plus
 * the one active run per plan rule, and a run interrupted by a restart is
 * re-triggered by the still present label.
 *
 * Gates live BETWEEN runs, never inside one. Three of them are idle states
 * (`asel:planned`, `asel:spec-to-approve`, `asel:plan-to-approve`) and the
 * labels that leave them (`asel:approved`, `asel:to-plan`, `asel:to-tasks`)
 * are set by a human. Naming convention: `to-*` is a trigger for the machine,
 * everything else is a state waiting for a person. The last of the three is
 * switchable per project (see `Gates`).
 *
 * Two ways a run can stop: `asel:failed` for a technical failure, and
 * `asel:blocked` for a run that finished CLEANLY but left a question a human has
 * to answer. Both are idle states; the way out of a blocked one is an answer in
 * a comment plus `asel:rework`.
 */

export type RunKind = "wayfinder" | "adr" | "prd" | "slices" | "tasks" | "implement";

/** Every run kind, in pipeline order. */
export const RUN_KINDS: readonly RunKind[] = [
  "wayfinder",
  "adr",
  "prd",
  "slices",
  "tasks",
  "implement",
];

/**
 * Guard for kinds read back from SQLite: a state file written by an older
 * build can still hold retired kinds ("plan", "spec"), and reconciliation must
 * not choke on them.
 */
export function isRunKind(value: string): value is RunKind {
  return (RUN_KINDS as readonly string[]).includes(value);
}

/** Which role the issue plays, derived from its labels. */
export type IssueRole = "epic" | "task";

/**
 * Per project switches that change the SHAPE of the pipeline, never its rules.
 *
 * They are passed in as an argument, exactly like the label prefix, so every
 * function in this module stays a pure function of its inputs and no module
 * level state can make two projects disagree.
 */
export interface Gates {
  /**
   * The `asel:plan-to-approve` gate, where a human reads the sliced plan.
   * With a specification a human already approved, the plan mostly writes
   * itself, so a project may switch the gate off and let the tasks run chain
   * automatically. Correcting a plan afterwards then costs no new label: a
   * human hangs `asel:to-plan` by hand and the slicing run repeats.
   */
  planApproval: boolean;
}

/** What a project gets when its registry file declares no gates. */
export const DEFAULT_GATES: Gates = { planApproval: true };

export interface LabelSet {
  plan: string;
  planned: string;
  /** "Not good enough, do that step again": works on every stage. */
  rework: string;
  approved: string;
  toPrd: string;
  specToApprove: string;
  toPlan: string;
  planToApprove: string;
  toTasks: string;
  specced: string;
  task: string;
  fast: string;
  inReview: string;
  failed: string;
  /** The run finished cleanly but asked a question nobody but a human answers. */
  blocked: string;
}

export function labelsFor(prefix: string): LabelSet {
  return {
    plan: `${prefix}:plan`,
    planned: `${prefix}:planned`,
    rework: `${prefix}:rework`,
    approved: `${prefix}:approved`,
    toPrd: `${prefix}:to-prd`,
    specToApprove: `${prefix}:spec-to-approve`,
    toPlan: `${prefix}:to-plan`,
    planToApprove: `${prefix}:plan-to-approve`,
    toTasks: `${prefix}:to-tasks`,
    specced: `${prefix}:specced`,
    task: `${prefix}:task`,
    fast: `${prefix}:fast`,
    inReview: `${prefix}:in-review`,
    failed: `${prefix}:failed`,
    blocked: `${prefix}:blocked`,
  };
}

export function allLabels(prefix: string): string[] {
  return Object.values(labelsFor(prefix));
}

/**
 * Prefix of the per slice marker label (`asel:slice-3`). The tasks run hangs
 * one on every task issue so a human can see at a glance which slice a task
 * belongs to. It is decoration only: the ordering the scheduler uses comes from
 * the `ASEL_SLICE` marker in the issue body, never from this label.
 */
export function sliceLabelPrefix(prefix: string): string {
  return `${prefix}:slice-`;
}

export function sliceLabelFor(prefix: string, slice: number): string {
  return `${sliceLabelPrefix(prefix)}${slice}`;
}

/** True when the issue carries any label owned by this orchestrator. */
export function isAselIssue(labels: string[], prefix: string): boolean {
  const owned = new Set(allLabels(prefix));
  return labels.some((label) => owned.has(label));
}

export interface IssueSnapshot {
  /** "owner/name" */
  repo: string;
  number: number;
  labels: string[];
}

export type Decision =
  | { action: "idle"; reason: string }
  | {
      action: "start";
      kind: RunKind;
      role: IssueRole;
      trigger: string;
      /** True when the run repeats a step a human rejected. */
      isRework: boolean;
    };

export function roleOf(labels: string[], prefix: string): IssueRole {
  return labels.includes(labelsFor(prefix).task) ? "task" : "epic";
}

/**
 * Rework: one label for every stage, replacing the old `asel:replan`.
 *
 * `asel:rework` NEVER hangs alone. The state label next to it names the step to
 * repeat, which keeps the machine a pure function of labels: nothing here has to
 * look at history to know what "do it again" means.
 *
 *   asel:planned          + rework -> wayfinder run again (the old replan)
 *   asel:spec-to-approve  + rework -> prd run again
 *   asel:plan-to-approve  + rework -> slices run again
 *   asel:specced          + rework -> tasks run again
 *   asel:task  + in-review + rework -> implement run again (task)
 *   asel:fast  + in-review + rework -> implement run again (fast)
 *
 * `asel:blocked` joins the table as a SECOND way of being finished, next to
 * `asel:in-review`: the run stopped on a question, a human answered it in a
 * comment and asks for the same step again. Which step that is still comes from
 * the state label next to it, because `blocked` says nothing about the stage.
 *
 * `asel:blocked` with no state label next to it is the one ambiguous shape, and
 * it is read as the implementation run ONLY for an issue that carries
 * `asel:task` or `asel:fast`. Those two labels are identity, not triggers: an
 * implementation run keeps them however it ends, so a task or a fast issue
 * really is in the implementation stage. An epic in that shape is something
 * else entirely - it blocked inside a pipeline run, which drops its trigger
 * label and leaves no gate label behind - and reading it as "implement" would
 * point an implementation agent at a planning issue. That one idles instead.
 *
 * Nothing recognizable next to it means idle: the orchestrator would have to
 * guess which run to repeat, and guessing here rewrites a branch.
 */
function reworkDecision(labels: Set<string>, L: LabelSet): Decision {
  const has = (label: string): boolean => labels.has(label);
  const start = (kind: RunKind, role: IssueRole): Decision => ({
    action: "start",
    kind,
    role,
    trigger: L.rework,
    isRework: true,
  });
  // An implementation run keeps its trigger label whichever way it stops, so
  // both of its finished states are recognizable here.
  const finished = has(L.inReview) || has(L.blocked);

  if (has(L.task) && finished) {
    return start("implement", "task");
  }
  if (has(L.fast) && finished) {
    return start("implement", "epic");
  }
  // Epic gates, most advanced first, so a leftover older gate label cannot win.
  if (has(L.specced)) {
    return start("tasks", "epic");
  }
  if (has(L.planToApprove)) {
    return start("slices", "epic");
  }
  if (has(L.specToApprove)) {
    return start("prd", "epic");
  }
  if (has(L.planned)) {
    return start("wayfinder", "epic");
  }
  // Last resort: blocked with nothing that names a stage, see the header. It is
  // reachable only for the implementation stage, and the two labels that mark
  // it were matched above, so what is left here is an epic. An epic gets no
  // implementation run out of a blocked label alone.
  if (has(L.blocked)) {
    return {
      action: "idle",
      reason:
        `${L.blocked} hangs on an epic issue with no state label next to it, so there ` +
        `is no step to repeat. Set the label of the stage to redo (${L.planned}, ` +
        `${L.specToApprove}, ${L.planToApprove} or ${L.specced}) next to ${L.rework}, ` +
        `or set that stage trigger again`,
    };
  }
  return {
    action: "idle",
    reason:
      `${L.rework} needs the state label of the step to repeat next to it ` +
      `(${L.planned}, ${L.specToApprove}, ${L.planToApprove}, ${L.specced}, ${L.inReview} ` +
      `or ${L.blocked})`,
  };
}

/**
 * Decides what (if anything) should run for an issue, based purely on labels.
 *
 * It takes no project configuration on purpose: a switchable gate changes which
 * label a finished run hangs (see `labelUpdateAfterRun`), never how a label is
 * read, so this stays a function of the label set alone.
 *
 * Note for task issues: this returns "start" as soon as the task is not in
 * review, not blocked and not failed. Slice ordering and the "spec PR must be
 * merged first" gate live in the scheduler, not here, because they need data
 * beyond labels.
 */
export function decide(issue: IssueSnapshot, prefix: string): Decision {
  const L = labelsFor(prefix);
  const labels = new Set(issue.labels);
  const has = (label: string): boolean => labels.has(label);

  // Rework outranks everything: a correction comes before moving forward. It
  // beats the idle states (`asel:in-review` included, which idles without it)
  // and the plain triggers, so setting `asel:rework` next to `asel:to-plan`
  // repeats the rejected step instead of walking into the next one. A failure
  // next to it does not block either: hanging rework is an explicit human
  // gesture, exactly like hanging a trigger label again.
  if (has(L.rework)) {
    return reworkDecision(labels, L);
  }

  // The fast shortcut wins over everything else: small change, straight to
  // commits on a branch of its own.
  if (has(L.fast)) {
    if (has(L.inReview)) {
      return { action: "idle", reason: "fast issue already in review" };
    }
    if (has(L.blocked)) {
      return { action: "idle", reason: "fast issue blocked on a question, waiting for an answer" };
    }
    if (has(L.failed)) {
      return { action: "idle", reason: "fast issue failed, waiting for a human" };
    }
    return { action: "start", kind: "implement", role: "epic", trigger: L.fast, isRework: false };
  }

  if (has(L.task)) {
    if (has(L.inReview)) {
      return { action: "idle", reason: "task already in review" };
    }
    if (has(L.blocked)) {
      return { action: "idle", reason: "task blocked on a question, waiting for an answer" };
    }
    if (has(L.failed)) {
      return { action: "idle", reason: "task failed, waiting for a human" };
    }
    return { action: "start", kind: "implement", role: "task", trigger: L.task, isRework: false };
  }

  // Epic triggers, most advanced stage first. A trigger label set by a human
  // overrides a previous failure, which is how a failed stage gets retried.
  if (has(L.toTasks)) {
    return { action: "start", kind: "tasks", role: "epic", trigger: L.toTasks, isRework: false };
  }
  if (has(L.toPlan)) {
    return { action: "start", kind: "slices", role: "epic", trigger: L.toPlan, isRework: false };
  }
  if (has(L.toPrd)) {
    return { action: "start", kind: "prd", role: "epic", trigger: L.toPrd, isRework: false };
  }
  if (has(L.approved)) {
    return { action: "start", kind: "adr", role: "epic", trigger: L.approved, isRework: false };
  }
  if (has(L.plan)) {
    return { action: "start", kind: "wayfinder", role: "epic", trigger: L.plan, isRework: false };
  }

  if (has(L.inReview)) {
    return { action: "idle", reason: "waiting for a human to review the commits" };
  }
  if (has(L.blocked)) {
    return {
      action: "idle",
      reason: `blocked on a question, waiting for an answer plus ${L.rework}`,
    };
  }
  if (has(L.failed)) {
    return { action: "idle", reason: "failed, waiting for a human" };
  }
  if (has(L.specced)) {
    return { action: "idle", reason: "spec pipeline done, tasks live on their own" };
  }
  if (has(L.planToApprove)) {
    return { action: "idle", reason: "waiting for a human to review the sliced plan" };
  }
  if (has(L.specToApprove)) {
    return { action: "idle", reason: "waiting for a human to review the ADRs and the PRD" };
  }
  if (has(L.planned)) {
    return { action: "idle", reason: "waiting for human approval" };
  }
  return { action: "idle", reason: "no trigger label" };
}

/**
 * How a run ended.
 *
 * "blocked" is not a failure: the agent did its job, ran into a question only a
 * human can answer, asked it in a comment and stopped instead of guessing.
 */
export type RunOutcome = "success" | "failure" | "blocked";

export interface LabelUpdate {
  add: string[];
  remove: string[];
}

/** The parts of a finished run that are not the kind or the outcome. */
export interface RunFinishOptions {
  role?: IssueRole;
  /** True when the run repeated a step a human rejected with `asel:rework`. */
  isRework?: boolean;
  /** Gates of the project the issue belongs to. */
  gates?: Gates;
}

/**
 * Labels to apply once a run finishes. Removal of labels the issue does not
 * carry is a no-op on the GitHub side, so the caller can apply this blindly.
 *
 * A run that stopped (failed, or blocked on a question) hangs exactly one of
 * the two stop labels and clears the other, so an issue never claims both at
 * once, and drops the same trigger label either way: what a human has to do
 * next depends on the stage, not on the reason for stopping.
 *
 * On failure every spec pipeline run drops its own trigger label and adds
 * `asel:failed`, so a retry means a human hanging the trigger label back on the
 * issue. The implement run is the exception: it keeps the trigger (`asel:task`
 * is an identity marker, `asel:fast` is what a human set), so there a retry
 * means removing `asel:failed`.
 *
 * A rework run is the other exception, and it is the simplest rule of all: it
 * only ever clears `asel:rework` itself. The state label stays where it was,
 * because a human asked for the SAME step again and lands back on the same gate,
 * now with a corrected result to read.
 */
export function labelUpdateAfterRun(
  kind: RunKind,
  outcome: RunOutcome,
  prefix: string,
  options: RunFinishOptions = {},
): LabelUpdate {
  const L = labelsFor(prefix);
  const { role = "epic", isRework = false, gates = DEFAULT_GATES } = options;

  /** A run that stopped: one stop label on, the other one off. */
  const stop = (dropped: string[]): LabelUpdate =>
    outcome === "blocked"
      ? { add: [L.blocked], remove: [...dropped, L.failed] }
      : { add: [L.failed], remove: [...dropped, L.blocked] };
  /** A run that delivered: both stop labels go. */
  const done = (add: string[], dropped: string[]): LabelUpdate => ({
    add,
    remove: [...dropped, L.failed, L.blocked],
  });

  if (isRework) {
    return outcome === "success" ? done([], [L.rework]) : stop([L.rework]);
  }

  if (kind === "wayfinder") {
    return outcome === "success" ? done([L.planned], [L.plan]) : stop([L.plan]);
  }

  if (kind === "adr") {
    // An ADR run that decided there was nothing worth recording still succeeds:
    // the pipeline moves on to the PRD either way.
    return outcome === "success" ? done([L.toPrd], [L.approved, L.planned]) : stop([L.approved]);
  }

  if (kind === "prd") {
    return outcome === "success" ? done([L.specToApprove], [L.toPrd]) : stop([L.toPrd]);
  }

  if (kind === "slices") {
    if (outcome !== "success") {
      return stop([L.toPlan]);
    }
    // Gate on (the default): the sliced plan waits for a human, who sets
    // `to-tasks` to continue. Gate off: the tasks run is triggered right away,
    // which is the whole point of switching the gate off.
    const next = gates.planApproval ? L.planToApprove : L.toTasks;
    return done([next], [L.toPlan, L.specToApprove]);
  }

  if (kind === "tasks") {
    return outcome === "success"
      ? done([L.specced], [L.toTasks, L.planToApprove])
      : stop([L.toTasks]);
  }

  // implement
  if (outcome === "success") {
    // The task label is an identity marker, not a trigger, so it stays.
    return done([L.inReview], role === "task" ? [] : [L.fast]);
  }
  // The trigger label stays: `decide` idles on a stopped issue, so a human
  // removing `asel:failed` is what retries the run, and an answer plus
  // `asel:rework` is what unblocks it.
  return stop([]);
}

/**
 * Applies a label update to a label list, the way GitHub would. Pure, and the
 * only way the orchestrator can know the new label set of an issue without
 * fetching it again, which is what the status block is rendered from right
 * after a run finishes.
 */
export function applyLabelUpdate(labels: readonly string[], update: LabelUpdate): string[] {
  const next = labels.filter((label) => !update.remove.includes(label));
  for (const label of update.add) {
    if (!next.includes(label)) {
      next.push(label);
    }
  }
  return next;
}

/** Human readable name of a run kind, used in logs, comments and pushes. */
export function describeRunKind(kind: RunKind): string {
  switch (kind) {
    case "wayfinder":
      return "wayfinder run (map and decision tickets)";
    case "adr":
      return "ADR run (architecture decision records on the plan branch)";
    case "prd":
      return "PRD run (product requirements on the plan branch)";
    case "slices":
      return "slicing run (plan split into small vertical slices)";
    case "tasks":
      return "task creation run (one issue per implementation task)";
    case "implement":
      return "implementation run (commits on the plan branch)";
  }
}
