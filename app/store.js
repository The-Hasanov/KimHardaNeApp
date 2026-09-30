'use strict';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const MiniSearch = require('minisearch');

const LIST_COLS = ['uid', 'package_id', 'package_name', 'tournament_name', 'game_id', 'game_name',
  'theme_name', 'text', 'answer', 'comment', 'accepted_answers', 'note_before', 'rekvizit_url', 'edited_at'];
const EDITABLE = ['text', 'answer', 'comment', 'accepted_answers', 'note_before', 'rekvizit_text', 'sources'];
const SEARCH_FIELDS = ['text', 'answer', 'comment', 'accepted_answers', 'theme_name'];
const DIM = 384;
const EMBEDDINGS_SCHEMA = 'CREATE TABLE IF NOT EXISTS embeddings (uid TEXT PRIMARY KEY, hash TEXT NOT NULL, vec BLOB NOT NULL)';
const PLAY_SCHEMA = `
CREATE TABLE IF NOT EXISTS play_games (
  id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, title TEXT NOT NULL, list_id INTEGER,
  seconds_per_question INTEGER NOT NULL, question_count INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS play_answers (
  game_id INTEGER NOT NULL, position INTEGER NOT NULL, uid TEXT NOT NULL, given_answer TEXT NOT NULL,
  ai_verdict TEXT NOT NULL, similarity REAL, closest_answer TEXT, is_correct INTEGER NOT NULL, decided_by_player INTEGER NOT NULL DEFAULT 0, seconds_used REAL,
  answered_at TEXT NOT NULL, PRIMARY KEY (game_id, position));`;
const LISTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS lists (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS list_questions (
  list_id INTEGER NOT NULL, uid TEXT NOT NULL, position INTEGER NOT NULL, added_at TEXT NOT NULL,
  PRIMARY KEY (list_id, uid));`;
const PARTY_RESULTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS party_results (
  name_key TEXT PRIMARY KEY, name TEXT NOT NULL, correct INTEGER NOT NULL DEFAULT 0, wrong INTEGER NOT NULL DEFAULT 0,
  unanswered INTEGER NOT NULL DEFAULT 0, rounds INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);`;
const POOL = 500;
const OWN_PACKAGE_ID = 0;
const OWN_GAME_ID = 0;
const OWN_NAME = 'My questions';
const OWN_IMAGE_PREFIX = 'own-image:';
const IMAGE_COLUMNS = ['rekvizit_url', 'source_media_url'];
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const TUNING = { combineWith: 'AND', prefix: true, fuzzy: 0.2, boost: { answer: 2, text: 1.5 }, rrfK: 10, aiWeight: 0.5 };

const fold = s => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/ə/g, 'e').replace(/ı/g, 'i');
const passage = r => `${r.text ?? ''}\n${r.answer ?? ''}`;
const embeddable = r => /[\p{L}\p{N}]/u.test(passage(r));
const hashOf = (model, r) => crypto.createHash('sha1').update(`${model}\0${passage(r)}`).digest('hex');

class Store {
  constructor(file, { imagesRoot = path.dirname(path.resolve(file)) } = {}) {
    this.roots = [].concat(imagesRoot);
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL');
    const cols = this.db.prepare('PRAGMA table_info(questions)').all().map(c => c.name);
    if (!cols.length) throw new Error(`${file}: no questions table`);
    if (!cols.includes('edited_at')) this.db.exec('ALTER TABLE questions ADD COLUMN edited_at TEXT');
    this.db.exec(EMBEDDINGS_SCHEMA);
    this.db.exec(LISTS_SCHEMA);
    this.db.exec(PLAY_SCHEMA);
    this.db.exec(PARTY_RESULTS_SCHEMA);
    this.loadRows();
    this.vecs = null;
    this.vectorCount = 0;
    this.tuning = { ...TUNING };
  }

  loadRows() {
    this.rows = this.db.prepare(`SELECT ${LIST_COLS} FROM questions ORDER BY package_id, ordinal, kind, value_id`).all();
    this.pos = new Map(this.rows.map((r, i) => [r.uid, i]));
    this.authorCache = null;
  }

  authorRows(id) {
    if (this.authorCache?.id !== id) {
      const uids = this.db.prepare("SELECT q.uid FROM questions q, json_each(q.authors) a WHERE json_extract(a.value, '$.id') = ?").all(id);
      this.authorCache = { id, rows: new Set(uids.map(r => this.pos.get(r.uid))) };
    }
    return this.authorCache.rows;
  }

