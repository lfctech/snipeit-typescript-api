import { constants, openAsBlob } from "node:fs";
import { access, mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { JsonRequestOptions } from "./http.js";
import type { AssetsManager } from "./resources.js";
import type { Asset, DownloadOptions } from "./types.js";

async function validatePath(path: string): Promise<void> {
  let information;
  try { information = await stat(path); }
  catch (cause) { throw new Error(`File not found: ${path}`, { cause }); }
  if (!information.isFile()) throw new Error(`Not a regular file: ${path}`);
  try { await access(path, constants.R_OK); }
  catch (cause) { throw new Error(`File not readable: ${path}`, { cause }); }
}

export async function uploadAssetFilesFromPaths(
  assets: AssetsManager,
  assetId: number | string,
  paths: readonly string[],
  notes?: string | null,
  request: JsonRequestOptions = {},
): Promise<Record<string, unknown>> {
  if (paths.length === 0) throw new TypeError("At least one file path required");
  await Promise.all(paths.map(validatePath));
  const files = await Promise.all(paths.map(async (path) => ({ name: basename(path), data: await openAsBlob(path) })));
  return assets.uploadFiles(assetId, files, notes, request);
}

export async function downloadAssetFileToPath(
  assets: AssetsManager,
  assetId: number | string,
  fileId: number | string,
  savePath: string,
  options: DownloadOptions = {},
): Promise<string> {
  await mkdir(dirname(savePath), { recursive: true });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const temporaryPath = `${savePath}.part-${suffix}`;
  const handle = await open(temporaryPath, "wx");
  try {
    const download = await assets.downloadFile(assetId, fileId, options);
    const reader = download.stream.getReader();
    let position = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await handle.write(value, 0, value.byteLength, position);
        position += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, savePath);
    return savePath;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function saveAssetLabels(
  assets: AssetsManager,
  savePath: string,
  assetsOrTags: readonly (string | Pick<Asset, "asset_tag">)[],
  request: JsonRequestOptions = {},
): Promise<string> {
  const pdf = await assets.labels(assetsOrTags, request);
  await mkdir(dirname(savePath), { recursive: true });
  await writeFile(savePath, new Uint8Array(await pdf.arrayBuffer()));
  return savePath;
}
