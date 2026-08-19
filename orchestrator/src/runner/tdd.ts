/**
 * Implementation run as a chain of three phases: red, green, review.
 *
 * All three happen in ONE container, on ONE worktree and on ONE branch. The
 * orchestrator does not know about any of it: `ImplementRunner.runImplement()`
 * stays a single call that either delivered or did not, and this module is what
 * that call runs inside.
 *
 * The point of the split is that every claim an agent could make about its own
 * work is replaced by a command the harness runs itself:
 *
 *   red     the agent writes tests only. The harness runs the test command and
 *           REQUIRES a failure. A green suite here means the tests assert
 *           nothing new, so the run stops with that reason.
 *   green   the agent implements. After every iteration the harness runs the
 *           suite: green ends the phase, red starts another iteration with the
 *           tail of the output in the prompt. There is a hard iteration limit,
 *           and no way to raise it from inside a run.
 *   review  code review and a look at the architecture, then the FULL substrate
 *           of declared checks. Only a green substrate reaches `asel:in-review`.
 *
 * The mechanic that makes this more than a well worded prompt is the guard on
 * the green phase: it may not change test files. That is checked with
 * `git diff --name-only <sha at the end of red>` after every iteration, and a
 * violation stops the run with the file names in the comment. Nothing is
 * reverted on the agent's behalf and there is nothing to argue about: the one
 * legal way out of a test the agent believes is wrong is the blocked marker,
 * which parks the run on a human.
 *
 * Deliberate decisions:
 *
 * - A REWORK RUNS THE WHOLE CHAIN, from red. A reviewer's remark can change
 *   what the code has to do, and then the tests have to change first. Starting
 *   a rework in the green phase would be the one supported way to edit tests
 *   with the guard switched off, which is exactly the hole this module exists
 *   to close.
 * - THE GUARD RUNS ON GREEN ONLY. The review phase may add a test case for a
 *   hole it found, because forbidding that would make the reviewer useless, and
 *   whatever it does is still gated by the full substrate afterwards.
 * - EVERY PHASE PUSHES. A stopped run leaves its commits visible on origin,
 *   which is what a human needs to judge a blocked or failed run at all.
 */
import {
  describeReport,
  formatCheckFailure,
  formatMissingCommand,
  fullSubstrate,
  isCommandMissing,
  parsePathList,
  runChecks,
  selectTestFiles,
  tailLines,
  testCheck,
  TEST_CHECK_NAME,
  type CheckCommand,
  type CheckReport,
  type CommandOutput,
} from "./checks.js";
import {
  implementGreenPrompt,
  implementPrompt,
  implementRedPrompt,
  implementReviewPrompt,
  isBlockedResult,
} from "./prompts.js";
import {
  blockedResult,
  type ImplementPhase,
  type ImplementPhaseReport,
  type ImplementResult,
  type RunContext,
} from "./types.js";

/** How many green iterations a run gets before a human is called in. */
export const DEFAULT_GREEN_MAX_ITERATIONS = 3;

export const HEAD_SHA_COMMAND = "git rev-parse HEAD";

/**
 * Untracked files, so a test file that was created but never committed is
 * caught as well.
 */
export const UNTRACKED_PATHS_COMMAND = "git ls-files --others --exclude-standard";

/**
 * Everything that differs from `sha`, INCLUDING uncommitted changes in the
 * worktree (no `..HEAD`): an agent that leaves a modified test file behind
 * without committing it has still modified a test file.
 */
export function changedPathsCommand(sha: string): string {
  return `git diff --name-only ${sha}`;
}

/** What one agent phase left behind. */
export interface AgentPhaseOutcome {
  /** Fields of the ASEL_RESULT line the phase printed. */
  marker: Record<string, string>;
  /** Commits the harness brought back for this phase. */
  commitCount: number;
}

/**
 * The impure half of a run, injected.
 *
 * The Sandcastle adapter backs it with one long lived sandbox
 * (`createSandbox()`, `sandbox.run()`, `sandbox.exec()`), the DRY_RUN runner
 * with a script. That is what makes the whole chain, and every gate in it,
 * testable without Docker.
 */
export interface ImplementHarness {
  /** Runs one agent phase against the shared worktree. */
  runPhase(phase: ImplementPhase, prompt: string, iteration: number): Promise<AgentPhaseOutcome>;
  /** Runs a shell command in the same container. A non zero exit is a value. */
  exec(command: string): Promise<CommandOutput>;
}

export interface ImplementChainOptions {
  greenMaxIterations: number;
}

/** Mutable bookkeeping of one chain, turned into the result at the end. */
interface ChainState {
  mode: "tdd" | "single-phase";
  lastPhase: ImplementPhase;
  greenIterations: number;
  commitCount: number;
  checks: Array<{ name: string; exitCode: number }>;
}

function reportOf(state: ChainState): ImplementPhaseReport {
  return {
    mode: state.mode,
    lastPhase: state.lastPhase,
    greenIterations: state.greenIterations,
    checks: state.checks,
  };
}

