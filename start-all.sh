#!/bin/bash
# NOTE: superseded by systemd units tesla-proxy.service and tesla-mcp.service (+ caddy); cloudflared no longer used.
# Idempotent: starts supervised proxy, MCP (http), and cloudflared quick tunnel.
D=/home/ada/tesla-fleet-mcp
cd "$D"; mkdir -p logs run
export PATH=/home/ada/.local/bin:$PATH
sup() { # name, command...
  local n=$1; shift
  if [[ -f run/$n.sup.pid ]] && kill -0 "$(cat run/$n.sup.pid)" 2>/dev/null; then echo "$n already running"; return; fi
  nohup bash -c 'while true; do "$@"; echo "[$(date)] exited, restart in 3s"; sleep 3; done' _ "$@" >> logs/$n.log 2>&1 &
  echo $! > run/$n.sup.pid; echo "$n started"
}
sup proxy /home/ada/tesla-http-proxy/run.sh
sup mcp env TESLA_MCP_HOST=127.0.0.1 TESLA_MCP_PORT=8787 "$D/run.sh" --http
# tunnel: fronts ONLY the MCP port
sup tunnel /home/ada/.local/bin/cloudflared tunnel --protocol http2 --no-autoupdate --url http://127.0.0.1:8787
for i in $(seq 1 40); do
  U=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' logs/tunnel.log | tail -1)
  [[ -n $U ]] && { echo "$U" > public-url.txt; echo "public: $U/mcp"; exit 0; }
  sleep 1
done
echo "tunnel URL not found yet"; exit 1
