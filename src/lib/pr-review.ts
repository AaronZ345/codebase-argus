import type { PullRequestReviewReport } from "./github";
import {
  DEFAULT_REVIEW_POLICY,
  applyPolicyReview,
} from "./review-policy";
import type { ReviewPolicy } from "./review-policy";

export type ReviewSeverity = "critical" | "high" | "medium" | "low" | "info";
export type ReviewRisk = "critical" | "high" | "medium" | "low";
export type ReviewProvider =
  | "rule-based"
  | "openai-api"
  | "anthropic-api"
  | "gemini-api"
  | "codex-cli"
  | "claude-cli"
  | "gemini-cli"
  | "tribunal";

export type PullRequestRef = {
  owner: string;
  repo: string;
  number: number;
  fullName: string;
};

export type ReviewFinding = {
  severity: ReviewSeverity;
  category: string;
  title: string;
  detail: string;
  recommendation: string;
  file?: string;
  confidence: "high" | "medium" | "low";
  evidence: Array<{
    kind: "file" | "patch" | "check" | "policy" | "git" | "agent";
    label: string;
    detail: string;
    file?: string;
  }>;
};

export type ReviewResult = {
  provider: ReviewProvider;
  model: string;
  summary: string;
  risk: ReviewRisk;
  findings: ReviewFinding[];
  markdown: string;
  raw?: string;
};

export type ReviewPrompt = {
  system: string;
  user: string;
};

const SEVERITIES: ReviewSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
];
const RISKS: ReviewRisk[] = ["critical", "high", "medium", "low"];

export function parsePullRequestRef(value: string): PullRequestRef {
  const trimmed = value.trim();
  const urlMatch = trimmed.match(
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([0-9]+)\/?$/i,
  );
  const shortMatch = trimmed.match(
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([0-9]+)$/i,
  );
  const match = urlMatch ?? shortMatch;

  if (!match) {
    throw new Error(
      'Pull request reference must look like "owner/repo#123" or a GitHub PR URL.',
    );
  }

  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`Invalid pull request number: ${match[3]}`);
  }

  return {
    owner: match[1],
    repo: match[2],
    number,
    fullName: `${match[1]}/${match[2]}`,
  };
}

