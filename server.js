import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import {
  createGame,
  submitAnswer,
  scoreCurrentQuestion,
  startRound,
  closeRound,
  recountQuestion,
  adjustScore,
  awardManualRoundWinnerByPin,
  getQuestionDurationMs,
  serializeForViewer,
  teamIdForPin,
  updateTeamSetup,
} from "./src/game.js";
import { fullRounds } from "./src/rounds.js";

const root = process.cwd();
const port = Number(process.env.PORT || 4173);
const hostCode = process.env.HOST_CODE || "0306";
const teamSlots = Math.max(2, Math.min(10, Number(process.env.TEAMS) || 6));
const finalStepMs = 800;
const roundStepMs = 800;
const stateFile = process.env.STATE_FILE || join(root, "game-state.json");

function createManualAttemptState(durationMs = 60000) {
  return {
    status: "idle",
    teamId: null,
    startedAt: 0,
    durationMs,
    remainingMs: durationMs,
    attemptNumber: 0,
  };
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function createFreshGame() {
  const game = createGame({ teamCount: teamSlots });
  game.rounds = structuredClone(fullRounds);
  game.finalReveal = "hidden";
  game.finalCountdown = 3;
  game.finalRevealAt = 0;
  game.roundCountdown = 3;
  game.roundCountdownAt = 0;
  game.paused = false;
  game.pausedRemainingMs = null;
  game.currentReviewIndex = 0;
  game.manualWinnerTeamId = null;
  game.manualAttempt = createManualAttemptState();
  return game;
}

async function loadGame() {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8"));
    if (!Array.isArray(parsed.teams)) throw new Error("bad state");
    parsed.rounds = structuredClone(fullRounds);
    parsed.status ||= "lobby";
    parsed.questionScores ||= {};
    parsed.roundResults ||= [];
    parsed.cityResources ||= [];
    parsed.answers ||= {};
    parsed.finalReveal ||= "hidden";
    parsed.finalCountdown ??= 3;
    parsed.finalRevealAt ??= 0;
    parsed.roundCountdown ??= 3;
    parsed.roundCountdownAt ??= 0;
    parsed.paused ??= false;
    parsed.pausedRemainingMs ??= null;
    parsed.currentReviewIndex ??= 0;
    parsed.manualWinnerTeamId ??= null;
    parsed.manualAttempt ||= createManualAttemptState(parsed.rounds?.[parsed.currentRoundIndex]?.durationMs || 60000);
    parsed.manualAttempt.durationMs ||= parsed.rounds?.[parsed.currentRoundIndex]?.durationMs || 60000;
    parsed.manualAttempt.remainingMs ??= parsed.manualAttempt.durationMs;
    if (parsed.status !== "lobby" && !parsed.teams.some((team) => team.ready)) {
      return createFreshGame();
    }
    for (const team of parsed.teams) team.token ||= "";
    return parsed;
  } catch {
    return createFreshGame();
  }
}

let game = await loadGame();
let persistTimer = null;

function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      await writeFile(stateFile, JSON.stringify(game));
    } catch {
      // диск недоступен — не роняем сервер
    }
  }, 50);
}

const clients = new Set();

function viewerState(client) {
  const seeAllAnswers = client.view === "host" && client.code === hostCode;
  return serializeForViewer(game, { seeAllAnswers, teamId: client.teamId, teamToken: client.teamToken });
}

function broadcast() {
  for (const client of clients) {
    try {
      client.res.write(`data: ${JSON.stringify(viewerState(client))}\n\n`);
    } catch {
      clients.delete(client);
    }
  }
}

function isManualRound() {
  return Boolean(game.rounds[game.currentRoundIndex]?.manual);
}

function questionTimeLeftMs() {
  if (game.paused) return game.pausedRemainingMs ?? 0;
  const duration = getQuestionDurationMs(game);
  if (!game.questionStartedAt || game.status !== "round_running") return duration;
  return Math.max(0, duration - (Date.now() - game.questionStartedAt));
}

function resetQuestionClock() {
  game.questionResultUntil = null;
  game.paused = false;
  game.pausedRemainingMs = null;
}

function hasClosedCurrentRound() {
  return game.roundResults.some((result) => result.roundIndex === game.currentRoundIndex);
}

function finishCurrentRound() {
  if (game.status === "round_running" && !isManualRound()) scoreCurrentQuestion(game);
  if (!hasClosedCurrentRound()) closeRound(game);
  game.status = "round_countdown";
  game.roundCountdown = 3;
  game.roundCountdownAt = Date.now();
  game.questionStartedAt = null;
  resetQuestionClock();
  game.manualAttempt = createManualAttemptState(getQuestionDurationMs(game));
}

