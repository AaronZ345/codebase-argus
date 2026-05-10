import { readFile as nodeReadFile } from "node:fs/promises";
import {
  runAgentReview as defaultRunAgentReview,
  runTribunalReview as defaultRunTribunalReview,
} from "./agent-providers";
import { buildAutofixPlan } from "./autofix";
import {
  buildCiLogPrompt,
  buildRuleBasedCiReview,
  formatCiReviewMarkdown,
} from "./ci-review";
import {
  buildDriftPrompt,
  buildRuleBasedDriftReview,
  formatDriftReviewMarkdown,
} from "./drift-review";
import {
  fetchPullRequestReviewReport as defaultFetchPullRequestReviewReport,
} from "./github";
import type { PullRequestReviewReport } from "./github";
import {
  fetchFailedGitHubActionsLogs as defaultFetchFailedGitHubActionsLogs,
} from "./github-app";
import {
  analyzeLocalDrift as defaultAnalyzeLocalDrift,
} from "./local-analyzer";
import type { LocalAnalysisReport } from "./local-analyzer";
import {
  buildReviewPrompt,
  buildRuleBasedReview,
  parsePullRequestRef,
} from "./pr-review";
import type { ReviewProvider, ReviewResult } from "./pr-review";
import {
  DEFAULT_REVIEW_POLICY,
  parseReviewPolicy,
} from "./review-policy";
import type { ReviewPolicy } from "./review-policy";
import {
  runSyncWorkflow as defaultRunSyncWorkflow,
} from "./sync-workflow";
import type { SyncInput, SyncMode } from "./sync-workflow";

type AgentProvider = Exclude<ReviewProvider, "rule-based" | "tribunal">;

type TribunalProvider = {
  provider: AgentProvider;
  model?: string;
};

export type ParsedCliArgs =
  | {
      command: "help";
    }
  | {
      command: "review";
      pr: ReturnType<typeof parsePullRequestRef>;
      provider: Exclude<ReviewProvider, "tribunal">;
      model?: string;
      tribunalProviders?: TribunalProvider[];
      format: "markdown" | "json";
      policyPath?: string;
      githubToken?: string;
      cwd?: string;
      timeoutMs?: number;
    }
  | {
      command: "drift";
      upstream: string;
      fork: string;
      upstreamBranch: string;
      forkBranch: string;
      provider: Exclude<ReviewProvider, "tribunal">;
      model?: string;
      tribunalProviders?: TribunalProvider[];
      format: "markdown" | "json";
      cwd?: string;
      timeoutMs?: number;
    }
	  | {
	      command: "ci-log";
	      logPath: string;
	      provider: Exclude<ReviewProvider, "tribunal">;
      model?: string;
      tribunalProviders?: TribunalProvider[];
      format: "markdown" | "json";
	      cwd?: string;
	      timeoutMs?: number;
	    }
	  | {
	      command: "ci-github";
	      pr: ReturnType<typeof parsePullRequestRef>;
	      provider: Exclude<ReviewProvider, "tribunal">;
	      model?: string;
	      tribunalProviders?: TribunalProvider[];
	      format: "markdown" | "json";
	      githubToken?: string;
	      cwd?: string;
	      timeoutMs?: number;
	    }
	  | {
	      command: "autofix-plan";
	      pr: ReturnType<typeof parsePullRequestRef>;
	      githubToken?: string;
	      format: "markdown" | "json";
	    }
	  | ({
	      command: "sync";
	    } & SyncInput);

type CliDeps = {
  env?: Record<string, string | undefined>;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  readFile?: (path: string, encoding: "utf8") => Promise<string> | string;
  fetchPullRequestReviewReport?: typeof defaultFetchPullRequestReviewReport;
  fetchFailedGitHubActionsLogs?: typeof defaultFetchFailedGitHubActionsLogs;
  analyzeLocalDrift?: typeof defaultAnalyzeLocalDrift;
  runAgentReview?: typeof defaultRunAgentReview;
  runTribunalReview?: typeof defaultRunTribunalReview;
  runSync?: typeof defaultRunSyncWorkflow;
};

