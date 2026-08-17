/**
 * Closed registry of the named routing predicates. Each entry is a pure
 * function over the routing context: conditions route, they never compute —
 * anything needing logic belongs to a node action. The table references them
 * by name, and the compiler pins both the names and their presence here.
 */

import type { RoutingContext } from "./types.ts";

export type ConditionFn = (ctx: RoutingContext) => boolean;

const registry = {
  always: () => true,

  // Entry routing: fresh starts and resumes all enter through the same node,
  // so these predicates discriminate on the persisted starting step. The two
  // cycle entries also carry the retry guard: it used to be the loop
  // condition, evaluated before every phase, so entering the cycle with no
  // attempts left (a resume whose counters were already spent) must fall
  // through to the exhaustion edge at the end of the entry list instead of
  // running a phase the budget would not have allowed.
  enters_at_implementation: (ctx) =>
    (ctx.entry.startStep === null || ctx.entry.startStep === "implementation") && ctx.attemptsLeft,
  enters_at_review: (ctx) => ctx.entry.startStep === "review" && ctx.attemptsLeft,
  // Cleanup is skipped in fast mode; the resume point and the mode together
  // decide whether it runs.
  enters_at_cleanup_full_mode: (ctx) => ctx.entry.startStep === "cleanup" && ctx.mode === "full",
  enters_at_cleanup_fast_mode: (ctx) => ctx.entry.startStep === "cleanup" && ctx.mode === "fast",
  enters_at_learner: (ctx) => ctx.entry.startStep === "learner",
  // The sync of the range entry follows the same rule as the tail routing:
  // fast mode syncs once, on the last task of the selection, so entering at
  // the sync phase on an earlier task skips it without marking it as run.
  enters_at_sync: (ctx) => ctx.entry.startStep === "sync" && (ctx.mode === "full" || ctx.isLastTask),
  enters_at_sync_skipped: (ctx) => ctx.entry.startStep === "sync" && ctx.mode === "fast" && !ctx.isLastTask,
  enters_at_update_done: (ctx) => ctx.entry.startStep === "update_done",

  // Leaving the implementation phase. The exhaustion guard comes first in the
  // table; once attempts are gone, the failure kind is irrelevant to routing.
  impl_failed_attempts_exhausted: (ctx) => ctx.implStatus !== "ok" && !ctx.attemptsLeft,
  // A retry that ran clean and wrote nothing: the review asked for a change
  // and the implementation produced a byte-identical tree. Sending it to
  // review again reproduces the rejection it just failed to act on, so the
  // task stops here rather than spending the rest of its attempts.
  impl_no_op_retry: (ctx) => ctx.implStatus === "no-op-retry",
  // A provider that refused the spawn refuses the next one identically, so
  // this leaves the cycle without spending an attempt — the rule the review
  // step has always applied to its own refused spawns.
  impl_environment_failed: (ctx) => ctx.implStatus === "environment-failed",
  impl_pre_hook_failed: (ctx) => ctx.implStatus === "pre-hook-failed",
  impl_spawn_failed: (ctx) => ctx.implStatus === "spawn-failed",
  impl_post_hook_failed: (ctx) => ctx.implStatus === "post-hook-failed",
  impl_ok: (ctx) => ctx.implStatus === "ok",

  // Leaving the review gate, on the verdict it just dispatched. A rejection
  // with the same feedback as the previous round means the implementation is
  // not acting on it: another round would reproduce the same pair of outputs.
  verdict_report_unusable: (ctx) => ctx.verdict?.kind === "reportUnusable",
  verdict_failed_same_feedback: (ctx) =>
    ctx.verdict?.kind === "failed" && ctx.feedback !== null && ctx.feedback === ctx.verdict.feedback,
  verdict_retry_attempts_exhausted: (ctx) =>
    (ctx.verdict?.kind === "failed" || ctx.verdict?.kind === "attemptFailed") && !ctx.attemptsLeft,
  verdict_failed_new_feedback: (ctx) =>
    ctx.verdict?.kind === "failed" && (ctx.feedback === null || ctx.feedback !== ctx.verdict.feedback),
  verdict_attempt_failed: (ctx) => ctx.verdict?.kind === "attemptFailed",
  verdict_passed_full_mode: (ctx) => ctx.verdict?.kind === "passed" && ctx.mode === "full",
  verdict_passed_fast_mode: (ctx) => ctx.verdict?.kind === "passed" && ctx.mode === "fast",

  // Tail routing: full mode syncs every task; fast mode syncs once, on the
  // last task of the selection, so a failing tail cannot leave the run
  // without its only sync.
  sync_wanted: (ctx) => ctx.mode === "full" || ctx.isLastTask,
  sync_not_wanted: (ctx) => ctx.mode === "fast" && !ctx.isLastTask,

  // The failure funnel decides once, for every non-pass outcome, whether the
  // run moves on or halts.
  continue_on_failure: (ctx) => ctx.continueOnFailure,
  halt_on_failure: (ctx) => !ctx.continueOnFailure,

  // Run-level guard for the end-of-range sync: it only runs when no task
  // synced, there is a completed task to sync on, and no stop is pending.
  final_sync_needed: (ctx) => !ctx.syncRan && ctx.hasLastCompleted && !ctx.stopping,
} as const satisfies Record<string, ConditionFn>;

export type ConditionName = keyof typeof registry;

export const CONDITIONS: Readonly<Record<ConditionName, ConditionFn>> = registry;
