'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const QRCode = require('qrcode');

const PARTY_LIMITS = { players: 100, nameLength: 24, answerLength: 200, bodyBytes: 4096 };
const PREFERRED_PORT = 8765;
const HEARTBEAT_MS = 20000;
const PLAYER_PAGE = path.join(__dirname, 'party', 'player.html');
const TV_PAGE = path.join(__dirname, 'party', 'tv.html');
const IMAGE_TYPES = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' };
const VIRTUAL_ADAPTER = /vEthernet|VirtualBox|VMware|WSL|Hyper-V|Loopback|Tailscale|ZeroTier|VPN/i;
const PHASES_WITH_QUESTION = ['question', 'judging', 'reveal'];
const TV_SCREENS = ['game', 'leaderboard', 'join'];
const PAUSABLE_PHASES = ['waiting', 'question', 'reveal'];
const DEFAULT_RULES = { secondsPerQuestion: 60, secondsBetweenQuestions: 0, secondsOnAnswer: 0, pointsForCorrect: 1, pointsForWrong: 0 };

class PartyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function lanAddresses() {
  const isPrivate = address => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);
  return Object.entries(os.networkInterfaces())
    .flatMap(([adapter, addresses]) => addresses
      .filter(a => a.family === 'IPv4' && !a.internal)
      .map(a => ({ adapter, address: a.address, rank: (isPrivate(a.address) ? 0 : 2) + (VIRTUAL_ADAPTER.test(adapter) ? 1 : 0) })))
    .sort((a, b) => a.rank - b.rank)
    .map(({ adapter, address }) => ({ adapter, address }));
}

class PartyGame {
  constructor({ judge, onChange = () => {} }) {
    this.id = crypto.randomBytes(6).toString('hex');
    this.judge = judge;
    this.onChange = onChange;
    this.players = new Map();
    this.bankedScores = new Map();
    this.round = 0;
    this.questions = [];
    this.answers = [];
    this.rules = { ...DEFAULT_RULES };
    this.phase = 'lobby';
    this.index = -1;
    this.endsAt = null;
    this.timer = null;
    this.pausedRemainingMs = null;
    this.screen = 'game';
    this.isNightMode = true;
    this.shownUids = new Set();
    this.streams = new Set();
    this.urls = [];
  }

