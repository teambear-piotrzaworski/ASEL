/**
 * Self updating status block kept inside the issue body.
 *
 * The owner of a project should not have to remember the label order. The block
 * says, on the issue itself, where the process stands, which branch the work
 * lands on and which label moves it forward. It is written in English because it
 * lands in the repositories of the projects, which are often public.
 *
 * Everything here is PURE: it takes labels, markers and the current body in, and
 * gives a new body out. No GitHub calls, no clock, no randomness. The rendered
 * block is a deterministic function of its input, which is what makes the
 * "do not send a request when nothing changed" rule work: the caller renders,
 * upserts, compares strings and only writes when they differ.
 *
 * The block is delimited by invisible HTML markers so it can be replaced
 * deterministically without touching a single character a human wrote.
 */
import { labelsFor, type LabelSet, type RunKind } from "./machine.js";
import { issueBranchFor, planBranchFor, type IssueMarkers } from "./plan.js";

export const STATUS_BLOCK_START = "<!-- ASEL:STATUS -->";
export const STATUS_BLOCK_END = "<!-- /ASEL:STATUS -->";

/** Which flavour of the block an issue gets. */
export type StatusVariant = "epic" | "task" | "fast";

export interface StatusInput {
  labelPrefix: string;
  issueNumber: number;
  /** html_url of this issue. The epic link is derived from it, no extra call. */
  issueUrl: string;
  labels: readonly string[];
  /** Markers parsed out of the issue body (plan membership, slice number). */
  markers: IssueMarkers;
  /** Run currently executing for this issue, null when nothing is running. */
  activeRunKind: RunKind | null;
}

interface BlockRange {
  /** Index of the opening marker. */
  start: number;
  /** Index one past the closing marker. */
  end: number;
}

/**
 * Finds the one block the orchestrator owns.
 *
 * The scan pairs every closing marker with the LAST opening marker before it,
 * and returns the first pair it completes. That handles the three malformed
 * cases without ever eating text:
 *
 * - an opening marker with no closing one: nothing is found, so the body is left
 *   alone and a fresh block is appended after it
 * - a stray closing marker before any opening one: ignored, the scan moves on
 * - duplicated blocks: the FIRST complete pair wins and the rest is left
 *   untouched. Deliberate choice: the orchestrator never deletes body text it
 *   cannot prove it wrote, and a leftover second block is visible enough that a
 *   human removes it. Silently deleting a duplicate would risk eating a human
 *   note that happens to sit between two markers.
 */
function findStatusBlock(body: string): BlockRange | null {
  let cursor = 0;
  let openAt: number | null = null;

  while (cursor < body.length) {
    const start = body.indexOf(STATUS_BLOCK_START, cursor);
    const end = body.indexOf(STATUS_BLOCK_END, cursor);
    if (end === -1) {
      return null;
    }
    if (start !== -1 && start < end) {
      // A later opener belongs to this closer, so it wins over an earlier one.
      openAt = start;
      cursor = start + STATUS_BLOCK_START.length;
      continue;
    }
    if (openAt === null) {
      cursor = end + STATUS_BLOCK_END.length;
      continue;
    }
    return { start: openAt, end: end + STATUS_BLOCK_END.length };
  }
  return null;
}

/**
 * Puts the rendered block into the body.
 *
 * - no block yet: appended at the END of the body, so text written by a human
 *   is never overwritten, reordered or pushed around
 * - block present: only the text between the markers changes
 * - CRLF bodies keep CRLF, so the "nothing changed" comparison stays reliable on
 *   bodies edited from Windows
 * - empty body: the block becomes the whole body
 *
 * Calling it twice with the same block returns an identical string, which is
 * what lets the caller skip the GitHub request.
 */
export function upsertStatusBlock(body: string, block: string): string {
  const usesCrlf = body.includes("\r\n");
  const rendered = usesCrlf
    ? block.replace(/\r?\n/g, "\r\n")
    : block.replace(/\r\n/g, "\n");

  const range = findStatusBlock(body);
  if (range !== null) {
    return body.slice(0, range.start) + rendered + body.slice(range.end);
  }

  // Only trailing whitespace of the human text is touched, and only once.
  const head = body.replace(/\s+$/, "");
  if (head === "") {
    return rendered;
  }
  const eol = usesCrlf ? "\r\n" : "\n";
  return `${head}${eol}${eol}${rendered}`;
}

/**
 * Removes the block from a body. Used before handing the issue text to an
 * agent: the block is orchestrator bookkeeping, not part of the request.
 */
