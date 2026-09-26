import type { ActiveJob, FleetVehicle } from "@farmlink/schema";
import { controllerLabel, formatPct, isAiController } from "../format";
import { fuelTone, Meter } from "./Gauge";

export interface FleetListProps {
  /** Machines not attached to another one, in display order. */
  machines: FleetVehicle[];
  jobs: ActiveJob[];
}

/** Every machine of the farm: who drives it, fuel and damage. */
export function FleetList({ machines, jobs }: FleetListProps) {
  const helpers = new Map(jobs.map((j) => [j.vehicleId, j.helper]));
  return (
    <section className="card fleet" aria-labelledby="fleet-title">
      <div className="card-head">
        <h2 id="fleet-title">Fleet</h2>
        <span className="count">{machines.length} machines</span>
      </div>
      {machines.length === 0 ? (
        <p className="muted">No machines yet.</p>
      ) : (
        <ul className="machines">
          {machines.map((machine) => {
            const helper = helpers.get(machine.vehicleId);
            const who =
              helper && isAiController(machine.controller)
                ? helper
                : controllerLabel(machine.controller);
            return (
              <li key={machine.vehicleId} className="machine">
                <div className="machine-head">
                  <span className="machine-name">{machine.name}</span>
                  <span className={`badge ${machine.controller}`}>{who}</span>
                </div>
                <div className="machine-stats small">
                  {machine.fuelPct !== null && (
                    <span className="machine-fuel">
                      Fuel {formatPct(machine.fuelPct)}
                      <Meter pct={machine.fuelPct} tone={fuelTone(machine.fuelPct)} />
                    </span>
                  )}
                  {machine.damagePct !== null && (
                    <span className="muted">Damage {formatPct(machine.damagePct)}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
