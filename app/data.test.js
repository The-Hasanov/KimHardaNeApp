'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { installData } = require('./data');
const needsFixtures = { skip: !fs.existsSync(path.join(__dirname, 'fixtures')) && 'needs app/fixtures, which is not published' };

function bundle(dir, name, rows, { withVectors = true } = {}) {
  const file = path.join(dir, name);
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE questions (package_id INTEGER, kind TEXT, value_id INTEGER, uid TEXT UNIQUE, text TEXT, answer TEXT,
           edited_at TEXT, PRIMARY KEY (package_id, kind, value_id))`);
  db.exec('CREATE TABLE embeddings (uid TEXT PRIMARY KEY, hash TEXT NOT NULL, vec BLOB NOT NULL)');
  const add = db.prepare("INSERT INTO questions VALUES (1, 'question', ?, ?, ?, ?, NULL)");
  const vec = db.prepare('INSERT INTO embeddings VALUES (?, ?, ?)');
  for (const [id, text, answer] of rows) {
    add.run(id, `1:question:${id}`, text, answer);
    vec.run(`1:question:${id}`, `h-${text}`, new Uint8Array([id]));
  }
  if (!withVectors) db.exec('DROP TABLE embeddings');
  db.close();
  return file;
}

const rows = file => {
  const db = new DatabaseSync(file, { readOnly: true });
  const out = Object.fromEntries(db.prepare('SELECT q.uid, q.text, q.edited_at, e.hash FROM questions q LEFT JOIN embeddings e USING (uid)')
    .all().map(r => [r.uid, { ...r }]));
  db.close();
  return out;
};

test('new version replaces data, keeps edits and one backup; same version is a no-op', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-data-'));
  const dir = path.join(tmp, 'userData');
  const v1 = bundle(tmp, 'v1.sqlite', [[1, 'old one', 'a'], [2, 'old two', 'b']]);
  const first = installData({ bundled: v1, dir, version: '1.0.0' });
  assert.equal(first.replaced, true);
  assert.equal(installData({ bundled: v1, dir, version: '1.0.0' }).replaced, false);

  const db = new DatabaseSync(first.db);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec("UPDATE questions SET text = 'my fix', edited_at = '2026-09-26' WHERE uid = '1:question:2'");
  db.exec("UPDATE embeddings SET hash = 'h-my fix' WHERE uid = '1:question:2'");
  db.close();

  const v2 = bundle(tmp, 'v2.sqlite', [[1, 'new one', 'a'], [2, 'new two', 'b'], [3, 'brand new', 'c']]);
  const up = installData({ bundled: v2, dir, version: '1.0.1' });
  assert.deepEqual([up.replaced, up.from, up.carried], [true, '1.0.0', 1]);
  const now = rows(up.db);
  assert.equal(now['1:question:1'].text, 'new one');
  assert.equal(now['1:question:3'].text, 'brand new');
  assert.equal(now['1:question:2'].text, 'my fix');
  assert.equal(now['1:question:2'].hash, 'h-my fix');
  assert.equal(rows(path.join(dir, '3sual.previous.sqlite'))['1:question:2'].text, 'my fix');
  assert.equal(fs.readFileSync(path.join(dir, 'data-version.txt'), 'utf8'), '1.0.1');
  assert.ok(!fs.existsSync(`${up.db}.new`));
  assert.equal(installData({ bundled: v2, dir, version: '1.0.1' }).replaced, false);
});

test('an interrupted update (marker not written) runs again without losing edits', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-data-'));
  const dir = path.join(tmp, 'userData');
  const v1 = bundle(tmp, 'v1.sqlite', [[1, 'old', 'a']]);
  const { db } = installData({ bundled: v1, dir, version: '1' });
  const w = new DatabaseSync(db);
  w.exec("UPDATE questions SET text = 'mine', edited_at = 'x'");
  w.close();
  const v2 = bundle(tmp, 'v2.sqlite', [[1, 'new', 'a']]);
  installData({ bundled: v2, dir, version: '2' });
  fs.rmSync(path.join(dir, 'data-version.txt'));
  installData({ bundled: v2, dir, version: '2' });
  assert.equal(rows(db)['1:question:1'].text, 'mine');
});

test('packages the user refreshed after the build keep their newer copy', needsFixtures, () => {
  const s = require('./scraper');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-data-'));
  const dir = path.join(tmp, 'userData');
  const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
  const osip = fixture('package_osip_questions.json'), erudit = fixture('package_erudit_themes.json');
  const build = (name, docs, at) => {
    const db = s.connect(path.join(tmp, name));
    for (const doc of docs) s.storePackage(db, 1, doc.package.id, doc, s.normalizePackage(doc));
    db.prepare('UPDATE packages SET fetched_at = ?').run(at);
    db.close();
    return path.join(tmp, name);
  };
  const { db } = installData({ bundled: build('v1.sqlite', [osip], '2026-01-01'), dir, version: '1' });

  const changed = structuredClone(osip);
  changed.package.phases[0].questions[0].values[0].answer = 'march answer';
  const w = s.connect(db);
  for (const doc of [changed, erudit]) s.storePackage(w, 1, doc.package.id, doc, s.normalizePackage(doc));
  w.prepare('UPDATE packages SET fetched_at = ?').run('2026-03-01');
  w.close();

  const up = installData({ bundled: build('v2.sqlite', [osip], '2026-02-01'), dir, version: '2' });
  assert.equal(up.newer, 2);
  const r = new DatabaseSync(db, { readOnly: true });
  assert.equal(r.prepare("SELECT answer FROM questions WHERE value_id = 932").get().answer, 'march answer');
  assert.equal(r.prepare('SELECT COUNT(*) AS n FROM questions WHERE package_id = 119').get().n, 12);
  assert.equal(r.prepare('SELECT COUNT(*) AS n FROM themes WHERE package_id = 119').get().n, 4);
  r.close();

  const v3 = installData({ bundled: build('v3.sqlite', [osip], '2026-04-01'), dir, version: '3' });
  const r3 = new DatabaseSync(db, { readOnly: true });
  assert.notEqual(r3.prepare("SELECT answer FROM questions WHERE value_id = 932").get().answer, 'march answer');
  assert.equal(v3.newer, 1);
  r3.close();
});

test("the user's lists survive a version update", () => {
  const { LISTS_SCHEMA } = require('./store');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-data-'));
  const dir = path.join(tmp, 'userData');
  const first = installData({ bundled: bundle(tmp, 'v1.sqlite', [[1, 'one', 'a'], [2, 'two', 'b']]), dir, version: '1.0.0' });
  const db = new DatabaseSync(first.db);
  db.exec(LISTS_SCHEMA);
  db.exec(`INSERT INTO lists VALUES (5, 'Friday', '2026-09-27');
    INSERT INTO list_questions VALUES (5, '1:question:2', 1, '2026-09-27'), (5, '1:question:1', 2, '2026-09-27')`);
  db.close();
  const up = installData({ bundled: bundle(tmp, 'v2.sqlite', [[1, 'one', 'a'], [2, 'two', 'b']]), dir, version: '1.0.1' });
  const updated = new DatabaseSync(up.db, { readOnly: true });
  assert.deepEqual(updated.prepare('SELECT id, name FROM lists').all().map(r => [r.id, r.name]), [[5, 'Friday']]);
  assert.deepEqual(updated.prepare('SELECT uid FROM list_questions ORDER BY position').all().map(r => r.uid), ['1:question:2', '1:question:1']);
  updated.close();
});

test('vectors the user built survive an update to data shipped without vectors', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-data-'));
  const dir = path.join(tmp, 'userData');
  installData({ bundled: bundle(tmp, 'v1.sqlite', [[1, 'one', 'a'], [2, 'two', 'b']]), dir, version: '1.0.0' });
  const withoutVectors = bundle(tmp, 'v2.sqlite', [[1, 'one', 'a'], [2, 'two', 'b']], { withVectors: false });
  const up = installData({ bundled: withoutVectors, dir, version: '1.0.1' });
  assert.deepEqual(Object.values(rows(up.db)).map(r => r.hash), ['h-one', 'h-two']);
});

test("the user's play results survive a version update", () => {
  const { PLAY_SCHEMA } = require('./store');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-data-'));
  const dir = path.join(tmp, 'userData');
  const first = installData({ bundled: bundle(tmp, 'v1.sqlite', [[1, 'one', 'a']]), dir, version: '1.0.0' });
  const db = new DatabaseSync(first.db);
  db.exec(PLAY_SCHEMA);
  db.exec(`INSERT INTO play_games VALUES (3, '2026-09-27', '2026-09-27', 'Friday', NULL, 60, 10);
    INSERT INTO play_answers VALUES (3, 0, '1:question:1', 'a', 'correct', 1, 'a', 1, 0, 9.5, '2026-09-27')`);
  db.close();
  const up = installData({ bundled: bundle(tmp, 'v2.sqlite', [[1, 'one', 'a']]), dir, version: '1.0.1' });
  const updated = new DatabaseSync(up.db, { readOnly: true });
  assert.deepEqual(updated.prepare('SELECT id, title FROM play_games').all().map(r => [r.id, r.title]), [[3, 'Friday']]);
  assert.equal(updated.prepare('SELECT given_answer FROM play_answers').get().given_answer, 'a');
  updated.close();
});
