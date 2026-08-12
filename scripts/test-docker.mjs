import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const compose = ["compose", "-p", "snipeit-typescript-integration", "-f", "docker/docker-compose.yml"];
const tokenPath = resolve(root, "docker/api-token.txt");
const port = Number(process.env.SNIPEIT_DOCKER_PORT ?? 18080);
const baseUrl = `http://localhost:${port}`;
const runDockerSync = (args, options = {}) => execFileSync("docker", [...compose, ...args], { cwd: root, encoding: "utf8", ...options });

const version = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { cwd: root, encoding: "utf8" });
if (version.status !== 0) throw new Error(`Docker daemon is required for integration tests:\n${version.stderr}`);

let activeChild;
const childIsRunning = (child) => child !== undefined && child.exitCode === null && child.signalCode === null;
const runAsync = (command, args, options = {}) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(command, args, {
    cwd: root,
    ...(options.env === undefined ? {} : { env: options.env }),
    stdio: options.stdio ?? "pipe",
  });
  activeChild = child;
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  let settled = false;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    if (activeChild === child) activeChild = undefined;
    if (error === undefined) resolveRun(stdout);
    else rejectRun(error);
  };
  child.once("error", finish);
  child.once("exit", (code, signal) => {
    if (code === 0) finish();
    else finish(new Error(`${command} exited ${code ?? signal ?? "unknown"}${stderr === "" ? "" : `:\n${stderr}`}`));
  });
});
const runDocker = (args, options = {}) => runAsync("docker", [...compose, ...args], options);

let cleanupStarted = false;
let pendingSignal;
const cleanup = (stdio = "pipe") => {
  if (cleanupStarted) return;
  cleanupStarted = true;
  try { runDockerSync(["down", "--volumes", "--remove-orphans"], { stdio, detached: true }); }
  finally { rmSync(tokenPath, { force: true }); }
};
const removeSignalHandlers = () => {
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
};
const handleSignal = (signal) => {
  pendingSignal ??= signal;
  if (cleanupStarted) return;
  const child = activeChild;
  try {
    if (childIsRunning(child)) child.kill("SIGTERM");
    cleanup("inherit");
  } catch (error) {
    console.error(`Docker cleanup failed while handling ${signal}:`, error);
  } finally {
    if (childIsRunning(child)) child.kill("SIGKILL");
    removeSignalHandlers();
    process.kill(process.pid, pendingSignal);
  }
};
const onSigint = () => handleSignal("SIGINT");
const onSigterm = () => handleSignal("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

let failed = false;
try {
  await runDocker(["down", "--volumes", "--remove-orphans"]);
  writeFileSync(tokenPath, "", { mode: 0o600 });
  await runDocker(["up", "--detach"], { stdio: "inherit" });

  const deadline = Date.now() + 300_000;
  let token = "";
  let readiness;
  while (Date.now() < deadline) {
    try { token = readFileSync(tokenPath, "utf8").trim(); } catch { token = ""; }
    if (token !== "") {
      try {
        const response = await fetch(`${baseUrl}/api/v1/users/me`, {
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
          signal: AbortSignal.timeout(Math.min(3_000, Math.max(1, deadline - Date.now()))),
        });
        if (response.ok) {
          const body = await response.json();
          if (body && typeof body === "object" && body.id) { readiness = body; break; }
        }
      } catch { /* app is not listening yet */ }
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(1_000, remainingMs)));
  }
  if (!readiness) throw new Error("Timed out waiting for a generated token plus authenticated /users/me readiness");
  console.log(`Authenticated Docker readiness passed for user ${readiness.id}`);

  await runAsync(process.execPath, ["tests/integration/docker.mjs"], {
    env: { ...process.env, SNIPEIT_TEST_URL: baseUrl, SNIPEIT_TEST_TOKEN: token },
    stdio: "inherit",
  });
} catch (error) {
  failed = true;
  try { console.error(await runDocker(["logs", "--no-color", "--tail", "200"])); } catch { /* preserve original failure */ }
  throw error;
} finally {
  try { cleanup(failed ? "inherit" : "pipe"); }
  finally {
    removeSignalHandlers();
    if (pendingSignal !== undefined) process.kill(process.pid, pendingSignal);
  }
}
