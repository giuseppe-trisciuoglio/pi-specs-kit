/**
 * Declared inputs of each phase spawn. The executor used to receive the
 * whole fix plan and extract what it needed, so any field could silently
 * leak into a prompt; these types make the ingress of every phase an
 * explicit, flat literal built by the calling node at the boundary. The
 * compiler is the only validator: a literal with missing or extra fields
 * does not compile.
 *
 * Types only, no runtime imports: the module is importable from tests
 * without dragging in the executor or any pi-provided package.
 */

import type { TaskFile } from "../tasks/task-parser.ts";
import type { RoutedSuggestion } from "./review-report.ts";

/** Identity of the measurement ledger row: which spec, which attempt. */
export interface PhaseMeterId {
  specId: string;
  attempt: number;
}

/** What every phase spawn receives: the task, its memory and the run knobs. */
export interface PhaseSpawnInput extends PhaseMeterId {
  task: TaskFile;
  /** Loop learnings for this spec, injected as task memory. */
  learnings: string[];
  signal?: AbortSignal;
}

export interface ImplementationPhaseInput extends PhaseSpawnInput {
  /** Verbatim feedback from a failed review, null on the first attempt. */
  reviewFeedback: string | null;
  /** Public API contracts from completed dependency tasks. */
  upstreamProvides: string[];
  /** Fixes earlier reviews routed to this task. */
  routedSuggestions: RoutedSuggestion[];
  /** Drives the pre-hook policy: first attempt blocks, retries feed context. */
  firstAttempt: boolean;
}

export interface ReviewPhaseInput extends PhaseSpawnInput {
  /** Why the previous report was rejected, null on the first spawn. */
  reviewFormatError: string | null;
}

export interface CleanupPhaseInput extends PhaseSpawnInput {
  upstreamProvides: string[];
  routedSuggestions: RoutedSuggestion[];
  firstAttempt: boolean;
}

export interface TaskSyncPhaseInput extends PhaseSpawnInput {
  upstreamProvides: string[];
  routedSuggestions: RoutedSuggestion[];
  firstAttempt: boolean;
}

/** The end-of-range sync spawns alone: no upstream contracts, no routed fixes. */
export type FinalSyncPhaseInput = PhaseSpawnInput;
export type SyncPhaseInput = TaskSyncPhaseInput | FinalSyncPhaseInput;
