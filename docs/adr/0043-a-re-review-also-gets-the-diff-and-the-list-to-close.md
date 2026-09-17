# A re-review also gets the diff and the list to close

Amends ADR-0023, which stays in force for what it actually decided.

ADR-0023 gave a retried review the archive map and nothing else: where the
earlier verdicts live, never what they concluded, so the fresh evaluation
would not anchor on a conclusion someone else reached. The reviewer still
starts from an empty context at every attempt and reads the task, the spec and
the workspace again — a retry that touched three files buys the same reading
as the first review. Measured on two real specs: a review median of 7.8
minutes, and reviews accounting for 46 % of the loop time on one of them.

The question a re-review has to answer is narrow: are the findings the
previous verdict blocked on closed, and did closing them break anything. Both
halves of that are facts the loop already holds — the findings are in the
report it archives one line before the spawn, and what changed is what git
says between two trees.

## The line this draws

Passing the **patch** is not what ADR-0023 refused. A patch is what changed,
not what was said: it carries no verdict, no status and no opinion, and a
reviewer reading it reaches its own conclusion about the same code it would
have opened by hand.

Passing the **list of blocking findings** is a verdict, and that is why this
decision exists. The compromise is on what a verdict is made of: the findings
are delivered as things to verify, the conclusion is not delivered at all.
`review_status` and `summary` stay out, and so does the escalation list, which
ends the task rather than buying it another review. What travels is the
`issues` and the `spec_conflicts` of the archived report, the latter tagged as
conflicts so a contradiction does not read as an ordinary defect. Anchoring on
*what to verify* is the intent; anchoring on *the verdict* is still refused.

The diff narrows the reading, not the verdict. The prompt says so, because a
retry can break code the patch does not touch, and an unchanged file must not
read as an approved one.

## Considered options

- **Hand over the whole previous report.** Rejected, as in 0023: the reviewer
  ends up checking the old findings and little else, this time with the
  previous conclusion in front of it.
- **Hand over the patch alone.** Rejected: it says what moved, not what the
  move was supposed to fix, and the most urgent question of a re-review would
  still be answered by model quality.
- **Commit a checkpoint per attempt and diff against its ref.** Rejected: the
  loop commits only after a task passes, and a commit per attempt would put
  every rejected attempt into whatever the branch is proposed as.
- **The findings, the patch and the archive map (chosen).** The base tree is
  the one the fingerprint guard already writes before a retried implementation
  runs (ADR-0015) — that object is exactly the tree the rejected verdict was
  looking at, and it lives in the repository's own object store, so a later
  phase can still diff against it.

## Consequences

The review ingress grows two declared fields, and the prompt one block, both
empty on a first review: the shape of a first review's prompt is unchanged.

The patch excludes the review artifacts on top of what the loop already keeps
out of a fingerprint. Between the two trees the loop archives the verdict it is
replacing and removes the report it replaces, so an unfiltered patch would have
delivered the whole text of the previous review as an added file — the one
thing this decision says must not travel, handed over by accident.

Every part of the channel is best-effort, like the fingerprint it reuses.
Outside a git repository, with an unreadable tree, or with the ceiling set to
zero, the patch is absent and the re-review reads the workspace as it did
before. The checklist does not depend on git at all: it survives on its own
when the patch cannot be built.

`run.review_diff_max_kb` is the ceiling, 64 by default, and zero turns the
channel off. A cut patch is announced as cut and the `--stat` summary above it
is never cut, because that summary is how a reader learns which files the patch
stops short of.

The base tree is persisted in the fix plan (`state.review_base_tree`), so a
`--resume` in the middle of a retried task still reaches the review with its
patch. Tolerated as missing, like every field added since.
