import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const shared: esbuild.BuildOptions = {
  bundle: true,
  minify: !watch,
  // No public source maps in production builds
  sourcemap: watch,
  target: "es2021",
  jsx: "automatic",
  jsxImportSource: "react",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  outdir: "public",
  logLevel: "info",
};

const configs: esbuild.BuildOptions[] = [
  {
    ...shared,
    entryPoints: { "js/dashboard": "src/client/main.tsx" },
  },
  {
    ...shared,
    entryPoints: { "js/join": "src/client/join.tsx" },
  },
  {
    ...shared,
    entryPoints: { "js/board": "src/client/board.ts" },
  },
];

async function run() {
  if (watch) {
    const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("Watching for changes...");
  } else {
    await Promise.all(configs.map((c) => esbuild.build(c)));
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
