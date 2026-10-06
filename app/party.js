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
const { PlayerProfiles } = require('./profiles');
const { CLASSIC_POINT_SYSTEM, normalizePointSystem, roundProblem, summaryOf, usesLeft, pickFor, risksLeft, scoreRound } = require('./scoring');

const PARTY_LIMITS = { players: 100, nameLength: 24, answerLength: 200, messageLength: 300, bodyBytes: 4096 };
const PREFERRED_PORT = 8765;
const HEARTBEAT_MS = 20000;
const PLAYER_PAGE = path.join(__dirname, 'party', 'player.html');
const TV_PAGE = path.join(__dirname, 'party', 'tv.html');
const VIRTUAL_ADAPTER = /vEthernet|VirtualBox|VMware|WSL|Hyper-V|Loopback|Tailscale|ZeroTier|VPN/i;
const PHASES_WITH_QUESTION = ['question', 'judging', 'reveal'];
const TV_SCREENS = ['game', 'leaderboard', 'join'];
const PAUSABLE_PHASES = ['show', 'waiting', 'question', 'reveal'];
const SKIPPABLE_PHASES = ['show', 'waiting', 'question', 'reveal'];
const REACTIONS = ['👏', '😂', '😮', '🤔', '🔥', '❤️', '😢', '🎉'];
const REACTION_COOLDOWN_MS = 1000;
const REACTIONS_PER_MINUTE = 10;
const MINUTE_MS = 60000;
const REACTION_SCREENS = {
  tv: { atOnce: 5, shownMs: 4200, maxWaitMs: 15000 },
  players: { atOnce: 2, shownMs: 3000, maxWaitMs: 8000 },
};
const DEFAULT_RULES = { secondsPerQuestion: 60, secondsBetweenQuestions: 0, secondsOnAnswer: 0, pointSystem: normalizePointSystem(CLASSIC_POINT_SYSTEM) };

class PartyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const DEFAULT_PARTY_TITLE = 'Quiz night';
const MAX_TITLE_LENGTH = 40;
const cleanTitle = title => String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH) || DEFAULT_PARTY_TITLE;
const escapeHtml = text => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
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
  constructor({ judge, title, onChange = () => {}, onRoundFinished = () => {}, onReaction = () => {}, profiles = new PlayerProfiles() }) {
    this.id = crypto.randomBytes(6).toString('hex');
    this.profiles = profiles;
    this.judge = judge;
    this.onChange = onChange;
    this.onRoundFinished = onRoundFinished;
    this.onReaction = onReaction;
    this.areReactionsOn = true;
    this.isMidGameJoinOn = true;
    this.reactionTimes = new Map();
    this.reactionQueues = { tv: [], players: [] };
    this.reactionsShown = { tv: 0, players: 0 };
    this.reactionTimers = new Set();
    this.players = new Map();
    this.bankedScores = new Map();
    this.bankedTimes = new Map();
    this.round = 0;
    this.questions = [];
    this.showPages = [];
    this.showPagesAfter = [];
    this.isShowingAfterRound = false;
    this.keepsScoresAfterShow = false;
    this.isLastRound = true;
    this.isLeaderboardHidden = false;
    this.showIndex = -1;
    this.answers = [];
    this.stakes = [];
    this.rulings = [];
    this.bans = [];
    this.adjustments = [];
    this.closedCount = 0;
    this.isJudging = false;
    this.isFinishPending = false;
    this.skips = { key: null, playerIds: new Set() };
    this.absences = { key: null, left: new Map(), disconnected: new Map() };
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
    this.title = cleanTitle(title);
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

  playerNamed(name, exceptId = null) {
    return [...this.players.values()].find(p => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase()) ?? null;
  }

  loadProfile(player, { preferences, isRenamed = false } = {}) {
    this.profiles.ensure(player.name, { preferences, isRenamed });
    player.preferences = this.profiles.preferencesOf(player.name);
    player.hasPin = this.profiles.hasPin(player.name);
  }

  join(name, pin = null) {
    const typed = cleanName(name);
    if (!typed) throw new PartyError(400, 'Type your name');
    const clean = this.profiles.nameOf(typed);
    this.profiles.unlock(clean, pin);
    const holder = this.playerNamed(clean);
    if (holder && !this.profiles.hasPin(clean)) throw new PartyError(409, 'That name is taken');
    if (holder) return this.moveToNewDevice(holder);
    if (!this.isMidGameJoinOn && (this.round > 0 || this.phase !== 'lobby')) throw new PartyError(409, 'The game has started and the host closed joining');
    if (this.players.size >= PARTY_LIMITS.players) throw new PartyError(409, 'The game is full');
    const player = { id: crypto.randomUUID(), token: crypto.randomBytes(16).toString('hex'), name: clean, countsFrom: { round: this.round, position: this.closedCount } };
    this.loadProfile(player);
    this.players.set(player.id, player);
    this.changed();
    return player;
  }

  moveToNewDevice(player) {
    player.token = crypto.randomBytes(16).toString('hex');
    for (const stream of this.streams) if (stream.playerId === player.id) stream.end({ phase: 'moved' });
    this.loadProfile(player);
    this.changed();
    return player;
  }

  rename(token, name, pin = null) {
    const player = this.playerByToken(token);
    const clean = this.checkName(name, player.id);
    const isSameName = clean.toLowerCase() === player.name.toLowerCase();
    if (!isSameName) this.profiles.unlock(clean, pin);
    const preferences = player.preferences;
    player.name = isSameName ? clean : this.profiles.nameOf(clean);
    this.loadProfile(player, { preferences, isRenamed: isSameName });
    this.changed();
    return player;
  }

  setPin(token, pin) {
    const player = this.playerByToken(token);
    this.profiles.setPin(player.name, pin);
    player.hasPin = this.profiles.hasPin(player.name);
    this.changed();
  }

  setPreferences(token, preferences) {
    const player = this.playerByToken(token);
    player.preferences = this.profiles.setPreferences(player.name, preferences);
    this.changed();
    return player.preferences;
  }

  profileChanged(name) {
    const player = this.playerNamed(cleanName(name));
    if (!player) return;
    player.hasPin = this.profiles.hasPin(player.name);
    this.changed();
  }

  isOnline(playerId) {
    return [...this.streams].some(stream => stream.playerId === playerId);
  }

  presenceChanged(playerId = null) {
    if (this.isClosed) return;
    if (playerId && !this.isOnline(playerId)) this.recordAbsence(playerId, 'disconnected');
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
    for (const banned of this.bans) banned.delete(playerId);
    for (const adjustments of this.adjustments) adjustments.delete(playerId);
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

  firstPositionOf(player) {
    return player.countsFrom.round === this.round ? player.countsFrom.position : 0;
  }

  stakesBefore(player, position = this.index) {
    return this.stakes.slice(this.firstPositionOf(player), position).map(stakes => stakes.get(player.id) ?? null);
  }

  setStake(token, { pick, isRisked } = {}) {
    const player = this.playerByToken(token);
    if (this.phase !== 'question') throw new PartyError(409, 'Answers are closed');
    const system = this.rules.pointSystem;
    const before = this.stakesBefore(player);
    const stake = { ...this.stakes[this.index].get(player.id) };
    if (pick !== undefined) {
      if (system.mode !== 'pool' || !Number.isInteger(pick) || !system.pool[pick]) throw new PartyError(400, 'Pick one of the points');
      const left = usesLeft(system, before)[pick];
      if (left != null && left <= 0) throw new PartyError(409, `No ${system.pool[pick].points}s left this round`);
      stake.pick = pick;
    }
    if (isRisked !== undefined) {
      if (!system.risk.isOn) throw new PartyError(400, 'This round has no risk');
      if (isRisked && !stake.isRisked && risksLeft(system, before) <= 0) throw new PartyError(409, 'No risks left this round');
      stake.isRisked = !!isRisked;
    }
    this.stakes[this.index].set(player.id, stake);
    this.changed();
    return this.stakeView(player);
  }

  settleStakes(position) {
    const system = this.rules.pointSystem;
    for (const player of this.players.values()) {
      if (this.firstPositionOf(player) > position) continue;
      const stake = { ...this.stakes[position].get(player.id) };
      const answer = this.answers[position].get(player.id);
      if (system.mode === 'pool') stake.pick = pickFor(system, this.stakesBefore(player, position), stake.pick);
      if (!answer || isBlank(answer.given) || this.isBanned(player.id, position)) stake.isRisked = false;
      this.stakes[position].set(player.id, stake);
    }
  }

  stakeView(player) {
    const system = this.rules.pointSystem;
    if (!PHASES_WITH_QUESTION.includes(this.phase)) return null;
    const before = this.stakesBefore(player);
    const stake = this.stakes[this.index]?.get(player.id) ?? {};
    return {
      pick: system.mode === 'pool' ? pickFor(system, before, stake.pick) : null,
      isPicked: Number.isInteger(stake.pick),
      isRisked: !!stake.isRisked,
      usesLeft: system.mode === 'pool' ? usesLeft(system, before) : null,
      risksLeft: system.risk.isOn ? Math.min(99, risksLeft(system, before)) : 0,
    };
  }

  isBanned(playerId, position) {
    return !!this.bans[position]?.has(playerId);
  }

  outcomeAt(player, position) {
    if (this.isBanned(player.id, position)) return 'banned';
    const answer = this.answers[position]?.get(player.id);
    if (answer?.isCorrect === true) return 'correct';
    if (!answer || isBlank(answer.given)) return position < this.closedCount ? 'unanswered' : 'pending';
    return answer.isCorrect === false ? 'wrong' : 'pending';
  }

  scoreOf(player, upTo = this.revealedCount) {
    const first = this.firstPositionOf(player);
    const entries = [];
    for (let position = first; position < upTo; position++) {
      entries.push({ outcome: this.outcomeAt(player, position), stake: this.stakes[position]?.get(player.id), position, adjustment: this.adjustmentOf(player.id, position) });
    }
    const isComplete = this.questions.length > 0 && upTo >= this.questions.length && this.closedCount >= this.questions.length;
    return scoreRound(this.rules.pointSystem, entries, { isComplete });
  }

  pointsAt(player, position) {
    if (!player || position < this.firstPositionOf(player)) return 0;
    const { perQuestion } = this.scoreOf(player, position + 1);
    const last = perQuestion.at(-1);
    return last ? last.points + last.streakBonus : 0;
  }

  rulingFor(position, given) {
    if (isBlank(given)) return null;
    const rulings = this.rulings[position] ?? [];
    return rulings.find(ruling => ruling.given === given) ?? rulings.find(ruling => matchesAsText(given, ruling.given)) ?? null;
  }

  questionKey() {
    return `${this.round}:${this.index}`;
  }

  recordAbsence(playerId, kind) {
    if (this.phase !== 'question' || !this.players.has(playerId)) return;
    if (this.absences.key !== this.questionKey()) this.absences = { key: this.questionKey(), left: new Map(), disconnected: new Map() };
    this.absences[kind].set(playerId, (this.absences[kind].get(playerId) ?? 0) + 1);
    if (kind === 'left') this.bans[this.index]?.add(playerId);
  }

  adjustmentOf(playerId, position) {
    return this.adjustments[position]?.get(playerId) ?? 0;
  }

  adjust(playerId, position, points) {
    const isDeciding = PHASES_WITH_QUESTION.concat('waiting').includes(this.phase);
    const player = this.players.get(playerId);
    if (!isDeciding || !player || !(position < this.closedCount) || position < this.firstPositionOf(player)) throw new PartyError(409, 'Points can be adjusted only while deciding a closed question');
    const clean = Math.max(-1000, Math.min(1000, Math.round(Number(points)) || 0));
    if (clean) this.adjustments[position].set(playerId, clean);
    else this.adjustments[position].delete(playerId);
    this.changed();
  }

  unban(playerId, position) {
    if (!this.bans[position]?.delete(playerId)) return;
    this.changed();
  }

  reportAway(token, { round = this.round, index = this.index } = {}) {
    const player = this.playerByToken(token);
    if (round !== this.round || !Number.isInteger(index) || index < this.firstPositionOf(player)) return;
    if (index === this.index && this.phase === 'question') this.recordAbsence(player.id, 'left');
    else if (index < this.closedCount && PHASES_WITH_QUESTION.concat('waiting').includes(this.phase)) this.bans[index].add(player.id);
    else return;
    this.changed();
  }

  absencesOf(playerId, kind) {
    return this.absences.key === this.questionKey() ? this.absences[kind].get(playerId) ?? 0 : 0;
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

  setMidGameJoinOn(isOn) {
    this.isMidGameJoinOn = !!isOn;
    this.changed();
  }

  leave(token) {
    this.kick(this.playerByToken(token).id);
  }

  skipKey() {
    return `${this.round}:${this.phase}:${this.phase === 'show' ? `page${this.showIndex}${this.isShowingAfterRound ? 'after' : ''}` : this.index}`;
  }

  isHostChecking() {
    if (this.phase === 'judging') return true;
    if (this.phase === 'waiting') return this.rules.revealAtEnd && this.index > 0;
    if (this.phase === 'reveal') return [...(this.answers[this.index]?.values() ?? [])].some(answer => answer.verdict === 'unsure' && !answer.decidedByHost);
    return false;
  }

  canSkip() {
    if (this.phase === 'show' && this.showPages[this.showIndex].canPlayersSkip === false) return false;
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
    ({ show: () => this.nextShowPage(), waiting: () => this.openAnswers(), question: () => this.closeAnswers(), reveal: () => this.next() })[this.phase]();
  }

  startRound({ questions, showPages = [], showPagesAfter = [], isLastRound = true, showsLeaderboard = true, secondsPerQuestion, secondsBetweenQuestions, secondsOnAnswer = 0, pointSystem, pointsForCorrect = 1, pointsForWrong = 0, revealAtEnd = false }) {
    if (this.phase !== 'lobby' || !questions.length) return;
    const system = normalizePointSystem(pointSystem ?? { name: 'Classic', simple: { correct: pointsForCorrect, wrong: pointsForWrong, unanswered: 0 } });
    const problem = roundProblem(system, questions.length);
    if (problem) throw new PartyError(400, problem);
    this.questions = questions;
    this.answers = questions.map(() => new Map());
    this.stakes = questions.map(() => new Map());
    this.rulings = questions.map(() => []);
    this.bans = questions.map(() => new Set());
    this.adjustments = questions.map(() => new Map());
    this.closedCount = 0;
    this.rules = { secondsPerQuestion, secondsBetweenQuestions, secondsOnAnswer, pointSystem: system, pointsSummary: summaryOf(system), revealAtEnd: !!revealAtEnd };
    this.revealedCount = 0;
    this.round += 1;
    this.showPages = showPages;
    this.showPagesAfter = showPagesAfter;
    this.isLastRound = !!isLastRound;
    this.isLeaderboardHidden = !isLastRound && !showsLeaderboard;
    if (!showPages.length) return this.goTo(0);
    this.showPage(0);
  }

  showPage(position) {
    this.showIndex = position;
    this.phase = 'show';
    this.screen = 'game';
    this.schedule(this.showPages[position].seconds, () => this.nextShowPage());
    this.changed();
  }

  nextShowPage() {
    if (this.phase !== 'show') return;
    if (this.showIndex + 1 < this.showPages.length) return this.showPage(this.showIndex + 1);
    if (this.isShowingAfterRound) return this.enterLobby(this.keepsScoresAfterShow);
    this.goTo(0);
  }

  showImageSrc(url) {
    const page = this.phase === 'show' && Number(url.searchParams.get('page')) === this.showIndex ? this.showPages[this.showIndex] : null;
    const block = page?.blocks[Number(url.searchParams.get('block'))];
    if (!block?.src) throw new PartyError(404, 'No media');
    return block.src;
  }

  showPageView(imageUrl) {
    const page = this.phase === 'show' ? this.showPages[this.showIndex] : null;
    return page && {
      index: this.showIndex, total: this.showPages.length, isAfterRound: this.isShowingAfterRound, title: page.title, seconds: page.seconds, canPlayersSkip: page.canPlayersSkip !== false,
      blocks: page.blocks.map((block, position) => (block.src ? { type: block.type, src: imageUrl(block, position), isFullscreen: !!block.isFullscreen, isLooping: !!block.isLooping } : block)),
    };
  }

  backToLobby({ keepScores }) {
    if (this.phase !== 'finished') return;
    if (!this.showPagesAfter.length) return this.enterLobby(keepScores);
    this.keepsScoresAfterShow = keepScores;
    this.isShowingAfterRound = true;
    this.showPages = this.showPagesAfter;
    this.showPage(0);
  }

  enterLobby(keepScores) {
    this.stopTimer();
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
      for (const player of this.players.values()) player.countsFrom = { round: 0, position: 0 };
    }
    this.questions = [];
    this.answers = [];
    this.stakes = [];
    this.rulings = [];
    this.bans = [];
    this.adjustments = [];
    this.showPages = [];
    this.showPagesAfter = [];
    this.isShowingAfterRound = false;
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
    if (this.phase === 'show') this.nextShowPage();
    else if (this.phase === 'waiting') this.openAnswers();
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
    const whenTimeIsUp = { show: () => this.nextShowPage(), waiting: () => this.openAnswers(), question: () => this.closeAnswers(), reveal: () => this.next() };
    this.schedule(this.pausedRemainingMs / 1000, whenTimeIsUp[this.phase]);
    this.changed();
    this.skipIfEveryoneAgrees();
  }

  setTitle(title) {
    this.title = cleanTitle(title);
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
    this.closedCount = position + 1;
    this.settleStakes(position);
    this.isJudging = true;
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
    this.isJudging = false;
    if (this.isFinishPending) {
      this.isFinishPending = false;
      return this.finish();
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
    if (this.isShowingAfterRound) return this.enterLobby(this.keepsScoresAfterShow);
    if (this.phase === 'lobby' || this.phase === 'finished') return;
    if (this.isJudging) {
      this.isFinishPending = true;
      return;
    }
    this.stopTimer();
    this.phase = 'finished';
    this.revealedCount = this.questions.length;
    this.changed();
    const results = this.roundResults();
    if (results.length) this.onRoundFinished(results);
  }

  roundResults() {
    return [...this.players.values()].map(player => {
      const result = { name: player.name, points: this.scoreOf(player, this.closedCount).total, correct: 0, wrong: 0, unanswered: 0, correctMs: 0 };
      for (let position = this.firstPositionOf(player); position < this.closedCount; position++) {
        const outcome = this.outcomeAt(player, position);
        if (outcome === 'pending') continue;
        result[outcome === 'banned' ? 'unanswered' : outcome] += 1;
        if (outcome === 'correct') result.correctMs += this.answers[position].get(player.id).ms ?? 0;
      }
      return result;
    }).filter(result => result.correct + result.wrong + result.unanswered > 0);
  }

  correctTimes(playerId) {
    const banked = this.bankedTimes.get(playerId) ?? { ms: 0, count: 0 };
    return this.answers.slice(0, this.revealedCount).reduce((times, answers, position) => {
      const answer = answers.get(playerId);
      return answer?.isCorrect && answer.ms != null && !this.isBanned(playerId, position) ? { ms: times.ms + answer.ms, count: times.count + 1 } : times;
    }, banked);
  }

  leaderboard() {
    const byTime = (a, b) => (a.avgSeconds ?? Infinity) - (b.avgSeconds ?? Infinity) || 0;
    const scored = [...this.players.values()]
      .map(p => {
        const roundScore = this.scoreOf(p).total;
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
      playerId, name: this.players.get(playerId)?.name, points: this.pointsAt(this.players.get(playerId), position), ...answer,
      stake: this.stakes[position]?.get(playerId) ?? null, isBanned: this.isBanned(playerId, position), adjustment: this.adjustmentOf(playerId, position),
    }));
    const silentRows = position => [...this.players.values()]
      .filter(player => !this.answers[position]?.has(player.id) && position >= this.firstPositionOf(player))
      .map(player => ({ playerId: player.id, name: player.name, points: this.pointsAt(player, position), isBanned: this.isBanned(player.id, position), adjustment: this.adjustmentOf(player.id, position) }));
    const checkedIndex = this.rules.revealAtEnd && this.phase === 'waiting' ? this.index - 1 : -1;
    return {
      id: this.id, title: this.title, phase: this.phase, round: this.round, index: this.index, total: this.questions.length,
      remainingMs: this.remainingMs(), isPaused: this.pausedRemainingMs != null, screen: this.screen,
      rules: this.rules, urls: this.urls, port: this.port, question: this.questions[this.index] ?? null,
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, hasPin: !!p.hasPin, hasAnswered: !!current?.has(p.id), isOnline: this.isOnline(p.id), timesAway: this.absencesOf(p.id, 'left'), timesDisconnected: this.absencesOf(p.id, 'disconnected'), isBanned: this.isBanned(p.id, this.index) })),
      skips: this.skipStatus(),
      announcement: this.announcement,
      areReactionsOn: this.areReactionsOn,
      isMidGameJoinOn: this.isMidGameJoinOn,
      showPagesAfterCount: this.phase === 'finished' ? this.showPagesAfter.length : 0,
      isLastRound: this.isLastRound,
      isLeaderboardHidden: this.isLeaderboardHidden,
      answers: answerRows(this.index),
      silentPlayers: this.index < this.closedCount ? silentRows(this.index) : [],
      previous: checkedIndex >= 0 ? { index: checkedIndex, question: this.questions[checkedIndex], answers: answerRows(checkedIndex), silentPlayers: silentRows(checkedIndex) } : null,
      leaderboard: this.leaderboard(),
      showPage: this.showPageView(block => block.src),
    };
  }

  tvView() {
    const { previous, skips, players, announcement, silentPlayers, ...view } = this.hostView();
    const question = PHASES_WITH_QUESTION.includes(this.phase) ? this.questions[this.index] : null;
    const isRevealed = this.phase === 'reveal';
    return {
      ...view,
      players: players.map(({ timesAway, timesDisconnected, isBanned, ...player }) => player),
      question: question && {
        text: question.text, note_before: question.note_before, rekvizit_text: question.rekvizit_text,
        package_name: question.package_name, tournament_name: question.tournament_name, authors: question.authors,
        rekvizit_src: question.rekvizit_src && `/tv/handout?question=${this.index}`, rekvizit_kind: question.rekvizit_kind ?? 'image',
        ...(isRevealed && {
          answer: question.answer, accepted_answers: question.accepted_answers, comment: question.comment,
          source_media_src: question.source_media_src && `/tv/answer-image?question=${this.index}`, source_media_kind: question.source_media_kind ?? 'image',
        }),
      },
      answers: isRevealed ? view.answers.map(({ given, similarity, closestAnswer, hostCall, isDirectCall, adjustment, isBanned, ...result }) => result) : [],
      showPage: this.showPageView((_block, position) => `/tv/show-image?page=${this.showIndex}&block=${position}`),
      isNightMode: this.isNightMode,
    };
  }

  playerView(player) {
    const question = this.questions[this.index];
    const myAnswer = this.answers[this.index]?.get(player.id);
    const leaderboard = this.leaderboard();
    const me = leaderboard.find(entry => entry.id === player.id);
    const isBetweenRounds = this.phase === 'finished' || (this.phase === 'lobby' && this.round > 0);
    const showsLeaderboard = this.phase === 'reveal' || (isBetweenRounds && !this.isLeaderboardHidden);
    return {
      partyId: this.id, title: this.title, phase: this.phase, round: this.round, index: this.index, total: this.questions.length,
      remainingMs: this.remainingMs(), isPaused: this.pausedRemainingMs != null, playerCount: this.players.size, isNightMode: this.isNightMode,
      isLastRound: this.isLastRound,
      isLeaderboardHidden: isBetweenRounds && this.isLeaderboardHidden,
      rules: {
        pointSystem: this.rules.pointSystem, pointsSummary: this.rules.pointsSummary ?? summaryOf(this.rules.pointSystem), secondsPerQuestion: this.rules.secondsPerQuestion,
        secondsBetweenQuestions: this.rules.secondsBetweenQuestions, secondsOnAnswer: this.rules.secondsOnAnswer,
      },
      stake: this.stakeView(player),
      isBanned: PHASES_WITH_QUESTION.includes(this.phase) && this.isBanned(player.id, this.index),
      me: { name: player.name, hasPin: !!player.hasPin, preferences: player.preferences, score: me?.score ?? 0, roundScore: me?.roundScore ?? 0, rank: me?.rank ?? null, avgSeconds: me?.avgSeconds ?? null },
      question: PHASES_WITH_QUESTION.includes(this.phase) ? {
        text: question.text, noteBefore: question.note_before, handoutText: question.rekvizit_text, hasHandoutImage: !!question.rekvizit_src, handoutKind: question.rekvizit_kind ?? 'image',
      } : null,
      showPage: this.showPageView((_block, position) => `/show-image?page=${this.showIndex}&block=${position}`),
      myAnswer: myAnswer?.given ?? null,
      skip: this.skipStatus(player.id),
      reactions: this.areReactionsOn ? REACTIONS : [],
      reactionsPerMinute: REACTIONS_PER_MINUTE,
      announcement: this.announcement,
      reveal: this.phase === 'reveal' ? {
        answer: question.answer, acceptedAnswers: question.accepted_answers, comment: question.comment,
        hasAnswerImage: !!question.source_media_src, answerKind: question.source_media_kind ?? 'image', isCorrect: myAnswer?.given ? !!myAnswer.isCorrect : null, ...this.revealedPointsOf(player),
        seconds: myAnswer?.ms != null && myAnswer.given ? Math.round(myAnswer.ms / 100) / 10 : null,
        isPending: !!myAnswer && myAnswer.verdict === 'unsure' && !myAnswer.decidedByHost,
      } : null,
      leaderboard: showsLeaderboard ? leaderboard.slice(0, 10).map(({ name, score, rank, avgSeconds }) => ({ name, score, rank, avgSeconds })) : null,
    };
  }

  revealedPointsOf(player) {
    if (this.index < this.firstPositionOf(player)) return { points: 0, streakBonus: 0, perfectBonus: 0, isRoundLost: false };
    const { perQuestion, isBroken, perfectBonus } = this.scoreOf(player, this.index + 1);
    const { points = 0, streakBonus = 0 } = perQuestion.at(-1) ?? {};
    return { points, streakBonus, perfectBonus, isRoundLost: isBroken };
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
  const headers = {
    'Content-Type': MEDIA_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
  };
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

function sendPage(res, file, title) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; media-src 'self' https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'",
    'Referrer-Policy': 'no-referrer',
  });
  res.end(fs.readFileSync(file, 'utf8').replaceAll('{{title}}', escapeHtml(title)));
}

