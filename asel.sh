#!/usr/bin/env bash
#
# ASEL - main entry point. Thin wrapper around docker compose plus a doctor
# command for local diagnostics. Written for bash 3.2 (macOS default shell),
# so no associative arrays and no mapfile.
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

AGENT_IMAGE="asel-agent-runtime:latest"
AGENT_CONTEXT="images/agent-runtime"
COMPOSE_FILE="docker-compose.yml"
ENV_FILE=".env"
DOCKER_SOCKET="/var/run/docker.sock"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'
  C_RED=$'\033[0;31m'
  C_GREEN=$'\033[0;32m'
  C_YELLOW=$'\033[0;33m'
  C_BLUE=$'\033[0;34m'
  C_BOLD=$'\033[1m'
else
  C_RESET=""
  C_RED=""
  C_GREEN=""
  C_YELLOW=""
  C_BLUE=""
  C_BOLD=""
fi

info() { printf '%s==>%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
ok() { printf '%s  ok %s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s warn%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
fail() { printf '%s fail%s %s\n' "$C_RED" "$C_RESET" "$*"; }
die() {
  fail "$*"
  exit 1
}

usage() {
  cat <<EOF
${C_BOLD}ASEL${C_RESET} - Agentic Software Engineering Lifecycle

Usage: ./asel.sh <command> [args]

Commands:
  up            Start the orchestrator (docker compose up -d)
  down          Stop and remove the orchestrator container
  restart       Restart the orchestrator
  logs [args]   Follow orchestrator logs (extra args go to docker compose logs)
  status        Show container status, health and the current registry
  build         Build the agent-runtime image and the compose images
  doctor        Check the local setup before starting anything
  help          Show this message

Environment:
  DRY_RUN=1        Log what a run WOULD do instead of starting containers
  LOG_LEVEL        debug | info | warn | error (default info)
  ASEL_REPOS_DIR   Host dir for repo clones and agent worktrees
                   (absolute path, default <repo>/repos, change needs down + up)
  ASEL_AGENT_UID   UID the agent containers run as and the agent image is built
  ASEL_AGENT_GID   with (default: the user running this script; changing either
                   means ./asel.sh build again)

Secrets live in ${ENV_FILE} (start from ${ENV_FILE}.example).
EOF
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker CLI not found in PATH"
  docker compose version >/dev/null 2>&1 || die "docker compose v2 plugin not available"
}

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

# Reads a top level scalar key out of a small YAML file, without a YAML parser.
# Good enough for the doctor command, the orchestrator uses a real parser.
yaml_value() {
  local file="$1" key="$2" line=""
  line="$(grep -E "^[[:space:]]*${key}:[[:space:]]*" "$file" 2>/dev/null | head -n 1 || true)"
  [ -n "$line" ] || return 0
  line="${line#*:}"
  line="${line%%#*}"
  # trim whitespace and optional quotes
  line="$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
  printf '%s' "$line"
}

# github.com/Owner/name -> Owner/name
repo_full_name() {
  printf '%s' "$1" \
    | sed -e 's#^git@github\.com:#/#' -e 's#^[a-zA-Z]*://##' -e 's#^\(www\.\)\{0,1\}github\.com/##' -e 's#\.git$##' -e 's#/*$##'
}

# Reads KEY= out of the env file. Last assignment wins, like docker compose.
env_file_value() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^[[:space:]]*${key}=" "$ENV_FILE" 2>/dev/null | tail -n 1 \
    | sed -e 's/^[^=]*=//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# Repos live in a plain host directory mounted into the orchestrator container
# under the SAME absolute path. The docker daemon resolves bind mount sources
# on the host, so every worktree path the orchestrator hands it must exist
# there too - identical paths on both sides make that true by construction.
# Resolution order: environment, .env, default <repo>/repos.
resolve_repos_dir() {
  local dir="${ASEL_REPOS_DIR:-}"
  [ -n "$dir" ] || dir="$(env_file_value ASEL_REPOS_DIR)"
  [ -n "$dir" ] || dir="${ROOT_DIR}/repos"
  case "$dir" in
    /*) ;;
    *) dir="${ROOT_DIR}/${dir}" ;;
  esac
  printf '%s' "$dir"
}

ASEL_REPOS_DIR="$(resolve_repos_dir)"
export ASEL_REPOS_DIR

# UID/GID of the `agent` user. One pair, two places that have to agree on it:
# the image is BUILT with it (cmd_build passes AGENT_UID/AGENT_GID), and the
# orchestrator hands it to Sandcastle at RUN time, which turns it into
# `docker run --user`. Both come from here so they cannot drift apart.
#
# The orchestrator cannot work it out itself: inside compose it runs as root
# (it needs the docker socket), so its own uid is 0 while the agent has to be
# the HOST user - agents write into bind mounted worktrees under
# ASEL_REPOS_DIR, and the host has to stay able to read and delete them.
# Resolution order: environment, .env, the user running this script.
resolve_agent_id() {
  local from_env="$1" key="$2" fallback="$3" value=""
  value="$from_env"
  [ -n "$value" ] || value="$(env_file_value "$key")"
  [ -n "$value" ] || value="$fallback"
  printf '%s' "$value"
}

ASEL_AGENT_UID="$(resolve_agent_id "${ASEL_AGENT_UID:-}" ASEL_AGENT_UID "$(id -u)")"
ASEL_AGENT_GID="$(resolve_agent_id "${ASEL_AGENT_GID:-}" ASEL_AGENT_GID "$(id -g)")"
export ASEL_AGENT_UID ASEL_AGENT_GID

cmd_up() {
  require_docker
  [ -f "$ENV_FILE" ] || warn "${ENV_FILE} not found, the orchestrator will start without secrets"
  mkdir -p "$ASEL_REPOS_DIR"
  info "starting orchestrator (repos dir: ${ASEL_REPOS_DIR})"
  compose up -d --remove-orphans
  compose ps
  ok "orchestrator started, follow it with ./asel.sh logs"
}

cmd_down() {
  require_docker
  info "stopping orchestrator"
  compose down --remove-orphans
  ok "orchestrator stopped (volume asel_state and ${ASEL_REPOS_DIR} are kept)"
}

cmd_restart() {
  require_docker
  info "restarting orchestrator"
  compose restart
  compose ps
}

cmd_logs() {
  require_docker
  compose logs -f --tail 200 "$@"
}

cmd_status() {
  require_docker
  info "compose services"
  compose ps || true

  info "health"
  if docker inspect --format '{{.State.Health.Status}}' asel-orchestrator >/dev/null 2>&1; then
    docker inspect --format '  container {{.Name}} state={{.State.Status}} health={{.State.Health.Status}}' asel-orchestrator
  else
    echo "  container not running"
  fi

  info "agent runtime image"
  if docker image inspect "$AGENT_IMAGE" >/dev/null 2>&1; then
    docker image inspect --format '  {{index .RepoTags 0}} created={{.Created}}' "$AGENT_IMAGE"
  else
    echo "  ${AGENT_IMAGE} not built (run ./asel.sh build)"
  fi

  info "project registry"
  local file name repo
  for file in projects/*.yml projects/*.yaml; do
    [ -f "$file" ] || continue
    name="$(yaml_value "$file" name)"
    repo="$(yaml_value "$file" repo)"
    printf '  %-16s %s\n' "${name:-?}" "$(repo_full_name "${repo:-?}")"
  done
}

cmd_build() {
  require_docker
  # Same numbers the orchestrator will pass to `docker run --user` later, so a
  # rebuild and a run can never disagree about who the agent is.
  local uid gid
  uid="$ASEL_AGENT_UID"
  gid="$ASEL_AGENT_GID"

  info "building ${AGENT_IMAGE} (uid=${uid} gid=${gid})"
  docker build \
    --build-arg "AGENT_UID=${uid}" \
    --build-arg "AGENT_GID=${gid}" \
    -t "$AGENT_IMAGE" \
    "$AGENT_CONTEXT"
  ok "${AGENT_IMAGE} built"

  info "building compose images"
  compose build
  ok "compose images built"
}

# --- doctor ------------------------------------------------------------------

DOCTOR_FAILURES=0

doctor_fail() {
  fail "$*"
  DOCTOR_FAILURES=$((DOCTOR_FAILURES + 1))
}

doctor_docker() {
  info "docker"
  if ! command -v docker >/dev/null 2>&1; then
    doctor_fail "docker CLI not found in PATH"
    return
  fi
  if ! docker info >/dev/null 2>&1; then
    doctor_fail "docker daemon not reachable (is Docker Desktop running?)"
    return
  fi
  ok "docker daemon reachable ($(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown))"

  if docker compose version >/dev/null 2>&1; then
    ok "docker compose plugin present"
  else
    doctor_fail "docker compose v2 plugin missing"
  fi

  if [ -S "$DOCKER_SOCKET" ]; then
    ok "socket ${DOCKER_SOCKET} present"
  else
    doctor_fail "socket ${DOCKER_SOCKET} missing (Sandcastle needs it to spawn sibling containers)"
  fi
}

doctor_env() {
  info "secrets"
  if [ -f "$ENV_FILE" ]; then
    ok "${ENV_FILE} present"
    set -a
    # shellcheck disable=SC1090
    . "./${ENV_FILE}"
    set +a
  else
    doctor_fail "${ENV_FILE} missing (cp ${ENV_FILE}.example ${ENV_FILE})"
  fi

  if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    doctor_fail "CLAUDE_CODE_OAUTH_TOKEN empty (get one with: claude setup-token)"
  else
    ok "CLAUDE_CODE_OAUTH_TOKEN set"
  fi

  if [ -n "${WOOPY_INBOUND_URL:-}" ]; then
    ok "WOOPY_INBOUND_URL set (push notifications possible)"
  else
    warn "WOOPY_INBOUND_URL empty (push notifications disabled)"
  fi
}

doctor_github() {
  info "github"
  if [ -z "${GITHUB_TOKEN:-}" ]; then
    doctor_fail "GITHUB_TOKEN empty, skipping API checks"
    return
  fi

  local body status login
  body="$(mktemp)"
  status="$(curl -sS -o "$body" -w '%{http_code}' \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    https://api.github.com/user || echo 000)"

  if [ "$status" != "200" ]; then
    doctor_fail "GITHUB_TOKEN rejected by GET /user (HTTP ${status})"
    rm -f "$body"
    return
  fi
  login="$(grep -o '"login"[[:space:]]*:[[:space:]]*"[^"]*"' "$body" | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
  rm -f "$body"
  ok "GITHUB_TOKEN valid, authenticated as ${login:-unknown}"

  local file name repo full code
  for file in projects/*.yml projects/*.yaml; do
    [ -f "$file" ] || continue
    name="$(yaml_value "$file" name)"
    repo="$(yaml_value "$file" repo)"
    if [ -z "$repo" ]; then
      doctor_fail "${file}: missing repo key"
      continue
    fi
    full="$(repo_full_name "$repo")"
    code="$(curl -sS -o /dev/null -w '%{http_code}' \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "https://api.github.com/repos/${full}" || echo 000)"
    case "$code" in
      200) ok "project ${name:-$file}: ${full} reachable" ;;
      404) doctor_fail "project ${name:-$file}: ${full} not found or token has no access" ;;
      *) doctor_fail "project ${name:-$file}: ${full} check failed (HTTP ${code})" ;;
    esac
  done
}

doctor_images() {
  info "images"
  if docker image inspect "$AGENT_IMAGE" >/dev/null 2>&1; then
    ok "${AGENT_IMAGE} built"
  else
    doctor_fail "${AGENT_IMAGE} not built (run ./asel.sh build)"
  fi
}

doctor_config() {
  info "config"
  if [ -f "asel.yml" ]; then
    ok "asel.yml present (label prefix: $(yaml_value asel.yml label_prefix))"
  else
    doctor_fail "asel.yml missing"
  fi

  local count=0 file
  for file in projects/*.yml projects/*.yaml; do
    [ -f "$file" ] || continue
    count=$((count + 1))
  done
  if [ "$count" -gt 0 ]; then
    ok "${count} project(s) in the registry"
  else
    warn "registry empty, the orchestrator will idle"
  fi

  if docker compose -f "$COMPOSE_FILE" config -q >/dev/null 2>&1; then
    ok "docker-compose.yml valid"
  else
    doctor_fail "docker-compose.yml invalid (docker compose config -q)"
  fi
}

doctor_repos_dir() {
  info "repos dir"
  case "$ASEL_REPOS_DIR" in
    /*) ;;
    *)
      doctor_fail "ASEL_REPOS_DIR is not an absolute path: ${ASEL_REPOS_DIR}"
      return
      ;;
  esac
  if mkdir -p "$ASEL_REPOS_DIR" 2>/dev/null && [ -w "$ASEL_REPOS_DIR" ]; then
    ok "repos dir ${ASEL_REPOS_DIR} writable (mounted into the orchestrator at the same path)"
  else
    doctor_fail "repos dir ${ASEL_REPOS_DIR} cannot be created or is not writable"
  fi
  if [ "$(uname -s)" = "Darwin" ]; then
    case "$ASEL_REPOS_DIR" in
      /Users/* | /Volumes/* | /private/* | /tmp/*) ;;
      *) warn "Docker Desktop shares /Users, /Volumes, /private and /tmp by default; ${ASEL_REPOS_DIR} may not be mountable" ;;
    esac
  fi
}

# The agent user is the one place where a silent mismatch is likelier than a
# loud one. Sandcastle's pre-flight compares the uid it is about to use with
# `{{.Config.User}}` of the image, but gives up when that is not a number - and
# images/agent-runtime ends with `USER agent`, a NAME. So a wrong uid does not
# get rejected: the agent simply runs as somebody else (root, when the
# orchestrator falls back to its own uid) and leaves files the host user cannot
# remove. This check asks the image itself instead.
doctor_agent_user() {
  info "agent user"
  case "${ASEL_AGENT_UID}" in
    "" | *[!0-9]*)
      doctor_fail "ASEL_AGENT_UID is not a number: '${ASEL_AGENT_UID}'"
      return
      ;;
  esac
  case "${ASEL_AGENT_GID}" in
    "" | *[!0-9]*)
      doctor_fail "ASEL_AGENT_GID is not a number: '${ASEL_AGENT_GID}'"
      return
      ;;
  esac
  if [ "$ASEL_AGENT_UID" = "0" ] || [ "$ASEL_AGENT_GID" = "0" ]; then
    doctor_fail "agent uid/gid is 0 (${ASEL_AGENT_UID}:${ASEL_AGENT_GID}), the agent image runs a non-root user"
    return
  fi
  ok "agents run as ${ASEL_AGENT_UID}:${ASEL_AGENT_GID}"

  if ! docker image inspect "$AGENT_IMAGE" >/dev/null 2>&1; then
    warn "${AGENT_IMAGE} not built yet, cannot compare its uid (run ./asel.sh build)"
    return
  fi
  local image_uid
  image_uid="$(docker run --rm "$AGENT_IMAGE" id -u 2>/dev/null || true)"
  if [ -z "$image_uid" ]; then
    warn "cannot read the uid of ${AGENT_IMAGE}, skipping the comparison"
  elif [ "$image_uid" = "$ASEL_AGENT_UID" ]; then
    ok "${AGENT_IMAGE} was built for the same uid (${image_uid})"
  else
    doctor_fail "${AGENT_IMAGE} was built for uid ${image_uid}, runs would use ${ASEL_AGENT_UID} (rebuild with ./asel.sh build)"
  fi
}

cmd_doctor() {
  doctor_docker
  doctor_config
  doctor_repos_dir
  # Before doctor_env, which sources ${ENV_FILE} into this shell: an empty
  # ASEL_AGENT_UID= line there would otherwise clobber the resolved value.
  doctor_agent_user
  doctor_env
  doctor_github
  doctor_images

  echo
  if [ "$DOCTOR_FAILURES" -eq 0 ]; then
    ok "${C_BOLD}everything checks out${C_RESET}"
    return 0
  fi
  fail "${DOCTOR_FAILURES} check(s) failed"
  return 1
}

main() {
  local command="${1:-}"
  [ "$#" -gt 0 ] && shift || true

  case "$command" in
    up) cmd_up "$@" ;;
    down) cmd_down "$@" ;;
    restart) cmd_restart "$@" ;;
    logs) cmd_logs "$@" ;;
    status) cmd_status "$@" ;;
    build) cmd_build "$@" ;;
    doctor) cmd_doctor "$@" ;;
    help | -h | --help) usage ;;
    "")
      usage
      exit 1
      ;;
    *)
      fail "unknown command: ${command}"
      echo
      usage
      exit 1
      ;;
  esac
}

main "$@"