const REVIEW_PROVIDERS: Array<Exclude<ReviewProvider, "tribunal">> = [
  "rule-based",
  "openai-api",
  "anthropic-api",
  "gemini-api",
  "codex-cli",
  "claude-cli",
  "gemini-cli",
];

const AGENT_PROVIDERS: AgentProvider[] = [
  "openai-api",
  "anthropic-api",
  "gemini-api",
  "codex-cli",
  "claude-cli",
  "gemini-cli",
];

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const [command, firstRef, secondRef, ...remaining] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { command: "help" };
  }
  if (isKnownCommand(command) && (firstRef === "--help" || firstRef === "-h")) {
    return { command: "help" };
  }

  if (command === "review") {
    if (!firstRef) {
      throw new Error(`Missing pull request reference.\n\n${usage()}`);
    }
    return parseReviewArgs(firstRef, [secondRef, ...remaining].filter(Boolean));
  }

  if (isDownstreamReviewCommand(command)) {
    if (!firstRef || !secondRef) {
      throw new Error(`Missing upstream or fork repository.\n\n${usage()}`);
    }
    return parseDriftArgs(firstRef, secondRef, remaining);
  }

  if (command === "ci-log") {
    if (!firstRef) {
      throw new Error(`Missing CI log path.\n\n${usage()}`);
    }
    return parseCiLogArgs(firstRef, [secondRef, ...remaining].filter(Boolean));
  }

  if (command === "ci-github") {
    if (!firstRef) {
      throw new Error(`Missing pull request reference.\n\n${usage()}`);
    }
    return parseCiGitHubArgs(firstRef, [secondRef, ...remaining].filter(Boolean));
  }

  if (command === "autofix-plan") {
    if (!firstRef) {
      throw new Error(`Missing pull request reference.\n\n${usage()}`);
    }
    return parseAutofixPlanArgs(firstRef, [secondRef, ...remaining].filter(Boolean));
  }

  if (command === "sync") {
    if (!firstRef || !secondRef) {
      throw new Error(`Missing upstream or fork repository.\n\n${usage()}`);
    }
    return parseSyncArgs(firstRef, secondRef, remaining);
  }

  throw new Error(`Unknown command "${command}".\n\n${usage()}`);
}

function parseReviewArgs(
  prRef: string,
  rest: string[],
): ParsedCliArgs & { command: "review" } {
  const options: ParsedCliArgs & { command: "review" } = {
    command: "review",
    pr: parsePullRequestRef(prRef),
    provider: "rule-based",
    format: "markdown",
  };

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag.startsWith("--")) {
      throw new Error(`Unexpected argument "${flag}".\n\n${usage()}`);
    }
    if (!value) {
      throw new Error(`Missing value for ${flag}.`);
    }
    index += 1;

    if (flag === "--provider") {
      options.provider = parseReviewProvider(value);
    } else if (flag === "--model") {
      options.model = value;
    } else if (flag === "--tribunal") {
      options.tribunalProviders = parseTribunalProviders(value);
    } else if (flag === "--format") {
      options.format = parseFormat(value);
    } else if (flag === "--policy") {
      options.policyPath = value;
    } else if (flag === "--github-token") {
      options.githubToken = value;
    } else if (flag === "--cwd") {
      options.cwd = value;
    } else if (flag === "--timeout-ms") {
      options.timeoutMs = parseTimeout(value);
    } else {
      throw new Error(`Unknown option "${flag}".\n\n${usage()}`);
    }
  }

  return options;
}

