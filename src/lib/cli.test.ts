import { describe, expect, test, vi } from "vitest";
import { parseCliArgs, runCli } from "./cli";
import type { PullRequestReviewReport } from "./github";

const report: PullRequestReviewReport = {
  generatedAt: "2026-05-06T08:00:00.000Z",
  repository: {
    fullName: "owner/repo",
    defaultBranch: "main",
    htmlUrl: "https://github.com/owner/repo",
    stars: 1,
    forks: 1,
    openIssues: 0,
    pushedAt: "2026-05-06T08:00:00Z",
  },
  pullRequest: {
    number: 12,
    title: "Add review CLI",
    htmlUrl: "https://github.com/owner/repo/pull/12",
    state: "open",
    draft: false,
    author: "alice",
    body: "",
    baseRef: "main",
    headRef: "cli",
    headRepo: "alice/repo",
    headSha: "abc",
    createdAt: "2026-05-06T08:00:00Z",
    updatedAt: "2026-05-06T08:00:00Z",
    mergeable: true,
    mergeableState: "clean",
    additions: 12,
    deletions: 2,
    changedFiles: 1,
    labels: [],
  },
  checks: { state: "passing", total: 1, failing: 0, pending: 0 },
  reviews: [],
  commits: [],
  files: [
    {
      filename: "src/cli.ts",
      status: "added",
      additions: 12,
      deletions: 2,
      changes: 14,
      blobUrl: "https://github.com/owner/repo/blob/abc/src/cli.ts",
      rawUrl: "https://github.com/owner/repo/raw/abc/src/cli.ts",
      patch: "+ export function run() {}",
    },
  ],
};

describe("CLI helpers", () => {
  test("parses a baseline PR review command", () => {
    expect(
      parseCliArgs([
        "review",
        "owner/repo#12",
        "--provider",
        "rule-based",
        "--format",
        "json",
        "--policy",
        ".fork-drift-sentinel.yml",
      ]),
    ).toMatchObject({
      command: "review",
      pr: {
        owner: "owner",
        repo: "repo",
        number: 12,
      },
      provider: "rule-based",
      format: "json",
      policyPath: ".fork-drift-sentinel.yml",
    });
  });

  test("parses a multi-provider tribunal command", () => {
    expect(
      parseCliArgs([
        "review",
        "https://github.com/owner/repo/pull/12",
        "--tribunal",
        "openai-api:gpt-test,codex-cli",
      ]),
    ).toMatchObject({
      command: "review",
      tribunalProviders: [
        { provider: "openai-api", model: "gpt-test" },
        { provider: "codex-cli" },
      ],
    });
  });

  test("runs rule-based review and writes markdown by default", async () => {
    const stdout = vi.fn();
    const code = await runCli(["review", "owner/repo#12"], {
      env: {},
      stdout,
      stderr: vi.fn(),
      fetchPullRequestReviewReport: vi.fn(async () => report),
      readFile: vi.fn(),
    });

    expect(code).toBe(0);
    expect(stdout.mock.calls.join("\n")).toContain("## PR Review");
    expect(stdout.mock.calls.join("\n")).toContain("Provider: rule-based");
  });

  test("runs an injected agent provider with a policy file", async () => {
    const stdout = vi.fn();
    const runAgentReview = vi.fn(async () => ({
      provider: "openai-api" as const,
      model: "gpt-test",
      summary: "Agent review.",
      risk: "low" as const,
      findings: [],
      markdown: "agent markdown",
    }));

    const code = await runCli(
      [
        "review",
        "owner/repo#12",
        "--provider",
        "openai-api",
        "--model",
        "gpt-test",
        "--policy",
        ".fork-drift-sentinel.yml",
      ],
      {
        env: { GITHUB_TOKEN: "gh-token" },
        stdout,
        stderr: vi.fn(),
        fetchPullRequestReviewReport: vi.fn(async () => report),
        readFile: vi.fn(async () => "requiredChecks: passing"),
        runAgentReview,
      },
    );

    expect(code).toBe(0);
    expect(runAgentReview).toHaveBeenCalledOnce();
    expect(runAgentReview.mock.calls[0][0].prompt.user).toContain(
      "Required checks: passing",
    );
    expect(stdout).toHaveBeenCalledWith("agent markdown");
  });
});
