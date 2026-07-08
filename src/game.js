export const TEAM_COLORS = [
  "#4CC9F0",
  "#FF5FA2",
  "#FFE45C",
  "#7CFF8A",
  "#FF8A3D",
  "#9B7BFF",
  "#FF4D5E",
  "#2DE2E6",
  "#B8FF3D",
  "#C9B8E8",
];

export const TEAM_PINS = Object.freeze({
  1: "101",
  2: "102",
  3: "103",
  4: "104",
  5: "105",
  6: "106",
});

export const QUESTION_DURATION_MS = 45000;

export const ROUNDS = [
  {
    title: "У меня работает",
    resource: "Технологии",
    questions: [
      {
        type: "choice",
        prompt:
          "Какая фраза лучше всего описывает ситуацию, когда у одного человека всё работает, а у всей команды нет?",
        options: ["Зима близко", "It works on my machine", "Да пребудет с тобой Сила", "Ты не пройдёшь"],
        correct: "B",
      },
      {
        type: "choice",
        prompt: "Что обычно советуют сделать первым, когда “ничего не работает”?",
        options: ["Перезагрузить", "Купить новый ноутбук", "Сходить к психологу", "Открыть Excel"],
        correct: "A",
      },
    ],
  },
  {
    title: "Цена вопроса",
    resource: "Банк",
    questions: [
      {
        type: "number",
        prompt: "Сколько стоит маникюр с покрытием и дизайном?",
        correct: 4500,
      },
    ],
  },
  { title: "Где я?", resource: "Территория", questions: [] },
  { title: "Баг в истории", resource: "Музей истории", questions: [] },
  { title: "Кто это сказал?", resource: "Театр", questions: [] },
  { title: "Остров кайфа", resource: "Остров кайфа", questions: [] },
  { title: "Узнай по пикселю", resource: "Порт и самолёт", questions: [] },
  { title: "Культурный сервер", resource: "Счастье жителей", questions: [] },
];

function getQuestion(game) {
  return game.rounds[game.currentRoundIndex].questions[game.currentQuestionIndex];
}

export function getQuestionDurationMs(game) {
  const round = game.rounds[game.currentRoundIndex];
  return round?.durationMs ?? game.questionDurationMs ?? QUESTION_DURATION_MS;
}

function normalizeChoice(value) {
  return String(value ?? "").trim().toUpperCase().slice(0, 1);
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[«»"“”.,!?()[\]:;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedAccepted(rawAnswers) {
  return rawAnswers
    .flatMap((answer) => String(answer ?? "").split(/\s*\/\s*|\s*\|\s*/))
    .map(normalizeText)
    .filter(Boolean);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// Средняя строгость: прощаем опечатки по длине слова (≤5 → 1, 6–10 → 2, >10 → 3).
function fuzzyThreshold(len) {
  if (len < 4) return 0;
  if (len <= 5) return 1;
  if (len <= 10) return 2;
  return 3;
}

function matchesAccepted(value, rawAnswers) {
  const normalized = normalizeText(value);
  if (!normalized) return false;
  return normalizedAccepted(rawAnswers).some((accepted) => {
    if (normalized === accepted) return true;
    if (accepted.length >= 4 && normalized.includes(accepted)) return true;
    const threshold = fuzzyThreshold(accepted.length);
    return threshold > 0 && levenshtein(normalized, accepted) <= threshold;
  });
}

function acceptedTextAnswers(question) {
  return normalizedAccepted(question.acceptedAnswers || question.answers || [question.answer]);
}

function isTextCorrect(value, question) {
  return matchesAccepted(value, question.acceptedAnswers || question.answers || [question.answer]);
}

function teamById(game, teamId) {
  const team = game.teams.find((item) => item.id === teamId);
  if (!team) throw new Error(`Unknown team ${teamId}`);
  return team;
}

export function teamIdForPin(pin) {
  const normalized = String(pin ?? "").trim();
  const entry = Object.entries(TEAM_PINS).find(([, value]) => value === normalized);
  return entry ? Number(entry[0]) : null;
}

export function createGame({ teamCount = 2 } = {}) {
  const count = Math.max(2, Math.min(10, teamCount));
  return {
    id: `game-${Date.now()}`,
    status: "lobby",
    currentRoundIndex: 0,
    currentQuestionIndex: 0,
    currentReviewIndex: 0,
    questionStartedAt: null,
    questionDurationMs: QUESTION_DURATION_MS,
    questionResultUntil: null,
    resultsVisible: false,
    finalRevealStep: "hidden",
    rounds: structuredClone(ROUNDS),
    teams: Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      slotName: `Команда ${index + 1}`,
      displayName: `Команда ${index + 1}`,
      name: "",
      captain: "",
      color: TEAM_COLORS[index],
      ready: false,
      online: false,
      roundScore: 0,
      totalScore: 0,
    })),
    answers: {},
    questionScores: {},
    roundResults: [],
    cityResources: [],
    manualWinnerTeamId: null,
  };
}

