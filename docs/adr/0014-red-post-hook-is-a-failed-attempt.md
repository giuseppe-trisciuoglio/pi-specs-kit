# Un post-hook rosso è un tentativo fallito, per l'implementazione; per le fasi senza retry viene registrato e detto alla chiusura

I post-hook di una fase erano eseguiti ma il loro esito non lo leggeva nessuno: un fallimento
emetteva una warning transitoria, i risultati finivano in `hookResults`, e `hookResults` non era
consumato da alcun chiamante. Conseguenze: un gate post-implementazione rosso (build che non
compila, test rossi) chiudeva la fase come riuscita, il reviewer veniva spawnato su un workspace
rotto e poteva mettere `PASSED` su un task che non compila; il retry successivo ripartiva cieco,
senza l'output del gate.

Decisioni registrate:

- **Il post-hook è un gate: un gate rosso non è seguito da un successo.** L'implementazione ha un
  percorso di retry, quindi reagisce come reagisce già a un pre-hook rosso o a uno spawn fallito:
  il tentativo costa, `state.retry_count` cresce, e `ImplStatus` guadagna il quarto caso
  `post-hook-failed` con il predicato e l'arco simmetrici ai due esistenti (stessa posizione
  relativa, dopo lo spawn-failed). Il predicato `impl_failed_attempts_exhausted` copre il nuovo
  stato a patto che l'ordine degli archi resti quello giusto: l'edge di esaurimento precede i
  back-edge, e un test di ordine lo pinna.
- **L'esito esce dall'esecutore in modo esplicito.** `PhaseStepResult` guadagna `postHooksOk` e
  `failedPostHooks` (i risultati dei soli hook falliti): il nodo non ri-deriva l'esito da
  `hookResults`. La warning transitoria esistente resta.
- **Il tentativo successivo vede che cosa ha rotto.** L'output dei post-hook falliti viaggia in
  `io.runtime.postHookFailures` tra un tentativo e l'altro, entra nel prompt come campo dichiarato
  di `ImplementationPhaseInput` (il file è il contratto d'ingresso: nessun dato entra in un prompt
  senza esserci dichiarato) e viene reso dal prompt builder **nello stesso blocco `<hooks>`**, sotto
  una label che nomina il gate e il tentativo (`post hooks of the previous attempt (failed only):`),
  così il pre-hook di questo tentativo e il post-hook del precedente non si confondono. L'output
  compare solo per gli hook falliti — la regola di resa del blocco è comune a pre-hook e
  post-hook ed è registrata come decisione autonoma in ADR-0022 — e viene troncato con
  lo stesso meccanismo.
- **Le fasi senza retry registrano, non inventano.** Cleanup, sync e la sync di fine range non
  hanno alcun percorso di ritentativo: inventarne uno non è delegato. Per loro il minimo onesto è
  che il rosso non svanisca: il campo `state.postHookGateFailed` (lettura tollerante al campo
  assente, come `graphPartialSync`) registra la fase il cui gate è fallito, e la chiusura del range
  lo riporta con una warning che nomina il gate. Il campo viene azzerato all'avvio del run
  successivo (un resume non deve riportare un fallimento del run precedente) e dopo l'avviso di
  chiusura.
- **Anche la review registra.** Il risultato dei suoi post-hook è visibile solo dentro il suo
  sub-loop, non al grafo, quindi la registrazione avviene lì: il reviewer non scrive codice e la
  fase non ha un percorso di ritentativo proprio, così il gate rosso non cambia il verdetto che il
  reviewer ha espresso ma finisce nello stesso campo di stato delle altre fasi che non possono
  reagire. Nessuna delle tre fasi senza retry lascia più chiudere il range in silenzio.
