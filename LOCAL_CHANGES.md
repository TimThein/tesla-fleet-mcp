# Local changes (Tim's self-hosted deployment)

Base: upstream `supervised-nl/tesla-fleet-mcp` commit `420c6e2` (v0.3.0). This checkout is not a git repo; changes below were found by diffing against the upstream tarball at that commit. Edited files have dated backups (`*.bak-YYYYMMDD`).

## 2026-10-22 — Energy history read tools
New read-only tools in `src/server.ts` (registered in `src/tools.ts` `TESLA_TOOL_NAMES`). Both use the shared `fleet()` helper, so they go through `acquireToken()` (refresh lock). Need scope `energy_device_data` (already in `SCOPES` in `src/config.ts`; no re-login needed).

### `get_energy_telemetry_history`
`GET /api/1/energy_sites/{energy_site_id}/telemetry_history`

| Param | Default | Notes |
|---|---|---|
| `energy_site_id` | required | from `energy_products` |
| `kind` | `charge` | Wall Connector charge history |
| `start_date`, `end_date` | — | RFC3339, e.g. `2026-10-22T00:00:00-07:00` |
| `time_zone` | `America/Los_Angeles` | |

Example: `{"energy_site_id":"<id>","kind":"charge","start_date":"2026-10-22T00:00:00-07:00","end_date":"2026-10-22T23:59:59-07:00"}`
Finding: returns `{"response":{"charge_history":null}}` on this site (Wall Connector offline / not on Wi-Fi).

### `get_energy_calendar_history`
`GET /api/1/energy_sites/{energy_site_id}/calendar_history`

| Param | Default | Notes |
|---|---|---|
| `energy_site_id` | required | |
| `kind` | `energy` | any string passed through (`energy`, `soe`, `power`, `backup`, ...) |
| `start_date`, `end_date` | — | RFC3339 |
| `period` | — | `day` / `week` / `month` / `year` |
| `time_zone` | `America/Los_Angeles` | |

Example: `{"energy_site_id":"<id>","kind":"soe","period":"day","start_date":"2026-10-22T00:00:00-07:00","end_date":"2026-10-22T23:59:59-07:00"}`

Findings (2026-10-22, period=day):
- `kind=energy`: works. 5-min buckets (Wh) through current time; fields include solar/grid/battery/consumer imported/exported breakdowns plus `total_home_usage`, `total_battery_discharge`, `total_grid_energy_exported`.
- `kind=soe`: works. 15-min Powerwall state of energy in percent (`{"timestamp","soe"}`) through current time. This is the battery % history; on 2026-10-22 it first read 100 at 15:30 PT (98 at 15:15), consistent with the 30-min log (99% ~15:33, 100% 16:02).
- `kind=power`: works. 5-min average power (W): `solar_power`, `battery_power`, `grid_power`, `grid_services_power`, `generator_power`; returns the full day (future buckets zero).

## 2026-10-21 — Token refresh fix (`src/auth.ts`)
Why: Tesla refresh tokens rotate and are single-use. Parallel tool calls each refreshed with the same refresh token; the losers' reuse got the whole grant revoked (`login_required`), forcing re-login.
- Single-flight refresh: `acquireToken()` returns the cached access token if valid; otherwise all callers share one in-flight `refreshToken()` promise.
- Atomic token-cache write: write to `<cache>.tmp-<pid>` (mode 600) then `renameSync` over the cache, so a crash never leaves a truncated cache.
- Backup of the original: `src/auth.ts.bak-20261021`.

Re-login (if the grant is ever revoked), on the VM in the project dir:
```bash
set -a; source .env; set +a
npm run login                       # prints the authorize URL; open it, approve
npm run login -- "<full callback URL>"   # paste https://tesla.timthein.net/callback?code=...
sudo systemctl restart tesla-mcp.service
```
Never print or commit `.env`, the token cache, or the callback URL (contains a one-time code).

## Earlier local changes (2026-10-19/20)
- `src/oauth.ts` (new) + `src/http.ts`: built-in OAuth 2.1 (PKCE, passphrase-gated authorize, `/.well-known/*` metadata, store `oauth-tokens.json`, passphrase hash `oauth-passphrase.hash`; env `TESLA_OAUTH_PASSPHRASE_HASH_FILE`, `TESLA_OAUTH_STORE`, `TESLA_OAUTH_EXTRA_REDIRECT_HOSTS`). `/mcp` accepts either the static `TESLA_MCP_TOKEN` bearer or an OAuth access token; 401 advertises `resource_metadata`. Adds request logging (method, path, UA, auth scheme/length only; no token values).
- `src/config.ts`: added `energy_cmds` scope.
- `src/server.ts` / `src/tools.ts`: Powerwall write tools `energy_set_operation_mode`, `energy_set_backup_reserve`, `energy_set_storm_mode`, `energy_set_grid_import_export`, `energy_set_off_grid_vehicle_charging_reserve` (direct to Fleet API, no command proxy; need `energy_cmds`), plus helpers `energySiteArg`, `energySitePath`, `energyCommand`, `definedBody`.
- `.gitignore`: added `logs/`, `run/`, `mcp-token.txt`, `public-url.txt`.
- New scripts: `reinstall.sh` (pinned reinstall), `start-all.sh` / `stop-all.sh` (legacy nohup+cloudflared supervisor, superseded by systemd `tesla-proxy.service`, `tesla-mcp.service` + Caddy).
- `SETUP-NOTES.md`: deployment notes.

## Known test note
`npm test`: `tests/http.test.ts > lists tools and runs one read` fails on this VM because it finds the real token cache and gets a live Tesla 412 instead of the expected "Not signed in". Environment-dependent, not caused by these changes. `tsc --noEmit` passes.
