import type { Alert } from "@farmlink/schema";
import { useEffect } from "react";
import { formatAgo } from "../format";

/** Info and warning pop-ups leave on their own; critical ones stay until tapped. */
const TOAST_MS = 8000;
const MAX_LISTED = 20;

function Toast({ alert, onDismiss }: { alert: Alert; onDismiss: (id: string) => void }) {
  useEffect(() => {
    if (alert.severity === "critical") return;
    const timer = setTimeout(() => onDismiss(alert.id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [alert.id, alert.severity, onDismiss]);
  return (
    <button type="button" className={`toast ${alert.severity}`} onClick={() => onDismiss(alert.id)}>
      <strong>{alert.title}</strong>
      <span>{alert.message}</span>
    </button>
  );
}

export interface AlertToastsProps {
  toasts: Alert[];
  onDismiss: (id: string) => void;
}

/** New alerts, on top of everything. */
export function AlertToasts({ toasts, onDismiss }: AlertToastsProps) {
  return (
    <div className="toasts" role="alert" aria-live="assertive">
      {toasts.map((alert) => (
        <Toast key={alert.id} alert={alert} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

/** Recent alerts, newest first. */
export function AlertList({ alerts, now }: { alerts: Alert[]; now: number }) {
  return (
    <section className="card alerts" aria-labelledby="alerts-title">
      <h2 id="alerts-title">Alerts</h2>
      {alerts.length === 0 ? (
        <p className="muted">Nothing to report.</p>
      ) : (
        <ul className="alert-list">
          {alerts.slice(0, MAX_LISTED).map((alert) => (
            <li key={alert.id} className={`alert-row ${alert.severity}`}>
              <div>
                <strong>{alert.title}</strong>
                <span className="muted small"> · {formatAgo(Date.parse(alert.at), now)}</span>
              </div>
              <div className="small">{alert.message}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
