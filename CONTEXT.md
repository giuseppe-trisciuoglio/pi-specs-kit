# pi-specs-kit

Estensione di pi che reimplementa in TypeScript il loop di esecuzione task di specs-kit (state machine implementation → review → cleanup → sync), orchestrando sottoprocessi `pi` dalla sessione pi interattiva.

## Language

**Loop**:
Il ciclo di esecuzione automatica dei task di una spec: per ogni task, le fasi in sequenza, con retry e persistenza dello stato tra un'esecuzione e l'altra.
_Avoid_: ralph loop, state machine (nome tecnico interno)

**Fase**:
Uno dei quattro passi eseguiti per un task: implementation, review, cleanup, sync. Ogni fase è un sottoprocesso agente con contesto fresco.
_Avoid_: step, stage

**Task**:
Unità di lavoro di una spec, descritta da un file markdown con frontmatter nella directory `tasks/` della spec.
_Avoid_: todo, job

**Spec**:
Directory sotto `docs/specs/` (es. `034-mes-listing-fasi-reparto`) che contiene specifica funzionale, piano tecnico, task e stato del loop.
_Avoid_: feature, specifica (generico)

**Spec attiva**:
La spec su cui i comandi operano di default quando non è indicata esplicitamente; l'unica persistita nel campo `spec:` di `specs-kit.yaml`. La creazione di una nuova spec la imposta automaticamente.
_Avoid_: spec corrente, default spec

**Fix plan**:
File `_ralph_loop/fix_plan.json` dentro la spec: single source of truth dello stato del loop (task done/pending, fase corrente, retry, learnings). Shape condivisa con il CLI Go.
_Avoid_: state file, progress file

**Agente**:
Il CLI che esegue una fase in sottoprocesso: sempre e solo `pi`. I ruoli differiscono solo per modello e thinking level configurati.
_Avoid_: LLM, provider, tool, codex

**Ruolo**:
Funzione svolta da un agente nel loop: agent (implementation), reviewer (review), cleaner (cleanup), synchronizer (sync), learner (estrazione learnings). Ogni ruolo ha modello e thinking level propri, configurabili da `specs-kit.yaml` o dalla TUI di pi.
_Avoid_: persona, worker

**Skill di fase**:
Documento di istruzioni iniettato nel prompt di una fase (specs-kit-task-implementation, specs-kit-task-review, specs-kit-code-cleanup, specs-kit-sync), risolto dal fork bundled nell'estensione.
_Avoid_: prompt template

**Hook**:
Comando shell eseguito prima (pre) o dopo (post) una fase; un pre-hook fallito blocca la fase, un post-hook fallito no.
_Avoid_: guard, script

**Learner**:
Ruolo agente che a fine task estrae learnings e li salva nel fix plan; i learnings sono iniettati come memory nei prompt dei task successivi.
_Avoid_: memory (è il dato, non il ruolo)

**Riconciliazione del contesto**:
Estensione opt-in del mandato della fase sync: quando `run.reconcile_context` è attivo e ci sono learnings consolidati, sync corregge la singola istruzione contraddetta in un documento sorgente (AGENTS.md, architecture.md, ontology.md, .pi/rules) e riporta ogni correzione nel suo summary. Di default i documenti autorevoli non vengono modificati dal loop.
_Avoid_: self-heal / heal (già usato per il ciclo implementation↔review), auto-fix

**graphify**:
Skill esterna che indicizza il codebase nel grafo della conoscenza `graphify-out/graph.json`. È la sola fonte del grafo del codebase: ogni fase lo legge direttamente, non esiste un file per-spec proiettato. Non è inclusa in questa estensione: va installata a parte (`~/.agents/skills/graphify` o `~/.pi/agent/skills/graphify`). L'estensione avverte all'avvio del loop se non la trova; la fase sync la rinfresca (`/graphify --update`) prima di consumarla.
_Avoid_: codebase indexer, KG builder, grafo del codice

**Knowledge Graph (KG)**:
Il grafo della conoscenza del codebase, prodotto da graphify in `graphify-out/graph.json` a livello di progetto. È la sola mappa del codebase e l'unico file di grafo: non esiste un `knowledge-graph.json` per-spec proiettato. La fase sync lo rinfresca (`/graphify --update`); la validazione tecnica dei task e la generazione dei task lo leggono direttamente. Senza graphify è assente e la validazione tecnica salta.
_Avoid_: knowledge-graph.json, proiezione, KG per-spec

**Sync parziale**:
Esito di una fase sync eseguita senza il Knowledge Graph (graphify assente o grafo non materializzato): il sync completa i suoi doveri documentali, ma la validazione delle dipendenze basata sul grafo salta. Il loop lo marca nel `state.graphPartialSync` del fix plan e lo segnala nel riepilogo finale, invece di degradare in silenzio.
_Avoid_: sync fallito, sync degradato

**Suggerimento routed**:
Fix che un reviewer rinvia a un task successivo invece che a quello appena recensito: vive nel frontmatter del report di review come voce `{ to, text }` sotto `routed`, e il loop lo inietta nel prompt di implementazione del task di destinazione come blocco `<routed_suggestions>`. Evita che un handoff tra task venga perso perché sepolto nel prosa di una review precedente.
_Avoid_: deferred suggestion, handoff testuale

