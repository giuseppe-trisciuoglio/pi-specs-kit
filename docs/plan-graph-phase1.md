# Piano di implementazione — Fase 1: contratti I/O per nodo (context firewall rigoroso)

Refactor puro che rende dichiarato, per ogni nodo del grafo, **cosa legge e cosa scrive**, chiudendo
le falla residue del context firewall: dopo la Fase 1 nessuna costruzione di prompt riceve il fix
plan intero o strutture di stato per comodità — solo la **vista dichiarata del nodo**. Il prompt di
ogni Fase diventa deterministico dalla topologia (la vista che le edge trasportano), non
dall'implementazione di chi lo assembla, e la costruzione del prompt diventa testabile per-nodo con
sol dati piatti, senza fabbricare un `FixPlan` fittizio.

Riferimenti: analisi in `docs/graph-engineering-evolution.md` (Fase 1 e decisioni D0–D8, non
rinegoziable), esito e risposte Q1–Q5 in `docs/plan-graph-phase0.md` §9–§10 (vincoli al pari di
D0–D8). La variante a costo zero (prompt builder che riceve `learnings` invece del piano intero) è
già in produzione dalla Fase 0; qui si generalizza il principio a tutti i canali.

> Baseline alla stesura: `npm test` 305 test passati (0 falliti), `npm run typecheck` e
> `npm run lint` verdi, albero git pulito.

**Perimetro.** Il canale nodo → esecutore di Fase → prompt builder (`PhaseExecutor.run`,
`buildPhasePrompt`) e la dichiarazione di letture/scritture nella tabella del grafo. **Non** cambia:
la struttura dello stato centralizzato né la forma di `fix_plan.json` (D3: cambia il contratto di
lettura, non lo stato), la semantica di `--resume`/`--force`, il sub-loop della review (D2), gli hook
come I/O del nodo (D1), il run-level come `for` esplicito (D4), il vocabolario delle edge (D5),
niente typebox né nuove dipendenze (D6), nessuna promozione di nodi deterministici (D8, è la Fase 2).
Le quattro anomalie di `docs/plan-graph-phase0.md` §11 restano **intoccate** (vedi §8).

---

## 1. Ricognizione: cosa legge e scrive davvero ogni nodo

Base di tutto il piano. Le righe si riferiscono al codice attuale. Convenzioni: **runtime** = stato
di runtime del task (D3, in memoria); **stato** = `plan.state` nel fix plan; **fs** = filesystem;
i canali `deps.*` (budget, stopping, signal, persist, notify, commitCheckpoint) sono meccanismo del
loop, non contesto.

Canale di uscita comune a ogni Fase: il prompt assemblato da `buildPhasePrompt`
(`src/prompt/prompt-builder.ts:126`) su `PromptContext` (`:20-40`). Oggi quel contesto lo assembla
`PhaseExecutor.run` (`src/loop/phases.ts:240-310`) leggendo, oltre agli `opts` passati dal nodo,
**tre campi dal fix plan intero**: `plan.spec_id` e `plan.state.retry_count` (identità della riga di
misura, `phases.ts:266`) e `plan.learnings` (blocco `<memory>`, `phases.ts:291`). In più l'esecutore
legge per conto della Fase: skill risolta e cachata per fase (`phases.ts:101-110`), project learnings
da fs (`:277-284`), knowledge base e override di system prompt dalla config, esiti pre-hook
(`:268-275`).

### Nodi del ciclo (`src/loop/graph/task-nodes-cycle.ts`)

