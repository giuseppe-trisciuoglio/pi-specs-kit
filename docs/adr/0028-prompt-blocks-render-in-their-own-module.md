# Prompt blocks render in their own module

The static-analysis report flagged the phase-prompt assembler with a cognitive
complexity of fifty-five against a ceiling of fifteen, and the finding was
fair: one function gathered the task block, the skill blocks, the knowledge
base, the inlined spec documents, both memory channels, hook outcomes, review
feedback, format errors, prior-attempt archives, upstream contracts, routed
suggestions and the per-phase instructions, deciding for each whether it
applied and how it rendered. Every new prompt block made that function worse,
and nothing about it could be tested except through the assembled whole.

The fix moved the rendering of each block into `src/prompt/prompt-blocks.ts`
as a small function that takes what it needs and returns either the rendered
text or null when the section does not apply. What stayed behind is the
assembly alone: stack the non-null results, append the instructions, join.
The context type and the hook-result type moved with the blocks, since they
describe exactly those inputs; the builder re-exports them so callers see no
difference.

Two constraints shaped the split. Output must stay byte-identical for every
input the tests already pin down — the prompts are resent at every turn and
their shape is part of the loop's contract with the phases — so the extraction
was mechanical, block by block, with the existing thirty-three builder tests
as the gate. And the file-size rule pulled in the same direction the complexity
finding did: the builder had outgrown its file long before it outgrew its
function.
