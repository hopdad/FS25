import { formatPct } from "../format";

const CENTER = 50;
const RADIUS = 40;
/** The dial runs clockwise from lower left to lower right, through the top. */
const START_DEG = 135;
const SWEEP_DEG = 270;

function point(deg: number): string {
  const rad = (deg * Math.PI) / 180;
  const x = CENTER + RADIUS * Math.cos(rad);
  const y = CENTER + RADIUS * Math.sin(rad);
  return `${x.toFixed(2)} ${y.toFixed(2)}`;
}

function arc(fromDeg: number, toDeg: number): string {
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${point(fromDeg)} A ${RADIUS} ${RADIUS} 0 ${large} 1 ${point(toDeg)}`;
}

/** The smallest step of the scale that holds the value, so the dial rarely pins at the end. */
export function scaleFor(value: number | null, steps: readonly number[]): number {
  const last = steps[steps.length - 1] ?? 1;
  if (value === null) return steps[0] ?? last;
  return steps.find((step) => value <= step) ?? Math.ceil(value / last) * last;
}

export interface GaugeProps {
  label: string;
  value: number | null;
  max: number;
  unit: string;
}

/** A round dial with the value in the middle. */
export function Gauge({ label, value, max, unit }: GaugeProps) {
  const fraction = value === null || max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
  const shown = value === null ? "—" : String(Math.round(value));
  return (
    <figure className="gauge" aria-label={`${label}: ${shown} ${unit}`}>
      <svg viewBox="0 0 100 88" role="img" aria-hidden="true">
        <path className="gauge-track" d={arc(START_DEG, START_DEG + SWEEP_DEG)} />
        {fraction > 0.002 && (
          <path className="gauge-value" d={arc(START_DEG, START_DEG + SWEEP_DEG * fraction)} />
        )}
        <text className="gauge-number" x="50" y="54">
          {shown}
        </text>
        <text className="gauge-unit" x="50" y="70">
          {unit}
        </text>
      </svg>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

export interface MeterProps {
  /** 0 to 100, or null when unknown. */
  pct: number | null;
  tone?: "ok" | "warn" | "bad";
}

/** A thin horizontal fill bar. */
export function Meter({ pct, tone = "ok" }: MeterProps) {
  const width = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  return (
    <div className={`meter ${tone}`} aria-hidden="true">
      <span style={{ width: `${width}%` }} />
    </div>
  );
}

export interface LevelProps {
  label: string;
  pct: number | null;
  /** Replaces the percentage on the right, for example `7,200 of 12,000 L`. */
  detail?: string;
  tone?: MeterProps["tone"];
}

/** A labelled fill bar: fuel, a grain tank, a seeder's hopper. */
export function Level({ label, pct, detail, tone }: LevelProps) {
  return (
    <div className="level">
      <div className="level-row">
        <span>{label}</span>
        <span className="level-value">{detail ?? formatPct(pct)}</span>
      </div>
      <Meter pct={pct} tone={tone} />
    </div>
  );
}

/** Fuel reads red under 10 % and amber under 25 %. */
export function fuelTone(pct: number | null): MeterProps["tone"] {
  if (pct === null) return "ok";
  if (pct < 10) return "bad";
  return pct < 25 ? "warn" : "ok";
}

/** A tank reads amber from 80 % and red when full. */
export function tankTone(pct: number | null): MeterProps["tone"] {
  if (pct === null) return "ok";
  if (pct >= 99.5) return "bad";
  return pct >= 80 ? "warn" : "ok";
}
