'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ai = require('./ai');
const { Store, TUNING, fold, passage, embeddable } = require('./store');
const { environment } = require('./bench/environment');

const DB = process.env.QUIZ_DB || path.join(__dirname, '..', 'data', 'kimhardane.sqlite');
const CACHE = path.join(__dirname, 'bench', 'cache');
const slug = model => model.replace(/[^\w.-]+/g, '_');
const PASSAGES = { ta: passage, tac: r => `${passage(r)}\n${r.comment ?? ''}` };
const passagesHash = (store, kind) => store.rows.reduce((hash, r) => hash.update(`${r.uid}\0${PASSAGES[kind](r)}\0`), crypto.createHash('sha1')).digest('hex');
const cacheName = (model, kind) => slug(model) + (kind === 'ta' ? '' : `@${kind}`);

async function embedCorpus(model, kind = 'ta') {
  const store = new Store(DB);
  const { dim } = ai.MODELS[model];
  const vecs = new Float32Array(store.rows.length * dim);
  const text = i => PASSAGES[kind](store.rows[i]);
  const todo = store.rows.map((r, i) => i).filter(i => embeddable(store.rows[i])).sort((a, b) => text(a).length - text(b).length);
  const t0 = Date.now();
  for (let k = 0; k < todo.length; k += ai.BATCH) {
    const idx = todo.slice(k, k + ai.BATCH);
    (await ai.embed(idx.map(text), 'passage', model)).forEach((v, j) => {
      if (v.length !== dim || !v.every(Number.isFinite)) throw new Error(`${model}: unusable vector for ${store.rows[idx[j]].uid}`);
      vecs.set(v, idx[j] * dim);
    });
    if ((k / ai.BATCH) % 100 === 0) console.log(`${model}: ${k}/${todo.length} ${Math.round(k / ((Date.now() - t0) / 1000))}/s`);
  }
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(path.join(CACHE, `${cacheName(model, kind)}.f32`), Buffer.from(vecs.buffer));
  fs.writeFileSync(path.join(CACHE, `${cacheName(model, kind)}.json`), JSON.stringify({ model, kind, dim, rows: store.rows.length, space: ai.embeddingSpace(model).id, passages: passagesHash(store, kind) }));
  console.log(`${model} ${kind}: done in ${Math.round((Date.now() - t0) / 1000)} s`);
}

function cachedVectorsProblem(store, model, kind) {
  const metaFile = path.join(CACHE, `${cacheName(model, kind)}.json`);
  if (!fs.existsSync(metaFile)) return 'no cache';
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  if (meta.space !== ai.embeddingSpace(model).id) return 'made with another model revision or preprocessing';
  if (meta.passages !== passagesHash(store, kind)) return 'made from other question texts';
  return null;
}

async function useModel(store, model, kind) {
  const space = ai.embeddingSpace(model);
  if (model === ai.MODEL && kind === 'ta') {
    store.loadVectors({ ...space, legacyModel: await ai.legacyModelFor(space) });
    return store.vectorCount;
  }
  const problem = cachedVectorsProblem(store, model, kind);
  if (problem) throw new Error(`${model} ${kind}: cache ${problem}; run node bench.js embed ${model} ${kind}`);
  const buf = fs.readFileSync(path.join(CACHE, `${cacheName(model, kind)}.f32`));
  const vecs = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  if (vecs.length !== store.rows.length * space.dim || !vecs.every(Number.isFinite)) throw new Error(`${model} ${kind}: cache has unusable vectors`);
  const has = Uint8Array.from(store.rows, r => (embeddable(r) ? 1 : 0));
  Object.assign(store, { space, dim: space.dim, has, vectorCount: has.reduce((a, b) => a + b, 0), vecs });
  return store.vectorCount;
}

