import type { NextConfig } from "next";

const isGitHubPages = process.env.GITHUB_PAGES === "true";

const nextConfig: NextConfig = {
  output: isGitHubPages ? "export" : undefined,
  basePath: isGitHubPages ? "/codebase-argus" : undefined,
  assetPrefix: isGitHubPages ? "/codebase-argus/" : undefined,
  trailingSlash: isGitHubPages,
};

export default nextConfig;
