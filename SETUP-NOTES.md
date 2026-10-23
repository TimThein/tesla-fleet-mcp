# tesla-fleet-mcp setup notes
Pinned commit 420c6e2 (v0.3.0); deps pinned by package-lock.json (`npm ci`). Needs Node >= 20 (system /usr/bin/node v20.19.2). Rebuild: `./reinstall.sh`.

## Required config (.env, mode 600, fill in; never print)
- TESLA_CLIENT_ID, TESLA_CLIENT_SECRET (Tesla developer app)
- TESLA_REDIRECT_URI = https://tesla.timthein.net/callback
- Allowed origin: https://tesla.timthein.net
- TESLA_AUDIENCE / TESLA_REGION (na or eu) – fleet region origin
- TESLA_MCP_TOKEN: long random secret for HTTP mode (also set in Grok plugin)
- Scopes: openid offline_access vehicle_device_data vehicle_cmds vehicle_charging_cmds vehicle_location energy_device_data energy_cmds
  (re-run `npm run login` after adding scopes)
- Public key hosted at https://tesla.timthein.net/.well-known/appspecific/com.tesla.3p.public-key.pem
- Private key: /home/box/tesla-keys/private-key.pem — do NOT copy or print. Only needed by tesla-http-proxy (vehicle commands), not bundled; the MCP itself doesn't read it.
- Partner registration POST /api/1/partner_accounts per region.

## Run
- stdio: ./run.sh    HTTP: ./run.sh --http (127.0.0.1:8787; needs public HTTPS tunnel + TESLA_MCP_TOKEN)
- Login: `set -a; source .env; set +a; npm run login`, open URL, approve, then `npm run login -- "<full callback URL>"`. Tokens cached in TESLA_CACHE_PATH (keep 600).

## Local changes
See LOCAL_CHANGES.md (energy history tools 2026-10-22; single-flight refresh + atomic token-cache write in src/auth.ts 2026-10-21; OAuth; Powerwall writes). After a re-login, restart: `sudo systemctl restart tesla-mcp.service`.
