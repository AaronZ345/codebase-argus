export type RunbookMode = "inspect" | "prepare" | "execute";

export type RunbookContext = {
  upstream: {
    repo: string;
    branch: string;
  };
  fork: {
    repo: string;
    branch: string;
  };
};

export type RunbookModes = Record<RunbookMode, string[]>;

export type WorkflowCommit = {
  sha: string;
  subject: string;
};

export type WorkflowConflictReport = {
  compare: {
    aheadBy: number;
    behindBy: number;
  };
  mergeTree: {
    clean: boolean;
    conflictFiles: string[];
    messages: string[];
  };
  cherry: {
    covered: WorkflowCommit[];
    unique: WorkflowCommit[];
  };
  runbooks: RunbookModes;
  rangeDiff?: {
    summary: {
      added: number;
      removed: number;
      changed: number;
    };
    lines: string[];
  };
};

export type ConflictDossier = {
  risk: "clean" | "conflict";
  summary: string;
  files: Array<{
    path: string;
    risk: "low" | "medium" | "high";
    reason: string;
  }>;
  instructions: string[];
};

export type AgentLogSummary = {
  backupCreated: boolean;
  fetched: boolean;
  rebaseAttempted: boolean;
  conflicts: string[];
  testsPassed: boolean;
  testsFailed: boolean;
  pushed: boolean;
  safeToPush: boolean;
  notes: string[];
};

export type GitHubActionsWorkflowInput = {
  upstream: string;
  fork: string;
  prHead?: string;
  upstreamBranch: string;
  forkBranch: string;
  scheduleCron?: string;
  issueNumber?: string;
};

export type PullRequestReviewWorkflowInput = {
  reviewEndpoint?: string;
  provider?: string;
  policyPath?: string;
};

export type AgentTaskPackageInput = {
  upstream: string;
  fork: string;
  upstreamBranch: string;
  forkBranch: string;
  mode: RunbookMode;
  generatedAt?: string;
  report?: WorkflowConflictReport | null;
};

export function buildRunbookModes(context: RunbookContext): RunbookModes {
  const upstreamUrl = githubCloneUrl(context.upstream.repo);
  const forkUrl = githubCloneUrl(context.fork.repo);
  const localBranch = `local/rebase-${context.fork.branch.replaceAll("/", "-")}`;
  const backupBranch = "backup/fork-drift-before-rebase-$(date +%Y%m%d-%H%M%S)";

  const inspect = [
    `git remote add upstream ${upstreamUrl} 2>/dev/null || git remote set-url upstream ${upstreamUrl}`,
    `git remote add fork ${forkUrl} 2>/dev/null || git remote set-url fork ${forkUrl}`,
    `git fetch --prune upstream ${context.upstream.branch}`,
    `git fetch --prune fork ${context.fork.branch}`,
    `git rev-list --left-right --count upstream/${context.upstream.branch}...fork/${context.fork.branch}`,
    `git merge-tree --write-tree --name-only upstream/${context.upstream.branch} fork/${context.fork.branch}`,
    `git cherry -v upstream/${context.upstream.branch} fork/${context.fork.branch}`,
  ];

  const prepare = [
    ...inspect,
    `git branch ${backupBranch} fork/${context.fork.branch}`,
    `git switch -C ${localBranch} fork/${context.fork.branch}`,
  ];

  const execute = [
    ...prepare,
    `git rebase upstream/${context.upstream.branch}`,
    `npm run lint && npm run build`,
    `git status --short --branch`,
    `git push --force-with-lease fork HEAD:${context.fork.branch}`,
  ];

  return { inspect, prepare, execute };
}

export function buildConflictDossier(
  report: WorkflowConflictReport,
): ConflictDossier {
  if (report.mergeTree.clean) {
    return {
      risk: "clean",
      summary: `Clean projection: ${report.compare.behindBy} behind and ${report.compare.aheadBy} ahead.`,
      files: [],
      instructions: [
        "Proceed with inspect or prepare mode first.",
        "Create a backup branch before any rebase.",
        "Run tests before force-with-lease push.",
      ],
    };
  }

  return {
    risk: "conflict",
    summary: `${report.mergeTree.conflictFiles.length} conflict file(s) need manual resolution before rebase can be trusted.`,
    files: report.mergeTree.conflictFiles.map((file) => ({
      path: file,
      risk: classifyConflictFile(file),
      reason: conflictReason(file),
    })),
    instructions: [
      "Stop before push.",
      "Resolve only the listed conflict files.",
      "Do not reformat unrelated files.",
      "After resolving, run merge/rebase tests and paste the agent log back into this tool.",
    ],
  };
}