**Verdetto della review**:
L'esito strutturato che la fase review proietta al loop alla fine del suo sub-ciclo: passed, failed (con feedback), attemptFailed, reportUnusable o stopped. Vive nel frontmatter del report; il loop ne instrada le transizioni del task.
_Avoid_: esito review, report (è il file, non l'esito)

**Archivio delle review per tentativo**:
Copia del report di review precedente, salvata come `tasks/<TASK>--review.attempt-N.md` prima che un retry sovrascriva il report canonico `<TASK>--review.md`. Preserva la cronologia dei verdetti (anche FAILED) per audit e debug; il file canonico resta sempre l'ultimo verdetto.
_Avoid_: review backup, snapshot di review

**Knowledge base**:
Lista di file di contesto (da `specs-kit.yaml`) iniettata nel prompt di ogni fase.
_Avoid_: context files, KB generico

**Reference documents**:
Lista di path di documenti aggiuntivi (`reference_documents.files` in `specs-kit.yaml`) iniettata nel prompt di ogni fase, prima dei file knowledge base, nello stesso blocco `<knowledge_base>`. I file mancanti vengono omessi in silenzio.
_Avoid_: context files, extra docs

**Trascrizione**:
La resa leggibile di ciò che l'agente sta facendo nella fase in corso, renderizzata come nella sessione interattiva. Si apre e si chiude senza toccare il loop, che prosegue indipendentemente.
_Avoid_: stream view, attach view, log, output

**Registro delle misure**:
File append-only accanto alle spec, versionato col progetto, in cui confluiscono le misure di consumo e durata: una riga per fase del loop e una per finestra di authoring. Non è stato del loop: perderlo non impedisce di ripartire.
_Avoid_: metriche (generico), log

**Finestra di authoring**:
Intervallo della sessione interattiva attribuito alla creazione di una spec: si apre con un comando di authoring e si chiude al comando specs-kit successivo o alla chiusura della sessione. La prima finestra viene attribuita alla spec retroattivamente, quando la spec diventa attiva.
_Avoid_: sessione, turno

**Costo del loop**:
Token consumati e spesa dei sottoprocessi agente che il loop esegue per una spec: tutte le fasi di tutti i task, retry compresi. È un totale per spec, non per fase né per task.
_Avoid_: token di implementazione, costo della fase implementation

**Durata del loop**:
Somma delle durate delle esecuzioni del loop su una spec, hook e checkpoint inclusi. Le pause tra un'esecuzione e la successiva non contano.
_Avoid_: tempo di implementazione, wall clock

**Fast mode**:
Modalità del loop che salta cleanup e la scrittura del frontmatter `reviewed`, e sincronizza solo l'ultimo task del range. I task completati restano comunque registrati come done e il checkpoint git viene creato.
_Avoid_: quick mode

**Grafo dichiarato**:
La topologia del loop espressa come dato — nodi, edge e condizioni — separata dal piccolo interprete che la esegue. Il loop l'ha sempre eseguita; dichiararla la rende ispezionabile e testabile.
_Avoid_: state machine, pipeline cablata, grafo implicito

**Nodo**:
Unità del grafo dichiarato, di due generi: agentic (una Fase o il learner, eseguita da un sottoprocesso agente) o deterministica (gate, funnel e scritture di stato, logica pura del loop senza agente).
_Avoid_: step, stage, fase (per i deterministici)

**Edge**:
Transizione dichiarata tra due nodi, con condizione e tipo. Il payload di un'edge è ciò che il nodo a valle legge (es. il feedback della review sul back-edge verso implementation).
_Avoid_: transizione, salto, branch

**Tipo di edge**:
La classificazione di un'edge, assegnata solo quando determina una decisione di instradamento. Quattro famiglie: advance, verdetto (i kind del verdetto della review), derivate (stall guard, tentativi esauriti, pre-hook o spawn falliti) e config/ambiente (salto per modalità, continue-on-failure, stop dell'operatore, budget esaurito).
_Avoid_: etichette generiche ok/failed, tipi per eventi che non instradano

**Funnel dei fallimenti del task**:
Nodo deterministico su cui convergono tutti gli esiti di non-pass di un task (stall guard, report inutilizzabile, tentativi esauriti); decide una volta sola se il run prosegue col task successivo o si ferma.
_Avoid_: halt, halt diretto

**Stall guard**:
Guardia che dichiara fallito il task quando la review respinge due volte consecutive con feedback identico: l'implementazione non sta agendo sul feedback.
_Avoid_: anti-loop, feedback loop

**Stato di runtime del task**:
Le variabili in-flight del ciclo di un task (feedback della review, suggerimenti routed, avanzamento del run), dichiarate nel grafo ma non persistite nel fix plan: muoiono col processo e il resume le ricomputa.
_Avoid_: stato del loop (quello è il fix plan), sessione

**Sync finale**:
La sync che il run esegue a fine range quando nessun task l'ha eseguita (es. coda fallita in fast mode), seguita dalla compazione dei learnings di progetto. Garantisce almeno un sync documentale per run.
_Avoid_: final sync, sync di chiusura
