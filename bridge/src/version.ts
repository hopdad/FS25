export const BRIDGE_VERSION = "0.2.0";

/** The JavaScript runtime this process is on, for `--doctor` and bug reports. */
export function runtimeName(): string {
  const bun = (process.versions as Record<string, string | undefined>).bun;
  return bun ? `bun ${bun}` : `node ${process.versions.node}`;
}
