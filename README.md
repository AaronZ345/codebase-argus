# Fork Drift Sentinel

Fork Drift Sentinel is a read-only GitHub API dashboard for people who maintain
long-lived forks and upstream pull requests.

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
- Keep the optional GitHub token only in browser memory.

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

The default repository pair is:

```text
upstream: chenhg5/cc-connect
fork:     AaronZ345/cc-connect
PR head:  Cigarrr/cc-connect
```

Public repositories work without a token, but unauthenticated GitHub API calls
are rate limited. A fine-grained personal access token with read-only public
repository access is enough for smoother testing.

## GitHub API Integration Notes

Fork Drift Sentinel uses the GitHub REST API endpoints for repositories,
comparison, commits, pull requests, and check runs. This makes it a concrete
GitHub API integration suitable for further development as a GitHub Developer
Program project.

Current scope:

- Read-only browser application.
- No database.
- No token persistence.
- No GitHub App installation flow yet.

Planned next steps:

- Add GitHub OAuth or GitHub App auth.
- Add a shareable drift report route.
- Add local CLI support for precise `git merge-tree` conflict checks.
- Add patch-id style equivalence checks for stronger cleanup detection.
