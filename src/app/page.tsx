"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  CleanupCandidate,
  fetchForkReport,
  ForkReport,
  PullRequestStatus,
} from "@/lib/github";
import { formatDate, formatNumber, relativeTime, shortSha } from "@/lib/format";
import type { LocalAnalysisReport } from "@/lib/local-analyzer";

const DEFAULT_UPSTREAM = "";
const DEFAULT_FORK = "";
const DEFAULT_PR_HEAD = "";
const STORAGE_KEY = "fork-drift-sentinel:repos";

type SavedRepos = {
  upstream: string;
  fork: string;
  prHead: string;
};

export default function Home() {
  const [upstream, setUpstream] = useState(DEFAULT_UPSTREAM);
  const [fork, setFork] = useState(DEFAULT_FORK);
  const [prHead, setPrHead] = useState(DEFAULT_PR_HEAD);
  const [token, setToken] = useState("");
  const [report, setReport] = useState<ForkReport | null>(null);
  const [localReport, setLocalReport] = useState<LocalAnalysisReport | null>(
    null,
  );
  const [error, setError] = useState("");
  const [localError, setLocalError] = useState("");
  const [loading, setLoading] = useState(false);
  const [localLoading, setLocalLoading] = useState(false);
  const hostedDemo = process.env.NEXT_PUBLIC_HOSTED_DEMO === "true";

  useEffect(() => {
    const restore = window.setTimeout(() => {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return;
      }
      try {
        const saved = JSON.parse(raw) as SavedRepos;
        if (saved.upstream) {
          setUpstream(saved.upstream);
        }
        if (saved.fork) {
          setFork(saved.fork);
        }
        if (saved.prHead) {
          setPrHead(saved.prHead);
        }
      } catch {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    }, 0);

    return () => window.clearTimeout(restore);
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const nextReport = await fetchForkReport({
        upstream,
        fork,
        prHead,
        token,
      });
      setReport(nextReport);
      setLocalReport(null);
      setLocalError("");
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ upstream, fork, prHead }),
      );
    } catch (caught) {
      setReport(null);
      setError(caught instanceof Error ? caught.message : "Unknown error.");
    } finally {
      setLoading(false);
    }
  }

  async function handleLocalAnalyze() {
    if (hostedDemo) {
      setLocalReport(null);
      setLocalError(
        "Local rebase risk analysis is available only when running the app on your machine.",
      );
      return;
    }

    setLocalError("");
    setLocalLoading(true);
    try {
      const response = await fetch("/api/local-analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          upstream,
          fork,
          upstreamBranch: report?.upstream.defaultBranch ?? "main",
          forkBranch: report?.fork.defaultBranch ?? "main",
        }),
      });
      const body = (await response.json()) as
        | LocalAnalysisReport
        | { error?: string };
      if (!response.ok) {
        throw new Error(
          "error" in body && body.error ? body.error : "Local analysis failed.",
        );
      }
      setLocalReport(body as LocalAnalysisReport);
    } catch (caught) {
      setLocalReport(null);
      setLocalError(
        caught instanceof Error ? caught.message : "Local analysis failed.",
      );
    } finally {
      setLocalLoading(false);
    }
  }

  const summary = useMemo(() => buildSummary(report), [report]);

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <div className="brand-row">
            <span className="brand-mark">FD</span>
            <span className="brand-name">Fork Drift Sentinel</span>
          </div>
          <h1>Track fork drift before it becomes PR debt.</h1>
          <p>
            Compare an upstream repository with a long-lived fork, inspect open
            pull requests from that fork, and surface commits that may already
            be covered upstream.
          </p>
        </div>

        <form className="repo-form" onSubmit={handleSubmit}>
          <label>
            Upstream repository
            <input
              value={upstream}
              onChange={(event) => setUpstream(event.target.value)}
              placeholder="upstream-owner/repo"
              spellCheck={false}
            />
          </label>
          <label>
            Fork repository
            <input
              value={fork}
              onChange={(event) => setFork(event.target.value)}
              placeholder="fork-owner/repo"
              spellCheck={false}
            />
          </label>
          <label>
            PR head repository
            <input
              value={prHead}
              onChange={(event) => setPrHead(event.target.value)}
              placeholder="Defaults to fork repository"
              spellCheck={false}
            />
          </label>
          <label>
            GitHub token, optional
            <input
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Only used in this browser session"
              type="password"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="form-actions">
            <button type="submit" disabled={loading}>
              {loading ? "Analyzing..." : "Analyze drift"}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={handleLocalAnalyze}
              disabled={localLoading || hostedDemo}
            >
              {hostedDemo
                ? "Local risk is local-only"
                : localLoading
                  ? "Running git..."
                  : "Run local risk"}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setUpstream(DEFAULT_UPSTREAM);
                setFork(DEFAULT_FORK);
                setPrHead(DEFAULT_PR_HEAD);
                setReport(null);
                setLocalReport(null);
                setError("");
                setLocalError("");
                window.localStorage.removeItem(STORAGE_KEY);
              }}
            >
              Clear
            </button>
          </div>
          <p className="privacy-note">
            Token is never stored. Public repositories work without one, but
            GitHub rate limits unauthenticated requests.
          </p>
        </form>
      </section>

      {error ? <div className="error-panel">{error}</div> : null}

      <section className="summary-grid" aria-label="Summary">
        {summary.map((item) => (
          <article className="metric-card" key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            <p>{item.detail}</p>
          </article>
        ))}
      </section>

      <LocalRiskPanel
        localReport={localReport}
        localError={localError}
        loading={localLoading}
        onAnalyze={handleLocalAnalyze}
        hostedDemo={hostedDemo}
      />

      {report ? (
        <section className="dashboard">
          <DriftPanel report={report} />
          <PullRequestPanel report={report} />
          <CleanupPanel candidates={report.cleanupCandidates} />
          <MethodPanel report={report} />
        </section>
      ) : (
        <section className="empty-state">
          <h2>Start with a repository pair.</h2>
          <p>
            Enter an upstream repository and a fork repository. If the PR head
            fork differs from the branch you track for drift, fill that in too.
            If GitHub API rate limits block the browser report, use Local Risk
            directly.
          </p>
        </section>
      )}
    </main>
  );
}