| nodo | legge | scrive |
|---|---|---|
| `enter_task` (`:36-65`) | budget per-task (`:37`); `runtime.entry` (`:38`); frontmatter del task (id, title, lang) e path (`:40-49`); `specDir` (`:43`); step di partenza via `stepIndex` (`:56-58`); **fs**: report di review dei task completati + `plan.done` via `collectRoutedSuggestions` (`:63`, `src/loop/routed-suggestions.ts:30-36`) | (solo fresh) `state.current_task*`, `state.step`, retry/contatori/`error` azzerati, `state.iteration++` (`:39-49`) + persist (`:50`) + notify (`:51`); `runtime.runState.syncRan` su resume oltre sync (`:58`); `runtime.routedSuggestions` (`:63`) |
| `implementation` (`:67-102`) | stop request (`:68, :75`); `runtime.feedback` (`:73`); `state.retry_count` (lettura per la policy pre-hook `:75`, incrementi `:80, :88`); `runtime.routedSuggestions` (`:74`); `upstreamProvides` ← dipendenze del task + selezione + `plan.done` (`:72`, helper in `task-nodes-tail.ts:17-26`); **`plan` intero passato all'esecutore** (`:71` → l'esecutore ne legge `spec_id`, `retry_count`, `learnings`); signal (`:72`) | `state.step` + persist (`:69-70`); `state.retry_count++` (`:80, :88`) + persist; `runtime.implStatus` (`:82, :89, :91`); notify (`:79, :87`) |
| `review` (`:104-112`, macro D2) | stop request (`:105`); delega a `runReviewStep` (`src/loop/review-runner.ts:50-149`) che legge: `state.retry_count` (`:91`), **fs**: report canonico da archiviare/cancellare (`:91-92`), `config.run.reviewFileRetry` (`:130, :140`), `plan.learnings`/`spec_id`/`retry_count` via `executor.run` (`:94`), format error locale del sub-loop (`:63, :138`) | `state.step` + persist (`:106-107`); nel sub-loop: `state.review_file_retry` e `state.review_file_error` + persist (`:103-147`), archivio `tasks/<T>--review.attempt-N.md` e cancellazione del canonico su fs (`:91-92`); `runtime.lastVerdict` (`cycle:110`) |
| `review_gate` (`:114-139`) | `runtime.lastVerdict` (`:115`); `runtime.feedback` (stall guard, `:126-128`) | `state.review_file_error` (`:121, :127`); `runtime.feedback` (`:129`); `state.retry_count++` + persist (`:134-135`) |
| `task_failed` (`:141-152`) | `state.review_file_error` (`:142`); `config.run.maxAttempts` (`:142`); `config.run.continueOnFailure` (`:148`) | `state.error`, `state.step = "failed"` + persist (`:143-145`); notify (`:147-150`) |

### Nodi di coda (`src/loop/graph/task-nodes-tail.ts`)

| nodo | legge | scrive |
|---|---|---|
| `cleanup` (`:64-77`) | stop request; `state.retry_count` (policy pre-hook `:70`); `upstreamProvides` (`:69`); `runtime.routedSuggestions` (`:70`); **`plan` intero all'esecutore** (`:68`); signal | `state.step` + persist (`:66-67`); notify su fallimento non fatale (`:76`) |
| `learner` (`:79-103`) | stop request; task (solo id e title: `buildLearnerPrompt`, `phases.ts:66-77`); signal | `state.step` + persist (`:81-82`); `plan.learnings` (merge) + persist (`:92-93`); **fs**: project learnings letti e riscritti best-effort (`:95-99`) |
| `sync` (`:105-120`) | stop request; `state.retry_count` (policy pre-hook `:113`); `upstreamProvides` e `runtime.routedSuggestions` (`:112-113`); **fs**: esistenza di `graphify-out/graph.json` via `checkGraphForSync` (`:109`, `:34-46`, `src/prompt/graphify.ts`); **`plan` intero all'esecutore** (`:110`); signal | `state.step` + persist (`:107-108`); `state.graphPartialSync` + persist + warning (`tail:40-44`); `runtime.runState.syncRan` (`:116`); notify |
| `update_done` (`:122-145`) | `plan.done` (`:124`); `plan.pending` (`:125`); `config.mode` (`:127`); `deps.now` (`:128`); `plan.tasks` (`:133`); path del task file | `state.step` (`:123`); `plan.done`/`plan.pending`/`plan.range_progress` (`:124-126`); **fs**: frontmatter `reviewed` + date (solo full mode, `:129-139`); `plan.tasks[].status` (`:133`); `runtime.runState.lastCompleted` (`:140`); persist (`:141`) |
| `checkpoint` (`:147-160`) | `config.run.noCommit` (`:148`); `state.retry_count` (messaggio commit, `:149`) | **git**: commit di checkpoint (`:149`); notify (`:152-159`) |

### Nodo run-level (`src/loop/graph/run-graph.ts`)

| nodo | legge | scrive |
|---|---|---|
| `final_sync` (guardia `:79-95`, azione `:39-72`) | guardia: `runState.syncRan`/`lastCompleted`/stopping (`conditions.ts:74-75`); azione: `runState.lastCompleted` (`:44`); grafo graphify + `state.graphPartialSync` (`:49`); **`plan` intero all'esecutore, senza upstream né routed** (`:51`); **fs**: project learnings per la compaction (`:55-66`); signal | `runState.syncRan` (`:45`); `state.step` + persist (`:46-47`); `state.graphPartialSync` eventuale; **fs**: project learnings compattati (`:61-63`); notify |

