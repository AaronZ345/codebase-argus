# Fork Drift Sentinel

Fork Drift Sentinel is a read-only GitHub API dashboard for people who maintain
long-lived forks and upstream pull requests.

Live demo: <https://aaronz345.github.io/fork-drift-sentinel/>

It answers the maintenance questions that generic PR dashboards usually leave
scattered across GitHub pages:

- How far is my fork default branch ahead of and behind upstream?
- Which open upstream pull requests come from my PR head fork?
- Are those PRs mergeable, conflicting, or waiting on checks?
- Which fork-ahead commits look like they may already be covered upstream?

The first version is deliberately narrow. It does not push, rebase, merge, write
comments, or request write scopes.

## Features

- Compare an upstream repository with a fork using GitHub's compare API.
- Filter upstream open pull requests to those whose head repository is the PR
  head fork. This can differ from the fork used for default-branch drift.
- Fetch pull request mergeability and check-run summaries.
- Classify fork-ahead commits with lightweight cleanup heuristics.
- Run a local git-backed rebase risk analysis in `.cache/repos`.
- Generate agent-safe runbooks in inspect, prepare, and gated execute modes.
- Export a ready-to-copy agent prompt with explicit stop conditions.
- Build a conflict dossier from local git output, including file-level risk
  hints and resolution instructions.
- Show `git cherry` and `git range-diff` patch evidence so maintainers can see
  what is covered, unique, or semantically changed.
- Parse an agent execution log after a run and flag missing fetch, backup,
  rebase, test, conflict, or push signals.
- Keep the optional GitHub token only in browser memory.

The hosted demo can run the browser-only GitHub API report. Local rebase risk,
range-diff evidence, and git-backed conflict dossiers require running the app on
your own machine because they execute local `git` commands in `.cache/repos`.

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

Public repositories work without a token, but unauthenticated GitHub API calls
are rate limited. A fine-grained personal access token with read-only public
repository access is enough for smoother testing.

## GitHub API Integration Notes

Fork Drift Sentinel uses the GitHub REST API endpoints for repositories,
comparison, commits, pull requests, and check runs. This makes it a concrete
GitHub API integration suitable for further development as a GitHub Developer
Program project.

Current scope:

- Read-only browser application plus local git analysis.
- No database.
- No token persistence.
- No GitHub App installation flow yet.
- No automatic push, rebase, merge, branch deletion, or PR closure.
- Agent integration is prompt/runbook/log-review based; it does not control an
  agent directly or grant write access.

Planned next steps:

- Add GitHub OAuth or GitHub App auth.
- Add a shareable drift report route.
- Add exact temporary-worktree rebase simulation for cases where merge-tree is
  too coarse.
- Add optional AI-assisted explanation for conflicted hunks, gated behind
  explicit user action.
- Add a GitHub Actions mode that posts a read-only drift report on a schedule.
