export type TeslaToolKind = "read" | "write";
export type TeslaDanger = "confirm" | "extra-confirm";

export type TeslaToolMeta = {
  name: string;
  kind: TeslaToolKind;
  needsProxy: boolean;
  danger?: TeslaDanger;
};

export const TESLA_TOOLS = [
  { name: "vehicles_list", kind: "read", needsProxy: false },
  { name: "vehicle_get", kind: "read", needsProxy: false },
  { name: "vehicle_data", kind: "read", needsProxy: false },
  { name: "nearby_chargers", kind: "read", needsProxy: false },
  { name: "mobile_enabled", kind: "read", needsProxy: false },
  { name: "recent_alerts", kind: "read", needsProxy: false },
  { name: "service_data", kind: "read", needsProxy: false },
  { name: "release_notes", kind: "read", needsProxy: false },
  { name: "energy_products", kind: "read", needsProxy: false },
  { name: "energy_live_status", kind: "read", needsProxy: false },
  { name: "energy_site_info", kind: "read", needsProxy: false },
  { name: "get_energy_telemetry_history", kind: "read", needsProxy: false },
  { name: "get_energy_calendar_history", kind: "read", needsProxy: false },
  { name: "energy_set_operation_mode", kind: "write", needsProxy: false, danger: "extra-confirm" },
  { name: "energy_set_backup_reserve", kind: "write", needsProxy: false, danger: "extra-confirm" },
  { name: "energy_set_storm_mode", kind: "write", needsProxy: false, danger: "confirm" },
  { name: "energy_set_grid_import_export", kind: "write", needsProxy: false, danger: "extra-confirm" },
  { name: "energy_set_off_grid_vehicle_charging_reserve", kind: "write", needsProxy: false, danger: "confirm" },
  { name: "wake_up", kind: "write", needsProxy: false, danger: "confirm" },
  { name: "climate_start", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "climate_stop", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "set_temps", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "set_climate_keeper_mode", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "charge_start", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "charge_stop", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "set_charge_limit", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "set_charging_amps", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "charge_port_door_open", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "charge_port_door_close", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "door_lock", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "door_unlock", kind: "write", needsProxy: true, danger: "extra-confirm" },
  { name: "honk_horn", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "flash_lights", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "actuate_trunk", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "window_control", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "remote_start_drive", kind: "write", needsProxy: true, danger: "extra-confirm" },
  { name: "set_sentry_mode", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "media_toggle_playback", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "media_next_track", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "media_prev_track", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "media_volume_up", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "media_volume_down", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "adjust_volume", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "navigation_request", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "navigation_gps_request", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "schedule_software_update", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "cancel_software_update", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "add_charge_schedule", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "remove_charge_schedule", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "add_precondition_schedule", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "remove_precondition_schedule", kind: "write", needsProxy: true, danger: "confirm" },
  { name: "set_valet_mode", kind: "write", needsProxy: true, danger: "extra-confirm" },
  { name: "reset_valet_pin", kind: "write", needsProxy: true, danger: "extra-confirm" },
  { name: "guest_mode", kind: "write", needsProxy: true, danger: "extra-confirm" },
  { name: "speed_limit_set_limit", kind: "write", needsProxy: true, danger: "extra-confirm" },
  { name: "speed_limit_activate", kind: "write", needsProxy: true, danger: "extra-confirm" },
  { name: "speed_limit_deactivate", kind: "write", needsProxy: true, danger: "extra-confirm" },
  { name: "speed_limit_clear_pin", kind: "write", needsProxy: true, danger: "extra-confirm" },
  { name: "speed_limit_clear_pin_admin", kind: "write", needsProxy: true, danger: "extra-confirm" },
  { name: "reset_pin_to_drive_pin", kind: "write", needsProxy: true, danger: "extra-confirm" },
  { name: "clear_pin_to_drive_admin", kind: "write", needsProxy: true, danger: "extra-confirm" },
  { name: "erase_user_data", kind: "write", needsProxy: true, danger: "extra-confirm" },
] as const satisfies readonly TeslaToolMeta[];

export type TeslaToolName = (typeof TESLA_TOOLS)[number]["name"];

export const TESLA_TOOL_NAMES: TeslaToolName[] = TESLA_TOOLS.map((t) => t.name);
