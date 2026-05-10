import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { runAgentReview, runTribunalReview } from "./agent-providers";
import { buildAutofixPlan } from "./autofix";
import { buildRuleBasedCiReview } from "./ci-review";
import {
  fetchPullRequestReviewReport,
  type CheckRunSummary,
  type PullRequestReviewReport,
} from "./github";
import {
  buildReviewPrompt,
  buildRuleBasedReview,
  formatReviewMarkdown,
  type ReviewFinding,
  type ReviewProvider,
  type ReviewResult,
} from "./pr-review";
import { DEFAULT_REVIEW_POLICY } from "./review-policy";

type Env = Record<string, string | undefined>;
const PAUSE_LABEL = "argus:paused";

type JsonResponse = {
  ok: boolean;
  status?: number;
  statusText?: string;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
};

type FetchImpl = (
  url: string,
  init?: {
    method?: "DELETE" | "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
    cache?: RequestCache;
  },
) => Promise<JsonResponse>;

export type PullRequestReviewComment = {
  path: string;
  position: number;
  body: string;
};

export type PostedPullRequestReview = {
  id: number;
  htmlUrl: string;
};

export type GitHubActionsLog = {
  label: string;
  log: string;
};

export type GitHubAppManifest = {
  name: string;
  url: string;
  hook_attributes: {
    url: string;
  };
  redirect_url: string;
  callback_urls: string[];
  public: boolean;
  default_permissions: Record<string, "read" | "write">;
  default_events: string[];
};

export type ReviewCommand = {
  action: "autofix" | "ci" | "help" | "pause" | "resume" | "review";
};

export type GitHubWebhookResult =
  | {
      status: "ignored";
      reason: string;
    }
  | {
      status: "unauthorized" | "misconfigured";
      reason: string;
    }
  | {
      status: "reviewed";
      review: ReviewResult;
      commentsPosted: number;
      reviewUrl?: string;
      ciLogsIncluded: number;
    }
  | {
      status: "commanded";
      action: ReviewCommand["action"];
      commentUrl?: string;
      reviewUrl?: string;
    };