export function buildAgentPrompt(input: {
  upstream: string;
  fork: string;
  upstreamBranch: string;
  forkBranch: string;
  mode: RunbookMode;
  report?: WorkflowConflictReport | null;
}): string {
  const runbooks = input.report?.runbooks ?? buildRunbookModes({
    upstream: { repo: input.upstream, branch: input.upstreamBranch },
    fork: { repo: input.fork, branch: input.forkBranch },
  });
  const dossier = input.report ? buildConflictDossier(input.report) : null;
  const commands = runbooks[input.mode];

  return [
    "You are maintaining a long-lived GitHub fork.",
    "",
    `Upstream: ${input.upstream} (${input.upstreamBranch})`,
    `Fork: ${input.fork} (${input.forkBranch})`,
    `Mode: ${input.mode}`,
    "",
    "Rules:",
    "- Create or verify a backup branch before any history rewrite.",
    "- Do not push, close PRs, delete branches, or rewrite unrelated files unless explicitly authorized.",
    "- If conflicts appear, list files and stop for human confirmation.",
    "- If tests fail, report the failing command and stop.",
    "",
    dossier ? `Risk summary: ${dossier.summary}` : "Risk summary: not computed.",
    "",
    "Commands:",
    ...commands.map((command, index) => `${index + 1}. ${command}`),
    "",
    "Return a concise execution log with: fetched refs, backup branch, conflict files, tests run, final branch status, and whether push is safe.",
  ].join("\n");
}

