import { z } from "zod";
import { CONTRACTS } from "./index";

/** Renders each contract as a draft 2020-12 JSON Schema document, keyed by contract name. */
export function renderJsonSchemas(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, schema] of Object.entries(CONTRACTS)) {
    const document = { title: name, ...z.toJSONSchema(schema, { target: "draft-2020-12" }) };
    out[name] = `${JSON.stringify(document, null, 2)}\n`;
  }
  return out;
}