  join(name) {
    const cleanName = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, PARTY_LIMITS.nameLength);
    if (!cleanName) throw new PartyError(400, 'Type your name');
    if (this.players.size >= PARTY_LIMITS.players) throw new PartyError(409, 'The game is full');
    if ([...this.players.values()].some(p => p.name.toLowerCase() === cleanName.toLowerCase())) throw new PartyError(409, 'That name is taken');
    const player = { id: crypto.randomUUID(), token: crypto.randomBytes(16).toString('hex'), name: cleanName };
    this.players.set(player.id, player);
    this.changed();
    return player;
  }

  playerByToken(token) {
    const player = typeof token === 'string' && [...this.players.values()].find(p => p.token === token);
    if (!player) throw new PartyError(401, 'Join the game first');
    return player;
  }

  kick(playerId) {
    this.players.delete(playerId);
    this.bankedScores.delete(playerId);
    for (const answers of this.answers) answers.delete(playerId);
    for (const stream of this.streams) if (stream.playerId === playerId) stream.end({ phase: 'kicked' });
    this.changed();
  }

  submitAnswer(token, given) {
    const player = this.playerByToken(token);
    if (this.phase !== 'question') throw new PartyError(409, 'Answers are closed');
    this.answers[this.index].set(player.id, { given: String(given ?? '').trim().slice(0, PARTY_LIMITS.answerLength) });
    this.changed();
  }

  startRound({ questions, secondsPerQuestion, secondsBetweenQuestions, secondsOnAnswer = 0, pointsForCorrect, pointsForWrong }) {
    if (this.phase !== 'lobby' || !questions.length) return;
    this.questions = questions;
    this.answers = questions.map(() => new Map());
    this.rules = { secondsPerQuestion, secondsBetweenQuestions, secondsOnAnswer, pointsForCorrect, pointsForWrong };
    this.round += 1;
    this.goTo(0);
  }

  backToLobby({ keepScores }) {
    if (this.phase !== 'finished') return;
    if (keepScores) for (const entry of this.leaderboard()) this.bankedScores.set(entry.id, entry.score);
    else {
      this.bankedScores.clear();
      this.round = 0;
    }
    this.questions = [];
    this.answers = [];
    this.index = -1;
    this.phase = 'lobby';
    this.screen = 'game';
    this.changed();
  }

  goTo(position) {
    this.index = position;
    this.screen = 'game';
    if (!this.rules.secondsBetweenQuestions) return this.openAnswers();
    this.phase = 'waiting';
    this.schedule(this.rules.secondsBetweenQuestions, () => this.openAnswers());
    this.changed();
  }

  skipWait() {
    if (this.phase === 'waiting') this.openAnswers();
  }

  openAnswers() {
    this.phase = 'question';
    this.shownUids.add(this.questions[this.index].uid);
    this.schedule(this.rules.secondsPerQuestion, () => this.closeAnswers());
    this.changed();
  }

  pause() {
    if (!PAUSABLE_PHASES.includes(this.phase) || this.pausedRemainingMs != null) return;
    const remaining = this.remainingMs();
    this.stopTimer();
    this.pausedRemainingMs = remaining;
    this.changed();
  }

  resume() {
    if (this.pausedRemainingMs == null) return;
    const whenTimeIsUp = { waiting: () => this.openAnswers(), question: () => this.closeAnswers(), reveal: () => this.next() };
    this.schedule(this.pausedRemainingMs / 1000, whenTimeIsUp[this.phase]);
    this.changed();
  }

  setNightMode(isNightMode) {
    this.isNightMode = !!isNightMode;
    this.changed();
  }

  setScreen(screen) {
    if (!TV_SCREENS.includes(screen)) return;
    this.screen = screen;
    this.changed();
  }

  schedule(seconds, then) {
    clearTimeout(this.timer);
    this.pausedRemainingMs = null;
    this.endsAt = Date.now() + seconds * 1000;
    this.timer = setTimeout(then, seconds * 1000);
  }

  stopTimer() {
    clearTimeout(this.timer);
    this.timer = null;
    this.endsAt = null;
    this.pausedRemainingMs = null;
  }

  async closeAnswers() {
    if (this.phase !== 'question') return;
    this.stopTimer();
    this.phase = 'judging';
    this.changed();
    const position = this.index;
    const answers = this.answers;
    for (const answer of answers[position].values()) {
      try {
        Object.assign(answer, await this.judge(this.questions[position], answer.given));
      } catch {
        Object.assign(answer, { verdict: 'unsure', similarity: null, closestAnswer: null });
      }
      answer.isCorrect = answer.verdict === 'correct';
    }
    if (this.phase !== 'judging' || this.answers !== answers) return;
    this.phase = 'reveal';
    if (this.rules.secondsOnAnswer) this.schedule(this.rules.secondsOnAnswer, () => this.next());
    this.changed();
  }

  setCorrect(playerId, position, isCorrect) {
    const answer = this.answers[position]?.get(playerId);
    if (!answer || answer.isCorrect === undefined) return;
    answer.isCorrect = isCorrect;
    answer.decidedByHost = true;
    this.changed();
  }

  next() {
    if (this.phase !== 'reveal') return;
    if (this.index + 1 >= this.questions.length) return this.finish();
    this.goTo(this.index + 1);
  }

  finish() {
    if (this.phase === 'lobby' || this.phase === 'finished') return;
    this.stopTimer();
    this.phase = 'finished';
    this.changed();
  }

  pointsFor(answer) {
    if (answer?.isCorrect === undefined) return 0;
    if (answer.isCorrect) return this.rules.pointsForCorrect;
    return answer.given ? this.rules.pointsForWrong : 0;
  }

  leaderboard() {
    const scored = [...this.players.values()]
      .map(p => {
        const roundScore = this.answers.reduce((sum, answers) => sum + this.pointsFor(answers.get(p.id)), 0);
        return { id: p.id, name: p.name, roundScore, score: (this.bankedScores.get(p.id) ?? 0) + roundScore };
      })
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return scored.map(entry => ({ ...entry, rank: 1 + scored.findIndex(other => other.score === entry.score) }));
  }

  remainingMs() {
    if (this.pausedRemainingMs != null) return this.pausedRemainingMs;
    return this.endsAt ? Math.max(0, this.endsAt - Date.now()) : null;
  }

  hostView() {
    const current = this.answers[this.index];
    return {
      id: this.id, phase: this.phase, round: this.round, index: this.index, total: this.questions.length,
      remainingMs: this.remainingMs(), isPaused: this.pausedRemainingMs != null, screen: this.screen,
      rules: this.rules, urls: this.urls, port: this.port, question: this.questions[this.index] ?? null,
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, hasAnswered: !!current?.has(p.id) })),
      answers: current ? [...current].map(([playerId, answer]) => ({
        playerId, name: this.players.get(playerId)?.name, points: this.pointsFor(answer), ...answer,
      })) : [],
      leaderboard: this.leaderboard(),
    };
  }

  tvView() {
    const view = this.hostView();
    const question = PHASES_WITH_QUESTION.includes(this.phase) ? this.questions[this.index] : null;
    const isRevealed = this.phase === 'reveal';
    return {
      ...view,
      question: question && {
        text: question.text, note_before: question.note_before, rekvizit_text: question.rekvizit_text,
        package_name: question.package_name, tournament_name: question.tournament_name, authors: question.authors,
        rekvizit_src: question.rekvizit_src && `/tv/handout?question=${this.index}`,
        ...(isRevealed && {
          answer: question.answer, accepted_answers: question.accepted_answers, comment: question.comment,
          source_media_src: question.source_media_src && `/tv/answer-image?question=${this.index}`,
        }),
      },
      answers: isRevealed ? view.answers.map(({ given, similarity, closestAnswer, ...result }) => result) : [],
      isNightMode: this.isNightMode,
    };
  }

  playerView(player) {
    const question = this.questions[this.index];
    const myAnswer = this.answers[this.index]?.get(player.id);
    const leaderboard = this.leaderboard();
    const me = leaderboard.find(entry => entry.id === player.id);
    const showsLeaderboard = ['reveal', 'finished'].includes(this.phase) || (this.phase === 'lobby' && this.round > 0);
    return {
      partyId: this.id, phase: this.phase, round: this.round, index: this.index, total: this.questions.length,
      remainingMs: this.remainingMs(), isPaused: this.pausedRemainingMs != null, playerCount: this.players.size,
      rules: { pointsForCorrect: this.rules.pointsForCorrect, pointsForWrong: this.rules.pointsForWrong },
      me: { name: player.name, score: me?.score ?? 0, roundScore: me?.roundScore ?? 0, rank: me?.rank ?? null },
      question: PHASES_WITH_QUESTION.includes(this.phase) ? {
        text: question.text, noteBefore: question.note_before, handoutText: question.rekvizit_text, hasHandoutImage: !!question.rekvizit_src,
      } : null,
      myAnswer: myAnswer?.given ?? null,
      reveal: this.phase === 'reveal' ? {
        answer: question.answer, acceptedAnswers: question.accepted_answers, comment: question.comment,
        hasAnswerImage: !!question.source_media_src, isCorrect: myAnswer ? !!myAnswer.isCorrect : null, points: this.pointsFor(myAnswer),
      } : null,
      leaderboard: showsLeaderboard ? leaderboard.slice(0, 10).map(({ name, score, rank }) => ({ name, score, rank })) : null,
    };
  }

  changed() {
    this.onChange(this.hostView());
    for (const stream of this.streams) {
      const view = stream.view();
      if (view) stream.send(view);
    }
  }

  close() {
    this.stopTimer();
    for (const stream of this.streams) stream.end({ phase: 'closed' });
  }
}

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > PARTY_LIMITS.bodyBytes) throw new PartyError(413, 'Too much data');
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new PartyError(400, 'Bad request');
  }
}

