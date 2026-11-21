import Module from "node:module";
import { defineConfig } from "drizzle-kit";

// drizzle-kit loads the schema as CommonJS and does not map NodeNext "./x.js" imports to "x.ts".
// It restores Module._resolveFilename after loading this file, so the hook goes on _findPath.
const mod = Module as unknown as { _findPath: (request: string, paths: string[], ...rest: unknown[]) => string | false };
const findPath = mod._findPath;
mod._findPath = function (request, paths, ...rest) {
  const found = findPath.call(this, request, paths, ...rest);
  if (found || !request.startsWith(".") || !request.endsWith(".js")) return found;
  return findPath.call(this, request.slice(0, -3) + ".ts", paths, ...rest);
};

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://atproto_tailnet:atproto_tailnet@localhost:5432/atproto_tailnet",
  },
});