function showRoundResults() {
  if (game.status === "round_running" && !isManualRound()) scoreCurrentQuestion(game);
  if (!hasClosedCurrentRound()) closeRound(game);
  game.status = "round_countdown";
  game.roundCountdown = 3;
  game.roundCountdownAt = Date.now();
  game.questionStartedAt = null;
  resetQuestionClock();
  return { ok: true };
}

function hideRoundResults() {
  if (game.status !== "round_results") return { error: "Итоги сейчас не показаны" };
  game.status = "round_over";
  game.roundCountdown = 3;
  game.roundCountdownAt = 0;
  return { ok: true };
}

function moveToNextQuestionOrRoundOver() {
  if (isManualRound()) return { error: "В ручном раунде нет следующего вопроса" };
  if (game.status === "lobby") return { error: "Игра ещё не началась" };
  if (game.status === "round_review") {
    const reviewLength = game.rounds[game.currentRoundIndex]?.questions?.length || 0;
    if (game.currentReviewIndex < reviewLength - 1) {
      game.currentReviewIndex += 1;
      return { ok: true };
    }
    game.status = "round_over";
    game.currentReviewIndex = 0;
    return { ok: true };
  }
  if (game.status === "round_running") scoreCurrentQuestion(game);

  const round = game.rounds[game.currentRoundIndex];
  const isLastQuestion = game.currentQuestionIndex >= round.questions.length - 1;
  if (isLastQuestion) {
    game.status = round.answerReview ? "round_review" : "round_over";
    game.currentReviewIndex = 0;
    game.questionStartedAt = null;
    resetQuestionClock();
    return { ok: true };
  }

  game.currentQuestionIndex += 1;
  game.status = "round_running";
  game.questionStartedAt = Date.now();
  resetQuestionClock();
  return { ok: true };
}

function manualAttemptDurationMs() {
  return game.rounds[game.currentRoundIndex]?.durationMs || 60000;
}

function manualAttemptTimeLeftMs() {
  const attempt = game.manualAttempt || createManualAttemptState(manualAttemptDurationMs());
  if (attempt.status === "paused" || attempt.status === "finished" || attempt.status === "idle") {
    return attempt.remainingMs ?? attempt.durationMs ?? manualAttemptDurationMs();
  }
  return Math.max(0, attempt.durationMs - (Date.now() - attempt.startedAt));
}

function startManualAttempt(teamId) {
  if (!isManualRound()) return { error: "Это действие доступно только в ручном раунде" };
  const team = game.teams.find((item) => item.id === Number(teamId) && item.ready);
  if (!team) return { error: "Сначала выберите команду в игре" };
  const durationMs = manualAttemptDurationMs();
  game.manualAttempt = {
    status: "running",
    teamId: team.id,
    startedAt: Date.now(),
    durationMs,
    remainingMs: durationMs,
    attemptNumber: (game.manualAttempt?.attemptNumber || 0) + 1,
  };
  return { ok: true };
}

function finishManualAttempt() {
  if (!isManualRound()) return { error: "Это действие доступно только в ручном раунде" };
  const attempt = game.manualAttempt || createManualAttemptState(manualAttemptDurationMs());
  game.manualAttempt = {
    ...attempt,
    status: "finished",
    remainingMs: 0,
  };
  return { ok: true };
}

function toggleManualAttemptPause() {
  if (!isManualRound()) return { error: "Это действие доступно только в ручном раунде" };
  const attempt = game.manualAttempt || createManualAttemptState(manualAttemptDurationMs());
  if (attempt.status === "running") {
    game.manualAttempt = { ...attempt, status: "paused", remainingMs: manualAttemptTimeLeftMs() };
  } else if (attempt.status === "paused") {
    game.manualAttempt = {
      ...attempt,
      status: "running",
      startedAt: Date.now() - (attempt.durationMs - (attempt.remainingMs ?? attempt.durationMs)),
    };
  }
  return { ok: true };
}

function resetManualAttempt() {
  if (!isManualRound()) return { error: "Это действие доступно только в ручном раунде" };
  game.manualAttempt = createManualAttemptState(manualAttemptDurationMs());
  return { ok: true };
}

