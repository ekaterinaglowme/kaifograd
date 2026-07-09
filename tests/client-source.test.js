import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("client uses the shared server instead of local browser game state", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(source, /EventSource/);
  assert.match(source, /\/api\/state/);
  assert.match(source, /\/api\/action/);
  assert.doesNotMatch(source, /createGame/);
  assert.doesNotMatch(source, /publishGame/);
  assert.doesNotMatch(source, /storageKey/);
});

test("client exposes Miro as the third shared tab", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  const hostTabIndex = source.indexOf('tab("host", "Ведущая")');
  const teamTabIndex = source.indexOf('tab("team", "Команда")');
  const miroTabIndex = source.indexOf('tab("city", "Miro")');

  assert.ok(hostTabIndex >= 0);
  assert.ok(teamTabIndex > hostTabIndex);
  assert.ok(miroTabIndex > teamTabIndex);
});

test("client exposes observer as the fourth shared tab", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  const miroTabIndex = source.indexOf('tab("city", "Miro")');
  const projectorTabIndex = source.indexOf('tab("screen", "Наблюдающий")');

  assert.ok(projectorTabIndex > miroTabIndex);
});

test("observer screen contains quiz and reveal content, not host controls", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const renderScreenStart = source.indexOf("function renderScreen()");
  const renderScreenEnd = source.indexOf("function renderFinalReveal", renderScreenStart);
  const renderScreenSource = source.slice(renderScreenStart, renderScreenEnd);

  assert.ok(renderScreenStart >= 0);
  assert.match(renderScreenSource, /renderBarChart/);
  assert.doesNotMatch(renderScreenSource, /renderScoreEditor/);
  assert.doesNotMatch(renderScreenSource, /data-action="adjust-score"/);
});

test("countdown cat overlay appears near the end and never blocks tapping", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // Кот подвешен и в экране команды (renderTeamQuestion), и у наблюдателя (renderScreen).
  const teamStart = source.indexOf("function renderTeamQuestion");
  const teamEnd = source.indexOf("function teamStatusLabel", teamStart);
  assert.match(source.slice(teamStart, teamEnd), /renderCountdownCat\(\)/);
  assert.match(source, /data-countdown-cat/);
  // Появляется за 5 секунд до конца ответа.
  assert.match(source, /left <= 5000/);
  // Оверлей не перехватывает нажатия — иначе мешал бы отвечать.
  const catCss = styles.slice(styles.indexOf(".countdown-cat-overlay"));
  assert.match(catCss, /pointer-events:\s*none/);
});

test("results cat shows on round results and both cat images exist as transparent PNGs", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // Кот-сердечко рендерится на итогах раунда у наблюдателя (в шапке «Общий счёт»).
  const screenStart = source.indexOf("function renderScreen()");
  const screenEnd = source.indexOf("function renderProjectorTimer", screenStart);
  assert.match(source.slice(screenStart, screenEnd), /renderResultsCat\(\)/);
  assert.match(source, /results-cat\.png/);
  assert.ok(styles.includes(".results-cat"), "стиль results-cat есть");

  // Обе картинки котов реально лежат в assets (ловит «ссылка есть, файла нет»).
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(new URL("../assets/countdown-cat.png", import.meta.url)), true);
  assert.equal(existsSync(new URL("../assets/results-cat.png", import.meta.url)), true);
});

test("round countdown lays the cat out on the left and the countdown text on the right", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function renderRoundCountdown()");
  const end = source.indexOf("function renderFinalReveal", start);
  const markup = source.slice(start, end);

  assert.match(markup, /countdown-layout/);
  // Кот идёт раньше блока с цифрой отсчёта — то есть слева от него.
  assert.ok(markup.indexOf("countdown-cat") < markup.indexOf("countdown-body"), "кот раньше текста отсчёта");
  assert.ok(markup.indexOf("countdown-body") < markup.indexOf("countdown-number"), "цифра внутри правого блока");
});

test("captain client no longer shows a waiting-for-host-start screen", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /Ждём старт раунда/);
  assert.doesNotMatch(source, /ведущая запустит раунд/);
});

test("team tab keeps setup/login flow free from global host error banners", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(source, /state\.error && state\.view !== "team"/);
  assert.match(source, /PIN выдаётся командам/);
  assert.doesNotMatch(source, /PIN выдаётся капитанам/);
});

test("app header uses final Kaifograd branding", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(source, /assets\/kaifograd-cat\.jpg/);
  assert.match(source, /tab\("team", "Команда"\)/);
  assert.doesNotMatch(source, /прототип/i);
  assert.doesNotMatch(source, />К</);
  assert.doesNotMatch(html, /прототип/i);
});

test("Miro board link uses the clean board URL", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(source, /https:\/\/miro\.com\/app\/board\/uXjVH--nKSM=\/"/);
  assert.doesNotMatch(source, /share_link_id/);
});

