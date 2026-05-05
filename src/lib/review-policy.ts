import type { PullRequestReviewReport } from "./github";
import type { ReviewFinding } from "./pr-review";

export type ReviewPolicy = {
  maxChangedFiles: number;
  maxTotalDelta: number;
  requiredChecks: "passing" | "none";
  requiredTestPatterns: string[];
  sensitivePathPatterns: string[];
  forbiddenWorkflowPatterns: string[];
};

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  maxChangedFiles: 30,
  maxTotalDelta: 1200,
  requiredChecks: "none",
  requiredTestPatterns: [],
  sensitivePathPatterns: [
    "auth",
    "secret",
    "token",
    "password",
    "payment",
    "webhook",
    "signature",
  ],
  forbiddenWorkflowPatterns: ["pull_request_target"],
};

export function parseReviewPolicy(text: string): ReviewPolicy {
  const trimmed = text.trim();
  if (!trimmed) {
    return DEFAULT_REVIEW_POLICY;
  }

  try {
    return normalizePolicy(JSON.parse(trimmed) as Record<string, unknown>);
  } catch {
    return normalizePolicy(parseYamlLikePolicy(trimmed));
  }
}

export function applyPolicyReview(
  report: PullRequestReviewReport,
  policy: ReviewPolicy,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const totalDelta = report.pullRequest.additions + report.pullRequest.deletions;
  const filenames = report.files.map((file) => file.filename);

  if (policy.requiredChecks === "passing" && report.checks.state !== "passing") {
    findings.push({
      severity: "high",
      category: "policy",
      title: "Policy requires passing checks",
      detail: `Checks are ${report.checks.state}, with ${report.checks.failing} failing and ${report.checks.pending} pending.`,
      recommendation: "Wait for checks to pass or explicitly override the policy.",
      confidence: "high",
      evidence: [
        {
          kind: "check",
          label: "check-run state",
          detail: `${report.checks.state}: ${report.checks.failing} failing, ${report.checks.pending} pending`,
        },
      ],
    });
  }

  if (
    policy.requiredTestPatterns.length > 0 &&
    !filenames.some((filename) =>
      policy.requiredTestPatterns.some((pattern) => matchesPattern(filename, pattern)),
    )
  ) {
    findings.push({
      severity: "medium",
      category: "policy",
      title: "Policy test requirement is not satisfied",
      detail: `No changed file matches: ${policy.requiredTestPatterns.join(", ")}.`,
      recommendation: "Add a matching test file or document the maintainer override.",
      confidence: "high",
      evidence: [
        {
          kind: "policy",
          label: "requiredTestPatterns",
          detail: policy.requiredTestPatterns.join(", "),
        },
      ],
    });
  }

  if (report.pullRequest.changedFiles > policy.maxChangedFiles) {
    findings.push({
      severity: "medium",
      category: "policy",
      title: "Policy changed-file limit exceeded",
      detail: `${report.pullRequest.changedFiles} files changed; policy limit is ${policy.maxChangedFiles}.`,
      recommendation: "Split the PR or require an explicit maintainer override.",
      confidence: "high",
      evidence: [
        {
          kind: "policy",
          label: "maxChangedFiles",
          detail: `${report.pullRequest.changedFiles} > ${policy.maxChangedFiles}`,
        },
      ],
    });
  }

  if (totalDelta > policy.maxTotalDelta) {
    findings.push({
      severity: "medium",
      category: "policy",
      title: "Policy line-change limit exceeded",
      detail: `${totalDelta} lines changed; policy limit is ${policy.maxTotalDelta}.`,
      recommendation: "Split the PR or require deeper review.",
      confidence: "high",
      evidence: [
        {
          kind: "policy",
          label: "maxTotalDelta",
          detail: `${totalDelta} > ${policy.maxTotalDelta}`,
        },
      ],
    });
  }

  for (const file of report.files) {
    const haystack = `${file.filename}\n${file.patch ?? ""}`.toLowerCase();
    const forbidden = policy.forbiddenWorkflowPatterns.find((pattern) =>
      haystack.includes(pattern.toLowerCase()),
    );
    if (forbidden) {
      findings.push({
        severity: "critical",
        category: "policy",
        title: "Forbidden workflow pattern found",
        detail: `Pattern "${forbidden}" appears in ${file.filename}.`,
        recommendation: "Remove the pattern or require an explicit security override.",
        file: file.filename,
        confidence: "high",
        evidence: [
          {
            kind: "patch",
            label: forbidden,
            detail: snippetForPattern(file.patch ?? file.filename, forbidden),
            file: file.filename,
          },
        ],
      });
    }

    const sensitive = policy.sensitivePathPatterns.find((pattern) =>
      haystack.includes(pattern.toLowerCase()),
    );
    if (sensitive) {
      findings.push({
        severity: "medium",
        category: "policy",
        title: "Policy-sensitive path changed",
        detail: `Pattern "${sensitive}" appears in ${file.filename}.`,
        recommendation: "Review trust boundaries and tests around this change.",
        file: file.filename,
        confidence: "medium",
        evidence: [
          {
            kind: "file",
            label: sensitive,
            detail: file.filename,
            file: file.filename,
          },
        ],
      });
    }
  }

  return dedupePolicyFindings(findings);
}

function normalizePolicy(record: Record<string, unknown>): ReviewPolicy {
  return {
    maxChangedFiles: numberField(record.maxChangedFiles, DEFAULT_REVIEW_POLICY.maxChangedFiles),
    maxTotalDelta: numberField(record.maxTotalDelta, DEFAULT_REVIEW_POLICY.maxTotalDelta),
    requiredChecks:
      record.requiredChecks === "passing" ? "passing" : DEFAULT_REVIEW_POLICY.requiredChecks,
    requiredTestPatterns: stringArrayField(
      record.requiredTestPatterns,
      DEFAULT_REVIEW_POLICY.requiredTestPatterns,
    ),
    sensitivePathPatterns: stringArrayField(
      record.sensitivePathPatterns,
      DEFAULT_REVIEW_POLICY.sensitivePathPatterns,
    ),
    forbiddenWorkflowPatterns: stringArrayField(
      record.forbiddenWorkflowPatterns,
      DEFAULT_REVIEW_POLICY.forbiddenWorkflowPatterns,
    ),
  };
}

function parseYamlLikePolicy(text: string): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  let currentListKey = "";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("-") && currentListKey) {
      const values = Array.isArray(record[currentListKey])
        ? record[currentListKey] as string[]
        : [];
      values.push(line.replace(/^-\s*/, "").trim());
      record[currentListKey] = values;
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    const [, key, value] = match;
    if (!value) {
      currentListKey = key;
      record[key] = [];
      continue;
    }
    currentListKey = "";
    record[key] = /^\d+$/.test(value) ? Number(value) : value;
  }

  return record;
}

function numberField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function stringArrayField(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const strings = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return strings.length ? strings : fallback;
}

function matchesPattern(filename: string, pattern: string): boolean {
  if (pattern.startsWith("*")) {
    return filename.endsWith(pattern.slice(1));
  }
  if (pattern.endsWith("*")) {
    return filename.startsWith(pattern.slice(0, -1));
  }
  return filename.includes(pattern);
}

function snippetForPattern(text: string, pattern: string): string {
  const lines = text.split(/\r?\n/);
  return lines.find((line) => line.toLowerCase().includes(pattern.toLowerCase())) ??
    pattern;
}

function dedupePolicyFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.title}:${finding.file ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
