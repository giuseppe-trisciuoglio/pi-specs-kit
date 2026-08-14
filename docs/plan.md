# Piano di implementazione — pi-specs-kit

Estensione di pi che reimplementa nativamente in TypeScript il loop di esecuzione
task di una spec (fasi: implementation → review → cleanup → sync), orchestrando
sottoprocessi `pi` dalla sessione interattiva. Il loop è pilotabile da comandi
utente, da tool LLM e osservabile via widget live e vista streaming.

> Decisioni emerse dalla sessione di grilling (vedi `CONTEXT.md` per il glossario):
> riscrittura nativa (no wrapper), solo agente `pi`, sottoprocesso per fase,
> fix_plan.json come single source of truth, modelli configurabili da TUI con
> persistenza su `specs-kit.yaml`, package npm globale, test con `node:test` + fake pi.
>
> Estensione del campo (seconda sessione di grilling, vedi §11–§12 e gli ADR
> `docs/adr/0001`, `docs/adr/0002`): fork pi-nativo di otto `specs-*` skill
> esposto via `resources_discover` (fixa anche il bug latente delle phase-skill
> oggi rotte sotto pi), catena di authoring (`/specs-kit-new`, `/specs-kit-continue`)
> e Spec attiva persistente. Registro delle misure fuori dal fix plan (ADR
> `docs/adr/0007`, vedi §3.4).

---

## 1. Vincoli e convenzioni

- **Solo `pi` come agente.** Il campo nome agente in `specs-kit.yaml` è ignorato;
  contano solo `*_model` e `*_thinking_level` per ruolo.
- **Un loop attivo per sessione pi.** Secondo avvio → errore gentile.
- **Commenti sorgente**: nessun riferimento a identificatori di specifiche,
  codici use-case, sezioni numerate, label di fase di analisi, path di
  documentazione di progetto. Rationale in linguaggio naturale.
- **Nessun riferimento al progetto Go**: il loop esistente (`specs-kit-cli`)
  è solo materiale di studio. Vietato citarlo — nome del repo, path, package o
  file `.go` — in codice, commenti, identificatori, stringhe, messaggi di log,
  test, e2e, README e metadata di package. La compatibilità dei formati si
  dichiara in linguaggio naturale ("compatibile con il formato esistente").
  I file Go sono nominati solo in §10 di questo documento.
