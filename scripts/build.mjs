import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
);

await build({
    absWorkingDir: projectRoot,
    entryPoints: ["frontend/running-grid.ts", "frontend/similarity-page.ts"],
    outdir: "Assets",
    bundle: true,
    format: "iife",
    target: "es2022",
    minify: false,
    sourcemap: true,
    charset: "utf8",
    legalComments: "none",
});
