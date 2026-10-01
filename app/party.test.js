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

test('the host names the party: phones, TV and page titles show it, escaped, with a default', async () => {
  const { game, close } = await openParty({ judge: judgeByText, title: '  Friday   <b>quiz</b> ' }, { port: 0 });
  const base = `http://127.0.0.1:${game.port}`;
  try {
    assert.equal(game.title, 'Friday <b>quiz</b>');
    assert.match(await (await fetch(base)).text(), /<title>Friday &#60;b&#62;quiz&#60;\/b&#62;<\/title>/);
    assert.match(await (await fetch(`${base}/tv`)).text(), /<title>Friday &#60;b&#62;quiz&#60;\/b&#62; · TV<\/title>/);
    game.setTitle('   ');
    assert.equal(game.tvView().title, 'Quiz night');
    game.setTitle('Office cup');
    assert.equal(game.playerView(game.join('Aysel')).title, 'Office cup');
    assert.equal(game.hostView().title, 'Office cup');
  } finally {
    await close();
  }
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
  assert.deepEqual(game.leaderboard().map(e => [e.name, e.score, e.roundScore]), [['Aysel', 4, 0], ['Nicat', 0, 2], ['Leila', 0, 0]]);
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

test('the TV page, join code and feed never carry the answer before the reveal, and phones and TV follow night mode', async () => {
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
    assert.equal(game.playerView(aysel).isNightMode, false);
  } finally {
    await close();
  }
});

test('the TV page script stays ES5, for the Chrome 47 web engine of 2017 Samsung TVs', () => {
  const script = fs.readFileSync(path.join(__dirname, 'party', 'tv.html'), 'utf8').split('<script>')[1].split('</script>')[0];
  const newerSyntax = [/=>/, /\b(let|const|class|async|await)\s/, /`/, /\?\./, /\?\?/, /\.\.\.\w/, /\.(replaceAll|replaceChildren|padStart|append)\(|\.isConnected\b/];
  for (const pattern of newerSyntax) assert.doesNotMatch(script, pattern);
});

test('the player and TV page scripts parse', () => {
  for (const page of ['player.html', 'tv.html']) {
    const script = fs.readFileSync(path.join(__dirname, 'party', page), 'utf8').split('<script>').at(-1).split('</script>')[0];
    assert.doesNotThrow(() => new Function(script), page);
  }
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

test('phones wait for the host while an answer is not decided yet', async () => {
  const game = new PartyGame({ judge: async () => ({ verdict: 'unsure', similarity: null, closestAnswer: null }) });
  const aysel = game.join('Aysel');
  game.startRound(ROUND);
  game.submitAnswer(aysel.token, 'Bakı');
  await game.closeAnswers();
  assert.deepEqual([game.playerView(aysel).reveal.isPending, game.playerView(aysel).reveal.isCorrect], [true, false]);
  game.setCorrect(aysel.id, 0, true);
  assert.deepEqual([game.playerView(aysel).reveal.isPending, game.playerView(aysel).reveal.isCorrect], [false, true]);
  game.finish();
});

test('answers can wait for the end of the round: the host checks them between questions, phones learn nothing until the host reveals', async () => {
  const game = newGame();
  const aysel = game.join('Aysel');
  game.startRound({ ...ROUND, secondsBetweenQuestions: 5, revealAtEnd: true });
  game.skipWait();
  game.submitAnswer(aysel.token, 'Baki');
  await game.closeAnswers();
  assert.deepEqual([game.phase, game.index, game.hostView().previous.answers[0].given], ['waiting', 1, 'Baki']);
  game.setCorrect(aysel.id, 0, true);
  assert.deepEqual([game.playerView(aysel).me.score, game.playerView(aysel).reveal], [0, null]);
  assert.ok(!JSON.stringify(game.playerView(aysel)).includes('Bakı'));
  assert.ok(!JSON.stringify(game.tvView()).includes('Baki'));
  game.skipWait();
  assert.equal(game.hostView().previous, null);
  game.submitAnswer(aysel.token, 'Nizami Gəncəvi');
  await game.closeAnswers();
  assert.deepEqual([game.phase, game.playerView(aysel).me.score, game.playerView(aysel).reveal], ['judging', 0, null]);
  game.next();
  assert.deepEqual([game.phase, game.index, game.tvView().question.answer, game.playerView(aysel).me.score], ['reveal', 0, 'Bakı', 1]);
  game.next();
  assert.deepEqual([game.phase, game.index, game.tvView().question.answer, game.playerView(aysel).me.score], ['reveal', 1, 'Nizami Gəncəvi', 2]);
  game.next();
  assert.equal(game.phase, 'finished');
});

const goOnline = (game, player) => game.streams.add({ playerId: player.id, view: () => null, send() {}, sendEvent() {}, end() {} });

test('the host sees answers while the question runs and can call them early; a changed answer drops the call', async () => {
  const game = new PartyGame({ judge: async () => ({ verdict: 'wrong', similarity: null, closestAnswer: null }) });
  const aysel = game.join('Aysel');
  const nicat = game.join('Nicat');
  const leyla = game.join('Leyla');
  game.startRound(ROUND);
  game.submitAnswer(aysel.token, 'Bakı şəhəri');
  game.submitAnswer(nicat.token, 'Gəncə');
  assert.deepEqual(game.hostView().answers.map(a => [a.name, a.given]), [['Aysel', 'Bakı şəhəri'], ['Nicat', 'Gəncə']]);
  game.setCorrect(aysel.id, 0, true);
  game.setCorrect(nicat.id, 0, false);
  game.submitAnswer(leyla.token, 'baki seheri');
  assert.equal(game.hostView().answers.find(a => a.name === 'Leyla').hostCall, true, 'the same answer follows the host call');
  game.submitAnswer(aysel.token, 'Bakı şəhəri');
  game.submitAnswer(nicat.token, 'Şəki');
  assert.equal(game.hostView().answers.find(a => a.name === 'Aysel').hostCall, true, 'resending the same answer keeps the call');
  assert.equal(game.hostView().answers.find(a => a.name === 'Nicat').hostCall, undefined, 'a changed answer loses the call');
  await game.closeAnswers();
  assert.deepEqual(game.hostView().answers.map(a => [a.name, a.isCorrect]), [['Aysel', true], ['Nicat', false], ['Leyla', true]]);
  game.finish();
});

test('after the check, a host call applies to the same answers of other players', async () => {
  const game = new PartyGame({ judge: async () => ({ verdict: 'unsure', similarity: null, closestAnswer: null }) });
  const aysel = game.join('Aysel');
  const nicat = game.join('Nicat');
  const leyla = game.join('Leyla');
  game.startRound(ROUND);
  game.submitAnswer(aysel.token, 'Baki');
  game.submitAnswer(nicat.token, 'baki');
  game.submitAnswer(leyla.token, 'Baku');
  await game.closeAnswers();
  game.setCorrect(leyla.id, 0, false);
  game.setCorrect(aysel.id, 0, true);
  assert.deepEqual(game.hostView().answers.map(a => [a.name, a.isCorrect, a.decidedByHost]), [['Aysel', true, true], ['Nicat', true, true], ['Leyla', false, true]]);
  game.setCorrect(nicat.id, 0, false);
  assert.equal(game.hostView().answers.find(a => a.name === 'Aysel').isCorrect, true, 'a direct call is not overwritten by a later one');
  game.finish();
});

test('when every online player taps skip the game moves on, and the count starts again at each step', async () => {
  const game = newGame();
  const aysel = game.join('Aysel');
  const nicat = game.join('Nicat');
  game.join('Offline');
  goOnline(game, aysel);
  goOnline(game, nicat);
  game.startRound({ ...ROUND, secondsBetweenQuestions: 5 });
  assert.equal(game.phase, 'waiting');
  game.toggleSkip(aysel.token);
  assert.deepEqual([game.playerView(aysel).skip, game.hostView().skips.count], [{ isAvailable: true, isHostChecking: false, count: 1, of: 2, isMine: true }, 1]);
  game.toggleSkip(aysel.token);
  assert.equal(game.hostView().skips.count, 0, 'tapping again takes the skip back');
  game.toggleSkip(aysel.token);
  game.toggleSkip(nicat.token);
  assert.deepEqual([game.phase, game.hostView().skips.count], ['question', 0]);
  game.submitAnswer(aysel.token, 'Bakı');
  game.pause();
  game.toggleSkip(aysel.token);
  game.toggleSkip(nicat.token);
  assert.equal(game.phase, 'question', 'a paused game waits for the host');
  game.resume();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(game.phase, 'reveal');
  game.toggleSkip(aysel.token);
  game.kick(nicat.id);
  assert.deepEqual([game.phase, game.index], ['waiting', 1], 'removing the last player who had not skipped moves on too');
  assert.throws(() => game.toggleSkip('forged'), /Join/);
  game.finish();
  assert.throws(() => game.toggleSkip(aysel.token), /Nothing to skip/);
});

test('players can rename to a free name, and a removed player can join again', () => {
  const game = newGame();
  const aysel = game.join('Aysel');
  game.join('Nicat');
  assert.throws(() => game.rename(aysel.token, 'nicat'), /taken/);
  assert.throws(() => game.rename(aysel.token, '  '), /name/);
  assert.equal(game.rename(aysel.token, 'AYSEL').name, 'AYSEL', 'a player may change the case of the own name');
  assert.equal(game.rename(aysel.token, 'Aysel Q').name, 'Aysel Q');
  assert.equal(game.playerView(aysel).me.name, 'Aysel Q');
  game.kick(aysel.id);
  assert.throws(() => game.playerByToken(aysel.token), /Join/);
  assert.equal(game.join('Aysel Q').name, 'Aysel Q');
});

test('a finished round reports points, correct, wrong and unanswered questions per player, from the question they joined at', async () => {
  const reports = [];
  const game = new PartyGame({ judge: judgeByText, onRoundFinished: results => reports.push(results) });
  const aysel = game.join('Aysel');
  const nicat = game.join('Nicat');
  game.startRound({ ...ROUND, pointsForCorrect: 3, pointsForWrong: -1 });
  game.submitAnswer(aysel.token, 'Bakı');
  game.submitAnswer(nicat.token, 'Gəncə');
  await game.closeAnswers();
  const leyla = game.join('Leyla');
  game.next();
  game.submitAnswer(nicat.token, ' ');
  game.submitAnswer(leyla.token, 'Nizami Gəncəvi');
  await game.closeAnswers();
  game.next();
  assert.ok(reports[0].every(result => result.correctMs >= 0));
  assert.deepEqual(reports.map(results => results.map(({ correctMs, ...result }) => result)), [[
    { name: 'Aysel', points: 3, correct: 1, wrong: 0, unanswered: 1 },
    { name: 'Nicat', points: -1, correct: 0, wrong: 1, unanswered: 1 },
    { name: 'Leyla', points: 3, correct: 1, wrong: 0, unanswered: 0 },
  ]]);
});

test('the party server lets a phone check its place, rename and skip', async () => {
  const { game, close } = await openParty({ judge: judgeByText }, { port: 0 });
  const base = `http://127.0.0.1:${game.port}`;
  try {
    const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const { token } = await (await post('/join', { name: 'Aysel' })).json();
    await post('/join', { name: 'Nicat' });
    assert.deepEqual(await (await fetch(`${base}/me?token=${token}`)).json(), { name: 'Aysel', partyId: game.id });
    assert.equal((await fetch(`${base}/me?token=forged`)).status, 401);
    assert.equal((await post('/rename', { token, name: 'nicat' })).status, 409);
    assert.deepEqual(await (await post('/rename', { token, name: 'Aysel Q' })).json(), { name: 'Aysel Q' });
    assert.equal((await post('/skip', { token })).status, 409);
    const events = await fetch(`${base}/events?token=${token}`);
    const reader = events.body.getReader();
    await reader.read();
    assert.equal(game.hostView().players.find(p => p.name === 'Aysel Q').isOnline, true);
    game.startRound({ ...ROUND, secondsBetweenQuestions: 5 });
    assert.equal((await post('/skip', { token })).status, 200);
    assert.equal(game.phase, 'question', 'the only online player skipped the wait');
    reader.cancel();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(game.hostView().players.find(p => p.name === 'Aysel Q').isOnline, false);
  } finally {
    await close();
  }
});

test('leaving the page during a question warns the host only, counts each time and starts again at each question', async () => {
  const game = newGame();
  const aysel = game.join('Aysel');
  const nicat = game.join('Nicat');
  const nicatStream = { playerId: nicat.id, view: () => null, send() {}, end() {} };
  game.streams.add(nicatStream);
  game.reportAway(aysel.token);
  assert.equal(game.hostView().players[0].timesAway, 0, 'the lobby is not watched');
  game.startRound(ROUND);
  game.reportAway(aysel.token);
  game.reportAway(aysel.token);
  game.streams.delete(nicatStream);
  game.presenceChanged(nicat.id);
  assert.deepEqual(game.hostView().players.map(p => [p.name, p.timesAway]), [['Aysel', 2], ['Nicat', 1]]);
  assert.ok(!JSON.stringify(game.tvView()).includes('timesAway'));
  assert.ok(!('timesAway' in game.playerView(aysel)));
  await game.closeAnswers();
  game.reportAway(aysel.token);
  assert.equal(game.hostView().players[0].timesAway, 2, 'the answer screen is not watched, the count stays for review');
  game.next();
  assert.deepEqual(game.hostView().players.map(p => p.timesAway), [0, 0]);
  game.finish();
});

test('a player can leave the game from the phone and join again', async () => {
  const { game, close } = await openParty({ judge: judgeByText }, { port: 0 });
  const base = `http://127.0.0.1:${game.port}`;
  try {
    const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const { token } = await (await post('/join', { name: 'Aysel' })).json();
    assert.equal((await post('/away', { token })).status, 200);
    assert.equal((await post('/leave', { token })).status, 200);
    assert.equal(game.players.size, 0);
    assert.equal((await post('/leave', { token })).status, 401);
    assert.equal((await post('/join', { name: 'Aysel' })).status, 200);
  } finally {
    await close();
  }
});

test('the host sends one-way messages to every phone; they clear at the next question and never reach the TV', async () => {
  const game = newGame();
  const aysel = game.join('Aysel');
  game.announce('  Starting   in two minutes  ');
  assert.equal(game.playerView(aysel).announcement.text, 'Starting in two minutes');
  game.startRound(ROUND);
  assert.equal(game.playerView(aysel).announcement, null);
  game.announce('Think about the year');
  const { id } = game.playerView(aysel).announcement;
  assert.equal(game.hostView().announcement.id, id);
  assert.ok(!JSON.stringify(game.tvView()).includes('Think about'));
  game.announce('x'.repeat(1000));
  assert.equal(game.playerView(aysel).announcement.text.length, 300);
  assert.notEqual(game.playerView(aysel).announcement.id, id);
  game.announce('');
  assert.equal(game.playerView(aysel).announcement, null);
  game.announce('Clue');
  await game.closeAnswers();
  game.next();
  assert.equal(game.playerView(aysel).announcement, null);
  game.finish();
});

test('players cannot skip while the host checks answers, but the host can still move on', async () => {
  const unsureGame = new PartyGame({ judge: async () => ({ verdict: 'unsure', similarity: null, closestAnswer: null }) });
  const aysel = unsureGame.join('Aysel');
  goOnline(unsureGame, aysel);
  unsureGame.startRound(ROUND);
  unsureGame.submitAnswer(aysel.token, 'Baki');
  await unsureGame.closeAnswers();
  assert.deepEqual([unsureGame.phase, unsureGame.playerView(aysel).skip.isAvailable, unsureGame.playerView(aysel).skip.isHostChecking], ['reveal', false, true]);
  assert.throws(() => unsureGame.toggleSkip(aysel.token), /checking/);
  unsureGame.setCorrect(aysel.id, 0, true);
  assert.equal(unsureGame.playerView(aysel).skip.isAvailable, true);
  unsureGame.toggleSkip(aysel.token);
  assert.deepEqual([unsureGame.phase, unsureGame.index], ['question', 1]);
  unsureGame.finish();

  const game = newGame();
  const nicat = game.join('Nicat');
  goOnline(game, nicat);
  game.startRound({ ...ROUND, secondsBetweenQuestions: 30, revealAtEnd: true });
  assert.equal(game.playerView(nicat).skip.isAvailable, true, 'the wait before the first question has nothing to check');
  game.skipWait();
  game.submitAnswer(nicat.token, 'Bakı');
  await game.closeAnswers();
  assert.deepEqual([game.phase, game.index, game.playerView(nicat).skip.isAvailable], ['waiting', 1, false]);
  assert.throws(() => game.toggleSkip(nicat.token), /checking/);
  game.skipWait();
  assert.equal(game.phase, 'question', 'the host skips the wait as before');
  game.finish();
});

test('answer times are kept per answer, averaged over correct answers, and break ties on the leaderboard', async () => {
  const game = newGame();
  const aysel = game.join('Aysel');
  const nicat = game.join('Nicat');
  const leyla = game.join('Leyla');
  game.startRound(ROUND);
  const answerAt = (player, given, secondsIn) => {
    game.endsAt = Date.now() + (60 - secondsIn) * 1000;
    game.submitAnswer(player.token, given);
  };
  answerAt(aysel, 'Bakı', 20);
  answerAt(nicat, 'Bakı', 8);
  answerAt(leyla, 'Gəncə', 3);
  game.pause();
  answerAt(aysel, 'Bakı', 50);
  assert.equal(game.hostView().answers.find(a => a.name === 'Aysel').ms, 20000, 'sending the same answer again keeps its time');
  game.resume();
  await game.closeAnswers();
  assert.deepEqual(game.leaderboard().map(e => [e.name, e.score, e.avgSeconds, e.rank]), [['Nicat', 1, 8, 1], ['Aysel', 1, 20, 2], ['Leyla', 0, null, 3]]);
  assert.equal(game.playerView(nicat).reveal.seconds, 8);
  assert.equal(game.playerView(leyla).reveal.seconds, 3);
  game.next();
  answerAt(aysel, 'Nizami Gəncəvi', 2);
  await game.closeAnswers();
  assert.deepEqual(game.leaderboard().slice(0, 2).map(e => [e.name, e.score, e.avgSeconds]), [['Aysel', 2, 11], ['Nicat', 1, 8]]);
  game.next();
  game.backToLobby({ keepScores: true });
  game.startRound(ROUND);
  answerAt(nicat, 'Bakı', 10);
  await game.closeAnswers();
  assert.deepEqual(game.leaderboard().slice(0, 2).map(e => [e.name, e.score, e.avgSeconds, e.rank]), [['Nicat', 2, 9, 1], ['Aysel', 2, 11, 2]], 'kept scores keep their times too');
  game.finish();
});

test('players send reactions from the list to the TV and the host, one a second, unless the host turns them off', () => {
  const shownToHost = [];
  const shownOnTv = [];
  const game = new PartyGame({ judge: judgeByText, onReaction: reaction => shownToHost.push(reaction) });
  game.streams.add({ playerId: null, view: () => null, send() {}, sendEvent: (name, data) => shownOnTv.push([name, data.emoji, data.name]), end() {} });
  const aysel = game.join('Aysel');
  const nicat = game.join('Nicat');
  const shownToPlayers = [];
  for (const player of [aysel, nicat]) game.streams.add({ playerId: player.id, view: () => null, send() {}, sendEvent: (name, data) => shownToPlayers.push([player.name, data.emoji]), end() {} });
  assert.deepEqual(game.playerView(aysel).reactions, ['👏', '😂', '😮', '🤔', '🔥', '❤️', '😢', '🎉']);
  game.react(aysel.token, '🔥');
  assert.deepEqual(shownOnTv, [['reaction', '🔥', 'Aysel']]);
  assert.deepEqual(shownToPlayers, [['Nicat', '🔥']], 'other players see it, the sender already did');
  assert.equal(shownToHost[0].emoji, '🔥');
  assert.throws(() => game.react(aysel.token, '👏'), /Wait/);
  game.reactionTimes.set(aysel.id, Array.from({ length: 10 }, (_, i) => Date.now() - 50000 + i * 1000));
  assert.throws(() => game.react(aysel.token, '👏'), /10 reactions a minute\. More in 10 s/);
  game.reactionTimes.delete(aysel.id);
  assert.equal(game.react(aysel.token, '👏').left, 9);
  game.reactionTimes.delete(aysel.id);
  assert.throws(() => game.react(aysel.token, '💩'), /Pick one/);
  game.setReactionsOn(false);
  assert.deepEqual([game.playerView(aysel).reactions, game.hostView().areReactionsOn], [[], false]);
  assert.throws(() => game.react(aysel.token, '👏'), /off/);
  assert.throws(() => game.react('forged', '👏'), /Join/);
  game.close();
});

test('the party server takes reactions and streams them to the TV', async () => {
  const { game, close } = await openParty({ judge: judgeByText }, { port: 0 });
  const base = `http://127.0.0.1:${game.port}`;
  try {
    const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const { token } = await (await post('/join', { name: 'Aysel' })).json();
    const tv = (await fetch(`${base}/tv/events`)).body.getReader();
    await tv.read();
    assert.equal((await post('/react', { token, emoji: '🎉' })).status, 200);
    const event = new TextDecoder().decode((await tv.read()).value);
    assert.match(event, /^event: reaction\ndata: .*"emoji":"🎉".*"name":"Aysel"/);
    assert.equal((await post('/react', { token, emoji: '🎉' })).status, 429);
    tv.cancel();
  } finally {
    await close();
  }
});

test('the host app queues reactions: five at a time on the TV, two at a time on phones, stale ones dropped', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const advance = ms => {
    for (let passed = 0; passed < ms; passed += 100) t.mock.timers.tick(100);
  };
  const onTv = [];
  const onPhone = [];
  const game = new PartyGame({ judge: judgeByText, onReaction: reaction => onTv.push(reaction.name) });
  const players = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(name => game.join(name));
  const watcher = game.join('Watcher');
  game.streams.add({ playerId: watcher.id, view: () => null, send() {}, sendEvent: (name, data) => onPhone.push(data.name), end() {} });
  for (const player of players) game.react(player.token, '👏');
  assert.deepEqual([onTv, onPhone], [['A', 'B', 'C', 'D', 'E'], ['A', 'B']]);
  advance(3000);
  assert.deepEqual([onTv.length, onPhone], [5, ['A', 'B', 'C', 'D']], 'phones free their two places after 3 s');
  advance(1200);
  assert.deepEqual([onTv, onPhone.length], [['A', 'B', 'C', 'D', 'E', 'F', 'G'], 4]);
  advance(3000);
  assert.deepEqual(onPhone, ['A', 'B', 'C', 'D', 'E', 'F']);
  advance(3000);
  assert.deepEqual(onPhone, ['A', 'B', 'C', 'D', 'E', 'F'], 'G waited more than 8 s for a place on phones, so it is dropped');
  for (const player of players) {
    game.reactionTimes.delete(player.id);
    game.react(player.token, '🔥');
  }
  advance(9000);
  assert.equal(onPhone.length, 6 + 6);
  game.close();
});

test('videos and audio stream to the TV and phones in ranges, so they can seek and play on iPhones', async () => {
  const video = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'quiz-video-')), 'clip.mp4');
  fs.writeFileSync(video, Buffer.from('0123456789abcdefghij'));
  const { pathToFileURL } = require('node:url');
  const questions = [{ ...QUESTIONS[0], rekvizit_src: pathToFileURL(video).href, rekvizit_kind: 'video' }, QUESTIONS[1]];
  const { game, close } = await openParty({ judge: judgeByText }, { port: 0 });
  const base = `http://127.0.0.1:${game.port}`;
  try {
    const aysel = game.join('Aysel');
    game.startRound({ ...ROUND, questions });
    assert.deepEqual([game.tvView().question.rekvizit_kind, game.playerView(aysel).question.handoutKind], ['video', 'video']);
    const whole = await fetch(`${base}/tv/handout?question=0`);
    assert.deepEqual([whole.status, whole.headers.get('content-type'), whole.headers.get('accept-ranges'), await whole.text()], [200, 'video/mp4', 'bytes', '0123456789abcdefghij']);
    const part = await fetch(`${base}/handout?token=${aysel.token}&question=0`, { headers: { Range: 'bytes=5-9' } });
    assert.deepEqual([part.status, part.headers.get('content-range'), await part.text()], [206, 'bytes 5-9/20', '56789']);
    const tail = await fetch(`${base}/tv/handout?question=0`, { headers: { Range: 'bytes=-3' } });
    assert.deepEqual([tail.status, await tail.text()], [206, 'hij']);
    assert.equal((await fetch(`${base}/tv/handout?question=0`, { headers: { Range: 'bytes=50-' } })).status, 416);
  } finally {
    game.finish();
    await close();
  }
});

