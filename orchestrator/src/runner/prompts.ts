/**
 * Prompts handed to Claude Code inside the sandbox.
 *
 * They are plain strings on purpose: the DryRun runner logs them, the
 * Sandcastle runner sends them. Keeping them here means a prompt change never
 * requires touching the scheduler.
 *
 * Two rules shape every prompt:
 *
 * 1. ONE PLAN = ONE BRANCH. The adr, prd, slices and tasks runs of an epic and
 *    every implementation task derived from it work on the same branch. Each
 *    run reads what the previous ones committed instead of being told about it.
 * 2. NO PULL REQUESTS. A run ends with commits plus a push of that branch to
 *    origin. Sandcastle brings commits back locally only, so without the push
 *    nothing is visible on GitHub. A human reviews the commit history on the
 *    branch and decides when and how to merge it.
 *
 * A third rule holds for every kind: a run that has nothing to write is a
 * SUCCESSFUL run, and a run that needs a human decision stops and says so
 * (`ASEL_RESULT status=blocked`) instead of guessing. Neither is a failure.
 */
import type { RunContext } from "./types.js";

/** Value of the `status` field an agent prints when it stops on a question. */
export const BLOCKED_STATUS = "blocked";

/**
 * First token of the single line EVERY prompt in this file asks the agent to
 * print last.
 *
 * It is exported because two different things key off it: the parser at the
 * bottom of this file, and the completion signal the Sandcastle adapter hands
 * to the iteration loop (see runner/sandcastle.ts). They have to mean the same
 * string, or the loop would stop on something the parser cannot read.
 */
export const RESULT_MARKER_PREFIX = "ASEL_RESULT";

/** The exact final line a blocked run is asked to print. */
export const BLOCKED_RESULT_LINE = `${RESULT_MARKER_PREFIX} status=${BLOCKED_STATUS}`;

function issueHeader(context: RunContext): string {
  return [
    `Repository: ${context.repo}`,
    `Issue: #${context.issue.number} ${context.issue.title}`,
    `Issue URL: ${context.issue.htmlUrl}`,
    "",
    "Issue body:",
    context.issue.body.trim() === "" ? "(empty)" : context.issue.body.trim(),
  ].join("\n");
}

/**
 * Branch contract, shared by every run that touches the repository.
 *
 * `expectExisting` flips the wording between "you may be the first run on this
 * branch" and "earlier runs already committed here, read them first".
 */
function branchNote(context: RunContext, expectExisting: boolean): string[] {
  const lines = [
    `Work on branch ${context.branch}. Every run of this plan commits to that`,
    "one branch: the ADRs, the product requirements, the sliced plan and every",
    "implementation task that comes out of it.",
  ];
  if (expectExisting) {
    lines.push(
      "Start by checking it out and reading what came before you:",
      `  git fetch origin && git checkout ${context.branch}`,
      "Read the work of the earlier runs (docs/adr/, docs/prd/, docs/plans/, and",
      "the code already committed) BEFORE you write anything.",
      "If that branch does not exist yet, create it from the default branch: an",
      "earlier run of this plan may legitimately have had nothing to commit.",
    );
  } else {
    lines.push(
      "Check the branch out if it already exists (git fetch origin && git",
      `checkout ${context.branch}), otherwise create it from the default branch.`,
    );
  }
  return lines;
}

/**
 * Rework contract, added to every prompt when a human hung `asel:rework`.
 *
 * A rework run is the same run again, with two differences: the review comments
 * on the issue are the actual brief, and the previous result is material to fix
 * rather than to ignore. `extra` carries the lines that differ per kind, for
 * example where else the comments live, or how far the correction may reach.
 */