function sendImage(res, src) {
  if (!src) throw new PartyError(404, 'No image');
  if (/^https?:/.test(src)) {
    res.writeHead(302, { Location: src });
    return res.end();
  }
  const file = fileURLToPath(src);
  res.writeHead(200, { 'Content-Type': IMAGE_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

function openEventStream(game, req, res, { playerId = null, view }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const stream = {
    playerId,
    view,
    send: view => res.write(`data: ${JSON.stringify(view)}\n\n`),
    end: view => {
      res.write(`data: ${JSON.stringify(view)}\n\n`);
      res.end();
    },
  };
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  game.streams.add(stream);
  req.on('close', () => {
    clearInterval(heartbeat);
    game.streams.delete(stream);
  });
  stream.send(view());
}

function sendPage(res, file) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  });
  res.end(fs.readFileSync(file));
}

function routeTv(game, req, res, url) {
  if (url.pathname === '/tv' || url.pathname === '/tv/') return sendPage(res, TV_PAGE);
  if (url.pathname === '/tv/join-qr.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.end(game.joinQrSvg);
  }
  if (url.pathname === '/tv/events') return openEventStream(game, req, res, { view: () => game.tvView() });
  if (url.pathname === '/tv/handout') {
    if (!PHASES_WITH_QUESTION.includes(game.phase)) throw new PartyError(404, 'No image');
    return sendImage(res, game.questions[game.index].rekvizit_src);
  }
  if (url.pathname === '/tv/answer-image') {
    if (game.phase !== 'reveal') throw new PartyError(404, 'No image');
    return sendImage(res, game.questions[game.index].source_media_src);
  }
  throw new PartyError(404, 'Not found');
}

