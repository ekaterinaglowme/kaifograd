import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export const nodeBin = process.execPath;
export const projectRoot = new URL("../..", import.meta.url).pathname;

export async function startTestServer({ port = 0 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "kaifograd-test-"));
  const stateFile = join(dir, "game-state.json");
  const child = spawn(nodeBin, ["server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      STATE_FILE: stateFile,
      HOST_CODE: "0306",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const deadline = Date.now() + 5000;
  let baseUrl = "";
  while (Date.now() < deadline) {
    const match = stdout.match(/http:\/\/localhost:(\d+)/);
    if (match) {
      baseUrl = `http://localhost:${match[1]}`;
      break;
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  if (!baseUrl) {
    child.kill();
    await rm(dir, { recursive: true, force: true });
    throw new Error(`Server did not start.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  async function stop() {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
    await rm(dir, { recursive: true, force: true });
  }

  return {
    baseUrl,
    stateFile,
    dir,
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    stop,
  };
}

export async function state(baseUrl, query = "view=host&code=0306") {
  const response = await fetch(`${baseUrl}/api/state?${query}`);
  assertHttp(response);
  return response.json();
}

export async function action(baseUrl, payload) {
  const response = await fetch(`${baseUrl}/api/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) throw new Error(body.error || response.statusText);
  return body;
}

export async function actionMayFail(baseUrl, payload) {
  const response = await fetch(`${baseUrl}/api/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok && !body.error, status: response.status, body };
}

export async function waitForState(baseUrl, predicate, { timeoutMs = 6000, query = "view=host&code=0306" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await state(baseUrl, query);
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for state. Latest: ${JSON.stringify(latest)}`);
}

export async function loginAndJoin(baseUrl, pin, { name = `Команда ${pin}`, color = "#4CC9F0" } = {}) {
  const login = await action(baseUrl, { type: "loginTeam", pin });
  await action(baseUrl, {
    type: "join",
    teamId: login.teamId,
    token: login.token,
    name,
    color,
    captain: "Команда",
  });
  return login;
}

export async function collectSseEvents(url, { count = 2, timeoutMs = 2500 } = {}) {
  const response = await fetch(url);
  assertHttp(response);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline && events.length < count) {
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remaining)),
      ]);
      if (result.timeout || result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";
      for (const chunk of chunks) {
        const lines = chunk.split("\n").filter((line) => line.startsWith("data: "));
        for (const line of lines) events.push(JSON.parse(line.slice(6)));
        if (events.length >= count) break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return events;
}

function assertHttp(response) {
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
}
