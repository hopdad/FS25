import type { LiveVehicle, VehicleState } from "@farmlink/schema";
import { fillTypeLabel, formatLiters, formatNumber, formatPct } from "../format";
import { fuelTone, Gauge, Level, scaleFor, tankTone } from "./Gauge";

type FillUnit = VehicleState["fillUnits"][number];

const SPEED_STEPS = [40, 60, 80, 120];
const RPM_STEPS = [2500, 3000];

function fillPct(unit: FillUnit): number | null {
  return unit.capacity ? (unit.level / unit.capacity) * 100 : null;
}

function fillDetail(unit: FillUnit): string {
  if (!unit.capacity) return formatLiters(unit.level);
  return `${formatNumber(unit.level)} of ${formatLiters(unit.capacity)}`;
}

function FillUnits({ units }: { units: FillUnit[] }) {
  return (
    <>
      {units.map((unit, index) => (
        <Level
          // Fill units have no id; their order in the vehicle is stable.
          key={index}
          label={unit.fillType ? fillTypeLabel(unit.fillType) : "Empty"}
          pct={fillPct(unit)}
          detail={fillDetail(unit)}
          tone={tankTone(fillPct(unit))}
        />
      ))}
    </>
  );
}

/** The machine the player is driving, updated every second. */
export function VehicleCard({ frame }: { frame: LiveVehicle | null }) {
  const vehicle = frame?.vehicle ?? null;
  if (!vehicle) {
    return (
      <section className="card vehicle" aria-labelledby="vehicle-title">
        <h2 id="vehicle-title">Your vehicle</h2>
        <p className="muted">{frame ? "On foot." : "Waiting for the game…"}</p>
      </section>
    );
  }
  return (
    <section className="card vehicle" aria-labelledby="vehicle-title">
      <div className="card-head">
        <h2 id="vehicle-title">{vehicle.name}</h2>
        {vehicle.isAI && <span className="badge ai">Worker driving</span>}
      </div>
      <div className="gauges">
        <Gauge
          label="Speed"
          value={vehicle.speedKmh}
          max={scaleFor(vehicle.speedKmh, SPEED_STEPS)}
          unit="km/h"
        />
        <Gauge
          label="Engine"
          value={vehicle.rpm}
          max={scaleFor(vehicle.rpm, RPM_STEPS)}
          unit="rpm"
        />
      </div>
      <dl className="facts">
        <div>
          <dt>Gear</dt>
          <dd>{vehicle.gear ?? "—"}</dd>
        </div>
        <div>
          <dt>Hours</dt>
          <dd>{vehicle.operatingHours === null ? "—" : vehicle.operatingHours.toFixed(1)}</dd>
        </div>
        <div>
          <dt>Damage</dt>
          <dd>{formatPct(vehicle.damagePct)}</dd>
        </div>
      </dl>
      {vehicle.fuelPct !== null && (
        <Level
          label={fillTypeLabel(vehicle.fuelType ?? "DIESEL")}
          pct={vehicle.fuelPct}
          tone={fuelTone(vehicle.fuelPct)}
        />
      )}
      <FillUnits units={vehicle.fillUnits} />
      {vehicle.implements.length > 0 && (
        <ul className="implements">
          {vehicle.implements.map((implement, index) => (
            <li key={implement.vehicleId ?? `implement-${index}`}>
              <span className="implement-name">{implement.name}</span>
              <FillUnits units={implement.fillUnits} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
