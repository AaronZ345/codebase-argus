# Fork Drift Sentinel

<p align="center">
  <strong>Evidence-first PR review and fork maintenance for maintainers.</strong>
</p>

<p align="center">
  <a href="https://aaronz345.github.io/fork-drift-sentinel/">Live demo</a>
  ·
  <a href="#cli">CLI</a>
  ·
  <a href="#github-app">GitHub App</a>
  ·
  <a href="#codex-skill">Codex Skill</a>
</p>

<p align="center">
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-black?style=flat-square">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178c6?style=flat-square">
  <img alt="Vitest" src="https://img.shields.io/badge/Vitest-tested-6e9f18?style=flat-square">
  <img alt="GitHub App" src="https://img.shields.io/badge/GitHub%20App-webhook-24292f?style=flat-square">
</p>

Fork Drift Sentinel is a maintainer firewall. It reviews pull requests, explains
CI failures, plans narrow autofixes, and measures downstream fork drift before a
long-lived fork turns into merge debt.

It keeps model output tied to evidence: patches, checks, files, branch state,
policy gates, provider consensus, and local git simulations.

## At a glance

| Workflow | Input | Output |
| --- | --- | --- |
| PR review | `owner/repo#123` or a GitHub PR URL | risk summary, findings, inline-ready comments |
| CI review | local log file or failing GitHub Actions jobs | likely root cause, affected command, fix path |
| Autofix plan | PR review findings | gated branch plan for mechanical fixes |
| Fork drift | upstream repo + fork repo | ahead/behind, conflict notes, rebase/merge risk |
| Agent handoff | dashboard or CLI report | task package with commands and acceptance gates |

## Quick start

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

For command-line review:

```bash
npm run fds -- review owner/repo#123
npm run fds -- ci-github owner/repo#123
npm run fds -- drift owner/upstream me/fork
```

Public GitHub repositories work from the hosted demo. Private repositories,
server-side AI providers, GitHub App webhooks, local git analysis, and CLI agent
review belong in a local or deployed server environment.

## Core capabilities

### Pull request review

Fork Drift Sentinel fetches the PR shape that maintainers usually need before
trusting a review:

- metadata, labels, author, branch refs, and mergeability;
- changed files, patch excerpts, commits, and prior reviews;
- check status and GitHub Actions run metadata;
- policy rules from `.fork-drift-sentinel.yml`;
- stacked PR signals and merge-queue states.

The deterministic reviewer looks for failing checks, source changes without
tests, workflow edits, dependency changes, sensitive paths, policy violations,
large diffs, stacked PR bases, and blocked/dirty/behind/unstable merge states.

### AI review and tribunal

The same evidence package can go to one provider or several providers:

| Provider | Mode |
| --- | --- |
| `openai-api` | API |
| `anthropic-api` | API |
| `gemini-api` | API |
| `codex-cli` | local CLI |
| `claude-cli` | local CLI |
| `gemini-cli` | local CLI |

Tribunal mode runs multiple reviewers against the same PR, groups matching
findings, raises confidence when providers agree, and keeps provider failures in
the report.

### CI failures

Use `ci-log` for a local file, or `ci-github` for failing GitHub Actions jobs on
a PR. Webhook mode can include failing Actions logs in the automatic PR review.

### Autofix planning

`autofix-plan` turns high-confidence, mechanical findings into a branch plan. It
covers narrow lanes such as npm lockfile refreshes, snapshot updates, and
formatter or linter fixes. The output includes commands, verification gates, and
push instructions for the maintainer or agent working in a real checkout.

### Downstream fork drift

The fork workflow compares an upstream repository and a long-lived fork. Local
analysis runs git in `.cache/repos` and temporary worktrees, then reports:

- projected merge conflicts from `git merge-tree`;
- rebase simulation in a temporary worktree;
- patch-equivalent commits from `git cherry`;
- semantic movement from `git range-diff`;
- fork-ahead commits already covered upstream;
- agent-safe merge/rebase runbooks.

## CLI

The CLI is the best entry point for scripts and coding agents.

```bash
npm run fds -- --help
```

### PR review

```bash
npm run fds -- review owner/repo#123
npm run fds -- review owner/repo#123 --policy .fork-drift-sentinel.yml
npm run fds -- review owner/repo#123 --provider openai-api --model gpt-4.1-mini
npm run fds -- review owner/repo#123 --tribunal openai-api,claude-cli,codex-cli
```

