#!/usr/bin/env bash
#
# runner.sh - interactive front end for web-archiver.
#
#   ./runner.sh                         guided prompts, then archive
#   ./runner.sh https://example.com -p 50 --depth 2
#                                       skip the prompts, pass flags straight
#                                       through to bin/archive.js
#   ./runner.sh --help
#
# Honours NO_COLOR and falls back to plain text when stdout is not a terminal.

set -uo pipefail

cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)" || exit 1

readonly CLI="bin/archive.js"
readonly HELPER="tools/resumable.js"
readonly NODE_MIN="22.4.0"

# ----------------------------------------------------------------------------
# Presentation
# ----------------------------------------------------------------------------

if [[ -t 1 && -z "${NO_COLOR:-}" && "${TERM:-}" != "dumb" ]]; then
  B=$'\033[1m'; D=$'\033[2m'; R=$'\033[0m'
  BLUE=$'\033[38;5;39m'; GREEN=$'\033[38;5;42m'; AMBER=$'\033[38;5;214m'
  RED=$'\033[38;5;203m'; GREY=$'\033[38;5;245m'; CYAN=$'\033[38;5;80m'
else
  B=""; D=""; R=""; BLUE=""; GREEN=""; AMBER=""; RED=""; GREY=""; CYAN=""
fi

readonly WIDTH=66

rule() { printf '%s%s%s\n' "$GREY" "$(printf '─%.0s' $(seq 1 $WIDTH))" "$R"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$R" "$1"; }
bad()  { printf '  %s✗%s %s\n' "$RED"   "$R" "$1"; }
warn() { printf '  %s!%s %s\n' "$AMBER" "$R" "$1"; }
note() { printf '    %s%s%s\n' "$GREY" "$1" "$R"; }

section() { printf '\n%s%s%s\n' "$B$BLUE" "$1" "$R"; rule; }

banner() {
  printf '\n%s' "$B$CYAN"
  cat <<'ART'
              _                        _     _
 __ __ ___| |__  ___ __ _ _ _ __| |_ _(_)_ _____ _ _
 \ V  V / -_) '_ \/ _/ _` | '_/ _| ' \ \ V / -_) '_|
  \_/\_/\___|_.__/\__\__,_|_| \__|_||_|_|\_/\___|_|
ART
  printf '%s' "$R"
  printf '%s  crawl a domain -> one standalone HTML file per page%s\n' "$GREY" "$R"
}

die() { printf '\n%s✗ %s%s\n\n' "$RED$B" "$1" "$R" >&2; exit 1; }

# ----------------------------------------------------------------------------
# Prompts
# ----------------------------------------------------------------------------

# These helpers write into a caller-named variable, so every local they use is
# __-prefixed - a plain name like `reply` would be shadowed when a caller asks
# for that name and the assignment would never reach the caller.

# ask <var> <label> <default>  - free text, empty input keeps the default.
ask() {
  local __ask_var=$1 __ask_label=$2 __ask_default=${3:-} __ask_in __ask_hint=""
  [[ -n $__ask_default ]] && __ask_hint=" ${GREY}[${__ask_default}]${R}"
  read -r -p "$(printf '  %s%s%s%s: ' "$CYAN" "$__ask_label" "$R" "$__ask_hint")" __ask_in
  printf -v "$__ask_var" '%s' "${__ask_in:-$__ask_default}"
}

# ask_int <var> <label> <default> [min] - re-prompts until it gets an integer.
ask_int() {
  local __int_var=$1 __int_label=$2 __int_default=$3 __int_min=${4:-0} __int_val=""
  while true; do
    ask __int_val "$__int_label" "$__int_default"
    if [[ $__int_val =~ ^[0-9]+$ ]] && ((__int_val >= __int_min)); then
      printf -v "$__int_var" '%s' "$__int_val"
      return
    fi
    bad "whole number >= ${__int_min} please, got \"${__int_val}\""
  done
}

