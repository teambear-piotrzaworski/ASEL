import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "../config.js";
import { createLogger } from "../logger.js";
import {
  BLOCKED_RESULT_LINE,
  adrPrompt,
  implementGreenPrompt,
  implementPrompt,
  implementRedPrompt,
  implementReviewPrompt,
  isBlockedResult,
  parseResultMarker,
  prdPrompt,
  slicesPrompt,
  tasksPrompt,
  wayfinderPrompt,
  type TaskPromptLabels,
} from "./prompts.js";
import type { RunContext } from "./types.js";

const PROJECT: ProjectConfig = {
  name: "example",
  fullName: "acme/example",
  owner: "acme",
  repoName: "example",
  image: "asel-agent-runtime:latest",
  concurrency: 1,
  env: [],
  gates: { planApproval: true },
  checks: [
    { name: "typecheck", command: "pnpm tsc --noEmit" },
    { name: "test", command: "pnpm test --run" },
  ],
  testFilePatterns: ["**/*.test.*", "test/**"],
  sourceFile: "projects/example.yml",
};

const TASK_LABELS: TaskPromptLabels = {
  taskLabel: "asel:task",
  sliceLabelPrefix: "asel:slice-",
  sliceLabelColor: "c5def5",
};

function context(overrides: Partial<RunContext> = {}): RunContext {
  return {
    project: PROJECT,
    repo: "acme/example",
    issue: {
      number: 42,
      title: "Rework the importer",
      body: "Details.",
      htmlUrl: "https://github.com/acme/example/issues/42",
    },
    role: "epic",
    triggerLabel: "asel:plan",
    isRework: false,
    repoPath: "/repos/acme__example",
    branch: "asel/plan-42",
    epicIssue: 42,
    slice: null,
    log: createLogger("test"),
    ...overrides,
  };
}

const GREEN_OPTIONS = {
  testCommand: "pnpm test --run",
  iteration: 1,
  maxIterations: 3,
  failureOutput: "",
  testFilePatterns: ["**/*.test.*"],
};

const RENDERERS: Array<[string, (context: RunContext) => string]> = [
  ["wayfinder", wayfinderPrompt],
  ["adr", adrPrompt],
  ["prd", prdPrompt],
  ["slices", slicesPrompt],
  ["tasks", (ctx) => tasksPrompt(ctx, TASK_LABELS)],
  ["implement", implementPrompt],
  ["red", (ctx) => implementRedPrompt(ctx, "pnpm test --run")],
  ["green", (ctx) => implementGreenPrompt(ctx, GREEN_OPTIONS)],
  ["review", (ctx) => implementReviewPrompt(ctx, ["typecheck", "test"])],
];

describe("prompts: normal run", () => {
  it("says nothing about rework", () => {
    for (const [, render] of RENDERERS) {
      expect(render(context())).not.toContain("REWORK");
    }
  });
});

describe("prompts: rework run", () => {
  it("marks every kind as a rework and points at the review comments", () => {
    for (const [kind, render] of RENDERERS) {
      const prompt = render(context({ isRework: true }));
      expect(prompt, kind).toContain("THIS RUN IS A REWORK, NOT NEW WORK.");
      expect(prompt, kind).toContain(
        "gh issue view 42 --repo acme/example --comments",
      );
      expect(prompt, kind).toContain("instead of writing it again from scratch");
    }
  });

  it("keeps the branch and push contract of the normal run", () => {
    const prompt = adrPrompt(context({ isRework: true }));
    expect(prompt).toContain("git push -u origin asel/plan-42");
    expect(prompt).toContain("do NOT open a pull request");
  });

  it("sends the wayfinder rework to the decision tickets as well", () => {
    expect(wayfinderPrompt(context({ isRework: true }))).toContain("decision tickets");
  });

  it("tells an implementation rework to read the commits it has to fix", () => {
    expect(implementPrompt(context({ isRework: true, role: "task" }))).toContain("git log");
  });

  it("lets a prd rework reach into the ADRs, because the gate covers both", () => {
    const prompt = prdPrompt(context({ isRework: true }));
    expect(prompt).toContain("fix the affected file in");
    expect(prompt).toContain("docs/adr/");
    expect(prompt).toContain("bring the PRD in line with the corrected ADRs");
    expect(prompt).toContain("if they only concern the requirements, leave docs/adr/ untouched");
  });

  it("keeps the normal prd run away from the ADRs", () => {
    const prompt = prdPrompt(context());
    expect(prompt).not.toContain("bring the PRD in line with the corrected ADRs");
    expect(prompt).not.toContain("fix the affected file in");
    expect(prompt).toContain("This run writes the product requirements and nothing else.");
  });

  it("sends the prd run to the decision tickets' comments, not only to the ADRs", () => {
    const prompt = prdPrompt(context());
    // Only the biggest decisions become ADRs; the rest live in the comment that
    // closed their ticket. A PRD that reads only docs/adr/ re-opens them.
    expect(prompt).toContain("ALL of its decision tickets");
    expect(prompt).toContain("WITH their comments");
    expect(prompt).toContain("never list a decided");
  });

  it("tells a tasks rework to fix the issues that already exist", () => {
    expect(tasksPrompt(context({ isRework: true }), TASK_LABELS)).toContain(
      "only create what is missing",
    );
  });
});

describe("prompts: blocking question", () => {
  it("gives every kind the same way out, with the same marker", () => {
    for (const [kind, render] of RENDERERS) {
      const prompt = render(context());
      expect(prompt, kind).toContain("IF YOU CANNOT FINISH WITHOUT A DECISION ONLY A HUMAN CAN MAKE");
      expect(prompt, kind).toContain("gh issue comment 42 --repo acme/example");
      expect(prompt, kind).toContain(BLOCKED_RESULT_LINE);
    }
  });

  it("tells the agent not to guess its way past the question", () => {
    for (const [kind, render] of RENDERERS) {
      expect(render(context()), kind).toContain("do not guess");
    }
  });
});

