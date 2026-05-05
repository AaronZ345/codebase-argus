import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  buildRunbookModes,
  parseRangeDiffSummary,
} from "./agent-workflow";
import type { RunbookModes } from "./agent-workflow";

export type LocalAnalyzeInput = {
  upstream: string;
  fork: string;
  upstreamBranch: string;
  forkBranch: string;
};

export type LocalCommit = {
  sha: string;
  subject: string;
};

export type MergeTreeResult = {
  clean: boolean;
  tree: string;
  conflictFiles: string[];
  messages: string[];
};

export type LocalAnalysisReport = {
  generatedAt: string;
  upstream: {
    repo: string;
    branch: string;
    gitRef: string;
  };
  fork: {
    repo: string;
    branch: string;
    gitRef: string;
  };
  compare: {
    aheadBy: number;
    behindBy: number;
  };
  mergeTree: MergeTreeResult;
  cherry: {
    covered: LocalCommit[];
    unique: LocalCommit[];
  };
  rangeDiff: {
    summary: {
      added: number;
      removed: number;
      changed: number;
    };
    lines: string[];
  };
  rebaseSimulation: RebaseSimulationResult;
  cache: {
    label: string;
  };
  runbooks: RunbookModes;
  runbook: string[];
};

export type RebaseSimulationResult = {
  clean: boolean;
  conflictFiles: string[];
  statusLines: string[];
  logLines: string[];
};

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type RepoRef = {
  owner: string;
  repo: string;
  fullName: string;
};

export async function analyzeLocalDrift(
  input: LocalAnalyzeInput,
): Promise<LocalAnalysisReport> {
  const upstream = validateRepoRef(input.upstream);
  const fork = validateRepoRef(input.fork);
  const upstreamBranch = validateBranchName(input.upstreamBranch);
  const forkBranch = validateBranchName(input.forkBranch);
  const cacheRoot = path.join(process.cwd(), ".cache", "repos");
  const repoDir = await ensureAnalysisRepository(cacheRoot, upstream, fork);

  const upstreamGitRef = `refs/heads/${upstreamBranch}`;
  const forkGitRef = `refs/remotes/fork/${forkBranch}`;

  const compare = await git(repoDir, [
    "rev-list",
    "--left-right",
    "--count",
    `${upstreamGitRef}...${forkGitRef}`,
  ]);
  const [behindBy, aheadBy] = compare.stdout
    .trim()
    .split(/\s+/)
    .map((value) => Number(value));

  const mergeTreeCommand = await git(
    repoDir,
    ["merge-tree", "--write-tree", "--name-only", upstreamGitRef, forkGitRef],
    [0, 1],
  );

  const cherry = await git(repoDir, ["cherry", "-v", upstreamGitRef, forkGitRef]);
  const rangeDiff = await git(
    repoDir,
    ["range-diff", "--no-color", `${upstreamGitRef}...${forkGitRef}`],
    [0, 1],
  );
  const rebaseSimulation = await simulateRebaseInWorktree(
    repoDir,
    upstreamGitRef,
    forkGitRef,
  );
  const runbooks = buildRunbookModes({
    upstream: {
      repo: upstream.fullName,
      branch: upstreamBranch,
    },
    fork: {
      repo: fork.fullName,
      branch: forkBranch,
    },
  });

  return {
    generatedAt: new Date().toISOString(),
    upstream: {
      repo: upstream.fullName,
      branch: upstreamBranch,
      gitRef: upstreamGitRef,
    },
    fork: {
      repo: fork.fullName,
      branch: forkBranch,
      gitRef: forkGitRef,
    },
    compare: {
      aheadBy: Number.isFinite(aheadBy) ? aheadBy : 0,
      behindBy: Number.isFinite(behindBy) ? behindBy : 0,
    },
    mergeTree: parseMergeTreeNameOnly(mergeTreeCommand),
    cherry: parseGitCherry(cherry.stdout),
    rangeDiff: parseRangeDiffSummary(rangeDiff.stdout),
    rebaseSimulation,
    cache: {
      label: `.cache/repos/${path.basename(repoDir)}`,
    },
    runbooks,
    runbook: runbooks.execute,
  };
}

