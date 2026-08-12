import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const compose = ["compose", "-p", "snipeit-typescript-integration", "-f", "docker/docker-compose.yml"];
const tokenPath = resolve(root, "docker/api-token.txt");
const port = Number(process.env.SNIPEIT_DOCKER_PORT ?? 18080);
const baseUrl = `http://localhost:${port}`;
const runDocker = (args, options = {}) => execFileSync("docker", [...compose, ...args], { cwd: root, encoding: "utf8", ...options });

const version = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" });
if (version.status !== 0) throw new Error(`Docker daemon is required for integration tests:\n${version.stderr}`);

let failed = false;
try {
  runDocker(["down", "--volumes", "--remove-orphans"], { stdio: "pipe" });
  writeFileSync(tokenPath, "", { mode: 0o600 });
  runDocker(["up", "--detach"], { stdio: "inherit" });

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

  execFileSync(process.execPath, ["tests/integration/docker.mjs"], {
    cwd: root,
    env: { ...process.env, SNIPEIT_TEST_URL: baseUrl, SNIPEIT_TEST_TOKEN: token },
    stdio: "inherit",
  });
} catch (error) {
  failed = true;
  try { console.error(runDocker(["logs", "--no-color", "--tail", "200"])); } catch { /* preserve original failure */ }
  throw error;
} finally {
  try { runDocker(["down", "--volumes", "--remove-orphans"], { stdio: failed ? "inherit" : "pipe" }); } finally { rmSync(tokenPath, { force: true }); }
}
