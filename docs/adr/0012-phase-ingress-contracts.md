# Contratti di ingresso per Fase: il fix plan non attraversa il confine nodo → esecutore

L'ingresso di ogni Fase diventa un tipo TypeScript dichiarato (`src/loop/phase-inputs.ts`), costruito come literal piatto dal nodo chiamante al confine; gli overload di `PhaseExecutor.run` indicizzati per Fase legano il nome della Fase al suo tipo di ingresso, e il compilatore è l'unico validatore (un literal con campi mancanti o extra non compila). Prima l'esecutore riceveva il fix plan intero ed estraeva da solo le slice (`spec_id`, `retry_count`, `learnings`): qualunque campo futuro del piano poteva finire in un prompt senza toccare la tabella del grafo — una falla strutturale, ora chiusa. Il modulo dei contratti non sta in `graph/` perché lo consuma anche il sub-loop review (fuori dal grafo per decisione della Fase 0) né in `phases.ts` perché i test devono importarlo senza trascinarsi l'esecutore.

Documenti di riferimento (letti dopo questo ADR, non prima):

- Decisione di topologia (grafo dichiarato, seriale, registry chiuso): ADR-0011.

Decisioni di design registrate:

- **Il nodo dichiara fatti, l'esecutore possiede la policy.** Il flag di blocco dei pre-hook diventa `firstAttempt: boolean` nel contratto; la mappa `blockOnPreHookFailure = firstAttempt` vive nel corpo dell'esecutore. Gli ingressi che non possono dichiarare un tipo di tentativo (re-spawn della review, sync di fine range) bloccano su un pre-hook fallito, come hanno sempre fatto per default.
- **Le due sync restano distinte.** `SyncPhaseInput` è unione di `TaskSyncPhaseInput` (contratti a monte, suggerimenti routed, `firstAttempt`) e `FinalSyncPhaseInput` (solo campi base): il nodo run-level non può dichiarare canali che non riceve.
- **Il contratto è sull'ingresso, non sull'output.** L'output reale della Fase resta `{ preHooksOk, hookResults, outcome }`; un output strutturato (es. i file modificati, che il codice non traccia) è materia della Fase 2.
- **Nessun metadato `reads`/`writes` nella tabella del grafo.** Considerati e rifiutati: nessun consumatore li leggerebbe, il compilatore non ne può verificare la verità, e una dichiarazione che può mentire inosservata invecchia peggio del silenzio — una dichiarazione esiste solo quando qualcosa dipende da lei (stessa regola del vocabolario delle edge). La ricognizione delle letture/scritture per nodo non è pubblicata come documento separato; vive nella tabella dichiarata in `src/loop/graph/task-graph.ts` e nel codice delle azioni in `src/loop/graph/task-nodes-*.ts`.
- **Project learnings letti dall'esecutore**, non dal nodo: spostare la lettura al confine cambierebbe quando il file viene riletto nei re-spawn del sub-loop review — un cambiamento di semantica dentro un refactor puro.
- **Nessun narrowing del canale di stato.** Il sub-loop review continua a ricevere il fix plan per i contatori centralizzati (`review_file_retry`, `review_file_error`) e il persist scrive il documento intero: il contratto restringe il canale del prompt, non quello dello stato, che resta singolo per scelta voluta.

Invarianti del refactor: contenuto dei prompt byte per byte identico (oracolo di equivalenza stringa in `test/phase-prompts.test.ts`, scritto sul codice pre-taglio); forma di `fix_plan.json`, semantica di `--resume`/`--force` e registro delle misure invariati (10 righe e2e, più un pin sull'`attempt` delle righe di retry in `test/measure-engine.test.ts`, perché l'identità di misura ora è dichiarata dal nodo e un valore sbagliato non toccherebbe i prompt).

Limiti noti: l'excess property check protegge solo i literal — un oggetto più largo passato con spread aggirerebbe il controllo, quindi i call site restano literal per convenzione da far rispettare in review; `grep -n "FixPlan" src/loop/phases.ts` (vuoto) è l'hook di review contro la reintroduzione di un parametro largo. `src/loop/phases.ts` resta sopra la soglia indicativa di righe, come già prima di questo intervento: un suo eventuale split è lavoro separato.
