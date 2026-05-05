import { describe, expect, test } from "vitest";
import {
  DEFAULT_REVIEW_POLICY,
  applyPolicyReview,
  parseReviewPolicy,
} from "./review-policy";
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
    number: 7,
    title: "Change deployment",
    htmlUrl: "https://github.com/owner/repo/pull/7",
    state: "open",
    draft: false,
    author: "alice",
    body: "",
    baseRef: "main",
    headRef: "deploy-change",
    headRepo: "alice/repo",
    headSha: "abc",
    createdAt: "2026-05-06T08:00:00Z",
    updatedAt: "2026-05-06T08:00:00Z",
    mergeable: true,
    mergeableState: "clean",
    additions: 80,
    deletions: 10,
    changedFiles: 3,
    labels: [],
  },
  checks: { state: "pending", total: 1, failing: 0, pending: 1 },
  reviews: [],
  commits: [],
  files: [
    {
      filename: "src/deploy.ts",
      status: "modified",
      additions: 60,
      deletions: 10,
      changes: 70,
      blobUrl: "https://github.com/owner/repo/blob/abc/src/deploy.ts",
      rawUrl: "https://github.com/owner/repo/raw/abc/src/deploy.ts",
      patch: "+ deploy(process.env.DEPLOY_TOKEN)",
    },
    {
      filename: ".github/workflows/release.yml",
      status: "modified",
      additions: 20,
      deletions: 0,
      changes: 20,
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

describe("review policy", () => {
  test("uses defaults for empty policy text", () => {
    expect(parseReviewPolicy("")).toEqual(DEFAULT_REVIEW_POLICY);
  });

  test("parses JSON policy text", () => {
    expect(
      parseReviewPolicy(
        JSON.stringify({
          maxChangedFiles: 2,
          requiredTestPatterns: ["*.test.ts"],
          forbiddenWorkflowPatterns: ["pull_request_target"],
        }),
      ),
    ).toMatchObject({
      maxChangedFiles: 2,
      requiredTestPatterns: ["*.test.ts"],
      forbiddenWorkflowPatterns: ["pull_request_target"],
    });
  });

  test("parses simple YAML-like policy text", () => {
    expect(
      parseReviewPolicy([
        "maxChangedFiles: 4",
        "requiredChecks: passing",
        "sensitivePathPatterns:",
        "  - deploy",
        "forbiddenWorkflowPatterns:",
        "  - pull_request_target",
      ].join("\n")),
    ).toMatchObject({
      maxChangedFiles: 4,
      requiredChecks: "passing",
      sensitivePathPatterns: ["deploy"],
      forbiddenWorkflowPatterns: ["pull_request_target"],
    });
  });

  test("adds policy findings with evidence", () => {
    const findings = applyPolicyReview(report, {
      ...DEFAULT_REVIEW_POLICY,
      maxChangedFiles: 2,
      requiredChecks: "passing",
      requiredTestPatterns: ["*.test.ts"],
      forbiddenWorkflowPatterns: ["pull_request_target"],
      sensitivePathPatterns: ["deploy"],
    });

    expect(findings.map((finding) => finding.title)).toContain(
      "Policy requires passing checks",
    );
    expect(findings.map((finding) => finding.title)).toContain(
      "Policy test requirement is not satisfied",
    );
    expect(findings.map((finding) => finding.title)).toContain(
      "Policy changed-file limit exceeded",
    );
    expect(findings.map((finding) => finding.title)).toContain(
      "Forbidden workflow pattern found",
    );
    expect(findings[0].evidence.length).toBeGreaterThan(0);
    expect(findings[0].confidence).toBe("high");
  });
});