Confronto con la tabella nodi/edge della Fase 0 (`docs/plan-graph-phase0.md` §4.1): la ricognizione
conferma le letture lì dichiarate e aggiunge i dettagli emersi dal codice (policy pre-hook da
`retry_count`, `graphPartialSync`, `lastCompleted`, fs dei project learnings). Nessuna contraddizione.

## 2. Contraddizioni col documento di analisi

Punti in cui il codice reale (`docs/graph-engineering-evolution.md` §4, Fase 1) dice altro. Il piano
segue il codice.

1. **«il nodo implementation produce `{ modifiedFiles, hookOutputs }`»** — non esiste alcun tracciamento dei file modificati in questo codebase. L'output reale della Fase è `{ preHooksOk, hookResults, outcome }` (`phases.ts:33-37`, spawn outcome incluso); gli output degli hook, quando non bloccano, fluiscono **in ingresso** al prompt successivo, non in uscita dal nodo. Il contratto di output della Fase 1 dichiara la forma reale (questione Q1 in §9).
2. **«il nodo review produce `{ verdict, feedback }`»** — il feedback lo produce il `review_gate` dal verdetto (`task-nodes-cycle.ts:129`), non il nodo review: la macro produce solo il verdetto (D2). La separazione è già dichiarata nel grafo; il contratto di Fase 1 la rispetta.
3. **«smettere di passare il fix plan intero a `buildPhasePrompt`»** — già chiuso in Fase 0 (D7). La falla residua è a monte: `PhaseExecutor.run` riceve il fix plan intero da **cinque** call site (`task-nodes-cycle.ts:71`, `task-nodes-tail.ts:68,110`, `run-graph.ts:51`, `review-runner.ts:94`) ed estrae da solo le slice. È questa la falla che la Fase 1 chiude.
4. **La vista dell'analisi include `projectLearnings` tra le letture del nodo** — vero a livello di effetto (finiscono nel prompt), ma la lettura fs la fa l'esecutore a ogni spawn (`phases.ts:277-284`), non il nodo. Il contratto la dichiara come ingresso fornito dall'esecutore; spostarla al confine del nodo è una questione aperta (Q2 in §9), non una scelta presa qui.

## 3. Dove il firewall perde ancora

### Falla reali (il nodo riceve più di quel che gli serve, o dati arrivano per effetto collaterale)

1. **`PhaseExecutor.run(phase, task, plan, opts)` riceve il fix plan intero** e ne legge tre campi. Conseguenza: qualunque campo futuro del piano può finire in un prompt senza toccare la tabella del grafo né i nodi — la falla è strutturale, non un uso scorretto. Cinque call site (§2.3).
2. **`runReviewStep(deps, plan, taskFile)`** riceve il piano intero. In parte inevitabile: i contatori `review_file_retry`/`review_file_error` sono stato centralizzato (D3) e il persist scrive il documento intero. Ma il **canale prompt** (learnings, identità di misura) passa dallo stesso parametro: si restringe con il contratto, lo stato resta.
3. **`TaskNodeEnv` chiude `plan` + `selected` per ogni nodo** (`types.ts:162-167`): ogni azione può leggere l'intero piano per costruzione, e la lettura è invisibile alla tabella. Oggi nessun nodo ne abusa (ogni estrazione è slice: `plan.learnings`, `plan.done`, `upstreamProvides`), quindi il firewall è **convenzione**, non vincolo. La Fase 1 rende il canale executor invalicabile (il tipo non ammette il piano) e dichiara le letture residue come dati (§4.5); il narrowing completo dell'env è questione Q3.
4. **Project learnings letti dall'esecutore a ogni spawn** (`phases.ts:277-284`): lettura fs non dichiarata dal nodo, ripetuta a ogni re-spawn del sub-loop review. Contenuto identico nella pratica (il file cambia solo nei nodi learner/sync, seriali), ma è un ingresso al prompt fuori dal contratto del nodo (Q2).
5. **Identità di misura letta dal piano dall'esecutore** (`phases.ts:266`): `spec_id` e `retry_count` attraversano il confine nodo→esecutore come effetto collaterale del piano intero e finiscono nel registro delle misure. Entra nel contratto come campo dichiarato.

### Sospetti verificati (non sono falla)

- **`PromptContext.config` riceve la config intera** (`prompt-builder.ts:21`): config immutabile per tutta la durata del run; il builder legge quattro campi (`skillContent`, `knowledgeBase.files`, `projectRoot`, `run.reconcileContext`). Ambiente dichiarato, non contesto volatile.
- **`preHookResults` nel prompt**: canale dichiarato per decisione D1 (hook = I/O del nodo).
- **`formatError` locale nel sub-loop review** (`review-runner.ts:63,138`): già canale esplicito per re-spawn, passa parola per parola nel contratto.
- **`learnings` letti al momento dello spawn**: prima li leggeva l'esecutore dentro `run()`, dopo il nodo al confine — stesso istante logico (chiamata sincrona), e `plan.learnings` muta solo nel nodo learner, seriale. Nessuna corsa.
- **`deps.*` e budget in ogni nodo**: meccanismo del loop, non dati di contesto; dichiarati come canale di dipendenza.

