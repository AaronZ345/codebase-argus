import { NextResponse } from "next/server";
import { buildGitHubAppManifest } from "@/lib/github-app";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const baseUrl =
    url.searchParams.get("url")?.trim() ||
    process.env.FDS_PUBLIC_URL?.trim() ||
    `${url.protocol}//${url.host}`;
  const name =
    url.searchParams.get("name")?.trim() ||
    process.env.FDS_GITHUB_APP_NAME?.trim() ||
    "Fork Drift Sentinel";

  return NextResponse.json(buildGitHubAppManifest({ name, url: baseUrl }));
}
