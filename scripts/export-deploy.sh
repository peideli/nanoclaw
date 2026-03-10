#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$PROJECT_ROOT/dist-deploy"
ARCHIVE="$PROJECT_ROOT/nanoclaw-deploy.tar.gz"

# Support --platform flag: build images for target platform before exporting
PLATFORM=""
for arg in "$@"; do
  if [[ "$arg" == --platform=* ]]; then
    PLATFORM="${arg#--platform=}"
  fi
done

echo "==> NanoClaw Deploy Packager${PLATFORM:+ (platform: $PLATFORM)}"

# Build images if --platform specified
if [[ -n "$PLATFORM" ]]; then
  echo "==> Building images for $PLATFORM..."
  "$SCRIPT_DIR/build-images.sh" --platform="$PLATFORM" base
  "$SCRIPT_DIR/build-images.sh" --platform="$PLATFORM" agent
fi

# Check images exist
for img in nanoclaw-base:latest nanoclaw-agent:latest; do
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    echo "Error: image $img not found. Run 'scripts/build-images.sh base' and 'scripts/build-images.sh agent' first." >&2
    exit 1
  fi
done

# Clean previous output
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# 1. Export images
echo "==> Saving Docker images (this may take a while)..."
docker save nanoclaw-base:latest nanoclaw-agent:latest -o "$OUTPUT_DIR/nanoclaw-images.tar"
echo "    Images saved: $(du -h "$OUTPUT_DIR/nanoclaw-images.tar" | cut -f1)"

# 2. Copy docker-compose.yml
cp "$PROJECT_ROOT/docker-compose.yml" "$OUTPUT_DIR/docker-compose.yml"

# 3. Copy deploy files
cp "$PROJECT_ROOT/deploy/env.example" "$OUTPUT_DIR/env.example"
cp "$PROJECT_ROOT/deploy/deploy.sh" "$OUTPUT_DIR/deploy.sh"
chmod +x "$OUTPUT_DIR/deploy.sh"

# 4. Create archive
echo "==> Creating archive..."
tar -czf "$ARCHIVE" -C "$OUTPUT_DIR" .

echo "==> Done!"
echo "    Archive: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
echo ""
echo "    To deploy on target machine:"
echo "      tar xzf nanoclaw-deploy.tar.gz -C nanoclaw && cd nanoclaw"
echo "      cp env.example .env && vim .env"
echo "      ./deploy.sh"

# Cleanup
rm -rf "$OUTPUT_DIR"
