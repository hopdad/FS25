import { z } from "zod";
import { Version } from "./primitives";

/**
 * `_probe/probe.json`, written by the P0 probe. Each section answers one verify-first item and is
 * free-form on purpose: the probe records what the engine actually returned.
 */
export const ProbeReport = z.object({
  v: Version,
  /** Raw game clock string; not validated as a timestamp because the probe is testing that. */
  generatedAt: z.string(),
  modVersion: z.string(),
  sections: z.record(z.string(), z.unknown()),
});

export type ProbeReport = z.infer<typeof ProbeReport>;
