import * as esbuild from "esbuild";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";

const watch = process.argv.includes("--watch");
const jsDir = path.join("public", "js");

/**
 * One ESM build for all pages: React and shared code share one cached chunk. Each lazy tab gets its own chunk.
 * Pages load the entry with `<script type="module">`. CSP `script-src 'self'` covers the same-origin chunks in /js/.
 */
const config: esbuild.BuildOptions = {
  bundle: true,
  splitting: true,
  format: "esm",
  minify: !watch,
  // No public source maps in production builds
  sourcemap: watch,
  target: "es2021",
  jsx: "automatic",
  jsxImportSource: "react",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  outdir: "public",
  entryPoints: { "js/dashboard": "src/client/main.tsx", "js/join": "src/client/join.tsx" },
  // Hashed names give new content a new URL. A stale cached chunk never mixes with a new entry.
  chunkNames: "js/chunks/[name]-[hash]",
  logLevel: "info",
};

/** Drop chunks of earlier builds (their names carry a content hash, so they pile up). */
function cleanChunks() {
  rmSync(path.join(jsDir, "chunks"), { recursive: true, force: true });
  // Only the two entries and old top-level chunk files are ours. Leave all other files.
  for (const f of readdirSync(jsDir, { withFileTypes: true }).filter((e) => e.isFile())) {
    if (/^(dashboard|join)\.js(\.map)?$/.test(f.name)) continue;
    if (/^chunk-.*\.js(\.map)?$/.test(f.name)) rmSync(path.join(jsDir, f.name));
  }
}

async function run() {
  try {
    cleanChunks();
  } catch {
    // first build: public/js does not exist yet
  }
  if (watch) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
    console.log("Watching for changes...");
  } else {
    await esbuild.build(config);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
