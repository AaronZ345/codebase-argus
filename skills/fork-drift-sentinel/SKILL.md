---
name: fork-drift-sentinel
description: Use when reviewing GitHub pull requests, reviewing CI failures, running evidence-first AI review with OpenAI/Claude/Gemini/Codex providers, preparing downstream merge/rebase work, or maintaining long-lived forks against an upstream repository.
metadata:
  origin: local
  owner: aaron
---

# Fork Drift Sentinel

Use this skill as a maintainer firewall for GitHub PRs, CI failures, and
downstream fork integration work.

## Fast Path

From a `fork-drift-sentinel` checkout:

```bash
npm install
npm run fds -- review owner/repo#123
```

For private repositories or higher GitHub API limits:

```bash
GITHUB_TOKEN=<read-only-token> npm run fds -- review owner/repo#123
```

Do not print tokens. Do not write tokens to files.

## Upstream PR Review

Default review is deterministic and rule-based:

```bash
npm run fds -- review owner/repo#123 --format markdown
```

Use a policy file when the repository has local rules:

```bash
npm run fds -- review owner/repo#123 --policy .fork-drift-sentinel.yml
```

Use API providers when credentials are available in the environment:

```bash
OPENAI_API_KEY=<key> npm run fds -- review owner/repo#123 --provider openai-api
ANTHROPIC_API_KEY=<key> npm run fds -- review owner/repo#123 --provider anthropic-api
GEMINI_API_KEY=<key> npm run fds -- review owner/repo#123 --provider gemini-api
```

Use local CLI providers only in trusted local workspaces:

```bash
npm run fds -- review owner/repo#123 --provider codex-cli
npm run fds -- review owner/repo#123 --provider claude-cli
npm run fds -- review owner/repo#123 --provider gemini-cli
```

For multi-agent review:

```bash
npm run fds -- review owner/repo#123 --tribunal openai-api,claude-cli,codex-cli
```

Treat output as review assistance. Do not approve, merge, push, or post comments automatically unless the user explicitly asks.

## CI Failure Review

When the user provides a failing job log or local log file, review it through the
same provider system:

```bash
npm run fds -- ci-log logs/failure.txt
npm run fds -- ci-log logs/failure.txt --provider codex-cli
npm run fds -- ci-log logs/failure.txt --tribunal codex-cli,claude-cli,gemini-cli
```

Focus on the first failing command, the most likely root cause, and the smallest
fix that can be verified locally.

## What To Look For

Prioritize findings with concrete evidence:

- failing or pending checks;
- source changes without matching tests;
- workflow edits, especially `pull_request_target`;
- auth, token, webhook, payment, signature, or route-handling changes;
- dependency and lockfile changes;
- large PRs that exceed policy gates;
- agreement between multiple providers.

Low-confidence model-only claims need manual verification before reporting them as facts.

## Downstream Fork Drift And Integration Review

For long-lived fork maintenance, use the downstream CLI first:

```bash
npm run fds -- drift owner/upstream me/fork
npm run fds -- drift owner/upstream me/fork --upstream-branch main --fork-branch feature/demo
```

For AI CLI review of merge/rebase risk:

```bash
npm run fds -- drift owner/upstream me/fork --fork-branch feature/demo --provider codex-cli
npm run fds -- drift owner/upstream me/fork --fork-branch feature/demo --tribunal codex-cli,claude-cli,gemini-cli
```

When the user explicitly asks the agent to perform the downstream integration,
use `sync`. It prints a dry-run plan unless `--execute` is present:

```bash
npm run fds -- sync owner/upstream me/fork --mode merge --fork-branch feature/demo --test "npm test"
npm run fds -- sync owner/upstream me/fork --mode rebase --fork-branch feature/demo --test "npm test" --execute --push --create-pr
```

Execution rules:

- run `drift` with a provider or tribunal first for risky branches;
- prefer a sync branch such as `sync/upstream-main`;
- push only with explicit `--push`;
- open a PR only with explicit `--create-pr`;
- never push directly over the user's original target branch;
- report failed commands, conflicts, and test output without hiding them.

The downstream prompt must consider both integration paths:

- merge upstream into the fork, using `git merge-tree` conflict evidence;
- rebase the fork on upstream, using temporary worktree rebase simulation;
- patch-equivalent cleanup candidates from `git cherry -v`;
- semantic patch movement from `git range-diff`;
- backup, test, and force-with-lease gates before any push.

Use the local dashboard when a human needs to inspect the same evidence visually:

```bash
npm run dev
```

Open the Fork Drift, Downstream Merge/Rebase Risk, and Downstream Agent Workflow panels. The local analyzer works in `.cache/repos` and temporary worktrees, and must not push or force-push by itself. Actual sync execution belongs to the CLI `sync` command and only runs after explicit flags.
