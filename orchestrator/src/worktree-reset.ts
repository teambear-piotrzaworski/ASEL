/**
 * The plan branch's worktree, before a run is handed it.
 *
 * git-sync.ts brings the CLONE up to date. This module brings the WORKTREE that
 * Sandcastle keeps for one plan branch up to date, which is a different
 * directory with a different failure mode.
 *
 * Read out of the installed sandcastle 0.12.0 sources (dist/, not the README):
 *
 * 1. The worktree of a NAMED branch lives at
 *    `<clone>/.sandcastle/worktrees/<branch, every "/" turned into "-">` -
 *    `worktreeName = branch.replace(/\//g, "-")` in `create()`, joined under
 *    `.sandcastle/worktrees`. So `asel/plan-2` becomes `asel-plan-2`, which is
 *    what the directory on disk is called.
 * 2. It OUTLIVES a run whenever that run left uncommitted changes behind. Both
 *    exits (`run()` and `sandbox.close()`) ask `hasUncommittedChanges()` and
 *    keep the directory when the answer is yes ("Worktree preserved at ..."). An
 *    interrupted run - a killed container, a restarted orchestrator - is exactly
 *    the case that leaves changes behind.
 * 3. The next run REUSES that directory as-is. `create()` finds the collision
 *    and, when the worktree is dirty, only warns ("worktree has uncommitted
 *    changes") before handing it over untouched. When it is clean it tries
 *    `fastForwardFromOrigin()`, whose `git fetch origin <branch>` runs INSIDE
 *    the worktree with no credential in its environment, so on a private
 *    repository it fails and the log says "Could not fetch from origin (reusing
 *    worktree at ... as-is)".
 *
 * Sandcastle therefore cannot heal that directory, and the orchestrator is the
 * only side that holds a token. Hence this step, immediately before the sandbox
 * is created: fetch, `reset --hard` onto what origin has, `clean -fd`. Both
 * halves matter and both failures really happened. A worktree left on a commit
 * that origin no longer has makes the run's push a non fast forward; leftovers
 * from a dead run get committed by the next agent as if they were its own work.
 *
 * Throwing local state away is safe HERE and nowhere else in the orchestrator
 * (fastForwardCommand() in git-sync.ts deliberately refuses to do it to the
 * clone): a worktree holds nothing but the last run's attempt, and every run
 * ends by pushing its branch, so anything worth keeping is already on origin.
 *
 * Same split as git-sync.ts and runner/checks.ts: building a command and
 * deciding what to reset to are pure functions, running the command is an
 * injected effect.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  ORIGIN,
  gitCredentialEnv,
  parseDefaultBranch,
  redactToken,
  type GitCommand,
  type GitExec,
} from "./git-sync.js";
import type { Logger } from "./logger.js";
import { tailLines, type CommandOutput } from "./runner/checks.js";

/** Everything needed to bring one plan branch's worktree to a clean state. */
export interface WorktreeResetRequest {
  /** Absolute path of the clone, the same one handed to Sandcastle as `cwd`. */
  readonly repoPath: string;
  /** Plan branch, e.g. `asel/plan-2`. */
  readonly branch: string;
  /** GitHub token, or undefined for a public repository. */
  readonly token?: string | undefined;
}

/** What the worktree's refs say, gathered before anything is decided. */
export interface WorktreeRefs {
  /** True when `origin/<branch>` resolves to a commit, so the plan was pushed. */
  readonly originBranchExists: boolean;
  /** Default branch taken from `origin/HEAD`, undefined when unreadable. */
  readonly defaultBranch: string | undefined;
}

/** The ref the worktree is reset to, or why it cannot be picked. */
export type WorktreeResetPlan =
  | {
      readonly action: "reset";
      readonly ref: string;
      /** Which of the two cases this is, for the log line. */
      readonly kind: "plan-branch" | "default-branch";
    }
  | { readonly action: "fail"; readonly reason: string };

export interface WorktreeResetDeps {
  /** Is Sandcastle's worktree directory for this branch there at all? */
  readonly exists: (path: string) => Promise<boolean>;
  readonly exec: GitExec;
  readonly log: Logger;
}

export class WorktreeResetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeResetError";
  }
}

