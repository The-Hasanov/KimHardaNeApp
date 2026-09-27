'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PartyGame, lanAddresses, openParty } = require('./party');

const QUESTIONS = [
  { uid: 'q1', text: 'Capital of Azerbaijan?', answer: 'Bakı', accepted_answers: 'Baku', comment: 'Since 1920', rekvizit_src: null },
  { uid: 'q2', text: 'Author of Xəmsə?', answer: 'Nizami Gəncəvi', accepted_answers: null, comment: null, rekvizit_src: null },
];
const judgeByText = async (question, given) => ({ verdict: given === question.answer ? 'correct' : 'wrong', similarity: null, closestAnswer: null });
const ROUND = { questions: QUESTIONS, secondsPerQuestion: 60, secondsBetweenQuestions: 0, pointsForCorrect: 1, pointsForWrong: 0 };
const newGame = () => new PartyGame({ judge: judgeByText });

test('joining needs a unique, non-empty name', () => {
  const game = newGame();
  const aysel = game.join('  Aysel  ');
  assert.equal(aysel.name, 'Aysel');
  assert.throws(() => game.join('aysel'), /taken/);
  assert.throws(() => game.join('   '), /name/);
  assert.equal(game.join('x'.repeat(40)).name.length, 24);
  assert.throws(() => game.playerByToken('forged'), /Join/);
});

test('answers are taken only while a question is open and stay hidden from players until the reveal', async () => {
  const game = newGame();
  const aysel = game.join('Aysel');
  const nicat = game.join('Nicat');
  assert.throws(() => game.submitAnswer(aysel.token, 'Bakı'), /closed/);
  game.startRound(ROUND);
  assert.equal(game.phase, 'question');
  assert.ok(!JSON.stringify(game.playerView(aysel)).includes('Bakı'));
  assert.ok(!JSON.stringify(game.playerView(aysel)).includes('Since 1920'));
  game.submitAnswer(aysel.token, 'Gəncə');
  game.submitAnswer(aysel.token, 'Bakı');
  game.submitAnswer(nicat.token, 'Şəki');
  assert.equal(game.playerView(aysel).myAnswer, 'Bakı');
  assert.equal(game.playerView(nicat).myAnswer, 'Şəki');
  await game.closeAnswers();
  assert.equal(game.phase, 'reveal');
  assert.throws(() => game.submitAnswer(nicat.token, 'Bakı'), /closed/);
  assert.deepEqual([game.playerView(aysel).reveal.isCorrect, game.playerView(nicat).reveal.isCorrect], [true, false]);
  assert.equal(game.playerView(aysel).reveal.answer, 'Bakı');
  game.finish();
});

test('scores follow the verdicts, host overrides and removed players', async () => {
  const game = newGame();
  const aysel = game.join('Aysel');
  const nicat = game.join('Nicat');
  game.startRound(ROUND);
  game.submitAnswer(aysel.token, 'Bakı');
  game.submitAnswer(nicat.token, 'Baku city');
  await game.closeAnswers();
  game.setCorrect(nicat.id, 0, true);
  assert.deepEqual(game.leaderboard().map(e => [e.name, e.score, e.rank]), [['Aysel', 1, 1], ['Nicat', 1, 1]]);
  game.next();
  game.submitAnswer(nicat.token, 'Nizami Gəncəvi');
  await game.closeAnswers();
  assert.deepEqual(game.leaderboard().map(e => [e.name, e.score, e.rank]), [['Nicat', 2, 1], ['Aysel', 1, 2]]);
  game.next();
  assert.equal(game.phase, 'finished');
  game.kick(nicat.id);
  assert.deepEqual(game.leaderboard().map(e => e.name), ['Aysel']);
});

