'use strict';

const MAX_ROUNDS = 20;
const MAX_NAME_LENGTH = 60;
const DEFAULT_ROUND = {
  showPageIds: [], showPageIdsAfter: [], listId: null, randomCount: 10, games: [], secondsPerQuestion: 60, secondsBetweenQuestions: 0, revealAtEnd: false, secondsOnAnswer: 0, pointSystemId: null, showsLeaderboard: true,
};

const whole = (value, min, max, fallback) => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};
const gamesOf = games => [...new Set((Array.isArray(games) ? games : []).filter(key => typeof key === 'string' && /^[\w.-]{1,40}:[\w.-]{1,40}$/.test(key)))].slice(0, 200);
const idOf = value => (Number.isInteger(value) && value > 0 ? value : null);

const showPageIdsOf = ids => [...new Set((Array.isArray(ids) ? ids : []).map(idOf).filter(Boolean))].slice(0, 10);

function normalizeRound(round = {}) {
  return {
    showPageIds: showPageIdsOf(round.showPageIds),
    showPageIdsAfter: showPageIdsOf(round.showPageIdsAfter),
    listId: idOf(round.listId),
    randomCount: whole(round.randomCount, 1, 50, DEFAULT_ROUND.randomCount),
    games: gamesOf(round.games),
    secondsPerQuestion: whole(round.secondsPerQuestion, 10, 600, DEFAULT_ROUND.secondsPerQuestion),
    secondsBetweenQuestions: whole(round.secondsBetweenQuestions, 0, 120, DEFAULT_ROUND.secondsBetweenQuestions),
    revealAtEnd: !!round.revealAtEnd,
    secondsOnAnswer: whole(round.secondsOnAnswer, 0, 120, DEFAULT_ROUND.secondsOnAnswer),
    pointSystemId: idOf(round.pointSystemId),
    showsLeaderboard: round.showsLeaderboard !== false,
  };
}

function normalizeTemplate({ id = null, name, rounds } = {}) {
  const cleanName = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  if (!cleanName) throw new Error('Give the template a name');
  const cleanRounds = (Array.isArray(rounds) ? rounds : []).slice(0, MAX_ROUNDS).map(normalizeRound);
  if (!cleanRounds.length) throw new Error('A template needs at least one round');
  return { id: idOf(id), name: cleanName, rounds: cleanRounds };
}

module.exports = { whole, MAX_ROUNDS, DEFAULT_ROUND, normalizeRound, normalizeTemplate };
