'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PartyGame } = require('./party');
const { PlayerProfiles, MAX_PIN_TRIES, PIN_LOCK_MS } = require('./profiles');
const { Store } = require('./store');
const { tempDb } = require('./testDb');

const judge = async () => ({ verdict: 'wrong' });

function gameWith(profiles = new PlayerProfiles()) {
  const game = new PartyGame({ judge, profiles });
  return { game, profiles };
}

test('a new name is accepted and gets a profile with default preferences', () => {
  const { game, profiles } = gameWith();
  const aysel = game.join('Aysel');
  assert.deepEqual(aysel.preferences, { showReactions: true, sound: true });
  assert.equal(aysel.hasPin, false);
  assert.ok(profiles.find('aysel'));
});

test('a name with a PIN asks for it, rejects a wrong one and accepts the right one', () => {
  const profiles = new PlayerProfiles();
  profiles.setPin('Aysel', '1234');
  const { game } = gameWith(profiles);
  assert.throws(() => game.join('aysel'), error => error.status === 403 && error.needsPin);
  assert.throws(() => game.join('Aysel', '9999'), /Wrong PIN. 4 tries left/);
  assert.throws(() => game.join('Aysel', 'abcd'), /Wrong PIN/);
  const aysel = game.join('Aysel', '1234');
  assert.equal(aysel.hasPin, true);
  assert.equal(game.playerView(aysel).me.hasPin, true);
});

test('too many wrong PINs lock the name for a minute', () => {
  let now = 0;
  const profiles = new PlayerProfiles(undefined, { now: () => now });
  profiles.setPin('Nicat', '4321');
  const { game } = gameWith(profiles);
  for (let i = 1; i < MAX_PIN_TRIES; i++) assert.throws(() => game.join('Nicat', '0000'), /Wrong PIN/);
  assert.throws(() => game.join('Nicat', '0000'), error => error.status === 429);
  assert.throws(() => game.join('Nicat', '4321'), /Try again in 60 s/);
  now += PIN_LOCK_MS;
  assert.equal(game.join('Nicat', '4321').name, 'Nicat');
});

test('the right PIN moves a player to a new device and keeps their score', () => {
  const profiles = new PlayerProfiles();
  profiles.setPin('Aysel', '1234');
  const { game } = gameWith(profiles);
  const oldPhone = game.join('Aysel', '1234');
  const oldToken = oldPhone.token;
  const ended = [];
  game.streams.add({ playerId: oldPhone.id, view: () => null, send() {}, sendEvent() {}, end: view => ended.push(view.phase) });
  assert.throws(() => game.join('Aysel'), /PIN/);
  const newPhone = game.join('Aysel', '1234');
  assert.equal(newPhone.id, oldPhone.id);
  assert.notEqual(newPhone.token, oldToken);
  assert.deepEqual(ended, ['moved']);
  assert.throws(() => game.playerByToken(oldToken), /Join/);
  assert.equal(game.players.size, 1);
});

test('a taken name without a PIN stays taken', () => {
  const { game } = gameWith();
  game.join('Leyla');
  assert.throws(() => game.join('leyla'), /taken/);
});

test('renaming to a protected name needs its PIN, and players can set, change and remove their own PIN', () => {
  const profiles = new PlayerProfiles();
  profiles.setPin('Orxan', '1111');
  const { game } = gameWith(profiles);
  const player = game.join('Kamran');
  assert.throws(() => game.rename(player.token, 'Orxan'), error => error.needsPin);
  game.rename(player.token, 'Orxan', '1111');
  assert.equal(player.name, 'Orxan');
  assert.throws(() => game.setPin(player.token, '12'), /4 digits/);
  game.setPin(player.token, '2222');
  assert.throws(() => profiles.unlock('Orxan', '1111'), /Wrong PIN/);
  game.setPin(player.token, null);
  assert.equal(player.hasPin, false);
  assert.doesNotThrow(() => profiles.unlock('Orxan'));
  game.rename(player.token, 'orxan');
  assert.equal(player.name, 'orxan');
});

test('preferences are saved by name and follow the player to a new game', () => {
  const profiles = new PlayerProfiles();
  const first = gameWith(profiles).game;
  const aysel = first.join('Aysel');
  assert.deepEqual(first.setPreferences(aysel.token, { sound: false, showReactions: 'yes', extra: true }), { showReactions: true, sound: false });
  const second = gameWith(profiles).game;
  assert.deepEqual(second.join('AYSEL').preferences, { showReactions: true, sound: false });
  const renamed = second.join('Nicat');
  second.setPreferences(renamed.token, { showReactions: false });
  second.rename(renamed.token, 'Brand new');
  assert.deepEqual(renamed.preferences, { showReactions: false, sound: true });
});

test('profiles are stored in the database, and the host can clear a PIN or delete a profile', () => {
  const store = new Store(tempDb());
  const profiles = new PlayerProfiles(store.partyProfileStorage);
  profiles.setPin('Aysel', '1234');
  profiles.setPreferences('Aysel', { sound: false });
  profiles.ensure('Nicat');
  store.addPartyResults([{ name: 'Aysel', correct: 2, wrong: 1, unanswered: 0 }]);
  const again = new PlayerProfiles(store.partyProfileStorage);
  assert.ok(again.hasPin('aysel'));
  assert.equal(again.preferencesOf('Aysel').sound, false);
  assert.ok(!JSON.stringify(store.partyProfiles()).includes('1234'));
  assert.deepEqual(store.partyProfiles().map(p => [p.name, p.has_pin, p.rounds]).sort(), [['Aysel', true, 1], ['Nicat', false, 0]]);
  store.clearPartyProfilePin('AYSEL');
  assert.equal(again.hasPin('Aysel'), false);
  store.deletePartyProfile('Aysel');
  assert.equal(store.partyResults().length, 1);
  store.deletePartyProfile('Nicat', { withResults: true });
  profiles.ensure('Aysel');
  store.deletePartyProfile('Aysel', { withResults: true });
  assert.deepEqual(store.partyProfiles(), []);
  assert.deepEqual(store.partyResults(), []);
});

test('the join route tells the phone when a PIN is needed', async () => {
  const profiles = new PlayerProfiles();
  profiles.setPin('Aysel', '1234');
  const { game, close } = await require('./party').openParty({ judge, profiles }, { port: 0 });
  try {
    const join = body => fetch(`http://127.0.0.1:${game.port}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const asked = await join({ name: 'Aysel' });
    assert.equal(asked.status, 403);
    assert.equal((await asked.json()).needsPin, true);
    const joined = await join({ name: 'aysel', pin: '1234' });
    assert.equal(joined.status, 200);
    assert.equal((await joined.json()).name, 'Aysel');
  } finally {
    await close();
  }
});
