# Fork Drift Sentinel

An evidence-first maintainer firewall for two related jobs that often get mixed
up:

- reviewing normal pull requests as an upstream maintainer;
- keeping a long-lived downstream fork from drifting into unreviewable debt.

Live demo: <https://aaronz345.github.io/fork-drift-sentinel/>

The hosted demo can fetch public GitHub data from the browser. Local git
analysis, API model review, and CLI agent review need a local or server
deployment because they run server-side code.

## What It Does

### Overall Features

Fork Drift Sentinel is built around evidence, not free-form model opinion.

- Findings cite checks, changed files, patch lines, policy gates, provider
  consensus, or local git output.
- Provider output is normalized into the same shape: summary, risk, findings,
  confidence, evidence, and copyable markdown.
- API keys stay on the server. The browser never sends or stores provider keys.
- The hosted UI stays non-writing. Local CLI workflows default to dry-run, then
  execute only when flags such as `--execute`, `--push`, or `--create-pr` are
  explicitly present.
- Agent handoff material includes forbidden actions, acceptance gates, and the
  return-log format an agent must produce after it runs.
- CI failure logs can be reviewed by the same rule-based, API, CLI, or tribunal
  providers used for PR review.

### Upstream: PR Review

For upstream maintainers, paste a GitHub PR URL or `owner/repo#123`.

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

#### Policy As Code

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

#### AI Review

The PR review context can be sent to:

- `openai-api`
- `anthropic-api`
- `gemini-api`
- `codex-cli`
- `claude-cli`
- `gemini-cli`

CLI providers run in non-interactive review mode and receive the PR context on
stdin.

Instead of trusting one reviewer, run several providers on the same PR. Fork
Drift Sentinel groups matching findings by category, file, and title. If two or
more providers report the same issue, confidence is raised and the finding lists
the providers that agreed. Provider failures are kept as visible findings, not
hidden in logs.

### Downstream: Fork Drift And Integration Review

For fork maintenance, enter an upstream repository, a fork repository, and
optionally a separate PR head repository.

The dashboard shows:

- default-branch ahead/behind count;
- open upstream PRs from the configured head repository;
- mergeability and checks for those PRs;
- fork-ahead commits that may already be covered upstream.

When running locally, the app uses `git` inside `.cache/repos` to inspect how a
downstream fork can integrate upstream changes. Both paths matter:

- merge upstream into the fork;
- rebase the fork on top of upstream.

The local analyzer provides:

- projected merge conflict files from `git merge-tree`;
- an actual temporary worktree rebase simulation;
- patch-equivalent commits from `git cherry`;
- semantic patch movement from `git range-diff`;
- an agent-safe runbook for inspect, prepare, or gated execute mode;
- a conflict dossier with file-level risk notes.

The local analyzer does not modify your working copy, create commits, or push.
Temporary worktrees live under `.cache/worktrees` and are removed after the
simulation. The separate `sync` CLI command can perform the actual merge or
rebase path, but only in an explicit downstream sync branch and only when
`--execute` is present.

#### AI Review For Downstream Merge/Rebase

The downstream integration dossier can also be sent to API providers or local AI
CLIs. The prompt includes merge-tree evidence, rebase simulation status,
patch-equivalent commits, unique fork commits, range-diff excerpts, and gated
runbook commands.

This supports a multi-agent tribunal before risky merge/rebase work:

- one agent can focus on conflict files;
- one agent can check patch-equivalent cleanup candidates;
- one agent can assess whether merge or rebase is the safer path;
- agreement between providers raises confidence.

#### Executable Downstream Sync

Use `sync` when the decision is already made and the agent should prepare a real
integration branch:

```bash
npm run fds -- sync owner/upstream me/fork \
  --mode merge \
  --upstream-branch main \
  --fork-branch feature/demo \
  --branch sync/upstream-main \
  --test "npm test"
```

Without `--execute`, this prints the plan only. With `--execute`, it clones the
fork into `.cache/sync`, creates a backup branch, creates the sync branch, runs
the selected `merge` or `rebase`, and runs each `--test` command. `--push` and
`--create-pr` are separate gates:

```bash
npm run fds -- sync owner/upstream me/fork \
  --mode rebase \
  --fork-branch feature/demo \
  --test "npm test" \
  --execute --push --create-pr
```

The command pushes the sync branch, not the original target branch. PR creation
uses `gh pr create`, so GitHub CLI auth decides whether that final step can run.

### Agent Handoff

The Agent Workflow panel exports:

- a durable task package with inputs, evidence, forbidden actions, command plan,
  acceptance gates, and required return-log format;
- a shorter prompt for quick interactive runs;
- a session-log checker that flags missing fetch, backup, integration, test,
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

