'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ai = require('../ai');
const { Store, TUNING, embeddable } = require('../store');
const { buildQueries, evaluate } = require('../bench');

const DB = process.env.QUIZ_DB || path.join(__dirname, '..', '..', 'data', 'kimhardane.sqlite');
const CACHE = path.join(__dirname, 'cache', `placeholders-${ai.MODEL.replace(/[^\w.-]+/g, '_')}.f32`);
const PLACEHOLDER = /(?<![\p{L}\p{N}])(?:İKS|IKS|iks|ALFA|ALPHA|Alfa|alfa|BETA|Beta|İQREK|BUN[A-ZƏÖÜÇŞĞİ]*|BU|ON(?:U|A|DA|LA)[A-ZƏÖÜÇŞĞİ]*)(?:-?\p{L}*)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])[XY](?:-\p{L}+)?(?![\p{L}\p{N}])(?!\s+əsr)/gu;
const HAS_PLACEHOLDER = new RegExp(PLACEHOLDER.source, 'u');
const answerOf = r => (r.answer ?? '').trim().replace(/[.]+$/, '');
const filled = r => `${(r.text ?? '').replace(PLACEHOLDER, answerOf(r))}\n${r.answer ?? ''}`;

async function filledVectors(store, rows) {
  if (fs.existsSync(CACHE)) {
    const buf = fs.readFileSync(CACHE);
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }
  const vecs = new Float32Array(rows.length * store.dim);
  const order = rows.map((r, k) => k).sort((a, b) => filled(rows[a]).length - filled(rows[b]).length);
  for (let k = 0; k < order.length; k += ai.BATCH) {
    const part = order.slice(k, k + ai.BATCH);
    (await ai.embed(part.map(j => filled(rows[j])), 'passage')).forEach((v, n) => vecs.set(v, part[n] * store.dim));
    if ((k / ai.BATCH) % 50 === 0) console.log(`${k}/${rows.length}`);
  }
  fs.writeFileSync(CACHE, Buffer.from(vecs.buffer));
  return vecs;
}

function placeholderQueries(store) {
  const { targets } = JSON.parse(fs.readFileSync(path.join(__dirname, 'placeholders.json'), 'utf8'));
  return targets.flatMap((t, k) => {
    if (!store.pos.has(t.uid)) throw new Error(`unknown target ${t.uid}`);
    const relevant = new Set([t.uid]), split = k % 2 ? 'test' : 'dev';
    return [{ type: 'ph recall', q: t.recall, relevant, split }, { type: 'ph with answer', q: t.withAnswer, relevant, split }];
  });
}

function score(results, filter) {
  const rs = results.filter(filter);
  const mean = f => rs.reduce((a, r) => a + f(r), 0) / rs.length;
  return { n: rs.length, mrr: mean(r => (r.rank ? 1 / r.rank : 0)), hit10: mean(r => r.rank > 0) };
}

async function main() {
  const store = new Store(DB);
  store.buildIndex();
  store.loadVectors(ai.embeddingSpace());
  const affected = store.rows.map((r, i) => i).filter(i => embeddable(store.rows[i]) && HAS_PLACEHOLDER.test(store.rows[i].text ?? ''));
  const isAffected = new Uint8Array(store.rows.length);
  affected.forEach(i => (isAffected[i] = 1));
  console.log(`${affected.length} of ${store.rows.length} questions have a placeholder; examples:`);
  for (const i of affected.filter((_, k) => k % Math.floor(affected.length / 6) === 0).slice(0, 6)) console.log(`  ${filled(store.rows[i]).replace(/\s+/g, ' ').slice(0, 200)}`);

  const queries = [...buildQueries(store), ...placeholderQueries(store)];
  const qvecs = new Map();
  for (const x of queries) if (!qvecs.has(x.q)) qvecs.set(x.q, await ai.embedQuery(x.q));
  const original = store.vecs.slice();
  const replaced = await filledVectors(store, affected.map(i => store.rows[i]));
  const sets = [
    ['bench: all 300', r => !r.type.startsWith('ph')], ['bench: paraphrase', r => r.type === 'paraphrase'],
    ['placeholder: recall', r => r.type === 'ph recall'], ['placeholder: with answer', r => r.type === 'ph with answer'],
  ];
  const lines = [`${'query set'.padEnd(28)} ${'mode'.padEnd(7)}   as is MRR h@10   filled MRR h@10`];
  const runs = {};
  for (const variant of ['as is', 'filled']) {
    store.vecs = original.slice();
    if (variant === 'filled') affected.forEach((i, k) => store.vecs.set(replaced.subarray(k * store.dim, (k + 1) * store.dim), i * store.dim));
    Object.assign(store.tuning, TUNING);
    for (const mode of ['ai', 'hybrid']) runs[`${variant} ${mode}`] = evaluate(store, queries, mode, qvecs);
    const hits = queries.filter(x => !x.type.startsWith('ph')).flatMap(x => store.search({ q: x.q, mode: 'ai', limit: 10 }, qvecs.get(x.q)).hits);
    runs[`${variant} share`] = hits.filter(h => isAffected[store.pos.get(h.uid)]).length / hits.length;
  }
  const pct = x => (100 * x).toFixed(0).padStart(4);
  for (const [name, filter] of sets) for (const mode of ['ai', 'hybrid']) {
    const a = score(runs[`as is ${mode}`], filter), b = score(runs[`filled ${mode}`], filter);
    lines.push(`${`${name} (${a.n})`.padEnd(28)} ${mode.padEnd(7)}   ${pct(a.mrr)} ${pct(a.hit10)}       ${pct(b.mrr)} ${pct(b.hit10)}`);
  }
  lines.push('', `placeholder questions are ${pct(affected.length / store.rows.length)}% of the corpus and ${pct(runs['as is share'])}% of AI top-10 hits for the 300 bench queries as is, ${pct(runs['filled share'])}% when filled`);
  const text = lines.join('\n');
  console.log(text);
  fs.writeFileSync(path.join(__dirname, 'placeholders-results.txt'), `${text}\n`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { PLACEHOLDER, filled };