export function buildGitHubActionsWorkflow(
  input: GitHubActionsWorkflowInput,
): string {
  const scheduleCron = input.scheduleCron?.trim() || "17 1 * * *";
  const issueNumber = input.issueNumber?.trim() || "";
  const prHead = input.prHead?.trim() || input.fork;
  const fromInputOrDefault = (name: string) =>
    githubExpression(`github.event.inputs.${name} || env.DEFAULT_${name.toUpperCase()}`);

  return [
    "name: Fork Drift Sentinel",
    "",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      upstream_repo:",
    "        description: Upstream repository as owner/repo",
    `        default: ${yamlDoubleQuoted(input.upstream)}`,
    "        required: true",
    "      fork_repo:",
    "        description: Fork repository as owner/repo",
    `        default: ${yamlDoubleQuoted(input.fork)}`,
    "        required: true",
    "      pr_head_repo:",
    "        description: PR head repository as owner/repo",
    `        default: ${yamlDoubleQuoted(prHead)}`,
    "        required: true",
    "      upstream_branch:",
    "        description: Upstream branch to compare",
    `        default: ${yamlDoubleQuoted(input.upstreamBranch)}`,
    "        required: true",
    "      fork_branch:",
    "        description: Fork branch to compare",
    `        default: ${yamlDoubleQuoted(input.forkBranch)}`,
    "        required: true",
    "  schedule:",
    `    - cron: ${yamlDoubleQuoted(scheduleCron)}`,
    "  repository_dispatch:",
    "    types: [upstream-updated]",
    "",
    "permissions:",
    "  contents: read",
    "  issues: write",
    "",
    "jobs:",
    "  drift-report:",
    "    runs-on: ubuntu-latest",
    "    env:",
    `      DEFAULT_UPSTREAM_REPO: ${yamlDoubleQuoted(input.upstream)}`,
    `      DEFAULT_FORK_REPO: ${yamlDoubleQuoted(input.fork)}`,
    `      DEFAULT_PR_HEAD_REPO: ${yamlDoubleQuoted(prHead)}`,
    `      DEFAULT_UPSTREAM_BRANCH: ${yamlDoubleQuoted(input.upstreamBranch)}`,
    `      DEFAULT_FORK_BRANCH: ${yamlDoubleQuoted(input.forkBranch)}`,
    `      DRIFT_REPORT_ISSUE: ${yamlDoubleQuoted(issueNumber)}`,
    "    steps:",
    "      - name: Generate drift report",
    "        shell: bash",
    "        env:",
    `          GH_TOKEN: ${githubExpression("github.token")}`,
    "        run: |",
    "          set -euo pipefail",
    `          upstream="${fromInputOrDefault("upstream_repo")}"`,
    `          fork="${fromInputOrDefault("fork_repo")}"`,
    `          pr_head="${fromInputOrDefault("pr_head_repo")}"`,
    `          upstream_branch="${fromInputOrDefault("upstream_branch")}"`,
    `          fork_branch="${fromInputOrDefault("fork_branch")}"`,
    "          workdir=\"$(mktemp -d)\"",
    "          trap 'rm -rf \"$workdir\"' EXIT",
    "          repo_dir=\"$workdir/drift.git\"",
    "          report=\"$workdir/fork-drift-report.md\"",
    "          git init --bare \"$repo_dir\" >/dev/null",
    "          git -C \"$repo_dir\" remote add upstream \"https://github.com/${upstream}.git\"",
    "          git -C \"$repo_dir\" remote add fork \"https://github.com/${fork}.git\"",
    "          git -C \"$repo_dir\" fetch --prune upstream \"+refs/heads/${upstream_branch}:refs/remotes/upstream/${upstream_branch}\"",
    "          git -C \"$repo_dir\" fetch --prune fork \"+refs/heads/${fork_branch}:refs/remotes/fork/${fork_branch}\"",
    "          upstream_ref=\"refs/remotes/upstream/${upstream_branch}\"",
    "          fork_ref=\"refs/remotes/fork/${fork_branch}\"",
    "          read -r behind ahead < <(git -C \"$repo_dir\" rev-list --left-right --count \"$upstream_ref...$fork_ref\")",
    "          merge_exit=0",
    "          git -C \"$repo_dir\" merge-tree --write-tree --name-only \"$upstream_ref\" \"$fork_ref\" > \"$workdir/merge-tree.txt\" 2>&1 || merge_exit=$?",
    "          # Patch evidence uses git cherry -v and git range-diff --no-color.",
    "          git -C \"$repo_dir\" cherry -v \"$upstream_ref\" \"$fork_ref\" > \"$workdir/cherry.txt\" || true",
    "          git -C \"$repo_dir\" range-diff --no-color \"$upstream_ref...$fork_ref\" > \"$workdir/range-diff.txt\" 2>&1 || true",
    "          covered=$(grep -c '^-' \"$workdir/cherry.txt\" || true)",
    "          unique=$(grep -c '^+' \"$workdir/cherry.txt\" || true)",
    "          changed=$(grep -cE '^[[:space:]]*[0-9-]+:.* ! ' \"$workdir/range-diff.txt\" || true)",
    "          conflict_files=$(tail -n +2 \"$workdir/merge-tree.txt\" | sed '/^$/,$d' || true)",
    "          {",
    "            echo '# Fork Drift Report'",
    "            echo",
    "            echo \"Generated: $(date -u +'%Y-%m-%dT%H:%M:%SZ')\"",
    "            echo",
    "            echo \"- Upstream: \\`$upstream\\` branch \\`$upstream_branch\\`\"",
    "            echo \"- Fork: \\`$fork\\` branch \\`$fork_branch\\`\"",
    "            echo \"- PR head repo: \\`$pr_head\\`\"",
    "            echo \"- Drift: $behind behind, $ahead ahead\"",
    "            echo \"- Patch evidence: $covered covered, $unique unique, $changed changed\"",
    "            echo",
    "            if [[ \"$merge_exit\" -eq 0 ]]; then",
    "              echo '## Rebase risk'",
    "              echo 'Clean projection from git merge-tree.'",
    "            else",
    "              echo '## Rebase risk'",
    "              echo 'Potential conflicts from git merge-tree:'",
    "              echo",
    "              if [[ -n \"$conflict_files\" ]]; then",
    "                while IFS= read -r file; do",
    "                  [[ -n \"$file\" ]] && echo \"- \\`$file\\`\"",
    "                done <<< \"$conflict_files\"",
    "              else",
    "                echo '- merge-tree returned non-zero; inspect raw output below.'",
    "              fi",
    "            fi",
    "            echo",
    "            echo '## Covered commits'",
    "            grep '^-' \"$workdir/cherry.txt\" | head -20 | sed 's/^/- /' || true",
    "            echo",
    "            echo '## Unique commits'",
    "            grep '^+' \"$workdir/cherry.txt\" | head -20 | sed 's/^/- /' || true",
    "            echo",
    "            echo '## Range-diff excerpt'",
    "            echo '```'",
    "            sed -n '1,80p' \"$workdir/range-diff.txt\"",
    "            echo '```'",
    "          } > \"$report\"",
    "          cat \"$report\" >> \"$GITHUB_STEP_SUMMARY\"",
    "          if [[ -n \"$DRIFT_REPORT_ISSUE\" ]]; then",
    "            gh issue comment \"$DRIFT_REPORT_ISSUE\" --repo \"$fork\" --body-file \"$report\"",
    "          fi",
    "",
  ].join("\n");
}

