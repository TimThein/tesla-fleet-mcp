export const AUTH = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3";
export const AUTHORIZE = "https://auth.tesla.com/oauth2/v3/authorize";

export const REGIONS = {
  eu: "https://fleet-api.prd.eu.vn.cloud.tesla.com",
  na: "https://fleet-api.prd.na.vn.cloud.tesla.com",
} as const;

export const SCOPES = [
  "openid",
  "offline_access",
  "vehicle_device_data",
  "vehicle_cmds",
  "vehicle_charging_cmds",
  "vehicle_location",
  "energy_device_data",
  "energy_cmds",
] as const;

export function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export function requiredEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

export const region = (): keyof typeof REGIONS => {
  const r = env("TESLA_REGION", "eu");
  return r === "na" ? "na" : "eu";
};

export const fleetBase = () => env("TESLA_FLEET_BASE", REGIONS[region()]);

export const cachePath = () =>
  env("TESLA_CACHE_PATH", new URL("../token-cache.json", import.meta.url).pathname);

export const redirectUri = () => requiredEnv("TESLA_REDIRECT_URI");

export const defaultVin = () => env("TESLA_VIN");

export const commandBase = () => env("TESLA_COMMAND_BASE");

export function vinOrDefault(vin?: string): string {
  const v = vin?.trim() || defaultVin();
  if (!v) throw new Error("Missing vin (pass vin or set TESLA_VIN)");
  return v;
}
