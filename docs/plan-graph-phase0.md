# Piano di implementazione — Fase 0: grafo dichiarato per il loop dei task

Refactor puro che esteriorizza il grafo di esecuzione del ciclo per-task, oggi implicito
nel controllo di flusso di `TaskRunner.run`, in una tabella dichiarata di nodi ed edge
eseguita da un piccolo interprete. **Zero cambiamenti di comportamento osservabile.**
Riferimenti: analisi in `docs/graph-engineering-evolution.md` (sezioni 4, 7, 8), decisioni
D0–D8 assunte e non rinegoziate, ADR `docs/adr/0011`.

> Stato: Fase 0 completata (Step 0-11). La tabella e eseguita dall'interprete: `TaskRunner.run`
> costruisce il runtime del task e delega; `final_sync` e un nodo run-level dichiarato
> (`graph/run-graph.ts`) consumato da `LoopEngine.#walk`. Baseline all'atto della stesura:
> `npm test` 271 test passati (0 falliti), `npm run typecheck` e `npm run lint` verdi.
> A chiusura: 304 test passati, tre gate verdi.
>
> Adattamento rispetto a §4.2 emerso al taglio (il codice vince): la guardia del ciclo retry
> era valutata anche *all'ingresso* — un resume dentro il ciclo con `retry_count` gia esaurito
> non eseguiva alcuna fase e cadeva nel funnel. La tabella lo rende con le predicate
> `enters_at_implementation`/`enters_at_review` congiunte ad `attemptsLeft` e una edge
> catch-all `enter_task → task_failed [attempts-exhausted]` in coda alle edge d'ingresso.