function parseDriftArgs(
  upstream: string,
  fork: string,
  rest: string[],
): ParsedCliArgs & { command: "drift" } {
  const options: ParsedCliArgs & { command: "drift" } = {
    command: "drift",
    upstream,
    fork,
    upstreamBranch: "main",
    forkBranch: "main",
    provider: "rule-based",
    format: "markdown",
  };

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag.startsWith("--")) {
      throw new Error(`Unexpected argument "${flag}".\n\n${usage()}`);
    }
    if (!value) {
      throw new Error(`Missing value for ${flag}.`);
    }
    index += 1;

    if (flag === "--provider") {
      options.provider = parseReviewProvider(value);
    } else if (flag === "--model") {
      options.model = value;
    } else if (flag === "--tribunal") {
      options.tribunalProviders = parseTribunalProviders(value);
    } else if (flag === "--format") {
      options.format = parseFormat(value);
    } else if (flag === "--upstream-branch") {
      options.upstreamBranch = value;
    } else if (flag === "--fork-branch") {
      options.forkBranch = value;
    } else if (flag === "--cwd") {
      options.cwd = value;
    } else if (flag === "--timeout-ms") {
      options.timeoutMs = parseTimeout(value);
    } else {
      throw new Error(`Unknown option "${flag}".\n\n${usage()}`);
    }
  }

  return options;
}

function parseCiLogArgs(
  logPath: string,
  rest: string[],
): ParsedCliArgs & { command: "ci-log" } {
  const options: ParsedCliArgs & { command: "ci-log" } = {
    command: "ci-log",
    logPath,
    provider: "rule-based",
    format: "markdown",
  };

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag.startsWith("--")) {
      throw new Error(`Unexpected argument "${flag}".\n\n${usage()}`);
    }
    if (!value) {
      throw new Error(`Missing value for ${flag}.`);
    }
    index += 1;

    if (flag === "--provider") {
      options.provider = parseReviewProvider(value);
    } else if (flag === "--model") {
      options.model = value;
    } else if (flag === "--tribunal") {
      options.tribunalProviders = parseTribunalProviders(value);
    } else if (flag === "--format") {
      options.format = parseFormat(value);
    } else if (flag === "--cwd") {
      options.cwd = value;
    } else if (flag === "--timeout-ms") {
      options.timeoutMs = parseTimeout(value);
    } else {
      throw new Error(`Unknown option "${flag}".\n\n${usage()}`);
    }
  }

  return options;
}

function parseCiGitHubArgs(
  prRef: string,
  rest: string[],
): ParsedCliArgs & { command: "ci-github" } {
  const options: ParsedCliArgs & { command: "ci-github" } = {
    command: "ci-github",
    pr: parsePullRequestRef(prRef),
    provider: "rule-based",
    format: "markdown",
  };

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag.startsWith("--")) {
      throw new Error(`Unexpected argument "${flag}".\n\n${usage()}`);
    }
    if (!value) {
      throw new Error(`Missing value for ${flag}.`);
    }
    index += 1;

    if (flag === "--provider") {
      options.provider = parseReviewProvider(value);
    } else if (flag === "--model") {
      options.model = value;
    } else if (flag === "--tribunal") {
      options.tribunalProviders = parseTribunalProviders(value);
    } else if (flag === "--format") {
      options.format = parseFormat(value);
    } else if (flag === "--github-token") {
      options.githubToken = value;
    } else if (flag === "--cwd") {
      options.cwd = value;
    } else if (flag === "--timeout-ms") {
      options.timeoutMs = parseTimeout(value);
    } else {
      throw new Error(`Unknown option "${flag}".\n\n${usage()}`);
    }
  }

  return options;
}

function parseAutofixPlanArgs(
  prRef: string,
  rest: string[],
): ParsedCliArgs & { command: "autofix-plan" } {
  const options: ParsedCliArgs & { command: "autofix-plan" } = {
    command: "autofix-plan",
    pr: parsePullRequestRef(prRef),
    format: "markdown",
  };

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag.startsWith("--")) {
      throw new Error(`Unexpected argument "${flag}".\n\n${usage()}`);
    }
    if (!value) {
      throw new Error(`Missing value for ${flag}.`);
    }
    index += 1;

    if (flag === "--format") {
      options.format = parseFormat(value);
    } else if (flag === "--github-token") {
      options.githubToken = value;
    } else {
      throw new Error(`Unknown option "${flag}".\n\n${usage()}`);
    }
  }

  return options;
}

