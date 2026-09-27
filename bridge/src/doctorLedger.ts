// The P2 half of --doctor: what the probe's `ledger` section found out for the ledger. Each check
// passes once the session answered its question, whatever the answer was; the detail says which.

import type { Check } from "./doctor";

type Json = Record<string, unknown>;

function get(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Json)[key];
  }
  return current;
}

const num = (value: unknown): number => (typeof value === "number" ? value : 0);

interface Totals {
  [key: string]: { calls?: number; total?: number };
}

/** "name ×calls (total)" for the entries with the most calls. */
function topEntries(totals: Totals, limit: number): string {
  return Object.entries(totals)
    .sort(([, a], [, b]) => num(b.calls) - num(a.calls))
    .slice(0, limit)
    .map(([name, entry]) => `${name} ×${num(entry.calls)} (${num(entry.total)})`)
    .join(", ");
}

function check(id: string, title: string, answered: boolean, detail: string): Check {
  return { id, title, status: answered ? "pass" : "pending", detail, phase: "P2" };
}

/** The P2 questions, from `sections.ledger` of probe.json and `_probe/handle_test.txt`. */
export function ledgerChecks(probe: unknown, handleText: string | undefined): Check[] {
  const ledger = get(probe, "sections.ledger");
  if (ledger === null || typeof ledger !== "object") {
    return [
      check(
        "ledger",
        "P2 questions",
        false,
        "probe.json has no ledger section yet: load a savegame with this build of the mod",
      ),
    ];
  }
  const l = (path: string) => get(ledger, path);
  const checks: Check[] = [];

  const whilePaused = num(l("updates.whilePaused"));
  const gaps = (l("updates.gaps") ?? []) as Json[];
  const longest = gaps.reduce((max, gap) => Math.max(max, num(gap.gapMs)), 0);
  checks.push(
    check(
      "pause",
      "Does the mod keep running while the game is paused?",
      whilePaused > 0 || longest >= 10_000,
      whilePaused > 0
        ? `yes: ${whilePaused} updates ran while paused`
        : longest >= 10_000
          ? `no: updates stopped for ${Math.round(longest / 1000)} s, so a pause looks like the game going offline`
          : "pause the game for 20 s during the session",
    ),
  );

  const opened = l("handle.opened");
  const second = l("handle.secondWrite");
  const handleOk = second === "ok" && handleText?.replace(/\r\n/g, "\n") === "one\ntwo\n";
  checks.push({
    ...check(
      "handle",
      "A file handle kept open can be written again later",
      handleOk,
      handleOk
        ? `yes: both writes landed (flush ${String(l("handle.flush"))})`
        : opened === false
          ? `io.open failed: ${String(l("handle.error"))}`
          : `second write ${String(second ?? "not reached")}, file holds ${JSON.stringify(handleText ?? null)}`,
    ),
    ...(opened === false || (second !== undefined && second !== "ok")
      ? { status: "fail" as const }
      : {}),
  });

  const sales = num(l("sales.calls"));
  const sale = ((l("sales.samples") ?? []) as Json[]).at(-1);
  checks.push(
    check(
      "sales",
      "Sales through SellingStation.sellFillType",
      sales > 0,
      sales > 0
        ? `${sales} sales; last ${String(sale?.liters)} L of ${String(sale?.fillType)} at ${String(sale?.station)} for ${String(sale?.returned)}`
        : l("sales.hooked") === true
          ? "no sale yet: sell anything at a selling point"
          : "the hook is not installed: SellingStation.sellFillType was not found",
    ),
  );

  const fuel = num(l("fuel.calls"));
  checks.push(
    check(
      "fuel",
      "Fuel bookings through FillTrigger.fillVehicle",
      fuel > 0,
      fuel > 0
        ? `${fuel} bookings for ${num(l("fuel.liters"))} L: one per frame while filling up`
        : "no refuel yet: fill up at a fuel station",
    ),
  );

  const stats = (l("farmStats.byStat") ?? {}) as Totals;
  const hectares = Object.keys(stats).filter((name) => name.endsWith("Hectares"));
  checks.push(
    check(
      "farmStats",
      "Field work through updateFarmStats",
      hectares.length > 0,
      hectares.length > 0
        ? topEntries(stats, 8)
        : `no field work yet (${String(l("farmStats.wrap"))}): sow, spray, cultivate or plow for 30 s`,
    ),
  );

  const days = num(l("messages.counts.DAY_CHANGED.count"));
  const day = ((l("messages.days") ?? []) as Json[]).at(-1);
  checks.push(
    check(
      "day",
      "A new day and the calendar it starts",
      days > 0,
      days > 0
        ? `DAY_CHANGED ×${days}; last: monotonic day ${String(day?.monotonicDay)}, period ${String(day?.period)}, day ${String(day?.dayInPeriod)} of ${String(day?.daysPerPeriod)}`
        : "no new day yet: sleep, or let the clock pass midnight",
    ),
  );

  const points = num(l("prices.atStart.sellingPoints"));
  const price = ((l("prices.atStart.samples") ?? []) as Json[])[0];
  checks.push(
    check(
      "prices",
      "Selling prices for the daily price table",
      points > 0,
      points > 0
        ? `${points} selling points; e.g. ${String(price?.fillType)} at ${String(price?.station)}: ${String(price?.pricePerLiter)} per liter`
        : "no selling points found through storageSystem:getUnloadingStations()",
    ),
  );

  // The money funnel's context: money of each type booked inside the function it expects to be in.
  const byContext = (l("context.byMoneyType") ?? {}) as Record<string, Totals>;
  const expectedContext = (moneyType: string): string | undefined =>
    ({
      AI: "wage",
      SOLD_PRODUCTS: "sale",
      VEHICLE_REPAIR: "repair",
      PURCHASE_SEEDS: "sowing",
      PURCHASE_FERTILIZER: "spraying",
    })[moneyType] ?? (moneyType.includes("purchaseFuel") ? "fuel" : undefined);
  const contextLines = Object.entries(byContext).flatMap(([moneyType, kinds]) => {
    const kind = expectedContext(moneyType);
    if (kind === undefined) return [];
    const total = Object.values(kinds).reduce((sum, entry) => sum + num(entry.calls), 0);
    return [`${moneyType} ${num(kinds[kind]?.calls)}/${total} in ${kind}`];
  });
  checks.push(
    check(
      "moneyContext",
      "Money booked inside the functions the funnel takes its context from",
      contextLines.length > 0,
      contextLines.length > 0
        ? contextLines.join(", ")
        : "no wages, sales, fuel, repairs or bought seed yet: hire a worker, and repair a machine",
    ),
  );

  const hooks = (l("context.hooks") ?? {}) as Record<string, string>;
  const missing = Object.entries(hooks)
    .filter(([, status]) => status !== "wrapped")
    .map(([name]) => name);
  const calls = (l("context.calls") ?? {}) as Record<string, number>;
  const worked = (l("context.workedHa") ?? {}) as Record<string, number>;
  const listeners = [
    ["sowing", "SowingMachine"],
    ["spraying", "Sprayer"],
  ].filter(([kind]) => num(calls[kind as string]) > 0);
  checks.push({
    ...check(
      "workListeners",
      "Field work through the sowing and spraying listeners",
      listeners.length > 0,
      missing.length > 0
        ? `not hooked: ${missing.join(", ")}`
        : listeners.length > 0
          ? listeners
              .map(
                ([kind, name]) =>
                  `${name} ×${num(calls[kind as string])} (${num(worked[kind as string])} ha)`,
              )
              .join(", ")
          : "no sowing or spraying yet: sow or spray for 30 s",
    ),
    ...(missing.length > 0 ? { status: "fail" as const } : {}),
  });

  const order = (l("finances.order") ?? []) as string[];
  const snapshots = (l("finances.snapshots") ?? []) as Json[];
  const lastDay = snapshots.filter((snap) => snap.message === "DAY_CHANGED").at(-1);
  const archive = snapshots.filter((snap) => snap.message === "PERIOD_CHANGED").at(-1);
  checks.push(
    check(
      "finances",
      "The farm's finance statistics when a day and a month end",
      lastDay !== undefined,
      lastDay !== undefined
        ? [
            `order ${order.join(" → ")}`,
            `at the last DAY_CHANGED the month so far was ${String(lastDay.current)} with ${String(lastDay.historyLength)} months archived`,
            archive !== undefined
              ? `PERIOD_CHANGED left ${String(archive.current)} and ${String(archive.historyLength)} archived (last ${String(archive.lastArchived)})`
              : "no new month yet: sleep through the last day of a month",
          ].join("; ")
        : "no new day yet: sleep, or let the clock pass midnight",
    ),
  );

  const bookings = (l("shop.bookings") ?? []) as Json[];
  const added = (l("shop.vehicleAdded") ?? []) as Json[];
  const booking = bookings.at(-1);
  const next = booking ? added.find((entry) => num(entry.frame) >= num(booking.frame)) : undefined;
  checks.push(
    check(
      "shopOrder",
      "A bought machine and its booking",
      booking !== undefined,
      booking !== undefined
        ? `${String(booking.moneyType)} at frame ${String(booking.frame)} with ${String(booking.vehicles)} machines; ` +
            (next
              ? `VEHICLE_ADDED at frame ${String(next.frame)} with ${String(next.vehicles)}`
              : "no VEHICLE_ADDED after it")
        : "nothing bought yet: buy or lease any cheap machine",
    ),
  );

  const moneyTypes = (l("money.byType") ?? {}) as Totals;
  checks.push(
    check(
      "moneyTypes",
      "Money types a session books",
      Object.keys(moneyTypes).length > 0,
      Object.keys(moneyTypes).length > 0
        ? topEntries(moneyTypes, 8)
        : "no money moved yet: buy fuel or sell anything",
    ),
  );
  return checks;
}