**Perimetro del refactor.** Il ciclo per-task (`src/loop/task-runner.ts`) e la sync finale
(`TaskRunner.finalSync`, promossa a nodo run-level per D4). Il run-level (`LoopEngine.#walk`)
resta un `for` esplicito (D4); `PhaseExecutor`, `runReviewStep`, hooks, budget, prompt builder
non vengono ristrutturati (l'unica firma che cambia è quella di `buildPhasePrompt`, D7).
Nessuna modifica alla forma di `fix_plan.json`, alla semantica di `--resume`/`--force`,
nessuna nuova dipendenza, niente typebox nella tabella (D6).

---

## 1. Ricognizione: `TaskRunner.run` transizione per transizione

Ogni ramo del controllo di flusso, con riferimento `file:riga` e l'edge dichiarata che lo
sostituirà (tabella completa in §4). Le righe si riferiscono allo stato attuale del codice.

### 1.1 Ingresso del task — nodo `enter_task`

| Codice (task-runner.ts) | Cosa fa | Resa dichiarata |
|---|---|---|
| `:148` `budget.startTask(id)` | apre il budget per-task, **incondizionato** (anche su resume) | azione di `enter_task` |
| `:150-162` `if (!resumed)` | init completa di `state` (current_task, file, lang, `step = startStep ?? "implementation"`, retry/counter/error azzerati, `iteration++`), persist, notify `task ${id}: ${title}` | azione di `enter_task` (ramo fresh) |
| `:164` `startPostReview` | `stepIndex(startStep) >= stepIndex("cleanup")` → salta l'intero ciclo implementation↔review | predicate d'ingresso `enters_at_*` |
| `:165-166` `feedback = null`, `passed = startPostReview` | variabili in-flight | stato di runtime del task (D3); `passed` scompare, sostituita dal routing |
| `:171` `await collectRoutedSuggestions(...)` | raccolta una tantum (anche su resume post-review) | azione di `enter_task` |

### 1.2 Ciclo implementation ↔ review

| Codice | Cosa fa | Edge dichiarata |
|---|---|---|
| `:173` `if (!passed)` | resume post-review salta il ciclo | edge d'ingresso `enter_task → cleanup/learner/sync/update_done` |
| `:174` `skipImplementation = startStep === "review"` | resume a review salta la prima implementation | edge `enter_task → review [advance]` |
| `:175` `while (state.retry_count < maxAttempts)` | guardia esaurimento tentativi **al top del ciclo** | guardie `attempts-exhausted` first-match (vedi §3.5) |
| `:177` stop check (graceful/now) | `return "stopped"` senza persist | esito `stopped` dell'azione del nodo (interruzione globale, §3.9) |
| `:178-179` `state.step = "implementation"; persist` | persist d'ingresso nodo | azione di `implementation` |
| `:180-191` `executor.run("implementation", …)` | con `reviewFeedback`, `upstreamProvides`, `routedSuggestions`, `blockOnPreHookFailure: retry_count === 0` | azione di `implementation` (I/O del nodo, D1) |
| `:194` stop-now check | `return "stopped"` | esito `stopped` dell'azione |
| `:195-200` `!impl.preHooksOk` | notify, `retry_count++`, persist, `continue` | `implementation → implementation [pre-hook-failed]` |
| `:201-206` `spawnFailed(impl.outcome)` | notify (attempt N/M), `retry_count++`, persist, `continue` | `implementation → implementation [spawn-failed]` |
| `:210` stop check | `return "stopped"` | esito `stopped` dell'azione |
| `:211-213` step/persist + `runReviewStep` | sub-loop del report (macro, D2) | azione di `review` (wrapper di `runReviewStep`, che resta intatto) |
| `:214` verdict `stopped` | `return "stopped"` | esito `stopped` dell'azione di `review` |
| `:215-218` verdict `passed` | `passed = true`, break | `review_gate → cleanup [passed]` / `→ learner [mode-skip]` |
| `:222-225` verdict `reportUnusable` | `state.review_file_error = detail`, break (senza persist: sarà il funnel) | `review_gate → task_failed [report-unusable]` |
| `:226-235` verdict `failed` | stall guard `:230-233` (feedback identico due volte → `review_file_error`, break, senza persist); altrimenti `:234` `feedback = verdict.feedback` | `review_gate → task_failed [stall-guard]` / payload del back-edge `[failed]` |
| `:236-237` `retry_count++; persist` | incremento comune a `failed` e `attemptFailed` prima del back-edge | effetto dell'azione di `review_gate` sulle back-edge `[failed]` / `[attempt-failed]` |

### 1.3 Funnel dei fallimenti — nodo `task_failed` (D0)

| Codice | Cosa fa | Edge dichiarata |
|---|---|---|
| `:241-250` `if (!passed)` | `detail = state.review_file_error ?? "task not completed after ${maxAttempts} attempts"`; `state.error`, `state.step = "failed"`, persist, notify (continue/halt), `return continueOnFailure ? "done" : "halted"` | azione di `task_failed` + `task_failed → task_done [continue-on-failure]` / `→ task_halted [halt-on-failure]` |

Il budget esaurito NON passa di qui: `BudgetExceededError` sale da `PhaseExecutor.#spawn`
attraverso le azioni dei nodi e viene catturato in `engine.ts:253-266` → halt run-level
(ledge `budget-exhausted`, separata per D0; test "the per-task spawn ceiling…" la pinna).

### 1.4 Coda post-review

`postFrom = startPostReview ? startStep : "cleanup"` (`:253`) governa i primi tre nodi.

| Codice | Cosa fa | Edge dichiarata |
|---|---|---|
| `:255` guardia cleanup: `stepIndex(postFrom) <= stepIndex("cleanup") && mode !== "fast"` | skip in fast mode o su resume oltre cleanup | edge d'ingresso `enter_task → cleanup [advance]` / `→ learner [mode-skip]`; `review_gate → cleanup [passed]` / `→ learner [mode-skip]` |
| `:256-266` stop check, step/persist, `executor.run("cleanup", …)` (upstreamProvides, routedSuggestions, `blockOnPreHookFailure: retry_count === 0`), stop-now, fallimento non fatale → notify | azione di `cleanup`; il fallimento non instrada (D5), resta notifica |
| `:269-293` guardia learner (`stepIndex(postFrom) <= stepIndex("learner")`), stop, step/persist, `runLearner`, stop-now, fallimento → notify; successo → parse/merge learnings, persist, project learnings best-effort | azione di `learner`; nessuno skip di modalità |
| `:299` `isLast = !selected.some(t => t.num > taskFile.num)` | "ultimo" è posizionale sulla selezione | predicate `sync_wanted` |
| `:300-301` `if (stepIndex(postFrom) > stepIndex("sync")) runState.syncRan = true` | resume oltre sync marca la sync come già fatta **senza eseguirla** | effetto di `enter_task` sull'edge d'ingresso `→ update_done` (stato di runtime, D3) |
| `:302-316` guardia sync `mode === "full" \|\| isLast`; stop, step/persist, `#checkGraphForSync` (`:86-99`: stat di graphify, `graphPartialSync` + persist, warning), `executor.run("sync", …)`, `runState.syncRan = true`, stop-now, fallimento non fatale → notify | `learner → sync [advance, sync_wanted]` / `learner → update_done [mode-skip]`; check graphify inline nel nodo (D8) |
| `:318-338` `update_done`: step, `done.push`, `pending` filter, `range_progress`, frontmatter `reviewed` solo full mode (try/catch → warning, il done viene comunque persistito), `runState.lastCompleted = taskFile`, persist | azione di `update_done`; `lastCompleted` è l'input del nodo run-level `final_sync` |
| `:340-350` `checkpoint`: `if (!noCommit)` → commit `checkpoint: ${id} attempt ${retry_count+1}` + notify; notify finale `task ${id} completed`; `return "done"` | azione di `checkpoint` (`no_commit` resta I/O interno del nodo, non edge); `checkpoint → task_done [advance]` |

### 1.5 Livello di run (resta orchestrazione, D4)

- `engine.ts:284` stop check del loop; `:288-300` consumo dell'anchor di resume e di
  `firstPhase` (con notify "start phase … ignored"); `:302` skip dei task done;
  `:303-329` fine range: `finalSync`, `step = "done"`, pulizia `current_task`/`error`,
  persist, notifiche di chiusura (range completed, failures, partial sync) → `completed`.
- `finalSync` (`task-runner.ts:103-133`): guardia `syncRan || !lastCompleted || stopping`
  (`:110`), poi step/persist, check graphify, spawn sync **senza** `upstreamProvides` e
  `routedSuggestions` e senza stop-check dopo lo spawn, fallimento non fatale; compaction
  dei learnings best-effort (`:119-132`). → nodo run-level dichiarato (D4, §3.10).

---

## 2. Delta contro lo strawman della sezione 7

Punti in cui il codice reale differisce dalla tabella nodi/edge del documento di analisi.
La tabella di §4 è la sintesi riconciliata.

1. **`enter_task` su resume è quasi un no-op.** Lo strawman fa scrivere a `enter_task`
   "retry azzerati, persist" sempre; nel codice l'init completa avviene solo `if (!resumed)`
   (`task-runner.ts:150`), mentre `budget.startTask(id)` (`:148`) è incondizionato e non è
   tra le letture dello strawman. La tabella dichiara entrambe le letture.
2. **Le edge d'ingresso partono da `enter_task`, non da una sorgente "resume" parallela.**
   Nel codice fresh e resume entrano nello stesso `run()`: prima budget/init (enter), poi il
   routing d'ingresso (`:164`, `:174`, `:253`). Lo strawman disegnava edge `resume →` come
   sorgenti distinte; la resa fedele è una sola sorgente con predicate che leggono lo step
   di partenza.
3. **`update_done` e `checkpoint` non hanno guardia di resume.** Riprendendo da
   `update_done` si riesegue `update_done` (idempotente: `if (!plan.done.includes(id))`,
   `:319`) e il checkpoint. Lo strawman elenca `resume → update_done` ma non esplicita che
   la coda da sync in poi è incondizionata.
4. **Effetto collaterale nascosto su resume oltre sync**: `runState.syncRan = true` senza
   eseguire la sync (`:300-301`). Assente dallo strawman; va dichiarato (stato di runtime
   scritto da `enter_task`).
5. **`attempts-exhausted` non è un'unica edge.** La guardia è il `while` al top del ciclo
   (`:175`): l'esaurimento va dichiarato come edge di esaurimento sia da `implementation`
   (pre-hook/spawn falliti, `:195-206`) sia da `review_gate` (failed/attemptFailed,
   `:236-237`), con first-match-wins. Più dichiarato dello strawman, compatibile con D0.
6. **`pre-hook-failed` e `spawn-failed` instradano identico** (self-loop su
   `implementation` con `retry_count++`): differiscono solo per il testo della notifica.
   D5 le conferma come tipi distinti; la tabella avrà due edge strutturalmente identiche
   (vedi "Questioni", Q1).
7. **Il testo di §7 sui nodi di coda è superato da D5 stessa**: dice che i fallimenti non
   fatali di cleanup/learner/sync escono "con un tipo dedicato", ma non instradano — restano
   notifiche (nessun tipo). La tabella finale segue D5.
8. **`review_gate` non esiste come funzione**: la logica (dispatch del verdict, stall guard,
   aggiornamento feedback, `retry_count++`, persist) è inline in `run()` (`:215-237`). La
   Fase 0 non si limita a dichiarare: estrae il nodo.
9. **Ordine interno della macro review è parte del comportamento**: archivio del verdetto
   precedente, cancellazione del report canonico e solo poi check di stopping
   (`review-runner.ts:90-93`). `runReviewStep` resta intatto (D2).
10. **`sync` "legge graph presente?"**: il check graphify avviene dentro il nodo, prima
    dello spawn, e scrive `state.graphPartialSync` + persist (`task-runner.ts:86-99, :306`).
    D8 conferma che resta inline, ma lo strawman non lo dichiarava tra le scritture.
11. **`finalSync` differisce dal nodo sync per-task**: nessun `upstreamProvides`/
    `routedSuggestions`, nessun stop-check dopo lo spawn, e compaction dei learnings
    inclusa (`:103-133`). Il nodo run-level dichiarato conserva queste differenze.
12. **`update_done` scrive `runState.lastCompleted`** (`:337`): input di `final_sync`,
    assente dalle writes dello strawman. Va dichiarata (stato di runtime, D3).
13. **Cleanup/learner/sync leggono `retry_count`**: `blockOnPreHookFailure: retry_count === 0`
    (`:263`, `:311`). Letture non elencate nello strawman.
14. **Persist d'ingresso ridondante su resume**: ogni nodo agentic persiste `step` + stato
    anche quando identico al persistito (es. resume a review → `:211-212` riscrive lo stesso
    step). Gli eventi `onStateChange` e i `last_updated` sono osservabili: la Fase 0 mantiene
    i persist esattamente dove sono (dentro le azioni), l'interprete **non** introduce un
    persist uniforme d'ingresso.
15. **Il verdetto `stopped` della macro review** (`:214`) non è un'edge: interrompe prima
    del gate, coerente con la convenzione "interruzione globale" di §7.

---

## 3. Design dei moduli

### 3.1 File nuovi (tutti sotto `src/loop/graph/`, importabili dai test, zero dipendenze da pacchetti pi)

| file | responsabilità | righe attese |
|---|---|---|
| `src/loop/step-order.ts` | `STEP_ORDER`, `stepIndex` spostati da task-runner (usi: engine `:187`, predicate d'ingresso) | ~20 |
| `src/loop/graph/types.ts` | tipi del grafo: `TaskNodeId`, `EdgeType` (vocabolario D5), `TaskNode`, `TaskEdge`, `TaskGraph`, `RoutingContext`, `TaskRuntime`, `NodeAction`, `NodeOutcome`, `RunState` (spostato e ri-esportato da task-runner per non toccare engine) | ~110 |
| `src/loop/graph/conditions.ts` | registry chiuso delle predicate nominate (D6): funzioni pure su `RoutingContext` + mappa nome→funzione | ~130 |
| `src/loop/graph/task-graph.ts` | la tabella dichiarata: `buildTaskGraph(actions: Record<TaskNodeId, NodeAction>): TaskGraph` — solo dati, in ordine di valutazione | ~140 |
| `src/loop/graph/interpreter.ts` | `interpretTaskGraph(graph, ctx): Promise<TaskOutcome>`: esegue l'azione del nodo corrente, costruisce il `RoutingContext`, risolve la prima edge vera (first-match-wins), avanza fino a un sink; propaga `stopped` e `BudgetExceededError` senza routing; errore esplicito se nessuna edge matcha | ~90 |
| `src/loop/graph/task-nodes-cycle.ts` | azioni `enter_task`, `implementation`, `review` (wrapper di `runReviewStep`), `review_gate`, `task_failed` — codice estratto verbatim da `TaskRunner.run` | ~170 |
| `src/loop/graph/task-nodes-tail.ts` | azioni `cleanup`, `learner`, `sync`, `update_done`, `checkpoint` + helper `upstreamProvides` (da `task-runner.ts:24-31`) e check graphify (da `:86-99`) | ~160 |
| `src/loop/graph/run-graph.ts` | nodo run-level dichiarato `final_sync` (D4): guard predicate `final_sync_needed`, azione = ex `TaskRunner.finalSync` (`:103-133`) inclusa compaction | ~80 |

Firme chiave:

```ts
// types.ts
export type TaskOutcome = "done" | "stopped" | "halted";          // spostato/ri-esportato
export type EdgeType = "advance" | "passed" | "failed" | "attempt-failed" | "report-unusable"
  | "stall-guard" | "attempts-exhausted" | "pre-hook-failed" | "spawn-failed"
  | "mode-skip" | "continue-on-failure" | "halt-on-failure";       // D5; user-stop e budget-exhausted non sono edge per-node
export interface TaskRuntime { /* D3: feedback, lastVerdict, implStatus, routedSuggestions,
                                   entry {resumed, startStep}, runState */ }
export interface RoutingContext { /* slice readonly: entry, implStatus, verdict, feedback,
                                      attemptsLeft, mode, isLastTask, continueOnFailure, stopping */ }
export interface NodeOutcome { kind: "ok" } | { kind: "stopped" }  // da tipizzare come union
export type NodeAction = (io: NodeIO) => Promise<NodeOutcome>;

// conditions.ts
export const CONDITIONS: Readonly<Record<string, (ctx: RoutingContext) => boolean>>;
```

### 3.2 File modificati

| file | delta |
|---|---|
| `src/loop/task-runner.ts` | 354 → ~110 righe: conserva `TaskRunnerDeps` (wiring engine invariato), `run()` costruisce `TaskRuntime`, lega le azioni, delega a `interpretTaskGraph`; `finalSync` eliminato; re-export di `RunState`/`TaskOutcome` per compatibilità |
| `src/loop/engine.ts` | ~5 righe: import di `STEP_ORDER` da `step-order.ts` (`:25`), consumo del nodo run-level `final_sync` al posto di `runner.finalSync` (`:304`) |
| `src/loop/phases.ts` | 1 riga: `buildPhasePrompt({ …, learnings: plan.learnings })` al posto di `fixPlan: plan` (`:291`) — D7, estrazione al confine |
| `src/prompt/prompt-builder.ts` | `PromptContext.fixPlan?: FixPlan \| null` (`:27`) → `learnings?: string[]`; aggiorna `:157` e `:212`; rimuove l'import di `FixPlan` — D7 |
| `test/prompt-builder.test.ts` | meccanico: `makeFixPlan(...)` → lista `learnings` (4 punti d'uso) |

`buildPhasePrompt` è l'unico costruttore di prompt che riceve il fix plan intero (verificato:
usa solo `fixPlan.learnings`, due letture): dopo lo Step 1 nessuna funzione riceve più il
fix plan intero per costruire un prompt (D7).

### 3.3 Vincoli rispettati

- **Un file, una responsabilità, < ~250 righe**: tutti i file nuovi dentro quota; gli
  action-node sono split cycle/tail proprio per restarci.
- **Hot reload first**: la tabella è costruita da una funzione chiamata in `run()` a ogni
  task; nessuna risorsa al caricamento del modulo.
- **Commenti/identificatori in inglese, senza riferimenti a specifiche**: i nomi delle
  predicate e dei nodi sono linguaggio di dominio neutro (`mode_is_fast`-style, vedi §4).
- **Nessun nuovo pacchetto**, niente typebox (D6): `tsc` valida la tabella a compile time.

---

## 4. La tabella dichiarata

### 4.1 Nodi

| nodo | kind | azione (estratta da) | note |
|---|---|---|---|
| `enter_task` | deterministic | `:148-171` | budget sempre; init+persist+notify solo fresh; raccoglie routed suggestions; su resume oltre sync marca `runtime.runState.syncRan = true` |
| `implementation` | agentic | `:178-206` | persist d'ingresso, spawn con feedback/upstream/routed, gestione pre-hook/spawn falliti (`retry_count++`, persist) |
| `review` | agentic (macro) | `:211-213` + `runReviewStep` intatto | il grafo vede solo il verdict (D2) |
| `review_gate` | deterministic | `:215-237` | dispatch verdict, stall guard, aggiorna `feedback`, `retry_count++` + persist sulle back-edge; **nessun persist sui rami che escono verso il funnel** (lo fa `task_failed`) |
| `task_failed` | deterministic | `:241-250` | funnel D0: detail, `state.error`, `step="failed"`, persist, notify |
| `cleanup` | agentic | `:256-266` | fallimento non fatale = notifica |
| `learner` | agentic | `:270-292` | merge learnings + persist + project best-effort |
| `sync` | agentic | `:303-315` | check graphify inline prima dello spawn (D8) |
| `update_done` | deterministic | `:318-338` | frontmatter solo full mode; scrive `lastCompleted` |
| `checkpoint` | deterministic | `:340-350` | `no_commit` interno al nodo |
| `task_done` / `task_stopped` / `task_halted` | sink | — | l'interprete restituisce l'esito del sink raggiunto |
| `final_sync` (run-level) | agentic | `:103-133` | dichiarato in `run-graph.ts`, consumato da `#walk` a fine range (D4) |

### 4.2 Edge (per nodo, in ordine di valutazione — first-match-wins)

```
task_start  → enter_task        [advance]        when: always

enter_task  → implementation    [advance]        when: enters_at_implementation     # fresh (default o --phase) o resume a implementation
enter_task  → review            [advance]        when: enters_at_review             # salta la prima implementation
enter_task  → cleanup           [advance]        when: enters_at_cleanup_full_mode
enter_task  → learner           [mode-skip]      when: enters_at_cleanup_fast_mode  # resume a cleanup in fast: cleanup saltato
enter_task  → learner           [advance]        when: enters_at_learner
enter_task  → sync              [advance]        when: enters_at_sync
enter_task  → update_done       [advance]        when: enters_at_update_done        # con side effect syncRan=true (in enter_task)
enter_task  → task_failed       [attempts-exhausted] when: always                   # catch-all: ingresso nel ciclo con tentativi gia esauriti (le entry del ciclo richiedono attemptsLeft)

implementation → task_failed    [attempts-exhausted] when: impl_failed_attempts_exhausted   # dichiarata PRIMA delle back-edge
implementation → implementation [pre-hook-failed]    when: impl_pre_hook_failed             # implica attempts left
implementation → implementation [spawn-failed]       when: impl_spawn_failed
implementation → review         [advance]            when: impl_ok

review      → review_gate       [advance]        when: always

review_gate → task_failed       [report-unusable]     when: verdict_report_unusable
review_gate → task_failed       [stall-guard]         when: verdict_failed_same_feedback
review_gate → task_failed       [attempts-exhausted]  when: verdict_retry_attempts_exhausted  # dichiarata PRIMA delle back-edge
review_gate → implementation    [failed]              when: verdict_failed_new_feedback      # payload: feedback aggiornato
review_gate → implementation    [attempt-failed]      when: verdict_attempt_failed           # feedback invariato
review_gate → cleanup           [passed]              when: verdict_passed_full_mode
review_gate → learner           [mode-skip]           when: verdict_passed_fast_mode

cleanup     → learner           [advance]        when: always
learner     → sync              [advance]        when: sync_wanted            # mode full oppure ultimo task del range
learner     → update_done       [mode-skip]      when: sync_not_wanted
sync        → update_done       [advance]        when: always
update_done → checkpoint        [advance]        when: always
checkpoint  → task_done         [advance]        when: always

task_failed → task_done         [continue-on-failure] when: continue_on_failure
task_failed → task_halted       [halt-on-failure]     when: halt_on_failure
```

Convenzioni non-edge (coerenti con §7 e D5): `stopped` è un'esito che le azioni dei nodi
restituiscono dai punti esatti in cui oggi c'è un check (§1); il budget esaurito è la
propagazione naturale dell'eccezione fino all'engine. Nessuna delle due passa dal routing.

### 4.3 Registry delle predicate (chiuse, D6)

`always`; ingresso: `enters_at_implementation`, `enters_at_review`, `enters_at_cleanup_full_mode`,
`enters_at_cleanup_fast_mode`, `enters_at_learner`, `enters_at_sync`, `enters_at_update_done`;
implementation: `impl_failed_attempts_exhausted`, `impl_pre_hook_failed`, `impl_spawn_failed`,
`impl_ok`; gate: `verdict_report_unusable`, `verdict_failed_same_feedback`,
`verdict_retry_attempts_exhausted`, `verdict_failed_new_feedback`, `verdict_attempt_failed`,
`verdict_passed_full_mode`, `verdict_passed_fast_mode`; coda: `sync_wanted`, `sync_not_wanted`;
funnel: `continue_on_failure`, `halt_on_failure`; run-level: `final_sync_needed`.
~23 funzioni pure su `RoutingContext`: le condizioni instradano, non calcolano (chi ha
bisogno di logica è un nodo).

`attemptsLeft` si valuta **dopo** l'eventuale incremento fatto dall'azione del nodo
(`retry_count < maxAttempts`), esattamente come la guardia del `while` oggi.

---

## 5. Sequenza di step

Ogni step lascia i tre gate verdi: `npm test`, `npm run typecheck`, `npm run lint`
(`npm test` include unit + e2e). Protocollo di fallback comune: se uno step non passa,
revert dello step, confronto riga per riga con la mappa di §1 (ogni divergenza è quasi
sempre un persist, un notify o un check di stop spostato), rifare.

**Step 0 — Baseline e ancoraggio.**
Cosa: verificare i tre gate su main e registrare il numero di test (baseline attuale: 271);
creare il branch di lavoro. Nota: al momento della stesura il repo **non ha commit iniziali**
— fare un commit di baseline prima di qualsiasi modifica, altrimenti `git status` non può
dimostrare l'assenza di modifiche estranee (vedi Q5).
Verifica: tre gate verdi, `git status` pulito dopo il commit.

**Step 1 — D7: la slice del firewall nel prompt builder.**
Cosa: `prompt-builder.ts` (firma `learnings?: string[]`, due letture aggiornate, import
rimosso), `phases.ts:291` (estrazione `plan.learnings` al confine), `test/prompt-builder.test.ts`
(sostituzione meccanica, 4 punti).
Perché primo: indipendente dal taglio principale, elimina l'unica firma "fix plan intero"
prima che il refactor muova il codice che la chiama.
Verifica: tre gate; i test state-machine (che pinna i prompt tramite spawn fake) restano
verdi senza modifiche. Se fallisce: controllare la seconda lettura (`:212`, `hasMemory` per
il reconcile) — coperta dal test "reconcile mandate".

**Step 2 — Estrarre `STEP_ORDER`/`stepIndex` in `src/loop/step-order.ts`.**
Cosa: nuovo modulo; `task-runner.ts` importa da lì; `engine.ts:25` aggiorna l'import;
`stepIndex` resta disponibile per i predicate d'ingresso (Step 3) senza cicli di import.
Verifica: tre gate.

**Step 3 — `graph/types.ts` + `graph/conditions.ts` + test delle predicate.**
Cosa: tipi del grafo (§3.1) e registry chiuso con tutte le predicate di §4.3, pure, non
cablate a nulla. Nuovo `test/graph-conditions.test.ts`: tabella di verità per ogni
predicate (mode, verdict kind, feedback precedente/attuale, attemptsLeft, entry.startStep,
isLast, continueOnFailure).
Verifica: tre gate.

**Step 4 — `graph/interpreter.ts` + test con grafo giocattolo.**
Cosa: interprete first-match-wins con sink, propaga `stopped`, lascia salire
`BudgetExceededError`. Nuovo `test/graph-interpreter.test.ts`: percorso lineare, branch
condizionale, priorità d'ordine, sink terminali, condizione non registrata → errore,
nessuna edge matchante → errore, azione che restituisce `stopped`.
Verifica: tre gate.

**Step 5 — Test di caratterizzazione sui gap dell'oracolo (prima del taglio).**
Cosa: nuovo `test/resume-paths.test.ts` che pinna i comportamenti oggi non coperti da
test, sulla base del codice attuale: resume a `review` (implementation saltata, nessun
`<review_feedback>`), resume a `cleanup`/`learner`/`sync`/`update_done` (guardie `postFrom`,
incluso il side effect `syncRan` su resume oltre sync: un secondo completamento non
riesegue la sync in fast mode), stop graceful richiesto durante la sync → `update_done` e
checkpoint vengono comunque eseguiti (asimmetria dei check di stop, §6 punto 1).
Perché prima del taglio: questi test descrivono il comportamento da preservare; scriverli
dopo userebbe il codice nuovo come oracolo di sé stesso.
Verifica: tre gate con i nuovi test verdi sul codice attuale. Se un test rivela un
comportamento che sembra un bug: non correggerlo qui — caratterizzarlo e segnalarlo
(§6, §8).

**Step 6 — Estrarre le azioni dei nodi del ciclo (controllo di flusso invariato).**
Cosa: `graph/task-nodes-cycle.ts` con `enter_task`, `implementation`, `review`,
`review_gate`, `task_failed`: codice spostato verbatim da `TaskRunner.run` (§1.1–1.3);
`TaskRunner.run` le chiama dal `while` esistente.
Perché così: dimostra la fedeltà dell'estrazione con l'oracolo completo prima di toccare
il controllo di flusso.
Verifica: tre gate, suite e test di caratterizzazione inclusi.

**Step 7 — Estrarre le azioni della coda.**
Cosa: `graph/task-nodes-tail.ts` con `cleanup`, `learner`, `sync`, `update_done`,
`checkpoint` + `upstreamProvides` e check graphify (§1.4); stesso schema dello Step 6.
Verifica: tre gate.

**Step 8 — Dichiarare la tabella + test strutturali.**
Cosa: `graph/task-graph.ts` con la tabella di §4.2 (azioni iniettate, solo dati). Nuovo
`test/graph-table.test.ts`: ogni `from`/`to` è un nodo dichiarato; ogni nodo non-sink ha
almeno un'edge in uscita; ogni `when` è nel registry; i tre sink sono raggiungibili da
`enter_task`; **l'ordine** delle edge di `implementation` e `review_gate` mette le guardie
`attempts-exhausted` prima delle back-edge (assert esplicito); i tipi usati appartengono
al vocabolario D5.
Ancora nessun uso a runtime; `tsc` tiene onesta la tabella.
Verifica: tre gate.

**Step 9 — Il taglio: l'interprete in esecuzione.**
Cosa: `task-runner.ts` riscritto (~110 righe): costruzione di `TaskRuntime`, binding
azioni→tabella, `interpretTaskGraph`; eliminazione del `while`/`if` originale. `RunState`
spostato in `types.ts` e ri-esportato.
È lo step a rischio massimo: l'oracolo è la suite esistente + i test di caratterizzazione
dello Step 5, tutti inviolati.
Verifica: tre gate + e2e (che pinna anche il numero di righe del registro delle misure:
10 righe per il run completo — rileva spawn persi o duplicati). Se fallisce: mappa §1
riga per riga; cause più probabili: ordine first-match, persist mancante/duplicato,
check di stop spostati, side effect d'ingresso (`syncRan`, `skipImplementation`) dimenticati.

**Step 10 — `final_sync` come nodo run-level dichiarato.**
Cosa: `graph/run-graph.ts` con il nodo dichiarato (guard `final_sync_needed` nel registry,
azione = ex `TaskRunner.finalSync` verbatim); `engine.ts:304` consuma il nodo;
`TaskRunner.finalSync` eliminato.
Perché dopo il taglio: dipende da `RunState` già dichiarato come stato di runtime (D3/D4).
Verifica: tre gate; in particolare "fast mode syncs even when the last tasks of the range
fail" e il flusso e2e (dove il final sync è saltato perché la sync è già corsa: la guardia
va comunque valutata).

**Step 11 — Pulizia e documentazione.**
Cosa: import morti, verifica dimensioni file (< ~250), commenti in inglese senza
identificativi di specifica, messaggi invariati byte per byte; aggiornamento della
documentazione di progetto: albero moduli in `docs/plan.md` (§2), stato della Fase 0 in
`docs/graph-engineering-evolution.md` (o ADR addendum a `docs/adr/0011`).
Verifica: tre gate + rilettura della documentazione aggiornata.

---

## 6. Rischi e edge nascoste

1. **Check di stop asimmetrici (il rischio maggiore).** Oggi i check `#stopping` stanno in
   ~9 punti scelti storicamente: tra sync e `update_done` non ce n'è uno (uno stop graceful
   richiesto durante la sync lascia comunque completare `update_done` e il checkpoint);
   tra implementation e review c'è. Hoistare un check generico "prima di ogni nodo"
   nell'interprete **cambierebbe comportamento**. Mitigazione: i check restano dentro le
   azioni dei nodi, nei punti esatti di §1; test di caratterizzazione dello Step 5.
