#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> NanoClaw Deployment"

# 1. Load images
if [[ -f nanoclaw-images.tar ]]; then
  echo "==> Loading Docker images..."
  docker load < nanoclaw-images.tar
  echo "==> Images loaded."
else
  echo "Error: nanoclaw-images.tar not found in $(pwd)" >&2
  exit 1
fi

# 2. Check .env
if [[ ! -f .env ]]; then
  if [[ -f env.example ]]; then
    echo "==> No .env found. Copying env.example to .env"
    cp env.example .env
    echo "==> IMPORTANT: Edit .env and fill in your API keys before starting!"
    echo "    vim .env"
    exit 0
  else
    echo "Error: No .env or env.example found" >&2
    exit 1
  fi
fi

# 3. Create data directories
echo "==> Creating data directories..."
mkdir -p data/groups/main data/groups/global data/store

# 4. Start services
echo "==> Starting NanoClaw..."
docker compose up -d

echo ""
echo "==> NanoClaw is running!"
echo "    WebChat: http://localhost:${WEB_PORT:-3000}"
echo "    Logs:    docker compose logs -f"
echo "    Stop:    docker compose down"