test('the wait between questions shows the number first, and can be skipped', () => {
  const game = newGame();
  game.join('Aysel');
  game.startRound({ ...ROUND, secondsBetweenQuestions: 5 });
  assert.deepEqual([game.phase, game.index], ['waiting', 0]);
  assert.equal(game.playerView([...game.players.values()][0]).question, null);
  game.skipWait();
  assert.equal(game.phase, 'question');
  game.finish();
});

test('lan addresses list private IPv4 addresses of this computer', () => {
  for (const { address } of lanAddresses()) assert.match(address, /^\d+\.\d+\.\d+\.\d+$/);
});

test('the party server serves the player page, joins, streams state and rejects bad requests', async () => {
  const { game, close } = await openParty({ judge: judgeByText }, { port: 0 });
  const base = `http://127.0.0.1:${game.port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Join the game/);
    const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const { token } = await (await post('/join', { name: 'Aysel' })).json();
    assert.equal((await post('/join', { name: 'AYSEL' })).status, 409);
    assert.equal((await post('/answer', { token, answer: 'Bakı' })).status, 409);
    assert.equal((await post('/join', { name: 'x'.repeat(5000) })).status, 413);
    assert.equal((await fetch(`${base}/events?token=forged`)).status, 401);
    assert.equal((await fetch(`${base}/secret`)).status, 404);

    const events = await fetch(`${base}/events?token=${token}`);
    const reader = events.body.getReader();
    const firstEvent = JSON.parse(new TextDecoder().decode((await reader.read()).value).replace(/^data: /, ''));
    assert.deepEqual([firstEvent.phase, firstEvent.me.name, firstEvent.playerCount], ['lobby', 'Aysel', 1]);
    game.startRound(ROUND);
    const questionEvent = JSON.parse(new TextDecoder().decode((await reader.read()).value).replace(/^data: /, ''));
    assert.equal(questionEvent.question.text, 'Capital of Azerbaijan?');
    assert.equal((await post('/answer', { token, answer: 'Bakı' })).status, 200);
    reader.cancel();
  } finally {
    await close();
  }
});

test('points per correct and wrong answer; rounds keep or reset the scores', async () => {
  const game = newGame();
  const aysel = game.join('Aysel');
  const nicat = game.join('Nicat');
  const leila = game.join('Leila');
  const playRound = async answersByPlayer => {
    for (const position of [0, 1]) {
      for (const [player, answers] of answersByPlayer) if (answers[position] != null) game.submitAnswer(player.token, answers[position]);
      await game.closeAnswers();
      game.next();
    }
  };
  game.startRound({ ...ROUND, pointsForCorrect: 2, pointsForWrong: -1 });
  await playRound([[aysel, ['Bakı', 'Nizami Gəncəvi']], [nicat, ['Gəncə', 'Füzuli']], [leila, ['', null]]]);
  assert.equal(game.phase, 'finished');
  assert.deepEqual(game.leaderboard().map(e => [e.name, e.score]), [['Aysel', 4], ['Leila', 0], ['Nicat', -2]]);
  game.backToLobby({ keepScores: true });
  assert.deepEqual([game.phase, game.round], ['lobby', 1]);
  assert.deepEqual(game.playerView(nicat).leaderboard.map(e => e.score), [4, 0, -2]);
  game.startRound(ROUND);
  await playRound([[nicat, ['Bakı', 'Nizami Gəncəvi']]]);
  assert.deepEqual(game.leaderboard().map(e => [e.name, e.score, e.roundScore]), [['Aysel', 4, 0], ['Leila', 0, 0], ['Nicat', 0, 2]]);
  game.backToLobby({ keepScores: false });
  assert.deepEqual([game.round, game.leaderboard().map(e => e.score)], [0, [0, 0, 0]]);
});

test('the host can pause and resume the timer, and pick what the TV shows until the next question', async () => {
  const game = newGame();
  const aysel = game.join('Aysel');
  game.startRound({ ...ROUND, secondsPerQuestion: 30 });
  game.pause();
  const frozen = game.remainingMs();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(game.remainingMs(), frozen);
  assert.deepEqual([game.hostView().isPaused, game.playerView(aysel).isPaused], [true, true]);
  game.submitAnswer(aysel.token, 'Bakı');
  game.resume();
  assert.equal(game.hostView().isPaused, false);
  assert.ok(game.remainingMs() <= frozen && game.remainingMs() > frozen - 1000);
  game.setScreen('leaderboard');
  game.setScreen('anything');
  assert.equal(game.hostView().screen, 'leaderboard');
  await game.closeAnswers();
  assert.equal(game.hostView().screen, 'leaderboard');
  game.next();
  assert.equal(game.hostView().screen, 'game');
  game.pause();
  await game.closeAnswers();
  assert.deepEqual([game.phase, game.hostView().isPaused], ['reveal', false]);
  game.finish();
});

test('the TV page, join code and feed never carry the answer before the reveal, and follow night mode', async () => {
  const { game, close } = await openParty({ judge: judgeByText }, { port: 0 });
  const base = `http://127.0.0.1:${game.port}`;
  try {
    assert.match(await (await fetch(`${base}/tv`)).text(), /tv\/events/);
    assert.equal((await fetch(`${base}/tv/secret`)).status, 404);
    if (game.urls.length) assert.match(await (await fetch(`${base}/tv/join-qr.svg`)).text(), /^<svg/);

    const aysel = game.join('Aysel');
    game.startRound(ROUND);
    game.submitAnswer(aysel.token, 'Gəncə');
    const feed = (await fetch(`${base}/tv/events`)).body.getReader();
    const shownDuringQuestion = new TextDecoder().decode((await feed.read()).value);
    assert.match(shownDuringQuestion, /Capital of Azerbaijan\?/);
    for (const secret of ['Bakı', 'Baku', 'Since 1920', 'Gəncə']) assert.ok(!shownDuringQuestion.includes(secret), secret);
    feed.cancel();

    await game.closeAnswers();
    const shownAtReveal = game.tvView();
    assert.equal(shownAtReveal.question.answer, 'Bakı');
    assert.deepEqual(shownAtReveal.answers.map(answer => [answer.name, answer.isCorrect, answer.given]), [['Aysel', false, undefined]]);
    assert.equal(shownAtReveal.isNightMode, true);
    game.setNightMode(false);
    assert.equal(game.tvView().isNightMode, false);
  } finally {
    await close();
  }
});

