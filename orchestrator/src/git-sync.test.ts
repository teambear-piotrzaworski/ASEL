import { describe, expect, it } from "vitest";
import {
  GITHUB_HTTPS_ORIGIN,
  GitSyncError,
  ORIGIN,
  cloneCommand,
  cloneUrlFor,
  currentBranchCommand,
  defaultBranchCommand,
  fastForwardCommand,
  fetchCommand,
  formatFastForwardFailure,
  formatOriginMismatch,
  formatSyncFailure,
  gitCredentialEnv,
  originUrlCommand,
  parseCurrentBranch,
  parseDefaultBranch,
  parseOriginUrl,
  parseRemoteBranches,
  parseWorktreeState,
  planEmptyRepoBootstrap,
  planFastForward,
  planRepoSync,
  redactToken,
  redactUrlCredentials,
  sameRemoteUrl,
  syncRepo,
  worktreeStatusCommand,
  type CloneHeadState,
  type GitCommand,
  type GitExec,
  type RepoInspection,
  type RepoSyncRequest,
} from "./git-sync.js";
import type { Logger } from "./logger.js";
import type { CommandOutput } from "./runner/checks.js";

const TOKEN = "ghp_secret_token_value";

const REQUEST: RepoSyncRequest = {
  owner: "acme",
  repoName: "example",
  repoPath: "/repos/acme__example",
  token: TOKEN,
};

const EXPECTED_URL = `${GITHUB_HTTPS_ORIGIN}/acme/example.git`;

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
}

/** Logger double: keeps every line so a test can assert what was reported. */
function recordingLog(lines: LogLine[]): Logger {
  const log: Logger = {
    debug: (message) => void lines.push({ level: "debug", message }),
    info: (message) => void lines.push({ level: "info", message }),
    warn: (message) => void lines.push({ level: "warn", message }),
    error: (message) => void lines.push({ level: "error", message }),
    child: () => log,
  };
  return log;
}

function inspection(overrides: Partial<RepoInspection> = {}): RepoInspection {
  return { exists: true, isGitRepo: true, isEmpty: false, ...overrides };
}

/** The git invocations syncRepo can make, named so a test can script them. */
type GitStep =
  | "clone"
  | "fetch"
  | "origin-url"
  | "head-probe"
  | "remote-branches"
  | "commit"
  | "push"
  | "set-head"
  | "default-branch"
  | "current-branch"
  | "status"
  | "merge";

function stepOf(command: GitCommand): GitStep {
  const args = command.args;
  if (args[0] === "clone") {
    return "clone";
  }
  // Everything else runs inside the clone: git -C <path> <verb> ...
  const verb = args[2];
  if (verb === "fetch") return "fetch";
  if (verb === "remote") return args[3] === "set-head" ? "set-head" : "origin-url";
  if (verb === "rev-parse") return "head-probe";
  if (verb === "for-each-ref") return "remote-branches";
  // The bootstrap commit leads with its -c identity flags, not with the verb.
  if (verb === "-c") return "commit";
  if (verb === "push") return "push";
  if (verb === "status") return "status";
  if (verb === "merge") return "merge";
  if (verb === "symbolic-ref") {
    return args[args.length - 1] === "HEAD" ? "current-branch" : "default-branch";
  }
  throw new Error(`test double got an unexpected command: ${command.display}`);
}

/** A healthy clone: right origin, on the default branch, clean, behind origin. */
const HEALTHY: Record<GitStep, CommandOutput> = {
  clone: { exitCode: 0, output: "" },
  fetch: { exitCode: 0, output: "" },
  "origin-url": { exitCode: 0, output: `${EXPECTED_URL}\n` },
  "head-probe": { exitCode: 0, output: "1111111111111111111111111111111111111111\n" },
  "remote-branches": { exitCode: 0, output: "origin/main\n" },
  commit: { exitCode: 0, output: "" },
  push: { exitCode: 0, output: "" },
  "set-head": { exitCode: 0, output: "origin/HEAD set to main\n" },
  "default-branch": { exitCode: 0, output: "origin/main\n" },
  "current-branch": { exitCode: 0, output: "main\n" },
  status: { exitCode: 0, output: "" },
  merge: { exitCode: 0, output: "Updating 1111111..2222222\nFast-forward\n" },
};

