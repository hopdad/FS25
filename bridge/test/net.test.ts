import type { networkInterfaces } from "node:os";
import { describe, expect, it } from "vitest";
import { lanAddresses, pageUrl, terminalQr } from "../src/net";

type Interfaces = ReturnType<typeof networkInterfaces>;

function entry(address: string, family: "IPv4" | "IPv6" = "IPv4", internal = false) {
  return {
    address,
    family,
    internal,
    netmask: "255.255.255.0",
    mac: "00:00:00:00:00:00",
    cidr: null,
    ...(family === "IPv6" ? { scopeid: 0 } : {}),
  } as NonNullable<Interfaces[string]>[number];
}

describe("lanAddresses", () => {
  it("lists reachable IPv4 addresses, the home network first", () => {
    const interfaces: Interfaces = {
      lo: [entry("127.0.0.1", "IPv4", true)],
      vpn: [entry("100.64.3.2")],
      eth0: [entry("192.168.1.23"), entry("fe80::1", "IPv6")],
      office: [entry("10.1.2.3")],
      apipa: [entry("169.254.10.1")],
    };
    expect(lanAddresses(interfaces)).toEqual(["192.168.1.23", "10.1.2.3", "100.64.3.2"]);
  });

  it("puts virtual adapters last, whatever their range", () => {
    // What Windows reports with WSL, Docker Desktop and Tailscale installed.
    const interfaces: Interfaces = {
      "vEthernet (WSL (Hyper-V firewall))": [entry("192.168.80.1")],
      "vEthernet (Default Switch)": [entry("172.25.96.1")],
      Tailscale: [entry("100.101.102.103")],
      "Wi-Fi": [entry("192.168.1.23")],
      Ethernet: [entry("172.20.10.4")],
    };
    expect(lanAddresses(interfaces)).toEqual([
      "192.168.1.23",
      "172.20.10.4",
      "192.168.80.1",
      "172.25.96.1",
      "100.101.102.103",
    ]);
  });

  it("returns nothing on a machine with no network", () => {
    expect(lanAddresses({ lo: [entry("127.0.0.1", "IPv4", true)] })).toEqual([]);
  });
});

describe("pageUrl", () => {
  it("puts the token in the query string", () => {
    expect(pageUrl("192.168.1.23", 8790, "a+b/c")).toBe("http://192.168.1.23:8790/?t=a%2Bb%2Fc");
  });
});

describe("terminalQr", () => {
  it("draws a square code with block characters", () => {
    const lines = terminalQr("http://192.168.1.23:8790/?t=Zm9vYmFyYmF6cXV4").split("\n");
    expect(lines.length).toBeGreaterThan(10);
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
    expect(lines.join("")).toMatch(/[█▀▄]/);
  });
});
