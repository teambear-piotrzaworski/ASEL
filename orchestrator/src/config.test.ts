import { describe, expect, it } from "vitest";
import {
  ConfigError,
  REGISTRY_TEMPLATE_FILE,
  assertUniqueProjects,
  parseGlobalConfig,
  parseProjectConfig,
  parseRepoRef,
  registryFiles,
  type ProjectConfig,
} from "./config.js";

const GLOBAL_YAML = `
poll_interval_seconds: 60
label_prefix: asel
concurrency:
  global: 2
  per_project_default: 1
notifications:
  woopy:
    enabled: false
    url_env: WOOPY_INBOUND_URL
paths:
  repos: /data/repos
  state: /data/state
`;

describe("parseGlobalConfig", () => {
  it("parses the shipped asel.yml shape", () => {
    const config = parseGlobalConfig(GLOBAL_YAML);
    expect(config.poll_interval_seconds).toBe(60);
    expect(config.label_prefix).toBe("asel");
    expect(config.concurrency).toEqual({ global: 2, per_project_default: 1 });
    expect(config.notifications.woopy.enabled).toBe(false);
    expect(config.notifications.woopy.url_env).toBe("WOOPY_INBOUND_URL");
    expect(config.paths).toEqual({ repos: "/data/repos", state: "/data/state" });
  });

  it("applies defaults for omitted sections", () => {
    const config = parseGlobalConfig("label_prefix: asel\n");
    expect(config.poll_interval_seconds).toBe(60);
    expect(config.concurrency.global).toBe(2);
    expect(config.paths.state).toBe("/data/state");
  });

  it("rejects a missing label prefix", () => {
    expect(() => parseGlobalConfig("poll_interval_seconds: 30\n")).toThrow(ConfigError);
  });

  it("rejects a non positive poll interval", () => {
    expect(() => parseGlobalConfig("label_prefix: asel\npoll_interval_seconds: 0\n")).toThrow(
      ConfigError,
    );
  });

  it("rejects broken YAML", () => {
    expect(() => parseGlobalConfig("label_prefix: [unclosed\n")).toThrow(ConfigError);
  });
});

describe("registryFiles", () => {
  it("keeps the YAML files of the registry, sorted", () => {
    expect(registryFiles(["zeta.yml", "alpha.yaml", "beta.yml"])).toEqual([
      "alpha.yaml",
      "beta.yml",
      "zeta.yml",
    ]);
  });

  it("skips the committed template, so it never becomes a project", () => {
    expect(registryFiles([REGISTRY_TEMPLATE_FILE])).toEqual([]);
    expect(registryFiles(["example.yml", "shop.yml"])).toEqual(["shop.yml"]);
  });

  it("skips the template by its exact name only", () => {
    expect(registryFiles(["example-api.yml", "my-example.yml", "example.yaml"])).toEqual([
      "example-api.yml",
      "example.yaml",
      "my-example.yml",
    ]);
  });

  it("ignores everything that is not YAML", () => {
    expect(registryFiles(["README.md", ".gitkeep", "shop.yml"])).toEqual(["shop.yml"]);
  });
});

describe("parseRepoRef", () => {
  it("accepts the registry form", () => {
    expect(parseRepoRef("github.com/acme/example")).toEqual({
      owner: "acme",
      repoName: "example",
      fullName: "acme/example",
    });
  });

  it("accepts https, ssh and bare owner/name forms", () => {
    expect(parseRepoRef("https://github.com/acme/example.git").fullName).toBe(
      "acme/example",
    );
    expect(parseRepoRef("git@github.com:acme/example.git").fullName).toBe("acme/example");
    expect(parseRepoRef("acme/example").fullName).toBe("acme/example");
  });

  it("rejects references that are not owner/name", () => {
    expect(() => parseRepoRef("github.com/acme")).toThrow(ConfigError);
    expect(() => parseRepoRef("github.com/a/b/c")).toThrow(ConfigError);
  });
});

