import { describe, expect, test, vi } from "vitest";
import {
  buildApiRequest,
  buildCliInvocation,
  resolveProviderConfig,
  runAgentReview,
  runTribunalReview,
} from "./agent-providers";
import type { ReviewPrompt } from "./pr-review";

const prompt: ReviewPrompt = {
  system: "system prompt",
  user: "user prompt",
};

describe("agent provider helpers", () => {
  test("resolves provider config from environment keys and model overrides", () => {
    expect(
      resolveProviderConfig("openai-api", "gpt-test", {
        OPENAI_API_KEY: "sk-test",
      }),
    ).toEqual({
      provider: "openai-api",
      model: "gpt-test",
      apiKey: "sk-test",
    });

    expect(() => resolveProviderConfig("anthropic-api", "", {})).toThrow(
      "ANTHROPIC_API_KEY",
    );
  });

  test("builds OpenAI, Anthropic, and Gemini API requests", () => {
    const openai = buildApiRequest("openai-api", prompt, "gpt-test", "sk-test");
    expect(openai.url).toBe("https://api.openai.com/v1/responses");
    expect(openai.headers.Authorization).toBe("Bearer sk-test");
    expect(openai.body.model).toBe("gpt-test");
    expect(JSON.stringify(openai.body)).toContain("json_schema");

    const anthropic = buildApiRequest(
      "anthropic-api",
      prompt,
      "claude-test",
      "sk-ant",
    );
    expect(anthropic.url).toBe("https://api.anthropic.com/v1/messages");
    expect(anthropic.headers["x-api-key"]).toBe("sk-ant");
    expect(anthropic.body.system).toBe("system prompt");

    const gemini = buildApiRequest("gemini-api", prompt, "gemini-test", "sk-gem");
    expect(gemini.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent?key=sk-gem",
    );
    expect(gemini.body.generationConfig.responseMimeType).toBe("application/json");
  });

  test("builds safe default CLI invocations", () => {
    expect(buildCliInvocation("codex-cli", "gpt-5.5").args).toEqual([
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.5",
      "-",
    ]);
    expect(buildCliInvocation("claude-cli", "sonnet").args).toContain(
      "--print",
    );
    expect(buildCliInvocation("gemini-cli", "gemini-2.5-pro").args).toContain(
      "--prompt",
    );
  });

  test("runs API review and parses normalized JSON", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          summary: "Review summary.",
          risk: "medium",
          findings: [
            {
              severity: "medium",
              category: "tests",
              title: "Add tests",
              detail: "No tests were included.",
              recommendation: "Add focused tests.",
            },
          ],
        }),
      }),
    }));

    const review = await runAgentReview({
      provider: "openai-api",
      prompt,
      model: "gpt-test",
      env: { OPENAI_API_KEY: "sk-test" },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(review.provider).toBe("openai-api");
    expect(review.risk).toBe("medium");
    expect(review.findings[0].title).toBe("Add tests");
  });

  test("runs CLI review with prompt on stdin", async () => {
    const execFileImpl = vi.fn(
      async (
        _command: string,
        _args: string[],
        options: { input?: string },
      ) => ({
        stdout: JSON.stringify({
          summary: options.input?.includes("user prompt") ? "CLI summary." : "",
          risk: "low",
          findings: [],
        }),
        stderr: "",
      }),
    );

    const review = await runAgentReview({
      provider: "codex-cli",
      prompt,
      model: "gpt-5.5",
      execFileImpl,
    });

    expect(execFileImpl).toHaveBeenCalledOnce();
    expect(review.provider).toBe("codex-cli");
    expect(review.summary).toBe("CLI summary.");
  });

  test("aggregates repeated findings across multiple providers", async () => {
    const review = await runTribunalReview({
      prompt,
      providers: [
        { provider: "openai-api", model: "gpt-test" },
        { provider: "anthropic-api", model: "claude-test" },
      ],
      runSingleReviewImpl: async ({ provider, model }) => ({
        provider,
        model: model ?? "",
        summary: `${provider} summary`,
        risk: "high",
        findings: [
          {
            severity: "high",
            category: "security",
            file: "src/auth.ts",
            title: "Validate token before use",
            detail: "Token is used before validation.",
            recommendation: "Validate the token before use.",
            confidence: "medium",
            evidence: [
              {
                kind: "agent",
                label: provider,
                detail: "Reported by provider.",
              },
            ],
          },
        ],
        markdown: "",
      }),
    });

    expect(review.provider).toBe("tribunal");
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0].confidence).toBe("high");
    expect(review.findings[0].detail).toContain("2 providers");
    expect(review.markdown).toContain("Provider: tribunal");
  });

  test("keeps provider errors as tribunal findings", async () => {
    const review = await runTribunalReview({
      prompt,
      providers: [{ provider: "openai-api", model: "gpt-test" }],
      runSingleReviewImpl: async () => {
        throw new Error("missing key");
      },
    });

    expect(review.risk).toBe("medium");
    expect(review.findings[0].title).toBe("Agent provider failed");
    expect(review.findings[0].evidence[0].detail).toContain("missing key");
  });
});
