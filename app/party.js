'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const QRCode = require('qrcode');
const { matchesAsText } = require('./judge');
const { MEDIA_TYPES } = require('./store');

const PARTY_LIMITS = { players: 100, nameLength: 24, answerLength: 200, messageLength: 300, bodyBytes: 4096 };
const PREFERRED_PORT = 8765;
const HEARTBEAT_MS = 20000;
const PLAYER_PAGE = path.join(__dirname, 'party', 'player.html');
const TV_PAGE = path.join(__dirname, 'party', 'tv.html');
const VIRTUAL_ADAPTER = /vEthernet|VirtualBox|VMware|WSL|Hyper-V|Loopback|Tailscale|ZeroTier|VPN/i;
const PHASES_WITH_QUESTION = ['question', 'judging', 'reveal'];
const TV_SCREENS = ['game', 'leaderboard', 'join'];
const PAUSABLE_PHASES = ['waiting', 'question', 'reveal'];
const SKIPPABLE_PHASES = ['waiting', 'question', 'reveal'];
const REACTIONS = ['👏', '😂', '😮', '🤔', '🔥', '❤️', '😢', '🎉'];
const REACTION_COOLDOWN_MS = 1000;
const REACTIONS_PER_MINUTE = 10;
const MINUTE_MS = 60000;
const REACTION_SCREENS = {
  tv: { atOnce: 5, shownMs: 4200, maxWaitMs: 15000 },
  players: { atOnce: 2, shownMs: 3000, maxWaitMs: 8000 },
};
const DEFAULT_RULES = { secondsPerQuestion: 60, secondsBetweenQuestions: 0, secondsOnAnswer: 0, pointsForCorrect: 1, pointsForWrong: 0 };

class PartyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const cleanName = name => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, PARTY_LIMITS.nameLength);
const isBlank = given => !String(given ?? '').trim();

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
  constructor({ judge, onChange = () => {}, onRoundFinished = () => {}, onReaction = () => {} }) {
    this.id = crypto.randomBytes(6).toString('hex');
    this.judge = judge;
    this.onChange = onChange;
    this.onRoundFinished = onRoundFinished;
    this.onReaction = onReaction;
    this.areReactionsOn = true;
    this.reactionTimes = new Map();
    this.reactionQueues = { tv: [], players: [] };
    this.reactionsShown = { tv: 0, players: 0 };
    this.reactionTimers = new Set();
    this.players = new Map();
    this.bankedScores = new Map();
    this.bankedTimes = new Map();
    this.round = 0;
    this.questions = [];
    this.answers = [];
    this.rulings = [];
    this.closedCount = 0;
    this.skips = { key: null, playerIds: new Set() };
    this.absences = { key: null, counts: new Map() };
    this.announcement = null;
    this.rules = { ...DEFAULT_RULES };
    this.phase = 'lobby';
    this.index = -1;
    this.revealedCount = 0;
    this.endsAt = null;
    this.timer = null;
    this.pausedRemainingMs = null;
    this.screen = 'game';
    this.isNightMode = true;
    this.shownUids = new Set();
    this.streams = new Set();
    this.urls = [];
  }

  checkName(name, playerId = null) {
    const clean = cleanName(name);
    if (!clean) throw new PartyError(400, 'Type your name');
    const isTaken = [...this.players.values()].some(p => p.id !== playerId && p.name.toLowerCase() === clean.toLowerCase());
    if (isTaken) throw new PartyError(409, 'That name is taken');
    return clean;
  }

  join(name) {
    const clean = this.checkName(name);
    if (this.players.size >= PARTY_LIMITS.players) throw new PartyError(409, 'The game is full');
    const player = { id: crypto.randomUUID(), token: crypto.randomBytes(16).toString('hex'), name: clean, countsFrom: { round: this.round, position: this.closedCount } };
    this.players.set(player.id, player);
    this.changed();
    return player;
  }

  rename(token, name) {
    const player = this.playerByToken(token);
    player.name = this.checkName(name, player.id);
    this.changed();
    return player;
  }

  isOnline(playerId) {
    return [...this.streams].some(stream => stream.playerId === playerId);
  }

  presenceChanged(playerId = null) {
    if (this.isClosed) return;
    if (playerId && !this.isOnline(playerId)) this.recordAbsence(playerId);
    this.changed();
    this.skipIfEveryoneAgrees();
  }

  playerByToken(token) {
    const player = typeof token === 'string' && [...this.players.values()].find(p => p.token === token);
    if (!player) throw new PartyError(401, 'Join the game first');
    return player;
  }

  kick(playerId) {
    this.players.delete(playerId);
    this.bankedScores.delete(playerId);
    this.bankedTimes.delete(playerId);
    for (const answers of this.answers) answers.delete(playerId);
    this.skips.playerIds.delete(playerId);
    for (const stream of this.streams) if (stream.playerId === playerId) stream.end({ phase: 'kicked' });
    this.changed();
    this.skipIfEveryoneAgrees();
  }

  submitAnswer(token, given) {
    const player = this.playerByToken(token);
    if (this.phase !== 'question') throw new PartyError(409, 'Answers are closed');
    const cleanGiven = String(given ?? '').trim().slice(0, PARTY_LIMITS.answerLength);
    const answers = this.answers[this.index];
    if (answers.get(player.id)?.given === cleanGiven) return;
    const answer = { given: cleanGiven, ms: Math.max(0, Math.round(this.rules.secondsPerQuestion * 1000 - (this.remainingMs() ?? 0))) };
    const ruling = this.rulingFor(this.index, cleanGiven);
    if (ruling) answer.hostCall = ruling.isCorrect;
    answers.set(player.id, answer);
    this.changed();
  }

  rulingFor(position, given) {
    if (isBlank(given)) return null;
    const rulings = this.rulings[position] ?? [];
    return rulings.find(ruling => ruling.given === given) ?? rulings.find(ruling => matchesAsText(given, ruling.given)) ?? null;
  }

  questionKey() {
    return `${this.round}:${this.index}`;
  }

  recordAbsence(playerId) {
    if (this.phase !== 'question' || !this.players.has(playerId)) return;
    if (this.absences.key !== this.questionKey()) this.absences = { key: this.questionKey(), counts: new Map() };
    this.absences.counts.set(playerId, (this.absences.counts.get(playerId) ?? 0) + 1);
  }

  reportAway(token) {
    const player = this.playerByToken(token);
    if (this.phase !== 'question') return;
    this.recordAbsence(player.id);
    this.changed();
  }

  absencesOf(playerId) {
    return this.absences.key === this.questionKey() ? this.absences.counts.get(playerId) ?? 0 : 0;
  }

  announce(text) {
    const message = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, PARTY_LIMITS.messageLength);
    this.announcement = message ? { id: crypto.randomUUID(), text: message } : null;
    this.changed();
  }

  react(token, emoji) {
    const player = this.playerByToken(token);
    if (!this.areReactionsOn) throw new PartyError(409, 'Reactions are off');
    if (!REACTIONS.includes(emoji)) throw new PartyError(400, 'Pick one of the reactions');
    const now = Date.now();
    const times = (this.reactionTimes.get(player.id) ?? []).filter(time => now - time < MINUTE_MS);
    if (times.length >= REACTIONS_PER_MINUTE) {
      const seconds = Math.ceil((MINUTE_MS - (now - times[0])) / 1000);
      throw new PartyError(429, `${REACTIONS_PER_MINUTE} reactions a minute. More in ${seconds} s`);
    }
    if (times.length && now - times.at(-1) < REACTION_COOLDOWN_MS) throw new PartyError(429, 'Wait a moment');
    times.push(now);
    this.reactionTimes.set(player.id, times);
    const reaction = { id: crypto.randomUUID(), emoji, name: player.name, playerId: player.id };
    for (const screen of Object.keys(REACTION_SCREENS)) {
      this.reactionQueues[screen].push({ reaction, queuedAt: now });
      this.showQueuedReactions(screen);
    }
    return { reaction, left: REACTIONS_PER_MINUTE - times.length };
  }

  showQueuedReactions(screen) {
    const { atOnce, shownMs, maxWaitMs } = REACTION_SCREENS[screen];
    const queue = this.reactionQueues[screen];
    while (this.reactionsShown[screen] < atOnce && queue.length && !this.isClosed) {
      const { reaction, queuedAt } = queue.shift();
      if (Date.now() - queuedAt > maxWaitMs) continue;
      this.reactionsShown[screen] += 1;
      this.deliverReaction(screen, reaction);
      const timer = setTimeout(() => {
        this.reactionTimers.delete(timer);
        this.reactionsShown[screen] -= 1;
        this.showQueuedReactions(screen);
      }, shownMs);
      this.reactionTimers.add(timer);
    }
  }

  deliverReaction(screen, reaction) {
    if (screen === 'tv') this.onReaction(reaction);
    for (const stream of this.streams) {
      const isTv = !stream.playerId;
      if (screen === 'tv' ? isTv : !isTv && stream.playerId !== reaction.playerId) stream.sendEvent('reaction', reaction);
    }
  }

  setReactionsOn(areOn) {
    this.areReactionsOn = !!areOn;
    this.changed();
  }

  leave(token) {
    this.kick(this.playerByToken(token).id);
  }

  skipKey() {
    return `${this.round}:${this.phase}:${this.index}`;
  }

  isHostChecking() {
    if (this.phase === 'judging') return true;
    if (this.phase === 'waiting') return this.rules.revealAtEnd && this.index > 0;
    if (this.phase === 'reveal') return [...(this.answers[this.index]?.values() ?? [])].some(answer => answer.verdict === 'unsure' && !answer.decidedByHost);
    return false;
  }

  canSkip() {
    return SKIPPABLE_PHASES.includes(this.phase) && !this.isHostChecking();
  }

  skipStatus(playerId = null) {
    const skipped = this.skips.key === this.skipKey() ? this.skips.playerIds : new Set();
    const online = [...this.players.keys()].filter(id => this.isOnline(id));
    return {
      isAvailable: this.canSkip(), isHostChecking: this.isHostChecking(), count: online.filter(id => skipped.has(id)).length, of: online.length,
      ...(playerId && { isMine: skipped.has(playerId) }),
    };
  }

  toggleSkip(token) {
    const player = this.playerByToken(token);
    if (this.isHostChecking()) throw new PartyError(409, 'The host is checking the answers');
    if (!this.canSkip()) throw new PartyError(409, 'Nothing to skip now');
    if (this.skips.key !== this.skipKey()) this.skips = { key: this.skipKey(), playerIds: new Set() };
    if (this.skips.playerIds.has(player.id)) this.skips.playerIds.delete(player.id);
    else this.skips.playerIds.add(player.id);
    this.changed();
    this.skipIfEveryoneAgrees();
  }

  skipIfEveryoneAgrees() {
    if (!this.canSkip() || this.pausedRemainingMs != null) return;
    const { count, of } = this.skipStatus();
    if (!of || count < of) return;
    ({ waiting: () => this.openAnswers(), question: () => this.closeAnswers(), reveal: () => this.next() })[this.phase]();
  }

  startRound({ questions, secondsPerQuestion, secondsBetweenQuestions, secondsOnAnswer = 0, pointsForCorrect, pointsForWrong, revealAtEnd = false }) {
    if (this.phase !== 'lobby' || !questions.length) return;
    this.questions = questions;
    this.answers = questions.map(() => new Map());
    this.rulings = questions.map(() => []);
    this.closedCount = 0;
    this.rules = { secondsPerQuestion, secondsBetweenQuestions, secondsOnAnswer, pointsForCorrect, pointsForWrong, revealAtEnd: !!revealAtEnd };
    this.revealedCount = 0;
    this.round += 1;
    this.goTo(0);
  }

  backToLobby({ keepScores }) {
    if (this.phase !== 'finished') return;
    if (keepScores) {
      for (const entry of this.leaderboard()) {
        this.bankedScores.set(entry.id, entry.score);
        this.bankedTimes.set(entry.id, this.correctTimes(entry.id));
      }
    }
    else {
      this.bankedScores.clear();
      this.bankedTimes.clear();
      this.round = 0;
    }
    this.questions = [];
    this.answers = [];
    this.rulings = [];
    this.index = -1;
    this.phase = 'lobby';
    this.screen = 'game';
    this.changed();
  }

  goTo(position) {
    this.index = position;
    this.announcement = null;
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
    this.skipIfEveryoneAgrees();
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
    this.closedCount = position + 1;
    for (const answer of answers[position].values()) {
      if (answer.hostCall === undefined) {
        try {
          Object.assign(answer, await this.judge(this.questions[position], answer.given));
        } catch {
          Object.assign(answer, { verdict: 'unsure', similarity: null, closestAnswer: null });
        }
      }
      answer.hostCall ??= this.rulingFor(position, answer.given)?.isCorrect;
      answer.decidedByHost = answer.hostCall !== undefined;
      answer.isCorrect = answer.decidedByHost ? answer.hostCall : answer.verdict === 'correct';
    }
    if (this.phase !== 'judging' || this.answers !== answers) return;
    if (!this.rules.revealAtEnd) return this.showAnswer();
    if (position + 1 < this.questions.length) return this.goTo(position + 1);
    this.changed();
  }

  isJudged() {
    return [...this.answers[this.index].values()].every(answer => answer.isCorrect !== undefined);
  }

  showAnswer() {
    this.phase = 'reveal';
    this.revealedCount = this.index + 1;
    if (this.rules.secondsOnAnswer) this.schedule(this.rules.secondsOnAnswer, () => this.next());
    this.changed();
  }

  setCorrect(playerId, position, isCorrect) {
    const answers = this.answers[position];
    const answer = answers?.get(playerId);
    if (!answer) return;
    answer.isDirectCall = true;
    if (!isBlank(answer.given)) {
      this.rulings[position] = [...(this.rulings[position] ?? []).filter(ruling => ruling.given !== answer.given), { given: answer.given, isCorrect }];
    }
    for (const other of answers.values()) {
      const isSameAnswer = other === answer || (!other.isDirectCall && !isBlank(answer.given) && matchesAsText(other.given, answer.given));
      if (!isSameAnswer) continue;
      other.hostCall = isCorrect;
      if (other.isCorrect === undefined) continue;
      other.isCorrect = isCorrect;
      other.decidedByHost = true;
    }
    this.changed();
  }

  next() {
    if (this.phase === 'judging' && this.rules.revealAtEnd && this.isJudged()) {
      this.index = 0;
      return this.showAnswer();
    }
    if (this.phase !== 'reveal') return;
    if (this.index + 1 >= this.questions.length) return this.finish();
    if (!this.rules.revealAtEnd) return this.goTo(this.index + 1);
    this.index += 1;
    this.showAnswer();
  }

  finish() {
    if (this.phase === 'lobby' || this.phase === 'finished') return;
    this.stopTimer();
    this.phase = 'finished';
    this.revealedCount = this.questions.length;
    this.changed();
    const results = this.roundResults();
    if (results.length) this.onRoundFinished(results);
  }

  roundResults() {
    return [...this.players.values()].map(player => {
      const result = { name: player.name, correct: 0, wrong: 0, unanswered: 0, correctMs: 0 };
      const firstPosition = player.countsFrom.round === this.round ? player.countsFrom.position : 0;
      for (const answers of this.answers.slice(firstPosition, this.closedCount)) {
        const answer = answers.get(player.id);
        if (answer?.isCorrect) {
          result.correct += 1;
          result.correctMs += answer.ms ?? 0;
        }
        else if (!answer || isBlank(answer.given)) result.unanswered += 1;
        else if (answer.isCorrect === false) result.wrong += 1;
      }
      return result;
    }).filter(result => result.correct + result.wrong + result.unanswered > 0);
  }

  pointsFor(answer) {
    if (answer?.isCorrect === undefined) return 0;
    if (answer.isCorrect) return this.rules.pointsForCorrect;
    return answer.given ? this.rules.pointsForWrong : 0;
  }

  correctTimes(playerId) {
    const banked = this.bankedTimes.get(playerId) ?? { ms: 0, count: 0 };
    return this.answers.slice(0, this.revealedCount).reduce((times, answers) => {
      const answer = answers.get(playerId);
      return answer?.isCorrect && answer.ms != null ? { ms: times.ms + answer.ms, count: times.count + 1 } : times;
    }, banked);
  }

  leaderboard() {
    const byTime = (a, b) => (a.avgSeconds ?? Infinity) - (b.avgSeconds ?? Infinity) || 0;
    const scored = [...this.players.values()]
      .map(p => {
        const roundScore = this.answers.slice(0, this.revealedCount).reduce((sum, answers) => sum + this.pointsFor(answers.get(p.id)), 0);
        const times = this.correctTimes(p.id);
        const avgSeconds = times.count ? Math.round(times.ms / times.count / 100) / 10 : null;
        return { id: p.id, name: p.name, roundScore, score: (this.bankedScores.get(p.id) ?? 0) + roundScore, avgSeconds };
      })
      .sort((a, b) => b.score - a.score || byTime(a, b) || a.name.localeCompare(b.name));
    return scored.map(entry => ({ ...entry, rank: 1 + scored.findIndex(other => other.score === entry.score && other.avgSeconds === entry.avgSeconds) }));
  }

  remainingMs() {
    if (this.pausedRemainingMs != null) return this.pausedRemainingMs;
    return this.endsAt ? Math.max(0, this.endsAt - Date.now()) : null;
  }

  hostView() {
    const current = this.answers[this.index];
    const answerRows = position => [...(this.answers[position] ?? [])].map(([playerId, answer]) => ({
      playerId, name: this.players.get(playerId)?.name, points: this.pointsFor(answer), ...answer,
    }));
    const checkedIndex = this.rules.revealAtEnd && this.phase === 'waiting' ? this.index - 1 : -1;
    return {
      id: this.id, phase: this.phase, round: this.round, index: this.index, total: this.questions.length,
      remainingMs: this.remainingMs(), isPaused: this.pausedRemainingMs != null, screen: this.screen,
      rules: this.rules, urls: this.urls, port: this.port, question: this.questions[this.index] ?? null,
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, hasAnswered: !!current?.has(p.id), isOnline: this.isOnline(p.id), timesAway: this.absencesOf(p.id) })),
      skips: this.skipStatus(),
      announcement: this.announcement,
      areReactionsOn: this.areReactionsOn,
      answers: answerRows(this.index),
      previous: checkedIndex >= 0 ? { index: checkedIndex, question: this.questions[checkedIndex], answers: answerRows(checkedIndex) } : null,
      leaderboard: this.leaderboard(),
    };
  }

  tvView() {
    const { previous, skips, players, announcement, ...view } = this.hostView();
    const question = PHASES_WITH_QUESTION.includes(this.phase) ? this.questions[this.index] : null;
    const isRevealed = this.phase === 'reveal';
    return {
      ...view,
      players: players.map(({ timesAway, ...player }) => player),
      question: question && {
        text: question.text, note_before: question.note_before, rekvizit_text: question.rekvizit_text,
        package_name: question.package_name, tournament_name: question.tournament_name, authors: question.authors,
        rekvizit_src: question.rekvizit_src && `/tv/handout?question=${this.index}`, rekvizit_kind: question.rekvizit_kind ?? 'image',
        ...(isRevealed && {
          answer: question.answer, accepted_answers: question.accepted_answers, comment: question.comment,
          source_media_src: question.source_media_src && `/tv/answer-image?question=${this.index}`, source_media_kind: question.source_media_kind ?? 'image',
        }),
      },
      answers: isRevealed ? view.answers.map(({ given, similarity, closestAnswer, hostCall, isDirectCall, ...result }) => result) : [],
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
      remainingMs: this.remainingMs(), isPaused: this.pausedRemainingMs != null, playerCount: this.players.size, isNightMode: this.isNightMode,
      rules: {
        pointsForCorrect: this.rules.pointsForCorrect, pointsForWrong: this.rules.pointsForWrong, secondsPerQuestion: this.rules.secondsPerQuestion,
        secondsBetweenQuestions: this.rules.secondsBetweenQuestions, secondsOnAnswer: this.rules.secondsOnAnswer,
      },
      me: { name: player.name, score: me?.score ?? 0, roundScore: me?.roundScore ?? 0, rank: me?.rank ?? null, avgSeconds: me?.avgSeconds ?? null },
      question: PHASES_WITH_QUESTION.includes(this.phase) ? {
        text: question.text, noteBefore: question.note_before, handoutText: question.rekvizit_text, hasHandoutImage: !!question.rekvizit_src, handoutKind: question.rekvizit_kind ?? 'image',
      } : null,
      myAnswer: myAnswer?.given ?? null,
      skip: this.skipStatus(player.id),
      reactions: this.areReactionsOn ? REACTIONS : [],
      reactionsPerMinute: REACTIONS_PER_MINUTE,
      announcement: this.announcement,
      reveal: this.phase === 'reveal' ? {
        answer: question.answer, acceptedAnswers: question.accepted_answers, comment: question.comment,
        hasAnswerImage: !!question.source_media_src, answerKind: question.source_media_kind ?? 'image', isCorrect: myAnswer ? !!myAnswer.isCorrect : null, points: this.pointsFor(myAnswer),
        seconds: myAnswer?.ms != null && myAnswer.given ? Math.round(myAnswer.ms / 100) / 10 : null,
        isPending: !!myAnswer && myAnswer.verdict === 'unsure' && !myAnswer.decidedByHost,
      } : null,
      leaderboard: showsLeaderboard ? leaderboard.slice(0, 10).map(({ name, score, rank, avgSeconds }) => ({ name, score, rank, avgSeconds })) : null,
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
    this.isClosed = true;
    this.stopTimer();
    for (const timer of this.reactionTimers) clearTimeout(timer);
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

function sendMedia(req, res, src) {
  if (!src) throw new PartyError(404, 'No media');
  if (/^https?:/.test(src)) {
    res.writeHead(302, { Location: src });
    return res.end();
  }
  const file = fileURLToPath(src);
  const size = fs.statSync(file).size;
  const headers = { 'Content-Type': MEDIA_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

function openEventStream(game, req, res, { playerId = null, view }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const stream = {
    playerId,
    view,
    send: view => res.write(`data: ${JSON.stringify(view)}\n\n`),
    sendEvent: (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`),
    end: view => {
      game.streams.delete(stream);
      res.write(`data: ${JSON.stringify(view)}\n\n`);
      res.end();
    },
  };
  const heartbeat = setInterval(() => res.write('event: ping\ndata: {}\n\n'), HEARTBEAT_MS);
  game.streams.add(stream);
  req.on('close', () => {
    clearInterval(heartbeat);
    const wasOpen = game.streams.delete(stream);
    if (playerId && wasOpen) game.presenceChanged(playerId);
  });
  if (playerId) game.presenceChanged();
  else stream.send(view());
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
    if (!PHASES_WITH_QUESTION.includes(game.phase)) throw new PartyError(404, 'No media');
    return sendMedia(req, res, game.questions[game.index].rekvizit_src);
  }
  if (url.pathname === '/tv/answer-image') {
    if (game.phase !== 'reveal') throw new PartyError(404, 'No media');
    return sendMedia(req, res, game.questions[game.index].source_media_src);
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
  if (req.method === 'GET' && url.pathname === '/me') {
    const player = game.playerByToken(token);
    return sendJson(res, 200, { name: player.name, partyId: game.id });
  }
  if (req.method === 'POST' && url.pathname === '/rename') {
    const body = await readJson(req);
    const player = game.rename(body.token, body.name);
    return sendJson(res, 200, { name: player.name });
  }
  if (req.method === 'POST' && url.pathname === '/away') {
    game.reportAway((await readJson(req)).token);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/leave') {
    game.leave((await readJson(req)).token);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/react') {
    const body = await readJson(req);
    const { left } = game.react(body.token, body.emoji);
    return sendJson(res, 200, { left });
  }
  if (req.method === 'POST' && url.pathname === '/skip') {
    game.toggleSkip((await readJson(req)).token);
    return sendJson(res, 200, { ok: true });
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
    if (!PHASES_WITH_QUESTION.includes(game.phase)) throw new PartyError(404, 'No media');
    return sendMedia(req, res, game.questions[game.index].rekvizit_src);
  }
  if (req.method === 'GET' && url.pathname === '/answer-image') {
    game.playerByToken(token);
    if (game.phase !== 'reveal') throw new PartyError(404, 'No media');
    return sendMedia(req, res, game.questions[game.index].source_media_src);
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

module.exports = { PARTY_LIMITS, DEFAULT_RULES, REACTIONS, PartyGame, PartyError, lanAddresses, openParty };
