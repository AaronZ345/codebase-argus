"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  buildAgentPrompt,
  buildAgentTaskPackage,
  buildConflictDossier,
  buildGitHubActionsWorkflow,
  buildPullRequestReviewWorkflow,
  parseAgentSessionLog,
} from "@/lib/agent-workflow";
import type { AgentLogSummary, RunbookMode } from "@/lib/agent-workflow";
import {
  fetchForkReport,
  fetchPullRequestReviewReport,
} from "@/lib/github";
import type {
  CleanupCandidate,
  ForkReport,
  PullRequestReviewReport,
  PullRequestStatus,
} from "@/lib/github";
import {
  buildRuleBasedReview,
  parsePullRequestRef,
} from "@/lib/pr-review";
import type {
  ReviewProvider,
  ReviewResult,
  ReviewSeverity,
} from "@/lib/pr-review";
import { parseReviewPolicy } from "@/lib/review-policy";
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
  const [runbookMode, setRunbookMode] = useState<RunbookMode>("inspect");
  const [agentLog, setAgentLog] = useState("");
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [copiedTaskPackage, setCopiedTaskPackage] = useState(false);
  const [copiedWorkflow, setCopiedWorkflow] = useState(false);
  const [actionSchedule, setActionSchedule] = useState("17 1 * * *");
  const [actionIssueNumber, setActionIssueNumber] = useState("");
  const [prRef, setPrRef] = useState("");
  const [prReport, setPrReport] = useState<PullRequestReviewReport | null>(null);
  const [prReview, setPrReview] = useState<ReviewResult | null>(null);
  const [prError, setPrError] = useState("");
  const [prLoading, setPrLoading] = useState(false);
  const [agentReviewLoading, setAgentReviewLoading] = useState(false);
  const [agentReviewProvider, setAgentReviewProvider] =
    useState<ReviewProvider>("openai-api");
  const [agentReviewModel, setAgentReviewModel] = useState("");
  const [tribunalProviders, setTribunalProviders] = useState(
    "openai-api, anthropic-api, gemini-api",
  );
  const [policyText, setPolicyText] = useState([
    "requiredChecks: passing",
    "maxChangedFiles: 30",
    "maxTotalDelta: 1200",
    "forbiddenWorkflowPatterns:",
    "  - pull_request_target",
  ].join("\n"));
  const [reviewEndpoint, setReviewEndpoint] = useState("");
  const [copiedPrWorkflow, setCopiedPrWorkflow] = useState(false);
  const [copiedReviewMarkdown, setCopiedReviewMarkdown] = useState(false);
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

  async function handlePullRequestAnalyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPrError("");
    setPrLoading(true);

    try {
      const ref = parsePullRequestRef(prRef);
      const nextReport = await fetchPullRequestReviewReport({
        owner: ref.owner,
        repo: ref.repo,
        number: ref.number,
        token,
      });
      const baseline = buildRuleBasedReview(
        nextReport,
        parseReviewPolicy(policyText),
      );
      setPrReport(nextReport);
      setPrReview(baseline);
    } catch (caught) {
      setPrReport(null);
      setPrReview(null);
      setPrError(caught instanceof Error ? caught.message : "PR review failed.");
    } finally {
      setPrLoading(false);
    }
  }

  async function handleAgentReview() {
    if (!prReport) {
      setPrError("Analyze a pull request before running an agent review.");
      return;
    }
    if (hostedDemo) {
      setPrError("Agent review needs a local or server deployment with API keys or CLIs.");
      return;
    }

    setPrError("");
    setAgentReviewLoading(true);
    try {
      const response = await fetch("/api/pr-agent-review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: agentReviewProvider,
          model: agentReviewModel,
          policy: parseReviewPolicy(policyText),
          report: prReport,
        }),
      });
      const body = (await response.json()) as ReviewResult | { error?: string };
      if (!response.ok) {
        throw new Error(
          "error" in body && body.error ? body.error : "Agent review failed.",
        );
      }
      setPrReview(body as ReviewResult);
    } catch (caught) {
      setPrError(
        caught instanceof Error ? caught.message : "Agent review failed.",
      );
    } finally {
      setAgentReviewLoading(false);
    }
  }

  async function handleTribunalReview() {
    if (!prReport) {
      setPrError("Analyze a pull request before running tribunal review.");
      return;
    }
    if (hostedDemo) {
      setPrError("Tribunal review needs a local or server deployment with API keys or CLIs.");
      return;
    }

    const providers = tribunalProviders
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => ({ provider: value as ReviewProvider }));
    if (!providers.length) {
      setPrError("Enter at least one tribunal provider.");
      return;
    }

    setPrError("");
    setAgentReviewLoading(true);
    try {
      const response = await fetch("/api/pr-agent-review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          providers,
          policy: parseReviewPolicy(policyText),
          report: prReport,
        }),
      });
      const body = (await response.json()) as ReviewResult | { error?: string };
      if (!response.ok) {
        throw new Error(
          "error" in body && body.error ? body.error : "Tribunal review failed.",
        );
      }
      setPrReview(body as ReviewResult);
    } catch (caught) {
      setPrError(
        caught instanceof Error ? caught.message : "Tribunal review failed.",
      );
    } finally {
      setAgentReviewLoading(false);
    }
  }

  const summary = useMemo(() => buildSummary(report), [report]);
  const upstreamBranch =
    report?.upstream.defaultBranch ?? localReport?.upstream.branch ?? "main";
  const forkBranch =
    report?.fork.defaultBranch ?? localReport?.fork.branch ?? "main";
  const upstreamRepo = upstream || "upstream-owner/repo";
  const forkRepo = fork || "fork-owner/repo";
  const prHeadRepo = prHead || fork || "fork-owner/repo";
  const actionsWorkflow = useMemo(
    () =>
      buildGitHubActionsWorkflow({
        upstream: upstreamRepo,
        fork: forkRepo,
        prHead: prHeadRepo,
        upstreamBranch,
        forkBranch,
        scheduleCron: actionSchedule,
        issueNumber: actionIssueNumber,
      }),
    [
      actionIssueNumber,
      actionSchedule,
      forkBranch,
      forkRepo,
      prHeadRepo,
      upstreamBranch,
      upstreamRepo,
    ],
  );
  const agentTaskPackage = useMemo(
    () =>
      buildAgentTaskPackage({
        upstream: upstreamRepo,
        fork: forkRepo,
        upstreamBranch,
        forkBranch,
        mode: runbookMode,
        report: localReport,
      }),
    [forkBranch, forkRepo, localReport, runbookMode, upstreamBranch, upstreamRepo],
  );
  const agentPrompt = useMemo(
    () =>
      buildAgentPrompt({
        upstream: upstreamRepo,
        fork: forkRepo,
        upstreamBranch,
        forkBranch,
        mode: runbookMode,
        report: localReport,
      }),
    [
      forkBranch,
      forkRepo,
      localReport,
      runbookMode,
      upstreamBranch,
      upstreamRepo,
    ],
  );
  const agentLogSummary = useMemo(
    () => (agentLog.trim() ? parseAgentSessionLog(agentLog) : null),
    [agentLog],
  );

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

      <PullRequestReviewPanel
        prRef={prRef}
        onPrRefChange={setPrRef}
        loading={prLoading}
        onAnalyze={handlePullRequestAnalyze}
        report={prReport}
        review={prReview}
        error={prError}
        provider={agentReviewProvider}
        onProviderChange={setAgentReviewProvider}
        model={agentReviewModel}
        onModelChange={setAgentReviewModel}
        tribunalProviders={tribunalProviders}
        onTribunalProvidersChange={setTribunalProviders}
        policyText={policyText}
        onPolicyTextChange={setPolicyText}
        reviewEndpoint={reviewEndpoint}
        onReviewEndpointChange={setReviewEndpoint}
        agentLoading={agentReviewLoading}
        onAgentReview={handleAgentReview}
        onTribunalReview={handleTribunalReview}
        hostedDemo={hostedDemo}
        copiedPrWorkflow={copiedPrWorkflow}
        onCopyPrWorkflow={async () => {
          const workflow = buildPullRequestReviewWorkflow({
            reviewEndpoint,
            provider: agentReviewProvider,
          });
          await navigator.clipboard.writeText(workflow);
          setCopiedPrWorkflow(true);
          window.setTimeout(() => setCopiedPrWorkflow(false), 1400);
        }}
        copiedMarkdown={copiedReviewMarkdown}
        onCopyMarkdown={async () => {
          if (!prReview) {
            return;
          }
          await navigator.clipboard.writeText(prReview.markdown);
          setCopiedReviewMarkdown(true);
          window.setTimeout(() => setCopiedReviewMarkdown(false), 1400);
        }}
      />

      <LocalRiskPanel
        localReport={localReport}
        localError={localError}
        loading={localLoading}
        onAnalyze={handleLocalAnalyze}
        hostedDemo={hostedDemo}
      />

      <ActionsWorkflowPanel
        schedule={actionSchedule}
        onScheduleChange={setActionSchedule}
        issueNumber={actionIssueNumber}
        onIssueNumberChange={setActionIssueNumber}
        workflow={actionsWorkflow}
        copiedWorkflow={copiedWorkflow}
        onCopyWorkflow={async () => {
          await navigator.clipboard.writeText(actionsWorkflow);
          setCopiedWorkflow(true);
          window.setTimeout(() => setCopiedWorkflow(false), 1400);
        }}
      />

      <AgentWorkflowPanel
        mode={runbookMode}
        onModeChange={setRunbookMode}
        prompt={agentPrompt}
        copiedPrompt={copiedPrompt}
        onCopyPrompt={async () => {
          await navigator.clipboard.writeText(agentPrompt);
          setCopiedPrompt(true);
          window.setTimeout(() => setCopiedPrompt(false), 1400);
        }}
        taskPackage={agentTaskPackage}
        copiedTaskPackage={copiedTaskPackage}
        onCopyTaskPackage={async () => {
          await navigator.clipboard.writeText(agentTaskPackage);
          setCopiedTaskPackage(true);
          window.setTimeout(() => setCopiedTaskPackage(false), 1400);
        }}
        localReport={localReport}
        agentLog={agentLog}
        onAgentLogChange={setAgentLog}
        agentLogSummary={agentLogSummary}
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