/** `asel/plan-2` -> `asel-plan-2`, the way sandcastle's create() names it. */
export function worktreeNameFor(branch: string): string {
  return branch.replace(/\//g, "-");
}

/** Absolute path of the worktree sandcastle keeps for one branch. */
export function worktreePathFor(repoPath: string, branch: string): string {
  return join(repoPath, ".sandcastle", "worktrees", worktreeNameFor(branch));
}

/** A git command run inside the worktree, with the credential opt in. */
function gitInWorktree(
  worktreePath: string,
  request: WorktreeResetRequest,
  args: readonly string[],
  credential: "with-token" | "local-only" = "local-only",
): GitCommand {
  const full = ["-C", worktreePath, ...args];
  return {
    args: full,
    env: gitCredentialEnv(credential === "with-token" ? request.token : undefined),
    display: `git ${full.join(" ")}`,
  };
}

/**
 * The fetch sandcastle cannot do, run from the worktree with a credential.
 *
 * A linked worktree shares refs and objects with its clone, so `--prune origin`
 * rather than `origin <branch>`: fetching everything is the same work git-sync
 * already does one directory up, and it keeps a branch deleted on origin from
 * lingering here. Fetching the branch by name would also fail on a plan whose
 * branch does not exist on origin yet, which is a normal first run rather than
 * an error, and that failure would be indistinguishable from a bad credential.
 */
export function worktreeFetchCommand(
  worktreePath: string,
  request: WorktreeResetRequest,
): GitCommand {
  return gitInWorktree(worktreePath, request, ["fetch", "--prune", ORIGIN], "with-token");
}

/** Does `origin/<branch>` exist? Quiet: "no" is an answer here, not noise. */
export function originBranchCommand(
  worktreePath: string,
  request: WorktreeResetRequest,
): GitCommand {
  return gitInWorktree(worktreePath, request, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/${ORIGIN}/${request.branch}^{commit}`,
  ]);
}

/**
 * The default branch, read through the worktree. Same ref as
 * defaultBranchCommand() in git-sync.ts reads in the clone - a linked worktree
 * shares its refs - so the two can never disagree about it.
 */
export function worktreeDefaultBranchCommand(
  worktreePath: string,
  request: WorktreeResetRequest,
): GitCommand {
  return gitInWorktree(worktreePath, request, [
    "symbolic-ref",
    "--quiet",
    "--short",
    `refs/remotes/${ORIGIN}/HEAD`,
  ]);
}

/** Moves the worktree, index and files onto `ref`, whatever they held before. */
export function worktreeResetCommand(
  worktreePath: string,
  request: WorktreeResetRequest,
  ref: string,
): GitCommand {
  return gitInWorktree(worktreePath, request, ["reset", "--hard", ref]);
}

/**
 * Removes what the reset cannot: files a dead run created and never staged.
 *
 * `-fd` and not `-fdx` on purpose. Ignored files are the project's own build and
 * dependency directories (`node_modules` and friends), which cost minutes to
 * recreate and are not what a dead run left behind. Untracked but not ignored
 * files are, so those go.
 */
export function worktreeCleanCommand(
  worktreePath: string,
  request: WorktreeResetRequest,
): GitCommand {
  return gitInWorktree(worktreePath, request, ["clean", "-fd"]);
}

/** Did `rev-parse --verify --quiet` find the ref? */
export function parseRefExists(result: CommandOutput): boolean {
  return result.exitCode === 0 && result.output.trim() !== "";
}

/**
 * Which ref the worktree belongs on.
 *
 * `origin/<branch>` whenever the plan branch is on origin: that is what the
 * previous run of this plan pushed and what the next one has to build on.
 *
 * The other case is the FIRST run of a plan, where the branch exists nowhere but
 * here. Sandcastle created it with `worktree add -b <branch> <path> HEAD` (no
 * `baseBranch` is passed by the adapter), i.e. from the clone's HEAD, which
 * git-sync.ts fast forwards onto the default branch before every run. Resetting
 * to `origin/<default>` therefore puts the worktree back exactly where
 * sandcastle would have forked it, and does it from the ref that cannot be
 * stale rather than from a local branch that might be.
 *
 * Without a readable `origin/HEAD` there is no such ref to name, and guessing
 * "main" would silently reset a repository onto the wrong history. That fails,
 * with the same repair hint git-sync.ts gives for the same missing ref.
 */
export function planWorktreeReset(
  worktreePath: string,
  branch: string,
  refs: WorktreeRefs,
): WorktreeResetPlan {
  if (refs.originBranchExists) {
    return { action: "reset", ref: `${ORIGIN}/${branch}`, kind: "plan-branch" };
  }
  if (refs.defaultBranch !== undefined) {
    return { action: "reset", ref: `${ORIGIN}/${refs.defaultBranch}`, kind: "default-branch" };
  }
  return {
    action: "fail",
    reason:
      `the worktree at ${worktreePath} is on plan branch '${branch}', which does not ` +
      `exist on ${ORIGIN} yet, and the clone has no readable ${ORIGIN}/HEAD to reset ` +
      `it to (repair with: git remote set-head ${ORIGIN} --auto). Nothing was changed ` +
      `or deleted automatically.`,
  };
}

/** Failure text for one git command of this step, with the token taken out. */
export function formatWorktreeFailure(
  command: GitCommand,
  result: CommandOutput,
  token: string | undefined,
): string {
  return [
    `worktree reset failed with exit code ${result.exitCode}: ${command.display}`,
    "",
    "last lines of output:",
    redactToken(tailLines(result.output), token),
  ].join("\n");
}

/**
 * Brings the plan branch's worktree to a clean, current state and says what it
 * did.
 *
 * "absent" is the everyday answer for a new plan: the directory is not there,
 * sandcastle is about to create it from a clone git-sync.ts just refreshed, and
 * there is nothing to repair. Anything that goes wrong throws, because the
 * caller turns that into a failed run: continuing would hand the agent a
 * worktree on the wrong commit, which is the failure this whole module exists
 * to prevent.
 */
export async function resetWorktree(
  request: WorktreeResetRequest,
  deps: WorktreeResetDeps,
): Promise<"absent" | "reset"> {
  const worktreePath = worktreePathFor(request.repoPath, request.branch);
  if (!(await deps.exists(worktreePath))) {
    deps.log.debug("no worktree to reset, sandcastle will create one", {
      path: worktreePath,
      branch: request.branch,
    });
    return "absent";
  }

  // The fetch first: both reads below are answered from refs on the disk, and
  // those refs have to be current before either of them is believed.
  await run(worktreeFetchCommand(worktreePath, request), request, deps);

  // Gathered, then judged (planWorktreeReset), so the decision stays a pure
  // function of the worktree's state. Both reads are local and cheap next to
  // the fetch that just ran.
  const refs: WorktreeRefs = {
    originBranchExists: parseRefExists(
      await deps.exec(originBranchCommand(worktreePath, request)),
    ),
    // parseDefaultBranch() from git-sync.ts, not a second copy of it: the ref is
    // the same one, and so is the reason to be narrow about what counts as an
    // answer - a ref this code does not understand must not become a
    // `reset --hard` target.
    defaultBranch: parseDefaultBranch(
      await deps.exec(worktreeDefaultBranchCommand(worktreePath, request)),
    ),
  };

  const plan = planWorktreeReset(worktreePath, request.branch, refs);
  if (plan.action === "fail") {
    throw new WorktreeResetError(plan.reason);
  }

  await run(worktreeResetCommand(worktreePath, request, plan.ref), request, deps);
  await run(worktreeCleanCommand(worktreePath, request), request, deps);

  deps.log.info("plan worktree reset before the sandbox", {
    path: worktreePath,
    branch: request.branch,
    ref: plan.ref,
    // The first run of a plan resets to the default branch instead, which is
    // worth seeing in the log next to the branch it happened for.
    reason:
      plan.kind === "plan-branch"
        ? "continuing the plan branch"
        : `the plan branch is not on ${ORIGIN} yet`,
  });
  return "reset";
}

/** Runs one command of this step, turning a non zero exit into the failure. */
async function run(
  command: GitCommand,
  request: WorktreeResetRequest,
  deps: WorktreeResetDeps,
): Promise<void> {
  const result = await deps.exec(command);
  if (result.exitCode !== 0) {
    throw new WorktreeResetError(formatWorktreeFailure(command, result, request.token));
  }
}

/**
 * Reads whether the worktree directory is there. A path that exists but is not
 * a directory is reported as absent: sandcastle would fail on it with its own
 * message, and this step has nothing to reset either way.
 */
export async function worktreeExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}
