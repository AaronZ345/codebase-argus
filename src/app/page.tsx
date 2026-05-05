"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  CleanupCandidate,
  fetchForkReport,
  ForkReport,
  PullRequestStatus,
} from "@/lib/github";
import { formatDate, formatNumber, relativeTime, shortSha } from "@/lib/format";

const DEFAULT_UPSTREAM = "chenhg5/cc-connect";
const DEFAULT_FORK = "AaronZ345/cc-connect";
const DEFAULT_PR_HEAD = "Cigarrr/cc-connect";
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
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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
              placeholder="owner/repo"
              spellCheck={false}
            />
          </label>
          <label>
            Fork repository
            <input
              value={fork}
              onChange={(event) => setFork(event.target.value)}
              placeholder="owner/repo"
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
              onClick={() => {
                setUpstream(DEFAULT_UPSTREAM);
                setFork(DEFAULT_FORK);
                setPrHead(DEFAULT_PR_HEAD);
                setReport(null);
                setError("");
              }}
            >
              Reset sample
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
            The default pair points at cc-connect. Run it to inspect the same
            fork/upstream maintenance problem this tool is built for.
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
        label: "Default pair",
        value: "cc-connect",
        detail: "Configured for the current upstream/fork workflow.",
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
