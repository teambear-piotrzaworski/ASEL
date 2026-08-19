# ASEL - Agentic Software Engineering Lifecycle

Spec v0.1 (2026-08-12, last updated 2026-08-14).

## What ASEL is

A "software factory" layer ABOVE the projects: AI agents do the planned work in isolated containers, and humans steer the process through issues, labels and comments on GitHub. GitHub = the control plane and the review UI. Adding a project to the factory = one configuration file.

The goal of this repo: to refine and test ASEL LOCALLY (macOS + Docker Desktop), so that moving it to a VPS is only a matter of `git clone` + `.env` + `./asel.sh up`.

## Architecture

```
+----------------------------------------------------------------+
| docker compose                                                 |
|                                                                |
|  +----------------------+     poll (60s)    +-----------+      |
|  | orchestrator (Node)  | <---------------> | GitHub API|      |
|  |  - label state mach. |                   +-----------+      |
|  |  - run queue         |                                      |
|  |  - concurrency caps  |    sandcastle.run()                  |
|  |  - state (SQLite)    | ------------------+                  |
|  +----------+-----------+                   |                  |
|             | /var/run/docker.sock          v                  |
|             |                    +---------------------+       |
|  mounts:    |                    | task container      |       |
|   - repos   +------------------> | (agent-runtime img) |       |
|   - state                        | worktree + Claude   |       |
|                                  +---------------------+       |
+----------------------------------------------------------------+
```

Components:

1. **Orchestrator** (`orchestrator/`) - a Node/TypeScript service, the only code we write ourselves. It polls the GitHub API (no webhooks - the target VPS has no public ports), reacts to labels, starts planning runs (Wayfinder) and execution runs (Sandcastle), runs the substrate gates itself (the test, lint and typecheck commands) inside the task container, watches the concurrency limits, records run state in SQLite (the `state` volume), and sends Woopy notifications when and only when the process has stopped.
2. **Agent runtime image** (`images/agent-runtime/`) - the base Docker image: the Claude Code CLI, git, basic toolchains. Project images inherit from it (FROM) and add their own dependencies.
3. **Project registry** (`projects/*.yml`) - one YAML file per project: repo, image, secrets/env, limits, label mapping. `projects/example.yml` is the committed template, skipped by the loader and meant to be copied.
4. **Global configuration** (`asel.yml`) - the poll interval, the global concurrency limit, the label prefix, notification settings, volume paths.
5. **Main script** (`asel.sh`) - a wrapper around docker compose: `up`, `down`, `restart`, `logs`, `status`, `doctor`, `build`.
6. **Repo clones** - one clone of each project repository in the repos directory on the host (`ASEL_REPOS_DIR`, `<repo>/repos` by default), kept in sync with GitHub by the orchestrator. Every run gets a fresh worktree out of that clone. The directory is mounted into the orchestrator container under an identical absolute path, because the Docker daemon resolves the agent containers' bind mounts on the host side - the paths have to mean the same thing on both sides (decision from 2026-08-13).
   **Correction 2026-08-15:** earlier versions of this point talked about BARE mirrors. That is out of date - the orchestrator keeps ordinary working clones (`git clone`, then `git fetch --prune origin` before every run), because Sandcastle makes worktrees out of them and keeps `.sandcastle/` next to them. Implementation, including the authorization scheme: `orchestrator/src/git-sync.ts`.

## External tools

