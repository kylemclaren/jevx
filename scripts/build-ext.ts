/** Bundles the background service worker and the two x.com scripts into dist/. Run after `vite build`. */
export {}
const shared = { outdir: "dist", target: "browser" as const, minify: true, sourcemap: "none" as const }

const results = await Promise.all([
  Bun.build({ ...shared, entrypoints: ["src/ext/background.ts"], format: "esm" }),
  Bun.build({ ...shared, entrypoints: ["src/ext/content.ts"], format: "iife" }),
  Bun.build({ ...shared, entrypoints: ["src/ext/inject.ts"], format: "iife" }),
])
for (const r of results) {
  if (!r.success) {
    for (const log of r.logs) console.error(log)
    process.exit(1)
  }
  for (const o of r.outputs) console.log(`  ${o.path.replace(process.cwd() + "/", "")}  ${(o.size / 1024).toFixed(1)} kB`)
}
console.log("Load dist/ as an unpacked extension at chrome://extensions")
