# PR Agent Review Design

## Goal

Codebase Argus is the current product name. It serves both upstream maintainers reviewing incoming PRs and downstream maintainers reviewing long-lived fork syncs, with the same evidence package available to one provider or a multi-agent tribunal.

## Scope

The first implementation is a read-only review loop:

- Fetch GitHub PR metadata, changed files, commits, checks, reviews, and patch excerpts from a PR URL or `owner/repo#number`.
- Build a shared review context that can be used by deterministic local heuristics, API model calls, and local CLI model calls.
- Support provider choices for `openai-api`, `anthropic-api`, `gemini-api`, `codex-cli`, `claude-cli`, and `gemini-cli`.
- Return structured findings, a summary, risk level, provider metadata, and markdown that a maintainer can copy into GitHub.
- Keep all model API keys server-side through environment variables.

This version does not automatically comment on PRs, approve changes, request changes, push branches, or run untrusted fork code in a privileged GitHub Actions context.

## Architecture

`src/lib/github.ts` remains the browser-facing GitHub REST helper and adds PR review data fetching. `src/lib/pr-review.ts` owns context normalization, deterministic findings, prompt construction, provider output validation, and markdown formatting. `src/lib/agent-providers.ts` owns API and CLI provider execution from server-only routes. `src/app/api/pr-agent-review/route.ts` accepts a review context plus provider settings and returns a normalized review result.

The page adds a PR Review panel above the existing downstream fork sync panels. Users can fetch a PR report with the browser token, inspect the rule-based baseline, then optionally run an AI review through a server route when running locally or in an environment configured with provider keys.

## Safety

API providers read keys from `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GEMINI_API_KEY`; no key is accepted from the browser. CLI providers run only from the local server route, use a timeout, pass context through stdin, and default to review-only prompts. The UI copy makes clear that model output is a draft review and requires human judgment.

## Testing

Unit tests cover PR reference parsing, review context summarization, deterministic findings, markdown formatting, provider output parsing, provider request construction, and CLI command selection. Route and UI behavior are verified through TypeScript build, lint, and Vitest.
