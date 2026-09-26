import { describe, expect, it } from "vitest";
import {
  defaultFarmId,
  farmChoices,
  farmView,
  gameTime,
  initialState,
  MAX_ALERTS,
  reduce,
} from "../src/store";
import {
  alert,
  farm,
  fleet,
  fullState,
  NOW,
  SAVE_ID,
  stateFrom,
  status,
  vehicle,
} from "./fixtures";

describe("the page's state", () => {
  it("collects the status, every channel and the alerts", () => {
    const state = fullState();
    expect(state.connection).toBe("open");
    expect(state.status?.saveName).toBe("Riverbend Springs");
    expect(state.vehicle?.vehicle?.name).toBe("Fendt 942 Vario");
    expect(state.fleet?.fleet.jobs).toHaveLength(1);
    expect(state.farm?.farm.farms).toHaveLength(2);
    expect(state.alerts.map((a) => a.id)).toEqual(["stop:x:2"]);
  });

  it("drops the old save's frames and alerts when the bridge follows another save", () => {
    const state = fullState();
    const next = reduce(state, {
      type: "message",
      message: {
        type: "status",
        status: { ...status, saveId: "11111111-2222-4333-8444-555555555555" },
      },
      at: NOW,
    });
    expect([next.vehicle, next.fleet, next.farm]).toEqual([null, null, null]);
    expect(next.alerts).toEqual([]);
    const same = reduce(state, {
      type: "message",
      message: { type: "status", status: { ...status, gameOnline: false } },
      at: NOW,
    });
    expect(same.vehicle).not.toBeNull();
  });

  it("pops up live alerts and recent replayed ones, once each", () => {
    // Replayed on connect: 3 minutes old stays in the list only, 1 minute old pops up too.
    const state = stateFrom([
      {
        type: "alerts",
        alerts: [
          alert("old", { at: new Date(NOW - 180_000).toISOString() }),
          alert("recent", { at: new Date(NOW - 60_000).toISOString() }),
        ],
      },
    ]);
    expect(state.alerts.map((a) => a.id)).toEqual(["old", "recent"]);
    expect(state.toasts.map((a) => a.id)).toEqual(["recent"]);

    const live = alert("live", { at: new Date(NOW - 600_000).toISOString() });
    let next = reduce(state, { type: "message", message: { type: "alert", alert: live }, at: NOW });
    next = reduce(next, { type: "message", message: { type: "alert", alert: live }, at: NOW });
    expect(next.toasts.map((a) => a.id)).toEqual(["recent", "live"]);
    expect(next.alerts.map((a) => a.id)).toEqual(["live", "old", "recent"]);

    next = reduce(next, { type: "dismiss", id: "recent" });
    expect(next.toasts.map((a) => a.id)).toEqual(["live"]);
  });

  it(`keeps the ${MAX_ALERTS} newest alerts`, () => {
    const alerts = Array.from({ length: MAX_ALERTS + 5 }, (_, i) =>
      alert(`a${i}`, { at: new Date(NOW - (100 - i) * 60_000).toISOString() }),
    );
    const state = stateFrom([{ type: "alerts", alerts }]);
    expect(state.alerts).toHaveLength(MAX_ALERTS);
    expect(state.alerts[0]?.id).toBe("a5");
  });

  it("ignores repeated connection states without making a new state", () => {
    const state = initialState();
    expect(reduce(state, { type: "connection", connection: "connecting" })).toBe(state);
  });
});

describe("the farm the page shows", () => {
  it("lists the save's farms, or the owners of the machines before live_farm.json arrives", () => {
    expect(farmChoices(fullState())).toEqual([
      { farmId: 1, name: "Riverbend Farms" },
      { farmId: 2, name: "Hillside" },
    ]);
    const early = stateFrom([{ type: "channel", channel: "fleet", data: fleet }]);
    expect(farmChoices(early).map((f) => f.name)).toEqual(["Farm 1", "Farm 2"]);
  });

  it("defaults to the farm of the machine the player drives", () => {
    expect(defaultFarmId(fullState())).toBe(1);
    const onFoot = stateFrom([
      { type: "channel", channel: "vehicle", data: { ...vehicle, vehicle: null } },
      { type: "channel", channel: "farm", data: farm },
    ]);
    expect(defaultFarmId(onFoot)).toBe(1);
  });

  it("filters workers, stops, machines and alerts to one farm", () => {
    const state = stateFrom([
      { type: "channel", channel: "fleet", data: fleet },
      { type: "channel", channel: "farm", data: farm },
      {
        type: "alerts",
        alerts: [
          alert("mine", { farmId: 1 }),
          alert("theirs", { farmId: 2 }),
          alert("everyone", { farmId: null, kind: "game_offline" }),
        ],
      },
    ]);
    const view = farmView(state, 1);
    expect(view.jobs.map((j) => j.helper)).toEqual(["Alex"]);
    expect(view.stops.map((s) => s.helper)).toEqual(["Sam"]);
    // The seeder hangs on the Fendt; the AI-driven combine comes first.
    expect(view.machines.map((m) => m.name)).toEqual(["Claas Lexion 8900", "Fendt 942 Vario"]);
    expect(view.alerts.map((a) => a.id).sort()).toEqual(["everyone", "mine"]);
    expect(view.farm?.name).toBe("Riverbend Farms");
    expect(farmView(state, 2).machines.map((m) => m.name)).toEqual(["John Deere 6R 150"]);
  });

  it("reads the newest game time from any channel", () => {
    expect(gameTime(fullState())).toEqual({ day: 37, minute: 846 });
    expect(gameTime(initialState())).toBeNull();
  });

  it("uses the save id it was given", () => {
    expect(fullState().status?.saveId).toBe(SAVE_ID);
  });
});