### CI review

```bash
npm run fds -- ci-log logs/failure.txt
npm run fds -- ci-log logs/failure.txt --provider codex-cli
GITHUB_TOKEN=... npm run fds -- ci-github owner/repo#123
```

### Autofix plan

```bash
npm run fds -- autofix-plan owner/repo#123
```

### Fork drift

```bash
npm run fds -- drift owner/upstream me/fork
npm run fds -- drift owner/upstream me/fork --upstream-branch main --fork-branch feature/demo
npm run fds -- drift owner/upstream me/fork --fork-branch feature/demo --provider codex-cli
```

### Sync planning

```bash
npm run fds -- sync owner/upstream me/fork --mode merge --fork-branch feature/demo --test "npm test"
npm run fds -- sync owner/upstream me/fork --mode rebase --fork-branch feature/demo --execute --push --create-pr
```

Output defaults to markdown. Use `--format json` for tool integration.

Install the binary locally:

```bash
npm link
fork-drift-sentinel review owner/repo#123
fork-drift-sentinel autofix-plan owner/repo#123
```

## Policy file

Add `.fork-drift-sentinel.yml` when the repository has local review rules:

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

Policy failures become normal findings with concrete evidence.

## GitHub App

Deploy the Next.js server and point a GitHub App webhook at:

```text
POST https://your-host.example.com/api/github/webhook
```

The server also emits a GitHub App manifest:

```text
GET https://your-host.example.com/api/github/app-manifest
```

Recommended repository permissions:

| Permission | Access |
| --- | --- |
| Pull requests | Read and write |
| Issues | Read and write |
| Contents | Read |
| Checks | Read |
| Actions | Read |
| Metadata | Read |

Required webhook events:

- `pull_request`
- `issue_comment`

Server environment:

```bash
GITHUB_WEBHOOK_SECRET=...
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY='<escaped-pem-private-key>'
```

Base64 private key storage is also supported:

```bash
GITHUB_APP_PRIVATE_KEY_BASE64=...
```

Review controls:

```bash
FDS_WEBHOOK_PROVIDER=rule-based
FDS_WEBHOOK_PROVIDER=openai-api
FDS_WEBHOOK_MODEL=gpt-4.1-mini
FDS_WEBHOOK_TRIBUNAL=openai-api,claude-cli,codex-cli
FDS_WEBHOOK_INLINE_COMMENTS=true
FDS_WEBHOOK_INCLUDE_CI_LOGS=true
FDS_WEBHOOK_DRY_RUN=true
```

Webhook behavior:

- verifies `X-Hub-Signature-256` before payload handling;
- reviews `opened`, `reopened`, `ready_for_review`, and `synchronize` events;
- skips draft PRs and PRs labeled `fds:paused`;
- uses GitHub App installation tokens when app credentials are present;
- posts GitHub PR reviews with event `COMMENT`;
- anchors high-signal findings to changed patch lines when inline comments are enabled;
- fetches failing GitHub Actions job logs when checks fail.

### PR comment commands

```text
/fds help
/fds review
/fds ci
/fds autofix
/fds pause
/fds resume
```

`/fds pause` applies the `fds:paused` label. `/fds resume` removes it.
`/fds autofix` posts the same gated plan as the CLI.

## AI provider setup

Set credentials for the providers you plan to use:

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

Local CLI providers expect authenticated commands:

```bash
codex exec --help
claude --help
gemini --help
```

## Codex skill

The repository includes a skill package:

```text
skills/fork-drift-sentinel/
```

Install it into a Codex skill directory:

```bash
mkdir -p ~/.codex/skills
cp -R skills/fork-drift-sentinel ~/.codex/skills/
```

The skill directs agents to use the CLI first, keep tokens out of logs, run
multi-provider review before risky downstream integration, and ask for explicit
authorization before approve, merge, rebase, push, PR creation, or GitHub
comments.

## Write model

Fork Drift Sentinel keeps write operations narrow:

| Surface | Write behavior |
| --- | --- |
| Hosted demo | Read-only browser inspection |
| Local CLI review | Markdown or JSON output |
| GitHub App review | `COMMENT` PR reviews |
| PR commands | Review, CI review, autofix plan, pause, resume |
| Sync command | Dry-run by default; `--execute`, `--push`, and `--create-pr` are explicit gates |
| Generated Actions workflow | Uses `pull_request` for untrusted fork PRs |