/** Exec double: records what it was asked to run, answers per step. */
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

describe("clone url", () => {
  it("builds a clean https url with no credentials in it", () => {
    const url = cloneUrlFor("acme", "example");
    expect(url).toBe(`${GITHUB_HTTPS_ORIGIN}/acme/example.git`);
    expect(url).not.toContain("@");
  });
});

describe("credentials", () => {
  it("carries the token as a scoped basic auth header in the environment", () => {
    const env = gitCredentialEnv(TOKEN);
    expect(env["GIT_CONFIG_COUNT"]).toBe("1");
    expect(env["GIT_CONFIG_KEY_0"]).toBe(`http.${GITHUB_HTTPS_ORIGIN}/.extraheader`);

    const value = env["GIT_CONFIG_VALUE_0"] ?? "";
    const encoded = value.replace("AUTHORIZATION: basic ", "");
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(`x-access-token:${TOKEN}`);
  });

  it("never puts the raw token into the environment value", () => {
    expect(JSON.stringify(gitCredentialEnv(TOKEN))).not.toContain(TOKEN);
  });

  it("switches terminal prompts off with and without a token", () => {
    expect(gitCredentialEnv(TOKEN)["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(gitCredentialEnv(undefined)["GIT_TERMINAL_PROMPT"]).toBe("0");
  });

  it("configures nothing when there is no token", () => {
    for (const empty of [undefined, "", "   "]) {
      const env = gitCredentialEnv(empty);
      expect(env["GIT_CONFIG_COUNT"]).toBeUndefined();
      expect(env["GIT_CONFIG_KEY_0"]).toBeUndefined();
    }
  });
});

describe("commands", () => {
  it("clones into the path the run will be given", () => {
    const command = cloneCommand(REQUEST);
    expect(command.args).toEqual([
      "clone",
      `${GITHUB_HTTPS_ORIGIN}/acme/example.git`,
      "/repos/acme__example",
    ]);
  });

  it("fetches with prune inside the existing clone", () => {
    const command = fetchCommand(REQUEST);
    expect(command.args).toEqual([
      "-C",
      "/repos/acme__example",
      "fetch",
      "--prune",
      "origin",
    ]);
  });

  it("reads the remote url of the clone, not of the registry", () => {
    expect(originUrlCommand(REQUEST).args).toEqual([
      "-C",
      "/repos/acme__example",
      "remote",
      "get-url",
      "origin",
    ]);
  });

  it("takes the default branch from the clone's origin/HEAD", () => {
    expect(defaultBranchCommand(REQUEST).args).toEqual([
      "-C",
      "/repos/acme__example",
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
  });

  it("reads the checked out branch quietly, so a detached HEAD is not noise", () => {
    expect(currentBranchCommand(REQUEST).args).toEqual([
      "-C",
      "/repos/acme__example",
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
  });

  it("ignores untracked files when asking whether the clone is dirty", () => {
    // Sandcastle keeps .sandcastle/ inside the clone; without this flag every
    // clone would look dirty from the first run on and never fast-forward.
    expect(worktreeStatusCommand(REQUEST).args).toEqual([
      "-C",
      "/repos/acme__example",
      "status",
      "--porcelain",
      "--untracked-files=no",
    ]);
  });

  it("advances the default branch with a merge that can only fast-forward", () => {
    expect(fastForwardCommand(REQUEST, "develop").args).toEqual([
      "-C",
      "/repos/acme__example",
      "merge",
      "--ff-only",
      "origin/develop",
    ]);
  });

  it("keeps the token out of argv and out of the loggable form", () => {
    const commands = [
      cloneCommand(REQUEST),
      fetchCommand(REQUEST),
      originUrlCommand(REQUEST),
      defaultBranchCommand(REQUEST),
      currentBranchCommand(REQUEST),
      worktreeStatusCommand(REQUEST),
      fastForwardCommand(REQUEST, "main"),
    ];
    for (const command of commands) {
      expect(command.args.join(" ")).not.toContain(TOKEN);
      expect(command.display).not.toContain(TOKEN);
      expect(command.display.startsWith("git ")).toBe(true);
    }
  });

  it("hands the credential only to the commands that talk to github", () => {
    for (const command of [cloneCommand(REQUEST), fetchCommand(REQUEST)]) {
      expect(command.env["GIT_CONFIG_COUNT"]).toBe("1");
    }
    const local = [
      originUrlCommand(REQUEST),
      defaultBranchCommand(REQUEST),
      currentBranchCommand(REQUEST),
      worktreeStatusCommand(REQUEST),
      fastForwardCommand(REQUEST, "main"),
    ];
    for (const command of local) {
      expect(command.env["GIT_CONFIG_COUNT"]).toBeUndefined();
      expect(command.env["GIT_TERMINAL_PROMPT"]).toBe("0");
    }
  });
});

describe("sync plan", () => {
  it("clones when nothing is there", () => {
    expect(planRepoSync(inspection({ exists: false, isGitRepo: false, isEmpty: true })))
      .toMatchObject({ action: "clone" });
  });

  it("clones into an existing empty directory", () => {
    expect(planRepoSync(inspection({ isGitRepo: false, isEmpty: true }))).toMatchObject({
      action: "clone",
    });
  });

  it("fetches when the clone is already there", () => {
    expect(planRepoSync(inspection())).toMatchObject({ action: "fetch" });
  });

  it("refuses a directory that holds files and is not a clone", () => {
    const plan = planRepoSync(inspection({ isGitRepo: false, isEmpty: false }));
    expect(plan.action).toBe("fail");
    expect(plan.reason).toContain("not a git clone");
  });
});

describe("reading the clone", () => {
  it("takes the branch name out of origin/HEAD", () => {
    expect(parseDefaultBranch({ exitCode: 0, output: "origin/main\n" })).toBe("main");
    expect(parseDefaultBranch({ exitCode: 0, output: "origin/release/2.x\n" })).toBe("release/2.x");
  });

  it("has no answer when origin/HEAD is missing or unexpected", () => {
    expect(parseDefaultBranch({ exitCode: 1, output: "" })).toBeUndefined();
    expect(parseDefaultBranch({ exitCode: 0, output: "" })).toBeUndefined();
    expect(parseDefaultBranch({ exitCode: 0, output: "refs/heads/main\n" })).toBeUndefined();
    expect(parseDefaultBranch({ exitCode: 0, output: "origin/\n" })).toBeUndefined();
  });

  it("reads the checked out branch and reports a detached HEAD as none", () => {
    expect(parseCurrentBranch({ exitCode: 0, output: "main\n" })).toBe("main");
    expect(parseCurrentBranch({ exitCode: 1, output: "" })).toBeUndefined();
  });

  it("calls the working tree clean, dirty or unreadable", () => {
    expect(parseWorktreeState({ exitCode: 0, output: "" })).toBe("clean");
    expect(parseWorktreeState({ exitCode: 0, output: "\n \n" })).toBe("clean");
    expect(parseWorktreeState({ exitCode: 0, output: " M src/index.ts\n" })).toBe("dirty");
    expect(parseWorktreeState({ exitCode: 128, output: "not a git repository" })).toBe("unknown");
  });

  it("reads the origin url and gives nothing when git printed nothing", () => {
    expect(parseOriginUrl({ exitCode: 0, output: `${EXPECTED_URL}\n` })).toBe(EXPECTED_URL);
    expect(parseOriginUrl({ exitCode: 0, output: "" })).toBeUndefined();
    expect(parseOriginUrl({ exitCode: 2, output: "error: No such remote" })).toBeUndefined();
  });
});

describe("fast forward plan", () => {
  function state(overrides: Partial<CloneHeadState> = {}): CloneHeadState {
    return { defaultBranch: "main", currentBranch: "main", worktree: "clean", ...overrides };
  }

  it("advances the default branch of a clean clone sitting on it", () => {
    expect(planFastForward(state())).toEqual({ action: "fast-forward", branch: "main" });
  });

  it("uses whatever the clone calls its default branch, never a hardcoded main", () => {
    const plan = planFastForward(state({ defaultBranch: "trunk", currentBranch: "trunk" }));
    expect(plan).toEqual({ action: "fast-forward", branch: "trunk" });
  });

  it("leaves a clone that is on another branch alone", () => {
    const plan = planFastForward(state({ currentBranch: "asel/plan-42" }));
    expect(plan.action).toBe("skip");
    expect(plan).toMatchObject({ level: "info" });
    expect(plan.action === "skip" && plan.reason).toContain("asel/plan-42");
  });

  it("warns instead of guessing when HEAD is detached", () => {
    const plan = planFastForward(state({ currentBranch: undefined }));
    expect(plan).toMatchObject({ action: "skip", level: "warn" });
    expect(plan.action === "skip" && plan.reason).toContain("detached");
  });

  it("warns and keeps its hands off a dirty clone", () => {
    const plan = planFastForward(state({ worktree: "dirty" }));
    expect(plan).toMatchObject({ action: "skip", level: "warn" });
    expect(plan.action === "skip" && plan.reason).toContain("uncommitted");
  });

  it("warns when it cannot tell whether the clone is dirty", () => {
    const plan = planFastForward(state({ worktree: "unknown" }));
    expect(plan).toMatchObject({ action: "skip", level: "warn" });
  });

  it("warns, with a repair hint, when the clone has no origin/HEAD", () => {
    const plan = planFastForward(state({ defaultBranch: undefined }));
    expect(plan).toMatchObject({ action: "skip", level: "warn" });
    expect(plan.action === "skip" && plan.reason).toContain("git remote set-head origin --auto");
  });
});

describe("remote url comparison", () => {
  it("ignores the differences github itself ignores", () => {
    expect(sameRemoteUrl(EXPECTED_URL, EXPECTED_URL)).toBe(true);
    expect(sameRemoteUrl("https://github.com/acme/example", EXPECTED_URL)).toBe(true);
    expect(sameRemoteUrl("https://github.com/acme/example/", EXPECTED_URL)).toBe(true);
    expect(sameRemoteUrl("https://github.com/ACME/EXAMPLE.git", EXPECTED_URL)).toBe(true);
    expect(sameRemoteUrl(`  ${EXPECTED_URL}  `, EXPECTED_URL)).toBe(true);
  });

  it("treats a different repository, host or transport as different", () => {
    expect(sameRemoteUrl("https://github.com/acme/other.git", EXPECTED_URL)).toBe(false);
    expect(sameRemoteUrl("https://github.com/Someone/example.git", EXPECTED_URL)).toBe(false);
    expect(sameRemoteUrl("https://gitlab.com/acme/example.git", EXPECTED_URL)).toBe(false);
    expect(sameRemoteUrl("git@github.com:acme/example.git", EXPECTED_URL)).toBe(false);
    expect(sameRemoteUrl("https://x:y@github.com/acme/example.git", EXPECTED_URL)).toBe(false);
  });
});

describe("redaction", () => {
  it("removes every occurrence of the token", () => {
    expect(redactToken(`fatal: ${TOKEN} rejected (${TOKEN})`, TOKEN)).toBe(
      "fatal: *** rejected (***)",
    );
  });

  it("leaves the text alone when there is no token", () => {
    expect(redactToken("fatal: repository not found", undefined)).toBe(
      "fatal: repository not found",
    );
  });

  it("keeps the token out of the failure text", () => {
    const text = formatSyncFailure(
      cloneCommand(REQUEST),
      { exitCode: 128, output: `remote: bad credentials ${TOKEN}` },
      TOKEN,
    );
    expect(text).toContain("exit code 128");
    expect(text).toContain("remote: bad credentials ***");
    expect(text).not.toContain(TOKEN);
  });

  it("blanks out a credential embedded in a url, whichever one it is", () => {
    expect(redactUrlCredentials("https://x-access-token:ghp_other@github.com/o/r.git")).toBe(
      "https://***@github.com/o/r.git",
    );
    expect(redactUrlCredentials(EXPECTED_URL)).toBe(EXPECTED_URL);
    // An scp style remote has no userinfo to cut, and must survive intact.
    expect(redactUrlCredentials("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
  });
});

describe("failure texts", () => {
  it("names both ways a fast forward can be refused, and repairs nothing", () => {
    const command = fastForwardCommand(REQUEST, "main");
    const text = formatFastForwardFailure(
      "main",
      command,
      { exitCode: 128, output: "fatal: Not possible to fast-forward, aborting." },
      TOKEN,
    );
    expect(text).toContain("cannot fast-forward 'main'");
    expect(text).toContain("commits origin does not");
    expect(text).toContain("renamed");
    expect(text).toContain("Nothing was changed or deleted automatically");
    expect(text).toContain("Not possible to fast-forward");
  });

  it("prints both urls of a mismatch and says what a human should do", () => {
    const text = formatOriginMismatch(REQUEST, "https://github.com/Someone/other.git", EXPECTED_URL);
    expect(text).toContain("https://github.com/Someone/other.git");
    expect(text).toContain(EXPECTED_URL);
    expect(text).toContain("Nothing was deleted");
    expect(text).toContain(REQUEST.repoPath);
  });
});

describe("syncRepo", () => {
  it("clones a project that has no working copy yet", async () => {
    const seen: GitCommand[] = [];
    const action = await syncRepo(REQUEST, {
      inspect: async () => inspection({ exists: false, isGitRepo: false, isEmpty: true }),
      exec: gitDouble({}, seen),
      log: silentLog,
    });
    expect(action).toBe("clone");
    // A fresh clone is already on origin's tip: no url check, no fast forward.
    // What it still gets is the check that HEAD points at a commit.
    expect(steps(seen)).toEqual(["clone", "head-probe", "remote-branches"]);
  });

  it("fetches an existing clone, so a continued plan branch is current", async () => {
    const seen: GitCommand[] = [];
    const action = await syncRepo(REQUEST, {
      inspect: async () => inspection(),
      exec: gitDouble({}, seen),
      log: silentLog,
    });
    expect(action).toBe("fetch");
    expect(steps(seen)).toEqual([
      "origin-url",
      "fetch",
      "head-probe",
      "remote-branches",
      "default-branch",
      "current-branch",
      "status",
      "merge",
    ]);
  });

  it("hands the credential to the command that talks to github", async () => {
    const seen: GitCommand[] = [];
    await syncRepo(REQUEST, {
      inspect: async () => inspection(),
      exec: gitDouble({}, seen),
      log: silentLog,
    });
    expect(commandFor(seen, "fetch")?.env["GIT_CONFIG_COUNT"]).toBe("1");
  });

  it("fails the run when git exits non zero, without leaking the token", async () => {
    let caught: unknown;
    try {
      await syncRepo(REQUEST, {
        inspect: async () => inspection(),
        exec: gitDouble({
          fetch: { exitCode: 128, output: `remote: Invalid username or password ${TOKEN}` },
        }),
        log: silentLog,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitSyncError);
    expect((caught as Error).message).toContain("exit code 128");
    expect((caught as Error).message).not.toContain(TOKEN);
  });

  it("refuses to touch a directory that is not a clone, and runs nothing", async () => {
    const seen: GitCommand[] = [];
    const failing = syncRepo(REQUEST, {
      inspect: async () => inspection({ isGitRepo: false, isEmpty: false }),
      exec: gitDouble({}, seen),
      log: silentLog,
    });
    await expect(failing).rejects.toThrow(/not a git clone/);
    expect(seen).toHaveLength(0);
  });

  it("works without a token, for a public repository", async () => {
    const seen: GitCommand[] = [];
    await syncRepo(
      { ...REQUEST, token: undefined },
      {
        inspect: async () => inspection({ exists: false, isGitRepo: false, isEmpty: true }),
        exec: gitDouble({}, seen),
        log: silentLog,
      },
    );
    expect(seen[0]?.env["GIT_CONFIG_COUNT"]).toBeUndefined();
  });
});

describe("syncRepo: fast forward of the default branch", () => {
  it("advances the branch a new plan would be forked from", async () => {
    const seen: GitCommand[] = [];
    const lines: LogLine[] = [];
    await syncRepo(REQUEST, {
      inspect: async () => inspection(),
      exec: gitDouble({}, seen),
      log: recordingLog(lines),
    });
    expect(commandFor(seen, "merge")?.args).toContain("origin/main");
    expect(lines.some((line) => line.message.includes("level with origin"))).toBe(true);
  });

  it("merges the branch the clone calls default, not one this code picked", async () => {
    const seen: GitCommand[] = [];
    await syncRepo(REQUEST, {
      inspect: async () => inspection(),
      exec: gitDouble(
        {
          "default-branch": { exitCode: 0, output: "origin/develop\n" },
          "current-branch": { exitCode: 0, output: "develop\n" },
        },
        seen,
      ),
      log: silentLog,
    });
    expect(commandFor(seen, "merge")?.args).toContain("origin/develop");
  });

  it("fast forwards only after the fetch, never before it", async () => {
    const seen: GitCommand[] = [];
    await syncRepo(REQUEST, {
      inspect: async () => inspection(),
      exec: gitDouble({}, seen),
      log: silentLog,
    });
    const order = steps(seen);
    expect(order.indexOf("fetch")).toBeLessThan(order.indexOf("merge"));
  });

  it("leaves a clone that sits on another branch alone, and says so", async () => {
    const seen: GitCommand[] = [];
    const lines: LogLine[] = [];
    await syncRepo(REQUEST, {
      inspect: async () => inspection(),
      exec: gitDouble({ "current-branch": { exitCode: 0, output: "asel/plan-42\n" } }, seen),
      log: recordingLog(lines),
    });
    expect(steps(seen)).not.toContain("merge");
    expect(lines.some((line) => line.message.includes("default branch left alone"))).toBe(true);
  });

  it("warns and merges nothing when the clone has local modifications", async () => {
    const seen: GitCommand[] = [];
    const lines: LogLine[] = [];
    await syncRepo(REQUEST, {
      inspect: async () => inspection(),
      exec: gitDouble({ status: { exitCode: 0, output: " M src/index.ts\n" } }, seen),
      log: recordingLog(lines),
    });
    expect(steps(seen)).not.toContain("merge");
    expect(lines.filter((line) => line.level === "warn")).toHaveLength(1);
  });

  it("warns and merges nothing when the working tree cannot be read", async () => {
    const seen: GitCommand[] = [];
    const lines: LogLine[] = [];
    await syncRepo(REQUEST, {
      inspect: async () => inspection(),
      exec: gitDouble({ status: { exitCode: 128, output: "fatal: bad object HEAD" } }, seen),
      log: recordingLog(lines),
    });
    expect(steps(seen)).not.toContain("merge");
    expect(lines.filter((line) => line.level === "warn")).toHaveLength(1);
  });

  it("warns and merges nothing when the clone has no origin/HEAD", async () => {
    const seen: GitCommand[] = [];
    const lines: LogLine[] = [];
    await syncRepo(REQUEST, {
      inspect: async () => inspection(),
      exec: gitDouble({ "default-branch": { exitCode: 1, output: "" } }, seen),
      log: recordingLog(lines),
    });
    expect(steps(seen)).not.toContain("merge");
    expect(lines.filter((line) => line.level === "warn")).toHaveLength(1);
  });

  it("warns and merges nothing on a detached HEAD", async () => {
    const seen: GitCommand[] = [];
    const lines: LogLine[] = [];
    await syncRepo(REQUEST, {
      inspect: async () => inspection(),
      exec: gitDouble({ "current-branch": { exitCode: 1, output: "" } }, seen),
      log: recordingLog(lines),
    });
    expect(steps(seen)).not.toContain("merge");
    expect(lines.filter((line) => line.level === "warn")).toHaveLength(1);
  });

  it("fails the run, loudly, when the histories have diverged", async () => {
    const failing = syncRepo(REQUEST, {
      inspect: async () => inspection(),
      exec: gitDouble({
        merge: { exitCode: 128, output: "fatal: Not possible to fast-forward, aborting." },
      }),
      log: silentLog,
    });
    await expect(failing).rejects.toBeInstanceOf(GitSyncError);
    await expect(failing).rejects.toThrow(/cannot fast-forward 'main'/);
    await expect(failing).rejects.toThrow(/Nothing was changed or deleted automatically/);
  });

  it("keeps the token out of a fast forward failure", async () => {
    let caught: unknown;
    try {
      await syncRepo(REQUEST, {
        inspect: async () => inspection(),
        exec: gitDouble({ merge: { exitCode: 1, output: `fatal: ${TOKEN}` } }),
        log: silentLog,
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).not.toContain(TOKEN);
  });
});

describe("syncRepo: origin against the registry", () => {
  it("accepts a clone whose origin is the registered repository", async () => {
    const seen: GitCommand[] = [];
    const action = await syncRepo(REQUEST, {
      inspect: async () => inspection(),
      exec: gitDouble({ "origin-url": { exitCode: 0, output: EXPECTED_URL } }, seen),
      log: silentLog,
    });
    expect(action).toBe("fetch");
    expect(steps(seen)).toContain("fetch");
  });

  it("accepts the same repository written without .git", async () => {
    const action = await syncRepo(REQUEST, {
      inspect: async () => inspection(),
      exec: gitDouble({
        "origin-url": { exitCode: 0, output: "https://github.com/ACME/example\n" },
      }),
      log: silentLog,
    });
    expect(action).toBe("fetch");
  });

  it("fails the run when the clone points at another repository, and fetches nothing", async () => {
    const seen: GitCommand[] = [];
    const failing = syncRepo(REQUEST, {
      inspect: async () => inspection(),
      exec: gitDouble(
        { "origin-url": { exitCode: 0, output: "https://github.com/Someone/other.git\n" } },
        seen,
      ),
      log: silentLog,
    });
    await expect(failing).rejects.toBeInstanceOf(GitSyncError);
    await expect(failing).rejects.toThrow(/is not a clone of acme\/example/);
    expect(steps(seen)).toEqual(["origin-url"]);
  });

  it("names both urls and refuses to delete anything by itself", async () => {
    let caught: unknown;
    try {
      await syncRepo(REQUEST, {
        inspect: async () => inspection(),
        exec: gitDouble({
          "origin-url": { exitCode: 0, output: "https://github.com/Someone/other.git\n" },
        }),
        log: silentLog,
      });
    } catch (error) {
      caught = error;
    }
    const message = (caught as Error).message;
    expect(message).toContain("https://github.com/Someone/other.git");
    expect(message).toContain(EXPECTED_URL);
    expect(message).toContain("Nothing was deleted");
  });

  it("redacts the run's token when it shows up in the clone's remote url", async () => {
    let caught: unknown;
    try {
      await syncRepo(REQUEST, {
        inspect: async () => inspection(),
        exec: gitDouble({
          "origin-url": {
            exitCode: 0,
            output: `https://x-access-token:${TOKEN}@github.com/Someone/other.git\n`,
          },
        }),
        log: silentLog,
      });
    } catch (error) {
      caught = error;
    }
    const message = (caught as Error).message;
    expect(message).not.toContain(TOKEN);
    expect(message).toContain("https://***@github.com/Someone/other.git");
  });

  it("redacts a credential that is not the run's token either", async () => {
    let caught: unknown;
    try {
      await syncRepo(REQUEST, {
        inspect: async () => inspection(),
        exec: gitDouble({
          "origin-url": {
            exitCode: 0,
            output: "https://someone:hunter2@github.com/acme/example.git\n",
          },
        }),
        log: silentLog,
      });
    } catch (error) {
      caught = error;
    }
    const message = (caught as Error).message;
    expect(message).not.toContain("hunter2");
    expect(message).toContain("https://***@github.com/acme/example.git");
  });

  it("fails the run when the clone has no origin remote at all", async () => {
    const failing = syncRepo(REQUEST, {
      inspect: async () => inspection(),
      exec: gitDouble({
        "origin-url": { exitCode: 2, output: "error: No such remote 'origin'" },
      }),
      log: silentLog,
    });
    await expect(failing).rejects.toThrow(/exit code 2/);
  });

  it("does not check the origin of a clone it is about to create", async () => {
    const seen: GitCommand[] = [];
    await syncRepo(REQUEST, {
      inspect: async () => inspection({ exists: false, isGitRepo: false, isEmpty: true }),
      exec: gitDouble({}, seen),
      log: silentLog,
    });
    expect(steps(seen)).not.toContain("origin-url");
  });

  it("uses the remote name the rest of the module uses", () => {
    expect(ORIGIN).toBe("origin");
  });
});

describe("empty repository bootstrap", () => {
  const UNBORN: CommandOutput = { exitCode: 1, output: "" };
  const NO_BRANCHES: CommandOutput = { exitCode: 0, output: "" };

  it("leaves a clone whose HEAD resolves alone", () => {
    expect(planEmptyRepoBootstrap(true, [])).toEqual({ action: "none" });
    expect(planEmptyRepoBootstrap(true, ["origin/main"])).toEqual({ action: "none" });
  });

  it("bootstraps only when origin has no branches either", () => {
    expect(planEmptyRepoBootstrap(false, []).action).toBe("bootstrap");
    expect(planEmptyRepoBootstrap(false, ["origin/main"]).action).toBe("fail");
  });

  it("reads branch names out of the listing and failure as no answer", () => {
    expect(parseRemoteBranches({ exitCode: 0, output: "origin/main\norigin/dev\n" })).toEqual([
      "origin/main",
      "origin/dev",
    ]);
    expect(parseRemoteBranches({ exitCode: 128, output: "fatal: broken" })).toEqual([]);
  });

  it("commits, pushes and sets origin/HEAD on a fresh clone of an empty repository", async () => {
    const seen: GitCommand[] = [];
    await syncRepo(REQUEST, {
      inspect: async () => inspection({ exists: false, isGitRepo: false, isEmpty: true }),
      exec: gitDouble({ "head-probe": UNBORN, "remote-branches": NO_BRANCHES }, seen),
      log: silentLog,
    });
    expect(steps(seen)).toEqual([
      "clone",
      "head-probe",
      "remote-branches",
      "commit",
      "push",
      "set-head",
    ]);
  });

  it("bootstraps an existing clone of a still empty repository, and skips the fast forward", async () => {
    const seen: GitCommand[] = [];
    const lines: LogLine[] = [];
    await syncRepo(REQUEST, {
      inspect: async () => inspection(),
      exec: gitDouble({ "head-probe": UNBORN, "remote-branches": NO_BRANCHES }, seen),
      log: recordingLog(lines),
    });
    expect(steps(seen)).toContain("commit");
    expect(steps(seen)).not.toContain("merge");
    expect(lines.some((line) => line.message.includes("root commit"))).toBe(true);
  });

  it("hands the credential to the push and the set-head, not to the commit", async () => {
    const seen: GitCommand[] = [];
    await syncRepo(REQUEST, {
      inspect: async () => inspection({ exists: false, isGitRepo: false, isEmpty: true }),
      exec: gitDouble({ "head-probe": UNBORN, "remote-branches": NO_BRANCHES }, seen),
      log: silentLog,
    });
    expect(commandFor(seen, "push")?.env["GIT_CONFIG_COUNT"]).toBe("1");
    expect(commandFor(seen, "set-head")?.env["GIT_CONFIG_COUNT"]).toBe("1");
    expect(commandFor(seen, "commit")?.env["GIT_CONFIG_COUNT"]).toBeUndefined();
  });

  it("refuses to invent a root commit when origin has branches HEAD lost", async () => {
    const seen: GitCommand[] = [];
    const failing = syncRepo(REQUEST, {
      inspect: async () => inspection(),
      exec: gitDouble({ "head-probe": UNBORN }, seen),
      log: silentLog,
    });
    await expect(failing).rejects.toThrow(/Remove the clone directory/);
    expect(steps(seen)).not.toContain("commit");
  });

  it("fails the run when the bootstrap push is rejected, without leaking the token", async () => {
    let caught: unknown;
    try {
      await syncRepo(REQUEST, {
        inspect: async () => inspection({ exists: false, isGitRepo: false, isEmpty: true }),
        exec: gitDouble({
          "head-probe": UNBORN,
          "remote-branches": NO_BRANCHES,
          push: { exitCode: 128, output: `remote: Permission denied ${TOKEN}` },
        }),
        log: silentLog,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitSyncError);
    expect((caught as Error).message).toContain("exit code 128");
    expect((caught as Error).message).not.toContain(TOKEN);
  });
});