const ASCII = { ə: 'e', ı: 'i', ş: 's', ç: 'c', ğ: 'g', ö: 'o', ü: 'u', Ə: 'E', İ: 'I', Ş: 'S', Ç: 'C', Ğ: 'G', Ö: 'O', Ü: 'U' };
const ascii = q => q.replace(/[əışçğöüƏİŞÇĞÖÜ]/g, c => ASCII[c]);
const typo = q => {
  const w = q.split(' ').reduce((a, b) => (b.length > a.length ? b : a));
  const m = Math.floor(w.length / 2);
  return q.replace(w, w.slice(0, m - 1) + w[m] + w[m - 1] + w.slice(m + 1));
};
const norm = s => fold(s ?? '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildQueries(store) {
  const { targets } = JSON.parse(fs.readFileSync(path.join(__dirname, 'bench', 'queries.json'), 'utf8'));
  const byText = new Map(), byAnswer = new Map();
  for (const r of store.rows) {
    const t = norm(r.text), a = norm(r.answer);
    if (t) byText.set(t, [...(byText.get(t) ?? []), r.uid]);
    if (a) byAnswer.set(a, [...(byAnswer.get(a) ?? []), r.uid]);
  }
  const queries = [];
  targets.forEach((t, k) => {
    const row = store.rows[store.pos.get(t.uid)];
    if (!row) throw new Error(`unknown target ${t.uid}`);
    const relevant = new Set(byText.get(norm(row.text)) ?? [t.uid]);
    const split = k % 2 ? 'test' : 'dev';
    queries.push({ type: 'recall', q: t.recall, relevant, split }, { type: 'paraphrase', q: t.paraphrase, relevant, split },
      { type: 'ascii', q: ascii(t.recall), relevant, split }, { type: 'typo', q: typo(t.recall), relevant, split });
  });
  const rand = mulberry32(20260926), seen = new Set();
  while (seen.size < 60) {
    const r = store.rows[Math.floor(rand() * store.rows.length)];
    const a = norm(r.answer);
    if (a.length < 4 || a.length > 40 || !/\p{L}/u.test(a) || seen.has(a)) continue;
    queries.push({ type: 'answer', q: r.answer.trim(), relevant: new Set(byAnswer.get(a)), split: seen.size % 2 ? 'test' : 'dev' });
    seen.add(a);
  }
  return queries;
}

const TYPES = ['recall', 'paraphrase', 'ascii', 'typo', 'answer'];

function evaluate(store, queries, mode, qvecs) {
  return queries.map(x => {
    const hits = store.search({ q: x.q, mode, limit: 10 }, qvecs?.get(x.q) ?? null).hits;
    const rank = hits.findIndex(h => x.relevant.has(h.uid)) + 1;
    return { ...x, rank };
  });
}

function summarize(results, split) {
  const out = {};
  for (const type of [...TYPES, 'all']) {
    const rs = results.filter(r => (split === 'all' || r.split === split) && (type === 'all' || r.type === type));
    const mean = f => rs.reduce((a, r) => a + f(r), 0) / rs.length;
    out[type] = { n: rs.length, mrr: mean(r => (r.rank ? 1 / r.rank : 0)), hit1: mean(r => r.rank === 1), hit10: mean(r => r.rank > 0) };
  }
  out.macro = TYPES.reduce((a, t) => a + out[t].mrr, 0) / TYPES.length;
  return out;
}

const pct = x => (100 * x).toFixed(0).padStart(3);
function row(name, s) {
  return `${name.padEnd(58)} ${TYPES.map(t => pct(s[t].mrr)).join('  ')}   ${pct(s.macro)}   ${pct(s.all.hit1)}  ${pct(s.all.hit10)}`;
}
const HEADER = `${'config'.padEnd(58)} rec para asc typo ans  macro  h@1 h@10   (MRR@10 %)`;