2. **Persist ridondanti/assenti come segnale.** Ogni persist emette `onStateChange` e
   aggiorna `last_updated`: spostarli è una regressione osservabile. Mitigazione: persist
   dentro le azioni dove sono oggi; nessun persist a livello interprete; `review_gate` non
   persiste sui rami verso il funnel (lo fa `task_failed`), come oggi.
3. **First-match-wins è convenzione d'ordine.** Due edge vere simultaneamente instradano
   diversamente se l'ordine cambia. Mitigazione: test strutturale sull'ordine (Step 8) +
   predicate per lo più mutuamente esclusive per costruzione (verdict kind).
4. **Side effect d'ingresso**: `syncRan = true` su resume oltre sync (`:300-301`) e la
   raccolta dei routed suggestions anche quando il ciclo non girerà (`:171`). Vanno resi
   da `enter_task`, non da edge "invisibili".
5. **Macro review intoccabile**: l'ordine archivio → cancellazione → check stopping →
   spawn (`review-runner.ts:90-93`) e il reset incrociato dei contatori sono coperti da
   `test/review-runner.test.ts`; `runReviewStep` non viene modificato.
6. **Budget**: `BudgetExceededError` deve attraversare l'interprete come eccezione nativa,
   senza routing né funnel (D0): i test per-task/per-run ceiling lo pinna già.
