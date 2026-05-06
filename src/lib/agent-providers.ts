import type {
  ReviewFinding,
  ReviewPrompt,
  ReviewProvider,
  ReviewResult,
} from "./pr-review";
import { formatReviewMarkdown, parseProviderReviewJson } from "./pr-review";

type ProviderEnv = Record<string, string | undefined>;

type ProviderConfig = {
  provider: ReviewProvider;
  model: string;
  apiKey?: string;
};

type ApiProvider = "openai-api" | "anthropic-api" | "gemini-api";
type CliProvider = "codex-cli" | "claude-cli" | "gemini-cli";

type ApiRequest = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

type FetchImpl = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{
  ok: boolean;
  status?: number;
  statusText?: string;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
}>;

type ExecFileImpl = (
  command: string,
  args: string[],
  options: {
    input: string;
    timeout: number;
    maxBuffer: number;
    cwd?: string;
  },
) => Promise<{
  stdout: string;
  stderr: string;
}>;

export type RunAgentReviewInput = {
  provider: ReviewProvider;
  prompt: ReviewPrompt;
  model?: string;
  env?: ProviderEnv;
  fetchImpl?: FetchImpl;
  execFileImpl?: ExecFileImpl;
  cwd?: string;
  timeoutMs?: number;
};

export type TribunalProviderInput = {
  provider: ApiProvider | CliProvider;
  model?: string;
};

export type RunTribunalReviewInput = {
  prompt: ReviewPrompt;
  providers: TribunalProviderInput[];
  env?: ProviderEnv;
  fetchImpl?: FetchImpl;
  execFileImpl?: ExecFileImpl;
  cwd?: string;
  timeoutMs?: number;
  runSingleReviewImpl?: (input: RunAgentReviewInput) => Promise<ReviewResult>;
};

const DEFAULT_MODELS: Record<Exclude<ReviewProvider, "rule-based" | "tribunal">, string> = {
  "openai-api": "gpt-4.1-mini",
  "anthropic-api": "claude-3-5-sonnet-20241022",
  "gemini-api": "gemini-2.0-flash",
  "codex-cli": "",
  "claude-cli": "",
  "gemini-cli": "",
};

const REVIEW_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "risk", "findings"],
  properties: {
    summary: { type: "string" },
    risk: { type: "string", enum: ["critical", "high", "medium", "low"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "severity",
          "category",
          "file",
          "title",
          "detail",
          "recommendation",
          "confidence",
          "evidence",
        ],
        properties: {
          severity: {
            type: "string",
            enum: ["critical", "high", "medium", "low", "info"],
          },
          category: { type: "string" },
          file: { type: ["string", "null"] },
          title: { type: "string" },
          detail: { type: "string" },
          recommendation: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          evidence: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "label", "detail", "file"],
              properties: {
                kind: {
                  type: "string",
                  enum: ["file", "patch", "check", "policy", "git", "agent"],
                },
                label: { type: "string" },
                detail: { type: "string" },
                file: { type: ["string", "null"] },
              },
            },
          },
        },
      },
    },
  },
};

export function resolveProviderConfig(
  provider: ReviewProvider,
  model = "",
  env: ProviderEnv = process.env,
): ProviderConfig {
  if (provider === "rule-based") {
    return { provider, model: "local-heuristics" };
  }
  if (provider === "tribunal") {
    return { provider, model: "multi-agent" };
  }

  const resolvedModel =
    model.trim() ||
    env[`FDS_${provider.replace("-", "_").toUpperCase()}_MODEL`]?.trim() ||
    DEFAULT_MODELS[provider];

  if (provider === "openai-api") {
    const apiKey = env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for openai-api review.");
    }
    return { provider, model: resolvedModel, apiKey };
  }

  if (provider === "anthropic-api") {
    const apiKey = env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is required for anthropic-api review.");
    }
    return { provider, model: resolvedModel, apiKey };
  }

  if (provider === "gemini-api") {
    const apiKey = env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY or GOOGLE_API_KEY is required for gemini-api review.");
    }
    return { provider, model: resolvedModel, apiKey };
  }

  return { provider, model: resolvedModel };
}

