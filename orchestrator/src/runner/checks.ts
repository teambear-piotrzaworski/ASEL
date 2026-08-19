/**
 * Substrate gates: the commands the ORCHESTRATOR runs, and the decisions it
 * takes from their exit codes.
 *
 * Two rules shape this module:
 *
 * 1. A verdict is an exit code, never a sentence in the agent's output. An
 *    agent saying "all tests pass" is a claim; `pnpm test` exiting 0 is a fact,
 *    and only the second one moves an issue to `asel:in-review`.
 * 2. Everything here is pure, or takes the one impure step (running a command)
 *    as an argument. That way the whole decision layer - what is green, what is
 *    red, what never ran - is testable without Docker, without a sandbox and
 *    without a repository.
 *
 * The commands themselves come from the project registry (`checks:` in
 * `projects/<name>.yml`), as an ORDERED map of name to shell command. One name
 * is special: `test` is the command the red and the green phase of an
 * implementation run are gated on. The rest only run in the full substrate at
 * the end of the review phase.
 */

/** The one check name with a meaning of its own. */
export const TEST_CHECK_NAME = "test";

/**
 * Check names must start with a letter.
 *
 * Not decoration: the registry declares checks as a YAML mapping and the order
 * of that mapping is the order they run in. JavaScript objects only preserve
 * insertion order for keys that do not look like array indices, so a check
 * named "1" would silently jump to the front. A leading letter makes the
 * declared order the executed order, always.
 */
export const CHECK_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]*$/;

/** How much of a failing command's output travels into an issue comment. */
export const CHECK_OUTPUT_TAIL_LINES = 50;

/**
 * The exit code a shell uses for "command not found".
 *
 * Worth a case of its own, because it is the one failure that looks exactly like
 * a red suite and means the opposite. A red phase gated on a command that does
 * not exist in the image would be read as "the tests fail, good, implement now",
 * and the whole test first regime would run on a command nobody ever executed.
 * The cause is always configuration (a check declared in the registry, a
 * toolchain missing from the project image), never the code under test, so it
 * stops the run with that reason instead of being counted as red.
 *
 * A test command that itself shells out to something missing lands here too.
 * That is a rare and equally broken setup, and the message points at the same
 * two places, so the misdiagnosis costs nothing.
 */
export const COMMAND_NOT_FOUND_EXIT_CODE = 127;

/** Whether a command failed because it does not exist, rather than by failing. */
export function isCommandMissing(result: CommandOutput): boolean {
  return result.exitCode === COMMAND_NOT_FOUND_EXIT_CODE;
}

/** Failure text for a command the container could not find. */
export function formatMissingCommand(name: string, command: string, output: string): string {
  return [
    `check "${name}" could not be run: \`${command}\` exited ` +
      `${COMMAND_NOT_FOUND_EXIT_CODE} (command not found).`,
    "",
    "That is a configuration problem, not a red suite: either the check is",
    "declared wrong in the project registry, or the project image does not ship",
    "the toolchain it needs. The run stopped here rather than read a missing",
    "command as a failing test.",
    "",
    `last ${CHECK_OUTPUT_TAIL_LINES} lines of output:`,
    tailLines(output),
  ].join("\n");
}

/**
 * Files the green phase of an implementation run must not touch.
 *
 * Matching is anchored at the repository root, the way a glob normally is, so
 * `test/**` means the top level `test/` directory and nothing else. The
 * `__tests__` entry is the exception: that directory is nested by convention,
 * never at the root, so it is declared as `**\/__tests__/**`. A project that
 * keeps its suites somewhere else overrides the whole list in its registry
 * file.
 */
export const DEFAULT_TEST_FILE_PATTERNS: readonly string[] = [
  "**/*.test.*",
  "**/*.spec.*",
  "test/**",
  "tests/**",
  "**/__tests__/**",
];

/** One declared command of the substrate. */
export interface CheckCommand {
  readonly name: string;
  readonly command: string;
}

/** What running a shell command in the task container gave back. */
export interface CommandOutput {
  readonly exitCode: number;
  /** stdout and stderr, in the order they were produced when possible. */
  readonly output: string;
}

export interface CheckExecution extends CheckCommand, CommandOutput {}

export interface CheckReport {
  readonly verdict: "green" | "red";
  readonly executed: readonly CheckExecution[];
  /** The first red command, or null when everything passed. */
  readonly failure: CheckExecution | null;
  /** Declared commands that never ran, because an earlier one was red. */
  readonly skipped: readonly string[];
}

/** The single impure step, injected so the decisions above stay testable. */
export type CheckExec = (command: string) => Promise<CommandOutput>;

export function findCheck(checks: readonly CheckCommand[], name: string): CheckCommand | null {
  return checks.find((check) => check.name === name) ?? null;
}

/** The command the red and green phases are gated on, when the project has one. */
export function testCheck(checks: readonly CheckCommand[]): CheckCommand | null {
  return findCheck(checks, TEST_CHECK_NAME);
}

