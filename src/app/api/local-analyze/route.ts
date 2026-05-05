import { NextResponse } from "next/server";
import { analyzeLocalDrift } from "@/lib/local-analyzer";

export const runtime = "nodejs";

type RequestBody = {
  upstream?: string;
  fork?: string;
  upstreamBranch?: string;
  forkBranch?: string;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;
    if (!body.upstream || !body.fork || !body.upstreamBranch || !body.forkBranch) {
      return NextResponse.json(
        {
          error:
            "upstream, fork, upstreamBranch, and forkBranch are required.",
        },
        { status: 400 },
      );
    }

    const report = await analyzeLocalDrift({
      upstream: body.upstream,
      fork: body.fork,
      upstreamBranch: body.upstreamBranch,
      forkBranch: body.forkBranch,
    });

    return NextResponse.json(report);
  } catch (caught) {
    return NextResponse.json(
      {
        error:
          caught instanceof Error ? caught.message : "Local analysis failed.",
      },
      { status: 500 },
    );
  }
}
