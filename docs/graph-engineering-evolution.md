# Evoluzione di pi-specs-kit verso il graph engineering (seriale)

Analisi di come trasformare il loop di esecuzione dei task da **grafo implicito**
(controllo di flusso in TypeScript) a **grafo dichiarato** (nodi, edge tipizzate e
condizioni come dato), mantenendo l'esecuzione strettamente seriale.

Documento di partenza per la sessione di grilling della Fase 0. L'obiettivo di
questo testo era fissare la diagnosi, la terminologia e l'agenda delle decisioni;
le decisioni sono state prese in grill e sono registrate qui (D0–D8), i termini
canonici in `CONTEXT.md`.

> Stato: grill di Fase 0 completata (D0–D8 risolte); Fase 0 implementata
> (vedi `docs/plan-graph-phase0.md`: la tabella e eseguita dall'interprete e la sync finale
> e un nodo run-level dichiarato). Fase 1 implementata (vedi
> `docs/plan-graph-phase1.md` e ADR `docs/adr/0012`): il fix plan non attraversa
> piu il confine nodo → esecutore, l'ingresso di ogni Fase e un literal piatto
> tipizzato e i prompt sono rimasti byte per byte identici (oracolo:
> `test/phase-prompts.test.ts`).

---

## 1. Reframe: non «pipeline → grafo», ma «grafo implicito → dichiarato»

La diagnosi di partenza («pi-specs-kit è una pipeline cablata, non è graph
engineering») è troppo severa. Le fonti di riferimento (§7) sono esplicite:

> «A loop is just a directed, cyclic graph.» — David Khourshid
> «Agent graphs are usually not DAGs. Loops are simple graphs.» — LangGraph
> Timeline di Osmani: loop engineering (giu 2026) → graph engineering (lug 2026),
> dove il salto è *«the structure between nodes becomes as important as the nodes
> themselves»*, **non** l'aggiunta del parallelismo.

pi-specs-kit **è già un grafo seriale ciclico**:

- nodi = le Fasi (implementation, review, cleanup, learner, sync) + passi
  deterministici (enter, gate del verdetto, update_done, checkpoint);
- un back-edge condizionale: review FAILED → implementation
  (`src/loop/task-runner.ts:226-236`);
- una guardia anti-stallo: feedback identico due volte → fallimento del task, e da lì
  `continue_on_failure` decide se il run si ferma (`:227-232`);
- checkpoint/resume atomico a ogni transizione
  (`src/fixplan/fix-plan.ts:150-156`, `saveFixPlan`);
- maker/checker split: implementation (maker) ↔ review (checker con veto).

Il vero divario, quindi, non è «diventare un grafo» ma **rendere dichiarato il
grafo che già si esegue**. È una distinzione che cambia la progettazione: non si
*costruisce* la topologia, la si *esteriorizza* da `TaskRunner.run` (dove oggi è
dispersa in `while`/`if` + il campo `state.step`) in una struttura dati
ispezionabile, testabile e componibile.

---

## 2. Il no-parallelismo non è un compromesso, è la scelta corretta

L'istinto di escludere il parallelismo è confermato dai fonti in termini
**economici**, non di semplificazione:

> «Graph engineering is defined by topology, state management, and explicit
> transition authority, not by multi-threaded concurrency. A completely serial
> pipeline is still a fully graph-engineered system.»
> **I grafi seriali vincono sul costo quando la pass-rate per ciclo è < ~50%.**
> Al 30% di pass-rate, un grafo parallelo costa ~3× i token di uno seriale per
> lo stesso numero di cicli.

I task di codifica hanno pass-rate bassa (è il motivo per cui esiste il retry con
`max_attempts`). Dunque **il grafo seriale è l'architettura target**, non un
gradino intermedio. Stripe Minions stessa — l'esempio *blueprint* — è, al nucleo,
una macchina a stati seriale con cicli di correzione.

Conseguenza progettuale: le Fasi 0–2 di questa analisi raddoppiano sul *serial
graph engineering*. Il parallelismo resta fuori scope (come già in `docs/plan.md`
§9) e non è prerequisito di alcuna fase.

---

## 3. Mappa contro i 5 elementi strutturali del graph engineering

