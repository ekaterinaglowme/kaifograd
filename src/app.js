import { TEAM_COLORS, getFinalPodium, getQuestionDurationMs } from "./game.js";
import { fullRounds, resourceDescriptions } from "./rounds.js";

const hostCode = "0306";
const miroUrl = "https://miro.com/app/board/uXjVH--nKSM=/";
const miroEmbedUrl =
  "https://miro.com/app/live-embed/uXjVH--nKSM=/?embedMode=view_only_without_ui&moveToViewport=-1600,-1000,3200,2000";

const params = new URLSearchParams(window.location.search);
const state = {
  view: params.get("view") || "team",
  selectedTeamId: Number(params.get("team")) || Number(sessionStorage.getItem("kaifogradTeamId")) || 1,
  selectedAnswer: "",
  songArtist: "",
  songTitle: "",
  setupName: "",
  setupColor: "",
  setupPin: "",
  lastAnswerKey: "",
  scoreEditor: false,
  miroLoaded: false,
  hostUnlocked: sessionStorage.getItem("kaifogradHostUnlocked") === "yes",
  error: "",
  teamNotice: "",
  connection: "connecting",
};

let game = null;
let eventSource = null;
let connectedQuery = "";
let pollingTimer = null;

function teamTokenKey(teamId) {
  return `kaifogradTeamToken:${teamId}`;
}

function currentTeamToken() {
  return sessionStorage.getItem(teamTokenKey(state.selectedTeamId)) || "";
}

function hasCurrentTeamToken() {
  return Boolean(currentTeamToken());
}

function saveTeamToken(teamId, token) {
  if (token) sessionStorage.setItem(teamTokenKey(teamId), token);
}

function html(strings, ...values) {
  return String.raw({ raw: strings }, ...values);
}

