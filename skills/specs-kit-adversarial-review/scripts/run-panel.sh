#!/usr/bin/env bash
# Runs a panel of independent reviewers and leaves their critiques on disk.
#
# The script is deliberately dumb: it resolves nothing. Models, personas and prompts are
# decided by the caller and arrive fully formed, so the flags that keep reviewers
# independent — no shared session, read-only tools, the declared model and no substitute —
# are a fact of the invocation rather than something a caller has to remember.
#
# Usage:
#   run-panel.sh --outdir DIR \
#                --reviewer "model|persona|prompt-file[|thinking]" \
#                [--reviewer ...] [--sequential] [--prefix raw] [--timeout 900]
#
# Emits one tab-separated status line per reviewer on stdout:
#   model <TAB> persona <TAB> ok|unparseable|unavailable <TAB> detail
#
# Exit: 0 when at least two reviewers are usable, 1 otherwise. Fewer than two critiques
# cannot tell consensus from opinion, so the caller must stop before merging.

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EXTRACTOR="$SCRIPT_DIR/extract-json.mjs"

OUTDIR=""
PREFIX="raw"
PARALLEL=1
TIMEOUT=""
REVIEWERS=()

die() {
  printf '[specs-kit] %s\n' "$1" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --outdir) OUTDIR="${2-}"; shift 2 ;;
    --reviewer) REVIEWERS+=("${2-}"); shift 2 ;;
    --prefix) PREFIX="${2-}"; shift 2 ;;
    --timeout) TIMEOUT="${2-}"; shift 2 ;;
    --sequential) PARALLEL=0; shift ;;
    --parallel) PARALLEL=1; shift ;;
    *) die "run-panel.sh: unknown argument '$1'" ;;
  esac
done

[ -n "$OUTDIR" ] || die "run-panel.sh: --outdir is required"
[ ${#REVIEWERS[@]} -ge 2 ] || die "run-panel.sh: at least two --reviewer entries are required"
[ ${#REVIEWERS[@]} -le 4 ] || die "run-panel.sh: at most four reviewers (declared panel is capped)"
command -v pi >/dev/null 2>&1 || die "run-panel.sh: the agent CLI 'pi' is not on PATH"
command -v node >/dev/null 2>&1 || die "run-panel.sh: node is not on PATH"

mkdir -p "$OUTDIR" || die "run-panel.sh: cannot create $OUTDIR"

# macOS ships no coreutils timeout; the cap is a courtesy, not a guarantee.
TIMEOUT_BIN=""
if [ -n "$TIMEOUT" ]; then
  if command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout"
  elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout"
  else printf '[specs-kit] no timeout(1) available: reviewers run uncapped\n' >&2
  fi
fi

slug() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed -e 's/-\{2,\}/-/g' -e 's/^-//' -e 's/-$//'
}

# One reviewer, start to finish: spawn, capture, extract, record its status.
run_reviewer() {
  local model="$1" persona="$2" prompt_file="$3" thinking="$4"
  local name raw json status_file exit_code
  name="$(slug "$model")"
  raw="$OUTDIR/$PREFIX--$name.txt"
  json="$OUTDIR/$PREFIX--$name.json"
  status_file="$OUTDIR/.$PREFIX--$name.status"

  if [ ! -r "$prompt_file" ]; then
    printf '%s\t%s\t%s\t%s\n' "$model" "$persona" "unavailable" "prompt file not readable: $prompt_file" >"$status_file"
    return
  fi

  local system_prompt
  system_prompt="You are a hostile specification reviewer, acting as ${persona}. Your job is to find defects, not to approve — approval is worthless here. You are autonomous: read the documents you are pointed at with the tools you have, and judge them. You do not write files, you do not modify anything, you do not ask for confirmation. Your entire deliverable is one JSON object, emitted as the last thing you say, matching exactly the schema in the task. No prose before it, no prose after it, no markdown fences around it."

  local -a cmd=(pi
    --model "$model"
    --tools read,grep,find,ls
    --append-system-prompt "$system_prompt"
    --no-session
    --thinking "${thinking:-high}"
    -p "$(cat "$prompt_file")")

  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" "$TIMEOUT" "${cmd[@]}" >"$raw" 2>&1
  else
    "${cmd[@]}" >"$raw" 2>&1
  fi
  exit_code=$?

  # A non-zero exit still leaves a transcript worth parsing: a reviewer that answered and
  # then died on teardown has done its job, and the JSON is right there in the file.
  if REVIEWER_MODEL="$model" REVIEWER_PERSONA="$persona" REVIEWER_EXIT="$exit_code" \
     node "$EXTRACTOR" "$raw" "$json" 2>/dev/null; then
    if [ "$exit_code" -eq 0 ]; then
      printf '%s\t%s\t%s\t%s\n' "$model" "$persona" "ok" "$json" >"$status_file"
    else
      printf '%s\t%s\t%s\t%s\n' "$model" "$persona" "ok" "$json (exit $exit_code)" >"$status_file"
    fi
  elif [ "$exit_code" -ne 0 ]; then
    printf '%s\t%s\t%s\t%s\n' "$model" "$persona" "unavailable" "exit $exit_code, transcript at $raw" >"$status_file"
  else
    printf '%s\t%s\t%s\t%s\n' "$model" "$persona" "unparseable" "no JSON object in $raw" >"$status_file"
  fi
}

STATUS_FILES=()
PIDS=()

for entry in "${REVIEWERS[@]}"; do
  IFS='|' read -r r_model r_persona r_prompt r_thinking <<<"$entry"
  [ -n "${r_model:-}" ] && [ -n "${r_persona:-}" ] && [ -n "${r_prompt:-}" ] \
    || die "run-panel.sh: malformed --reviewer '$entry' (expected model|persona|prompt-file[|thinking])"
  STATUS_FILES+=("$OUTDIR/.$PREFIX--$(slug "$r_model").status")
  rm -f "$OUTDIR/.$PREFIX--$(slug "$r_model").status"

  if [ "$PARALLEL" -eq 1 ]; then
    run_reviewer "$r_model" "$r_persona" "$r_prompt" "${r_thinking:-}" &
    PIDS+=("$!")
  else
    run_reviewer "$r_model" "$r_persona" "$r_prompt" "${r_thinking:-}"
  fi
done

for pid in "${PIDS[@]:-}"; do
  [ -n "$pid" ] && wait "$pid"
done

usable=0
for status_file in "${STATUS_FILES[@]}"; do
  if [ -r "$status_file" ]; then
    cat "$status_file"
    case "$(cut -f3 <"$status_file")" in ok) usable=$((usable + 1)) ;; esac
    rm -f "$status_file"
  else
    printf '%s\t%s\t%s\t%s\n' "?" "?" "unavailable" "reviewer left no status"
  fi
done

if [ "$usable" -lt 2 ]; then
  printf '[specs-kit] Only %d usable reviewer(s). A merge over one critique cannot tell consensus from opinion.\n' "$usable" >&2
  exit 1
fi
exit 0
