# Piano di implementazione — Fase 2: nodi deterministici first-class (verdetto: non promuovere)

La Fase 2 dell'analisi (`docs/graph-engineering-evolution.md` §4) proponeva di promuovere a nodi
dichiarati con proprio contratto I/O il lavoro deterministico oggi inline nelle azioni dei nodi
agentic: esecuzione degli hook, gate sul report della review, check di presenza del grafo, scrittura
del frontmatter di completamento. Questo piano applica al codice reale il test di ammissione
fissato dalla decisione D8 — si promuove **solo** ciò che instrada, oppure produce un output
strutturato che un nodo a valle consuma come input — e ne riporta l'esito.

**Esito in una riga: nessun candidato supera il test sul codice attuale.** Due (gate del report,
funnel dei fallimenti) sono già nodi dichiarati dalla Fase 0; tre (frontmatter, check del grafo,
post-hook) non instradano e non hanno consumatori a valle, come D8 aveva già stabilito; i pre-hook
di gate — l'unico candidato che D8 riservava a questa Fase — non superano il test applicato al
codice: la loro metà che instrada è già un'edge dichiarata dalla Fase 0, e la loro metà che produce
output non ha un *nodo* a valle che la consumi, perché il consumatore è lo spawn della stessa Fase
(D1). Il residuo di valore reale non è un nodo: è la politica di *cosa* l'agente legge nel blocco
`<hooks>`, un cambio di comportamento che si fa (se si fa) nel prompt builder, senza toccare il
grafo. La raccomandazione finale è al §9.

Vincoli onorati: D0–D8 e le risposte dell'architect nelle Fasi 0 e 1 restano chiuse (la tensione
D8/D1 che emerge dal codice è riportata all'architect, non risolta qui); grafo seriale, parallelismo
fuori scope per sempre; stato centralizzato singolo, forma di `fix_plan.json`, semantica di resume e
riavvio forzato invariate; nessuna nuova dipendenza, niente typebox, nessuno step di build; i
moduli del grafo restano importabili dai test senza import di valore dai pacchetti di pi; un file
una responsabilità sotto le ~250 righe; le anomalie note dei piani precedenti non si toccano.

> Baseline alla stesura: `npm test` 316 test passati (0 falliti), `npm run typecheck` e
> `npm run lint` verdi, albero git pulito.

---

## 1. Inventario dei candidati (dal codice)

Convenzioni: **instrada** = il suo esito determina un'edge del grafo dichiarato; **consumatore a
valle** = un altro nodo del grafo che legge l'output come ingresso dichiarato.

### C1 — Esecuzione dei pre-hook (gate di Fase)

- **Dove vive**: dentro `PhaseExecutor.run` (`src/loop/phases.ts:268-274`): `runPhaseHooks`
  (`src/loop/hooks.ts:46-61`, sequenziale, si ferma al primo fallimento) e la policy di blocco
  `blockOnFailure` (`phases.ts:263`: `"firstAttempt" in input ? input.firstAttempt : true`).
- **Cosa legge**: `config.hooks[phase].pre`, `config.projectRoot`, `config.hooks.timeoutMs`
  (`hooks.ts:53-56`); il fatto dichiarato `firstAttempt` dai contratti di Fase
  (`src/loop/phase-inputs.ts`: `ImplementationPhaseInput`, `CleanupPhaseInput`,
  `TaskSyncPhaseInput`; review e final sync non lo dichiarano e bloccano sempre).
- **Cosa scrive**: `HookResult[]` (`hooks.ts:5-12`: command, ok, exitCode, timedOut, output grezzo
  stdout+stderr); il booleano `preHooksOk` nel risultato della Fase (`phases.ts:51-55`); il blocco
  `<hooks>` del prompt (`phases.ts:293` → `src/prompt/prompt-builder.ts:163-176`), con troncamento
  `truncateOutput` (`prompt-builder.ts:117-123`) ai limiti `HOOK_OUTPUT_LIMIT = 6000` /
  `HOOK_TAIL = 4500` (`prompt-builder.ts:43-45`).