export function verifyGitHubWebhookSignature(
  body: string,
  signature: string | null | undefined,
  secret: string | null | undefined,
): boolean {
  if (!signature?.startsWith("sha256=") || !secret) {
    return false;
  }
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export async function requestInstallationToken(input: {
  appId: string;
  installationId: number;
  privateKey: string;
  now?: Date;
  fetchImpl?: FetchImpl;
}): Promise<{ token: string; expiresAt: string }> {
  const jwt = createGitHubAppJwt({
    appId: input.appId,
    privateKey: input.privateKey,
    now: input.now,
  });
  const response = await (input.fetchImpl ?? fetch)(
    `https://api.github.com/app/installations/${input.installationId}/access_tokens`,
    {
      method: "POST",
      headers: githubHeaders(jwt),
      body: "{}",
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub App installation token failed: ${await responseText(response)}`);
  }
  const body = await responseJson(response);
  const token = stringField(body, "token");
  if (!token) {
    throw new Error("GitHub App installation token response did not include a token.");
  }
  return {
    token,
    expiresAt: stringField(body, "expires_at") || "",
  };
}

export function buildPullRequestReviewComments(
  review: ReviewResult,
  report: PullRequestReviewReport,
  maxComments = 5,
): PullRequestReviewComment[] {
  const files = new Map(report.files.map((file) => [file.filename, file]));
  const comments: PullRequestReviewComment[] = [];
  const seen = new Set<string>();

  for (const finding of review.findings) {
    if (finding.severity === "info") {
      continue;
    }
    const path = finding.file ?? finding.evidence.find((item) => item.file)?.file;
    if (!path || seen.has(path)) {
      continue;
    }
    const file = files.get(path);
    const position = firstCommentablePatchPosition(file?.patch);
    if (!position) {
      continue;
    }
    seen.add(path);
    comments.push({
      path,
      position,
      body: formatInlineFinding(finding),
    });
    if (comments.length >= maxComments) {
      break;
    }
  }

  return comments;
}

export async function postPullRequestReview(input: {
  owner: string;
  repo: string;
  number: number;
  token: string;
  commitId: string;
  body: string;
  comments?: PullRequestReviewComment[];
  fetchImpl?: FetchImpl;
}): Promise<PostedPullRequestReview> {
  const response = await (input.fetchImpl ?? fetch)(
    `https://api.github.com/repos/${input.owner}/${input.repo}/pulls/${input.number}/reviews`,
    {
      method: "POST",
      headers: githubHeaders(input.token),
      body: JSON.stringify({
        commit_id: input.commitId,
        body: input.body,
        event: "COMMENT",
        ...(input.comments?.length ? { comments: input.comments } : undefined),
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub pull request review failed: ${await responseText(response)}`);
  }
  const body = await responseJson(response);
  return {
    id: numberField(body, "id"),
    htmlUrl: stringField(body, "html_url"),
  };
}

export async function postIssueComment(input: {
  owner: string;
  repo: string;
  number: number;
  token: string;
  body: string;
  fetchImpl?: FetchImpl;
}): Promise<{ id: number; htmlUrl: string }> {
  const response = await (input.fetchImpl ?? fetch)(
    `https://api.github.com/repos/${input.owner}/${input.repo}/issues/${input.number}/comments`,
    {
      method: "POST",
      headers: githubHeaders(input.token),
      body: JSON.stringify({ body: input.body }),
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub issue comment failed: ${await responseText(response)}`);
  }
  const body = await responseJson(response);
  return {
    id: numberField(body, "id"),
    htmlUrl: stringField(body, "html_url"),
  };
}

export async function addIssueLabels(input: {
  owner: string;
  repo: string;
  number: number;
  labels: string[];
  token: string;
  fetchImpl?: FetchImpl;
}): Promise<void> {
  const response = await (input.fetchImpl ?? fetch)(
    `https://api.github.com/repos/${input.owner}/${input.repo}/issues/${input.number}/labels`,
    {
      method: "POST",
      headers: githubHeaders(input.token),
      body: JSON.stringify({ labels: input.labels }),
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub issue labels failed: ${await responseText(response)}`);
  }
}

export async function removeIssueLabel(input: {
  owner: string;
  repo: string;
  number: number;
  label: string;
  token: string;
  fetchImpl?: FetchImpl;
}): Promise<void> {
  const response = await (input.fetchImpl ?? fetch)(
    `https://api.github.com/repos/${input.owner}/${input.repo}/issues/${input.number}/labels/${encodeURIComponent(input.label)}`,
    {
      method: "DELETE",
      headers: githubHeaders(input.token),
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`GitHub issue label removal failed: ${await responseText(response)}`);
  }
}

export async function fetchFailedGitHubActionsLogs(input: {
  owner: string;
  repo: string;
  runs: CheckRunSummary[];
  token: string;
  maxJobs?: number;
  maxBytesPerJob?: number;
  fetchImpl?: FetchImpl;
}): Promise<GitHubActionsLog[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const maxJobs = input.maxJobs ?? 3;
  const maxBytes = input.maxBytesPerJob ?? 12000;
  const runRefs = uniqueRunRefs(input.runs, input.owner, input.repo);
  const logs: GitHubActionsLog[] = [];

  for (const runRef of runRefs) {
    const jobs = await listWorkflowRunJobs({
      owner: runRef.owner,
      repo: runRef.repo,
      runId: runRef.runId,
      token: input.token,
      fetchImpl,
    });
    for (const job of jobs) {
      if (!isFailureConclusion(job.conclusion)) {
        continue;
      }
      const response = await fetchImpl(
        `https://api.github.com/repos/${runRef.owner}/${runRef.repo}/actions/jobs/${job.id}/logs`,
        {
          method: "GET",
          headers: githubHeaders(input.token),
        },
      );
      if (!response.ok) {
        continue;
      }
      const log = truncate(await responseText(response), maxBytes);
      logs.push({ label: job.name, log });
      if (logs.length >= maxJobs) {
        return logs;
      }
    }
  }

  return logs;
}

export async function handleGitHubWebhook(input: {
  body: string;
  headers: Headers | Record<string, string | undefined>;
  env?: Env;
  fetchImpl?: FetchImpl;
  fetchPullRequestReviewReport?: typeof fetchPullRequestReviewReport;
  fetchFailedGitHubActionsLogs?: typeof fetchFailedGitHubActionsLogs;
  postPullRequestReview?: typeof postPullRequestReview;
  postIssueComment?: typeof postIssueComment;
  addIssueLabels?: typeof addIssueLabels;
  removeIssueLabel?: typeof removeIssueLabel;
}): Promise<GitHubWebhookResult> {
  const env = input.env ?? process.env;
  const secret = env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret && envFlag(env, "ALLOW_UNSIGNED_WEBHOOKS") !== "true") {
    return {
      status: "misconfigured",
      reason: "GITHUB_WEBHOOK_SECRET is required unless ARGUS_ALLOW_UNSIGNED_WEBHOOKS=true.",
    };
  }
  if (
    secret &&
    !verifyGitHubWebhookSignature(
      input.body,
      header(input.headers, "x-hub-signature-256"),
      secret,
    )
  ) {
    return { status: "unauthorized", reason: "Invalid GitHub webhook signature." };
  }

  const event = header(input.headers, "x-github-event");
  if (event === "issue_comment") {
    return handleIssueCommentWebhook(input, env);
  }
  if (event !== "pull_request") {
    return { status: "ignored", reason: `Unsupported GitHub event: ${event || "unknown"}.` };
  }

  const payload = parseWebhookPayload(input.body);
  if (!shouldReviewPullRequestAction(payload.action)) {
    return { status: "ignored", reason: `Pull request action ${payload.action} ignored.` };
  }
  if (payload.pull_request?.draft) {
    return { status: "ignored", reason: "Draft pull request ignored." };
  }

  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const number = payload.pull_request?.number;
  if (!owner || !repo || !number) {
    return { status: "ignored", reason: "Webhook payload did not include a repository PR." };
  }

  const token = await resolveGitHubToken({
    env,
    installationId: payload.installation?.id,
    fetchImpl: input.fetchImpl,
  });
  const report = await (input.fetchPullRequestReviewReport ?? fetchPullRequestReviewReport)({
    owner,
    repo,
    number,
    token,
  });
  if (report.pullRequest.labels.some((label) => isPauseLabel(label))) {
    return {
      status: "ignored",
      reason: `Pull request review is paused by ${PAUSE_LABEL} label.`,
    };
  }
  let review = await runConfiguredReview(report, env);
  const ciLogs = await collectCiLogs({
    env,
    report,
    token,
    fetchFailedGitHubActionsLogsImpl:
      input.fetchFailedGitHubActionsLogs ?? fetchFailedGitHubActionsLogs,
    fetchImpl: input.fetchImpl,
  });
  review = appendCiFindings(review, ciLogs);

  const comments =
    envFlag(env, "WEBHOOK_INLINE_COMMENTS") === "true"
      ? buildPullRequestReviewComments(review, report)
      : [];
  if (envFlag(env, "WEBHOOK_DRY_RUN") === "true") {
    return {
      status: "reviewed",
      review,
      commentsPosted: 0,
      ciLogsIncluded: ciLogs.length,
    };
  }

  const posted = await (input.postPullRequestReview ?? postPullRequestReview)({
    owner,
    repo,
    number,
    token,
    commitId: report.pullRequest.headSha,
    body: review.markdown,
    comments,
    fetchImpl: input.fetchImpl,
  });

  return {
    status: "reviewed",
    review,
    reviewUrl: posted.htmlUrl,
    commentsPosted: comments.length,
    ciLogsIncluded: ciLogs.length,
  };
}

export function parseReviewCommand(body: string): ReviewCommand | null {
  const match = body
    .trim()
    .match(/^\/(?:argus|codebase-argus)(?:\s+([a-z-]+))?/i);
  if (!match) {
    return null;
  }
  const action = (match[1]?.toLowerCase() || "help") as ReviewCommand["action"];
  if (["autofix", "ci", "help", "pause", "resume", "review"].includes(action)) {
    return { action };
  }
  return { action: "help" };
}

export function buildGitHubAppManifest(input: {
  name: string;
  url: string;
}): GitHubAppManifest {
  const url = input.url.replace(/\/+$/g, "");
  return {
    name: input.name,
    url,
    hook_attributes: {
      url: `${url}/api/github/webhook`,
    },
    redirect_url: url,
    callback_urls: [url],
    public: false,
    default_permissions: {
      actions: "read",
      checks: "read",
      contents: "read",
      issues: "write",
      metadata: "read",
      pull_requests: "write",
    },
    default_events: ["issue_comment", "pull_request"],
  };
}

async function handleIssueCommentWebhook(
  input: {
    body: string;
    env?: Env;
    fetchImpl?: FetchImpl;
    fetchPullRequestReviewReport?: typeof fetchPullRequestReviewReport;
    fetchFailedGitHubActionsLogs?: typeof fetchFailedGitHubActionsLogs;
    postPullRequestReview?: typeof postPullRequestReview;
    postIssueComment?: typeof postIssueComment;
    addIssueLabels?: typeof addIssueLabels;
    removeIssueLabel?: typeof removeIssueLabel;
  },
  env: Env,
): Promise<GitHubWebhookResult> {
  const payload = parseWebhookPayload(input.body);
  if (payload.action !== "created") {
    return { status: "ignored", reason: `Issue comment action ${payload.action} ignored.` };
  }
  if (!payload.issue?.pull_request) {
    return { status: "ignored", reason: "Issue comment is not on a pull request." };
  }
  const command = parseReviewCommand(payload.comment?.body ?? "");
  if (!command) {
    return { status: "ignored", reason: "Issue comment did not contain an Argus command." };
  }
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const number = payload.issue?.number;
  if (!owner || !repo || !number) {
    return { status: "ignored", reason: "Issue comment payload did not include a repository PR." };
  }
  const token = await resolveGitHubToken({
    env,
    installationId: payload.installation?.id,
    fetchImpl: input.fetchImpl,
  });

  if (command.action === "pause") {
    await (input.addIssueLabels ?? addIssueLabels)({
      owner,
      repo,
      number,
      labels: [PAUSE_LABEL],
      token,
      fetchImpl: input.fetchImpl,
    });
    const comment = await (input.postIssueComment ?? postIssueComment)({
      owner,
      repo,
      number,
      token,
      body: "Paused automatic Codebase Argus reviews for this PR. Use `/argus resume` to enable them again.",
      fetchImpl: input.fetchImpl,
    });
    return { status: "commanded", action: "pause", commentUrl: comment.htmlUrl };
  }

  if (command.action === "resume") {
    await (input.removeIssueLabel ?? removeIssueLabel)({
      owner,
      repo,
      number,
      label: PAUSE_LABEL,
      token,
      fetchImpl: input.fetchImpl,
    });
    const comment = await (input.postIssueComment ?? postIssueComment)({
      owner,
      repo,
      number,
      token,
      body: "Resumed automatic Codebase Argus reviews for this PR.",
      fetchImpl: input.fetchImpl,
    });
    return { status: "commanded", action: "resume", commentUrl: comment.htmlUrl };
  }

  if (command.action === "help") {
    const comment = await (input.postIssueComment ?? postIssueComment)({
      owner,
      repo,
      number,
      token,
      body: [
        "Codebase Argus commands:",
        "",
        "- `/argus review` runs PR review now.",
        "- `/argus ci` reviews failing GitHub Actions logs.",
        "- `/argus autofix` posts a gated autofix branch plan.",
        `- \`/argus pause\` pauses automatic review with the \`${PAUSE_LABEL}\` label.`,
        "- `/argus resume` removes the pause label.",
      ].join("\n"),
      fetchImpl: input.fetchImpl,
    });
    return { status: "commanded", action: "help", commentUrl: comment.htmlUrl };
  }

  const report = await (input.fetchPullRequestReviewReport ?? fetchPullRequestReviewReport)({
    owner,
    repo,
    number,
    token,
  });

  if (command.action === "ci") {
    const logs = await collectCiLogs({
      env: { ...env, ARGUS_WEBHOOK_INCLUDE_CI_LOGS: "true" },
      report,
      token,
      fetchFailedGitHubActionsLogsImpl:
        input.fetchFailedGitHubActionsLogs ?? fetchFailedGitHubActionsLogs,
      fetchImpl: input.fetchImpl,
    });
    const review = buildRuleBasedCiReview({
      log: logs.map((log) => `## ${log.label}\n${log.log}`).join("\n\n") ||
        "No failing GitHub Actions job logs were available.",
      label: `${owner}/${repo}#${number}`,
    });
    const comment = await (input.postIssueComment ?? postIssueComment)({
      owner,
      repo,
      number,
      token,
      body: review.markdown,
      fetchImpl: input.fetchImpl,
    });
    return { status: "commanded", action: "ci", commentUrl: comment.htmlUrl };
  }

  const review = await runConfiguredReview(report, env);
  if (command.action === "autofix") {
    const plan = buildAutofixPlan({ report, review });
    const comment = await (input.postIssueComment ?? postIssueComment)({
      owner,
      repo,
      number,
      token,
      body: plan.markdown,
      fetchImpl: input.fetchImpl,
    });
    return { status: "commanded", action: "autofix", commentUrl: comment.htmlUrl };
  }

  const posted = await (input.postPullRequestReview ?? postPullRequestReview)({
    owner,
    repo,
    number,
    token,
    commitId: report.pullRequest.headSha,
    body: review.markdown,
    comments: buildPullRequestReviewComments(review, report),
    fetchImpl: input.fetchImpl,
  });
  return { status: "commanded", action: "review", reviewUrl: posted.htmlUrl };
}

function createGitHubAppJwt(input: {
  appId: string;
  privateKey: string;
  now?: Date;
}): string {
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat: nowSeconds - 60,
    exp: nowSeconds + 540,
    iss: input.appId,
  });
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(normalizePrivateKey(input.privateKey));
  return `${signingInput}.${base64Url(signature)}`;
}

function normalizePrivateKey(value: string): string {
  return value.replace(/\\n/g, "\n");
}

function base64UrlJson(value: Record<string, unknown>): string {
  return base64Url(Buffer.from(JSON.stringify(value)));
}

function base64Url(value: Buffer): string {
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function resolveGitHubToken(input: {
  env: Env;
  installationId?: number;
  fetchImpl?: FetchImpl;
}): Promise<string> {
  const appId = input.env.GITHUB_APP_ID?.trim();
  const privateKey = appPrivateKey(input.env);
  if (input.installationId && appId && privateKey) {
    return (
      await requestInstallationToken({
        appId,
        installationId: input.installationId,
        privateKey,
        fetchImpl: input.fetchImpl,
      })
    ).token;
  }

  const token = input.env.GITHUB_TOKEN?.trim();
  if (token) {
    return token;
  }

  throw new Error(
    "GitHub token unavailable. Configure GitHub App credentials or GITHUB_TOKEN.",
  );
}

function appPrivateKey(env: Env): string {
  const inline = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (inline) {
    return inline;
  }
  const encoded = env.GITHUB_APP_PRIVATE_KEY_BASE64?.trim();
  return encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
}

async function runConfiguredReview(
  report: PullRequestReviewReport,
  env: Env,
): Promise<ReviewResult> {
  const tribunal = envValue(env, "WEBHOOK_TRIBUNAL");
  if (tribunal) {
    return runTribunalReview({
      providers: parseTribunalProviders(tribunal),
      prompt: buildReviewPrompt(report, DEFAULT_REVIEW_POLICY),
      env,
      cwd: process.cwd(),
    });
  }

  const provider = (envValue(env, "WEBHOOK_PROVIDER") || "rule-based") as ReviewProvider;
  if (provider === "rule-based") {
    return buildRuleBasedReview(report, DEFAULT_REVIEW_POLICY);
  }
  if (provider === "tribunal") {
    throw new Error("Use ARGUS_WEBHOOK_TRIBUNAL to configure tribunal providers.");
  }
  return runAgentReview({
    provider,
    model: envValue(env, "WEBHOOK_MODEL"),
    prompt: buildReviewPrompt(report, DEFAULT_REVIEW_POLICY),
    env,
    cwd: process.cwd(),
  });
}

function parseTribunalProviders(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [provider, ...modelParts] = item.split(":");
      return {
        provider: provider as Exclude<ReviewProvider, "rule-based" | "tribunal">,
        ...(modelParts.length ? { model: modelParts.join(":") } : undefined),
      };
    });
}

async function collectCiLogs(input: {
  env: Env;
  report: PullRequestReviewReport;
  token: string;
  fetchFailedGitHubActionsLogsImpl: typeof fetchFailedGitHubActionsLogs;
  fetchImpl?: FetchImpl;
}): Promise<GitHubActionsLog[]> {
  if (
    envFlag(input.env, "WEBHOOK_INCLUDE_CI_LOGS") === "false" ||
    input.report.checks.state !== "failing" ||
    !input.report.checks.runs?.length
  ) {
    return [];
  }
  const [owner, repo] = input.report.repository.fullName.split("/");
  try {
    return await input.fetchFailedGitHubActionsLogsImpl({
      owner,
      repo,
      runs: input.report.checks.runs,
      token: input.token,
      fetchImpl: input.fetchImpl,
    });
  } catch {
    return [];
  }
}

function appendCiFindings(
  review: ReviewResult,
  logs: GitHubActionsLog[],
): ReviewResult {
  if (!logs.length) {
    return review;
  }
  const findings = [
    ...review.findings,
    ...logs.flatMap((log) =>
      buildRuleBasedCiReview({ log: log.log, label: log.label }).findings,
    ),
  ];
  const result = {
    ...review,
    summary: `${review.summary} Included ${logs.length} failing GitHub Actions job log(s).`,
    risk: maxRisk([review.risk, ...findings.map(riskFromFinding)]),
    findings,
    markdown: "",
  };
  result.markdown = formatReviewMarkdown(result);
  return result;
}

function envValue(env: Env, name: string): string {
  return env[`ARGUS_${name}`]?.trim() || "";
}

function envFlag(env: Env, name: string): string {
  return envValue(env, name).toLowerCase();
}

function isPauseLabel(label: string): boolean {
  return label === PAUSE_LABEL;
}

function maxRisk(risks: ReviewResult["risk"][]): ReviewResult["risk"] {
  const order: ReviewResult["risk"][] = ["critical", "high", "medium", "low"];
  return order.find((risk) => risks.includes(risk)) ?? "low";
}

function riskFromFinding(finding: ReviewFinding): ReviewResult["risk"] {
  if (finding.severity === "critical") {
    return "critical";
  }
  if (finding.severity === "high") {
    return "high";
  }
  if (finding.severity === "medium") {
    return "medium";
  }
  return "low";
}

function parseWebhookPayload(body: string): {
  action?: string;
  installation?: { id?: number };
  repository?: { name?: string; owner?: { login?: string } };
  pull_request?: { number?: number; draft?: boolean };
  issue?: { number?: number; pull_request?: unknown };
  comment?: { body?: string };
} {
  const payload = JSON.parse(body) as {
    action?: string;
    installation?: { id?: number };
    repository?: { name?: string; owner?: { login?: string } };
    pull_request?: { number?: number; draft?: boolean };
    issue?: { number?: number; pull_request?: unknown };
    comment?: { body?: string };
  };
  return payload;
}

function shouldReviewPullRequestAction(action: string | undefined): boolean {
  return ["opened", "reopened", "ready_for_review", "synchronize"].includes(
    action ?? "",
  );
}

function header(
  headers: Headers | Record<string, string | undefined>,
  name: string,
): string | null {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value ?? null;
    }
  }
  return null;
}

function firstCommentablePatchPosition(patch: string | undefined): number | null {
  if (!patch) {
    return null;
  }
  let inHunk = false;
  let position = 0;
  let fallback: number | null = null;

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) {
      continue;
    }
    position += 1;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return position;
    }
    if (!line.startsWith("-") && fallback === null) {
      fallback = position;
    }
  }

  return fallback;
}

