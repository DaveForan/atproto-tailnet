import { describe, it, expect } from "vitest";
import express from "express";
import session from "express-session";
import type { AddressInfo } from "node:net";

async function setCookieBehindProxy(trustProxy: number): Promise<string | null> {
  const app = express();
  app.set("trust proxy", trustProxy);
  app.use(session({ secret: "x".repeat(32), resave: false, saveUninitialized: false, cookie: { secure: true } }));
  app.get("/login", (req, res) => {
    req.session.userId = "u";
    res.end("ok");
  });
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/login`, { headers: { "X-Forwarded-Proto": "https" } });
    return res.headers.get("set-cookie");
  } finally {
    server.close();
  }
}

describe("trust proxy and secure session cookies", () => {
  it("issues the secure cookie behind one trusted proxy", async () => {
    expect(await setCookieBehindProxy(1)).toMatch(/connect\.sid=.*Secure/);
  });

  it("never issues it when the proxy is not trusted (sign-in would loop)", async () => {
    expect(await setCookieBehindProxy(0)).toBeNull();
  });
});
