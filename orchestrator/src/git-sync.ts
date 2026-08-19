/**
 * Repository clones for the runs.
 *
 * Sandcastle is handed a `cwd` and makes a git worktree out of it. Nothing in
 * the orchestrator used to put a repository at that path, so `cwd` pointed at a
 * directory that did not exist. This module is the missing step: before a run
 * starts, the project's clone either gets created or gets its refs refreshed.
 *
 * Two decisions shape it:
 *
 * 1. A PLAIN WORKING CLONE, not a bare mirror. Sandcastle creates worktrees
 *    from this directory and keeps `.sandcastle/` next to it, and a worktree
 *    off a bare repository is a different (and less well trodden) path through
 *    git. The clone is never edited in place - agents only ever see worktrees -
 *    so nothing is gained by making it bare.
 * 2. A FETCH BEFORE EVERY RUN, not only after cloning. One plan is one branch
 *    and that branch is continued by run after run, each of which pushes to
 *    origin at the end. A stale clone would hand the next run an old tip of its
 *    own plan branch, so the refs have to be current before the worktree is
 *    made, not after.
 * 3. A FAST FORWARD OF THE DEFAULT BRANCH AFTER THAT FETCH. `git fetch` only
 *    moves `origin/*`; the local default branch and the clone's HEAD stay where
 *    they were when the directory was created. That matters because Sandcastle
 *    forks a NEW plan branch from the clone's HEAD (see fastForwardDefault()),
 *    so without this step every new plan would start from the code as it looked
 *    the day the clone was made.
 * 4. A CHECK THAT `origin` STILL IS WHAT THE REGISTRY SAYS. The clone path is
 *    derived from the project name, not from the URL, so pointing `repo:` at a
 *    different repository under the same project name would silently reuse the
 *    old clone and run agents against the wrong code.
 *
 * The split is the same as in runner/checks.ts: building a command and deciding
 * what to do with a directory are pure functions, running the command is an
 * injected effect. That way the interesting part - which command, with which
 * credentials, in which situation - is testable without a network or a disk.
 */
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import type { Logger } from "./logger.js";
import { tailLines, type CommandOutput } from "./runner/checks.js";

/** The only forge the project registry can point at today (see parseRepoRef). */
export const GITHUB_HTTPS_ORIGIN = "https://github.com";

/** The one remote a clone in the repos directory ever has. */
export const ORIGIN = "origin";

/** What a run needs to know about the directory it is about to be given. */
export interface RepoInspection {
  readonly exists: boolean;
  /** Holds a `.git` entry, so it is a clone rather than some other directory. */
  readonly isGitRepo: boolean;
  /** Exists but holds nothing - `git clone` is happy to fill it. */
  readonly isEmpty: boolean;
}

/** What to do with the directory, decided from the inspection alone. */
export interface SyncPlan {
  readonly action: "clone" | "fetch" | "fail";
  readonly reason: string;
}

/** Whether the clone's own working tree is in the way of a fast forward. */
export type CloneWorktreeState = "clean" | "dirty" | "unknown";

/** Where the clone stands after a fetch, as far as the fast forward cares. */
export interface CloneHeadState {
  /** Default branch name taken from `origin/HEAD`, undefined when unreadable. */
  readonly defaultBranch: string | undefined;
  /** Branch the clone has checked out; undefined means a detached HEAD. */
  readonly currentBranch: string | undefined;
  readonly worktree: CloneWorktreeState;
}

/** Advance the clone's default branch, or say why that is not being done. */
export type FastForwardPlan =
  | { readonly action: "fast-forward"; readonly branch: string }
  | { readonly action: "skip"; readonly level: "info" | "warn"; readonly reason: string };

