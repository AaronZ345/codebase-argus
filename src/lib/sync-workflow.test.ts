import { describe, expect, test, vi } from "vitest";
import { buildSyncSteps, runSyncWorkflow } from "./sync-workflow";
import type { SyncInput } from "./sync-workflow";

const input: SyncInput = {
  upstream: "owner/upstream",
  fork: "me/fork",
  upstreamBranch: "main",
  forkBranch: "feature/demo",
  branch: "sync/upstream-main",
  mode: "merge",
  testCommands: ["npm test"],
  execute: false,
  push: false,
  createPr: false,
};

describe("sync workflow", () => {
  test("builds a gated merge plan without push or PR steps by default", () => {
    const steps = buildSyncSteps(input, "/tmp/fork");
    const commands = steps.map((step) => step.command);

    expect(commands).toContain("git merge --no-ff upstream/main");
    expect(commands).toContain("npm test");
    expect(commands.some((command) => command.startsWith("git push"))).toBe(false);
    expect(commands.some((command) => command.startsWith("gh pr create"))).toBe(false);
  });

  test("adds push and PR steps only when their gates are enabled", () => {
    const steps = buildSyncSteps(
      { ...input, push: true, createPr: true },
      "/tmp/fork",
    );
    const commands = steps.map((step) => step.command);

    expect(commands).toContain(
      "git push --force-with-lease origin HEAD:sync/upstream-main",
    );
    expect(commands.at(-1)).toContain("gh pr create --repo me/fork");
    expect(commands.at(-1)).toContain('--title "sync upstream main into feature/demo"');
  });

  test("dry-run prints the plan without executing commands", async () => {
    const execImpl = vi.fn();
    const result = await runSyncWorkflow(input, execImpl);

    expect(execImpl).not.toHaveBeenCalled();
    expect(result.markdown).toContain("Execute: false");
    expect(result.steps.every((step) => step.status === "planned")).toBe(true);
  });

  test("execution stops at the first failed step", async () => {
    const execImpl = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "cloned", stderr: "" })
      .mockRejectedValueOnce(new Error("remote already exists"));

    const result = await runSyncWorkflow(
      { ...input, execute: true },
      execImpl,
    );

    expect(execImpl).toHaveBeenCalledTimes(2);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].status).toBe("passed");
    expect(result.steps[1].status).toBe("failed");
    expect(result.markdown).toContain("remote already exists");
  });
});