function handleAction(action) {
  const type = action?.type;
  const isHost = action?.code === hostCode;

  if (type === "loginTeam") {
    const teamId = teamIdForPin(action.pin);
    if (!teamId || teamId > game.teams.length) return { error: "Неверный PIN команды" };
    const team = game.teams.find((item) => item.id === teamId);
    team.token ||= randomUUID();
    team.online = true;
    return { ok: true, teamId: team.id, token: team.token };
  }

  if (type === "join") {
    const team = game.teams.find((item) => item.id === Number(action.teamId));
    if (!team) return { error: "Нет такой команды" };
    if (!team.token || team.token !== action.token) return { error: "Сначала войдите по PIN команды" };
    try {
      updateTeamSetup(game, team.id, { name: action.name, color: action.color, captain: action.captain || "Команда" });
      // Игру запускает ведущая кнопкой «Начать игру» — авто-старт отключён.
    } catch (error) {
      return { error: error.message };
    }
    return { ok: true, teamId: team.id, token: team.token };
  }

  if (type === "submitAnswer") {
    if (game.status !== "round_running" || isManualRound()) return { error: "Сейчас нельзя отвечать" };
    const team = game.teams.find((item) => item.id === Number(action.teamId));
    if (!team) return { error: "Нет такой команды" };
    if (!team.ready) return { error: "Сначала сохраните название команды" };
    if (team.token && team.token !== action.token) return { error: "Эта команда уже занята на другом устройстве" };
    // Защита от устаревшего ответа: клиент присылает номер раунда/вопроса. Если из-за
    // сетевой задержки они не совпадают с текущими — ответ не пишем на чужой вопрос.
    if (action.roundIndex != null && Number(action.roundIndex) !== game.currentRoundIndex) {
      return { error: "Вопрос уже сменился" };
    }
    if (action.questionIndex != null && Number(action.questionIndex) !== game.currentQuestionIndex) {
      return { error: "Вопрос уже сменился" };
    }
    submitAnswer(game, team.id, action.value);
    return { ok: true };
  }

  if (!isHost) return { error: "Только для ведущей" };

  switch (type) {
    case "startRound":
      startRound(game);
      resetQuestionClock();
      game.manualAttempt = createManualAttemptState(manualAttemptDurationMs());
      break;
    case "scoreNow":
      scoreCurrentQuestion(game);
      game.status = "question_scored";
      game.questionResultUntil = null;
      game.paused = false;
      game.pausedRemainingMs = null;
      break;
    case "nextQuestion": {
      const result = moveToNextQuestionOrRoundOver();
      if (result.error) return result;
      break;
    }
    case "recount":
      recountQuestion(game);
      scoreCurrentQuestion(game);
      game.status = "question_scored";
      game.questionResultUntil = null;
      break;
    case "adjustScore":
      adjustScore(game, Number(action.teamId), Number(action.delta));
      break;
    case "awardManualWinnerByPin": {
      try {
        awardManualRoundWinnerByPin(game, action.pin);
      } catch (error) {
        return { error: error.message };
      }
      break;
    }
    case "nextRound":
      game.currentRoundIndex = Math.min(game.rounds.length - 1, game.currentRoundIndex + 1);
      startRound(game);
      resetQuestionClock();
      game.manualAttempt = createManualAttemptState(manualAttemptDurationMs());
      break;
    case "closeManualRound":
      finishCurrentRound();
      break;
    case "finishRound":
      showRoundResults();
      break;
    case "hideRoundResults": {
      const result = hideRoundResults();
      if (result.error) return result;
      break;
    }
    case "togglePause":
      if (game.paused) {
        game.paused = false;
        if (game.status === "round_running" && game.pausedRemainingMs != null) {
          game.questionStartedAt = Date.now() - (getQuestionDurationMs(game) - game.pausedRemainingMs);
        }
        game.pausedRemainingMs = null;
      } else if (game.status === "round_running") {
        game.pausedRemainingMs = questionTimeLeftMs();
        game.paused = true;
      }
      break;
    case "startManualAttempt": {
      const result = startManualAttempt(action.teamId);
      if (result.error) return result;
      break;
    }
    case "finishManualAttempt": {
      const result = finishManualAttempt();
      if (result.error) return result;
      break;
    }
    case "toggleManualAttemptPause": {
      const result = toggleManualAttemptPause();
      if (result.error) return result;
      break;
    }
    case "resetManualAttempt": {
      const result = resetManualAttempt();
      if (result.error) return result;
      break;
    }
    case "finalReveal":
      game.finalReveal = "countdown";
      game.finalCountdown = 3;
      game.finalRevealAt = Date.now();
      break;
    case "showFinalCongrats":
      game.finalReveal = "congrats";
      game.finalCountdown = 0;
      game.finalRevealAt = Date.now();
      break;
    case "reset":
      game = createFreshGame();
      break;
    default:
      return { error: "Неизвестное действие" };
  }
  return { ok: true };
}

