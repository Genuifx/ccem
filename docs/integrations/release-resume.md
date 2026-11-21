# Resume non-publishing release readiness

Run `pnpm release:resume` from the repository to recover a stable version already on `main` but not yet tagged. The command does not bump versions, create/push tags, merge code, publish packages/releases, change credentials, or add full CI as a mandatory release gate.

## Inputs and boundaries

- Node.js 22+ and Git are required. Existing authentication comes from `CCEM_RELEASE_READINESS_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token --hostname github.com`, in that order. Reading Actions evidence needs Actions read access; dispatching missing workflows needs Actions write access. The command never creates tokens or changes permissions.
- `origin` must identify the intended repository on `github.com` using its HTTPS or Git SSH URL. The API repository is derived from that URL. A different `GITHUB_REPOSITORY` is rejected, including a different fork sharing the same commit.
- The command fetches existing `origin/main` and tags without force, then reuses `resolve-release-candidate.mjs` to pin the current SHA, the five matching stable version sources, and the baseline tag/commit. It refuses an existing candidate tag or a published/current version. It does not invent another bump.
- Baseline delivery remains a separate gate: reconcile the previous tag's CLI/Desktop workflows, GitHub Release assets, `latest.json`, npm version, and npm dist-tags using the release skill before publishing. Fetching a baseline tag does not prove its delivery.

The only completion status is `PRETAG_READINESS_VERIFIED`. JSON output explicitly reports `baselineDelivery: "NOT_CHECKED"` and `releaseEligible: false`. It is not `READY`, a release approval, or evidence that the baseline was delivered. The command's successful exit covers only the bounded pre-tag readiness work it actually verifies.

## What it does

1. Inspect CLI `release-cli.yml` and Desktop `mode2-signed-readiness.yml` on the exact pinned main SHA. A fully skipped automatic push run is missing evidence. The newest substantive attempt is authoritative; a newer pending or failed attempt cannot be bypassed using an older green run. Attempt activity timestamps, rather than only run IDs, account for reruns of older runs; tied timestamps conservatively favor blockers.
2. Reuse valid evidence, wait for existing pending runs, and dispatch only missing workflows on `main` with exact `expected_sha` and `expected_version` inputs. Desktop publication (`release-desktop.yml`) is never dispatched.
3. Before dispatches, during polling, and at completion, rerun candidate resolution. Main movement, version/baseline changes, and tag races stop the command. It never loops after a moving main. Resolve a new candidate only in a new invocation after inspecting the change.
4. Require real outcomes for `Preflight npm Trusted Publisher` and `Confirm Desktop Release Readiness`. Workflow-level success cannot hide skipped, missing, failed, or foreign-run required jobs. The shared `check-pretag-readiness-runs.mjs` validates selected exact run attempts and re-reads current attempts after loading jobs to detect rerun races.
5. Poll running workflows every 15 seconds, for an observation window of two hours. A pending timeout reports the exact run/attempt and leaves it running. A later invocation can reuse it. Network reads and reconciliation have their own finite bounds, so the process can exceed the observation window by the current bounded request/reconciliation work.

The standalone tag-time readiness checker retains its existing successful-run lookup interface for compatibility. The resume command adds latest-substantive-attempt selection and passes those selected identities into the same exact-attempt validator. Neither path requires full CI as an additional release gate.

## Transient errors and ambiguous dispatch

Read-only GitHub API requests retry at most three times, after one and two seconds, for allowlisted transport failures (including nested causes and interrupted response bodies) or HTTP 408/429/500/502/503/504. Each request has a 30-second timeout. Invalid JSON, malformed evidence, and denied access are not retried. Diagnostic exception type/code chains are retained without arbitrary exception text, authorization headers, or token values. Git/gh command failures stop with authentication/ref-refresh guidance; they are not automatically retried.

A dispatch POST is sent at most once per intent. A transport error or ambiguous HTTP response may mean GitHub already accepted it. The command reconciles up to 12 run-list observations, five seconds apart, looking for a new exact-source `workflow_dispatch` run absent from its pre-dispatch snapshot. A matching run supplies conclusive evidence even if its eventual outcome fails. No evidence means `UNKNOWN_DISPATCH`, not a second POST.

Before each POST, a local intent is durably written below Git's common metadata directory, in `ccem-release-resume/<owner>--<repo>/`. It contains only repository, SHA, version, workflow, and previously observed run IDs. On a subsequent invocation, unresolved intents are reconciled first, including a previous SHA. A resolved failed run clears its intent and still reports the actual failure. An old unresolved intent blocks starting another candidate. Keep these files until remote state has been conclusively reconciled; deleting them or using a different clone loses this duplicate-dispatch protection.

An exclusive `operator.lock` in the same repository directory prevents concurrent invocations across linked worktrees in that clone. The command releases its own lock on normal exit, including handled failures. A killed process can leave a lock: inspect its recorded host/PID, verify that process has stopped, then remove only the named lock file. Do not remove dispatch-intent files as lock cleanup. The lock cannot coordinate independent clones or other operators; their exact-source runs are observed and reused when visible.

## Failures requiring an operator

- `WORKFLOW_FAILED`: inspect the exact run and attempt with the printed `gh run view ... --attempt ... --log-failed` command. This command does not rerun failed workflows automatically. Even a log containing `ENOTFOUND` can have a deterministic test/build failure elsewhere; automatic workflow-level retry needs stronger step-level proof and is outside this implementation.
- `UNKNOWN_DISPATCH`: inspect the linked workflow and pinned SHA/version. Re-running this command in the same clone safely reconciles its retained intent; do not manually redispatch or discard that intent merely because the run has not appeared yet.
- `CANDIDATE_CHANGED` or resolver main/tag failure: stop, inspect refs, and preserve the existing version. Do not move/overwrite tags. Fresh readiness belongs to a new invocation pinned to the newly verified main SHA.
- `READINESS_PENDING`: inspect the printed active run/attempt or invoke the command later to continue waiting without duplication.
- Malformed/paginated evidence: the command fails closed when API totals change, identities/timestamps are invalid, or the 1,000-run search window is exceeded. Inspect remote evidence before restarting.

No CLI observation is an atomic lock on GitHub. Immediately before any separately authorized tag operation, re-prove exact remote main and local/remote candidate-tag absence, and require the separate baseline-delivery gate.

## Local tests

`pnpm test:release-resume` runs injected transport, readiness state, orchestration, and durable-intent tests without credentials or real GitHub mutations. `pnpm test:pretag-readiness` covers the shared exact-attempt gate. These tests do not claim that real readiness workflows or baseline delivery succeeded.
