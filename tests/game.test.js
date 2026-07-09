import test from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  registerTeam,
  submitAnswer,
  scoreCurrentQuestion,
  startRound,
  advanceAfterQuestionScore,
  closeRound,
  getFinalPodium,
  getTeamView,
  getQuestionDurationMs,
  ensureCurrentRoundStarted,
  recountQuestion,
  adjustScore,
  serializeForViewer,
  serializeLive,
  TEAM_PINS,
  teamIdForPin,
  updateTeamSetup,
  MAX_TEXT_LEN,
} from "../src/game.js";
import { fullRounds } from "../src/rounds.js";

test("team slots work before real names are known", () => {
  const game = createGame({ teamCount: 3 });

  assert.equal(game.teams[0].displayName, "Команда 1");
  assert.equal(game.teams[1].displayName, "Команда 2");

  registerTeam(game, 2, { name: "Ctrl+Z", color: "#FF5FA2", captain: "Катя" });

  assert.equal(game.teams[1].displayName, "Ctrl+Z");
  assert.equal(game.teams[1].color, "#FF5FA2");
  assert.equal(game.teams[0].displayName, "Команда 1");
});

test("team pins identify fixed team slots", () => {
  assert.equal(TEAM_PINS[1], "101");
  assert.equal(TEAM_PINS[6], "106");
  assert.equal(teamIdForPin("101"), 1);
  assert.equal(teamIdForPin(" 106 "), 6);
  assert.equal(teamIdForPin("999"), null);
});

test("unclaimed team default colors do not block captain color choice", () => {
  const game = createGame({ teamCount: 3 });

  registerTeam(game, 1, { name: "Розовые", color: "#FF5FA2", captain: "Катя" });

  assert.equal(game.teams[0].color, "#FF5FA2");
  assert.equal(game.teams[0].displayName, "Розовые");
});

test("registered teams stay in lobby until the host starts the game", () => {
  const game = createGame({ teamCount: 2 });
  const now = new Date("2026-07-06T20:00:00.000Z").getTime();
  registerTeam(game, 1, { name: "Без ожидания", color: "#FF5FA2", captain: "Катя" });

  const status = ensureCurrentRoundStarted(game, { now });

  assert.equal(status, "lobby");
  assert.equal(game.status, "lobby");
  assert.equal(game.questionStartedAt, null);
});

test("captain can update team setup only before the game starts", () => {
  const game = createGame({ teamCount: 2 });
  registerTeam(game, 1, { name: "Старое имя", color: "#4CC9F0", captain: "Команда" });

  updateTeamSetup(game, 1, { name: "Новое имя", color: "#FF5FA2", captain: "Команда" });

  assert.equal(game.teams[0].displayName, "Новое имя");
  assert.equal(game.teams[0].color, "#FF5FA2");

  startRound(game);
  assert.throws(
    () => updateTeamSetup(game, 1, { name: "Поздно", color: "#FFE45C", captain: "Команда" }),
    /до начала игры/,
  );
});

test("auto-start does not restart a running round", () => {
  const game = createGame({ teamCount: 2 });
  startRound(game, { now: 1000 });

  const status = ensureCurrentRoundStarted(game, { now: 2000 });

  assert.equal(status, "round_running");
  assert.equal(game.questionStartedAt, 1000);
});

test("captain view never exposes other teams answers", () => {
  const game = createGame({ teamCount: 2 });
  submitAnswer(game, 1, "A");
  submitAnswer(game, 2, "B");

  const teamView = getTeamView(game, 1);

  assert.equal(teamView.ownAnswer.value, "A");
  assert.equal(teamView.otherAnswersVisible, false);
  assert.equal("answers" in teamView, false);
});

test("choice questions score automatically", () => {
  const game = createGame({ teamCount: 3 });
  submitAnswer(game, 1, "B");
  submitAnswer(game, 2, "A");
  submitAnswer(game, 3, "B");

  const result = scoreCurrentQuestion(game);

  assert.deepEqual(result.correctTeamIds, [1, 3]);
  assert.equal(game.teams[0].roundScore, 1);
  assert.equal(game.teams[1].roundScore, 0);
  assert.equal(game.teams[2].roundScore, 1);
});