## 4. Design dei contratti

Principio guida (da D6/D7, generalizzato): **la dichiarazione è un tipo TypeScript, la validazione è
il compilatore, l'estrazione avviene al confine in chi chiama**. Niente schema a runtime, niente
typebox, nessuna nuova dipendenza.

### 4.1 Scelte prese (P1–P6)

- **P1 — Dove vive il contratto.** Nuovo modulo `src/loop/phase-inputs.ts` (~70 righe, soli import
  di tipo): i tipi di ingresso per Fase. Non sta in `graph/` perché lo consuma anche il sub-loop
  review (`review-runner.ts`), che è fuori dal grafo per D2; non sta in `phases.ts` perché i test
  devono importarlo senza trascinarsi l'esecutore.
- **P2 — Chi costruisce la vista.** Il nodo stesso, con un literal inline al confine (stesso gesto
  dell'estrazione `plan.learnings` fatta in Fase 0 in `phases.ts:291`). Nessun builder intermedio:
  il valore aggiunto è il tipo e il punto unico di estrazione, non una funzione in più.
- **P3 — Il compilatore fa rispettare il contratto** tramite overload di `PhaseExecutor.run`
  indicizzati per Fase: `run("implementation", input: ImplementationPhaseInput)`, ecc. Un literal
  con campi extra o mancanti non compila (excess property check); la review non può ricevere
  `routedSuggestions`, l'implementation non può dimenticare `reviewFeedback`.
- **P4 — I nodi dichiarano fatti, l'esecutore possiede la policy.** Il flag
  `blockOnPreHookFailure: retry_count === 0` diventa `firstAttempt: boolean` nel contratto; è
  l'esecutore a mapparlo nella policy di blocco (`blockOnPreHookFailure = firstAttempt`). Il nodo
  non dichiara *cosa fare* ma *com'è il mondo*.
- **P5 — Le due sync restano distinte** come da resa fedele della Fase 0: `SyncPhaseInput` è unione
  di `TaskSyncPhaseInput` (con `upstreamProvides`, `routedSuggestions`, `firstAttempt`) e
  `FinalSyncPhaseInput` (solo campi base) — il nodo run-level non può dichiarare contratti a monte
  che non riceve.
- **P6 — Letture/scritture come dati nella tabella.** `TaskNode` guadagna `reads`/`writes` opzionali
  (array di nomi di canale da un vocabolario chiuso) in `NODE_DECLARATIONS`
  (`task-graph.ts:16-31`): rendono l'I/O di **tutti** i nodi — deterministici compresi —
  ispezionabile come dato (e riutilizzabili se la Fase 3 esternalizzerà la tabella). Limitazione
  dichiarata: il compilatore non ne verifica la verità; per i nodi agentic la dichiarazione esaustiva
  e verificata resta il tipo di §4.2.

### 4.2 I tipi di ingresso per Fase

```ts
// src/loop/phase-inputs.ts — types only, no runtime imports
/** Identity of the measurement ledger row: which spec, which attempt. */
export interface PhaseMeterId { specId: string; attempt: number; }

/** What every phase spawn receives: the task, its memory and the run knobs. */
export interface PhaseSpawnInput extends PhaseMeterId {
  task: TaskFile;
  /** Loop learnings for this spec, injected as task memory. */
  learnings: string[];
  signal?: AbortSignal;
}

export interface ImplementationPhaseInput extends PhaseSpawnInput {
  /** Verbatim feedback from a failed review, null on the first attempt. */
  reviewFeedback: string | null;
  /** Public API contracts from completed dependency tasks. */
  upstreamProvides: string[];
  /** Fixes earlier reviews routed to this task. */
  routedSuggestions: RoutedSuggestion[];
  /** Drives the pre-hook policy: first attempt blocks, retries feed context. */
  firstAttempt: boolean;
}

export interface ReviewPhaseInput extends PhaseSpawnInput {
  /** Why the previous report was rejected, null on the first spawn. */
  reviewFormatError: string | null;
}

export interface CleanupPhaseInput extends PhaseSpawnInput {
  upstreamProvides: string[];
  routedSuggestions: RoutedSuggestion[];
  firstAttempt: boolean;
}

export interface TaskSyncPhaseInput extends PhaseSpawnInput {
  upstreamProvides: string[];
  routedSuggestions: RoutedSuggestion[];
  firstAttempt: boolean;
}

/** The end-of-range sync spawns alone: no upstream contracts, no routed fixes. */
export type FinalSyncPhaseInput = PhaseSpawnInput;
export type SyncPhaseInput = TaskSyncPhaseInput | FinalSyncPhaseInput;
```

Firme dell'esecutore (`phases.ts`):

```ts
run(phase: "implementation", input: ImplementationPhaseInput): Promise<PhaseStepResult>;
run(phase: "review", input: ReviewPhaseInput): Promise<PhaseStepResult>;
run(phase: "cleanup", input: CleanupPhaseInput): Promise<PhaseStepResult>;
run(phase: "sync", input: SyncPhaseInput): Promise<PhaseStepResult>;
```

Il corpo unico normalizza (`"reviewFeedback" in input ? … : null`, `firstAttempt ?? true`) e
costruisce il `PromptContext` esattamente come oggi: stessi valori, stessa origine, canale dichiarato.
`runLearner` e `compactLearnings` sono già a slice e non cambiano. L'output resta `PhaseStepResult`
(§2.1): il contratto di Fase 1 è sul **ingresso**; il contratto di output strutturato è materia Fase 2
(D8).

Dopo il taglio: `grep -n "FixPlan" src/loop/phases.ts` non trova nulla — il fix plan non attraversa
più il confine nodo→esecutore, quindi non può raggiungere la costruzione del prompt per alcuna via
tipata. `buildPhasePrompt` e `PromptContext` **non cambiano** (già a slice dalla Fase 0).

### 4.3 Le viste al confine (come cambiano i call site)

Esempio, nodo implementation (`task-nodes-cycle.ts:71-77`):

```ts
const impl = await executor.run("implementation", {
  task: taskFile,
  learnings: plan.learnings,                      // extraction at the boundary
  reviewFeedback: io.runtime.feedback,            // payload of the failed back-edge
  upstreamProvides: upstreamProvides(taskFile, selected, plan.done),
  routedSuggestions: io.runtime.routedSuggestions,
  firstAttempt: state.retry_count === 0,
  specId: plan.spec_id,
  attempt: state.retry_count + 1,                 // ledger identity, now declared
  signal: deps.signal(),
});
```

Gli altri call site seguono lo stesso gesto: cleanup e sync per-task (stessi campi senza feedback),
`final_sync` (solo campi base, come oggi), review nel sub-loop (`reviewFormatError: formatError`
locale + campi base). Il sub-loop review continua a ricevere il piano per i **contatori di stato**
(D3, §3.2): il contratto restringe il suo canale prompt, non il canale stato.

### 4.4 Cosa non cambia

`PromptContext` e `buildPhasePrompt` (prompt byte per byte identici), `NodeIO`/`NodeAction`
(`types.ts:135-138`), l'interprete, le predicate, la tabella delle edge, il fix plan, i persist, le
notifiche, i check di stop (con le asimmetrie congelate da Q3 della Fase 0), il registro delle misure
(campi e conteggio righe).

### 4.5 Letture/scritture dichiarate nella tabella

`TaskNode` (`types.ts:173`) guadagna `readonly reads?: readonly string[]` e `readonly writes?:
readonly string[]`; `NODE_DECLARATIONS` viene annotata con i nomi di canale della §1, da un
vocabolario chiuso (es. `state.retry_count`, `plan.learnings`, `plan.done`, `runtime.feedback`,
`runtime.routedSuggestions`, `runtime.runState.*`, `fs.reviewReports`, `fs.projectLearnings`,
`fs.taskFrontmatter`, `fs.graph`, `git.commit`, `config.mode`, `config.run.*`, `notify`, `persist`).
Test strutturale in `test/graph-table.test.ts`: ogni nodo non-sink (escluso il marcatore di start)
dichiara letture e scritture non vuote e ogni voce appartiene al vocabolario.

## 5. Impatto sulla costruzione dei prompt

- **Chi chiama il builder non cambia** (`buildPhasePrompt` resta chiamato solo da
  `PhaseExecutor.run`); cambia **cosa** l'esecutore può leggere per costruire il contesto: solo i
  campi dichiarati dell'input + i canali executor-supplied (skill, hook, project learnings, config).
- **Il prompt diventa funzione della topologia**: ogni blocco del prompt corrisponde a un campo del
  contratto trasportato da un'edge (`reviewFeedback` è il payload del back-edge `failed`, i
  `routedSuggestions` li raccoglie `enter_task`, i contratti a monte derivano da `plan.done`).
  Un'edge mancante ora è un campo mancante nel tipo: il nodo a valle agisce alla cieca **per
  costrizione dichiarata**, non per omissione silenziosa.