function PullRequestReviewPanel({
  prRef,
  onPrRefChange,
  loading,
  onAnalyze,
  report,
  review,
  error,
  provider,
  onProviderChange,
  model,
  onModelChange,
  tribunalProviders,
  onTribunalProvidersChange,
  policyText,
  onPolicyTextChange,
  reviewEndpoint,
  onReviewEndpointChange,
  agentLoading,
  onAgentReview,
  onTribunalReview,
  hostedDemo,
  copiedPrWorkflow,
  onCopyPrWorkflow,
  copiedMarkdown,
  onCopyMarkdown,
}: {
  prRef: string;
  onPrRefChange: (value: string) => void;
  loading: boolean;
  onAnalyze: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  report: PullRequestReviewReport | null;
  review: ReviewResult | null;
  error: string;
  provider: ReviewProvider;
  onProviderChange: (value: ReviewProvider) => void;
  model: string;
  onModelChange: (value: string) => void;
  tribunalProviders: string;
  onTribunalProvidersChange: (value: string) => void;
  policyText: string;
  onPolicyTextChange: (value: string) => void;
  reviewEndpoint: string;
  onReviewEndpointChange: (value: string) => void;
  agentLoading: boolean;
  onAgentReview: () => Promise<void>;
  onTribunalReview: () => Promise<void>;
  hostedDemo: boolean;
  copiedPrWorkflow: boolean;
  onCopyPrWorkflow: () => Promise<void>;
  copiedMarkdown: boolean;
  onCopyMarkdown: () => Promise<void>;
}) {
  return (
    <article className="panel pr-review-panel">
      <div className="panel-header">
        <div>
          <h2>PR Review</h2>
          <p>
            Review a normal GitHub pull request with baseline checks, then hand
            the same context to Codex, Claude, Gemini, or an API model.
          </p>
        </div>
        {review ? (
          <StatusPill tone={riskTone(review.risk)} label={`${review.risk} risk`} />
        ) : null}
      </div>

      <div className="pr-review-grid">
        <form className="pr-review-controls" onSubmit={onAnalyze}>
          <label className="compact-field">
            Pull request
            <input
              value={prRef}
              onChange={(event) => onPrRefChange(event.target.value)}
              placeholder="owner/repo#123 or GitHub PR URL"
              spellCheck={false}
            />
          </label>
          <div className="inline-actions">
            <button type="submit" disabled={loading}>
              {loading ? "Fetching PR..." : "Analyze PR"}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={onCopyMarkdown}
              disabled={!review}
            >
              {copiedMarkdown ? "Copied" : "Copy markdown"}
            </button>
          </div>

          <div className="agent-review-controls">
            <label className="compact-field">
              Policy as code
              <textarea
                value={policyText}
                onChange={(event) => onPolicyTextChange(event.target.value)}
                className="policy-box"
                spellCheck={false}
              />
            </label>
            <label className="compact-field">
              Agent provider
              <select
                value={provider}
                onChange={(event) =>
                  onProviderChange(event.target.value as ReviewProvider)
                }
              >
                <option value="openai-api">OpenAI API</option>
                <option value="anthropic-api">Anthropic API</option>
                <option value="gemini-api">Gemini API</option>
                <option value="codex-cli">Codex CLI</option>
                <option value="claude-cli">Claude CLI</option>
                <option value="gemini-cli">Gemini CLI</option>
              </select>
            </label>
            <label className="compact-field">
              Model override
              <input
                value={model}
                onChange={(event) => onModelChange(event.target.value)}
                placeholder="Optional"
                spellCheck={false}
              />
            </label>
            <button
              type="button"
              className="secondary-button"
              onClick={onAgentReview}
              disabled={!report || agentLoading || hostedDemo}
            >
              {hostedDemo
                ? "Server-only"
                : agentLoading
                  ? "Running agent..."
                  : "Run agent review"}
            </button>
            <label className="compact-field">
              Tribunal providers
              <input
                value={tribunalProviders}
                onChange={(event) => onTribunalProvidersChange(event.target.value)}
                spellCheck={false}
              />
            </label>
            <button
              type="button"
              className="secondary-button"
              onClick={onTribunalReview}
              disabled={!report || agentLoading || hostedDemo}
            >
              {agentLoading ? "Running tribunal..." : "Run tribunal"}
            </button>
            <label className="compact-field">
              Review endpoint
              <input
                value={reviewEndpoint}
                onChange={(event) => onReviewEndpointChange(event.target.value)}
                placeholder="Optional endpoint for generated Actions workflow"
                spellCheck={false}
              />
            </label>
            <button
              type="button"
              className="secondary-button"
              onClick={onCopyPrWorkflow}
            >
              {copiedPrWorkflow ? "Copied" : "Copy PR Action"}
            </button>
            <p className="small-muted no-pad">
              API keys stay on the server. CLI providers run locally in
              review-only mode and return draft findings.
            </p>
          </div>
        </form>

        <div className="pr-review-main">
          {error ? <div className="inline-error standalone">{error}</div> : null}

          {report ? (
            <div className="pr-facts">
              <div>
                <span>Repository</span>
                <strong>{report.repository.fullName}</strong>
              </div>
              <div>
                <span>PR</span>
                <strong>#{report.pullRequest.number}</strong>
              </div>
              <div>
                <span>Checks</span>
                <StatusPill
                  tone={checkTone(report.checks.state)}
                  label={checksLabel(report.checks)}
                />
              </div>
              <div>
                <span>Policy</span>
                <strong>
                  {parseReviewPolicy(policyText).requiredChecks === "passing"
                    ? "checks required"
                    : "checks optional"}
                </strong>
              </div>
              <div>
                <span>Delta</span>
                <strong>
                  +{formatNumber(report.pullRequest.additions)} / -
                  {formatNumber(report.pullRequest.deletions)}
                </strong>
              </div>
            </div>
          ) : (
            <p className="muted">
              This mode works for upstream maintainers too: paste a PR URL,
              inspect the local baseline, then optionally ask an agent for a
              structured review.
            </p>
          )}

          {review ? (
            <div className="review-result">
              <div className="block-heading">
                <div>
                  <h3>{review.provider} review</h3>
                  <p>{review.summary}</p>
                </div>
                <StatusPill tone={riskTone(review.risk)} label={review.risk} />
              </div>
              <ReviewFindingList findings={review.findings} />
              <textarea
                readOnly
                value={review.markdown}
                className="review-markdown-box"
              />
            </div>
          ) : null}

          {report ? <PullRequestFileTable report={report} /> : null}
        </div>
      </div>
    </article>
  );
}

