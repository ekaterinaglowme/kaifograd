import assert from "node:assert/strict";
import test from "node:test";
import { action, loginAndJoin, startTestServer, state, waitForState } from "./helpers/integration-server.js";

// Персист пишется с задержкой ~50мс после действия — даём запас, чтобы состояние
// гарантированно легло на диск перед «падением» сервера.
const PERSIST_MS = 250;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Сценарий: посреди игры контейнер упал (kill -9) и поднялся с тем же game-state.json.
// Счёт, статус, ответы и токены команд должны пережить рестарт: команды продолжают
// играть с тех же телефонов без повторного входа по PIN.
test("a hard server crash mid-game keeps score, answers and team tokens after restart", async () => {
  const first = await startTestServer();
  let second = null;
  try {
    const team1 = await loginAndJoin(first.baseUrl, "101", { name: "Живучие", color: "#FF5FA2" });
    const team2 = await loginAndJoin(first.baseUrl, "102", { name: "Стойкие", color: "#4CC9F0" });
    await action(first.baseUrl, { type: "startRound", code: "0306" });
    // Вопрос 1 разминки: правильный ответ B.
    await action(first.baseUrl, { type: "submitAnswer", teamId: 1, token: team1.token, value: "B", roundIndex: 0, questionIndex: 0 });
    await action(first.baseUrl, { type: "submitAnswer", teamId: 2, token: team2.token, value: "A", roundIndex: 0, questionIndex: 0 });
    // Закрываем вопрос — статус question_scored стабилен (серверный тик его не двигает).
    await action(first.baseUrl, { type: "scoreNow", code: "0306" });
    const before = await state(first.baseUrl);
    assert.equal(before.status, "question_scored");
    assert.equal(before.teams[0].totalScore, 1);

    await wait(PERSIST_MS); // состояние должно долететь до диска
    first.child.kill("SIGKILL"); // «выдернули питание»

    second = await startTestServer({ dir: first.dir });
    const after = await state(second.baseUrl);

    // Игра продолжилась ровно с того места.
    assert.equal(after.status, "question_scored");
    assert.equal(after.currentRoundIndex, 0);
    assert.equal(after.currentQuestionIndex, 0);
    assert.equal(after.teams[0].totalScore, 1);
    assert.equal(after.teams[0].displayName, "Живучие");
    assert.equal(after.answers["0:0"][1].value, "B");

    // Старый токен команды жив: команда отвечает на следующий вопрос без нового входа.
    await action(second.baseUrl, { type: "nextQuestion", code: "0306" });
    await waitForState(second.baseUrl, (g) => g.status === "round_running" && g.currentQuestionIndex === 1);
    await action(second.baseUrl, { type: "submitAnswer", teamId: 1, token: team1.token, value: "D", roundIndex: 0, questionIndex: 1 });
    const played = await state(second.baseUrl);
    assert.equal(played.answers["0:1"][1].value, "D");
  } finally {
    if (second) await second.stop();
    await first.stop(); // папку состояния чистит владелец
  }
});

// Сценарий: ведущая поставила игру на паузу (например, технический сбой в зале),
// и в этот момент сервер перезапустился. Пауза и оставшееся время должны сохраниться,
// а «Продолжить» — работать как ни в чём не бывало.
test("a restart while paused keeps the pause and the remaining time", async () => {
  const first = await startTestServer();
  let second = null;
  try {
    const team = await loginAndJoin(first.baseUrl, "101", { name: "НаПаузе", color: "#FF5FA2" });
    await action(first.baseUrl, { type: "startRound", code: "0306" });
    await action(first.baseUrl, { type: "togglePause", code: "0306" });
    const before = await state(first.baseUrl);
    assert.equal(before.paused, true);
    assert.ok(before.pausedRemainingMs > 0, "остаток времени зафиксирован");

    await wait(PERSIST_MS);
    first.child.kill("SIGKILL");

    second = await startTestServer({ dir: first.dir });
    const after = await state(second.baseUrl);
    assert.equal(after.paused, true);
    assert.equal(after.pausedRemainingMs, before.pausedRemainingMs);
    assert.equal(after.status, "round_running");

    // «Продолжить» после рестарта: таймер идёт дальше, команда может ответить.
    await action(second.baseUrl, { type: "togglePause", code: "0306" });
    const resumed = await state(second.baseUrl);
    assert.equal(resumed.paused, false);
    await action(second.baseUrl, { type: "submitAnswer", teamId: 1, token: team.token, value: "B", roundIndex: 0, questionIndex: 0 });
    const played = await state(second.baseUrl);
    assert.equal(played.answers["0:0"][1].value, "B");
  } finally {
    if (second) await second.stop();
    await first.stop();
  }
});
