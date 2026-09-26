import type { ActiveJob, CommandRequest, CommandResponse } from "@farmlink/schema";
import { useCallback, useEffect } from "react";
import { gameClock } from "../format";
import { useNow, useStoredState } from "../hooks";
import { defaultFarmId, farmChoices, farmView, gameTime, type LiveState } from "../store";
import { AlertList, AlertToasts } from "./Alerts";
import { FarmSummary } from "./FarmSummary";
import { FleetList } from "./FleetList";
import { ConnectionHelp, StatusBar } from "./StatusBar";
import { VehicleCard } from "./VehicleCard";
import { WorkerBoard } from "./WorkerBoard";

export interface LiveDashboardProps {
  state: LiveState;
  sendCommand: (request: CommandRequest) => Promise<CommandResponse>;
  dismiss: (alertId: string) => void;
}

/** The whole live view: the driven vehicle, workers, alerts, fleet and farm. */
export function LiveDashboard({ state, sendCommand, dismiss }: LiveDashboardProps) {
  const now = useNow();
  const farms = farmChoices(state);
  const [chosen, choose] = useStoredState<number | null>("farmlink.farm", null);
  const farmId =
    chosen !== null && farms.some((f) => f.farmId === chosen) ? chosen : defaultFarmId(state);
  const view = farmView(state, farmId);
  const time = gameTime(state);
  const saveName = state.status?.saveName;

  useEffect(() => {
    document.title = saveName ? `FarmLink · ${saveName}` : "FarmLink Live";
  }, [saveName]);

  const stop = useCallback(
    (job: ActiveJob) =>
      sendCommand({ type: "worker.stop", farmId: job.farmId, args: { jobId: job.jobId } }),
    [sendCommand],
  );

  return (
    <>
      <StatusBar
        connection={state.connection}
        status={state.status}
        clock={time ? gameClock(time.day, time.minute) : null}
        farms={farms}
        farmId={farmId}
        onFarm={choose}
      />
      <AlertToasts toasts={view.toasts} onDismiss={dismiss} />
      <main>
        <ConnectionHelp connection={state.connection} />
        <VehicleCard frame={state.vehicle} />
        <WorkerBoard
          jobs={view.jobs}
          stops={view.stops}
          names={view.names}
          sessionId={state.fleet?.sessionId ?? null}
          now={now}
          onStop={stop}
          canCommand={state.connection === "open" && state.status?.gameOnline === true}
        />
        <AlertList alerts={view.alerts} now={now} />
        <FleetList machines={view.machines} jobs={view.jobs} />
        <FarmSummary farm={view.farm} weather={state.farm?.farm.weather ?? null} />
      </main>
      <footer className="muted small">
        FarmLink bridge {state.status?.bridgeVersion ?? "?"}
        {state.status?.modVersion && ` · mod ${state.status.modVersion}`}
        {state.status?.gameVersion && ` · game ${state.status.gameVersion}`}
      </footer>
    </>
  );
}
