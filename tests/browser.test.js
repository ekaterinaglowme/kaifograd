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

test("PIN 101 opens team 1 and captain sets name and color, then sees a confirmation", async () => {
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

      const game = await state(server.baseUrl);
      assert.equal(game.teams[0].displayName, "UI Команда");
      assert.equal(game.teams[0].color, "#FF5FA2");

      // После сохранения кнопки правки названия/цвета нет — только подтверждение.
      assert.equal(await page.locator('[data-action="edit-team-setup"]').count(), 0);
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

test("warmup runaway answer cannot be submitted for 15 seconds, then submits", async () => {
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
      // Ставим на паузу, чтобы 20-секундный таймер вопроса не увёл его дальше, пока ждём 15 секунд;
      // счётчик «убегания» на клиенте всё равно идёт по реальному времени и разблокирует ответ.
      await action(server.baseUrl, { type: "togglePause", code: "0306" });
      await page.reload();
      await page.locator('[data-runaway-answer="D"]').waitFor({ state: "visible" });

      await page.locator('[data-runaway-answer="D"]').click({ force: true });
      let game = await state(server.baseUrl);
      assert.equal(game.answers["0:1"], undefined);

      await page.waitForTimeout(15300);
      await page.locator('[data-runaway-answer="D"]').click();
      await page.locator(".score-result").getByText("Ответ принят", { exact: true }).waitFor({ state: "visible" });

      game = await state(server.baseUrl);
      assert.equal(game.answers["0:1"][1].value, "D");
    });
  } finally {
    await server.stop();
  }
});

// Сценарий: на втором вопросе разминки вариант «Почти готово» убегает. Пока идёт отсчёт,
// на кнопке нет ничего, кроме названия ответа, и при приближении курсора она отпрыгивает
// в другую точку всего экрана (position: fixed), а не топчется в своей ячейке.
test("runaway answer shows only its label and jumps across the whole screen while locked", async () => {
  const server = await startTestServer();
  try {
    await withBrowser(async (browser) => {
      const team = await loginAndJoin(server.baseUrl, "101", { name: "Догоняшки", color: "#FF5FA2" });
      await action(server.baseUrl, { type: "startRound", code: "0306" }); // вопрос 1 — без убегания

      // Готовим страницу заранее, пока идёт первый вопрос. Тогда к моменту появления убегающей
      // кнопки её 15-секундный счётчик только начинается — и медленное окружение не съедает
      // окно (счётчик «убегания» на клиенте идёт по реальному времени, пауза его не морозит).
      const page = await newPage(browser, server.baseUrl, "/?view=team&team=1");
      await page.evaluate((token) => {
        sessionStorage.setItem("kaifogradTeamId", "1");
        sessionStorage.setItem("kaifogradTeamToken:1", token);
      }, team.token);
      await page.reload();
      await page.locator('[data-answer="A"]').first().waitFor({ state: "visible" });

      // Переходим на вопрос 2 (с убегающей кнопкой) и сразу замораживаем таймер вопроса.
      await action(server.baseUrl, { type: "nextQuestion", code: "0306" });
      await action(server.baseUrl, { type: "togglePause", code: "0306" });

      const btn = page.locator('[data-runaway-answer="D"]');
      await btn.waitFor({ state: "visible" });
      assert.equal((await btn.innerText()).trim(), "D. Почти готово");

      // Несколько раз подводим курсор — кнопка каждый раз отпрыгивает в новую точку экрана.
      const before = await btn.boundingBox();
      let flew = false;
      let maxJump = 0;
      for (let i = 0; i < 3; i += 1) {
        const box = await btn.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(120);
        if ((await btn.evaluate((el) => getComputedStyle(el).position)) === "fixed") flew = true;
        const after = await btn.boundingBox();
        maxJump = Math.max(maxJump, Math.hypot(after.x - before.x, after.y - before.y));
      }
      // Главный признак «по всему экрану» — кнопка вырвалась из сетки в position: fixed.
      assert.ok(flew, "кнопка вырвалась из сетки (position: fixed)");
      assert.ok(maxJump > 100, `кнопка отпрыгнула далеко (макс сдвиг ${Math.round(maxJump)}px)`);
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
      await assertVisibleText(page, "Общий счёт");

      const body = await page.locator("body").innerText();
      assert.doesNotMatch(body, /Поправить баллы|Сбросить игру|Следующий раунд/);
    });
  } finally {
    await server.stop();
  }
});

