# shellcheck shell=bash
# Sourced by the scripts that run a stack. Reads a .env the way Compose
# reads it, and never as shell: the file holds data, and a value may have
# spaces, quotes, `&`, `<`, or `$(…)` that a shell would act on.
#
#   . "$root/scripts/env-file.sh"
#   read_env_file "$env_file" POSTGRES_USER POSTGRES_DB
#
# Compose itself answers, on a small composition that names only the
# variables asked for, each empty by default: the required variables of
# the stack's own files do not get in the way. Each non-empty value is
# exported. As in Compose, a variable already set wins over the file. No
# file: nothing is read. A file Compose refuses stops here, and what
# Compose says about it is not shown, since it quotes the file's content.

# The text of a JSON string, in REPLY. Compose's JSON escapes `<`, `>`, `&`
# and control characters. Written for bash 3.2, which macOS ships.
_env_json_text() {
  local rest="$1" out="" head code byte
  while :; do
    head="${rest%%\\*}"
    out+="$head"
    if [ "$head" = "$rest" ]; then break; fi
    rest="${rest#"$head"\\}"
    case "${rest:0:1}" in
      n) out+=$'\n' ;;
      r) out+=$'\r' ;;
      t) out+=$'\t' ;;
      b) out+=$'\b' ;;
      f) out+=$'\f' ;;
      u)
        code=$((16#${rest:1:4}))
        rest="${rest:4}"
        if [ "$code" -lt 128 ]; then
          printf -v byte '\\%03o' "$code"
        elif [ "$code" -lt 2048 ]; then
          printf -v byte '\\%03o\\%03o' $((192 + code / 64)) $((128 + code % 64))
        else
          printf -v byte '\\%03o\\%03o\\%03o' $((224 + code / 4096)) \
            $((128 + code / 64 % 64)) $((128 + code % 64))
        fi
        printf -v byte '%b' "$byte"
        out+="$byte"
        ;;
      *) out+="${rest:0:1}" ;;
    esac
    rest="${rest:1}"
  done
  REPLY="$out"
}

read_env_file() {
  local file="$1" folder asked out line key value doubled="" entry
  local pattern='^[[:space:]]*"([A-Za-z_][A-Za-z0-9_]*)": "(.*)",?$'
  shift
  if [ ! -f "$file" ]; then return 0; fi
  folder="$(cd "$(dirname "$file")" && pwd)"
  file="$folder/$(basename "$file")"
  asked=$'name: anygriddb-env\nservices:\n  env:\n    image: scratch\n    environment:\n      ANYGRIDDB_ENV_DOLLAR: "$$"\n'
  for key in "$@"; do
    asked+="      ${key}: \${${key}-}"$'\n'
  done
  if ! out="$(printf '%s' "$asked" | docker compose --project-directory "$folder" \
    --env-file "$file" -f - config --format json 2>/dev/null)"; then
    echo "$file could not be read as Compose reads it. To see why: docker compose --env-file $file config -q" >&2
    return 1
  fi
  # `config` writes each `$` of a value twice, in the versions that do:
  # the variable above, a single `$`, says which this one is.
  case "$out" in *'"ANYGRIDDB_ENV_DOLLAR": "$$"'*) doubled=yes ;; esac
  while IFS= read -r line; do
    if [[ ! "$line" =~ $pattern ]]; then continue; fi
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    for entry in "$@"; do
      if [ "$entry" != "$key" ]; then continue; fi
      if [ -n "$doubled" ]; then value="${value//\$\$/\$}"; fi
      _env_json_text "$value"
      if [ -n "$REPLY" ]; then
        printf -v "$key" '%s' "$REPLY"
        export "${key?}"
      fi
    done
  done <<<"$out"
}

# Percent-encodes a part of a database's address: a password typed by hand
# may hold @, :, / or #, which would cut it.
url_encode() {
  local raw="$1" out="" i c hex
  local LC_ALL=C
  for ((i = 0; i < ${#raw}; i++)); do
    c="${raw:i:1}"
    case "$c" in
      [a-zA-Z0-9._~-]) out+="$c" ;;
      *)
        printf -v hex '%%%02X' "'$c"
        out+="$hex"
        ;;
    esac
  done
  printf '%s' "$out"
}