# ask_yn <var> <label> <default y|n> - sets the var to "yes" or "no".
ask_yn() {
  local __yn_var=$1 __yn_label=$2 __yn_default=$3 __yn_in
  while true; do
    read -r -p "$(printf '  %s%s%s %s[%s/%s]%s: ' "$CYAN" "$__yn_label" "$R" "$GREY" \
      "$([[ $__yn_default == y ]] && echo Y || echo y)" \
      "$([[ $__yn_default == y ]] && echo n || echo N)" "$R")" __yn_in
    __yn_in=${__yn_in:-$__yn_default}
    case ${__yn_in,,} in
      y|yes) printf -v "$__yn_var" 'yes'; return ;;
      n|no)  printf -v "$__yn_var" 'no';  return ;;
      *) bad "answer y or n" ;;
    esac
  done
}

# ask_url <var> - required, and a bare host gets https:// put in front.
ask_url() {
  local __url_var=$1 __url_in __url
  while true; do
    read -r -p "$(printf '  %sStart URL%s %s(the site to archive)%s: ' \
      "$CYAN" "$R" "$GREY" "$R")" __url_in
    __url=${__url_in// /}
    [[ -z $__url ]] && { bad "a URL is required"; continue; }
    [[ $__url != http://* && $__url != https://* ]] && __url="https://${__url}"
    if [[ $__url =~ ^https?://[A-Za-z0-9._~-]+(:[0-9]+)?(/.*)?$ ]]; then
      printf -v "$__url_var" '%s' "$__url"
      return
    fi
    bad "that does not look like a URL: ${__url_in}"
  done
}

# ----------------------------------------------------------------------------
# Settings lookup
# ----------------------------------------------------------------------------

# One KEY=value out of .env, without pulling in a parser.
env_file_value() {
  [[ -f .env ]] || return 0
  grep -E "^\s*$1=" .env 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "\r"
}

# Same precedence the CLI uses: environment first, then .env, then the default.
default_output() {
  local value=${OUTPUT_FOLDER:-}
  [[ -z $value ]] && value=$(env_file_value OUTPUT_FOLDER)
  printf '%s' "${value:-./archive}"
}

# ----------------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------------

version_lt() { # version_lt A B -> true when A < B
  [[ $1 != "$2" ]] && [[ $(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1) == "$1" ]]
}

preflight() {
  section "Environment"

  command -v node >/dev/null 2>&1 || die "Node.js not found on PATH. Install Node >= ${NODE_MIN}."

  local node_version
  node_version=$(node --version); node_version=${node_version#v}
  if version_lt "$node_version" "$NODE_MIN"; then
    bad "Node ${node_version} - too old"
    note "SingleFile needs the native WebSocket in Node >= ${NODE_MIN}"
    die "Upgrade Node to ${NODE_MIN} or newer."
  fi
  ok "Node ${node_version}"

  [[ -f $CLI ]] || die "${CLI} not found - run this from the web-archiver checkout."

  if [[ ! -d node_modules ]]; then
    warn "dependencies are not installed"
    local answer
    ask_yn answer "run npm install now?" y
    [[ $answer == yes ]] || die "Install them first: npm install"
    npm install || die "npm install failed."
  fi
  ok "dependencies installed"

  # SingleFile lives in a submodule (AGPL, kept out of this repo's history).
  local sf_dir="${SINGLEFILE_DIR:-}"
  [[ -z $sf_dir ]] && sf_dir=$(env_file_value SINGLEFILE_DIR)
  [[ -z $sf_dir ]] && sf_dir="vendor/single-file-cli"

  if [[ -d $sf_dir/node_modules ]]; then
    ok "SingleFile ready (${sf_dir})"
  else
    warn "SingleFile is not set up at ${sf_dir}"
    local answer
    ask_yn answer "run npm run setup now?" y
    if [[ $answer == yes ]]; then
      npm run setup || die "npm run setup failed."
      ok "SingleFile ready"
    else
      note "archiving will fail without it; --dry-run still works"
    fi
  fi
}

# ----------------------------------------------------------------------------
# Wizard
# ----------------------------------------------------------------------------

ARGS=()          # what gets handed to bin/archive.js
declare -a SUMMARY_KEYS=() SUMMARY_VALUES=()
declare -a RESUMABLE=()
declare -A PREV=()   # the resumed crawl's previous settings; empty for a new one
IS_RESUME=no
MODE=new
URL=""
OUTPUT=""

record() { SUMMARY_KEYS+=("$1"); SUMMARY_VALUES+=("$2"); }

# add_flag <flag> <yes|no> - append a boolean flag only when it is on.
add_flag() { [[ $2 == yes ]] && ARGS+=("$1"); return 0; }

# prior <key> <fallback> - a previous run's value, or the fallback for new crawls.
prior() {
  local value=${PREV[$1]:-}
  [[ -n $value ]] && printf '%s' "$value" || printf '%s' "$2"
}

# prior_yn <key> - a previous 0/1 toggle as the y/n default ask_yn expects.
prior_yn() { [[ $(prior "$1" 0) == 1 ]] && printf 'y' || printf 'n'; }

# ----------------------------------------------------------------------------
# Start menu
# ----------------------------------------------------------------------------

# Fill RESUMABLE with "index url age archived pending" lines, newest first.
find_resumable() {
  RESUMABLE=()
  local line
  while IFS= read -r line; do
    [[ -n $line ]] && RESUMABLE+=("$line")
  done < <(node "$HELPER" list "$1" 2>/dev/null)
}

start_menu() {
  section "Start"
  local label
  case ${#RESUMABLE[@]} in
    0) label="${GREY}(none saved)${R}" ;;
    1) label="${GREY}(1 saved)${R}" ;;
    *) label="${GREY}(${#RESUMABLE[@]} saved)${R}" ;;
  esac
  printf '  %s1%s  Start with a new URL\n' "$B" "$R"
  printf '  %s2%s  Resume a saved crawl        %s\n\n' "$B" "$R" "$label"

  # Sets MODE rather than echoing it: a $(start_menu) subshell would swallow
  # the menu itself along with the answer.
  local choice
  while true; do
    ask choice "Choice" "1"
    case $choice in
      1) MODE=new; return ;;
      2) MODE=resume; return ;;
      *) bad "enter 1 or 2" ;;
    esac
  done
}

# ----------------------------------------------------------------------------
# Resume
# ----------------------------------------------------------------------------

# Returns 1 when there is nothing to resume, so main falls back to a new crawl.
resume_wizard() {
  local base=$1
  section "Resume"

  while ((${#RESUMABLE[@]} == 0)); do
    warn "no saved crawls under $base"
    note "a crawl is saved when it is interrupted, or when it hits --max-pages with URLs left"
    local again
    ask_yn again "Look in a different output folder?" n
    [[ $again == yes ]] || return 1
    ask base "Output folder to scan" "$base"
    find_resumable "$base"
  done

  local line idx url age archived pending
  for line in "${RESUMABLE[@]}"; do
    IFS=$'\t' read -r idx url age archived pending <<<"$line"
    printf '  %s%s%s  %s\n' "$B" "$idx" "$R" "$url"
    printf '     %ssaved %s - %s archived, %s pending%s\n' "$GREY" "$age" "$archived" "$pending" "$R"
  done
  printf '\n'

  local index=1
  if ((${#RESUMABLE[@]} > 1)); then
    while true; do
      ask_int index "Which crawl?" 1 1
      ((index <= ${#RESUMABLE[@]})) && break
      bad "pick a number between 1 and ${#RESUMABLE[@]}"
    done
  fi

  PREV=()
  local key value
  while IFS= read -r line; do
    key=${line%%=*}
    value=${line#*=}
    [[ -n $key ]] && PREV[$key]=$value
  done < <(node "$HELPER" show "$base" "$index")
  [[ -n ${PREV[url]:-} ]] || die "Could not read that crawl's saved state."

  IS_RESUME=yes
  # The URL comes from the state file, never retyped: the archiver only resumes
  # when the start URL matches the saved one exactly.
  URL=${PREV[url]}
  OUTPUT=${PREV[base]}

  local processed=${PREV[processed]} prev_max=${PREV[maxPages]} pending_count=${PREV[pending]}
  # --max-pages counts the whole crawl, saved progress included, so the old
  # value would archive nothing. Default to the number that clears the queue.
  local suggested=$((processed + pending_count))
  ((suggested < prev_max)) && suggested=$prev_max

  section "Scope"
  printf '  %s%s of %s pages used, %s URLs still pending.%s\n' \
    "$GREY" "$processed" "$prev_max" "$pending_count" "$R"
  printf '  %s--max-pages is the total for the whole crawl - %s covers everything pending.%s\n\n' \
    "$GREY" "$suggested" "$R"

  local pages anyway
  while true; do
    ask_int pages "Pages to archive (total)" "$suggested" 1
    ((pages > processed)) && break
    warn "$processed pages of that budget are already used - the crawl would stop immediately"
    ask_yn anyway "Use it anyway?" n
    [[ $anyway == yes ]] && break
  done

  local depth
  ask_int depth "Link depth from the seeds" "${PREV[maxDepth]}" 0

  [[ ${PREV[optionsFound]} == 1 ]] ||
    warn "no previous report found - the settings below fall back to CLI defaults"

  record "Resuming" "$URL  ${GREY}(saved ${PREV[age]}, ${pending_count} pending)${R}"
  record "Pages" "$pages  ${GREY}(${processed} already used)${R}"
  record "Depth" "$depth"
  record "Output" "$OUTPUT"

  ARGS=("$URL" --max-pages "$pages" --depth "$depth" --output "$OUTPUT" --resume)

  section "Advanced"
  printf "  %sthe previous run's filters and tuning are kept unless you change them%s\n\n" "$GREY" "$R"
  local change
  ask_yn change "Change filters or tuning?" n
  if [[ $change == yes ]]; then
    wizard_advanced
  else
    # Carry the previous scope and tuning flags over verbatim. Dropping the
    # filters here would let a resumed crawl wander into URLs the original run
    # deliberately excluded.
    local -a carried=()
    while IFS= read -r line; do
      [[ -n $line ]] && carried+=("$line")
    done < <(node "$HELPER" args "$base" "$index")
    if ((${#carried[@]} > 0)); then
      ARGS+=("${carried[@]}")
      record "Carried over" "${carried[*]}"
    fi
  fi
}

wizard() {
  section "Target"
  ask_url URL
  record "URL" "$URL"

  section "Scope"
  ask_int PAGES "Pages to archive" 100 1
  ask_int DEPTH "Link depth from the seeds (0 = seeds only)" 3 0
  record "Pages" "$PAGES"
  record "Depth" "$DEPTH"

  ask OUTPUT "Output folder" "$(default_output)"
  record "Output" "$OUTPUT"

  ask_yn DRY_RUN "Dry run (crawl and report, archive nothing)?" n
  record "Mode" "$([[ $DRY_RUN == yes ]] && echo 'dry run' || echo 'archive')"

  ARGS=("$URL" --max-pages "$PAGES" --depth "$DEPTH" --output "$OUTPUT")
  add_flag --dry-run "$DRY_RUN"

  section "Advanced"
  printf '  %sfilters, tuning, resume - defaults are fine for most sites%s\n\n' "$GREY" "$R"
  local advanced
  ask_yn advanced "Configure advanced options?" n
  [[ $advanced == yes ]] && wizard_advanced

  return 0
}

# On a resume every prompt starts on what the saved crawl used (via PREV).
wizard_advanced() {
  local include exclude sitemap workers concurrency delay timeout idle
  local resume overwrite robots all_domains verbose kind count

  printf '\n'
  # Only the first pattern can be offered as a default; say so rather than
  # dropping the others silently.
  for kind in include exclude; do
    count=$(prior "${kind}Count" 0)
    ((count > 1)) &&
      warn "the saved crawl had $count $kind patterns - keeping only the one shown below"
  done

  ask include "Only crawl URLs matching (regex, blank = all)" "$(prior include '')"
  [[ -n $include ]] && { ARGS+=(--include "$include"); record "Include" "$include"; }

  ask exclude "Never crawl URLs matching (regex, blank = none)" "$(prior exclude '')"
  [[ -n $exclude ]] && { ARGS+=(--exclude "$exclude"); record "Exclude" "$exclude"; }

  ask sitemap "Sitemap: auto, off, or a sitemap URL" "$(prior sitemap auto)"
  case $sitemap in
    auto|"") ;;
    off|no|none) ARGS+=(--no-sitemap); record "Sitemap" "disabled" ;;
    *) ARGS+=(--sitemap "$sitemap"); record "Sitemap" "$sitemap" ;;
  esac

  printf '\n'
  ask_int workers     "Parallel browser tabs per batch" "$(prior workers 4)" 1
  ask_int concurrency "Parallel discovery fetches" "$(prior concurrency 2)" 1
  ask_int delay       "Delay between requests (ms)" "$(prior delay 500)" 0
  ask_int timeout     "Per-request / per-page timeout (ms)" "$(prior timeout 30000)" 1000
  ask_int idle        "Lazy-image wait per page (ms; raise for image-heavy sites)" "$(prior idle 500)" 0
  ARGS+=(--workers "$workers" --concurrency "$concurrency" --delay "$delay"
         --timeout "$timeout" --deferred-images-idle "$idle")
  record "Tuning" "${workers} tabs, ${concurrency} fetches, ${delay}ms delay, ${timeout}ms timeout, ${idle}ms lazy-image wait"

  printf '\n'
  # --resume is already set by the resume flow, so it is not asked there.
  resume=no
  [[ $IS_RESUME == yes ]] || ask_yn resume "Resume a previous interrupted crawl?" n
  ask_yn overwrite   "Overwrite pages already in raw-html/?" n
  ask_yn robots      "Respect robots.txt disallow rules?" "$(prior_yn respectRobots)"
  ask_yn all_domains "Follow links to external domains?" "$(prior_yn allDomains)"
  ask_yn verbose     "Verbose logging?" n
  add_flag --resume        "$resume"
  add_flag --overwrite     "$overwrite"
  add_flag --respect-robots "$robots"
  add_flag --all-domains   "$all_domains"
  add_flag --verbose       "$verbose"

  local toggles=""
  [[ $resume      == yes ]] && toggles+="resume "
  [[ $overwrite   == yes ]] && toggles+="overwrite "
  [[ $robots      == yes ]] && toggles+="respect-robots "
  [[ $all_domains == yes ]] && toggles+="all-domains "
  [[ $verbose     == yes ]] && toggles+="verbose "
  [[ -n $toggles ]] && record "Flags" "${toggles% }"

  return 0
}

# ----------------------------------------------------------------------------
# Confirmation
# ----------------------------------------------------------------------------

# Print "  Label   value", wrapping long values under the label column.
summary_row() {
  local label=$1 value=$2 pad=12
  printf '  %s%-*s%s %s\n' "$GREY" "$pad" "$label" "$R" "$value"
}

confirm() {
  section "Ready"
  local i
  for i in "${!SUMMARY_KEYS[@]}"; do
    summary_row "${SUMMARY_KEYS[$i]}" "${SUMMARY_VALUES[$i]}"
  done

  # The equivalent one-liner, so this run can be scripted later.
  local quoted="" arg
  for arg in "${ARGS[@]}"; do
    if [[ $arg =~ [[:space:]\'\"\\\$\&\|\<\>\(\)] ]]; then
      quoted+=" '${arg//\'/\'\\\'\'}'"
    else
      quoted+=" $arg"
    fi
  done
  printf '\n  %scommand%s %snode %s%s%s\n' "$GREY" "$R" "$D" "$CLI" "$quoted" "$R"

  printf '\n'
  local go
  ask_yn go "Start?" y
  [[ $go == yes ]] || { printf '\n  %scancelled%s\n\n' "$GREY" "$R"; exit 0; }
}

# ----------------------------------------------------------------------------
# Run
# ----------------------------------------------------------------------------

execute() {
  section "Crawling"
  printf '\n'

  # A no-op INT handler keeps this script alive through Ctrl+C so the archiver
  # can save resume state and this script can still print the outcome. The
  # archiver gets the signal directly; a second Ctrl+C hard-exits it.
  trap ':' INT
  local started=$SECONDS
  node "$CLI" "${ARGS[@]}"
  local code=$?
  local elapsed=$((SECONDS - started))
  trap - INT

  local mins=$((elapsed / 60)) secs=$((elapsed % 60)) took
  took=$([[ $mins -gt 0 ]] && printf '%dm %ds' "$mins" "$secs" || printf '%ds' "$secs")

  printf '\n'
  rule
  case $code in
    0)
      printf '%s  ✓ Finished%s %sin %s%s\n' "$GREEN$B" "$R" "$GREY" "$took" "$R"
      local host=${URL#*://}; host=${host%%/*}
      local site="${OUTPUT:-./archive}/${host}"
      printf '  %sPages%s   %s/raw-html/\n' "$GREY" "$R" "$site"
      printf '  %sReport%s  %s/report/crawl-report.json\n' "$GREY" "$R" "$site"
      ;;
    2)
      printf '%s  ! Nothing archived%s %severy page failed - see the report above%s\n' \
        "$AMBER$B" "$R" "$GREY" "$R"
      ;;
    130)
      printf '%s  ! Interrupted%s %safter %s - state was saved%s\n' \
        "$AMBER$B" "$R" "$GREY" "$took" "$R"
      printf '  %sRe-run with the same URL and answer yes to "Resume" to continue.%s\n' "$GREY" "$R"
      ;;
    *)
      printf '%s  ✗ Failed%s %sexit code %s%s\n' "$RED$B" "$R" "$GREY" "$code" "$R"
      ;;
  esac
  rule
  printf '\n'
  exit $code
}

usage() {
  banner
  cat <<EOF

${B}Usage${R}
  ./runner.sh                     guided prompts, then archive
  ./runner.sh <url> [flags...]    skip the prompts; flags go straight to ${CLI}
  ./runner.sh --help              this message

${B}Examples${R}
  ./runner.sh
  ./runner.sh https://example.com --max-pages 50 --depth 2
  ./runner.sh https://example.com --dry-run

Every flag from ${CLI} is accepted in pass-through mode; run
${D}node ${CLI} --help${R} for the full list.

EOF
}

main() {
  case ${1:-} in
    -h|--help) usage; exit 0 ;;
  esac

  # Pass-through: any arguments mean the caller already knows what they want.
  if (($# > 0)); then
    exec node "$CLI" "$@"
  fi

  if [[ ! -t 0 ]]; then
    die "No arguments and stdin is not a terminal. Pass flags instead: ./runner.sh <url> [flags]"
  fi

  banner
  preflight

  local base
  base=$(default_output)
  find_resumable "$base"
  start_menu
  # resume_wizard returns non-zero when there is nothing to resume, which falls
  # through to the new-URL flow rather than dead-ending.
  if [[ $MODE == resume ]] && resume_wizard "$base"; then
    :
  else
    wizard
  fi

  confirm
  execute
}

main "$@"
