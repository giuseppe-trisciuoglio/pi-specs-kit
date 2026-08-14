# Anomalie preesistenti del loop

Difetti **già presenti prima** dell'evoluzione verso il grafo dichiarato, emersi mentre si
dichiarava il comportamento implicito. Nessuno è stato introdotto da quel lavoro e nessuno è stato
corretto lì dentro: correggerli durante un refactor a comportamento invariato avrebbe mescolato due
cose diverse, rendendo impossibile distinguere una regressione da una correzione voluta.

Ognuno è oggi **caratterizzato da un test che descrive il comportamento attuale**, sbagliato
compreso. Vuol dire due cose: che il difetto non può peggiorare in silenzio, e che il giorno in cui
si decide di correggerlo il test va aggiornato di proposito — è il segnale che si sta cambiando
comportamento, non aggiustando un dettaglio.

Ordinati per impatto. Per ciascuno: cosa succede, dove, perché esiste, come si correggerebbe e cosa
si rischia correggendolo.

---

## A1 — Un run può chiudersi "completato" senza aver mai eseguito una sync

**Sintomo.** In modalità veloce, un run ripreso da un punto oltre la fase di sync completa il range e
si dichiara concluso senza che nessuna sync sia mai girata: né quella del task, né quella di fine
range. La documentazione della spec resta indietro rispetto al codice, e i learnings di progetto non
vengono compattati.

**Dove.** `src/loop/graph/task-nodes-cycle.ts:58` — all'ingresso del task, se il punto di ripartenza
è oltre la sync, lo stato di runtime marca la sync come già eseguita **senza eseguirla**. Quella
stessa marcatura è la guardia della sync di fine range
(`src/loop/graph/conditions.ts:71`): una volta alzata, sopprime anche l'ultima occasione di
sincronizzare.

**Perché esiste.** La marcatura serve a non rieseguire una sync che il run precedente aveva già
fatto. L'assunzione implicita è "se riprendo oltre la sync, la sync è avvenuta" — vera quando il run
precedente si è fermato dopo averla eseguita, falsa quando si era fermato prima per un motivo
qualsiasi, o quando la sync era stata saltata perché il task non era l'ultimo.

**Impatto.** Silenzioso: nessun errore, nessun warning, il run riporta successo. Si manifesta come
documentazione che non si aggiorna mai, ed è il tipo di difetto che si scopre settimane dopo
guardando una spec e chiedendosi perché è ferma.

**Pinnato da.** `test/resume-paths.test.ts`, il caso che descrive il resume oltre la sync.

**Fix proposto.** Distinguere "la sync è stata eseguita" da "il punto di ripartenza è oltre la sync":
sono due fatti diversi che oggi condividono una variabile. La sync di fine range dovrebbe dipendere
dal primo, non dal secondo. Un modo minimale: non alzare la marcatura all'ingresso, e lasciare che
sia la guardia di fine range a decidere sulla base di ciò che è realmente accaduto in questo run.

**Rischio del fix.** Basso sul codice, medio sull'effetto: si passerebbe da "nessuna sync" a "una
sync in più" in alcuni resume. Va deciso quale dei due si preferisce — una sync ridondante costa uno
spawn, una sync mancante costa documentazione ferma. Il test di caratterizzazione va riscritto di
proposito.

**Priorità: alta.** È l'unico dei quattro che produce un risultato sbagliato invece che solo
sorprendente.

---

## A2 — Uno stop richiesto durante la sync lascia comunque completare il task

**Stato: chiuso.** La decisione è stata presa: il comportamento attuale si tiene. Il completamento
del task è deliberatamente non interrompibile. Il razionale: quando si arriva a quel punto il lavoro
del task è già stato fatto per intero (implementazione, review, cleanup, sync); non registrarlo
significherebbe rifarlo tutto al riavvio, buttando via spawn già pagati per rispettare una simmetria
che non serve a nessuno. La scelta è resa leggibile da un commento sul nodo di completamento
(`src/loop/graph/task-nodes-tail.ts`) e pinnata da `test/stop-policy.test.ts`.

**Sintomo.** Chiedendo l'interruzione mentre la fase di sync è in corso, il loop non si ferma alla
fine di quella fase: prosegue, marca il task come completato, aggiorna il frontmatter, fa il commit
di checkpoint e notifica "task completed". Solo dopo esce come interrotto, lasciando persistito uno
stato che dice che il task è arrivato in fondo.

**Dove.** `src/loop/graph/task-nodes-tail.ts:130` — il nodo che marca il task come completato non ha
alcun controllo di interruzione in ingresso, a differenza di tutti i nodi che lo precedono
(`:65, :78, :84, :88, :110, :125`).

**Perché esiste.** I controlli di interruzione sono stati aggiunti nel tempo, uno per volta, nei
punti in cui servivano. Non c'è mai stata una decisione che dicesse "fra la sync e il completamento
non serve": semplicemente non è stato aggiunto.

**Impatto.** Difendibile ma incoerente. Si può argomentare che sia giusto: il lavoro è fatto,
registrarlo evita di rifarlo al riavvio. Il problema è che nessuno l'ha deciso, quindi il
comportamento è un caso, non una scelta — e le altre fasi si comportano nel modo opposto.

**Pinnato da.** `test/stop-policy.test.ts` (la scelta come voluta: stop durante la sync → task
comunque completato, checkpoint, notifica, run che esce come interrotto). Il caso preesistente in
`test/resume-paths.test.ts` continua a descrivere lo stesso comportamento.