const THREE_QUESTIONS = [...QUESTIONS, { uid: 'q3', text: 'Longest river?', answer: 'Kür', accepted_answers: null, comment: null, rekvizit_src: null }];

async function playQuestion(game, answers) {
  for (const [player, given] of answers) game.submitAnswer(player.token, given);
  await game.closeAnswers();
}

test('a round with a point pool refuses to start when there are more questions than picks', () => {
  const game = newGame();
  game.join('Aysel');
  const pointSystem = { name: 'Tight', mode: 'pool', pool: [{ points: 10, uses: 1 }, { points: 30, uses: 1 }] };
  assert.throws(() => game.startRound({ ...ROUND, questions: THREE_QUESTIONS, pointSystem }), /3 questions.*only 2 picks/);
  assert.equal(game.phase, 'lobby');
  game.startRound({ ...ROUND, pointSystem });
  assert.equal(game.phase, 'question');
});

test('players pick pool values within their uses, and an unpicked question takes the lowest free value', async () => {
  const game = newGame();
  const aysel = game.join('Aysel');
  const nicat = game.join('Nicat');
  const pointSystem = { name: 'Pool', mode: 'pool', pool: [{ points: 10, uses: 2 }, { points: 20, wrong: -10, uses: 1 }, { points: 30, wrong: -20, unanswered: -10, uses: 1 }] };
  game.startRound({ ...ROUND, questions: THREE_QUESTIONS, pointSystem });
  assert.deepEqual(game.playerView(aysel).stake, { pick: 0, isPicked: false, isRisked: false, usesLeft: [2, 1, 1], risksLeft: 0 });
  game.setStake(aysel.token, { pick: 2 });
  assert.throws(() => game.setStake(aysel.token, { pick: 5 }), /Pick/);
  assert.throws(() => game.setStake(aysel.token, { isRisked: true }), /no risk/);
  await playQuestion(game, [[aysel, 'Bakı'], [nicat, 'Gəncə']]);
  assert.equal(game.playerView(aysel).reveal.points, 30);
  assert.equal(game.playerView(nicat).reveal.points, 0);
  game.next();
  assert.deepEqual(game.playerView(aysel).stake.usesLeft, [2, 1, 0]);
  assert.throws(() => game.setStake(aysel.token, { pick: 2 }), /No 30s left/);
  game.setStake(aysel.token, { pick: 1 });
  game.setStake(nicat.token, { pick: 2 });
  await playQuestion(game, [[aysel, 'Səməd Vurğun']]);
  assert.equal(game.playerView(aysel).reveal.points, -10);
  assert.equal(game.playerView(nicat).reveal.points, -10);
  assert.deepEqual(game.leaderboard().map(entry => [entry.name, entry.score]), [['Aysel', 20], ['Nicat', -10]]);
  assert.equal(game.hostView().answers[0].stake.pick, 1);
});

