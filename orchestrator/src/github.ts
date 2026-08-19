/**
 * Minimal GitHub REST client built on fetch. No SDK on purpose: the
 * orchestrator needs a handful of endpoints and nothing else.
 */
import type { RepoLabel } from "./labels.js";

const API_VERSION = "2022-11-28";

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  htmlUrl: string;
  isPullRequest: boolean;
}

export interface GitHubUser {
  login: string;
}

export class GitHubError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.url = url;
  }
}

interface RawLabel {
  name: string;
}

interface RawRepoLabel {
  name: string;
  color: string | null;
  description: string | null;
}

interface RawIssue {
  number: number;
  title: string | null;
  body: string | null;
  labels: Array<RawLabel | string>;
  html_url: string;
  pull_request?: unknown;
}

function normalizeIssue(raw: RawIssue): GitHubIssue {
  return {
    number: raw.number,
    title: raw.title ?? "",
    body: raw.body ?? "",
    labels: raw.labels.map((label) => (typeof label === "string" ? label : label.name)),
    htmlUrl: raw.html_url,
    isPullRequest: raw.pull_request !== undefined,
  };
}

export class GitHubClient {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(token: string, baseUrl = "https://api.github.com") {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": API_VERSION,
        "user-agent": "asel-orchestrator",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.headers as Record<string, string> | undefined),
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new GitHubError(
        `GitHub ${init.method ?? "GET"} ${url} failed with ${response.status}: ${text.slice(0, 400)}`,
        response.status,
        url,
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  /** Token check used by `asel.sh doctor` and on orchestrator startup. */
  async whoami(): Promise<GitHubUser> {
    return this.request<GitHubUser>("/user");
  }

  /** Confirms the repository exists and the token can see it. */
  async getRepo(fullName: string): Promise<{ full_name: string; default_branch: string }> {
    return this.request<{ full_name: string; default_branch: string }>(`/repos/${fullName}`);
  }

  /**
   * Lists open issues (pull requests filtered out). GitHub's `labels` query
   * parameter is an AND filter, so filtering by our label prefix happens
   * client side instead.
   */
  async listOpenIssues(fullName: string, maxPages = 3): Promise<GitHubIssue[]> {
    const issues: GitHubIssue[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = await this.request<RawIssue[]>(
        `/repos/${fullName}/issues?state=open&per_page=100&page=${page}`,
      );
      for (const raw of batch) {
        const issue = normalizeIssue(raw);
        if (!issue.isPullRequest) {
          issues.push(issue);
        }
      }
      if (batch.length < 100) {
        break;
      }
    }
    return issues;
  }

  /**
   * One issue, fresh. The scheduler rechecks an issue right before it starts a
   * run: the poll's issue list can be seconds old, and a run finishing inside
   * that window rewrites the labels the decision was made from.
   */
  async getIssue(fullName: string, issueNumber: number): Promise<GitHubIssue> {
    const raw = await this.request<RawIssue>(`/repos/${fullName}/issues/${issueNumber}`);
    return normalizeIssue(raw);
  }

  async addLabels(fullName: string, issueNumber: number, labels: string[]): Promise<void> {
    if (labels.length === 0) {
      return;
    }
    await this.request<unknown>(`/repos/${fullName}/issues/${issueNumber}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels }),
    });
  }

  /** Removing a label the issue does not carry is treated as success. */
  async removeLabel(fullName: string, issueNumber: number, label: string): Promise<void> {
    try {
      await this.request<unknown>(
        `/repos/${fullName}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
        { method: "DELETE" },
      );
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  /**
   * Replaces the issue body. Used by the status block, which is why the caller
   * must send the WHOLE body: GitHub has no partial update for it.
   */
  async updateIssueBody(fullName: string, issueNumber: number, body: string): Promise<void> {
    await this.request<unknown>(`/repos/${fullName}/issues/${issueNumber}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    });
  }

  /** Every label of a repository, ours and everybody else's. */
  async listLabels(fullName: string, maxPages = 5): Promise<RepoLabel[]> {
    const labels: RepoLabel[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = await this.request<RawRepoLabel[]>(
        `/repos/${fullName}/labels?per_page=100&page=${page}`,
      );
      for (const raw of batch) {
        labels.push({
          name: raw.name,
          color: raw.color ?? "",
          description: raw.description ?? "",
        });
      }
      if (batch.length < 100) {
        break;
      }
    }
    return labels;
  }

  async createLabel(
    fullName: string,
    label: { name: string; color: string; description: string },
  ): Promise<void> {
    await this.request<unknown>(`/repos/${fullName}/labels`, {
      method: "POST",
      body: JSON.stringify(label),
    });
  }

  async updateLabel(
    fullName: string,
    name: string,
    patch: { color?: string; description?: string },
  ): Promise<void> {
    await this.request<unknown>(`/repos/${fullName}/labels/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  async createComment(fullName: string, issueNumber: number, body: string): Promise<void> {
    await this.request<unknown>(`/repos/${fullName}/issues/${issueNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  async listComments(
    fullName: string,
    issueNumber: number,
  ): Promise<Array<{ id: number; body: string; user: string; createdAt: string }>> {
    const raw = await this.request<
      Array<{ id: number; body: string | null; user: { login: string } | null; created_at: string }>
    >(`/repos/${fullName}/issues/${issueNumber}/comments?per_page=100`);
    return raw.map((comment) => ({
      id: comment.id,
      body: comment.body ?? "",
      user: comment.user?.login ?? "unknown",
      createdAt: comment.created_at,
    }));
  }
}