test("scoring the same question twice does not duplicate points", () => {
  const game = createGame({ teamCount: 2 });
  submitAnswer(game, 1, "B");

  scoreCurrentQuestion(game);
  scoreCurrentQuestion(game);

  assert.equal(game.teams[0].roundScore, 1);
  assert.equal(game.teams[0].totalScore, 1);
});

test("number questions award nearest and second nearest", () => {
  const game = createGame({ teamCount: 4 });
  game.currentRoundIndex = 1;
  game.currentQuestionIndex = 0;
  submitAnswer(game, 1, 4200);
  submitAnswer(game, 2, 9000);
  submitAnswer(game, 3, 4700);
  submitAnswer(game, 4, 3000);

  const result = scoreCurrentQuestion(game);

  assert.equal(result.ranked[0].teamId, 3);
  assert.equal(result.ranked[0].points, 2);
  assert.equal(result.ranked[1].teamId, 1);
  assert.equal(result.ranked[1].points, 1);
  assert.equal(game.teams[2].roundScore, 2);
  assert.equal(game.teams[0].roundScore, 1);
});

test("text questions score automatically from accepted answer variants", () => {
  const game = createGame({ teamCount: 3 });
  game.currentRoundIndex = 2;
  game.rounds[2].questions = [{ type: "text", prompt: "Где Нео?", answer: "Матрица / The Matrix" }];
  submitAnswer(game, 1, "матрица");
  submitAnswer(game, 2, "The Matrix");
  submitAnswer(game, 3, "Хогвартс");

  const result = scoreCurrentQuestion(game);

  assert.deepEqual(result.correctTeamIds, [1, 2]);
  assert.equal(game.teams[0].totalScore, 1);
  assert.equal(game.teams[1].totalScore, 1);
  assert.equal(game.teams[2].totalScore, 0);
});

test("round autopilot advances from scored question to next question", () => {
  const game = createGame({ teamCount: 2 });
  startRound(game);
  submitAnswer(game, 1, "B");
  scoreCurrentQuestion(game);

  const state = advanceAfterQuestionScore(game);

  assert.equal(state, "round_running");
  assert.equal(game.currentRoundIndex, 0);
  assert.equal(game.currentQuestionIndex, 1);
  assert.equal(game.status, "round_running");
});

test("round autopilot closes the round after the last question", () => {
  const game = createGame({ teamCount: 2 });
  game.rounds[0].questions = game.rounds[0].questions.slice(0, 1);
  registerTeam(game, 1, { name: "Тест", color: "#4CC9F0" });
  startRound(game);
  submitAnswer(game, 1, "B");
  scoreCurrentQuestion(game);

  const state = advanceAfterQuestionScore(game);

  assert.equal(state, "round_results");
  assert.equal(game.status, "round_results");
  assert.equal(game.roundResults[0].roundScores[0].score, 1);
  assert.equal(game.roundResults[0].winners[0].teamName, "Тест");
});

test("round winner receives the round resource in team color", () => {
  const game = createGame({ teamCount: 2 });
  registerTeam(game, 1, { name: "404", color: "#4CC9F0" });
  game.teams[0].roundScore = 4;
  game.teams[1].roundScore = 2;

  const result = closeRound(game);

  assert.equal(result.winners[0].teamId, 1);
  assert.equal(result.resource.name, "Технологии");
  assert.equal(game.cityResources[0].teamName, "404");
  assert.equal(game.cityResources[0].color, "#4CC9F0");
});

test("question duration comes from the current round", () => {
  const game = createGame({ teamCount: 2 });
  game.rounds[0].durationMs = 30000;
  game.rounds[1].durationMs = 45000;

  game.currentRoundIndex = 0;
  assert.equal(getQuestionDurationMs(game), 30000);

  game.currentRoundIndex = 1;
  assert.equal(getQuestionDurationMs(game), 45000);
});

