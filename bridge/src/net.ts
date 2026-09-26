import { networkInterfaces } from "node:os";
import { renderUnicodeCompact } from "uqr";

type Interfaces = ReturnType<typeof networkInterfaces>;

/** Adapters a phone on the home Wi-Fi cannot reach: virtual machines, containers and VPNs. */
const VIRTUAL =
  /vethernet|wsl|hyper-v|docker|virtualbox|vmware|vbox|loopback|tailscale|zerotier|hamachi|radmin|wireguard|openvpn|tap-|tun|utun|^veth|^br-|virbr/i;

/** Home routers hand out 192.168.x.x most often, then 10.x.x.x; 172.16/12 is mostly virtual. */
function rangeRank(address: string): number {
  const [a, b] = address.split(".").map(Number);
  if (a === 192 && b === 168) return 0;
  if (a === 10) return 1;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return 2;
  return 3;
}

/**
 * The machine's IPv4 addresses a phone might reach, most likely first: real adapters before
 * virtual ones, then by how often home networks use the range. Loopback and link-local addresses
 * are left out. The first one goes into the QR code; all of them are printed.
 */
export function lanAddresses(interfaces: Interfaces = networkInterfaces()): string[] {
  const found: Array<{ address: string; virtual: boolean }> = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      if (found.some((f) => f.address === entry.address)) continue;
      found.push({ address: entry.address, virtual: VIRTUAL.test(name) });
    }
  }
  return found
    .sort(
      (x, y) =>
        Number(x.virtual) - Number(y.virtual) || rangeRank(x.address) - rangeRank(y.address),
    )
    .map((f) => f.address);
}

/** The URL a phone opens: the page, with the pairing token the WebSocket requires. */
export function pageUrl(host: string, port: number, token: string): string {
  return `http://${host}:${port}/?t=${encodeURIComponent(token)}`;
}

/** A QR code for the terminal, so the phone can open the page by scanning it. */
export function terminalQr(text: string): string {
  return renderUnicodeCompact(text, { border: 1 });
}
