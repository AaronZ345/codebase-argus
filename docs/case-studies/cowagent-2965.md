# Case study: reviewing CowAgent PR #2965

This case study uses a live public pull request rather than a fixture. On July 17, 2026, Codebase Argus reviewed [CowAgent #2965](https://github.com/zhayujie/CowAgent/pull/2965), a three-file change that exposes the `/tasks` command across chat channels.

## Reproduce the review

```bash
git clone https://github.com/AaronZ345/codebase-argus.git
cd codebase-argus
npm ci
npm run argus -- review zhayujie/CowAgent#2965
```

The default rule-based pass classified the pull request as low risk and found no obvious CI, workflow, test-presence, or size problem.

To hand the same evidence package to Codex CLI:

```bash
npm run argus -- review zhayujie/CowAgent#2965 \
  --provider codex-cli \
  --timeout-ms 120000
```

That review also returned low risk and found no blocking issue. It did preserve one residual concern: the tests exercise the command directly with synthetic context and an in-memory task store, while the repository reported no CI checks. The suggested follow-up was a dispatch-level test using the real event context and persisted task records.

## Why the result is useful

The two passes answer different questions:

- deterministic checks quickly rule out known policy, workflow, size, and missing-test signals;
- the coding agent reads the patch and points to an integration boundary that still deserves human judgment;
- both results keep the recommendation tied to files and observable repository state.

The output is a review aid, not an approval. Pull request state and code can change after this snapshot, so rerun the command before relying on the result.
