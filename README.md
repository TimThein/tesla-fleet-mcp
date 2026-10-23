# tesla-fleet-mcp

Tesla [Fleet API](https://developer.tesla.com/docs/fleet-api) MCP for **Grok Bot**, **Grok Build**, and Cursor.

Grok does not accept stdio or localhost. Host this server over **Streamable HTTP** on a public HTTPS URL, then connect the `tesla` plugin.

- **Grok Bot / Grok Build / Cursor Cloud.** Streamable HTTP (`npm run start:http`) + plugin in [`tesla/`](tesla/)
- **Local Cursor / Hermes.** stdio (`./run.sh`)

Plugin and MCP server name: `tesla`.

Vehicle commands need Tesla’s official [`tesla-http-proxy`](https://github.com/teslamotors/vehicle-command) plus a virtual key on the car. That proxy is **not** bundled here.

## Grok Bot

1. Run Streamable HTTP and expose `/mcp` on public HTTPS (your host or Cloudflare Tunnel).
2. In Grok Bot: **Plugins → connect `tesla`**.
3. Set `TESLA_MCP_URL` (`https://…/mcp`) and `TESLA_MCP_TOKEN` (same value as the server `TESLA_MCP_TOKEN`).

Fallback if the plugin is not in the marketplace yet:

| Field | Value |
| --- | --- |
| Name | `tesla` |
| Type | `http` |
| URL | your public `https://…/mcp` |
| Header | `Authorization: Bearer <TESLA_MCP_TOKEN>` |

Do not add a second Tesla MCP entry. Tesla Fleet / Tessie tokens stay in server env, never in Grok.

## Grok Build

```text
/plugin
```

or

```bash
grok plugin install tesla
```

Then connect `tesla`. Manifest: [`tesla/.grok-plugin/plugin.json`](tesla/.grok-plugin/plugin.json). MCP: [`tesla/.mcp.json`](tesla/.mcp.json).

## Cursor

Install **tesla** from the [Cursor Marketplace](https://cursor.com/marketplace) (or open [`tesla/`](tesla/)), then **Settings → Tools & MCP → Connect** `tesla`. Same two variables as Grok.

Details: [`tesla/README.md`](tesla/README.md).

## Third-party host checklist

Tesla registers your app against a domain you own. Use this list before the first Fleet call.

- Pick an HTTPS hostname you own. The hostname must not contain the word `tesla`.
- Set the developer app allowed origin to `https://your.domain` and the redirect to `https://your.domain/callback`.
- Host **only** the public key at `https://your.domain/.well-known/appspecific/com.tesla.3p.public-key.pem`. Do not host `private-key.pem`.
- Confirm that URL returns `200` with the PEM body and no redirect.
- Register the partner account with `POST /api/1/partner_accounts` in **each** Fleet region you use.
- Set `TESLA_AUDIENCE` to that region’s Fleet origin. Set `TESLA_REGION` to `eu` or `na`, or set `TESLA_FLEET_BASE` to the same origin if you need an explicit override.
- Pair the virtual key (`https://tesla.com/_ak/your.domain`) before vehicle commands.
- Keep `tesla-http-proxy` on localhost. Do not publish it next to the public MCP URL.
- The `tesla` plugin only gets `TESLA_MCP_URL` and `TESLA_MCP_TOKEN`. Fleet secrets stay on the host.

## Tools

Reads hit `TESLA_FLEET_BASE` (or the region default). Writes under `/command/*` hit `TESLA_COMMAND_BASE` and fail without that proxy. `wake_up` is a Fleet POST and does not use the proxy.

Do **not** poll `vehicle_data`. Tesla bills per call. Check `vehicle_get` first.

A comma-separated `endpoints` query returns **metadata only** (no `charge_state`). This server rewrites commas to `;`.

### Reads (no command proxy)

| Tool | Notes |
|---|---|
| `vehicles_list` | Account vehicles |
| `vehicle_get` | Cheap state (`online` / `asleep` / `offline`) |
| `vehicle_data` | Live data. Billable. Optional `endpoints`; Tesla wants `;`. `location_data` for GPS |
| `nearby_chargers` | Nearby charge sites |
| `mobile_enabled` | Mobile access enabled |
| `recent_alerts` | Recent alerts |
| `service_data` | Service status |
| `release_notes` | Firmware release notes |
| `energy_products` | `GET /api/1/products`. Needs `energy_device_data` (re-login after upgrade) |
| `energy_live_status` | `energy_site_id`. Live power / soe / grid |
| `energy_site_info` | `energy_site_id`. Site config |
| `get_energy_telemetry_history` | `energy_site_id`, `kind` (default `charge`; Wall Connector history, may be `null`), `start_date`/`end_date` (RFC3339), `time_zone`. Needs `energy_device_data` |
| `get_energy_calendar_history` | `energy_site_id`, `kind` (default `energy`; also `soe` = battery % history, `power`, `backup`), `start_date`/`end_date`, `period` (day/week/month/year), `time_zone`. Needs `energy_device_data` |

### Writes that need `TESLA_COMMAND_BASE`

| Tool | Notes |
|---|---|
| `climate_start` / `climate_stop` / `set_temps` / `set_climate_keeper_mode` | Climate. Keeper: 0 off, 1 keep, 2 dog, 3 camp |
| `charge_start` / `charge_stop` / `set_charge_limit` / `set_charging_amps` | Charging |
| `charge_port_door_open` / `charge_port_door_close` | Charge port |
| `door_lock` / `door_unlock` | `door_unlock` needs extra confirm |
| `honk_horn` / `flash_lights` | Park required |
| `actuate_trunk` | `which_trunk`: `front` or `rear` |
| `window_control` | `vent` or `close`. Close may need `lat` / `lon` |
| `remote_start_drive` | Extra confirm. Keyless driving |
| `set_sentry_mode` | `on` boolean |
| `media_toggle_playback` / `media_next_track` / `media_prev_track` | Media |
| `media_volume_up` / `media_volume_down` / `adjust_volume` | Volume. `adjust_volume` needs user present |
| `navigation_request` | Share-to-car text. Proxy forwards this REST command |
| `navigation_gps_request` | `lat` / `lon` |
| `schedule_software_update` / `cancel_software_update` | OTA. `offset_sec` for schedule |
| `add_charge_schedule` / `remove_charge_schedule` | View via `vehicle_data` `charge_schedule_data` |
| `add_precondition_schedule` / `remove_precondition_schedule` | View via `preconditioning_schedule_data` |
| `set_valet_mode` / `reset_valet_pin` | Extra confirm |
| `guest_mode` | Extra confirm. `enable` boolean |
| `speed_limit_set_limit` / `speed_limit_activate` / `speed_limit_deactivate` | Extra confirm. Limit is mph |
| `speed_limit_clear_pin` / `speed_limit_clear_pin_admin` | Extra confirm. PIN clear |
| `reset_pin_to_drive_pin` / `clear_pin_to_drive_admin` | Extra confirm. Owner / fleet manager |
| `erase_user_data` | Extra confirm. Parked Guest Mode |

### Other writes

| Tool | Notes |
|---|---|
| `wake_up` | Fleet wake. No command proxy |

The live name list is `TESLA_TOOL_NAMES` in [`src/tools.ts`](src/tools.ts). Tests fail if it drifts from `listTools()`.

## Requirements

- Node 20+
- A Tesla developer application ([dashboard](https://developer.tesla.com/dashboard))
- An HTTPS hostname **you own** (must not contain the word `tesla`)
- Public key at `https://<your-domain>/.well-known/appspecific/com.tesla.3p.public-key.pem`
- Partner `POST /api/1/partner_accounts` in each region you use
- Payment method + billing limit (Fleet API is pay-as-you-go; ~$10/month credit)

## Environment

Copy `env.example` and point `TESLA_CACHE_PATH` at a `0600` file outside git.

| Variable | Required | Meaning |
|---|---|---|
| `TESLA_CLIENT_ID` | yes | Developer app client id |
| `TESLA_CLIENT_SECRET` | yes | Developer app secret |
| `TESLA_REDIRECT_URI` | yes | Must match the app’s allowed redirect (e.g. `https://your.domain/callback`) |
| `TESLA_AUDIENCE` | yes | Fleet base URL for your region (EU example in `env.example`) |
| `TESLA_FLEET_BASE` | no | Override Fleet origin. Default is `TESLA_REGION` (`eu` or `na`) |
| `TESLA_CACHE_PATH` | no | Token cache path (default: `./token-cache.json`) |
| `TESLA_REGION` | no | `eu` (default) or `na` |
| `TESLA_VIN` | no | Default vehicle if tools omit `vin` |
| `TESLA_COMMAND_BASE` | no | Proxy origin, e.g. `https://127.0.0.1:4443`. Required for `/command/*` tools |
| `NODE_EXTRA_CA_CERTS` | no | Proxy TLS CA if you use a self-signed localhost cert |
| `TESLA_MCP_TOKEN` | HTTP | Bearer gate for Streamable HTTP. **Not** a Fleet/Tessie token |
| `TESLA_MCP_HOST` | HTTP | Bind address (default `0.0.0.0`) |
| `TESLA_MCP_PORT` | HTTP | Bind port (default `8787`) |
| `MCP_TRANSPORT` | HTTP | Set `http` to start Streamable HTTP instead of stdio |

Never commit secrets. Never paste refresh tokens, client secrets, VIN, or `TESLA_MCP_TOKEN` into chat.

## Setup (once)

1. Create the Tesla developer app. Grant type: authorization code **and** machine-to-machine.
2. Allowed origin: `https://your.domain`. Allowed redirect: `https://your.domain/callback`.
3. Scopes you need, typically: `openid`, `offline_access`, `vehicle_device_data`, plus `vehicle_cmds` / `vehicle_charging_cmds` / `vehicle_location`. Add `energy_device_data` for energy tools, then run `npm run login` again.
4. Generate a P-256 key pair:

```bash
openssl ecparam -name prime256v1 -genkey -noout -out private-key.pem
openssl ec -in private-key.pem -pubout -out public-key.pem
```

Host **only** the public key at:

`https://your.domain/.well-known/appspecific/com.tesla.3p.public-key.pem`

5. Register the partner account (EU example):

```bash
# partner token
curl -s --data-urlencode grant_type=client_credentials \
  --data-urlencode client_id="$TESLA_CLIENT_ID" \
  --data-urlencode client_secret="$TESLA_CLIENT_SECRET" \
  --data-urlencode audience="$TESLA_AUDIENCE" \
  --data-urlencode scope='openid vehicle_device_data vehicle_cmds' \
  https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token

# then POST {"domain":"your.domain"} to $TESLA_AUDIENCE/api/1/partner_accounts
# with Authorization: Bearer <partner access_token>
```

6. User login (owner of the car):

```bash
set -a && source .env && set +a
npm install
npm run login
# open the printed URL, approve, paste the full https://your.domain/callback?code=... URL:
npm run login -- "https://your.domain/callback?code=...."
```

The callback host only needs to accept the browser hit; this CLI reads the URL you paste. A blank page is fine.

## Start

Grok Bot / Grok Build (Streamable HTTP). Public URL must be HTTPS, not localhost. Set that origin as `TESLA_MCP_URL`:

```bash
export TESLA_MCP_TOKEN  # long random secret; same value as the Grok plugin variable
MCP_TRANSPORT=http npm run start:http
# cloudflared tunnel --url http://127.0.0.1:8787
```

Local Cursor / Hermes (stdio):

```bash
./run.sh
```

Hermes stdio wrapper: `hermes mcp add tesla-fleet --command /path/to/tesla-fleet-mcp/run.sh`

`run.sh` sources `.env` in the repo directory **or** `$TESLA_ENV` if set. Restart the Hermes process/gateway after adding. Enable/disable tools in the client (`tools.include` / `exclude`), not with extra server flags.

## Commands (optional)

Model 3 / Y and recent S/X require the [Vehicle Command Protocol](https://github.com/teslamotors/vehicle-command). Unsigned Fleet command calls are rejected.

1. Run `tesla-http-proxy` with your **private** key, TLS, **localhost only**.
2. Pair the virtual key (Tesla app, car online): `https://tesla.com/_ak/your.domain`
3. Set `TESLA_COMMAND_BASE=https://127.0.0.1:4443` (and `NODE_EXTRA_CA_CERTS` if the proxy cert is self-signed).

Do not publish the proxy to the internet. This repo does not vendor or start that binary.

## Docker Compose notes

HTTP MCP can run in Compose if you bind **localhost only**. Keep Fleet secrets in an uncommitted `.env`. Do not publish `tesla-http-proxy`. If you add it as a sidecar, give it `network_mode: host` or a shared network, listen on `127.0.0.1:4443`, and omit ports for the proxy service.

```yaml
services:
  tesla-mcp:
    image: node:20-bookworm
    working_dir: /app
    volumes:
      - ./:/app
    command: bash -lc "npm ci && npm run start:http"
    env_file: .env
    environment:
      MCP_TRANSPORT: http
      TESLA_MCP_HOST: 0.0.0.0
    ports:
      - "127.0.0.1:8787:8787"
```

Point Cloudflare Tunnel (or similar) at `http://127.0.0.1:8787`. Do not publish `8787` on `0.0.0.0` unless something else already gates that port.

## Dev

```bash
npm test
npx tsc --noEmit
```

## License

MIT
