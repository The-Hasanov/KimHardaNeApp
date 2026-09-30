'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const { Store, fold, DIM } = require('./store');

function tempDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-')), 'q.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE questions (package_id INTEGER, kind TEXT, value_id INTEGER, uid TEXT UNIQUE, origin TEXT, ordinal INTEGER,
    package_name TEXT, package_played TEXT, tournament_name TEXT, game_id INTEGER, game_name TEXT, phase_path TEXT,
    theme_name TEXT, theme_round INTEGER, group_size INTEGER, group_index INTEGER, text TEXT, answer TEXT, comment TEXT,
    accepted_answers TEXT, note_before TEXT, rekvizit_text TEXT, rekvizit_url TEXT, source_media_url TEXT, sources TEXT,
    authors TEXT, raw_value TEXT, raw_parent TEXT)`);
  db.exec('CREATE TABLE images (url TEXT PRIMARY KEY, status TEXT, path TEXT, bytes INTEGER, content_type TEXT, sha256 TEXT, error TEXT, fetched_at TEXT)');
  const add = db.prepare('INSERT INTO questions (package_id, kind, value_id, uid, ordinal, game_id, game_name, text, answer, sources) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  add.run('question', 1, '1:question:1', 1, 1, 'NHN', 'Azərbaycanın paytaxtı hansı şəhərdir?', 'Bakı', '["https://a.az"]');
  add.run('question', 2, '1:question:2', 2, 1, 'NHN', 'Futbol klubu "Qarabağ" hansı şəhəri təmsil edir?', 'Ağdam', null);
  add.run('theme', 3, '1:theme:3', 3, 3, 'Fərdi Oyun', 'Bakının ən qədim məhəlləsi', 'İçərişəhər', null);
  add.run('question', 4, '1:question:4', 4, 1, 'NHN', '-', '-', null);
  db.exec(`UPDATE questions SET authors = '[{"id":7,"fullname":"Aysel"},{"id":9,"fullname":"Nicat"}]' WHERE value_id IN (1, 3);
    UPDATE questions SET authors = '[{"id":9,"fullname":"Nicat"}]' WHERE value_id = 2`);
  db.close();
  return file;
}

const vec = (a, b = a, w = 0) => {
  const v = new Float32Array(DIM);
  v[a] = 1;
  v[b] += w;
  const n = Math.hypot(...v);
  return v.map(x => x / n);
};

function store(withVectors = false) {
  const s = new Store(tempDb());
  s.buildIndex();
  s.loadVectors('fake-model');
  if (withVectors) s.putVectors(s.staleRows(), [vec(0), vec(1), vec(2)]);
  return s;
}

test('fold ignores case, diacritics, ə and dotless ı', () => {
  assert.equal(fold('BAKI'), fold('Bakı'));
  assert.equal(fold('Baki'), fold('bakı'));
  assert.equal(fold('İçərişəhər'), 'icerisehe' + 'r');
  assert.equal(fold('Gəncə'), 'gence');
});

test('keyword search is accent-insensitive, prefix-aware and filterable', () => {
  const s = store();
  assert.deepEqual(s.search({ q: 'baki', mode: 'keyword' }).hits.map(h => h.uid).sort(), ['1:question:1', '1:theme:3']);
  assert.deepEqual(s.search({ q: 'icerisehe', mode: 'keyword' }).hits.map(h => h.uid), ['1:theme:3']);
  const nhn = s.search({ q: 'baki', mode: 'keyword', game: '1' });
  assert.deepEqual(nhn.hits.map(h => h.uid), ['1:question:1']);
  assert.equal(nhn.hits[0].ai, null);
  assert.equal(s.search({}).matches, 4);
  assert.deepEqual(s.staleRows().map(r => r.uid), ['1:question:1', '1:question:2', '1:theme:3']);
});

test('AI mode ranks by cosine; hybrid fuses keyword and AI hits', () => {
  const s = store(true);
  const qvec = vec(1, 0, 0.5);
  assert.deepEqual(s.search({ q: 'anything', mode: 'ai' }, qvec).hits.map(h => h.uid).slice(0, 2), ['1:question:2', '1:question:1']);
  const hybrid = s.search({ q: 'baki', mode: 'hybrid' }, qvec);
  assert.ok(hybrid.ai);
  const top = hybrid.hits[0];
  assert.equal(top.uid, '1:question:1');
  assert.ok(top.kw > 0 && top.ai > 0.4);
  assert.ok(hybrid.hits.some(h => h.uid === '1:question:2' && h.kw === null));
  assert.equal(s.search({ q: 'baki', mode: 'hybrid' }, null).ai, false);
});

test('save writes only changes, marks edited, reindexes and invalidates the vector', () => {
  const s = store(true);
  assert.equal(s.save('1:question:1', { text: s.get('1:question:1').text, sources: 'https://a.az' }), null);
  const row = s.save('1:question:1', { answer: 'Bakı (Abşeron)', comment: '', sources: ' https://a.az \n\nhttps://b.az ' });
  assert.ok(row.edited_at);
  const q = s.get('1:question:1');
  assert.deepEqual(q.sources, ['https://a.az', 'https://b.az']);
  assert.equal(q.comment, null);
  assert.deepEqual(s.search({ q: 'abseron', mode: 'keyword' }).hits.map(h => h.uid), ['1:question:1']);
  assert.deepEqual(s.search({ edited: true }).hits.map(h => h.uid), ['1:question:1']);
  assert.equal(s.vectorCount, 2);
  assert.deepEqual(s.staleRows().map(r => r.uid), ['1:question:1']);
  const again = new Store(s.db.location());
  again.loadVectors('fake-model');
  assert.equal(again.vectorCount, 2);
  assert.throws(() => s.save('nope', { text: 'x' }), /unknown question/);
});

test('images: a downloaded copy is served from disk, otherwise the remote URL', () => {
  const file = tempDb();
  const remote = n => `https://api.3sual.az/images/rekvizit/${n}.png`;
  const db = new DatabaseSync(file);
  db.exec(`UPDATE questions SET rekvizit_url = '${remote('a')}' WHERE uid = '1:question:1'`);
  db.exec(`UPDATE questions SET rekvizit_url = '${remote('b')}' WHERE uid = '1:question:2'`);
  const s = new Store(file);
  assert.equal(s.get('1:question:1').rekvizit_src, remote('a'));
  db.exec(`INSERT INTO images (url, status, path) VALUES ('${remote('a')}', 'ok', 'images/aa/a.png'), ('${remote('b')}', 'ok', 'images/bb/gone.png')`);
  fs.mkdirSync(path.join(path.dirname(file), 'images', 'aa'), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(file), 'images', 'aa', 'a.png'), 'png');
  assert.match(s.get('1:question:1').rekvizit_src, /^file:\/\/\/.*\/images\/aa\/a\.png$/);
  assert.equal(s.get('1:question:2').rekvizit_src, remote('b'));
  assert.equal(s.get('1:theme:3').rekvizit_src, null);
});