function reworkNote(context: RunContext, extra: readonly string[] = []): string[] {
  return [
    "THIS RUN IS A REWORK, NOT NEW WORK.",
    "A human read the result of this step and asked for it again.",
    "",
    "Read the review comments on the issue BEFORE you change anything:",
    `  gh issue view ${context.issue.number} --repo ${context.repo} --comments`,
    ...extra,
    "Treat those comments as the brief for this run. Correct and extend what is",
    "already there instead of writing it again from scratch, and leave alone what",
    "the comments did not object to.",
    "Everything the normal run does still applies: same branch, small commits,",
    "push at the end, no pull request.",
  ];
}

/** The rework section, or nothing at all when this is a normal run. */
function reworkSection(context: RunContext, extra: readonly string[] = []): string[] {
  return context.isRework ? [...reworkNote(context, extra), ""] : [];
}

/**
 * Blocking question contract, shared by every kind.
 *
 * The one thing an agent must never do is invent an answer to a question that
 * belongs to a human. So every prompt offers the same exit: ask on the issue,
 * print the blocked marker, stop. The orchestrator turns that into
 * `asel:blocked`, which is a state of its own and NOT a failure, and a human
 * answers in a comment and sets `asel:rework` to have this same run repeated.
 */
function blockedNote(context: RunContext): string[] {
  return [
    "IF YOU CANNOT FINISH WITHOUT A DECISION ONLY A HUMAN CAN MAKE:",
    "do not guess, do not pick an option to keep moving, and do not fail on",
    "purpose. Ask the question on the issue and stop:",
    `  gh issue comment ${context.issue.number} --repo ${context.repo} --body "<your question>"`,
    "Ask one concrete question. Say what you already tried, which options you see",
    "and what each of them would cost. Keep whatever partial work is worth",
    "keeping (commit and push it the usual way), then end the run with this exact",
    "line INSTEAD of the result line above:",
    `  ${BLOCKED_RESULT_LINE}`,
    "A human answers in a comment and asks for this same run again; it will start",
    "by reading those comments. Use this only for a real blocker, never as a way",
    "to hand back work you could have done.",
  ];
}

/** Closing contract: commits plus a push, never a pull request. */
function finishNote(context: RunContext): string[] {
  return [
    "Finish the run like this:",
    "- commit your work in small, readable commits",
    `- push the branch to origin: git push -u origin ${context.branch}`,
    "- do NOT open a pull request and do NOT merge anything into the default",
    "  branch; a human reviews the commits on the branch and decides about the",
    "  merge",
    "A commit that is not pushed is invisible on GitHub, so the push is the part",
    "that actually delivers the work.",
    "If this run genuinely produced nothing worth committing, commit nothing and",
    "push nothing. An empty run still counts as a successful one; a filler commit",
    "only makes the branch harder to read.",
  ];
}

/**
 * Wayfinder run. Wayfinder is a Claude Code skill, not a library, so it is
 * invoked the only way it can be: as a slash command inside the session.
 */
export function wayfinderPrompt(context: RunContext): string {
  return [
    issueHeader(context),
    "",
    ...reworkSection(context, [
      "Read the comments on the wayfinder map issue and on its decision tickets as well.",
    ]),
    "Run /wayfinder for this issue.",
    "",
    "Produce a wayfinder map issue plus decision tickets on this repository's",
    "issue tracker. Link the map to the issue above. Do not write production",
    "code in this run: wayfinder plans, it does not implement.",
    "",
    "If a map already exists for this issue, read the human comments on its",
    "decision tickets and update the map instead of starting a new one.",
    "",
    "This run creates issues, not files: commit nothing, push nothing, open no",
    "pull request.",
    "",
    "When you are done, print a final line in this exact form:",
    "ASEL_RESULT map_issue=<number> decisions_open=<number>",
    "",
    ...blockedNote(context),
  ].join("\n");
}