test("question duration falls back to the game default when the round has none", () => {
  const game = createGame({ teamCount: 2 });
  delete game.rounds[0].durationMs;
  game.currentRoundIndex = 0;

  assert.equal(getQuestionDurationMs(game), game.questionDurationMs);
});

test("answer windows match the event timing plan", () => {
  assert.equal(fullRounds[0].durationMs, 20000, "Разминка");
  for (const i of [1, 2, 4, 5, 7]) {
    assert.equal(fullRounds[i].durationMs, 45000, fullRounds[i].title);
  }
  assert.equal(fullRounds[6].durationMs, 30000, "Угадай песню");
  assert.equal(fullRounds[3].durationMs, 60000, "Мячи: 60 сек на попытку");
  assert.equal(fullRounds[3].manual, true, "Мячи — ручной раунд (теперь раунд 4)");
});

test("round 4 is the manual island round and round 8 is history bug", () => {
  assert.equal(fullRounds[3].title, "Кайфуй и работай");
  assert.equal(fullRounds[3].manual, true);
  assert.equal(fullRounds[7].title, "Баг в истории");
});

test("warmup second question marks one runaway option", () => {
  assert.equal(fullRounds[0].questions[1].runawayOption, "D");
  assert.equal(fullRounds[0].questions[1].runawayDelayMs, 15000);
});

test("recount rolls back a choice question so it can be scored again", () => {
  const game = createGame({ teamCount: 2 });
  submitAnswer(game, 1, "B");
  scoreCurrentQuestion(game);
  assert.equal(game.teams[0].totalScore, 1);

  recountQuestion(game);

  assert.equal(game.teams[0].totalScore, 0);
  assert.equal(game.teams[0].roundScore, 0);
  assert.equal(game.questionScores["0:0"], undefined);

  const result = scoreCurrentQuestion(game);
  assert.deepEqual(result.correctTeamIds, [1]);
  assert.equal(game.teams[0].totalScore, 1);
});

test("recount rolls back number-question points for every team", () => {
  const game = createGame({ teamCount: 2 });
  game.currentRoundIndex = 1;
  submitAnswer(game, 1, 4400);
  submitAnswer(game, 2, 9000);
  scoreCurrentQuestion(game);
  assert.equal(game.teams[0].totalScore, 2);
  assert.equal(game.teams[1].totalScore, 1);

  recountQuestion(game);

  assert.equal(game.teams[0].totalScore, 0);
  assert.equal(game.teams[1].totalScore, 0);
});

test("adjust score changes round and total by a delta", () => {
  const game = createGame({ teamCount: 2 });

  adjustScore(game, 1, 3);
  assert.equal(game.teams[0].roundScore, 3);
  assert.equal(game.teams[0].totalScore, 3);

  adjustScore(game, 1, -1);
  assert.equal(game.teams[0].roundScore, 2);
  assert.equal(game.teams[0].totalScore, 2);
});

test("adjust score never pushes a team below zero", () => {
  const game = createGame({ teamCount: 2 });

  adjustScore(game, 1, -5);

  assert.equal(game.teams[0].roundScore, 0);
  assert.equal(game.teams[0].totalScore, 0);
});

test("a team name longer than 150 characters is capped to 150", () => {
  const game = createGame({ teamCount: 2 });
  registerTeam(game, 1, { name: "Я".repeat(400), color: "#FF5FA2", captain: "К".repeat(400) });
  assert.equal(game.teams[0].displayName.length, MAX_TEXT_LEN);
  assert.equal(game.teams[0].captain.length, MAX_TEXT_LEN);
});

test("a text answer longer than 150 characters is stored capped to 150", () => {
  const game = createGame({ teamCount: 2 });
  startRound(game);
  const stored = submitAnswer(game, 1, "ответ ".repeat(200));
  assert.equal(stored.value.length, MAX_TEXT_LEN);
});

