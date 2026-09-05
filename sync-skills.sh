#!/usr/bin/env bash
# Sincronizza le skill di questo progetto (./skills/) verso le directory locali
# usate dagli agenti.
#
# In push ogni sottocartella di ./skills/ viene sincronizzata verso entrambe le
# directory di destinazione. In pull resta invariata la direzione storica da
# ~/.agents/skills verso ./skills/.
#
# Uso:
#   ./sync-skills.sh            # sincronizza verso ~/.agents/skills e ~/.claude/skills
#   ./sync-skills.sh --dry-run  # mostra cosa farebbe senza scrivere nulla
#   ./sync-skills.sh --pull     # direzione inversa (~/.agents/skills -> progetto)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="${SCRIPT_DIR}/skills"
AGENTS_DEST_DIR="${HOME}/.agents/skills"
CLAUDE_DEST_DIR="${HOME}/.claude/skills"

MODE="push"
for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN="--dry-run" ;;
    --pull) MODE="pull" ;;
    -h|--help)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Opzione sconosciuta: ${arg}" >&2
      exit 1
      ;;
  esac
done

DRY_RUN="${DRY_RUN:-}"

if [[ ! -d "${SRC_DIR}" ]]; then
  echo "Cartella sorgente assente: ${SRC_DIR}" >&2
  exit 1
fi
mkdir -p "${AGENTS_DEST_DIR}"
if [[ "${MODE}" == "push" ]]; then
  mkdir -p "${CLAUDE_DEST_DIR}"
fi

if [[ "${MODE}" == "pull" ]]; then
  FROM="${AGENTS_DEST_DIR}"
  TO="${SRC_DIR}"
  echo ">> Pull: ${FROM} -> ${TO}"
else
  FROM="${SRC_DIR}"
  echo ">> Push: ${FROM} -> ${AGENTS_DEST_DIR}"
  echo ">> Push: ${FROM} -> ${CLAUDE_DEST_DIR}"
fi

# Esclude i metadata macOS e i file di sistema: non devono propagarsi.
EXCLUDES=(--exclude '.DS_Store' --exclude '._*' --exclude '__MACOSX')

synced=0
for skill_dir in "${SRC_DIR}"/*/; do
  [[ -d "${skill_dir}" ]] || continue
  skill_name="$(basename "${skill_dir}")"

  if [[ "${MODE}" == "pull" ]]; then
    src="${AGENTS_DEST_DIR}/${skill_name}/"
    dst="${SRC_DIR}/${skill_name}/"
    [[ -d "${src}" ]] || { echo "-- salto ${skill_name}: non presente in ${AGENTS_DEST_DIR}"; continue; }

    echo "-- ${skill_name}"
    rsync -a --delete "${EXCLUDES[@]}" ${DRY_RUN} "${src}" "${dst}"
  else
    src="${SRC_DIR}/${skill_name}/"
    for destination in "${AGENTS_DEST_DIR}" "${CLAUDE_DEST_DIR}"; do
      echo "-- ${skill_name} -> ${destination}"
      rsync -a --delete "${EXCLUDES[@]}" ${DRY_RUN} "${src}" "${destination}/${skill_name}/"
    done
  fi
  synced=$((synced + 1))
done

if (( synced == 0 )); then
  echo "Nessuna skill trovata in ${SRC_DIR}" >&2
  exit 1
fi

echo "Fatto: ${synced} skill sincronizzate."