I fonti identificano cinque elementi minimi per un grafo di esecuzione. Mappa
dello stato attuale di pi-specs-kit:

| Elemento | Stato | Evidenza |
|---|---|---|
| **Nodi agentic + deterministici** | Parziale. Gli agentic sono le 4 Fasi. I **deterministici sono inline, non first-class**: hook, gate del review-file, check di graphify, scrittura frontmatter in update_done, skip per fast-mode/`continue_on_failure` | `src/loop/phases.ts` (hook dentro `run`), `src/loop/review-runner.ts:85-138` (gate), `src/loop/task-runner.ts` `#checkGraphForSync` + blocco update_done |
| **Edge + transizioni condizionali** | Esiste il back-edge, ma è **codice, non dato** | `STEP_ORDER` (`task-runner.ts:41-48`) + la matassa di `if`/`while` in `TaskRunner.run` (`:175-320`) |
| **Context firewall per nodo** | **Presente** (subprocesso `--no-session` + prompt ricostruito da zero ogni Fase). **Falla**: `buildPhasePrompt` riceve il `fixPlan` intero e ne usa solo `.learnings` | `src/agent/spawner.ts:44`; `src/prompt/prompt-builder.ts` (blocco `<memory>`); passaggio in `src/loop/phases.ts` `run()` → `fixPlan: plan` |
| **Stato per-nodo** | Stato **centralizzato** singolo — e i fonti lo *endorsiscono* esplicitamente | `src/fixplan/fix-plan.ts` `LoopState` (step, current_task, retry_count, …) |
| **Resume / checkpoint** | **Presente**, atomico a ogni transizione | `saveFixPlan` (tmp + rename) invocato via `#persist` ovunque |

**Conclusione:** non mancano firewall, checkpoint né back-edge. Manca
(1) la **dichiarazione** del grafo come dato, (2) il **rigore** del firewall
(smettere di passare il `fixPlan` intero), (3) la **promozione** dei nodi
deterministici a first-class.

---

## 4. Le tre lacune → evoluzione in fasi (tutte seriali, tutte reversibili)

### Fase 0 — Esteriorizzare il grafo (refactor puro, zero cambio di comportamento)

Sostituire `STEP_ORDER` + gli `if`/`while` di `TaskRunner.run` con una **tabella
di nodi ed edge** come dato. Ogni nodo dichiara
`{ id, kind: "agentic" | "deterministic", run, reads: [...], writes: [...] }`.
Ogni edge dichiara `{ from, to, condition? }` con `condition` che legge lo stato
o l'esito del nodo precedente.

Diventano edge dichiarati (oggi `if` inline):
- il back-edge review FAILED → implementation (condition: `verdict.kind === "failed"`);
- la guardia anti-stallo feedback-identico → `task_failed` (condition:
  `feedback === verdict.feedback`);
- lo skip di cleanup in fast-mode (condition: `config.mode === "fast"`);
- il sync condizionale (condition: `config.mode === "full" || isLast`);
- `continue_on_failure` → next task (condition: `config.run.continueOnFailure`).

**Valore.** Il grafo diventa ispezionabile e testabile come dato; `TaskRunner`
collassa a un piccolo interprete (sotto le ~250 righe, coerente con `AGENTS.md`).
È anche il primo atto del grilling: dichiariare ogni transizione oggi sepolta
nel controllo di flusso fa emergere le assunzioni nascoste.

**Nessun nuovo runtime.** La tabella può vivere in TypeScript (`typebox`, già
disponibile) senza nuove dipendenze, rispettando il vincolo «dipendenze runtime:
solo `yaml` + `typebox`».

### Fase 1 — Contratti I/O per nodo (il context firewall reso rigoroso)

> **Implementata.** La forma reale e descritta da `docs/plan-graph-phase1.md` e
> registrata in ADR `docs/adr/0012`: contratto sull'**ingresso** di ogni Fase
> (tipi in `src/loop/phase-inputs.ts`, overload di `PhaseExecutor.run`), non
> sull'output — l'output reale resta `{ preHooksOk, hookResults, outcome }`;
> `modifiedFiles` non e mai esistito. I project learnings restano una lettura
> dell'esecutore, non del nodo.

