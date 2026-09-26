import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PAGE_HTML } from "../generated/page";
import { buildPageHtml, PAGE_MODULE, pageModule } from "../scripts/build-page";

describe("the built phone page", () => {
  it("matches its sources", async () => {
    const fresh = pageModule(await buildPageHtml());
    const committed = readFileSync(PAGE_MODULE, "utf8");
    expect(
      committed === fresh,
      "generated/page.ts is stale: run `pnpm --filter @farmlink/live-ui run build`",
    ).toBe(true);
  });

  it("needs nothing from the internet and stays small", () => {
    expect(PAGE_HTML).toContain('<div id="root"></div>');
    expect(PAGE_HTML).not.toMatch(/\s(src|href)="(https?:)?\/\//);
    // The schema package's Zod code must not leak into the bundle.
    expect(PAGE_HTML).not.toMatch(/ZodError|\$ZodType/);
    expect(Buffer.byteLength(PAGE_HTML)).toBeLessThan(80 * 1024);
  });
});
