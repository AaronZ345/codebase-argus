import type { ReviewFinding, ReviewPrompt, ReviewResult } from "./pr-review";
import { formatReviewMarkdown } from "./pr-review";

export function buildCiLogPrompt(input: {
  log: string;
  label?: string;
}): ReviewPrompt {
  return {
    system:
      "You are reviewing a CI failure log. Identify the most likely root cause, affected files or commands, and concrete fix steps. Prefer evidence from the log over speculation. Return JSON only.",
    user: [
      `CI log: ${input.label || "unnamed"}`,
      "",
      "Log excerpt:",
      "```text",
      truncate(input.log, 12000),
      "```",
      "",
      "Return JSON only with this shape:",
      '{"summary":"...","risk":"critical|high|medium|low","findings":[{"severity":"critical|high|medium|low|info","category":"ci|tests|build|lint|security|infra|dependencies","file":"path or null","title":"...","detail":"...","recommendation":"...","confidence":"high|medium|low","evidence":[{"kind":"file|patch|check|policy|git|agent","label":"...","detail":"...","file":"path or optional"}]}]}',
    ].join("\n"),
  };
}

export function buildRuleBasedCiReview(input: {
  log: string;
  label?: string;
}): ReviewResult {
  const findings: ReviewFinding[] = [];
  const lower = input.log.toLowerCase();
  const failingLines = input.log
    .split(/\r?\n/)
    .filter((line) => /\b(fail|failed|error|exception|traceback)\b/i.test(line))
    .slice(0, 8);

  if (/\b(test|spec)\b/.test(lower) && /\b(fail|failed)\b/.test(lower)) {
    findings.push(ciFinding("tests", "Test failure detected", failingLines));
  } else if (/\b(lint|eslint|prettier|ruff|flake8)\b/.test(lower)) {
    findings.push(ciFinding("lint", "Lint failure detected", failingLines));
  } else if (/\b(build|compile|typescript|tsc|webpack|next build)\b/.test(lower)) {
    findings.push(ciFinding("build", "Build failure detected", failingLines));
  } else {
    findings.push(ciFinding("ci", "CI failure needs root-cause review", failingLines));
  }

  const result: ReviewResult = {
    provider: "rule-based",
    model: "local-ci-heuristics",
    summary: `${input.label || "CI log"} produced ${findings.length} finding(s).`,
    risk: findings.some((finding) => finding.severity === "high")
      ? "high"
      : "medium",
    findings,
    markdown: "",
  };
  result.markdown = formatCiReviewMarkdown(result);
  return result;
}

export function formatCiReviewMarkdown(review: ReviewResult): string {
  if (review.markdown.startsWith("## CI Failure Review")) {
    return review.markdown;
  }
  if (review.markdown.trim()) {
    return `## CI Failure Review\n\n${review.markdown.trim()}`;
  }
  return formatReviewMarkdown(review, "CI Failure Review");
}

function ciFinding(
  category: ReviewFinding["category"],
  title: string,
  lines: string[],
): ReviewFinding {
  return {
    severity: "high",
    category,
    title,
    detail: lines[0] || "The log contains failure indicators.",
    recommendation:
      "Use the cited log lines to identify the failing command, then rerun that command locally after applying a focused fix.",
    confidence: lines.length ? "medium" : "low",
    evidence: (lines.length ? lines : ["No compact failure line found."]).map(
      (line) => ({
        kind: "check" as const,
        label: "log line",
        detail: truncate(line.trim(), 500),
      }),
    ),
  };
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n... truncated ...`;
}
