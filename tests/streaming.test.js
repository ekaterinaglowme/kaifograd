import assert from "node:assert/strict";
import test from "node:test";
import { action, collectSseEvents, loginAndJoin, startTestServer, state } from "./helpers/integration-server.js";

const WARMUP_PROMPT = "Работает у меня на компьютере"; // кусок текста первого вопроса

// Сценарий: при загрузке страницы клиент один раз забирает полный снимок — в нём есть
// тексты вопросов (контент). Это «запрос №1».
test("the full /api/state snapshot carries question texts for the observer", async () => {
  const server = await startTestServer();
  try {
    const game = await state(server.baseUrl, "view=screen");
    assert.ok(Array.isArray(game.rounds), "снимок несёт список раундов с вопросами");
    assert.match(JSON.stringify(game.rounds), new RegExp(WARMUP_PROMPT));
  } finally {
    await server.stop();
  }
});

// Сценарий: дальше по стриму приходят только статусы — без текстов вопросов. Первый кадр
// стрима — полный (бутстрап контента), а обновления после действий уже лёгкие.
test("the SSE stream sends a lean update without question texts after an action", async () => {
  const server = await startTestServer();
  try {
    await action(server.baseUrl, { type: "reset", code: "0306" });
    const eventsPromise = collectSseEvents(`${server.baseUrl}/api/events?view=screen`, { count: 2, timeoutMs: 4000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await action(server.baseUrl, { type: "startRound", code: "0306" });

    const events = await eventsPromise;
    assert.ok(events.length >= 2, "получили и первый снимок, и обновление");
    const bootstrap = events[0];
    const update = events.at(-1);

    // Первый кадр — полный, с текстами вопросов.
    assert.ok(Array.isArray(bootstrap.rounds));
    assert.match(JSON.stringify(bootstrap), new RegExp(WARMUP_PROMPT));

    // Обновление — лёгкое: несёт статус, но не тексты вопросов.
    assert.equal(update.status, "round_running");
    assert.equal(update.rounds, undefined);
    assert.doesNotMatch(JSON.stringify(update), new RegExp(WARMUP_PROMPT));
  } finally {
    await server.stop();
  }
});

// Сценарий: лёгкое обновление заметно меньше полного снимка — ради этого и разделяли,
// чтобы на вайфае не гонять по 12 КБ на каждое действие каждому телефону.
test("a lean stream update is much smaller than the full snapshot", async () => {
  const server = await startTestServer();
  try {
    await action(server.baseUrl, { type: "reset", code: "0306" });
    const eventsPromise = collectSseEvents(`${server.baseUrl}/api/events?view=screen`, { count: 2, timeoutMs: 4000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await action(server.baseUrl, { type: "startRound", code: "0306" });
    const events = await eventsPromise;

    const fullBytes = Buffer.byteLength(JSON.stringify(events[0]));
    const leanBytes = Buffer.byteLength(JSON.stringify(events.at(-1)));
    assert.ok(leanBytes < fullBytes / 2, `лёгкое обновление (${leanBytes}Б) меньше половины снимка (${fullBytes}Б)`);
  } finally {
    await server.stop();
  }
});

// Сценарий: правильные ответы кино-раунда всё равно должны доехать до зрителя по лёгкому
// стриму — но только текущего слайда, в отдельном поле reveals, без «правильного» варианта.
test("reveal answers reach the observer through the lean stream during film review", async () => {
  const server = await startTestServer();
  try {
    await loginAndJoin(server.baseUrl, "101", { name: "Киноманы", color: "#FF5FA2" });
    await action(server.baseUrl, { type: "nextRound", code: "0306" });
    await action(server.baseUrl, { type: "nextRound", code: "0306" }); // раунд «Угадай фильм»
    for (let i = 0; i < 7; i += 1) await action(server.baseUrl, { type: "nextQuestion", code: "0306" }); // → round_review

    const game = await state(server.baseUrl, "view=screen");
    assert.equal(game.status, "round_review");
    // Ответ текущего слайда пришёл через reveals, а не внутри текста вопроса.
    const key = `${game.currentRoundIndex}:${game.currentReviewIndex || 0}`;
    assert.ok(game.reveals[key], "reveals содержит ответ текущего слайда");
    assert.ok(game.reveals[key].revealImage, "у слайда есть картинка-раскрытие");
    // «Правильный» вариант и матчинг наружу не утекают.
    assert.doesNotMatch(JSON.stringify(game.reveals), /"acceptedAnswers"|"correct"/);
  } finally {
    await server.stop();
  }
});
