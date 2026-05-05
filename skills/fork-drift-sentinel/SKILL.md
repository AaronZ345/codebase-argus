---
name: fork-drift-sentinel
description: Use when reviewing GitHub pull requests, running evidence-first AI review with OpenAI/Claude/Gemini/Codex providers, generating maintainer-safe PR summaries, or maintaining long-lived forks against an upstream repository.
metadata:
  origin: local
  owner: aaron
---

# Fork Drift Sentinel

Use this skill as a maintainer firewall for GitHub PRs and fork drift work.

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

## PR Review

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

## Fork Drift Work

For fork maintenance, use the web app local analyzer until the CLI grows drift subcommands:

```bash
npm run dev
```

Open the local dashboard and use the Fork Drift and Local Rebase Risk panels. The local analyzer works in `.cache/repos` and temporary worktrees, and must not push or force-push by itself.
