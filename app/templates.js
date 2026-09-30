'use strict';

const MAX_ROUNDS = 20;
const MAX_NAME_LENGTH = 60;
const DEFAULT_ROUND = {
  listId: null, randomCount: 10, games: [], secondsPerQuestion: 60, secondsBetweenQuestions: 0, revealAtEnd: false, secondsOnAnswer: 0, pointSystemId: null,
};

const whole = (value, min, max, fallback) => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};
const gamesOf = games => [...new Set((Array.isArray(games) ? games : []).filter(key => typeof key === 'string' && /^[\w.-]{1,40}:[\w.-]{1,40}$/.test(key)))].slice(0, 200);
const idOf = value => (Number.isInteger(value) && value > 0 ? value : null);

function normalizeRound(round = {}) {
  return {
    listId: idOf(round.listId),
    randomCount: whole(round.randomCount, 1, 50, DEFAULT_ROUND.randomCount),
    games: gamesOf(round.games),
    secondsPerQuestion: whole(round.secondsPerQuestion, 10, 600, DEFAULT_ROUND.secondsPerQuestion),
    secondsBetweenQuestions: whole(round.secondsBetweenQuestions, 0, 120, DEFAULT_ROUND.secondsBetweenQuestions),
    revealAtEnd: !!round.revealAtEnd,
    secondsOnAnswer: whole(round.secondsOnAnswer, 0, 120, DEFAULT_ROUND.secondsOnAnswer),
    pointSystemId: idOf(round.pointSystemId),
  };
}

function normalizeTemplate({ id = null, name, rounds } = {}) {
  const cleanName = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  if (!cleanName) throw new Error('Give the template a name');
  const cleanRounds = (Array.isArray(rounds) ? rounds : []).slice(0, MAX_ROUNDS).map(normalizeRound);
  if (!cleanRounds.length) throw new Error('A template needs at least one round');
  return { id: idOf(id), name: cleanName, rounds: cleanRounds };
}

module.exports = { MAX_ROUNDS, DEFAULT_ROUND, normalizeRound, normalizeTemplate };