/**
 * What to do about a clone whose HEAD does not point at a commit.
 *
 * "none" is the everyday answer: HEAD resolves, nothing to do. The other two
 * exist because of one concrete failure: a repository registered on GitHub
 * before its first commit. `git clone` of such a repository succeeds and leaves
 * an UNBORN branch behind, and the first thing Sandcastle then does is
 * `git worktree add -b <branch> <path> HEAD`, which dies with git's least
 * helpful message ("ambiguous argument 'HEAD'"). A brand new repository is
 * exactly what ASEL is for, so this state is handled rather than reported.
 */
export type BootstrapPlan =
  | { readonly action: "none" }
  | { readonly action: "bootstrap" }
  | { readonly action: "fail"; readonly reason: string };

/** One git invocation: argv, the environment it needs, and a loggable form. */
export interface GitCommand {
  readonly args: readonly string[];
  /**
   * Extra environment for this invocation. Carries the credential, which is
   * why it is kept apart from `args` and out of `display`.
   */
  readonly env: Record<string, string>;
  /** The command as a human should see it in a log. Never holds the token. */
  readonly display: string;
}

/** Everything needed to bring one project's clone up to date. */
export interface RepoSyncRequest {
  readonly owner: string;
  readonly repoName: string;
  /** Absolute path of the clone, the same one handed to Sandcastle as `cwd`. */
  readonly repoPath: string;
  /** GitHub token, or undefined for a public repository. */
  readonly token?: string | undefined;
}

/** The single impure step, injected so everything above stays testable. */
export type GitExec = (command: GitCommand) => Promise<CommandOutput>;

export interface RepoSyncDeps {
  readonly inspect: (path: string) => Promise<RepoInspection>;
  readonly exec: GitExec;
  readonly log: Logger;
}

export class GitSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitSyncError";
  }
}

/** Clean remote URL: no credentials in it, ever. See gitCredentialEnv(). */
export function cloneUrlFor(owner: string, repoName: string): string {
  return `${GITHUB_HTTPS_ORIGIN}/${owner}/${repoName}.git`;
}

/**
 * Credentials for one git process, and one git process only.
 *
 * The token travels in `GIT_CONFIG_*` environment variables rather than in the
 * remote URL, in `git config`, or in a `-c` flag. Three reasons, in order of
 * how much they would hurt:
 *
 * 1. The remote URL of the clone stays clean, so the token is never written
 *    into `<clone>/.git/config`. That file lives in the repos directory, and
 *    Sandcastle bind mounts worktrees of that clone into every agent container
 *    it starts - a token sitting in there would be readable by every agent the
 *    factory ever runs, including on repositories that have nothing to do with
 *    the one the token was meant for.
 * 2. Nothing lands in argv either, which `git -c http.extraheader=...` would
 *    do: a clone of a large repository runs for minutes, and for those minutes
 *    the credential would be visible to anything that can read `ps` on the
 *    host.
 * 3. The setting is scoped to the process we spawn, so there is no state to
 *    clean up and rotating the token needs no repair of existing clones.
 *
 * The header itself is what GitHub documents for tokens over HTTPS: basic auth
 * with the literal user `x-access-token` and the token as the password. It is
 * scoped to the GitHub URL prefix so it cannot be sent anywhere else.
 *
 * `GIT_CONFIG_COUNT` needs git 2.31 or newer (bookworm, the orchestrator image,
 * ships 2.39). `GIT_TERMINAL_PROMPT=0` goes in unconditionally: without it a
 * private repository without a usable token makes git sit and wait for a
 * username that nobody is going to type into a daemon.
 */
export function gitCredentialEnv(token: string | undefined): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  if (token === undefined || token.trim() === "") {
    return env;
  }
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  env["GIT_CONFIG_COUNT"] = "1";
  env["GIT_CONFIG_KEY_0"] = `http.${GITHUB_HTTPS_ORIGIN}/.extraheader`;
  env["GIT_CONFIG_VALUE_0"] = `AUTHORIZATION: basic ${basic}`;
  return env;
}

export function cloneCommand(request: RepoSyncRequest): GitCommand {
  const url = cloneUrlFor(request.owner, request.repoName);
  const args = ["clone", url, request.repoPath];
  return {
    args,
    env: gitCredentialEnv(request.token),
    display: `git ${args.join(" ")}`,
  };
}

