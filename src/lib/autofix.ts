import type { PullRequestReviewReport } from "./github";
import type { ReviewResult } from "./pr-review";

export type AutofixLaneKind =
  | "lockfile-refresh"
  | "snapshot-refresh"
  | "format-refresh";

export type AutofixLane = {
  kind: AutofixLaneKind;
  title: string;
  files: string[];
  commands: string[];
  verify: string[];
};

export type AutofixPlan = {
  branch: string;
  summary: string;
  lanes: AutofixLane[];
  markdown: string;
};

export function buildAutofixPlan(input: {
  report: PullRequestReviewReport;
  review: ReviewResult;
}): AutofixPlan {
  const branch = `fds/autofix-pr-${input.report.pullRequest.number}`;
  const lanes = [
    buildLockfileLane(input.report, input.review),
    buildSnapshotLane(input.report, input.review),
    buildFormatLane(input.report, input.review),
  ].filter((lane): lane is AutofixLane => Boolean(lane));

  const plan: AutofixPlan = {
    branch,
    summary: lanes.length
      ? `Prepared ${lanes.length} gated autofix lane(s) for PR #${input.report.pullRequest.number}.`
      : `No narrow autofix lane matched PR #${input.report.pullRequest.number}.`,
    lanes,
    markdown: "",
  };
  plan.markdown = formatAutofixPlan(plan, input.report);
  return plan;
}

function buildLockfileLane(
  report: PullRequestReviewReport,
  review: ReviewResult,
): AutofixLane | null {
  const files = report.files
    .map((file) => file.filename)
    .filter((file) => /(^|\/)(package-lock\.json|npm-shrinkwrap\.json)$/.test(file));
  if (!files.length || !hasFinding(review, "dependencies", files)) {
    return null;
  }
  return {
    kind: "lockfile-refresh",
    title: "Refresh npm lockfile",
    files,
    commands: ["npm install --package-lock-only"],
    verify: ["npm test"],
  };
}

function buildSnapshotLane(
  report: PullRequestReviewReport,
  review: ReviewResult,
): AutofixLane | null {
  const files = report.files
    .map((file) => file.filename)
    .filter((file) => /(^|\/)__snapshots__\/|\.snap$/i.test(file));
  if (!files.length || !hasFinding(review, "tests", files)) {
    return null;
  }
  return {
    kind: "snapshot-refresh",
    title: "Refresh test snapshots",
    files,
    commands: ["npm test -- -u"],
    verify: ["npm test"],
  };
}

function buildFormatLane(
  report: PullRequestReviewReport,
  review: ReviewResult,
): AutofixLane | null {
  const files = review.findings
    .filter((finding) => /lint|format|prettier/i.test(`${finding.category} ${finding.title}`))
    .flatMap((finding) => finding.file ? [finding.file] : [])
    .filter((file) => report.files.some((changed) => changed.filename === file));
  if (!files.length) {
    return null;
  }
  return {
    kind: "format-refresh",
    title: "Apply formatter or lint fixer",
    files: Array.from(new Set(files)),
    commands: ["npm run lint -- --fix"],
    verify: ["npm run lint", "npm test"],
  };
}

function hasFinding(
  review: ReviewResult,
  category: string,
  files: string[],
): boolean {
  return review.findings.some((finding) =>
    finding.category === category ||
    (finding.file ? files.includes(finding.file) : false),
  );
}

function formatAutofixPlan(plan: AutofixPlan, report: PullRequestReviewReport): string {
  return [
    "## Autofix Plan",
    "",
    plan.summary,
    "",
    "### Branch",
    "",
    "```bash",
    `git fetch origin pull/${report.pullRequest.number}/head`,
    `git switch -c ${plan.branch} FETCH_HEAD`,
    "```",
    "",
    "### Lanes",
    plan.lanes.length
      ? plan.lanes.map(formatLane).join("\n\n")
      : "No deterministic lane matched. Use the review findings as a manual checklist.",
    "",
    "### Finish",
    "",
    "```bash",
    "git diff --check",
    "git status --short",
    `git push origin ${plan.branch}`,
    "```",
    "",
    `After verification passes, push the autofix branch and open a PR back to \`${report.pullRequest.headRef}\`.`,
  ].join("\n");
}

function formatLane(lane: AutofixLane): string {
  return [
    `#### ${lane.title}`,
    "",
    `Files: ${lane.files.map((file) => `\`${file}\``).join(", ")}`,
    "",
    "```bash",
    ...lane.commands,
    ...lane.verify,
    "```",
  ].join("\n");
}
