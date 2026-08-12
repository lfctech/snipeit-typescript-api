import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = readFileSync(resolve(root, "tests/workers/wrangler.jsonc"), "utf8");
if (/nodejs_compat/u.test(config)) throw new Error("Workers config must not enable nodejs_compat");
for (const file of ["dist/index.js", "dist/client.js", "dist/http.js", "dist/resources.js", "dist/errors.js", "dist/version.js"]) {
  const source = readFileSync(resolve(root, file), "utf8");
  if (/from\s+["']node:|require\s*\(|process\.|\bBuffer\b|__dirname|__filename/u.test(source)) throw new Error(`Portable output contains a Node reference: ${file}`);
}

const port = 8791;
const child = spawn(process.execPath, [resolve(root, "node_modules/wrangler/bin/wrangler.js"), "dev", "--config", "tests/workers/wrangler.jsonc", "--ip", "127.0.0.1", "--port", String(port), "--local", "--log-level", "error"], {
  cwd: root,
  env: { ...process.env, CI: "1", NO_COLOR: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });

const childIsRunning = () => child.exitCode === null && child.signalCode === null;
const waitForExit = async (timeoutMs) => {
  if (!childIsRunning()) return;
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, timeoutMs)),
  ]);
};
let shutdownPromise;
const shutdown = () => {
  shutdownPromise ??= (async () => {
    if (childIsRunning()) child.kill("SIGTERM");
    await waitForExit(2_000);
    if (childIsRunning()) child.kill("SIGKILL");
    await waitForExit(1_000);
    if (childIsRunning()) throw new Error("Wrangler did not terminate after SIGKILL");
  })();
  return shutdownPromise;
};
const removeSignalHandlers = () => {
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
};
let signalReceived = false;
const handleSignal = (signal) => {
  if (signalReceived) return;
  signalReceived = true;
  void shutdown().finally(() => {
    removeSignalHandlers();
    process.kill(process.pid, signal);
  });
};
const onSigint = () => handleSignal("SIGINT");
const onSigterm = () => handleSignal("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

const deadline = Date.now() + 30_000;
let result;
try {
  while (Date.now() < deadline) {
    if (!childIsRunning()) throw new Error(`Wrangler exited ${child.exitCode ?? child.signalCode}:\n${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(Math.min(2_000, Math.max(1, deadline - Date.now()))) });
      const body = await response.json();
      if (!response.ok || body.ok !== true) throw new Error(`Worker checks failed: ${JSON.stringify(body)}`);
      result = body;
      break;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Worker checks failed")) throw error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(200, remainingMs)));
    }
  }
  if (result === undefined) throw new Error(`Timed out waiting for Worker:\n${output}`);
  const names = ["import", "request", "pagination", "upload", "download", "cancellation", "errors"];
  for (const name of names) if (result.checks?.[name] !== true) throw new Error(`Missing Worker check: ${name}`);
  console.log(`Workers checks passed without nodejs_compat: ${names.join(", ")}`);
} finally {
  try { await shutdown(); }
  finally { removeSignalHandlers(); }
}