describe("parseProjectConfig", () => {
  const yaml = `
name: example
repo: github.com/acme/example
image: asel-agent-runtime:latest
concurrency: 1
env: []
`;

  it("parses the shipped projects/example.yml shape", () => {
    const project = parseProjectConfig(yaml, "projects/example.yml", 1);
    expect(project).toMatchObject({
      name: "example",
      fullName: "acme/example",
      owner: "acme",
      repoName: "example",
      image: "asel-agent-runtime:latest",
      concurrency: 1,
      env: [],
    });
  });

  it("falls back to the global per project concurrency default", () => {
    const project = parseProjectConfig("name: x\nrepo: github.com/o/r\n", "x.yml", 3);
    expect(project.concurrency).toBe(3);
    expect(project.image).toBe("asel-agent-runtime:latest");
  });

  it("keeps every gate on when the file says nothing about them", () => {
    const project = parseProjectConfig("name: x\nrepo: github.com/o/r\n", "x.yml", 1);
    expect(project.gates).toEqual({ planApproval: true });
  });

  it("reads a gate switched off", () => {
    const project = parseProjectConfig(
      "name: x\nrepo: github.com/o/r\ngates:\n  plan_approval: false\n",
      "x.yml",
      1,
    );
    expect(project.gates.planApproval).toBe(false);
  });

  it("accepts a gates block that only says what it means to say", () => {
    const project = parseProjectConfig(
      "name: x\nrepo: github.com/o/r\ngates: {}\n",
      "x.yml",
      1,
    );
    expect(project.gates.planApproval).toBe(true);
  });

  it("rejects a gate that is not a boolean", () => {
    expect(() =>
      parseProjectConfig(
        "name: x\nrepo: github.com/o/r\ngates:\n  plan_approval: maybe\n",
        "x.yml",
        1,
      ),
    ).toThrow(ConfigError);
  });

  it("reads the substrate commands in the order they are declared", () => {
    const project = parseProjectConfig(
      [
        "name: x",
        "repo: github.com/o/r",
        "checks:",
        "  typecheck: pnpm tsc --noEmit",
        "  lint: pnpm lint",
        "  test: pnpm test --run",
      ].join("\n"),
      "x.yml",
      1,
    );
    expect(project.checks).toEqual([
      { name: "typecheck", command: "pnpm tsc --noEmit" },
      { name: "lint", command: "pnpm lint" },
      { name: "test", command: "pnpm test --run" },
    ]);
  });

  it("accepts a project that declares no checks at all", () => {
    const project = parseProjectConfig("name: x\nrepo: github.com/o/r\n", "x.yml", 1);
    expect(project.checks).toEqual([]);
  });

  it("rejects a check name that could reorder the map", () => {
    expect(() =>
      parseProjectConfig("name: x\nrepo: github.com/o/r\nchecks:\n  1: pnpm test\n", "x.yml", 1),
    ).toThrow(ConfigError);
  });

  it("rejects an empty check command", () => {
    expect(() =>
      parseProjectConfig(`name: x\nrepo: github.com/o/r\nchecks:\n  test: "  "\n`, "x.yml", 1),
    ).toThrow(ConfigError);
  });

  it("ships default test file patterns and lets a project replace them", () => {
    const shipped = parseProjectConfig("name: x\nrepo: github.com/o/r\n", "x.yml", 1);
    expect(shipped.testFilePatterns).toContain("**/*.test.*");
    expect(shipped.testFilePatterns).toContain("**/__tests__/**");

    const custom = parseProjectConfig(
      "name: x\nrepo: github.com/o/r\ntest_file_patterns:\n  - spec/**\n",
      "x.yml",
      1,
    );
    expect(custom.testFilePatterns).toEqual(["spec/**"]);
  });

  it("rejects an empty pattern list, because that would switch the guard off", () => {
    expect(() =>
      parseProjectConfig("name: x\nrepo: github.com/o/r\ntest_file_patterns: []\n", "x.yml", 1),
    ).toThrow(ConfigError);
  });

  it("keeps the declared env passthrough list", () => {
    const project = parseProjectConfig(
      "name: x\nrepo: github.com/o/r\nenv:\n  - DATABASE_URL\n",
      "x.yml",
      1,
    );
    expect(project.env).toEqual(["DATABASE_URL"]);
  });

  it("rejects a project without a repo", () => {
    expect(() => parseProjectConfig("name: x\n", "x.yml", 1)).toThrow(ConfigError);
  });
});

describe("assertUniqueProjects", () => {
  const base: ProjectConfig = {
    name: "example",
    fullName: "acme/example",
    owner: "acme",
    repoName: "example",
    image: "asel-agent-runtime:latest",
    concurrency: 1,
    env: [],
    gates: { planApproval: true },
    checks: [],
    testFilePatterns: ["**/*.test.*"],
    sourceFile: "projects/example.yml",
  };

  it("accepts a registry with distinct projects", () => {
    expect(() =>
      assertUniqueProjects([base, { ...base, name: "other", fullName: "acme/other" }]),
    ).not.toThrow();
  });

  it("rejects duplicate names", () => {
    expect(() => assertUniqueProjects([base, { ...base, fullName: "acme/other" }])).toThrow(
      ConfigError,
    );
  });

  it("rejects duplicate repositories", () => {
    expect(() => assertUniqueProjects([base, { ...base, name: "other" }])).toThrow(ConfigError);
  });
});