test('risk uses the risk points and runs out at the limit, and an unanswered risk is not used up', async () => {
  const game = newGame();
  const aysel = game.join('Aysel');
  const pointSystem = { name: 'Risky', simple: { correct: 3, wrong: -1, unanswered: 0 }, risk: { isOn: true, correct: 6, wrong: -6, limit: 1 } };
  game.startRound({ ...ROUND, questions: THREE_QUESTIONS, pointSystem });
  game.setStake(aysel.token, { isRisked: true });
  await playQuestion(game, []);
  assert.equal(game.playerView(aysel).reveal.points, 0);
  game.next();
  assert.equal(game.playerView(aysel).stake.risksLeft, 1);
  game.setStake(aysel.token, { isRisked: true });
  game.setStake(aysel.token, { isRisked: false });
  game.setStake(aysel.token, { isRisked: true });
  await playQuestion(game, [[aysel, 'Nizami Gəncəvi']]);
  assert.equal(game.playerView(aysel).reveal.points, 6);
  game.next();
  assert.equal(game.playerView(aysel).stake.risksLeft, 0);
  assert.throws(() => game.setStake(aysel.token, { isRisked: true }), /No risks left/);
});

test('streak bonuses and all or nothing count through a whole round and reach the all-time results', async () => {
  const reports = [];
  const game = new PartyGame({ judge: judgeByText, onRoundFinished: results => reports.push(results) });
  const aysel = game.join('Aysel');
  const nicat = game.join('Nicat');
  const pointSystem = { name: 'Perfect', simple: { correct: 2 }, streak: { isOn: true, from: 2, bonus: 1 }, allOrNothing: { isOn: true }, perfectBonus: { isOn: true, points: 5 } };
  game.startRound({ ...ROUND, questions: THREE_QUESTIONS, pointSystem });
  await playQuestion(game, [[aysel, 'Bakı'], [nicat, 'Bakı']]);
  game.next();
  await playQuestion(game, [[aysel, 'Nizami Gəncəvi'], [nicat, 'Nizami Gəncəvi']]);
  assert.equal(game.playerView(aysel).reveal.streakBonus, 1);
  game.next();
  await playQuestion(game, [[aysel, 'Kür'], [nicat, 'Araz']]);
  assert.equal(game.playerView(nicat).reveal.isRoundLost, true);
  assert.equal(game.playerView(aysel).reveal.perfectBonus, 5);
  game.next();
  assert.equal(game.phase, 'finished');
  assert.deepEqual(game.leaderboard().map(entry => [entry.name, entry.score]), [['Aysel', 2 + 3 + 3 + 5], ['Nicat', 0]]);
  assert.deepEqual(reports[0].map(({ name, points }) => [name, points]), [['Aysel', 13], ['Nicat', 0]]);
});