export function stripStatusBlock(body: string): string {
  const range = findStatusBlock(body);
  if (range === null) {
    return body;
  }
  const before = body.slice(0, range.start).replace(/\s+$/, "");
  const after = body.slice(range.end).replace(/^\s+/, "");
  if (before === "") {
    return after;
  }
  if (after === "") {
    return before;
  }
  return `${before}\n\n${after}`;
}

/**
 * Renders, upserts and writes only when the body actually changed. Returns the
 * body that is now on GitHub, so the caller can keep its in memory copy fresh.
 */
export async function applyStatusBlock(
  body: string,
  block: string,
  write: (nextBody: string) => Promise<void>,
): Promise<string> {
  const next = upsertStatusBlock(body, block);
  if (next === body) {
    return body;
  }
  await write(next);
  return next;
}

/** Short name of a run kind, tuned for one line inside the block. */
export function runKindLabel(kind: RunKind): string {
  switch (kind) {
    case "wayfinder":
      return "wayfinder run";
    case "adr":
      return "ADR run";
    case "prd":
      return "PRD run";
    case "slices":
      return "slicing run";
    case "tasks":
      return "task creation run";
    case "implement":
      return "implementation run";
  }
}

/**
 * Which variant an issue gets, derived from labels alone.
 *
 * The fast track is detected by its own label, plus one derived case: a
 * successful fast run REMOVES `asel:fast` and adds `asel:in-review`, so an issue
 * that is finished (in review, blocked or failed) while carrying none of the
 * pipeline labels can only be a finished fast issue. Without that rule such an
 * issue would suddenly render an epic checklist it never walked.
 */
export function statusVariantOf(labels: readonly string[], prefix: string): StatusVariant {
  const L = labelsFor(prefix);
  const has = (label: string): boolean => labels.includes(label);
  if (has(L.task)) {
    return "task";
  }
  if (has(L.fast)) {
    return "fast";
  }
  // `asel:rework` is deliberately absent: it hangs on fast issues too, and the
  // list below is what tells an epic apart from a finished fast issue.
  const pipeline = [
    L.plan,
    L.planned,
    L.approved,
    L.toPrd,
    L.specToApprove,
    L.toPlan,
    L.planToApprove,
    L.toTasks,
    L.specced,
  ];
  if ((has(L.inReview) || has(L.failed) || has(L.blocked)) && !pipeline.some(has)) {
    return "fast";
  }
  return "epic";
}

/** Branch every run of this issue commits to. Mirrors planContextFor in plan.ts. */
function branchOf(input: StatusInput, variant: StatusVariant): string {
  if (variant === "epic") {
    return planBranchFor(input.issueNumber);
  }
  if (variant === "task" && input.markers.epicIssue !== null) {
    return planBranchFor(input.markers.epicIssue);
  }
  return issueBranchFor(input.issueNumber);
}

/**
 * Link to the epic issue, derived from the URL of this issue instead of asking
 * GitHub for it. Falls back to a plain reference when the URL has an unexpected
 * shape, which keeps the block honest on a GitHub Enterprise host.
 */
