import type { ActiveJob, CommandResponse, WorkerStopEntry } from "@farmlink/schema";
import { describeReason, stopSeverity } from "@farmlink/schema/reasons";
import { useEffect, useState } from "react";
import { formatAgo, formatDuration, jobTypeLabel } from "../format";
import { Level, tankTone } from "./Gauge";

/** How long the Stop button waits for the confirming second tap. */
const CONFIRM_MS = 3000;
const MAX_STOPS = 8;

type StopState =
  | { phase: "idle" }
  | { phase: "confirm" }
  | { phase: "sending" }
  | { phase: "answered"; response: CommandResponse };

function answerText(response: CommandResponse): string {
  if (response.status === "ok")
    return response.message === "not running" ? "Already stopped" : "Stopped";
  const reason = response.message ? `: ${response.message}` : "";
  if (response.status === "expired") return `No answer from the game${reason}`;
  if (response.status === "rejected") return `Refused${reason}`;
  return `Failed${reason}`;
}

/** Stop takes two taps, so a stray touch never stops a worker. The page shows the game's answer. */
interface StopButtonProps {
  job: ActiveJob;
  onStop: (job: ActiveJob) => Promise<CommandResponse>;
  /** False while the game or the bridge cannot take commands. */
  enabled: boolean;
}

function StopButton({ job, onStop, enabled }: StopButtonProps) {
  const [state, setState] = useState<StopState>({ phase: "idle" });

  useEffect(() => {
    if (state.phase !== "confirm") return;
    const timer = setTimeout(() => setState({ phase: "idle" }), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [state.phase]);

  if (state.phase === "answered") {
    const ok = state.response.status === "ok";
    return (
      <div className={`answer ${ok ? "ok" : "bad"}`} role="status">
        <span>{answerText(state.response)}</span>
        {!ok && (
          <button type="button" className="link" onClick={() => setState({ phase: "idle" })}>
            Retry
          </button>
        )}
      </div>
    );
  }

  const click = async () => {
    if (state.phase === "idle") {
      setState({ phase: "confirm" });
      return;
    }
    if (state.phase !== "confirm") return;
    setState({ phase: "sending" });
    setState({ phase: "answered", response: await onStop(job) });
  };

  return (
    <button
      type="button"
      className={`stop ${state.phase}`}
      disabled={state.phase === "sending" || (!enabled && state.phase === "idle")}
      title={enabled ? undefined : "The game is not connected"}
      onClick={() => void click()}
    >
      {state.phase === "idle" && "Stop"}
      {state.phase === "confirm" && "Tap again to stop"}
      {state.phase === "sending" && "Stopping…"}
    </button>
  );
}

export interface WorkerBoardProps {
  jobs: ActiveJob[];
  /** Newest first. */
  stops: WorkerStopEntry[];
  names: Map<string, string>;
  /** Job ids restart with every game session, so the Stop buttons are keyed by session too. */
  sessionId: string | null;
  now: number;
  onStop: (job: ActiveJob) => Promise<CommandResponse>;
  /** False while the game or the bridge cannot take commands. */
  canCommand: boolean;
}

/** Hired workers at work, each with a Stop button, and the latest workers that stopped. */
export function WorkerBoard({
  jobs,
  stops,
  names,
  sessionId,
  now,
  onStop,
  canCommand,
}: WorkerBoardProps) {
  return (
    <section className="card workers" aria-labelledby="workers-title">
      <div className="card-head">
        <h2 id="workers-title">Workers</h2>
        <span className="count">
          {jobs.length === 0 ? "none working" : `${jobs.length} working`}
        </span>
      </div>
      {jobs.length > 0 && (
        <ul className="jobs">
          {jobs.map((job) => {
            const started = Date.parse(job.startedAt);
            return (
              <li key={`${sessionId}:${job.jobId}`} className="job">
                <div className="job-head">
                  <div>
                    <strong>{job.helper ?? "Worker"}</strong>
                    <span className="muted">
                      {" "}
                      · {names.get(job.vehicleId) ?? "unknown vehicle"}
                    </span>
                  </div>
                  <StopButton job={job} onStop={onStop} enabled={canCommand} />
                </div>
                <div className="muted small">
                  {jobTypeLabel(job.jobType)}
                  {job.fieldId !== null && ` · field ${job.fieldId}`}
                  {!Number.isNaN(started) &&
                    ` · running ${formatDuration((now - started) / 60_000)}`}
                </div>
                {job.tankFillPct !== null && (
                  <Level label="Tank" pct={job.tankFillPct} tone={tankTone(job.tankFillPct)} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {stops.length > 0 && (
        <>
          <h3>Recently stopped</h3>
          <ul className="stops">
            {stops.slice(0, MAX_STOPS).map((stop) => (
              <li
                key={`${sessionId}:${stop.stopId}`}
                className={`stop-row ${stopSeverity(stop.reason)}`}
              >
                <div>
                  <strong>{stop.helper ?? "Worker"}</strong>
                  <span className="muted">
                    {" "}
                    · {(stop.vehicleId && names.get(stop.vehicleId)) || jobTypeLabel(stop.jobType)}
                  </span>
                </div>
                <div className="small">
                  {describeReason(stop.reason)}
                  <span className="muted">
                    {" · "}
                    {formatAgo(Date.parse(stop.realTs), now)}
                    {stop.durationMin !== null &&
                      ` · worked ${formatDuration(stop.durationMin)} of game time`}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