function ReviewFindingList({ findings }: { findings: ReviewResult["findings"] }) {
  return (
    <div className="finding-list">
      {findings.map((finding, index) => (
        <div className="finding-card" key={`${finding.title}-${index}`}>
          <div className="block-heading">
            <h4>{finding.title}</h4>
            <StatusPill
              tone={severityTone(finding.severity)}
              label={finding.severity}
            />
          </div>
          {finding.file ? <code>{finding.file}</code> : null}
          <p>{finding.detail}</p>
          <span>{finding.recommendation}</span>
          {finding.evidence.length ? (
            <ul className="evidence-list">
              {finding.evidence.map((evidence, index) => (
                <li key={`${evidence.label}-${index}`}>
                  <strong>{evidence.label}</strong>
                  <span>
                    {evidence.file ? <code>{evidence.file}</code> : null}
                    {evidence.detail}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function PullRequestFileTable({
  report,
}: {
  report: PullRequestReviewReport;
}) {
  return (
    <div className="file-risk-table">
      <div className="block-heading">
        <h3>Changed files</h3>
        <span>{report.files.length} files</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th>Status</th>
              <th>Delta</th>
              <th>Risk cue</th>
            </tr>
          </thead>
          <tbody>
            {report.files.slice(0, 20).map((file) => {
              const cue = reviewFileCue(file.filename, file.patch);
              return (
                <tr key={file.filename}>
                  <td>
                    <a href={file.blobUrl} target="_blank" rel="noreferrer">
                      <code>{file.filename}</code>
                    </a>
                  </td>
                  <td>{file.status}</td>
                  <td>
                    +{formatNumber(file.additions)} / -
                    {formatNumber(file.deletions)}
                  </td>
                  <td>
                    <StatusPill tone={cue.tone} label={cue.label} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ActionsWorkflowPanel({
  schedule,
  onScheduleChange,
  issueNumber,
  onIssueNumberChange,
  workflow,
  copiedWorkflow,
  onCopyWorkflow,
}: {
  schedule: string;
  onScheduleChange: (value: string) => void;
  issueNumber: string;
  onIssueNumberChange: (value: string) => void;
  workflow: string;
  copiedWorkflow: boolean;
  onCopyWorkflow: () => Promise<void>;
}) {
  return (
    <article className="panel actions-panel">
      <div className="panel-header">
        <div>
          <h2>GitHub Actions Mode</h2>
          <p>
            Generate a workflow that posts the drift report to the run summary
            and optionally comments on a tracking issue.
          </p>
        </div>
        <button type="button" className="secondary-button" onClick={onCopyWorkflow}>
          {copiedWorkflow ? "Copied" : "Copy workflow"}
        </button>
      </div>

      <div className="actions-grid">
        <div className="actions-controls">
          <label className="compact-field">
            Schedule cron
            <input
              value={schedule}
              onChange={(event) => onScheduleChange(event.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="compact-field">
            Issue number, optional
            <input
              value={issueNumber}
              onChange={(event) => onIssueNumberChange(event.target.value)}
              inputMode="numeric"
              placeholder="42"
              spellCheck={false}
            />
          </label>
          <ul className="action-notes">
            <li>Runs on schedule, manual dispatch, or upstream-updated dispatch.</li>
            <li>Uses local git on the runner; no write operation except issue comment.</li>
            <li>Reports behind/ahead counts, merge-tree conflicts, cherry evidence, and range-diff.</li>
          </ul>
        </div>

        <textarea readOnly value={workflow} className="workflow-box" />
      </div>
    </article>
  );
}

function AgentWorkflowPanel({
  mode,
  onModeChange,
  prompt,
  copiedPrompt,
  onCopyPrompt,
  taskPackage,
  copiedTaskPackage,
  onCopyTaskPackage,
  localReport,
  agentLog,
  onAgentLogChange,
  agentLogSummary,
}: {
  mode: RunbookMode;
  onModeChange: (mode: RunbookMode) => void;
  prompt: string;
  copiedPrompt: boolean;
  onCopyPrompt: () => Promise<void>;
  taskPackage: string;
  copiedTaskPackage: boolean;
  onCopyTaskPackage: () => Promise<void>;
  localReport: LocalAnalysisReport | null;
  agentLog: string;
  onAgentLogChange: (value: string) => void;
  agentLogSummary: AgentLogSummary | null;
}) {
  const dossier = localReport ? buildConflictDossier(localReport) : null;

  return (
    <article className="panel agent-panel">
      <div className="panel-header">
        <div>
          <h2>Agent Workflow</h2>
          <p>
            Export a safe task prompt, inspect conflict evidence, and paste an
            agent execution log back for a quick safety read.
          </p>
        </div>
        <label className="mode-picker">
          Mode
          <select
            value={mode}
            onChange={(event) => onModeChange(event.target.value as RunbookMode)}
          >
            <option value="inspect">Inspect only</option>
            <option value="prepare">Prepare rebase</option>
            <option value="execute">Execute with gate</option>
          </select>
        </label>
      </div>

      <div className="agent-grid">
        <div className="agent-block wide">
          <div className="block-heading">
            <h3>Task package</h3>
            <button
              type="button"
              className="secondary-button"
              onClick={onCopyTaskPackage}
            >
              {copiedTaskPackage ? "Copied" : "Copy package"}
            </button>
          </div>
          <textarea readOnly value={taskPackage} className="package-box" />
        </div>

        <div className="agent-block wide">
          <div className="block-heading">
            <h3>Prompt export</h3>
            <button type="button" className="secondary-button" onClick={onCopyPrompt}>
              {copiedPrompt ? "Copied" : "Copy prompt"}
            </button>
          </div>
          <textarea readOnly value={prompt} className="prompt-box" />
        </div>

        <div className="agent-block">
          <h3>Conflict dossier</h3>
          {dossier ? (
            <div className="dossier">
              <StatusPill
                tone={dossier.risk === "clean" ? "good" : "bad"}
                label={dossier.risk === "clean" ? "Clean" : "Conflict"}
              />
              <p>{dossier.summary}</p>
              {dossier.files.length ? (
                <ul className="compact-list">
                  {dossier.files.map((file) => (
                    <li key={file.path}>
                      <code>{file.path}</code>
                      <span>
                        {file.risk} risk · {file.reason}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <ol className="instruction-list">
                {dossier.instructions.map((instruction) => (
                  <li key={instruction}>{instruction}</li>
                ))}
              </ol>
            </div>
          ) : (
            <p className="small-muted">
              Run local risk to generate conflict-specific agent instructions.
            </p>
          )}
        </div>

        <div className="agent-block">
          <h3>Patch evidence</h3>
          {localReport ? (
            <div className="range-summary">
              <div>
                <strong>{localReport.cherry.covered.length}</strong>
                <span>covered</span>
              </div>
              <div>
                <strong>{localReport.cherry.unique.length}</strong>
                <span>unique</span>
              </div>
              <div>
                <strong>{localReport.rangeDiff.summary.changed}</strong>
                <span>changed</span>
              </div>
              <pre>
                {localReport.rangeDiff.lines.slice(0, 24).join("\n") ||
                  "No range-diff output."}
              </pre>
            </div>
          ) : (
            <p className="small-muted">
              Local risk adds git cherry and range-diff evidence here.
            </p>
          )}
        </div>

        <div className="agent-block wide">
          <div className="block-heading">
            <h3>Agent session log review</h3>
            {agentLogSummary ? (
              <StatusPill
                tone={agentLogSummary.safeToPush ? "good" : "warn"}
                label={agentLogSummary.safeToPush ? "Looks safe" : "Needs review"}
              />
            ) : null}
          </div>
          <textarea
            value={agentLog}
            onChange={(event) => onAgentLogChange(event.target.value)}
            className="log-box"
            placeholder="Paste the agent's execution log here after it runs the prompt..."
          />
          {agentLogSummary ? <AgentLogSummaryView summary={agentLogSummary} /> : null}
        </div>
      </div>
    </article>
  );
}

function AgentLogSummaryView({ summary }: { summary: AgentLogSummary }) {
  const rows = [
    ["Fetched", summary.fetched],
    ["Backup", summary.backupCreated],
    ["Rebase", summary.rebaseAttempted],
    ["Tests passed", summary.testsPassed],
    ["Tests failed", summary.testsFailed],
    ["Pushed", summary.pushed],
    ["Safe to push", summary.safeToPush],
  ] as const;

  return (
    <div className="log-summary">
      <div className="log-signal-grid">
        {rows.map(([label, active]) => (
          <span className={active ? "active" : ""} key={label}>
            {label}
          </span>
        ))}
      </div>
      {summary.conflicts.length ? (
        <div>
          <h4>Conflicts</h4>
          <ul className="compact-list">
            {summary.conflicts.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <h4>Notes</h4>
        <ul className="compact-list">
          {summary.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
    </div>
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
            <h3>Worktree rebase simulation</h3>
            <StatusPill
              tone={localReport.rebaseSimulation.clean ? "good" : "bad"}
              label={localReport.rebaseSimulation.clean ? "Clean" : "Conflict"}
            />
            {localReport.rebaseSimulation.conflictFiles.length ? (
              <ul className="compact-list">
                {localReport.rebaseSimulation.conflictFiles.map((file) => (
                  <li key={file}>
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small-muted">
                Temporary worktree rebase did not report conflicts.
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
  return checksLabel(pull.checks);
}

function checksLabel(checks: PullRequestStatus["checks"]) {
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

function riskTone(risk: ReviewResult["risk"]) {
  if (risk === "critical" || risk === "high") {
    return "bad" as const;
  }
  if (risk === "medium") {
    return "warn" as const;
  }
  return "good" as const;
}

function severityTone(severity: ReviewSeverity) {
  if (severity === "critical" || severity === "high") {
    return "bad" as const;
  }
  if (severity === "medium") {
    return "warn" as const;
  }
  if (severity === "low") {
    return "neutral" as const;
  }
  return "good" as const;
}

function reviewFileCue(filename: string, patch?: string) {
  const haystack = `${filename}\n${patch ?? ""}`.toLowerCase();
  if (filename.startsWith(".github/workflows/") || haystack.includes("pull_request_target")) {
    return { tone: "bad" as const, label: "workflow" };
  }
  if (
    ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"].some((name) =>
      filename.endsWith(name),
    )
  ) {
    return { tone: "warn" as const, label: "dependency" };
  }
  if (
    ["auth", "secret", "token", "payment", "webhook", "signature"].some((term) =>
      haystack.includes(term),
    )
  ) {
    return { tone: "bad" as const, label: "security" };
  }
  if (/\.(test|spec)\.(ts|tsx|js|jsx|py|go|rs)$/i.test(filename)) {
    return { tone: "good" as const, label: "test" };
  }
  if (/\.(md|mdx|txt|rst)$/i.test(filename)) {
    return { tone: "neutral" as const, label: "docs" };
  }
  return { tone: "warn" as const, label: "source" };
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
