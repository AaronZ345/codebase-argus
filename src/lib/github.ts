export type RepoRef = {
  owner: string;
  repo: string;
  fullName: string;
};

export type RepositorySummary = {
  fullName: string;
  defaultBranch: string;
  htmlUrl: string;
  stars: number;
  forks: number;
  openIssues: number;
  pushedAt: string;
};

type GitHubRepository = {
  full_name: string;
  default_branch: string;
  html_url: string;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  pushed_at: string;
};

type GitHubCompareCommit = {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: {
      date: string;
      name: string;
    } | null;
  };
  author: {
    login: string;
  } | null;
};

type GitHubCompare = {
  status: "ahead" | "behind" | "diverged" | "identical";
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  html_url: string;
  commits: GitHubCompareCommit[];
};

type GitHubCommitListItem = GitHubCompareCommit;

type GitHubPullRequest = {
  number: number;
  title: string;
  html_url: string;
  draft: boolean;
  created_at: string;
  updated_at: string;
  mergeable: boolean | null;
  mergeable_state?: string;
  user: {
    login: string;
  } | null;
  base: {
    ref: string;
    repo: {
      full_name: string;
    };
  };
  head: {
    ref: string;
    sha: string;
    repo: {
      full_name: string;
      owner: {
        login: string;
      };
    } | null;
  };
  labels: Array<{
    name: string;
  }>;
};

type GitHubCheckRuns = {
  total_count: number;
  check_runs: Array<{
    name: string;
    status: "queued" | "in_progress" | "completed";
    conclusion:
      | "success"
      | "failure"
      | "neutral"
      | "cancelled"
      | "skipped"
      | "timed_out"
      | "action_required"
      | null;
    html_url: string;
  }>;
};

export type DriftCommit = {
  sha: string;
  subject: string;
  author: string;
  date: string;
  htmlUrl: string;
  prNumbers: number[];
};

export type PullRequestStatus = {
  number: number;
  title: string;
  htmlUrl: string;
  draft: boolean;
  author: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  createdAt: string;
  updatedAt: string;
  mergeable: boolean | null;
  mergeableState: string;
  labels: string[];
  checks: {
    state: "passing" | "failing" | "pending" | "none" | "unavailable";
    total: number;
    failing: number;
    pending: number;
  };
};

export type CleanupCandidate = {
  sha: string;
  subject: string;
  htmlUrl: string;
  reason: string;
  confidence: "high" | "medium" | "low";
  action: "drop-candidate" | "keep-open-pr" | "manual-review";
  upstreamMatch?: {
    sha: string;
    subject: string;
    htmlUrl: string;
  };
};

export type ForkReport = {
  generatedAt: string;
  upstream: RepositorySummary;
  fork: RepositorySummary;
  prHead: RepositorySummary;
  compare: {
    status: GitHubCompare["status"];
    aheadBy: number;
    behindBy: number;
    htmlUrl: string;
    commits: DriftCommit[];
  };
  pullRequests: PullRequestStatus[];
  cleanupCandidates: CleanupCandidate[];
};

