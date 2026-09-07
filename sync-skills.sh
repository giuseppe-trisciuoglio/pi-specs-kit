#!/usr/bin/env bash
# Sync this project's skills (./skills/) into the local agent folders.
#
# On push every subfolder of ./skills/ is synced into both destinations. On
# pull the historical direction is preserved (from ~/.agents/skills into
# ./skills/).
#
# Usage:
#   ./sync-skills.sh            # sync into ~/.agents/skills and ~/.claude/skills
#   ./sync-skills.sh --dry-run  # show what would happen without writing
#   ./sync-skills.sh --pull     # reverse direction (~/.agents/skills -> project)

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
      echo "Unknown option: ${arg}" >&2
      exit 1
      ;;
  esac
done

DRY_RUN="${DRY_RUN:-}"

if [[ ! -d "${SRC_DIR}" ]]; then
  echo "Source directory not found: ${SRC_DIR}" >&2
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

# Exclude macOS metadata and system files: they must not propagate.
EXCLUDES=(--exclude '.DS_Store' --exclude '._*' --exclude '__MACOSX')

synced=0
for skill_dir in "${SRC_DIR}"/*/; do
  [[ -d "${skill_dir}" ]] || continue
  skill_name="$(basename "${skill_dir}")"

  if [[ "${MODE}" == "pull" ]]; then
    src="${AGENTS_DEST_DIR}/${skill_name}/"
    dst="${SRC_DIR}/${skill_name}/"
    [[ -d "${src}" ]] || { echo "-- skipping ${skill_name}: not in ${AGENTS_DEST_DIR}"; continue; }

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
  echo "No skills found in ${SRC_DIR}" >&2
  exit 1
fi

echo "Done: ${synced} skill(s) synced."