test('author filter narrows browsing and keyword search to that author', () => {
  const s = store();
  const uids = opts => s.search(opts).hits.map(h => h.uid).sort();
  assert.deepEqual(uids({ author: 7 }), ['1:question:1', '1:theme:3']);
  assert.deepEqual(uids({ author: '9' }), ['1:question:1', '1:question:2', '1:theme:3']);
  assert.deepEqual(uids({ q: 'baki', mode: 'keyword', author: 9, game: '1' }), ['1:question:1']);
  assert.deepEqual(uids({ author: 404 }), []);
});

test('random picks playable questions of one game only', () => {
  const s = store();
  const picked = s.randomPlayableQuestions(1, 10);
  assert.deepEqual(picked.map(q => q.uid).sort(), ['1:question:1', '1:question:2']);
  assert.equal(picked[0].answer.length > 0, true);
  assert.equal(s.randomPlayableQuestions(1, 1).length, 1);
  assert.deepEqual(s.randomPlayableQuestions(99, 10), []);
  assert.deepEqual(s.randomPlayableQuestions(1, 10, ['1:question:1']).map(q => q.uid), ['1:question:2']);
  const own = s.createQuestion({ text: 'Qısa?', answer: 'Bəli' });
  assert.ok(!s.randomPlayableQuestions(1, 10).some(q => q.uid === own.uid));
  assert.deepEqual(s.randomPlayableQuestions(1, 1, [], { includeOwn: true }).map(q => q.uid), [own.uid]);
  assert.deepEqual(s.randomPlayableQuestions(1, 10, [], { includeOwn: true }).map(q => q.uid).sort(), [own.uid, '1:question:1', '1:question:2']);
});

