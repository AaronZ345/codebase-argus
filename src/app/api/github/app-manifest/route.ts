import { NextResponse } from "next/server";
import { buildGitHubAppManifest } from "@/lib/github-app";

export const dynamic = "force-static";

export async function GET() {
  const baseUrl =
    process.env.FDS_PUBLIC_URL?.trim() ||
    "https://aaronz345.github.io/fork-drift-sentinel";
  const name =
    process.env.FDS_GITHUB_APP_NAME?.trim() ||
    "Fork Drift Sentinel";

  return NextResponse.json(buildGitHubAppManifest({ name, url: baseUrl }));
}
