/** HTML shells of the React pages: ES module entries (code splitting), no inline script (CSP `script-src 'self'`). */
import { describe, it, expect, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { dashboardRouter } from "../routes/dashboard.js";

const app = express();
app.use(dashboardRouter);
const server = app.listen(0);
afterAll(() => server.close());

async function page(path: string): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
  return r.text();
}

describe("dashboard shells", () => {
  it.each([
    ["/", "/js/dashboard.js"],
    ["/verify-device", "/js/dashboard.js"],
    ["/join/quiet-harbor", "/js/join.js"],
  ])("%s loads %s as a module and nothing inline", async (path, entry) => {
    const html = await page(path);
    expect(html).toContain(`<script type="module" src="${entry}"></script>`);
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts).toHaveLength(1);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });
});