function parseSyncArgs(
  upstream: string,
  fork: string,
  rest: string[],
): ParsedCliArgs & { command: "sync" } {
  const options: ParsedCliArgs & { command: "sync" } = {
    command: "sync",
    upstream,
    fork,
    upstreamBranch: "main",
    forkBranch: "main",
    branch: "sync/upstream-main",
    mode: "merge",
    testCommands: [],
    execute: false,
    push: false,
    createPr: false,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--execute") {
      options.execute = true;
      continue;
    }
    if (flag === "--push") {
      options.push = true;
      continue;
    }
    if (flag === "--create-pr") {
      options.createPr = true;
      continue;
    }

    const value = rest[index + 1];
    if (!flag.startsWith("--")) {
      throw new Error(`Unexpected argument "${flag}".\n\n${usage()}`);
    }
    if (!value) {
      throw new Error(`Missing value for ${flag}.`);
    }
    index += 1;

    if (flag === "--mode") {
      options.mode = parseSyncMode(value);
    } else if (flag === "--upstream-branch") {
      options.upstreamBranch = value;
    } else if (flag === "--fork-branch") {
      options.forkBranch = value;
    } else if (flag === "--branch") {
      options.branch = value;
    } else if (flag === "--test") {
      options.testCommands.push(value);
    } else if (flag === "--workdir") {
      options.workdir = value;
    } else {
      throw new Error(`Unknown option "${flag}".\n\n${usage()}`);
    }
  }

  if ((options.push || options.createPr) && !options.execute) {
    throw new Error("--push and --create-pr require --execute.");
  }

  return options;
}

export async function runCli(
  argv: string[],
  deps: CliDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((value) => process.stdout.write(`${value}\n`));
  const stderr = deps.stderr ?? ((value) => process.stderr.write(`${value}\n`));

  try {
    const args = parseCliArgs(argv);
    if (args.command === "help") {
      stdout(usage());
      return 0;
    }

    if (args.command === "drift") {
      const report = await (deps.analyzeLocalDrift ?? defaultAnalyzeLocalDrift)({
        upstream: args.upstream,
        fork: args.fork,
        upstreamBranch: args.upstreamBranch,
        forkBranch: args.forkBranch,
      });
      const review = await runDrift(args, report, deps);
      stdout(args.format === "json" ? JSON.stringify(review, null, 2) : review.markdown);
      return 0;
    }

    if (args.command === "ci-log") {
      const log = await (deps.readFile ?? nodeReadFile)(args.logPath, "utf8");
      const review = await runCiLog(args, log, deps);
      stdout(args.format === "json" ? JSON.stringify(review, null, 2) : review.markdown);
      return 0;
    }

    if (args.command === "ci-github") {
      const token = args.githubToken ?? githubTokenFromEnv(deps.env ?? process.env);
      const report = await (deps.fetchPullRequestReviewReport ??
        defaultFetchPullRequestReviewReport)({
        owner: args.pr.owner,
        repo: args.pr.repo,
        number: args.pr.number,
        token,
      });
      const logs = await (deps.fetchFailedGitHubActionsLogs ??
        defaultFetchFailedGitHubActionsLogs)({
        owner: args.pr.owner,
        repo: args.pr.repo,
        runs: report.checks.runs ?? [],
        token: token ?? "",
      });
      const label = `GitHub Actions ${args.pr.fullName}#${args.pr.number}`;
      const log = logs.length
        ? logs.map((item) => `## ${item.label}\n${item.log}`).join("\n\n")
        : "No failing GitHub Actions job logs were available for this pull request.";
      const review = await runCiLog(
        {
          command: "ci-log",
          logPath: label,
          provider: args.provider,
          model: args.model,
          tribunalProviders: args.tribunalProviders,
          format: args.format,
          cwd: args.cwd,
          timeoutMs: args.timeoutMs,
        },
        log,
        deps,
      );
      stdout(args.format === "json" ? JSON.stringify(review, null, 2) : review.markdown);
      return 0;
    }

    if (args.command === "autofix-plan") {
      const report = await (deps.fetchPullRequestReviewReport ??
        defaultFetchPullRequestReviewReport)({
        owner: args.pr.owner,
        repo: args.pr.repo,
        number: args.pr.number,
        token: args.githubToken ?? githubTokenFromEnv(deps.env ?? process.env),
      });
      const review = buildRuleBasedReview(report, DEFAULT_REVIEW_POLICY);
      const plan = buildAutofixPlan({ report, review });
      stdout(args.format === "json" ? JSON.stringify(plan, null, 2) : plan.markdown);
      return 0;
    }

    if (args.command === "sync") {
      const result = await (deps.runSync ?? defaultRunSyncWorkflow)(args);
      stdout(result.markdown);
      return 0;
    }

    const policy = await loadPolicy(args.policyPath, deps);
    const report = await (deps.fetchPullRequestReviewReport ??
      defaultFetchPullRequestReviewReport)({
      owner: args.pr.owner,
      repo: args.pr.repo,
      number: args.pr.number,
      token: args.githubToken ?? githubTokenFromEnv(deps.env ?? process.env),
    });
    const review = await runReview(args, report, policy, deps);
    stdout(args.format === "json" ? JSON.stringify(review, null, 2) : review.markdown);
    return 0;
  } catch (caught) {
    stderr(caught instanceof Error ? caught.message : String(caught));
    return 1;
  }
}