test("a song answer keeps only artist and title, each capped to 150", () => {
  const game = createGame({ teamCount: 2 });
  startRound(game);
  const stored = submitAnswer(game, 1, { artist: "и".repeat(300), title: "т".repeat(300), evil: "x".repeat(99999) });
  assert.equal(stored.value.artist.length, MAX_TEXT_LEN);
  assert.equal(stored.value.title.length, MAX_TEXT_LEN);
  assert.equal("evil" in stored.value, false);
});

test("song questions score artist and title fields separately", () => {
  const game = createGame({ teamCount: 3 });
  game.rounds[0].questions = [
    {
      type: "song",
      prompt: "Угадай песню",
      artist: "Pixies",
      title: "Where Is My Mind?",
      artistAccepted: ["pixies"],
      titleAccepted: ["where is my mind"],
    },
  ];
  submitAnswer(game, 1, { artist: "Pixies", title: "Where is my mind" });
  submitAnswer(game, 2, { artist: "pixies", title: "не знаю" });
  submitAnswer(game, 3, { artist: "нет", title: "нет" });

  const result = scoreCurrentQuestion(game);

  assert.equal(game.teams[0].roundScore, 2);
  assert.equal(game.teams[1].roundScore, 1);
  assert.equal(game.teams[2].roundScore, 0);
  assert.deepEqual(result.correctTeamIds.slice().sort(), [1, 2]);
});

test("text answers tolerate small typos via Levenshtein distance", () => {
  const game = createGame({ teamCount: 4 });
  game.currentRoundIndex = 2;
  game.rounds[2].questions = [{ type: "text", prompt: "Что за место?", answer: "Матрица / The Matrix" }];
  submitAnswer(game, 1, "матриса");
  submitAnswer(game, 2, "the matrx");
  submitAnswer(game, 3, "корабль");
  submitAnswer(game, 4, "Матрица");

  const result = scoreCurrentQuestion(game);

  assert.deepEqual(result.correctTeamIds.slice().sort(), [1, 2, 4]);
  assert.equal(game.teams[2].totalScore, 0);
});

test("serializeForViewer hides correct answers from non-host viewers", () => {
  const game = createGame({ teamCount: 2 });
  game.rounds[0].questions = [
    { type: "choice", prompt: "?", options: ["A", "B"], correct: "B" },
    { type: "text", prompt: "?", answer: "Матрица", acceptedAnswers: ["матрица"] },
  ];
  registerTeam(game, 1, { name: "X", color: "#4CC9F0" });
  game.teams[0].token = "t1";

  const teamView = serializeForViewer(game, { teamId: 1, teamToken: "t1" });
  assert.equal(teamView.rounds[0].questions[0].correct, undefined);
  assert.deepEqual(teamView.rounds[0].questions[0].options, ["A", "B"]);
  assert.equal(teamView.rounds[0].questions[1].answer, undefined);
  assert.equal(teamView.rounds[0].questions[1].acceptedAnswers, undefined);

  const screenView = serializeForViewer(game, {});
  assert.equal(screenView.rounds[0].questions[0].correct, undefined);

  const hostView = serializeForViewer(game, { seeAllAnswers: true });
  assert.equal(hostView.rounds[0].questions[0].correct, "B");
  assert.equal(hostView.rounds[0].questions[1].answer, "Матрица");
});

test("serializeForViewer hides other teams answers from a team viewer", () => {
  const game = createGame({ teamCount: 3 });
  submitAnswer(game, 1, "A");
  submitAnswer(game, 2, "B");

  const teamView = serializeForViewer(game, { teamId: 2 });
  assert.equal(teamView.answers["0:0"][2].value, "B");
  assert.equal(teamView.answers["0:0"][1], undefined);

  const hostView = serializeForViewer(game, { seeAllAnswers: true });
  assert.equal(hostView.answers["0:0"][1].value, "A");
  assert.equal(hostView.answers["0:0"][2].value, "B");

  const screenView = serializeForViewer(game, {});
  assert.deepEqual(screenView.answers, {});
});