export function buildRuleBasedReview(
  report: PullRequestReviewReport,
  policy: ReviewPolicy = DEFAULT_REVIEW_POLICY,
): ReviewResult {
  const findings: ReviewFinding[] = [...applyPolicyReview(report, policy)];
  const changedSource = report.files.some((file) => isSourceFile(file.filename));
  const changedTests = report.files.some((file) => isTestFile(file.filename));
  const workflowFiles = report.files.filter((file) =>
    file.filename.startsWith(".github/workflows/"),
  );
  const securityFiles = report.files.filter((file) =>
    isSecuritySensitive(file.filename, file.patch),
  );
  const dependencyFiles = report.files.filter((file) =>
    ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"].some(
      (name) => file.filename.endsWith(name),
    ),
  );
  const totalDelta =
    report.pullRequest.additions + report.pullRequest.deletions;

  if (report.pullRequest.baseRef !== report.repository.defaultBranch) {
    findings.push({
      severity: "medium",
      category: "stack",
      title: "Stacked pull request needs dependency review",
      detail: `The PR targets ${report.pullRequest.baseRef} instead of ${report.repository.defaultBranch}, so it is likely part of a stacked branch flow.`,
      recommendation:
        "Review the base branch first, then verify this PR after restacking or after the base PR merges.",
      confidence: "high",
      evidence: [
        {
          kind: "policy",
          label: "non-default base",
          detail: `${report.pullRequest.baseRef} != ${report.repository.defaultBranch}`,
        },
      ],
    });
  }

  if (isMergeQueueAttentionState(report.pullRequest.mergeableState)) {
    findings.push({
      severity: report.pullRequest.mergeableState === "dirty" ? "high" : "medium",
      category: "merge-queue",
      title: "Merge queue state needs attention",
      detail: `GitHub reports mergeable_state=${report.pullRequest.mergeableState}.`,
      recommendation:
        "Refresh the branch, resolve queue blockers, and rerun required checks before adding it to the merge queue.",
      confidence: "medium",
      evidence: [
        {
          kind: "check",
          label: "mergeable state",
          detail: report.pullRequest.mergeableState,
        },
      ],
    });
  }

  if (report.checks.state === "failing") {
    findings.push({
      severity: "high",
      category: "ci",
      title: "Failing checks block merge confidence",
      detail: `${report.checks.failing} of ${report.checks.total} check runs are failing.`,
      recommendation: "Fix or explain failing checks before merge.",
      confidence: "high",
      evidence: [
        {
          kind: "check",
          label: "failing checks",
          detail: `${report.checks.failing}/${report.checks.total} failing`,
        },
      ],
    });
  }

  if (changedSource && !changedTests) {
    findings.push({
      severity: "medium",
      category: "tests",
      title: "Source changes have no matching tests",
      detail: "The PR changes source files but no obvious test files.",
      recommendation: "Add targeted tests or document why coverage is unnecessary.",
      confidence: "medium",
      evidence: [
        {
          kind: "file",
          label: "source files",
          detail: report.files
            .filter((file) => isSourceFile(file.filename))
            .slice(0, 5)
            .map((file) => file.filename)
            .join(", "),
        },
      ],
    });
  }

  if (workflowFiles.length > 0) {
    findings.push({
      severity: "high",
      category: "security",
      title: "Workflow changes require maintainer review",
      detail: `${workflowFiles.length} GitHub Actions workflow file(s) changed.`,
      recommendation:
        "Review permissions, pull_request_target usage, and secret exposure before merge.",
      file: workflowFiles[0].filename,
      confidence: "high",
      evidence: workflowFiles.slice(0, 3).map((file) => ({
        kind: "file" as const,
        label: "workflow file",
        detail: file.filename,
        file: file.filename,
      })),
    });
  }

  if (securityFiles.length > 0) {
    findings.push({
      severity: "high",
      category: "security",
      title: "Security-sensitive code path changed",
      detail: `${securityFiles.length} file(s) touch auth, secret, token, payment, webhook, or route-handling paths.`,
      recommendation:
        "Trace trust boundaries, failure behavior, and negative tests before merge.",
      file: securityFiles[0].filename,
      confidence: "high",
      evidence: securityFiles.slice(0, 3).map((file) => ({
        kind: "patch" as const,
        label: "security-sensitive token",
        detail: firstInterestingPatchLine(file.patch) ?? file.filename,
        file: file.filename,
      })),
    });
  }

  if (dependencyFiles.length > 0) {
    findings.push({
      severity: "medium",
      category: "dependencies",
      title: "Dependency lockfile changed",
      detail: `${dependencyFiles.length} dependency manifest or lockfile changed.`,
      recommendation: "Verify dependency intent, supply-chain risk, and lockfile diff.",
      file: dependencyFiles[0].filename,
      confidence: "medium",
      evidence: dependencyFiles.slice(0, 3).map((file) => ({
        kind: "file" as const,
        label: "dependency file",
        detail: `${file.filename}: +${file.additions}/-${file.deletions}`,
        file: file.filename,
      })),
    });
  }

  if (totalDelta >= 1000) {
    findings.push({
      severity: "medium",
      category: "maintainability",
      title: "Large PR increases review risk",
      detail: `The PR changes ${totalDelta} lines across ${report.pullRequest.changedFiles} files.`,
      recommendation: "Consider splitting unrelated changes or require deeper review.",
      confidence: "medium",
      evidence: [
        {
          kind: "policy",
          label: "diff size",
          detail: `${totalDelta} changed lines, ${report.pullRequest.changedFiles} files`,
        },
      ],
    });
  }

  if (!findings.length) {
    findings.push({
      severity: "info",
      category: "review",
      title: "No obvious baseline risks found",
      detail: "Rule-based checks did not find CI, test, workflow, or size risks.",
      recommendation: "Still review behavior and edge cases manually.",
      confidence: "low",
      evidence: [
        {
          kind: "policy",
          label: "baseline checks",
          detail: "No deterministic baseline finding matched.",
        },
      ],
    });
  }

  const result: ReviewResult = {
    provider: "rule-based",
    model: "local-heuristics",
    summary: `PR #${report.pullRequest.number} changes ${report.pullRequest.changedFiles} files with ${findings.length} baseline finding(s).`,
    risk: riskFromFindings(findings),
    findings,
    markdown: "",
  };
  result.markdown = formatReviewMarkdown(result);
  return result;
}

