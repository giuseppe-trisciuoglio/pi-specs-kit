# A halt taps the operator on the shoulder

Every message the loop produces goes to the in-session notification channel,
which is the right place for it: it lands in the transcript, in order, next to
the phase it belongs to. It has one blind spot, and it is the one that costs
the most. A run halts on a ceiling after fourteen hours; the operator is not
looking at the terminal, because a run that takes fourteen hours is precisely
the run nobody watches; the message sits there until morning. The ten hours of
silence that followed the halt were not a scheduling problem — the loop was
finished with what it could do and had no way to say so out loud.

## Considered options

- **The terminal's own notification escape sequence (chosen).** OSC 777 for
  most emulators, OSC 99 for Kitty, a PowerShell toast under Windows Terminal:
  the same channel the agent CLI already uses for "ready for input", and the
  same code path its bundled example established. No dependency, no daemon, no
  configuration, and a terminal that does not implement the sequence silently
  prints nothing.
- **A hook the operator configures.** Rejected as the mechanism: the hooks
  already exist and an operator who wants a webhook or a phone push can wire
  one up. But a halt has to be audible by default, and a default that requires
  configuration is not a default.
- **`osascript` / `notify-send` per platform.** Rejected: a subprocess per
  platform to reach the same notification the terminal is already able to
  raise, and it fails in exactly the environment where the escape sequence
  works best — an SSH session, where the notification belongs on the machine
  holding the terminal, not on the one running the loop.

## Consequences

- `src/util/push-notify.ts` holds the channel. `notificationSequence` is pure
  and exported, so the choice of sequence is tested without a terminal, and
  `pushNotify` never throws: a notification is not a reason for a run to fail.
- The title and the body are stripped of control characters and of the `;`
  that delimits the sequence's own parameters. A halt detail carries whatever
  the failing phase printed, and a semicolon in it would end the title early
  and hand the rest to the terminal as parameters — the same argument as
  `docs/adr/0035` makes for `argv`, at a different boundary.
- The engine fires it from the one place that turns a ceiling or an
  environmental streak into a halt, and takes it as an injectable dependency
  (`EngineDeps.pushNotify`) so the test suite observes the call instead of
  writing escape sequences into the test output.
- Windows Terminal invokes PowerShell only at the fixed absolute path
  `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, never through
  the working directory or `PATH`. This assumes the Windows system directory
  is protected by OS permissions. A nonstandard installation without that
  executable skips the toast, best-effort; there is no `PATH` fallback.
  The subprocess dependency is injectable so tests verify the executable and
  argument escaping without displaying notifications.
- Only a halt pushes. A completed run, a stopped run and an ordinary failed
  task stay on the in-session channel: a notification that fires for everything
  is one the operator learns to ignore, and the halt is the event that leaves
  the loop unable to continue without a person.