test("serializeForViewer never exposes team tokens", () => {
  const game = createGame({ teamCount: 2 });
  game.teams[0].token = "secret-team-token";

  const hostView = serializeForViewer(game, { seeAllAnswers: true });
  const teamView = serializeForViewer(game, { teamId: 1, teamToken: "secret-team-token" });

  assert.equal("token" in hostView.teams[0], false);
  assert.equal("token" in teamView.teams[0], false);
});

test("serializeForViewer marks occupied teams as locked without the team token", () => {
  const game = createGame({ teamCount: 2 });
  registerTeam(game, 1, { name: "Закрытая", color: "#FF5FA2" });
  game.teams[0].token = "team-token";
  submitAnswer(game, 1, "B");

  const lockedView = serializeForViewer(game, { teamId: 1 });
  const unlockedView = serializeForViewer(game, { teamId: 1, teamToken: "team-token" });

  assert.equal(lockedView.viewer.teamAccess, false);
  assert.deepEqual(lockedView.answers, {});
  assert.equal(unlockedView.viewer.teamAccess, true);
  assert.equal(unlockedView.answers["0:0"][1].value, "B");
});

test("serializeForViewer flags a stale team token after the game is reset", () => {
  const game = createGame({ teamCount: 2 });
  registerTeam(game, 1, { name: "Была", color: "#FF5FA2" });
  game.teams[0].token = "old-token";

  // Reset забывает токены: команда снова не готова и без токена, но клиент держит старый.
  game.teams[0].ready = false;
  game.teams[0].token = "";

  const staleView = serializeForViewer(game, { teamId: 1, teamToken: "old-token" });
  assert.equal(staleView.viewer.tokenStale, true);

  // Без токена (свежий клиент) — не stale, просто идёт на PIN-гейт обычным путём.
  const freshView = serializeForViewer(game, { teamId: 1, teamToken: "" });
  assert.equal(freshView.viewer.tokenStale, false);

  // Совпадающий токен — не stale.
  const active = createGame({ teamCount: 2 });
  registerTeam(active, 1, { name: "Ок", color: "#FF5FA2" });
  active.teams[0].token = "t";
  assert.equal(serializeForViewer(active, { teamId: 1, teamToken: "t" }).viewer.tokenStale, false);

  // Ведущая (seeAllAnswers) — никогда не stale.
  assert.equal(serializeForViewer(game, { seeAllAnswers: true }).viewer.tokenStale, false);
});

test("serializeForViewer reveals round answers on results only for revealAnswers rounds", () => {
  const game = createGame({ teamCount: 2 });
  game.status = "round_results";
  game.currentRoundIndex = 0;
  game.rounds[0].revealAnswers = true;
  game.rounds[0].questions = [
    { type: "song", artist: "Pixies", title: "Where Is My Mind?", artistAccepted: ["pixies"], titleAccepted: ["where is my mind"] },
    { type: "text", answer: "Чипи чапа", acceptedAnswers: ["чипи чапа"] },
  ];
  game.rounds[1].revealAnswers = false;
  game.rounds[1].questions = [{ type: "text", answer: "Секрет" }];

  const teamView = serializeForViewer(game, { teamId: 1 });
  // Сами тексты вопросов чистые — без ответов и вариантов матчинга.
  const song = teamView.rounds[0].questions[0];
  assert.equal("artist" in song, false);
  assert.equal("title" in song, false);
  assert.equal("artistAccepted" in song, false);
  assert.equal("answer" in teamView.rounds[0].questions[1], false);
  // Правильные ответы этого раунда приходят отдельным полем reveals.
  assert.equal(teamView.reveals["0:0"].artist, "Pixies");
  assert.equal(teamView.reveals["0:0"].title, "Where Is My Mind?");
  assert.equal("artistAccepted" in teamView.reveals["0:0"], false);
  assert.equal(teamView.reveals["0:1"].answer, "Чипи чапа");
  // Раунд без revealAnswers — его ответов в reveals нет.
  assert.equal("1:0" in teamView.reveals, false);

  // До итогов (round_running) reveals пуст даже у revealAnswers-раунда.
  game.status = "round_running";
  const running = serializeForViewer(game, { teamId: 1 });
  assert.deepEqual(running.reveals, {});
});