test('lists keep their questions in order and survive renames, removals and deletion', () => {
  const s = store();
  const quiz = s.createList(' Friday quiz ');
  const spare = s.createList('Spare');
  s.addToList(quiz, '1:question:2');
  s.addToList(quiz, '1:question:1');
  s.addToList(quiz, '1:question:1');
  s.addToList(spare, '1:question:1');
  const uidsOf = listId => s.listQuestions(listId).map(q => q.uid);
  assert.deepEqual(uidsOf(quiz), ['1:question:2', '1:question:1']);
  s.reorderList(quiz, ['1:question:1', '1:question:2']);
  assert.deepEqual(uidsOf(quiz), ['1:question:1', '1:question:2']);
  s.renameList(quiz, 'Final');
  assert.deepEqual(s.allLists().map(l => [l.name, l.count]), [['Final', 2], ['Spare', 1]]);
  assert.deepEqual(s.listIdsContaining('1:question:1').sort(), [quiz, spare].sort());
  s.removeFromList(quiz, '1:question:1');
  assert.deepEqual(uidsOf(quiz), ['1:question:2']);
  s.deleteList(quiz);
  assert.deepEqual(s.allLists().map(l => l.name), ['Spare']);
  assert.deepEqual(s.listIdsContaining('1:question:2'), []);
});

test('dropping vectors turns AI ranking off, deletes them and ignores late ones', () => {
  const s = store(true);
  s.dropVectors();
  assert.equal(s.vectorCount, 0);
  assert.equal(s.search({ q: 'baki', mode: 'hybrid' }, vec(0)).ai, false);
  s.putVectors([s.get('1:question:1')], [vec(0)]);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM embeddings').get().n, 0);
  s.reload();
  assert.equal(s.vectorCount, 0);
});

test('the image filter keeps only questions with a handout image', () => {
  const file = tempDb();
  const db = new DatabaseSync(file);
  db.exec("UPDATE questions SET rekvizit_url = 'https://api.3sual.az/images/rekvizit/1.png' WHERE value_id = 3");
  db.close();
  const s = new Store(file);
  s.buildIndex();
  assert.deepEqual(s.search({ withImage: true }).hits.map(h => h.uid), ['1:theme:3']);
  assert.deepEqual(s.search({ q: 'baki', mode: 'keyword', withImage: true }).hits.map(h => h.uid), ['1:theme:3']);
});

test('play games save answers, overrides and scores; empty games are not kept', () => {
  const s = store();
  const gameId = s.startPlayGame({ title: 'Friday', secondsPerQuestion: 60, questionCount: 3 });
  s.savePlayAnswer(gameId, { position: 0, uid: '1:question:1', givenAnswer: 'Baki', verdict: 'correct', similarity: 1, closestAnswer: 'Bakı', secondsUsed: 12 });
  const unsure = s.savePlayAnswer(gameId, { position: 1, uid: '1:question:2', givenAnswer: 'Qarabağ', verdict: 'unsure', similarity: 0.7, closestAnswer: 'Ağdam', secondsUsed: 40 });
  assert.equal(unsure.is_correct, 0);
  const decided = s.setPlayAnswerCorrect(gameId, 1, true);
  assert.deepEqual([decided.is_correct, decided.decided_by_player], [1, 1]);
  s.finishPlayGame(gameId);
  const [game] = s.playGames();
  assert.deepEqual([game.title, game.answered, game.score, game.question_count, !!game.finished_at], ['Friday', 2, 2, 3, true]);
  assert.deepEqual(s.playGameAnswers(gameId).map(a => [a.given_answer, a.question.answer]), [['Baki', 'Bakı'], ['Qarabağ', 'Ağdam']]);
  const abandoned = s.startPlayGame({ title: 'Empty', secondsPerQuestion: 60, questionCount: 10 });
  s.finishPlayGame(abandoned);
  assert.deepEqual(s.playGames().map(g => g.id), [gameId]);
  s.deletePlayGame(gameId);
  assert.deepEqual(s.playGames(), []);
});