test("observer shows a welcome message before the game starts", async () => {
  const server = await startTestServer();
  try {
    await withBrowser(async (browser) => {
      const page = await newPage(browser, server.baseUrl, "/?view=screen");

      await assertVisibleText(page, "Игра скоро начнётся");
      await assertVisibleText(page, "Коллеги, садитесь поудобнее");
      await assertVisibleText(page, "занимайте места");
      await assertVisibleText(page, "Команд в игре: 0");
    });
  } finally {
    await server.stop();
  }
});

// Сценарий: до старта игры наблюдающий на большом экране (проекторе) видит слева
// картинку офиса, а справа от неё — текст «Игра скоро начнётся» уменьшенным шрифтом.
// На узком (мобильном) экране блоки складываются в столбик, чтобы ничего не сжималось.
test("observer welcome screen puts the image left and smaller text right on a wide screen", async () => {
  const server = await startTestServer();
  try {
    await withBrowser(async (browser) => {
      const page = await newPage(browser, server.baseUrl, "/?view=screen");
      await assertVisibleText(page, "Игра скоро начнётся");

      const image = await page.locator(".lobby-layout .lobby-office").boundingBox();
      const text = await page.locator(".lobby-layout .lobby-text").boundingBox();
      assert.ok(image && text, "на экране ожидания есть и картинка, и текстовый блок");
      // Картинка целиком левее текста, и они на одной высоте (рядом, а не друг под другом).
      assert.ok(image.x + image.width <= text.x, "картинка стоит слева от текста");
      assert.ok(text.y < image.y + image.height, "текст стоит рядом с картинкой, а не под ней");

      // Заголовок уменьшен: раньше на этой ширине он был бы ~51px (4vw), теперь заметно меньше.
      const titleSize = await page
        .locator(".projector-welcome .projector-round-title")
        .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
      assert.ok(titleSize <= 44, `заголовок стал меньше (сейчас ${titleSize}px)`);

      // На мобильной ширине — столбик: картинка сверху, текст снизу.
      await page.setViewportSize({ width: 375, height: 812 });
      const mobileImage = await page.locator(".lobby-layout .lobby-office").boundingBox();
      const mobileText = await page.locator(".lobby-layout .lobby-text").boundingBox();
      assert.ok(mobileImage.y + mobileImage.height <= mobileText.y + 1, "на телефоне текст уходит под картинку");
    });
  } finally {
    await server.stop();
  }
});

// Сценарий: в Miro-вкладке карточки ресурсов идут так, что «Театр» стоит перед «Счастьем
// жителей» (их поменяли местами относительно исходного порядка раундов).
test("miro tab shows the Театр card before the Счастье жителей card", async () => {
  const server = await startTestServer();
  try {
    await withBrowser(async (browser) => {
      // Не ждём полной загрузки страницы: вкладка Miro тянет живой iframe с miro.com,
      // и под нагрузкой событие load может не успеть за таймаут. Карточки рендерятся
      // локально — достаточно DOM и явного ожидания селектора ниже.
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
      await page.goto(`${server.baseUrl}/?view=city`, { waitUntil: "domcontentloaded" });
      await page.locator(".city-map .district").first().waitFor({ state: "visible" });

      const names = await page.locator(".city-map .district strong").allInnerTexts();
      const teatr = names.indexOf("Театр");
      const happiness = names.indexOf("Счастье жителей");

      assert.ok(teatr >= 0 && happiness >= 0, "обе карточки на месте");
      assert.ok(teatr < happiness, `Театр (${teatr}) стоит раньше Счастья жителей (${happiness})`);
    });
  } finally {
    await server.stop();
  }
});