/**
 * ADR run: first stage of the spec pipeline and usually the first run that
 * writes to the plan branch.
 *
 * ADRs are OPTIONAL. An architecture decision record exists to explain a choice
 * that constrains the code for a long time; most tickets contain no such choice,
 * and a directory of records saying "we used the obvious approach" is worse than
 * an empty one, because it teaches the reader to skip the directory. Judging
 * that is the agent's job and not the orchestrator's: a decision ticket count
 * says nothing about whether anything is worth recording, so this run is allowed
 * to write nothing and still succeed. The pipeline continues to the PRD either
 * way.
 */
export function adrPrompt(context: RunContext): string {
  return [
    issueHeader(context),
    "",
    ...reworkSection(context),
    "The wayfinder decisions for this issue are approved. This run records the",
    "architecture decisions that are worth recording, and nothing else.",
    "",
    "Read the wayfinder map issue and its decision tickets, including the human",
    "comments that approved or amended them. Then decide, decision by decision,",
    "whether it deserves a record at all. Write one file in docs/adr/ ONLY for a",
    "decision with real architectural consequences, which in practice means:",
    "- a serious alternative was rejected, and somebody could reasonably ask",
    "  later why it was rejected",
    "- the choice shapes the structure of the system: a boundary, a data model, a",
    "  protocol, a dependency that is hard to walk back",
    "Follow the numbering already used in that directory (or start at 0001 when",
    "it is empty), and record the decision, the context it came from, the",
    "alternatives that were rejected and the consequences.",
    "",
    "IF NOTHING MEETS THAT BAR, WRITE NOTHING. Do not create a file, do not",
    "commit an empty or padded record, and do not invent a decision to have",
    "something to show. Say why in one sentence as a comment on the issue:",
    `  gh issue comment ${context.issue.number} --repo ${context.repo} --body "<one sentence>"`,
    "then finish the run with adrs=0. That is a successful run, not a failure:",
    "the PRD run follows either way.",
    "",
    ...branchNote(context, false),
    "",
    "Do not write production code and do not create any issues in this run.",
    "",
    ...finishNote(context),
    "",
    "When you are done, print a final line in this exact form (with adrs=0 and no",
    "commits when there was nothing worth recording):",
    `ASEL_RESULT adrs=<number> branch=${context.branch}`,
    "",
    ...blockedNote(context),
  ].join("\n");
}

/**
 * PRD run: second stage. Reads the ADRs already on the plan branch and derives
 * the product requirements from them, on the same branch.
 *
 * The rework variant carries one extra power: the `asel:spec-to-approve` gate is
 * where a human reads the ADRs and the PRD TOGETHER, and rework there repeats
 * the prd run. So a comment objecting to an architecture decision would have
 * nowhere to land unless this run may also correct `docs/adr/`. It may, and then
 * it has to bring the PRD back in line with what it corrected.
 */
export function prdPrompt(context: RunContext): string {
  return [
    issueHeader(context),
    "",
    ...reworkSection(context, [
      "This gate covers the ADRs and the PRD together, so judge what the comments",
      "are actually about:",
      "- if they object to an architecture decision, fix the affected file in",
      "  docs/adr/ first, then bring the PRD in line with the corrected ADRs",
      "- if they only concern the requirements, leave docs/adr/ untouched",
    ]),
    "The architecture decision records for this issue are already committed.",
    context.isRework
      ? "This run writes the product requirements, plus the ADR corrections the comments ask for."
      : "This run writes the product requirements and nothing else.",
    "",
    ...branchNote(context, true),
    "",
    "Read every file in docs/adr/ that belongs to this issue. Then read the",
    "wayfinder map issue and ALL of its decision tickets, the closed ones",
    "included, WITH their comments: a ticket's decision usually lives in the",
    "comment that closed it, not in its body, and only the biggest decisions got",
    "an ADR. A decision recorded on a ticket binds the requirements exactly like",
    "an ADR does - fold it into the requirement text, and never list a decided",
    "question as open or defer it to planning.",
    "",
    "Then write the product requirements into docs/prd/: what is being built,",
    "for whom, the requirements themselves, what is explicitly out of scope, and",
    "how the result is verified. The requirements must stay inside the",
    "boundaries the ADRs and the ticket decisions set.",
    "",
    "Do not write production code and do not create any issues in this run.",
    "",
    ...finishNote(context),
    "",
    "When you are done, print a final line in this exact form:",
    `ASEL_RESULT prd_files=<number> branch=${context.branch}`,
    "",
    ...blockedNote(context),
  ].join("\n");
}

