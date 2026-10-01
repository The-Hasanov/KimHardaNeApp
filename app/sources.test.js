'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareLibrary } = require('./data');
const { Store, OWN_IMAGE_PREFIX } = require('./store');
const { DATA_SOURCES, dataSourceById, describe, removeDataSource } = require('./sources');

const threeSual = dataSourceById('3sual');

function library() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-sources-'));
  const store = new Store(prepareLibrary(path.join(dir, 'kimhardane.sqlite')), { imagesRoot: dir });
  return { dir, store, db: store.db };
}

function addSiteQuestion(db, id, { picture = null, isEdited = false, sourceId = '3sual' } = {}) {
  db.prepare(`INSERT INTO questions (source_id, package_id, kind, value_id, uid, origin, text, answer, rekvizit_url, edited_at)
    VALUES (?, 7, 'question', ?, ?, 'package', 'Site question text', 'Answer', ?, ?)`).run(sourceId, id, `${sourceId}:7:${id}`, picture, isEdited ? '2026-01-01' : null);
}

function savePicture(db, dir, url, rel) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), 'bytes');
  db.prepare("INSERT INTO images (url, status, path) VALUES (?, 'ok', ?)").run(url, rel);
}

test('an empty library has every data source available and no questions', () => {
  const { dir, store, db } = library();
  assert.equal(store.rows.length, 0);
  assert.deepEqual(DATA_SOURCES.map(source => source.id), ['3sual']);
  const status = describe(threeSual, db, [dir]);
  assert.equal(status.state, 'available');
  assert.equal(status.questions, 0);
  assert.deepEqual([status.kind, status.price], ['scraper', null]);
  assert.throws(() => dataSourceById('nope'), /Unknown data source/);
});

test('3sual status counts questions, edits and saved pictures, and is unfinished until a run finishes', () => {
  const { dir, db } = library();
  addSiteQuestion(db, 1, { picture: 'https://api-v2.3sual.az/images/a.png' });
  addSiteQuestion(db, 2, { picture: 'https://api-v2.3sual.az/images/b.png', isEdited: true });
  savePicture(db, dir, 'https://api-v2.3sual.az/images/a.png', 'images/aa/a.png');
  db.prepare("INSERT INTO images (url, status, path) VALUES ('https://api-v2.3sual.az/images/b.png', 'ok', 'images/bb/gone.png')").run();
  db.prepare("INSERT INTO runs (started_at, status) VALUES ('2026-09-01T10:00:00+00:00', 'interrupted')").run();
  addSiteQuestion(db, 3, { sourceId: 'other' });
  let status = describe(threeSual, db, [dir]);
  assert.deepEqual([status.state, status.questions, status.edited, { ...status.pictures }, status.checkedAt], ['unfinished', 2, 1, { referenced: 2, saved: 1 }, null]);
  db.prepare("INSERT INTO runs (started_at, finished_at, status) VALUES ('2026-09-02T10:00:00+00:00', '2026-09-02T10:30:00+00:00', 'finished')").run();
  status = describe(threeSual, db, [dir]);
  assert.equal(status.state, 'installed');
  assert.equal(status.checkedAt, '2026-09-02T10:30:00+00:00');
});

test('an install that brought no questions is unfinished and reports why, not installed', async () => {
  const { dir, db } = library();
  db.prepare("INSERT INTO runs (started_at, finished_at, status) VALUES ('2026-10-01T10:00:00+00:00', '2026-10-01T10:00:04+00:00', 'finished')").run();
  assert.equal(describe(threeSual, db, [dir]).state, 'unfinished');
  const scraper = require('./scraper');
  const { crawl } = scraper;
  scraper.crawl = async () => ({ status: 'finished', report: { complete: false, listing: { unique_packages_listed: 0 }, failures: [{ message: 'page 1: HTTP 404' }] } });
  try {
    const result = await threeSual.download(db, { mode: 'quick', signal: new AbortController().signal, roots: [dir], progress: () => {} });
    assert.equal(result.error, '3sual.az listed no packages: page 1: HTTP 404');
  } finally {
    scraper.crawl = crawl;
  }
});

test('deleting 3sual keeps own questions, other sources, their pictures, lists and games, and frees the site pictures', () => {
  const { dir, store, db } = library();
  addSiteQuestion(db, 1, { picture: 'https://api-v2.3sual.az/images/a.png' });
  addSiteQuestion(db, 2, { picture: 'https://api-v2.3sual.az/images/shared.png' });
  addSiteQuestion(db, 2, { picture: 'https://api-v2.3sual.az/images/shared.png', sourceId: 'other' });
  savePicture(db, dir, 'https://api-v2.3sual.az/images/a.png', 'images/aa/a.png');
  savePicture(db, dir, 'https://api-v2.3sual.az/images/shared.png', 'images/sh/shared.png');
  savePicture(db, dir, `${OWN_IMAGE_PREFIX}mine.png`, 'images/own/mine.png');
  db.prepare("INSERT INTO runs (started_at, status) VALUES ('2026-09-02T10:00:00+00:00', 'finished')").run();
  db.prepare("INSERT INTO packages (id, status) VALUES (7, 'ok')").run();
  db.prepare("INSERT INTO embeddings (uid, hash, vec) VALUES ('3sual:7:1', 'h', x'00')").run();
  store.reload();
  const own = store.createQuestion({ text: 'My own question text', answer: 'Mine' });
  const listId = store.createList('Favourites');
  store.addToList(listId, '3sual:7:1');
  store.addToList(listId, own.uid);

  removeDataSource(threeSual, db, [dir]);
  store.reload();

  assert.deepEqual(store.rows.map(row => row.uid).sort(), ['other:7:2', own.uid].sort());
  assert.equal(describe(threeSual, db, [dir]).state, 'available');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM embeddings').get().n, 0);
  assert.equal(fs.existsSync(path.join(dir, 'images/aa/a.png')), false);
  assert.equal(fs.existsSync(path.join(dir, 'images/own/mine.png')), true);
  assert.equal(fs.existsSync(path.join(dir, 'images/sh/shared.png')), true);
  assert.deepEqual(db.prepare('SELECT url FROM images ORDER BY url').all().map(row => row.url), ['https://api-v2.3sual.az/images/shared.png', `${OWN_IMAGE_PREFIX}mine.png`]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM list_questions WHERE list_id = ?').get(listId).n, 2);
  assert.deepEqual(store.listQuestions(listId).map(question => question.uid), [own.uid]);
});
