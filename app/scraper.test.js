'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const t = require('./scraper');

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const needsFixtures = { skip: !fs.existsSync(path.join(__dirname, 'fixtures')) && 'needs app/fixtures, which is not published' };
const memdb = () => t.prepareDb(new DatabaseSync(':memory:'));
const one = (db, sql, ...a) => Object.values(db.prepare(sql).get(...a))[0];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-'));
const quiet = () => {};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('questions inside subphases (Breyn Rinq: phases[].subs[].questions[])', needsFixtures, () => {
  const ext = t.normalizePackage(fixture('package_breyn_subs.json'));
  assert.deepEqual(ext.problems, []);
  assert.equal(ext.records.length, 8);
  assert.deepEqual(new Set(ext.records.map(r => r.kind)), new Set(['question']));
  const r = ext.records[0];
  assert.deepEqual([r.package_id, r.value_id, r.uid], [3992, 102658, '3992:question:102658']);
  assert.deepEqual([r.phase_name, r.subphase_name], ['1/4 Final', 'I Döyüş']);
  assert.deepEqual(r.phase_path.map(p => p.name), ['1/4 Final', 'I Döyüş']);
  assert.equal(r.game_name, 'Breyn Rinq');
  assert.equal(r.answer, 'Amazon');
  assert.ok(r.comment.startsWith('1995-ci ildə'));
  assert.deepEqual(r.authors.map(a => a.id), [2510]);
  assert.notEqual(r.tournament_name, null);
  const subs = ext.phases.filter(p => p.depth === 1);
  assert.equal(subs.length, 4);
  assert.ok(subs.every(p => p.parent_phase_id));
  assert.deepEqual(ext.records.map(x => x.ordinal), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('themes direct and inside subphases (Erudit-kvartet)', needsFixtures, () => {
  const ext = t.normalizePackage(fixture('package_erudit_themes.json'));
  assert.deepEqual(ext.problems, []);
  assert.deepEqual([ext.themes.length, ext.records.length], [4, 12]);
  const direct = ext.records.filter(r => r.subphase_id === null), nested = ext.records.filter(r => r.subphase_id !== null);
  assert.deepEqual([direct.length, nested.length], [6, 6]);
  const r = nested[0];
  assert.deepEqual([r.kind, r.theme_name, r.subphase_name], ['theme', 'İnək', 'A qrupu']);
  assert.deepEqual([r.group_key, r.group_size, r.group_index], ['t:506', 3, 0]);
  assert.equal(r.authors[0].id, 43);
  assert.equal(direct[0].comment.slice(0, 4), 'Krok');
  assert.equal(direct[1].comment, null);
  assert.deepEqual(ext.themes.filter(th => th.name === 'İnək').map(th => th.phase_id), [r.subphase_id]);
});

test('multi-value group, media and accepted answers (OSİP)', needsFixtures, () => {
  const recs = Object.fromEntries(t.normalizePackage(fixture('package_osip_questions.json')).records.map(r => [r.value_id, r]));
  const blits = [932, 933, 934].map(i => recs[i]);
  assert.deepEqual([...new Set(blits.map(r => r.group_key))], ['q:932']);
  assert.deepEqual(blits.map(r => r.group_index), [0, 1, 2]);
  assert.deepEqual([...new Set(blits.map(r => r.group_size))], [3]);
  assert.equal(new Set(blits.map(r => r.comment)).size, 1);
  assert.equal(blits[0].sources.length, 2);
  assert.equal(recs[898].rekvizit_url, 'https://api.3sual.az/images/rekvizit/1582455607337.95121-2.jpg');
  assert.equal(recs[898].rekvizit_text, null);
  assert.equal(recs[920].rekvizit_text, '... bizə ... deyil');
  assert.equal(recs[920].rekvizit_url, null);
  assert.equal(recs[897].accepted_answers, 'Dəqiq cavablar');
  assert.ok('rekvizit' in recs[898].raw_value);
  assert.ok(!('values' in recs[898].raw_parent));
});

test('arbitrarily nested subs', () => {
  const v = i => ({ id: i, text: `t${i}`, answer: `a${i}`, rekvizit: null });
  const doc = { package: { id: 1, game: { id: 9, name: 'G' }, phases: [
    { id: 10, name: 'P', questions: [{ values: [v(1)] }], subs: [
      { id: 11, name: 'S', subs: [
        { id: 12, name: 'SS', questions: [{ values: [v(2), v(3)] }],
          themes: [{ id: 5, name: 'T', values: [{ id: 4, text: 'x', answer: 'y', rekvizit: 'rekvizit/a b.png' }] }] }] }] }] } };
  const ext = t.normalizePackage(doc);
  assert.deepEqual(ext.problems, []);
  const by = Object.fromEntries(ext.records.map(r => [r.value_id, r]));
  assert.deepEqual(by[1].phase_path, [{ id: 10, name: 'P' }]);
  assert.deepEqual(by[2].phase_path.map(p => p.id), [10, 11, 12]);
  assert.deepEqual([by[2].phase_id, by[2].subphase_id, by[2].subphase_name], [10, 12, 'SS']);
  assert.equal(by[4].rekvizit_url, 'https://api.3sual.az/images/rekvizit/a%20b.png');
  assert.deepEqual(ext.phases.map(p => p.depth), [0, 1, 2]);
});

test('malformed records are reported, not dropped silently', () => {
  const doc = { package: { id: 7, phases: [
    'not a phase',
    { id: 1, name: 'P',
      questions: [{ values: [] }, { values: [{ text: 'no id' }, { id: 5, text: 'ok', answer: 'a' }] },
        { values: [{ id: 5, text: 'changed', answer: 'b' }] }],
      themes: { oops: 1 } }] } };
  const ext = t.normalizePackage(doc);
  assert.deepEqual(ext.records.map(r => r.value_id), [5]);
  const paths = Object.fromEntries(ext.problems.map(p => [p.path, p]));
  for (const p of ['package.phases[0]', 'package.phases[1].questions[0]', 'package.phases[1].questions[1].values[0]', 'package.phases[1].themes']) {
    assert.ok(p in paths, p);
  }
  assert.equal(paths['package.phases[1].questions[2].values[0]'].severity, 'error');
  assert.ok(ext.problems.every(p => p.severity === 'error'));
});

const counts = db => ['questions', 'phases', 'themes'].map(x => one(db, `SELECT COUNT(*) FROM ${x}`));

test('store is idempotent and replaces stale rows', needsFixtures, () => {
  const db = memdb(), doc = fixture('package_erudit_themes.json');
  assert.equal(t.storePackage(db, 1, 119, doc, t.normalizePackage(doc)), 'ok');
  const first = counts(db);
  t.storePackage(db, 2, 119, doc, t.normalizePackage(doc));
  assert.deepEqual(counts(db), first);
  assert.equal(one(db, 'SELECT attempts FROM packages WHERE id=119'), 2);
  const smaller = structuredClone(doc);
  smaller.package.phases = smaller.package.phases.slice(0, 1);
  t.storePackage(db, 3, 119, smaller, t.normalizePackage(smaller));
  assert.equal(counts(db)[0], 6);
  assert.deepEqual(JSON.parse(one(db, 'SELECT raw_json FROM packages WHERE id=119')), smaller);
});

test('refresh keeps rows edited in the app', needsFixtures, () => {
  const db = memdb(), doc = fixture('package_erudit_themes.json');
  t.storePackage(db, 1, 119, doc, t.normalizePackage(doc));
  const uid = one(db, 'SELECT uid FROM questions ORDER BY ordinal LIMIT 1');
  db.prepare("UPDATE questions SET text='fixed', edited_at='2026-09-26' WHERE uid=?").run(uid);
  const n = counts(db)[0];
  t.storePackage(db, 2, 119, doc, t.normalizePackage(doc));
  assert.equal(one(db, 'SELECT text FROM questions WHERE uid=?', uid), 'fixed');
  assert.equal(counts(db)[0], n);
});

test('empty and partial statuses', () => {
  const db = memdb();
  const empty = { package: { id: 3, phases: [{ id: 1, name: 'I tur', questions: [] }] } };
  assert.equal(t.storePackage(db, 1, 3, empty, t.normalizePackage(empty)), 'empty');
  const bad = { package: { id: 4, phases: [{ id: 2, questions: [{ values: [{ text: 'x' }] }] }] } };
  assert.equal(t.storePackage(db, 1, 4, bad, t.normalizePackage(bad)), 'partial');
  assert.deepEqual({ ...db.prepare('SELECT package_id, stage, severity, path FROM errors').get() },
    { package_id: 4, stage: 'parse', severity: 'error', path: 'package.phases[0].questions[0].values[0]' });
});

test('export jsonl', needsFixtures, () => {
  const db = memdb(), doc = fixture('package_osip_questions.json');
  t.storePackage(db, 1, 20, doc, t.normalizePackage(doc));
  const out = path.join(tmp(), 'q.jsonl');
  assert.equal(t.exportJsonl(db, out), 6);
  const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(rows.map(r => r.value_id), [932, 933, 934, 898, 920, 897]);
  assert.ok(Array.isArray(rows[0].sources));
  assert.equal(typeof rows[0].is_translated, 'boolean');
  assert.ok(!('raw_value' in rows[0]));
});

class FakeFetch {
  constructor(fail = []) {
    this.fail = new Set(fail);
    this.calls = [];
  }

  async fetch(url) {
    this.calls.push(url);
    if (this.fail.has(url)) throw new t.FetchError(`HTTP 404 for ${url}`);
    return { status: 200, headers: new Headers({ 'Content-Type': 'image/png' }), body: Buffer.concat([PNG_SIGNATURE, Buffer.from(url)]) };
  }
}

test('image download resumes, retries failures and exports paths', needsFixtures, async () => {
  const db = memdb(), doc = fixture('package_osip_questions.json');
  t.storePackage(db, 1, 20, doc, t.normalizePackage(doc));
  const extra = 'https://api.3sual.az/images/theme/a b.jpeg';
  db.prepare('UPDATE questions SET source_media_url=? WHERE value_id=933').run(extra);
  const rekvizit = one(db, 'SELECT rekvizit_url FROM questions WHERE rekvizit_url IS NOT NULL');
  const root = tmp(), opts = { log: quiet };
  const report = await t.downloadImages(db, new FakeFetch([extra]), root, opts);
  assert.deepEqual([report.referenced, report.downloaded, report.failed, report.complete], [2, 1, 1, false]);
  const rel = one(db, 'SELECT path FROM images WHERE url=?', rekvizit);
  assert.ok(rel.startsWith('images/') && rel.endsWith('.png'));
  assert.deepEqual(fs.readFileSync(path.join(root, rel)), Buffer.concat([PNG_SIGNATURE, Buffer.from(rekvizit)]));
  const again = new FakeFetch();
  assert.ok((await t.downloadImages(db, again, root, opts)).complete);
  assert.deepEqual(again.calls, [extra]);
  fs.unlinkSync(path.join(root, rel));
  const third = new FakeFetch();
  await t.downloadImages(db, third, [tmp(), root], opts);
  assert.deepEqual(third.calls, [rekvizit]);
  const out = path.join(root, 'q.jsonl');
  t.exportJsonl(db, out);
  const rows = Object.fromEntries(fs.readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l)).map(r => [r.value_id, r]));
  assert.equal(rows[933].source_media_path, t.imagePath(extra, 'image/png'));
  assert.ok(Object.values(rows).some(r => r.rekvizit_path === rel));
});

class FakeClient {
  constructor(routes) {
    this.routes = routes;
    this.calls = [];
    this.requests = 0;
  }

  async getJson(p, params) {
    this.calls.push([p, params]);
    this.requests++;
    const answer = this.routes(p, params);
    if (answer instanceof Error) throw answer;
    return structuredClone(answer);
  }
}

function listing(pagesByPass) {
  let pass = 0;
  return (p, params) => {
    assert.equal(p, 'packages/forhome');
    if (params.page === 1) pass++;
    const ids = pagesByPass[pass - 1][params.page] || [];
    return { count: 7, packages: ids.map(i => ({ id: i, name: `p${i}`, game: 'G' })) };
  };
}

const crawler = (db, client, runId, opts = {}) => new t.Crawler(db, client, runId, { log: quiet, ...opts });

test('listing: duplicates, shifts and a second pass', async () => {
  const db = memdb();
  const c = crawler(db, new FakeClient(listing([{ 1: [1, 2, 3], 2: [3, 4, 5], 3: [6] }, { 1: [1, 2, 3], 2: [4, 5, 6], 3: [7] }])), 1);
  await c.crawlList();
  assert.deepEqual([...c.targets()].sort(), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(c.targets().slice(0, 3), [1, 2, 3]);
  const rep = t.buildReport(db, 1, null, {}, null);
  assert.equal(rep.listing.unique_packages_listed, 7);
  assert.equal(rep.listing.duplicate_sightings, 1);
  assert.equal(rep.listing.passes, 2);
  assert.ok(rep.listing.coverage_ok);
});

test('listing: resume skips recorded pages and limit stops early', async () => {
  const db = memdb();
  const route = listing([{ 1: [1, 2, 3], 2: [4, 5, 6], 3: [7] }, { 1: [1, 2, 3], 2: [4, 5, 6], 3: [7] }]);
  const first = new FakeClient(route);
  await crawler(db, first, 1).crawlList();
  assert.equal(first.calls.length, 4);
  const again = new FakeClient(route);
  await crawler(db, again, 1).crawlList();
  assert.deepEqual(again.calls, []);
  const limited = new FakeClient(route);
  const c = crawler(memdb(), limited, 1, { limit: 2 });
  await c.crawlList();
  assert.deepEqual([limited.calls.length, c.targets()], [1, [1, 2]]);
});

test('listing: empty page mid-listing is logged and skipped', async () => {
  const db = memdb();
  const c = crawler(db, new FakeClient(listing([{ 1: [1, 2, 3], 3: [4, 5, 6], 4: [7] }])), 1, { listPasses: 1 });
  await c.crawlList();
  assert.equal(c.targets().length, 7);
  assert.equal(t.buildReport(db, 1, null, {}, null).listing.empty_pages_before_end, 1);
});

test('fetch failures are recorded and retried on resume', needsFixtures, async () => {
  const db = memdb();
  const docs = { 119: fixture('package_erudit_themes.json'), 20: null };
  const route = (p, params) => (params.id === 5 ? new t.FetchError('HTTP 404') : docs[params.id]);
  await crawler(db, new FakeClient(route), 1).fetchPackages([119, 20, 5]);
  assert.deepEqual(Object.fromEntries(db.prepare('SELECT id, status FROM packages').all().map(r => [r.id, r.status])),
    { 119: 'ok', 20: 'failed', 5: 'failed' });
  assert.equal(one(db, "SELECT COUNT(*) FROM errors WHERE stage='fetch'"), 2);
  docs[20] = fixture('package_osip_questions.json');
  const again = new FakeClient(route);
  await crawler(db, again, 2).fetchPackages([119, 20]);
  assert.deepEqual(again.calls.map(([, p]) => p.id), [20]);
  assert.equal(one(db, 'SELECT status FROM packages WHERE id=20'), 'ok');
  assert.equal(one(db, 'SELECT COUNT(*) FROM errors WHERE package_id=20'), 0);
});

test('refresh refetches stored packages once per run, so a resumed refresh skips them', needsFixtures, async () => {
  const db = memdb(), doc = fixture('package_osip_questions.json');
  t.storePackage(db, 1, 20, doc, t.normalizePackage(doc));
  db.prepare("UPDATE packages SET fetched_at = '2020-01-01T00:00:00+00:00'").run();
  const { runId } = t.openRun(db, true, {});
  const first = new FakeClient(() => doc);
  await crawler(db, first, runId, { refresh: true }).fetchPackages([20]);
  assert.equal(first.calls.length, 1);
  const resumed = new FakeClient(() => doc);
  await crawler(db, resumed, runId, { refresh: true }).fetchPackages([20]);
  assert.equal(resumed.calls.length, 0);
});

test('package id mismatch fails', needsFixtures, () => {
  assert.match(t.validateDocument(fixture('package_osip_questions.json'), 21), /!=/);
  assert.equal(t.validateDocument(fixture('package_osip_questions.json'), 20), null);
  assert.notEqual(t.validateDocument({ x: 1 }, 20), null);
});

test('author listing reveals missing values', needsFixtures, async () => {
  const db = memdb(), doc = fixture('package_osip_questions.json');
  t.storePackage(db, 1, 20, doc, t.normalizePackage(doc));
  const aq = fixture('author_questions.json');
  const route = (p, params) => {
    if (p === 'authors') return { count: 1, authors: [{ id: 43, fullname: 'A', questions: 2, themes: 0 }] };
    if (p === 'authors/questions') return params.page === 1 ? aq : { count: 2, results: [] };
    throw new Error(p);
  };
  const c = crawler(db, new FakeClient(route), 1);
  await c.auditAuthors();
  assert.equal(c.audit.values_discovered, 1);
  assert.deepEqual(c.audit.count_mismatches, [{ author_id: 43, kind: 'questions', site: 2, local: 1 }]);
  assert.deepEqual({ ...db.prepare('SELECT package_id, origin FROM questions WHERE value_id=900').get() }, { package_id: 20, origin: 'author_listing' });
  await c.auditAuthors();
  assert.equal(c.audit.listings_checked, 0);
});

function client(responses, opts = {}) {
  const waits = [];
  const fetch = async () => {
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return r;
  };
  const c = new t.Client({ delay: 0, log: quiet, fetch, sleep: async ms => { waits.push(ms); }, ...opts });
  return { c, waits, left: () => responses.length };
}
const res = (status, body = '{"ok": 1}') => new Response(status === 204 ? null : body, { status });

test('client retries transient errors with growing backoff', async () => {
  const { c, waits, left } = client([res(503), new DOMException('slow', 'TimeoutError'), res(429), res(200)]);
  assert.deepEqual(await c.getJson('x'), { ok: 1 });
  assert.equal(left(), 0);
  assert.equal(c.requests, 4);
  assert.ok(waits[0] < waits[1] && waits[1] < waits[2]);
});

test('client does not retry client errors and gives up after retries', async () => {
  const a = client([res(404), res(200)]);
  await assert.rejects(a.c.getJson('x'), t.FetchError);
  assert.equal(a.left(), 1);
  const b = client([res(500), res(500), res(500)], { retries: 2 });
  await assert.rejects(b.c.getJson('x'), /gave up after 3 attempts/);
});

test('client: 204 is null, bad JSON raises, abort stops', async () => {
  assert.equal(await client([res(204)]).c.getJson('x'), null);
  await assert.rejects(client([res(200, '<html>')]).c.getJson('x'), /invalid JSON/);
  await assert.rejects(client([res(200)], { signal: AbortSignal.abort() }).c.getJson('x'), t.Interrupted);
});

test('downloads use https only, stay under size limits and refuse redirects away from https', async () => {
  const quietClient = fetch => new t.Client({ delay: 0, retries: 0, log: quiet, fetch, sleep: async () => {} });
  const ok = async () => new Response('{"ok":1}');
  await assert.rejects(quietClient(ok).fetch('http://api.3sual.az/api/x'), /only https/);
  await assert.rejects(quietClient(ok).fetch('file:///etc/passwd'), /only https/);
  const declared = async () => new Response('x', { headers: { 'Content-Length': String(100 * 1024 * 1024) } });
  await assert.rejects(quietClient(declared).fetch('https://api.3sual.az/images/a.png', 'image/*', { maxBytes: 1024 }), /larger than/);
  const streamed = async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(4096)); } }));
  await assert.rejects(quietClient(streamed).fetch('https://api.3sual.az/images/a.png', 'image/*', { maxBytes: 64 * 1024 }), /larger than/);
  const redirected = async () => ({ status: 200, url: 'http://evil.example/a.png', headers: new Headers(), body: null, arrayBuffer: async () => new ArrayBuffer(1) });
  await assert.rejects(quietClient(redirected).fetch('https://api.3sual.az/images/a.png'), /redirected away from https/);
});

