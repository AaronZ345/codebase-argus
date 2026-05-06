import { NextResponse } from "next/server";
import { handleGitHubWebhook } from "@/lib/github-app";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const result = await handleGitHubWebhook({
      body: await request.text(),
      headers: request.headers,
      env: process.env,
    });

    if (result.status === "unauthorized") {
      return NextResponse.json(result, { status: 401 });
    }
    if (result.status === "misconfigured") {
      return NextResponse.json(result, { status: 503 });
    }
    if (result.status === "ignored") {
      return NextResponse.json(result, { status: 202 });
    }
    return NextResponse.json(result);
  } catch (caught) {
    return NextResponse.json(
      {
        status: "error",
        reason:
          caught instanceof Error ? caught.message : "GitHub webhook review failed.",
      },
      { status: 500 },
    );
  }
}
