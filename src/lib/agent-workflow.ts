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

function githubCloneUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}