export function buildReviewPrompt(
  report: PullRequestReviewReport,
  policy: ReviewPolicy = DEFAULT_REVIEW_POLICY,
): ReviewPrompt {
  return {
    system:
      "You are a senior maintainer doing a precise, high-signal pull request review. Focus on correctness, security, tests, public API, config, dependencies, and operational risk.",
    user: [
      `Review ${report.repository.fullName}#${report.pullRequest.number}: ${report.pullRequest.title}`,
      "",
      "PR metadata:",
      `- Author: ${report.pullRequest.author}`,
      `- Base: ${report.pullRequest.baseRef}`,
      `- Head: ${report.pullRequest.headRepo}:${report.pullRequest.headRef}`,
      `- Mergeable: ${report.pullRequest.mergeableState}`,
      `- Checks: ${report.checks.state}, ${report.checks.failing} failing, ${report.checks.pending} pending`,
      `- Size: ${report.pullRequest.additions} additions, ${report.pullRequest.deletions} deletions, ${report.pullRequest.changedFiles} files`,
      `- Labels: ${report.pullRequest.labels.join(", ") || "none"}`,
      "",
      "Policy gates:",
      `- Required checks: ${policy.requiredChecks}`,
      `- Max changed files: ${policy.maxChangedFiles}`,
      `- Max line delta: ${policy.maxTotalDelta}`,
      `- Required test patterns: ${policy.requiredTestPatterns.join(", ") || "none"}`,
      `- Sensitive path patterns: ${policy.sensitivePathPatterns.join(", ") || "none"}`,
      `- Forbidden workflow patterns: ${policy.forbiddenWorkflowPatterns.join(", ") || "none"}`,
      "",
      "Changed files and patch excerpts:",
      ...report.files.slice(0, 40).flatMap((file) => [
        `### ${file.filename}`,
        `status=${file.status} additions=${file.additions} deletions=${file.deletions}`,
        "```diff",
        truncate(file.patch ?? "No patch available, likely binary or too large.", 4000),
        "```",
      ]),
      "",
      "Return JSON only with this shape:",
      '{"summary":"...","risk":"critical|high|medium|low","findings":[{"severity":"critical|high|medium|low|info","category":"correctness|security|tests|api|config|dependencies|maintainability|docs","file":"path or null","title":"...","detail":"...","recommendation":"...","confidence":"high|medium|low","evidence":[{"kind":"file|patch|check|policy|git|agent","label":"...","detail":"...","file":"path or optional"}]}]}',
    ].join("\n"),
  };
}

export function parseProviderReviewJson(
  text: string,
  provider: ReviewProvider,
  model: string,
): ReviewResult {
  const parsed = JSON.parse(extractJson(text)) as {
    summary?: unknown;
    risk?: unknown;
    findings?: unknown;
  };
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.map(normalizeFinding)
    : [];
  const risk =
    typeof parsed.risk === "string" && RISKS.includes(parsed.risk as ReviewRisk)
      ? (parsed.risk as ReviewRisk)
      : riskFromFindings(findings);
  const result: ReviewResult = {
    provider,
    model,
    summary:
      typeof parsed.summary === "string"
        ? parsed.summary
        : "Provider returned no summary.",
    risk,
    findings,
    markdown: "",
    raw: text,
  };
  result.markdown = formatReviewMarkdown(result);
  return result;
}

