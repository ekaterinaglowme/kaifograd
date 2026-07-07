import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { action, loginAndJoin, startTestServer, state, waitForState } from "./helpers/integration-server.js";

const bundledPlaywright =
  "/Users/ekaterina/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright";

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const require = createRequire(import.meta.url);
    return require(process.env.PLAYWRIGHT_PACKAGE || bundledPlaywright);
  }
}

async function withBrowser(fn) {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

async function newPage(browser, baseUrl, path = "/") {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.goto(`${baseUrl}${path}`);
  return page;
}

async function loginTeamInUi(page, pin = "101") {
  await page.locator('[data-field="team-pin"]').fill(pin);
  await page.locator('[data-action="login-team"]').click();
  await page.locator('[data-field="setup-team-name"]').waitFor({ state: "visible" });
}

test("single team link opens PIN gate and has no team-number selector", async () => {
  const server = await startTestServer();
  try {
    await withBrowser(async (browser) => {
      const page = await newPage(browser, server.baseUrl, "/");

      await assertVisibleText(page, "Введите PIN команды");
      assert.equal(await page.locator('[data-field="team-pin"]').count(), 1);
      assert.equal(await page.locator('[data-field="team-select"]').count(), 0);
    });
  } finally {
    await server.stop();
  }
});

test("PIN 101 opens team 1 and captain can edit name and color before start", async () => {
  const server = await startTestServer();
  try {
    await withBrowser(async (browser) => {
      const page = await newPage(browser, server.baseUrl, "/");
      await loginTeamInUi(page, "101");

      await assertVisibleText(page, "Команда 1");
      await page.locator('[data-field="setup-team-name"]').fill("UI Команда");
      await page.locator('[data-color="#FF5FA2"]').click();
      await page.locator('[data-action="save-team-setup"]').click();
      await assertVisibleText(page, "Спасибо! Название сохранено");

      let game = await state(server.baseUrl);
      assert.equal(game.teams[0].displayName, "UI Команда");
      assert.equal(game.teams[0].color, "#FF5FA2");

      await page.locator('[data-action="edit-team-setup"]').click();
      await page.locator('[data-field="setup-team-name"]').fill("UI Команда 2");
      await page.locator('[data-action="save-team-setup"]').click();

      game = await state(server.baseUrl);
      assert.equal(game.teams[0].displayName, "UI Команда 2");
    });
  } finally {
    await server.stop();
  }
});

test("team PIN errors stay inside the login card without host-only warning", async () => {
  const server = await startTestServer();
  try {
    await withBrowser(async (browser) => {
      const page = await newPage(browser, server.baseUrl, "/");
      await page.locator('[data-field="team-pin"]').fill("999");
      await page.locator('[data-action="login-team"]').click();

      await assertVisibleText(page, "PIN не подошёл");
      const body = await page.locator("body").innerText();
      assert.doesNotMatch(body, /Нужно внимание|Только для ведущей/);
      assert.equal(await page.locator('[data-field="team-pin"]').count(), 1);
    });
  } finally {
    await server.stop();
  }
});

test("host sees a team immediately after PIN login before setup is saved", async () => {
  const server = await startTestServer();
  try {
    await withBrowser(async (browser) => {
      const teamPage = await newPage(browser, server.baseUrl, "/");
      await loginTeamInUi(teamPage, "101");

      const hostPage = await newPage(browser, server.baseUrl, "/?view=host");
      await hostPage.evaluate(() => sessionStorage.setItem("kaifogradHostUnlocked", "yes"));
      await hostPage.reload();

      await assertVisibleText(hostPage, "Команда 1");
      await assertVisibleText(hostPage, "зашла по PIN");
      const body = await hostPage.locator("body").innerText();
      assert.doesNotMatch(body, /Команда 1\\s+0 баллов\\s+ещё не вошла/);
    });
  } finally {
    await server.stop();
  }
});

test("warmup runaway answer cannot be submitted for 7 seconds, then submits", async () => {
  const server = await startTestServer();
  try {
    await withBrowser(async (browser) => {
      const page = await newPage(browser, server.baseUrl, "/");
      await loginTeamInUi(page, "101");
      await page.locator('[data-field="setup-team-name"]').fill("Бегущая кнопка");
      await page.locator('[data-action="save-team-setup"]').click();

      await action(server.baseUrl, { type: "startRound", code: "0306" });
      await action(server.baseUrl, { type: "nextQuestion", code: "0306" });
      await waitForState(server.baseUrl, (game) => game.currentRoundIndex === 0 && game.currentQuestionIndex === 1);
      await page.reload();
      await page.locator('[data-runaway-answer="D"]').waitFor({ state: "visible" });

      await page.locator('[data-runaway-answer="D"]').click({ force: true });
      let game = await state(server.baseUrl);
      assert.equal(game.answers["0:1"], undefined);

      await page.waitForTimeout(7300);
      await page.locator('[data-runaway-answer="D"]').click();
      await page.locator(".score-result").getByText("Ответ принят", { exact: true }).waitFor({ state: "visible" });

      game = await state(server.baseUrl);
      assert.equal(game.answers["0:1"][1].value, "D");
    });
  } finally {
    await server.stop();
  }
});

test("text input keeps focus and typed value across timer and SSE updates", async () => {
  const server = await startTestServer();
  try {
    await withBrowser(async (browser) => {
      const page = await newPage(browser, server.baseUrl, "/");
      const team1 = await loginAndJoin(server.baseUrl, "101", { name: "Пишущие", color: "#FF5FA2" });
      const team2 = await loginAndJoin(server.baseUrl, "102", { name: "Шум", color: "#4CC9F0" });
      await page.evaluate(([teamId, token]) => {
        sessionStorage.setItem("kaifogradTeamId", String(teamId));
        sessionStorage.setItem(`kaifogradTeamToken:${teamId}`, token);
      }, [team1.teamId, team1.token]);
      await page.reload();

      await action(server.baseUrl, { type: "nextRound", code: "0306" });
      await action(server.baseUrl, { type: "nextRound", code: "0306" });
      await page.locator('[data-field="answer-input"]').waitFor({ state: "visible" });
      await page.locator('[data-field="answer-input"]').fill("Матри");
      await action(server.baseUrl, { type: "submitAnswer", teamId: 2, token: team2.token, value: "Титаник" });
      await page.waitForTimeout(1300);

      const inputState = await page.evaluate(() => ({
        value: document.querySelector('[data-field="answer-input"]')?.value,
        focused: document.activeElement === document.querySelector('[data-field="answer-input"]'),
      }));
      assert.deepEqual(inputState, { value: "Матри", focused: true });
    });
  } finally {
    await server.stop();
  }
});

test("observer shows round countdown/results without admin controls", async () => {
  const server = await startTestServer();
  try {
    await withBrowser(async (browser) => {
      const page = await newPage(browser, server.baseUrl, "/?view=screen");
      await loginAndJoin(server.baseUrl, "101", { name: "Наблюдатели", color: "#FF5FA2" });
      await action(server.baseUrl, { type: "startRound", code: "0306" });
      for (let i = 0; i < 7; i += 1) await action(server.baseUrl, { type: "nextQuestion", code: "0306" });
      await action(server.baseUrl, { type: "finishRound", code: "0306" });

      await assertVisibleText(page, "итоги раунда");
      await page.locator(".countdown-number").waitFor({ state: "visible" });
      await waitForState(server.baseUrl, (game) => game.status === "round_results");
      await assertVisibleText(page, "Итоги раунда");

      const body = await page.locator("body").innerText();
      assert.doesNotMatch(body, /Поправить баллы|Сбросить игру|Следующий раунд/);
    });
  } finally {
    await server.stop();
  }
});

test("main views fit desktop and mobile viewports without horizontal overflow", async () => {
  const server = await startTestServer();
  try {
    await withBrowser(async (browser) => {
      const team1 = await loginAndJoin(server.baseUrl, "101", { name: "Адаптив", color: "#FF5FA2" });
      await action(server.baseUrl, { type: "startRound", code: "0306" });

      const urls = [
        "/?view=host",
        "/?view=team",
        "/?view=screen",
        "/?view=city",
      ];
      const viewports = [
        { width: 1366, height: 850 },
        { width: 390, height: 844 },
      ];

      for (const viewport of viewports) {
        for (const url of urls) {
          const page = await browser.newPage({ viewport });
          if (url.includes("view=host")) {
            await page.goto(`${server.baseUrl}${url}`);
            await page.evaluate(() => sessionStorage.setItem("kaifogradHostUnlocked", "yes"));
          } else if (url.includes("view=team")) {
            await page.goto(`${server.baseUrl}${url}`);
            await page.evaluate(([teamId, token]) => {
              sessionStorage.setItem("kaifogradTeamId", String(teamId));
              sessionStorage.setItem(`kaifogradTeamToken:${teamId}`, token);
            }, [team1.teamId, team1.token]);
          } else {
            await page.goto(`${server.baseUrl}${url}`);
          }
          await page.reload();
          await page.locator("main.app").waitFor({ state: "visible" });

          const metrics = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            bodyText: document.body.innerText,
            hasMiroFrame: Boolean(document.querySelector(".miro-embed")),
          }));
          assert.ok(metrics.scrollWidth <= metrics.clientWidth + 8, `${url} overflows at ${viewport.width}px`);
          if (url.includes("view=city")) assert.equal(metrics.hasMiroFrame, true);
          else assert.match(metrics.bodyText, /Кайфоград/);
          await page.close();
        }
      }
    });
  } finally {
    await server.stop();
  }
});

