import type { NextConfig } from "next";

const isGitHubPages = process.env.GITHUB_PAGES === "true";

const nextConfig: NextConfig = {
  output: isGitHubPages ? "export" : undefined,
  basePath: isGitHubPages ? "/fork-drift-sentinel" : undefined,
  assetPrefix: isGitHubPages ? "/fork-drift-sentinel/" : undefined,
  trailingSlash: isGitHubPages,
};

export default nextConfig;