function failure(state: ChainState, summary: string, error: string): ImplementResult {
  return { ok: false, summary, error, phases: reportOf(state) };
}

function blocked(state: ChainState, phase: ImplementPhase): ImplementResult {
  const base = blockedResult(`implementation run (${phase} phase)`);
  return { ...base, phases: reportOf(state) };
}

async function headSha(harness: ImplementHarness): Promise<string> {
  const result = await harness.exec(HEAD_SHA_COMMAND);
  return result.output.trim().split("\n")[0]?.trim() ?? "";
}

/** Changed plus untracked paths, relative to the repository root. */
async function changedPaths(harness: ImplementHarness, sha: string): Promise<string[]> {
  const changed = await harness.exec(changedPathsCommand(sha));
  const untracked = await harness.exec(UNTRACKED_PATHS_COMMAND);
  const paths = new Set([...parsePathList(changed.output), ...parsePathList(untracked.output)]);
  return [...paths];
}

/**
 * Runs the declared substrate and records the exit codes on the state, so the
 * result carries them whether the run ends here or later.
 */
async function runSubstrate(
  context: RunContext,
  harness: ImplementHarness,
  state: ChainState,
): Promise<CheckReport> {
  const commands = fullSubstrate(context.project.checks);
  const report = await runChecks(commands, (command) => harness.exec(command));
  state.checks = report.executed.map((execution) => ({
    name: execution.name,
    exitCode: execution.exitCode,
  }));
  context.log.info("substrate finished", {
    verdict: report.verdict,
    checks: describeReport(report),
  });
  return report;
}

/**
 * Stops the run when the test command does not exist in the container.
 *
 * Checked at every place the suite is run, because the answer differs from
 * "red": a missing command in the red phase would otherwise be read as a
 * failing suite and send the run on to implement against nothing, and in the
 * green phase it would burn every iteration on a command that never ran.
 */
function missingTestCommandFailure(
  state: ChainState,
  test: CheckCommand,
  result: CommandOutput,
): ImplementResult | null {
  if (!isCommandMissing(result)) {
    return null;
  }
  return failure(
    state,
    `The test command does not exist in the container: \`${test.command}\``,
    formatMissingCommand(TEST_CHECK_NAME, test.command, result.output),
  );
}

function substrateFailure(state: ChainState, report: CheckReport): ImplementResult | null {
  if (report.verdict === "green" || report.failure === null) {
    return null;
  }
  return failure(
    state,
    `The substrate is red: check "${report.failure.name}" failed`,
    formatCheckFailure(report.failure),
  );
}

/**
 * Fallback for a project with no `test` command: one agent phase, then the
 * substrate it did declare. The phases are skipped rather than faked, because a
 * red phase nobody can verify is worse than no red phase: it would teach the
 * factory to trust a claim.
 */
async function runSinglePhase(
  context: RunContext,
  harness: ImplementHarness,
): Promise<ImplementResult> {
  const state: ChainState = {
    mode: "single-phase",
    lastPhase: "single",
    greenIterations: 0,
    commitCount: 0,
    checks: [],
  };
  context.log.warn(
    "no `test` check declared for this project, the test first phases cannot be enforced",
    { project: context.project.name, source: context.project.sourceFile },
  );

  const outcome = await harness.runPhase("single", implementPrompt(context), 1);
  state.commitCount += outcome.commitCount;
  if (isBlockedResult(outcome.marker)) {
    return blocked(state, "single");
  }

  const report = await runSubstrate(context, harness, state);
  const red = substrateFailure(state, report);
  if (red !== null) {
    return red;
  }

  return {
    ok: true,
    summary:
      `${state.commitCount} commits pushed to ${context.branch} ` +
      `(single phase run: this project declares no test command, ` +
      `${state.checks.length} checks green)`,
    branch: context.branch,
    commitCount: state.commitCount,
    phases: reportOf(state),
  };
}

/**
 * One implementation run: the whole chain, or the single phase fallback.
 *
 * Returns rather than throws for every expected way of stopping (a red gate, a
 * blocked agent), because those are outcomes of the run and the orchestrator
 * has a label for each. Only an unexpected error propagates.
 */
