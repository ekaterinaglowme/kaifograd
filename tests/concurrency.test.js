import assert from "node:assert/strict";
import test from "node:test";
import {
  action,
  collectSseEvents,
  loginAndJoin,
  startTestServer,
  state,
} from "./helpers/integration-server.js";

// Сценарий: все 6 команд заходят и сохраняют настройку одновременно (как в реальности,
// когда по сигналу ведущей все капитаны жмут кнопку разом). Ни одна регистрация не теряется.
test("all six teams can log in and join at the same time without losing anyone", async () => {
  const server = await startTestServer();
  try {
    await action(server.baseUrl, { type: "reset", code: "0306" });
    const colors = ["#4CC9F0", "#FF5FA2", "#FFE45C", "#7CFF8A", "#FF8A3D", "#9B7BFF"];
    await Promise.all(
      colors.map((color, index) =>
        loginAndJoin(server.baseUrl, String(101 + index), { name: `Команда ${index + 1}`, color }),
      ),
    );

    const game = await state(server.baseUrl, "view=host&code=0306");
    const ready = game.teams.filter((team) => team.ready);
    assert.equal(ready.length, 6);
    assert.deepEqual(
      ready.map((team) => team.color).sort(),
      colors.slice().sort(),
    );
  } finally {
    await server.stop();
  }
});

// Сценарий: на один и тот же вопрос все команды отвечают в одну и ту же секунду.
// Так как сервер обрабатывает действия по очереди (Node однопоточный), ни один ответ
// не затирается — все 6 ответов записаны и посчитаны.
test("six teams answering simultaneously are all recorded and scored", async () => {
  const server = await startTestServer();
  try {
    await action(server.baseUrl, { type: "reset", code: "0306" });
    const logins = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        loginAndJoin(server.baseUrl, String(101 + index), {
          name: `Команда ${index + 1}`,
          color: ["#4CC9F0", "#FF5FA2", "#FFE45C", "#7CFF8A", "#FF8A3D", "#9B7BFF"][index],
        }),
      ),
    );
    await action(server.baseUrl, { type: "startRound", code: "0306" });

    // Все отвечают верно (B) буквально одновременно.
    await Promise.all(
      logins.map((login) =>
        action(server.baseUrl, {
          type: "submitAnswer",
          teamId: login.teamId,
          token: login.token,
          value: "B",
          roundIndex: 0,
          questionIndex: 0,
        }),
      ),
    );
    await action(server.baseUrl, { type: "scoreNow", code: "0306" });

    const game = await state(server.baseUrl, "view=host&code=0306");
    assert.equal(Object.keys(game.answers["0:0"]).length, 6);
    for (const team of game.teams.filter((t) => t.ready)) {
      assert.equal(team.totalScore, 1);
    }
  } finally {
    await server.stop();
  }
});

// Сценарий: к трансляции подключено 20 устройств-наблюдателей (проектор + телефоны зрителей).
// Когда ведущая стартует раунд, обновление доходит до всех 20 подключений.
test("a start-round update fans out to twenty connected observers", async () => {
  const server = await startTestServer();
  try {
    await action(server.baseUrl, { type: "reset", code: "0306" });

    const observers = Array.from({ length: 20 }, () =>
      collectSseEvents(`${server.baseUrl}/api/events?view=screen`, { count: 2, timeoutMs: 4000 }),
    );
    // Даём подключениям встать и получить первый снимок (status: lobby).
    await new Promise((resolve) => setTimeout(resolve, 200));
    await action(server.baseUrl, { type: "startRound", code: "0306" });

    const results = await Promise.all(observers);
    assert.equal(results.length, 20);
    for (const events of results) {
      assert.ok(events.length >= 2, "каждый наблюдатель получил и снимок, и обновление");
      assert.equal(events.at(-1).status, "round_running");
    }
  } finally {
    await server.stop();
  }
});

// Сценарий: капитан быстро несколько раз меняет ответ (нервничает и перекликивает).
// Сервер не падает, а в зачёт идёт последний ответ.
test("rapid repeated answers keep the server alive and the last answer wins", async () => {
  const server = await startTestServer();
  try {
    await action(server.baseUrl, { type: "reset", code: "0306" });
    const login = await loginAndJoin(server.baseUrl, "101", { name: "Нервный капитан", color: "#FF5FA2" });
    await action(server.baseUrl, { type: "startRound", code: "0306" });

    const sequence = ["A", "C", "D", "A", "B"];
    for (const value of sequence) {
      await action(server.baseUrl, {
        type: "submitAnswer",
        teamId: login.teamId,
        token: login.token,
        value,
        roundIndex: 0,
        questionIndex: 0,
      });
    }

    const game = await state(server.baseUrl, "view=host&code=0306");
    assert.equal(game.answers["0:0"][1].value, "B");
    assert.equal(server.child.exitCode, null);
  } finally {
    await server.stop();
  }
});

// Сценарий: во время игры кто-то (ведущая) нажал «Сбросить игру». Команды, которые
// уже сидели с токеном, должны это увидеть (tokenStale), чтобы клиент вернул их на вход
// по PIN, а не завис в непонятной ошибке.
test("a reset marks previously joined team viewers as tokenStale", async () => {
  const server = await startTestServer();
  try {
    const login = await loginAndJoin(server.baseUrl, "101", { name: "До сброса", color: "#FF5FA2" });
    await action(server.baseUrl, { type: "startRound", code: "0306" });

    const before = await state(server.baseUrl, `view=team&team=1&token=${encodeURIComponent(login.token)}`);
    assert.equal(before.viewer.tokenStale, false);

    await action(server.baseUrl, { type: "reset", code: "0306" });

    const after = await state(server.baseUrl, `view=team&team=1&token=${encodeURIComponent(login.token)}`);
    assert.equal(after.viewer.tokenStale, true);
    assert.equal(after.status, "lobby");
  } finally {
    await server.stop();
  }
});
