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
  RESULT_MARKER_PREFIX,
  slicesPrompt,
  tasksPrompt,
  wayfinderPrompt,
  type TaskPromptLabels,
} from "./prompts.js";
import {
  buildDockerOptions,
  COMPLETION_GRACE_SECONDS,
  COMPLETION_SIGNAL,
} from "./sandcastle.js";
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
  checks: [{ name: "test", command: "pnpm test --run" }],
  testFilePatterns: ["**/*.test.*"],
  sourceFile: "projects/example.yml",
};

const TASK_LABELS: TaskPromptLabels = {
  taskLabel: "asel:task",
  sliceLabelPrefix: "asel:slice-",
  sliceLabelColor: "c5def5",
};

function context(): RunContext {
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
  };
}

describe("buildDockerOptions", () => {
  it("passes the host uid and gid through to the provider", () => {
    expect(
      buildDockerOptions({
        imageName: "asel-agent-runtime:latest",
        env: { GH_TOKEN: "x" },
        containerUser: { uid: 501, gid: 20 },
      }),
    ).toEqual({
      imageName: "asel-agent-runtime:latest",
      env: { GH_TOKEN: "x" },
      containerUid: 501,
      containerGid: 20,
    });
  });

  // Absent, not undefined: the provider reads `options?.containerUid ??
  // process.getuid()`, so an explicit undefined and a missing key mean the same
  // thing to it, but only the missing key says so in a snapshot of the options.
  it("omits both fields when the host values never arrived", () => {
    const options = buildDockerOptions({
      imageName: "asel-agent-runtime:latest",
      env: {},
    });
    expect(options).toEqual({ imageName: "asel-agent-runtime:latest", env: {} });
    expect("containerUid" in options).toBe(false);
    expect("containerGid" in options).toBe(false);
  });

  it("never passes one half of the pair", () => {
    const options = buildDockerOptions({
      imageName: "asel-agent-runtime:latest",
      env: {},
      containerUser: undefined,
    });
    expect("containerUid" in options).toBe(false);
    expect("containerGid" in options).toBe(false);
  });
});

describe("completion signal", () => {
  const prompts: Array<[string, string]> = [
    ["wayfinder", wayfinderPrompt(context())],
    ["adr", adrPrompt(context())],
    ["prd", prdPrompt(context())],
    ["slices", slicesPrompt(context())],
    ["tasks", tasksPrompt(context(), TASK_LABELS)],
    ["implement", implementPrompt(context())],
    ["red", implementRedPrompt(context(), "pnpm test --run")],
    [
      "green",
      implementGreenPrompt(context(), {
        testCommand: "pnpm test --run",
        iteration: 1,
        maxIterations: 3,
        failureOutput: "1 failing",
        testFilePatterns: ["**/*.test.*"],
      }),
    ],
    ["review", implementReviewPrompt(context(), ["test"])],
  ];

  it("is the marker prefix, so no prompt needs a second instruction", () => {
    expect(COMPLETION_SIGNAL).toBe(RESULT_MARKER_PREFIX);
  });

  it.each(prompts)("the %s prompt already asks for a line carrying it", (_name, prompt) => {
    expect(prompt).toContain(COMPLETION_SIGNAL);
  });

  // The package matches with `includes` against the agent's final output and
  // this adapter parses the same string. Both have to fire on the same text, or
  // the loop would stop on something the adapter cannot read.
  it("fires on exactly the output the adapter can parse", () => {
    const output = ["Committed and pushed.", "", "ASEL_RESULT adrs=2 branch=asel/plan-42"].join(
      "\n",
    );
    expect(output.includes(COMPLETION_SIGNAL)).toBe(true);
    expect(parseResultMarker(output)).toEqual({ adrs: "2", branch: "asel/plan-42" });
  });

  it("fires on a blocked run as well, which is the whole point of one marker", () => {
    expect(BLOCKED_RESULT_LINE.includes(COMPLETION_SIGNAL)).toBe(true);
    expect(isBlockedResult(parseResultMarker(BLOCKED_RESULT_LINE))).toBe(true);
  });

  it("does not fire on output without a marker, which is the old behaviour", () => {
    const output = "I finished the work and pushed the branch.";
    expect(output.includes(COMPLETION_SIGNAL)).toBe(false);
    expect(parseResultMarker(output)).toEqual({});
  });

  // A match in the stream (not in the final result) only shortens the idle
  // budget to this window, so it has to be wider than the 60 s package default:
  // a quiet test suite would otherwise force-complete the iteration mid work.
  it("keeps a grace window wider than the package default", () => {
    expect(COMPLETION_GRACE_SECONDS).toBeGreaterThan(60);
  });
});
