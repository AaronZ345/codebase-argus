import type { LocalAnalysisReport } from "./local-analyzer";
import type {
  ReviewFinding,
  ReviewPrompt,
  ReviewResult,
  ReviewRisk,
} from "./pr-review";
import { formatReviewMarkdown } from "./pr-review";

export function buildRuleBasedDriftReview(
  report: LocalAnalysisReport,
): ReviewResult {
  const findings: ReviewFinding[] = [];

  if (
    !report.mergeTree.clean ||
    report.rebaseSimulation.conflictFiles.length > 0
  ) {
    const files = Array.from(
      new Set([
        ...report.mergeTree.conflictFiles,
        ...report.rebaseSimulation.conflictFiles,
      ]),
    );
    findings.push({
      severity: "high",
      category: "integration",
      title: "Upstream integration has projected conflicts",
      detail: `${files.length} file(s) conflict when the fork is integrated with upstream by merge or rebase.`,
      recommendation:
        "Use a multi-agent review before resolving conflicts, then run tests before any push.",
      file: files[0],
      confidence: "high",
      evidence: files.slice(0, 6).map((file) => ({
        kind: "git" as const,
        label: "conflict file",
        detail: file,
        file,
      })),
    });
  }

  if (report.compare.behindBy > 0) {
    findings.push({
      severity: report.compare.behindBy >= 25 ? "medium" : "low",
      category: "drift",
      title: "Fork is behind upstream",
      detail: `${report.fork.repo} is ${report.compare.behindBy} commit(s) behind ${report.upstream.repo}.`,
      recommendation:
        "Review upstream changes before choosing merge or rebase as the integration path.",
      confidence: "high",
      evidence: [
        {
          kind: "git",
          label: "behind/ahead",
          detail: `${report.compare.behindBy} behind, ${report.compare.aheadBy} ahead`,
        },
      ],
    });
  }

  if (report.cherry.covered.length > 0) {
    findings.push({
      severity: "low",
      category: "cleanup",
      title: "Patch-equivalent fork commits may be removable",
      detail: `${report.cherry.covered.length} fork commit(s) appear patch-equivalent to upstream.`,
      recommendation:
        "Ask an agent to verify the covered commits before dropping or rewriting them.",
      confidence: "medium",
      evidence: report.cherry.covered.slice(0, 5).map((commit) => ({
        kind: "git" as const,
        label: "covered commit",
        detail: `${commit.sha.slice(0, 8)} ${commit.subject}`,
      })),
    });
  }

  if (report.cherry.unique.length > 0) {
    findings.push({
      severity: "medium",
      category: "downstream",
      title: "Unique fork commits need an explicit keep/upstream decision",
      detail: `${report.cherry.unique.length} commit(s) remain unique to the fork.`,
      recommendation:
        "Classify each unique commit as keep, upstream later, or drop after agent and human review.",
      confidence: "medium",
      evidence: report.cherry.unique.slice(0, 5).map((commit) => ({
        kind: "git" as const,
        label: "unique commit",
        detail: `${commit.sha.slice(0, 8)} ${commit.subject}`,
      })),
    });
  }

  if (!findings.length) {
    findings.push({
      severity: "info",
      category: "integration",
      title: "No obvious downstream integration risk found",
      detail:
        "The local git checks did not report drift, conflicts, or unique fork commits.",
      recommendation:
        "Still run the project test suite before merging or rebasing upstream.",
      confidence: "low",
      evidence: [
        {
          kind: "git",
          label: "local analysis",
          detail: "merge-tree, rebase simulation, cherry, and range-diff were clean.",
        },
      ],
    });
  }

  const result: ReviewResult = {
    provider: "rule-based",
    model: "local-drift-heuristics",
    summary: `${report.fork.repo} is ${report.compare.behindBy} behind and ${report.compare.aheadBy} ahead of ${report.upstream.repo}.`,
    risk: riskFromFindings(findings),
    findings,
    markdown: "",
  };
  result.markdown = formatDriftReviewMarkdown(result);
  return result;
}

export function buildDriftPrompt(report: LocalAnalysisReport): ReviewPrompt {
  return {
    system:
      "You are reviewing a long-lived downstream fork before it integrates upstream changes. Give a precise, evidence-first review for both merge-upstream and rebase-upstream paths. Focus on conflicts, semantic patch drift, patch-equivalent cleanup, unique downstream commits, test gates, and whether another agent should re-check risky files.",
    user: [
      `Review downstream fork integration for ${report.fork.repo}.`,
      "",
      "Repositories:",
      `- Upstream: ${report.upstream.repo} branch ${report.upstream.branch} (${report.upstream.gitRef})`,
      `- Fork: ${report.fork.repo} branch ${report.fork.branch} (${report.fork.gitRef})`,
      `- Drift: ${report.compare.behindBy} behind, ${report.compare.aheadBy} ahead`,
      "",
      "Merge upstream evidence:",
      `- merge-tree clean: ${String(report.mergeTree.clean)}`,
      `- conflict files: ${report.mergeTree.conflictFiles.join(", ") || "none"}`,
      `- messages: ${report.mergeTree.messages.slice(0, 12).join(" | ") || "none"}`,
      "",
      "Rebase simulation evidence:",
      `- clean: ${String(report.rebaseSimulation.clean)}`,
      `- conflict files: ${report.rebaseSimulation.conflictFiles.join(", ") || "none"}`,
      `- status: ${report.rebaseSimulation.statusLines.slice(0, 20).join(" | ") || "none"}`,
      `- log: ${report.rebaseSimulation.logLines.slice(0, 20).join(" | ") || "none"}`,
      "",
      "Patch evidence:",
      `- patch-equivalent covered commits: ${report.cherry.covered.length}`,
      ...report.cherry.covered
        .slice(0, 20)
        .map((commit) => `  - ${commit.sha.slice(0, 12)} ${commit.subject}`),
      `- unique fork commits: ${report.cherry.unique.length}`,
      ...report.cherry.unique
        .slice(0, 30)
        .map((commit) => `  - ${commit.sha.slice(0, 12)} ${commit.subject}`),
      "",
      "Range-diff:",
      `- added: ${report.rangeDiff.summary.added}`,
      `- removed: ${report.rangeDiff.summary.removed}`,
      `- changed: ${report.rangeDiff.summary.changed}`,
      "```",
      truncate(report.rangeDiff.lines.slice(0, 80).join("\n") || "No range-diff output.", 8000),
      "```",
      "",
      "Gated runbook candidates:",
      "Inspect:",
      ...report.runbooks.inspect.map((command) => `- ${command}`),
      "Prepare:",
      ...report.runbooks.prepare.map((command) => `- ${command}`),
      "Execute:",
      ...report.runbooks.execute.map((command) => `- ${command}`),
      "",
      "Return JSON only with this shape:",
      '{"summary":"...","risk":"critical|high|medium|low","findings":[{"severity":"critical|high|medium|low|info","category":"integration|conflict|cleanup|downstream|tests|security|maintainability","file":"path or null","title":"...","detail":"...","recommendation":"...","confidence":"high|medium|low","evidence":[{"kind":"file|patch|check|policy|git|agent","label":"...","detail":"...","file":"path or optional"}]}]}',
    ].join("\n"),
  };
}

export function formatDriftReviewMarkdown(review: ReviewResult): string {
  return formatReviewMarkdown(review, "Fork Drift Review");
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

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n... truncated ...`;
}
