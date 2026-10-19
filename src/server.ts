import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { vinOrDefault } from "./config.ts";
import { fleet } from "./fleet.ts";
import { endpointsQuery } from "./util.ts";

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

async function run(fn: () => Promise<unknown>) {
  try {
    return text(await fn());
  } catch (e) {
    return { content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
}

const vinArg = { vin: z.string().optional() };

function vehiclePath(vin: string | undefined, suffix: string): string {
  return `/api/1/vehicles/${encodeURIComponent(vinOrDefault(vin))}${suffix}`;
}

function vehicleCommand(vin: string | undefined, name: string, body: unknown = {}) {
  return fleet("POST", vehiclePath(vin, `/command/${name}`), body, { command: true });
}

function vehicleRead(vin: string | undefined, suffix: string) {
  return fleet("GET", vehiclePath(vin, suffix));
}

const energySiteArg = {
  energy_site_id: z.union([z.string(), z.number()]).describe("energy_site_id from energy_products"),
};

function energySitePath(id: string | number, suffix: string): string {
  return `/api/1/energy_sites/${encodeURIComponent(String(id))}${suffix}`;
}

/** Energy site commands go straight to the Fleet API base (no vehicle command proxy). */
function energyCommand(id: string | number, suffix: string, body: unknown) {
  return fleet("POST", energySitePath(id, suffix), body);
}

function definedBody(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

function addWrite(
  server: McpServer,
  name: string,
  description: string,
  commandName: string,
  schema: z.ZodRawShape = {},
  body?: (args: Record<string, unknown>) => unknown,
) {
  server.tool(name, description, { vin: z.string().optional(), ...schema }, async (args) =>
    run(() =>
      vehicleCommand(args.vin as string | undefined, commandName, body ? body(args as Record<string, unknown>) : {}),
    ),
  );
}

function navigationShareBody(location: string, locale: string) {
  return {
    type: "share_ext_content_raw",
    locale,
    timestamp_ms: String(Date.now()),
    value: { "android.intent.extra.TEXT": location },
  };
}

export function createTeslaServer(): McpServer {
  const server = new McpServer({ name: "tesla", version: "0.3.0" });

  server.tool("vehicles_list", "List vehicles on the signed-in Tesla account.", {}, async () =>
    run(() => fleet("GET", "/api/1/vehicles")),
  );

  server.tool("vehicle_get", "Cheap vehicle status (state: online/asleep/offline).", vinArg, async ({ vin }) =>
    run(() => vehicleRead(vin, "")),
  );

  server.tool(
    "vehicle_data",
    "Live vehicle_data. Expensive. Use only when needed. Default is the full payload. Optional endpoints: comma or semicolon list (Tesla wants ; ). Add location_data for GPS.",
    {
      vin: z.string().optional(),
      endpoints: z.string().optional(),
    },
    async ({ vin, endpoints }) =>
      run(() => fleet("GET", `${vehiclePath(vin, "/vehicle_data")}${endpointsQuery(endpoints)}`)),
  );

  server.tool("nearby_chargers", "Charging sites near the vehicle.", vinArg, async ({ vin }) =>
    run(() => vehicleRead(vin, "/nearby_charging_sites")),
  );

  server.tool("mobile_enabled", "Whether mobile access is enabled for the vehicle.", vinArg, async ({ vin }) =>
    run(() => vehicleRead(vin, "/mobile_enabled")),
  );

  server.tool("recent_alerts", "Recent vehicle alerts.", vinArg, async ({ vin }) =>
    run(() => vehicleRead(vin, "/recent_alerts")),
  );

  server.tool("service_data", "Service status for the vehicle.", vinArg, async ({ vin }) =>
    run(() => vehicleRead(vin, "/service_data")),
  );

  server.tool("release_notes", "Firmware release notes for the vehicle.", vinArg, async ({ vin }) =>
    run(() => vehicleRead(vin, "/release_notes")),
  );

  server.tool("energy_products", "Energy and vehicle products on the signed-in account. Needs energy_device_data scope.", {}, async () =>
    run(() => fleet("GET", "/api/1/products")),
  );

  server.tool(
    "energy_live_status",
    "Live energy site status (power, soe, grid, storm). Needs energy_device_data scope.",
    { energy_site_id: z.union([z.string(), z.number()]) },
    async ({ energy_site_id }) =>
      run(() => fleet("GET", `/api/1/energy_sites/${encodeURIComponent(String(energy_site_id))}/live_status`)),
  );

  server.tool(
    "energy_site_info",
    "Energy site config, assets, and features. Needs energy_device_data scope.",
    { energy_site_id: z.union([z.string(), z.number()]) },
    async ({ energy_site_id }) =>
      run(() => fleet("GET", `/api/1/energy_sites/${encodeURIComponent(String(energy_site_id))}/site_info`)),
  );

  server.tool(
    "energy_set_operation_mode",
    "Set Powerwall operation mode. Extra confirm. self_consumption = Self-Powered; autonomous = Time-Based Control (savings). Needs energy_cmds scope.",
    { ...energySiteArg, default_real_mode: z.enum(["self_consumption", "autonomous"]) },
    async ({ energy_site_id, default_real_mode }) =>
      run(() => energyCommand(energy_site_id, "/operation", { default_real_mode })),
  );

  server.tool(
    "energy_set_backup_reserve",
    "Set Powerwall backup reserve percent (0-100) held for outages. Extra confirm. Needs energy_cmds scope.",
    { ...energySiteArg, backup_reserve_percent: z.number().int().min(0).max(100) },
    async ({ energy_site_id, backup_reserve_percent }) =>
      run(() => energyCommand(energy_site_id, "/backup", { backup_reserve_percent })),
  );

  server.tool(
    "energy_set_storm_mode",
    "Enable or disable Storm Watch (pre-charge ahead of severe weather). Needs energy_cmds scope.",
    { ...energySiteArg, enabled: z.boolean() },
    async ({ energy_site_id, enabled }) => run(() => energyCommand(energy_site_id, "/storm_mode", { enabled })),
  );

  server.tool(
    "energy_set_grid_import_export",
    "Set grid charging/export rules. Extra confirm. disallow_charge_from_grid_with_solar_installed: true blocks grid charging. customer_preferred_export_rule: pv_only (solar only), battery_ok (solar and battery), never. Pass at least one. Needs energy_cmds scope.",
    {
      ...energySiteArg,
      disallow_charge_from_grid_with_solar_installed: z.boolean().optional(),
      customer_preferred_export_rule: z.enum(["pv_only", "battery_ok", "never"]).optional(),
    },
    async ({ energy_site_id, disallow_charge_from_grid_with_solar_installed, customer_preferred_export_rule }) =>
      run(async () => {
        const body = definedBody({ disallow_charge_from_grid_with_solar_installed, customer_preferred_export_rule });
        if (Object.keys(body).length === 0) {
          throw new Error(
            "Pass disallow_charge_from_grid_with_solar_installed and/or customer_preferred_export_rule.",
          );
        }
        return energyCommand(energy_site_id, "/grid_import_export", body);
      }),
  );

  server.tool(
    "energy_set_off_grid_vehicle_charging_reserve",
    "Set the Powerwall percent kept back from vehicle charging during a grid outage (0-100). Needs energy_cmds scope.",
    { ...energySiteArg, off_grid_vehicle_charging_reserve_percent: z.number().int().min(0).max(100) },
    async ({ energy_site_id, off_grid_vehicle_charging_reserve_percent }) =>
      run(() =>
        energyCommand(energy_site_id, "/off_grid_vehicle_charging_reserve", {
          off_grid_vehicle_charging_reserve_percent,
        }),
      ),
  );

  server.tool("wake_up", "Wake the vehicle from sleep.", vinArg, async ({ vin }) =>
    run(() => fleet("POST", vehiclePath(vin, "/wake_up"))),
  );

  addWrite(server, "climate_start", "Start cabin preconditioning (needs command proxy).", "auto_conditioning_start");
  addWrite(server, "climate_stop", "Stop cabin preconditioning (needs command proxy).", "auto_conditioning_stop");
  addWrite(
    server,
    "set_temps",
    "Set cabin temps in °C (needs command proxy).",
    "set_temps",
    { driver: z.number(), passenger: z.number().optional() },
    (args) => ({ driver_temp: args.driver, passenger_temp: args.passenger ?? args.driver }),
  );
  addWrite(
    server,
    "set_climate_keeper_mode",
    "Climate keeper: 0 off, 1 keep, 2 dog, 3 camp (needs command proxy).",
    "set_climate_keeper_mode",
    {
      climate_keeper_mode: z.number().int().min(0).max(3),
      manual_override: z.boolean().optional(),
    },
    (args) => definedBody({ climate_keeper_mode: args.climate_keeper_mode, manual_override: args.manual_override }),
  );

  addWrite(server, "charge_start", "Start charging (needs command proxy).", "charge_start");
  addWrite(server, "charge_stop", "Stop charging (needs command proxy).", "charge_stop");
  addWrite(
    server,
    "set_charge_limit",
    "Set charge limit percent (needs command proxy).",
    "set_charge_limit",
    { percent: z.number() },
    (args) => ({ percent: args.percent }),
  );
  addWrite(
    server,
    "set_charging_amps",
    "Set charging amps (needs command proxy).",
    "set_charging_amps",
    { charging_amps: z.number() },
    (args) => ({ charging_amps: args.charging_amps }),
  );
  addWrite(server, "charge_port_door_open", "Open the charge port door (needs command proxy).", "charge_port_door_open");
  addWrite(server, "charge_port_door_close", "Close the charge port door (needs command proxy).", "charge_port_door_close");

  addWrite(server, "door_lock", "Lock the vehicle (needs command proxy).", "door_lock");
  addWrite(
    server,
    "door_unlock",
    "Unlock the vehicle. Extra confirm. Needs command proxy.",
    "door_unlock",
  );
  addWrite(server, "honk_horn", "Honk the horn. Vehicle must be in park. Needs command proxy.", "honk_horn");
  addWrite(server, "flash_lights", "Flash the headlights. Vehicle must be in park. Needs command proxy.", "flash_lights");
  addWrite(
    server,
    "actuate_trunk",
    "Open or close front (frunk) or rear trunk (needs command proxy).",
    "actuate_trunk",
    { which_trunk: z.enum(["front", "rear"]) },
    (args) => ({ which_trunk: args.which_trunk }),
  );
  addWrite(
    server,
    "window_control",
    "Vent or close windows on a parked vehicle (needs command proxy). Close may need lat/lon except on Model 3 platform.",
    "window_control",
    {
      command: z.enum(["vent", "close"]),
      lat: z.number().optional(),
      lon: z.number().optional(),
    },
    (args) => definedBody({ command: args.command, lat: args.lat, lon: args.lon }),
  );
  addWrite(
    server,
    "remote_start_drive",
    "Remote start. Extra confirm. Requires keyless driving. Needs command proxy.",
    "remote_start_drive",
  );

  addWrite(
    server,
    "set_sentry_mode",
    "Enable or disable Sentry Mode (needs command proxy).",
    "set_sentry_mode",
    { on: z.boolean() },
    (args) => ({ on: args.on }),
  );

  addWrite(server, "media_toggle_playback", "Toggle play/pause (needs command proxy).", "media_toggle_playback");
  addWrite(server, "media_next_track", "Next media track (needs command proxy).", "media_next_track");
  addWrite(server, "media_prev_track", "Previous media track (needs command proxy).", "media_prev_track");
  addWrite(server, "media_volume_up", "Volume up one step (needs command proxy).", "media_volume_up");
  addWrite(server, "media_volume_down", "Volume down one step (needs command proxy).", "media_volume_down");
  addWrite(
    server,
    "adjust_volume",
    "Set media volume. User must be present with mobile access enabled. Needs command proxy.",
    "adjust_volume",
    { volume: z.number() },
    (args) => ({ volume: args.volume }),
  );

  addWrite(
    server,
    "navigation_request",
    "Share a location or address to the car (needs command proxy; proxy forwards this REST command).",
    "navigation_request",
    { text: z.string(), locale: z.string().optional() },
    (args) => navigationShareBody(String(args.text), typeof args.locale === "string" ? args.locale : "en-US"),
  );
  addWrite(
    server,
    "navigation_gps_request",
    "Start navigation to coordinates (needs command proxy).",
    "navigation_gps_request",
    { lat: z.number(), lon: z.number(), order: z.number().optional() },
    (args) => definedBody({ lat: args.lat, lon: args.lon, order: args.order }),
  );

  addWrite(
    server,
    "schedule_software_update",
    "Schedule an OTA install offset_sec seconds from now (needs command proxy).",
    "schedule_software_update",
    { offset_sec: z.number() },
    (args) => ({ offset_sec: args.offset_sec }),
  );
  addWrite(
    server,
    "cancel_software_update",
    "Cancel a pending software update countdown (needs command proxy).",
    "cancel_software_update",
  );

  addWrite(
    server,
    "add_charge_schedule",
    "Add or update a charge schedule. View via vehicle_data charge_schedule_data. Needs command proxy.",
    "add_charge_schedule",
    {
      lat: z.number(),
      lon: z.number(),
      days_of_week: z.string(),
      enabled: z.boolean(),
      start_enabled: z.boolean(),
      end_enabled: z.boolean(),
      start_time: z.number().optional(),
      end_time: z.number().optional(),
      one_time: z.boolean().optional(),
      id: z.number().optional(),
    },
    (args) =>
      definedBody({
        lat: args.lat,
        lon: args.lon,
        days_of_week: args.days_of_week,
        enabled: args.enabled,
        start_enabled: args.start_enabled,
        end_enabled: args.end_enabled,
        start_time: args.start_time,
        end_time: args.end_time,
        one_time: args.one_time,
        id: args.id,
      }),
  );
  addWrite(
    server,
    "remove_charge_schedule",
    "Remove a charge schedule by id (needs command proxy).",
    "remove_charge_schedule",
    { id: z.number() },
    (args) => ({ id: args.id }),
  );
  addWrite(
    server,
    "add_precondition_schedule",
    "Add or update a precondition schedule. View via vehicle_data preconditioning_schedule_data. Needs command proxy.",
    "add_precondition_schedule",
    {
      lat: z.number(),
      lon: z.number(),
      days_of_week: z.string(),
      enabled: z.boolean(),
      precondition_time: z.number(),
      one_time: z.boolean().optional(),
      id: z.number().optional(),
    },
    (args) =>
      definedBody({
        lat: args.lat,
        lon: args.lon,
        days_of_week: args.days_of_week,
        enabled: args.enabled,
        precondition_time: args.precondition_time,
        one_time: args.one_time,
        id: args.id,
      }),
  );
  addWrite(
    server,
    "remove_precondition_schedule",
    "Remove a precondition schedule by id (needs command proxy).",
    "remove_precondition_schedule",
    { id: z.number() },
    (args) => ({ id: args.id }),
  );

  addWrite(
    server,
    "set_valet_mode",
    "Valet mode on/off. Extra confirm. On requires a four-digit PIN. Needs command proxy.",
    "set_valet_mode",
    { on: z.boolean(), password: z.string().optional() },
    (args) => definedBody({ on: args.on, password: args.password }),
  );
  addWrite(
    server,
    "reset_valet_pin",
    "Clear valet PIN. Extra confirm. Valet mode must already be off. Needs command proxy.",
    "reset_valet_pin",
  );
  addWrite(
    server,
    "guest_mode",
    "Enable or disable Guest Mode. Extra confirm. Needs command proxy.",
    "guest_mode",
    { enable: z.boolean() },
    (args) => ({ enable: args.enable }),
  );
  addWrite(
    server,
    "speed_limit_set_limit",
    "Set Speed Limit Mode max speed in mph. Extra confirm. Needs command proxy.",
    "speed_limit_set_limit",
    { limit_mph: z.number() },
    (args) => ({ limit_mph: args.limit_mph }),
  );
  addWrite(
    server,
    "speed_limit_activate",
    "Activate Speed Limit Mode with a four-digit PIN. Extra confirm. Needs command proxy.",
    "speed_limit_activate",
    { pin: z.string() },
    (args) => ({ pin: args.pin }),
  );
  addWrite(
    server,
    "speed_limit_deactivate",
    "Deactivate Speed Limit Mode with the PIN. Extra confirm. Needs command proxy.",
    "speed_limit_deactivate",
    { pin: z.string() },
    (args) => ({ pin: args.pin }),
  );
  addWrite(
    server,
    "speed_limit_clear_pin",
    "Deactivate Speed Limit Mode and reset the PIN. Extra confirm. Needs command proxy.",
    "speed_limit_clear_pin",
    { pin: z.string() },
    (args) => ({ pin: args.pin }),
  );
  addWrite(
    server,
    "speed_limit_clear_pin_admin",
    "Owner/fleet-manager Speed Limit PIN clear (firmware 2023.38+). Extra confirm. Needs command proxy.",
    "speed_limit_clear_pin_admin",
  );
  addWrite(
    server,
    "reset_pin_to_drive_pin",
    "Remove PIN to Drive. Extra confirm. Owner/fleet-manager. PIN to Drive must not be active. Needs command proxy.",
    "reset_pin_to_drive_pin",
  );
  addWrite(
    server,
    "clear_pin_to_drive_admin",
    "Deactivate PIN to Drive and reset the PIN (firmware 2023.44+). Extra confirm. Owner/fleet-manager. Needs command proxy.",
    "clear_pin_to_drive_admin",
  );
  addWrite(
    server,
    "erase_user_data",
    "Erase UI user data. Extra confirm. Vehicle must be parked in Guest Mode. Needs command proxy.",
    "erase_user_data",
  );

  return server;
}
