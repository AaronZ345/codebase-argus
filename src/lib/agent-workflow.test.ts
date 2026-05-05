import { describe, expect, test } from "vitest";
import {
  buildAgentPrompt,
  buildAgentTaskPackage,
  buildConflictDossier,
  buildGitHubActionsWorkflow,
  buildPullRequestReviewWorkflow,
  buildRunbookModes,
  parseAgentSessionLog,
  parseRangeDiffSummary,
} from "./agent-workflow";

describe("agent workflow helpers", () => {
  test("builds runbook modes with gated execution", () => {
    const runbooks = buildRunbookModes({
      upstream: { repo: "owner/upstream", branch: "main" },
      fork: { repo: "me/fork", branch: "feature/demo" },
    });

    expect(runbooks.inspect).toContain(
      "git merge-tree --write-tree --name-only upstream/main fork/feature/demo",
    );
    expect(runbooks.prepare).toContain(
      "git switch -C local/rebase-feature-demo fork/feature/demo",
    );
    expect(runbooks.execute.at(-1)).toBe(
      "git push --force-with-lease fork HEAD:feature/demo",
    );
  });

  test("creates a conflict dossier with file risk levels", () => {
    const dossier = buildConflictDossier({
      compare: { aheadBy: 2, behindBy: 1 },
      mergeTree: {
        clean: false,
        conflictFiles: ["README.md", "src/core.ts"],
        messages: [],
      },
      cherry: { covered: [], unique: [] },
      runbooks: buildRunbookModes({
        upstream: { repo: "owner/upstream", branch: "main" },
        fork: { repo: "me/fork", branch: "main" },
      }),
    });

    expect(dossier.risk).toBe("conflict");
    expect(dossier.files).toEqual([
      {
        path: "README.md",
        risk: "low",
        reason: "Usually documentation or generated metadata; verify but likely easy.",
      },
      {
        path: "src/core.ts",
        risk: "high",
        reason: "Source file conflict; requires careful semantic review.",
      },
    ]);
    expect(dossier.instructions).toContain("Stop before push.");
  });

  test("builds an agent prompt with command sequence and safety rules", () => {
    const prompt = buildAgentPrompt({
      upstream: "owner/upstream",
      fork: "me/fork",
      upstreamBranch: "main",
      forkBranch: "main",
      mode: "inspect",
    });

    expect(prompt).toContain("Do not push");
    expect(prompt).toContain("git cherry -v upstream/main fork/main");
    expect(prompt).toContain("Return a concise execution log");
  });

  test("parses agent logs into safety signals", () => {
    const summary = parseAgentSessionLog([
      "Fetched upstream/main and fork/main",
      "Created backup/fork-drift-before-rebase-20260505-123000",
      "CONFLICT (content): Merge conflict in src/core.ts",
      "npm run build failed",
    ].join("\n"));

    expect(summary).toMatchObject({
      backupCreated: true,
      fetched: true,
      rebaseAttempted: false,
      conflicts: ["src/core.ts"],
      testsFailed: true,
      safeToPush: false,
    });
  });

  test("requires fetch, backup, rebase, and passing tests before push is safe", () => {
    expect(
      parseAgentSessionLog([
        "Fetched upstream/main and fork/main",
        "Created backup/fork-drift-before-rebase-20260505-123000",
        "npm run build passed",
      ].join("\n")).safeToPush,
    ).toBe(false);

    expect(
      parseAgentSessionLog([
        "Fetched upstream/main and fork/main",
        "Created backup/fork-drift-before-rebase-20260505-123000",
        "git rebase upstream/main",
        "npm run build passed",
        "nothing to commit",
      ].join("\n")).safeToPush,
    ).toBe(true);
  });

  test("summarizes range-diff output", () => {
    const summary = parseRangeDiffSummary([
      " 1:  aaaaaaaa <  -:  -------- old upstream only",
      " -:  -------- >  1:  bbbbbbbb new fork only",
      " 2:  cccccccc !  2:  dddddddd changed patch",
    ].join("\n"));

    expect(summary).toMatchObject({
      summary: {
        added: 1,
        removed: 1,
        changed: 1,
      },
    });
    expect(summary.lines).toHaveLength(3);
  });

  test("builds a self-contained GitHub Actions workflow for scheduled drift reports", () => {
    const workflow = buildGitHubActionsWorkflow({
      upstream: "owner/upstream",
      fork: "me/fork",
      prHead: "me/fork",
      upstreamBranch: "main",
      forkBranch: "feature/demo",
      scheduleCron: "17 1 * * *",
      issueNumber: "42",
    });

    expect(workflow).toContain("name: Fork Drift Sentinel");
    expect(workflow).toContain("repository_dispatch:");
    expect(workflow).toContain("types: [upstream-updated]");
    expect(workflow).toContain("- cron: \"17 1 * * *\"");
    expect(workflow).toContain("DEFAULT_UPSTREAM_REPO: \"owner/upstream\"");
    expect(workflow).toContain("DEFAULT_FORK_BRANCH: \"feature/demo\"");
    expect(workflow).toContain("git cherry -v");
    expect(workflow).toContain("git range-diff --no-color");
    expect(workflow).toContain("cat \"$report\" >> \"$GITHUB_STEP_SUMMARY\"");
    expect(workflow).toContain("gh issue comment \"$DRIFT_REPORT_ISSUE\"");
  });

  test("builds an agent task package with gates, evidence, and log format", () => {
    const packageMarkdown = buildAgentTaskPackage({
      upstream: "owner/upstream",
      fork: "me/fork",
      upstreamBranch: "main",
      forkBranch: "feature/demo",
      mode: "prepare",
      generatedAt: "2026-05-05T08:00:00.000Z",
      report: {
        compare: { aheadBy: 3, behindBy: 2 },
        mergeTree: {
          clean: false,
          conflictFiles: ["src/core.ts"],
          messages: ["CONFLICT (content): Merge conflict in src/core.ts"],
        },
        cherry: {
          covered: [
            {
              sha: "1111111111111111111111111111111111111111",
              subject: "fix: upstream covered",
            },
          ],
          unique: [
            {
              sha: "2222222222222222222222222222222222222222",
              subject: "feat: local unique",
            },
          ],
        },
        rangeDiff: {
          summary: { added: 1, removed: 0, changed: 2 },
          lines: [" 1: abcdef1 !  1: 1234567 changed patch"],
        },
        runbooks: buildRunbookModes({
          upstream: { repo: "owner/upstream", branch: "main" },
          fork: { repo: "me/fork", branch: "feature/demo" },
        }),
      },
    });

    expect(packageMarkdown).toContain("# Fork Drift Agent Task Package");
    expect(packageMarkdown).toContain("Task ID: `me-fork-feature-demo-prepare`");
    expect(packageMarkdown).toContain("Risk: conflict");
    expect(packageMarkdown).toContain("Forbidden actions");
    expect(packageMarkdown).toContain("Do not push");
    expect(packageMarkdown).toContain("src/core.ts");
    expect(packageMarkdown).toContain("Covered commits: 1");
    expect(packageMarkdown).toContain("Unique commits: 1");
    expect(packageMarkdown).toContain("Range-diff changed patches: 2");
    expect(packageMarkdown).toContain("Acceptance checklist");
    expect(packageMarkdown).toContain("Return log format");
  });

  test("builds a pull request review workflow with optional endpoint dispatch", () => {
    const workflow = buildPullRequestReviewWorkflow({
      reviewEndpoint: "https://example.com/api/pr-agent-review",
      provider: "openai-api",
      policyPath: ".fork-drift-sentinel.yml",
    });

    expect(workflow).toContain("name: Fork Drift Sentinel PR Review");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("FDS_REVIEW_ENDPOINT");
    expect(workflow).toContain("https://example.com/api/pr-agent-review");
    expect(workflow).toContain(".fork-drift-sentinel.yml");
    expect(workflow).toContain("pull_request_target");
    expect(workflow).toContain("github.rest.issues.createComment");
  });
});