test("serializeLive omits question texts but keeps dynamic state and reveals", () => {
  const game = createGame({ teamCount: 2 });
  game.status = "round_results";
  game.currentRoundIndex = 0;
  game.rounds[0].revealAnswers = true;
  game.rounds[0].questions = [{ type: "text", answer: "Ответ", acceptedAnswers: ["ответ"] }];

  const live = serializeLive(game, { teamId: 1 });
  // Тексты вопросов в лёгкое обновление не попадают.
  assert.equal(live.rounds, undefined);
  // Динамика на месте.
  assert.equal(live.status, "round_results");
  assert.ok(Array.isArray(live.teams));
  assert.ok(live.viewer);
  // Правильный ответ раунда приходит отдельным полем reveals, без матчинга.
  assert.equal(live.reveals["0:0"].answer, "Ответ");
  assert.doesNotMatch(JSON.stringify(live.reveals), /"acceptedAnswers"|"correct"/);

  // У ведущей лёгкое обновление тоже без текстов вопросов.
  const hostLive = serializeLive(game, { seeAllAnswers: true });
  assert.equal(hostLive.rounds, undefined);
});

test("serializeForViewer returns a copy, not the live game", () => {
  const game = createGame({ teamCount: 2 });

  const copy = serializeForViewer(game, { seeAllAnswers: true });
  copy.teams[0].totalScore = 99;

  assert.equal(game.teams[0].totalScore, 0);
});

test("final podium reveals third, second, first without mutating scores", () => {
  const game = createGame({ teamCount: 4 });
  game.teams[0].totalScore = 8;
  game.teams[1].totalScore = 12;
  game.teams[2].totalScore = 10;
  game.teams[3].totalScore = 3;

  const podium = getFinalPodium(game);

  assert.deepEqual(
    podium.map((p) => [p.place, p.teamId, p.totalScore]),
    [
      [3, 1, 8],
      [2, 3, 10],
      [1, 2, 12],
    ],
  );
});

test("closeRound grants no winner on an all-zero round", () => {
  const game = createGame({ teamCount: 3 });

  const result = closeRound(game);

  assert.equal(result.winners.length, 0);
  assert.equal(game.cityResources.length, 0);
});

test("closeRound grants the resource to every team tied at the top score", () => {
  const game = createGame({ teamCount: 3 });
  game.teams[0].roundScore = 2;
  game.teams[1].roundScore = 2;
  game.teams[2].roundScore = 1;

  const result = closeRound(game);

  assert.deepEqual(result.winners.map((w) => w.teamId).sort(), [1, 2]);
  assert.equal(game.cityResources.length, 2);
});

test("serializeForViewer during film review reveals only the current slide answer", () => {
  const game = createGame({ teamCount: 2 });
  game.status = "round_review";
  game.currentRoundIndex = 0;
  game.currentReviewIndex = 0;
  game.rounds[0].answerReview = true;
  game.rounds[0].questions = [
    { type: "text", answer: "A0", answerTitle: "A0", revealImage: "r0.png" },
    { type: "text", answer: "A1", answerTitle: "A1", revealImage: "r1.png" },
  ];

  const view = serializeForViewer(game, { teamId: 1 });

  // Ответ и картинку-раскрытие текущего слайда даём через reveals, а не в текстах вопросов.
  assert.equal("answer" in view.rounds[0].questions[0], false);
  assert.equal("revealImage" in view.rounds[0].questions[0], false);
  assert.equal(view.reveals["0:0"].answer, "A0");
  assert.equal(view.reveals["0:0"].revealImage, "r0.png");
  // Следующий слайд ещё не раскрыт — его в reveals нет.
  assert.equal("0:1" in view.reveals, false);
});
