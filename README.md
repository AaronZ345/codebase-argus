# Fork Drift Sentinel

A read-only maintainer firewall for two related jobs:

- reviewing normal pull requests as an upstream maintainer;
- keeping a long-lived fork from drifting into unreviewable debt.

Live demo: <https://aaronz345.github.io/fork-drift-sentinel/>

The hosted demo can fetch public GitHub data from the browser. Local git
analysis, API model review, and CLI agent review need a local or server
deployment because they run server-side code.

## What It Does

### PR Review

Paste a GitHub PR URL or `owner/repo#123`.

Fork Drift Sentinel fetches:

- PR metadata, labels, branch info, mergeability, and size;
- changed files and patch excerpts;
- commit list;
- review history;
- check-run status.

It then produces a baseline review with risk cues for failing checks, missing
tests, workflow changes, dependency updates, security-sensitive paths, policy
violations, and large diffs. Findings include confidence and concrete evidence,
so the output is not just a model opinion.

### Evidence Engine

Each finding can carry evidence:

- check-run state;
- changed files;
- patch lines;
- policy gates;
- provider consensus;
- local git output for fork drift.

The review markdown includes those evidence lines so maintainers can decide
quickly whether a finding is worth attention.

### Policy As Code

The PR panel accepts a small `.fork-drift-sentinel.yml`-style policy. No extra
dependency is required; the parser handles JSON or simple YAML-like input.

Example:

```yaml
requiredChecks: passing
maxChangedFiles: 30
maxTotalDelta: 1200
requiredTestPatterns:
  - .test.ts
forbiddenWorkflowPatterns:
  - pull_request_target
sensitivePathPatterns:
  - auth
  - token
  - webhook
```

Policy findings are treated as first-class review findings with high-confidence
evidence.

### AI Review

The PR review context can be sent to:

- `openai-api`
- `anthropic-api`
- `gemini-api`
- `codex-cli`
- `claude-cli`
- `gemini-cli`

API keys stay on the server. The browser never sends or stores provider keys.
CLI providers run in non-interactive review mode and receive the PR context on
stdin. The result is normalized into the same shape: summary, risk, findings,
confidence, evidence, and copyable markdown.

### Multi-Agent Tribunal

Instead of trusting one reviewer, run several providers on the same PR. Fork
Drift Sentinel groups matching findings by category, file, and title. If two or
more providers report the same issue, confidence is raised and the finding lists
the providers that agreed. Provider failures are kept as visible findings, not
hidden in logs.

### Fork Drift

For fork maintenance, enter an upstream repository, a fork repository, and
optionally a separate PR head repository.

The dashboard shows:

- default-branch ahead/behind count;
- open upstream PRs from the configured head repository;
- mergeability and checks for those PRs;
- fork-ahead commits that may already be covered upstream.

### Local Rebase Risk

When running locally, the app can use `git` inside `.cache/repos` to inspect
drift more deeply:

- projected conflict files from `git merge-tree`;
- an actual temporary worktree rebase simulation;
- patch-equivalent commits from `git cherry`;
- semantic patch movement from `git range-diff`;
- an agent-safe runbook for inspect, prepare, or gated execute mode;
- a conflict dossier with file-level risk notes.

The local analyzer does not modify your working copy, create commits, or push.
Temporary worktrees live under `.cache/worktrees` and are removed after the
simulation.

### Agent Handoff

The Agent Workflow panel exports:

- a durable task package with inputs, evidence, forbidden actions, command plan,
  acceptance gates, and required return-log format;
- a shorter prompt for quick interactive runs;
- a session-log checker that flags missing fetch, backup, rebase, test,
  conflict, or push signals after an agent finishes.

### GitHub Actions Mode

The Actions panel generates a self-contained workflow for scheduled fork drift
reports. The PR Review panel also exports a pull-request workflow. It can either
run a baseline guard directly in GitHub Actions or POST the PR context to a
Fork Drift Sentinel server endpoint for AI review.

Fork drift reports can run on:

- `schedule`
- `workflow_dispatch`
- `repository_dispatch` with type `upstream-updated`

The workflow writes a markdown report to `$GITHUB_STEP_SUMMARY`. If you provide
an issue number, it can also comment the report on that issue with the
repository `GITHUB_TOKEN`.

PR review workflows run on `pull_request`, comment a summary, and avoid the
privileged `pull_request_target` pattern.

## Local Development

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

Public repositories work without a GitHub token, but unauthenticated GitHub API
calls are rate limited. A fine-grained read-only token is enough for smoother
testing.

## AI Provider Setup

Set only the providers you want to use:

```bash
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...
```

Optional model overrides:

```bash
FDS_OPENAI_API_MODEL=gpt-4.1-mini
FDS_ANTHROPIC_API_MODEL=claude-3-5-sonnet-20241022
FDS_GEMINI_API_MODEL=gemini-2.0-flash
```

You can also enter a one-off model override in the UI.

CLI review expects the corresponding command to be installed and authenticated:

```bash
codex exec --help
claude --help
gemini --help
```

## Safety Boundaries

Fork Drift Sentinel is intentionally conservative:

- no database;
- no token persistence;
- no browser-side AI provider keys;
- no automatic GitHub comments from the web UI;
- no automatic approve/request-changes action;
- no branch deletion, merge, rebase, push, or force-push from the app;
- no privileged `pull_request_target` workflow execution for untrusted fork PRs.

The generated task package may include commands for a human or agent to run, but
the app itself stays read-only unless you manually use those commands elsewhere.

## Current Gaps

- No GitHub App installation flow yet.
- No OAuth flow yet.
- No inline GitHub review comments yet.
- PR review Actions can comment a summary, but full hosted endpoint deployment is
  still up to the operator.
- AI findings are drafts. Treat them as review assistance, not merge authority.