/**
 * A git command run inside the clone.
 *
 * `credential` is opt in, and only the two commands that talk to GitHub ask for
 * it. Everything else here reads or moves refs that are already on the disk, so
 * handing those processes the token would widen its blast radius for nothing -
 * the same reasoning as gitCredentialEnv(), one level down.
 */
function gitInClone(
  request: RepoSyncRequest,
  args: readonly string[],
  credential: "with-token" | "local-only" = "local-only",
): GitCommand {
  const full = ["-C", request.repoPath, ...args];
  return {
    args: full,
    env: gitCredentialEnv(credential === "with-token" ? request.token : undefined),
    display: `git ${full.join(" ")}`,
  };
}

/**
 * `--prune` so a branch deleted on origin stops existing here too: the repos
 * directory outlives every run, and remote tracking refs for branches that are
 * gone are the kind of thing that quietly ages a clone into confusion.
 */
export function fetchCommand(request: RepoSyncRequest): GitCommand {
  return gitInClone(request, ["fetch", "--prune", ORIGIN], "with-token");
}

/** Where this clone actually points, to be held against the registry. */
export function originUrlCommand(request: RepoSyncRequest): GitCommand {
  return gitInClone(request, ["remote", "get-url", ORIGIN]);
}

/**
 * The default branch as the clone understands it. `git clone` writes
 * `refs/remotes/origin/HEAD` from what the remote advertises, so the answer
 * comes from the repository rather than from a guess like "main".
 */