- **Chi consuma oggi il suo output**:
  1. *il routing*: `impl.preHooksOk === false` → `runtime.implStatus = "pre-hook-failed"`
     (`src/loop/graph/task-nodes-cycle.ts:91-96`) → edge dichiarata
     `implementation → implementation [pre-hook-failed]` (`src/loop/graph/task-graph.ts:56`,
     predicate `impl_pre_hook_failed` in `src/loop/graph/conditions.ts:41`). Per la review il
     pre-hook fallito vive dentro la macro D2: restituisce il verdetto `attemptFailed` con persist
     proprio (`src/loop/review-runner.ts:108-112`). Per cleanup, sync e final sync il pre-hook
     fallito è non fatale: notifica e via (`task-nodes-tail.ts:76`, `:118`;
     `src/loop/graph/run-graph.ts:62`).
  2. *il prompt della stessa Fase*: quando non blocca (retry, oppure hook che passano), l'output
     grezzo troncato entra nel blocco `<hooks>` dello spawn immediatamente successivo — stesso nodo,
     stessa azione, millisecondi dopo.

### C1b — Esecuzione dei post-hook

- **Dove vive**: `phases.ts:313-318`. Fallimento → sola notifica warning (`phases.ts:318`).
- Non instrada (D5 lo registrò: resta notifica, non tipo di edge); nessun consumatore a valle:
  l'output dei post-hook non entra mai in alcun prompt (il prompt è costruito prima, `phases.ts:286`)
  e in nessuna decisione.

### C2 — Gate sul report della review

- Già dichiarato dalla Fase 0 in due pezzi, per costruzione: il gate di leggibilità del file vive
  nella macro review (D2: sub-loop in `review-runner.ts:96-147`, contatore `review_file_retry`
  persistito); il dispatch del verdetto è il nodo deterministico `review_gate`
  (`task-nodes-cycle.ts:119-142`, edge `passed`/`failed`/`attempt-failed`/`report-unusable`/
  `stall-guard` in `task-graph.ts:63-71`). Il funnel `task_failed` è nodo dalla Fase 0.

### C3 — Check di presenza del grafo della conoscenza

- **Dove vive**: `checkGraphForSync` (`src/loop/graph/task-nodes-tail.ts:34-46`), chiamato dal nodo
  `sync` (`:113`) e dal nodo run-level `final_sync` (`run-graph.ts:50`). Legge il filesystem
  (`graphifyGraphExists`), scrive `state.graphPartialSync` + persist e un warning.
- **Consumatore**: `src/loop/engine.ts:332` — la notifica di fine range "partial sync". È
  orchestrazione del run-level, non un nodo; nessuna edge la legge (D5: `graph-missing` scartato
  come tipo perché la sync gira comunque).

### C4 — Scrittura del frontmatter `reviewed` in update_done

- **Dove vive**: dentro l'azione del nodo deterministico `update_done`
  (`task-nodes-tail.ts:129-139`, solo full mode, try/catch con warning). Non instrada: il done viene
  persistito comunque (`:142`). **Consumatore a valle**: nessuno nel run — i task file si rileggono
  al refresh del run successivo, fuori dal grafo.

### Non-candidati verificati (per chiudere l'inventario)

- `upstreamProvides` (`task-nodes-tail.ts:17-26`): funzione pura su `plan.done`, già calcolata al
  confine del nodo che la consuma; nessun lavoro "inline rumore" da estrarre.
- `collectRoutedSuggestions` (`task-nodes-cycle.ts:63`): già azione del nodo deterministico
  `enter_task`.
- Stall guard: già azione di `review_gate` (`task-nodes-cycle.ts:132-135`).
- Archivio/cancellazione del report prima dello spawn: dentro la macro D2 per decisione chiusa.
- Budget: eccezione run-level, propagazione nativa (D0).

## 2. Applicazione del test di ammissione (sezione principale)

### C3 — check del grafo: **non promuove** (conferma di D8 sul codice)

