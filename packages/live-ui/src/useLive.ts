import type { CommandRequest, CommandResponse, ServerMessage } from "@farmlink/schema";
import { useCallback, useEffect, useReducer } from "react";
import { initialState, type LiveState, reduce } from "./store";

export interface LiveConnection {
  state: LiveState;
  /** Posts a command and resolves with the game's answer; never rejects. */
  sendCommand: (request: CommandRequest) => Promise<CommandResponse>;
  dismiss: (alertId: string) => void;
}

/** The bridge repeats its status every 10 s; this much silence means the connection is dead. */
const SILENCE_MS = 25_000;
const BACKOFF_MS = [1000, 2000, 4000, 8000];

/**
 * Connects to the bridge's WebSocket and keeps the connection alive: reconnects with backoff, at
 * once when the phone wakes the page, and when the socket goes quiet. When the socket closes, one
 * HTTP request tells a stale pairing link (401, stop trying) from a bridge that is not running.
 */
export function useLive(token: string, origin: string = location.origin): LiveConnection {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);

  useEffect(() => {
    const wsUrl = `${origin.replace(/^http/, "ws")}/ws?t=${encodeURIComponent(token)}`;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let lastMessageAt = Date.now();
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      clearTimeout(retry);
      const previous = socket;
      const ws = new WebSocket(wsUrl);
      socket = ws;
      previous?.close();
      ws.onopen = () => {
        attempt = 0;
        lastMessageAt = Date.now();
        dispatch({ type: "connection", connection: "open" });
      };
      ws.onmessage = (event) => {
        lastMessageAt = Date.now();
        let message: ServerMessage;
        try {
          message = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          return;
        }
        dispatch({ type: "message", message, at: lastMessageAt });
      };
      ws.onclose = () => {
        if (socket === ws) void diagnose();
      };
    };

    const diagnose = async () => {
      if (stopped) return;
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      attempt++;
      try {
        const response = await fetch(`${origin}/api/status`, {
          headers: { authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (response.status === 401) {
          dispatch({ type: "connection", connection: "unpaired" });
          return;
        }
        dispatch({ type: "connection", connection: "reconnecting" });
      } catch {
        dispatch({ type: "connection", connection: "unreachable" });
      }
      if (!stopped) retry = setTimeout(connect, delay);
    };

    const quiet = () => Date.now() - lastMessageAt > SILENCE_MS;
    const watchdog = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN && quiet()) connect();
    }, 5000);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (!socket || socket.readyState >= WebSocket.CLOSING || quiet()) {
        attempt = 0;
        connect();
      }
    };

    document.addEventListener("visibilitychange", onVisible);
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(watchdog);
      document.removeEventListener("visibilitychange", onVisible);
      socket?.close();
    };
  }, [token, origin]);

  const sendCommand = useCallback(
    async (request: CommandRequest): Promise<CommandResponse> => {
      try {
        const response = await fetch(`${origin}/api/commands`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(request),
        });
        const body = (await response.json()) as Partial<CommandResponse>;
        if (typeof body.status === "string") return body as CommandResponse;
        return { id: null, status: "error", message: `the bridge answered ${response.status}` };
      } catch {
        return { id: null, status: "error", message: "could not reach the bridge" };
      }
    },
    [token, origin],
  );

  const dismiss = useCallback((alertId: string) => dispatch({ type: "dismiss", id: alertId }), []);

  return { state, sendCommand, dismiss };
}
