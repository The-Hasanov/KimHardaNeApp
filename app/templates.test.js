'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTemplate, normalizeRound, DEFAULT_ROUND, MAX_ROUNDS } = require('./templates');
const { Store } = require('./store');
const { tempDb } = require('./testDb');

test('template rounds are cleaned to safe values', () => {
  assert.deepEqual(normalizeRound({}), DEFAULT_ROUND);
  assert.deepEqual(normalizeRound({ listId: 4, randomCount: 500, secondsPerQuestion: 2, secondsBetweenQuestions: 'x', revealAtEnd: 1, secondsOnAnswer: -5, pointSystemId: 2.5 }),
    { ...DEFAULT_ROUND, listId: 4, randomCount: 50, secondsPerQuestion: 10, revealAtEnd: true, secondsOnAnswer: 0 });
  assert.deepEqual(normalizeRound({ games: ['3sual:1', '3sual:1', 'own:0', 42, 'bad key', ''] }).games, ['3sual:1', 'own:0']);
  const template = normalizeTemplate({ name: '  Friday   night ', rounds: Array.from({ length: 30 }, () => ({})) });
  assert.equal(template.name, 'Friday night');
  assert.equal(template.rounds.length, MAX_ROUNDS);
  assert.throws(() => normalizeTemplate({ name: ' ', rounds: [{}] }), /name/);
  assert.throws(() => normalizeTemplate({ name: 'Empty', rounds: [] }), /at least one round/);
});

test('templates are saved, overwritten by name, and know which point systems they use', () => {
  const store = new Store(tempDb());
  const pool = store.savePointSystem({ name: 'Brave pool', mode: 'pool' });
  const classic = store.savePointSystem({ name: 'Classic', mode: 'simple' });
  const id = store.saveGameTemplate(normalizeTemplate({ name: 'Friday night', rounds: [{ pointSystemId: classic }, { pointSystemId: pool }] }));
  assert.equal(store.saveGameTemplate(normalizeTemplate({ name: 'friday NIGHT', rounds: [{ pointSystemId: classic }] })), id);
  assert.deepEqual(store.gameTemplates().map(template => [template.name, template.rounds.length]), [['friday NIGHT', 1]]);
  const other = store.saveGameTemplate(normalizeTemplate({ name: 'Quick', rounds: [{ pointSystemId: pool }] }));
  assert.throws(() => store.saveGameTemplate({ id: other, name: 'Friday night', rounds: [] }), /already exists/);
  assert.deepEqual(store.templatesUsingPointSystem(pool), ['Quick']);
  assert.deepEqual(store.templatesUsingPointSystem(classic), ['friday NIGHT']);
  store.deleteGameTemplate(other);
  assert.deepEqual(store.templatesUsingPointSystem(pool), []);
});