export function startRound(game, { now = Date.now() } = {}) {
  game.status = "round_running";
  game.currentQuestionIndex = 0;
  game.currentReviewIndex = 0;
  game.manualWinnerTeamId = null;
  game.questionStartedAt = now;
  game.questionResultUntil = null;
  for (const team of game.teams) team.roundScore = 0;
  return game.status;
}

export function ensureCurrentRoundStarted(game, { now = Date.now() } = {}) {
  void now;
  if (game.status !== "lobby") return game.status;
  return game.status;
}

export function registerTeam(game, teamId, { name = "", color, captain = "" } = {}) {
  const team = teamById(game, teamId);
  const colorTaken = game.teams.some((item) => item.id !== teamId && item.ready && item.color === color);
  if (color && colorTaken) throw new Error("Color already taken");
  team.name = name.trim();
  team.displayName = team.name || team.slotName;
  team.color = color || team.color;
  team.captain = captain.trim();
  team.ready = true;
  team.online = true;
  return team;
}

export function updateTeamSetup(game, teamId, { name = "", color, captain = "" } = {}) {
  const team = teamById(game, teamId);
  // Первичный вход (команда ещё не готова) разрешён в любой момент — чтобы опоздавшие
  // могли присоединиться и играть. Переименование уже готовой команды — только до старта.
  if (team.ready && game.status !== "lobby") {
    throw new Error("Название команды можно менять только до начала игры");
  }
  return registerTeam(game, teamId, { name, color, captain });
}

export function submitAnswer(game, teamId, value) {
  teamById(game, teamId);
  const key = `${game.currentRoundIndex}:${game.currentQuestionIndex}`;
  if (!game.answers[key]) game.answers[key] = {};
  game.answers[key][teamId] = {
    teamId,
    value,
    submittedAt: new Date().toISOString(),
  };
  return game.answers[key][teamId];
}

export function getTeamView(game, teamId) {
  const team = teamById(game, teamId);
  const questionKey = `${game.currentRoundIndex}:${game.currentQuestionIndex}`;
  return {
    team: {
      id: team.id,
      displayName: team.displayName,
      color: team.color,
      ready: team.ready,
      online: team.online,
    },
    round: {
      index: game.currentRoundIndex,
      title: game.rounds[game.currentRoundIndex].title,
      resource: game.rounds[game.currentRoundIndex].resource,
    },
    question: getQuestion(game),
    ownAnswer: game.answers[questionKey]?.[teamId] ?? null,
    otherAnswersVisible: false,
  };
}

function award(game, awarded, teamId, points) {
  if (!points) return;
  const team = teamById(game, teamId);
  team.roundScore += points;
  team.totalScore += points;
  awarded[teamId] = (awarded[teamId] ?? 0) + points;
}

