/**
 * Configuration loading and validation.
 *
 * Two layers:
 * - global config (asel.yml): polling, concurrency, label prefix, notifications, paths
 * - project registry (projects/*.yml): one file per project in the factory
 *
 * Parsing is exposed as pure functions over YAML text so it can be unit tested
 * without touching the filesystem.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { DEFAULT_GATES, type Gates } from "./machine.js";
import {
  CHECK_NAME_PATTERN,
  DEFAULT_TEST_FILE_PATTERNS,
  type CheckCommand,
} from "./runner/checks.js";

export const globalConfigSchema = z.object({
  poll_interval_seconds: z.number().int().positive().default(60),
  label_prefix: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/i, "label_prefix must be alphanumeric with dashes"),
  concurrency: z
    .object({
      global: z.number().int().positive().default(2),
      per_project_default: z.number().int().positive().default(1),
    })
    .default({ global: 2, per_project_default: 1 }),
  notifications: z
    .object({
      woopy: z
        .object({
          enabled: z.boolean().default(false),
          url_env: z.string().min(1).default("WOOPY_INBOUND_URL"),
        })
        .default({ enabled: false, url_env: "WOOPY_INBOUND_URL" }),
    })
    .default({ woopy: { enabled: false, url_env: "WOOPY_INBOUND_URL" } }),
  paths: z
    .object({
      repos: z.string().min(1).default("/data/repos"),
      state: z.string().min(1).default("/data/state"),
    })
    .default({ repos: "/data/repos", state: "/data/state" }),
});

export type GlobalConfig = z.infer<typeof globalConfigSchema>;

/**
 * Human gates a project can switch off. Absent means "on", so a registry file
 * written before the switch existed keeps the full pipeline it was set up with.
 */
export const gatesSchema = z
  .object({
    plan_approval: z.boolean().default(DEFAULT_GATES.planApproval),
  })
  .default({ plan_approval: DEFAULT_GATES.planApproval });

/**
 * Substrate commands the ORCHESTRATOR runs in the task container, as an ordered
 * mapping of name to shell command:
 *
 *   checks:
 *     typecheck: pnpm tsc --noEmit
 *     lint: pnpm lint
 *     test: pnpm test --run
 *
 * `test` is the one name with a meaning: the red and the green phase of an
 * implementation run are gated on it. Everything else runs in the full
 * substrate at the end of the review phase, in the order declared here. A
 * project that declares nothing gets no gates, which is a legitimate setup for
 * a repository that has no test runner yet.
 */
export const checksSchema = z
  .record(
    z
      .string()
      .regex(
        CHECK_NAME_PATTERN,
        "check name must start with a letter and hold only letters, digits, dots, dashes or underscores",
      ),
    z.string().trim().min(1, "check command must not be empty"),
  )
  .default({});

/**
 * Globs the green phase of an implementation run may not touch. An explicit
 * empty list is rejected rather than accepted as "no guard": switching the one
 * mechanism that stops an agent from rewriting its own tests has to be a
 * deliberate, visible act, not a stray empty array.
 */
export const testFilePatternsSchema = z
  .array(z.string().min(1))
  .min(1, "test_file_patterns must name at least one pattern")
  .default([...DEFAULT_TEST_FILE_PATTERNS]);

export const projectFileSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i, "project name must be a slug"),
  repo: z.string().min(3),
  image: z.string().min(1).default("asel-agent-runtime:latest"),
  concurrency: z.number().int().positive().optional(),
  env: z.array(z.string().min(1)).default([]),
  gates: gatesSchema,
  checks: checksSchema,
  test_file_patterns: testFilePatternsSchema,
});

export type ProjectFile = z.infer<typeof projectFileSchema>;

/** A project entry after validation, with the repo reference split out. */
export interface ProjectConfig {
  name: string;
  /** "owner/name" as used by the GitHub API. */
  fullName: string;
  owner: string;
  repoName: string;
  image: string;
  concurrency: number;
  env: string[];
  /** Human gates this project keeps, in the shape the state machine reads. */
  gates: Gates;
  /**
   * Substrate commands in declared order, `test` first class. The orchestrator
   * runs them itself in the task container; see runner/checks.ts.
   */
  checks: CheckCommand[];
  /** Globs the green phase of an implementation run may not touch. */
  testFilePatterns: string[];
  /** Source file, useful in error messages. */
  sourceFile: string;
}

