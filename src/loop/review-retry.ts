/**
 * What a re-review is handed beyond a first review's ingress: the findings the
 * verdict it replaces blocked on, and the patch of what the retry changed.
 *
 * Its own module because the two halves answer the same question — what does
 * this review have to verify — and because the line they sit on is a decision,
 * not an implementation detail: a re-review is told what to check and never
 * what the previous one concluded.
 */

import type { FixPlan } from "../fixplan/fix-plan.ts";
import type { AttemptDiff } from "./phase-inputs.ts";
import { blockingFindings, type ReviewReport } from "./review-report.ts";
import type { ReviewStepDeps } from "./review-runner.ts";
import { loopArtifactExclusions, reviewArtifactExclusions } from "./workspace.ts";

/** What a re-review is handed beyond the first review's ingress. */
export interface RetryIngress {
  /** The findings the rejected verdict asked the retry to close. */
  findings: string[];
  /** What the retry changed since the tree that verdict judged. */
  diff: AttemptDiff | null;
}

/**
 * The patch a re-review reads: from the tree the rejected verdict judged to
 * the tree the retry left behind. Best-effort like every git signal of the
 * loop — no base tree (no git, or a first review), a zero ceiling or an
 * unreadable tree all leave the reviewer with the workspace and nothing else,
 * which is what it had before this channel existed.
 *
 * The review artifacts are excluded on top of the loop's own: between the two
 * trees the loop archived the verdict being replaced, and an unfiltered patch
 * would deliver its whole text as an added file.
 */
async function attemptDiff(deps: ReviewStepDeps, plan: FixPlan): Promise<AttemptDiff | null> {
  const { config, specDir } = deps;
  const base = plan.state.review_base_tree ?? null;
  if (!base) return null;
  const excluded = [
    ...loopArtifactExclusions(config.projectRoot, specDir),
    ...reviewArtifactExclusions(config.projectRoot, specDir),
  ];
  return deps.workspaceDiff(config.projectRoot, base, excluded, config.run.reviewDiffMaxKb * 1024);
}

/**
 * Assemble the retry ingress from the verdict the rotation is archiving. The
 * checklist does not depend on git and the patch does, so a repository the
 * loop cannot read costs the patch alone.
 */
export async function retryReviewIngress(
  deps: ReviewStepDeps,
  plan: FixPlan,
  prior: ReviewReport,
): Promise<RetryIngress> {
  return { findings: blockingFindings(prior), diff: await attemptDiff(deps, plan) };
}
