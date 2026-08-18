# Grafo dichiarato, seriale, per il loop dei task

Il loop di esecuzione dei task passa da grafo implicito (controllo di flusso in `TaskRunner.run`) a grafo dichiarato come dato: tabella di nodi (agentic e deterministici) ed edge tipizzate con condizioni espresse come predicate nominate in un registry chiuso, eseguita da un piccolo interprete. L'esecuzione resta rigorosamente seriale come scelta architetturale permanente, non come compromesso: con pass-rate per ciclo sotto ~50% (tipico dei task di codifica, ed è il motivo dell'esistenza del retry) un grafo parallelo costa più token di uno seriale per lo stesso numero di cicli.

Documenti di riferimento (letti dopo questo ADR, non prima):

- Decisioni registrate nelle altre fasi: ADR-0012 (contratti I/O per nodo), ADR-0021 (esito della fase 2), ADR-0022 (politica di resa del blocco `<hooks>`).

Decisioni di dettaglio (D0–D8): il funnel dei fallimenti è un nodo deterministico con un solo bivio `continue_on_failure`; il sub-loop review resta un nodo macro che proietta il verdetto; lo stato del fix plan resta centralizzato e le variabili in-flight sono stato di runtime dichiarato ma non persistito; il run-level resta un pattern fisso seriale con la sola sync finale promossa a nodo; i tipi di edge esistono solo dove la routing decision dipende da loro (niente tipi per eventi che non instradano, come l'assenza del grafo del codebase); la tabella vive in TypeScript senza validazione runtime (typebox arriverà solo se la topologia diventerà configurazione esterna); il context firewall si chiude alla firma nella prima fase e a contratti I/O per nodo nella successiva.
