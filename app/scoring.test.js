'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePointSystem, scoreRound, roundProblem, pickFor, usesLeft, risksLeft, summaryOf } = require('./scoring');

const system = changes => normalizePointSystem({ name: 'Test', ...changes });
const round = (points, outcomes, options) => scoreRound(points, outcomes.map(outcome => (typeof outcome === 'string' ? { outcome } : outcome)), options);
const perQuestion = result => result.perQuestion.map(({ points, streakBonus }) => points + streakBonus);
const C = 'correct', W = 'wrong', U = 'unanswered';

test('simple points give each outcome its points', () => {
  const points = system({ simple: { correct: 3, wrong: -1, unanswered: -2 } });
  assert.equal(round(points, [C, W, U, C]).total, 3);
});

test('a flat streak bonus adds the same bonus from the nth correct answer in a row', () => {
  const points = system({ streak: { isOn: true, from: 3, bonus: 1 } });
  const result = round(points, [C, C, C, C, W, C]);
  assert.deepEqual(perQuestion(result), [1, 1, 2, 2, 0, 1]);
  assert.equal(result.total, 7);
  assert.deepEqual(perQuestion(round(points, [C, C, U, C, C, C])), [1, 1, 0, 1, 1, 2]);
});

test('a growing streak bonus grows by the bonus with every correct answer in a row', () => {
  const points = system({ streak: { isOn: true, from: 3, bonus: 1, isGrowing: true } });
  assert.deepEqual(perQuestion(round(points, [C, C, C, C, C])), [1, 1, 2, 3, 4]);
});

test('all or nothing pays only a clean round, and can have the all correct bonus', () => {
  const points = system({ simple: { correct: 2, wrong: -1, unanswered: -1 }, allOrNothing: { isOn: true }, perfectBonus: { isOn: true, points: 5 } });
  assert.equal(round(points, [C, C, C, C, C], { isComplete: true }).total, 15);
  assert.equal(round(points, [C, C, C, C, C]).total, 10);
  assert.equal(round(points, [C, C, W, C, C], { isComplete: true }).total, 0);
  assert.equal(round(points, [C, C, U, C, C], { isComplete: true }).total, 0);
  const lenient = system({ simple: { correct: 2, unanswered: -1 }, allOrNothing: { isOn: true, unansweredCountsAsWrong: false }, perfectBonus: { isOn: true, points: 5 } });
  assert.equal(round(lenient, [C, C, U, C, C], { isComplete: true }).total, 13);
  assert.equal(round(lenient, [U, U], { isComplete: true }).total, 0);
});

test('the all correct bonus works in any point system, only for a finished round with every answer right', () => {
  const points = system({ simple: { correct: 1, wrong: -1 }, perfectBonus: { isOn: true, points: 4 } });
  assert.equal(round(points, [C, C, C], { isComplete: true }).total, 7);
  assert.equal(round(points, [C, C, C]).total, 3);
  assert.equal(round(points, [C, W, C], { isComplete: true }).total, 1);
  assert.equal(round(points, [C, U, C], { isComplete: true }).total, 2);
  const pool = system({ mode: 'pool', pool: [{ points: 10 }, { points: 30 }], perfectBonus: { isOn: true, points: 20 } });
  assert.equal(round(pool, [{ outcome: C, stake: { pick: 1 } }, { outcome: C, stake: { pick: 0 } }], { isComplete: true }).total, 60);
  assert.equal(round(system({ simple: { correct: 1 } }), [C, C], { isComplete: true }).total, 2);
});

test('a perfect round bonus saved inside all or nothing becomes the all correct bonus', () => {
  const points = normalizePointSystem({ name: 'Old', allOrNothing: { isOn: true, perfectBonus: 7 } });
  assert.deepEqual(points.perfectBonus, { isOn: true, points: 7 });
  assert.equal('perfectBonus' in points.allOrNothing, false);
  assert.equal(normalizePointSystem({ name: 'New' }).perfectBonus.isOn, false);
});

test('a risked answer uses the risk points, and an unanswered risk scores as unanswered', () => {
  const points = system({ simple: { correct: 3, wrong: -1, unanswered: 0 }, risk: { isOn: true, correct: 6, wrong: -6 } });
  const risked = outcome => ({ outcome, stake: { isRisked: true } });
  assert.deepEqual(perQuestion(round(points, [C, risked(C), W, risked(W), risked(U)])), [3, 6, -1, -6, 0]);
});