test("final congrats text stays inside the rectangle", async () => {
  const server = await startTestServer();
  try {
    await withBrowser(async (browser) => {
      await loginAndJoin(server.baseUrl, "101", { name: "Победители", color: "#FF5FA2" });
      await action(server.baseUrl, { type: "adjustScore", code: "0306", teamId: 1, delta: 8 });
      await action(server.baseUrl, { type: "showFinalCongrats", code: "0306" });

      const page = await newPage(browser, server.baseUrl, "/?view=screen");
      await page.locator(".final-congrats .congrats-image").waitFor({ state: "visible" });

      const metrics = await page.evaluate(() => {
        const box = document.querySelector(".congrats-image");
        const range = document.createRange();
        range.selectNodeContents(box);
        const textRect = range.getBoundingClientRect();
        const boxRect = box.getBoundingClientRect();
        return {
          textWidth: textRect.width,
          innerWidth: boxRect.width - 64,
        };
      });

      assert.ok(metrics.textWidth <= metrics.innerWidth, JSON.stringify(metrics));
    });
  } finally {
    await server.stop();
  }
});

test("final congrats shows the celebration cat image", async () => {
  const server = await startTestServer();
  try {
    await withBrowser(async (browser) => {
      await loginAndJoin(server.baseUrl, "101", { name: "Котики", color: "#FF5FA2" });
      await action(server.baseUrl, { type: "showFinalCongrats", code: "0306" });

      const page = await browser.newPage({ viewport: { width: 1366, height: 850 } });
      await page.goto(`${server.baseUrl}/?view=screen`);
      const cat = page.locator(".final-congrats-cat");
      await cat.waitFor({ state: "visible" });

      const metrics = await cat.evaluate((image) => {
        const rect = image.getBoundingClientRect();
        return {
          loaded: image.complete && image.naturalWidth > 0 && image.naturalHeight > 0,
          src: image.getAttribute("src"),
          width: rect.width,
          height: rect.height,
          viewportWidth: document.documentElement.clientWidth,
          viewportHeight: document.documentElement.clientHeight,
          scrollHeight: document.documentElement.scrollHeight,
        };
      });
      assert.equal(metrics.loaded, true);
      assert.match(metrics.src, /final-congrats-cat\.png$/);
      assert.ok(metrics.width >= metrics.viewportWidth * 0.35, JSON.stringify(metrics));
      assert.ok(metrics.height <= metrics.viewportHeight * 0.72, JSON.stringify(metrics));
      assert.ok(metrics.scrollHeight <= metrics.viewportHeight + 12, JSON.stringify(metrics));
    });
  } finally {
    await server.stop();
  }
});

