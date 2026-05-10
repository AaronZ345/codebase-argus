import { NextResponse } from "next/server";
import { buildGitHubAppManifest } from "@/lib/github-app";

export const dynamic = "force-static";

export async function GET() {
  const baseUrl =
    process.env.ARGUS_PUBLIC_URL?.trim() ||
    "https://aaronz345.github.io/codebase-argus";
  const name =
    process.env.ARGUS_GITHUB_APP_NAME?.trim() ||
    "Codebase Argus";

  return NextResponse.json(buildGitHubAppManifest({ name, url: baseUrl }));
}
