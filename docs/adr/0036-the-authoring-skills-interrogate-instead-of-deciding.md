# The authoring skills interrogate instead of deciding

The brainstorming skill was producing specifications the author had never been
asked about. Not as a drift of the model's behaviour: the skill said so. Its
core principles opened with *"ask only high-signal questions … if the request is
already clear, proceed without adding extra checkpoints"*, the refinement phase
capped the dialogue at three questions asked in one batch, the approach phase
allowed selecting a dominant option *"without an extra gate"*, the presentation
phase defaulted to drafting everything and reviewing once, and a table listed
the areas — retention, authorization, error behaviour, validation, integration
shape, interface behaviour — where the right move was to *"guess and document"*.
Everything the author cared about most had a sanctioned way of never reaching
them. The `[NEEDS CLARIFICATION]` cap of three then absorbed what was left: the
overflow was to be converted into best-guess assumptions.

## The shape

Brainstorming is an interrogation and the specification is written from the
answers. A single **Grilling Protocol** section states the rules once, and the
phases refer to it: one question per turn with the reply awaited before the
next; every question carrying the answer the skill would pick, so the cheapest
possible reply is "yes"; closed options preferred, recommendation first; a new
decision opened by an answer followed immediately, depth first; and anything
answerable from the codebase, the ADRs or `CONTEXT.md` read rather than asked.

The loop has no quota. It ends when no remaining ambiguity would change scope,
acceptance criteria, constraints or exclusions — or when the author says to
proceed. "Seems clear enough", "the questions are getting long" and "a
reasonable default exists" are explicitly not exits.

Every unknown therefore lands in one of three places, and there is no fourth:
answered becomes a requirement, delegated ("decide for me") becomes a documented
assumption attributed to the delegation, deferred becomes a marker. A marker is
now defined as *a question the author was asked and postponed*, which makes the
count diagnostic rather than regulatory: more than three means the interrogation
stopped early, and the answer is to resume it, never to trim the list into
silent assumptions.

The old "make an informed guess instead" table survives inverted, as *areas the
grill must cover*: the same rows, each now a question to put to the author with
the former default demoted to the recommendation that opens it.

## Where the gates went back

Approach selection is the author's, stated as such even when one option
dominates — the skill says that it dominates and has it confirmed. The
specification is again validated section by section, with the all-at-once draft
available only when the author explicitly asks for it.

## The technical plan

`specs-kit-technical-plan` had the milder version of the same defect: it
mentioned `ask_user_question` but defined no protocol, and told the skill to ask
for the stack *"or derive from existing architecture"* — an alternative to
asking. Deriving is now how a candidate is found, not permission to skip the
confirmation, and stack components and architecture decisions are raised one at
a time with a recommendation attached.
