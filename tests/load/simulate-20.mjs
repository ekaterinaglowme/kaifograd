// Нагрузочная проба: «выдержит ли Кайфоград, если разом зайдут 20 человек».
// Поднимает настоящий сервер, открывает 20 живых SSE-подключений (проектор + зрители +
// команды), проигрывает несколько вопросов с одновременными ответами и всплеском запросов,
// затем печатает задержки и вердикт. Запуск: npm run test:load
import { startTestServer } from "../helpers/integration-server.js";

const TOTAL_VIEWERS = 20;

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function ms(n) {
  return `${n.toFixed(1)} мс`;
}

async function post(baseUrl, payload) {
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}/api/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    return { ms: performance.now() - started, ok: response.ok && !body.error, body, status: response.status };
  } catch (error) {
    // Сетевой сбой на стороне клиента (например переполнение пула соединений) — не роняем пробу.
    return { ms: performance.now() - started, ok: false, body: {}, status: 0, netError: String(error?.cause?.code || error?.message || error) };
  }
}

// Выполняет задачи с ограничением одновременности (как реальные браузеры: несколько
// соединений на origin, а не сотни сразу).
async function runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor++;
      results[index] = await tasks[index]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

// Живой SSE-клиент: держит соединение, складывает события с временем получения,
// умеет дождаться нужного состояния (для замера задержки рассылки).
function openViewer(baseUrl, query) {
  const controller = new AbortController();
  const client = { events: 0, waiters: [], lastStatus: null, bytes: 0 };
  const run = async () => {
    const response = await fetch(`${baseUrl}/api/events?${query}`, { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      client.bytes += value.length;
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";
      for (const chunk of chunks) {
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        client.events += 1;
        let payload;
        try {
          payload = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        client.lastStatus = payload.status;
        const now = performance.now();
        client.waiters = client.waiters.filter((w) => {
          if (w.predicate(payload)) {
            w.resolve(now);
            return false;
          }
          return true;
        });
      }
    }
  };
  run().catch(() => {});
  client.waitFor = (predicate, timeoutMs = 5000) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      client.waiters.push({
        predicate,
        resolve: (t) => {
          clearTimeout(timer);
          resolve(t);
        },
      });
    });
  client.close = () => controller.abort();
  return client;
}