/**
 * Whether the test first regime can be ENFORCED at all.
 *
 * Without a test command there is nothing to make red and nothing to turn
 * green, so the phases would be theatre: three prompts and no verdict. A
 * project in that state falls back to a single implementation phase (see
 * runner/tdd.ts) instead of blocking the factory.
 */
export function isTddEnforceable(checks: readonly CheckCommand[]): boolean {
  return testCheck(checks) !== null;
}

/**
 * Everything the review phase is gated on: all declared commands, in the order
 * the registry declares them, `test` included. The order is the project's call,
 * so a cheap typecheck can be put in front of a slow suite.
 */
export function fullSubstrate(checks: readonly CheckCommand[]): readonly CheckCommand[] {
  return checks;
}

/**
 * Runs commands until one of them is red.
 *
 * Fail fast on purpose: the first red command is the one a human has to look
 * at, and the ones behind it would mostly repeat its noise. What never ran is
 * reported as skipped rather than silently dropped.
 */
export async function runChecks(
  commands: readonly CheckCommand[],
  exec: CheckExec,
): Promise<CheckReport> {
  const executed: CheckExecution[] = [];
  for (let index = 0; index < commands.length; index += 1) {
    const check = commands[index] as CheckCommand;
    const result = await exec(check.command);
    const execution: CheckExecution = {
      name: check.name,
      command: check.command,
      exitCode: result.exitCode,
      output: result.output,
    };
    executed.push(execution);
    if (result.exitCode !== 0) {
      return {
        verdict: "red",
        executed,
        failure: execution,
        skipped: commands.slice(index + 1).map((rest) => rest.name),
      };
    }
  }
  return { verdict: "green", executed, failure: null, skipped: [] };
}

/**
 * Last lines of a command's output, which is the part that says what broke.
 *
 * Triple backticks are neutralized: every consumer of this puts the text inside
 * a fenced block (an issue comment, the next prompt), and a fence inside a
 * fence closes it early, which turns the rest of the comment into markdown
 * soup. Losing three characters of a lint message is the cheaper problem.
 */
export function tailLines(text: string, limit: number = CHECK_OUTPUT_TAIL_LINES): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  return lines
    .slice(Math.max(0, lines.length - limit))
    .join("\n")
    .replace(/```/g, "'''");
}

/**
 * Failure text for an issue comment.
 *
 * Deliberately without a code fence: the orchestrator wraps the whole error in
 * one (see index.ts), and a second fence inside it would break the block.
 */
export function formatCheckFailure(execution: CheckExecution): string {
  if (isCommandMissing(execution)) {
    return formatMissingCommand(execution.name, execution.command, execution.output);
  }
  return [
    `check "${execution.name}" failed with exit code ${execution.exitCode}: ${execution.command}`,
    "",
    `last ${CHECK_OUTPUT_TAIL_LINES} lines of output:`,
    tailLines(execution.output),
  ].join("\n");
}

/** One line summary of a report, for the log. */
export function describeReport(report: CheckReport): string {
  const parts = report.executed.map((execution) => `${execution.name}=${execution.exitCode}`);
  for (const name of report.skipped) {
    parts.push(`${name}=skipped`);
  }
  return parts.length === 0 ? "no checks declared" : parts.join(" ");
}

/**
 * Glob to regular expression, for the subset of glob a path list needs:
 * `**\/` (any number of leading directories), `**` (anything), `*` (anything
 * but a separator) and `?` (one character but a separator).
 *
 * Hand rolled because the orchestrator has no glob dependency and this is the
 * only place that needs one. Anything more exotic than the above belongs in a
 * library, not here.
 */
function patternToRegExp(pattern: string): RegExp {
  let source = "^";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern.charAt(index);
    if (char === "*") {
      if (pattern.charAt(index + 1) === "*") {
        if (pattern.charAt(index + 2) === "/") {
          source += "(?:.*/)?";
          index += 3;
          continue;
        }
        source += ".*";
        index += 2;
        continue;
      }
      source += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }
  return new RegExp(`${source}$`);
}

const patternCache = new Map<string, RegExp>();

function compiled(pattern: string): RegExp {
  const cached = patternCache.get(pattern);
  if (cached !== undefined) {
    return cached;
  }
  const expression = patternToRegExp(pattern);
  patternCache.set(pattern, expression);
  return expression;
}

/** Normalizes a git path: forward slashes, no leading "./". */
export function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

export function matchesTestFile(path: string, patterns: readonly string[]): boolean {
  const normalized = normalizePath(path);
  return patterns.some((pattern) => compiled(pattern).test(normalized));
}

export function selectTestFiles(
  paths: readonly string[],
  patterns: readonly string[],
): string[] {
  return paths.filter((path) => matchesTestFile(path, patterns)).map(normalizePath);
}

/** Reads the output of a git command that prints one path per line. */
export function parsePathList(output: string): string[] {
  return output
    .split("\n")
    .map(normalizePath)
    .filter((path) => path !== "");
}
