# ASEL - Agentic Software Engineering Lifecycle

A "software factory" layer on top of projects: AI agents do the work in isolated containers, and humans steer the process through issues, labels and comments on GitHub. GitHub is the control plane and the review UI. Adding a project to the factory is one YAML file.

This repo contains slice 1: the skeleton. The orchestrator polls GitHub, drives a state machine over labels, enforces concurrency limits and keeps state in SQLite. Agent runs default to the stubbed DRY_RUN mode; the real Sandcastle integration sits behind the `ASEL_ENABLE_SANDCASTLE` flag.

Landing page: [teambear-piotrzaworski.github.io/asel-landing](https://teambear-piotrzaworski.github.io/asel-landing/). Full specification: [SPEC.md](SPEC.md).

## Layers - what sits where

```
Layer 0: GitHub               issues, labels, comments (humans live here)
Layer 1: ASEL orchestrator    polling, state machine, run queue
Layer 2: Run types            wayfinder / adr / prd / slices / tasks / implement
Layer 3: Sandcastle           harness: container + worktree + branch + commits
```

Sandcastle sits at the very bottom and is the engine room, not a part of the process. It knows nothing about ADRs, PRDs or slices - it runs an agent against the code in a container and brings the commits back. Every layer 2 run goes through the same harness; they differ by prompt and configuration.

The two levels of planning do not clash. Micro-planning happens inside a single Sandcastle run (plan out the change, implement it, consolidate the commits). Macro-planning is the ASEL pipeline (Wayfinder -> ADR -> PRD -> Plan -> tasks) and decides WHAT there is to do in the first place.

Task size rule: **one task = one run**. If a task does not fit into one run, it is too big and starts duplicating Sandcastle's internal planning.

## One plan = one branch

The factory does not use pull requests. Everything that grows out of one epic issue - the ADRs, the PRD, the plan with slices and the implementation of EVERY task from that plan - lands on one branch, `asel/plan-<epic issue number>`. Every run ends with commits and a push of that branch to origin. The human reads the commit history on the branch and decides for themselves when and how to merge it into the default branch. The orchestrator does not open and does not merge PRs, and it does not close issues either - that is the human's decision after the review.

A consequence the project deliberately accepts: **implementation goes sequentially**. Since everything lands on one branch, at any given moment exactly one agent works on one plan. The order follows from the slice number, not from a dependency graph. Parallelism within a plan is deliberately deferred.

Sequentiality concerns the BRANCH, not the working directory: every run goes on its own worktree in a separate container anyway, so agents never share files on disk. Per-plan serialization only makes sure that two runs do not diverge the commit history of a single branch. Runs of different epics and different projects still go in parallel (global limit 2) and that is the only place where competing changes to the same files can appear; the human resolves that at merge time.

Branch naming scheme:

| Run | Branch |
| --- | --- |
| wayfinder, adr, prd, slices, tasks (epic issue) | `asel/plan-<epic number>` |
| task implement with an `ASEL_EPIC` marker | `asel/plan-<epic number from the marker>` |
| task implement WITHOUT the marker (issue created by hand) | `asel/issue-<issue number>` |
| `asel:fast` implement | `asel/issue-<issue number>` |

A task finds its plan through markers in the issue body - the orchestrator has no repository clones and does not read files from them, so the information has to travel in the body. The tasks run writes two lines into every issue:

```
ASEL_EPIC: 42
ASEL_SLICE: 3
```

`ASEL_EPIC` points at the plan branch, `ASEL_SLICE` gives the execution order. The parser looks for the line (not for a position), tolerates markdown decoration, letter case and junk around it, and treats a missing marker as a normal case: a task without `ASEL_EPIC` gets its own per-issue branch and is not serialized with anything. The task also gets an `asel:slice-<number>` label - that is a readable marker for the human; the source of truth for the ordering is the marker in the body.

## Requirements

- Docker Desktop (running, with `/var/run/docker.sock` available)
- Node 22+ and pnpm (only for working on the orchestrator code; the runtime itself goes in a container)
- `GITHUB_TOKEN` - a PAT with access to the repositories covered by the factory (issues, labels, comments, write to the repo, because the agent pushes the branch)
- `CLAUDE_CODE_OAUTH_TOKEN` - from the `claude setup-token` command

## Quickstart

```bash
cp .env.example .env     # and fill in the tokens
./asel.sh doctor         # checks docker, tokens, images, reachability of the registry repos
./asel.sh build          # builds asel-agent-runtime:latest and the orchestrator image
./asel.sh up             # starts the orchestrator in the background
./asel.sh logs           # tail
./asel.sh status         # container state, healthcheck, project registry
./asel.sh down           # stop
```

The `asel_state` volume and the `repos/` directory survive `down`, so run state is not lost.

The `repos/` directory (repository clones and agent worktrees) is an ordinary directory on the host, mounted into the orchestrator container under the same absolute path. Thanks to that, the worktree paths handed to the Docker daemon when agent containers are started also exist on the host - the daemon resolves bind mounts on its own side. The location is changed by `ASEL_REPOS_DIR` in `.env` (then `./asel.sh down && ./asel.sh up`; a restart does not re-wire the mounts).

## Label flow

The label prefix is configurable in `asel.yml` (`asel` by default).

Every planning stage is a SEPARATE run, meaning a separate agent and a separate context window. Three human-in-the-loop gates: `asel:planned` (Wayfinder decisions), `asel:spec-to-approve` (ADR + PRD) and `asel:plan-to-approve` (the plan with slices, switchable off per project).

Naming convention: `to-*` is a trigger for the machine, every other label is a state waiting for a human.

| Label | Who sets it | What the orchestrator does |
| --- | --- | --- |
| `asel:plan` | human | Wayfinder run (map + decision tickets); on success it removes `asel:plan` and adds `asel:planned` |
| `asel:planned` | orchestrator | gate: waits for human decisions, does nothing |
| `asel:rework` | human | repeats the step indicated by the neighboring state label (see below) |
| `asel:approved` | human (gate) | ADR run: `docs/adr/` on the plan branch, then `asel:to-prd`. ADRs are optional: no decision worth recording = zero files and still a success |
| `asel:to-prd` | orchestrator | PRD run: `docs/prd/` on the same branch, then `asel:spec-to-approve` |
| `asel:spec-to-approve` | orchestrator | gate: the human reads the ADRs and the PRD on the plan branch |
| `asel:to-plan` | human (gate) | plan run: `docs/plans/` with slices on the same branch, then `asel:plan-to-approve` or straight away `asel:to-tasks` if the project has the plan gate switched off |
| `asel:plan-to-approve` | orchestrator | gate: the human reads the plan with slices on the plan branch |
| `asel:to-tasks` | human (gate), or the orchestrator when the gate is off | tasks run: one issue per task (`asel:task`), then `asel:specced` |
| `asel:specced` | orchestrator | terminal state of the epic: the tasks exist and live their own lives |
| `asel:task` | tasks run | one task = one implement run, commits on the plan branch; on success it adds `asel:in-review` |
| `asel:fast` | human | skips the whole plan pipeline, straight to implementation on its own branch (small stuff) |
| `asel:in-review` | orchestrator | the commits are waiting for a human review (`asel:rework` alongside = implementation repeat) |
| `asel:failed` | orchestrator | the run blew up, there is a comment in the issue with the cause (and a Woopy push) |
| `asel:blocked` | orchestrator | the run finished cleanly but left a QUESTION: answer with a comment and attach `asel:rework` (Woopy push) |

Outside the state machine: `asel:slice-<number>` sits on the task as a readable marker for the human (prefix from the configuration). The orchestrator does not read it.

### `asel:failed` versus `asel:blocked`

Two different ways of stopping and two different human reactions:

- `asel:failed` - something blew up: an exception, a red substrate, the green phase touched test files, the iteration limit ran out. You read the comment and fix the factory or the repo.
- `asel:blocked` - the run went through cleanly, but the agent hit a decision it is not allowed to guess. The question is in a comment on the issue. You answer with a comment and attach `asel:rework`; the same step runs once more, reading your answer.

The two are mutually exclusive (attaching one removes the other) and both remove the same trigger label that a failure of the given run would. The marker on the agent side is `ASEL_RESULT status=blocked` on the ordinary result line; a missing marker simply means "run finished", which is the safe direction.

A Woopy push goes out ONLY on these two states, because only they mean "the process has stopped and will not move without me". A finished map, the gates and commits awaiting review send nothing - those are not alarms.

### Correction: `asel:rework` at every stage

One label for rejecting a result, works at any step. It is never attached alone: the NEIGHBORING state label says which run to repeat, which keeps the state machine a pure function of labels and spares it from looking into history.

| Attached together with `asel:rework` | Repeated run |
| --- | --- |
| `asel:planned` | wayfinder (the former `asel:replan`) |
| `asel:spec-to-approve` | prd (may also fix the ADRs, see below) |
| `asel:plan-to-approve` | slices |
| `asel:specced` | tasks |
| `asel:task` + `asel:in-review` or `asel:blocked` | implement (task) |
| `asel:fast` + `asel:in-review` or `asel:blocked` | implement (fast) |
| `asel:blocked` alone on an epic | nothing happens, the reason is in the log and in the status block |
| none of the above | nothing happens, the reason is in the log |

Rework rules:

- Rework takes precedence over EVERYTHING: over idle states (in particular it beats `asel:in-review`) and over the ordinary `to-*` / `approved` triggers, in case someone attaches both at once. Correction before moving forward.
- `asel:failed` next to a rework does not block it: attaching a rework is an explicit human gesture, exactly like re-attaching a trigger. With `asel:blocked`, rework is in fact the only way out.
- `asel:blocked` is the second way (next to `asel:in-review`) of being finished, but on its own it says nothing about the stage. That is why `asel:blocked` alone fires an implementation run only on an issue with `asel:task` or `asel:fast` - those labels stay regardless of how the run ended. An epic in that shape idles: an implementation agent has no business on a planning issue.
- After a successful run ONLY `asel:rework` disappears (plus `asel:failed` / `asel:blocked`, if they were attached). The gate label stays, so the human comes back to the same gate, only with a corrected version. After a stop: `asel:failed` or `asel:blocked` is added, `asel:rework` disappears, so a repeat = attaching the rework once more.
- An implementation rework goes through the FULL chain of phases, starting from the tests: the reviewer's remarks may change the required behavior, and then the tests have to change first.
- The prompt of a rework run tells the agent FIRST to read the comments under the issue (via `gh`), treat them as the reviewer's remarks and fix up the work already on the branch instead of writing everything from scratch.
- At the `asel:spec-to-approve` gate the human reads the ADRs and the PRD TOGETHER, and a rework there fires the prd run. That is why the rework variant of the prd prompt judges what the remarks are about: if they undermine an architectural decision, the agent first fixes the file in `docs/adr/` and then brings the PRD into agreement with the corrected ADRs; if they concern the requirements alone, `docs/adr/` stays untouched. Without that there would be no way for remarks about the ADRs to land.

Rules:

- Gates are BETWEEN runs, not inside them. No run waits for a human.
- The trigger label is removed after the run finishes, not at its start. Deduplication is guarded by SQLite (a unique active run per `repo#issue` AND a unique active run per plan), and a run interrupted by a restart will fire again, because the label stayed in place.
- Trigger priority: `rework` > `fast` > `task` > `to-tasks` > `to-plan` > `to-prd` > `approved` > `plan`. A more advanced stage beats an older label left on the issue.
- Retry after an error: a spec pipeline run removes its own trigger, so coming back = setting that label again (`asel:plan`, `asel:approved`, `asel:to-prd`, `asel:to-plan`, `asel:to-tasks`, `asel:rework`). An implement run leaves the trigger in place, so there a retry = removing `asel:failed`. The comment in the issue says outright which variant applies.
- Concurrency limits: global (2 by default) and per project (1 by default). Above them works the rule of one active run per plan, which tightens them within a single epic.
- Closing a task issue is the human's decision after reviewing the commits. The orchestrator does not close it, and the prompt forbids the agent from doing so.

## Status block on the issue

Nobody has to remember the order of labels: the orchestrator maintains a self-updating block in the issue BODY that says where the process stands, which branch the work lands on and what to attach to move further (and what to attach if the result needs correcting). The block is in English, because it lands in project repositories.

The block sits between the invisible markers `<!-- ASEL:STATUS -->` and `<!-- /ASEL:STATUS -->`:

- when it is absent, it is appended at the END of the body; text written by a human is never overwritten or reordered,
- when it is present, only the content between the markers is replaced,
- when the new content is identical to the old one, the orchestrator sends no request to GitHub (which is why refreshing it on every poll is free),
- the block content is stripped from the issue description handed to the agent: this is the orchestrator's bookkeeping, not part of the assignment.

Three variants: epic (state in words, plan branch, next step and a checklist of the whole path `asel:plan` -> Wayfinder questions -> `asel:approved` -> ADR -> PRD -> gate -> `asel:to-plan` -> slices -> gate -> `asel:to-tasks` -> tasks), task (link to the epic, slice number, branch, whether it waits in the queue / is running / is up for review / failed / is stuck on a question) and a minimal one for `asel:fast`. Being blocked wins over the stage description: the block then says outright that the run stopped with a question, and that the way out is an answer plus `asel:rework`.

The block is refreshed on every poll, additionally at the start of a run ("run in progress, do nothing") and right after the label change at the end of a run. Rendering is a pure function of the labels, the markers from the body and the state from SQLite, so it adds no requests to GitHub.

## Label bootstrap

At startup, for every project from the registry, the orchestrator makes sure that all 15 state machine labels exist in the repo. It creates the missing ones, and for existing ones with a drifted description it fixes the description; it does not touch the COLOR of an existing label (a project may have themed its labels on purpose). Every label has a short English description saying what will happen once it is attached, and a color according to its role:

| Role | Color | Labels |
| --- | --- | --- |
| attached by a human | `1d76db` | `plan`, `rework`, `approved`, `to-plan`, `to-tasks`, `fast` |
| machine state | `ededed` | `to-prd`, `specced` |
| gate waiting for a human | `fbca04` | `planned`, `spec-to-approve`, `plan-to-approve`, `in-review` |
| failure | `b60205` | `failed` |
| question waiting for an answer | `d876e3` | `blocked` (never red: a question is not a failure) |
| task | `5319e7` | `task` |
| slice marker | `c5def5` | dynamic `asel:slice-<number>` |

The bootstrap does not know the dynamic `asel:slice-<number>` labels (the numbers are only known once the plan has been sliced) - the tasks run creates them, in the same color, because the prompt explicitly tells it to.

A lack of write permission for labels does not knock the orchestrator over: a warning goes to the log and work carries on. Kill switch: `ASEL_BOOTSTRAP_LABELS=0`.

## Planning artifact pipeline

```
wayfinder run   map + decision tickets                 -> asel:planned
  [GATE: humans approve the decisions, asel:approved]
adr run         docs/adr/    on the plan branch        -> asel:to-prd
prd run         docs/prd/    on the same branch        -> asel:spec-to-approve
  [GATE: the human reads the ADRs and the PRD, asel:to-plan]
slices run      docs/plans/  on the same branch        -> asel:plan-to-approve
  [GATE: the human reads the plan with slices, asel:to-tasks]
tasks run       issues with the asel:task label        -> asel:specced
```

Five separate runs instead of one, because a single run is meant to fit into a single context window. The `adr`, `prd`, `slices` and `tasks` runs work on one shared plan branch (`asel/plan-<epic issue number>`): the ADR run creates it, the PRD and the plan add commits, the tasks run only reads. Each of them checks out the branch and reads what its predecessors produced, and at the end pushes the branch to origin (Sandcastle brings commits in locally only). The plan is cut into SMALL VERTICAL slices (a slice works end to end and closes out within one agent run), and every task is pinned to exactly one slice, with the slice number and the epic number written into the issue body.

Two things in this chain are optional:

- **The ADRs.** The ADR run always goes, but writing an ADR is the agent's substantive decision: a file is created only for a decision with real architectural consequences (a serious alternative rejected, a choice that shapes a boundary, a data model, a protocol or a dependency that is hard to undo). No such decision = no file, no commit, one sentence of justification in a comment and still SUCCESS - the pipeline moves on to the PRD just the same. A directory of ADRs along the lines of "we picked the obvious solution" is worse than an empty one.
- **The `asel:plan-to-approve` gate.** Set per project through `gates.plan_approval` (`true` by default). With `false` a successful slices run attaches `asel:to-tasks` right away, so the tasks are created without waiting for a human; correcting the plan after the fact means attaching `asel:to-plan` by hand.

Tasks of the same plan commit to THE SAME branch, so they go one after another: ascending by slice number, ties broken by issue number, and a task without a slice marker goes to the end of the queue. There is no dependency graph - the order follows from the slice numbering set by the plan run. The reason why a given task is waiting is visible in the logs at the `debug` level.

`ASEL_TASK_GATE=closed` halts task runs completely (it concerns task implement runs only, not the plan pipeline) and overrides the queue above.

## Implementation run: red, green, review

One implement run is a chain of three agent phases in ONE container, on one worktree and one branch. The orchestrator knows nothing about the phases: to it this is still one call that either delivered or did not.

```
red      the agent writes tests only and commits
         -> the harness runs the test command and DEMANDS red
green    the agent implements
         -> guard: did it touch a test file? if so, hard stop
         -> the harness runs the tests; red = another iteration with the log tail in the prompt
review   code review and architecture verification
         -> the harness runs the FULL substrate of declared commands
```

The rule everything here stands on: the verdict is the EXIT CODE of the command the harness runs, not the agent's opinion of its own work.

- A green suite after the red phase = hard stop. A test that passes the moment it is written has specified nothing.
- The green phase has a hard iteration limit (`ASEL_GREEN_MAX_ITERATIONS`, 3 by default). After the last one the run becomes `asel:failed` and calls for a human. There is no "keep trying until it works" mode.
- **The guard against the agent writing tests to fit its own code is in the harness, not in the prompt.** Before every test invocation in the green phase the orchestrator computes `git diff --name-only <sha after the red phase>` plus the untracked files; touching a test file ends the run with the file list in a comment. Nothing is reverted on the agent's behalf - the commits stay on the branch to be read. The guard goes before the tests, because a suite the agent could have edited proves nothing.
- The guard applies to the green phase only. The review phase may ADD a test case (it is gated by the full substrate anyway), but it may not weaken an assertion.
- When a test really is wrong, the only legal way out is `asel:blocked`: the agent describes on the issue which test and why, and ends the phase with the `status=blocked` marker. The human decides.
- Every phase commits and pushes, so even a stopped run leaves its work visible on origin.
- A project without `checks.test` cannot have the test regime enforced, so the run degrades to ONE phase (a warning in the log). The remaining declared commands still run as the final gate: the substrate gate is independent of TDD.

The full substrate after the review phase runs in the declaration order from `checks`, fail-fast: the first red command ends the run, the rest are reported as skipped. A red substrate = `asel:failed` plus a comment with the command name, the exit code and the last ~50 lines of output. Exit code 127 (the command does not exist) is recognized as a project configuration error, not as red tests.

## How to add a project

One file in `projects/`. Start from the committed template [`projects/example.yml`](projects/example.yml), which documents every key inline: **copy** it to `projects/<your-project>.yml` and edit the copy. The orchestrator skips `example.yml` by name, so editing the template in place registers nothing. Everything else in `projects/` is gitignored, so your real registry entries stay local.

```yaml
name: your-project
repo: github.com/your-org/your-project
image: asel-agent-runtime:latest   # or the project's own image (FROM asel-agent-runtime)
concurrency: 1                     # optional, defaults to per_project_default from asel.yml
env:                               # names of the variables passed into the task container
  - DATABASE_URL

gates:
  plan_approval: true              # false = tasks run right after the plan, no gate

checks:                            # commands that the ORCHESTRATOR runs in the task container
  typecheck: pnpm tsc --noEmit     # declaration order = execution order
  lint: pnpm lint
  test: pnpm test --run            # the distinguished key: the red and green phases stand on it

test_file_patterns:                # what the green phase may not touch; omitted = defaults
  - "**/*.test.*"
  - "**/*.spec.*"
  - "test/**"
  - "tests/**"
  - "**/__tests__/**"
```

- `gates.plan_approval` defaults to `true`, so an older registry file keeps the full pipeline.
- `checks` is a name -> command map. The name has to start with a letter (a key that looks like a number would silently jump to the front of a JS object and break the order), the command has to be on the PATH in the project image. No `checks` = no gates, which is a legal transitional state.
- `test_file_patterns` omitted = the default values from the list above. An explicit EMPTY list is rejected: switching the guard off has to be a visible decision, not an accident.

Then `./asel.sh doctor` (it will check whether the token can see the repo) and `./asel.sh restart`. The registry is mounted read-only, so changes go through git, not through the container.

The project image, if needed, inherits from the base one:

```dockerfile
FROM asel-agent-runtime:latest
USER root
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
USER agent
```

## DRY_RUN mode

`DRY_RUN=1` makes the orchestrator log what it WOULD do (which run, on which image, on which branch, with which prompt) instead of starting containers. Labels and comments on GitHub are still applied, because that is the point: this tests the state machine without burning tokens.

```bash
DRY_RUN=1 ./asel.sh up
./asel.sh logs
```

The implementation run is the exception: in DRY_RUN it goes through the REAL chain of phases with a scripted harness, so the red gate, the test guard, the iteration limit and the substrate gate execute exactly as they would execute on Docker. Which ending to simulate is chosen by `ASEL_DRY_RUN_IMPLEMENT`:

| Value | What it exercises |
| --- | --- |
| `success` (default) | the full chain red -> green -> review -> green substrate, `asel:in-review` |
| `blocked` | the agent ends the green phase with the `status=blocked` marker -> `asel:blocked` |
| `red-phase-green` | the suite already passes after the red phase -> `asel:failed` |
| `test-guard` | the green phase touches a test file -> `asel:failed` with the file list |
| `green-limit` | the suite does not turn green within the iteration limit -> `asel:failed` |
| `checks-red` | a red command in the full substrate -> `asel:failed` with the output tail |

The scenarios assume a project with `checks.test` declared; without it the run degrades to a single phase, so the red gate, the green gate and the block (simulated in the green phase) have nothing to happen on. Without `checks.test` the working scenario that remains is `checks-red`.

The default value in `docker-compose.yml` is `DRY_RUN=1`. To fire real runs, set `DRY_RUN=0` in `.env` (the Sandcastle adapter itself sits behind the `ASEL_ENABLE_SANDCASTLE=1` flag, which is already on by default in `.env.example`).

In DRY_RUN the orchestrator does NOT clone the project repositories - it only logs that it skipped the synchronization. With `DRY_RUN=0` every run starts with `git clone` (the first time) or `git fetch --prune origin` (subsequent ones) into `ASEL_REPOS_DIR`, and does not start until that succeeds.

The prompts are visible with `LOG_LEVEL=debug`.

## Working on the orchestrator

```bash
cd orchestrator
pnpm install
pnpm test          # vitest: state machine, status block, labels, branches and the plan queue,
                   # configuration, prompts, substrate gates, phase chain and notification policy
pnpm build         # tsc, output in dist/
pnpm typecheck
```

Running locally without Docker (handy for debugging the loop):

```bash
cd orchestrator
GITHUB_TOKEN=... DRY_RUN=1 \
  ASEL_CONFIG_DIR=.. ASEL_STATE_DIR=/tmp/asel-state ASEL_REPOS_DIR=/tmp/asel-repos \
  node dist/index.js
```

Useful environment variables:

| Variable | Default | What for |
| --- | --- | --- |
| `DRY_RUN` | `1` in compose | 1 = do not start containers |
| `LOG_LEVEL` | `info` | `debug` shows the prompts and the per-issue decisions |
| `ASEL_CONFIG_DIR` | `/app/config` | directory with `asel.yml` and `projects/` |
| `ASEL_STATE_DIR` | `/data/state` | the SQLite database and the heartbeat file |
| `ASEL_REPOS_DIR` | `<repo>/repos` (determined by asel.sh) | clones and agent worktrees; identical path on the host and in the container |
| `ASEL_TASK_GATE` | `open` | `closed` halts all task implement runs |
| `ASEL_BOOTSTRAP_LABELS` | `1` | `0` disables creating labels in the project repositories |
| `ASEL_GREEN_MAX_ITERATIONS` | `3` | hard iteration limit of the green phase (an invalid value = the default) |
| `ASEL_DRY_RUN_IMPLEMENT` | `success` | only with `DRY_RUN=1`: which ending of the phase chain to simulate |
| `ASEL_ENABLE_SANDCASTLE` | unset | `1` enables the Sandcastle adapter (real containers) |
| `WOOPY_INBOUND_URL` | unset | target of the Woopy alarm webhook; empty = notifications off, whatever `asel.yml` says |
| `GITHUB_API_URL` | api.github.com | swapping in a mock in tests |

## Repo structure

```
asel.yml                      global configuration
projects/*.yml                project registry, one file per project (example.yml is the skipped template)
asel.sh                       wrapper around docker compose + doctor
docker-compose.yml            orchestrator service, state volume, repos bind mount
images/agent-runtime/         base agent image (Claude Code CLI, git, gh)
orchestrator/src/
  config.ts                   loading and validating the configuration (zod)
  github.ts                   minimal REST client on fetch
  machine.ts                  state machine over labels, pure functions
  labels.ts                   label definitions (description, color) and bootstrap in the project repo
  status.ts                   status block in the issue body, pure rendering and upsert
  plan.ts                     plan branches, markers in the issue body, run ordering and limits
  git-sync.ts                 project clones: clone/fetch before a run, header authorization
  state.ts                    run state in SQLite, dedup per issue and per plan, reconciliation
  runner/
    types.ts                  run interfaces, run result, implementation phases
    prompts.ts                prompts of all kinds and phases
    checks.ts                 substrate gates: commands, verdicts, test file patterns
    tdd.ts                    the red / green / review chain plus the test guard
    dry-run.ts                logging stub + scripted harness for the phase chain
    sandcastle.ts             Sandcastle adapter (run() and createSandbox() for implementation)
  notify.ts                   notifications: push only on failed and blocked
  index.ts                    main loop
```

## Conventions

- Code, comments, names in code and conceptual documentation: English.
- No long dashes in any files, always a plain hyphen.
- Node 22+, TypeScript strict, ESM, pnpm.

## License

MIT, see [LICENSE](LICENSE).
