const pad = (value: number) => String(value).padStart(2, "0");

/**
 * Local wall-clock time with its UTC offset, for example `2026-09-26T11:04:05-04:00`. Command
 * timestamps use this form: the mod compares them with its own local clock, and when the game
 * cannot tell its offset, the local fields still line up because both run on one machine.
 */
export function localIsoWithOffset(date: Date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

/**
 * Milliseconds since 1970 for a timestamp the mod wrote. One without an offset is local time,
 * which is how the ECMAScript date parser reads it too.
 */
export function parseGameTimestamp(timestamp: string): number | undefined {
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? undefined : ms;
}