export function scoreCurrentQuestion(game, manualScores = {}) {
  const question = getQuestion(game);
  const key = `${game.currentRoundIndex}:${game.currentQuestionIndex}`;
  if (game.questionScores[key]) return game.questionScores[key];
  const answers = Object.values(game.answers[key] ?? {});
  const result = { key, type: question.type, correctTeamIds: [], ranked: [], awarded: {} };

  if (question.type === "choice") {
    for (const answer of answers) {
      const isCorrect = normalizeChoice(answer.value) === question.correct;
      if (isCorrect) {
        award(game, result.awarded, answer.teamId, 1);
        result.correctTeamIds.push(answer.teamId);
      }
    }
  } else if (question.type === "number") {
    result.ranked = answers
      .map((answer) => ({
        teamId: answer.teamId,
        value: Number(answer.value),
        distance: Math.abs(Number(answer.value) - Number(question.correct)),
        points: 0,
      }))
      .filter((item) => Number.isFinite(item.value))
      .sort((a, b) => a.distance - b.distance);
    if (result.ranked[0]) result.ranked[0].points = 2;
    if (result.ranked[1]) result.ranked[1].points = 1;
    for (const item of result.ranked) {
      award(game, result.awarded, item.teamId, item.points);
    }
  } else if (question.type === "text") {
    for (const answer of answers) {
      if (isTextCorrect(answer.value, question)) {
        award(game, result.awarded, answer.teamId, 1);
        result.correctTeamIds.push(answer.teamId);
      }
    }
  } else if (question.type === "song") {
    for (const answer of answers) {
      const value = answer.value || {};
      let points = 0;
      if (matchesAccepted(value.artist, question.artistAccepted || [])) points += 1;
      if (matchesAccepted(value.title, question.titleAccepted || [])) points += 1;
      award(game, result.awarded, answer.teamId, points);
      if (points > 0) result.correctTeamIds.push(answer.teamId);
    }
  } else {
    for (const [teamId, points] of Object.entries(manualScores)) {
      award(game, result.awarded, Number(teamId), points);
      if (points > 0) result.correctTeamIds.push(Number(teamId));
    }
  }

  game.questionScores[key] = result;
  return result;
}

export function recountQuestion(game) {
  const key = `${game.currentRoundIndex}:${game.currentQuestionIndex}`;
  const result = game.questionScores[key];
  if (!result) return null;
  for (const [teamId, points] of Object.entries(result.awarded ?? {})) {
    const team = teamById(game, Number(teamId));
    team.roundScore = Math.max(0, team.roundScore - points);
    team.totalScore = Math.max(0, team.totalScore - points);
  }
  delete game.questionScores[key];
  return result;
}

export function adjustScore(game, teamId, delta) {
  const team = teamById(game, teamId);
  team.roundScore = Math.max(0, team.roundScore + delta);
  team.totalScore = Math.max(0, team.totalScore + delta);
  return team;
}

export function awardManualRoundWinnerByPin(game, pin) {
  const round = game.rounds[game.currentRoundIndex];
  if (!round?.manual) throw new Error("Это действие доступно только в ручном раунде");
  const teamId = teamIdForPin(pin);
  if (!teamId) throw new Error("Неверный PIN команды");
  const winner = teamById(game, teamId);
  if (!winner.ready) throw new Error("Команда ещё не сохранила название");

  if (game.manualWinnerTeamId) {
    const previous = teamById(game, game.manualWinnerTeamId);
    previous.roundScore = Math.max(0, previous.roundScore - 1);
    previous.totalScore = Math.max(0, previous.totalScore - 1);
  }

  winner.roundScore += 1;
  winner.totalScore += 1;
  game.manualWinnerTeamId = winner.id;
  return winner;
}

