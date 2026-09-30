'use strict';

const POINT_LIMIT = 1000;
const MAX_POOL_VALUES = 8;
const MAX_USES = 99;
const MAX_NAME_LENGTH = 40;

const CLASSIC_POINT_SYSTEM = {
  name: 'Classic',
  mode: 'simple',
  simple: { correct: 1, wrong: 0, unanswered: 0 },
  pool: [{ points: 10, wrong: 0, unanswered: 0, uses: null }, { points: 20, wrong: -10, unanswered: 0, uses: null }, { points: 30, wrong: -20, unanswered: -10, uses: null }],
  streak: { isOn: false, from: 3, bonus: 1, isGrowing: false },
  allOrNothing: { isOn: false, unansweredCountsAsWrong: true },
  perfectBonus: { isOn: false, points: 5 },
  risk: { isOn: false, correct: 2, wrong: -2, limit: null },
};

const pointsOf = (value, fallback = 0) => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.max(-POINT_LIMIT, Math.min(POINT_LIMIT, number)) : fallback;
};
const countOf = (value, min, max, fallback) => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};
const limitOf = (value, max) => (value == null || value === '' ? null : countOf(value, 1, max, null));

function normalizePointSystem(input = {}) {
  const base = CLASSIC_POINT_SYSTEM;
  const name = String(input.name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH) || 'Untitled';
  const mode = input.mode === 'pool' ? 'pool' : 'simple';
  const simple = {
    correct: pointsOf(input.simple?.correct, base.simple.correct),
    wrong: pointsOf(input.simple?.wrong, base.simple.wrong),
    unanswered: pointsOf(input.simple?.unanswered, base.simple.unanswered),
  };
  const seen = new Set();
  const pool = (Array.isArray(input.pool) && input.pool.length ? input.pool : base.pool)
    .map(entry => ({ points: pointsOf(entry?.points), wrong: pointsOf(entry?.wrong), unanswered: pointsOf(entry?.unanswered), uses: limitOf(entry?.uses, MAX_USES) }))
    .filter(entry => entry.points > 0 && !seen.has(entry.points) && seen.add(entry.points))
    .sort((a, b) => a.points - b.points)
    .slice(0, MAX_POOL_VALUES);
  const streak = {
    isOn: !!input.streak?.isOn,
    from: countOf(input.streak?.from, 2, 20, base.streak.from),
    bonus: countOf(input.streak?.bonus, 1, POINT_LIMIT, base.streak.bonus),
    isGrowing: !!input.streak?.isGrowing,
  };
  const allOrNothing = {
    isOn: !!input.allOrNothing?.isOn,
    unansweredCountsAsWrong: input.allOrNothing?.unansweredCountsAsWrong !== false,
  };
  const oldPerfectBonus = Number(input.allOrNothing?.perfectBonus) || 0;
  const perfectBonus = {
    isOn: typeof input.perfectBonus?.isOn === 'boolean' ? input.perfectBonus.isOn : oldPerfectBonus > 0,
    points: countOf(input.perfectBonus?.points ?? (oldPerfectBonus || undefined), 1, POINT_LIMIT, base.perfectBonus.points),
  };
  const risk = {
    isOn: mode === 'simple' && !!input.risk?.isOn,
    correct: pointsOf(input.risk?.correct, base.risk.correct),
    wrong: pointsOf(input.risk?.wrong, base.risk.wrong),
    limit: limitOf(input.risk?.limit, MAX_USES),
  };
  return { name, mode, simple, pool: pool.length ? pool : base.pool, streak, allOrNothing, perfectBonus, risk };
}

const signed = points => (points > 0 ? `+${points}` : points < 0 ? `−${-points}` : '0');