test('show pages play before the round, each for its seconds, can be skipped or paused, and serve their pictures', async () => {
  const picture = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'show-')), 'welcome.png');
  fs.writeFileSync(picture, Buffer.from('89504e470d0a1a0a', 'hex'));
  const { game, close } = await openParty({ judge: judgeByText }, { port: 0 });
  const base = `http://127.0.0.1:${game.port}`;
  try {
    const aysel = game.join('Aysel');
    const pages = [
      { title: 'Welcome', seconds: 5, blocks: [{ type: 'text', text: 'Hello everyone', isLarge: true }, { type: 'image', image: 'own-image:x.png', src: require('node:url').pathToFileURL(picture).href }] },
      { title: 'Round 1 rules', seconds: 8, blocks: [{ type: 'text', text: 'No phones.' }] },
    ];
    game.startRound({ ...ROUND, showPages: pages });
    assert.equal(game.phase, 'show');
    assert.ok(game.remainingMs() > 4000 && game.remainingMs() <= 5000);
    const tv = game.tvView().showPage;
    assert.deepEqual([tv.index, tv.total, tv.title, tv.blocks[0].text, tv.blocks[1].src], [0, 2, 'Welcome', 'Hello everyone', '/tv/show-image?page=0&block=1']);
    assert.equal(game.playerView(aysel).showPage.blocks[1].src, '/show-image?page=0&block=1');
    assert.equal(game.playerView(aysel).question, null);
    assert.equal((await fetch(`${base}/tv/show-image?page=0&block=1`)).status, 200);
    assert.equal((await fetch(`${base}/tv/show-image?page=0&block=0`)).status, 404);
    assert.equal((await fetch(`${base}/show-image?page=0&block=1`)).status, 401);
    assert.equal((await fetch(`${base}/show-image?page=0&block=1&token=${aysel.token}`)).status, 200);
    game.pause();
    assert.ok(game.hostView().isPaused);
    game.resume();
    game.skipWait();
    assert.deepEqual([game.phase, game.showIndex, game.hostView().showPage.title], ['show', 1, 'Round 1 rules']);
    assert.equal((await fetch(`${base}/tv/show-image?page=0&block=1`)).status, 404);
    assert.equal(game.skipStatus().isAvailable, true);
    game.skipWait();
    assert.equal(game.phase, 'question');
    assert.equal(game.tvView().showPage, null);
  } finally {
    await close();
  }
});

