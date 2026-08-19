import { describe, expect, it } from "vitest";
import type { GitCommand, GitExec } from "./git-sync.js";
import type { Logger } from "./logger.js";
import type { CommandOutput } from "./runner/checks.js";
import {
  WorktreeResetError,
  formatWorktreeFailure,
  originBranchCommand,
  parseRefExists,
  planWorktreeReset,
  resetWorktree,
  worktreeCleanCommand,
  worktreeDefaultBranchCommand,
  worktreeFetchCommand,
  worktreeNameFor,
  worktreePathFor,
  worktreeResetCommand,
  type WorktreeRefs,
  type WorktreeResetRequest,
} from "./worktree-reset.js";

const TOKEN = "ghp_secret_token_value";

const REQUEST: WorktreeResetRequest = {
  repoPath: "/repos/acme__example",
  branch: "asel/plan-2",
  token: TOKEN,
};

/** The path sandcastle really uses, as verified on disk for asel/plan-2. */
const WORKTREE = "/repos/acme__example/.sandcastle/worktrees/asel-plan-2";

const silentLog: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLog,
};

interface LogLine {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly meta: Record<string, unknown>;
}

/** Logger double: keeps every line so a test can assert what was reported. */
function recordingLog(lines: LogLine[]): Logger {
  const push =
    (level: LogLine["level"]) =>
    (message: string, meta: Record<string, unknown> = {}): void =>
      void lines.push({ level, message, meta });
  const log: Logger = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    child: () => log,
  };
  return log;
}

/** The git invocations resetWorktree can make, named so a test can script them. */
type GitStep = "fetch" | "origin-branch" | "default-branch" | "reset" | "clean";

function stepOf(command: GitCommand): GitStep {
  // Everything runs inside the worktree: git -C <worktree> <verb> ...
  const verb = command.args[2];
  if (verb === "fetch") return "fetch";
  if (verb === "rev-parse") return "origin-branch";
  if (verb === "symbolic-ref") return "default-branch";
  if (verb === "reset") return "reset";
  if (verb === "clean") return "clean";
  throw new Error(`test double got an unexpected command: ${command.display}`);
}

/** A worktree of a plan whose branch is already on origin, one commit behind. */
const HEALTHY: Record<GitStep, CommandOutput> = {
  fetch: { exitCode: 0, output: "" },
  "origin-branch": { exitCode: 0, output: "2222222222222222222222222222222222222222\n" },
  "default-branch": { exitCode: 0, output: "origin/main\n" },
  reset: { exitCode: 0, output: "HEAD is now at 2222222 previous run\n" },
  clean: { exitCode: 0, output: "Removing scratch.txt\n" },
};

/** `rev-parse --verify --quiet` on a ref that is not there. */
const NO_ORIGIN_BRANCH: CommandOutput = { exitCode: 1, output: "" };

function gitDouble(
  overrides: Partial<Record<GitStep, CommandOutput>> = {},
  seen: GitCommand[] = [],
): GitExec {
  return async (command) => {
    seen.push(command);
    return overrides[stepOf(command)] ?? HEALTHY[stepOf(command)];
  };
}

function steps(seen: readonly GitCommand[]): GitStep[] {
  return seen.map(stepOf);
}

function commandFor(seen: readonly GitCommand[], step: GitStep): GitCommand | undefined {
  return seen.find((command) => stepOf(command) === step);
}

describe("worktree path", () => {
  it("turns every slash of the branch into a dash, the way sandcastle does", () => {
    expect(worktreeNameFor("asel/plan-2")).toBe("asel-plan-2");
    expect(worktreeNameFor("sandcastle/spike/2026-01-01")).toBe("sandcastle-spike-2026-01-01");
    expect(worktreeNameFor("main")).toBe("main");
  });

  it("builds the path sandcastle keeps the worktree at", () => {
    expect(worktreePathFor(REQUEST.repoPath, REQUEST.branch)).toBe(WORKTREE);
  });
});