export function usage(): string {
  return [
    "Codebase Argus CLI",
    "",
    "Usage:",
    "  codebase-argus review <owner/repo#123|github-pr-url> [options]",
    "  codebase-argus downstream <upstream-owner/repo> <fork-owner/repo> [options]",
    "  codebase-argus ci-log <path> [options]",
    "  codebase-argus ci-github <owner/repo#123|github-pr-url> [options]",
    "  codebase-argus autofix-plan <owner/repo#123|github-pr-url> [options]",
    "  codebase-argus sync <upstream-owner/repo> <fork-owner/repo> [options]",
    "",
    "Options:",
    "  --provider <provider>       rule-based, openai-api, anthropic-api, gemini-api, codex-cli, claude-cli, gemini-cli",
    "  --tribunal <providers>      comma list, optional model with provider:model",
    "  --model <model>             model override for a single provider",
    "  --format <markdown|json>    output format, default markdown",
    "  --policy <path>             PR review only: JSON or simple YAML policy file",
    "  --github-token <token>      PR review, ci-github, and autofix-plan only: GitHub token override",
    "  --upstream-branch <branch>  downstream/sync only: upstream branch, default main",
    "  --fork-branch <branch>      downstream/sync only: fork branch, default main",
    "  --mode <merge|rebase>       sync only: integration mode, default merge",
    "  --branch <branch>           sync only: branch to create, default sync/upstream-main",
    "  --test <command>            sync only: test command, repeatable",
    "  --execute                   sync only: run the plan; omitted means dry-run",
    "  --push                      sync only: push sync branch, requires --execute",
    "  --create-pr                 sync only: open PR with gh, requires --execute",
    "  --cwd <path>                working directory for CLI providers",
    "  --timeout-ms <number>       agent timeout, default provider setting",
  ].join("\n");
}

function isDownstreamReviewCommand(command: string): boolean {
  return command === "downstream" || command === "fork-review" || command === "drift";
}

function isKnownCommand(command: string): boolean {
  return (
    command === "review" ||
    isDownstreamReviewCommand(command) ||
    command === "ci-log" ||
    command === "ci-github" ||
    command === "autofix-plan" ||
    command === "sync"
  );
}

async function runCiLog(
  args: ParsedCliArgs & { command: "ci-log" },
  log: string,
  deps: CliDeps,
): Promise<ReviewResult> {
  if (args.tribunalProviders?.length) {
    return withCiMarkdown(
      await (deps.runTribunalReview ?? defaultRunTribunalReview)({
        providers: args.tribunalProviders,
        prompt: buildCiLogPrompt({ log, label: args.logPath }),
        env: deps.env,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
      }),
    );
  }

  if (args.provider === "rule-based") {
    return buildRuleBasedCiReview({ log, label: args.logPath });
  }

  return withCiMarkdown(
    await (deps.runAgentReview ?? defaultRunAgentReview)({
      provider: args.provider,
      model: args.model,
      prompt: buildCiLogPrompt({ log, label: args.logPath }),
      env: deps.env,
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
    }),
  );
}

