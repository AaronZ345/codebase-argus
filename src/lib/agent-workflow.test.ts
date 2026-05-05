import { describe, expect, test } from "vitest";
import {
  buildAgentPrompt,
  buildConflictDossier,
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
});