// Серверный тик: таймер вопроса, автопереходы, финальный отсчёт.
setInterval(() => {
  let changed = false;
  if (game.status === "round_countdown") {
    if (Date.now() - game.roundCountdownAt >= roundStepMs) {
      game.roundCountdown -= 1;
      game.roundCountdownAt = Date.now();
      if (game.roundCountdown <= 0) game.status = "round_results";
      changed = true;
    }
  } else if (game.finalReveal === "countdown") {
    if (Date.now() - game.finalRevealAt >= finalStepMs) {
      game.finalCountdown -= 1;
      game.finalRevealAt = Date.now();
      if (game.finalCountdown <= 0) game.finalReveal = "podium";
      changed = true;
    }
  } else if (isManualRound()) {
    if (game.manualAttempt?.status === "running" && manualAttemptTimeLeftMs() <= 0) {
      finishManualAttempt();
      changed = true;
    }
  } else if (!game.paused) {
    if (game.status === "round_running" && game.questionStartedAt && questionTimeLeftMs() <= 0) {
      moveToNextQuestionOrRoundOver();
      changed = true;
    }
  }
  if (changed) {
    persistSoon();
    broadcast();
  }
}, 500);

function readBody(request) {
  return new Promise((resolve) => {
    let data = "";
    request.on("data", (chunk) => (data += chunk));
    request.on("end", () => resolve(data));
  });
}

function clientFromQuery(url) {
  return {
    view: url.searchParams.get("view") || "team",
    teamId: Number(url.searchParams.get("team")) || null,
    teamToken: url.searchParams.get("token") || "",
    code: url.searchParams.get("code") || "",
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

// Каждый запрос пишем одной строкой в stdout — это то, что видно в логах контейнера
// (docker logs / вкладка логов на :9099). Помогает ловить, например, 400 на просроченный токен.
function logRequest(request, status, detail = "") {
  const ip = request.headers["x-forwarded-for"] || request.socket?.remoteAddress || "-";
  const method = request.method;
  const path = request.url;
  console.log(`${new Date().toISOString()} ${ip} ${method} ${path} ${status}${detail ? ` ${detail}` : ""}`);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname;

  if (pathname === "/api/state") {
    logRequest(request, 200, `view=${url.searchParams.get("view") || "team"}`);
    return sendJson(response, 200, viewerState(clientFromQuery(url)));
  }

  if (pathname === "/api/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const client = { res: response, ...clientFromQuery(url) };
    clients.add(client);
    logRequest(request, 200, `SSE open view=${client.view} team=${client.teamId ?? "-"} clients=${clients.size}`);
    response.write(`data: ${JSON.stringify(viewerState(client))}\n\n`);
    const ping = setInterval(() => {
      try {
        response.write(": ping\n\n");
      } catch {
        // соединение закрыто
      }
    }, 25000);
    request.on("close", () => {
      clearInterval(ping);
      clients.delete(client);
      logRequest(request, 499, `SSE close view=${client.view} team=${client.teamId ?? "-"} clients=${clients.size}`);
    });
    return;
  }

  if (pathname === "/api/action") {
    if (request.method !== "POST") {
      logRequest(request, 405, "action rejected: not POST");
      return sendJson(response, 405, { error: "POST only" });
    }
    let action;
    try {
      action = JSON.parse((await readBody(request)) || "{}");
    } catch {
      logRequest(request, 400, "action rejected: bad JSON");
      return sendJson(response, 400, { error: "Плохой JSON" });
    }
    // Любое исключение обработчика (например teamById на неизвестный teamId) не должно
    // валить процесс — иначе один кривой запрос кладёт живую игру.
    let result;
    try {
      result = handleAction(action);
    } catch (error) {
      logRequest(request, 400, `action=${action?.type || "?"} threw="${error.message}"`);
      return sendJson(response, 400, { error: "Не получилось выполнить действие" });
    }
    const detail = `action=${action?.type || "?"} team=${action?.teamId ?? "-"} ${result.error ? `error="${result.error}"` : "ok"}`;
    logRequest(request, result.error ? 400 : 200, detail);
    if (result.error) return sendJson(response, 400, result);
    persistSoon();
    broadcast();
    return sendJson(response, 200, result);
  }

  // Статика
  try {
    const requested = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
    const filePath = normalize(join(root, requested));
    if (!filePath.startsWith(root) || filePath === stateFile) throw new Error("Invalid path");
    const data = await readFile(filePath);
    response.writeHead(200, { "Content-Type": types[extname(filePath)] || "text/plain" });
    response.end(data);
    logRequest(request, 200);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    logRequest(request, 404);
  }
});

server.listen(port, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`Кайфоград сервер: http://localhost:${actualPort}`);
});