export interface AselConfig {
  global: GlobalConfig;
  projects: ProjectConfig[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function formatZodError(error: z.ZodError, source: string): string {
  const details = error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  return `invalid config in ${source}: ${details}`;
}

/**
 * Normalizes a repo reference like "github.com/Owner/name",
 * "https://github.com/Owner/name.git" or "Owner/name" into "Owner/name".
 */
export function parseRepoRef(repo: string): { owner: string; repoName: string; fullName: string } {
  let value = repo.trim();
  value = value.replace(/^git@github\.com:/i, "");
  value = value.replace(/^[a-z]+:\/\//i, "");
  value = value.replace(/^(www\.)?github\.com\//i, "");
  value = value.replace(/\.git$/i, "");
  value = value.replace(/\/+$/, "");

  const parts = value.split("/").filter((part) => part.length > 0);
  if (parts.length !== 2) {
    throw new ConfigError(`cannot parse repo reference "${repo}", expected github.com/owner/name`);
  }
  const owner = parts[0] as string;
  const repoName = parts[1] as string;
  return { owner, repoName, fullName: `${owner}/${repoName}` };
}

export function parseGlobalConfig(yamlText: string, source = "asel.yml"): GlobalConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    throw new ConfigError(`cannot parse YAML in ${source}: ${(error as Error).message}`);
  }
  const result = globalConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new ConfigError(formatZodError(result.error, source));
  }
  return result.data;
}

export function parseProjectConfig(
  yamlText: string,
  source: string,
  defaultConcurrency: number,
): ProjectConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    throw new ConfigError(`cannot parse YAML in ${source}: ${(error as Error).message}`);
  }
  const result = projectFileSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new ConfigError(formatZodError(result.error, source));
  }
  const parsed = result.data;
  const ref = parseRepoRef(parsed.repo);
  return {
    name: parsed.name,
    fullName: ref.fullName,
    owner: ref.owner,
    repoName: ref.repoName,
    image: parsed.image,
    concurrency: parsed.concurrency ?? defaultConcurrency,
    env: parsed.env,
    gates: { planApproval: parsed.gates.plan_approval },
    checks: toCheckCommands(parsed.checks),
    testFilePatterns: parsed.test_file_patterns,
    sourceFile: source,
  };
}

/**
 * YAML mapping to an ordered list. The order of the mapping IS the execution
 * order, and it survives the trip through a plain object because check names
 * are required to start with a letter (see CHECK_NAME_PATTERN).
 */
function toCheckCommands(checks: Record<string, string>): CheckCommand[] {
  return Object.entries(checks).map(([name, command]) => ({ name, command }));
}

/** Rejects duplicated project names or repositories in the registry. */
export function assertUniqueProjects(projects: ProjectConfig[]): void {
  const seenNames = new Set<string>();
  const seenRepos = new Set<string>();
  for (const project of projects) {
    const nameKey = project.name.toLowerCase();
    if (seenNames.has(nameKey)) {
      throw new ConfigError(`duplicate project name "${project.name}" (${project.sourceFile})`);
    }
    seenNames.add(nameKey);

    const repoKey = project.fullName.toLowerCase();
    if (seenRepos.has(repoKey)) {
      throw new ConfigError(`duplicate project repo "${project.fullName}" (${project.sourceFile})`);
    }
    seenRepos.add(repoKey);
  }
}

/**
 * The registry template committed to the repo. It is documentation rather than
 * a project: it points at a placeholder repository, so loading it would put a
 * repo nobody can reach into the registry and buy one failed poll per cycle
 * forever. Adding a project means COPYING it to projects/<name>.yml.
 */
export const REGISTRY_TEMPLATE_FILE = "example.yml";

/**
 * The registry files of a projects/ directory, in load order: YAML only, the
 * template skipped, sorted so that the registry comes out the same on every
 * boot. Pure on purpose, so the rule is testable without a filesystem.
 */
export function registryFiles(fileNames: string[]): string[] {
  return fileNames
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .filter((file) => file !== REGISTRY_TEMPLATE_FILE)
    .sort();
}

/**
 * Loads asel.yml plus every projects/*.yml from a config directory, except the
 * committed template (see registryFiles). In the container this is /app/config,
 * locally it is the repo root.
 */
export function loadConfig(configDir: string): AselConfig {
  const globalPath = join(configDir, "asel.yml");
  if (!existsSync(globalPath)) {
    throw new ConfigError(`missing global config at ${globalPath}`);
  }
  const global = parseGlobalConfig(readFileSync(globalPath, "utf8"), globalPath);

  const projectsDir = join(configDir, "projects");
  const projects: ProjectConfig[] = [];
  if (existsSync(projectsDir)) {
    const files = registryFiles(readdirSync(projectsDir));
    for (const file of files) {
      const path = join(projectsDir, file);
      projects.push(
        parseProjectConfig(readFileSync(path, "utf8"), path, global.concurrency.per_project_default),
      );
    }
  }
  assertUniqueProjects(projects);

  return { global, projects };
}
