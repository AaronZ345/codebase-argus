import { describe, expect, test } from "vitest";
import { buildAutofixPlan } from "./autofix";
import type { PullRequestReviewReport } from "./github";
import type { ReviewResult } from "./pr-review";

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
    title: "Refresh dependency and snapshots",
    htmlUrl: "https://github.com/owner/repo/pull/12",
    state: "open",
    draft: false,
    author: "alice",
    body: "",
    baseRef: "main",
    headRef: "feature/deps",
    headRepo: "alice/repo",
    headSha: "abc",
    createdAt: "2026-05-06T08:00:00Z",
    updatedAt: "2026-05-06T08:00:00Z",
    mergeable: true,
    mergeableState: "clean",
    additions: 10,
    deletions: 2,
    changedFiles: 2,
    labels: [],
  },
  checks: { state: "failing", total: 1, failing: 1, pending: 0 },
  reviews: [],
  commits: [],
  files: [
    {
      filename: "package-lock.json",
      status: "modified",
      additions: 6,
      deletions: 2,
      changes: 8,
      blobUrl: "https://github.com/owner/repo/blob/abc/package-lock.json",
      rawUrl: "https://github.com/owner/repo/raw/abc/package-lock.json",
      patch: "@@ lockfile @@",
    },
    {
      filename: "src/__snapshots__/view.test.ts.snap",
      status: "modified",
      additions: 4,
      deletions: 0,
      changes: 4,
      blobUrl: "https://github.com/owner/repo/blob/abc/src/__snapshots__/view.test.ts.snap",
      rawUrl: "https://github.com/owner/repo/raw/abc/src/__snapshots__/view.test.ts.snap",
      patch: "@@ snapshot @@",
    },
  ],
};

const review: ReviewResult = {
  provider: "rule-based",
  model: "local-heuristics",
  summary: "Dependency and snapshot updates need verification.",
  risk: "medium",
  findings: [
    {
      severity: "medium",
      category: "dependencies",
      title: "Dependency lockfile changed",
      detail: "Lockfile changed.",
      recommendation: "Refresh and verify the lockfile.",
      file: "package-lock.json",
      confidence: "medium",
      evidence: [],
    },
    {
      severity: "medium",
      category: "tests",
      title: "Snapshot output changed",
      detail: "Snapshot changed.",
      recommendation: "Regenerate snapshots and run tests.",
      file: "src/__snapshots__/view.test.ts.snap",
      confidence: "medium",
      evidence: [],
    },
  ],
  markdown: "",
};

describe("autofix plans", () => {
  test("builds a gated branch plan for narrow fix lanes", () => {
    const plan = buildAutofixPlan({ report, review });

    expect(plan.branch).toBe("argus/autofix-pr-12");
    expect(plan.lanes.map((lane) => lane.kind)).toEqual([
      "lockfile-refresh",
      "snapshot-refresh",
    ]);
    expect(plan.markdown).toContain("git switch -c argus/autofix-pr-12 FETCH_HEAD");
    expect(plan.markdown).toContain("npm install --package-lock-only");
    expect(plan.markdown).toContain("npm test -- -u");
    expect(plan.markdown).toContain("push the autofix branch");
  });
});
