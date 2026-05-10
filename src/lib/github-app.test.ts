import { createHmac, generateKeyPairSync } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import {
  buildGitHubAppManifest,
  buildPullRequestReviewComments,
  fetchFailedGitHubActionsLogs,
  handleGitHubWebhook,
  parseReviewCommand,
  postPullRequestReview,
  requestInstallationToken,
  verifyGitHubWebhookSignature,
} from "./github-app";
import type { PullRequestReviewReport } from "./github";
import type { ReviewResult } from "./pr-review";

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
    additions: 120,
    deletions: 10,
    changedFiles: 1,
    labels: ["backend"],
  },
  checks: {
    state: "failing",
    total: 1,
    failing: 1,
    pending: 0,
    runs: [
      {
        name: "CI",
        status: "completed",
        conclusion: "failure",
        htmlUrl: "https://github.com/owner/repo/actions/runs/123/jobs/456",
        detailsUrl: "https://github.com/owner/repo/actions/runs/123/job/456",
      },
    ],
  },
  reviews: [],
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
      status: "modified",
      additions: 2,
      deletions: 0,
      changes: 2,
      blobUrl: "https://github.com/owner/repo/blob/abc/src/app/api/payment/callback/route.ts",
      rawUrl: "https://github.com/owner/repo/raw/abc/src/app/api/payment/callback/route.ts",
      patch: [
        "@@ -10,2 +10,3 @@ export async function POST() {",
        " const body = await request.json();",
        "+const token = process.env.PAYMENT_SECRET;",
        "+await verifySignature(token);",
      ].join("\n"),
    },
  ],
};

const review: ReviewResult = {
  provider: "rule-based",
  model: "local-heuristics",
  summary: "Review summary.",
  risk: "high",
  findings: [
    {
      severity: "high",
      category: "security",
      title: "Validate webhook secret behavior",
      detail: "The callback depends on PAYMENT_SECRET without a missing-secret branch.",
      recommendation: "Add explicit failure behavior and tests.",
      file: "src/app/api/payment/callback/route.ts",
      confidence: "high",
      evidence: [
        {
          kind: "patch",
          label: "secret branch",
          detail: "PAYMENT_SECRET is read in the callback route.",
          file: "src/app/api/payment/callback/route.ts",
        },
      ],
    },
  ],
  markdown: "## PR Review\n\nReview summary.",
};