test('the host decides per show page whether players may skip it; the host always can', () => {
  const game = newGame();
  const aysel = game.join('Aysel');
  game.startRound({ ...ROUND, showPages: [
    { title: 'Rules', seconds: 30, canPlayersSkip: false, blocks: [] },
    { title: 'Ready?', seconds: 10, blocks: [] },
  ] });
  assert.deepEqual([game.tvView().showPage.canPlayersSkip, game.playerView(aysel).skip.isAvailable], [false, false]);
  assert.throws(() => game.toggleSkip(aysel.token), /Nothing to skip/);
  game.skipWait();
  assert.deepEqual([game.showIndex, game.playerView(aysel).skip.isAvailable, game.hostView().showPage.canPlayersSkip], [1, true, true]);
  game.stopTimer();
});

test('phones and the TV page block selecting, copying and saving questions; only the answer box takes a selection', () => {
  for (const page of ['player.html', 'tv.html']) {
    const html = fs.readFileSync(path.join(__dirname, 'party', page), 'utf8');
    assert.match(html, /body \{[^}]*user-select: none/, page);
    assert.match(html, /\['copy', 'cut', 'contextmenu', 'selectstart', 'dragstart'\]/, page);
  }
  assert.match(fs.readFileSync(path.join(__dirname, 'party', 'player.html'), 'utf8'), /input, textarea \{ user-select: text/);
});