function formatInlineFinding(finding: ReviewFinding): string {
  return truncate(
    [
      `**${finding.title}** (${finding.severity}, ${finding.category})`,
      "",
      finding.detail,
      "",
      `Recommendation: ${finding.recommendation}`,
      `Confidence: ${finding.confidence}`,
    ].join("\n"),
    1400,
  );
}

async function listWorkflowRunJobs(input: {
  owner: string;
  repo: string;
  runId: number;
  token: string;
  fetchImpl: FetchImpl;
}): Promise<Array<{ id: number; name: string; conclusion: string | null }>> {
  const response = await input.fetchImpl(
    `https://api.github.com/repos/${input.owner}/${input.repo}/actions/runs/${input.runId}/jobs?filter=latest&per_page=100`,
    {
      method: "GET",
      headers: githubHeaders(input.token),
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub workflow jobs failed: ${await responseText(response)}`);
  }
  const body = await responseJson(response);
  const jobs = Array.isArray((body as { jobs?: unknown }).jobs)
    ? ((body as { jobs: unknown[] }).jobs)
    : [];
  return jobs
    .map((job) => {
      const record = objectRecord(job);
      return {
        id: numberField(record, "id"),
        name: stringField(record, "name") || `job-${numberField(record, "id")}`,
        conclusion: stringField(record, "conclusion") || null,
      };
    })
    .filter((job) => job.id > 0);
}

function uniqueRunRefs(
  runs: CheckRunSummary[],
  fallbackOwner: string,
  fallbackRepo: string,
): Array<{ owner: string; repo: string; runId: number }> {
  const refs = new Map<string, { owner: string; repo: string; runId: number }>();
  for (const run of runs) {
    if (!isFailureConclusion(run.conclusion)) {
      continue;
    }
    const parsed =
      parseActionsRunUrl(run.detailsUrl) ??
      parseActionsRunUrl(run.htmlUrl);
    if (!parsed) {
      continue;
    }
    const ref = {
      owner: parsed.owner || fallbackOwner,
      repo: parsed.repo || fallbackRepo,
      runId: parsed.runId,
    };
    refs.set(`${ref.owner}/${ref.repo}/${ref.runId}`, ref);
  }
  return Array.from(refs.values());
}

function parseActionsRunUrl(
  value: string | undefined,
): { owner: string; repo: string; runId: number } | null {
  const match = value?.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/([0-9]+)/,
  );
  if (!match) {
    return null;
  }
  return {
    owner: match[1],
    repo: match[2],
    runId: Number(match[3]),
  };
}

function isFailureConclusion(conclusion: string | null): boolean {
  return ["failure", "cancelled", "timed_out", "action_required"].includes(
    conclusion ?? "",
  );
}

async function responseJson(response: JsonResponse): Promise<Record<string, unknown>> {
  const body = response.json ? await response.json() : {};
  return objectRecord(body);
}

async function responseText(response: JsonResponse): Promise<string> {
  if (response.text) {
    return response.text();
  }
  if (response.json) {
    return JSON.stringify(await response.json());
  }
  return response.statusText ?? `HTTP ${response.status ?? "error"}`;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  return typeof value === "string" ? value : "";
}

function numberField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n... truncated ...`;
}
