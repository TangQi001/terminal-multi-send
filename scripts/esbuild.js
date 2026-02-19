/* eslint-disable no-console */
const esbuild = require("esbuild");
const fs = require("node:fs/promises");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function build() {
  await fs.rm("out", { recursive: true, force: true });
  await fs.mkdir("out", { recursive: true });

  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outfile: "out/extension.js",
    external: ["vscode"],
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    legalComments: "none",
    define: {
      "process.env.NODE_ENV": production ? "\"production\"" : "\"development\""
    },
    logLevel: "info"
  });

  if (watch) {
    await ctx.watch();
    console.log("[watch] esbuild started");
    return;
  }

  await ctx.rebuild();
  await ctx.dispose();
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