7. **Bug latente vs regressione — protocollo.** Se un test esistente fallisce dopo un taglio:
   è una regressione, il codice del passo vince e la tabella si corregge. Se invece la
   dichiarazione fa emergere un comportamento non coperto da test che sembra sbagliato
   (es. la persistenza ridondante su resume, o il fatto che `enter_task` raccoglie routed
   suggestions anche quando il ciclo non partirà): lo si caratterizza con un test, non lo
   si corregge in Fase 0, e lo si riporta (§8).
8. **Dimensione file**: gli action-node tendono a superare le 250 righe se tenuti insieme;
   lo split cycle/tail è già nel design. Se `task-nodes-cycle.ts` crescesse oltre quota in
   implementazione, separare `review_gate` (pura) in un file proprio.
9. **Hot reload**: la tabella è dati costruiti a ogni `run()`, nessuno stato di modulo;
   nessuna azione richiesta, solo non violare il vincolo introducendo cache di modulo con
   stato.

---

## 7. Strategia di test: come si dimostra l'assenza di cambiamenti

- **La suite esistente è l'oracolo e non viene toccata** (unica eccezione meccanica: i 4
  punti di `test/prompt-builder.test.ts` per D7). Pesa 271 test; in particolare:
  - `test/state-machine.test.ts` (~30 scenari): sequenze esatte di chiamate fase-per-fase,
    fix plan finali, notifiche (testo compreso), checkpoint, retry/halt/continue_on_failure,
    stall guard, report unusable, budget, resume, force, fast mode, sync finale su coda
    fallita;
  - `test/review-runner.test.ts`, `test/phase-interrupt.test.ts`: sub-loop e interrupt;
  - `e2e/loop.e2e.test.ts`: loop completo con agente finto, incluse **10 righe esatte del
    registro delle misure** (rileva qualsiasi spawn in più o in meno) e il resume.