function safe(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function apiQuery() {
  const query = new URLSearchParams();
  query.set("view", state.view);
  if (state.view === "team") {
    query.set("team", String(state.selectedTeamId));
    const token = currentTeamToken();
    if (token) query.set("token", token);
  }
  if (state.hostUnlocked) query.set("code", hostCode);
  return query.toString();
}

async function fetchState() {
  const response = await fetch(`/api/state?${apiQuery()}`);
  if (!response.ok) throw new Error(await response.text());
  applyIncomingGame(await response.json());
}

function applyIncomingGame(nextGame) {
  const previousGame = game;
  game = nextGame;
  state.connection = "online";
  resetDraftForQuestion();
  if (shouldPreserveFocusedAnswer(previousGame)) updateLiveTimers();
  else render();
}

function connectEvents() {
  const query = apiQuery();
  if (query === connectedQuery && eventSource) return;
  connectedQuery = query;
  if (eventSource) eventSource.close();
  if (pollingTimer) clearInterval(pollingTimer);

  if (!("EventSource" in window)) {
    pollingTimer = setInterval(() => fetchState().catch(showError), 1000);
    fetchState().catch(showError);
    return;
  }

  eventSource = new EventSource(`/api/events?${query}`);
  eventSource.onopen = () => {
    state.connection = "online";
    if (!isAnswerInputActive()) render();
  };
  eventSource.onmessage = (event) => {
    applyIncomingGame(JSON.parse(event.data));
  };
  eventSource.onerror = () => {
    state.connection = "reconnecting";
    if (!isAnswerInputActive()) render();
  };
}

async function postAction(action, { refresh = true } = {}) {
  state.error = "";
  state.teamNotice = "";
  const response = await fetch("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error) {
    throw new Error(result.error || "Сервер не принял действие");
  }
  if (refresh) await fetchState();
  return result;
}

function showError(error) {
  const message = error?.message || String(error);
  if (state.view === "team") {
    state.error = "";
    state.teamNotice = teamFriendlyError(message);
  } else {
    state.error = message;
  }
  render();
}

function teamFriendlyError(message) {
  if (/PIN|Только для ведущей/i.test(message)) return "PIN не подошёл. Проверьте код команды и попробуйте ещё раз.";
  if (/Сначала сохраните название команды/i.test(message)) return "Сначала сохраните название и цвет команды.";
  if (/Сейчас нельзя отвечать/i.test(message)) return "Сейчас вопрос не принимает ответы. Дождитесь следующего экрана.";
  return "Не получилось отправить действие. Попробуйте ещё раз.";
}

function syncUrl() {
  const next = new URL(window.location.href);
  next.searchParams.set("view", state.view);
  if (state.view === "team") next.searchParams.set("team", String(state.selectedTeamId));
  else next.searchParams.delete("team");
  window.history.replaceState(null, "", next);
}

function currentRound() {
  return game?.rounds?.[game.currentRoundIndex] || fullRounds[0];
}

function currentQuestion() {
  return currentRound()?.questions?.[game.currentQuestionIndex] || {};
}

function currentReviewQuestion() {
  return currentRound()?.questions?.[game.currentReviewIndex || 0] || {};
}

function questionElapsedMs() {
  if (!game?.questionStartedAt) return 0;
  return Math.max(0, Date.now() - game.questionStartedAt);
}

function isRunawayAnswerLocked(letter) {
  const q = currentQuestion();
  if (!q.runawayOption || q.runawayOption !== letter) return false;
  return questionElapsedMs() < (q.runawayDelayMs || 7000);
}

function runawayLabel(letter) {
  if (!isRunawayAnswerLocked(letter)) return "";
  const left = Math.max(1, Math.ceil(((currentQuestion().runawayDelayMs || 7000) - questionElapsedMs()) / 1000));
  return `<span class="runaway-badge">${left}</span>`;
}

function isManualRound() {
  return Boolean(currentRound()?.manual);
}

function hasSideMedia() {
  return currentRound()?.mediaSide === "left" && currentQuestion().image !== undefined;
}

function isFilmRound() {
  return Boolean(currentRound()?.answerReview);
}

function answerKey() {
  return `${game?.currentRoundIndex ?? 0}:${game?.currentQuestionIndex ?? 0}`;
}

function draftKey() {
  return `${answerKey()}:${state.selectedTeamId}`;
}

function answersForCurrent() {
  return game?.answers?.[answerKey()] ?? {};
}

function scoreForCurrent() {
  return game?.questionScores?.[answerKey()] ?? null;
}

function readyTeams() {
  return game?.teams?.filter((team) => team.ready) ?? [];
}

function questionTimeLeftMs() {
  if (!game) return 0;
  if (game.paused) return game.pausedRemainingMs ?? 0;
  const duration = getQuestionDurationMs(game);
  if (!game.questionStartedAt || game.status !== "round_running") return duration;
  return Math.max(0, duration - (Date.now() - game.questionStartedAt));
}

function questionTimeLabel() {
  if (game?.paused) return "пауза";
  return `${Math.ceil(questionTimeLeftMs() / 1000)} сек`;
}

function manualAttemptTimeLeftMs() {
  const attempt = game?.manualAttempt;
  const duration = attempt?.durationMs || currentRound()?.durationMs || 60000;
  if (!attempt || attempt.status === "idle") return duration;
  if (attempt.status === "paused" || attempt.status === "finished") return attempt.remainingMs ?? 0;
  return Math.max(0, duration - (Date.now() - attempt.startedAt));
}

function manualAttemptTimeLabel() {
  const attempt = game?.manualAttempt;
  if (attempt?.status === "paused") return "пауза";
  return `${Math.ceil(manualAttemptTimeLeftMs() / 1000)} сек`;
}

function manualAttemptTeam() {
  const teamId = game?.manualAttempt?.teamId;
  return game?.teams?.find((team) => team.id === Number(teamId)) || null;
}

function finalRevealMode() {
  return game?.finalReveal || game?.finalRevealStep || "hidden";
}

function isRoundCountdown() {
  return game?.status === "round_countdown";
}

function isAnswerInputActive() {
  const active = document.activeElement;
  return Boolean(active?.matches?.('[data-field="answer-input"], [data-field="answer-artist"], [data-field="answer-title"]'));
}

function shouldPreserveFocusedAnswer(previousGame) {
  if (state.view !== "team" || !previousGame || !isAnswerInputActive()) return false;
  if (!game || game.status !== "round_running" || isManualRound()) return false;
  if (previousGame.status !== game.status) return false;
  if (previousGame.currentRoundIndex !== game.currentRoundIndex) return false;
  if (previousGame.currentQuestionIndex !== game.currentQuestionIndex) return false;
  return !answersForCurrent()[state.selectedTeamId];
}

function resetDraftForQuestion() {
  if (!game || state.lastAnswerKey === draftKey()) return;
  const own = answersForCurrent()[state.selectedTeamId]?.value;
  state.selectedAnswer = typeof own === "string" ? own : "";
  state.songArtist = own && typeof own === "object" ? own.artist || "" : "";
  state.songTitle = own && typeof own === "object" ? own.title || "" : "";
  state.lastAnswerKey = draftKey();
}

function pointsLabel(value) {
  const last = Math.abs(value) % 10;
  const lastTwo = Math.abs(value) % 100;
  if (last === 1 && lastTwo !== 11) return "балл";
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return "балла";
  return "баллов";
}

function setLiveText(selector, value) {
  for (const element of document.querySelectorAll(selector)) {
    const next = String(value ?? "");
    if (element.textContent !== next) element.textContent = next;
  }
}

function projectorTimerLabel() {
  if (game.status === "round_running") return questionTimeLabel();
  if (game.status === "question_scored") return "закрыто";
  return "готово";
}

function manualAttemptStatusText() {
  const attempt = game?.manualAttempt || {};
  const team = manualAttemptTeam();
  if (attempt.status === "running" || attempt.status === "paused") {
    return `Играет: ${team ? team.displayName : "команда"} · ${manualAttemptTimeLabel()}`;
  }
  if (attempt.status === "finished") return `Попытка завершена: ${team ? team.displayName : "команда"}`;
  return "Выберите команду и запустите попытку на 60 сек";
}

function teamActivityStatusText(team) {
  const attemptTeam = manualAttemptTeam();
  const isOwnAttempt = attemptTeam?.id === team.id;
  const attempt = game.manualAttempt || {};
  if (attempt.status === "running" || attempt.status === "paused") {
    return `${isOwnAttempt ? "Ваша попытка" : `Играет ${attemptTeam?.displayName || "команда"}`} · ${manualAttemptTimeLabel()}`;
  }
  return "Следуйте за ведущей: баллы за этот раунд она начислит вручную.";
}

function updateLiveTimers() {
  if (!game) return;
  const currentTeam = game.teams?.find((team) => team.id === state.selectedTeamId);
  setLiveText('[data-live="host-status"]', renderGameStatusLabel());
  if (currentTeam) setLiveText('[data-live="team-status"]', teamStatusLabel(currentTeam));
  setLiveText('[data-live="projector-timer"]', projectorTimerLabel());
  setLiveText('[data-live="manual-attempt-time"]', manualAttemptTimeLabel());
  setLiveText('[data-live="manual-attempt-status"]', manualAttemptStatusText());
  if (currentTeam) setLiveText('[data-live="team-activity-status"]', teamActivityStatusText(currentTeam));
  updateRunawayButtons();
}

function updateRunawayButtons() {
  for (const button of document.querySelectorAll("[data-runaway-answer]")) {
    const letter = button.dataset.runawayAnswer;
    const locked = isRunawayAnswerLocked(letter);
    button.classList.toggle("runaway-locked", locked);
    button.classList.toggle("runaway-catchable", !locked);
    if (!locked) {
      button.style.setProperty("--runaway-x", "0px");
      button.style.setProperty("--runaway-y", "0px");
    }
    const badge = button.querySelector("[data-runaway-count]");
    if (badge) badge.textContent = locked ? String(Math.max(1, Math.ceil(((currentQuestion().runawayDelayMs || 7000) - questionElapsedMs()) / 1000))) : "✓";
  }
}

function moveRunawayButton(button) {
  const box = button.closest(".options")?.getBoundingClientRect();
  const maxX = Math.min(190, Math.max(80, (box?.width || 420) / 3));
  const maxY = Math.min(110, Math.max(50, (box?.height || 180) / 2));
  const x = Math.round((Math.random() * 2 - 1) * maxX);
  const y = Math.round((Math.random() * 2 - 1) * maxY);
  button.style.setProperty("--runaway-x", `${x}px`);
  button.style.setProperty("--runaway-y", `${y}px`);
}

function render() {
  // Не пересобираем DOM (и не перезагружаем встроенную карту Miro), пока открыта её вкладка.
  if (game && state.view === "city" && document.querySelector(".miro-embed")) return;
  syncUrl();
  const app = document.querySelector("#app");
  app.innerHTML = html`
    <main class="app">
      <header class="topbar">
        <div class="brand">
          <div class="logo"><img class="logo-image" src="./assets/kaifograd-cat.jpg" alt="Кайфоград" /></div>
          <div>
            <h1>Кайфоград</h1>
          </div>
        </div>
        <nav class="tabs">
          ${tab("host", "Ведущая")}
          ${tab("team", "Команда")}
          ${tab("city", "Miro")}
          ${tab("screen", "Наблюдающий")}
        </nav>
      </header>
      ${renderBody()}
    </main>
  `;
}

function renderBody() {
  if (!game) return renderLoading();
  if (state.error) return `${renderError()}${renderView()}`;
  return renderView();
}

function renderView() {
  const reveal = finalRevealMode();
  if (reveal !== "hidden") return renderFinalReveal(reveal);
  if (isRoundCountdown()) return renderRoundCountdown();
  if (state.view === "host") return state.hostUnlocked ? `${renderHostRoundsStrip()}${renderHost()}` : renderHostGate();
  if (state.view === "screen") return renderScreen();
  if (state.view === "city") return renderCity();
  return renderTeam();
}

function tab(name, label) {
  return `<button class="tab ${state.view === name ? "active" : ""}" data-view="${name}">${label}</button>`;
}

function renderLoading() {
  return html`
    <section class="setup-shell">
      <div class="panel setup-card">
        <p class="eyebrow">подключение</p>
        <h2>Подключаюсь к серверу игры</h2>
        <p class="muted">Если это сообщение висит долго, сервер не отвечает на этой ссылке.</p>
      </div>
    </section>
  `;
}

function renderError() {
  return `<div class="score-result"><strong>Нужно внимание</strong><span>${safe(state.error)}</span></div>`;
}

function renderHostGate() {
  return html`
    <section class="panel auth-panel">
      <p class="eyebrow">доступ ведущей</p>
      <h2>Вход по коду</h2>
      <p class="muted">Команды видят только свою вкладку. Код ведущей нужен для ответов, счёта и управления игрой.</p>
      <input class="input" data-field="host-code" placeholder="Введите код ведущей" />
      <button class="btn" data-action="unlock-host">Открыть панель</button>
    </section>
  `;
}

function renderHostRoundsStrip() {
  const rounds = game?.rounds || [];
  const chips = rounds
    .map((r, i) => `<span class="round-chip ${i === game.currentRoundIndex ? "current" : ""}">${i + 1}. ${safe(r.title)}</span>`)
    .join("");
  return `<section class="rounds-strip"><span class="rounds-strip-label">Раунд ${game.currentRoundIndex + 1} / ${rounds.length}</span><div class="round-chips">${chips}</div></section>`;
}

function renderHost() {
  if (game.status === "round_results") return renderHostRoundResults();
  if (game.status === "round_over") return renderHostRoundOver();
  if (game.status === "round_review") return renderHostFilmAnswerReview();
  if (isManualRound()) return renderHostManualRound();
  const teams = readyTeams();
  const answeredNow = Object.keys(answersForCurrent()).length;
  return html`
    <section class="grid three">
      <div class="panel">
        <div class="panel-title">
          <h2>Команды</h2>
          <span class="status">${teams.length} в игре</span>
        </div>
        <div class="team-list">${game.teams.map(renderTeamCard).join("")}</div>
      </div>
      <div class="panel">
        <div class="panel-title">
          <div>
            <p class="eyebrow">${safe(currentRound().resource)}</p>
            <h2>${safe(currentRound().title)} · вопрос ${game.currentQuestionIndex + 1}/${currentRound().questions.length}</h2>
          </div>
          <span class="status" data-live="host-status">${renderGameStatusLabel()}</span>
        </div>
        <div class="question">
          <h2>${safe(currentQuestion().prompt)}</h2>
          ${renderQuestionMedia(currentQuestion())}
          ${renderQuestionInputPreview()}
        </div>
        ${renderHostQuestionActions()}
        ${renderScoreResult()}
        ${state.scoreEditor ? renderScoreEditor() : ""}
      </div>
      <div class="panel">
        <div class="panel-title">
          <h2>Ответы</h2>
          <span class="status ${answeredNow === teams.length && teams.length > 0 ? "" : "waiting"}">${answeredNow}/${teams.length}</span>
        </div>
        <div class="answer-list">${teams.map(renderAnswerCard).join("")}</div>
      </div>
    </section>
  `;
}

function renderHostQuestionActions() {
  if (game.status === "lobby") {
    return `<div class="actions"><button class="btn" data-action="start-round">Начать игру</button><button class="btn secondary" data-action="reset-test">Сбросить игру</button></div>`;
  }

  return html`
    <div class="actions">
      ${game.status === "round_running" ? `<button class="btn secondary" data-action="score-now">Закрыть вопрос</button>` : ""}
      ${game.status === "round_running" || game.status === "question_scored" ? `<button class="btn" data-action="next-question">К следующему вопросу</button>` : ""}
      ${game.status === "round_running" ? `<button class="btn secondary" data-action="toggle-pause">${game.paused ? "Продолжить" : "Пауза"}</button>` : ""}
      <button class="btn secondary" data-action="finish-round">Завершить раунд</button>
      <button class="btn secondary" data-action="recount">Пересчитать вопрос</button>
      <button class="btn secondary" data-action="toggle-score-editor">Поправить баллы</button>
      <button class="btn secondary" data-action="reset-test">Сбросить игру</button>
    </div>
  `;
}

function renderHostFilmAnswerReview() {
  return html`
    <section class="grid">
      <div class="panel">
        ${renderFilmAnswerReview("host")}
        <div class="actions">
          <button class="btn" data-action="next-question">${(game.currentReviewIndex || 0) >= currentRound().questions.length - 1 ? "Завершить раскрытие" : "Следующий ответ"}</button>
          <button class="btn secondary" data-action="finish-round">Показать итоги 3-2-1</button>
          <button class="btn secondary" data-action="reset-test">Сбросить игру</button>
        </div>
      </div>
      <div class="panel">
        <div class="panel-title"><h2>Ответы команд</h2></div>
        <div class="answer-list">${readyTeams().map(renderAnswerCard).join("")}</div>
      </div>
    </section>
  `;
}

function renderHostManualRound() {
  const round = currentRound();
  return html`
    <section class="grid">
      <div class="panel">
        <div class="panel-title">
          <div>
            <p class="eyebrow">${safe(round.resource)}</p>
            <h2>${safe(round.title)}</h2>
          </div>
          <span class="status">активность в зале</span>
        </div>
        ${renderActivityBlock(round)}
        ${renderManualAttemptControls()}
        ${renderManualWinnerPinControl()}
      </div>
      <div class="panel">
        <div class="panel-title">
          <h2>Баллы за активность</h2>
          <span class="status">вручную</span>
        </div>
        ${renderScoreEditor()}
      </div>
    </section>
  `;
}

function renderManualAttemptControls() {
  const attempt = game.manualAttempt || {};
  const isRunning = attempt.status === "running";
  const isPaused = attempt.status === "paused";

  return html`
    <div class="score-result">
      <strong>Попытка ${attempt.attemptNumber || 0}</strong>
      <span data-live="manual-attempt-status">${safe(manualAttemptStatusText())}</span>
    </div>
    <div class="actions manual-team-actions">
      ${readyTeams().map((item) => `<button class="btn secondary" data-action="start-manual-attempt" data-team="${item.id}" ${isRunning || isPaused ? "disabled" : ""}>Старт 60 сек: ${safe(item.displayName)}</button>`).join("")}
    </div>
    <div class="actions">
      ${isRunning || isPaused ? `<button class="btn secondary" data-action="toggle-manual-attempt-pause">${isPaused ? "Продолжить попытку" : "Пауза попытки"}</button>` : ""}
      ${isRunning || isPaused ? `<button class="btn secondary" data-action="finish-manual-attempt">Завершить попытку</button>` : ""}
      <button class="btn secondary" data-action="toggle-score-editor">Поправить баллы</button>
      <button class="btn" data-action="close-manual-round">Завершить раунд</button>
      <button class="btn secondary" data-action="reset-test">Сбросить игру</button>
    </div>
  `;
}

function renderManualWinnerPinControl() {
  const winner = game.teams.find((team) => team.id === Number(game.manualWinnerTeamId));
  return html`
    <div class="manual-winner">
      <p class="eyebrow">победитель активности</p>
      <h3>${winner ? `Засчитано: ${safe(winner.displayName)}` : "Введите PIN команды-победителя"}</h3>
      <div class="manual-winner-row">
        <input class="input" data-field="manual-winner-pin" inputmode="numeric" placeholder="Например: 102" />
        <button class="btn" data-action="award-manual-winner">Засчитать победителя</button>
      </div>
    </div>
  `;
}

function renderHostRoundOver() {
  return html`
    <section class="grid">
      <div class="panel">
        <div class="panel-title">
          <div>
            <p class="eyebrow">${safe(currentRound().resource)}</p>
            <h2>${safe(currentRound().title)}</h2>
          </div>
          <span class="status">раунд закончился</span>
        </div>
        <div class="score-result"><strong>Раунд закончился</strong><span>Нажмите «Показать итоги», когда будете готовы раскрыть результаты всем.</span></div>
        ${renderScoreResult()}
        <div class="actions">
          <button class="btn" data-action="finish-round">Показать итоги 3-2-1</button>
          <button class="btn secondary" data-action="recount">Пересчитать вопрос</button>
          <button class="btn secondary" data-action="toggle-score-editor">Поправить баллы</button>
          <button class="btn secondary" data-action="reset-test">Сбросить игру</button>
        </div>
        ${state.scoreEditor ? renderScoreEditor() : ""}
      </div>
      <div class="panel">
        <div class="panel-title"><h2>Ответы</h2></div>
        <div class="answer-list">${readyTeams().map(renderAnswerCard).join("")}</div>
      </div>
    </section>
  `;
}

function renderHostRoundResults() {
  return html`
    <section class="grid">
      <div class="panel">
        ${renderRoundResults()}
        <div class="actions">
          ${game.currentRoundIndex >= game.rounds.length - 1 ? `<button class="btn danger" data-action="final-reveal">Финал 3-2-1</button>` : `<button class="btn" data-action="next-round">Следующий раунд</button>`}
          <button class="btn secondary" data-action="hide-round-results">Скрыть итоги</button>
          <button class="btn secondary" data-action="toggle-score-editor">Поправить баллы</button>
          <button class="btn secondary" data-action="reset-test">Сбросить тест</button>
        </div>
        ${state.scoreEditor ? renderScoreEditor() : ""}
      </div>
      <div class="panel">
        <div class="panel-title"><h2>Общий счёт</h2></div>
        ${renderBarChart(false)}
      </div>
    </section>
  `;
}

function renderTeam() {
  const team = game.teams.find((item) => item.id === state.selectedTeamId) || game.teams[0];
  if (!hasCurrentTeamToken()) return renderTeamPinGate();
  if (game.viewer?.teamAccess === false) return renderTeamLocked(team);
  if (game.status === "lobby") return renderTeamSetup(team);
  if (!team.ready) return renderTeamSetupClosed(team);
  if (game.status === "round_results") return renderTeamRoundResults(team);
  if (game.status === "round_over") return renderTeamRoundOver(team);
  if (game.status === "round_review") return renderTeamFilmAnswerReview(team);
  if (isManualRound()) return renderTeamActivity(team);
  return renderTeamQuestion(team);
}

function renderTeamPinGate() {
  return html`
    <section class="setup-shell">
      <div class="panel setup-card">
        <p class="eyebrow">вход команды</p>
        <h2>Введите PIN команды</h2>
        <p class="muted">PIN выдаётся капитанам в день мероприятия. По нему приложение само определит номер команды.</p>
        ${renderTeamNotice()}
        <input class="input" data-field="team-pin" value="${safe(state.setupPin)}" inputmode="numeric" autocomplete="one-time-code" placeholder="Например: 101" />
        <button class="btn" data-action="login-team">Войти</button>
      </div>
    </section>
  `;
}

function renderTeamNotice() {
  if (!state.teamNotice) return "";
  return `<p class="team-notice">${safe(state.teamNotice)}</p>`;
}

function renderTeamSetup(team) {
  const selectedColor = state.setupColor || team.color;
  const selectedName = state.setupName || team.name || "";
  const takenColors = new Set(game.teams.filter((item) => item.id !== team.id && item.ready).map((item) => item.color));
  return html`
    <section class="setup-shell">
      <div class="panel setup-card">
        <p class="eyebrow">${safe(team.slotName)}</p>
        <h2>Название и цвет команды</h2>
        <p class="muted">До начала игры можно переименовать команду и выбрать цвет стикеров.</p>
        <label class="muted">Название команды</label>
        <input class="input" data-field="setup-team-name" value="${safe(selectedName)}" placeholder="Например: Архитекторы кайфа" />
        <label class="muted">Цвет стикеров и графика</label>
        <div class="color-grid">
          ${TEAM_COLORS.slice(0, 6).map((color) => {
            const taken = takenColors.has(color);
            const colorClass = taken ? "color-button taken" : "color-button";
            return `<button class="${colorClass} ${selectedColor === color ? "selected" : ""}" style="--team-color:${color}" data-color="${taken ? "" : color}" ${taken ? "disabled" : ""} title="${taken ? "Цвет уже занят" : "Выбрать цвет"}"></button>`;
          }).join("")}
        </div>
        <button class="btn" data-action="save-team-setup">${team.ready ? "Сохранить" : "Готово, играть"}</button>
      </div>
    </section>
  `;
}

function renderTeamSetupClosed(team) {
  return html`
    <section class="setup-shell">
      <div class="panel setup-card">
        <p class="eyebrow">${safe(team.slotName)}</p>
        <h2>Игра уже началась</h2>
        <p class="muted">Название и цвет команды меняются только до старта игры. Обратитесь к ведущей.</p>
      </div>
    </section>
  `;
}

function renderTeamLocked(team) {
  return html`
    <section class="setup-shell">
      <div class="panel setup-card">
        <p class="eyebrow">${safe(team.displayName)}</p>
        <h2>Нужен PIN команды</h2>
        <p class="muted">Эта команда защищена PIN. Войдите заново с кодом, который выдала ведущая.</p>
        <button class="btn" data-action="logout-team">Ввести PIN заново</button>
      </div>
    </section>
  `;
}

function renderTeamRoundOver(team) {
  return html`
    <section class="setup-shell">
      <div class="panel setup-card">
        <p class="eyebrow">${safe(team.displayName)} · ${safe(currentRound().title)}</p>
        <h2>Раунд закончился</h2>
        <p class="muted">Ведущая подводит итоги раунда. Экран обновится сам.</p>
      </div>
    </section>
  `;
}

function renderTeamBooting(team) {
  return html`
    <section class="setup-shell">
      <div class="panel setup-card">
        <p class="eyebrow">${safe(team.displayName)}</p>
        <h2>Готовим первый вопрос</h2>
        <p class="muted">Экран обновится сам, как только сервер синхронизирует команду.</p>
      </div>
    </section>
  `;
}

function renderTeamActivity(team) {
  return html`
    <section class="setup-shell">
      <div class="panel setup-card">
        <p class="eyebrow">${safe(team.displayName)} · ${safe(currentRound().title)}</p>
        <h2>Активность в зале</h2>
        <p class="muted" data-live="team-activity-status">${safe(teamActivityStatusText(team))}</p>
      </div>
    </section>
  `;
}

function renderTeamRoundResults(team) {
  return html`
    <section class="grid">
      <div class="panel">${renderRoundResults()}</div>
      <div class="panel">
        <p class="eyebrow">${safe(team.displayName)}</p>
        <h2>${team.totalScore} ${pointsLabel(team.totalScore)}</h2>
        <p class="muted">Ждём следующий раунд. Карта Miro остаётся отдельной вкладкой.</p>
      </div>
    </section>
  `;
}

function renderTeamFilmAnswerReview(team) {
  return html`
    <section class="team-play">
      <div class="panel team-question-panel">
        <div class="panel-title">
          <div>
            <p class="eyebrow">${safe(team.displayName)} · ${safe(currentRound().title)}</p>
            <h2>Правильный ответ</h2>
          </div>
          <span class="status">раскрытие</span>
        </div>
        ${renderFilmAnswerReview("team")}
      </div>
    </section>
  `;
}

function renderTeamQuestion(team) {
  const q = currentQuestion();
  const split = hasSideMedia();
  const inner = split
    ? `<div class="question-media-side">${renderQuestionMedia(q)}</div><div class="question-body-side"><h2>${safe(q.prompt)}</h2>${renderTeamAnswerControl(team)}</div>`
    : `<h2>${safe(q.prompt)}</h2>${renderQuestionMedia(q)}${renderTeamAnswerControl(team)}`;
  return html`
    <section class="team-play">
      <div class="panel team-question-panel">
        <div class="panel-title">
          <div>
            <p class="eyebrow">${safe(team.displayName)} · ${safe(currentRound().title)}</p>
            <h2>Вопрос ${game.currentQuestionIndex + 1}/${currentRound().questions.length}</h2>
          </div>
          <span class="status" data-live="team-status">${teamStatusLabel(team)}</span>
        </div>
        <div class="question ${split ? "question-split" : ""} ${isFilmRound() ? "film-question" : ""}">${inner}</div>
      </div>
    </section>
  `;
}

function teamStatusLabel(team) {
  if (game.paused) return "пауза";
  if (game.status === "question_scored") return "вопрос закрыт";
  if (answersForCurrent()[team.id]) return "ответ принят";
  return `можно отвечать · ${questionTimeLabel()}`;
}

function renderTeamAnswerControl(team) {
  const q = currentQuestion();
  if (game.status === "question_scored") {
    return `<div class="score-result"><strong>Ответы закрыты</strong><span>Сейчас автоматически появится следующий вопрос или итоги раунда.</span></div>`;
  }
  if (answersForCurrent()[team.id]) {
    return `<div class="score-result"><strong>Ответ принят</strong><span>Ждём окончание таймера. Ответы других команд скрыты.</span></div>`;
  }
  if (q.type === "choice") {
    return html`
      <div class="options">
        ${q.options.map((option, index) => {
          const letter = "ABCD"[index];
          const runaway = q.runawayOption === letter;
          const locked = isRunawayAnswerLocked(letter);
          const classes = [
            "option",
            state.selectedAnswer === letter ? "selected" : "",
            runaway ? "runaway-option" : "",
            runaway && locked ? "runaway-locked" : "",
            runaway && !locked ? "runaway-catchable" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const attrs = runaway ? `data-runaway-answer="${letter}"` : "";
          return `<button class="${classes}" data-answer="${letter}" ${attrs}>${letter}. ${safe(option)}${runaway ? runawayLabel(letter).replace("runaway-badge", "runaway-badge\" data-runaway-count=\"yes") : ""}</button>`;
        }).join("")}
      </div>
      <div class="answer-hint">Нажмите на вариант: он сразу отправится на сервер.</div>
    `;
  }
  if (q.type === "song") {
    return html`
      <input class="input answer-input" data-field="answer-artist" value="${safe(state.songArtist)}" placeholder="Исполнитель" />
      <input class="input answer-input song-second" data-field="answer-title" value="${safe(state.songTitle)}" placeholder="Название песни" />
      <div class="actions answer-actions"><button class="btn" data-action="submit-answer">Отправить ответ</button></div>
    `;
  }
  return html`
    <input class="input answer-input" data-field="answer-input" value="${safe(state.selectedAnswer)}" placeholder="${q.type === "number" ? "Введите число" : "Введите ответ"}" />
    <div class="actions answer-actions"><button class="btn" data-action="submit-answer">Отправить ответ</button></div>
  `;
}

function renderScreen() {
  if (game.status === "round_review") {
    return html`
      <section class="projector-screen">
        <div class="panel projector-panel">
          ${renderFilmAnswerReview("projector")}
        </div>
      </section>
    `;
  }
  if (game.status === "round_results") {
    return html`
      <section class="projector-screen">
        <div class="panel projector-panel">
          ${renderRoundResults()}
        </div>
      </section>
    `;
  }
  if (game.status === "round_over") {
    return html`
      <section class="projector-screen">
        <div class="panel projector-panel">
          <div class="question projector-question">
            <h2 class="projector-round-title">${safe(currentRound().title)}</h2>
            <h2 class="projector-prompt">Раунд закончился</h2>
            <p class="muted">Ведущая подводит итоги раунда.</p>
          </div>
        </div>
      </section>
    `;
  }
  if (isManualRound()) {
    const round = currentRound();
    const team = manualAttemptTeam();
    const attempt = game.manualAttempt || {};
    const attemptLine =
      attempt.status === "running" || attempt.status === "paused"
        ? `<div class="projector-head"><h2 class="projector-round-title">${safe(round.title)}</h2><span class="projector-timer" data-live="manual-attempt-time">${manualAttemptTimeLabel()}</span></div><p class="projector-meta">${safe(team ? team.displayName : "Команда")} · попытка ${attempt.attemptNumber || 1}</p>`
        : `<h2 class="projector-round-title">${safe(round.title)}</h2>`;
    return html`
      <section class="projector-screen">
        <div class="panel projector-panel">
          <div class="question projector-question">
            ${attemptLine}
            ${renderActivityBlock(round)}
          </div>
        </div>
      </section>
    `;
  }
  const q = currentQuestion();
  const split = hasSideMedia();
  const content = `
    <div class="projector-head">
      <h2 class="projector-round-title">${safe(currentRound().title)}</h2>
      ${renderProjectorTimer()}
    </div>
    <p class="projector-meta">Вопрос ${game.currentQuestionIndex + 1}/${currentRound().questions.length}</p>
    <h2 class="projector-prompt">${safe(q.prompt)}</h2>
    ${split ? "" : renderQuestionMedia(q)}
    ${renderQuestionInputPreview("projector")}
  `;
  return html`
    <section class="projector-screen">
      <div class="panel projector-panel">
        <div class="question projector-question ${split ? "question-split" : ""} ${isFilmRound() ? "film-question" : ""}">
          ${split ? `<div class="question-media-side">${renderQuestionMedia(q)}</div><div class="question-body-side">${content}</div>` : content}
        </div>
      </div>
    </section>
  `;
}

function renderProjectorTimer() {
  if (game.status === "round_running") return `<span class="projector-timer" data-live="projector-timer">${questionTimeLabel()}</span>`;
  if (game.status === "question_scored") return `<span class="projector-timer" data-live="projector-timer">закрыто</span>`;
  return `<span class="projector-timer quiet" data-live="projector-timer">готово</span>`;
}

function renderFilmAnswerReview(context = "team") {
  const q = currentReviewQuestion();
  const index = (game.currentReviewIndex || 0) + 1;
  const total = currentRound().questions.length;
  const image = q.revealImage || q.image || "";
  const title = q.answerTitle || q.answer || "Правильный ответ";
  return html`
    <div class="film-review ${context === "projector" ? "projector-review" : ""}">
      <p class="eyebrow">ответ ${index}/${total}</p>
      <img class="film-review-image" src="${safe(image)}" alt="${safe(title)}" />
      <div class="film-review-title">
        <span>Правильный ответ</span>
        <h2>${safe(title)}</h2>
      </div>
    </div>
  `;
}

function renderRoundCountdown() {
  const count = Math.max(1, game.roundCountdown ?? 3);
  return `<section class="panel countdown"><div><p class="eyebrow">итоги раунда</p><div class="countdown-number">${count}</div><h2>${safe(currentRound().title)}</h2></div></section>`;
}

function renderFinalReveal(mode) {
  const podium = getFinalPodium(game);
  if (mode === "countdown") {
    const count = Math.max(1, game.finalCountdown ?? 3);
    return `<section class="panel countdown"><div><p class="eyebrow">финальное раскрытие</p><div class="countdown-number">${count}</div><h2>Считаем вклад в Кайфоград...</h2></div></section>`;
  }
  if (mode === "congrats") return renderFinalCongrats(podium);
  return html`
    <section class="panel">
      <p class="eyebrow">главные архитекторы Кайфограда</p>
      <h2>Финальный топ</h2>
      <div class="podium">
        ${podium.map((team) => `<article class="podium-card" style="--team-color:${team.color};--podium-height:${team.place === 1 ? "360px" : team.place === 2 ? "300px" : "250px"}"><h3>${team.place} место</h3><h2>${safe(team.teamName)}</h2><strong>${team.totalScore} ${pointsLabel(team.totalScore)}</strong></article>`).join("")}
      </div>
      ${state.view === "host" ? `<div class="actions final-actions"><button class="btn" data-action="show-final-congrats">Показать поздравление</button></div>` : ""}
    </section>
  `;
}

function renderFinalCongrats(podium = getFinalPodium(game)) {
  const winner = podium.find((team) => team.place === 1) || podium.at(-1);
  return html`
    <section class="panel final-congrats">
      <img class="final-congrats-cat" src="assets/final-congrats-cat.png" alt="Котик поздравляет победителей" />
      <div class="final-congrats-copy">
        <p class="eyebrow">кайфоград построен</p>
        <div class="congrats-image">Поздравляем!</div>
        <h2>${safe(winner?.teamName || "Команда-победитель")}</h2>
        <p class="muted">Вы внесли самый большой вклад в развитие Кайфограда.</p>
        ${state.view === "host" ? `<div class="actions final-actions"><button class="btn" data-action="restart-game">Начать сначала</button></div>` : ""}
      </div>
    </section>
  `;
}

function renderCity() {
  const rounds = game.rounds?.length ? game.rounds : fullRounds;
  return html`
    <section class="grid">
      <div class="panel">
        <div class="panel-title">
          <div>
            <p class="eyebrow">живая карта</p>
            <h2>Кайфоград в Miro</h2>
          </div>
          <div class="actions">
            <button class="btn secondary" data-action="reload-miro">Перезагрузить карту</button>
            <a class="btn" href="${miroUrl}" target="_blank" rel="noreferrer">Открыть Miro</a>
          </div>
        </div>
        <div class="miro-frame">
          <iframe class="miro-embed" src="${miroEmbedUrl}" allow="fullscreen; clipboard-read; clipboard-write"></iframe>
        </div>
      </div>
      <div class="panel">
        <div class="panel-title">
          <h2>Ресурсы города</h2>
          <span class="status">${game.cityResources.length}/${rounds.length}</span>
        </div>
        <div class="city-map">
          ${rounds.map((round) => {
            const stickers = game.cityResources.filter((item) => item.resource === round.resource);
            return `<article class="district"><strong>${safe(round.resource)}</strong><p class="muted">${safe(resourceDescriptions[round.resource] || "")}</p>${stickers.map((item) => `<div class="sticker" style="--team-color:${item.color}">Раунд завершён<br>Победила команда ${item.teamId} — ${safe(item.teamName)}</div>`).join("")}</article>`;
          }).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderGameStatusLabel() {
  if (game.paused) return "пауза";
  if (game.status === "round_running") return `идёт · ${questionTimeLabel()}`;
  if (game.status === "question_scored") return "вопрос закрыт";
  if (game.status === "round_review") return "показываем ответы";
  if (game.status === "round_over") return "раунд закончился";
  if (game.status === "round_results") return "итоги раунда";
  return "ожидание старта";
}

function renderQuestionMedia(q) {
  if (q.image === undefined) return "";
  if (!q.image) return `<div class="question-image placeholder">Картинка появится здесь</div>`;
  return `<img class="question-image" src="${safe(q.image)}" alt="картинка вопроса" onerror="this.outerHTML='<div class=&quot;question-image placeholder&quot;>Картинка появится здесь</div>'" />`;
}

function renderQuestionInputPreview(mode = "") {
  const q = currentQuestion();
  const optionsClass = mode === "projector" ? "options projector-options" : "options";
  if (q.type === "choice") {
    return `<div class="${optionsClass}">${q.options.map((option, index) => `<div class="option">${"ABCD"[index]}. ${safe(option)}</div>`).join("")}</div>`;
  }
  if (q.type === "song") {
    return `<div class="panel mini-note"><span class="muted">Звучит песня · команды вписывают исполнителя и название</span></div>`;
  }
  return `<div class="panel mini-note"><span class="muted">${q.type === "number" ? "Ответ числом" : "Открытый ответ"} · команды видят поле ввода у себя</span></div>`;
}

function renderActivityBlock(round) {
  const image = round.image
    ? `<img class="activity-image" src="${safe(round.image)}" alt="${safe(round.title)}" />`
    : `<div class="activity-image placeholder">Сюда вставится картинка</div>`;
  return html`
    <div class="activity">
      ${image}
      <div class="score-result"><strong>Правила</strong><span>${safe(round.rules || "Правила впишет ведущая.")}</span></div>
    </div>
  `;
}

function renderTeamCard(team) {
  const answered = Boolean(answersForCurrent()[team.id]);
  const inQuestion = game.status === "round_running" && !isManualRound();
  const teamStateText = team.ready
    ? `${team.totalScore} ${pointsLabel(team.totalScore)} всего`
    : team.online
      ? "зашла по PIN"
      : "ещё не вошла";
  const badge = inQuestion
    ? `<span class="status ${answered ? "" : "waiting"}">${answered ? "ответила" : "ждёт"}</span>`
    : `<span class="status">${team.totalScore} ${pointsLabel(team.totalScore)}</span>`;
  return html`
    <article class="team-card" style="--team-color:${team.color}">
      <div class="team-row">
        <strong><span class="swatch"></span> ${safe(team.displayName)}</strong>
        ${badge}
      </div>
      <span class="muted">${safe(teamStateText)}</span>
    </article>
  `;
}

function renderAnswerCard(team) {
  const answer = answersForCurrent()[team.id];
  return html`
    <article class="answer-card" style="--team-color:${team.color}">
      <div class="team-row">
        <strong><span class="swatch"></span> ${safe(team.displayName)}</strong>
        <span class="status ${answer ? "" : "waiting"}">${answer ? "принят" : "нет ответа"}</span>
      </div>
      <span class="muted">${answer ? safe(formatAnswerValue(answer.value)) : "Команда пока думает"}</span>
    </article>
  `;
}

function formatAnswerValue(value) {
  if (value && typeof value === "object") return `${value.artist || "—"} — ${value.title || "—"}`;
  return value;
}

function renderScoreResult() {
  const result = scoreForCurrent();
  if (!result) return "";
  const q = currentQuestion();
  let body = "";
  if (result.type === "choice") {
    const names = result.correctTeamIds.map((id) => game.teams.find((team) => team.id === id)?.displayName).filter(Boolean);
    body = names.length ? `Баллы получили: ${names.join(", ")}. Правильный ответ: ${q.correct}.` : `Никто не ответил правильно. Правильный ответ: ${q.correct}.`;
  } else if (result.type === "number") {
    const ranked = result.ranked.filter((item) => item.points > 0);
    body = ranked.length
      ? ranked.map((item) => `${game.teams.find((team) => team.id === item.teamId)?.displayName}: +${item.points}`).join(" · ")
      : "Нет числовых ответов для зачёта.";
  } else {
    const names = result.correctTeamIds.map((id) => game.teams.find((team) => team.id === id)?.displayName).filter(Boolean);
    body = names.length ? `Баллы получили: ${names.join(", ")}.` : "Ручной зачёт пока без победителей.";
  }
  return `<div class="score-result"><strong>Результат засчитан</strong><span>${safe(body)}</span></div>`;
}

function renderRoundResults() {
  const result = game.roundResults[game.roundResults.length - 1];
  if (!result) return `<h2>Итоги раунда появятся здесь</h2>`;
  const winners = result.winners.length ? result.winners.map((winner) => winner.teamName).join(", ") : "нет победителя";
  return html`
    <p class="eyebrow">${safe(result.resource.name)}</p>
    <h2>Итоги раунда: ${safe(result.resource.roundTitle)}</h2>
    <div class="score-result">
      <strong>Ресурс получает: ${safe(winners)}</strong>
      <span>${safe(result.resource.name)} отправляется в Кайфоград.</span>
    </div>
    <div class="answer-list round-score-list">
      ${result.roundScores.map((team) => `<article class="answer-card" style="--team-color:${team.color}"><div class="team-row"><strong><span class="swatch"></span> ${safe(team.teamName)}</strong><span class="status">${team.score} ${pointsLabel(team.score)}</span></div></article>`).join("")}
    </div>
  `;
}

function renderScoreEditor() {
  const teams = readyTeams();
  if (!teams.length) return `<div class="score-editor"><p class="muted">Команды появятся здесь, как только они зайдут.</p></div>`;
  return html`
    <div class="score-editor">
      <div class="answer-list">
        ${teams.map((team) => `
          <article class="answer-card" style="--team-color:${team.color}">
            <div class="team-row">
              <strong><span class="swatch"></span> ${safe(team.displayName)}</strong>
              <span class="status">${team.totalScore} ${pointsLabel(team.totalScore)}</span>
            </div>
            <div class="actions score-buttons">
              <button class="btn secondary" data-action="adjust-score" data-team="${team.id}" data-delta="-1">-1</button>
              <button class="btn secondary" data-action="adjust-score" data-team="${team.id}" data-delta="1">+1</button>
              <button class="btn" data-action="adjust-score" data-team="${team.id}" data-delta="3">+3</button>
            </div>
          </article>`).join("")}
      </div>
    </div>
  `;
}

function renderBarChart(useRound = true) {
  const latestRound = game.roundResults[game.roundResults.length - 1];
  const scoreFor = (team) => {
    if (!useRound) return team.totalScore;
    if (game.status === "round_results" && latestRound) return latestRound.roundScores.find((item) => item.teamId === team.id)?.score || 0;
    return team.roundScore;
  };
  const max = Math.max(1, ...game.teams.map(scoreFor));
  return `<div class="bar-chart">${game.teams.map((team) => {
    const score = scoreFor(team);
    return `<div class="bar-row" style="--team-color:${team.color};--bar-width:${Math.max(4, (score / max) * 100)}%"><strong>${safe(team.displayName)}</strong><div class="bar-track"><div class="bar-fill"></div></div><strong>${score}</strong></div>`;
  }).join("")}</div>`;
}

async function submitCurrentAnswer(value) {
  if (!game || game.status !== "round_running" || isManualRound()) return;
  await postAction({ type: "submitAnswer", teamId: state.selectedTeamId, token: currentTeamToken(), value });
}

function confirmDangerousAction(action) {
  if (action === "reset-test") return window.confirm("Сбросить игру и все ответы команд?");
  if (action === "final-reveal") return window.confirm("Запустить финальное раскрытие 3-2-1?");
  return true;
}

document.addEventListener("click", async (event) => {
  const view = event.target.closest("[data-view]")?.dataset.view;
  if (view) {
    state.view = view;
    state.error = "";
    state.teamNotice = "";
    connectEvents();
    fetchState().catch(showError);
    render();
    return;
  }

  const color = event.target.closest("[data-color]")?.dataset.color;
  if (color) {
    state.setupColor = color;
    render();
    return;
  }

  const runawayButton = event.target.closest("[data-runaway-answer]");
  if (runawayButton && isRunawayAnswerLocked(runawayButton.dataset.runawayAnswer)) {
    moveRunawayButton(runawayButton);
    return;
  }

  const answer = event.target.closest("[data-answer]")?.dataset.answer;
  if (answer) {
    state.selectedAnswer = answer;
    render();
    submitCurrentAnswer(answer).catch(showError);
    return;
  }

  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;

  try {
    if (action === "unlock-host") {
      const code = document.querySelector("[data-field='host-code']")?.value?.trim();
      if (code !== hostCode) throw new Error("Неверный код ведущей");
      state.hostUnlocked = true;
      sessionStorage.setItem("kaifogradHostUnlocked", "yes");
      connectEvents();
      await fetchState();
      return;
    }

    if (action === "login-team") {
      const pin = document.querySelector("[data-field='team-pin']")?.value?.trim() || state.setupPin;
      const result = await postAction({ type: "loginTeam", pin }, { refresh: false });
      state.selectedTeamId = Number(result.teamId);
      saveTeamToken(result.teamId, result.token);
      sessionStorage.setItem("kaifogradTeamId", String(result.teamId));
      state.setupPin = "";
      state.setupName = "";
      state.setupColor = "";
      state.teamNotice = "";
      connectEvents();
      await fetchState();
      return;
    }

    if (action === "logout-team") {
      sessionStorage.removeItem(teamTokenKey(state.selectedTeamId));
      state.setupPin = "";
      state.setupName = "";
      state.setupColor = "";
      state.teamNotice = "";
      connectEvents();
      await fetchState();
      return;
    }

    if (action === "save-team-setup") {
      const team = game.teams.find((item) => item.id === state.selectedTeamId);
      const name = document.querySelector("[data-field='setup-team-name']")?.value?.trim() || team.slotName;
      const color = state.setupColor || team.color;
      const result = await postAction({ type: "join", teamId: team.id, token: currentTeamToken(), name, color, captain: "Команда" }, { refresh: false });
      saveTeamToken(team.id, result.token);
      sessionStorage.setItem("kaifogradTeamId", String(team.id));
      state.setupName = "";
      state.setupColor = "";
      state.teamNotice = "";
      connectEvents();
      await fetchState();
      return;
    }

    if (action === "submit-answer") {
      let value;
      if (currentQuestion().type === "song") {
        value = {
          artist: state.songArtist || document.querySelector("[data-field='answer-artist']")?.value || "",
          title: state.songTitle || document.querySelector("[data-field='answer-title']")?.value || "",
        };
      } else {
        value = state.selectedAnswer || document.querySelector("[data-field='answer-input']")?.value || "";
      }
      await submitCurrentAnswer(value);
      return;
    }

    const hostAction = {
      "start-round": { type: "startRound", code: hostCode },
      "score-now": { type: "scoreNow", code: hostCode },
      "next-question": { type: "nextQuestion", code: hostCode },
      recount: { type: "recount", code: hostCode },
      "close-manual-round": { type: "closeManualRound", code: hostCode },
      "finish-round": { type: "finishRound", code: hostCode },
      "toggle-pause": { type: "togglePause", code: hostCode },
      "finish-manual-attempt": { type: "finishManualAttempt", code: hostCode },
      "toggle-manual-attempt-pause": { type: "toggleManualAttemptPause", code: hostCode },
      "next-round": { type: "nextRound", code: hostCode },
      "hide-round-results": { type: "hideRoundResults", code: hostCode },
      "reset-test": { type: "reset", code: hostCode },
      "restart-game": { type: "reset", code: hostCode },
      "final-reveal": { type: "finalReveal", code: hostCode },
      "show-final-congrats": { type: "showFinalCongrats", code: hostCode },
    }[action];

    if (hostAction) {
      if (!confirmDangerousAction(action)) return;
      await postAction(hostAction);
      return;
    }

    if (action === "award-manual-winner") {
      const pin = document.querySelector("[data-field='manual-winner-pin']")?.value?.trim();
      await postAction({ type: "awardManualWinnerByPin", code: hostCode, pin });
      return;
    }

    if (action === "start-manual-attempt") {
      const target = event.target.closest("[data-team]");
      const teamId = Number(target?.dataset.team);
      if (teamId) await postAction({ type: "startManualAttempt", code: hostCode, teamId });
      return;
    }

    if (action === "toggle-score-editor") {
      state.scoreEditor = !state.scoreEditor;
      render();
      return;
    }

    if (action === "reload-miro") {
      const frame = document.querySelector(".miro-embed");
      if (frame) frame.src = miroEmbedUrl + (miroEmbedUrl.includes("?") ? "&" : "?") + "reload=" + Date.now();
      return;
    }

    if (action === "adjust-score") {
      const target = event.target.closest("[data-team]");
      const teamId = Number(target?.dataset.team);
      const delta = Number(target?.dataset.delta);
      if (teamId && Number.isFinite(delta)) {
        await postAction({ type: "adjustScore", code: hostCode, teamId, delta });
      }
    }
  } catch (error) {
    showError(error);
  }
});

document.addEventListener("mouseover", (event) => {
  const button = event.target.closest("[data-runaway-answer]");
  if (!button || !isRunawayAnswerLocked(button.dataset.runawayAnswer)) return;
  moveRunawayButton(button);
});

document.addEventListener("input", (event) => {
  const field = event.target.dataset.field;
  if (field === "answer-input") state.selectedAnswer = event.target.value;
  if (field === "answer-artist") state.songArtist = event.target.value;
  if (field === "answer-title") state.songTitle = event.target.value;
  if (field === "setup-team-name") state.setupName = event.target.value;
  if (field === "team-pin") state.setupPin = event.target.value;
});

function needsLiveTimerUpdate() {
  return game?.status === "round_running" || game?.manualAttempt?.status === "running";
}

setInterval(() => {
  if (!game) return;
  if (state.view === "city") return; // не дёргаем вкладку карты (иначе Miro-iframe перезагружается)
  if (needsLiveTimerUpdate()) updateLiveTimers();
  if (finalRevealMode() === "countdown") render();
}, 500);

connectEvents();
fetchState().catch(showError);
render();