async function run() {
  const store = new Store(DB);
  store.buildIndex();
  const queries = buildQueries(store);
  const report = [];
  const log = line => { console.log(line); report.push(line); };
  const embeddableCount = store.rows.filter(embeddable).length;
  log(`${queries.length} queries: ${TYPES.map(t => `${queries.filter(q => q.type === t).length} ${t}`).join(', ')}; dev/test split by target`);

  const BOOSTS = { current: TUNING.boost, none: {}, answer3: { answer: 3, text: 1.5, comment: 0.5 } };
  const kwConfigs = [];
  for (const combineWith of ['AND', 'OR']) for (const fuzzy of [0, 0.2]) for (const prefix of [true, false]) {
    for (const [b, boost] of Object.entries(BOOSTS)) kwConfigs.push({ name: `kw ${combineWith} fuzzy=${fuzzy} prefix=${prefix} boost=${b}`, tuning: { combineWith, fuzzy, prefix, boost } });
  }
  log(`\n## Keyword (dev)\n${HEADER}`);
  for (const c of kwConfigs) {
    Object.assign(store.tuning, TUNING, c.tuning);
    c.results = evaluate(store, queries, 'keyword');
    c.dev = summarize(c.results, 'dev');
    log(row(c.name, c.dev));
  }
  const bestKw = kwConfigs.reduce((a, b) => (b.dev.macro > a.dev.macro ? b : a));
  const shipped = kwConfigs.find(c => ['combineWith', 'fuzzy', 'prefix', 'boost'].every(k => c.tuning[k] === TUNING[k]));
  log(`best keyword on dev: ${bestKw.name}`);

  const variants = [];
  for (const model of Object.keys(ai.MODELS)) for (const kind of Object.keys(PASSAGES)) {
    if ((model === ai.MODEL && kind === 'ta') || !cachedVectorsProblem(store, model, kind)) {
      variants.push({ model, kind, short: model.split('/')[1] + (kind === 'ta' ? '' : '+comment') });
    }
  }
  const hyConfigs = [], qvecsByModel = new Map();
  report.unshift(...await environment(variants.map(v => v.model).filter((m, i, all) => all.indexOf(m) === i)), '');
  for (const { model, kind, short } of variants) {
    const coverage = await useModel(store, model, kind);
    log(`\n${short}: ${coverage} of ${embeddableCount} embeddable questions have vectors${coverage < embeddableCount ? ' (INCOMPLETE: AI results are understated)' : ''}`);
    const qvecs = qvecsByModel.get(model) ?? qvecsByModel.set(model, new Map()).get(model);
    const t0 = Date.now();
    for (const x of queries) if (!qvecs.has(x.q)) qvecs.set(x.q, await ai.embedQuery(x.q, model));
    const embedMs = (Date.now() - t0) / qvecs.size;
    const memo = new Map(), nearest = Store.prototype.nearest.bind(store);
    store.nearest = (qvec, keep) => memo.get(qvec) ?? memo.set(qvec, nearest(qvec, keep)).get(qvec);
    Object.assign(store.tuning, TUNING, bestKw.tuning);
    const aiOnly = { name: `ai ${short}`, model: short, results: evaluate(store, queries, 'ai', qvecs) };
    aiOnly.dev = summarize(aiOnly.results, 'dev');
    log(`\n## ${short} (query embed ${embedMs.toFixed(0)} ms)\n${HEADER}\n${row(aiOnly.name, aiOnly.dev)}`);
    for (const kwc of [shipped, bestKw]) {
      for (const rrfK of [10, 30, 60]) for (const aiWeight of [0.5, 1, 2]) {
        const c = { name: `hy ${short} ${kwc === bestKw ? 'bestkw' : 'default'} k=${rrfK} w=${aiWeight}`, model: short, qvecs, tuning: { ...kwc.tuning, rrfK, aiWeight } };
        Object.assign(store.tuning, TUNING, c.tuning);
        c.results = evaluate(store, queries, 'hybrid', qvecs);
        c.dev = summarize(c.results, 'dev');
        log(row(c.name, c.dev));
        hyConfigs.push(c);
      }
      if (kwc === bestKw) break;
    }
    hyConfigs.push(aiOnly);
    delete store.nearest;
  }

  const baseline = hyConfigs.find(c => c.name === `hy ${ai.MODEL.split("/")[1]} default k=${TUNING.rrfK} w=${TUNING.aiWeight}`);
  const pick = list => list.reduce((x, y) => (y.dev.macro > x.dev.macro ? y : x));
  const best = pick([...kwConfigs, ...hyConfigs]);
  const before = hyConfigs.find(c => c.name === 'hy multilingual-e5-small default k=60 w=1');
  const lines = [...(before ? [['before tuning', before]] : []), ['shipped now', baseline], ['best keyword', bestKw]];
  for (const { short } of variants) {
    lines.push(['ai only', hyConfigs.find(c => c.name === `ai ${short}`)],
      ['best hybrid', pick(hyConfigs.filter(c => c.model === short && c.name.startsWith('hy ')))]);
  }
  lines.push(['BEST on dev', best]);
  log(`\n## Test split (held out)\n${HEADER}`);
  for (const [label, c] of lines) log(row(`${label}: ${c.name.replace('multilingual-', '')}`.slice(0, 58), summarize(c.results, 'test')));
  log(`\nbest overall = ${best.name} ${JSON.stringify(best.tuning ?? {})}`);
  const misses = best.results.filter(r => !r.rank).map(r => `  [${r.type}] ${r.q}`);
  log(`\nmisses of best config (${misses.length}):\n${misses.join('\n')}`);
  fs.writeFileSync(path.join(__dirname, 'bench', 'results.txt'), report.join('\n') + '\n');
}

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  (cmd === 'embed' ? embedCorpus(arg, process.argv[4]) : run()).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { ascii, typo, norm, summarize, buildQueries, evaluate, cachedVectorsProblem };
