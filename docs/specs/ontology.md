# Project Ontology — Ubiquitous Language

**Created**: 2026-08-17
**Last Updated**: 2026-08-17

## Domain Glossary

| Term | Definition | Bounded Context |
|------|-----------|-----------------|
| Consegna del run | Il passo post-run che, a loop completato e con il flag di consegna attivo, committa le modifiche residue, spinge il ramo e apre la pull request. _Avoid_: publish, release, deploy | Loop / consegna |
| Flag di consegna | Opzione di configurazione che abilita la consegna automatica a fine loop; default spento. _Avoid_: auto-PR, publish flag | Configurazione / consegna |
| Ramo della spec | Ramo dedicato creato o riusato dalla consegna quando il ramo di lavoro coincide col ramo base, nominato a partire dall'identificatore della spec (`specs/<spec-id>`). _Avoid_: feature branch, ramo di lavoro | Consegna |
| Ramo base | Ramo di destinazione della pull request, letto dalla configurazione del progetto. _Avoid_: main hardcodato | Configurazione / consegna |
| Forge | La piattaforma di hosting del codice raggiunta tramite la sua CLI per aprire la pull request. _Avoid_: GitHub hardcodato, provider | Consegna |

## Bounded Contexts

| Context | Description | Key Terms |
|---------|-------------|-----------|
| Consegna | Il passo deterministico post-run che porta il lavoro del loop su una pull request reviewable: ispezione del repository, ramo, commit, push, creazione della PR. Mai delegato a un agente. | Consegna del run, Flag di consegna, Ramo della spec, Ramo base, Forge |
| Configurazione | Il file yaml del progetto: flag di consegna, ramo base, ruoli e limiti del run. | Flag di consegna, Ramo base |

## Conceptual Mapping

- La **consegna del run** viene eseguita solo al termine *completato* del loop; halt e stop la saltano e lo dichiarano nella notifica di chiusura.
- Il **flag di consegna** abilita la consegna e implica il commit finale anche quando i checkpoint per task sono disattivati.
- Il **ramo della spec** nasce solo quando il loop ha lavorato sul **ramo base**; altrimenti la PR parte dal ramo di lavoro corrente.
- La **forge** è raggiunta solo via CLI con la sessione già autenticata dell'operatore; l'esito (URL della PR) è riportato nelle notifiche e mai persistito nello stato del loop.