test('the TV page script stays ES5, for the Chrome 47 web engine of 2017 Samsung TVs', () => {
  const script = fs.readFileSync(path.join(__dirname, 'party', 'tv.html'), 'utf8').split('<script>')[1].split('</script>')[0];
  const newerSyntax = [/=>/, /\b(let|const|class|async|await)\s/, /`/, /\?\./, /\?\?/, /\.\.\.\w/, /\.(replaceAll|replaceChildren|padStart|append)\(|\.isConnected\b/];
  for (const pattern of newerSyntax) assert.doesNotMatch(script, pattern);
});

test('autoplay moves on after the answer has been shown, can be paused, and ends the round by itself', async () => {
  const game = newGame();
  game.join('Aysel');
  game.startRound({ ...ROUND, secondsOnAnswer: 0.05 });
  await game.closeAnswers();
  assert.equal(game.phase, 'reveal');
  assert.ok(game.remainingMs() > 0);
  game.pause();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual([game.phase, game.hostView().isPaused], ['reveal', true]);
  game.resume();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual([game.phase, game.index], ['question', 1]);
  await game.closeAnswers();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(game.phase, 'finished');
});

test('without autoplay the answer stays up until the host moves on', async () => {
  const game = newGame();
  game.join('Aysel');
  game.startRound(ROUND);
  await game.closeAnswers();
  assert.deepEqual([game.phase, game.remainingMs()], ['reveal', null]);
  game.finish();
  game.backToLobby({ keepScores: true });
  assert.deepEqual([...game.shownUids], ['q1']);
});
