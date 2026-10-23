#!/bin/bash
# NOTE: superseded by systemd units tesla-proxy.service and tesla-mcp.service (+ caddy); cloudflared no longer used.
cd /home/ada/tesla-fleet-mcp
for n in tunnel mcp proxy; do
  if [[ -f run/$n.sup.pid ]]; then
    p=$(cat run/$n.sup.pid); pkill -P "$p" 2>/dev/null; kill "$p" 2>/dev/null; rm -f run/$n.sup.pid; echo "$n stopped"
  fi
done
rm -f public-url.txt
