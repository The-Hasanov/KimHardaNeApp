'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openLibraryFile } = require('./data');
const { Store, OWN_IMAGE_PREFIX } = require('./store');
const { DATA_SOURCES, dataSourceById, describe } = require('./sources');

const threeSual = dataSourceById('3sual');

function library() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-sources-'));
  const store = new Store(openLibraryFile(dir), { imagesRoot: dir });
  return { dir, store, db: store.db };
}

function addSiteQuestion(db, id, { picture = null, isEdited = false } = {}) {
  db.prepare(`INSERT INTO questions (package_id, kind, value_id, uid, origin, text, answer, rekvizit_url, edited_at)
    VALUES (7, 'question', ?, ?, 'package', 'Site question text', 'Answer', ?, ?)`).run(id, `7:question:${id}`, picture, isEdited ? '2026-01-01' : null);
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
  assert.throws(() => dataSourceById('nope'), /Unknown data source/);
});

test('3sual status counts questions, edits and saved pictures, and is unfinished until a run finishes', () => {
  const { dir, db } = library();
  addSiteQuestion(db, 1, { picture: 'https://api.3sual.az/images/a.png' });
  addSiteQuestion(db, 2, { picture: 'https://api.3sual.az/images/b.png', isEdited: true });
  savePicture(db, dir, 'https://api.3sual.az/images/a.png', 'images/aa/a.png');
  db.prepare("INSERT INTO images (url, status, path) VALUES ('https://api.3sual.az/images/b.png', 'ok', 'images/bb/gone.png')").run();
  db.prepare("INSERT INTO runs (started_at, status) VALUES ('2026-09-01T10:00:00+00:00', 'interrupted')").run();
  let status = threeSual.status(db, [dir]);
  assert.deepEqual({ ...status, pictures: { ...status.pictures } }, { state: 'unfinished', questions: 2, edited: 1, pictures: { referenced: 2, saved: 1 }, checkedAt: null });
  db.prepare("INSERT INTO runs (started_at, finished_at, status) VALUES ('2026-09-02T10:00:00+00:00', '2026-09-02T10:30:00+00:00', 'finished')").run();
  status = threeSual.status(db, [dir]);
  assert.equal(status.state, 'installed');
  assert.equal(status.checkedAt, '2026-09-02T10:30:00+00:00');
});

test('deleting 3sual keeps own questions, their pictures, lists and games, and frees the site pictures', () => {
  const { dir, store, db } = library();
  addSiteQuestion(db, 1, { picture: 'https://api.3sual.az/images/a.png' });
  savePicture(db, dir, 'https://api.3sual.az/images/a.png', 'images/aa/a.png');
  savePicture(db, dir, `${OWN_IMAGE_PREFIX}mine.png`, 'images/own/mine.png');
  db.prepare("INSERT INTO runs (started_at, status) VALUES ('2026-09-02T10:00:00+00:00', 'finished')").run();
  db.prepare("INSERT INTO packages (id, status) VALUES (7, 'ok')").run();
  db.prepare("INSERT INTO embeddings (uid, hash, vec) VALUES ('7:question:1', 'h', x'00')").run();
  store.reload();
  const own = store.createQuestion({ text: 'My own question text', answer: 'Mine' });
  const listId = store.createList('Favourites');
  store.addToList(listId, '7:question:1');
  store.addToList(listId, own.uid);

  threeSual.remove(db, [dir]);
  store.reload();

  assert.deepEqual(store.rows.map(row => row.uid), [own.uid]);
  assert.equal(threeSual.status(db, [dir]).state, 'available');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM embeddings').get().n, 0);
  assert.equal(fs.existsSync(path.join(dir, 'images/aa/a.png')), false);
  assert.equal(fs.existsSync(path.join(dir, 'images/own/mine.png')), true);
  assert.deepEqual(db.prepare('SELECT url FROM images').all().map(row => row.url), [`${OWN_IMAGE_PREFIX}mine.png`]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM list_questions WHERE list_id = ?').get(listId).n, 2);
  assert.deepEqual(store.listQuestions(listId).map(question => question.uid), [own.uid]);
});

test('the library file takes over the database from before data sources', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-library-'));
  const old = new DatabaseSync(path.join(dir, '3sual.sqlite'));
  old.exec("CREATE TABLE lists (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO lists (name) VALUES ('Kept')");
  old.close();
  const file = openLibraryFile(dir);
  assert.equal(path.basename(file), 'kimhardane.sqlite');
  assert.equal(fs.existsSync(path.join(dir, '3sual.sqlite')), false);
  const db = new DatabaseSync(file);
  assert.deepEqual(db.prepare('SELECT name FROM lists').all().map(row => row.name), ['Kept']);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'questions'").get());
  db.close();
});
