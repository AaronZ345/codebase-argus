import { NextResponse } from "next/server";
import { runAgentReview, runTribunalReview } from "@/lib/agent-providers";
import {
  buildDriftPrompt,
  buildRuleBasedDriftReview,
  formatDriftReviewMarkdown,
} from "@/lib/drift-review";
import type { LocalAnalysisReport } from "@/lib/local-analyzer";
import type { ReviewProvider } from "@/lib/pr-review";

export const runtime = "nodejs";

type RequestBody = {
  provider?: ReviewProvider;
  model?: string;
  providers?: Array<{
    provider?: ReviewProvider;
    model?: string;
  }>;
  report?: LocalAnalysisReport;
};

const PROVIDERS: ReviewProvider[] = [
  "rule-based",
  "openai-api",
  "anthropic-api",
  "gemini-api",
  "codex-cli",
  "claude-cli",
  "gemini-cli",
];

export async function POST(request: Request) {
  try {
    const body = await request.json() as RequestBody;
    if (!body.report) {
      return NextResponse.json(
        { error: "report is required." },
        { status: 400 },
      );
    }

    if (body.providers?.length) {
      const providers = body.providers.map((provider) => ({
        provider: provider.provider,
        model: provider.model,
      }));
      if (
        providers.some(
          (provider) =>
            !provider.provider ||
            provider.provider === "rule-based" ||
            provider.provider === "tribunal" ||
            !PROVIDERS.includes(provider.provider),
        )
      ) {
        return NextResponse.json(
          { error: "providers must contain supported agent providers." },
          { status: 400 },
        );
      }
      const review = await runTribunalReview({
        providers: providers as Array<{
          provider:
            | "openai-api"
            | "anthropic-api"
            | "gemini-api"
            | "codex-cli"
            | "claude-cli"
            | "gemini-cli";
          model?: string;
        }>,
        prompt: buildDriftPrompt(body.report),
        cwd: process.cwd(),
      });
      return NextResponse.json({
        ...review,
        markdown: formatDriftReviewMarkdown(review),
      });
    }

    if (!body.provider || !PROVIDERS.includes(body.provider)) {
      return NextResponse.json(
        { error: "A supported provider is required." },
        { status: 400 },
      );
    }

    if (body.provider === "rule-based") {
      return NextResponse.json(buildRuleBasedDriftReview(body.report));
    }

    const review = await runAgentReview({
      provider: body.provider,
      model: body.model,
      prompt: buildDriftPrompt(body.report),
      cwd: process.cwd(),
    });

    return NextResponse.json({
      ...review,
      markdown: formatDriftReviewMarkdown(review),
    });
  } catch (caught) {
    return NextResponse.json(
      {
        error:
          caught instanceof Error
            ? caught.message
            : "Drift agent review failed.",
      },
      { status: 500 },
    );
  }
}