- **Wayfinder** (Matt Pocock's planning skill) - the plan phase: a map (`wayfinder:map`) plus decision tickets in the repo's issue tracker. Docs: https://github.com/mattpocock/skills/blob/main/docs/engineering/wayfinder.md
- **Sandcastle** (`@ai-hero/sandcastle`, Matt Pocock's TS library) - `sandcastle.run()` starts an agent in an isolated container, manages worktrees and branch strategies, brings the commits back. The implementation run needs several agent calls on ONE worktree, so it uses the library's second entry point: `createSandbox()` + repeated `sandbox.run()` + `sandbox.exec()` for the harness commands in the same warm container. Repo: https://github.com/mattpocock/sandcastle
- When implementing the integration, FIRST read the current API of both tools (WebFetch on the repo/docs) - do not guess signatures.

## Layers - what sits where (and where Sandcastle sits)

There are two different kinds of "planning" in ASEL and they are easy to confuse. The order of the layers:

```
Layer 0: GitHub                 issues, labels, comments (humans live here)
Layer 1: ASEL orchestrator      polling, state machine, run queue
Layer 2: Run kinds (process)    wayfinder / adr / prd / slices / tasks / implement
Layer 3: Sandcastle             execution harness: container + worktree + branch + commits back
```

- **Sandcastle sits at the very bottom** - it is the engine room, not an element of the process. `sandcastle.run()` is responsible only for safely starting an agent on the code in an isolated container and bringing the commits back. It knows nothing about ADRs, PRDs or slices. Every layer 2 run that touches the repo is executed THROUGH Sandcastle - these are different prompts/configurations fed into the same harness.
- **The repository clone belongs to layer 1, the worktree to layer 3.** Sandcastle is handed a ready path (`cwd`) and does not create it itself, so it is the orchestrator that makes sure the clone exists and has fresh refs from origin - `git clone` on the first run, `git fetch --prune origin` before every next one (`orchestrator/src/git-sync.ts`). A failed sync is a failure of the RUN (`asel:failed` plus a comment), not a crash of the orchestrator.
- **One run = one agent = one context window.** That is why the spec phase is not one run but four (adr, prd, slices, tasks). A single run doing ADR + PRD + plan + tasks does not fit in the window for a larger epic.
- **Exception: the implementation run is a chain of three phases** (red, green, review) in ONE container, on one worktree and one branch, plus the substrate gates started by the harness between the phases. The whole chain sits in layer 3 - for layers 1 and 2 it is still a single `runImplement()` call that either delivered or did not. Details in the implementation run section.
- **The two levels of planning do not clash.** Sandcastle's internal planner/implementer/merger loop is micro-planning: it works inside a single run and concerns a change in the code ("plan out the change, implement it, merge the commits"). The ASEL pipeline (Wayfinder -> ADR -> PRD -> Plan -> tasks) is macro-planning: it decides WHAT is to be done and cuts the work into tasks. Macro feeds micro well-defined tasks.
- **The task size rule**: one task = one run. The tasks coming out of the tasks run have to fit in a single Sandcastle run; if a task is too big ("build the whole module"), it starts duplicating Sandcastle's internal planning. Small vertical slices are the safeguard against that problem.

## One plan = one branch

The factory does not use pull requests as process mechanics. Commits are enough.

- Everything that grows out of one epic issue (the ADRs, the PRD, the plan with slices, the implementation of every task) commits to ONE branch: `asel/plan-<epic issue number>`. The name is deterministic, so it is stable between runs, between gates and after an orchestrator restart.
- The wayfinder run gets the same branch even though it produces issues rather than files - that way it does not leave an orphaned branch behind.
- `asel:fast` has its own branch per issue (`asel/issue-<number>`), because it belongs to no plan and can go independently.
- Every run ends with commits and **a push of the branch to origin**. Sandcastle brings the commits back locally only, so without the push the work is invisible on GitHub.
- A human reviews the commit history on the branch and decides on their own when and how to merge it into the default branch. The orchestrator does not open, merge or watch pull requests. It does not close task issues either - that is the human's decision after the review.
- **Consequence: implementation goes sequentially.** Since everything lands on one branch, at any given moment exactly one agent works on one plan. This replaces the previously planned slice-by-slice queueing with dependency declarations: the order follows from the slice numbering, not from a dependency graph. Parallelism is deliberately deferred.
- **Sequencing applies to the BRANCH, not to the working directory.** Agents never share a directory: Sandcastle starts every run on a separate worktree in a separate container, so even today two runs cannot trample each other's files on disk. Per-plan serialization exists so that two runs do not push the same branch in parallel and split its commit history. Runs of different epics and different projects still go in parallel (global limit 2) and that is the only place where a collision of changes in the same files is possible at all; it is settled by a human when merging the branch into the default branch, because that is their decision, not the factory's.

### How a task finds its plan

The orchestrator does not read files out of the repositories (the clones in `ASEL_REPOS_DIR` exist solely so that Sandcastle has something to make a worktree from), so the link between a task and its plan travels in the issue body. The tasks run writes two lines into every issue:

```
ASEL_EPIC: 42
ASEL_SLICE: 3
```

- `ASEL_EPIC` determines the plan branch (`asel/plan-42`) and the serialization key.
- `ASEL_SLICE` gives the execution order: ascending by slice, ties broken by issue number, a task without the marker goes to the end of the queue.
- The parser looks for a LINE, not a position: it tolerates markdown decoration (`- **ASEL_EPIC:** #42`), letter case, `=` instead of `:`, text after the number and a human reordering the lines. A missing marker is a normal case, not an error.
- Fallback: a task without `ASEL_EPIC` (for example an issue created by hand by a human) gets its own branch `asel/issue-<number>` and is not serialized with anything.
- The task also gets an `asel:slice-<number>` label (prefix from the configuration) as a readable marker for the human. The source of truth for the order is the marker in the body, not the label.

## Planning artifact pipeline

The plan phase is not one document but a chain of artifacts derived one from another. Every link is a separate run, because a separate responsibility = a separate context window:

```
wayfinder run   map + decision tickets                -> asel:planned
  [GATE: humans approve the decisions, asel:approved]
adr run         docs/adr/    on the plan branch       -> asel:to-prd
prd run         docs/prd/    on the same branch       -> asel:spec-to-approve
  [GATE: a human reads the ADRs and the PRD, asel:to-plan]
slices run      docs/plans/  on the same branch       -> asel:plan-to-approve
  [GATE: a human reads the plan with slices, asel:to-tasks - CAN BE TURNED OFF per project]
tasks run       issues with the asel:task label       -> asel:specced
```

- The `adr`, `prd`, `slices` and `tasks` runs work on ONE shared plan branch for a given epic (`asel/plan-<issue number>`). The ADR run creates it, the PRD and the plan add commits and push, the tasks run only reads the branch and commits nothing. Each of them checks out the branch and reads as input what the previous one left behind (`docs/adr/`, `docs/prd/`, `docs/plans/`), instead of getting it in the prompt.
- **The ADR is OPTIONAL.** The ADR run always stays in the pipeline, but the agent writes a file only for decisions with real architectural consequences (a serious alternative was rejected; the choice shapes a boundary, a data model, a protocol or a dependency that is hard to undo). No such decision = no file, no commit, one sentence of justification in a comment on the issue, `ASEL_RESULT adrs=0` - and the run ends in SUCCESS, and the pipeline moves on to `asel:to-prd` exactly the same way as after ten records. A directory full of ADRs along the lines of "we picked the obvious solution" is worse than an empty one, because it teaches the reader to skip that directory.
  Rejected alternative: the orchestrator skips the ADR step on its own by counting Wayfinder's decision tickets. Wayfinder issues tickets almost always, and a settled decision is not yet a decision worth recording - that judgement is substantive and belongs to the agent that read the tickets. The gain: the state machine stays a pure function of labels, without peeking into somebody else's label space.
- **The `asel:plan-to-approve` gate can be turned off per project** (`gates.plan_approval` in `projects/<name>.yml`, `true` by default). With a good, approved spec the plan basically writes itself, so this gate is meant to disappear eventually; it stays on for the duration of the tests, and the switch is per project because trust in the process will differ across repositories. With `plan_approval: false` a successful slices run applies `asel:to-tasks` straight away, so the tasks run starts on the next poll. Fixing the plan after the fact with the gate off needs no new label: the human applies `asel:to-plan` by hand and the plan run goes again.
  The configuration does NOT enter `decide()` - that stays a pure function of labels. The gate changes only WHICH label a finished run applies, so it comes in through the options object to `labelUpdateAfterRun(...)`.
- None of these runs writes production code and none of them opens a pull request.
- Tasks are created as issues with the `asel:task` label (plus `asel:slice-<number>` for readability), linked to exactly one slice of the plan and to the epic issue, with the `ASEL_EPIC` and `ASEL_SLICE` markers in the issue body. A slice is vertical (a working piece from UI/API down to data), small and closable in one run.
- Slices are numbered IN EXECUTION ORDER. There are no dependency declarations between slices and no dependency graph - the slice number is all the information about the order there is.
- Implementation goes sequentially: the tasks of one plan commit to the same branch, so at any given moment exactly one run of that plan is going, in slice order.

## State machine (labels)

The label prefix is configurable, `asel` by default. The flow:

Fifteen labels:

| Label | Who sets it | Effect |
| --- | --- | --- |
| `asel:plan` | human | Wayfinder run (map + decision tickets), success -> `asel:planned` |
| `asel:planned` | orchestrator | gate: idle, waiting for the humans' decisions |
| `asel:rework` | human | repeats the step indicated by the neighboring state label (table below), reading the comments |
| `asel:approved` | human | ADR run (the ADRs are optional, `adrs=0` is a success too), success -> `approved` + `planned` removed, `asel:to-prd` added |
| `asel:to-prd` | orchestrator | PRD run, success -> `to-prd` removed, `asel:spec-to-approve` added |
| `asel:spec-to-approve` | orchestrator | gate: idle, a human reads the ADRs and the PRD on the plan branch |
| `asel:to-plan` | human | run of the plan with slices, success -> `to-plan` + `spec-to-approve` removed, `asel:plan-to-approve` added or (with `gates.plan_approval: false`) `asel:to-tasks` straight away |
| `asel:plan-to-approve` | orchestrator | gate: idle, a human reads the plan with slices on the plan branch; with the gate turned off this label is never created |
| `asel:to-tasks` | human (or the orchestrator with the gate turned off) | task creation run, success -> `to-tasks` + `plan-to-approve` removed, `asel:specced` added |
| `asel:specced` | orchestrator | terminal state of the epic: idle, the tasks exist and live a life of their own |
| `asel:task` | tasks run | implement run per task -> commits on the plan branch -> `asel:in-review` |
| `asel:fast` | human | skips the whole plan pipeline, straight to implementation on its own branch (small stuff) |
| `asel:in-review` | orchestrator | idle, the commits wait for a human review (`asel:rework` next to it = the implementation is repeated) |
| `asel:failed` | orchestrator | the run blew up (an exception, a red substrate, a tripped guard, an exhausted iteration limit), a comment with the reason on the issue, a Woopy push |
| `asel:blocked` | orchestrator | the run finished CLEANLY but left a question: idle, the agent's question on the issue, a Woopy push |

- Naming convention: `to-*` is a trigger for the machine, every other label is a state waiting for a human.
- The gates are BETWEEN runs, not inside them - no run waits for a human. There are three: `asel:planned` (Wayfinder's decisions), `asel:spec-to-approve` (ADR + PRD) and `asel:plan-to-approve` (the plan with slices, can be turned off per project).
- The triggering label is removed AFTER the run FINISHES, not at its start.
- Trigger priority in the state machine: `rework` > `fast` > `task` > `to-tasks` > `to-plan` > `to-prd` > `approved` > `plan`. A more advanced stage beats an older label left over on the issue.
- On the failure of any run of the spec pipeline: `asel:failed` + removal of that run's triggering label. Retry = the human applies the triggering label again. The implement run is the exception: the trigger stays (`asel:task` is an identity marker, `asel:fast` was applied by a human), so retry = removing `asel:failed`.
- Outside the state machine: `asel:slice-<number>` on a task as a marker for the human.

### Two ways a run can stop: `asel:failed` and `asel:blocked`

`asel:failed` means "it blew up" (an exception, a red substrate, the test guard, an exhausted green phase iteration limit). `asel:blocked` means "the agent does not know what to do and is asking". They are kept apart so that the human's reaction is different: on a failure you read the log and fix the factory or the repo, on a block you answer the question.

- The run finishes cleanly, the agent leaves a question in a comment on the issue (`gh issue comment`), and the orchestrator applies `asel:blocked`. This is an idle state: nothing starts by itself.
- The way out: the human answers with a comment and applies `asel:rework`. The same run goes again, this time reading the comments.
- Marker: `ASEL_RESULT status=blocked` on the ordinary result line, not in a separate format. The value is compared case-insensitively. NO marker = the run is simply finished - that is the safe direction, because the result is visible on the issue anyway, and a second thing that can get lost (a separate parser, a separate line) only makes things worse.
- `asel:failed` and `asel:blocked` are mutually exclusive: applying one removes the other, so an issue never claims both at once.
- `asel:blocked` removes exactly the same triggering label as a failure of that run kind does - what the human has to do next depends on the stage, not on the reason for stopping.
- A block is not a failure in the run history either: SQLite records a separate `blocked` status, so that "the factory broke" can be told apart from "the factory was waiting for us".

### Notifications (Woopy)

A push goes out only when the process has STOPPED and will not move without a human: `failure` and `blocked`. A finished Wayfinder map, the spec and plan gates, commits waiting for review - none of that sends a notification. Woopy is an alarm in the "drop everything you are doing" sense, and a channel that also carries ordinary events stops being an alarm within a single day; the rest is meant to go into a batch review, so that you can sit down once and go through everything in one sitting. The rule is a single explicit function in the code (`shouldNotifyOutcome()` in `notify.ts`), not a condition repeated at the call sites - precisely so that it does not spread back out. The batch digest and the commands in `asel.sh` are deliberately out of scope, to be done later.

### Rework: `asel:rework`

Rejecting a result works at EVERY stage and has one label. `asel:rework` never sits on an issue alone - the neighboring state label says unambiguously which run to repeat, so the state machine remains a pure function of labels:

| Sits together with `asel:rework` | Repeated run |
| --- | --- |
| `asel:planned` | wayfinder |
| `asel:spec-to-approve` | prd (with the right to fix the ADRs, see below) |
| `asel:plan-to-approve` | slices |
| `asel:specced` | tasks |
| `asel:task` + (`asel:in-review` or `asel:blocked`) | implement, role "task" |
| `asel:fast` + (`asel:in-review` or `asel:blocked`) | implement, role "epic" |
| `asel:blocked` alone on an epic | idle with a readable reason (see below) |
| none of the above | idle with a readable reason, nothing starts |

- `asel:blocked` joins the table as the SECOND way of being finished, next to `asel:in-review`. Which step to repeat is still told by the neighboring state label, because `blocked` carries no information about the stage.
- **Guard: `asel:blocked` on its own, without a neighboring state label, maps to the implementation run only for issues with `asel:task` or `asel:fast`.** Those two labels are an identity, not a trigger - the implementation run leaves them in place regardless of how it ended, so a task or a fast really does stand at the implementation stage. An epic in that shape is something else (it blocked in the middle of a pipeline run that removed its own trigger and left no gate label), and treating it as "implement" would let an implementation agent loose on a planning issue. Such an epic idles with the reason spelled out: apply the label of the stage to repeat, or the trigger of that stage.
- Rework has PRECEDENCE over the idle states (in particular it beats `asel:in-review`, which idles without it) and over the ordinary `to-*` / `approved` triggers, should a human apply both at once. Fixing comes before moving forward.
- `asel:failed` next to a rework does not block it: a rework is an explicit human gesture, so it starts a run just like applying the trigger again. The same goes for `asel:blocked` - there it is in fact the only way out.
- Labels after a rework run: success removes ONLY `asel:rework` (plus `asel:failed` and `asel:blocked`, if either was there), the state/gate label is left untouched, because the human comes back to the same gate with a corrected version. A stop adds `asel:failed` or `asel:blocked` and removes `asel:rework`.
- Every run kind has a "rework" variant of the prompt: the agent is to first read the comments under the issue (for wayfinder also under the decision tickets) through `gh`, treat them as reviewer notes and fix the existing work on the branch instead of writing from scratch. The rest of the contract (branch, commits, push, no pull requests) is unchanged.
- A rework of the implementation run goes through the FULL chain, from the red phase. Reviewer notes can change the required behavior, and then the tests have to change first. Starting a rework from the green phase would be the only supported way to edit tests with the guard turned off, that is exactly the hole the chain of phases closes.
- **A scope exception at the `asel:spec-to-approve` gate.** This gate covers the ADRs and the PRD together, and a rework starts the prd run there, so the prd rework prompt decides what the notes are about: notes that undermine an architectural decision = a fix to a file in `docs/adr/`, followed by bringing the PRD in line with the corrected ADRs; notes about the requirements themselves = `docs/adr/` unchanged. This is the only run that reaches outside its own directory, and it does so only in the rework variant. The alternative (a separate gate and a separate label after the ADRs) was rejected: it adds a label and a gate to a process that is meant to be simple.

### The interface for the human: the status block and the labels in the repo

The state machine is driven by labels, but the human is not supposed to memorize their order. Two interface elements are part of the machine, not an add-on:

1. **A status block in the issue body.** In the body of every covered issue the orchestrator maintains a block between the `<!-- ASEL:STATUS -->` and `<!-- /ASEL:STATUS -->` markers: the current state in words, the branch, a highlighted NEXT STEP (which label to apply to move on or to step back with a rework; or the information that a run is in progress and nothing needs to be done) and, for an epic, a checklist of the whole path with the completed steps ticked off. Three variants: epic, task (link to the epic, slice, branch, whether it is waiting/running/up for review/failed/stopped on a question) and a minimal one for `asel:fast`. The text of the block is in English, because it lands in the project repositories. A block wins over the description of the stage: the block then says outright that the last run stopped with a question, and that the way out is an answer plus `asel:rework`.
   - Rendering and insertion are pure functions (`orchestrator/src/status.ts`): the state comes solely from the labels, the markers in the body and the state in SQLite, with no extra requests to GitHub.
   - No block = it is appended at the end of the body, never overwriting the human's text. An existing block = a replacement only between the markers. Identical content = ZERO requests to GitHub, so refreshing it on every poll is free.
   - The block is cut out of the issue body that is passed to the agent (it is the orchestrator's bookkeeping, not part of the assignment).
2. **Label bootstrap.** On startup, for every project in the registry, the orchestrator creates the missing state machine labels (all 15) with a short English description ("what happens when you apply this") and a color by role: human / machine state / gate / failure / block / task / slice marker. `asel:blocked` has its own color, never red: a question is not a failure and calls for a different reaction. The descriptions of existing labels are corrected, the colors are not (a project may have themed its labels on purpose). A lack of write permission for labels logs a warning and does not interrupt the work. Off switch: `ASEL_BOOTSTRAP_LABELS=0`. The dynamic `asel:slice-<number>` labels are created by the tasks run, because their numbers are only known once the plan has been cut up.

State safety rules:
- The orchestrator never starts two runs for the same issue at once (dedup by `repo#issue` in SQLite).
- The orchestrator never starts two runs of the same plan at once, counting the epic's runs and that epic's task runs together (dedup by the plan key in SQLite, because they all commit to one branch).
- An orchestrator restart must not lose or duplicate runs: the state lives in SQLite, and after startup it is reconciled with the labels on GitHub.
- Concurrency limit: global (2 by default) and per project (1 by default). The one-run-per-plan rule sits above them and only tightens them within a single epic - runs of different epics and different projects can still go in parallel.
- `ASEL_TASK_GATE=closed` is an emergency kill switch for all task implement runs, overriding the queue and the limits.

## The implementation run: red, green, review

The implementation run is the only run that, instead of one prompt, is a CHAIN of three agent phases, interleaved with commands started by the harness. All three go in one container, on one worktree and one branch. For the orchestrator it is still a single `runImplement()` call with a single result - only layer 3 knows about the phases.

The point of the split: every claim the agent could make about its own work is replaced with a command that the harness runs itself. "I wrote a test that fails" is worth nothing next to an exit code.

```
red phase     the agent writes ONLY tests and commits
              -> the harness runs the test command and DEMANDS red
green phase   the agent implements
              -> guard: did it touch a test file?
              -> the harness runs the tests; red = another iteration with the log tail
review phase  code review and architecture verification
              -> the harness runs the FULL substrate of declared commands
```

- **red.** The agent writes tests describing the task, writes no production code (not even a stub), and commits separately. After the phase the harness runs the `checks.test` command and demands a non-zero exit code. Green after the red phase = a HARD STOP: a test that passes the moment it is written checks something that was already true, so this run specified nothing. The run ends in failure with that reason written into the issue, before it implements anything.
- **green.** The agent writes production code. After EVERY iteration the harness runs the tests itself: green ends the phase, red starts another iteration with the tail of the output pasted into the prompt. The iteration limit is hard (`ASEL_GREEN_MAX_ITERATIONS`, 3 by default) and cannot be raised from inside the run; after the last iteration the run becomes `asel:failed` and calls a human. There is no "keep trying until it works" mode: an agent that did not get there in three attempts usually does not know something that the human knows.
- **review.** A green suite says only that the code does what the tests say. This phase asks the second question: whether the tests and the code are what the task asked for, whether they fit the architecture around them, what about error handling, edge cases and the documentation that the change invalidated. At the end the harness runs the full substrate.

### Guard: the agent does not write the tests to suit itself

The guard sits in the HARNESS, not in the prompt - the prompt only warns that the guard exists.

- Baseline: `git rev-parse HEAD` after the red phase. Whatever was already dirty at that moment was left behind by the red phase, so it is excluded from the guard: the green phase answers only for what it changed itself.
- Before EVERY test run in the green phase: `git diff --name-only <sha>` (without `..HEAD`, so it also catches uncommitted changes) plus `git ls-files --others --exclude-standard` (catches a new, uncommitted test file). Touching a test file = a hard stop with the list of files in a comment.
- The guard goes BEFORE the tests, because a suite that the agent could have edited proves nothing - there is no point in running it first.
- Nothing is reverted on the agent's behalf. The commits stay on the branch to be read; the factory does not clean up after the agent and does not pretend something never happened.
- The guard applies ONLY to the green phase. The review phase may add a test case for a hole it found (a ban would take away the reviewer's point), but it must not weaken or delete an assertion - everything is gated by the full substrate anyway.
- The only legitimate way out when a test is genuinely wrong (it checks something the task did not ask for, or something impossible): the agent does NOT fix it and does not work around it, it only describes on the issue which test and why, and ends the green phase with the `status=blocked` marker. The human decides. Taking this route is a good outcome, not a failure.
- The test file patterns are configurable (`test_file_patterns`), by default `**/*.test.*`, `**/*.spec.*`, `test/**`, `tests/**`, `**/__tests__/**`. The list also goes into the green phase prompt, so that the agent knows what not to touch. An explicit empty list is REJECTED during configuration validation: turning off the only mechanism that stops an agent from rewriting its own tests has to be a visible decision, not an accidental empty array.

### The substrate gates are run by the harness, not by the prompt

`checks` in `projects/<name>.yml` is an ORDERED map of name -> shell command. The order of declaration is the order of execution (a cheap check can be put before a slow suite), and the name has to start with a letter: a key that looks like a number silently jumps to the front of a JS object and upends the declared order.

- The `test` key is the special one - the red and green phases stand on it. The rest of the commands go in the full substrate after the review phase.
- Execution is fail-fast: the first red command ends the substrate, the remaining ones are reported as skipped (rather than quietly lost). The first red one is the one the human looks at anyway, and the following ones usually just repeat its noise.
- The result is the EXIT CODE, not the agent's declaration. A red substrate = `asel:failed` plus a comment with the name of the command, its exit code and the last ~50 lines of output in a code block (triple backticks in the output are neutralized so that they do not blow the block apart).
- Exit code 127 (command not found) is recognized as a project configuration error, not as red tests - otherwise a typo in `checks` would look like broken code.
- **No `checks.test`**: a warning in the log and a degradation to a SINGLE-PHASE implementation run. Without a test command the phases would be theater - three prompts and no verdict - and a repo without a test runner is not supposed to block the factory. The remaining declared commands still work as the final gate: the substrate gate is independent of the TDD regime.
- A project that declares nothing has no gate at all. That is a legitimate transitional state, not the recommended end state.

## Configuration

`asel.yml` (global, committed):

```yaml
poll_interval_seconds: 60
label_prefix: asel
concurrency:
  global: 2
  per_project_default: 1
notifications:
  woopy:
    enabled: false        # a stub locally, the Woopy inbound webhook on the VPS
    url_env: WOOPY_INBOUND_URL
paths:
  # both keys are a fallback: ASEL_REPOS_DIR and ASEL_STATE_DIR take
  # precedence. In practice the repos directory is always set by
  # ASEL_REPOS_DIR (asel.sh / compose), because it has to be identical on
  # the host and in the orchestrator container
  repos: /data/repos
  state: /data/state
```

`projects/<name>.yml` (per project; `projects/example.yml` is the committed template, skipped by the loader and copied rather than edited, and the rest of the directory is gitignored):

```yaml
name: example
repo: github.com/your-org/example       # the full repo
image: asel-agent-runtime:latest        # or the project's own image
concurrency: 1
env: []                                 # names of the variables passed to the task container
gates:
  plan_approval: true                   # false = the tasks run starts right after the plan
checks:                                 # ordered map: declaration order = execution order
  typecheck: pnpm tsc --noEmit
  lint: pnpm lint
  test: pnpm test --run                 # the special key: the red and green phases stand on it
test_file_patterns:                     # omitted = the defaults; an empty list is rejected
  - "**/*.test.*"
  - "**/*.spec.*"
  - "test/**"
  - "tests/**"
  - "**/__tests__/**"
```

- `gates.plan_approval` defaults to `true`, so a registry file written before the switch existed keeps the full pipeline it was created with.
- `checks` and `test_file_patterns` are described in the implementation run section. A check name has to start with a letter, a command must not be empty.

`.env` (secrets and operational switches, NOT committed; `.env.example` is committed):

- `GITHUB_TOKEN` - a PAT with access to the repos covered by the factory
- `CLAUDE_CODE_OAUTH_TOKEN` - a token from `claude setup-token` (eventually a separate machine account)
- `WOOPY_INBOUND_URL` - optional
- `ASEL_REPOS_DIR` - optional, the directory for the clones and worktrees (`<repo>/repos` by default)
- `ASEL_GREEN_MAX_ITERATIONS` - the hard iteration limit of the green phase, 3 by default (an invalid value = the default)
- `ASEL_DRY_RUN_IMPLEMENT` - only with `DRY_RUN=1`: which ending of the chain of phases to simulate
- `ASEL_TASK_GATE`, `ASEL_BOOTSTRAP_LABELS`, `ASEL_ENABLE_SANDCASTLE` - operational switches, deliberately kept outside `asel.yml`
- `ASEL_STATE_DIR`, `ASEL_CONFIG_DIR` - they override the paths derived from `asel.yml` (state, the directory of the project registry)
- `ASEL_AGENT_MODEL`, `ASEL_MAX_ITERATIONS` - the agent model and the iteration limit of a SINGLE Sandcastle run; not to be confused with `ASEL_GREEN_MAX_ITERATIONS`, which counts the repeats of the whole green phase
- `ASEL_HEARTBEAT_MAX_AGE_SECONDS`, `ASEL_SHUTDOWN_TIMEOUT_MS` - the healthcheck and the time given to finish the runs while the container is being stopped

## docker compose

- The `orchestrator` service: built from `orchestrator/Dockerfile`, mounts `/var/run/docker.sock` (Sandcastle starts sibling containers, NOT DinD), the `state` volume and a bind mount of the repos directory under an identical path (`${ASEL_REPOS_DIR}:${ASEL_REPOS_DIR}`), `env_file: .env`, `restart: unless-stopped`.
- The `agent-runtime` image is built separately (`asel.sh build`), it is not a compose service.
- A healthcheck for the orchestrator (a simple endpoint or a heartbeat file).

## Local testing mode

- `asel.sh doctor` - checks: docker is running, the socket is available, `GITHUB_TOKEN` is valid (whoami), `CLAUDE_CODE_OAUTH_TOKEN` is set, the agent-runtime image is built, the projects from the registry are reachable on GitHub.
- An end-to-end test locally: a dedicated test repo (to be created later), an issue with the `asel:fast` label, the expected result is an `asel/issue-<number>` branch pushed to origin with commits.
- `DRY_RUN=1` mode: the orchestrator logs what it WOULD do (a plan run / an implementation run), without starting containers - for testing the state machine without burning tokens. The implementation run is the exception: it goes through the REAL chain of phases with a scripted harness, so the red gate, the test guard, the iteration limit and the substrate gate execute exactly as they would execute on Docker. `ASEL_DRY_RUN_IMPLEMENT` picks the simulated ending: `success` (the default), `blocked`, `red-phase-green`, `test-guard`, `green-limit`, `checks-red` - and this is the way to rehearse the `asel:failed` and `asel:blocked` labels without a container.

## Rollout order

1. Slice 1 (this repo, now): the skeleton - configuration, compose, asel.sh, the orchestrator with polling and the state machine, the agent-runtime image, DRY_RUN.
2. Slice 2: a manual E2E pass on the test repo (Wayfinder by hand, sandcastle.run() by hand) - verification of the workflow.
3. Slice 3: full automation of the runs in the orchestrator + Woopy notifications.
4. Slice 4: the move to a server (private networking, mirrors, a separate Claude account).

## Repo conventions

- Code, comments, names in the code and the documentation: English.
- No long dashes in any file - always a plain hyphen.
- Node 22+, TypeScript strict, ESM. Package manager: pnpm.
- Tests: vitest, at least for the state machine and configuration parsing.
