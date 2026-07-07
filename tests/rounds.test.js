import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fullRounds } from "../src/rounds.js";

test("warmup round is text-only without meme images", () => {
  const warmup = fullRounds[0];

  assert.equal(warmup.title, "Разминка");
  assert.equal(warmup.mediaSide, undefined);
  assert.equal(
    warmup.questions.some((question) => Object.hasOwn(question, "image")),
    false,
  );
});

test("film round uses blurred questions and original answer slides in order", () => {
  const filmRound = fullRounds[2];
  const titles = [
    "Отель Гранд Будапешт",
    "Шоу Трумана",
    "Мой сосед Тоторо",
    "В поисках Немо",
    "Касабланка",
    "Космическая одиссея 2001",
    "Бойцовский клуб",
  ];

  assert.equal(filmRound.title, "Угадай фильм");
  assert.equal(filmRound.answerReview, true);
  assert.equal(filmRound.questions.length, 7);
  filmRound.questions.forEach((question, index) => {
    assert.equal(question.answerTitle, titles[index]);
    assert.equal(question.image, `assets/film-${index + 1}-blur.png`);
    assert.equal(question.revealImage, `assets/film-${index + 1}-original.png`);
    assert.equal(existsSync(new URL(`../${question.image}`, import.meta.url)), true);
    assert.equal(existsSync(new URL(`../${question.revealImage}`, import.meta.url)), true);
  });
});

test("manual island round has the ball image and meme round uses available meme assets", () => {
  const islandRound = fullRounds[3];
  const memeRound = fullRounds[5];

  assert.equal(islandRound.image, "assets/island-balls.png");
  assert.equal(existsSync(new URL("../assets/island-balls.png", import.meta.url)), true);
  assert.equal(memeRound.questions[5].image, "assets/meme-6.png");
  assert.equal(existsSync(new URL("../assets/meme-6.png", import.meta.url)), true);
});