export function parseRebaseSimulationResult(input: {
  exitCode: number;
  stdout: string;
  stderr: string;
  status: string;
}): RebaseSimulationResult {
  const statusLines = input.status.split(/\r?\n/).filter(Boolean);
  const conflictFiles = Array.from(
    new Set(
      statusLines.flatMap((line) => {
        const code = line.slice(0, 2);
        if (!/^(AA|AU|DD|DU|UA|UD|UU)$/.test(code)) {
          return [];
        }
        return [line.slice(3).trim()].filter(Boolean);
      }),
    ),
  );
  const logLines = `${input.stdout}\n${input.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 80);

  return {
    clean: input.exitCode === 0 && conflictFiles.length === 0,
    conflictFiles,
    statusLines,
    logLines,
  };
}

export function validateRepoRef(value: string): RepoRef {
  const trimmed = value.trim().replace(/\/$/, "");
  const withoutProtocol = trimmed
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "");
  const parts = withoutProtocol.split("/").filter(Boolean);

  if (
    parts.length !== 2 ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[0]) ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[1]) ||
    parts.some((part) => part === "." || part === "..")
  ) {
    throw new Error(`Invalid GitHub repository: ${value}`);
  }

  return {
    owner: parts[0],
    repo: parts[1],
    fullName: `${parts[0]}/${parts[1]}`,
  };
}

export function validateBranchName(value: string): string {
  const branch = value.trim();
  const invalid =
    branch.length === 0 ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    /[\s~^:?*[\\;]/.test(branch) ||
    branch.includes("@{") ||
    branch.endsWith(".lock");

  if (invalid) {
    throw new Error(`Invalid branch name: ${value}`);
  }

  return branch;
}

export function parseMergeTreeNameOnly(input: {
  stdout: string;
  exitCode: number;
}): MergeTreeResult {
  const [tree = "", ...rest] = input.stdout.split(/\r?\n/);
  const blankIndex = rest.findIndex((line) => line.trim() === "");
  const conflictFileLines =
    blankIndex === -1 ? rest.filter(Boolean) : rest.slice(0, blankIndex);
  const messageLines =
    blankIndex === -1 ? [] : rest.slice(blankIndex + 1).filter(Boolean);

  return {
    clean: input.exitCode === 0,
    tree: tree.trim(),
    conflictFiles: conflictFileLines.map((line) => line.trim()).filter(Boolean),
    messages: messageLines.map((line) => line.trim()),
  };
}

export function parseGitCherry(stdout: string): {
  covered: LocalCommit[];
  unique: LocalCommit[];
} {
  const covered: LocalCommit[] = [];
  const unique: LocalCommit[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^([+-])\s+([0-9a-f]{40})\s+(.+)$/i);
    if (!match) {
      continue;
    }
    const commit = {
      sha: match[2],
      subject: match[3],
    };
    if (match[1] === "-") {
      covered.push(commit);
    } else {
      unique.push(commit);
    }
  }

  return { covered, unique };
}

async function ensureAnalysisRepository(
  cacheRoot: string,
  upstream: RepoRef,
  fork: RepoRef,
): Promise<string> {
  await mkdir(cacheRoot, { recursive: true });
  const repoDir = path.join(cacheRoot, `${cacheKey(upstream.fullName)}.git`);

  try {
    await git(repoDir, ["rev-parse", "--git-dir"]);
  } catch {
    await run("git", [
      "clone",
      "--mirror",
      "--quiet",
      githubCloneUrl(upstream),
      repoDir,
    ]);
  }

  await git(repoDir, ["remote", "set-url", "origin", githubCloneUrl(upstream)]);
  await git(repoDir, ["remote", "update", "--prune", "origin"]);
  await git(repoDir, ["remote", "remove", "fork"], [0, 2]);
  await git(repoDir, ["remote", "add", "fork", githubCloneUrl(fork)]);
  await git(repoDir, [
    "fetch",
    "--prune",
    "fork",
    "+refs/heads/*:refs/remotes/fork/*",
  ]);

  return repoDir;
}

async function simulateRebaseInWorktree(
  repoDir: string,
  upstreamGitRef: string,
  forkGitRef: string,
): Promise<RebaseSimulationResult> {
  const worktreeRoot = path.join(process.cwd(), ".cache", "worktrees");
  await mkdir(worktreeRoot, { recursive: true });
  const worktreeDir = path.join(
    worktreeRoot,
    `${path.basename(repoDir, ".git")}-${Date.now().toString(36)}`,
  );

  try {
    await git(repoDir, ["worktree", "add", "--detach", worktreeDir, forkGitRef]);
    const rebase = await git(
      worktreeDir,
      ["rebase", upstreamGitRef],
      [0, 1],
    );
    const status = await git(worktreeDir, ["status", "--porcelain"], [0]);
    return parseRebaseSimulationResult({
      exitCode: rebase.exitCode,
      stdout: rebase.stdout,
      stderr: rebase.stderr,
      status: status.stdout,
    });
  } finally {
    await git(repoDir, ["worktree", "remove", "--force", worktreeDir], [0, 1]);
    await rm(worktreeDir, { recursive: true, force: true });
  }
}

function githubCloneUrl(repo: RepoRef): string {
  return `https://github.com/${repo.fullName}.git`;
}

function cacheKey(value: string): string {
  const hash = createHash("sha1").update(value).digest("hex").slice(0, 10);
  return `${value.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${hash}`;
}

async function git(
  cwd: string,
  args: string[],
  allowedExitCodes = [0],
): Promise<CommandResult> {
  return run("git", ["-C", cwd, ...args], allowedExitCodes);
}

async function run(
  file: string,
  args: string[],
  allowedExitCodes = [0],
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        maxBuffer: 20 * 1024 * 1024,
        timeout: 120_000,
      },
      (error, stdout, stderr) => {
        const exitCode = getExitCode(error);
        const result = {
          stdout: String(stdout),
          stderr: String(stderr),
          exitCode,
        };

        if (allowedExitCodes.includes(exitCode)) {
          resolve(result);
          return;
        }

        reject(
          new Error(
            `${file} ${args.join(" ")} failed with ${exitCode}: ${
              result.stderr || result.stdout
            }`,
          ),
        );
      },
    );
  });
}

function getExitCode(error: unknown): number {
  if (!error) {
    return 0;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "number" ? code : 1;
  }
  return 1;
}