function summaryOf(system) {
  const lines = [];
  if (system.mode === 'simple') lines.push(`Correct ${signed(system.simple.correct)} · Wrong ${signed(system.simple.wrong)} · No answer ${signed(system.simple.unanswered)}`);
  else lines.push(`Point pool: ${system.pool.map(entry => (entry.uses ? `${entry.points} ×${entry.uses}` : `${entry.points}`)).join(', ')}`);
  if (system.risk.isOn) lines.push(`Risk: correct ${signed(system.risk.correct)} · wrong ${signed(system.risk.wrong)}${system.risk.limit ? ` · ${system.risk.limit} per round` : ''}`);
  if (system.streak.isOn) lines.push(`Streak: ${signed(system.streak.bonus)}${system.streak.isGrowing ? ' more each time' : ''} from ${system.streak.from} correct in a row`);
  if (system.allOrNothing.isOn) {
    lines.push(`All or nothing${system.allOrNothing.unansweredCountsAsWrong ? '' : ' (no answer is not a miss)'}`);
  }
  if (system.perfectBonus.isOn) lines.push(`All correct bonus: ${signed(system.perfectBonus.points)} for a round with every answer right`);
  return lines;
}

function roundProblem(system, questionCount) {
  if (system.mode !== 'pool' || system.pool.some(entry => entry.uses == null)) return null;
  const picks = system.pool.reduce((sum, entry) => sum + entry.uses, 0);
  if (questionCount <= picks) return null;
  return `This round has ${questionCount} questions, but the point system “${system.name}” allows only ${picks} picks. Add uses to the pool or play fewer questions.`;
}

function usesLeft(system, stakes) {
  return system.pool.map((entry, index) => (entry.uses == null ? null : entry.uses - stakes.filter(stake => stake?.pick === index).length));
}

function pickFor(system, stakesBefore, wanted) {
  const left = usesLeft(system, stakesBefore);
  const isFree = index => index >= 0 && index < system.pool.length && (left[index] == null || left[index] > 0);
  if (Number.isInteger(wanted) && isFree(wanted)) return wanted;
  const lowest = system.pool.findIndex((_entry, index) => isFree(index));
  return lowest < 0 ? 0 : lowest;
}

function risksLeft(system, stakesBefore) {
  if (!system.risk.isOn) return 0;
  if (system.risk.limit == null) return Infinity;
  return system.risk.limit - stakesBefore.filter(stake => stake?.isRisked).length;
}

function basePoints(system, outcome, stake = {}) {
  if (outcome === 'pending') return 0;
  if (system.allOrNothing.isOn && outcome === 'unanswered') return 0;
  if (system.mode === 'pool') {
    const entry = system.pool[stake.pick] ?? system.pool[0];
    return outcome === 'correct' ? entry.points : entry[outcome];
  }
  if (stake.isRisked && outcome !== 'unanswered') return system.risk[outcome];
  return system.simple[outcome];
}

function scoreRound(system, entries, { isComplete = false } = {}) {
  let inARow = 0;
  let isBroken = false;
  let hasCorrect = false;
  let hasMiss = false;
  const perQuestion = entries.map(({ outcome, stake }) => {
    const points = basePoints(system, outcome, stake);
    let streakBonus = 0;
    if (outcome === 'correct') {
      hasCorrect = true;
      inARow += 1;
      if (system.streak.isOn && inARow >= system.streak.from) {
        streakBonus = system.streak.bonus * (system.streak.isGrowing ? inARow - system.streak.from + 1 : 1);
      }
    } else if (outcome !== 'pending') {
      inARow = 0;
      const isMiss = outcome === 'wrong' || !system.allOrNothing.isOn || system.allOrNothing.unansweredCountsAsWrong;
      if (isMiss) hasMiss = true;
      if (system.allOrNothing.isOn && isMiss) isBroken = true;
    }
    return { points, streakBonus };
  });
  const perfectBonus = system.perfectBonus.isOn && isComplete && !hasMiss && hasCorrect ? system.perfectBonus.points : 0;
  const earned = perQuestion.reduce((sum, { points, streakBonus }) => sum + points + streakBonus, 0);
  return { perQuestion, perfectBonus, isBroken, total: isBroken ? 0 : earned + perfectBonus };
}

module.exports = { CLASSIC_POINT_SYSTEM, normalizePointSystem, summaryOf, roundProblem, usesLeft, pickFor, risksLeft, scoreRound };
