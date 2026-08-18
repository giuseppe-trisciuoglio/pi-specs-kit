# Istruzioni per agenti su pi-specs-kit

Estensione pi in TypeScript: esegue il loop dei task di una spec orchestrando sottoprocessi `pi`. Prima di modificare
qualcosa, leggi `CONTEXT.md` (glossario e termini da evitare) e l'elenco degli ADR (`docs/adr/`, ordinati per numero)
per le decisioni di architettura. Il glossario dei termini di dominio è la sola guida canonica del vocabolario.

## Comandi

```bash
npm test          # unit + e2e, Node 24 esegue TypeScript nativamente
npm run typecheck # tsc --noEmit
npm run lint      # eslint . (flat config, AST-level; i tipi sono di tsc)
./sync-skills.sh  # risincronizza ./skills/ verso ~/.agents/skills (solo skill del progetto;
                  # --dry-run per anteprima, --pull per direzione inversa)
```

Nessuno step di build: non aggiungere bundler o transpiler. La pubblicazione npm è guidata dalle GitHub Release
(`.github/workflows/publish.yml`): alla pubblicazione di una release `vX.Y.Z` il workflow verifica che il tag
corrisponda alla `version` di `package.json`, gira i tre gate e pubblica su npm. 

## Vincoli di codice

- **Hot reload first.** La factory in `src/index.ts` registra solo comandi, tool ed eventi: niente risorse avviate al
  caricamento, config letta al primo comando. Ogni modifica deve sopravvivere a `/reload`.
- **Un file, una responsabilità**, indicativamente sotto le 250 righe. Se un file cresce oltre, estrai un modulo.
- **Dipendenze runtime**: solo `yaml` e i pacchetti forniti da pi (`typebox`, i tipi dell'SDK). Non aggiungerne altre.
- I moduli importabili dai test non devono dipendere dai pacchetti forniti da pi a runtime: gli import di tipo si
  cancellano, quelli di valore no. Se una funzione pura serve a un test, tienila fuori dai moduli che importano
  `typebox` o l'SDK (vedi `src/ui/run-args.ts`).
- **Solo `pi` come agente.** I ruoli differiscono unicamente per modello e thinking level; il nome agente nella
  configurazione è ignorato.
- **Un loop per sessione**, sia da comando sia da tool.

## Commenti e stringhe

- I commenti spiegano il perché in linguaggio naturale. Niente riferimenti a identificatori di specifiche, codici
  use-case, sezioni numerate, label di fase di analisi o path di documentazione di progetto.
- Non citare in codice, commenti, test, log, README o metadata di pacchetto il progetto da cui deriva la semantica del
  loop: la compatibilità dei formati si dichiara a parole ("compatibile con il formato esistente").
- Messaggi utente (notifiche, output dei comandi, errori mostrati) in inglese, prefissati con `[specs-kit]`; commenti e
  identificatori in inglese.

## Stato e persistenza

`<spec>/_ralph_loop/fix_plan.json` è la sola fonte di verità del loop. Ogni transizione di stato lo riscrive in modo
atomico (tmp + rename) prima di proseguire, così un kill in qualsiasi punto lascia uno snapshot ripartibile con
`--resume`. Se aggiungi un campo, mantieni la lettura tollerante ai campi assenti e non rompere la forma esistente del
documento.

Le misure (token e durate) non stanno nel fix plan: il registro append-only è
`<specs_dir>/measurements.jsonl` (versionato), alimentato dal buffer write-ahead
`~/.pi/agent/specs-kit/measurements-wal.jsonl` (moduli
`src/measure/`). Ogni I/O di misura è best-effort: mai far fallire il loop per un errore del registro.

Un tentativo di implementazione ripetuto che lascia l'albero identico non è progresso: `src/loop/workspace.ts`
calcola l'impronta del worktree (indice git usa e getta, il vero staging non viene toccato) prima e dopo la fase, e
solo sui retry. Impronte uguali su un tentativo pulito chiudono il task prima di rispawnare la review. Best-effort:
fuori da un repo git l'impronta è `null` e la guardia resta inerte. Decisione documentata in `docs/adr/0015`.

## Dipendenze esterne

- **graphify è la sola fonte del grafo del codebase.** Il grafo della conoscenza vive in un unico file,
  `graphify-out/graph.json` (prodotto dalla skill esterna graphify), letto direttamente da ogni consumer. Non esiste un
  `knowledge-graph.json` per-spec proiettato: graph.json è l'unico file di grafo. L'estensione non indicizza mai il
  codebase. graphify non è bundled:
  va installata a parte (`~/.agents/skills/graphify` o
  `~/.pi/agent/skills/graphify`); la fase sync la rinfresca (`/graphify --update`)
  prima di consumarla.
- **Check a runtime.** `LoopController.start` verifica la presenza di graphify prima di avviare il loop e, se manca,
  emette un warning `[specs-kit]`
  (best-effort: il loop prosegue, ma le feature che leggono il grafo restano indisponibili). Il resolver è iniettabile
  (`ControllerDeps`).
- **Refresh per task.** L'ingresso di ogni task ri-estrae la metà di codice del grafo con `graphify update`
  (`src/loop/codebase-graph.ts`): nessuna chiamata a modello, ~3s. Serve perché il sync — l'unica fase che lo
  ricostruisce — in fast mode gira una volta per range, mentre tutte le fasi lo leggono. La metà doc/paper/image resta
  al sync. Best-effort e iniettabile (`TaskNodeDeps.refreshCodebaseGraph`): senza stub i test dipenderebbero dal
  binario. Decisione documentata in `docs/adr/0017`.
- **Pre-flight modelli.** `LoopController.start` confronta i modelli configurati per i cinque ruoli con il catalogo
  di `pi --list-models` (`src/loop/model-check.ts`): un modello assente fa rifiutare l'avvio nominando ruoli e modelli;
  un catalogo non ottenibile produce solo un warning e il loop parte. La funzione di interrogazione è iniettabile
  (`ControllerDeps.listModels`). Decisione documentata in `docs/adr/0013`.
- Decisione documentata in `docs/adr/0009`.

## Test

- Unit con `node:test` per parser, fix plan, configurazione, prompt builder, state machine e hook: il motore accetta
  dipendenze iniettabili (`spawnPhase`, `runHooks`, `commitCheckpoint`), usale al posto di mock globali.
- L'e2e in `e2e/` mette un agente finto sul PATH e verifica il loop completo, retry, halt e resume. Se cambi il testo
  dei prompt di fase, aggiorna i marker che l'agente finto e i test usano per riconoscere la fase.
- Test prima del cablaggio UI.

## NotebookLM

Hai accesso attraverso il tool da riga di commando `nlm` che ti consente di effettuare delle query e ricevere risposte
in un ambiente controllato. Il tool è utile per fare ricerche su fonti selezionate e per ottenere risposte più accurate
e contestualizzate.

Ci sono due notebooklm che puoi utilizzare:

1. `2109b364-abe6-4aaf-9818-1bf8b08bb46a` - The 2026 Guide to AI Coding Agents and SDLC Context
2. `1c3312fc-90f1-4ebc-988e-32ff1e83086c` - Personale | SDD & Harness Engineering