Definire uno **schema I/O per nodo**: il nodo `implementation` legge
`{ task, memory, reviewFeedback, upstreamContracts, routedSuggestions,
projectLearnings }` e produce `{ modifiedFiles, hookOutputs }`; il nodo `review`
produce `{ verdict, feedback }`; ecc. Smettere di passare `fixPlan` intero a
`buildPhasePrompt`: passare la **vista dichiarata**.

**Valore.** Chiude l'unica falla reale del firewall. I fonti:
*«context does not automatically flow between nodes — you design the edges that
carry it. Missing an edge = downstream agent acts blindly.»* Rende il prompt
**deterministico dalla topologia**, non dall'implementazione, e `buildPhasePrompt`
testabile per-nodo senza costruire un `FixPlan` fittizio.

### Fase 2 — Nodi deterministici first-class (composizione blueprint)

Promuovere da codice inline a **nodi dichiarati** con proprio contratto I/O:
l'esecuzione degli hook, il gate «il report esiste ed è leggibile», il check
«graphify/graph.json presente» (Sync parziale), la scrittura del frontmatter
`reviewed` in update_done.

**Valore.** Realizza il modello *blueprint* di Stripe Minions (interleave di nodi
deterministici e agentic): *«putting LLMs into contained boxes compounds into
system-wide reliability.»* Sposta rumore deterministico fuori dal contesto
dell'agente (es. l'output grezzo degli hook, oggi troncato a 6 KB nel prompt,
diventerebbe output di un nodo deterministico che produce un verdetto
strutturato).

### Fase 3 (opzionale) — Edge come configurazione

Externalizzare la tabella nodi/edge in YAML/JSON, riusando lo stesso principio di
graphify (grafo dichiarato in un file) ma per l'**esecuzione** invece che per la
conoscenza. Rende la topologia ispezionabile e modificabile senza toccare il
codice. Coerente col fatto che si legge già un grafo esterno
(`graphify-out/graph.json`, ADR `docs/adr/0009`) — solo, per scopo diverso.

---

## 5. Correzione all'analisi di partenza

L'analisi originale (punto 5) diceva: lo stato per-nodo serve a «reggere
branching/parallelismo concorrente (un solo step/current_task/retry_count)». Per
la **strada no-parallelismo è mal posto**: lo stato centralizzato singolo è
*corretto e voluto* dai fonti (LangGraph: «centralized, schema-validated state
object»). Quello che serve non è *spaccare* lo stato per nodo, ma far leggere a
ogni nodo **solo la sua slice dichiarata**. È la Fase 1 (contratti I/O), non un
file di stato per task.

`fix_plan.state` resta single-source-of-truth (e mantiene resume / `--force` /
riconciliazione così come sono). Cambia il *contratto di lettura*, non la
*struttura*.

---

## 6. Costi e rischi (da tenere a mente quando si progetta)

I fonti sono espliciti sui trade-off:

> «A loop is tolerant of ambiguity. A graph is not — you must declare every node,
> every edge, every failure mode.»
> «Untyped edges are useless. Every edge must have a type.»
> Rischio peculiare del parallelismo: *feedback loop cost runaway* nei grafi
> paralleli a bassa pass-rate — **escluso** da questo perimetro.

La mitigazione è **Fase 0 come refactor puro**: rendere visibile il grafo che si
ha *prima* di aggiungere un singolo edge nuovo. Se un'edge nascosta salta fuori
durante la dichiarazione, si è trovato un bug latente, non creata complessità.

---

## 7. Strawman: il grafo attuale come lo dichiara la Fase 0

Candidato della topologia attuale, per task, corretto dopo il confronto col
codice: la prima bozza invertiva cleanup/learner, dichiarava `halt` dirette che
il codice non ha, ignorava gli ingressi da resume e la mancanza del verdict
`attemptFailed`. Lo scopo resta un argomento concreto da raffinare, non una
specifica finale.