test('image download fetches only question bank pictures and keeps only real images', async () => {
  const db = memdb();
  const add = db.prepare("INSERT INTO questions (package_id, kind, value_id, uid, origin, ordinal, rekvizit_url) VALUES (1, 'question', ?, ?, 'package', ?, ?)");
  const site = 'https://api.3sual.az/images/good.png';
  const fake = 'https://api.3sual.az/images/fake.png';
  [site, fake, 'http://192.168.1.1/admin', 'https://tracker.example/pixel.png', 'own-image:abc.png', 'https://api.3sual.az/api/secret']
    .forEach((url, i) => add.run(i + 1, `1:question:${i + 1}`, i + 1, url));
  const calls = [];
  const client = new t.Client({ delay: 0, retries: 0, log: quiet, sleep: async () => {}, fetch: async url => {
    calls.push(url);
    const body = url === site ? Buffer.concat([PNG_SIGNATURE, Buffer.alloc(16)]) : Buffer.from('<html><script>alert(1)</script></html>');
    return new Response(body, { headers: { 'Content-Type': 'image/png' } });
  } });
  const root = tmp();
  const report = await t.downloadImages(db, client, root, { log: quiet });
  assert.deepEqual(calls, [fake, site]);
  assert.deepEqual([report.downloaded, report.failed], [1, 1]);
  const rel = one(db, "SELECT path FROM images WHERE url=? AND status='ok'", site);
  assert.match(rel, /^images\/[0-9a-f]{2}\/[0-9a-f]{40}\.png$/);
  assert.equal(one(db, 'SELECT status FROM images WHERE url=?', fake), 'failed');
});
