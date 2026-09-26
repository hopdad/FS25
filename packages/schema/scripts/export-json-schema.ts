import { mkdirSync, writeFileSync } from "node:fs";
import { renderJsonSchemas } from "../src/jsonSchema";

const outDir = new URL("../json-schema/", import.meta.url);
mkdirSync(outDir, { recursive: true });
for (const [name, text] of Object.entries(renderJsonSchemas())) {
  writeFileSync(new URL(`${name}.schema.json`, outDir), text);
  console.log(`wrote json-schema/${name}.schema.json`);
}
