import { describe, expect, it } from "vitest";
import {
  CHECK_OUTPUT_TAIL_LINES,
  COMMAND_NOT_FOUND_EXIT_CODE,
  DEFAULT_TEST_FILE_PATTERNS,
  TEST_CHECK_NAME,
  findCheck,
  formatCheckFailure,
  formatMissingCommand,
  isCommandMissing,
  fullSubstrate,
  isTddEnforceable,
  matchesTestFile,
  parsePathList,
  runChecks,
  selectTestFiles,
  tailLines,
  testCheck,
  type CheckCommand,
  type CommandOutput,
} from "./checks.js";

const CHECKS: CheckCommand[] = [
  { name: "typecheck", command: "pnpm tsc --noEmit" },
  { name: "lint", command: "pnpm lint" },
  { name: TEST_CHECK_NAME, command: "pnpm test --run" },
];

/** Exec double: every command is green unless the map says otherwise. */
function execWith(exitCodes: Record<string, number>, seen: string[] = []) {
  return async (command: string): Promise<CommandOutput> => {
    seen.push(command);
    const exitCode = exitCodes[command] ?? 0;
    return { exitCode, output: `output of ${command}` };
  };
}

describe("declared checks", () => {
  it("finds a command by name and keeps the declared order", () => {
    expect(findCheck(CHECKS, "lint")).toEqual({ name: "lint", command: "pnpm lint" });
    expect(findCheck(CHECKS, "bench")).toBeNull();
    expect(fullSubstrate(CHECKS).map((check) => check.name)).toEqual([
      "typecheck",
      "lint",
      "test",
    ]);
  });

  it("treats `test` as the one command with a meaning of its own", () => {
    expect(testCheck(CHECKS)?.command).toBe("pnpm test --run");
    expect(isTddEnforceable(CHECKS)).toBe(true);
  });

  it("says TDD is not enforceable when no test command is declared", () => {
    expect(testCheck([{ name: "lint", command: "pnpm lint" }])).toBeNull();
    expect(isTddEnforceable([{ name: "lint", command: "pnpm lint" }])).toBe(false);
    expect(isTddEnforceable([])).toBe(false);
  });
});

describe("runChecks", () => {
  it("runs every command in order and reports green", async () => {
    const seen: string[] = [];
    const report = await runChecks(CHECKS, execWith({}, seen));
    expect(report.verdict).toBe("green");
    expect(report.failure).toBeNull();
    expect(report.skipped).toEqual([]);
    expect(seen).toEqual(["pnpm tsc --noEmit", "pnpm lint", "pnpm test --run"]);
  });

  it("stops at the first red command and reports what never ran", async () => {
    const seen: string[] = [];
    const report = await runChecks(CHECKS, execWith({ "pnpm lint": 1 }, seen));
    expect(report.verdict).toBe("red");
    expect(report.failure).toMatchObject({ name: "lint", exitCode: 1 });
    expect(report.executed.map((execution) => execution.name)).toEqual(["typecheck", "lint"]);
    expect(report.skipped).toEqual(["test"]);
    expect(seen).not.toContain("pnpm test --run");
  });

  it("counts an empty substrate as green, because nothing was declared", async () => {
    const seen: string[] = [];
    const report = await runChecks([], execWith({}, seen));
    expect(report.verdict).toBe("green");
    expect(report.executed).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe("output tail", () => {
  it("keeps the last lines only", () => {
    const text = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
    const tail = tailLines(text).split("\n");
    expect(tail).toHaveLength(CHECK_OUTPUT_TAIL_LINES);
    expect(tail.at(-1)).toBe("line 199");
  });

  it("returns short output untouched", () => {
    expect(tailLines("one\ntwo")).toBe("one\ntwo");
  });

  it("neutralizes a code fence, because the caller puts this inside one", () => {
    expect(tailLines("before\n```\nafter")).toBe("before\n'''\nafter");
  });

  it("names the failing command and adds no code fence of its own", () => {
    const message = formatCheckFailure({
      name: "lint",
      command: "pnpm lint",
      exitCode: 2,
      output: "boom",
    });
    expect(message).toContain("lint");
    expect(message).toContain("pnpm lint");
    expect(message).toContain("2");
    expect(message).toContain("boom");
    expect(message).not.toContain("```");
  });
});

describe("test file patterns", () => {
  it("recognizes the conventional shapes with the shipped defaults", () => {
    const patterns = DEFAULT_TEST_FILE_PATTERNS;
    expect(matchesTestFile("src/importer.test.ts", patterns)).toBe(true);
    expect(matchesTestFile("importer.spec.tsx", patterns)).toBe(true);
    expect(matchesTestFile("test/helpers/build.ts", patterns)).toBe(true);
    expect(matchesTestFile("tests/e2e/login.ts", patterns)).toBe(true);
    expect(matchesTestFile("src/app/__tests__/login.ts", patterns)).toBe(true);
  });

  it("leaves production files alone", () => {
    const patterns = DEFAULT_TEST_FILE_PATTERNS;
    expect(matchesTestFile("src/importer.ts", patterns)).toBe(false);
    expect(matchesTestFile("src/latest.ts", patterns)).toBe(false);
    expect(matchesTestFile("docs/testing.md", patterns)).toBe(false);
  });

  it("picks the test files out of a changed file list", () => {
    expect(
      selectTestFiles(
        ["src/a.ts", "src/a.test.ts", "README.md", "tests/b.ts"],
        DEFAULT_TEST_FILE_PATTERNS,
      ),
    ).toEqual(["src/a.test.ts", "tests/b.ts"]);
  });

  it("reads a git path list, ignoring blank lines and ./ prefixes", () => {
    expect(parsePathList("src/a.ts\n\n./src/b.ts\n")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(parsePathList("")).toEqual([]);
  });
});

describe("a command that does not exist is not a red command", () => {
  it("recognizes the shell's exit code for a missing command", () => {
    expect(isCommandMissing({ exitCode: COMMAND_NOT_FOUND_EXIT_CODE, output: "" })).toBe(true);
    expect(isCommandMissing({ exitCode: 1, output: "" })).toBe(false);
    expect(isCommandMissing({ exitCode: 0, output: "" })).toBe(false);
  });

  it("says it is configuration, not a failing suite", () => {
    const text = formatMissingCommand("test", "pnpm test --run", "sh: pnpm: not found");
    expect(text).toContain("command not found");
    expect(text).toContain("configuration problem");
    expect(text).toContain("project image");
    expect(text).toContain("sh: pnpm: not found");
  });

  it("reaches the issue comment through formatCheckFailure", () => {
    const text = formatCheckFailure({
      name: "lint",
      command: "pnpm lint",
      exitCode: COMMAND_NOT_FOUND_EXIT_CODE,
      output: "sh: pnpm: not found",
    });
    expect(text).toContain("configuration problem");
    // The ordinary wording would blame the code instead.
    expect(text).not.toContain("failed with exit code");
  });
});
