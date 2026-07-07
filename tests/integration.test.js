import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  action,
  actionMayFail,
  collectSseEvents,
  loginAndJoin,
  startTestServer,
  state,
  waitForState,
} from "./helpers/integration-server.js";

test("server uses an isolated temporary game-state file", async () => {
  const server = await startTestServer();
  try {
    await action(server.baseUrl, { type: "reset", code: "0306" });
    await loginAndJoin(server.baseUrl, "101", { name: "Temp State", color: "#FF5FA2" });
    await new Promise((resolve) => setTimeout(resolve, 120));

    const persisted = JSON.parse(await readFile(server.stateFile, "utf8"));
    assert.equal(persisted.teams[0].displayName, "Temp State");
    assert.match(server.stateFile, /kaifograd-test-/);
  } finally {
    await server.stop();
  }
});

test("team PINs 101-106 identify teams and invalid PIN is rejected", async () => {
  const server = await startTestServer();
  try {
    for (let teamId = 1; teamId <= 6; teamId += 1) {
      const result = await action(server.baseUrl, { type: "loginTeam", pin: String(100 + teamId) });
      assert.equal(result.teamId, teamId);
      assert.ok(result.token);
    }

    const invalid = await actionMayFail(server.baseUrl, { type: "loginTeam", pin: "999" });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.body.error, "Неверный PIN команды");
  } finally {
    await server.stop();
  }
});

test("team setup can be updated before start but not after start", async () => {
  const server = await startTestServer();
  try {
    const login = await action(server.baseUrl, { type: "loginTeam", pin: "101" });
    await action(server.baseUrl, {
      type: "join",
      teamId: 1,
      token: login.token,
      name: "Первое имя",
      color: "#FF5FA2",
      captain: "Команда",
    });
    await action(server.baseUrl, {
      type: "join",
      teamId: 1,
      token: login.token,
      name: "Новое имя",
      color: "#4CC9F0",
      captain: "Команда",
    });

    let game = await state(server.baseUrl, `view=team&team=1&token=${encodeURIComponent(login.token)}`);
    assert.equal(game.teams[0].displayName, "Новое имя");
    assert.equal(game.teams[0].color, "#4CC9F0");

    await action(server.baseUrl, { type: "startRound", code: "0306" });
    const late = await actionMayFail(server.baseUrl, {
      type: "join",
      teamId: 1,
      token: login.token,
      name: "Поздно",
      color: "#FFE45C",
      captain: "Команда",
    });

    assert.equal(late.ok, false);
    assert.match(late.body.error, /до начала игры/);
  } finally {
    await server.stop();
  }
});

test("answers require saved setup and then score normally", async () => {
  const server = await startTestServer();
  try {
    const login = await action(server.baseUrl, { type: "loginTeam", pin: "101" });
    await action(server.baseUrl, { type: "startRound", code: "0306" });

    const unreadyAnswer = await actionMayFail(server.baseUrl, {
      type: "submitAnswer",
      teamId: 1,
      token: login.token,
      value: "B",
    });
    assert.equal(unreadyAnswer.ok, false);
    assert.equal(unreadyAnswer.body.error, "Сначала сохраните название команды");

    await action(server.baseUrl, { type: "reset", code: "0306" });
    const readyLogin = await loginAndJoin(server.baseUrl, "101", { name: "Готовые", color: "#FF5FA2" });
    await action(server.baseUrl, { type: "startRound", code: "0306" });
    await action(server.baseUrl, { type: "submitAnswer", teamId: 1, token: readyLogin.token, value: "B" });
    await action(server.baseUrl, { type: "scoreNow", code: "0306" });

    const game = await state(server.baseUrl, "view=host&code=0306");
    assert.equal(game.answers["0:0"][1].value, "B");
    assert.equal(game.teams[0].totalScore, 1);
  } finally {
    await server.stop();
  }
});

test("viewer privacy hides answers from teams and observer but shows them to host", async () => {
  const server = await startTestServer();
  try {
    const team1 = await loginAndJoin(server.baseUrl, "101", { name: "Первая", color: "#FF5FA2" });
    const team2 = await loginAndJoin(server.baseUrl, "102", { name: "Вторая", color: "#4CC9F0" });
    await action(server.baseUrl, { type: "startRound", code: "0306" });
    await action(server.baseUrl, { type: "submitAnswer", teamId: 1, token: team1.token, value: "B" });
    await action(server.baseUrl, { type: "submitAnswer", teamId: 2, token: team2.token, value: "A" });

    const host = await state(server.baseUrl, "view=host&code=0306");
    const firstTeam = await state(server.baseUrl, `view=team&team=1&token=${encodeURIComponent(team1.token)}`);
    const observer = await state(server.baseUrl, "view=screen");

    assert.equal(host.answers["0:0"][1].value, "B");
    assert.equal(host.answers["0:0"][2].value, "A");
    assert.equal(firstTeam.answers["0:0"][1].value, "B");
    assert.equal(firstTeam.answers["0:0"][2], undefined);
    assert.deepEqual(observer.answers, {});
    assert.equal("token" in host.teams[0], false);
  } finally {
    await server.stop();
  }
});

