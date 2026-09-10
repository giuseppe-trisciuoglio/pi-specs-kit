# A dead primary model is not re-probed for the rest of the run

The per-role escalation of `0027` gives a role a second model: on a classified
failure the phase is spawned once more on the fallback before giving up. The
diagnosis, though, was thrown away as soon as the phase ended. A provider key
that hits a hard, longer-lived cap — a daily key limit answered as
`403 Key limit exceeded` — is not a moment of bad luck: every phase for that
role, for the rest of the run, paid for the same doomed attempt before falling
back.

The cost is not only latency. The wasted attempt is a real subprocess, charged
to `run.max_spawns_per_task` and `run.max_spawns_per_run` like any other, on
ceilings sized for roughly one spawn per phase. Over a long range that doubles
the spawn count of every affected phase and can exhaust the run budget before
the range completes — the loop stalls anyway, later and less legibly than an
outright halt, while a working model was available the whole time.

## Considered options

- **Persist the dead primary in the fix plan.** Rejected: access comes back.
  A cap resets overnight and a rotated key works again; a run that starts
  tomorrow must re-probe the primary rather than inherit yesterday's verdict.
  The memory is run-scoped, held on the spawner instance, which lives exactly
  as long as the run.
- **Re-probe the primary every N phases.** Rejected: the probe is the cost
  being removed. Any period is a guess, and the failure the memory records is
  by definition the kind that does not change within a run.
- **Escalate to a ladder of further models.** Out of scope and already refused
  in `0027`: proving the same outage against more models per task is the
  behaviour this decision exists to stop.
- **Remember the dead primary for the run (chosen).** After an environment
  failure whose escalation delivered, the role's primary is recorded as dead
  and later phases for that role spawn straight on the fallback.

## What earns the memory

Only a failure classified as environmental. A silent spawn or an agent error
says something about the prompt, and the next phase's prompt is a different
one — those keep re-probing the primary. The entry also records *which* model
died, so a configuration reload that names a different primary probes the new
one: the memory is about the model the run found dead, not about the role.

The escalation notice still fires for the attempt that discovered the failure,
and one further notice says that the role stays on the fallback for the rest of
the run. Both are emitted once; the phases that follow are silent about it, so
the transcript names the switch instead of leaving the operator to infer it
from spawn counts.

The budget sees only what actually ran: the skipped primary is never spawned,
so it is never charged.