async function route(game, req, res) {
  const url = new URL(req.url, 'http://party');
  const token = url.searchParams.get('token');
  if (req.method === 'GET' && url.pathname === '/') return sendPage(res, PLAYER_PAGE);
  if (req.method === 'POST' && url.pathname === '/join') {
    const player = game.join((await readJson(req)).name);
    return sendJson(res, 200, { token: player.token, partyId: game.id });
  }
  if (req.method === 'POST' && url.pathname === '/answer') {
    const body = await readJson(req);
    game.submitAnswer(body.token, body.answer);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    const { id: playerId } = game.playerByToken(token);
    return openEventStream(game, req, res, { playerId, view: () => game.players.has(playerId) && game.playerView(game.players.get(playerId)) });
  }
  if (req.method === 'GET' && (url.pathname === '/tv' || url.pathname.startsWith('/tv/'))) return routeTv(game, req, res, url);
  if (req.method === 'GET' && url.pathname === '/handout') {
    game.playerByToken(token);
    if (!PHASES_WITH_QUESTION.includes(game.phase)) throw new PartyError(404, 'No image');
    return sendImage(res, game.questions[game.index].rekvizit_src);
  }
  if (req.method === 'GET' && url.pathname === '/answer-image') {
    game.playerByToken(token);
    if (game.phase !== 'reveal') throw new PartyError(404, 'No image');
    return sendImage(res, game.questions[game.index].source_media_src);
  }
  throw new PartyError(404, 'Not found');
}

async function openParty(settings, { port = PREFERRED_PORT } = {}) {
  const game = new PartyGame(settings);
  const server = http.createServer((req, res) => route(game, req, res).catch(e => {
    if (!res.headersSent) sendJson(res, e.status ?? 500, { error: e.status ? e.message : 'Something went wrong' });
    else res.end();
  }));
  const listen = candidatePort => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(candidatePort, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    await listen(port);
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    await listen(0);
  }
  const { port: actualPort } = server.address();
  game.urls = lanAddresses().map(({ adapter, address }) => ({ adapter, url: `http://${address}:${actualPort}/` }));
  game.joinQrSvg = game.urls.length ? await QRCode.toString(game.urls[0].url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) : '';
  game.port = actualPort;
  game.changed();
  return {
    game,
    close: () => new Promise(resolve => {
      game.close();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

module.exports = { PARTY_LIMITS, DEFAULT_RULES, PartyGame, PartyError, lanAddresses, openParty };