describe("prompts: an empty run is a successful run", () => {
  it("lets the ADR run write nothing when no decision is worth recording", () => {
    const prompt = adrPrompt(context());
    expect(prompt).toContain("IF NOTHING MEETS THAT BAR, WRITE NOTHING");
    expect(prompt).toContain("adrs=0");
    expect(prompt).toContain("That is a successful run, not a failure");
    expect(prompt).toContain("a serious alternative was rejected");
  });

  it("tells the runs that commit that an empty result is allowed", () => {
    for (const render of [adrPrompt, prdPrompt, slicesPrompt, implementPrompt]) {
      expect(render(context())).toContain("nothing worth committing");
    }
  });

  it("lets a later run of the plan create the branch an empty run never made", () => {
    expect(prdPrompt(context())).toContain("If that branch does not exist yet, create it");
  });
});

describe("parseResultMarker and isBlockedResult", () => {
  it("reads the blocked status off the ordinary result line", () => {
    expect(isBlockedResult(parseResultMarker(`some output\n${BLOCKED_RESULT_LINE}`))).toBe(true);
    expect(isBlockedResult(parseResultMarker("ASEL_RESULT STATUS=Blocked"))).toBe(false);
    expect(isBlockedResult(parseResultMarker("ASEL_RESULT status=BLOCKED"))).toBe(true);
  });

  it("treats a finished run, and a run with no marker at all, as not blocked", () => {
    expect(isBlockedResult(parseResultMarker("ASEL_RESULT adrs=0 branch=asel/plan-42"))).toBe(
      false,
    );
    expect(isBlockedResult(parseResultMarker("no marker here"))).toBe(false);
  });

  it("still reads a zero count as a result, not as a missing one", () => {
    expect(parseResultMarker("ASEL_RESULT adrs=0 branch=asel/plan-42")).toEqual({
      adrs: "0",
      branch: "asel/plan-42",
    });
  });
});

describe("prompts: the three implementation phases", () => {
  it("keeps the red phase to tests, and says who decides they are red", () => {
    const prompt = implementRedPrompt(context({ role: "task" }), "pnpm test --run");
    expect(prompt).toContain("PHASE 1 OF 3: RED");
    expect(prompt).toContain("YOU WRITE TESTS, AND NOTHING ELSE");
    expect(prompt).toContain("test: ");
    expect(prompt).toContain("the orchestrator runs `pnpm test --run` itself");
    expect(prompt).toContain("REQUIRES it to fail");
  });

  it("tells the green phase the test guard exists and what the only way out is", () => {
    const prompt = implementGreenPrompt(context({ role: "task" }), GREEN_OPTIONS);
    expect(prompt).toContain("PHASE 2 OF 3: GREEN, ITERATION 1 OF 3");
    expect(prompt).toContain("YOU MUST NOT CHANGE ANY TEST FILE");
    expect(prompt).toContain("git diff --name-only");
    expect(prompt).toContain("**/*.test.*");
    expect(prompt).toContain("DO NOT FIX IT");
    expect(prompt).toContain(BLOCKED_RESULT_LINE);
    // No "try until it works": the iteration limit is stated as a fact.
    expect(prompt).toContain("3 iterations in total");
  });

  it("carries the failing output of the previous iteration into the next prompt", () => {
    const prompt = implementGreenPrompt(context(), {
      ...GREEN_OPTIONS,
      iteration: 2,
      failureOutput: "AssertionError: expected 1 to be 2",
    });
    expect(prompt).toContain("ITERATION 2 OF 3");
    expect(prompt).toContain("AssertionError: expected 1 to be 2");
  });

  it("names the full substrate in the review phase", () => {
    const prompt = implementReviewPrompt(context(), ["typecheck", "lint", "test"]);
    expect(prompt).toContain("PHASE 3 OF 3: REVIEW");
    expect(prompt).toContain("typecheck, lint, test");
    expect(prompt).toContain("A single red command stops the run");
    expect(prompt).toContain("you may not weaken or");
  });

  it("says so when the project declares nothing to run", () => {
    expect(implementReviewPrompt(context(), [])).toContain("declares no checks");
  });

  it("keeps the single phase fallback free of any phase talk", () => {
    const prompt = implementPrompt(context({ role: "task" }));
    expect(prompt).not.toContain("PHASE");
    expect(prompt).toContain("Run the project's own tests and linters");
  });

  it("warns a rework that the chain starts from the tests again", () => {
    expect(implementRedPrompt(context({ isRework: true }), "pnpm test")).toContain(
      "the run starts from the test phase again",
    );
  });
});

describe("prompts: slice marker labels", () => {
  it("tells the tasks run to create the slice label it needs", () => {
    const prompt = tasksPrompt(context(), TASK_LABELS);
    expect(prompt).toContain("gh label create");
    expect(prompt).toContain("--color c5def5");
  });
});

describe("prompts: context budget of a task run", () => {
  it("caps a slice at a quarter of the agent's context window", () => {
    const prompt = slicesPrompt(context());
    expect(prompt).toContain("quarter of");
    expect(prompt).toContain("50k tokens");
    expect(prompt).toContain("split it further");
  });

  it("tells the tasks run to split an oversized slice into several tasks", () => {
    const prompt = tasksPrompt(context(), TASK_LABELS);
    expect(prompt).toContain("quarter");
    expect(prompt).toContain("50k tokens");
    expect(prompt).toContain("SEVERAL tasks sharing the same ASEL_SLICE number");
    expect(prompt).toContain("issue-number order");
  });
});
