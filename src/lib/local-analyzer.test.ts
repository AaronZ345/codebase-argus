import { describe, expect, test } from "vitest";
import {
  parseGitCherry,
  parseMergeTreeNameOnly,
  parseRebaseSimulationResult,
  validateBranchName,
  validateRepoRef,
} from "./local-analyzer";

describe("local analyzer parsers", () => {
  test("parses merge-tree clean output", () => {
    expect(
      parseMergeTreeNameOnly({
        stdout: "55fcdb7eae96aaeb7500521727ea036080467416\n",
        exitCode: 0,
      }),
    ).toEqual({
      clean: true,
      tree: "55fcdb7eae96aaeb7500521727ea036080467416",
      conflictFiles: [],
      messages: [],
    });
  });

  test("parses merge-tree conflict files and messages", () => {
    const output = [
      "e5561dbcef3f753d4bbd2628d79461c6d6b4db35",
      "core/engine.go",
      "platform/feishu/feishu.go",
      "",
      "Auto-merging core/engine.go",
      "CONFLICT (content): Merge conflict in core/engine.go",
      "Auto-merging platform/feishu/feishu.go",
      "CONFLICT (content): Merge conflict in platform/feishu/feishu.go",
      "",
    ].join("\n");

    expect(parseMergeTreeNameOnly({ stdout: output, exitCode: 1 })).toEqual({
      clean: false,
      tree: "e5561dbcef3f753d4bbd2628d79461c6d6b4db35",
      conflictFiles: ["core/engine.go", "platform/feishu/feishu.go"],
      messages: [
        "Auto-merging core/engine.go",
        "CONFLICT (content): Merge conflict in core/engine.go",
        "Auto-merging platform/feishu/feishu.go",
        "CONFLICT (content): Merge conflict in platform/feishu/feishu.go",
      ],
    });
  });

  test("parses git cherry covered and unique commits", () => {
    const output = [
      "- 1111111111111111111111111111111111111111 fix(core): upstream covered",
      "+ 2222222222222222222222222222222222222222 feat(cron): local unique",
      "+ 3333333333333333333333333333333333333333 fix(ui): another unique",
      "",
    ].join("\n");

    expect(parseGitCherry(output)).toEqual({
      covered: [
        {
          sha: "1111111111111111111111111111111111111111",
          subject: "fix(core): upstream covered",
        },
      ],
      unique: [
        {
          sha: "2222222222222222222222222222222222222222",
          subject: "feat(cron): local unique",
        },
        {
          sha: "3333333333333333333333333333333333333333",
          subject: "fix(ui): another unique",
        },
      ],
    });
  });

  test("rejects unsafe repository and branch input", () => {
    expect(() => validateRepoRef("owner/repo")).not.toThrow();
    expect(() => validateRepoRef("https://github.com/owner/repo.git")).not.toThrow();
    expect(() => validateRepoRef("../repo")).toThrow();
    expect(() => validateRepoRef("owner/repo/extra")).toThrow();

    expect(() => validateBranchName("feature/rebase-risk")).not.toThrow();
    expect(() => validateBranchName("main;rm -rf /")).toThrow();
    expect(() => validateBranchName("../main")).toThrow();
  });

  test("parses rebase simulation conflicts from status and stderr", () => {
    expect(
      parseRebaseSimulationResult({
        exitCode: 1,
        stdout: "Auto-merging src/core.ts\nCONFLICT (content): Merge conflict in src/core.ts\n",
        stderr: "error: could not apply 1234567... change core\n",
        status: "UU src/core.ts\nM  package.json\nAA src/new.ts\n",
      }),
    ).toEqual({
      clean: false,
      conflictFiles: ["src/core.ts", "src/new.ts"],
      statusLines: ["UU src/core.ts", "M  package.json", "AA src/new.ts"],
      logLines: [
        "Auto-merging src/core.ts",
        "CONFLICT (content): Merge conflict in src/core.ts",
        "error: could not apply 1234567... change core",
      ],
    });
  });
});