test('your own questions are searchable under My questions, kept as edits, and deletable without shifting other vectors', () => {
  const s = store(true);
  assert.throws(() => s.createQuestion({ text: 'Only the text' }), /text and answer/);
  const mountain = s.createQuestion({ text: 'Ən hündür dağ hansıdır?', answer: 'Şahdağ', sources: 'https://x.az' });
  const river = s.createQuestion({ text: 'Ən uzun çay hansıdır?', answer: 'Kür' });
  assert.ok(mountain.edited_at);
  assert.deepEqual(s.get(mountain.uid).sources, ['https://x.az']);
  assert.deepEqual(s.search({ q: 'sahdag', mode: 'keyword' }).hits.map(h => h.uid), [mountain.uid]);
  assert.deepEqual(s.games().map(g => [g.id, g.name, g.n]), [[0, 'My questions', 2], [1, 'NHN', 3], [3, 'Fərdi Oyun', 1]]);
  s.putVectors([mountain, river], [vec(3), vec(4)]);
  const listId = s.createList('Mine');
  s.addToList(listId, mountain.uid);
  assert.throws(() => s.deleteQuestion('1:question:1'), /own questions/);
  s.deleteQuestion(mountain.uid);
  assert.deepEqual([s.get(mountain.uid), s.search({ q: 'sahdag', mode: 'keyword' }).hits.length, s.listQuestions(listId).length], [null, 0, 0]);
  assert.equal(s.vectorCount, 4);
  assert.equal(s.search({ q: 'anything', mode: 'ai' }, vec(4)).hits[0].uid, river.uid);
  const lake = s.createQuestion({ text: 'Ən böyük göl hansıdır?', answer: 'Sarısu' });
  assert.equal(s.search({ q: 'sarisu', mode: 'keyword' }).hits[0].uid, lake.uid);
});

test('pictures on your own questions are saved next to the database, shown from there and removable', () => {
  const s = store();
  const own = s.createQuestion({ text: 'Bu hansı şəhərdir?', answer: 'Şəki' });
  const picture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-picture-')), 'Handout.PNG');
  fs.writeFileSync(picture, 'png bytes');
  const shown = s.setOwnImage(own.uid, 'rekvizit_url', picture);
  assert.match(shown.rekvizit_src, /^file:.*\/images\/own\/[0-9a-f]{64}\.png$/);
  assert.equal(fs.readFileSync(fileURLToPath(shown.rekvizit_src), 'utf8'), 'png bytes');
  assert.ok(s.search({ withImage: true }).hits.some(h => h.uid === own.uid));
  assert.equal(s.setOwnImage(own.uid, 'source_media_url', picture).source_media_src, shown.rekvizit_src);
  assert.equal(s.setOwnImage(own.uid, 'rekvizit_url', null).rekvizit_src, null);
  assert.throws(() => s.setOwnImage('1:question:1', 'rekvizit_url', picture), /own questions/);
  assert.throws(() => s.setOwnImage(own.uid, 'text', picture), /unknown picture/);
  assert.throws(() => s.setOwnImage(own.uid, 'rekvizit_url', 'notes.txt'), /PNG, JPEG/);
});

test('party results add up per player name across rounds and can be reset', () => {
  const s = store();
  s.addPartyResults([{ name: 'Aysel', correct: 3, wrong: 1, unanswered: 1 }, { name: 'Nicat', correct: 1, wrong: 0, unanswered: 4 }]);
  s.addPartyResults([{ name: 'aysel', correct: 2, wrong: 2, unanswered: 0 }]);
  assert.deepEqual(s.partyResults().map(({ name, correct, wrong, unanswered, rounds }) => [name, correct, wrong, unanswered, rounds]),
    [['aysel', 5, 3, 1, 2], ['Nicat', 1, 0, 4, 1]]);
  s.resetPartyResults();
  assert.deepEqual(s.partyResults(), []);
});
