'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const SOURCE_ID = '3sual';
const API = 'https://api-v2.3sual.az/api/';
const IMAGES = 'https://api-v2.3sual.az/images/';
const ALL_GAMES = '1,2,3,4,5,6,7';
const USER_AGENT = '3sual-dataset-scraper/2.0 (sequential, rate-limited; node)';
const MAX_DEPTH = 16;
const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/bmp': '.bmp', 'image/svg+xml': '.svg' };
const IMAGE_SIGNATURES = {
  'image/jpeg': bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  'image/png': bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': bytes => ['GIF87a', 'GIF89a'].includes(bytes.toString('latin1', 0, 6)),
  'image/webp': bytes => bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP',
  'image/bmp': bytes => bytes.toString('latin1', 0, 2) === 'BM',
  'image/svg+xml': bytes => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(bytes.toString('utf8', 0, 4096).replace(/^\uFEFF/, '')),
};
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const AUTHOR_PAGE = 100;
const LIST_FAILURE_LIMIT = 3;
const FETCH_FAILURE_LIMIT = 10;
const DONE = ['ok', 'empty', 'partial'];

const now = () => `${new Date().toISOString().slice(0, 19)}+00:00`;
const dumps = obj => JSON.stringify(obj);
const snippet = (obj, limit = 2000) => (obj == null ? null : dumps(obj).slice(0, limit));
const defaultLog = (level, msg) => process.stderr.write(`${new Date().toTimeString().slice(0, 8)} ${level.toUpperCase()} ${msg}\n`);
const sleep = (ms, signal) => new Promise(resolve => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

const isInt = Number.isInteger;
const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const get = (o, k) => (isObj(o) && Object.hasOwn(o, k) ? o[k] : null);
const truthy = x => (Array.isArray(x) ? x.length > 0 : isObj(x) ? Object.keys(x).length > 0 : !!x);
const or = (x, y) => (truthy(x) ? x : y);
const pyType = x => (x === null ? 'NoneType' : Array.isArray(x) ? 'list' : typeof x === 'string' ? 'str'
  : typeof x === 'boolean' ? 'bool' : typeof x === 'number' ? (isInt(x) ? 'int' : 'float') : 'dict');
const pyRepr = x => (x == null ? 'None' : typeof x === 'string' ? `'${x}'` : dumps(x));
const canon = x => JSON.stringify(x, (k, v) => (isObj(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
const same = (a, b) => canon(a) === canon(b);
const sql = v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : isInt(v) ? BigInt(v)
  : v !== null && typeof v === 'object' ? dumps(v) : v);
const run = (stmt, ...args) => stmt.run(...args.map(sql));

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

class FetchError extends Error {}

async function readLimited(res, maxBytes, url) {
  const tooLarge = () => new FetchError(`${url} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  if (Number(res.headers.get('content-length')) > maxBytes) throw tooLarge();
  if (!res.body?.getReader) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const isSiteImage = url => {
  try {
    const parsed = new URL(url);
    return parsed.origin === new URL(IMAGES).origin && parsed.pathname.startsWith(new URL(IMAGES).pathname);
  } catch {
    return false;
  }
};
class Interrupted extends Error {}

class Client {
  constructor({ delay = 1, retries = 5, timeout = 30, backoff = 2, maxBackoff = 120, base = API, signal = null,
    log = defaultLog, fetch = globalThis.fetch, sleep: wait = sleep } = {}) {
    Object.assign(this, { delay, retries, timeout, backoff, maxBackoff, base, signal, log, fetchImpl: fetch, wait });
    this.last = 0;
    this.requests = 0;
  }

  async getJson(p, params = null) {
    const q = v => encodeURIComponent(String(v)).replace(/%2C/g, ',').replace(/%20/g, '+');
    const url = this.base + p + (params ? `?${Object.entries(params).map(([k, v]) => `${q(k)}=${q(v)}`).join('&')}` : '');
    const { status, body } = await this.fetch(url, 'application/json', { maxBytes: MAX_JSON_BYTES });
    const text = body.toString('utf8');
    if (status === 204 || !text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new FetchError(`invalid JSON from ${url}: ${e.message}`);
    }
  }

  async fetch(url, accept = '*/*', { maxBytes = MAX_JSON_BYTES } = {}) {
    if (new URL(url).protocol !== 'https:') throw new FetchError(`refusing to download ${url}: only https is allowed`);
    for (let attempt = 0; ; attempt++) {
      const pause = this.delay * 1000 - (Date.now() - this.last);
      if (pause > 0) await this.wait(pause, this.signal);
      this.stopIfAborted();
      this.last = Date.now();
      this.requests++;
      let err, retryAfter = null;
      try {
        const timeout = AbortSignal.timeout(this.timeout * 1000);
        const res = await this.fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: accept },
          signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout });
        if (res.status < 400) {
          if (res.url && new URL(res.url).protocol !== 'https:') throw new FetchError(`refusing ${url}: it redirected away from https`);
          return { status: res.status, headers: res.headers, body: await readLimited(res, maxBytes, url) };
        }
        if (res.status !== 429 && res.status < 500) throw new FetchError(`HTTP ${res.status} for ${url}`);
        err = `HTTP ${res.status}`;
        retryAfter = res.headers.get('retry-after');
      } catch (e) {
        if (e instanceof FetchError) throw e;
        this.stopIfAborted();
        err = `${e.name}: ${e.cause?.message ?? e.message}`;
      }
      if (attempt >= this.retries) throw new FetchError(`${err} for ${url} (gave up after ${attempt + 1} attempts)`);
      let wait = Math.min(this.maxBackoff, this.backoff * 2 ** attempt) + Math.random();
      if (retryAfter && /^\d+$/.test(retryAfter)) wait = Math.max(wait, Math.min(Number(retryAfter), this.maxBackoff));
      this.log('warning', `${err} for ${url}; retry ${attempt + 1}/${this.retries} in ${wait.toFixed(1)}s`);
      await this.wait(wait * 1000, this.signal);
    }
  }

  stopIfAborted() {
    if (this.signal?.aborted) throw new Interrupted('interrupted');
  }
}

const CTX_KEYS = ['package_id', 'package_name', 'package_played', 'tournament_id', 'tournament_name',
  'tournament_continuation', 'game_id', 'game_name'];

const quote = s => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%2F/g, '/');

function media(value) {
  if (isObj(value)) {
    const inner = get(value, 'rekvizit');
    if (truthy(get(value, 'text'))) return [inner, null];
    value = inner;
  }
  if (typeof value === 'string' && value.trim()) return [null, IMAGES + quote(value.trim())];
  return [null, null];
}

function mergeLists(...lists) {
  const out = [];
  for (const items of lists) for (const x of Array.isArray(items) ? items : []) if (!out.some(y => same(x, y))) out.push(x);
  return out;
}

class Extraction {
  constructor(ctx, origin = 'package') {
    this.ctx = Object.fromEntries(CTX_KEYS.map(k => [k, get(ctx, k)]));
    this.origin = origin;
    this.phases = [];
    this.themes = [];
    this.records = [];
    this.problems = [];
    this.seen = new Map();
  }

  problem(p, message, raw = null, severity = 'error') {
    this.problems.push({ path: p, message, raw, severity });
  }

  list(items, p) {
    if (items == null || Array.isArray(items)) return items || [];
    this.problem(p, `expected list, got ${pyType(items)}`, items);
    return [];
  }

  walkPhases(items, trail = [], parentId = null, p = 'package.phases') {
    if (trail.length > MAX_DEPTH) return this.problem(p, 'phase nesting deeper than MAX_DEPTH');
    this.list(items, p).forEach((ph, pos) => {
      const where = `${p}[${pos}]`;
      if (!isObj(ph) || !isInt(get(ph, 'id'))) return this.problem(where, 'phase without integer id', ph);
      const here = [...trail, { id: ph.id, name: get(ph, 'name') }];
      this.phases.push({ phase_id: ph.id, parent_phase_id: parentId, depth: trail.length, position: pos,
        name: get(ph, 'name'), information: get(ph, 'information') });
      this.walkQuestions(get(ph, 'questions'), here, `${where}.questions`);
      this.walkThemes(get(ph, 'themes'), here, ph.id, `${where}.themes`);
      this.walkPhases(get(ph, 'subs'), here, ph.id, `${where}.subs`);
    });
  }

  walkQuestions(items, trail, p) {
    this.list(items, p).forEach((q, pos) => {
      const where = `${p}[${pos}]`;
      if (!isObj(q)) return this.problem(where, 'question is not an object', q);
      const values = this.list(get(q, 'values'), `${where}.values`);
      if (!values.length) return this.problem(where, 'question has no values', q);
      const ids = values.filter(v => isObj(v) && isInt(get(v, 'id'))).map(v => v.id);
      const { values: _, ...parent } = q;
      this.addValues('question', values, parent, trail, null, pos, ids.length ? `q:${ids[0]}` : null, where);
    });
  }

  walkThemes(items, trail, phaseId, p) {
    this.list(items, p).forEach((th, pos) => {
      const where = `${p}[${pos}]`;
      if (!isObj(th) || !isInt(get(th, 'id'))) return this.problem(where, 'theme without integer id', th);
      this.themes.push({ theme_id: th.id, phase_id: phaseId, position: pos, name: get(th, 'name'), raund: get(th, 'raund'),
        information: get(th, 'information'), authors: or(get(th, 'authors'), []), sources: or(get(th, 'sources'), []) });
      const { values: _, ...parent } = th;
      this.addValues('theme', this.list(get(th, 'values'), `${where}.values`), parent, trail, th, pos, `t:${th.id}`, where);
    });
  }

  addValues(kind, values, parent, trail, theme, position, group, where) {
    theme = theme || {};
    values.forEach((v, i) => {
      const vw = `${where}.values[${i}]`;
      if (!isObj(v) || !isInt(get(v, 'id'))) return this.problem(vw, 'value without integer id', v);
      const key = `${kind}:${v.id}`;
      if (this.seen.has(key)) {
        const dup = same(this.seen.get(key), v);
        return this.problem(vw, `duplicate ${kind} value id ${v.id} within package${dup ? '' : ' (different content; first copy kept)'}`,
          v, dup ? 'warning' : 'error');
      }
      this.seen.set(key, v);
      for (const field of ['text', 'answer']) {
        if (typeof get(v, field) !== 'string') this.problem(vw, `value ${v.id} has non-string ${field}`, v, 'warning');
      }
      const [rekText, rekUrl] = media(get(v, 'rekvizit'));
      this.records.push({
        ...this.ctx,
        uid: `${this.ctx.package_id}:${kind}:${v.id}`,
        value_id: v.id, kind, origin: this.origin, ordinal: this.records.length,
        phase_id: trail.length ? trail[0].id : null,
        phase_name: trail.length ? trail[0].name : null,
        subphase_id: trail.length > 1 ? trail.at(-1).id : null,
        subphase_name: trail.length > 1 ? trail.at(-1).name : null,
        phase_path: [...trail],
        theme_id: get(theme, 'id'), theme_name: get(theme, 'name'),
        theme_round: get(theme, 'raund'), theme_information: get(theme, 'information'),
        group_key: group, position, group_size: values.length, group_index: i,
        text: get(v, 'text'), answer: get(v, 'answer'),
        comment: get(v, 'comment') !== null ? v.comment : get(parent, 'comment'),
        accepted_answers: get(parent, 'considered'),
        note_before: get(parent, 'notebefore'),
        rekvizit_text: rekText, rekvizit_url: rekUrl,
        source_media_url: media(get(v, 'source_media'))[1],
        sources: mergeLists(get(v, 'sources'), get(parent, 'sources')),
        authors: or(get(parent, 'authors'), []),
        is_translated: get(parent, 'isTranslated'),
        is_rekvizit_for_all: get(parent, 'isRekvizitForAll'),
        raw_value: v, raw_parent: parent,
      });
    });
  }
}

function packageContext(doc) {
  const pkg = doc.package, tour = or(get(doc, 'tournament'), {}), game = or(get(pkg, 'game'), {});
  return { package_id: pkg.id, package_name: get(pkg, 'name'), package_played: get(pkg, 'played'),
    tournament_id: get(tour, 'id'), tournament_name: get(tour, 'name'), tournament_continuation: get(tour, 'continuation'),
    game_id: get(game, 'id'), game_name: get(game, 'name') };
}

function normalizePackage(doc) {
  const ext = new Extraction(packageContext(doc));
  ext.walkPhases(get(doc.package, 'phases'));
  return ext;
}

function validateDocument(doc, pid) {
  if (!isObj(doc) || !isObj(get(doc, 'package'))) return "document has no 'package' object";
  const id = get(doc.package, 'id');
  return id !== pid ? `document package id ${pyRepr(id)} != requested ${pid}` : null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, started_at TEXT, finished_at TEXT, status TEXT,
  args_json TEXT, stats_json TEXT, report_json TEXT);
CREATE TABLE IF NOT EXISTS list_pages (
  run_id INTEGER, pass INTEGER, page INTEGER, count INTEGER, n_items INTEGER, fetched_at TEXT,
  PRIMARY KEY (run_id, pass, page));
CREATE TABLE IF NOT EXISTS list_sightings (
  run_id INTEGER, pass INTEGER, page INTEGER, package_id INTEGER,
  PRIMARY KEY (run_id, pass, page, package_id));
CREATE TABLE IF NOT EXISTS package_list (
  package_id INTEGER PRIMARY KEY, source TEXT NOT NULL, name TEXT, game TEXT, organization TEXT,
  date TEXT, raw_json TEXT, first_seen_run INTEGER, last_seen_run INTEGER);
CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('ok','empty','partial','failed')),
  error TEXT, name TEXT, game_id INTEGER, game_name TEXT, game_with_theme INTEGER, tournament_id INTEGER,
  played TEXT, added TEXT, updated TEXT, is_ready INTEGER, viewtype INTEGER, information TEXT,
  n_values INTEGER, n_problems INTEGER, raw_json TEXT, fetched_at TEXT, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY, name TEXT, is_league INTEGER, continuation_id INTEGER, continuation TEXT,
  information TEXT, added TEXT, raw_json TEXT);
CREATE TABLE IF NOT EXISTS phases (
  package_id INTEGER, phase_id INTEGER, parent_phase_id INTEGER, depth INTEGER, position INTEGER,
  name TEXT, information TEXT, PRIMARY KEY (package_id, phase_id));
CREATE TABLE IF NOT EXISTS themes (
  package_id INTEGER, theme_id INTEGER, phase_id INTEGER, position INTEGER, name TEXT, raund INTEGER,
  information TEXT, authors TEXT, sources TEXT, PRIMARY KEY (package_id, theme_id));
CREATE TABLE IF NOT EXISTS questions (
  source_id TEXT NOT NULL, package_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('question','theme')),
  value_id INTEGER NOT NULL, uid TEXT NOT NULL UNIQUE, origin TEXT NOT NULL, ordinal INTEGER,
  package_name TEXT, package_played TEXT, tournament_id INTEGER, tournament_name TEXT,
  tournament_continuation TEXT, game_id INTEGER, game_name TEXT,
  phase_id INTEGER, phase_name TEXT, subphase_id INTEGER, subphase_name TEXT, phase_path TEXT,
  theme_id INTEGER, theme_name TEXT, theme_round INTEGER, theme_information TEXT,
  group_key TEXT, position INTEGER, group_size INTEGER, group_index INTEGER,
  text TEXT, answer TEXT, comment TEXT, accepted_answers TEXT, note_before TEXT,
  rekvizit_text TEXT, rekvizit_url TEXT, source_media_url TEXT, sources TEXT, authors TEXT,
  is_translated INTEGER, is_rekvizit_for_all INTEGER, raw_value TEXT, raw_parent TEXT,
  edited_at TEXT,  -- set by the editor; edited rows survive --refresh
  PRIMARY KEY (source_id, package_id, kind, value_id));
CREATE INDEX IF NOT EXISTS questions_value ON questions (kind, value_id);
CREATE TABLE IF NOT EXISTS authors (
  id INTEGER PRIMARY KEY, fullname TEXT, questions INTEGER, themes INTEGER, editors INTEGER,
  other INTEGER, raw_json TEXT, fetched_at TEXT);
CREATE TABLE IF NOT EXISTS images (
  url TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('ok','failed')), path TEXT,
  bytes INTEGER, content_type TEXT, sha256 TEXT, error TEXT, fetched_at TEXT);
CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY, run_id INTEGER, package_id INTEGER, stage TEXT NOT NULL,
  severity TEXT NOT NULL, path TEXT, message TEXT NOT NULL, raw TEXT, created_at TEXT);
`;

const QUESTION_COLUMNS = ['source_id', 'package_id', 'kind', 'value_id', 'uid', 'origin', 'ordinal', 'package_name', 'package_played',
  'tournament_id', 'tournament_name', 'tournament_continuation', 'game_id', 'game_name',
  'phase_id', 'phase_name', 'subphase_id', 'subphase_name', 'phase_path',
  'theme_id', 'theme_name', 'theme_round', 'theme_information',
  'group_key', 'position', 'group_size', 'group_index',
  'text', 'answer', 'comment', 'accepted_answers', 'note_before',
  'rekvizit_text', 'rekvizit_url', 'source_media_url', 'sources', 'authors',
  'is_translated', 'is_rekvizit_for_all', 'raw_value', 'raw_parent'];
const JSON_COLUMNS = new Set(['phase_path', 'sources', 'authors', 'raw_value', 'raw_parent']);
const BOOL_COLUMNS = new Set(['is_translated', 'is_rekvizit_for_all']);
const INSERT_QUESTION = `INSERT OR IGNORE INTO questions (${QUESTION_COLUMNS}) VALUES (${QUESTION_COLUMNS.map(() => '?')})`;

function prepareDb(db) {
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(SCHEMA);
  const columns = db.prepare('PRAGMA table_info(questions)').all().map(c => c.name);
  if (!columns.includes('edited_at')) db.exec('ALTER TABLE questions ADD COLUMN edited_at TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS questions_source ON questions (source_id, game_id)');
  return db;
}

const connect = file => prepareDb(new DatabaseSync(file));
const questionRow = rec => QUESTION_COLUMNS.map(c => (c === 'source_id' ? SOURCE_ID : JSON_COLUMNS.has(c) ? dumps(rec[c]) : rec[c]));

function recordError(db, runId, stage, message, { packageId = null, path: p = null, raw = null, severity = 'error' } = {}) {
  run(db.prepare('INSERT INTO errors (run_id, package_id, stage, severity, path, message, raw, created_at) VALUES (?,?,?,?,?,?,?,?)'),
    runId, packageId, stage, severity, p, message, snippet(raw), now());
}

function storePackage(db, runId, pid, doc, ext) {
  const pkg = doc.package, tour = or(get(doc, 'tournament'), {}), game = or(get(pkg, 'game'), {});
  const hard = ext.problems.filter(p => p.severity === 'error').length;
  const status = hard ? 'partial' : ext.records.length ? 'ok' : 'empty';
  tx(db, () => {
    run(db.prepare("DELETE FROM questions WHERE source_id = ? AND package_id = ? AND origin = 'package' AND edited_at IS NULL"), SOURCE_ID, pid);
    run(db.prepare('DELETE FROM themes WHERE package_id = ?'), pid);
    run(db.prepare('DELETE FROM phases WHERE package_id = ?'), pid);
    run(db.prepare("DELETE FROM errors WHERE package_id = ? AND stage IN ('fetch','parse')"), pid);
    if (get(tour, 'id') !== null) {
      run(db.prepare('INSERT OR REPLACE INTO tournaments VALUES (?,?,?,?,?,?,?,?)'), tour.id, get(tour, 'name'), get(tour, 'isLeague'),
        get(tour, 'continuation_ID'), get(tour, 'continuation'), get(tour, 'information'), get(tour, 'added'), dumps(tour));
    }
    const phase = db.prepare('INSERT OR REPLACE INTO phases VALUES (?,?,?,?,?,?,?)');
    for (const p of ext.phases) run(phase, pid, p.phase_id, p.parent_phase_id, p.depth, p.position, p.name, p.information);
    const theme = db.prepare('INSERT OR REPLACE INTO themes VALUES (?,?,?,?,?,?,?,?,?)');
    for (const t of ext.themes) {
      run(theme, pid, t.theme_id, t.phase_id, t.position, t.name, t.raund, t.information, dumps(t.authors), dumps(t.sources));
    }
    const del = db.prepare('DELETE FROM questions WHERE source_id = ? AND package_id = ? AND kind = ? AND value_id = ? AND edited_at IS NULL');
    const ins = db.prepare(INSERT_QUESTION);
    for (const r of ext.records) run(del, SOURCE_ID, pid, r.kind, r.value_id);
    for (const r of ext.records) run(ins, ...questionRow(r));
    for (const p of ext.problems) recordError(db, runId, 'parse', p.message, { packageId: pid, path: p.path, raw: p.raw, severity: p.severity });
    run(db.prepare(`INSERT INTO packages (id, status, error, name, game_id, game_name, game_with_theme,
        tournament_id, played, added, updated, is_ready, viewtype, information, n_values, n_problems, raw_json, fetched_at, attempts)
      VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
      ON CONFLICT (id) DO UPDATE SET status=excluded.status, error=NULL, name=excluded.name, game_id=excluded.game_id,
        game_name=excluded.game_name, game_with_theme=excluded.game_with_theme, tournament_id=excluded.tournament_id,
        played=excluded.played, added=excluded.added, updated=excluded.updated, is_ready=excluded.is_ready,
        viewtype=excluded.viewtype, information=excluded.information, n_values=excluded.n_values,
        n_problems=excluded.n_problems, raw_json=excluded.raw_json, fetched_at=excluded.fetched_at,
        attempts=packages.attempts + 1`),
    pid, status, get(pkg, 'name'), get(game, 'id'), get(game, 'name'), get(game, 'with_Theme'), get(tour, 'id'),
    get(pkg, 'played'), get(pkg, 'added'), get(pkg, 'updated'), get(pkg, 'isReady'), get(doc, 'viewtype'),
    get(pkg, 'information'), ext.records.length, ext.problems.length, dumps(doc), now());
  });
  return status;
}

function markFailed(db, runId, pid, message, raw = null) {
  tx(db, () => {
    run(db.prepare("DELETE FROM errors WHERE package_id = ? AND stage IN ('fetch','parse')"), pid);
    recordError(db, runId, 'fetch', message, { packageId: pid, raw });
    run(db.prepare(`INSERT INTO packages (id, status, error, raw_json, fetched_at, attempts) VALUES (?, 'failed', ?, ?, ?, 1)
      ON CONFLICT (id) DO UPDATE SET status='failed', error=excluded.error, fetched_at=excluded.fetched_at,
        attempts=packages.attempts + 1`), pid, message, raw == null ? null : dumps(raw), now());
  });
}

class Crawler {
  constructor(db, client, runId, { limit = null, listPasses = 2, refresh = false, log = defaultLog, progress = () => {} } = {}) {
    Object.assign(this, { db, client, runId, limit, listPasses, refresh, log, progress });
    this.audit = {};
    this.runStart = db.prepare('SELECT started_at FROM runs WHERE id = ?').get(runId)?.started_at ?? null;
  }

  err(stage, message, opts = {}) {
    this.log(opts.severity === 'warning' ? 'warning' : 'error', `${stage}: ${message}`);
    tx(this.db, () => recordError(this.db, this.runId, stage, message, opts));
  }

  listedCount() {
    return this.db.prepare('SELECT COUNT(DISTINCT package_id) AS n FROM list_sightings WHERE run_id = ?').get(this.runId).n;
  }

  async crawlList() {
    for (let pass = 1; pass <= this.listPasses; pass++) {
      const count = await this.listPass(pass);
      const covered = this.listedCount();
      const target = this.limit ? Math.min(count, this.limit) : count;
      this.log('info', `list pass ${pass}: ${covered} unique packages seen, site reports ${count}`);
      if (covered >= target) return;
      this.log('warning', `list pass ${pass} covered ${covered}/${target}; traversing again`);
    }
  }

  async listPass(pass) {
    let page = 1, pageSize = 0, count = 0, failures = 0;
    const passSeen = new Set();
    const recorded = this.db.prepare('SELECT count, n_items FROM list_pages WHERE run_id = ? AND pass = ? AND page = ?');
    const sighted = this.db.prepare('SELECT package_id FROM list_sightings WHERE run_id = ? AND pass = ? AND page = ?');
    for (;;) {
      const row = recorded.get(this.runId, pass, page);
      let ids, n;
      if (row) {
        ({ count, n_items: n } = row);
        ids = new Set(sighted.all(this.runId, pass, page).map(r => r.package_id));
      } else {
        try {
          const data = await this.client.getJson('packages/forhome', { page, games: ALL_GAMES, word: '' });
          [count, ids] = this.storeListPage(pass, page, data);
          n = ids.size;
          failures = 0;
        } catch (e) {
          if (!(e instanceof FetchError)) throw e;
          this.err('list', `page ${page}: ${e.message}`);
          if (++failures >= LIST_FAILURE_LIMIT) {
            this.err('list', `pass ${pass} abandoned after ${failures} consecutive failures`);
            return count;
          }
          page++;
          continue;
        }
      }
      pageSize = Math.max(pageSize, n);
      const expected = pageSize ? Math.ceil(count / pageSize) : 0;
      const fresh = [...ids].filter(id => !passSeen.has(id));
      for (const id of ids) passSeen.add(id);
      this.log('info', `list page ${page}/${expected}: ${n} packages (${fresh.length} new), count=${count}`);
      this.progress({ stage: 'list', done: Math.min(page, expected), total: expected });
      if (this.limit && this.listedCount() >= this.limit) return count;
      if (page > expected && (n === 0 || !fresh.length)) return count;
      if (n === 0) this.err('list', `page ${page} empty before expected end (${expected} pages)`, { severity: 'warning' });
      page++;
    }
  }

  storeListPage(pass, page, data) {
    if (!isObj(data) || !isInt(get(data, 'count')) || !Array.isArray(get(data, 'packages'))) {
      throw new FetchError(`malformed listing response: ${snippet(data, 300)}`);
    }
    const ids = new Set();
    tx(this.db, () => {
      const upsert = this.db.prepare(`INSERT INTO package_list VALUES (?, 'list', ?,?,?,?,?,?,?)
        ON CONFLICT (package_id) DO UPDATE SET source='list', name=excluded.name, game=excluded.game,
          organization=excluded.organization, date=excluded.date, raw_json=excluded.raw_json, last_seen_run=excluded.last_seen_run`);
      const sight = this.db.prepare('INSERT OR IGNORE INTO list_sightings VALUES (?,?,?,?)');
      for (const item of data.packages) {
        if (!isObj(item) || !isInt(get(item, 'id'))) {
          recordError(this.db, this.runId, 'list', 'listing item without integer id', { path: `page ${page}`, raw: item });
          continue;
        }
        ids.add(item.id);
        const org = or(get(item, 'organization'), {});
        run(upsert, item.id, get(item, 'name'), get(item, 'game'), get(org, 'name'), get(item, 'date'), dumps(item), this.runId, this.runId);
        run(sight, this.runId, pass, page, item.id);
      }
      run(this.db.prepare('INSERT OR REPLACE INTO list_pages VALUES (?,?,?,?,?,?)'), this.runId, pass, page, data.count, ids.size, now());
    });
    return [data.count, ids];
  }

  targets() {
    const ids = this.db.prepare('SELECT package_id FROM list_sightings WHERE run_id = ? GROUP BY package_id ORDER BY MIN(rowid)')
      .all(this.runId).map(r => r.package_id);
    return this.limit ? ids.slice(0, this.limit) : ids;
  }

  async fetchPackages(ids) {
    const row = this.db.prepare('SELECT status, fetched_at FROM packages WHERE id = ?');
    const todo = ids.filter(pid => {
      const r = row.get(pid);
      return !r || !DONE.includes(r.status) || (this.refresh && !(this.runStart && r.fetched_at >= this.runStart));
    });
    this.log('info', `details: ${ids.length} packages targeted, ${todo.length} to fetch, ${ids.length - todo.length} already stored`);
    const started = Date.now();
    let failures = 0;
    for (let i = 1; i <= todo.length; i++) {
      const pid = todo[i - 1];
      const status = await this.fetchPackage(pid);
      failures = status === 'failed' ? failures + 1 : 0;
      const eta = ((Date.now() - started) / 1000 / i) * (todo.length - i);
      this.log('info', `[${i}/${todo.length}] package ${pid}: ${status} (eta ${Math.floor(eta / 60)}m${String(Math.floor(eta % 60)).padStart(2, '0')}s)`);
      this.progress({ stage: 'packages', done: i, total: todo.length });
      if (failures >= FETCH_FAILURE_LIMIT) {
        this.err('fetch', `stopping after ${failures} consecutive package failures; rerun to resume`);
        break;
      }
    }
  }

  async fetchPackage(pid) {
    let doc;
    try {
      doc = await this.client.getJson('packages/foruse', { id: pid });
    } catch (e) {
      if (!(e instanceof FetchError)) throw e;
      markFailed(this.db, this.runId, pid, e.message);
      return 'failed';
    }
    if (doc === null) {
      markFailed(this.db, this.runId, pid, 'no content (HTTP 204 / empty body): package not available');
      return 'failed';
    }
    const problem = validateDocument(doc, pid);
    if (problem) {
      markFailed(this.db, this.runId, pid, problem, doc);
      return 'failed';
    }
    const ext = normalizePackage(doc);
    const status = storePackage(this.db, this.runId, pid, doc, ext);
    return `${status}, ${ext.records.length} values${ext.problems.length ? `, ${ext.problems.length} problems` : ''}`;
  }

  async auditAuthors(full = false) {
    const authors = [];
    for (let page = 1; ; page++) {
      let data;
      try {
        data = await this.client.getJson('authors', { page, perpage: AUTHOR_PAGE, detailed: 'true', search: '' });
      } catch (e) {
        if (!(e instanceof FetchError)) throw e;
        return this.err('audit', `authors page ${page}: ${e.message}`);
      }
      const items = get(data, 'authors');
      if (!Array.isArray(items)) return this.err('audit', `malformed authors page ${page}`, { raw: data });
      authors.push(...items.filter(a => isObj(a) && isInt(get(a, 'id'))));
      tx(this.db, () => {
        const put = this.db.prepare('INSERT OR REPLACE INTO authors VALUES (?,?,?,?,?,?,?,?)');
        for (const a of items) {
          if (isObj(a) && Object.hasOwn(a, 'id')) {
            run(put, a.id, get(a, 'fullname'), get(a, 'questions'), get(a, 'themes'), get(a, 'editors'), get(a, 'other'), dumps(a), now());
          }
        }
      });
      if (!items.length || page * AUTHOR_PAGE >= or(get(data, 'count'), 0)) break;
    }
    const local = localAuthorCounts(this.db);
    const checks = [];
    for (const a of authors) {
      const haveQ = local.question.get(a.id)?.size ?? 0, haveT = local.theme.get(a.id)?.size ?? 0;
      for (const [kind, want, have] of [['questions', or(get(a, 'questions'), 0), haveQ], ['themes', or(get(a, 'themes'), 0), haveT]]) {
        if ((full && truthy(want)) || want !== have) checks.push([a.id, kind, want, have]);
      }
    }
    this.log('info', `audit: ${authors.length} authors, ${checks.length} listings to check`);
    this.audit = { authors: authors.length, listings_checked: checks.length, count_mismatches: [], packages_discovered: [], values_discovered: 0 };
    for (const [n, [aid, kind, want, have]] of checks.entries()) {
      if (want !== have) this.audit.count_mismatches.push({ author_id: aid, kind, site: want, local: have });
      this.log('info', `audit [${n + 1}/${checks.length}] author ${aid} ${kind}: site=${want} local=${have}`);
      this.progress({ stage: 'audit', done: n + 1, total: checks.length });
      await this.auditListing(aid, kind);
    }
  }

  async auditListing(aid, kind) {
    const records = [];
    for (let page = 1; ; page++) {
      let data;
      try {
        data = await this.client.getJson(`authors/${kind}`, { id: aid, page, perpage: AUTHOR_PAGE });
      } catch (e) {
        if (!(e instanceof FetchError)) throw e;
        return this.err('audit', `author ${aid} ${kind} page ${page}: ${e.message}`);
      }
      const results = get(data, 'results');
      if (!Array.isArray(results)) return this.err('audit', `malformed author ${aid} ${kind} page ${page}`, { raw: data });
      let got = 0;
      for (const r of results) {
        if (!isObj(r) || !isInt(get(r, 'id'))) {
          this.err('audit', `author ${aid} ${kind}: listing entry without package id`, { raw: r });
          continue;
        }
        const ext = new Extraction({ package_id: r.id, package_name: get(r, 'name'), game_name: get(r, 'game') }, 'author_listing');
        const where = `authors/${kind}?id=${aid}&page=${page}`;
        if (kind === 'questions') ext.walkQuestions(get(r, 'questions'), [], where);
        else ext.walkThemes(get(r, 'themes'), [], null, where);
        const listed = or(get(r, kind), []);
        got += Array.isArray(listed) ? listed.length : 0;
        for (const p of ext.problems) this.err('audit', p.message, { packageId: r.id, path: p.path, raw: p.raw, severity: 'warning' });
        for (const rec of ext.records) rec.authors = or(rec.authors, [{ id: aid, user: null, fullname: get(data, 'fullname') }]);
        records.push(...ext.records);
      }
      if (!results.length || !got || page * AUTHOR_PAGE >= or(get(data, 'count'), 0)) break;
    }
    const stored = this.storedIds();
    for (const pid of [...new Set(records.map(r => r.package_id))].filter(p => !stored.has(p)).sort((a, b) => a - b)) {
      this.log('warning', `audit: author ${aid} references package ${pid} not collected via the listing`);
      tx(this.db, () => run(this.db.prepare(`INSERT INTO package_list (package_id, source, name, first_seen_run, last_seen_run)
        VALUES (?, 'author_listing', ?, ?, ?) ON CONFLICT (package_id) DO UPDATE SET last_seen_run=excluded.last_seen_run`),
      pid, records.find(r => r.package_id === pid).package_name, this.runId, this.runId));
      this.audit.packages_discovered.push(pid);
      await this.fetchPackage(pid);
    }
    const known = this.db.prepare('SELECT 1 FROM questions WHERE source_id = ? AND kind = ? AND value_id = ?');
    const missing = records.filter(r => !known.get(SOURCE_ID, r.kind, r.value_id));
    if (missing.length) {
      this.log('warning', `audit: author ${aid} ${kind} listing reveals ${missing.length} values absent from packages`);
      tx(this.db, () => {
        const ins = this.db.prepare(INSERT_QUESTION);
        for (const r of missing) run(ins, ...questionRow(r));
      });
      this.audit.values_discovered += missing.length;
    }
  }

  storedIds() {
    return new Set(this.db.prepare("SELECT id FROM packages WHERE status IN ('ok','empty','partial')").all().map(r => r.id));
  }
}

function localAuthorCounts(db) {
  const out = { question: new Map(), theme: new Map() };
  for (const { kind, group_key: group, authors } of db.prepare('SELECT kind, group_key, authors FROM questions').iterate()) {
    for (const a of JSON.parse(authors || '[]')) {
      if (!isObj(a) || !isInt(get(a, 'id'))) continue;
      if (!out[kind].has(a.id)) out[kind].set(a.id, new Set());
      out[kind].get(a.id).add(group);
    }
  }
  return out;
}

function buildReport(db, runId, limit, audit, stats) {
  const q1 = (s, ...a) => Object.values(db.prepare(s).get(...a))[0];
  const last = db.prepare('SELECT count FROM list_pages WHERE run_id = ? ORDER BY fetched_at DESC, rowid DESC LIMIT 1').get(runId);
  const reported = last ? last.count : null;
  const listed = db.prepare('SELECT package_id FROM list_sightings WHERE run_id = ? GROUP BY package_id ORDER BY MIN(rowid)')
    .all(runId).map(r => r.package_id);
  const targets = limit ? listed.slice(0, limit) : listed;
  const extra = db.prepare("SELECT package_id FROM package_list WHERE source = 'author_listing' AND last_seen_run = ?")
    .all(runId).map(r => r.package_id);
  const scope = [...targets, ...extra];
  const byStatus = {};
  const st = db.prepare('SELECT status FROM packages WHERE id = ?');
  for (const pid of scope) (byStatus[st.get(pid)?.status ?? 'not_fetched'] ??= []).push(pid);
  const failures = db.prepare(`SELECT package_id, stage, severity, path, message FROM errors WHERE severity = 'error'
    AND (run_id = ? AND package_id IS NULL OR package_id IN (SELECT value FROM json_each(?)))`).all(runId, dumps(scope)).map(r => ({ ...r }));
  const perGame = {};
  for (const r of db.prepare('SELECT game_name g, COUNT(*) v, COUNT(DISTINCT group_key) n FROM questions GROUP BY game_name').all()) {
    perGame[r.g || '?'] = { values: r.v, question_groups: r.n };
  }
  const coverageOk = reported !== null && listed.length >= (limit ? Math.min(reported, limit) : reported);
  const report = {
    run_id: runId, limit_packages: limit,
    listing: {
      reported_count: reported, site_stats_packages: get(stats, 'packages'),
      unique_packages_listed: listed.length,
      duplicate_sightings: q1(`SELECT COALESCE(SUM(c - 1), 0) FROM (SELECT COUNT(*) c FROM list_sightings WHERE run_id = ?
        GROUP BY pass, package_id HAVING c > 1)`, runId),
      empty_pages_before_end: q1("SELECT COUNT(*) FROM errors WHERE run_id = ? AND stage = 'list' AND message LIKE '%empty before expected end%'", runId),
      passes: q1('SELECT COALESCE(MAX(pass), 0) FROM list_pages WHERE run_id = ?', runId),
      coverage_ok: coverageOk,
    },
    packages: {
      targeted: scope.length,
      ...Object.fromEntries(Object.keys(byStatus).sort().map(k => [k, byStatus[k].length])),
      empty_ids: byStatus.empty ?? [], failed_ids: byStatus.failed ?? [], partial_ids: byStatus.partial ?? [],
    },
    questions: {
      rows: q1('SELECT COUNT(*) FROM questions'),
      distinct_values: q1('SELECT COUNT(*) FROM (SELECT DISTINCT kind, value_id FROM questions)'),
      question_values: q1("SELECT COUNT(*) FROM questions WHERE kind = 'question'"),
      theme_values: q1("SELECT COUNT(*) FROM questions WHERE kind = 'theme'"),
      from_author_listings: q1("SELECT COUNT(*) FROM questions WHERE origin = 'author_listing'"),
      values_in_multiple_packages: q1('SELECT COUNT(*) FROM (SELECT 1 FROM questions GROUP BY kind, value_id HAVING COUNT(*) > 1)'),
      duplicate_rows: q1('SELECT COALESCE(SUM(c - 1), 0) FROM (SELECT COUNT(*) c FROM questions GROUP BY kind, value_id)'),
      by_game: perGame,
    },
    site_stats: stats,
    author_audit: truthy(audit) ? audit : null,
    errors: failures.length,
    warnings: q1(`SELECT COUNT(*) FROM errors WHERE severity = 'warning' AND (run_id = ? OR package_id IN
      (SELECT value FROM json_each(?)))`, runId, dumps(scope)),
    failures: failures.slice(0, 200),
  };
  report.complete = !!(coverageOk && !failures.length && !byStatus.not_fetched && !byStatus.failed && !byStatus.partial);
  return report;
}

function exportJsonl(db, out, includeRaw = false) {
  const cols = QUESTION_COLUMNS.filter(c => includeRaw || (c !== 'raw_value' && c !== 'raw_parent'));
  const fd = fs.openSync(out, 'w');
  let n = 0;
  try {
    const rows = db.prepare(`SELECT ${cols.map(c => `q.${c}`)}, ri.path AS x_rp, si.path AS x_sp, q.edited_at AS x_ed,
        p.is_ready AS x_ready FROM questions q
      LEFT JOIN packages p ON p.id = q.package_id
      LEFT JOIN images ri ON ri.url = q.rekvizit_url AND ri.status = 'ok'
      LEFT JOIN images si ON si.url = q.source_media_url AND si.status = 'ok'
      ORDER BY q.package_id, q.ordinal, q.kind, q.value_id`).iterate();
    for (const row of rows) {
      const rec = {};
      for (const c of cols) {
        const v = row[c];
        rec[c] = v == null ? null : JSON_COLUMNS.has(c) ? JSON.parse(v) : BOOL_COLUMNS.has(c) ? !!v : v;
      }
      Object.assign(rec, { rekvizit_path: row.x_rp, source_media_path: row.x_sp, edited_at: row.x_ed,
        package_is_ready: row.x_ready == null ? null : !!row.x_ready });
      fs.writeSync(fd, `${dumps(rec)}\n`);
      n++;
    }
  } finally {
    fs.closeSync(fd);
  }
  return n;
}

function imagePath(url, contentType) {
  const h = crypto.createHash('sha1').update(url).digest('hex');
  return `images/${h.slice(0, 2)}/${h}${IMAGE_TYPES[contentType] ?? '.bin'}`;
}

async function downloadImages(db, client, roots, { limit = null, log = defaultLog, progress = () => {} } = {}) {
  roots = [].concat(roots);
  const urls = db.prepare(`SELECT rekvizit_url u FROM questions WHERE rekvizit_url IS NOT NULL UNION
    SELECT source_media_url FROM questions WHERE source_media_url IS NOT NULL ORDER BY 1`).all().map(r => r.u);
  const have = new Set(db.prepare("SELECT url, path FROM images WHERE status = 'ok'").all()
    .filter(r => roots.some(root => fs.existsSync(path.join(root, r.path)))).map(r => r.url));
  const todo = urls.filter(u => !have.has(u) && isSiteImage(u)).slice(0, limit ?? undefined);
  log('info', `images: ${urls.length} referenced, ${have.size} already downloaded, ${todo.length} to fetch`);
  for (let i = 1; i <= todo.length; i++) {
    const url = todo[i - 1];
    let row;
    try {
      const { headers, body } = await client.fetch(url, 'image/*', { maxBytes: MAX_IMAGE_BYTES });
      const ctype = (headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!body.length || !IMAGE_SIGNATURES[ctype]?.(body)) {
        throw new FetchError(`not an image: ${ctype || 'no content type'}, ${body.length} bytes`);
      }
      const rel = imagePath(url, ctype);
      const dest = path.join(roots[0], rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(`${dest}.part`, body);
      fs.renameSync(`${dest}.part`, dest);
      row = [url, 'ok', rel, body.length, ctype, crypto.createHash('sha256').update(body).digest('hex'), null, now()];
    } catch (e) {
      if (!(e instanceof FetchError)) throw e;
      log('warning', `image failed: ${e.message}`);
      row = [url, 'failed', null, null, null, null, e.message, now()];
    }
    tx(db, () => run(db.prepare('INSERT OR REPLACE INTO images VALUES (?,?,?,?,?,?,?,?)'), ...row));
    if (i % 100 === 0 || i === todo.length) log('info', `images: ${i}/${todo.length}`);
    progress({ stage: 'images', done: i, total: todo.length });
  }
  const referenced = new Set(urls);
  const ok = db.prepare("SELECT url FROM images WHERE status = 'ok'").all().filter(r => referenced.has(r.url)).length;
  const failed = db.prepare("SELECT url, error FROM images WHERE status = 'failed'").all().filter(r => referenced.has(r.url));
  return { referenced: urls.length, downloaded: ok, fetched_this_run: todo.length, failed: failed.length,
    failed_urls: failed.slice(0, 100).map(r => ({ url: r.url, error: r.error })),
    bytes: db.prepare("SELECT COALESCE(SUM(bytes), 0) AS b FROM images WHERE status = 'ok'").get().b, complete: ok === urls.length };
}

function openRun(db, newRun, args) {
  const row = db.prepare('SELECT id, status FROM runs ORDER BY id DESC LIMIT 1').get();
  if (row && row.status !== 'finished' && !newRun) return { runId: row.id, resumed: true };
  const { lastInsertRowid } = tx(db, () => db.prepare("INSERT INTO runs (started_at, status, args_json) VALUES (?, 'running', ?)").run(now(), dumps(args)));
  return { runId: Number(lastInsertRowid), resumed: false };
}

async function crawl(db, { client, limit = null, listPasses = 2, refresh = false, newRun = false, audit = 'auto',
  log = defaultLog, progress = () => {} }) {
  const { runId, resumed } = openRun(db, newRun, { limit, listPasses, refresh, newRun, audit });
  if (resumed) log('info', `resuming unfinished run ${runId}`);
  const crawler = new Crawler(db, client, runId, { limit, listPasses, refresh, log, progress });
  let stats = null, status = 'interrupted';
  try {
    try {
      stats = await client.getJson('info/stats');
      tx(db, () => run(db.prepare('UPDATE runs SET stats_json = ? WHERE id = ?'), dumps(stats), runId));
    } catch (e) {
      if (!(e instanceof FetchError)) throw e;
      crawler.err('stats', e.message, { severity: 'warning' });
    }
    await crawler.crawlList();
    await crawler.fetchPackages(crawler.targets());
    let mode = audit;
    if (mode === 'auto') {
      mode = limit ? 'off' : 'counts';
      if (limit) log('info', 'author audit skipped: counts are not comparable with --limit-packages');
    }
    if (mode !== 'off') await crawler.auditAuthors(mode === 'full');
    status = 'finished';
  } catch (e) {
    if (!(e instanceof Interrupted)) throw e;
    log('warning', 'interrupted; progress is saved, run again to resume');
  }
  const report = { ...buildReport(db, runId, limit, crawler.audit, stats), requests: client.requests, run_status: status };
  tx(db, () => run(db.prepare('UPDATE runs SET finished_at = ?, status = ?, report_json = ? WHERE id = ?'), now(), status, dumps(report), runId));
  log('info', `run ${runId} ${status}: ${report.listing.unique_packages_listed} packages listed / ${report.listing.reported_count} reported, `
    + `${report.questions.rows} question rows, ${report.errors} errors -> ${report.complete ? 'COMPLETE' : 'INCOMPLETE'}`);
  return { report, status };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const { values: a } = parseArgs({ args: rest, options: {
    db: { type: 'string', default: '3sual.sqlite' }, delay: { type: 'string', default: '1' },
    timeout: { type: 'string', default: '30' }, retries: { type: 'string', default: '5' },
    'limit-packages': { type: 'string' }, 'list-passes': { type: 'string', default: '2' },
    refresh: { type: 'boolean' }, 'new-run': { type: 'boolean' }, 'audit-authors': { type: 'string', default: 'auto' },
    out: { type: 'string', default: 'questions.jsonl' }, 'include-raw': { type: 'boolean' }, limit: { type: 'string' },
  } });
  const num = (k, int = false) => {
    if (a[k] === undefined) return null;
    const x = Number(a[k]);
    if (!(x >= 0) || (int && !isInt(x))) throw new Error(`--${k} must be a non-negative ${int ? 'integer' : 'number'}`);
    return x;
  };
  if (!['crawl', 'images', 'export'].includes(cmd)) {
    process.stderr.write('usage: node scraper.js crawl|images|export --db FILE [options]  (see README.md)\n');
    return 2;
  }
  if (!['auto', 'off', 'counts', 'full'].includes(a['audit-authors'])) throw new Error('--audit-authors must be auto, off, counts or full');
  const db = connect(a.db);
  try {
    if (cmd === 'export') {
      defaultLog('info', `wrote ${exportJsonl(db, a.out, !!a['include-raw'])} question records to ${a.out}`);
      return 0;
    }
    const stop = new AbortController();
    process.once('SIGINT', () => stop.abort());
    const client = new Client({ delay: num('delay'), retries: num('retries', true), timeout: num('timeout'), signal: stop.signal });
    if (cmd === 'crawl') {
      const { report, status } = await crawl(db, { client, limit: num('limit-packages', true), listPasses: num('list-passes', true),
        refresh: !!a.refresh, newRun: !!a['new-run'], audit: a['audit-authors'] });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return status !== 'finished' ? 130 : report.complete ? 0 : 1;
    }
    try {
      const report = await downloadImages(db, client, path.dirname(path.resolve(a.db)), { limit: num('limit', true) });
      process.stdout.write(`${dumps(report)}\n`);
      return report.complete ? 0 : 1;
    } catch (e) {
      if (!(e instanceof Interrupted)) throw e;
      defaultLog('warning', 'interrupted; run again to continue');
      return 130;
    }
  } finally {
    db.close();
  }
}

module.exports = { SOURCE_ID, Client, FetchError, Interrupted, Extraction, media, mergeLists, normalizePackage, validateDocument,
  SCHEMA, QUESTION_COLUMNS, connect, prepareDb, questionRow, storePackage, markFailed, Crawler, buildReport,
  exportJsonl, imagePath, downloadImages, openRun, crawl, main };

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => {
    process.stderr.write(`${e.stack || e}\n`);
    process.exitCode = 2;
  });
}