- **Gap dell'oracolo chiusi prima del taglio** (Step 5) con test di caratterizzazione sui
  percorsi resume post-review e sull'asimmetria degli stop: i comportamenti oggi impliciti
  diventano pinntati *sul codice attuale*, prima che il refactor li muova.
- **Test nuovi per il dichiarato**: verità delle predicate (Step 3), interprete su grafo
  giocattolo (Step 4), invarianti strutturali della tabella (Step 8). Dimostrano che la
  tabella è un grafo ben formato, non che è *quello giusto*: questo lo dimostra l'oracolo.
- **Invariante di esecuzione a ogni step**: i tre gate verdi; il taglio principale (Step 9)
  è l'unico che cambia il controllo di flusso, e avviene dopo che estrazione (Step 6–7) e
  dichiarazione (Step 8) sono già state validate indipendentemente.

## 8. Questioni da riportare all'architect

1. **Q1 — `pre-hook-failed` e `spawn-failed` come tipi distinti (D5).** Nel codice reale
   instradano identico (self-loop su `implementation`, `retry_count++`, stesso effetto del
   funnel a esaurimento): differiscono solo nel testo della notifica. La tabella le tiene
   distinte come chiede D5, ma sono due edge strutturalmente identiche da `implementation`
   a `implementation`. Confermare che la distinzione di tipo resti voluta in assenza di
   routing divergente.