Non instrada: la sync parte comunque (`task-nodes-tail.ts:113-114` esegue il check e poi lo spawn
incondizionatamente). L'output (`state.graphPartialSync`) non è letto da nessun nodo: l'unico
lettore è la notifica di chiusura del run in `engine.ts:332`. Un nodo `graph_check` sarebbe un nodo
che non decide nulla e di cui nessuno consuma l'uscita — esattamente la categoria che D8 esclude.

### C4 — frontmatter `reviewed`: **non promuove** (conferma di D8 sul codice)

Non instrada (`update_done` procede al checkpoint in ogni caso) e nessun nodo a valle legge il
frontmatter: il primo lettore è il refresh del run successivo. È inoltre già *dentro* un nodo
deterministico dichiarato: promuoverne un pezzo interno a nodo distinto aggiungerebbe un nodo senza
aggiungere una decisione.

### C1b — post-hook: **non promuove**

Non instrada (solo warning, `phases.ts:318`) e non ha consumatori: l'output non raggiunge né prompt
né routing. Stessa categoria di C3/C4.

### C2 — gate del report: **nulla da promuovere**

È la promozione già fatta in Fase 0: `review_gate` e il funnel `task_failed` sono nodi dichiarati
con edge tipizzate; il gate di leggibilità è incapsulato nella macro per D2, decisione chiusa con
motivi (nessuna diramazione propria, contatore di tentativo, resume dal contatore persistito) che
il codice conferma attuali (`review-runner.ts:96-147`).

### C1 — pre-hook di gate: **non promuove** (il verdetto contrario a D8, con evidenza)

D8 riservava questo candidato alla Fase 2, condizionato all'esistenza del contratto dell'output
strutturato. Applicando il test al codice reale, nessuno dei due rami regge.

**Ramo 1 — "instrada": sì, ma quella routing è già first-class.** L'esito `preHooksOk: false` del
primo tentativo instrada già oggi attraverso un'edge *dichiarata* con predicate nel registry chiuso
(`pre-hook-failed`, `task-graph.ts:56`, `conditions.ts:41`) e la guardia di esaurimento dichiarata
prima di essa. Il test di ammissione chiede se il lavoro debba diventare un nodo; la metà del
lavoro che instrada ha già la forma dichiarata che la promozione gli darebbe. Promuovere
l'esecuzione a un nodo `pre_hooks` sposterebbe le edge da `implementation` al nuovo nodo senza
aggiungere alcuna decisione: la condizione di blocco diventerebbe una nuova predicate
("pre-hook fallito E primo tentativo", oggi espressa da `firstAttempt` nel contratto della Fase,
`phases.ts:263`) e le stesse quattro destinazioni di oggi. Puro spostamento, zero routing nuova.

**Ramo 2 — "output strutturato consumato da un nodo a valle": il consumatore non è un nodo a
valle.** L'output degli hook è già strutturato (`HookResult` e `PhaseStepResult.preHooksOk`), ma il
suo consumatore è lo spawn della **stessa Fase**: l'esecutore gira gli hook e, se non bloccano,
costruisce il prompt e spawna nella stessa azione di nodo (`phases.ts:268-303`). Non esiste un nodo
a valle finché non si spaccia la Fase in `pre_hooks → <fase>`, e quello spaccamento:

1. **contraddice D1**, chiusa con due motivi che il codice mostra ancora portanti: (a) l'unità di
   misura — il meter apre l'handle *prima* degli hook e lo chiude nel `finally` *dopo* i post-hook
   (`phases.ts:266`, `:321`, commento "The handle spans hooks and subprocess alike"); il registro
   delle misure documenta la durata come intero step (`docs/plan.md` §3.4) e l'e2e pinna 10 righe
   esatte (`e2e/loop.e2e.test.ts:122`). Due nodi significherebbero o due righe di registro per Fase
   (cambio di semantica del registro, oracolo e2e da rinegoziare) o un handle condiviso attraverso
   il confine nodo→nodo (state plumbing nel runtime del task); (b) la policy di blocco definita al
   confine di Fase — `blockOnFailure` dipende dalla Fase e dal tentativo: implementation, cleanup e
   sync dichiarano `firstAttempt: retry_count === 0`, la review incapsula i suoi pre-hook nel
   verdetto `attemptFailed` della macro (`review-runner.ts:108-112`), la final sync blocca sempre.
   Un nodo `pre_hooks` unico andrebbe parametrizzato per Fase, o moltiplicato in quattro: in entrambi
   i casi, cerimonia senza decisione.