export function defaultBranchCommand(request: RepoSyncRequest): GitCommand {
  return gitInClone(request, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${ORIGIN}/HEAD`]);
}

/** The branch the clone has checked out. Fails, quietly, on a detached HEAD. */
export function currentBranchCommand(request: RepoSyncRequest): GitCommand {
  return gitInClone(request, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
}

/** Does HEAD point at a commit? Quiet: an unborn branch is an answer, not noise. */
export function headCommitCommand(request: RepoSyncRequest): GitCommand {
  return gitInClone(request, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
}

/**
 * Every remote tracking branch the clone knows. Empty output is the interesting
 * answer: together with an unborn HEAD it means the repository on GitHub really
 * has no commits at all, as opposed to a clone that merely lost its footing.
 */
export function remoteBranchesCommand(request: RepoSyncRequest): GitCommand {
  return gitInClone(request, [
    "for-each-ref",
    "--format=%(refname:short)",
    `refs/remotes/${ORIGIN}`,
  ]);
}

/**
 * The root commit for an empty repository. `--allow-empty` because there is
 * nothing to commit, and `-c` identity flags because the orchestrator container
 * has no git identity configured and has no business writing one to disk.
 */
export function bootstrapCommitCommand(request: RepoSyncRequest): GitCommand {
  return gitInClone(request, [
    "-c",
    "user.name=ASEL orchestrator",
    "-c",
    "user.email=asel-orchestrator@noreply.local",
    "commit",
    "--allow-empty",
    "-m",
    "chore: bootstrap empty repository so runs can fork branches from HEAD",
  ]);
}

/** Publishes the root commit, so the next clone or fetch finds a real branch. */
export function bootstrapPushCommand(request: RepoSyncRequest): GitCommand {
  return gitInClone(request, ["push", ORIGIN, "HEAD"], "with-token");
}

/**
 * Writes `refs/remotes/origin/HEAD`, which a clone of an empty repository never
 * got. Without it every later run would warn about an unknowable default branch
 * (see planFastForward). Asks the remote, hence the token.
 */
export function setOriginHeadCommand(request: RepoSyncRequest): GitCommand {
  return gitInClone(request, ["remote", "set-head", ORIGIN, "--auto"], "with-token");
}

/**
 * Is anything tracked modified in the clone's own working tree?
 *
 * `--untracked-files=no` is not laziness, it is required: Sandcastle keeps
 * `.sandcastle/` (worktrees, logs, its own env file) INSIDE this directory, and
 * the project's .gitignore has no reason to mention it. A plain
 * `git status --porcelain` would therefore report the clone as dirty from the
 * first run onwards and the fast forward would never happen again. Untracked
 * files also do not stand in the way of a fast forward - and in the one case
 * where they would (a merge that has to write over one), the merge itself
 * fails loudly, which is handled.
 */
export function worktreeStatusCommand(request: RepoSyncRequest): GitCommand {
  return gitInClone(request, ["status", "--porcelain", "--untracked-files=no"]);
}

/**
 * Move the checked out default branch up to origin, or refuse.
 *
 * `merge --ff-only` and not something blunter, on purpose:
 *
 * - `git reset --hard origin/<branch>` would also "work", and would silently
 *   throw away anything the local branch had that origin did not. The clone is
 *   supposed to have nothing of its own, so the interesting case is exactly the
 *   one where that assumption broke, and destroying the evidence is the worst
 *   possible answer to it.
 * - `git fetch origin <branch>:<branch>` cannot update a branch that is checked
 *   out in the main working tree, and the checked out one is the only branch
 *   this step ever touches.
 * - `git pull --ff-only` is this command plus a second network fetch, one line
 *   after the fetch we just did.
 *
 * The refusal is the feature: a fast forward is impossible only when the local
 * branch has diverged, and that is a broken clone rather than a state to work
 * around.
 */
export function fastForwardCommand(request: RepoSyncRequest, branch: string): GitCommand {
  return gitInClone(request, ["merge", "--ff-only", `${ORIGIN}/${branch}`]);
}

/**
 * Clone, fetch, or refuse to touch the directory.
 *
 * The refusal case matters: a path that exists, holds something, and is not a
 * clone is either a mistake in `ASEL_REPOS_DIR` or somebody's data. Cloning
 * over it is not an option and neither is guessing, so the run stops with the
 * path in the message.
 */
export function planRepoSync(inspection: RepoInspection): SyncPlan {
  if (!inspection.exists) {
    return { action: "clone", reason: "no clone yet" };
  }
  if (inspection.isGitRepo) {
    return { action: "fetch", reason: "clone exists, refreshing refs from origin" };
  }
  if (inspection.isEmpty) {
    return { action: "clone", reason: "directory exists but is empty" };
  }
  return {
    action: "fail",
    reason: "directory exists, holds files and is not a git clone",
  };
}

/** First line with something on it, which is where git puts a one line answer. */
function firstLine(result: CommandOutput): string | undefined {
  if (result.exitCode !== 0) {
    return undefined;
  }
  for (const line of result.output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") {
      return trimmed;
    }
  }
  return undefined;
}

/**
 * `origin/main` -> `main`.
 *
 * Anything that does not look like a remote tracking ref of `origin` is treated
 * as no answer at all: a clone whose `origin/HEAD` says something else is one
 * this code does not understand, and guessing a branch name here would move the
 * wrong branch.
 */
export function parseDefaultBranch(result: CommandOutput): string | undefined {
  const line = firstLine(result);
  const prefix = `${ORIGIN}/`;
  if (line === undefined || !line.startsWith(prefix)) {
    return undefined;
  }
  const branch = line.slice(prefix.length);
  return branch === "" ? undefined : branch;
}

/** The checked out branch, or undefined for a detached HEAD. */
export function parseCurrentBranch(result: CommandOutput): string | undefined {
  return firstLine(result);
}

/** Non zero exit means the working tree could not be read, not that it is clean. */
export function parseWorktreeState(result: CommandOutput): CloneWorktreeState {
  if (result.exitCode !== 0) {
    return "unknown";
  }
  return firstLine(result) === undefined ? "clean" : "dirty";
}

/** The configured remote URL, or undefined when git printed nothing usable. */
export function parseOriginUrl(result: CommandOutput): string | undefined {
  return firstLine(result);
}

/**
 * Whether the clone needs a root commit, decided from two local reads.
 *
 * The split matters: an unborn HEAD alone does not mean the repository is
 * empty. When origin HAS branches and HEAD still points at none of them, this
 * clone is in a state the orchestrator never produces (a default branch deleted
 * on GitHub after cloning, or a hand-made mess), and inventing a root commit
 * there would create a second, unrelated history. That case fails with a repair
 * hint instead, in keeping with the rest of this module: repair what is
 * understood, refuse what is not.
 */
export function planEmptyRepoBootstrap(
  headResolves: boolean,
  remoteBranches: readonly string[],
): BootstrapPlan {
  if (headResolves) {
    return { action: "none" };
  }
  if (remoteBranches.length === 0) {
    return { action: "bootstrap" };
  }
  return {
    action: "fail",
    reason:
      `the clone's HEAD points at no commit although ${ORIGIN} has branches ` +
      `(${remoteBranches.join(", ")}). Remove the clone directory so the next ` +
      `run clones it afresh. Nothing was changed or deleted automatically.`,
  };
}

