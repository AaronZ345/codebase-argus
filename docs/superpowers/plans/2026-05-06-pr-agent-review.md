# PR Agent Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add read-only PR review and direct AI provider review to Fork Drift Sentinel without renaming the project.

**Architecture:** GitHub PR data is fetched into a normalized `PullRequestReviewReport`. Deterministic local review helpers create a baseline. A server-only provider layer calls OpenAI, Anthropic, Gemini, Codex CLI, Claude CLI, or Gemini CLI and normalizes JSON findings for the UI.

**Tech Stack:** Next.js App Router route handlers, React client page, TypeScript, Vitest, GitHub REST API, server-side `fetch`, Node `child_process`.

---

### Task 1: PR Review Data Model

**Files:**
- Modify: `src/lib/github.ts`
- Create: `src/lib/pr-review.test.ts`
- Create: `src/lib/pr-review.ts`

- [ ] Add failing tests for parsing PR references, building deterministic findings, and formatting markdown.
- [ ] Implement `parsePullRequestRef`, `buildRuleBasedReview`, `buildReviewPrompt`, `parseProviderReviewJson`, and `formatReviewMarkdown`.
- [ ] Extend `src/lib/github.ts` with `fetchPullRequestReviewReport`.
- [ ] Run `npm test -- src/lib/pr-review.test.ts`.

### Task 2: Provider Runner

**Files:**
- Create: `src/lib/agent-providers.test.ts`
- Create: `src/lib/agent-providers.ts`
- Create: `src/app/api/pr-agent-review/route.ts`

- [ ] Add failing tests for provider config, OpenAI/Anthropic/Gemini request bodies, CLI command selection, and timeout errors.
- [ ] Implement server-only provider adapters with environment-variable keys.
- [ ] Implement the route handler using `NextResponse.json`.
- [ ] Run `npm test -- src/lib/agent-providers.test.ts`.

### Task 3: Page Integration

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/app/globals.css`

- [ ] Add client state for PR input, PR report, provider selection, model override, AI loading, AI result, and errors.
- [ ] Add `PullRequestReviewPanel` with fetch, baseline findings, AI provider controls, result markdown, and file risk table.
- [ ] Reuse existing panel, compact field, status pill, table, textarea, and button styles.
- [ ] Keep the existing Fork Drift Sentinel branding.

### Task 4: Documentation And Verification

**Files:**
- Modify: `README.md`

- [ ] Document PR Review Mode and AI Review providers.
- [ ] Run `npm test`, `npm run lint`, and `npm run build`.
- [ ] Fix issues without reverting unrelated work.
