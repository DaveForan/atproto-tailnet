import * as esbuild from "esbuild";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";

const watch = process.argv.includes("--watch");
const jsDir = path.join("public", "js");

/**
 * One ESM build for every page, so React and the shared code are one cached
 * chunk and each lazy dashboard tab is its own chunk. Pages load the entry
 * with `<script type="module">` (CSP `script-src 'self'` covers chunks: they
 * are same-origin files under /js/).
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
  // Hashed names: a chunk's URL changes with its content, so a cached old chunk is never mixed with a new entry
  chunkNames: "js/chunks/[name]-[hash]",
  logLevel: "info",
};

/** Drop chunks of earlier builds (their names carry a content hash, so they pile up). */
function cleanChunks() {
  rmSync(path.join(jsDir, "chunks"), { recursive: true, force: true });
  // Earlier non-split builds wrote only the two entries; nothing else in js/ is ours
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