test("projector has dedicated compact classes for timer, prompt, and answers", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  assert.match(source, /projector-timer/);
  assert.match(source, /projector-prompt/);
  assert.match(source, /projector-options/);
  assert.match(styles, /\.projector-timer/);
  assert.match(styles, /\.projector-prompt/);
  assert.match(styles, /\.projector-options/);
});

test("team client stores and sends a private team token", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(source, /teamTokenKey/);
  assert.match(source, /currentTeamToken/);
  assert.match(source, /sessionStorage\.setItem\(teamTokenKey/);
  assert.match(source, /type: "submitAnswer"/);
  assert.match(source, /token: currentTeamToken\(\)/);
  assert.match(source, /roundIndex: game\.currentRoundIndex/);
  assert.match(source, /questionIndex: game\.currentQuestionIndex/);
});

test("team client has a locked occupied-team state", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(source, /renderTeamLocked/);
  assert.match(source, /Нужен PIN команды/);
  assert.match(source, /game\.viewer\?\.teamAccess === false/);
});

test("team setup marks taken colors and host destructive actions ask for confirmation", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  assert.match(source, /color-button taken/);
  assert.match(source, /disabled/);
  assert.match(source, /confirmDangerousAction/);
  assert.match(styles, /\.color-button\.taken/);
});

test("team client logs in by captain pin instead of choosing a team number", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(source, /renderTeamPinGate/);
  assert.match(source, /data-field="team-pin"/);
  assert.match(source, /type: "loginTeam"/);
  assert.doesNotMatch(source, /data-field="team-select"/);
});

test("team setup can be resaved in lobby after pin login", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(source, /action === "save-team-setup"/);
  assert.match(source, /token: currentTeamToken\(\)/);
  assert.match(source, /game\.status === "lobby"/);
});

test("host panel is a full control desk without Miro shortcut", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const hostStart = source.indexOf("function renderHost()");
  const hostEnd = source.indexOf("function renderTeam()", hostStart);
  const hostSource = source.slice(hostStart, hostEnd);

  assert.ok(hostStart >= 0);
  assert.match(hostSource, /data-action="start-round"/);
  assert.match(hostSource, /data-action="score-now"/);
  assert.match(hostSource, /data-action="next-question"/);
  assert.match(hostSource, /data-action="toggle-pause"/);
  assert.match(hostSource, /data-action="finish-round"/);
  assert.match(hostSource, /data-action="toggle-score-editor"/);
  assert.doesNotMatch(hostSource, /Открыть Miro/);
});

test("manual round has repeatable 60 second attempts for teams", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  assert.match(source, /start-manual-attempt/);
  assert.match(source, /finish-manual-attempt/);
  assert.match(source, /toggle-manual-attempt-pause/);
  assert.match(source, /manualAttempt/);
  assert.match(source, /activity-mascot/);
  assert.match(styles, /\.activity-rules span[\s\S]*font-size: clamp\(24px, 2\.2vw, 34px\)/);
  assert.match(source, /60 сек/);
});

test("host controls round results reveal with a 3-2-1 countdown", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

  assert.match(source, /hide-round-results/);
  assert.match(source, /renderRoundCountdown/);
  assert.match(server, /round_countdown/);
  assert.match(server, /showRoundResults/);
  assert.doesNotMatch(server, /questionResultPauseMs = 2500/);
});

test("client supports film answer review, manual winner PIN, and final congrats", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  assert.match(source, /renderFilmAnswerReview/);
  assert.match(source, /currentReviewQuestion/);
  assert.match(source, /data-field="manual-winner-pin"/);
  assert.match(source, /awardManualWinnerByPin/);
  assert.match(source, /renderFinalCongrats/);
  assert.match(styles, /\.film-review-image/);
  assert.match(styles, /\.projector-review \.film-review-image[\s\S]*max-height: min\(58vh, 620px\)/);
  assert.match(styles, /\.projector-review \.film-review-title h2[\s\S]*font-size: clamp\(44px, 5\.2vw, 74px\)/);
  assert.match(styles, /\.final-congrats/);
});

test("warmup runaway answer is implemented without external UI dependency", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const pkg = await readFile(new URL("../package.json", import.meta.url), "utf8");

  assert.match(source, /runaway-option/);
  assert.match(source, /data-runaway-answer/);
  assert.match(source, /function moveRunawayButton/);
  assert.doesNotMatch(pkg, /runaway|hover-effect/i);
});

test("live timer updates do not rerender answer inputs while typing", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const intervalStart = source.lastIndexOf("setInterval(");
  const intervalEnd = source.indexOf("connectEvents()", intervalStart);
  const intervalSource = source.slice(intervalStart, intervalEnd);

  assert.ok(intervalStart >= 0);
  assert.match(source, /function updateLiveTimers/);
  assert.match(source, /data-live="team-status"/);
  assert.match(source, /data-live="projector-timer"/);
  assert.match(intervalSource, /updateLiveTimers\(\)/);
  assert.doesNotMatch(intervalSource, /game\.status === "round_running"[\s\S]*render\(\)/);
});
