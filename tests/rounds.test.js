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

test("warmup 'scariest sound' question offers Битрикс instead of Slack", () => {
  const question = fullRounds[0].questions.find((q) => q.prompt === "Какой самый страшный звук для айтишника?");
  assert.ok(question, "вопрос про страшный звук на месте");
  assert.deepEqual(question.options, ["Teams звонок", "«Есть минутка?»", "Будильник", "Битрикс уведомление"]);
  assert.equal(question.correct, "B");
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

test("manual island round has the balloon cat mascot and meme round uses available meme assets", () => {
  const islandRound = fullRounds[3];
  const memeRound = fullRounds[5];
  const memeImages = [
    "assets/mem1.jpeg",
    "assets/mem2.jpeg",
    "assets/mem3.jpg",
    "assets/mem4.jpeg",
    "assets/mem5.jpeg",
    "assets/mem6.png",
    "assets/mem7.png",
  ];

  assert.equal(islandRound.image, undefined);
  assert.equal(islandRound.mascotImage, "assets/balloon-cat.png");
  assert.equal(existsSync(new URL("../assets/balloon-cat.png", import.meta.url)), true);
  assert.equal(memeRound.questions.length, memeImages.length);
  memeRound.questions.forEach((question, index) => {
    assert.equal(question.image, memeImages[index]);
    assert.equal(existsSync(new URL(`../${question.image}`, import.meta.url)), true);
  });
});