describe("GitHub App review helpers", () => {
  test("verifies GitHub webhook HMAC signatures", () => {
    const body = JSON.stringify({ action: "opened" });
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;

    expect(verifyGitHubWebhookSignature(body, signature, "secret")).toBe(true);
    expect(verifyGitHubWebhookSignature(body, signature, "wrong")).toBe(false);
    expect(verifyGitHubWebhookSignature(body, "sha1=legacy", "secret")).toBe(false);
  });

  test("requests an installation token with a GitHub App JWT", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ token: "installation-token", expires_at: "2026-05-06T09:00:00Z" }),
      text: async () => "",
    }));

    const result = await requestInstallationToken({
      appId: "12345",
      installationId: 99,
      privateKey: testPrivateKey(),
      now: new Date("2026-05-06T08:00:00Z"),
      fetchImpl,
    });

    expect(result.token).toBe("installation-token");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/app/installations/99/access_tokens",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Bearer [^.]+\.[^.]+\.[^.]+$/),
        }),
      }),
    );
  });

  test("builds inline review comments only on commentable patch lines", () => {
    const comments = buildPullRequestReviewComments(review, report);

    expect(comments).toEqual([
      expect.objectContaining({
        path: "src/app/api/payment/callback/route.ts",
        position: 2,
        body: expect.stringContaining("Validate webhook secret behavior"),
      }),
    ]);
  });

  test("posts a GitHub pull request review with summary and inline comments", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 80, html_url: "https://github.com/owner/repo/pull/42#review" }),
      text: async () => "",
    }));

    const posted = await postPullRequestReview({
      owner: "owner",
      repo: "repo",
      number: 42,
      token: "installation-token",
      commitId: "abc123",
      body: review.markdown,
      comments: buildPullRequestReviewComments(review, report),
      fetchImpl,
    });

    expect(posted.htmlUrl).toContain("#review");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/pulls/42/reviews",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer installation-token",
        }),
        body: expect.stringContaining("\"event\":\"COMMENT\""),
      }),
    );
  });

  test("fetches failing GitHub Actions job logs from check-run URLs", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          jobs: [
            { id: 456, name: "test", conclusion: "failure" },
            { id: 789, name: "lint", conclusion: "success" },
          ],
        }),
        text: async () => "",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => "FAIL src/app.test.ts\nMissing config",
        json: async () => ({}),
      });

    const logs = await fetchFailedGitHubActionsLogs({
      owner: "owner",
      repo: "repo",
      runs: report.checks.runs ?? [],
      token: "installation-token",
      fetchImpl,
    });

    expect(logs).toEqual([
      {
        label: "test",
        log: "FAIL src/app.test.ts\nMissing config",
      },
    ]);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/owner/repo/actions/runs/123/jobs?filter=latest&per_page=100",
    );
    expect(fetchImpl.mock.calls[1][0]).toBe(
      "https://api.github.com/repos/owner/repo/actions/jobs/456/logs",
    );
  });

  test("handles pull_request webhooks by running review and posting a comment review", async () => {
    const body = JSON.stringify({
      action: "opened",
      installation: { id: 99 },
      repository: { name: "repo", owner: { login: "owner" } },
      pull_request: { number: 42, draft: false },
    });
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    const postPullRequestReviewImpl = vi.fn(async () => ({
      id: 80,
      htmlUrl: "https://github.com/owner/repo/pull/42#review",
    }));

    const result = await handleGitHubWebhook({
      body,
      headers: {
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature,
      },
      env: {
        GITHUB_WEBHOOK_SECRET: "secret",
        GITHUB_TOKEN: "installation-token",
        ARGUS_WEBHOOK_INLINE_COMMENTS: "true",
      },
      fetchPullRequestReviewReport: vi.fn(async () => report),
      fetchFailedGitHubActionsLogs: vi.fn(async () => []),
      postPullRequestReview: postPullRequestReviewImpl,
    });

    expect(result.status).toBe("reviewed");
    expect(postPullRequestReviewImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "owner",
        repo: "repo",
        number: 42,
        token: "installation-token",
        comments: expect.arrayContaining([
          expect.objectContaining({ path: "src/app/api/payment/callback/route.ts" }),
        ]),
      }),
    );
  });

  test("parses PR comment commands", () => {
    expect(parseReviewCommand("/argus review")).toEqual({ action: "review" });
    expect(parseReviewCommand("/fds review")).toEqual({ action: "review" });
    expect(parseReviewCommand("/fork-drift ci")).toEqual({ action: "ci" });
    expect(parseReviewCommand("looks good")).toBeNull();
  });

  test("handles issue_comment pause command by applying the pause label", async () => {
    const body = JSON.stringify({
      action: "created",
      installation: { id: 99 },
      repository: { name: "repo", owner: { login: "owner" } },
      issue: { number: 42, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/42" } },
      comment: { body: "/argus pause" },
    });
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    const addIssueLabels = vi.fn(async () => undefined);
    const postIssueComment = vi.fn(async () => ({
      id: 1,
      htmlUrl: "https://github.com/owner/repo/pull/42#issuecomment-1",
    }));

    const result = await handleGitHubWebhook({
      body,
      headers: {
        "x-github-event": "issue_comment",
        "x-hub-signature-256": signature,
      },
      env: {
        GITHUB_WEBHOOK_SECRET: "secret",
        GITHUB_TOKEN: "installation-token",
      },
      addIssueLabels,
      postIssueComment,
    });

    expect(result.status).toBe("commanded");
    expect(addIssueLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "owner",
        repo: "repo",
        number: 42,
        labels: ["argus:paused"],
      }),
    );
    expect(postIssueComment.mock.calls[0][0].body).toContain("Paused");
  });

  test("ignores automatic PR review when the pause label is present", async () => {
    const body = JSON.stringify({
      action: "synchronize",
      installation: { id: 99 },
      repository: { name: "repo", owner: { login: "owner" } },
      pull_request: { number: 42, draft: false },
    });
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    const pausedReport: PullRequestReviewReport = {
      ...report,
      pullRequest: {
        ...report.pullRequest,
        labels: ["argus:paused"],
      },
    };
    const postPullRequestReviewImpl = vi.fn();

    const result = await handleGitHubWebhook({
      body,
      headers: {
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature,
      },
      env: {
        GITHUB_WEBHOOK_SECRET: "secret",
        GITHUB_TOKEN: "installation-token",
      },
      fetchPullRequestReviewReport: vi.fn(async () => pausedReport),
      postPullRequestReview: postPullRequestReviewImpl,
    });

    expect(result).toEqual({
      status: "ignored",
      reason: "Pull request review is paused by argus:paused label.",
    });
    expect(postPullRequestReviewImpl).not.toHaveBeenCalled();
  });

  test("builds a GitHub App manifest for setup", () => {
    const manifest = buildGitHubAppManifest({
      name: "Codebase Argus",
      url: "https://argus.example.com",
    });

    expect(manifest.hook_attributes.url).toBe(
      "https://argus.example.com/api/github/webhook",
    );
    expect(manifest.default_permissions.pull_requests).toBe("write");
    expect(manifest.default_events).toContain("issue_comment");
  });
});

function testPrivateKey(): string {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: {
      type: "pkcs1",
      format: "pem",
    },
    publicKeyEncoding: {
      type: "pkcs1",
      format: "pem",
    },
  }).privateKey;
}