- **Testabilità per-nodo**: costruire l'ingresso di una Fase diventa un literal piatto (niente
  `FixPlan` con `state`/`iteration`/`range_progress` fittizi). I test d'equivalenza di §7 lo
  dimostrano per tutte e quattro le Fasi.
- **Residui dichiarati**: project learnings e skill restano letti dall'esecutore (Q2); la config è
  ambiente; i contatori di stato restano nel canale piano (D3, Q3).

## 6. Sequenza di step

Ogni step lascia i tre gate verdi (`npm test`, `npm run typecheck`, `npm run lint`). Protocollo di
fallback comune: se uno step non passa, revert dello step; la causa più probabile è un campo
dimenticato o un default `null`/`undefined` invertito nella normalizzazione (§4.2); confrontare con
la mappa di §1 e con il test d'equivalenza fallito.

**Step 0 — Baseline e branch.**
Cosa: verificare i tre gate (305 test attesi), `git status` pulito, creare il branch.
Verifica: tre gate verdi; nessuna differenza nell'albero.

**Step 1 — Caratterizzazione: prompt d'oro per equivalenza (prima del taglio).**
Cosa: nuovo `test/phase-prompts.test.ts` con l'esecutore **reale** e `spawnPhase`/`runHooks` finti
che catturano il prompt. Per ogni Fase uno scenario rappresentativo (implementation con feedback,
upstream e routed su retry; review con e senza format error; cleanup; sync) e un'asserzione di
**uguaglianza stringa** tra il prompt catturato e `buildPhasePrompt` applicato a un `PromptContext`
costruito nel test dagli stessi valori dichiarati + `resolvePhaseSkill(phase)` + project learnings
caricati nel test: skill e path dipendenti dalla macchina si elidono perché entrambi i lati li
risolvono nello stesso run. Pinna anche i negativi: prompt di cleanup/sync senza `<review_feedback>`,
prompt di review senza `<routed_suggestions>`.
Perché primo: scrivere l'oracolo sul codice attuale, prima che il refactor muova la mappa
input→prompt (scritto dopo, userebbe il codice nuovo come oracolo di sé stesso).
Verifica: nuovi test verdi sul codice attuale + tre gate. Se fallisce: la mappa non è quella
dichiarata in §1 — correggere il test, non il codice.