export function buildPullRequestReviewWorkflow(
  input: PullRequestReviewWorkflowInput = {},
): string {
  const endpoint = input.reviewEndpoint?.trim() || "";
  const provider = input.provider?.trim() || "openai-api";
  const policyPath = input.policyPath?.trim() || ".fork-drift-sentinel.yml";

  return [
    "name: Fork Drift Sentinel PR Review",
    "",
    "on:",
    "  pull_request:",
    "    types: [opened, synchronize, reopened, ready_for_review]",
    "",
    "permissions:",
    "  contents: read",
    "  pull-requests: read",
    "  issues: write",
    "",
    "jobs:",
    "  review:",
    "    runs-on: ubuntu-latest",
    "    env:",
    `      FDS_REVIEW_ENDPOINT: ${yamlDoubleQuoted(endpoint)}`,
    `      FDS_REVIEW_PROVIDER: ${yamlDoubleQuoted(provider)}`,
    `      FDS_POLICY_PATH: ${yamlDoubleQuoted(policyPath)}`,
    "    steps:",
    "      - name: Build PR review payload",
    "        id: payload",
    "        uses: actions/github-script@v7",
    "        with:",
    "          script: |",
    "            const pr = context.payload.pull_request;",
    "            const files = await github.paginate(github.rest.pulls.listFiles, {",
    "              owner: context.repo.owner,",
    "              repo: context.repo.repo,",
    "              pull_number: pr.number,",
    "              per_page: 100,",
    "            });",
    "            const forbidden = files.filter((file) =>",
    "              file.filename.startsWith('.github/workflows/') &&",
    "              String(file.patch || '').includes('pull_request_target')",
    "            );",
    "            const source = files.filter((file) => /\\.(ts|tsx|js|jsx|py|go|rs)$/.test(file.filename));",
    "            const tests = files.filter((file) => /(test|spec|__tests__)/i.test(file.filename));",
    "            const baseline = [];",
    "            if (forbidden.length) baseline.push(`Critical: pull_request_target appears in ${forbidden.map(f => f.filename).join(', ')}`);",
    "            if (source.length && !tests.length) baseline.push('Medium: source changed without obvious test files.');",
    "            const body = baseline.length ? baseline.join('\\n') : 'No baseline policy findings.';",
    "            core.setOutput('baseline', body);",
    "            core.setOutput('payload', JSON.stringify({",
    "              provider: process.env.FDS_REVIEW_PROVIDER,",
    "              policyPath: process.env.FDS_POLICY_PATH,",
    "              repository: `${context.repo.owner}/${context.repo.repo}`,",
    "              pullRequest: {",
    "                number: pr.number,",
    "                title: pr.title,",
    "                head: pr.head.ref,",
    "                base: pr.base.ref,",
    "              },",
    "              files: files.slice(0, 100).map((file) => ({",
    "                filename: file.filename,",
    "                status: file.status,",
    "                additions: file.additions,",
    "                deletions: file.deletions,",
    "                patch: file.patch || '',",
    "              })),",
    "            }));",
    "",
    "      - name: Dispatch to Fork Drift Sentinel endpoint",
    "        id: remote",
    "        if: env.FDS_REVIEW_ENDPOINT != ''",
    "        shell: bash",
    "        run: |",
    "          set -euo pipefail",
    "          payload='${{ steps.payload.outputs.payload }}'",
    "          curl -fsS -X POST \"$FDS_REVIEW_ENDPOINT\" \\",
    "            -H 'content-type: application/json' \\",
    "            --data \"$payload\" > review.json",
    "          jq -r '.markdown // .summary // \"Remote review returned no markdown.\"' review.json > review.md",
    "",
    "      - name: Comment review summary",
    "        uses: actions/github-script@v7",
    "        with:",
    "          script: |",
    "            const fs = require('fs');",
    "            const remote = process.env.FDS_REVIEW_ENDPOINT ? fs.readFileSync('review.md', 'utf8') : '';",
    "            const baseline = `${{ steps.payload.outputs.baseline }}`;",
    "            const body = remote || `## PR Review\\n\\n${baseline}\\n\\n_Generated by Fork Drift Sentinel baseline guard._`;",
    "            await github.rest.issues.createComment({",
    "              owner: context.repo.owner,",
    "              repo: context.repo.repo,",
    "              issue_number: context.payload.pull_request.number,",
    "              body,",
    "            });",
    "",
  ].join("\n");
}

