import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packDirectory = mkdtempSync(join(tmpdir(), "snipeit-pack-"));
rmSync(join(root, "dist"), { recursive: true, force: true });
execFileSync("pnpm", ["pack", "--pack-destination", packDirectory], { cwd: root, encoding: "utf8" });
const packedFiles = readdirSync(packDirectory).filter((name) => name.endsWith(".tgz"));
if (packedFiles.length !== 1 || packedFiles[0] === undefined) throw new Error(`Expected one packed archive, found: ${packedFiles.join(", ")}`);
const tarball = join(packDirectory, packedFiles[0]);

const archiveEntries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
for (const required of [
  "package/dist/index.js", "package/dist/index.d.ts", "package/dist/node.js", "package/dist/node.d.ts",
  "package/docs/PARITY.md", "package/docs/ARCHITECTURE.md",
]) {
  if (!archiveEntries.includes(required)) throw new Error(`Packed documentation missing: ${required}`);
}
const unresolvedMaps = archiveEntries.filter((entry) => entry.endsWith(".map"));
if (unresolvedMaps.length > 0) throw new Error(`Packed package must not contain unresolved maps: ${unresolvedMaps.join(", ")}`);

function installConsumer(name, source) {
  const directory = mkdtempSync(join(tmpdir(), `snipeit-${name}-`));
  try {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: `consumer-${name}`, private: true, type: "module" }));
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: directory, stdio: "pipe" });
    writeFileSync(join(directory, "index.mjs"), source);
    execFileSync(process.execPath, ["index.mjs"], { cwd: directory, stdio: "inherit" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

installConsumer("portable", `
import { SnipeIT, VERSION } from "@lfctech/snipeit";
const calls = [];
const client = new SnipeIT({ baseUrl: "https://example.test", token: "token", fetch: async (input) => {
  calls.push(String(input));
  return Response.json({ id: 1, username: "packed" });
}});
const me = await client.users.me();
if (me.username !== "packed" || VERSION !== "0.1.0" || calls.length !== 1) throw new Error("portable packed consumer failed");
`);

installConsumer("node", `
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAssetLabels } from "@lfctech/snipeit/node";
const directory = await mkdtemp(join(tmpdir(), "packed-node-"));
try {
  const path = join(directory, "nested", "labels.pdf");
  await saveAssetLabels({ labels: async () => new Blob(["%PDF"]) }, path, ["A"]);
  if (await readFile(path, "utf8") !== "%PDF") throw new Error("node packed consumer failed");
} finally { await rm(directory, { recursive: true, force: true }); }
`);

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!packageJson.exports?.["."] || !packageJson.exports?.["./node"]) throw new Error("packed exports missing");
rmSync(packDirectory, { recursive: true, force: true });
console.log("packed portable and Node consumers passed from a missing-dist start");
