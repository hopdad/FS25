// The P4 exit criterion ahead of time: every view loads in under a second for a save of 100,000
// events. Timing depends on the machine, so this runs only with SCALE_TEST=1:
//
//   SCALE_TEST=1 pnpm --filter @farmlink/supabase test scale
//
// SCALE_NO_JIT=1 turns off Postgres's JIT compiler for the queries. On the development container
// (Postgres 16, through node-postgres) the slowest view, field_season_pnl, takes about 0.5 s, and
// 0.85 s when Postgres JIT-compiles it; the others take 0.2 s or less.

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { beforeAll, describe, expect, it } from "vitest";
import { createSave, hasPostgres, useDatabase } from "./db";

const EVENTS = 100_000;
const LIMIT_MS = 1000;

// A synthetic save: 1,000 game days of 100 events each, over 30 machines and 40 fields. Half the
// events are money; the rest harvests, field work, hired workers, machine hours and daily prices.
const GENERATE = `
insert into public.events (save_id, branch_id, seq, type, farm_id, user_id, day, minute, year, real_ts, data)
select $1, $2, g, k.type, 1, null, g / 100, (g % 100) * 14, (g / 100) / 12 + 1,
  timestamptz '2026-01-01' + g * interval '1 second',
  case k.type
    when 'session' then jsonb_build_object('modVersion', '0.3.0.0', 'gameVersion', '1.10.1.0',
      'integrations', '[]'::jsonb, 'period', (g / 100) % 12 + 1, 'dayInPeriod', 1, 'daysPerPeriod', 1)
    when 'day_rollover' then jsonb_build_object('balance', 1000000 + g, 'loan', 0,
      'financeByCategory', '{}'::jsonb, 'period', (g / 100) % 12 + 1, 'dayInPeriod', 1, 'daysPerPeriod', 1)
    when 'prices' then jsonb_build_object('entries', (
      select jsonb_agg(jsonb_build_object('stationId', 'station' || (i % 5),
        'fillType', (array['WHEAT', 'BARLEY', 'CANOLA', 'MAIZE', 'SOYBEAN', 'OAT'])[i % 6 + 1],
        'pricePer1000L', 300 + (g % 97) + i))
      from generate_series(1, 30) i))
    when 'money' then jsonb_build_object('amount', case when g % 7 = 0 then 500 else -50 end,
      'moneyType', 'OTHER', 'context', case g % 7
        when 0 then jsonb_build_object('kind', 'sale', 'stationId', 'station1',
          'fillType', (array['WHEAT', 'BARLEY', 'CANOLA'])[g % 3 + 1], 'liters', 1000)
        when 1 then jsonb_build_object('kind', 'fuel', 'vehicleId', 'v' || (g % 30), 'fillType', 'DIESEL', 'liters', 40)
        when 2 then jsonb_build_object('kind', 'wage', 'jobId', (34 + g % 7)::text, 'vehicleId', 'v' || (g % 30))
        when 3 then jsonb_build_object('kind', 'input', 'fillType', 'SEEDS', 'liters', 100,
          'fieldId', g % 40 + 1, 'vehicleId', 'v' || (g % 30))
        when 4 then jsonb_build_object('kind', 'vehicle', 'vehicleId', 'v' || (g % 30))
        when 5 then jsonb_build_object('kind', 'shop', 'storeItem', 'machine.xml', 'vehicleId', 'v' || (g % 30))
        else jsonb_build_object('kind', 'none') end)
    when 'harvest' then jsonb_build_object('fieldId', g % 40 + 1, 'farmlandId', g % 40 + 1,
      'fillType', (array['WHEAT', 'BARLEY', 'CANOLA'])[g % 3 + 1], 'liters', 800,
      'vehicleId', 'v' || (g % 30), 'isAI', false, 'workedHours', 0.1)
    when 'field_work' then jsonb_build_object('fieldId', g % 40 + 1, 'farmlandId', g % 40 + 1,
      'workType', 'seeding', 'areaHa', 0.5, 'inputFillType', null, 'inputLiters', null,
      'vehicleId', 'v' || (g % 30), 'isAI', true, 'workedHours', 0.1)
    when 'worker_start' then jsonb_build_object('jobId', ((g / 2) % 50)::text, 'vehicleId', 'v' || (g % 30),
      'jobType', 'FIELDWORK', 'fieldId', g % 40 + 1)
    when 'worker_stop' then jsonb_build_object('jobId', ((g / 2) % 50)::text, 'vehicleId', 'v' || ((g - 1) % 30),
      'reason', (array['ERROR_OUT_OF_FUEL', 'SUCCESS_FINISHED_JOB', 'ERROR_BLOCKED_BY_OBJECT'])[g % 3 + 1],
      'durationMin', 30, 'wagesTotal', 20)
    else jsonb_build_object('vehicleId', 'v' || (g % 30), 'operatingHours', g / 1000.0, 'sellValue', 100000 - g / 10)
  end
from generate_series(1, $3::integer) g
cross join lateral (
  select case
    when g % 5000 = 1 then 'session'
    when g % 100 = 0 then 'day_rollover'
    when g % 100 = 2 then 'prices'
    when g % 100 between 3 and 52 then 'money'
    when g % 100 between 53 and 60 then 'harvest'
    when g % 100 between 61 and 67 then 'field_work'
    when g % 100 between 68 and 81 then case when g % 2 = 0 then 'worker_start' else 'worker_stop' end
    else 'vehicle_hours'
  end as type
) k`;

const VIEWS = [
  "ledger_events",
  "prices",
  "vehicle_cost_per_hour",
  "worker_downtime",
  "field_season_pnl",
  "money_reconciliation",
];

describe.skipIf(!hasPostgres || !process.env.SCALE_TEST)(`a save of ${EVENTS} events`, () => {
  const db = useDatabase();
  let owner = "";
  let saveId = "";

  beforeAll(async () => {
    owner = await db.createUser();
    saveId = await db.as(owner, (query) => createSave(query));
    await db.admin(GENERATE, [saveId, randomUUID(), EVENTS]);
    await db.admin("analyze");
  }, 120_000);

  for (const view of VIEWS) {
    it(`loads ${view} in under ${LIMIT_MS} ms`, async () => {
      const elapsed = await db.as(owner, async (query) => {
        if (process.env.SCALE_NO_JIT) await query("set local jit = off");
        const started = performance.now();
        await query(`select * from public.${view} where save_id = $1`, [saveId]);
        return performance.now() - started;
      });
      console.info(`${view}: ${Math.round(elapsed)} ms`);
      expect(elapsed).toBeLessThan(LIMIT_MS);
    });
  }
});