test("SSE broadcasts updates to host and team viewers", async () => {
  const server = await startTestServer();
  try {
    const team1 = await loginAndJoin(server.baseUrl, "101", { name: "SSE", color: "#FF5FA2" });
    await action(server.baseUrl, { type: "startRound", code: "0306" });

    const hostEventsPromise = collectSseEvents(`${server.baseUrl}/api/events?view=host&code=0306`, { count: 2 });
    const teamEventsPromise = collectSseEvents(
      `${server.baseUrl}/api/events?view=team&team=1&token=${encodeURIComponent(team1.token)}`,
      { count: 2 },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await action(server.baseUrl, { type: "submitAnswer", teamId: 1, token: team1.token, value: "B" });

    const hostEvents = await hostEventsPromise;
    const teamEvents = await teamEventsPromise;

    assert.ok(hostEvents.length >= 2);
    assert.ok(teamEvents.length >= 2);
    assert.equal(hostEvents.at(-1).answers["0:0"][1].value, "B");
    assert.equal(teamEvents.at(-1).answers["0:0"][1].value, "B");
  } finally {
    await server.stop();
  }
});

test("round results are host-controlled with countdown, hide, and next round", async () => {
  const server = await startTestServer();
  try {
    await loginAndJoin(server.baseUrl, "101", { name: "Раунд", color: "#FF5FA2" });
    await action(server.baseUrl, { type: "startRound", code: "0306" });
    for (let i = 0; i < 7; i += 1) await action(server.baseUrl, { type: "nextQuestion", code: "0306" });

    let game = await state(server.baseUrl);
    assert.equal(game.status, "round_over");

    await action(server.baseUrl, { type: "finishRound", code: "0306" });
    game = await state(server.baseUrl);
    assert.equal(game.status, "round_countdown");
    assert.equal(game.roundCountdown, 3);

    game = await waitForState(server.baseUrl, (next) => next.status === "round_results");
    assert.equal(game.roundResults.length, 1);

    await action(server.baseUrl, { type: "hideRoundResults", code: "0306" });
    game = await state(server.baseUrl);
    assert.equal(game.status, "round_over");

    await action(server.baseUrl, { type: "finishRound", code: "0306" });
    await waitForState(server.baseUrl, (next) => next.status === "round_results");
    await action(server.baseUrl, { type: "nextRound", code: "0306" });
    game = await state(server.baseUrl);
    assert.equal(game.currentRoundIndex, 1);
    assert.equal(game.status, "round_running");
  } finally {
    await server.stop();
  }
});

test("film round shows seven answer reveal slides before round results", async () => {
  const server = await startTestServer();
  try {
    await loginAndJoin(server.baseUrl, "101", { name: "Киноманы", color: "#FF5FA2" });
    await action(server.baseUrl, { type: "nextRound", code: "0306" });
    await action(server.baseUrl, { type: "nextRound", code: "0306" });

    let game = await state(server.baseUrl);
    assert.equal(game.currentRoundIndex, 2);
    assert.equal(game.status, "round_running");
    assert.equal(game.rounds[2].questions[0].image, "assets/film-1-blur.png");

    for (let i = 0; i < 7; i += 1) await action(server.baseUrl, { type: "nextQuestion", code: "0306" });
    game = await state(server.baseUrl);
    assert.equal(game.status, "round_review");
    assert.equal(game.currentReviewIndex, 0);
    assert.equal(game.rounds[2].questions[0].revealImage, "assets/film-1-original.png");

    for (let i = 0; i < 6; i += 1) await action(server.baseUrl, { type: "nextQuestion", code: "0306" });
    game = await state(server.baseUrl);
    assert.equal(game.status, "round_review");
    assert.equal(game.currentReviewIndex, 6);

    await action(server.baseUrl, { type: "nextQuestion", code: "0306" });
    game = await state(server.baseUrl);
    assert.equal(game.status, "round_over");

    await action(server.baseUrl, { type: "finishRound", code: "0306" });
    game = await state(server.baseUrl);
    assert.equal(game.status, "round_countdown");
  } finally {
    await server.stop();
  }
});

test("manual island round winner can be awarded by team PIN", async () => {
  const server = await startTestServer();
  try {
    await loginAndJoin(server.baseUrl, "101", { name: "Первые", color: "#FF5FA2" });
    await loginAndJoin(server.baseUrl, "102", { name: "Шарики", color: "#4CC9F0" });
    for (let i = 0; i < 3; i += 1) await action(server.baseUrl, { type: "nextRound", code: "0306" });

    let game = await state(server.baseUrl);
    assert.equal(game.currentRoundIndex, 3);
    assert.equal(game.rounds[3].manual, true);

    await action(server.baseUrl, { type: "awardManualWinnerByPin", code: "0306", pin: "102" });
    game = await state(server.baseUrl);
    assert.equal(game.teams[1].roundScore, 1);
    assert.equal(game.teams[1].totalScore, 1);
    assert.equal(game.manualWinnerTeamId, 2);

    await action(server.baseUrl, { type: "finishRound", code: "0306" });
    game = await waitForState(server.baseUrl, (next) => next.status === "round_results");
    assert.equal(game.roundResults.at(-1).winners[0].teamId, 2);
  } finally {
    await server.stop();
  }
});

test("final reveal reaches podium after the last round", async () => {
  const server = await startTestServer();
  try {
    await loginAndJoin(server.baseUrl, "101", { name: "Финалисты", color: "#FF5FA2" });
    for (let i = 0; i < 7; i += 1) await action(server.baseUrl, { type: "nextRound", code: "0306" });

    let game = await state(server.baseUrl);
    assert.equal(game.currentRoundIndex, 7);

    await action(server.baseUrl, { type: "finalReveal", code: "0306" });
    game = await state(server.baseUrl);
    assert.equal(game.finalReveal, "countdown");
    assert.equal(game.finalCountdown, 3);

    game = await waitForState(server.baseUrl, (next) => next.finalReveal === "podium");
    assert.equal(game.finalReveal, "podium");
  } finally {
    await server.stop();
  }
});
