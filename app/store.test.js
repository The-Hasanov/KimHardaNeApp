'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const { Store, fold, hashOf, DIM } = require('./store');
const { tempDb } = require('./testDb');

const FAKE_SPACE = { id: 'fake-model', dim: DIM };

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
  s.loadVectors(FAKE_SPACE);
  if (withVectors) s.putVectors(s.staleRows(), [vec(0), vec(1), vec(2)]);
  return s;
}

test('with AI search off no vectors are loaded and every embeddable row is stale', () => {
  const s = new Store(tempDb());
  assert.deepEqual(s.staleRows().map(r => r.uid), ['1:question:1', '1:question:2', '1:theme:3']);
});

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
  const nhn = s.search({ q: 'baki', mode: 'keyword', games: ['3sual:1'] });
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
  again.loadVectors(FAKE_SPACE);
  assert.equal(again.vectorCount, 2);
  assert.throws(() => s.save('nope', { text: 'x' }), /unknown question/);
});

test('images: a downloaded copy is served from disk, otherwise the remote URL', () => {
  const file = tempDb();
  const remote = n => `https://api-v2.3sual.az/images/rekvizit/${n}.png`;
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
  assert.deepEqual(uids({ q: 'baki', mode: 'keyword', author: 9, games: ['3sual:1'] }), ['1:question:1']);
  assert.deepEqual(uids({ author: 404 }), []);
});

