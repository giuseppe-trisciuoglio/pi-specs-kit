# Drop the language parameter from the pi extension

The `--lang` argument carried over from the devkit fork shaped the specs-kit skills as if the agent could be specialized
per stack (Java/Spring, TypeScript/React, Python, …). In pi there are no specialized agents — there is only `pi` and
roles differ only by model and thinking level — so a parameter that selects an agent type is meaningless, and the
per-language exploration prompts that came with it are vestigial. We drop the parameter, collapse the per-language
guidance into a single stack-detection checklist, replace the per-language formatter table with "discover the project's
own tooling from its config", and stop emitting the language hint in the task frontmatter and in the prompt sent to the
phase agent.

## Consequences

What we kept, and why it looks asymmetric: the fix-plan JSON shares its shape with the existing CLI, and the project
treats format compatibility as a hard invariant. The fix-plan task entry still carries `lang` and the loop state still
carries `current_task_lang` as tolerant-read fields, so legacy fix plans load cleanly and the shared shape is preserved.
New task files the loop writes never set the field (the template no longer emits it, and the prompt builder no longer
surfaces it), so it stays `null` on the wire while remaining defined in the model. The prompt-builder test now asserts
`lang=` never appears in the task block, even when the model field is populated — that asymmetry is the point of this
ADR and is what the test pins down.