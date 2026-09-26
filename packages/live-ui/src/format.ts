import type { FleetVehicle } from "@farmlink/schema";

const pad = (value: number) => String(value).padStart(2, "0");

/** In-game day and time of day, for example `Day 37 · 14:05`. */
export function gameClock(day: number, minute: number): string {
  return `Day ${day} · ${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}

const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatNumber(value: number): string {
  return grouped.format(Math.round(value));
}

/** Money as the game shows it, without a currency sign (the mod does not report the currency). */
export function formatMoney(value: number): string {
  return value < 0 ? `−${formatNumber(-value)}` : formatNumber(value);
}

export function formatPct(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value)} %`;
}

export function formatLiters(value: number): string {
  return `${formatNumber(value)} L`;
}

/** Minutes as `42 min` or `3 h 05 min`. */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)} h ${pad(total % 60)} min`;
}

/** How long ago something happened, from two epoch milliseconds. */
export function formatAgo(thenMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

const CONTROLLERS: Record<FleetVehicle["controller"], string> = {
  player: "Player",
  ai: "Worker",
  courseplay: "Courseplay",
  autodrive: "AutoDrive",
  idle: "Parked",
};

export function controllerLabel(controller: FleetVehicle["controller"]): string {
  return CONTROLLERS[controller];
}

/** True for anything the AI drives, including Courseplay and AutoDrive. */
export function isAiController(controller: FleetVehicle["controller"]): boolean {
  return controller === "ai" || controller === "courseplay" || controller === "autodrive";
}

const FILL_TYPES: Record<string, string> = {
  DEF: "DEF",
  DIESEL: "Diesel",
  ELECTRICCHARGE: "Electric charge",
  LIQUIDFERTILIZER: "Liquid fertilizer",
  LIQUIDMANURE: "Slurry",
  SUGARBEET: "Sugar beet",
  SUGARBEET_CUT: "Sugar beet cut",
  SUNFLOWER: "Sunflower",
  SOYBEAN: "Soybeans",
  OILSEEDRADISH: "Oilseed radish",
  CANOLA: "Canola",
  GRASS_WINDROW: "Grass",
  DRYGRASS_WINDROW: "Hay",
  SILAGE: "Silage",
  WOODCHIPS: "Wood chips",
  TREESAPLINGS: "Tree saplings",
  POPLAR: "Poplar",
  RICELONGGRAIN: "Long grain rice",
  GREENBEAN: "Green beans",
  SPINACH: "Spinach",
};

/** A fill type name in words: `LIQUIDFERTILIZER` → `Liquid fertilizer`, `WHEAT` → `Wheat`. */
export function fillTypeLabel(fillType: string): string {
  const known = FILL_TYPES[fillType];
  if (known) return known;
  const words = fillType.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Registered in FS25's AIJobTypeManager; mods may add more.
const JOB_TYPES: Record<string, string> = {
  GOTO: "Drive to",
  FIELDWORK: "Field work",
  CONVEYOR: "Conveyor",
  DELIVER: "Deliver",
  LOAD_AND_DELIVER: "Load and deliver",
};

export function jobTypeLabel(jobType: string): string {
  return JOB_TYPES[jobType] ?? fillTypeLabel(jobType);
}

const WEATHER: Record<string, string> = {
  SUN: "Sunny",
  PARTIALLY_CLOUDY: "Partly cloudy",
  CLOUDY: "Cloudy",
  RAIN: "Rain",
  SNOW: "Snow",
  HAIL: "Hail",
  TWISTER: "Twister",
  THUNDER: "Thunderstorm",
  UNKNOWN: "Unknown",
};

const WEATHER_ICONS: Record<string, string> = {
  SUN: "☀️",
  PARTIALLY_CLOUDY: "⛅",
  CLOUDY: "☁️",
  RAIN: "🌧️",
  SNOW: "❄️",
  HAIL: "🌨️",
  TWISTER: "🌪️",
  THUNDER: "⛈️",
  UNKNOWN: "·",
};

export function weatherLabel(type: string): string {
  return WEATHER[type] ?? fillTypeLabel(type);
}

export function weatherIcon(type: string): string {
  return WEATHER_ICONS[type] ?? "·";
}