export async function runImplementChain(
  context: RunContext,
  harness: ImplementHarness,
  options: ImplementChainOptions,
): Promise<ImplementResult> {
  const test: CheckCommand | null = testCheck(context.project.checks);
  if (test === null) {
    return runSinglePhase(context, harness);
  }

  const patterns = context.project.testFilePatterns;
  const maxIterations = Math.max(1, options.greenMaxIterations);
  const state: ChainState = {
    mode: "tdd",
    lastPhase: "red",
    greenIterations: 0,
    commitCount: 0,
    checks: [],
  };

  // Phase 1: red.
  context.log.info("implement phase started", { phase: "red", testCommand: test.command });
  const red = await harness.runPhase("red", implementRedPrompt(context, test.command), 1);
  state.commitCount += red.commitCount;
  if (isBlockedResult(red.marker)) {
    return blocked(state, "red");
  }

  // The baseline for the green guard. Anything already dirty at this point was
  // left behind by the red phase itself, so it is excluded from the guard: the
  // green phase can only be blamed for what IT changed.
  const baselineSha = await headSha(harness);
  const redLeftovers = new Set(await changedPaths(harness, baselineSha));
  if (redLeftovers.size > 0) {
    context.log.warn("the red phase left uncommitted changes behind", {
      files: [...redLeftovers].join(", "),
    });
  }

  const afterRed = await harness.exec(test.command);
  context.log.info("substrate after the red phase", {
    command: test.command,
    exitCode: afterRed.exitCode,
  });
  const redCommandMissing = missingTestCommandFailure(state, test, afterRed);
  if (redCommandMissing !== null) {
    return redCommandMissing;
  }
  if (afterRed.exitCode === 0) {
    return failure(
      state,
      "The red phase ended with a passing test suite, so nothing was specified",
      [
        `The red phase ended with a passing test suite: \`${test.command}\` exited 0.`,
        "A test written before the work exists has to fail; one that passes the",
        "moment it is written asserts something that was already true, so this run",
        "specified nothing and stopped before implementing anything.",
        "",
        "Last lines of the test output:",
        tailLines(afterRed.output),
      ].join("\n"),
    );
  }

  // Phase 2: green.
  state.lastPhase = "green";
  let failureOutput = tailLines(afterRed.output);
  let green = false;
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    state.greenIterations = iteration;
    context.log.info("implement phase started", { phase: "green", iteration, maxIterations });
    const outcome = await harness.runPhase(
      "green",
      implementGreenPrompt(context, {
        testCommand: test.command,
        iteration,
        maxIterations,
        failureOutput,
        testFilePatterns: patterns,
      }),
      iteration,
    );
    state.commitCount += outcome.commitCount;
    if (isBlockedResult(outcome.marker)) {
      // The legal way out of a test the agent believes is wrong.
      return blocked(state, "green");
    }

    // The guard comes BEFORE the suite: a suite the agent was free to edit says
    // nothing, so there is no point in running it first.
    const changed = (await changedPaths(harness, baselineSha)).filter(
      (path) => !redLeftovers.has(path),
    );
    const touched = selectTestFiles(changed, patterns);
    if (touched.length > 0) {
      context.log.error("the green phase changed test files", { files: touched.join(", ") });
      return failure(
        state,
        `The green phase changed ${touched.length} test file(s), which stops the run`,
        [
          "The green phase changed test files. It may not: a run that edits its own",
          "tests proves nothing when the suite turns green, so the harness stops",
          "here rather than accept the result.",
          "",
          "Files changed since the end of the red phase:",
          ...touched.map((path) => `  ${path}`),
          "",
          "Nothing was reverted, so the commits are on the branch for you to read.",
          "If a test really is wrong, say so in a comment and set the rework label:",
          "the run may then stop on that question instead of rewriting the test.",
        ].join("\n"),
      );
    }

    const result = await harness.exec(test.command);
    context.log.info("substrate after a green iteration", {
      iteration,
      exitCode: result.exitCode,
    });
    const greenCommandMissing = missingTestCommandFailure(state, test, result);
    if (greenCommandMissing !== null) {
      return greenCommandMissing;
    }
    if (result.exitCode === 0) {
      green = true;
      break;
    }
    failureOutput = tailLines(result.output);
  }

  if (!green) {
    return failure(
      state,
      `The green phase did not reach a passing suite in ${maxIterations} iterations`,
      [
        `The green phase ran ${maxIterations} iterations and the test suite is still`,
        `red. The limit is deliberate: an agent that has not got there in`,
        `${maxIterations} tries is usually missing something a human knows.`,
        "",
        "Last lines of the test output:",
        failureOutput,
      ].join("\n"),
    );
  }

  // Phase 3: review, then the full substrate.
  state.lastPhase = "review";
  context.log.info("implement phase started", { phase: "review" });
  const review = await harness.runPhase(
    "review",
    implementReviewPrompt(
      context,
      context.project.checks.map((check) => check.name),
    ),
    1,
  );
  state.commitCount += review.commitCount;
  if (isBlockedResult(review.marker)) {
    return blocked(state, "review");
  }

  const report = await runSubstrate(context, harness, state);
  const substrateRed = substrateFailure(state, report);
  if (substrateRed !== null) {
    return substrateRed;
  }

  return {
    ok: true,
    summary:
      `${state.commitCount} commits pushed to ${context.branch} ` +
      `(tests first: red, green after ${state.greenIterations} ` +
      `iteration${state.greenIterations === 1 ? "" : "s"}, review, ` +
      `${state.checks.length} checks green)`,
    branch: context.branch,
    commitCount: state.commitCount,
    phases: reportOf(state),
  };
}