/** Lines of a `for-each-ref` listing, or nothing when git failed. */
export function parseRemoteBranches(result: CommandOutput): readonly string[] {
  if (result.exitCode !== 0) {
    return [];
  }
  return result.output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Whether to advance the default branch, and if not, what to tell the log.
 *
 * Every "skip" here describes a clone that is not in the shape the orchestrator
 * left it in - it clones, fetches and fast forwards, and never checks anything
 * out or edits a file. So none of these are silent: the run continues (the
 * clone is still perfectly usable for continuing an EXISTING plan branch), but
 * the reason goes to the log, at warn level for the states that should not be
 * possible at all.
 *
 * The one thing that is NOT decided here is divergence. Whether a fast forward
 * is possible is git's answer to give, and giving it is the point of running
 * the merge instead of predicting it.
 */
export function planFastForward(state: CloneHeadState): FastForwardPlan {
  if (state.defaultBranch === undefined) {
    return {
      action: "skip",
      level: "warn",
      reason:
        `the clone has no readable ${ORIGIN}/HEAD, so its default branch is unknown ` +
        `(repair with: git remote set-head ${ORIGIN} --auto)`,
    };
  }
  if (state.currentBranch === undefined) {
    return {
      action: "skip",
      level: "warn",
      reason: `the clone has a detached HEAD instead of the default branch '${state.defaultBranch}'`,
    };
  }
  if (state.currentBranch !== state.defaultBranch) {
    return {
      action: "skip",
      level: "info",
      reason:
        `the clone is on '${state.currentBranch}', not on the default branch ` +
        `'${state.defaultBranch}'`,
    };
  }
  if (state.worktree === "dirty") {
    return {
      action: "skip",
      level: "warn",
      reason:
        `the clone has uncommitted changes to tracked files; nothing but the ` +
        `orchestrator is supposed to write here`,
    };
  }
  if (state.worktree === "unknown") {
    return {
      action: "skip",
      level: "warn",
      reason: "the state of the clone's working tree could not be read",
    };
  }
  return { action: "fast-forward", branch: state.defaultBranch };
}

/**
 * Two remote URLs for the same repository?
 *
 * Normalization is deliberately narrow: a trailing slash, a trailing `.git` and
 * letter case are all differences GitHub itself ignores, so treating them as a
 * mismatch would only produce false alarms. Everything else - an ssh remote, a
 * URL with a credential in it, another host - counts as different even when it
 * happens to point at the same repository, because the credential built in
 * gitCredentialEnv() is scoped to `https://github.com/` and would not be used
 * by such a remote anyway.
 */
export function sameRemoteUrl(left: string, right: string): boolean {
  return normalizeRemoteUrl(left) === normalizeRemoteUrl(right);
}

function normalizeRemoteUrl(url: string): string {
  let normalized = url.trim().toLowerCase();
  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized.endsWith(".git")) {
    normalized = normalized.slice(0, -".git".length);
  }
  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Blanks out the userinfo part of a URL before it is printed.
 *
 * redactToken() only knows the token this run was given. A clone somebody made
 * by hand can carry a completely different credential in its remote URL, and
 * the mismatch message exists precisely to print that URL.
 */
export function redactUrlCredentials(url: string): string {
  return url.replace(/\/\/[^/@\s]*@/g, "//***@");
}

/**
 * Removes the token from text on its way to a log or an issue comment. Git is
 * not supposed to echo the header back, but "not supposed to" is not a reason
 * to publish whatever it did print.
 */
export function redactToken(text: string, token: string | undefined): string {
  if (token === undefined || token.trim() === "") {
    return text;
  }
  return text.split(token).join("***");
}

/** Failure text for a git command, in the shape the run comment expects. */
export function formatSyncFailure(
  command: GitCommand,
  result: CommandOutput,
  token: string | undefined,
): string {
  return [
    `repository sync failed with exit code ${result.exitCode}: ${command.display}`,
    "",
    "last lines of output:",
    redactToken(tailLines(result.output), token),
  ].join("\n");
}

/**
 * Failure text for a refused fast forward.
 *
 * Two ways to get here and the message names both, because the fix differs:
 * either the local default branch carries commits origin does not have (a clone
 * somebody committed into), or `origin/HEAD` points at a branch that no longer
 * exists on the remote (a default branch renamed on GitHub). Nothing is
 * repaired automatically - a clone in this state is holding work that only its
 * owner can judge.
 */
export function formatFastForwardFailure(
  branch: string,
  command: GitCommand,
  result: CommandOutput,
  token: string | undefined,
): string {
  return [
    `cannot fast-forward '${branch}' to ${ORIGIN}/${branch} in the clone: either the ` +
      `local branch has commits ${ORIGIN} does not, or ${ORIGIN}/${branch} is gone ` +
      `(default branch renamed?).`,
    `Until this is fixed, every new plan branch would fork from stale code. Inspect ` +
      `the clone and either remove it so the next run clones again, or run ` +
      `git remote set-head ${ORIGIN} --auto in it if the default branch was renamed. ` +
      `Nothing was changed or deleted automatically.`,
    "",
    formatSyncFailure(command, result, token),
  ].join("\n");
}

/** Failure text for a clone that points somewhere else than the registry says. */
export function formatOriginMismatch(
  request: RepoSyncRequest,
  actual: string | undefined,
  expected: string,
): string {
  const shown =
    actual === undefined
      ? "(git printed no url)"
      : redactToken(redactUrlCredentials(actual), request.token);
  return [
    `the clone at ${request.repoPath} is not a clone of ${request.owner}/${request.repoName}:`,
    `  ${ORIGIN} points at: ${shown}`,
    `  registry expects:  ${expected}`,
    `Nothing was deleted. Either remove that directory so the next run clones the ` +
      `right repository, or correct the repo entry for this project in the registry.`,
  ].join("\n");
}

/**
 * Brings one clone up to date and says what it did.
 *
 * Throws GitSyncError on anything that leaves the clone unusable, because the
 * caller turns that into a failed run: a run started on a missing or stale
 * clone would either crash inside Sandcastle or, worse, quietly work on an old
 * tip of its own plan branch.
 *
 * The return value stays the coarse "what happened to the directory" it always
 * was. What the fast forward did is a property of the clone, not of the run,
 * and it is already in the log; widening this contract would only push the
 * decision of what to do about it onto a caller that has nothing to do with it.
 */
export async function syncRepo(
  request: RepoSyncRequest,
  deps: RepoSyncDeps,
): Promise<"clone" | "fetch"> {
  const inspection = await deps.inspect(request.repoPath);
  const plan = planRepoSync(inspection);
  if (plan.action === "fail") {
    throw new GitSyncError(
      `cannot use ${request.repoPath} as the clone of ${request.owner}/${request.repoName}: ` +
        `${plan.reason}. Point ASEL_REPOS_DIR somewhere else or clear that path.`,
    );
  }

  // Before the fetch, not after: fetching into a clone of the wrong repository
  // downloads objects nobody asked for and confuses the log about which
  // repository the run is on.
  if (plan.action === "fetch") {
    await assertRegisteredOrigin(request, deps);
  }

  const command = plan.action === "clone" ? cloneCommand(request) : fetchCommand(request);
  deps.log.info(`repository ${plan.action}`, {
    repo: `${request.owner}/${request.repoName}`,
    path: request.repoPath,
    reason: plan.reason,
    command: command.display,
  });

  const result = await deps.exec(command);
  if (result.exitCode !== 0) {
    throw new GitSyncError(formatSyncFailure(command, result, request.token));
  }

  // Both paths can surface a repository with no commits yet: a fresh clone of
  // an empty repository, or an old clone of one that is still empty. Sandcastle
  // forks every plan branch from HEAD, so a HEAD that resolves is part of what
  // "synced" means here.
  const head = await ensureHeadHasCommit(request, deps);

  // A fresh clone already has its default branch on origin's tip and cannot be
  // dirty, and a just-bootstrapped clone is a commit AHEAD of what it pushed,
  // so the fast forward only concerns an existing clone that was left alone.
  if (plan.action === "fetch" && head === "existing") {
    await fastForwardDefault(request, deps);
  }
  return plan.action;
}

/**
 * Makes sure HEAD points at a commit, creating and publishing a root commit
 * when the repository is genuinely empty. See planEmptyRepoBootstrap for when
 * that is refused instead.
 *
 * The push is not optional: a root commit that only exists locally would make
 * GitHub adopt whatever branch an agent pushes first as the repository's
 * default, and the next clone from another machine would start unborn again.
 */
async function ensureHeadHasCommit(
  request: RepoSyncRequest,
  deps: RepoSyncDeps,
): Promise<"existing" | "bootstrapped"> {
  const headResolves = (await deps.exec(headCommitCommand(request))).exitCode === 0;
  const branches = parseRemoteBranches(await deps.exec(remoteBranchesCommand(request)));
  const plan = planEmptyRepoBootstrap(headResolves, branches);
  if (plan.action === "none") {
    return "existing";
  }
  if (plan.action === "fail") {
    throw new GitSyncError(plan.reason);
  }

  deps.log.info("repository is empty, creating and pushing a root commit", {
    repo: `${request.owner}/${request.repoName}`,
    path: request.repoPath,
  });
  for (const command of [
    bootstrapCommitCommand(request),
    bootstrapPushCommand(request),
    setOriginHeadCommand(request),
  ]) {
    const result = await deps.exec(command);
    if (result.exitCode !== 0) {
      throw new GitSyncError(formatSyncFailure(command, result, request.token));
    }
  }
  return "bootstrapped";
}

/**
 * Refuses to work in a clone that points at a different repository.
 *
 * The clone path comes from the project NAME (`projects/<name>.yml` ->
 * `repoPathFor`), so editing `repo:` in place leaves the old clone sitting at
 * the path the new configuration resolves to. Everything after that looks
 * healthy: the fetch succeeds, the worktree is created, the agent works - on
 * the wrong repository. Hence a check, and hence no automatic deletion: a
 * directory full of somebody's commits is not something to remove on a hunch
 * about what they meant to configure.
 */
async function assertRegisteredOrigin(
  request: RepoSyncRequest,
  deps: RepoSyncDeps,
): Promise<void> {
  const command = originUrlCommand(request);
  const result = await deps.exec(command);
  if (result.exitCode !== 0) {
    throw new GitSyncError(formatSyncFailure(command, result, request.token));
  }
  const actual = parseOriginUrl(result);
  const expected = cloneUrlFor(request.owner, request.repoName);
  if (actual !== undefined && sameRemoteUrl(actual, expected)) {
    return;
  }
  throw new GitSyncError(formatOriginMismatch(request, actual, expected));
}

/**
 * Advances the clone's default branch to origin, so a NEW plan branch is forked
 * from current code.
 *
 * Why this is needed at all, from the installed sandcastle 0.12.0 (the package
 * sources, not the README): `worktree add <path> <branch>` is tried first, and
 * when the branch does not exist yet the error is caught and retried as
 * `worktree add -b <branch> <path> <opts?.baseBranch ?? "HEAD">`. The
 * orchestrator's adapter passes no `baseBranch`, so "HEAD" means the clone's
 * HEAD - the default branch as it stood when the directory was created. The
 * published type says as much in words: baseBranch defaults to HEAD and
 * "Callers are responsible for ensuring the ref is current (e.g. `git fetch`)".
 * A fetch alone does not make HEAD current, which is what this fixes.
 *
 * Three reads before the merge, all local and all cheap next to the fetch that
 * just ran. They are gathered first and judged afterwards (planFastForward) so
 * that the decision stays a pure function of the clone's state.
 */
async function fastForwardDefault(request: RepoSyncRequest, deps: RepoSyncDeps): Promise<void> {
  const state: CloneHeadState = {
    defaultBranch: parseDefaultBranch(await deps.exec(defaultBranchCommand(request))),
    currentBranch: parseCurrentBranch(await deps.exec(currentBranchCommand(request))),
    worktree: parseWorktreeState(await deps.exec(worktreeStatusCommand(request))),
  };

  const plan = planFastForward(state);
  if (plan.action === "skip") {
    const fields = { path: request.repoPath, reason: plan.reason };
    const message = "default branch left alone, a new plan branch may fork from stale code";
    if (plan.level === "warn") {
      deps.log.warn(message, fields);
    } else {
      deps.log.info(message, fields);
    }
    return;
  }

  const command = fastForwardCommand(request, plan.branch);
  const result = await deps.exec(command);
  if (result.exitCode !== 0) {
    throw new GitSyncError(
      formatFastForwardFailure(plan.branch, command, result, request.token),
    );
  }
  // Not "fast-forwarded": the same command and the same exit code cover "moved"
  // and "was already there", and telling them apart would cost two more git
  // calls for a line in a log.
  deps.log.info("default branch level with origin", {
    path: request.repoPath,
    branch: plan.branch,
  });
}

/** Reads a directory the way planRepoSync wants to hear about it. */
export async function inspectRepoPath(path: string): Promise<RepoInspection> {
  try {
    const entries = await readdir(path);
    return {
      exists: true,
      isGitRepo: entries.includes(".git"),
      isEmpty: entries.length === 0,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { exists: false, isGitRepo: false, isEmpty: true };
    }
    if (code === "ENOTDIR") {
      // A file sits where the clone should be: exists, not a clone, not empty.
      return { exists: true, isGitRepo: false, isEmpty: false };
    }
    throw error;
  }
}

const execFileAsync = promisify(execFile);

/**
 * The real executor. `execFile` and not a shell: the arguments are built here,
 * a shell would only add a quoting problem nobody needs.
 */
export function createGitExec(): GitExec {
  return async (command) => {
    try {
      const { stdout, stderr } = await execFileAsync("git", [...command.args], {
        env: { ...process.env, ...command.env },
        maxBuffer: 8 * 1024 * 1024,
      });
      return { exitCode: 0, output: joinStreams(stdout, stderr) };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      return {
        // Same convention as runner/checks.ts: 127 means the binary is missing,
        // which is a broken image rather than a broken repository.
        exitCode:
          typeof failure.code === "number" ? failure.code : failure.code === "ENOENT" ? 127 : 1,
        output: joinStreams(failure.stdout ?? "", failure.stderr ?? failure.message),
      };
    }
  };
}

function joinStreams(stdout: string, stderr: string): string {
  return [stdout, stderr].filter((part) => part !== "").join("\n");
}