export function formatReviewMarkdown(
  review: ReviewResult,
  title = "PR Review",
): string {
  return [
    `## ${title}`,
    "",
    `Provider: ${review.provider} (${review.model})`,
    `Risk: ${review.risk}`,
    "",
    review.summary,
    "",
    "### Findings",
    ...review.findings.map((finding, index) =>
      [
        `${index + 1}. **${finding.title}** (${finding.severity}, ${finding.category})`,
        `   - Confidence: ${finding.confidence}`,
        finding.file ? `   - File: \`${finding.file}\`` : "",
        `   - Detail: ${finding.detail}`,
        `   - Recommendation: ${finding.recommendation}`,
        finding.evidence.length
          ? [
              "   - Evidence:",
              ...finding.evidence.map((evidence) =>
                `     - ${evidence.label}: ${
                  evidence.file ? `\`${evidence.file}\` ` : ""
                }${evidence.detail}`,
              ),
            ].join("\n")
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    "",
    "_Generated by Fork Drift Sentinel._",
  ].join("\n");
}

function normalizeFinding(value: unknown): ReviewFinding {
  const record =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const severity =
    typeof record.severity === "string" &&
    SEVERITIES.includes(record.severity as ReviewSeverity)
      ? (record.severity as ReviewSeverity)
      : "high";

  return {
    severity,
    category: stringField(record.category, "review"),
    title: stringField(record.title, "Untitled finding"),
    detail: stringField(record.detail, "No detail provided."),
    recommendation: stringField(
      record.recommendation,
      "Review manually before merge.",
    ),
    file: typeof record.file === "string" && record.file ? record.file : undefined,
    confidence:
      record.confidence === "high" || record.confidence === "low"
        ? record.confidence
        : "medium",
    evidence: normalizeEvidence(record.evidence),
  };
}

function normalizeEvidence(value: unknown): ReviewFinding["evidence"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const record =
        item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const kind: ReviewFinding["evidence"][number]["kind"] =
        record.kind === "file" ||
        record.kind === "patch" ||
        record.kind === "check" ||
        record.kind === "policy" ||
        record.kind === "git" ||
        record.kind === "agent"
          ? record.kind
          : "agent";
      return {
        kind,
        label: stringField(record.label, "evidence"),
        detail: stringField(record.detail, "No detail provided."),
        file:
          typeof record.file === "string" && record.file ? record.file : undefined,
      };
    })
    .slice(0, 8);
}

function riskFromFindings(findings: ReviewFinding[]): ReviewRisk {
  if (findings.some((finding) => finding.severity === "critical")) {
    return "critical";
  }
  if (findings.some((finding) => finding.severity === "high")) {
    return "high";
  }
  if (findings.some((finding) => finding.severity === "medium")) {
    return "medium";
  }
  return "low";
}

function isSourceFile(filename: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs)$/i.test(
    filename,
  );
}

function isTestFile(filename: string): boolean {
  return /(^|\/)(__tests__|tests?|spec)\//i.test(filename) ||
    /\.(test|spec)\.(ts|tsx|js|jsx|py|go|rs)$/i.test(filename);
}

function isSecuritySensitive(filename: string, patch?: string): boolean {
  const haystack = `${filename}\n${patch ?? ""}`.toLowerCase();
  return [
    "auth",
    "secret",
    "token",
    "password",
    "webhook",
    "payment",
    "signature",
    "process.env",
    "pull_request_target",
    "route.ts",
  ].some((needle) => haystack.includes(needle));
}

function isMergeQueueAttentionState(state: string): boolean {
  return ["blocked", "behind", "dirty", "unstable"].includes(state);
}

function firstInterestingPatchLine(patch?: string): string | null {
  if (!patch) {
    return null;
  }
  return patch
    .split(/\r?\n/)
    .find((line) =>
      /auth|secret|token|password|webhook|payment|signature|process\.env|pull_request_target/i.test(
        line,
      ),
    ) ?? null;
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    return trimmed;
  }
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match) {
    return match[1].trim();
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n... truncated ...`;
}
