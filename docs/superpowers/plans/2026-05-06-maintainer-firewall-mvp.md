# Maintainer Firewall MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add evidence-first review, policy-as-code, multi-agent tribunal, PR review Actions, and worktree rebase simulation as a coherent MVP.

**Architecture:** `pr-review.ts` stays responsible for normalized review results. New focused helpers own policy parsing, evidence extraction, tribunal aggregation, and workflow generation. `local-analyzer.ts` adds a temporary worktree simulation result to the existing local drift report. The UI exposes these features through compact controls in the existing panels.

**Tech Stack:** Next.js App Router, React client component, TypeScript, Vitest, GitHub REST API, local `git`, Node `child_process`, no new npm dependencies.

---

### Task 1: Evidence And Policy

**Files:**
- Create: `src/lib/review-policy.test.ts`
- Create: `src/lib/review-policy.ts`
- Modify: `src/lib/pr-review.test.ts`
- Modify: `src/lib/pr-review.ts`

- [ ] Add tests for parsing JSON/YAML-like policy text, evidence snippets on findings, confidence labels, and policy findings.
- [ ] Implement a dependency-free policy parser with sensible defaults.
- [ ] Add evidence arrays and confidence to review findings.
- [ ] Let rule-based review apply policy gates.

### Task 2: Multi-Agent Tribunal

**Files:**
- Modify: `src/lib/agent-providers.test.ts`
- Modify: `src/lib/agent-providers.ts`
- Modify: `src/app/api/pr-agent-review/route.ts`

- [ ] Add tests for running multiple providers and aggregating repeated findings.
- [ ] Implement `runTribunalReview` with provider-level errors preserved as findings.
- [ ] Extend the API route to accept `providers`.

### Task 3: PR Review Actions

**Files:**
- Modify: `src/lib/agent-workflow.test.ts`
- Modify: `src/lib/agent-workflow.ts`

- [ ] Add tests for a generated PR review workflow.
- [ ] Generate a workflow that posts PR context to a server endpoint, or runs baseline policy checks when no endpoint is configured.

### Task 4: Fork Drift Pro

**Files:**
- Modify: `src/lib/local-analyzer.test.ts`
- Modify: `src/lib/local-analyzer.ts`
- Modify: `src/app/page.tsx`

- [ ] Add parser tests for rebase simulation output.
- [ ] Run a temporary worktree rebase simulation after merge-tree analysis.
- [ ] Display simulation status and conflict files in Rebase Risk.

### Task 5: UI And Docs

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/app/globals.css`
- Modify: `README.md`

- [ ] Add policy text input, tribunal controls, PR review workflow export, and evidence display.
- [ ] Keep current project name and existing fork drift panels.
- [ ] Run `npm test`, `npm run lint`, and `npm run build`.