function withCiMarkdown(review: ReviewResult): ReviewResult {
  return {
    ...review,
    markdown: formatCiReviewMarkdown(review),
  };
}

async function runDrift(
  args: ParsedCliArgs & { command: "drift" },
  report: LocalAnalysisReport,
  deps: CliDeps,
): Promise<ReviewResult> {
  if (args.tribunalProviders?.length) {
    return withDriftMarkdown(
      await (deps.runTribunalReview ?? defaultRunTribunalReview)({
        providers: args.tribunalProviders,
        prompt: buildDriftPrompt(report),
        env: deps.env,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
      }),
    );
  }

  if (args.provider === "rule-based") {
    return buildRuleBasedDriftReview(report);
  }

  return withDriftMarkdown(
    await (deps.runAgentReview ?? defaultRunAgentReview)({
      provider: args.provider,
      model: args.model,
      prompt: buildDriftPrompt(report),
      env: deps.env,
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
    }),
  );
}

function withDriftMarkdown(review: ReviewResult): ReviewResult {
  return {
    ...review,
    markdown: formatDriftReviewMarkdown(review),
  };
}

async function runReview(
  args: ParsedCliArgs & { command: "review" },
  report: PullRequestReviewReport,
  policy: ReviewPolicy,
  deps: CliDeps,
): Promise<ReviewResult> {
  if (args.tribunalProviders?.length) {
    return (deps.runTribunalReview ?? defaultRunTribunalReview)({
      providers: args.tribunalProviders,
      prompt: buildReviewPrompt(report, policy),
      env: deps.env,
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
    });
  }

  if (args.provider === "rule-based") {
    return buildRuleBasedReview(report, policy);
  }

  return (deps.runAgentReview ?? defaultRunAgentReview)({
    provider: args.provider,
    model: args.model,
    prompt: buildReviewPrompt(report, policy),
    env: deps.env,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
  });
}

async function loadPolicy(
  policyPath: string | undefined,
  deps: CliDeps,
): Promise<ReviewPolicy> {
  if (!policyPath) {
    return DEFAULT_REVIEW_POLICY;
  }
  const readFile = deps.readFile ?? nodeReadFile;
  return parseReviewPolicy(await readFile(policyPath, "utf8"));
}

function parseReviewProvider(value: string): Exclude<ReviewProvider, "tribunal"> {
  if (!REVIEW_PROVIDERS.includes(value as Exclude<ReviewProvider, "tribunal">)) {
    throw new Error(`Unsupported provider "${value}".`);
  }
  return value as Exclude<ReviewProvider, "tribunal">;
}

function parseTribunalProviders(value: string): TribunalProvider[] {
  const providers = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [provider, ...modelParts] = item.split(":");
      if (!AGENT_PROVIDERS.includes(provider as AgentProvider)) {
        throw new Error(`Unsupported tribunal provider "${provider}".`);
      }
      const model = modelParts.join(":").trim();
      return {
        provider: provider as AgentProvider,
        ...(model ? { model } : undefined),
      };
    });
  if (!providers.length) {
    throw new Error("At least one tribunal provider is required.");
  }
  return providers;
}

function parseFormat(value: string): "markdown" | "json" {
  if (value === "markdown" || value === "json") {
    return value;
  }
  throw new Error(`Unsupported format "${value}".`);
}

function parseTimeout(value: string): number {
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error(`Invalid timeout "${value}".`);
  }
  return timeout;
}

function parseSyncMode(value: string): SyncMode {
  if (value === "merge" || value === "rebase") {
    return value;
  }
  throw new Error(`Unsupported sync mode "${value}".`);
}

function githubTokenFromEnv(env: Record<string, string | undefined>): string | undefined {
  return env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || undefined;
}