export function parseRepoRef(value: string): RepoRef {
  const trimmed = value.trim().replace(/\/$/, "");
  const withoutProtocol = trimmed
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "");
  const parts = withoutProtocol.split("/").filter(Boolean);

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Repository must look like "owner/repo", got "${value}".`);
  }

  return {
    owner: parts[0],
    repo: parts[1],
    fullName: `${parts[0]}/${parts[1]}`,
  };
}

export async function fetchForkReport(input: {
  upstream: string;
  fork: string;
  prHead?: string;
  token?: string;
}): Promise<ForkReport> {
  const upstreamRef = parseRepoRef(input.upstream);
  const forkRef = parseRepoRef(input.fork);
  const prHeadRef = parseRepoRef(input.prHead?.trim() || input.fork);

  const [upstreamRepo, forkRepo, prHeadRepo] = await Promise.all([
    githubRequest<GitHubRepository>(
      `/repos/${upstreamRef.owner}/${upstreamRef.repo}`,
      input.token,
    ),
    githubRequest<GitHubRepository>(
      `/repos/${forkRef.owner}/${forkRef.repo}`,
      input.token,
    ),
    githubRequest<GitHubRepository>(
      `/repos/${prHeadRef.owner}/${prHeadRef.repo}`,
      input.token,
    ),
  ]);

  const comparePath = `/repos/${upstreamRef.owner}/${upstreamRef.repo}/compare/${encodeURIComponent(
    upstreamRepo.default_branch,
  )}...${encodeURIComponent(`${forkRef.owner}:${forkRepo.default_branch}`)}`;

  const [compare, upstreamRecent, upstreamOpenPulls] = await Promise.all([
    githubRequest<GitHubCompare>(comparePath, input.token),
    githubRequest<GitHubCommitListItem[]>(
      `/repos/${upstreamRef.owner}/${upstreamRef.repo}/commits?sha=${encodeURIComponent(
        upstreamRepo.default_branch,
      )}&per_page=100`,
      input.token,
    ),
    githubRequestPages<GitHubPullRequest>(
      `/repos/${upstreamRef.owner}/${upstreamRef.repo}/pulls?state=open&sort=updated&direction=desc&per_page=100`,
      input.token,
      5,
    ),
  ]);

  const forkOpenPulls = upstreamOpenPulls
    .filter((pull) => {
      const headRepo = pull.head.repo?.full_name.toLowerCase();
      return headRepo === prHeadRepo.full_name.toLowerCase();
    })
    .slice(0, 20);

  const pullRequests = await Promise.all(
    forkOpenPulls.map((pull) => enrichPullRequest(upstreamRef, pull, input.token)),
  );

  const commits = compare.commits.map(mapDriftCommit);
  const cleanupCandidates = buildCleanupCandidates({
    aheadCommits: commits,
    upstreamRecent,
    pullRequests,
  });

  return {
    generatedAt: new Date().toISOString(),
    upstream: mapRepository(upstreamRepo),
    fork: mapRepository(forkRepo),
    prHead: mapRepository(prHeadRepo),
    compare: {
      status: compare.status,
      aheadBy: compare.ahead_by,
      behindBy: compare.behind_by,
      htmlUrl: compare.html_url,
      commits,
    },
    pullRequests,
    cleanupCandidates,
  };
}

async function enrichPullRequest(
  upstream: RepoRef,
  pull: GitHubPullRequest,
  token?: string,
): Promise<PullRequestStatus> {
  let detail = await githubRequest<GitHubPullRequest>(
    `/repos/${upstream.owner}/${upstream.repo}/pulls/${pull.number}`,
    token,
  );
  if (detail.mergeable === null) {
    await delay(700);
    detail = await githubRequest<GitHubPullRequest>(
      `/repos/${upstream.owner}/${upstream.repo}/pulls/${pull.number}`,
      token,
    );
  }

  const checks = await fetchChecks(detail, token);

  return {
    number: detail.number,
    title: detail.title,
    htmlUrl: detail.html_url,
    draft: detail.draft,
    author: detail.user?.login ?? "unknown",
    baseRef: detail.base.ref,
    headRef: detail.head.ref,
    headSha: detail.head.sha,
    createdAt: detail.created_at,
    updatedAt: detail.updated_at,
    mergeable: detail.mergeable,
    mergeableState: detail.mergeable_state ?? "unknown",
    labels: detail.labels.map((label) => label.name),
    checks,
  };
}

async function fetchChecks(
  pull: GitHubPullRequest,
  token?: string,
): Promise<PullRequestStatus["checks"]> {
  const repo = pull.head.repo;
  if (!repo) {
    return { state: "unavailable", total: 0, failing: 0, pending: 0 };
  }

  try {
    const response = await githubRequest<GitHubCheckRuns>(
      `/repos/${repo.full_name}/commits/${pull.head.sha}/check-runs?per_page=100`,
      token,
    );
    const failing = response.check_runs.filter((run) =>
      ["failure", "cancelled", "timed_out", "action_required"].includes(
        run.conclusion ?? "",
      ),
    ).length;
    const pending = response.check_runs.filter(
      (run) => run.status !== "completed",
    ).length;
    let state: PullRequestStatus["checks"]["state"] = "none";
    if (response.total_count > 0) {
      state = failing > 0 ? "failing" : pending > 0 ? "pending" : "passing";
    }
    return {
      state,
      total: response.total_count,
      failing,
      pending,
    };
  } catch {
    return { state: "unavailable", total: 0, failing: 0, pending: 0 };
  }
}

async function githubRequest<T>(path: string, token?: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token?.trim()
        ? { Authorization: `Bearer ${token.trim()}` }
        : undefined),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    const message = body?.message ?? response.statusText;
    throw new Error(`GitHub API ${response.status}: ${message}`);
  }

  return (await response.json()) as T;
}

async function githubRequestPages<T>(
  path: string,
  token: string | undefined,
  maxPages: number,
): Promise<T[]> {
  const separator = path.includes("?") ? "&" : "?";
  const pages = Array.from({ length: maxPages }, (_, index) =>
    githubRequest<T[]>(`${path}${separator}page=${index + 1}`, token),
  );
  const settled = await Promise.all(pages);
  return settled.flat();
}

function mapRepository(repo: GitHubRepository): RepositorySummary {
  return {
    fullName: repo.full_name,
    defaultBranch: repo.default_branch,
    htmlUrl: repo.html_url,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    openIssues: repo.open_issues_count,
    pushedAt: repo.pushed_at,
  };
}

function mapDriftCommit(commit: GitHubCompareCommit): DriftCommit {
  const subject = firstLine(commit.commit.message);
  return {
    sha: commit.sha,
    subject,
    author: commit.author?.login ?? commit.commit.author?.name ?? "unknown",
    date: commit.commit.author?.date ?? "",
    htmlUrl: commit.html_url,
    prNumbers: extractPrNumbers(subject),
  };
}

function buildCleanupCandidates(input: {
  aheadCommits: DriftCommit[];
  upstreamRecent: GitHubCommitListItem[];
  pullRequests: PullRequestStatus[];
}): CleanupCandidate[] {
  const upstreamSubjects = input.upstreamRecent.map((commit) => ({
    sha: commit.sha,
    subject: firstLine(commit.commit.message),
    normalized: normalizeSubject(firstLine(commit.commit.message)),
    prNumbers: extractPrNumbers(firstLine(commit.commit.message)),
    htmlUrl: commit.html_url,
  }));

  const openPullNumbers = new Set(input.pullRequests.map((pull) => pull.number));

  return input.aheadCommits.slice(0, 50).map((commit) => {
    const normalized = normalizeSubject(commit.subject);
    const exactSubject = upstreamSubjects.find(
      (upstream) => upstream.normalized === normalized,
    );
    const prMatch = upstreamSubjects.find((upstream) =>
      commit.prNumbers.some((number) => upstream.prNumbers.includes(number)),
    );
    const upstreamMatch = exactSubject ?? prMatch;

    if (upstreamMatch) {
      return {
        sha: commit.sha,
        subject: commit.subject,
        htmlUrl: commit.htmlUrl,
        confidence: exactSubject ? "high" : "medium",
        action: "drop-candidate",
        reason: exactSubject
          ? "Same normalized commit subject appears on upstream main."
          : "Same pull request number appears on upstream main.",
        upstreamMatch: {
          sha: upstreamMatch.sha,
          subject: upstreamMatch.subject,
          htmlUrl: upstreamMatch.htmlUrl,
        },
      };
    }

    if (commit.prNumbers.some((number) => openPullNumbers.has(number))) {
      return {
        sha: commit.sha,
        subject: commit.subject,
        htmlUrl: commit.htmlUrl,
        confidence: "medium",
        action: "keep-open-pr",
        reason: "Commit points at an open upstream pull request from this fork.",
      };
    }

    return {
      sha: commit.sha,
      subject: commit.subject,
      htmlUrl: commit.htmlUrl,
      confidence: "low",
      action: "manual-review",
      reason: "No obvious upstream match found in the latest 100 commits.",
    };
  });
}

function firstLine(message: string): string {
  return message.split("\n")[0]?.trim() || "Untitled commit";
}

function normalizeSubject(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/\(#\d+\)/g, "")
    .replace(/#[0-9]+/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPrNumbers(subject: string): number[] {
  const matches = subject.matchAll(/#(\d+)/g);
  return Array.from(matches, (match) => Number(match[1])).filter(Number.isFinite);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