function routeTv(game, req, res, url) {
  if (url.pathname === '/tv' || url.pathname === '/tv/') return sendPage(res, TV_PAGE, game.title);
  if (url.pathname === '/tv/join-qr.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.end(game.joinQrSvg);
  }
  if (url.pathname === '/tv/events') return openEventStream(game, req, res, { view: () => game.tvView() });
  if (url.pathname === '/tv/handout') {
    if (!PHASES_WITH_QUESTION.includes(game.phase)) throw new PartyError(404, 'No media');
    return sendMedia(req, res, game.questions[game.index].rekvizit_src);
  }
  if (url.pathname === '/tv/show-image') return sendMedia(req, res, game.showImageSrc(url));
  if (url.pathname === '/tv/answer-image') {
    if (game.phase !== 'reveal') throw new PartyError(404, 'No media');
    return sendMedia(req, res, game.questions[game.index].source_media_src);
  }
  throw new PartyError(404, 'Not found');
}

async function route(game, req, res) {
  const url = new URL(req.url, 'http://party');
  const token = url.searchParams.get('token');
  if (req.method === 'GET' && url.pathname === '/') return sendPage(res, PLAYER_PAGE, game.title);
  if (req.method === 'POST' && url.pathname === '/join') {
    const body = await readJson(req);
    const player = game.join(body.name, body.pin);
    return sendJson(res, 200, { token: player.token, partyId: game.id, name: player.name });
  }
  if (req.method === 'GET' && url.pathname === '/me') {
    const player = game.playerByToken(token);
    return sendJson(res, 200, { name: player.name, partyId: game.id });
  }
  if (req.method === 'POST' && url.pathname === '/rename') {
    const body = await readJson(req);
    const player = game.rename(body.token, body.name, body.pin);
    return sendJson(res, 200, { name: player.name });
  }
  if (req.method === 'POST' && url.pathname === '/pin') {
    const body = await readJson(req);
    game.setPin(body.token, body.pin ?? null);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/preferences') {
    const body = await readJson(req);
    return sendJson(res, 200, { preferences: game.setPreferences(body.token, body.preferences) });
  }
  if (req.method === 'POST' && url.pathname === '/away') {
    const body = await readJson(req);
    game.reportAway(body.token, { round: body.round, index: body.index });
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
  if (req.method === 'POST' && url.pathname === '/stake') {
    const body = await readJson(req);
    return sendJson(res, 200, { stake: game.setStake(body.token, { pick: body.pick, isRisked: body.isRisked }) });
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
  if (req.method === 'GET' && url.pathname === '/show-image') {
    game.playerByToken(token);
    return sendMedia(req, res, game.showImageSrc(url));
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
    if (!res.headersSent) sendJson(res, e.status ?? 500, { error: e.status ? e.message : 'Something went wrong', ...(e.needsPin && { needsPin: true }) });
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

module.exports = { DEFAULT_PARTY_TITLE, PARTY_LIMITS, DEFAULT_RULES, REACTIONS, PartyGame, PartyError, lanAddresses, openParty };
