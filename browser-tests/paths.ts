import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const assetPath = (path: string): string =>
    resolve(extensionRoot, "Assets", path);
export const corePath = (path: string): string =>
    resolve(extensionRoot, "../..", path);
export const fixturePath = (path: string): string =>
    resolve(
        process.env.GRIDTWEAKS_VIEWER_FIXTURE ||
            resolve(extensionRoot, "Tests/bin/Debug/net8.0/SimilarityViewer"),
        path,
    );