function epicLink(issueUrl: string, epicIssue: number): string {
  const url = issueUrl.replace(/\/\d+(?:[?#].*)?$/, `/${epicIssue}`);
  return url === issueUrl ? `#${epicIssue}` : `[#${epicIssue}](${url})`;
}

/** The whole path an epic walks, in order. Index = step number. */
function epicSteps(L: LabelSet): string[] {
  return [
    `Wayfinder run (\`${L.plan}\`)`,
    "Wayfinder decision tickets answered by a human",
    `Decisions approved (\`${L.approved}\`)`,
    "ADR run (docs/adr on the plan branch)",
    "PRD run (docs/prd, chained automatically)",
    `ADRs and PRD reviewed (\`${L.toPlan}\`)`,
    "Slicing run (docs/plans, small vertical slices)",
    `Sliced plan reviewed (\`${L.toTasks}\`)`,
    "Task issues created, then implemented one at a time",
  ];
}

interface EpicProgress {
  /** How many steps are finished; also the index of the step in progress. */
  done: number;
  stage: string;
  next: string;
}

/**
 * Reads the stage off the labels, in the same priority order the state machine
 * uses, so the block can never disagree with what the orchestrator will do.
 */
function epicProgress(input: StatusInput, L: LabelSet, branch: string): EpicProgress {
  const has = (label: string): boolean => input.labels.includes(label);
  const running = input.activeRunKind;
  const waiting = (kind: RunKind, done: number): EpicProgress => ({
    done,
    stage:
      running === null
        ? `${runKindLabel(kind)} queued, it starts on the next poll`
        : `${runKindLabel(running)} in progress`,
    next: "Nothing to do, the orchestrator is on it.",
  });

  // Rework first, exactly like decide(): the step named by the state label next
  // to it is repeated before anything moves forward.
  if (has(L.rework)) {
    const repeat = (kind: RunKind, done: number): EpicProgress => ({
      done,
      stage:
        running === null
          ? `rework requested, the ${runKindLabel(kind)} repeats and reads your comments`
          : `${runKindLabel(running)} in progress, repeating the step you rejected`,
      next: "Nothing to do, the orchestrator is redoing that step.",
    });
    if (has(L.specced)) {
      return repeat("tasks", 8);
    }
    if (has(L.planToApprove)) {
      return repeat("slices", 6);
    }
    if (has(L.specToApprove)) {
      return repeat("prd", 4);
    }
    if (has(L.planned)) {
      return repeat("wayfinder", 0);
    }
    // Nothing recognizable next to it: the machine idles, so the checklist keeps
    // showing the real stage and only the wording says what is wrong.
    const base = epicProgress(
      { ...input, labels: input.labels.filter((label) => label !== L.rework) },
      L,
      branch,
    );
    return {
      done: base.done,
      stage: `\`${L.rework}\` is set, but no state label next to it says which step to repeat`,
      next: `Put \`${L.rework}\` next to the state label of the step you want repeated, or remove it.`,
    };
  }

  // Trigger labels next, most advanced stage wins, exactly like decide().
  if (has(L.toTasks)) {
    return waiting("tasks", 8);
  }
  if (has(L.toPlan)) {
    return waiting("slices", 6);
  }
  if (has(L.toPrd)) {
    return waiting("prd", 4);
  }
  if (has(L.approved)) {
    return waiting("adr", 3);
  }
  if (has(L.plan)) {
    return waiting("wayfinder", 0);
  }

  // Idle states: every one of them is a gate waiting for a human, and every gate
  // offers the same two ways out, forward or back.
  const orRework = `If it is not good enough, say why in a comment and set \`${L.rework}\` to have this step redone.`;
  if (has(L.specced)) {
    return {
      done: 9,
      stage: "planning finished, the task issues carry the work from here",
      next:
        `Follow the task issues. They run one at a time and commit to \`${branch}\`. ` +
        `If the task issues are wrong, comment here and set \`${L.rework}\` to have them redone.`,
    };
  }
  if (has(L.planToApprove)) {
    return {
      done: 7,
      stage: "the sliced plan is waiting for review",
      next:
        `Read the plan on \`${branch}\`, then set \`${L.toTasks}\` to have the task issues created. ` +
        orRework,
    };
  }
  if (has(L.specToApprove)) {
    return {
      done: 5,
      stage: "the ADRs and the PRD are waiting for review",
      next:
        `Read the ADRs and the PRD on \`${branch}\`, then set \`${L.toPlan}\` to have the plan sliced. ` +
        orRework,
    };
  }
  if (has(L.planned)) {
    return {
      done: 1,
      stage: "the wayfinder map is ready and the decisions are waiting for you",
      next:
        `Answer the decision tickets, then set \`${L.approved}\` to start the spec pipeline. ` +
        `If the map itself is wrong, comment on it and set \`${L.rework}\` to run the wayfinder again.`,
    };
  }
  return {
    done: 0,
    stage: "not started",
    next: `Set \`${L.plan}\` to run the wayfinder and start the pipeline.`,
  };
}

/** Label a human sets again to retry the stage that failed. */
function epicRetryLabel(input: StatusInput, L: LabelSet): string {
  const has = (label: string): boolean => input.labels.includes(label);
  if (has(L.planToApprove)) {
    return L.toTasks;
  }
  if (has(L.specToApprove)) {
    return L.toPlan;
  }
  if (has(L.planned)) {
    return L.approved;
  }
  return L.plan;
}

function checklist(steps: string[], done: number, runInProgress: boolean): string[] {
  return steps.map((step, index) => {
    if (index < done) {
      return `- [x] ${step}`;
    }
    if (index === done && runInProgress) {
      return `- [ ] ${step} (running now)`;
    }
    return `- [ ] ${step}`;
  });
}

const FOOTER = "_ASEL keeps this block up to date. Keep your own notes outside it._";

function renderEpic(input: StatusInput): string[] {
  const L = labelsFor(input.labelPrefix);
  const branch = branchOf(input, "epic");
  const progress = epicProgress(input, L, branch);
  const failed = input.labels.includes(L.failed);
  // A blocked run is not a failed one: it did its job and ran into a question.
  // Only a human answer moves it, so that wording wins over the stage wording.
  const blocked = input.labels.includes(L.blocked);

  const stage = blocked
    ? `${progress.stage}, and the last run STOPPED WITH A QUESTION for you`
    : failed
      ? `${progress.stage}, and the last run FAILED`
      : progress.stage;
  const next = blocked
    ? `Answer the question in the newest ASEL comment, then set \`${L.rework}\` to have that step repeated.`
    : failed
      ? `Read the newest ASEL comment for the reason, then set \`${epicRetryLabel(input, L)}\` again to retry.`
      : progress.next;

  return [
    "### ASEL",
    "",
    `**Stage:** ${stage}`,
    `**Plan branch:** \`${branch}\``,
    `**Next step:** ${next}`,
    "",
    ...checklist(epicSteps(L), progress.done, input.activeRunKind !== null),
    "",
    FOOTER,
  ];
}

interface WorkState {
  stage: string;
  next: string;
}

/**
 * Stage of an issue that ends in commits (a plan task or a fast issue). Order
 * matches decide(): a failed run idles until a human clears it, an issue in
 * review idles until a human reviews it.
 */
function workState(input: StatusInput, L: LabelSet, branch: string, queued: string): WorkState {
  const has = (label: string): boolean => input.labels.includes(label);
  if (has(L.rework)) {
    if (!has(L.inReview) && !has(L.blocked)) {
      return {
        stage: `\`${L.rework}\` is set, but this issue is not waiting for review`,
        next: `Rework repeats a finished run, so it only works next to \`${L.inReview}\` or \`${L.blocked}\`. Remove it.`,
      };
    }
    return {
      stage:
        input.activeRunKind === null
          ? "rework requested, the implementation run repeats and reads your comments"
          : "implementation run in progress, repeating the work you rejected",
      next: "Nothing to do, the orchestrator is redoing it.",
    };
  }
  if (has(L.blocked)) {
    return {
      stage: "the implementation run stopped and asked you a question",
      next:
        `Answer the question in the newest comment, then set \`${L.rework}\` to have the run ` +
        "continue from there.",
    };
  }
  if (has(L.failed)) {
    return {
      stage: "the implementation run FAILED",
      next: `Read the newest ASEL comment for the reason, then remove \`${L.failed}\` to retry.`,
    };
  }
  if (has(L.inReview)) {
    return {
      stage: "implementation finished, the commits are waiting for review",
      next:
        `Review the commits on \`${branch}\` and close this issue when you are satisfied. ` +
        `Merging the branch is your call. If the work is not good enough, say why in a comment ` +
        `and set \`${L.rework}\` to have it redone.`,
    };
  }
  if (input.activeRunKind !== null) {
    return {
      stage: `${runKindLabel(input.activeRunKind)} in progress`,
      next: "Nothing to do, the orchestrator is on it.",
    };
  }
  return { stage: queued, next: "Nothing to do, the orchestrator is on it." };
}

function renderTask(input: StatusInput): string[] {
  const L = labelsFor(input.labelPrefix);
  const branch = branchOf(input, "task");
  const state = workState(
    input,
    L,
    branch,
    "waiting in the queue, tasks of one plan run one at a time in slice order",
  );

  // "Slice number" and not "Slice", because a line starting with "Slice:" is a
  // legacy ordering marker that plan.ts parses out of the body.
  const sliceLine =
    input.markers.slice === null
      ? "**Slice number:** not set, so this task runs after every numbered one"
      : `**Slice number:** ${input.markers.slice}`;

  const epicLine =
    input.markers.epicIssue === null
      ? "**Epic:** none, this issue carries no epic marker, so it runs on a branch of its own"
      : `**Epic:** ${epicLink(input.issueUrl, input.markers.epicIssue)}`;

  return [
    "### ASEL",
    "",
    epicLine,
    sliceLine,
    `**Branch:** \`${branch}\``,
    `**Stage:** ${state.stage}`,
    `**Next step:** ${state.next}`,
    "",
    FOOTER,
  ];
}

function renderFast(input: StatusInput): string[] {
  const L = labelsFor(input.labelPrefix);
  const branch = branchOf(input, "fast");
  const state = workState(input, L, branch, "queued, the implementation run starts on the next poll");

  return [
    "### ASEL",
    "",
    "**Mode:** fast track, no planning pipeline and no plan to belong to",
    `**Branch:** \`${branch}\``,
    `**Stage:** ${state.stage}`,
    `**Next step:** ${state.next}`,
    "",
    FOOTER,
  ];
}

/** The block, markers included, ready to hand to upsertStatusBlock. */
export function renderStatusBlock(input: StatusInput): string {
  const variant = statusVariantOf(input.labels, input.labelPrefix);
  const lines =
    variant === "task" ? renderTask(input) : variant === "fast" ? renderFast(input) : renderEpic(input);
  return [STATUS_BLOCK_START, ...lines, STATUS_BLOCK_END].join("\n");
}