Convenzioni di lettura: `stopped` (richiesta di stop dell'operatore) è
un'interruzione globale raggiungibile da ogni nodo, non un'edge da dichiarare
per ciascuno; i nodi agentic di coda (cleanup, learner, sync) falliscono in
modo non fatale — l'edge uscente porta comunque avanti il task, con un tipo
dedicato (vocabolario D5). Il budget esaurito è un halt run-level che non
passa dal funnel: ignora `continue_on_failure` per costruzione.

### Nodi

| nodo | kind | legge | scrive |
|---|---|---|---|
| `enter_task` | deterministic | task, resume anchor o fase iniziale esplicita, fix_plan.state | state.current_task, iteration++, retry azzerati, persist |
| `implementation` | agentic (ruolo `agent`) | task, memory, reviewFeedback, upstreamContracts, routedSuggestions, projectLearnings, preHookResults | file del workspace, hookOutputs |
| `review` | agentic (ruolo `reviewer`, sub-loop) | task, reviewFormatError | `tasks/<T>--review.md`, verdict |
| `review_gate` | deterministic | verdict, feedback (prev) | feedback (new), review_file_error |
| `task_failed` | deterministic | stato del task, continue_on_failure | state.step="failed", state.error, persist |
| `cleanup` | agentic (ruolo `cleaner`) | task, upstreamContracts, routedSuggestions | file del workspace |
| `learner` | agentic (ruolo `learner`) | task.id, task.title | learnings[] (spec + progetto) |
| `sync` | agentic (ruolo `synchronizer`) | task, memory, projectLearnings, graph presente? | documenti della spec, graphPartialSync? |
| `update_done` | deterministic | task, fix_plan, mode | done[] += id, frontmatter `reviewed` (solo full mode), range_progress |
| `checkpoint` | deterministic | config.run.no_commit | commit git |

`task_failed` è il funnel dei fallimenti del task: stall guard, report
inutilizzabile e tentativi esauriti convergono tutti su di lui, che decide una
volta sola — invece di triplicare la condizione nelle edge — se il task
successivo parte o il run si ferma. Il suo stato (`step: "failed"`, `error`)
è esattamente ciò che il fix plan già persiste.

### Edge (con condizione)

```
# ingresso del task (dal run-level) — tutte [advance]
next_task --(task nuovo)--> enter_task
enter_task --(always)--> implementation
resume  --(step=review)--> review                       [implementazione saltata]
resume  --(step≥cleanup)--> cleanup|learner|sync|update_done
start   --(fase esplicita)--> quella fase

# ciclo implementation ↔ review
implementation --(preHook failed al 1° tentativo)--> implementation  [pre-hook-failed, retry_count++]
implementation --(spawn failed)--> implementation                    [spawn-failed, retry_count++]
implementation --(ok)--> review                                      [advance]
review --(always)--> review_gate                                     [advance]
review_gate --(PASSED)--> cleanup                                    [passed]
review_gate --(FAILED, feedback ≠ prev)--> implementation   [failed, carry feedback, retry_count++]
review_gate --(FAILED, feedback = prev)--> task_failed      [stall-guard]
review_gate --(attemptFailed)--> implementation             [attempt-failed, retry_count++, feedback invariato]
review_gate --(reportUnusable)--> task_failed                [report-unusable]
ciclo retry  --(retry_count ≥ max_attempts)--> task_failed   [attempts-exhausted]

# coda post-review
cleanup    --(always)--> learner       [advance; mode-skip del nodo se mode=fast]
learner    --(always)--> sync          [advance; mode-skip del nodo se mode≠full && !isLast]
sync       --(always)--> update_done   [advance]
update_done --(always)--> checkpoint   [advance]
checkpoint --(always)--> next_task     [advance]

# funnel dei fallimenti
task_failed --(continue_on_failure)--> next_task    [continue-on-failure]
task_failed --(¬continue_on_failure)--> halt (run)  [halt-on-failure]
```

### Livello di run (orchestrazione, `LoopEngine.#walk`)

Serial for sui task del range: ogni task → sottografo sopra. Il pattern fisso
resta (decisione D4): la sequenza di task non si dichiara come grafo annidato.
Unica promozione: `finalSync` (con compaction dei learnings) è un nodo agentic
di run-level dichiarato nella tabella — ha spawn, persistenza e condizioni suoi
(`syncRan || !lastCompleted || stopping`) — non un metodo dell'interprete. Il
funnel dei fallimenti del task e l'halt restano orchestrazione dell'interprete.

---

## 8. Agenda della grill di Fase 0 — decisioni risolte

La grill risolve queste una alla volta, partendo dalle più strutturali. Per
ciascuna, l'analisi propone una risposta di default (da sfidare).

- **D0 — Funnel dei fallimenti (risolta in grill).** Ogni non-pass del task
  (stall guard, report inutilizzabile, tentativi esauriti) converge su un nodo
  deterministico `task_failed` con una sola edge condizionale
  (`continue_on_failure ? next_task : halt`). Scartata l'alternativa delle edge
  condizionali dirette verso halt/next_task: tre copie della stessa condizione
  da tenere sincronizzate. Il budget esaurito resta un halt run-level a parte.
- **D1 — Granularità dei nodi (risolta in grill).** Un nodo = una Fase: gli hook
  restano I/O del nodo (preHookResults in ingresso, hookOutputs in uscita), non
  nodi distinti. Due motivi: la misura di fase copre volutamente l'intero step
  (hook inclusi) come unità indivisibile, e la policy di blocco del pre-hook è
  definita al confine di Fase (primo tentativo blocca, retry lo passa come
  contesto). La promozione a nodi first-class è la Fase 2 (D8).

- **D2 — Il sub-loop review (risolta in grill).** Nodo macro: il ciclo interno
  del report resta incapsulato, il grafo vede solo il verdict (passed | failed |
  attemptFailed | reportUnusable | stopped). Motivi: il ciclo interno non ha
  diramazioni (spawn → gate → retry | verdict), il contatore `review_file_retry`
  appartiene al tentativo (reset incrociato con `retry_count` se appiattito nel
  grafo principale) e il resume da `step: "review"` riprende comunque dal
  contatore persistito. L'incapsulamento del ciclo non nasconde la
  persistenza.

- **D3 — Granularità dello stato (risolta in grill).** Lo stato centralizzato del
  fix plan resta singolo (confermato dai fonti). Le variabili in-flight del
  ciclo (`feedback`, `passed`/`skipImplementation`, `routedSuggestions`,
  `runState`) sono dichiarate nella tabella come stato di runtime del task —
  slice di lettura e payload di edge — ma restano in memoria, fuori dal fix
  plan. Conseguenza dichiarata, non accidentale: la stall guard riparte da
  zero dopo un kill+resume (il feedback non sopravvive al processo).
  Persistirle cambierebbe la semantica di resume e la Fase 0 non cambia
  comportamento.

- **D4 — Il run-level (risolta in grill).** Pattern fisso seriale: `#walk` resta
  un for esplicito, si dichiara solo il sottografo per-task. Concessione
  unica: `finalSync` + compaction è un nodo agentic di run-level dichiarato
  (ha spawn, persistenza e condizioni propri), non un metodo dell'interprete.
  Dichiarare il run-level per simmetria produrrebbe nodi che non decidono
  nulla; servirebbe solo al parallelismo, che è fuori scope per sempre.

- **D5 — Vocabolario degli edge type (risolta in grill).** Regola: un tipo esiste
  solo quando la routing decision dipende da lui. Eventi che non instradano
  (post-hook fallito, graph-missing, fallimenti non fatali di cleanup/learner/
  sync) restano notifiche o annotazioni di stato, non tipi. Quattro famiglie:
  advance; verdetto (riusa i kind del verdetto della review: passed, failed,
  attempt-failed, report-unusable); derivate (stall-guard, attempts-exhausted,
  pre-hook-failed, spawn-failed); config/ambiente (mode-skip,
  continue-on-failure, halt-on-failure, user-stop, budget-exhausted). Scartati:
  graph-missing come edge (sync gira comunque, la routing non cambia),
  fast-skip (lo skip è una coppia di edge condizionali con tipo condiviso), la
  terna generica agentic-ok/failed (collisione col vocabolario dei verdetti).

- **D6 — Dove vive il grafo dichiarato (risolta in grill).** TypeScript in-tree,
  niente typebox in Fase 0: la tabella è già validata da `tsc` a compile time,
  typebox aggiungerebbe solo costo a runtime (entra il giorno in cui la
  topologia arriva da un file esterno). Le condizioni sono **predicate nominate
  in un registry chiuso**: la tabella dichiara `when: "mode_is_fast"`,
  l'interprete risolve il nome in una funzione pura su un RoutingContext
  tipizzato. Non closure inline: renderebbero la metà condizionale invisibile
  all'ispezione e la serializzazione YAML (Fase 3) una riscrittura. Il registry
  resta piccolo per la regola D5: le condizioni instradano, non calcolano;
  chi ha bisogno di logica è un nodo, non un'edge.

- **D7 — La falla del firewall (risolta in grill).** Il contratto I/O completo per
  nodo resta Fase 1, ma la Fase 0 include la variante a costo zero: la firma di
  `buildPhasePrompt` riceve la slice (`learnings: string[]`), non il fix plan
  intero; l'estrazione avviene al confine, in chi chiama. Al termine della Fase 0
  nessuna funzione riceve più il fix plan intero per costruire un prompt. Fare
  lo schema completo in corsa mescolerebbe due refactor; lasciare la falla
  aperta mescolerebbe dichiarazione e violazione della stessa dichiarazione.

- **D8 — Nodi deterministici first-class (risolta in grill).** Test di promozione:
  solo ciò che instrada, oppure produce un output strutturato che un nodo a
  valle consuma come input. Applicato: i pre-hook di gate si promuovono in
  Fase 2 (dopo che la Fase 1 ha definito il contratto dell'output strutturato
  che sostituisce l'output grezzo troncato); la scrittura del frontmatter e il
  check graphify non si promuovono mai — non instradano e nessuno a valle
  consuma il loro output, promuoverli creerebbe nodi che non decidono nulla.
  `review_gate` e `task_failed` sono già nodi dalla Fase 0.

---

## 9. Vincoli di progetto rispettati

Riepilogo dei vincoli di `AGENTS.md` / `docs/plan.md` che l'evoluzione deve
onorare:

- **Un loop per sessione.** Non cambia: il grafo resta seriale, una sola
  esecuzione per volta (`LoopEngine.start` già lo garantisce).
- **Hot reload first.** La tabella nodi/edge è un dato costruito al primo comando,
  niente risorse avviate al caricamento.
- **Un file, una responsabilità (< ~250 righe).** L'interprete del grafo e la
  tabella vivono in moduli distinti; `TaskRunner` si snella.
- **Dipendenze runtime: solo `yaml` + `typebox`.** Nessuna nuova dipendenza per
  Fase 0–2.
- **Commenti sorgente senza riferimenti a identificativi di specifica, codici
  use-case, ecc.** Quando si implementa, il *perché* va in linguaggio naturale.
- **Guardia source-comment e divieto di citare il predecessore Go.** Nessun
  riferimento nel codice, nei commenti, nei test né nella documentazione;
  compatibilità dei formati dichiarata a parole.

---

## 10. Fonti

Le tesi di questo documento sono ancorate ai materiali del libro, interrogati via
NotebookLM (notebook SDD & Harness Engineering e AI Coding Agents). Fonti
principali richiamate:

- **LangGraph / LangChain** — *agent graphs are usually not DAGs, loops are simple
  graphs*; *a single centralized, schema-validated state object*; *each node reads
  only the specific keys required*; *conditional edges + decrementing counter for
  retries*; *checkpoint/resume via serialized state*.
- **Stripe Minions / blueprint architecture** — *blueprint = collection of agent
  skills interwoven with deterministic code*; *putting LLMs into contained boxes
  compounds into reliability*; nodi deterministici come *validation checkpoints*.
- **HumanLayer** — *sub-agents as context firewall*; *compressed return + source
  references*; *context rot / idiot zone*.
- **Addy Osmani** — timeline loop engineering → graph engineering; *graph breaks
  the cycle open, the structure between nodes becomes as important as the nodes*.
- **David Khourshid** — *a loop is just a directed, cyclic graph*.
- **Cost-vs-performance framework** — grafi seriali vincono a pass-rate < ~50%;
  parallelismo ottimale solo per task indipendenti con pass-rate > 50%.