async function main() {
  console.log(`\n=== Кайфоград · нагрузочная проба (${TOTAL_VIEWERS} подключений) ===\n`);
  const server = await startTestServer();
  const actionLatencies = [];
  try {
    await post(server.baseUrl, { type: "reset", code: "0306" });

    // 6 команд заходят и сохраняют настройку.
    const logins = [];
    for (let i = 0; i < 6; i += 1) {
      const login = await post(server.baseUrl, { type: "loginTeam", pin: String(101 + i) });
      actionLatencies.push(login.ms);
      const join = await post(server.baseUrl, {
        type: "join",
        teamId: login.body.teamId,
        token: login.body.token,
        name: `Команда ${i + 1}`,
        color: ["#4CC9F0", "#FF5FA2", "#FFE45C", "#7CFF8A", "#FF8A3D", "#9B7BFF"][i],
        captain: "Команда",
      });
      actionLatencies.push(join.ms);
      logins.push(login.body);
    }

    // 20 подключений: 1 проектор + 13 зрителей + 6 командных устройств.
    const viewers = [];
    for (let i = 0; i < 14; i += 1) viewers.push(openViewer(server.baseUrl, "view=screen"));
    for (const login of logins) {
      viewers.push(openViewer(server.baseUrl, `view=team&team=${login.teamId}&token=${encodeURIComponent(login.token)}`));
    }
    await new Promise((resolve) => setTimeout(resolve, 300)); // дать соединениям встать

    // Проигрываем 2 раунда по 2 вопроса: старт → все отвечают разом → счёт → следующий.
    const fanoutLatencies = [];
    let questionsPlayed = 0;
    for (let round = 0; round < 2; round += 1) {
      const startAction = round === 0 ? { type: "startRound", code: "0306" } : { type: "nextRound", code: "0306" };
      const waits = viewers.map((v) => v.waitFor((s) => s.status === "round_running"));
      const sent = performance.now();
      const started = await post(server.baseUrl, startAction);
      actionLatencies.push(started.ms);
      const arrivals = await Promise.all(waits);
      for (const arrival of arrivals) if (arrival != null) fanoutLatencies.push(arrival - sent);

      for (let q = 0; q < 2; q += 1) {
        // Все 6 команд отвечают в одну секунду.
        const answers = await Promise.all(
          logins.map((login, idx) =>
            post(server.baseUrl, {
              type: "submitAnswer",
              teamId: login.teamId,
              token: login.token,
              value: ["A", "B", "C", "D"][idx % 4],
              roundIndex: round === 0 ? 0 : 1,
              questionIndex: q,
            }),
          ),
        );
        for (const a of answers) actionLatencies.push(a.ms);
        const scored = await post(server.baseUrl, { type: "scoreNow", code: "0306" });
        actionLatencies.push(scored.ms);
        questionsPlayed += 1;
        const next = await post(server.baseUrl, { type: "nextQuestion", code: "0306" });
        actionLatencies.push(next.ms);
      }
    }

    // Всплеск: 240 быстрых ответов подряд (имитация нервных перекликиваний / скрипта).
    await post(server.baseUrl, { type: "reset", code: "0306" });
    const burstLogins = [];
    for (let i = 0; i < 6; i += 1) {
      const login = await post(server.baseUrl, { type: "loginTeam", pin: String(101 + i) });
      await post(server.baseUrl, {
        type: "join",
        teamId: login.body.teamId,
        token: login.body.token,
        name: `Команда ${i + 1}`,
        color: ["#4CC9F0", "#FF5FA2", "#FFE45C", "#7CFF8A", "#FF8A3D", "#9B7BFF"][i],
        captain: "Команда",
      });
      burstLogins.push(login.body);
    }
    await post(server.baseUrl, { type: "startRound", code: "0306" });
    const burstStart = performance.now();
    // 240 быстрых ответов, но не более 12 «в воздухе» одновременно — как ~2 соединения на команду.
    const burstTasks = Array.from({ length: 240 }, (_, n) => {
      const login = burstLogins[n % 6];
      return () =>
        post(server.baseUrl, {
          type: "submitAnswer",
          teamId: login.teamId,
          token: login.token,
          value: ["A", "B", "C", "D"][n % 4],
          roundIndex: 0,
          questionIndex: 0,
        });
    });
    const burstResults = await runPool(burstTasks, 12);
    const burstMs = performance.now() - burstStart;
    const burstErrors = burstResults.filter((r) => !r.ok).length;
    const burstThroughput = (burstResults.length / burstMs) * 1000;

    const totalEvents = viewers.reduce((sum, v) => sum + v.events, 0);
    const totalBytes = viewers.reduce((sum, v) => sum + v.bytes, 0);
    for (const v of viewers) v.close();

    // ── Отчёт ──
    console.log(`Подключений (SSE) одновременно : ${viewers.length}`);
    console.log(`Проиграно вопросов            : ${questionsPlayed}`);
    console.log(`Действий замерено             : ${actionLatencies.length}`);
    console.log("");
    console.log("Задержка действия (POST /api/action):");
    console.log(`  медиана p50 : ${ms(percentile(actionLatencies, 50))}`);
    console.log(`  p95         : ${ms(percentile(actionLatencies, 95))}`);
    console.log(`  максимум    : ${ms(Math.max(...actionLatencies))}`);
    console.log("");
    console.log("Доставка обновления на все 20 экранов (веерная рассылка):");
    console.log(`  медиана p50 : ${ms(percentile(fanoutLatencies, 50))}`);
    console.log(`  p95         : ${ms(percentile(fanoutLatencies, 95))}`);
    console.log(`  максимум    : ${ms(Math.max(...fanoutLatencies))}`);
    console.log("");
    console.log("Всплеск 240 ответов подряд:");
    console.log(`  всего времени : ${ms(burstMs)}`);
    console.log(`  пропускная    : ${burstThroughput.toFixed(0)} ответов/сек`);
    console.log(`  ошибок        : ${burstErrors}`);
    console.log("");
    console.log(`SSE-событий получено суммарно : ${totalEvents}`);
    console.log(`Трафик SSE суммарно           : ${(totalBytes / 1024).toFixed(0)} КБ`);
    console.log("");

    const p95 = percentile(actionLatencies, 95);
    const fanoutP95 = percentile(fanoutLatencies, 95);
    const verdict =
      burstErrors === 0 && p95 < 150 && fanoutP95 < 500
        ? "✅ ВЫДЕРЖИВАЕТ: 20 подключений обслуживаются с запасом."
        : "⚠️  ЕСТЬ РИСК: посмотрите цифры выше (задержки/ошибки выросли).";
    console.log(verdict);
    console.log("");
  } finally {
    await server.stop();
  }
}

main().catch((error) => {
  console.error("Нагрузочная проба упала:", error);
  process.exit(1);
});