  reload() {
    this.loadRows();
    this.buildIndex();
    if (this.model) this.loadVectors(this.model, this.dim);
  }

  buildIndex() {
    this.index = new MiniSearch({ idField: 'uid', fields: SEARCH_FIELDS, processTerm: fold });
    this.index.addAll(this.rows);
  }

  loadVectors(model, dim = DIM) {
    this.model = model;
    this.dim = dim;
    this.vecs = new Float32Array(this.rows.length * this.dim);
    this.has = new Uint8Array(this.rows.length);
    this.vectorCount = 0;
    for (const { uid, hash, vec } of this.db.prepare('SELECT uid, hash, vec FROM embeddings').iterate()) {
      const i = this.pos.get(uid);
      if (i === undefined || vec.byteLength !== this.dim * 4 || hash !== hashOf(model, this.rows[i]) || !embeddable(this.rows[i])) continue;
      this.vecs.set(new Float32Array(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength)), i * this.dim);
      this.has[i] = 1;
      this.vectorCount++;
    }
  }

  staleRows() {
    return this.rows.filter((r, i) => !this.has[i] && embeddable(r));
  }

  dropVectors() {
    this.db.exec('DELETE FROM embeddings');
    this.db.exec('VACUUM');
    this.model = null;
    this.vecs = null;
    this.has = null;
    this.vectorCount = 0;
  }

  putVectors(rows, vectors) {
    if (!this.vecs) return;
    const put = this.db.prepare('INSERT OR REPLACE INTO embeddings (uid, hash, vec) VALUES (?, ?, ?)');
    this.db.exec('BEGIN');
    rows.forEach((r, k) => {
      const v = vectors[k], i = this.pos.get(r.uid);
      if (i === undefined) return;
      put.run(r.uid, hashOf(this.model, r), new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      this.vecs.set(v, i * this.dim);
      if (!this.has[i]) this.vectorCount++;
      this.has[i] = 1;
    });
    this.db.exec('COMMIT');
  }

  cosine(i, qvec) {
    if (!qvec || !this.has?.[i]) return null;
    let s = 0;
    for (let d = 0, o = i * this.dim; d < this.dim; d++) s += this.vecs[o + d] * qvec[d];
    return s;
  }

  search({ q = '', mode = 'hybrid', game = null, edited = false, withImage = false, author = null, limit = 100 } = {}, qvec = null) {
    const t0 = performance.now();
    const byAuthor = author == null ? null : this.authorRows(+author);
    const keep = i => (!game || this.rows[i].game_id === +game) && (!edited || this.rows[i].edited_at)
      && (!withImage || this.rows[i].rekvizit_url) && (!byAuthor || byAuthor.has(i));
    let ranked;
    if (!q.trim()) {
      ranked = [];
      for (let i = 0; i < this.rows.length; i++) if (keep(i)) ranked.push({ i });
      return this.result(ranked, limit, { matches: ranked.length, t0 });
    }
    const { combineWith, prefix, fuzzy, boost, rrfK, aiWeight } = this.tuning;
    const kw = mode === 'ai' && qvec ? [] : this.index
      .search(q, { prefix, fuzzy: term => (term.length > 4 ? fuzzy : 0), combineWith, boost })
      .map(h => ({ i: this.pos.get(h.id), kw: h.score, terms: h.terms })).filter(h => keep(h.i));
    const sem = mode === 'keyword' || !qvec ? [] : this.nearest(qvec, keep);
    const info = { matches: sem.length && mode === 'ai' ? null : kw.length, ai: sem.length > 0, t0, qvec };
    if (!sem.length) ranked = kw.map(h => ({ ...h, score: h.kw }));
    else if (!kw.length || mode === 'ai') ranked = sem.map(h => ({ ...h, score: h.ai }));
    else {
      const fused = new Map();
      const add = (list, key, weight) => list.slice(0, POOL).forEach((h, rank) => {
        const f = fused.get(h.i) ?? fused.set(h.i, { i: h.i, score: 0 }).get(h.i);
        f[key] = h[key];
        if (h.terms) f.terms = h.terms;
        f.score += weight / (rrfK + rank + 1);
      });
      add(kw, 'kw', 1);
      add(sem, 'ai', aiWeight);
      ranked = [...fused.values()].sort((a, b) => b.score - a.score);
    }
    return this.result(ranked, limit, info);
  }

  nearest(qvec, keep) {
    const hits = [];
    for (let i = 0; i < this.rows.length; i++) if (this.has?.[i] && keep(i)) hits.push({ i, ai: this.cosine(i, qvec) });
    return hits.sort((a, b) => b.ai - a.ai).slice(0, POOL);
  }

  result(ranked, limit, { matches, ai = false, t0, qvec = null }) {
    const hits = ranked.slice(0, limit).map(h => {
      const r = this.rows[h.i];
      return { uid: r.uid, game_name: r.game_name, package_name: r.package_name, theme_name: r.theme_name,
        text: r.text, answer: r.answer, edited_at: r.edited_at,
        kw: h.kw ?? null, ai: h.ai ?? this.cosine(h.i, qvec), score: h.score ?? null, terms: h.terms ?? [] };
    });
    return { hits, matches, ai, ms: Math.round(performance.now() - t0) };
  }

  get(uid) {
    const r = this.db.prepare('SELECT * FROM questions WHERE uid = ?').get(uid);
    if (!r) return null;
    delete r.raw_value;
    delete r.raw_parent;
    for (const c of ['sources', 'authors', 'phase_path']) r[c] = r[c] == null ? null : JSON.parse(r[c]);
    r.rekvizit_src = this.imageSrc(r.rekvizit_url);
    r.source_media_src = this.imageSrc(r.source_media_url);
    return r;
  }

  imageSrc(url) {
    if (!url) return null;
    let hit;
    try {
      hit = this.db.prepare("SELECT path FROM images WHERE url = ? AND status = 'ok'").get(url);
    } catch {
      return url;
    }
    const file = hit && this.roots.map(root => path.join(root, hit.path)).find(f => fs.existsSync(f));
    return file ? pathToFileURL(file).href : url;
  }

  save(uid, fields) {
    const cur = this.get(uid);
    if (!cur) throw new Error(`unknown question ${uid}`);
    const next = {};
    for (const k of EDITABLE) {
      if (!(k in fields)) continue;
      let v = fields[k];
      if (k === 'sources') v = String(v ?? '').split('\n').map(s => s.trim()).filter(Boolean);
      else v = v === '' || v == null ? null : String(v);
      const same = k === 'sources' ? JSON.stringify(v) === JSON.stringify(cur.sources ?? []) : v === cur[k];
      if (!same) next[k] = k === 'sources' ? JSON.stringify(v) : v;
    }
    const keys = Object.keys(next);
    if (!keys.length) return null;
    this.db.prepare(`UPDATE questions SET ${keys.map(k => `${k} = ?`).join(', ')}, edited_at = datetime('now') WHERE uid = ?`)
      .run(...keys.map(k => next[k]), uid);
    const i = this.pos.get(uid);
    const row = this.db.prepare(`SELECT ${LIST_COLS} FROM questions WHERE uid = ?`).get(uid);
    this.rows[i] = row;
    if (this.index) this.index.replace(row);
    if (this.has?.[i] && hashOf(this.model, row) !== hashOf(this.model, cur)) {
      this.has[i] = 0;
      this.vectorCount--;
    }
    return row;
  }

  createQuestion(fields) {
    if (!String(fields.text ?? '').trim() || !String(fields.answer ?? '').trim()) throw new Error('A question needs its text and answer');
    const valueId = this.db.prepare('SELECT max(COALESCE(MAX(value_id) + 1, 0), ?) AS id FROM questions WHERE package_id = ?').get(Date.now(), OWN_PACKAGE_ID).id;
    const uid = `${OWN_PACKAGE_ID}:question:${valueId}`;
    this.db.prepare(`INSERT INTO questions (package_id, kind, value_id, uid, origin, ordinal, game_id, game_name)
      VALUES (?, 'question', ?, ?, 'own', ?, ?, ?)`).run(OWN_PACKAGE_ID, valueId, uid, valueId, OWN_GAME_ID, OWN_NAME);
    const i = this.rows.push(this.db.prepare(`SELECT ${LIST_COLS} FROM questions WHERE uid = ?`).get(uid)) - 1;
    this.pos.set(uid, i);
    this.index?.add(this.rows[i]);
    if (this.vecs && this.has.length < this.rows.length) {
      const vecs = new Float32Array(this.rows.length * this.dim);
      vecs.set(this.vecs);
      const has = new Uint8Array(this.rows.length);
      has.set(this.has);
      Object.assign(this, { vecs, has });
    }
    return this.save(uid, fields);
  }

  deleteQuestion(uid) {
    const i = this.pos.get(uid);
    if (i === undefined || this.rows[i].package_id !== OWN_PACKAGE_ID) throw new Error('Only your own questions can be deleted');
    this.db.exec('BEGIN');
    for (const table of ['questions', 'embeddings', 'list_questions']) this.db.prepare(`DELETE FROM ${table} WHERE uid = ?`).run(uid);
    this.db.exec('COMMIT');
    this.index?.discard(uid);
    this.rows.splice(i, 1);
    this.pos = new Map(this.rows.map((r, k) => [r.uid, k]));
    this.authorCache = null;
    if (!this.vecs) return;
    if (this.has[i]) this.vectorCount--;
    this.vecs.copyWithin(i * this.dim, (i + 1) * this.dim);
    this.has.copyWithin(i, i + 1);
    this.has[this.rows.length] = 0;
  }

  setOwnImage(uid, column, file = null) {
    const i = this.pos.get(uid);
    if (i === undefined || this.rows[i].package_id !== OWN_PACKAGE_ID) throw new Error('Pictures can be added to your own questions only');
    if (!IMAGE_COLUMNS.includes(column)) throw new Error(`unknown picture ${column}`);
    let url = null;
    if (file) {
      const extension = path.extname(file).toLowerCase();
      if (!IMAGE_TYPES[extension]) throw new Error('Pick a PNG, JPEG, GIF or WebP picture');
      const bytes = fs.readFileSync(file);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const relative = `images/own/${sha256}${extension}`;
      fs.mkdirSync(path.join(this.roots[0], 'images', 'own'), { recursive: true });
      fs.writeFileSync(path.join(this.roots[0], relative), bytes);
      url = OWN_IMAGE_PREFIX + sha256 + extension;
      this.db.prepare(`INSERT OR REPLACE INTO images (url, status, path, bytes, content_type, sha256, fetched_at)
        VALUES (?, 'ok', ?, ?, ?, ?, datetime('now'))`).run(url, relative, bytes.length, IMAGE_TYPES[extension], sha256);
    }
    this.db.prepare(`UPDATE questions SET ${column} = ?, edited_at = datetime('now') WHERE uid = ?`).run(url, uid);
    this.rows[i] = this.db.prepare(`SELECT ${LIST_COLS} FROM questions WHERE uid = ?`).get(uid);
    return this.get(uid);
  }

  randomPlayableQuestions(gameId, count, excludedUids = [], { includeOwn = false } = {}) {
    return this.db.prepare(`SELECT uid FROM (SELECT uid FROM questions
      WHERE (game_id = ? OR (? AND package_id = ?)) AND kind = 'question' AND COALESCE(group_size, 1) <= 1
      AND (package_id = ? OR length(text) > 20) AND trim(COALESCE(answer, '')) NOT IN ('', '-') AND uid NOT IN (SELECT value FROM json_each(?))
      ORDER BY package_id = ? DESC, random() LIMIT ?) ORDER BY random()`)
      .all(gameId, includeOwn ? 1 : 0, OWN_PACKAGE_ID, OWN_PACKAGE_ID, JSON.stringify(excludedUids), OWN_PACKAGE_ID, count).map(r => this.get(r.uid));
  }

  allLists() {
    return this.db.prepare(`SELECT l.id, l.name, l.created_at, COUNT(q.uid) AS count FROM lists l
      LEFT JOIN list_questions q ON q.list_id = l.id AND q.uid IN (SELECT uid FROM questions)
      GROUP BY l.id ORDER BY l.created_at, l.id`).all();
  }

  createList(name) {
    const { lastInsertRowid } = this.db.prepare("INSERT INTO lists (name, created_at) VALUES (?, datetime('now'))").run(name.trim());
    return Number(lastInsertRowid);
  }

  renameList(listId, name) {
    this.db.prepare('UPDATE lists SET name = ? WHERE id = ?').run(name.trim(), listId);
  }

  deleteList(listId) {
    this.db.exec('BEGIN');
    this.db.prepare('DELETE FROM list_questions WHERE list_id = ?').run(listId);
    this.db.prepare('DELETE FROM lists WHERE id = ?').run(listId);
    this.db.exec('COMMIT');
  }

  addToList(listId, uid) {
    this.db.prepare(`INSERT OR IGNORE INTO list_questions (list_id, uid, position, added_at)
      SELECT ?, ?, COALESCE(MAX(position), 0) + 1, datetime('now') FROM list_questions WHERE list_id = ?`).run(listId, uid, listId);
  }

  removeFromList(listId, uid) {
    this.db.prepare('DELETE FROM list_questions WHERE list_id = ? AND uid = ?').run(listId, uid);
  }

  reorderList(listId, uidsInOrder) {
    const setPosition = this.db.prepare('UPDATE list_questions SET position = ? WHERE list_id = ? AND uid = ?');
    this.db.exec('BEGIN');
    uidsInOrder.forEach((uid, index) => setPosition.run(index + 1, listId, uid));
    this.db.exec('COMMIT');
  }

  listQuestions(listId) {
    return this.db.prepare('SELECT uid FROM list_questions WHERE list_id = ? ORDER BY position').all(listId)
      .map(r => this.get(r.uid)).filter(Boolean);
  }

  listIdsContaining(uid) {
    return this.db.prepare('SELECT list_id FROM list_questions WHERE uid = ?').all(uid).map(r => r.list_id);
  }

  startPlayGame({ title, listId = null, secondsPerQuestion, questionCount }) {
    return Number(this.db.prepare(`INSERT INTO play_games (started_at, title, list_id, seconds_per_question, question_count)
      VALUES (datetime('now'), ?, ?, ?, ?)`).run(title, listId, secondsPerQuestion, questionCount).lastInsertRowid);
  }

  savePlayAnswer(gameId, { position, uid, givenAnswer, verdict, similarity, closestAnswer, secondsUsed }) {
    this.db.prepare(`INSERT OR REPLACE INTO play_answers
      (game_id, position, uid, given_answer, ai_verdict, similarity, closest_answer, is_correct, seconds_used, answered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
      .run(gameId, position, uid, givenAnswer, verdict, similarity, closestAnswer, verdict === 'correct' ? 1 : 0, secondsUsed);
    return this.playAnswer(gameId, position);
  }

  playAnswer(gameId, position) {
    return this.db.prepare('SELECT * FROM play_answers WHERE game_id = ? AND position = ?').get(gameId, position);
  }

  setPlayAnswerCorrect(gameId, position, isCorrect) {
    this.db.prepare('UPDATE play_answers SET is_correct = ?, decided_by_player = 1 WHERE game_id = ? AND position = ?').run(isCorrect ? 1 : 0, gameId, position);
    return this.playAnswer(gameId, position);
  }

  finishPlayGame(gameId) {
    const answered = this.db.prepare('SELECT COUNT(*) AS n FROM play_answers WHERE game_id = ?').get(gameId).n;
    if (!answered) return this.deletePlayGame(gameId);
    this.db.prepare("UPDATE play_games SET finished_at = datetime('now') WHERE id = ?").run(gameId);
  }

  deletePlayGame(gameId) {
    this.db.exec('BEGIN');
    this.db.prepare('DELETE FROM play_answers WHERE game_id = ?').run(gameId);
    this.db.prepare('DELETE FROM play_games WHERE id = ?').run(gameId);
    this.db.exec('COMMIT');
  }

  playGames() {
    return this.db.prepare(`SELECT g.*, COUNT(a.position) AS answered, COALESCE(SUM(a.is_correct), 0) AS score
      FROM play_games g LEFT JOIN play_answers a ON a.game_id = g.id GROUP BY g.id ORDER BY g.started_at DESC, g.id DESC`).all();
  }

  playGameAnswers(gameId) {
    return this.db.prepare('SELECT * FROM play_answers WHERE game_id = ? ORDER BY position').all(gameId)
      .map(answer => ({ ...answer, question: this.get(answer.uid) }));
  }

  addPartyResults(results) {
    const add = this.db.prepare(`INSERT INTO party_results (name_key, name, correct, wrong, unanswered, rounds, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
      ON CONFLICT (name_key) DO UPDATE SET name = excluded.name, correct = correct + excluded.correct, wrong = wrong + excluded.wrong,
        unanswered = unanswered + excluded.unanswered, rounds = rounds + 1, updated_at = excluded.updated_at`);
    this.db.exec('BEGIN');
    for (const { name, correct, wrong, unanswered } of results) add.run(name.toLowerCase(), name, correct, wrong, unanswered);
    this.db.exec('COMMIT');
  }

  partyResults() {
    return this.db.prepare(`SELECT name, correct, wrong, unanswered, rounds, updated_at FROM party_results
      ORDER BY correct DESC, wrong ASC, unanswered ASC, name`).all();
  }

  resetPartyResults() {
    this.db.exec('DELETE FROM party_results');
  }

  games() {
    return this.db.prepare('SELECT game_id AS id, game_name AS name, COUNT(*) AS n FROM questions GROUP BY game_id ORDER BY game_id').all();
  }
}

module.exports = { Store, OWN_PACKAGE_ID, OWN_IMAGE_PREFIX, TUNING, LISTS_SCHEMA, PLAY_SCHEMA, PARTY_RESULTS_SCHEMA, EMBEDDINGS_SCHEMA, fold, passage, embeddable, hashOf, DIM };
