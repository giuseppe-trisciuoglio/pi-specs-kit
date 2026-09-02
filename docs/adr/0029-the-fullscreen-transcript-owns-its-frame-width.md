# The fullscreen transcript owns its frame width

Observed on a real run: with the fullscreen transcript open, the phase output
was wrapped to a handful of columns while the window was wide, and the footer
line ran across the full window in the same frame. The wrapping healed by
itself the moment the window was resized.

Two distinct defects met on that screen.

The first is the mixed frame. Every line of the view was clamped to the width
the render received except the footer and the key hint, which were emitted
whole. A line wider than the frame is wrapped by the terminal, so those two
lines both lied about the real width and pushed the rows below them out of
alignment.

The second is the stale width. The render path of the host propagates the
width intact from the terminal down to the markdown, so a narrow body means
the cached terminal size was already wrong when the view opened — a resize
that landed while nothing was listening for it. The size is only refreshed on
the resize signal, which is why the next resize repaired the view.

## Considered options

- **Read the size directly at render time.** Rejected: it duplicates the
  authority over the terminal size that belongs to the host, and every other
  component would keep the stale value anyway.
- **Widen the clamp defensively (take the largest of the candidate widths).**
  Rejected: it papers over a wrong width with a guess, and a guess that is too
  large produces lines the terminal wraps — the first defect again.
- **Clamp every line of the frame, and refresh the size when the view opens
  (chosen).** The footer and the hint are truncated like any other line, and
  entering the view re-emits the resize signal so the runtime reads the real
  size again. The same signal trick the toolchain already uses when a process
  resumes after being suspended.

## Consequences

The fullscreen view no longer produces a frame whose lines disagree about the
width, and a size that went stale before the view opened is corrected on the
way in rather than waiting for the operator to resize the window.

The refresh is best-effort and confined to the entry point: it is skipped on
platforms without the signal, and a failure to send it never keeps the view
from opening. It does not correct a size that goes stale while the view is
already open — no evidence of that case exists, and the operator's resize
covers it.