test('random picks playable questions from the chosen games of any source, or from everything', () => {
  const s = store();
  const picked = s.randomPlayableQuestions(['3sual:1'], 10);
  assert.deepEqual(picked.map(q => q.uid).sort(), ['1:question:1', '1:question:2']);
  assert.equal(picked[0].answer.length > 0, true);
  assert.equal(s.randomPlayableQuestions(['3sual:1'], 1).length, 1);
  assert.deepEqual(s.randomPlayableQuestions(['3sual:99', 'other:1'], 10), []);
  assert.deepEqual(s.randomPlayableQuestions(['3sual:1'], 10, ['1:question:1']).map(q => q.uid), ['1:question:2']);
  const own = s.createQuestion({ text: 'Qısa?', answer: 'Bəli' });
  assert.ok(!s.randomPlayableQuestions(['3sual:1'], 10).some(q => q.uid === own.uid));
  assert.deepEqual(s.randomPlayableQuestions(['own:0'], 10).map(q => q.uid), [own.uid]);
  assert.deepEqual(s.randomPlayableQuestions([], 10).map(q => q.uid).sort(), ['1:question:1', '1:question:2', own.uid]);
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
  db.exec("UPDATE questions SET rekvizit_url = 'https://api-v2.3sual.az/images/rekvizit/1.png' WHERE value_id = 3");
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
  assert.deepEqual(s.games().map(g => [g.sourceId, g.key, g.name, g.n]), [['3sual', '3sual:1', 'NHN', 3], ['3sual', '3sual:3', 'Fərdi Oyun', 1], ['own', 'own:0', 'My questions', 2]]);
  assert.deepEqual(s.search({ games: ['own:0'] }).hits.map(h => h.uid).sort(), [mountain.uid, river.uid].sort());
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

test('party results add up per player name across rounds, rank by points then time, and can be reset', () => {
  const s = store();
  s.addPartyResults([{ name: 'Aysel', points: 6, correct: 3, wrong: 1, unanswered: 1, correctMs: 30000 }, { name: 'Nicat', points: 10, correct: 1, wrong: 0, unanswered: 4, correctMs: 5000 }]);
  s.addPartyResults([{ name: 'aysel', points: 4, correct: 2, wrong: 2, unanswered: 0, correctMs: 15500 }, { name: 'Leyla', correct: 1, wrong: 0, unanswered: 0, correctMs: 2000 }]);
  s.addPartyResults([{ name: 'Orxan', points: 1, correct: 1, wrong: 0, unanswered: 0, correctMs: 9000 }]);
  assert.deepEqual(s.partyResults().map(({ name, points, correct, wrong, unanswered, rounds, avg_seconds }) => [name, points, correct, wrong, unanswered, rounds, avg_seconds]),
    [['Nicat', 10, 1, 0, 4, 1, 5], ['aysel', 10, 5, 3, 1, 2, 9.1], ['Leyla', 1, 1, 0, 0, 1, 2], ['Orxan', 1, 1, 0, 0, 1, 9]]);
  s.resetPartyResults();
  assert.deepEqual(s.partyResults(), []);
});

test('point systems are saved by name, renamed, and deleted', () => {
  const s = store();
  const id = s.savePointSystem({ name: 'Brave pool', mode: 'pool', pool: [{ points: 10 }] });
  assert.throws(() => s.savePointSystem({ name: 'brave POOL', mode: 'simple' }), /already exists/);
  s.savePointSystem({ id, name: 'Brave pool', mode: 'pool', pool: [{ points: 20 }] });
  assert.deepEqual(s.pointSystems().find(system => system.id === id).pool, [{ points: 20 }]);
  const other = s.savePointSystem({ name: 'Classic', mode: 'simple' });
  assert.deepEqual(s.pointSystems().map(system => system.name), ['Brave pool', 'Classic']);
  s.deletePointSystem(other);
  assert.deepEqual(s.pointSystems().map(system => system.id), [id]);
});

test('vectors from an older embedding setup are not loaded unless their model and preprocessing are verified', () => {
  const s = store(true);
  const relabel = s.db.prepare('UPDATE embeddings SET hash = ? WHERE uid = ?');
  for (const uid of ['1:question:1', '1:question:2']) relabel.run(hashOf('legacy-model', s.get(uid)), uid);
  const unverified = new Store(s.db.location());
  unverified.loadVectors(FAKE_SPACE);
  assert.equal(unverified.vectorCount, 1);
  assert.equal(unverified.legacyVectorCount('legacy-model'), 2);
  assert.deepEqual(unverified.staleRows().map(r => r.uid), ['1:question:1', '1:question:2']);
  const verified = new Store(s.db.location());
  verified.loadVectors({ ...FAKE_SPACE, legacyModel: 'legacy-model' });
  assert.equal(verified.vectorCount, 3);
  assert.equal(verified.legacyVectorCount('legacy-model'), 0);
  const reopened = new Store(s.db.location());
  reopened.loadVectors(FAKE_SPACE);
  assert.equal(reopened.vectorCount, 3);
});

test('vectors with the wrong size, non-finite values or an outdated passage are not stored', () => {
  const s = store();
  const [first, second, third] = s.staleRows();
  const withNaN = vec(1).map((x, i) => (i === 5 ? NaN : x));
  const edited = { ...third, answer: 'an answer from before the edit' };
  assert.equal(s.putVectors([first, second, edited], [new Float32Array(DIM - 1), withNaN, vec(2)]), 0);
  assert.equal(s.vectorCount, 0);
  assert.equal(s.storedVectorCount(), 0);
  const reopened = new Store(s.db.location());
  reopened.db.exec("INSERT INTO embeddings (uid, hash, vec) VALUES ('1:question:1', 'x', x'00')");
  reopened.db.prepare('UPDATE embeddings SET vec = ?, hash = ? WHERE uid = ?').run(new Uint8Array(new Float32Array(DIM).fill(Infinity).buffer), hashOf(FAKE_SPACE.id, first), first.uid);
  reopened.loadVectors(FAKE_SPACE);
  assert.equal(reopened.vectorCount, 0);
});

test('a failed vector write rolls back, leaves memory untouched and the next write works', () => {
  const s = store();
  const [first, second] = s.staleRows();
  s.db.exec(`CREATE TRIGGER refuse BEFORE INSERT ON embeddings WHEN NEW.uid = '${second.uid}' BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
  assert.throws(() => s.putVectors([first, second], [vec(0), vec(1)]), /disk full/);
  assert.equal(s.db.isTransaction, false);
  assert.deepEqual([s.vectorCount, s.storedVectorCount()], [0, 0]);
  assert.equal(s.putVectors([first], [vec(0)]), 1);
  assert.deepEqual([s.vectorCount, s.storedVectorCount()], [1, 1]);
});

test('vector search runs on shared memory and every change that moves rows changes the generation', () => {
  const s = store(true);
  assert.ok(s.vecs.buffer instanceof SharedArrayBuffer && s.has.buffer instanceof SharedArrayBuffer);
  const allowed = s.allowedRows({ games: ['3sual:1'] });
  assert.deepEqual(s.nearest(vec(2), allowed).map(h => s.rows[h.i].uid), ['1:question:1', '1:question:2']);
  const before = s.generation;
  const own = s.createQuestion({ text: 'Ən hündür dağ hansıdır?', answer: 'Şahdağ' });
  assert.equal(s.generation, before);
  s.deleteQuestion(own.uid);
  assert.ok(s.generation > before);
  for (const change of [() => s.reload(), () => s.unloadVectors()]) {
    const generation = s.generation;
    change();
    assert.ok(s.generation > generation);
  }
});