test('a point pool scores the picked value, with its own wrong and unanswered points', () => {
  const points = system({ mode: 'pool', pool: [{ points: 10 }, { points: 20, wrong: -10 }, { points: 30, wrong: -20, unanswered: -10 }] });
  const picked = (pick, outcome) => ({ outcome, stake: { pick } });
  assert.deepEqual(perQuestion(round(points, [picked(2, C), picked(0, W), picked(1, W), picked(2, U), picked(1, C)])), [30, 0, -10, -10, 20]);
});

test('pool picks respect the uses left, falling back to the lowest free value', () => {
  const points = system({ mode: 'pool', pool: [{ points: 30, uses: 1 }, { points: 10, uses: 2 }, { points: 20, uses: 1 }] });
  assert.deepEqual(points.pool.map(entry => entry.points), [10, 20, 30]);
  assert.equal(pickFor(points, [], 2), 2);
  assert.equal(pickFor(points, [{ pick: 2 }], 2), 0);
  assert.equal(pickFor(points, [{ pick: 0 }, { pick: 0 }], undefined), 1);
  assert.deepEqual(usesLeft(points, [{ pick: 0 }, { pick: 2 }]), [1, 1, 0]);
  assert.equal(roundProblem(points, 4), null);
  assert.match(roundProblem(points, 5), /5 questions.*only 4 picks/);
  assert.equal(roundProblem(system({ mode: 'pool', pool: [{ points: 10 }, { points: 20, uses: 1 }] }), 50), null);
});

test('a point list scores each question by its position and blocks longer rounds', () => {
  const points = system({ mode: 'list', list: [{ points: 10 }, { points: 50, wrong: -20 }, { points: 10 }, { points: 50, unanswered: -5 }], risk: { isOn: true } });
  assert.deepEqual(perQuestion(round(points, [C, W, C, U])), [10, -20, 10, -5]);
  assert.deepEqual(perQuestion(round(points, [{ outcome: C, position: 1 }, { outcome: C, position: 3 }])), [50, 50]);
  assert.equal(points.risk.isOn, false);
  assert.deepEqual(summaryOf(points), ['Point list: 10, 50, 10, 50']);
  assert.equal(roundProblem(points, 4), null);
  assert.match(roundProblem(points, 5), /5 questions.*only 4/);
});

test('a banned question scores nothing and counts as a miss', () => {
  const points = system({ simple: { correct: 1, wrong: -1 }, streak: { isOn: true, from: 2, bonus: 1 }, perfectBonus: { isOn: true, points: 5 } });
  const result = round(points, [C, 'banned', C, C], { isComplete: true });
  assert.deepEqual(perQuestion(result), [1, 0, 1, 2]);
  assert.equal(result.perfectBonus, 0);
  assert.equal(round(system({ allOrNothing: { isOn: true, unansweredCountsAsWrong: false } }), [C, 'banned']).isBroken, true);
});

test('host adjustments add to the question points and survive all or nothing', () => {
  assert.deepEqual(perQuestion(round(system({}), [{ outcome: C, adjustment: 4 }, { outcome: W, adjustment: -2 }])), [5, -2]);
  const broken = round(system({ allOrNothing: { isOn: true } }), [{ outcome: C, adjustment: 3 }, W]);
  assert.deepEqual([broken.isBroken, broken.total], [true, 3]);
});

test('risks are limited per round, and a pool never has risk', () => {
  const points = system({ risk: { isOn: true, limit: 2 } });
  assert.equal(risksLeft(points, [{ isRisked: true }, {}, null]), 1);
  assert.equal(risksLeft(system({ risk: { isOn: true } }), [{ isRisked: true }]), Infinity);
  assert.equal(system({ mode: 'pool', risk: { isOn: true } }).risk.isOn, false);
});

test('point systems are cleaned and summarised', () => {
  const points = normalizePointSystem({ name: '  Brave   pool ', mode: 'pool', pool: [{ points: 20, wrong: 'x' }, { points: 20 }, { points: -5 }, { points: 5000, uses: 0 }], streak: { isOn: true, from: 1, bonus: 2 } });
  assert.equal(points.name, 'Brave pool');
  assert.deepEqual(points.pool, [{ points: 20, wrong: 0, unanswered: 0, uses: null }, { points: 1000, wrong: 0, unanswered: 0, uses: 1 }]);
  assert.equal(points.streak.from, 2);
  assert.deepEqual(summaryOf(points), ['Point pool: 20, 1000 ×1', 'Streak: +2 from 2 correct in a row']);
  assert.deepEqual(summaryOf(system({})), ['Correct +1 · Wrong 0 · No answer 0']);
});
