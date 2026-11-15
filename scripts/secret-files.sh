# shellcheck shell=bash
# Sourced by the scripts that run `docker compose` on a stack. An install
# made by scripts/install.sh keeps POSTGRES_PASSWORD and AUTH_ENCRYPTION_KEY
# in files, not in .env, and compose.yml still refuses to start without
# them. This reads each one, for Compose to fill the file in; then
# compose.secrets.yml mounts the files and leaves the variables empty in
# the containers. A variable already set wins. Nothing is printed.
#
#   . "$root/scripts/secret-files.sh"
#   load_secret_files "$env_dir"
#
# Each value comes from NAME_FILE when .env sets it (a path relative to the
# folder of .env, or absolute), else from secrets/<name> beside .env.

load_secret_files() {
  local dir="$1" name file_var path value
  for name in POSTGRES_PASSWORD AUTH_ENCRYPTION_KEY; do
    if [ -n "${!name:-}" ]; then continue; fi
    file_var="${name}_FILE"
    path="${!file_var:-}"
    if [ -z "$path" ]; then
      path="secrets/$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
    fi
    case "$path" in
      /*) ;;
      *) path="$dir/$path" ;;
    esac
    if [ ! -f "$path" ]; then continue; fi
    value="$(tr -d '\r\n' <"$path")"
    printf -v "$name" '%s' "$value"
    export "${name?}"
  done
}