2. **non cambierebbe una virgola del prompt.** Il valore dichiarato della Fase 2 era "spostare
   rumore deterministico fuori dal contesto dell'agente". Quel rumore è il *contenuto* del blocco
   `<hooks>`, deciso dal prompt builder (`prompt-builder.ts:163-176`): la promozione a nodo, da
   sola, lascia il blocco byte per byte identico. Un refactor che non cambia né routing (già
   dichiarata) né prompt (gestita altrove) né persistenza è cerimoniale: aggiunge nodi al grafo che
   non decidono nulla — la categoria che D8 stesso esclude per C3 e C4.

**Il residuo di valore è reale ma non è un nodo.** Il rumore oggi in prompt è duplice: (a) l'output
*degli hook che passano* entra integralmente (troncato a 6 KB a hook) nel prompt di ogni spawn —
`prompt-builder.ts:169-171` include `output:` per ogni hook con output non vuoto, `ok` compreso
(pinnato dal test "hooks block reports command, status and bounded output",
`test/prompt-builder.test.ts:144-158`: `status: ok` + `output:\nall green`); (b) l'output degli hook
falliti sui retry entra troncato al solo scopo di dare all'agente il contesto per riparare — e
quello è segnale, non rumore. La leva deterministica è una politica del prompt builder: output
omesso per gli hook ok (comando e stato bastano a certificare che il gate è girato), output troncato
invariato per gli hook falliti. È un cambio di comportamento del prompt, piccolo, misurabile con il
registro delle misure esistente, e non tocca grafo, nodi, edge, registry né contratti di Fase. Questo
piano lo tratta come **variante ridotta**, condizionata all'approvazione dell'architect (§8, §9).

## 3. Il contratto di output strutturato

**Per la promozione (non raccomandata):** il verdetto strutturato esisterebbe già come tipo —
`HookResult` (`hooks.ts:5-12`) è il verdetto per-hook e `PhaseStepResult.preHooksOk/hookResults`
(`phases.ts:51-55`) è il verdetto di Fase. Un canale dichiarato nodo→nodo richiederebbe un campo
`preHookVerdict` nei tipi di `src/loop/phase-inputs.ts` (modulo di soli tipi, validato dal
compilatore, nessuna dipendenza, niente typebox: identico per principio ai tipi di Fase 1). Non serve
costruirlo: il §2 mostra che non c'è un nodo a valle a cui darlo.

**Per la variante ridotta (raccomandata, condizionata):** non serve alcun tipo nuovo. Il contratto è
la politica di resa del blocco `<hooks>` nel prompt builder, dove il tipo di ingresso esiste già
(`PreHookResult`, `prompt-builder.ts:29-33`): per hook `ok` → solo `$ command` + `status: ok`;
per hook fallito → `$ command` + `status: failed` + `output:` con il troncamento esistente. La
"validazione dal compilatore" resta quella dei tipi esistenti; nessun nuovo modulo, nessun file
nuovo, `prompt-builder.ts` resta sotto quota.

## 4. Impatto sul contenuto dei prompt (esplicito e onesto)

**Oggi l'agente legge**, per ogni pre-hook configurato della Fase che sta per girare
(`prompt-builder.ts:163-176`):

```
$ <comando>
status: ok | failed
output:
<output grezzo, trimmato; se supera 6000 caratteri: coda di 4500 + "...[N characters omitted]...">
```

Nota onesta: il "rumore" non è solo quello dei retry. L'output degli hook **che passano** entra nel
prompt *del primo tentativo* (basta che abbia output non vuoto): una suite di test verde da 5 KB
viaggia nel prompt di ogni Fase con pre-hook configurati, per certificare qualcosa che una riga
`status: ok` certifica già. L'output *fallito* su retry è invece il contesto di riparazione: quello
va conservato.