/**
 * Slicing run: third stage. Turns the PRD into a plan split into small vertical
 * slices, numbered in execution order, on the same branch.
 */
export function slicesPrompt(context: RunContext): string {
  return [
    issueHeader(context),
    "",
    ...reworkSection(context),
    "The product requirements for this issue are already committed and approved",
    "by a human. This run writes the implementation plan and nothing else.",
    "",
    ...branchNote(context, true),
    "",
    "Read docs/prd/ (and docs/adr/ for the constraints), then write the plan into",
    "docs/plans/, split into SMALL VERTICAL SLICES:",
    "",
    "- a slice is vertical: it works end to end, from interface down to data",
    "- a slice is small: one agent run closes it within AT MOST a quarter of",
    "  the agent's context window - budget about 50k tokens for the WHOLE run:",
    "  reading the specs and the branch, writing the tests, the implementation",
    "  and the review. In practice that means one subsystem and a handful of",
    "  files; a slice that touches many files, ports a large asset or has to",
    "  read wide stretches of the codebase is too big",
    "- slices are numbered from 1 IN EXECUTION ORDER, each one building on the",
    "  previous one; that number is the only ordering the factory knows, so do",
    "  not write dependency graphs or 'can run in parallel with' notes",
    "- every slice states what it delivers and how it is verified",
    "",
    "If a slice does not fit that budget, split it further: two small slices",
    "beat one that runs out of context halfway through.",
    "",
    "The tasks of this plan are implemented one at a time, in slice order, on",
    "this same branch. Order the slices so that reading the branch top to bottom",
    "tells a coherent story.",
    "",
    "Do not write production code and do not create any issues in this run.",
    "",
    ...finishNote(context),
    "",
    "When you are done, print a final line in this exact form:",
    `ASEL_RESULT slices=<number> branch=${context.branch}`,
    "",
    ...blockedNote(context),
  ].join("\n");
}

export interface TaskPromptLabels {
  /** Label marking an issue as an implementation task. */
  taskLabel: string;
  /** Prefix of the per slice marker label, completed with the slice number. */
  sliceLabelPrefix: string;
  /**
   * Colour of the per slice marker labels. The orchestrator bootstraps its 15
   * fixed labels itself, but the slice ones only exist once a plan has been
   * sliced, so this run creates them, and does it with the same palette.
   */
  sliceLabelColor: string;
}

/**
 * Task creation run: last stage of planning. Reads the plan from the branch and
 * turns every implementation task into an issue. Commits nothing.
 *
 * The markers it writes into every task issue are the ONLY way the orchestrator
 * can link a task back to its plan: it has no clone of the repository and never
 * reads files out of it.
 */
