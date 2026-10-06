'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeShowPage } = require('./showPages');
const { Store } = require('./store');
const { tempDb } = require('./testDb');

test('show pages are cleaned, keep whether players may skip them, and round-trip through the store', () => {
  const image = `own-image:${'a'.repeat(64)}.png`;
  const video = `own-image:${'b'.repeat(64)}.mp4`;
  const page = normalizeShowPage({ title: '  Round   1 ', seconds: 1, blocks: [{ type: 'text', text: ' Hi ' }, { type: 'image', image }, { type: 'image', image: 'https://x/y.png' }, { type: 'video', image: video, isFullscreen: 1, isLooping: 1 }, { type: 'video', image }, { type: 'image', image: video }, { type: 'text', text: '  ' }] });
  assert.deepEqual(page, { id: null, title: 'Round 1', seconds: 3, canPlayersSkip: true, blocks: [{ type: 'text', text: 'Hi', isLarge: false }, { type: 'image', image, isFullscreen: false }, { type: 'video', image: video, isFullscreen: true, isLooping: true }] });
  assert.equal(normalizeShowPage({ title: 'Rules', canPlayersSkip: false }).canPlayersSkip, false);
  assert.throws(() => normalizeShowPage({ title: ' ', blocks: [] }), /title, a text, a picture or a video/);
  const store = new Store(tempDb());
  const id = store.saveShowPage(normalizeShowPage({ title: 'Rules', canPlayersSkip: false, blocks: [{ type: 'text', text: 'No phones' }] }));
  assert.deepEqual(store.showPages().map(saved => [saved.title, saved.canPlayersSkip, saved.blocks[0].text]), [['Rules', false, 'No phones']]);
  store.saveShowPage({ ...normalizeShowPage({ title: 'Rules' }), id });
  assert.equal(store.showPages()[0].canPlayersSkip, true);
});
