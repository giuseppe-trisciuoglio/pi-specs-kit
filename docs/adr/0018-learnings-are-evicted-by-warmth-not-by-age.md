# Learnings are evicted by warmth, not by age

The memory the loop carries between tasks was a flat list of fifty strings with
FIFO eviction. Each learner adds eleven to thirty-three bullets, so the list
turns over roughly every three tasks and nothing distinguishes an architectural
invariant from a note about a JPA default: the oldest goes, whatever it is.
Traced through the phase prompts of one real run, the rule "keep Spring
Security types out of the application layer" entered at the sixth task,
survived to the ninth, and was gone by the tenth — evicted by age with five
tasks still to implement against it.

## Considered options

- **Score each insight and evict the coldest (chosen).** Two signals the loop
  observes for itself, plus decay: how many tasks met the insight again, and
  whether a review had to reject the task that produced it. Nothing is
  self-rated — an agent asked to rank its own output rates all of it highly,
  with recency and authorship bias and nothing to check it against.
- **Detect re-statements by text similarity.** Rejected on measurement. Across
  the fifty learnings of the run, token-set similarity never exceeds 0.21, and
  the obvious semantic duplicate — "Build/tests must run with `JAVA_HOME`
  pointing at a JDK 21 install" versus "Build on JDK 21 even though the system
  default is JDK 25" — scores 0.20, indistinguishable from unrelated pairs at
  0.18. These are paraphrases with near-disjoint vocabulary; no threshold
  separates them.
- **Have the learner cite instead of restate (chosen in its place).** The
  learner is now shown what the project already knows and told to add only what
  is new; where a task met a recorded insight again it emits a `CONFIRMED:`
  line quoting it. The semantic match is done by the one participant that can
  do it, and the loop verifies the quote against the list it supplied, so a
  paraphrase or an invention is dropped rather than trusted. Citations are
  capped, and weigh no more than the rejection signal.
- **Have the learner tag its own bullets by importance.** Rejected: same
  self-rating problem, and each learner sees only its own task.
- **Compact with a model whenever the cap is hit.** Rejected as the primary
  mechanism: it spends an agent session per overflow, and the run overflows
  from the fifth task on. The end-of-range compaction stays as it was.

## Consequences

- The prompt handed to the learner was previously the task id and title and
  nothing else, which is why every task re-derived the same conventions in new
  words. Giving it the current list is what makes both non-duplication and
  citation possible; it is the change the rest depends on.
- `mergeLearnings` takes a named input and returns learnings plus stats. An
  exact repeat or a citation reheats the entry already present rather than
  taking a second slot, so reinforcement concentrates the memory instead of
  diluting it — under the old exact-match dedup, a reworded repeat consumed a
  slot of its own.
- Weights are denominated in tasks, because decay is one point per task: an
  insight outlives roughly `score` more of them. Six was reached by calibration,
  not taste. The first pass used two per hit and three for a rejection, and a
  rule met three times and paid for with a rejection still died within nine
  tasks — the decay ate the reinforcement, reproducing the failure with extra
  steps.
- `fix_plan.json` keeps `learnings` as a plain list of strings; the scores live
  in an optional `learning_stats` aligned by position. A plan written before
  this reads as neutral, and a reader of the file still sees the memory as it
  always looked.
- The scoring only ranks what is already in the list. It does not make the
  memory channel more persuasive: in the run that motivated this, the rule was
  in the implementation prompt verbatim, with the `grep` to verify it, and the
  agent violated it anyway. The review caught it. That remains the enforcement.
