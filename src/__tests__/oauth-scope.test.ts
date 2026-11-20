/** Sign-in is identification only: the OAuth scope never grants account access. */
import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, pool: {} }));

import { OAUTH_SCOPE, getClientMetadata } from "../auth/atproto.js";

describe("OAuth scope", () => {
  it("requests the atproto identity scope and nothing else", () => {
    expect(OAUTH_SCOPE).toBe("atproto");
    expect((getClientMetadata() as { scope: string }).scope).toBe("atproto");
  });

  it("no source file requests a transition scope", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name === "node_modules" || name === "__tests__") continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && /["'`][^"'`]*transition:(generic|chat|email)/.test(readFileSync(p, "utf8"))) {
          offenders.push(p);
        }
      }
    };
    walk(join(import.meta.dirname, ".."));
    expect(offenders).toEqual([]);
  });
});
