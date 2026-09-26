import {
  type BridgeHeartbeat,
  BridgeHeartbeat as BridgeHeartbeatSchema,
  Command,
  type CommandsFile,
  CommandsFile as CommandsFileSchema,
} from "./channel";

// Wire formats for the two files the mod reads. The FS25 sandbox only lets a mod read XML
// (PLAN_REVIEW.md F1), so these are XML, parsed in the game with XMLFile:
//
//   <commands v="1" epoch="<uuid>">
//       <command id="57" type="worker.stop" farmId="1" issuedAt="..." ttlSec="30" jobId="9"/>
//   </commands>
//
//   <bridge v="1" version="0.2.0" beat="12" realTs="..." features="commands xlsx"/>
//
// A command's args become attributes next to its envelope; an arg may not reuse an envelope name.
// The parsers are for tests and --doctor; the bridge only ever writes these files.

const XML_DECLARATION = '<?xml version="1.0" encoding="utf-8" standalone="no" ?>';
const ENVELOPE = ["id", "type", "farmId", "issuedAt", "ttlSec"] as const;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

function unescapeAttribute(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function attributes(pairs: Array<[string, string | number]>): string {
  return pairs.map(([name, value]) => `${name}="${escapeAttribute(String(value))}"`).join(" ");
}

function parseAttributes(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of source.matchAll(/([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) out[name] = unescapeAttribute(value);
  }
  return out;
}

/** Serializes the command ring the bridge writes to `commands.xml`. */
export function renderCommandsXml(file: CommandsFile): string {
  const parsed = CommandsFileSchema.parse(file);
  const lines = [
    XML_DECLARATION,
    `<commands ${attributes([
      ["v", 1],
      ["epoch", parsed.epoch],
    ])}>`,
  ];
  for (const command of parsed.commands) {
    const pairs: Array<[string, string | number]> = [
      ["id", command.id],
      ["type", command.type],
      ["farmId", command.farmId],
      ["issuedAt", command.issuedAt],
      ["ttlSec", command.ttlSec],
    ];
    for (const [name, value] of Object.entries(command.args)) {
      if ((ENVELOPE as readonly string[]).includes(name) || name === "v") {
        throw new Error(`command arg "${name}" collides with an envelope attribute`);
      }
      pairs.push([name, value]);
    }
    lines.push(`    <command ${attributes(pairs)}/>`);
  }
  lines.push("</commands>", "");
  return lines.join("\n");
}

/** Reads `commands.xml` back into its logical shape. */
export function parseCommandsXml(text: string): CommandsFile {
  const root = text.match(/<commands\b([^>]*)>/);
  if (!root) throw new Error("no <commands> element");
  const rootAttributes = parseAttributes(root[1] ?? "");
  const commands = [...text.matchAll(/<command\b([^>]*?)\/>/g)].map((match) => {
    const attrs = parseAttributes(match[1] ?? "");
    const args: Record<string, string> = {};
    for (const [name, value] of Object.entries(attrs)) {
      if (!(ENVELOPE as readonly string[]).includes(name)) args[name] = value;
    }
    return Command.parse({
      v: 1,
      id: Number(attrs.id),
      type: attrs.type,
      farmId: Number(attrs.farmId),
      issuedAt: attrs.issuedAt,
      ttlSec: Number(attrs.ttlSec),
      args,
    });
  });
  return CommandsFileSchema.parse({
    v: Number(rootAttributes.v),
    epoch: rootAttributes.epoch,
    commands,
  });
}

/** Serializes the bridge heartbeat to `bridge.xml`. */
export function renderBridgeXml(heartbeat: BridgeHeartbeat): string {
  const hb = BridgeHeartbeatSchema.parse(heartbeat);
  const pairs: Array<[string, string | number]> = [
    ["v", 1],
    ["version", hb.bridgeVersion],
    ["beat", hb.beat],
    ["realTs", hb.realTs],
    ["features", hb.features.join(" ")],
  ];
  return `${XML_DECLARATION}\n<bridge ${attributes(pairs)}/>\n`;
}

/** Reads `bridge.xml` back into its logical shape. */
export function parseBridgeXml(text: string): BridgeHeartbeat {
  const element = text.match(/<bridge\b([^>]*?)\/?>/);
  if (!element) throw new Error("no <bridge> element");
  const attrs = parseAttributes(element[1] ?? "");
  return BridgeHeartbeatSchema.parse({
    v: Number(attrs.v),
    bridgeVersion: attrs.version,
    beat: Number(attrs.beat),
    realTs: attrs.realTs,
    features: (attrs.features ?? "").split(" ").filter((f) => f.length > 0),
  });
}
