#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  cat <<EOF
Usage: $(basename "$0") <command> [args]

Commands:
  base              Build nanoclaw-base host image
  agent             Build nanoclaw-agent container image
  tenant <name>     Build nanoclaw-<name> tenant image (from tenants/<name>/)

Examples:
  $(basename "$0") base
  $(basename "$0") agent
  $(basename "$0") tenant acme
EOF
  exit 1
}

build_base() {
  echo "==> Building nanoclaw-base:latest"
  docker build -t nanoclaw-base:latest "$PROJECT_ROOT"
  echo "==> Done: nanoclaw-base:latest"
}

build_agent() {
  echo "==> Building nanoclaw-agent:latest"
  "$PROJECT_ROOT/container/build.sh"
  echo "==> Done: nanoclaw-agent:latest"
}

build_tenant() {
  local name="$1"
  local tenant_dir="$PROJECT_ROOT/tenants/$name"

  if [[ ! -d "$tenant_dir" ]]; then
    echo "Error: tenant directory not found: $tenant_dir" >&2
    echo "Hint: copy tenants/_template/ to tenants/$name/ and customize" >&2
    exit 1
  fi

  if [[ ! -f "$tenant_dir/Dockerfile" ]]; then
    echo "Error: no Dockerfile in $tenant_dir" >&2
    exit 1
  fi

  echo "==> Building nanoclaw-$name:latest"
  docker build \
    --build-arg "TENANT_NAME=$name" \
    -t "nanoclaw-$name:latest" \
    "$tenant_dir"
  echo "==> Done: nanoclaw-$name:latest"
}

[[ $# -lt 1 ]] && usage

case "$1" in
  base)
    build_base
    ;;
  agent)
    build_agent
    ;;
  tenant)
    [[ $# -lt 2 ]] && { echo "Error: tenant name required" >&2; usage; }
    build_tenant "$2"
    ;;
  *)
    echo "Unknown command: $1" >&2
    usage
    ;;
esac