describe("commands", () => {
  it("fetches with prune from inside the worktree, with the credential", () => {
    const command = worktreeFetchCommand(WORKTREE, REQUEST);
    expect(command.args).toEqual(["-C", WORKTREE, "fetch", "--prune", "origin"]);
    // The whole point: sandcastle's own fetch runs here without a token.
    expect(command.env["GIT_CONFIG_COUNT"]).toBe("1");
  });

  it("asks quietly whether the plan branch is on origin at all", () => {
    expect(originBranchCommand(WORKTREE, REQUEST).args).toEqual([
      "-C",
      WORKTREE,
      "rev-parse",
      "--verify",
      "--quiet",
      "refs/remotes/origin/asel/plan-2^{commit}",
    ]);
  });

  it("reads the default branch from the refs the worktree shares with the clone", () => {
    expect(worktreeDefaultBranchCommand(WORKTREE, REQUEST).args).toEqual([
      "-C",
      WORKTREE,
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
  });

  it("resets the worktree hard onto the ref it was given", () => {
    expect(worktreeResetCommand(WORKTREE, REQUEST, "origin/asel/plan-2").args).toEqual([
      "-C",
      WORKTREE,
      "reset",
      "--hard",
      "origin/asel/plan-2",
    ]);
  });

  it("cleans untracked files but keeps ignored ones, so no -x", () => {
    const command = worktreeCleanCommand(WORKTREE, REQUEST);
    expect(command.args).toEqual(["-C", WORKTREE, "clean", "-fd"]);
    expect(command.args).not.toContain("-fdx");
  });

  it("keeps the token out of argv and out of the loggable form", () => {
    const commands = [
      worktreeFetchCommand(WORKTREE, REQUEST),
      originBranchCommand(WORKTREE, REQUEST),
      worktreeDefaultBranchCommand(WORKTREE, REQUEST),
      worktreeResetCommand(WORKTREE, REQUEST, "origin/main"),
      worktreeCleanCommand(WORKTREE, REQUEST),
    ];
    for (const command of commands) {
      expect(command.args.join(" ")).not.toContain(TOKEN);
      expect(command.display).not.toContain(TOKEN);
      expect(command.display.startsWith("git ")).toBe(true);
    }
  });

  it("hands the credential only to the command that talks to github", () => {
    const local = [
      originBranchCommand(WORKTREE, REQUEST),
      worktreeDefaultBranchCommand(WORKTREE, REQUEST),
      worktreeResetCommand(WORKTREE, REQUEST, "origin/main"),
      worktreeCleanCommand(WORKTREE, REQUEST),
    ];
    for (const command of local) {
      expect(command.env["GIT_CONFIG_COUNT"]).toBeUndefined();
      expect(command.env["GIT_TERMINAL_PROMPT"]).toBe("0");
    }
  });
});

describe("reading the refs", () => {
  it("calls a ref found only when git printed a commit for it", () => {
    expect(parseRefExists({ exitCode: 0, output: "2222222\n" })).toBe(true);
    expect(parseRefExists({ exitCode: 1, output: "" })).toBe(false);
    expect(parseRefExists({ exitCode: 0, output: "\n" })).toBe(false);
  });
});

describe("reset plan", () => {
  function refs(overrides: Partial<WorktreeRefs> = {}): WorktreeRefs {
    return { originBranchExists: true, defaultBranch: "main", ...overrides };
  }

  it("resets a continued plan onto what origin has for its branch", () => {
    expect(planWorktreeReset(WORKTREE, "asel/plan-2", refs())).toEqual({
      action: "reset",
      ref: "origin/asel/plan-2",
      kind: "plan-branch",
    });
  });

  it("falls back to the default branch on the first run of a plan", () => {
    expect(
      planWorktreeReset(WORKTREE, "asel/plan-2", refs({ originBranchExists: false })),
    ).toEqual({ action: "reset", ref: "origin/main", kind: "default-branch" });
  });

  it("uses whatever the clone calls its default branch, never a hardcoded main", () => {
    const plan = planWorktreeReset(
      WORKTREE,
      "asel/plan-2",
      refs({ originBranchExists: false, defaultBranch: "trunk" }),
    );
    expect(plan).toMatchObject({ action: "reset", ref: "origin/trunk" });
  });

  it("prefers the plan branch even when a default branch is known", () => {
    const plan = planWorktreeReset(WORKTREE, "asel/plan-2", refs({ defaultBranch: "trunk" }));
    expect(plan).toMatchObject({ ref: "origin/asel/plan-2" });
  });

  it("refuses to guess a ref when there is neither a plan branch nor an origin/HEAD", () => {
    const plan = planWorktreeReset(
      WORKTREE,
      "asel/plan-2",
      refs({ originBranchExists: false, defaultBranch: undefined }),
    );
    expect(plan.action).toBe("fail");
    const reason = plan.action === "fail" ? plan.reason : "";
    expect(reason).toContain(WORKTREE);
    expect(reason).toContain("git remote set-head origin --auto");
    expect(reason).toContain("Nothing was changed or deleted automatically");
  });
});

describe("resetWorktree", () => {
  it("runs nothing when sandcastle has no worktree for this branch yet", async () => {
    const seen: GitCommand[] = [];
    const action = await resetWorktree(REQUEST, {
      exists: async () => false,
      exec: gitDouble({}, seen),
      log: silentLog,
    });
    expect(action).toBe("absent");
    expect(seen).toHaveLength(0);
  });

  it("looks for the worktree exactly where sandcastle keeps it", async () => {
    const asked: string[] = [];
    await resetWorktree(REQUEST, {
      exists: async (path) => {
        asked.push(path);
        return false;
      },
      exec: gitDouble(),
      log: silentLog,
    });
    expect(asked).toEqual([WORKTREE]);
  });

  it("fetches, then resets and cleans an existing worktree onto its plan branch", async () => {
    const seen: GitCommand[] = [];
    const lines: LogLine[] = [];
    const action = await resetWorktree(REQUEST, {
      exists: async () => true,
      exec: gitDouble({}, seen),
      log: recordingLog(lines),
    });
    expect(action).toBe("reset");
    expect(steps(seen)).toEqual(["fetch", "origin-branch", "default-branch", "reset", "clean"]);
    expect(commandFor(seen, "reset")?.args).toContain("origin/asel/plan-2");
    expect(lines.some((line) => line.meta["ref"] === "origin/asel/plan-2")).toBe(true);
  });

  it("resets onto the default branch when the plan branch is not on origin yet", async () => {
    const seen: GitCommand[] = [];
    await resetWorktree(REQUEST, {
      exists: async () => true,
      exec: gitDouble({ "origin-branch": NO_ORIGIN_BRANCH }, seen),
      log: silentLog,
    });
    expect(commandFor(seen, "reset")?.args).toContain("origin/main");
    expect(steps(seen)).toContain("clean");
  });

  it("takes the fallback branch from origin/HEAD, not from a guess", async () => {
    const seen: GitCommand[] = [];
    await resetWorktree(REQUEST, {
      exists: async () => true,
      exec: gitDouble(
        {
          "origin-branch": NO_ORIGIN_BRANCH,
          "default-branch": { exitCode: 0, output: "origin/develop\n" },
        },
        seen,
      ),
      log: silentLog,
    });
    expect(commandFor(seen, "reset")?.args).toContain("origin/develop");
  });

  it("resets only after the fetch, never before it", async () => {
    const seen: GitCommand[] = [];
    await resetWorktree(REQUEST, {
      exists: async () => true,
      exec: gitDouble({}, seen),
      log: silentLog,
    });
    const order = steps(seen);
    expect(order.indexOf("fetch")).toBeLessThan(order.indexOf("reset"));
    expect(order.indexOf("reset")).toBeLessThan(order.indexOf("clean"));
  });

  it("hands the credential to the fetch and to nothing else", async () => {
    const seen: GitCommand[] = [];
    await resetWorktree(REQUEST, {
      exists: async () => true,
      exec: gitDouble({}, seen),
      log: silentLog,
    });
    expect(commandFor(seen, "fetch")?.env["GIT_CONFIG_COUNT"]).toBe("1");
    for (const step of ["origin-branch", "default-branch", "reset", "clean"] as const) {
      expect(commandFor(seen, step)?.env["GIT_CONFIG_COUNT"]).toBeUndefined();
    }
  });

  it("works without a token, for a public repository", async () => {
    const seen: GitCommand[] = [];
    await resetWorktree(
      { ...REQUEST, token: undefined },
      { exists: async () => true, exec: gitDouble({}, seen), log: silentLog },
    );
    expect(commandFor(seen, "fetch")?.env["GIT_CONFIG_COUNT"]).toBeUndefined();
  });

  it("fails the run when the fetch fails, and resets nothing on a guess", async () => {
    const seen: GitCommand[] = [];
    const failing = resetWorktree(REQUEST, {
      exists: async () => true,
      exec: gitDouble(
        { fetch: { exitCode: 128, output: "fatal: could not read Username for 'https://github.com'" } },
        seen,
      ),
      log: silentLog,
    });
    await expect(failing).rejects.toBeInstanceOf(WorktreeResetError);
    await expect(failing).rejects.toThrow(/worktree reset failed with exit code 128/);
    await expect(failing).rejects.toThrow(/could not read Username/);
    expect(steps(seen)).toEqual(["fetch"]);
  });

  it("keeps the token out of a failed fetch", async () => {
    let caught: unknown;
    try {
      await resetWorktree(REQUEST, {
        exists: async () => true,
        exec: gitDouble({
          fetch: { exitCode: 128, output: `remote: Invalid username or password ${TOKEN}` },
        }),
        log: silentLog,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorktreeResetError);
    expect((caught as Error).message).toContain("exit code 128");
    expect((caught as Error).message).not.toContain(TOKEN);
  });

  it("fails the run when the reset itself fails, and does not clean afterwards", async () => {
    const seen: GitCommand[] = [];
    const failing = resetWorktree(REQUEST, {
      exists: async () => true,
      exec: gitDouble({ reset: { exitCode: 128, output: "fatal: ambiguous argument" } }, seen),
      log: silentLog,
    });
    await expect(failing).rejects.toThrow(/worktree reset failed with exit code 128/);
    expect(steps(seen)).not.toContain("clean");
  });

  it("fails the run when the clean fails, because leftovers would be committed", async () => {
    const failing = resetWorktree(REQUEST, {
      exists: async () => true,
      exec: gitDouble({ clean: { exitCode: 1, output: "warning: failed to remove build/" } }),
      log: silentLog,
    });
    await expect(failing).rejects.toThrow(/failed to remove build/);
  });

  it("fails without touching the worktree when there is no ref to reset to", async () => {
    const seen: GitCommand[] = [];
    const failing = resetWorktree(REQUEST, {
      exists: async () => true,
      exec: gitDouble(
        { "origin-branch": NO_ORIGIN_BRANCH, "default-branch": { exitCode: 1, output: "" } },
        seen,
      ),
      log: silentLog,
    });
    await expect(failing).rejects.toBeInstanceOf(WorktreeResetError);
    await expect(failing).rejects.toThrow(/git remote set-head origin --auto/);
    expect(steps(seen)).toEqual(["fetch", "origin-branch", "default-branch"]);
  });

  it("says which worktree it reset and why, at info level", async () => {
    const lines: LogLine[] = [];
    await resetWorktree(REQUEST, {
      exists: async () => true,
      exec: gitDouble({ "origin-branch": NO_ORIGIN_BRANCH }),
      log: recordingLog(lines),
    });
    const info = lines.find((line) => line.level === "info");
    expect(info?.meta["path"]).toBe(WORKTREE);
    expect(info?.meta["branch"]).toBe("asel/plan-2");
    expect(String(info?.meta["reason"])).toContain("not on origin yet");
  });
});

describe("failure text", () => {
  it("names the command, the exit code and the tail of the output", () => {
    const text = formatWorktreeFailure(
      worktreeFetchCommand(WORKTREE, REQUEST),
      { exitCode: 128, output: `fatal: authentication failed ${TOKEN}` },
      TOKEN,
    );
    expect(text).toContain("worktree reset failed with exit code 128");
    expect(text).toContain(`git -C ${WORKTREE} fetch --prune origin`);
    expect(text).toContain("fatal: authentication failed ***");
    expect(text).not.toContain(TOKEN);
  });
});