test("team and observer both see total score after each round", async () => {
  const server = await startTestServer();
  try {
    await withBrowser(async (browser) => {
      const team = await loginAndJoin(server.baseUrl, "101", { name: "Счётчики", color: "#FF5FA2" });
      const teamPage = await newPage(browser, server.baseUrl, `/?view=team&team=1`);
      await teamPage.evaluate((token) => {
        sessionStorage.setItem("kaifogradTeamId", "1");
        sessionStorage.setItem("kaifogradTeamToken:1", token);
      }, team.token);
      await teamPage.reload();
      const observerPage = await newPage(browser, server.baseUrl, "/?view=screen");

      await action(server.baseUrl, { type: "startRound", code: "0306" });
      for (let i = 0; i < 7; i += 1) await action(server.baseUrl, { type: "nextQuestion", code: "0306" });
      await action(server.baseUrl, { type: "finishRound", code: "0306" });
      await waitForState(server.baseUrl, (game) => game.status === "round_results");

      await assertVisibleText(teamPage, "Общий счёт");
      await assertVisibleText(observerPage, "Общий счёт");
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
          // Шрифты на Linux-раннере CI рендерятся чуть шире, чем на macOS локально,
          // поэтому документ бывает на несколько px шире вьюпорта. Допускаем небольшой
          // зазор; реально сломанная вёрстка вылезает намного сильнее (дельта в тексте
          // ошибки). Проектор в 390px в жизни не используется — это только про CI.
          const overflow = metrics.scrollWidth - metrics.clientWidth;
          assert.ok(overflow <= 24, `${url} overflows by ${overflow}px at ${viewport.width}px`);
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

      // Тот же эффект: на Linux-раннере CI текст рендерится на ~2-3px шире, чем на
      // macOS, и упирается в бокс. Допускаем небольшой зазор.
      assert.ok(metrics.textWidth <= metrics.innerWidth + 6, JSON.stringify(metrics));
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

test("a stale answer submitted as the question changes shows a clear notice", async () => {
  const server = await startTestServer();
  try {
    await withBrowser(async (browser) => {
      const team = await loginAndJoin(server.baseUrl, "101", { name: "Гонка", color: "#FF5FA2" });
      await action(server.baseUrl, { type: "startRound", code: "0306" });

      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      // Замораживаем SSE: клиент застревает на Q0, пока сервер уедет на Q1.
      await page.route("**/api/events*", (route) => route.abort());
      await page.goto(`${server.baseUrl}/?view=team&team=1`);
      await page.evaluate(([id, tok]) => {
        sessionStorage.setItem("kaifogradTeamId", String(id));
        sessionStorage.setItem(`kaifogradTeamToken:${id}`, tok);
      }, [team.teamId, team.token]);
      await page.reload();
      await page.locator(".options .option").first().waitFor({ state: "visible" });

      await action(server.baseUrl, { type: "nextQuestion", code: "0306" });
      await page.locator(".options .option").nth(1).click(); // ответ на устаревший Q0

      await page.locator(".team-notice").getByText("вопрос уже сменился", { exact: false }).waitFor({ state: "visible" });
      const gameState = await state(server.baseUrl);
      assert.equal(Object.keys(gameState.answers).length, 0);
    });
  } finally {
    await server.stop();
  }
});

test("text answer submit is disabled until at least one character is typed", async () => {
  const server = await startTestServer();
  try {
    await withBrowser(async (browser) => {
      const team = await loginAndJoin(server.baseUrl, "101", { name: "Т", color: "#FF5FA2" });
      await action(server.baseUrl, { type: "nextRound", code: "0306" });
      await action(server.baseUrl, { type: "nextRound", code: "0306" }); // раунд 2 — текстовый

      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`${server.baseUrl}/?view=team&team=1`);
      await page.evaluate(([id, tok]) => {
        sessionStorage.setItem("kaifogradTeamId", String(id));
        sessionStorage.setItem(`kaifogradTeamToken:${id}`, tok);
      }, [team.teamId, team.token]);
      await page.reload();

      const submit = page.locator('.answer-actions [data-action="submit-answer"]');
      await page.locator('[data-field="answer-input"]').waitFor({ state: "visible" });
      assert.equal(await submit.isDisabled(), true);
      await page.locator('[data-field="answer-input"]').fill("Матрица");
      assert.equal(await submit.isDisabled(), false);
      await page.locator('[data-field="answer-input"]').fill("");
      assert.equal(await submit.isDisabled(), true);
    });
  } finally {
    await server.stop();
  }
});

test("a team without a session sees the PIN gate even during the round countdown", async () => {
  const server = await startTestServer();
  try {
    await withBrowser(async (browser) => {
      await loginAndJoin(server.baseUrl, "101", { name: "Игроки", color: "#FF5FA2" });
      await action(server.baseUrl, { type: "startRound", code: "0306" });
      await action(server.baseUrl, { type: "finishRound", code: "0306" }); // -> round_countdown (3-2-1)
      assert.equal((await state(server.baseUrl)).status, "round_countdown");

      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`${server.baseUrl}/?view=team&team=2`); // без токена
      await page.locator('[data-field="team-pin"]').waitFor({ state: "visible" });
      assert.equal(await page.locator(".countdown-number").count(), 0);
    });
  } finally {
    await server.stop();
  }
});

test("a malicious team name is HTML-escaped and does not execute", async () => {
  const server = await startTestServer();
  try {
    await withBrowser(async (browser) => {
      await loginAndJoin(server.baseUrl, "101", { name: "<img src=x onerror=window.__xss=1>", color: "#FF5FA2" });
      const host = await newPage(browser, server.baseUrl, "/?view=host");
      await host.evaluate(() => sessionStorage.setItem("kaifogradHostUnlocked", "yes"));
      await host.reload();
      await host.waitForTimeout(500);
      assert.equal(await host.evaluate(() => window.__xss), undefined);
      assert.equal(await host.evaluate(() => Boolean(document.querySelector('img[src="x"]'))), false);
    });
  } finally {
    await server.stop();
  }
});

test("after a host reset the team returns to the PIN gate with a notice and cleared token", async () => {
  const server = await startTestServer();
  try {
    await withBrowser(async (browser) => {
      const team = await loginAndJoin(server.baseUrl, "101", { name: "A", color: "#FF5FA2" });
      await action(server.baseUrl, { type: "startRound", code: "0306" });

      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`${server.baseUrl}/?view=team&team=1`);
      await page.evaluate(([id, tok]) => {
        sessionStorage.setItem("kaifogradTeamId", String(id));
        sessionStorage.setItem(`kaifogradTeamToken:${id}`, tok);
      }, [team.teamId, team.token]);
      await page.reload();
      await page.locator(".options .option").first().waitFor({ state: "visible" });

      await action(server.baseUrl, { type: "reset", code: "0306" });

      await page.locator('[data-field="team-pin"]').waitFor({ state: "visible" });
      await page.getByText("Игра перезапущена", { exact: false }).waitFor({ state: "visible" });
      assert.equal(await page.evaluate(() => sessionStorage.getItem("kaifogradTeamToken:1")), null);
    });
  } finally {
    await server.stop();
  }
});

test("the host gate unlocks with the correct code and rejects a wrong one", async () => {
  const server = await startTestServer();
  try {
    await withBrowser(async (browser) => {
      const page = await newPage(browser, server.baseUrl, "/?view=host");
      await page.locator("[data-field='host-code']").fill("9999");
      await page.locator("[data-action='unlock-host']").click();
      await page.getByText("Неверный код ведущей", { exact: false }).waitFor({ state: "visible" });
      await page.locator("[data-field='host-code']").fill("0306");
      await page.locator("[data-action='unlock-host']").click();
      await page.locator("[data-action='start-round']").waitFor({ state: "visible" });
    });
  } finally {
    await server.stop();
  }
});

async function assertVisibleText(page, text) {
  await page.getByText(text, { exact: false }).waitFor({ state: "visible" });
}