**Dopo la promozione a nodo (non raccomandata): byte per byte identico.** Nessun impatto, in nessuna
direzione. È l'argomento decisivo contro: un refactor strutturale senza alcun effetto osservabile,
al prezzo di spostare una decisione chiusa (D1) e rinegoziare l'unità di misura del registro.

**Dopo la variante ridotta (condizionata):** gli hook ok perdono la riga `output:` (restano comando
e stato); gli hook falliti restano identici, troncamento incluso. Effetto: prompt più piccoli e più
denso in segnale quando i gate girano verdi; nessuna perdita sul percorso di riparazione. Rischio
dichiarato: un output *ok* può contenere warning utili (deprecation, skip di test). Come si misura
che il cambio è un miglioramento e non un peggioramento:

1. **Token di ingresso per Fase** dal registro delle misure esistente (`measurements.jsonl`, riga
   `phase`, campo `usage.input`): confronto pre/post su run comparabili. La riduzione è
   deterministica nella struttura (il blocco si restringe di tutto l'output verde) e deve apparire
   nei numeri.
2. **Pass-rate per ciclo come guardia di non-degrado**: distribuzione dell'`attempt` delle righe
   `implementation`/`review` (quanto spesso la review passa al primo colpo) pre/post. Se la
   rimozione dell'output verde peggiorasse la qualità delle implementazioni, la si vedrebbe qui
   prima che altrove. Soglia pratica: se il pass-rate al primo tentativo cala in modo consistente
   sui run successivi al cambio, si torna indietro (la variazione è una riga di prompt builder).

**Dichiarazione richiesta dai criteri di accettazione:** la Fase 2 come promozione a nodi sarebbe
stata un refactor *puro ma inutile* (zero cambio di comportamento, zero valore); la variante ridotta
è un **cambiamento di comportamento deliberato** del contenuto del prompt, con misura e criterio di
ritorno definiti sopra. Non esiste una terza via che sia "refactor puro e utile": l'unica utilità
disponibile abita nel contenuto del prompt.

## 5. Sequenza di step (variante ridotta — solo se l'architect la approva)

Ogni step lascia i tre gate verdi (`npm test`, `npm run typecheck`, `npm run lint`). Se la
raccomandazione finale venisse accolta come "non fare nulla", questa sezione non si esegue.

**Step 0 — Baseline e branch.**
Cosa: tre gate verdi (316 test attesi), `git status` pulito, branch di lavoro.
Verifica: gate verdi, albero pulito. Se fallisce: nessun passo avanti su baseline rossa.

**Step 1 — Caratterizzazione del comportamento nuovo, prima del taglio.**
Cosa: estendere `test/prompt-builder.test.ts` con i casi della politica futura, scritti come
*auspicati* e verificati rossi sul codice attuale: hook ok con output → il prompt contiene
`$ cmd` e `status: ok` e **non** contiene `output:`; hook fallito → invariato (output troncato
presente). Aggiornare anche l'oracolo d'equivalenza di `test/phase-prompts.test.ts` se qualche
scenario usa pre-hook ok con output (oggi usa solo `FAILING_PREHOOK`, `:71-74`: verificare allo
step, non assumere).
Perché prima: i test descrivono la politica voluta; scriverli dopo userebbe il codice nuovo come
oracolo di sé stesso.
Verifica: nuovi test rossi esattamente per l'asserzione `output:` dell'hook ok, verdi su tutto il
resto; tre gate col resto della suite verde. Se un test "rosso" risulta verde: la mappa del §4 è
sbagliata, fermarsi e rileggere il prompt builder prima di toccare codice.

**Step 2 — Il taglio: la politica del blocco `<hooks>`.**
Cosa: `src/prompt/prompt-builder.ts:163-176`: emettere `output:` solo per `!hook.ok`. Nessun altro
file. Aggiornare il test esistente "hooks block reports command, status and bounded output"
(`test/prompt-builder.test.ts:144-158`): l'hook ok perde `output:\nall green` — è l'unica
modifica deliberata a un test esistente, e va dichiarata nel commit come il pin del nuovo
comportamento.
Verifica: tre gate; i test dello Step 1 passano; e2e verde con le 10 righe del registro (il numero
di spawn non cambia); suite state-machine intatta (i suoi `runHooks` finti restituiscono `[]`, non
vedono il blocco).
Se fallisce: l'unica variabile in gioco è la condizione su `hook.ok` — confrontare con il rendering
del test dello Step 1.

**Step 3 — Misura e documentazione.**
Cosa: ADR nuovo (`docs/adr/0013`) che registra la decisione di politica del blocco hook, la
motivazione (output verde = certificazione, non contesto) e il criterio di ritorno (pass-rate al
primo tentativo); aggiornare la descrizione del blocco `<hooks>` in `docs/plan.md` §4.5 e la voce
"Hook" di `CONTEXT.md` se necessario (una frase: l'output entra nel prompt solo per hook falliti).
Avviare la raccolta della misura (§4): confronto dei token di ingresso e del pass-rate al primo
tentativo sui run reali successivi, rispetto ai run precedenti comparabili.
Verifica: tre gate; rilettura dell'ADR; prima lettura della misura al run reale successivo.

## 6. Strategia di test

- **La suite esistente resta l'oracolo**: 316 test. Per la variante ridotta la superficie toccata è
  piccola e localizzata: `prompt-builder.test.ts` (il blocco `<hooks>`), `phase-prompts.test.ts`
  (equivalenza esecutore↔builder), e2e (10 righe del registro: prova che nessuno spawn cambia),
  state-machine (hook finti vuoti: non coinvolta). Nessun test di grafo, interprete o registry viene
  toccato — la variante non tocca il grafo.
- **Il comportamento nuovo è pinnato dal caratterizzazione dello Step 1**, scritta prima del taglio,
  con il protocollo rosso-verde (rosso sul codice attuale, verde dopo). Il test esistente che pinna
  il comportamento vecchio viene modificato una sola volta, allo Step 2, e la modifica è essa stessa
  il record del cambio di comportamento.
- **La non-regressione di contenuto** è data dall'unchanged path: hook falliti, troncamento,
  limiti 6000/4500 e ogni altro blocco del prompt restano com'erano e continuano a essere pinnati
  dagli stessi test di prima.
- **Se invece si decidesse (contro questa raccomandazione) la promozione a nodo**: l'oracolo minimo
  sarebbe la suite intera *più* la rinegoziazione esplicita di due pin: le 10 righe del registro
  e2e (l'unità di misura si spacca o si condivide) e i marker di Fase dell'agente finto. È il costo
  di oracolo che rende la promozione ancora meno conveniente.

## 7. Rischi

1. **Il rischio principale della variante ridotta è la perdita di informazione utile nell'output
   verde** (warning, deprecation, skip). Mitigazione: misura del pass-rate al primo tentativo con
   criterio di ritorno esplicito (§4); la variazione è una riga, il ritorno è immediato.
2. **Deriva silenziosa della politica**: qualcuno potrebbe in futuro reincludere l'output verde "per
   sicurezza". Mitigazione: il test di caratterizzazione dello Step 1 la pinna; l'ADR ne registra la
   motivazione.
3. **Rischio della promozione (se fatta contro raccomandazione)**: spaccare l'unità di misura del
   registro, moltiplicare nodi senza decisioni, dover rinegoziare D1 e l'oracolo e2e. Elencato per
   completezza; la raccomandazione è di non farla.
4. **Rischio di fare nulla e chiamarlo fatto**: dichiarare la Fase 2 chiusa senza l'ADR che ne
   registra l'esito negativo lascerebbe l'agenda dell'analisi (§4) apparentemente aperta. Mitigazione:
   la chiusura formale è essa stessa un passo documentale (§8, Q1).

## 8. Questioni da riportare all'architect

1. **Q1 — Chiusura formale della Fase 2 come "non fare"** (chiede approvazione). Il test D8 applicato
   al codice boccia anche i pre-hook che D8 vi riservava: routing già dichiarata in Fase 0,
   consumatore non-nodo, D1 e unità di misura del registro a monte (§2, evidenza citata). Serve una
   decisione esplicita (ADR o aggiornamento dello stato in `docs/graph-engineering-evolution.md`)
   che chiuda la Fase 2 senza implementazione, così l'agenda dell'analisi non resta sospesa.
2. **Q2 — Approvazione della variante ridotta** (comportamento nuovo). La politica "output nel prompt
   solo per hook falliti" è un cambio di comportamento con misura e criterio di ritorno (§4) e tre
   step pronti (§5). È la metà utile della Fase 2, e non è un grafo: chiedere se si fa, quando, o
   mai. Notare che D8 subordinava la promozione "all'esistenza del contratto dell'output strutturato":
   il contratto esiste già (`HookResult`, `PreHookResult`); quello che manca non è il contratto ma la
   ragione per un nodo.
3. **Q3 — Tensione D1/D8, da chiudere a verbale** (solo se Q1 venisse respinta). D8 prometteva la
   promozione dei pre-hook; D1 (precedente) vieta di spaccare la Fase e fissa due motivi (unità di
   misura, policy al confine di Fase) che il codice conferma ancora validi. Se l'architect volesse
   comunque la promozione, è una spostazione di D1 che va decisa con lui, insieme alla sorte delle
   10 righe del registro e2e e della semantica di `duration_ms` del registro — non una scelta
   eseguibile in delega.

## 9. Raccomandazione finale

**Non fare la Fase 2 come promozione a nodi deterministici.** Sul codice reale nessun candidato la
supera: il gate del report e il funnel sono già nodi dalla Fase 0; frontmatter, check del grafo e
post-hook non instradano e non hanno consumatori (D8 lo aveva già stabilito e il codice lo
conferma); i pre-hook di gate — l'unico candidato riservato a questa Fase — instradano tramite un'edge
già dichiarata e il loro output è consumato dallo spawn della stessa Fase, quindi la promozione
aggiungerebbe nodi che non decidono nulla, al prezzo di spostare D1 e rinegoziare l'unità di misura
del registro. Il test di ammissione di D8, applicato onestamente, boccia l'intero perimetro della
Fase 2 così com'era intitolata.

**Fare, se l'architect approva, la variante ridotta** (§5): la politica del blocco `<hooks>` —
output nel prompt solo per hook falliti — che è l'unico residuo reale del valore dichiarato della
Fase 2 (meno rumore deterministico nel contesto dell'agente), costa tre step in un solo file più
test, è misurabile con il registro esistente e ha un criterio di ritorno. È un cambio di
comportamento dichiarato, non un refactor: proprio per questo la decisione spetta all'architect
(Q2), non alla delega.

---

## 10. Risposte dell'architect (decisioni chiuse)

- **Q1 → la Fase 2 è chiusa come "won't do".** La diagnosi è accettata: il test di ammissione,
  applicato al codice invece che assunto, boccia l'intero perimetro. Promuovere i pre-hook
  produrrebbe nodi che non decidono nulla — esattamente ciò che il test doveva impedire — al prezzo
  di spostare il confine di Fase e rinegoziare l'unità di misura del registro. La sequenza delle
  fasi resta quella dichiarata: quello che cade è il contenuto della Fase 2, non il metodo che l'ha
  bocciata.
- **Q2 → variante ridotta approvata.** Nel blocco degli hook del prompt entra l'output dei soli hook
  falliti; un hook che passa contribuisce il suo status e nient'altro. Un output che nessuno ha mai
  dimostrato servire, ripetuto a ogni spawn di ogni fase, è costo puro: si toglie e si misura.
  È un cambiamento di comportamento dichiarato, non un refactor, e va trattato come tale — pinnato
  da test propri, non nascosto dentro una pulizia.
- **Q3 → decade.** La tensione fra D1 e D8 non va chiusa a verbale: senza la promozione dei pre-hook
  non esiste. D1 resta com'è.

**Criterio di ritorno**: se dopo il cambiamento la pass-rate al primo tentativo peggiora in modo
riconoscibile, si torna indietro — l'output degli hook riusciti conteneva un contesto che serviva, e
lo si è scoperto nel modo giusto invece che assumendolo.