2. **Q2 — `attempts-exhausted` raddoppia per sorgente.** La guardia è al top del ciclo
   (`task-runner.ts:175`), quindi servono due edge di esaurimento (da `implementation` e da
   `review_gate`) più la regola d'ordine, invece della singola edge "ciclo retry" dello
   strawman. Eseguibile e compatibile con D0; solo più verbosa del previsto.
3. **Q3 — `user-stop` resta non dichiarato.** Le check di stop vivono dentro le azioni con
   asimmetrie storiche (nessuna check tra sync e `update_done`); dichiararle come edge
   per-node equivarrebbe a decidere cambiamenti di comportamento, fuori da un refactor
   puro. La Fase 0 le congela dove sono; se si vuole la simmetria, è una decisione da
   prendere esplicitamente in una fase successiva.
4. **Q4 — resa dichiarativa del side effect `syncRan` su resume oltre sync.** Il piano lo
   mette tra le scritture di `enter_task` (stato di runtime, D3). Alternativa: dichiararlo
   come payload dell'edge `enter_task → update_done`. Entrambe fedeli; la scelta
   (azione di nodo) è pragmatica: D6 vuole predicate che non calcolano.
5. **Q5 — il repository non ha commit iniziali.** Al momento della stesura `git log`
   fallisce e `git status` elenca tutto come untracked: il criterio di accettazione
   "nessun altro file modificato" non è dimostrabile per differenza. Serve un commit di
   baseline prima dello Step 0 (già previsto nel piano).

