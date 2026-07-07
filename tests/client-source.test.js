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

test("client exposes projector as the fourth shared tab", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  const miroTabIndex = source.indexOf('tab("city", "Miro")');
  const projectorTabIndex = source.indexOf('tab("screen", "Проектор")');

  assert.ok(projectorTabIndex > miroTabIndex);
});

test("projector screen contains only quiz content, not admin results", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const renderScreenStart = source.indexOf("function renderScreen()");
  const renderScreenEnd = source.indexOf("function renderFinalReveal", renderScreenStart);
  const renderScreenSource = source.slice(renderScreenStart, renderScreenEnd);

  assert.ok(renderScreenStart >= 0);
  assert.doesNotMatch(renderScreenSource, /Рейтинг/);
  assert.doesNotMatch(renderScreenSource, /renderBarChart/);
  assert.doesNotMatch(renderScreenSource, /renderRoundResults/);
});

test("captain client no longer shows a waiting-for-host-start screen", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /Ждём старт раунда/);
  assert.doesNotMatch(source, /ведущая запустит раунд/);
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
  assert.match(source, /type: "submitAnswer", teamId: state\.selectedTeamId, token: currentTeamToken\(\), value/);
});

test("team client has a locked occupied-team state", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(source, /renderTeamLocked/);
  assert.match(source, /Команда уже занята/);
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