**Step 2 — Il modulo dei contratti.**
Cosa: creare `src/loop/phase-inputs.ts` (§4.2). Nessun uso, nessun comportamento.
Verifica: tre gate; file sotto ~100 righe; nessun import di valore (solo tipi) — importabile dai
test senza pacchetti pi.

**Step 3 — Il taglio dell'esecutore.**
Cosa: overload di `PhaseExecutor.run` + corpo che legge solo l'input dichiarato; rimozione
dell'import di `FixPlan` da `phases.ts`; aggiornamento dei cinque call site (§4.3); aggiornamento
meccanico dei due stub executor in `test/review-runner.test.ts` (`:60-75`, `:156`) e della
costruzione degli input in `test/phase-prompts.test.ts` (le stringhe d'equivalenza restano identiche:
cambia solo come si costruisce l'ingresso).
Verifica: tre gate; `grep -n "FixPlan" src/loop/phases.ts` senza riscontri; e2e verde con le 10 righe
del registro delle misure (spawn persi/duplicati si vedrebbero); suite state-machine intatta.
Raccomandato in questo step: aggiungere un'asserzione (e2e o state-machine) che pinni il campo
`attempt` di una riga di retry del registro (es. attempt 2 alla seconda implementation) — l'identità
di misura ora è dichiarata dal nodo e un valore sbagliato non toccherebbe i prompt (vedi §7 rischi).
Se fallisce: quasi sempre la normalizzazione dei campi assenti (`reviewFeedback` per cleanup/sync,
`firstAttempt` per final sync).

**Step 4 — Nodo per nodo, senza strutture fittizie.**
Cosa: estendere `test/phase-prompts.test.ts` con i casi per-nodo che prima non erano costruibili
senza un `FixPlan`: prima implementation (feedback null, nessun blocco `<review_feedback>`), retry
(feedback presente), pre-hook fallito con `firstAttempt: true` (Fase bloccata, nessuno spawn) vs
`firstAttempt: false` (output hook nel prompt `<hooks>`), final sync (nessun contratto a monte).
Questi test valgono anche da documentazione esecutiva dei contratti.
Verifica: tre gate; ogni test costruisce solo literal del tipo di §4.2.

**Step 5 — Letture/scritture dichiarate nella tabella.**
Cosa: `reads`/`writes` in `TaskNode` + annotazione di `NODE_DECLARATIONS` con i canali di §1 +
estensione di `test/graph-table.test.ts` (presenza per ogni nodo non-sink, vocabolario chiuso).
Perché dopo il taglio: i metadati devono descrivere il codice già contrattualizzato, non guidarlo.
Verifica: tre gate; il test strutturale rosso se una voce esce dal vocabolario.

**Step 6 — Pulizia e documentazione.**
Cosa: import morti, dimensioni file (< ~250), commenti in inglese senza riferimenti a identificativi
di specifica o sezioni numerate di documenti; aggiornamento dell'albero moduli in `docs/plan.md` (§2),
dello stato della Fase 1 in `docs/graph-engineering-evolution.md`, e ADR nuovo che registra le scelte
P1–P6 e le questioni rimaste aperte (Q1–Q5 di §9).
Verifica: tre gate + rilettura della documentazione aggiornata.

## 7. Strategia di test: come si dimostra che i prompt non sono cambiati

- **La suite esistente è l'oracolo di contenuto e non si tocca** (305 test; unica eccezione meccanica
  i due stub di `review-runner.test.ts`, che implementano l'esecutore finto e devono seguirne la
  firma). In particolare: `test/prompt-builder.test.ts` penna i blocchi e i loro contenuti,
  `test/state-machine.test.ts` penna i prompt via spawn finti (es. "rejected review feeds back into
  the next implementation prompt"), l'e2e penna il loop completo.
- **L'equivalenza executor↔builder è la prova nuova**: gli assertion d'uguaglianza stringa dello
  Step 1 vengono scritti **sul codice attuale** e sopravvivono al taglio dello Step 3 senza modifiche
  di contenuto. Dimostrano che la mappa input→prompt è esattamente quella dichiarata, prima e dopo.
  Se il refactor cambiasse silenziosamente un prompt, l'uguaglianza (o i test del builder) rompe.
- **Il registro delle misure resta ancorato**: le 10 righe dell'e2e pinnano numero e tipo degli
  spawn; l'asserzione aggiuntiva sull'`attempt` (Step 3) copre il campo la cui origine si sposta dal
  piano al contratto.
- **Cosa diventa testabile che prima non lo era**: il prompt di ogni Fase da un literal piatto
  (Step 4), la policy pre-hook guidata dal fatto dichiarato `firstAttempt`, l'impossibilità tipata
  di passare campi extra ai literal di ingresso (excess property check del compilatore).

## 8. Rischi

1. **Cambiamento silenzioso del contenuto di un prompt** (il rischio principale: invisibile ai test
   che non lo pinnano). Vie più probabili: normalizzazione dei campi assenti (`reviewFeedback` per
   cleanup/sync deve restare `null`, `firstAttempt` del final sync deve bloccare come oggi), default
   `null` vs `undefined` nei blocchi condizionali. Mitigazione: `buildPhasePrompt` non viene toccato,
   equivalenza d'oro dello Step 1 scritta prima, negativi pinnati (cleanup/sync senza feedback).
2. **Identità di misura dichiarata male** (`specId`/`attempt`): non tocca i prompt, quindi l'oracolo
   dei prompt non la vede; righe di registro sbagliate. Mitigazione: asserzione sull'`attempt` nei
   retry (Step 3) + le 10 righe e2e.
3. **Erosione degli overload**: l'excess property check protegge solo i literal; un oggetto wider
   passato con spread lo aggira. Mitigazione: i call site sono cinque e tutti literal (convention da
   far rispettare in review); il canale `plan` non esiste più nella firma, quindi anche uno spread
   non può trasportare il piano.
4. **Deriva dei metadati `reads`/`writes`**: nessun compilatore ne verifica la verità; possono
   mentire. Mitigazione dichiarata (P6): vocabolario chiuso + test strutturale + la verità per i
   nodi agentic è nel tipo; se in review emergono discrepanze, correggere i metadati, mai il codice,
   in questa Fase.
5. **Cerimonia aggirata in futuro**: nulla vieta tecnicamente di rimettere un parametro largo
   nell'esecutore. Mitigazione: il criterio `grep "FixPlan" src/loop/phases.ts` (vuoto) come hook di
   review + ADR che registra il principio.
6. **Anomalie note di Fase 0 (§11), intoccate per esplicito vincolo**: il resume oltre la sync che la
   marca eseguita senza eseguirla (pinnata da test), l'asimmetria dei check di stop fra sync e
   update_done, la edge catch-all d'ingresso senza test dedicato, `engine.ts` oltre la soglia righe.
   Nessuno step le modifica; se un test nuovo le illuminasse, caratterizzare e riportare, non
   correggere.

## 9. Questioni da riportare all'architect

1. **Q1 — L'output `modifiedFiles` dell'analisi non esiste.** Nessun file-change detector è stato
   portato: l'output reale della Fase è `{ preHooksOk, hookResults, outcome }` (`phases.ts:33-37`) e
   gli output degli hook alimentano il prompt in ingresso. Introdurre `modifiedFiles` come output
   dichiarato è nuovo comportamento (famiglia del contratto di output strutturato, Fase 2 per D8):
   decidere se e quando, non in questa Fase.
2. **Q2 — Project learnings: lettura dell'esecutore o del nodo?** Oggi li carica l'esecutore a ogni
   spawn (`phases.ts:277-284`), anche nei re-spawn del sub-loop review; l'analisi li elenca tra le
   letture del nodo. Spostare la lettura al confine del nodo cambierebbe la semantica di ricarica
   nei re-spawn (il file può mutare solo nei nodi learner/sync, seriali: oggi irrilevante in
   pratica). Il piano li dichiara ingresso executor-supplied; confermare o chiedere l'hoisting.
3. **Q3 — Narrowing del canale stato.** `runReviewStep` e `TaskNodeEnv` mantengono l'accesso al piano
   intero per i contatori e le scritture di stato centralizzato (D3: `types.ts:162-167`,
   `review-runner.ts:78-147`). Il rigore tipato di Fase 1 copre il canale prompt; restringere anche
   lo stato (slice tipizzate per nodo) è fattibile ma moltiplica i tipi a beneficio quasi solo
   documentale. Decidere se è voluto.
4. **Q4 — Metadati `reads`/`writes` non verificabili dal compilatore**: accettarli come dati
   ispezionabili con vocabolario chiuso e test strutturale (la proposta di questo piano), oppure
   dropparli e tenere la dichiarazione solo dove il compilatore la fa rispettare (i tipi di Fase)?
5. **Q5 — Copertura della edge catch-all d'ingresso.** Restano scoperte solo indirettamente
   (anomalia 3 di §11): confermare che anche un test dedicato resti fuori dal perimetro di Fase 1
   (è un gap di test della Fase 0, non un contratto I/O).

---

## 10. Risposte dell'architect (decisioni chiuse)

Valgono come vincoli al pari di D0–D8 e delle risposte di Fase 0: chi implementa non le rinegozia.

- **Q1 → nessun tracciamento dei file modificati.** Il contratto di Fase 1 è sull'**ingresso**;
  l'output resta quello reale di oggi. Introdurre un output che il codice non produce sarebbe
  comportamento nuovo travestito da refactor. Se servirà, è materia del contratto di output
  strutturato, cioè Fase 2.
- **Q2 → i project learnings restano una lettura dell'esecutore.** Spostarli al confine del nodo
  cambierebbe quando il file viene riletto nei re-spawn: oggi irrilevante in pratica, ma è un
  cambiamento di semantica dentro un refactor puro. Si dichiarano come ingresso fornito
  dall'esecutore, insieme a skill e configurazione.
- **Q3 → nessun narrowing del canale di stato.** La Fase 1 chiude il canale del prompt e basta. Lo
  stato centralizzato resta accessibile com'è: restringerlo moltiplicherebbe i tipi per un beneficio
  quasi solo documentale, e lo stato singolo è una scelta voluta, non una concessione.
- **Q4 → i metadati `reads`/`writes` non si fanno.** È la riduzione di perimetro: nessun consumatore
  li legge, nessun compilatore ne verifica la verità, e una dichiarazione che può mentire senza che
  niente se ne accorga invecchia peggio del silenzio. Vale qui la stessa regola che governa il
  vocabolario delle edge: una dichiarazione esiste quando qualcosa dipende da lei. La dichiarazione
  di Fase 1 resta dove il compilatore la fa rispettare, cioè i tipi di ingresso per Fase. **Lo Step 5
  esce dal piano**; la ricognizione di §1 resta come documentazione, che è il suo valore vero.
- **Q5 → confermato fuori perimetro.** Il test dedicato alla edge catch-all è un gap di copertura
  della Fase 0, non un contratto I/O: resta nell'elenco di ciò che è rimasto fuori, da fare quando si
  affrontano le anomalie note.

**Perimetro finale**: Step 0, 1, 2, 3, 4 e 6 del §6 (rinumerato 0–5), senza lo Step 5 originale.