---

## 9. Risposte dell'architect (decisioni chiuse)

Le questioni di §8 sono risolte così. Valgono come vincoli al pari di D0–D8: chi implementa
non le rinegozia.

- **Q1 → tipi distinti confermati.** `pre-hook-failed` e `spawn-failed` restano due tipi
  anche se instradano alla stessa destinazione: il tipo registra la provenienza del
  fallimento, che è l'informazione utile quando si legge una traccia di esecuzione. La
  regola "un tipo esiste solo quando la routing decision dipende da lui" governa la
  *creazione* di tipi nuovi, non la fusione di due tipi già nel vocabolario.
- **Q2 → accettata la doppia edge di esaurimento.** Due edge (da `implementation` e da
  `review_gate`) più la regola d'ordine first-match, con l'assert strutturale previsto.
  La verbosità è il prezzo corretto per rendere esplicita una guardia che oggi è la
  condizione di un `while`.
- **Q3 → `user-stop` resta non dichiarato.** I check di stop restano nei punti esatti in cui
  sono oggi, asimmetrie comprese. Simmetrizzarli è un cambiamento di comportamento e non
  appartiene a un refactor puro: se si vuole, è una decisione separata da prendere più
  avanti, con i suoi test.
- **Q4 → `syncRan` è una scrittura di `enter_task`.** Confermata la resa come azione di
  nodo, non come payload di edge: le condizioni instradano e non calcolano, e un payload
  che muta stato di runtime renderebbe l'edge il posto dove cercare gli effetti.