- **Nessuna dipendenza runtime pesante**: solo un parser YAML (`yaml`) oltre ai
  pacchetti forniti da pi (`typebox`, tipi dell'SDK).
- **Hot reload first**: tutto il codice deve funzionare con `pi -e ./src/index.ts`
  e `/reload`; niente risorse background avviate nella factory (vedi regole
  estensioni: avvio risorse solo su `session_start` o su comando).

## 2. Struttura del repository

```
pi-specs-kit/
├── package.json              # "pi": {"extensions": ["./src/index.ts"]}, dep: yaml
├── tsconfig.json             # solo per typecheck/editor (esecuzione via jiti)
├── CONTEXT.md                # glossario (già presente)
├── docs/plan.md              # questo file
├── src/
│   ├── index.ts              # factory: registra comandi, tool, eventi, widget
│   ├── config/
│   │   ├── specs-kit-config.ts    # lettura specs-kit.yaml (subset tipizzato)
│   │   └── config-writer.ts       # update chirurgico modelli/thinking per ruolo
│   ├── tasks/
│   │   ├── task-parser.ts         # frontmatter YAML + body markdown
│   │   └── task-loader.ts         # scansione tasks/*.md, ordinamento, filtri range
│   ├── fixplan/
│   │   ├── fix-plan.ts            # tipi + load/save atomico
│   │   └── refresh.ts             # rigenerazione da task files (Created/Updated/Nothing)
│   ├── measure/
│   │   ├── ledger.ts              # registro append-only: tipi riga + append
│   │   ├── usage.ts               # estrazione usage dai messaggi assistant sullo stream
│   │   ├── wal.ts                 # buffer write-ahead grezzo (~/.pi/agent/specs-kit/)
│   │   ├── phase-meter.ts         # consolidamento per fase: ledger + potatura WAL
│   │   └── authoring-window.ts    # finestre di authoring: open/close/attribuzione
│   ├── prompt/
│   │   ├── prompt-builder.ts      # prompt di fase: skill, KB, memory, hooks
│   │   └── skill-resolver.ts      # path skill per fase (~/.agents/skills, ~/.pi/…)
│   ├── agent/
│   │   ├── spawner.ts             # spawn pi --print --mode json, timeout, kill tree
│   │   ├── json-stream.ts         # parsing JSONL → eventi di sessione
│   │   ├── stream-format.ts       # riga singola per log e widget
│   │   └── assistant-stream.ts    # ricostruzione del messaggio dai delta
│   ├── loop/
│   │   ├── engine.ts              # orchestrazione run: selezione, resume, stop
│   │   ├── run-setup.ts           # caricamento task, range, fix plan, force
│   │   ├── task-runner.ts         # costruisce il runtime del task e delega all'interprete del grafo
│   │   ├── step-order.ts          # ordine delle fasi per-task e confronti resume
│   │   ├── graph/                 # grafo dichiarato: tabella, predicate, interprete e azioni dei nodi
│   │   │   ├── types.ts           #     tipi: nodi, edge, contesto di routing, runtime del task
│   │   │   ├── conditions.ts      #     registry chiuso delle predicate di routing
│   │   │   ├── interpreter.ts     #     interprete first-match-wins con sink
│   │   │   ├── task-nodes-cycle.ts #    azioni dei nodi del ciclo (entry, implementation, review, gate, funnel)
│   │   │   ├── task-nodes-tail.ts #     azioni della coda (cleanup, learner, sync, update_done, checkpoint)
│   │   │   ├── task-graph.ts      #     tabella nodi/edge dichiarata (dati, in ordine di valutazione)
│   │   │   └── run-graph.ts       #     nodo run-level final_sync (guardia dal registry, compaction inclusa)
│   │   ├── review-runner.ts       # sub-loop review con retry del report
│   │   ├── review-report.ts       # path, parsing e feedback del report review
│   │   ├── loop-status.ts         # snapshot di stato per widget e comandi
│   │   ├── phases.ts              # implementation/review/cleanup/sync/learner
│   │   ├── hooks.ts               # esecuzione hook pre/post (shell, timeout)
│   │   ├── learner.ts             # estrazione learnings a fine task
│   │   └── checkpoint.ts          # commit checkpoint (se no_commit=false)
│   ├── ui/
│   │   ├── widget.ts              # widget stato live sopra l'editor
│   │   ├── attach-view.ts         # guscio della trascrizione (ctx.ui.custom)
│   │   ├── transcript.ts          # eventi → componenti di rendering di pi
│   │   ├── config-view.ts         # picker modelli/thinking per ruolo → yaml
│   │   └── pickers.ts             # select spec, range, fase
│   ├── tools/
│   │   └── loop-tools.ts          # tool LLM: start/stop/status/refresh
│   └── util/
│       ├── log-writer.ts          # log stream su _ralph_loop/logs/
│       └── process.ts             # spawn helper, kill tree, elapsed
├── test/
│   ├── task-parser.test.ts
│   ├── fix-plan.test.ts
│   ├── refresh.test.ts
│   ├── config.test.ts
│   ├── prompt-builder.test.ts
│   ├── state-machine.test.ts
│   └── hooks.test.ts
└── e2e/
    ├── fake-bin/pi             # script: emette JSONL realistico, scrive review file
    └── loop.e2e.test.ts        # loop 2-3 task completo con fake pi su PATH
```

Regola di granularità: un file per responsabilità, ~max 250 LOC per file.

## 3. Formati dati

### 3.1 Task file (`tasks/TASK-NNN.md`)

Frontmatter YAML riconosciuto:

| campo | tipo | note |
|---|---|---|
| `id` | string | obbligatorio, formato `TASK-NNN` |
| `title` | string | obbligatorio |
| `spec` | path | riferimento alla spec |
| `lang` | string | es. `nestjs`, `go` |
| `status` | enum | `pending`, `implemented`, `reviewed` |
| `dependencies` | string[] | id task prerequisiti |
| `ac-mapping`, `imp-requirements` | string[] | tracciamento (pass-through) |
| `implemented_date`, `reviewed_date` | date | aggiornate dalle fasi |

Il body markdown è passato al prompt builder così com'è.

### 3.2 Fix plan (`<spec>/_ralph_loop/fix_plan.json`)

Shape da leggere/scrivere (compatibile con quella esistente):

```json
{
  "spec_id": "034-mes-listing-fasi-reparto",
  "spec_folder": "docs/specs/034-mes-listing-fasi-reparto",
  "default_agent": "pi",
  "tasks": [{ "id": "TASK-001", "file": "tasks/TASK-001.md", "title": "…", "lang": "nestjs", "status": "reviewed" }],
  "done": ["TASK-001"],
  "pending": ["TASK-009"],
  "superseded": null,
  "optional": null,
  "learnings": ["…"],
  "task_range": { "from": null, "from_num": 0, "to": null, "to_num": 999, "total_in_range": 10 },
  "range_progress": { "done_in_range": 7, "percent": 70, "total_in_range": 10 },
  "state": {
    "step": "implementation",
    "current_task": "TASK-009",
    "current_task_file": "tasks/TASK-009.md",
    "current_task_lang": "nestjs",
    "iteration": 8,
    "retry_count": 0,
    "review_file_error": null,
    "review_file_retry": 0,
    "error": null,
    "last_updated": "…"
  },
  "last_updated": "…"
}
```

Regole:
- salvataggio **atomico** (write tmp + rename) dopo ogni transizione di stato;
- `refresh` ricostruisce `tasks[]`/`pending` dai frontmatter preservando
  `done`, `learnings`, `state` coerenti; esito: `Created` | `Updated` | `Nothing to refresh`;
- il loop riprende da `state` con `--resume` (o riparte con `--force`).

### 3.3 Config (`specs-kit.yaml`, subset)

```yaml
version: "1"
specs_dir: docs/specs
spec: docs/specs/<spec-attiva>
mode: fast                      # fast mode
poll_interval: 100ms
agents:
  agent: <ignorato>             # sempre pi
  agent_model: "provider/id"
  agent_thinking_level: low|medium|high|…
  reviewer_model: …             # idem per reviewer, cleaner, synchronizer, learner
run:
  max_attempts: 5
  timeout: 60m
  no_commit: true
  yolo: true
  debug_stream: true
  no_log_files: false
  show_prompt: true
  skill_content: true
  verbose: false
  continue_on_failure: false
  reconcile_context: false      # opt-in: sync corregge i doc sorgente contraddetti dai learnings
  from_task: / to_task: / resume: / review_file_retry:
git:
  baseBranch: main
hooks:
  timeout: 240s
  implementation: { pre: [...], post: [...] }
  review:         { pre: [...], post: [...] }
  cleanup:        { pre: [...], post: [...] }
  sync:           { pre: [...], post: [...] }
knowledge_base:
  files: ["./docs/...", ...]
prompts:
  system_overrides:
    unsupported_policy: error
    agent_phase:
      pi:
        implementation: { mode: append, source: file, file: <path> }
        review:         { mode: append, source: file, file: <path> }
        cleanup:        { mode: append, source: file, file: <path> }
        sync:           { mode: append, source: file, file: <path> }
```

`mode` accetta `append` (il testo si aggiunge al system prompt dell'agente) o
`replace` (lo sostituisce); `source` accetta `file` (`file: <path>` relativo
alla root del progetto) o `text` (`text: <contenuto inline>`). Tutte e quattro
le combinazioni sono supportate. `unsupported_policy` decide cosa fare quando
un override non è applicabile — file illeggibile, o `file`/`text` mancante per
il `source` scelto: `error` interrompe il loop, `skip` emette un warning e
prosegue senza override.

- campi ignoti ignorati senza errore (tolleranza forward-compat);
- ruoli: `agent` (implementation), `reviewer` (review), `cleaner` (cleanup),
  `synchronizer` (sync), `learner` (estrazione learnings);
- modello default `"auto"` se assente; thinking default da config pi.
- `spec:` è la **Spec attiva** (first-class, persistente): unica spec persistita,
  default per ogni comando/tool quando `--spec` manca, impostata automaticamente
  alla creazione di una nuova spec (vedi §12).

### 3.4 Registro delle misure (`<specs_dir>/measurements.jsonl`)

Ledger **append-only** versionato col progetto, accanto alle directory delle
spec. Non è stato del loop: perderlo non impedisce di ripartire (vedi
`docs/adr/0007`). Una riga JSON per record, due tipi:

```json
{"v":1,"kind":"phase","ts":"…","spec":"001-spec","task":"TASK-001","phase":"implementation","attempt":2,"role":"agent","model":"provider/id","duration_ms":61234,"usage":{"input":300,"output":30,"cache_read":0,"cache_write":0,"total":330},"cost_total":0.012}
{"v":1,"kind":"authoring","ts":"…","spec":"001-spec","started_at":"…","duration_ms":900000,"usage":{…},"cost_total":0.34}
```

- `phase`: una riga per fase eseguita (learner e compact inclusi); `duration_ms`
  copre l'intero step (pre-hook, sottoprocesso, post-hook); `model` è quello
  osservato sullo stream, con fallback su quello configurato per il ruolo;
  `usage` è la somma dei `message_end` assistant della fase (messaggi senza
  usage contano zero).
- `authoring`: una riga per finestra di authoring (vedi `CONTEXT.md`), con la
  prima finestra attribuita retroattivamente quando la spec diventa attiva.

Le righe grezze per messaggio vivono nel buffer write-ahead
`~/.pi/agent/specs-kit/measurements-wal.jsonl` (fuori dal progetto, così i
checkpoint non le versionano): una fase killata a metà lascia lì il suo
consumo; le righe di una fase/finestra conclusa vengono potate. Ogni I/O di
misura è best-effort: un fallimento emette un warning e disattiva la misura,
senza mai interrompere il loop.

## 4. Moduli

### 4.1 `config/specs-kit-config.ts`
Parsing yaml → oggetto tipizzato con default; ricerca del file nel cwd del
progetto (`specs-kit.yaml`, override `--config`); risoluzione path relativi
alla root del progetto.

### 4.2 `config/config-writer.ts`
Aggiornamento dei soli campi `agents.<ruolo>_model` / `agents.<ruolo>_thinking_level`
riscrivendo il documento YAML (i commenti possono andare persi: la TUI diventa
l'interfaccia di editing). Write atomico + backup `.bak` una tantum per run.

### 4.3 `tasks/task-parser.ts` + `task-loader.ts`
Frontmatter con parser YAML tollerante; validazione campi obbligatori con
errori puntuali (file + campo). Loader: lista ordinata per numero, filtro
`from_task`/`to_task` inclusivo, controllo dipendenze (task con dipendenze
non soddisfatte nel range → warning a inizio loop).

### 4.4 `fixplan/fix-plan.ts` + `refresh.ts`
Tipi, load (tollerante a campi mancanti), save atomico, calcolo
`range_progress`. Refresh: confronto task files vs fix plan → nuovo documento;
esito testuale esatto: `Created` / `Updated` / `Nothing to refresh`.

### 4.5 `prompt/prompt-builder.ts` + `skill-resolver.ts`
Prompt di fase in formato XML-like:

```
<task id file title lang>
<body markdown del task>
<skill_content>             # contenuto SKILL.md della skill di fase
<skill_path>                # path assoluto della skill dir (per file referenziati)
<knowledge_base>            # lista path da knowledge_base.files
<memory>                    # learnings dal fix plan (se presenti)
<hooks>                     # esiti hook pre (se rilevanti)
<review_feedback>           # solo retry dopo review negativa
<upstream_contracts>        # contratti `provides` dei task dipendenza già completati
<routed_suggestions>        # fix che review precedenti hanno routed a questo task
<project_learnings>         # learnings consolidati a livello progetto
<phase_instructions>        # contratto d'uscita della fase (vedi §5)
```

Skill per fase: `specs-kit-task-implementation`, `specs-kit-task-review`,
`specs-kit-code-cleanup`, `specs-kit-sync`. Risoluzione in ordine: **dir del fork bundled**
(`skills/<nome>/SKILL.md` dentro l'estensione, risolto via `import.meta.url`),
poi `~/.agents/skills/<nome>/SKILL.md`, poi `~/.pi/agent/skills/<nome>/SKILL.md`.
Leggere il fork direttamente dal resolver — e non dalla discovery `/skill:` di pi —
fa sì che il loop usi sempre la versione pi-nativa, aggirando le collisioni di
nome (vedi §11). Mancanza skill → warning e prompt senza blocco skill.
`skill_content: false` → solo `<skill_path>` senza contenuto inline.

### 4.6 `agent/spawner.ts` + `json-stream.ts`
Comando fase:

```
pi --print --mode json --no-session \
   --model <ruolo_model> --thinking <ruolo_thinking> \
   [--append-system-prompt <contenuto file override>] \
   <prompt>
```

- parsing JSONL stdout → eventi di sessione, inoltrati senza ridurli: la
  trascrizione li dà ai componenti di rendering, log e widget passano invece
  per la formattazione a riga singola;
- stderr catturato nel log;
- timeout fase da `run.timeout` → SIGTERM → SIGKILL al process tree;
- `stop` utente: kill controllato (stesso path);
- exit code + rilevamento review file determinano successo/fallimento fase.

**Esiti spike M0** (rivisti su uno stream catturato con pi 0.84):
- gli eventi `--mode json` sono gli eventi di sessione della modalità
  interattiva serializzati, non un formato a sé: `session`, `agent_start`,
  `turn_start`, `message_start`, `message_update`, `message_end`,
  `tool_execution_start`, `tool_execution_update`, `tool_execution_end`,
  `turn_end`, `agent_end`, `agent_settled`. La prima stesura ignorava i tre
  eventi di tool, che nella pratica sono la parte più corposa dello stream;
- `message_update` porta solo `assistantMessageEvent`: lo snapshot cumulativo
  del messaggio, disponibile in interattivo, sul wire non c'è. Il messaggio va
  ricostruito dai delta (`text_*`, `thinking_*`, `toolcall_*`);
- i messaggi `role: "toolResult"` ripetono l'output di un tool già arrivato con
  `tool_execution_end`: si deduplica su `toolCallId`;
- messaggi assistente con `stopReason` (`error` su fallimento provider) ed
  `errorMessage`; parser tollerante obbligatorio: tipi ignoti inoltrati
  comunque e registrati nel log come JSON;
- `--append-system-prompt <text>` accetta testo o contenuto di file
  (gestito da pi); usiamo comunque il fallback di leggere noi il file e
  passare il contenuto, così gli errori di path sono nostri e chiari;
- in `--print` non c'è UI di approvazione: i tool girano senza conferma;
  resta disponibile `--tools` come allowlist di emergenza;
- il modello della fase va passato sempre con `--model` esplicito:
  in modalità efimera (`--no-session`) pi riusa comunque l'ultimo modello
  noto se il flag manca.

### 4.7 `loop/hooks.ts`
Esecuzione sequenziale dei comandi pre/post della fase con shell di sistema,
cwd = root progetto, timeout `hooks.timeout`. Pre fallito → fase bloccata
(conta come tentativo fallito). Post fallito → warning, si prosegue.

### 4.8 `loop/engine.ts` — state machine

Stati per task: `choose_task → implementation → review → (fix?) → cleanup → learner → sync → update_done`.

- **implementation**: pre-hooks → spawn ruolo `agent` → post-hooks.
  Fallimento → retry fino a `max_attempts` (`state.retry_count` persistito).
- **review**: spawn ruolo `reviewer`; la fase deve produrre
  `tasks/<TASK>--review.md`; assenza → `review_file_retry` incrementale
  (re-spawn) fino al limite; esito negativo (review respinge) → ritorno a
  implementation con `<review_feedback>` nel prompt, entro `max_attempts`.
  Prima di sovrascrivere il report canonico, il verdetto precedente viene
  archiviato come `tasks/<TASK>--review.attempt-N.md` (vedi CONTEXT.md):
  un retry non cancella più silenziosamente la cronologia dei verdetti.
- **cleanup**: saltata in `mode: fast`; ruolo `cleaner`.
- **learner**: ruolo `learner`, estrae learnings del task → append a
  `learnings[]` nel fix plan (deduplicati, max N voci con rotazione).
- **sync**: in fast mode solo dopo l'ultimo task del range; ruolo `synchronizer`. Con `run.reconcile_context: true` e learnings presenti, sync corregge anche la singola istruzione contraddetta in AGENTS.md/architecture.md/ontology.md/.pi/rules (vedi ADR `docs/adr/0008`).
- **update_done**: task → `done[]`, status frontmatter `reviewed` (+ date),
  `range_progress` ricalcolato, save fix plan.
- **checkpoint**: se `no_commit: false` → commit `checkpoint: <task> attempt N`.
- Esauriti i tentativi → `state.error`, halt del loop (o task successivo se
  `continue_on_failure: true`).
- Ogni transizione → save atomico fix plan (resume sicuro a qualsiasi kill).
- `run.resume` / `--resume`: riparte da `state`; `--force`: azzera e riparte.

### 4.9 UI

**Widget** (`ctx.ui.setWidget("specs-kit", …)`, aggiornato su eventi loop):

```
● 034-mes-listing-fasi-reparto — TASK-009 · review · tentativo 2/5 · done 7/10 (70%) · 12:34
  ultima riga stream dell'agente…
```

Nascosto quando il loop è idle. Notifiche (`ctx.ui.notify`) su: cambio task,
review negativa, halt, completamento range.

**Comandi**:

| comando | argomenti | comportamento |
|---|---|---|
| `/specs-kit-run` | `[--spec p] [--from-task T] [--to-task T] [--phase f] [--resume] [--force]` | avvia il loop; picker spec/fase/range se assenti; errore se loop già attivo |
| `/specs-kit-stop` | `[--now]` | default: stop graceful a fine fase; `--now`: kill immediato |
| `/specs-kit-status` | — | stato dettagliato (step, retry, ultimo errore, log path) |
| `/specs-kit-refresh` | `[--spec p]` | refresh fix plan; stampa esito |
| `/specs-kit-attach` | — | vista fullscreen streaming (vedi sotto) |
| `/specs-kit-config` | — | picker modelli/thinking per ruolo → scrive yaml |
| `/specs-kit-spec` | `[<dir> \| --spec p]` | imposta/verifica la Spec attiva su `specs-kit.yaml`; picker incluse le spec senza `tasks/` |
| `/specs-kit-new` | — | avvia il brainstorm (skill fork) per una nuova specifica; al termine imposta la spec come attiva |
| `/specs-kit-continue` | — | dato lo stato della Spec attiva, propone il passo successivo della catena di authoring (fino a `tasks/`) |

**Attach view** (`ctx.ui.custom`): fullscreen con stream renderizzato del
sottoprocesso corrente (testo assistente + tool call compattate), footer con
task/fase/elapsed; `q` chiude (il loop prosegue), `ctrl+c` interrompe la fase
(conta come fallimento fase).

**Config view**: elenco dei 5 ruoli → per ognuno picker modello
(da `ctx.scopedModels` se popolato, altrimenti `ctx.modelRegistry`) e thinking
level; conferma → `config-writer` su `specs-kit.yaml` + reload config in memoria.

### 4.10 Tool LLM (`tools/loop-tools.ts`, `tools/authoring-tools.ts`)

| tool | parametri | effetto |
|---|---|---|
| `specs_kit_loop_start` | `spec?, from_task?, to_task?, phase?, resume?, force?` | avvia il loop in background; ritorna subito con stato iniziale |
| `specs_kit_loop_stop` | `now?` | stop graceful/immediato |
| `specs_kit_loop_status` | — | JSON stato corrente (spec, task, fase, retry, progress) |
| `specs_kit_refresh` | `spec?` | refresh fix plan, ritorna esito |
| `specs_kit_set_active_spec` | `spec_dir` | persiste la Spec attiva su `specs-kit.yaml` (chiamato dall'agente al termine del brainstorm) |

I tool girano nella sessione host: nessuna attesa bloccante; il loop emette
eventi → widget/notifiche. Guardia: un solo loop per sessione anche via tool.

**Pre-flight graphify.** `LoopController.start` verifica la presenza della
skill esterna graphify (unica fonte del grafo del codebase, `graphify-out/graph.json`,
lettura diretta, senza file per-spec proiettato) e, se manca, emette un warning
`[specs-kit]`: il loop prosegue, ma le feature che leggono il grafo restano
indisponibili. Il resolver è iniettabile (`ControllerDeps.findGraphifySkill`);
dettagli e motivazione in `docs/adr/0009`.

### 4.11 `measure/*`

Registro delle misure (formato in §3.4). `phase-meter.ts` è agganciato al
`PhaseExecutor` (choke point di ogni spawn): accumula l'usage dei `message_end`
nel WAL e a fine fase scrive la riga consolidata e pota il buffer. Il meter è
iniettabile nell'engine (`EngineDeps.meter`) per i test.
`authoring-window.ts` vive nella sessione host (`src/index.ts`): apre le
finestre sui comandi di authoring, le chiude al comando specs-kit successivo o
a `session_shutdown`, osserva i `message_end` della sessione interattiva e
attribuisce retroattivamente le finestre prive di spec quando la spec diventa
attiva (`LoopController.onActiveSpecChanged`).

## 5. Contratti d'uscita delle fasi

- **implementation**: codice modificato nel workspace; hook post verificano build/lint.
- **review**: file `tasks/<TASK>--review.md` con verdetto (approva/respingi +
  motivazioni). Il loop rileva il file; verdetto negativo parsato dal report.
- **cleanup**: nessun artefatto obbligatorio; hook pre come gate.
- **sync**: aggiornamenti documentali nel workspace. Con `reconcile_context` attivo e learnings presenti, anche correzione chirurgica delle istruzioni contraddette nei documenti sorgente (AGENTS.md, architecture.md, ontology.md, .pi/rules), con elenco delle modifiche nel summary.
- **learner**: output testuale → parsato in learnings (bullet list).

## 6. Testing

- **Unit (`node --test`, zero deps, TS nativo Node 24)**: parser task (validi/
  invalidi/edge), fix plan load/save/refresh (Created/Updated/Nothing, preservazione
  done/learnings), config loader+writer (default, campi ignoti, rewrite modelli),
  prompt builder (presenza blocchi, skill mancante, memory), state machine
  (transizioni, retry, halt, fast mode, continue_on_failure, resume),
  hooks (pre blocca, post no, timeout).
- **E2E (`e2e/`)**: `fake-bin/pi` = script eseguibile che emula `--mode json`
  (JSONL di eventi), scrive il review file quando il prompt contiene il marker
  di review, fallisce N volte su richiesta (env var) per testare retry/halt.
  Scenario: spec finta con 3 task → loop completo, fix plan finale atteso,
  resume da kill a metà.
- **Validazione manuale**: run reale su una spec di test in un progetto reale,
  confronto del fix plan con la shape attesa.

## 7. Milestone

| # | milestone | output verificabile |
|---|---|---|
| M0 | Spike subprocesso | script standalone che spawna `pi --print --mode json` e stampa eventi parsati; note su flag nel piano |
| M1 | Skeleton package | `pi -e src/index.ts` carica, `/specs-kit-status` risponde, `/reload` ok |
| M2 | Config + writer | test config verdi; `/specs-kit-config` scrive yaml |
| M3 | Parser + fix plan + refresh | test verdi; `/specs-kit-refresh` su spec reale |
| M4 | Prompt builder | test verdi; prompt ispezionabile con `show_prompt` |
| M5 | Spawner + JSONL | fake pi e2e harne<br/>ss verde; log file scritti |
| M6 | Engine loop | e2e fake: 3 task completi, retry, halt, resume |
| M7 | Widget + comandi run/stop/status | loop reale visibile in TUI |
| M8 | Attach view | streaming fullscreen + interrupt |
| M9 | Tool LLM | "avvia il loop sulla spec X" da prompt naturale |
| M10 | Learner + checkpoint + polish | learnings nel fix plan; README, AGENTS.md |
| M11 | Fork skill + discovery | `skills/` bundled caricato da pi via `resources_discover`; `skill-resolver` punta al fork; phase-skill injection funzionante sotto pi |
| M12 | Authoring chain | `/specs-kit-new` + `/specs-kit-continue` via skill fork; catena spec-check→technical-plan→spec-to-tasks end-to-end su spec finta |
| M13 | Spec attiva | campo `spec:` persistente, auto-set su creazione, `/specs-kit-spec` picker, `listSpecs` incluse spec senza `tasks/` |

Ordine interno alle milestone: test prima del cablaggio UI. M11 è prerequisito
di M12 (le skill di authoring sono il fork) e va anticipato rispetto a M7, perché
le phase-skill oggi sono già rotte sotto pi e il loop reale le usa da lì in poi.

## 8. Rischi e mitigazioni

| rischio | mitigazione |
|---|---|
| schema eventi `--mode json` non documentato | M0 spike + parser tollerante (campi opzionali, unknown → raw log) |
| tool non auto-approvati in `--print` | spike M0; fallback: flag di tool-allowlist o conferma via stdin se supportata |
| skill expansion non attiva in print mode | non ci affidiamo: contenuto skill iniettato nel prompt + path dir |
| kill del process tree su macOS/Linux | `process.kill(-pid)` con detached group; test e2e dedicato |
| fix plan corrotto da scrittura concorrente | save atomico tmp+rename; lock in memoria (un loop per sessione) |
| drift di comportamento rispetto al loop attuale | e2e con fix plan attesi; validazione manuale su spec reale |
| collisioni di nome skill: le `specs-*` globali shadowano il fork bundled | skill di fase lette dal fork via `skill-resolver`; authoring rinominato in `specs-kit-*` o documentata rimozione delle globali (v. §11) |

## 9. Fuori scope (v1)

Notifiche Telegram, dashboard standalone, agenti non-pi, multi-loop paralleli,
migrazione assistita yaml, vista diff delle modifiche del task. Skill del kit
non forkate: `change-spec` (modifiche a sistemi esistenti) e `task-manage`
(split/aggiunta di task dopo la generazione) — fuori dal perimetro di questa
estensione (loop + catena di creazione di spec nuove).

## 10. Materiale di riferimento (specs-kit-cli)

Il comportamento da replicare è quello del comando `task run` del CLI Go in
`~/project/GT/specs-kit-cli` (la skill `ralph-loop` è deprecata). I file si
leggono per allineare la semantica; non si copia codice e non si cita il
progetto nei sorgenti (vedi §1).

### Loop e state machine

| file | cosa prendere |
|---|---|
| `cmd/specs-kit/task_run.go` | wiring dei flag (`--resume`, `--force`, `--from-task`, `--to-task`, `--phase`, `--max-attempts`…) sulla config di run |
| `internal/coreengine/taskrun/orchestrate.go` | ciclo sui task del range: prepare → execute → learner → checkpoint → finish; bivio fast mode |
| `internal/coreengine/taskrun/execute.go` | dispatch del singolo task: skip-done, resume, partenza da fase specifica, fresh run |
| `internal/coreengine/taskrun/prepare.go` | caricamento/validazione task, filtro range, discovery/creazione fix plan |
| `internal/coreengine/taskrun/resume.go` | ripresa da stato persistito |
| `internal/coreengine/taskrun/range.go` | ricalcolo `range_progress`, riallineamento done/pending |
| `internal/coreengine/taskrun/finish.go` | riepilogo finale del run |
| `internal/coreengine/taskrun/phase.go` | parsing `--phase` e stato di partenza per fase |
| `pkg/domain/state.go` | stati del task (`init`…`done`/`failed`) e transizioni valide |
| `internal/coreengine/statemachine/` | macchina a stati per task con listener e validazione delle transizioni |

### Self-healing (cuore del loop)

| file | cosa prendere |
|---|---|
| `internal/coreengine/selfhealing/healer.go` | loop implementation↔review: tentativi, snapshot per tentativo, esaurimento retry |
| `internal/coreengine/selfhealing/healer_outcomes.go` | contratto outcome runner→healer (file cambiati, esiti hook) |
| `internal/coreengine/selfhealing/review_frontmatter.go`, `review_parser.go`, `review_validator.go` | frontmatter review: `review_status: PASSED\|FAILED`, issue counts, summary |
| `internal/coreengine/selfhealing/task_status_sync.go` | sync dello status nel frontmatter del task dopo review PASSED |
| `internal/coreengine/taskrun/selfhealing.go` | wiring del loop con file-change detector e rate limit |
| `internal/coreengine/taskrun/review_phase.go` | runner review: hook pre/post, retry su file mancante, parse del verdetto |
| `internal/coreengine/taskrun/review_files.go` | rimozione review stale, validazione strict del frontmatter |

### Fasi post-review, learner, checkpoint

| file | cosa prendere |
|---|---|
| `internal/coreengine/taskrun/post_review.go` | cleanup→sync→update_done esteso; fast mode: skip cleanup/update_done, sync solo sull'ultimo task |
| `internal/coreengine/taskrun/cleanup.go`, `sync.go` | le due fasi post-review |
| `internal/coreengine/taskrun/learner.go` | estrazione learnings a fine task, append al fix plan e al knowledge-graph |
| `internal/coreengine/memory/` (store, extractor, xml_builder) | persistenza learnings e blocco `<memory>` |
| `internal/coreengine/checkpoint/checkpoint.go` | commit checkpoint per task (skip se `no_commit`) |

### Persistenza

| file | cosa prendere |
|---|---|
| `internal/coreengine/persistence/fixplan_creator.go` | shape `fix_plan.json` (tasks/state/range_progress) e scrittura atomica tmp+rename |
| `internal/coreengine/persistence/fixplan_refresh.go`, `fixplan_refresh_create.go` | refresh dai task files; esiti `Created` / `Updated` / `Nothing to refresh` |
| `internal/coreengine/persistence/filestore.go` | state file per task (qui fuso nel blocco `state` del fix plan) |
| `internal/coreengine/persistence/fixplan_migration.go` | tolleranza a campi mancanti |

### Prompt e subprocesso agente

| file | cosa prendere |
|---|---|
| `internal/coreengine/agent/prompt_builder.go` | prompt XML per fase: context, review_context, skill_content, knowledge_base, hooks, memory, changed_files |
| `internal/coreengine/agent/command_builder.go` | comando slash per fase |
| `internal/coreengine/prompt/` (implementation, review, cleanup, sync, common, knowledge_base) | constraints/instructions/output contract/verification per fase |
| `internal/coreengine/agent/system_prompt_override.go` | override del system prompt per ruolo/fase (`prompts.system_overrides`) |
| `internal/coreengine/agent/executor.go` | spawn del subprocesso con timeout, cattura stdout/stderr, prefissi per riga |
| `internal/coreengine/agent/stream.go` | parsing eventi JSONL → righe formattate per la vista |
| `internal/coreengine/logging/` | log per fase su file |

### Hook, task, config

| file | cosa prendere |
|---|---|
| `internal/coreengine/hooks/` (runner, xml_builder) | esecuzione comandi pre/post con timeout, blocco `<hooks>` nel prompt |
| `internal/coreengine/taskrun/hooks.go` | wiring hook per fase/stage, timeout di default |
| `internal/taskmanagement/parser/parser.go`, `loader/` | frontmatter dei task, scansione/ordinamento/validazione |
| `pkg/domain/task.go` | shape del task (id, title, spec, lang, status, date, dependencies) |
| `internal/config/config.go`, `atomic_persist.go`, `prompt_overrides.go` | `specs-kit.yaml`: ruoli/modelli, hooks, run flags, knowledge base, override prompt; persistenza atomica |

## 11. Fork delle skill e discovery (`docs/adr/0001`, `docs/adr/0002`)

Le `specs-*` skill sono sagomate per Claude Code (`Task` subagent, `TodoWrite`,
`AskUserQuestion`, `${CLAUDE_PLUGIN_ROOT}`) e non girano sotto pi: l'iniezione
delle skill di fase nel prompt è quindi **già rotta oggi**, non solo nel flusso di
creazione. Si fa quindi un fork pi-nativo di otto `specs-*`, adattato ed
esposto via `resources_discover` così che un solo install fornisca tutta la
catena authoring + esecuzione. I blocchi `Task(subagent_type: …)` diventano
istruzioni inline per lo stesso agente (l'unica parte non meccanica del port:
calcolo di qualità accettato, vedi `docs/adr/0002`).

**Esito spike di fattibilità (verificato a runtime su pi):**

- `resources_discover` accetta `skillPaths` e li carica (`dist/core/skills.js`,
  funzione `loadSkills`).
- `import.meta.url` risolve la directory dell'estensione installata: è il pattern
  canonico dell'esempio ufficiale `dynamic-resources`. Implementazione:
  ```ts
  const baseDir = dirname(fileURLToPath(import.meta.url));
  pi.on("resources_discover", () => ({ skillPaths: [join(baseDir, "skills")] }));
  ```
- `skillPaths` accetta una **directory**: la scoperta è ricorsiva su ogni
  `SKILL.md` (`loadSkillsFromDirInternal`). Un'unica voce `skills/` basta per
  tutte le skill forkate.

**Caveat critico — collisioni di nome (verificato a runtime).** pi risolve le
collisioni con "first found wins" e i path di default (`~/.pi/agent/skills`,
`~/.agents/skills`) sono uniti **prima** di quelli dell'estensione
(`resource-loader.js`, `extendResources`). Se l'utente ha già le `specs-*`
globali installate, **le globali vincono** e il fork bundled viene shadowed:
confermato empiricamente (skill spike con nomi collidenti caricate come versione
globale; solo quelle con nome univoco sono arrivate dal bundle).

Mitigazione a due binari:

- **Skill di fase del loop** (`implementation/review/cleanup/sync`): il loop le
  inietta nel prompt leggendo il `SKILL.md` direttamente via `skill-resolver`
  (§4.5), non tramite la discovery `/skill:` di pi. Puntando il resolver al dir
  del fork (`import.meta.url`) il loop usa il fork a prescindere dalla
  collisione. Questo **fixa già oggi** il bug latente delle phase-skill.
- **Skill di authoring** (`brainstorm`, `spec-check`, `technical-plan`,
  `spec-to-tasks`, ecc.): sono invocate dall'utente o dall'agente come
  `/skill:<nome>`, quindi passano dalla discovery di pi dove la collisione le
  shadowa. Serve una delle due: (a) **rinominare** il fork in un namespace non
  collidente (famiglia `specs-kit-*`, coerente coi comandi `/specs-kit-*`) e
  aggiornare i riferimenti incrociati tra skill; (b) documentare che
  l'estensione **sostituisce** le `specs-*` globali e chiedere all'utente di
  rimuoverle (pi emette già un warning di collisione). **Deciso: (a)** — il fork
  viene distribuito come famiglia `specs-kit-*`, non collidente con le globali
  (vedi `docs/adr/0003`).

## 12. Catena di authoring e Spec attiva (post-grilling)

Oltre al loop di esecuzione, l'estensione copre l'authoring di una spec e la
scelta della spec attiva.

**Crea.**

- `/specs-kit-new` → avvia la skill di brainstorm (fork) per produrre una nuova
  specifica funzionale; al termine imposta la spec come attiva.
- `/specs-kit-continue` → derivato dagli artefatti esistenti: dato lo stato della
  spec attiva, propone il passo successivo della catena
  (brainstorm → spec-check → technical-plan → spec-to-tasks, fino a `tasks/`).

**Scegli (Spec attiva).** La Spec attiva è first-class e persistente (vedi
`CONTEXT.md`): il campo `spec:` di `specs-kit.yaml` è l'unica persistita.

- comando `/specs-kit-spec` per sceglierla/verificarla;
- default per tutti i comandi e i tool quando `--spec` non è passato;
- impostata automaticamente alla creazione di una nuova spec;
- `listSpecs` (picker) include anche le spec senza `tasks/` (non ancora pronte
  per il loop).

**Cross-cutting.** Fork delle otto skill committed in `skills/` (canonico:
nessuno snapshot né transform script), adattato a pi — namespace `specs-kit-*`,
glue host rimosso, dispatch subagent inline-izzato (v. ADR-0002/0003);
`skill-resolver` ripuntato al fork bundled; collisione di nome gestita come da §11.
