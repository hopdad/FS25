import type { LiveVehicle } from "@farmlink/schema";

type FillLevel = { fillType: string | null; level: number; capacity: number | null };

function clock(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function fill(unit: FillLevel): string {
  const capacity = unit.capacity === null ? "unlimited" : String(Math.round(unit.capacity));
  return `${unit.fillType ?? "empty"} ${Math.round(unit.level)}/${capacity}`;
}

const pct = (value: number | null) => (value === null ? "n/a" : `${value.toFixed(1)}%`);

/** One line per live_vehicle.json frame, for the P0 console output. */
export function formatVehicleFrame(frame: LiveVehicle): string {
  const when = `day ${frame.day} ${clock(frame.minute)}`;
  const v = frame.vehicle;
  if (v === null) return `${when} | on foot`;

  const parts = [
    when,
    v.name,
    `${v.speedKmh.toFixed(1)} km/h`,
    v.rpm === null ? "no motor" : `${Math.round(v.rpm)} rpm`,
    v.gear === null ? null : `gear ${v.gear}`,
    v.fuelType === null ? null : `${v.fuelType.toLowerCase()} ${pct(v.fuelPct)}`,
    v.damagePct === null ? null : `damage ${pct(v.damagePct)}`,
    v.operatingHours === null ? null : `${v.operatingHours.toFixed(2)} h`,
    `x ${v.position.x.toFixed(1)} z ${v.position.z.toFixed(1)}`,
    v.isAI ? "AI" : null,
  ];
  const tanks = v.fillUnits.map(fill);
  if (tanks.length > 0) parts.push(tanks.join(", "));
  for (const implement of v.implements) {
    const units = implement.fillUnits.map(fill).join(", ");
    parts.push(units ? `+ ${implement.name} (${units})` : `+ ${implement.name}`);
  }
  return parts.filter((p) => p !== null).join(" | ");
}