export function buildAgentTaskPackage(input: AgentTaskPackageInput): string {
  const runbooks =
    input.report?.runbooks ??
    buildRunbookModes({
      upstream: { repo: input.upstream, branch: input.upstreamBranch },
      fork: { repo: input.fork, branch: input.forkBranch },
    });
  const dossier = input.report ? buildConflictDossier(input.report) : null;
  const risk = dossier?.risk ?? "not computed";
  const taskId = stableTaskId(input.fork, input.forkBranch, input.mode);
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const commands = runbooks[input.mode];
  const evidence = input.report
    ? [
        `- Covered commits: ${input.report.cherry.covered.length}`,
        `- Unique commits: ${input.report.cherry.unique.length}`,
        `- Range-diff added patches: ${input.report.rangeDiff?.summary.added ?? 0}`,
        `- Range-diff removed patches: ${input.report.rangeDiff?.summary.removed ?? 0}`,
        `- Range-diff changed patches: ${input.report.rangeDiff?.summary.changed ?? 0}`,
      ]
    : ["- Local git evidence has not been computed yet."];
  const conflictFiles = dossier?.files.length
    ? dossier.files.map(
        (file) => `- \`${file.path}\` (${file.risk}): ${file.reason}`,
      )
    : ["- None reported."];

  return [
    "# Fork Drift Agent Task Package",
    "",
    `Task ID: \`${taskId}\``,
    `Generated: ${generatedAt}`,
    `Mode: ${input.mode}`,
    `Risk: ${risk}`,
    "",
    "## Mission",
    `Bring \`${input.fork}\` branch \`${input.forkBranch}\` up to date with \`${input.upstream}\` branch \`${input.upstreamBranch}\` using the selected gated mode.`,
    "",
    "## Inputs",
    `- Upstream: \`${input.upstream}\``,
    `- Upstream branch: \`${input.upstreamBranch}\``,
    `- Fork: \`${input.fork}\``,
    `- Fork branch: \`${input.forkBranch}\``,
    "",
    "## Risk summary",
    dossier ? dossier.summary : "Run local risk analysis before prepare or execute mode.",
    "",
    "## Conflict dossier",
    ...conflictFiles,
    "",
    "## Patch evidence",
    ...evidence,
    "",
    "## Forbidden actions",
    "- Do not push unless the mode is execute and every acceptance gate is satisfied.",
    "- Do not close pull requests, delete branches, or rewrite unrelated files.",
    "- Do not resolve files outside the conflict dossier without explicit approval.",
    "- Do not continue after conflicts, failed tests, missing backup, or unexpected remote state.",
    "",
    "## Command plan",
    ...commands.map((command, index) => `${index + 1}. \`${command}\``),
    "",
    "## Acceptance checklist",
    "- Fetch commands completed for upstream and fork.",
    "- Backup branch was created or verified before history rewrite.",
    "- Rebase was attempted only in prepare or execute mode.",
    "- Conflict files are empty, or the run stopped before push.",
    "- Required tests/build commands were run and passed.",
    "- Final branch status was recorded.",
    "- Push safety was explicitly assessed before any force-with-lease.",
    "",
    "## Return log format",
    "```text",
    "Fetched refs:",
    "Backup branch:",
    "Rebase command and result:",
    "Conflict files:",
    "Tests/build commands and results:",
    "Final git status:",
    "Push attempted: yes/no",
    "Safe to push: yes/no, with reason",
    "```",
    "",
  ].join("\n");
}

