import { describe, expect, test, vi } from "vitest";
import { parseCliArgs, runCli } from "./cli";
import type { PullRequestReviewReport } from "./github";
import type { LocalAnalysisReport } from "./local-analyzer";

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

const localReport: LocalAnalysisReport = {
  generatedAt: "2026-05-06T08:00:00.000Z",
  upstream: {
    repo: "owner/upstream",
    branch: "main",
    gitRef: "refs/heads/main",
  },
  fork: {
    repo: "me/fork",
    branch: "feature/demo",
    gitRef: "refs/remotes/fork/feature/demo",
  },
  compare: {
    aheadBy: 3,
    behindBy: 12,
  },
  mergeTree: {
    clean: false,
    tree: "",
    conflictFiles: ["src/runtime.ts"],
    messages: ["Auto-merging src/runtime.ts"],
  },
  cherry: {
    covered: [{ sha: "a".repeat(40), subject: "fix: upstream covered" }],
    unique: [{ sha: "b".repeat(40), subject: "feat: local only" }],
  },
  rangeDiff: {
    summary: {
      added: 1,
      removed: 0,
      changed: 2,
    },
    lines: ["1:  abcdef0 ! 1:  1234567 feat: local only"],
  },
  rebaseSimulation: {
    clean: false,
    conflictFiles: ["src/runtime.ts"],
    statusLines: ["UU src/runtime.ts"],
    logLines: ["CONFLICT (content): Merge conflict in src/runtime.ts"],
  },
  cache: {
    label: ".cache/repos/owner-upstream.git",
  },
  runbooks: {
    inspect: ["git fetch --prune upstream main"],
    prepare: ["git branch backup/fork-drift-before-rebase"],
    execute: ["git rebase upstream/main"],
  },
  runbook: ["git rebase upstream/main"],
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

  test("parses a downstream drift command with an AI CLI provider", () => {
    expect(
      parseCliArgs([
        "drift",
        "owner/upstream",
        "me/fork",
        "--upstream-branch",
        "main",
        "--fork-branch",
        "feature/demo",
        "--provider",
        "codex-cli",
        "--model",
        "gpt-test",
        "--format",
        "json",
      ]),
    ).toMatchObject({
      command: "drift",
      upstream: "owner/upstream",
      fork: "me/fork",
      upstreamBranch: "main",
      forkBranch: "feature/demo",
      provider: "codex-cli",
      model: "gpt-test",
      format: "json",
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

  test("runs downstream drift analysis through an injected AI CLI provider", async () => {
    const stdout = vi.fn();
    const runAgentReview = vi.fn(async () => ({
      provider: "codex-cli" as const,
      model: "codex",
      summary: "Downstream drift needs conflict handling.",
      risk: "high" as const,
      findings: [
        {
          severity: "high" as const,
          category: "rebase",
          title: "Rebase conflicts need manual review",
          detail: "src/runtime.ts conflicts in the simulated rebase.",
          recommendation: "Resolve the conflict before force-with-lease push.",
          file: "src/runtime.ts",
          confidence: "high" as const,
          evidence: [
            {
              kind: "git" as const,
              label: "rebase simulation",
              detail: "UU src/runtime.ts",
              file: "src/runtime.ts",
            },
          ],
        },
      ],
      markdown: "provider markdown",
    }));

    const code = await runCli(
      [
        "drift",
        "owner/upstream",
        "me/fork",
        "--fork-branch",
        "feature/demo",
        "--provider",
        "codex-cli",
      ],
      {
        env: {},
        stdout,
        stderr: vi.fn(),
        analyzeLocalDrift: vi.fn(async () => localReport),
        runAgentReview,
      },
    );

    expect(code).toBe(0);
    expect(runAgentReview).toHaveBeenCalledOnce();
    expect(runAgentReview.mock.calls[0][0].prompt.system).toContain(
      "long-lived downstream fork",
    );
    expect(runAgentReview.mock.calls[0][0].prompt.user).toContain(
      "owner/upstream",
    );
    expect(runAgentReview.mock.calls[0][0].prompt.user).toContain("me/fork");
    expect(runAgentReview.mock.calls[0][0].prompt.user).toContain(
      "Rebase simulation",
    );
    expect(stdout.mock.calls.join("\n")).toContain("## Fork Drift Review");
  });
});