## CLI

The app also ships a local CLI. It is the best entry point for agents and
scripts because it does not need a browser session.

### Upstream PR Review

```bash
npm run fds -- review owner/repo#123
```

Use a GitHub token for private repositories or higher rate limits:

```bash
GITHUB_TOKEN=... npm run fds -- review owner/repo#123
```

Use a policy file:

```bash
npm run fds -- review owner/repo#123 --policy .fork-drift-sentinel.yml
```

Run an AI provider:

```bash
npm run fds -- review owner/repo#123 --provider openai-api --model gpt-4.1-mini
```

Run a multi-agent tribunal:

```bash
npm run fds -- review owner/repo#123 --tribunal openai-api,claude-cli,codex-cli
```

Review a CI failure log with the same providers:

```bash
npm run fds -- ci-log logs/failure.txt
npm run fds -- ci-log logs/failure.txt --provider codex-cli
npm run fds -- ci-log logs/failure.txt --tribunal codex-cli,claude-cli,gemini-cli
```

### Downstream Fork Integration Review

Run deterministic local drift analysis and get a markdown review:

```bash
npm run fds -- drift owner/upstream me/fork
```

Pick branches explicitly:

```bash
npm run fds -- drift owner/upstream me/fork --upstream-branch main --fork-branch feature/demo
```

Send the downstream merge/rebase dossier to a local AI CLI:

```bash
npm run fds -- drift owner/upstream me/fork --fork-branch feature/demo --provider codex-cli
```

Run a multi-agent tribunal before choosing merge or rebase:

```bash
npm run fds -- drift owner/upstream me/fork --fork-branch feature/demo --tribunal codex-cli,claude-cli,gemini-cli
```

Print or execute a downstream sync plan:

```bash
npm run fds -- sync owner/upstream me/fork --mode merge --fork-branch feature/demo --test "npm test"
npm run fds -- sync owner/upstream me/fork --mode rebase --fork-branch feature/demo --execute --push --create-pr
```

Output defaults to markdown. Use `--format json` when another tool should parse
the result.

You can also link the package locally:

```bash
npm link
fork-drift-sentinel review owner/repo#123
fork-drift-sentinel drift owner/upstream me/fork --provider codex-cli
fork-drift-sentinel sync owner/upstream me/fork --mode merge --test "npm test" --execute
```

## Codex Skill

The repository includes a skill package at:

```text
skills/fork-drift-sentinel/
```

Install it into a Codex skill directory when you want agents to invoke the
review workflow directly:

```bash
mkdir -p ~/.codex/skills
cp -R skills/fork-drift-sentinel ~/.codex/skills/
```

The skill tells the agent to use the CLI first, keep tokens out of logs, run
multi-agent review before risky downstream integration, and require explicit
authorization before approve, merge, rebase, push, PR creation, or GitHub
comments.

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

CLI AI review expects the corresponding command to be installed and
authenticated:

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
- no branch deletion from the app;
- local sync execution is dry-run by default;
- `--push` and `--create-pr` require `--execute`;
- sync pushes a named sync branch with `--force-with-lease`, not the original
  target branch;
- no privileged `pull_request_target` workflow execution for untrusted fork PRs.

The hosted demo remains read-only. Local CLI execution is available because local
agents can inspect failures, resolve conflicts, run tests, push a sync branch, and
open a PR when those actions are explicitly requested.

## Practical Gaps To Add Next

Compared with mature PR automation and merge-queue tools, the most useful next
features are:

- GitHub App installation and least-privilege repo permissions, instead of
  relying on pasted tokens or local `gh` auth.
- Merge queue awareness: detect required queues, blocked merge groups, stale
  heads, and whether a sync branch needs to be updated before entering the queue.
- Stack awareness for downstream or stacked PR workflows: understand dependent
  branches, restack order, and whether a rebase changes later PRs.
- Inline GitHub review comments and suggested patches, with explicit human
  confirmation before posting.
- CI failure ingestion from GitHub check logs, so `ci-log` can fetch failing
  jobs directly instead of requiring a local log file.
- Auto-fix mode for narrow classes of failures, such as lockfile refresh,
  formatting, generated snapshots, or conflict markers, always followed by tests.
- Dependency-specific risk signals such as changelog links, update type,
  vulnerability context, and confidence for safe automerge.

## Current Gaps

- No GitHub App installation flow yet.
- No OAuth flow yet.
- No inline GitHub review comments yet.
- CI log review reads a local file; it does not fetch job logs from GitHub yet.
- PR review Actions can comment a summary, but full hosted endpoint deployment is
  still up to the operator.
- AI findings are drafts. Treat them as review assistance, not merge authority.
