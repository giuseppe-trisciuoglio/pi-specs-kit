# User Request

**Original Input** (Italian):

> se è attivo, quando il loop è terminato vorrei che il sistema (previo flag in configurazione) imposti in automatico la creazione di una pr. A volte nei progetti il commit e il push potrebbe essere bloccato. Dovremmo eseguire questi commandi in modo programmatico.

**Translation**:

If enabled, when the loop is finished I would like the system — via a flag in configuration — to automatically set up the creation of a pull request. Sometimes in projects the commit and push could be blocked. We should execute these commands programmatically.

**Key Requirements Mentioned**:

- A configuration flag gates the feature (opt-in)
- Trigger: the loop has terminated
- Behavior: automatic creation of a pull request
- Concern: agent-driven commit/push can be blocked or unreliable in some projects
- Constraint: commit, push and pull request creation must be executed programmatically by the system itself, not delegated to the agent

**Clarifications Collected During Brainstorming**:

- Trigger: only on the completed terminal state (halted and stopped runs skip delivery)
- Branch: when the working branch is the base branch, the system auto-creates a branch named after the spec identifier
- Failure policy: delivery failures warn loudly but never change the loop's completed outcome
- Approach: balanced delivery (commit + branch safety + push + spec-derived PR + PR URL notification)