function DriftPanel({ report }: { report: ForkReport }) {
  const commits = report.compare.commits.slice(0, 12);

  return (
    <article className="panel drift-panel">
      <div className="panel-header">
        <div>
          <h2>Fork Drift</h2>
          <p>
            {report.fork.fullName} vs {report.upstream.fullName}
          </p>
        </div>
        <a href={report.compare.htmlUrl} target="_blank" rel="noreferrer">
          Open compare
        </a>
      </div>

      <div className="branch-strip">
        <span>{report.upstream.defaultBranch}</span>
        <strong>
          {report.compare.behindBy} behind · {report.compare.aheadBy} ahead
        </strong>
        <span>{report.fork.defaultBranch}</span>
      </div>

      <div className="commit-list">
        {commits.length ? (
          commits.map((commit) => (
            <a
              className="commit-row"
              href={commit.htmlUrl}
              target="_blank"
              rel="noreferrer"
              key={commit.sha}
            >
              <code>{shortSha(commit.sha)}</code>
              <span>{commit.subject}</span>
              <small>
                {commit.author} · {relativeTime(commit.date)}
              </small>
            </a>
          ))
        ) : (
          <p className="muted">No ahead commits on the fork default branch.</p>
        )}
      </div>
    </article>
  );
}

function PullRequestPanel({ report }: { report: ForkReport }) {
  const pullRequests = report.pullRequests;

  return (
    <article className="panel pr-panel">
      <div className="panel-header">
        <div>
          <h2>PR Radar</h2>
          <p>
            Open upstream pull requests whose head repo is {report.prHead.fullName}.
          </p>
        </div>
      </div>

      {pullRequests.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>PR</th>
                <th>Branch</th>
                <th>Mergeability</th>
                <th>Checks</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {pullRequests.map((pull) => (
                <tr key={pull.number}>
                  <td>
                    <a href={pull.htmlUrl} target="_blank" rel="noreferrer">
                      #{pull.number} {pull.title}
                    </a>
                    <span className="row-subtext">
                      {pull.draft ? "Draft" : "Ready"} · {pull.author}
                    </span>
                  </td>
                  <td>
                    <code>{pull.headRef}</code>
                    <span className="row-subtext">into {pull.baseRef}</span>
                  </td>
                  <td>
                    <StatusPill
                      tone={mergeTone(pull)}
                      label={mergeLabel(pull)}
                    />
                  </td>
                  <td>
                    <StatusPill
                      tone={checkTone(pull.checks.state)}
                      label={checkLabel(pull)}
                    />
                  </td>
                  <td>{relativeTime(pull.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">
          No open pull requests from the PR head repository were found in the
          upstream repo.
        </p>
      )}
    </article>
  );
}

function LocalRiskPanel({
  localReport,
  localError,
  loading,
  onAnalyze,
  hostedDemo,
}: {
  localReport: LocalAnalysisReport | null;
  localError: string;
  loading: boolean;
  onAnalyze: () => Promise<void>;
  hostedDemo: boolean;
}) {
  return (
    <article className="panel local-risk-panel">
      <div className="panel-header">
        <div>
          <h2>Rebase Risk</h2>
          <p>
            Runs local git in a private cache to project conflicts and prepare
            an agent-safe runbook.
          </p>
        </div>
        <button
          type="button"
          onClick={onAnalyze}
          disabled={loading || hostedDemo}
        >
          {hostedDemo
            ? "Local-only"
            : loading
              ? "Running git..."
              : "Run local analysis"}
        </button>
      </div>

      {localError ? <div className="inline-error">{localError}</div> : null}

      {localReport ? (
        <div className="risk-grid">
          <div className="risk-summary">
            <StatusPill
              tone={localReport.mergeTree.clean ? "good" : "bad"}
              label={localReport.mergeTree.clean ? "Clean projection" : "Conflict"}
            />
            <strong>
              {localReport.compare.behindBy} behind ·{" "}
              {localReport.compare.aheadBy} ahead
            </strong>
            <p>
              Compared {localReport.fork.gitRef} against{" "}
              {localReport.upstream.gitRef} in {localReport.cache.label}.
            </p>
          </div>

          <div className="risk-block">
            <h3>Conflict files</h3>
            {localReport.mergeTree.conflictFiles.length ? (
              <ul className="compact-list">
                {localReport.mergeTree.conflictFiles.map((file) => (
                  <li key={file}>
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small-muted">
                `git merge-tree` reports no content conflicts.
              </p>
            )}
          </div>

          <div className="risk-block">
            <h3>Patch-equivalent commits</h3>
            {localReport.cherry.covered.length ? (
              <CommitMiniList commits={localReport.cherry.covered.slice(0, 8)} />
            ) : (
              <p className="small-muted">No patch-equivalent commits found.</p>
            )}
          </div>

          <div className="risk-block">
            <h3>Still unique</h3>
            {localReport.cherry.unique.length ? (
              <CommitMiniList commits={localReport.cherry.unique.slice(0, 8)} />
            ) : (
              <p className="small-muted">No unique fork commits remain.</p>
            )}
          </div>

          {localReport.mergeTree.messages.length ? (
            <div className="risk-block wide">
              <h3>Merge-tree messages</h3>
              <pre>{localReport.mergeTree.messages.join("\n")}</pre>
            </div>
          ) : null}

          <div className="risk-block wide">
            <h3>Agent runbook</h3>
            <ol className="runbook">
              {localReport.runbook.map((command) => (
                <li key={command}>
                  <code>{command}</code>
                </li>
              ))}
            </ol>
          </div>
        </div>
      ) : (
        <p className="muted">
          {hostedDemo
            ? "Hosted demo cannot run local git. Clone the repository and run the app locally to use rebase risk analysis."
            : "Run local analysis to clone/fetch repositories into `.cache/repos`. It does not need a GitHub token for public repos and will not modify your working copy. Without a GitHub report it assumes `main` as both branch names."}
        </p>
      )}
    </article>
  );
}

function CommitMiniList({
  commits,
}: {
  commits: Array<{ sha: string; subject: string }>;
}) {
  return (
    <ul className="compact-list">
      {commits.map((commit) => (
        <li key={commit.sha}>
          <code>{shortSha(commit.sha)}</code>
          <span>{commit.subject}</span>
        </li>
      ))}
    </ul>
  );
}

function CleanupPanel({ candidates }: { candidates: CleanupCandidate[] }) {
  return (
    <article className="panel cleanup-panel">
      <div className="panel-header">
        <div>
          <h2>Candidate Cleanup</h2>
          <p>Heuristic hints. Treat every drop suggestion as manual review.</p>
        </div>
      </div>

      <div className="candidate-list">
        {candidates.length ? (
          candidates.map((candidate) => (
            <div className="candidate-row" key={candidate.sha}>
              <div>
                <a href={candidate.htmlUrl} target="_blank" rel="noreferrer">
                  <code>{shortSha(candidate.sha)}</code> {candidate.subject}
                </a>
                <p>{candidate.reason}</p>
                {candidate.upstreamMatch ? (
                  <a
                    className="upstream-match"
                    href={candidate.upstreamMatch.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Upstream match: {shortSha(candidate.upstreamMatch.sha)} ·{" "}
                    {candidate.upstreamMatch.subject}
                  </a>
                ) : null}
              </div>
              <StatusPill
                tone={cleanupTone(candidate)}
                label={cleanupLabel(candidate)}
              />
            </div>
          ))
        ) : (
          <p className="muted">No fork-ahead commits to classify.</p>
        )}
      </div>
    </article>
  );
}

function MethodPanel({ report }: { report: ForkReport }) {
  return (
    <article className="panel method-panel">
      <div className="panel-header">
        <div>
          <h2>Report Notes</h2>
          <p>Generated {formatDate(report.generatedAt)} with read-only calls.</p>
        </div>
      </div>

      <ul>
        <li>
          Drift uses GitHub compare from upstream default branch to fork default
          branch.
        </li>
        <li>
          PR Radar filters upstream open PRs where the head repository equals
          the configured PR head repository.
        </li>
        <li>
          Cleanup candidates compare fork-ahead subjects against the latest 100
          upstream commits.
        </li>
        <li>
          Rebase Risk uses local git commands in `.cache/repos`; it creates no
          commits and does not push.
        </li>
        <li>
          The app never writes to GitHub and never stores your token.
        </li>
      </ul>
    </article>
  );
}

function StatusPill({
  tone,
  label,
}: {
  tone: "good" | "warn" | "bad" | "neutral";
  label: string;
}) {
  return <span className={`status-pill ${tone}`}>{label}</span>;
}

function buildSummary(report: ForkReport | null) {
  if (!report) {
    return [
      {
        label: "Mode",
        value: "Read-only",
        detail: "No write scopes, no database, no token persistence.",
      },
      {
        label: "Inputs",
        value: "Repos",
        detail: "Use owner/repo values or GitHub repository URLs.",
      },
      {
        label: "Signal",
        value: "Drift + PRs",
        detail: "Compares branches, open PRs, checks, and cleanup hints.",
      },
      {
        label: "API",
        value: "GitHub REST",
        detail: "A real GitHub API integration suitable for iteration.",
      },
    ];
  }

  return [
    {
      label: "Fork ahead",
      value: formatNumber(report.compare.aheadBy),
      detail: `${report.fork.defaultBranch} commits ahead of upstream ${report.upstream.defaultBranch}.`,
    },
    {
      label: "Fork behind",
      value: formatNumber(report.compare.behindBy),
      detail: "Commits that upstream has and the fork default branch lacks.",
    },
    {
      label: "Open PRs",
      value: formatNumber(report.pullRequests.length),
      detail: `Open upstream PRs from ${report.prHead.fullName}.`,
    },
    {
      label: "Cleanup hints",
      value: formatNumber(report.cleanupCandidates.length),
      detail: "Fork-ahead commits classified by lightweight heuristics.",
    },
  ];
}

function mergeTone(pull: PullRequestStatus) {
  if (pull.mergeable === true) {
    return "good" as const;
  }
  if (pull.mergeable === false) {
    return "bad" as const;
  }
  return "warn" as const;
}

function mergeLabel(pull: PullRequestStatus) {
  if (pull.mergeable === true) {
    return pull.mergeableState === "clean" ? "Clean" : pull.mergeableState;
  }
  if (pull.mergeable === false) {
    return "Conflict";
  }
  return pull.mergeableState === "unknown" ? "Computing" : pull.mergeableState;
}

function checkTone(state: PullRequestStatus["checks"]["state"]) {
  switch (state) {
    case "passing":
      return "good" as const;
    case "failing":
      return "bad" as const;
    case "pending":
      return "warn" as const;
    default:
      return "neutral" as const;
  }
}

function checkLabel(pull: PullRequestStatus) {
  const { checks } = pull;
  if (checks.state === "none") {
    return "No checks";
  }
  if (checks.state === "unavailable") {
    return "Unavailable";
  }
  if (checks.state === "failing") {
    return `${checks.failing}/${checks.total} failing`;
  }
  if (checks.state === "pending") {
    return `${checks.pending}/${checks.total} pending`;
  }
  return `${checks.total} passing`;
}

function cleanupTone(candidate: CleanupCandidate) {
  if (candidate.action === "drop-candidate") {
    return candidate.confidence === "high" ? "good" : "warn";
  }
  if (candidate.action === "keep-open-pr") {
    return "neutral";
  }
  return "warn";
}

function cleanupLabel(candidate: CleanupCandidate) {
  if (candidate.action === "drop-candidate") {
    return candidate.confidence === "high" ? "Likely covered" : "Maybe covered";
  }
  if (candidate.action === "keep-open-pr") {
    return "Open PR";
  }
  return "Review";
}
