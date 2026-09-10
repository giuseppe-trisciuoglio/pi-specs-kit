# External output is sanitized before it becomes argv

A post-implementation gate failed and the whole run died. Not because the gate
was red — that is the gate doing its job, worth one attempt and a prompt the
next spawn can act on — but because an integration test had received a binary
protocol handshake on a socket it expected to speak HTTP, and the raw bytes
travelled from the exception message into the build summary, into the hook's
captured output, into the `<hooks>` block of the retry prompt, and from there
into `argv` of the next phase. Node refuses to spawn a process with an argument
containing a NUL byte, so the loop aborted with
`args[10] must be a string without null bytes` and an excerpt of the task block
— pointing at the one part of the prompt that was innocent.

## Where the sanitization goes

Two layers, neither of them a validator that rejects:

`runHook` (`src/loop/hooks.ts`) strips the non-printable control characters
while it composes `HookResult.output`. That is the single place the text is
built, so every consumer — the retry prompt, the log, a future reader — gets
output that can travel in an argv. `truncateOutput` in the prompt blocks was the
other candidate and is the wrong one: it bounds the size by keeping the tail,
which is exactly where the bytes were, and it only covers the consumers that go
through it.

`runAgentPhase` (`src/agent/spawner.ts`) strips them again from the prompt and
from both system-prompt arguments, immediately before the spawn. Hook output is
not the only external text that reaches a prompt — a previous phase's stderr, a
failure detail, a review's verbatim feedback all do — and sanitizing at the last
point before `argv` means no future path into the prompt can bring the abort
back, whatever its own hygiene.

Kept: tab, newline and carriage return, the three controls that carry meaning in
captured output. Stripped: NUL, the rest of the C0 block, and DEL
(`src/util/control-chars.ts`). Removing rather than escaping is deliberate —
these bytes are noise to the model reading the prompt and unprintable to the
operator reading the log, so there is nothing to preserve.

## A rejected spawn is a failed phase

The third layer is about blast radius. `spawnProcess` rejects when Node refuses
the arguments, and that rejection used to unwind through the phase, the task and
the engine to the run's abort handler. `runAgentPhase` now catches it and returns
an ordinary failed `PhaseRunOutcome` — no exit code, `stopReason: "error"`, the
message in `errorMessage` — which `classifyPhaseFailure` reads as a
non-environmental `agent-error`: the attempt is spent, the retry logic decides
what happens next, and the run stays alive. A malformed argument is this phase's
problem; the tasks after it are not the ones holding a binary byte.
