import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import {
  createGame,
  registerTeam,
  submitAnswer,
  scoreCurrentQuestion,
  startRound,
  ensureCurrentRoundStarted,
  advanceAfterQuestionScore,
  closeRound,
  recountQuestion,
  adjustScore,
  getQuestionDurationMs,
  serializeForViewer,
} from "./src/game.js";
import { fullRounds } from "./src/rounds.js";

const root = process.cwd();
const port = Number(process.env.PORT || 4173);
const hostCode = process.env.HOST_CODE || "0306";
const teamSlots = Math.max(2, Math.min(10, Number(process.env.TEAMS) || 6));
const questionResultPauseMs = 2500;
const finalStepMs = 800;
const stateFile = process.env.STATE_FILE || join(root, "game-state.json");

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
  game.paused = false;
  game.pausedRemainingMs = null;
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
    parsed.paused ??= false;
    parsed.pausedRemainingMs ??= null;
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

function handleAction(action) {
  const type = action?.type;
  const isHost = action?.code === hostCode;

  if (type === "join") {
    const team = game.teams.find((item) => item.id === Number(action.teamId));
    if (!team) return { error: "Нет такой команды" };
    if (team.ready) return { error: "Команда уже занята" };
    try {
      registerTeam(game, team.id, { name: action.name, color: action.color, captain: action.captain || "Команда" });
      team.token = randomUUID();
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
    if (team.token && team.token !== action.token) return { error: "Эта команда уже занята на другом устройстве" };
    submitAnswer(game, team.id, action.value);
    return { ok: true };
  }

  if (!isHost) return { error: "Только для ведущей" };

  switch (type) {
    case "startRound":
      startRound(game);
      break;
    case "scoreNow":
      scoreCurrentQuestion(game);
      game.status = "question_scored";
      game.questionResultUntil = Date.now() + questionResultPauseMs;
      break;
    case "recount":
      recountQuestion(game);
      scoreCurrentQuestion(game);
      game.status = "question_scored";
      game.questionResultUntil = Date.now() + questionResultPauseMs;
      break;
    case "adjustScore":
      adjustScore(game, Number(action.teamId), Number(action.delta));
      break;
    case "nextRound":
      game.currentRoundIndex = Math.min(game.rounds.length - 1, game.currentRoundIndex + 1);
      startRound(game);
      break;
    case "closeManualRound":
      closeRound(game);
      game.status = "round_results";
      break;
    case "finishRound":
      closeRound(game);
      game.status = "round_results";
      game.paused = false;
      game.pausedRemainingMs = null;
      break;
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
    case "finalReveal":
      game.finalReveal = "countdown";
      game.finalCountdown = 3;
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
  if (game.finalReveal === "countdown") {
    if (Date.now() - game.finalRevealAt >= finalStepMs) {
      game.finalCountdown -= 1;
      game.finalRevealAt = Date.now();
      if (game.finalCountdown <= 0) game.finalReveal = "podium";
      changed = true;
    }
  } else if (!isManualRound() && !game.paused) {
    if (game.status === "round_running" && game.questionStartedAt && questionTimeLeftMs() <= 0) {
      scoreCurrentQuestion(game);
      game.status = "question_scored";
      game.questionResultUntil = Date.now() + questionResultPauseMs;
      changed = true;
    } else if (game.status === "question_scored" && game.questionResultUntil && Date.now() >= game.questionResultUntil) {
      const round = game.rounds[game.currentRoundIndex];
      const isLastQuestion = game.currentQuestionIndex >= round.questions.length - 1;
      if (isLastQuestion) {
        // Раунд закончился — ждём, пока ведущая нажмёт «Завершить раунд».
        game.status = "round_over";
      } else {
        advanceAfterQuestionScore(game);
      }
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

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname;

  if (pathname === "/api/state") {
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
    });
    return;
  }

  if (pathname === "/api/action") {
    if (request.method !== "POST") return sendJson(response, 405, { error: "POST only" });
    let action;
    try {
      action = JSON.parse((await readBody(request)) || "{}");
    } catch {
      return sendJson(response, 400, { error: "Плохой JSON" });
    }
    const result = handleAction(action);
    if (result.error) return sendJson(response, 400, result);
    persistSoon();
    broadcast();
    return sendJson(response, 200, result);
  }

  // Статика
  try {
    const requested = pathname === "/" ? "/index.html" : pathname;
    const filePath = normalize(join(root, requested));
    if (!filePath.startsWith(root) || filePath === stateFile) throw new Error("Invalid path");
    const data = await readFile(filePath);
    response.writeHead(200, { "Content-Type": types[extname(filePath)] || "text/plain" });
    response.end(data);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, () => {
  console.log(`Кайфоград сервер: http://localhost:${port}`);
});
