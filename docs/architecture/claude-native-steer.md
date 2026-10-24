# Claude native mid-turn steer

The queue dock's steer action first attaches its next FIFO batch to the running
Claude command. It does not interrupt that command. An explicit unsent rejection
retains the existing interrupt-and-drain fallback, fenced to the clicked command.

## SDK contract

Verified with the locked `@anthropic-ai/claude-agent-sdk` **0.3.220** and its
bundled Claude **2.1.220**. `SDKUserMessage.priority` declares `now`, `next`, and
`later`. CCEM sends a human message with `priority: 'next'` through the existing
streaming input iterator. The installed types, release changelog, and a live SDK
probe were checked before implementation.

- [SDK changelog at v0.3.220](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.220/CHANGELOG.md)
- [Claude message queue behavior](https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works)

The probe injected during a tool call. The child was queued, replayed as a human
message after the tool, acknowledged by the model, and completed. One result was
attributed to the original human UUID. A send racing the last boundary can instead
become an SDK continuation, so consumers must also tolerate separate child results.

Safe Stop is part of the feature gate. The installed SDK's public `interrupt()`
leaves queued inputs alive. Its runtime implements the negotiated
`interrupt_cancel_queued_v1` control request through `request()`, although that
method is absent from the public `Query` type. CCEM narrowly feature-detects this
adapter and only advertises `ccem_steer_v1` when both it and `msg_lifecycle_v1` are
available. SDK upgrades must recheck this adapter; missing support uses fallback.

## Ownership and delivery

1. Rust claims the next frozen queue batch and reserves a separate steer receipt.
   Its fence includes the parent command, child wire UUID, helper incarnation,
   and query generation. The foreground owner remains unchanged.
2. The helper validates that exact running owner and pushes the child without
   resetting foreground state or creating another input operation. Normal prompt
   admission still returns busy. Slash commands and pending settings use fallback.
3. `steer_admitted` persists each original client message once and removes the
   batch. The existing queue/transcript reconciliation consumes those client IDs;
   it does not wait for the root turn to finish. Images and display text retain
   the ordinary queue projection path.
4. `steer_rejected` means no input was sent. Rust restores the queue and permits
   fallback only while the original parent is still active. If it ended during
   the handshake, Rust rechecks normal FIFO dispatch instead.
5. A partial write or missing receipt becomes delivery-uncertain. There is no
   automatic interrupt or replay. An exact late receipt can reconcile it; stale
   or duplicate receipts cannot change queue ownership. Replacing the helper
   retires only its receipt lane, without replaying uncertain queue entries.
   A late receipt that restores or exposes a pending FIFO head wakes normal
   dispatch, while preserving initialization and settings fences.

Only one receipt can be pending at a time. The UI also suppresses repeat clicks.
Neither a receipt nor a child SDK terminal is a foreground completion.

## Completion and errors

Child lifecycle frames use `steer_command_state`. They never reach Rust as root
`sdk_command_state` frames. If the root terminal arrives while an accepted child
is unresolved, the helper holds the raw terminal until the child settles. This
also prevents FIFO dispatch during an SDK continuation. Root `turn_completed`
retains the original command identity.

Distinct results are deduplicated by their SDK input UUID before aliasing to the
root. Late child results cannot complete a newer root. Usage remains attributed
to the original input operation, with output metrics summed over continuations.
The transcript keeps that operation across the inserted user message.

Refused, discarded, or unsolicited-cancelled children produce a visible
`steer_failed` event without automatic retry. Explicit Stop cancels pending child
inputs along with the root through the negotiated control adapter.
If the original SDK root already completed but Stop cancels a pending child,
the raw root terminal remains intact and the grouped user turn is marked
interrupted rather than successfully completed.

## Regression surfaces

- `packages/native-runtime-helper/test/claude-steer.test.mjs` uses a concurrent
  input pump and tool gates, including continuation, Stop, and late-result races.
- Rust `native_session_coordinator/steer_tests.rs` and
  `native_runtime/steering_tests.rs` exercise receipt fences, root retention,
  queue projection, fallback, and uncertain delivery.
- Desktop queue projection and event transcript tests verify that admission
  removes the dock row while the same root remains active, renders the message
  once, and preserves the root operation across the inserted message.
- `composer-queue-motion-dom.test.mjs` exercises normal-motion DOM removal with
  suspended animation frames, tween cancellation, reactivation, and unmount.
  Semantic queue cleanup has a bounded timer independent of the exit animation.
- Real-app verification uses the worktree-specific `pnpm tauri:dev` instance,
  actual composer sends and steer clicks, a model acknowledgement, and event
  checks for unchanged ownership and no interrupt.
