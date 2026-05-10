import { describe, expect, test } from "vitest";
import {
  buildReviewPrompt,
  buildRuleBasedReview,
  formatReviewMarkdown,
  parseProviderReviewJson,
  parsePullRequestRef,
} from "./pr-review";
import type { PullRequestReviewReport } from "./github";
import { DEFAULT_REVIEW_POLICY } from "./review-policy";

const report: PullRequestReviewReport = {
  generatedAt: "2026-05-06T08:00:00.000Z",
  repository: {
    fullName: "owner/repo",
    defaultBranch: "main",
    htmlUrl: "https://github.com/owner/repo",
    stars: 10,
    forks: 2,
    openIssues: 3,
    pushedAt: "2026-05-05T10:00:00Z",
  },
  pullRequest: {
    number: 42,
    title: "Add payment callback",
    htmlUrl: "https://github.com/owner/repo/pull/42",
    state: "open",
    draft: false,
    author: "alice",
    body: "Adds the callback route.",
    baseRef: "main",
    headRef: "feature/payment-callback",
    headRepo: "alice/repo",
    headSha: "abc123",
    createdAt: "2026-05-04T10:00:00Z",
    updatedAt: "2026-05-06T08:00:00Z",
    mergeable: true,
    mergeableState: "clean",
    additions: 840,
    deletions: 260,
    changedFiles: 4,
    labels: ["backend"],
  },
  checks: {
    state: "failing",
    total: 4,
    failing: 1,
    pending: 0,
  },
  reviews: [
    {
      user: "maintainer",
      state: "COMMENTED",
      submittedAt: "2026-05-05T12:00:00Z",
    },
  ],
  commits: [
    {
      sha: "abc123",
      subject: "feat: add payment callback",
      author: "alice",
      date: "2026-05-05T08:00:00Z",
      htmlUrl: "https://github.com/owner/repo/commit/abc123",
      prNumbers: [],
    },
  ],
  files: [
    {
      filename: "src/app/api/payment/callback/route.ts",
      status: "added",
      additions: 120,
      deletions: 0,
      changes: 120,
      blobUrl: "https://github.com/owner/repo/blob/abc/src/app/api/payment/callback/route.ts",
      rawUrl: "https://github.com/owner/repo/raw/abc/src/app/api/payment/callback/route.ts",
      patch: "+ const token = process.env.PAYMENT_SECRET;\n+ await verifySignature(token);",
    },
    {
      filename: "package-lock.json",
      status: "modified",
      additions: 700,
      deletions: 240,
      changes: 940,
      blobUrl: "https://github.com/owner/repo/blob/abc/package-lock.json",
      rawUrl: "https://github.com/owner/repo/raw/abc/package-lock.json",
      patch: "@@ dependency changes @@",
    },
    {
      filename: ".github/workflows/release.yml",
      status: "modified",
      additions: 20,
      deletions: 20,
      changes: 40,
      blobUrl: "https://github.com/owner/repo/blob/abc/.github/workflows/release.yml",
      rawUrl: "https://github.com/owner/repo/raw/abc/.github/workflows/release.yml",
      patch: "+ pull_request_target:",
    },
    {
      filename: "README.md",
      status: "modified",
      additions: 0,
      deletions: 0,
      changes: 0,
      blobUrl: "https://github.com/owner/repo/blob/abc/README.md",
      rawUrl: "https://github.com/owner/repo/raw/abc/README.md",
    },
  ],
};

describe("PR review helpers", () => {
  test("parses GitHub pull request references", () => {
    expect(parsePullRequestRef("owner/repo#42")).toEqual({
      owner: "owner",
      repo: "repo",
      number: 42,
      fullName: "owner/repo",
    });
    expect(parsePullRequestRef("https://github.com/owner/repo/pull/42")).toEqual({
      owner: "owner",
      repo: "repo",
      number: 42,
      fullName: "owner/repo",
    });
    expect(() => parsePullRequestRef("owner/repo")).toThrow(
      "Pull request reference",
    );
  });

  test("builds deterministic findings for risky PR signals", () => {
    const result = buildRuleBasedReview(report, DEFAULT_REVIEW_POLICY);

    expect(result.risk).toBe("critical");
    expect(result.summary).toContain("#42");
    expect(result.findings.map((finding) => finding.title)).toContain(
      "Failing checks block merge confidence",
    );
    expect(result.findings.map((finding) => finding.title)).toContain(
      "Source changes have no matching tests",
    );
    expect(result.findings.map((finding) => finding.title)).toContain(
      "Workflow changes require maintainer review",
    );
    expect(result.findings.map((finding) => finding.title)).toContain(
      "Security-sensitive code path changed",
    );
    expect(result.findings[0].confidence).toBeDefined();
    expect(result.findings[0].evidence.length).toBeGreaterThan(0);
  });

  test("flags stacked PR and merge queue state signals", () => {
    const stackedReport: PullRequestReviewReport = {
      ...report,
      pullRequest: {
        ...report.pullRequest,
        baseRef: "feature/base-pr",
        mergeableState: "blocked",
      },
      repository: {
        ...report.repository,
        defaultBranch: "main",
      },
    };

    const result = buildRuleBasedReview(stackedReport, DEFAULT_REVIEW_POLICY);

    expect(result.findings.map((finding) => finding.title)).toContain(
      "Stacked pull request needs dependency review",
    );
    expect(result.findings.map((finding) => finding.title)).toContain(
      "Merge queue state needs attention",
    );
  });

  test("builds a compact provider prompt with patch evidence", () => {
    const prompt = buildReviewPrompt(report, DEFAULT_REVIEW_POLICY);

    expect(prompt.system).toContain("senior maintainer");
    expect(prompt.user).toContain("owner/repo#42");
    expect(prompt.user).toContain("src/app/api/payment/callback/route.ts");
    expect(prompt.user).toContain("Policy gates");
    expect(prompt.user).toContain("Return JSON only");
  });

  test("parses provider JSON and normalizes invalid severities", () => {
    const review = parseProviderReviewJson(
      JSON.stringify({
        summary: "Looks risky.",
        risk: "critical",
        findings: [
          {
            severity: "blocker",
            category: "security",
            file: "src/app/api/payment/callback/route.ts",
            title: "Secret handling needs review",
            detail: "The callback trusts env state without fallback behavior.",
            recommendation: "Add explicit failure behavior and tests.",
            confidence: "high",
            evidence: [
              {
                kind: "patch",
                label: "env secret",
                detail: "PAYMENT_SECRET is read in the callback route.",
                file: "src/app/api/payment/callback/route.ts",
              },
            ],
          },
        ],
      }),
      "openai-api",
      "gpt-5.5",
    );

    expect(review.risk).toBe("critical");
    expect(review.findings[0].severity).toBe("high");
    expect(review.findings[0].confidence).toBe("high");
    expect(review.findings[0].evidence[0].label).toBe("env secret");
    expect(review.provider).toBe("openai-api");
    expect(review.model).toBe("gpt-5.5");
  });

  test("formats review markdown for GitHub comments", () => {
    const markdown = formatReviewMarkdown(
      buildRuleBasedReview(report, DEFAULT_REVIEW_POLICY),
    );

    expect(markdown).toContain("## PR Review");
    expect(markdown).toContain("Risk: critical");
    expect(markdown).toContain("Failing checks block merge confidence");
    expect(markdown).toContain("Evidence");
    expect(markdown).toContain("Generated by Codebase Argus");
  });
});