export function tasksPrompt(context: RunContext, labels: TaskPromptLabels): string {
  return [
    issueHeader(context),
    "",
    ...reworkSection(context, [
      "Existing task issues of this plan are yours to fix: correct or close the ones the comments reject, and only create what is missing.",
    ]),
    "The plan for this issue is committed on the plan branch and approved by a",
    "human. This run creates the implementation task issues and nothing else.",
    "",
    `The plan branch ${context.branch} holds everything this plan produced so`,
    "far. Check it out and read it before you write a single issue:",
    `  git fetch origin && git checkout ${context.branch}`,
    "This run commits nothing and pushes nothing: it only reads the branch.",
    "",
    "Read the plan in docs/plans/, then create one issue per implementation task:",
    "",
    `- label every issue "${labels.taskLabel}"`,
    `- also label it "${labels.sliceLabelPrefix}<slice number>" so a human sees`,
    "  the slice at a glance; that label may not exist yet, so check the",
    "  repository labels first and create the missing ones, for example",
    `  gh label create "${labels.sliceLabelPrefix}<slice number>" --color ${labels.sliceLabelColor} --description "Marker only: this task belongs to slice <slice number> of its plan"`,
    "- one task belongs to exactly one slice, never to two",
    "- write these two marker lines into the issue body, each on its own line,",
    "  in this exact form (the orchestrator parses them):",
    `    ASEL_EPIC: ${context.issue.number}`,
    "    ASEL_SLICE: <slice number>",
    "  ASEL_EPIC tells the orchestrator which plan branch the task belongs to,",
    "  ASEL_SLICE gives it the execution order. Keep them on separate lines and",
    "  do not reformat them.",
    "- describe the task well enough to be implemented without reading this",
    "  issue: what to change, where, and how it is verified",
    "- link every issue back to the issue above",
    "- a task must be closable in a single agent run within AT MOST a quarter",
    "  of the agent's context window - budget about 50k tokens for the whole",
    "  run: reading the specs and the branch, writing the tests, the",
    "  implementation and the review. A slice that does not fit that budget",
    "  becomes SEVERAL tasks sharing the same ASEL_SLICE number: they execute",
    "  in issue-number order, so create them in the order they build on each",
    "  other, and give each one its own verifiable outcome",
    "",
    "Tell the reader in each issue that the work lands on the shared plan branch",
    `${context.branch}, and that tasks of this plan run one at a time in slice`,
    "order.",
    "",
    "Do not commit anything in this run: no code, no documents, no changes to the",
    "plan branch. This run only creates issues.",
    "",
    "When you are done, print a final line in this exact form:",
    "ASEL_RESULT tasks=<comma separated issue numbers> slices=<number>",
    "",
    ...blockedNote(context),
  ].join("\n");
}

/**
 * Shared opening of every implementation prompt: what the issue is, whether
 * this is a rework, which branch the work lands on and what else lives there.
 *
 * All three phases of an implementation run (red, green, review) and the single
 * phase fallback start with exactly this, because they are the same task seen
 * three times, not three different jobs.
 */
function implementBriefing(context: RunContext): string[] {
  const lines = [
    issueHeader(context),
    "",
    ...reworkSection(context, [
      "The commits you are asked to fix are already on the branch: read them (git log) and correct them with new commits.",
      "Reviewer remarks can change what the code has to DO, so they can change the tests as well: the run starts from the test phase again.",
    ]),
  ];

  if (context.role === "task") {
    lines.push("This is a plan task. Implement exactly this task, nothing more.");
    if (context.epicIssue !== null) {
      lines.push(
        "",
        `It belongs to the plan of epic issue #${context.epicIssue}` +
          (context.slice === null ? "." : `, slice ${context.slice}.`),
        ...branchNote(context, true),
        "",
        "Earlier tasks of this plan already committed to this branch, and later",
        "ones will commit on top of your work. Read the plan in docs/plans/ and",
        "the relevant ADRs and PRD before you start, and do not redo what is",
        "already there.",
      );
    } else {
      lines.push(
        "",
        "The issue carries no ASEL_EPIC marker, so this task has no plan branch.",
        `Work on branch ${context.branch}, created from the default branch.`,
      );
    }
  } else {
    lines.push(
      "This is a fast track issue: it skipped the planning pipeline. Keep the",
      "change small.",
      "",
      `Work on branch ${context.branch}, created from the default branch. It`,
      "belongs to no plan, so nothing else commits here.",
    );
  }

  return lines;
}

/** Closing lines every implementation phase shares. */
function implementClosing(context: RunContext, phase: string): string[] {
  return [
    ...finishNote(context),
    "",
    "Do not close the issue: a human closes it after reviewing the commits.",
    "",
    "When you are done, print a final line in this exact form:",
    `ASEL_RESULT phase=${phase} commits=<number> branch=${context.branch}`,
    "",
    ...blockedNote(context),
  ];
}

