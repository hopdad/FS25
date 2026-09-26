import { networkInterfaces } from "node:os";
import { renderUnicodeCompact } from "uqr";

type Interfaces = ReturnType<typeof networkInterfaces>;

function isPrivateIPv4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  if (a === undefined || b === undefined) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * The machine's LAN IPv4 addresses, private ranges first: those are what a phone on the same
 * Wi-Fi can reach. Loopback and link-local addresses are left out.
 */
export function lanAddresses(interfaces: Interfaces = networkInterfaces()): string[] {
  const found: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      if (!found.includes(entry.address)) found.push(entry.address);
    }
  }
  return found.sort((x, y) => Number(isPrivateIPv4(y)) - Number(isPrivateIPv4(x)));
}

/** The URL a phone opens: the page, with the pairing token the WebSocket requires. */
export function pageUrl(host: string, port: number, token: string): string {
  return `http://${host}:${port}/?t=${encodeURIComponent(token)}`;
}

/** A QR code for the terminal, so the phone can open the page by scanning it. */
export function terminalQr(text: string): string {
  return renderUnicodeCompact(text, { border: 1 });
}