**Decisione.** Tenere il comportamento attuale. Nessun controllo di interruzione è stato aggiunto al
nodo di completamento: il punto era decidere ed esplicitare, non cambiare. Il commento sul nodo e il
test rendono la scelta leggibile e verificata, quindi l'asimmetria smette di essere un caso storico.

---

## A3 — La guardia d'ingresso al ciclo con tentativi esauriti non ha un test dedicato

**Sintomo.** Nessuno visibile: il comportamento è corretto. Manca la rete.

**Dove.** L'edge di ingresso verso il funnel dei fallimenti, in coda alle edge d'ingresso in
`src/loop/graph/task-graph.ts`, con le predicate d'ingresso corrispondenti in
`src/loop/graph/conditions.ts`.

**Perché esiste.** Riproduce una guardia che nel codice precedente stava nella condizione del ciclo:
riprendere un task i cui tentativi erano già esauriti non esegue alcuna fase e cade direttamente nel
funnel. La finestra è stretta — richiede un'interruzione fra due scritture di stato — e infatti
nessun test la copriva neanche prima.

**Impatto.** Nullo oggi. Il rischio è futuro: è l'unica edge il cui comportamento non è verificato
da niente, quindi è quella che una modifica distratta all'ordine delle edge romperebbe senza che
nessuno se ne accorga.

**Fix proposto.** Un test che costruisce uno stato con i tentativi già esauriti e verifica che la
ripresa non produca alcuno spawn e chiuda dal funnel con lo stesso messaggio di sempre.

**Rischio del fix.** Nessuno: è solo copertura.

**Priorità: bassa**, ma è il più economico dei quattro — mezz'ora di lavoro senza alcun rischio.

---

## A4 — Due file oltre la soglia indicativa di dimensione

**Sintomo.** `src/loop/engine.ts` (352 righe) e `src/loop/phases.ts` (384 righe) superano le ~250
righe che il progetto si è dato come limite indicativo.

**Perché esiste.** Entrambi erano già oltre prima di questo lavoro, e nessuna delle fasi aveva il
loro split in perimetro. Il refactor del grafo ha semmai ridotto la pressione altrove: il ciclo
per-task è passato da 354 a 86 righe.

**Impatto.** Igiene, non correttezza.

**Fix proposto.** Per l'orchestratore di run: separare la sequenza dei task dalla preparazione del
run e dalle notifiche di chiusura. Per l'esecutore di fase: separare la costruzione del contesto di
prompt dall'esecuzione dello spawn e dagli hook.

**Rischio del fix.** Basso ma non nullo: sono i due file più attraversati dal loop, e uno split fatto
male sposta persistenze o notifiche. Va trattato come i tagli già fatti — estrazione prima,
comportamento invariato, la suite come oracolo.

**Priorità: bassa.**

---

## A5 — L'avviso di chiusura sui task falliti scatta solo se il fallimento è l'ultimo

**Sintomo.** Un run configurato per proseguire dopo un fallimento chiude il range senza alcun avviso,
se dopo il task fallito ne gira almeno un altro con successo. L'avviso di chiusura che segnala i
fallimenti compare solo quando il task fallito è l'ultimo del range.

**Perché esiste.** Lo stato di fallimento scritto dal funnel è **transitorio**: l'ingresso del task
successivo azzera l'errore prima di iniziare. L'avviso di chiusura legge quello stato, e a quel punto
è già pulito. Nessuno l'ha deciso: è la conseguenza non vista di due comportamenti corretti presi
separatamente.

**Impatto.** Un run può concludersi apparentemente sereno avendo perso per strada uno o più task.
Chi guarda solo le notifiche non ha modo di accorgersene; l'informazione resta nel documento di stato
e nel registro, ma nessuno la mette davanti agli occhi.

**Trovata.** Durante la scrittura del test di copertura di A3, come effetto collaterale: l'agente
aveva istruzione di riportare le sorprese invece di correggerle.

**Fix proposto.** Contare i task falliti lungo il run invece di leggere lo stato dell'ultimo task,
e usare quel conteggio per l'avviso di chiusura. Il conteggio è informazione di run, non di task,
quindi non va nel documento di stato del task.

**Rischio del fix.** Basso: cambia solo cosa viene notificato a fine range, non il flusso.

**Priorità: media.** Non produce lavoro sbagliato, ma nasconde lavoro non fatto — che è il modo in
cui un difetto silenzioso diventa costoso.

---

## Note minori, non tracciate come anomalie

- **Riassegnazione ridondante del dettaglio di errore del report.** Il sub-loop della review scrive
  già il dettaglio nello stato (`src/loop/review-runner.ts:138`) prima di restituire il verdetto; il
  gate lo riscrive con lo stesso valore (`src/loop/graph/task-nodes-cycle.ts:128`). Innocua, mantenuta
  per fedeltà durante il refactor. Si può togliere quando si tocca quel codice per altri motivi.
- **Scritture di stato ridondanti alla ripresa.** Ogni nodo riscrive il proprio passo anche quando è
  identico a quello già persistito. Ogni scrittura emette un evento e aggiorna un timestamp, quindi
  è osservabile: toglierla è un cambiamento di comportamento, non una pulizia.

---

## Come affrontarli

Non insieme. Ognuno ha una natura diversa: A1 è un difetto da correggere, A2 è una decisione da
prendere prima di scrivere codice, A3 è copertura mancante, A4 è igiene. Metterli in un unico
intervento rimescolerebbe le stesse categorie che il lavoro sul grafo ha tenuto separate a fatica.

L'ordine consigliato è A3 (gratis, riduce il rischio degli altri), poi A1 (l'unico con impatto
reale), poi A2 come decisione esplicita, e A4 quando quei due file vanno toccati per altro.