export function buildApiRequest(
  provider: ApiProvider,
  prompt: ReviewPrompt,
  model: string,
  apiKey: string,
): ApiRequest {
  if (provider === "openai-api") {
    return {
      url: "https://api.openai.com/v1/responses",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: {
        model,
        input: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "pr_review",
            schema: REVIEW_JSON_SCHEMA,
            strict: true,
          },
        },
      },
    };
  }

  if (provider === "anthropic-api") {
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model,
        max_tokens: 3000,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
      },
    };
  }

  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model,
    )}:generateContent?key=${encodeURIComponent(apiKey)}`,
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      systemInstruction: {
        parts: [{ text: prompt.system }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: prompt.user }],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
      },
    },
  };
}

export function buildCliInvocation(
  provider: CliProvider,
  model = "",
): { command: string; args: string[] } {
  if (provider === "codex-cli") {
    return {
      command: "codex",
      args: [
        "exec",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        ...(model ? ["--model", model] : []),
        "-",
      ],
    };
  }

  if (provider === "claude-cli") {
    return {
      command: "claude",
      args: [
        "--print",
        "--permission-mode",
        "plan",
        "--output-format",
        "text",
        ...(model ? ["--model", model] : []),
      ],
    };
  }

  return {
    command: "gemini",
    args: [
      ...(model ? ["--model", model] : []),
      "--approval-mode",
      "plan",
      "--output-format",
      "text",
      "--prompt",
      "Review the provided engineering context from stdin. Return JSON only.",
    ],
  };
}

export async function runAgentReview(
  input: RunAgentReviewInput,
): Promise<ReviewResult> {
  const config = resolveProviderConfig(input.provider, input.model, input.env);
  if (isApiProvider(config.provider)) {
    const request = buildApiRequest(
      config.provider,
      input.prompt,
      config.model,
      config.apiKey ?? "",
    );
    const fetchImpl = input.fetchImpl ?? fetch;
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
    });
    if (!response.ok) {
      const message = await readProviderError(response);
      throw new Error(`${config.provider} review failed: ${message}`);
    }
    const body = await response.json();
    return parseProviderReviewJson(
      extractApiText(config.provider, body),
      config.provider,
      config.model,
    );
  }

  if (!isCliProvider(config.provider)) {
    throw new Error("rule-based provider does not require an agent run.");
  }

  const execFileImpl = input.execFileImpl ?? execFilePromise;
  const invocation = buildCliInvocation(config.provider, config.model);
  const output = await execFileImpl(invocation.command, invocation.args, {
    input: `${input.prompt.system}\n\n${input.prompt.user}`,
    timeout: input.timeoutMs ?? 120000,
    maxBuffer: 1024 * 1024 * 8,
    cwd: input.cwd,
  });
  return parseProviderReviewJson(
    output.stdout,
    config.provider,
    config.model || invocation.command,
  );
}

export async function runTribunalReview(
  input: RunTribunalReviewInput,
): Promise<ReviewResult> {
  const runSingleReview = input.runSingleReviewImpl ?? runAgentReview;
  const settled = await Promise.allSettled(
    input.providers.map((providerInput) =>
      runSingleReview({
        provider: providerInput.provider,
        model: providerInput.model,
        prompt: input.prompt,
        env: input.env,
        fetchImpl: input.fetchImpl,
        execFileImpl: input.execFileImpl,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
      }),
    ),
  );
  const successful = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const failed = settled.flatMap((result, index) =>
    result.status === "rejected"
      ? [buildProviderFailureFinding(input.providers[index], result.reason)]
      : [],
  );
  const findings = [...aggregateFindings(successful), ...failed];
  const result: ReviewResult = {
    provider: "tribunal",
    model: input.providers
      .map((provider) => `${provider.provider}${provider.model ? `:${provider.model}` : ""}`)
      .join(", "),
    summary: `Tribunal reviewed with ${successful.length}/${input.providers.length} successful provider(s).`,
    risk: riskFromFindings(findings),
    findings,
    markdown: "",
    raw: JSON.stringify({
      providers: input.providers.map((provider) => provider.provider),
      successful: successful.map((review) => review.provider),
      failed: failed.length,
    }),
  };
  result.markdown = formatReviewMarkdown(result);
  return result;
}

function isApiProvider(provider: ReviewProvider): provider is ApiProvider {
  return ["openai-api", "anthropic-api", "gemini-api"].includes(provider);
}

function isCliProvider(provider: ReviewProvider): provider is CliProvider {
  return ["codex-cli", "claude-cli", "gemini-cli"].includes(provider);
}

function aggregateFindings(reviews: ReviewResult[]): ReviewFinding[] {
  const groups = new Map<string, Array<{ review: ReviewResult; finding: ReviewFinding }>>();
  for (const review of reviews) {
    for (const finding of review.findings) {
      const key = normalizeFindingKey(finding);
      const values = groups.get(key) ?? [];
      values.push({ review, finding });
      groups.set(key, values);
    }
  }

  return Array.from(groups.values()).map((items) => {
    const [first] = items;
    const providers = Array.from(new Set(items.map((item) => item.review.provider)));
    const severity = maxSeverity(items.map((item) => item.finding.severity));
    const evidence = items.flatMap((item) => [
      ...item.finding.evidence,
      {
        kind: "agent" as const,
        label: item.review.provider,
        detail: item.review.summary,
      },
    ]);

    return {
      ...first.finding,
      severity,
      confidence: providers.length >= 2 ? "high" : first.finding.confidence,
      detail:
        providers.length >= 2
          ? `${first.finding.detail} Reported by ${providers.length} providers: ${providers.join(", ")}.`
          : first.finding.detail,
      evidence: evidence.slice(0, 10),
    };
  });
}

function buildProviderFailureFinding(
  provider: TribunalProviderInput,
  reason: unknown,
): ReviewFinding {
  const message = reason instanceof Error ? reason.message : String(reason);
  return {
    severity: "medium",
    category: "agent",
    title: "Agent provider failed",
    detail: `${provider.provider} did not return a usable review.`,
    recommendation: "Check provider credentials, CLI installation, or model settings.",
    confidence: "high",
    evidence: [
      {
        kind: "agent",
        label: provider.provider,
        detail: message,
      },
    ],
  };
}

function normalizeFindingKey(finding: ReviewFinding): string {
  return `${finding.category}:${finding.file ?? ""}:${finding.title}`
    .toLowerCase()
    .replace(/[^a-z0-9:/._-]+/g, " ")
    .trim();
}

function maxSeverity(severities: ReviewFinding["severity"][]) {
  const order: ReviewFinding["severity"][] = [
    "critical",
    "high",
    "medium",
    "low",
    "info",
  ];
  return order.find((severity) => severities.includes(severity)) ?? "info";
}

function riskFromFindings(findings: ReviewFinding[]): ReviewResult["risk"] {
  if (findings.some((finding) => finding.severity === "critical")) {
    return "critical";
  }
  if (findings.some((finding) => finding.severity === "high")) {
    return "high";
  }
  if (findings.some((finding) => finding.severity === "medium")) {
    return "medium";
  }
  return "low";
}

async function execFilePromise(
  command: string,
  args: string[],
  options: {
    input: string;
    timeout: number;
    maxBuffer: number;
    cwd?: string;
  },
): Promise<{ stdout: string; stderr: string }> {
  const { execFile } = await import("node:child_process");

  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    child.stdin?.end(options.input);
  });
}

function extractApiText(provider: ApiProvider, body: unknown): string {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (provider === "openai-api") {
    if (typeof record.output_text === "string") {
      return record.output_text;
    }
    const output = Array.isArray(record.output) ? record.output : [];
    const texts = output.flatMap((item) => {
      const itemRecord =
        item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const content = Array.isArray(itemRecord.content) ? itemRecord.content : [];
      return content.flatMap((contentItem) => {
        const contentRecord =
          contentItem && typeof contentItem === "object"
            ? (contentItem as Record<string, unknown>)
            : {};
        return typeof contentRecord.text === "string" ? [contentRecord.text] : [];
      });
    });
    return texts.join("\n");
  }

  if (provider === "anthropic-api") {
    const content = Array.isArray(record.content) ? record.content : [];
    return content
      .flatMap((item) => {
        const itemRecord =
          item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        return typeof itemRecord.text === "string" ? [itemRecord.text] : [];
      })
      .join("\n");
  }

  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  return candidates
    .flatMap((candidate) => {
      const candidateRecord =
        candidate && typeof candidate === "object"
          ? (candidate as Record<string, unknown>)
          : {};
      const content =
        candidateRecord.content && typeof candidateRecord.content === "object"
          ? (candidateRecord.content as Record<string, unknown>)
          : {};
      const parts = Array.isArray(content.parts) ? content.parts : [];
      return parts.flatMap((part) => {
        const partRecord =
          part && typeof part === "object" ? (part as Record<string, unknown>) : {};
        return typeof partRecord.text === "string" ? [partRecord.text] : [];
      });
    })
    .join("\n");
}

async function readProviderError(response: Awaited<ReturnType<FetchImpl>>) {
  try {
    const json = await response.json() as { error?: { message?: string }; message?: string };
    return json.error?.message ?? json.message ?? response.statusText ?? "unknown error";
  } catch {
    if (response.text) {
      return response.text();
    }
    return response.statusText ?? "unknown error";
  }
}