/**
 * Implementation run, single phase. This is the FALLBACK: it runs when the
 * project declares no `test` command, which makes the test first regime
 * unenforceable (see runner/checks.ts). Without a command to run, "the tests
 * fail now and pass later" would be a claim by the agent about its own work,
 * and the whole point of the phases is that a harness decides that, not a
 * prompt.
 */
export function implementPrompt(context: RunContext): string {
  return [
    ...implementBriefing(context),
    "",
    "Run the project's own tests and linters before finishing, and fix what you",
    "broke.",
    "",
    ...implementClosing(context, "implement"),
  ].join("\n");
}

/**
 * Phase 1 of 3: RED. Tests only, and they have to fail.
 *
 * The requirement is enforced by the orchestrator, which runs the test command
 * itself once this phase ends. That is deliberate: the sentence "I wrote a
 * failing test" is worth nothing next to an exit code, and a test that passes
 * the moment it is written is a test that asserts something already true.
 */
export function implementRedPrompt(context: RunContext, testCommand: string): string {
  return [
    ...implementBriefing(context),
    "",
    "PHASE 1 OF 3: RED. IN THIS PHASE YOU WRITE TESTS, AND NOTHING ELSE.",
    "",
    "- write the tests that describe what this task has to do, at the level the",
    "  project already tests at",
    "- do NOT write or change production code in this phase, not even a stub,",
    "  beyond what a test file needs to import",
    "- when the test needs a function, a module or an endpoint that does not",
    "  exist yet, write the test against the interface the task describes; the",
    "  next phase builds it",
    "- commit the tests on their own, with a subject that starts with `test: `",
    "",
    `When this phase ends, the orchestrator runs \`${testCommand}\` itself and`,
    "REQUIRES it to fail. A suite that passes here means the tests assert",
    "something that was already true, so nothing was actually specified, and the",
    "run stops on the spot with that reason on the issue.",
    "",
    "Test only what this task asks for. Tests for behaviour nobody asked for are",
    "as bad as no tests: the next phase has to make all of them pass.",
    "",
    ...implementClosing(context, "red"),
  ].join("\n");
}

export interface GreenPhaseOptions {
  /** The command the orchestrator runs after this phase. */
  testCommand: string;
  /** 1 based, and it is not going to be raised. */
  iteration: number;
  maxIterations: number;
  /** Tail of the last failing test output, empty on the first iteration. */
  failureOutput: string;
  /** Globs the harness treats as test files. */
  testFilePatterns: readonly string[];
}

/**
 * Phase 2 of 3: GREEN. Production code until the suite passes.
 *
 * Two mechanics are stated here because the agent has to know they exist, but
 * NEITHER of them is enforced by this text: the orchestrator diffs the worktree
 * against the end of the red phase after every iteration, and it counts the
 * iterations. The prompt only makes sure the agent is not surprised by a stop
 * it could have avoided by asking a question instead.
 */