test("host can restart the game from final congrats, observer cannot", async () => {
  const server = await startTestServer();
  try {
    await withBrowser(async (browser) => {
      await loginAndJoin(server.baseUrl, "101", { name: "Повтор", color: "#FF5FA2" });
      await action(server.baseUrl, { type: "showFinalCongrats", code: "0306" });

      const observer = await newPage(browser, server.baseUrl, "/?view=screen");
      await observer.locator(".final-congrats").waitFor({ state: "visible" });
      assert.equal(await observer.locator('[data-action="reset-test"]').count(), 0);

      const host = await newPage(browser, server.baseUrl, "/?view=host");
      await host.evaluate(() => sessionStorage.setItem("kaifogradHostUnlocked", "yes"));
      await host.reload();
      await host.locator(".final-congrats").waitFor({ state: "visible" });
      await host.getByRole("button", { name: "Начать сначала" }).click();

      const next = await state(server.baseUrl, "view=host&code=0306");
      assert.equal(next.status, "lobby");
      assert.equal(next.finalReveal, "hidden");
      assert.equal(next.teams.every((team) => !team.ready), true);
    });
  } finally {
    await server.stop();
  }
});

async function assertVisibleText(page, text) {
  await page.getByText(text, { exact: false }).waitFor({ state: "visible" });
}
