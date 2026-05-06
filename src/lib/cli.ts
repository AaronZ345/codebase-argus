import { readFile as nodeReadFile } from "node:fs/promises";
import {
  runAgentReview as defaultRunAgentReview,
  runTribunalReview as defaultRunTribunalReview,
} from "./agent-providers";
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
    };

type CliDeps = {
  env?: Record<string, string | undefined>;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  readFile?: (path: string, encoding: "utf8") => Promise<string> | string;
  fetchPullRequestReviewReport?: typeof defaultFetchPullRequestReviewReport;
  analyzeLocalDrift?: typeof defaultAnalyzeLocalDrift;
  runAgentReview?: typeof defaultRunAgentReview;
  runTribunalReview?: typeof defaultRunTribunalReview;
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

  if (command === "review") {
    if (!firstRef) {
      throw new Error(`Missing pull request reference.\n\n${usage()}`);
    }
    return parseReviewArgs(firstRef, [secondRef, ...remaining].filter(Boolean));
  }

  if (command === "drift") {
    if (!firstRef || !secondRef) {
      throw new Error(`Missing upstream or fork repository.\n\n${usage()}`);
    }
    return parseDriftArgs(firstRef, secondRef, remaining);
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
    "Fork Drift Sentinel CLI",
    "",
    "Usage:",
    "  fork-drift-sentinel review <owner/repo#123|github-pr-url> [options]",
    "  fork-drift-sentinel drift <upstream-owner/repo> <fork-owner/repo> [options]",
    "",
    "Options:",
    "  --provider <provider>       rule-based, openai-api, anthropic-api, gemini-api, codex-cli, claude-cli, gemini-cli",
    "  --tribunal <providers>      comma list, optional model with provider:model",
    "  --model <model>             model override for a single provider",
    "  --format <markdown|json>    output format, default markdown",
    "  --policy <path>             PR review only: JSON or simple YAML policy file",
    "  --github-token <token>      PR review only: GitHub token override",
    "  --upstream-branch <branch>  drift only: upstream branch, default main",
    "  --fork-branch <branch>      drift only: fork branch, default main",
    "  --cwd <path>                working directory for CLI providers",
    "  --timeout-ms <number>       agent timeout, default provider setting",
  ].join("\n");
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

function githubTokenFromEnv(env: Record<string, string | undefined>): string | undefined {
  return env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || undefined;
}
