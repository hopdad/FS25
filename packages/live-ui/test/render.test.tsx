import type { CommandResponse } from "@farmlink/schema";
import { renderToString } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { LiveDashboard } from "../src/components/LiveDashboard";
import { initialState, type LiveState, reduce } from "../src/store";
import { fullState, NOW, status } from "./fixtures";

const answer = async (): Promise<CommandResponse> => ({ id: 1, status: "ok", message: null });

function render(state: LiveState) {
  const html = renderToString(
    <LiveDashboard state={state} sendCommand={answer} dismiss={() => {}} />,
  );
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
  return { html, text };
}

describe("the live dashboard", () => {
  it("shows the driven vehicle, the farm's workers, alerts, fleet and money", () => {
    const { html, text } = render(fullState());
    expect(text).toContain("Live Day 37 · 14:06 Riverbend Springs");
    expect(html).toContain('<option value="2">Hillside</option>');

    expect(text).toContain("Fendt 942 Vario");
    expect(html).toContain('aria-label="Speed: 14 km/h"');
    expect(html).toContain('aria-label="Engine: 1450 rpm"');
    expect(text).toContain("Diesel 8 %");
    expect(html).toContain('class="meter bad"');
    expect(text).toContain("Amazone Cirrus 6003 Seeds 2,100 of 3,600 L");

    expect(text).toContain("Workers 1 working");
    expect(text).toContain("Alex · Claas Lexion 8900");
    expect(text).toContain("Field work · field 12");
    const button = html.match(/<button[^>]*class="stop idle"[^>]*>Stop<\/button>/)?.[0] ?? "";
    expect(button).not.toBe("");
    expect(button).not.toContain("disabled");
    expect(text).toContain("Sam · Fendt 942 Vario out of fuel");
    expect(text).toContain("worked 2 h 05 min of game time");
    expect(text).not.toContain("Kim");

    expect(text).toContain("Worker stopped");
    expect(text).toContain("Fleet 2 machines");
    expect(text).not.toContain("John Deere");
    expect(text).toContain("Riverbend Farms Balance 1,250,000 Loan 0");
    expect(text).toContain("Partly cloudy, 21 °C");
    expect(text).toContain("Wheat 180,000 L");
    expect(text).toContain("FarmLink bridge 0.2.0 · mod 0.2.0.0 · game 1.12.0.0");
  });

  it("waits politely before any data arrives", () => {
    const { text } = render(initialState());
    expect(text).toContain("Connecting…");
    expect(text).toContain("Waiting for the game…");
    expect(text).toContain("none working");
    expect(text).toContain("Nothing to report.");
  });

  it("disables Stop while the game is offline", () => {
    const offline = reduce(fullState(), {
      type: "message",
      message: { type: "status", status: { ...status, gameOnline: false } },
      at: NOW,
    });
    const { html, text } = render(offline);
    expect(text).toContain("Game offline");
    const button = html.match(/<button[^>]*class="stop idle"[^>]*>Stop<\/button>/)?.[0] ?? "";
    expect(button).toContain(" disabled ");
  });

  it("explains an out-of-date link and an unreachable bridge", () => {
    const unpaired = render(reduce(initialState(), { type: "connection", connection: "unpaired" }));
    expect(unpaired.text).toContain("Link out of date");
    expect(unpaired.text).toContain("scan the QR code");
    const gone = render(reduce(initialState(), { type: "connection", connection: "unreachable" }));
    expect(gone.text).toContain("Cannot reach the bridge");
  });
});
