import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadAssetFileToPath, saveAssetLabels, uploadAssetFilesFromPaths } from "../../src/node.js";
import type { AssetsManager } from "../../src/resources.js";

const directories: string[] = [];
const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "snipeit-ts-"));
  directories.push(directory);
  return directory;
};
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("@lfctech/snipeit/node", () => {
  it("uploads validated paths with basenames and file contents", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "hello.txt");
    await writeFile(path, "hello");
    const uploadFiles = vi.fn(async (_id, files: Array<{ name: string; data: Blob }>, notes) => ({
      name: files[0]?.name,
      text: await files[0]?.data.text(),
      notes,
    }));
    const assets = { uploadFiles } as unknown as AssetsManager;
    await expect(uploadAssetFilesFromPaths(assets, 1, [path], "memo")).resolves.toEqual({ name: "hello.txt", text: "hello", notes: "memo" });
    await expect(uploadAssetFilesFromPaths(assets, 1, [])).rejects.toThrow("At least one");
    await expect(uploadAssetFilesFromPaths(assets, 1, [join(directory, "missing")])).rejects.toThrow("File not found");
  });

  it("streams to a nested path and replaces no file until success", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "nested", "file.bin");
    const downloadFile = vi.fn(async () => ({ stream: new Blob(["abcdef"]).stream(), contentLength: 6 }));
    const assets = { downloadFile } as unknown as AssetsManager;
    await expect(downloadAssetFileToPath(assets, 1, 2, destination)).resolves.toBe(destination);
    await expect(readFile(destination, "utf8")).resolves.toBe("abcdef");
    expect(await readdir(join(directory, "nested"))).toEqual(["file.bin"]);
  });

  it("removes temporary output after a streaming failure", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "failed.bin");
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("broken stream")); } });
    const assets = { downloadFile: async () => ({ stream }) } as unknown as AssetsManager;
    await expect(downloadAssetFileToPath(assets, 1, 2, destination)).rejects.toThrow("broken stream");
    expect(await readdir(directory)).toEqual([]);
  });

  it("saves generated labels and creates parent directories", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "labels", "assets.pdf");
    const labels = vi.fn(async () => new Blob(["%PDF"]));
    const assets = { labels } as unknown as AssetsManager;
    await expect(saveAssetLabels(assets, destination, ["A-1"])).resolves.toBe(destination);
    await expect(readFile(destination, "utf8")).resolves.toBe("%PDF");
    expect(labels).toHaveBeenCalledWith(["A-1"], {});
  });
});