export function parseAgentSessionLog(text: string): AgentLogSummary {
  const lower = text.toLowerCase();
  const conflictFiles = Array.from(
    new Set(
      Array.from(text.matchAll(/CONFLICT[^\n]* in ([^\s]+)/g), (match) =>
        match[1].trim(),
      ),
    ),
  );
  const testsFailed =
    /\b(fail|failed|error|exit status [1-9]|npm err)\b/i.test(text) &&
    /\b(test|lint|build|rebase)\b/i.test(text);
  const testsPassed =
    /\b(ok|pass|passed|compiled successfully|lint.*0 problems)\b/i.test(text) &&
    !testsFailed;
  const pushed = /push(ed)?\b|force-with-lease/i.test(text);
  const backupCreated = /backup\/|backup branch|created backup/i.test(text);
  const fetched = /\bfetch(ed)?\b|remote update/i.test(text);
  const rebaseAttempted =
    /\bgit\s+rebase\b|\brebasing\b|\bsuccessfully rebased\b/i.test(text);
  const safeToPush =
    fetched &&
    backupCreated &&
    rebaseAttempted &&
    testsPassed &&
    !testsFailed &&
    conflictFiles.length === 0 &&
    !pushed;

  return {
    backupCreated,
    fetched,
    rebaseAttempted,
    conflicts: conflictFiles,
    testsPassed,
    testsFailed,
    pushed,
    safeToPush,
    notes: buildLogNotes({
      lower,
      backupCreated,
      conflictFiles,
      fetched,
      rebaseAttempted,
      testsFailed,
      testsPassed,
      pushed,
      safeToPush,
    }),
  };
}

export function parseRangeDiffSummary(stdout: string): {
  summary: {
    added: number;
    removed: number;
    changed: number;
  };
  lines: string[];
} {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  return {
    summary: {
      added: lines.filter((line) => line.includes(" -------- > ")).length,
      removed: lines.filter((line) => line.includes(" <  -:  --------")).length,
      changed: lines.filter((line) => /!\s+/.test(line)).length,
    },
    lines: lines.slice(0, 80),
  };
}

function buildLogNotes(input: {
  lower: string;
  backupCreated: boolean;
  conflictFiles: string[];
  fetched: boolean;
  rebaseAttempted: boolean;
  testsFailed: boolean;
  testsPassed: boolean;
  pushed: boolean;
  safeToPush: boolean;
}): string[] {
  const notes: string[] = [];
  if (input.conflictFiles.length) {
    notes.push("Conflicts were reported; stop before push.");
  }
  if (!input.fetched) {
    notes.push("No fetch signal found.");
  }
  if (!input.backupCreated) {
    notes.push("No backup branch signal found.");
  }
  if (!input.rebaseAttempted) {
    notes.push("No rebase attempt found.");
  }
  if (input.testsFailed) {
    notes.push("A test/build/rebase failure appears in the log.");
  }
  if (!input.testsPassed) {
    notes.push("No passing test/build signal found.");
  }
  if (input.testsPassed) {
    notes.push("The log contains a passing test/build signal.");
  }
  if (input.pushed) {
    notes.push("The log appears to include a push; verify remote state manually.");
  } else if (input.safeToPush) {
    notes.push("Fetch, backup, rebase, and passing tests were all detected.");
  }
  if (input.lower.includes("nothing to commit")) {
    notes.push("Working tree may be clean at the end of the run.");
  }
  if (!notes.length) {
    notes.push("No strong signal found; inspect the raw log manually.");
  }
  return notes;
}

function classifyConflictFile(file: string): "low" | "medium" | "high" {
  if (/\.(md|txt|rst)$/.test(file) || file.includes("tsbuildinfo")) {
    return "low";
  }
  if (/lock|package-lock|go\.sum|yarn\.lock|pnpm-lock/.test(file)) {
    return "medium";
  }
  return "high";
}

function conflictReason(file: string): string {
  const risk = classifyConflictFile(file);
  if (risk === "low") {
    return "Usually documentation or generated metadata; verify but likely easy.";
  }
  if (risk === "medium") {
    return "Dependency or generated lock state; resolve mechanically and test.";
  }
  return "Source file conflict; requires careful semantic review.";
}

function stableTaskId(
  fork: string,
  forkBranch: string,
  mode: RunbookMode,
): string {
  return `${fork}-${forkBranch}-${mode}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function yamlDoubleQuoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function githubExpression(expression: string): string {
  return "${{ " + expression + " }}";
}

function githubCloneUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}