export function implementGreenPrompt(context: RunContext, options: GreenPhaseOptions): string {
  const lines = [
    ...implementBriefing(context),
    "",
    `PHASE 2 OF 3: GREEN, ITERATION ${options.iteration} OF ${options.maxIterations}.`,
    "",
    "The tests of the red phase are committed and failing. Make them pass.",
    "",
    "- write production code; keep it the smallest change that makes the suite",
    "  green without breaking the tests that already passed",
    "- YOU MUST NOT CHANGE ANY TEST FILE IN THIS PHASE. After every iteration the",
    "  orchestrator lists what changed since the red phase",
    "  (git diff --name-only) and stops the run the moment a test file is in that",
    "  list. The file names go into a comment on the issue. This is not a style",
    "  rule and there is nothing to negotiate: a run that may edit its own tests",
    "  proves nothing when it turns green.",
    `  Files it treats as tests: ${options.testFilePatterns.join(", ")}`,
    "- IF A TEST IS GENUINELY WRONG (it asserts something this task does not ask",
    "  for, or something impossible), DO NOT FIX IT AND DO NOT WORK AROUND IT.",
    "  Say which test, and why, on the issue, and end this phase with the blocked",
    "  line below. A human decides. That is the only legal way past a wrong test,",
    "  and using it is a good outcome, not a failure.",
    `- you have ${options.maxIterations} iterations in total. The orchestrator runs`,
    `  \`${options.testCommand}\` after each one. Trying until it somehow works is`,
    "  not one of the options: after the last iteration the run stops and a human",
    "  is called in.",
  ];

  if (options.failureOutput.trim() !== "") {
    lines.push(
      "",
      `Last output of \`${options.testCommand}\`:`,
      "```",
      options.failureOutput,
      "```",
    );
  }

  lines.push("", ...implementClosing(context, "green"));
  return lines.join("\n");
}

/**
 * Phase 3 of 3: REVIEW. The suite is green, which says the code does what the
 * tests say. This phase asks the other question: whether the tests, and the
 * code under them, are what the task actually asked for.
 */
export function implementReviewPrompt(
  context: RunContext,
  checkNames: readonly string[],
): string {
  return [
    ...implementBriefing(context),
    "",
    "PHASE 3 OF 3: REVIEW.",
    "",
    "The test suite passes. Now review the work as if somebody else had written",
    "it and you had to sign it off:",
    "",
    "- read the task description again, then read the diff of this run",
    "  (git diff, git log). Does it answer the task, all of it, and nothing",
    "  beyond it?",
    "- does it fit the architecture around it: the boundaries, the naming, the",
    "  patterns this repository already uses? A green suite says nothing about",
    "  that",
    "- error handling, edge cases the tests do not reach, dead code left behind,",
    "  documentation the change invalidated",
    "- fix what you find, in small commits",
    "",
    "You may ADD a test case here for a hole you found, but you may not weaken or",
    "delete an assertion to make something pass: if an existing test is wrong,",
    "stop and ask, exactly as the previous phase would have.",
    "",
    checkNames.length === 0
      ? "This project declares no checks, so nothing else runs after you."
      : `When you are done, the orchestrator runs the full substrate itself: ${checkNames.join(", ")}. ` +
        "A single red command stops the run, the issue gets the output and nobody sees a review label.",
    "",
    ...implementClosing(context, "review"),
  ].join("\n");
}

/**
 * True when the agent said it stopped on a question.
 *
 * One form for every kind: a `status=blocked` field on the ordinary
 * ASEL_RESULT line. Reusing the existing marker means no second parser, no
 * second thing that can go missing, and a run that forgets the field simply
 * counts as finished, which is the safe direction: a human sees the result on
 * the issue anyway.
 */
export function isBlockedResult(marker: Record<string, string>): boolean {
  return (marker["status"] ?? "").trim().toLowerCase() === BLOCKED_STATUS;
}

/**
 * Parses the trailing ASEL_RESULT line the agent is asked to print.
 * Returns an empty object when the marker is absent.
 *
 * A missing marker is not an error: the run may have had nothing to report, and
 * a zero count is a perfectly good result (an ADR run that found nothing worth
 * recording, an implementation run that only deleted dead code).
 */
export function parseResultMarker(output: string): Record<string, string> {
  const lines = output.split("\n").reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(RESULT_MARKER_PREFIX)) {
      continue;
    }
    const values: Record<string, string> = {};
    for (const token of trimmed.slice(RESULT_MARKER_PREFIX.length).trim().split(/\s+/)) {
      const separator = token.indexOf("=");
      if (separator > 0) {
        values[token.slice(0, separator)] = token.slice(separator + 1);
      }
    }
    return values;
  }
  return {};
}
