#!/bin/bash
# Idempotent reinstall of tesla-fleet-mcp. Never touches key/secret dirs.
set -euo pipefail
DIR="${TESLA_MCP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PIN=420c6e2be6324d0b2477e1f163f7429ad9c94019
REPO=https://github.com/supervised-nl/tesla-fleet-mcp.git
if [ ! -d "$DIR/.git" ]; then
  mkdir -p "$DIR"; git clone "$REPO" "$DIR.tmp" && cp -a "$DIR.tmp/." "$DIR/" && rm -rf "$DIR.tmp"
fi
cd "$DIR"
git fetch -q origin && git checkout -q "$PIN"
npm ci --no-audit --no-fund
if [ ! -f .env ]; then
  cat > .env <<ENV
TESLA_CLIENT_ID=
TESLA_CLIENT_SECRET=
TESLA_REDIRECT_URI=
TESLA_AUDIENCE=
TESLA_REGION=
TESLA_CACHE_PATH=$DIR/token-cache.json
TESLA_VIN=
TESLA_COMMAND_BASE=
TESLA_MCP_TOKEN=
TESLA_MCP_HOST=127.0.0.1
TESLA_MCP_PORT=8787
MCP_TRANSPORT=
ENV
fi
chmod 600 .env
[ -f token-cache.json ] && chmod 600 token-cache.json || true
echo "Done. Run: ./run.sh (stdio) or ./run.sh --http"