export function closeRound(game) {
  const maxScore = Math.max(...game.teams.map((team) => team.roundScore));
  const roundScores = game.teams.map((team) => ({
    teamId: team.id,
    teamName: team.displayName,
    score: team.roundScore,
    color: team.color,
  }));
  const winners = game.teams
    .filter((team) => team.roundScore === maxScore && maxScore > 0)
    .map((team) => ({
      teamId: team.id,
      teamName: team.displayName,
      score: team.roundScore,
      color: team.color,
    }));
  const round = game.rounds[game.currentRoundIndex];
  const resource = { name: round.resource, roundTitle: round.title };

  for (const winner of winners) {
    game.cityResources.push({
      id: `${game.currentRoundIndex + 1}-${winner.teamId}`,
      roundIndex: game.currentRoundIndex,
      roundTitle: round.title,
      resource: round.resource,
      teamId: winner.teamId,
      teamName: winner.teamName,
      color: winner.color,
    });
  }

  const result = { roundIndex: game.currentRoundIndex, resource, winners, roundScores };
  game.roundResults.push(result);
  for (const team of game.teams) team.roundScore = 0;
  return result;
}

export function advanceAfterQuestionScore(game, { now = Date.now() } = {}) {
  const round = game.rounds[game.currentRoundIndex];
  const isLastQuestion = game.currentQuestionIndex >= round.questions.length - 1;
  if (!isLastQuestion) {
    game.currentQuestionIndex += 1;
    game.status = "round_running";
    game.questionStartedAt = now;
    game.questionResultUntil = null;
    return game.status;
  }

  closeRound(game);
  game.status = "round_results";
  game.questionStartedAt = null;
  game.questionResultUntil = null;
  return game.status;
}

export function serializeForViewer(game, { seeAllAnswers = false, teamId = null, teamToken = "" } = {}) {
  const clone = structuredClone(game);
  for (const team of clone.teams) delete team.token;

  const liveTeam = teamId != null ? game.teams.find((team) => team.id === Number(teamId)) : null;
  const teamAccess =
    seeAllAnswers ||
    teamId == null ||
    !liveTeam ||
    !liveTeam.ready ||
    !liveTeam.token ||
    liveTeam.token === teamToken;

  clone.viewer = {
    teamId,
    teamAccess,
  };

  if (seeAllAnswers) return clone;
  const redacted = {};
  if (teamId != null && teamAccess) {
    for (const [key, byTeam] of Object.entries(game.answers)) {
      if (byTeam[teamId]) redacted[key] = { [teamId]: structuredClone(byTeam[teamId]) };
    }
  }
  clone.answers = redacted;

  // Безопасность: правильные ответы не отдаём никому, кроме ведущей (seeAllAnswers).
  // Иначе их видно в консоли разработчика во время игры. На раскрытии кино-раунда
  // показываем ответ только текущего слайда.
  const isReview = clone.status === "round_review";
  const revealIndex = clone.currentReviewIndex || 0;
  clone.rounds = (clone.rounds || []).map((round, ri) => ({
    ...round,
    questions: (round.questions || []).map((q, qi) => {
      const keepReveal = isReview && ri === clone.currentRoundIndex && qi === revealIndex;
      const safeQ = { ...q };
      delete safeQ.correct;
      delete safeQ.acceptedAnswers;
      delete safeQ.artist;
      delete safeQ.title;
      delete safeQ.artistAccepted;
      delete safeQ.titleAccepted;
      if (!keepReveal) {
        delete safeQ.answer;
        delete safeQ.answerTitle;
        delete safeQ.revealImage;
      }
      return safeQ;
    }),
  }));

  return clone;
}

export function getFinalPodium(game) {
  return game.teams
    .slice()
    .sort((a, b) => b.totalScore - a.totalScore || b.id - a.id)
    .slice(0, 3)
    .reverse()
    .map((team, index) => ({
      place: 3 - index,
      teamId: team.id,
      teamName: team.displayName,
      color: team.color,
      totalScore: team.totalScore,
      resources: game.cityResources.filter((resource) => resource.teamId === team.id),
    }));
}