- **Q5 → baseline git a carico dell'operatore**, prima dello Step 0. Nessuna delega parte
  su un albero senza commit.

---

## 10. Esito della review e fix applicati

Review indipendente del refactor completo contro la baseline pre-refactor: due difetti reali,
entrambi sul percorso d'ingresso o ai limiti, entrambi chiusi. Il resto del confronto (messaggi
utente byte per byte, posizione e conteggio dei persist, check di interruzione, ordine dei verdetti
nel gate, spawn e contatori, nodo run-level, propagazione dell'errore di budget) è risultato fedele.

**F1 — la guardia di modalità mancava sull'ingresso diretto alla sync.** La predicate d'ingresso
leggeva solo la posizione di partenza, ignorando la modalità: entrare alla fase di sync in modalità
veloce su un task non ultimo eseguiva una fase che prima veniva saltata, e per giunta marcava la
sync come eseguita, sopprimendo la sync di fine range e la compaction dei learnings di progetto.
Fix: predicate d'ingresso congiunta con la condizione di modalità, più l'edge complementare che
salta al nodo di aggiornamento del task senza marcare la sync. Caratterizzato da un test nuovo,
verificato fallire sulla predicate vecchia e passare su quella corretta.

**F2 — il tetto di hop dell'interprete era una costante arbitraria.** Il ciclo originale non aveva
alcun limite di iterazione: con un numero di tentativi configurato molto alto il walk abortiva con
un errore grezzo invece di esaurire i tentativi e passare dal funnel. Fix: tetto derivato dalla
configurazione reale, con la costante che resta solo come fallback e rete contro i cicli infiniti.

**Stato finale**: 305 test verdi (304 più il test di caratterizzazione di F1), typecheck e lint
puliti; nessun test preesistente modificato oltre l'aggiornamento meccanico del contratto del prompt
builder e l'inventario del registry chiuso.

## 11. Cosa resta fuori dalla Fase 0

Consapevolmente non affrontato qui, in ordine di priorità suggerita:

1. **Un run può chiudersi completato con zero sync.** Un resume oltre la sync la marca come già
   eseguita senza eseguirla, e questo sopprime anche la sync di fine range. Anomalia preesistente,
   ora pinnata da un test: è un candidato bug da decidere, non una regressione.
2. **Asimmetria dei check di interruzione.** Non ce n'è uno fra la sync e l'aggiornamento del task
   come completato: uno stop chiesto durante la sync lascia completare il task e il checkpoint.
   Congelata per fedeltà (Q3); simmetrizzarla è una decisione con i suoi test.
3. **Guardia d'ingresso al ciclo con tentativi esauriti**: resa dalla edge catch-all, corretta ma
   non coperta da un test dedicato.
4. **`engine.ts` sopra la soglia indicativa di righe**, già così prima della Fase 0.
