'use strict';
// Benchmarks judge.js on answers made from the dataset: node bench/judge.js [questions=300]
const fs = require('node:fs');
const path = require('node:path');
const ai = require('../ai');
const { Store, fold } = require('../store');
const { JUDGE_THRESHOLDS, answerCandidates, editDistance, judgeAnswer } = require('../judge');

const DB = process.env.QUIZ_DB || path.join(__dirname, '..', '..', 'data', '3sual.sqlite');
const CACHE = path.join(__dirname, 'cache', 'judge-vectors.json');
const N = +process.argv[2] || 300;

let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = list => list[Math.floor(rand() * list.length)];

const LETTERS = 'abcdefgəhxıijkqlmnoöprsştuüvyz';
function typo(text, edits) {
  const words = text.split(' ');
  const i = words.reduce((best, w, k) => (w.length > words[best].length ? k : best), 0);
  let w = words[i];
  for (let e = 0; e < edits; e++) {
    const at = 1 + Math.floor(rand() * (w.length - 2));
    const kind = Math.floor(rand() * 4);
    if (kind === 0) w = w.slice(0, at) + pick([...LETTERS]) + w.slice(at + 1);
    else if (kind === 1) w = w.slice(0, at) + w.slice(at + 1);
    else if (kind === 2) w = w.slice(0, at) + pick([...LETTERS]) + w.slice(at);
    else w = w.slice(0, at - 1) + w[at] + w[at - 1] + w.slice(at + 1);
  }
  words[i] = w;
  return words.join(' ');
}
const TRANSLIT = { ə: 'a', Ə: 'A', ş: 'sh', Ş: 'Sh', ç: 'ch', Ç: 'Ch', ı: 'i', ğ: 'g', ö: 'o', ü: 'u' };
const translit = text => text.replace(/[əƏşŞçÇığöü]/g, c => TRANSLIT[c]);
const parts = text => text.split(/\s*[,;]\s*|\s+və\s+/).filter(Boolean);
// Answers closer than this are often the same answer spelled two ways ("Ofelia", "Ofeliya").
const squash = text => fold(text).replace(/[^\p{L}\p{N}]+/gu, '');
const clean = text => text.replace(/[.«»"“”]/g, '').trim();

function cases(q, others, byPrefix) {
  const a = clean(q.answer);
  const out = [];
  const add = (category, given, correct, question = q) => given && fold(given) !== '' && out.push({ category, given, correct, question });
  const longest = Math.max(...a.split(' ').map(w => w.length));
  add('+ exact', a, true);
  add('+ lowercase, no diacritics', fold(a), true);
  if (longest >= 5) add('+ 1 typo', typo(a, 1), true);
  if (longest >= 9) add('+ 2 typos', typo(a, 2), true);
  if (/[əşçığöü]/i.test(a)) add('+ ə→a, ş→sh', translit(a), true);
  const ps = parts(a);
  if (ps.length === 2 && ps.every(p => p.length >= 3)) {
    add('+ list joined with və', ps.join(' və '), true);
    add('+ list reversed', `${ps[1]}, ${ps[0]}`, true);
    add('- half of a list', ps[0], false);
  }
  const alts = answerCandidates(q).map(clean).filter(c => fold(c) !== fold(a) && c.length <= 40);
  if (alts.length) add('+ accepted alternative (AI only)', pick(alts), true, { ...q, accepted_answers: null });
  add('- other answer', clean(pick(others).answer), false);
  const near = (byPrefix.get(fold(a).slice(0, 3)) ?? []).filter(o => Math.abs(o.length - a.length) <= 3 && editDistance(squash(o), squash(a)) >= 3);
  if (near.length) add('- similar-looking answer', pick(near), false);
  return out;
}

async function main() {
  const store = new Store(DB);
  const pool = store.rows.filter(r => r.answer && clean(r.answer).length >= 3 && clean(r.answer).length <= 40);
  const byPrefix = new Map();
  for (const r of pool) {
    const key = fold(clean(r.answer)).slice(0, 3);
    if (!byPrefix.has(key)) byPrefix.set(key, []);
    byPrefix.get(key).push(clean(r.answer));
  }
  const questions = Array.from({ length: N }, () => pick(pool)).map(r => store.get(r.uid));
  const all = questions.flatMap(q => cases(q, pool, byPrefix));

  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
  const embedTexts = async texts => {
    const todo = [...new Set(texts.filter(t => !cache[t]))];
    if (todo.length) (await ai.embed(todo, 'query')).forEach((v, i) => (cache[todo[i]] = Array.from(v, x => +x.toFixed(5))));
    return texts.map(t => cache[t]);
  };
  const t0 = Date.now();
  for (const c of all) c.result = await judgeAnswer(c.question, c.given, embedTexts);
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  console.log(`${all.length} answers to ${N} questions judged in ${Math.round((Date.now() - t0) / 1000)} s\n`);

  const verdict = (c, correctAt, unsureAt) => c.result.method !== 'ai' ? c.result.verdict
    : c.result.similarity >= correctAt ? 'correct' : c.result.similarity >= unsureAt ? 'unsure' : 'wrong';
  const pct = (n, d) => `${Math.round((100 * n) / d)}%`.padStart(5);
  console.log('category                              n   correct unsure  wrong');
  for (const category of [...new Set(all.map(c => c.category))].sort()) {
    const cs = all.filter(c => c.category === category);
    const count = v => cs.filter(c => c.result.verdict === v).length;
    console.log(`${category.padEnd(34)} ${String(cs.length).padStart(4)}  ${pct(count('correct'), cs.length)}  ${pct(count('unsure'), cs.length)}  ${pct(count('wrong'), cs.length)}`);
  }

  // Mistakes cost 1 (a right answer called wrong, or a wrong one called right); an unsure costs the host a look.
  console.log('\nthresholds (correctAt / unsureAt)   mistakes  unsure   (current marked *)');
  const grid = [];
  for (let correctAt = 0.7; correctAt <= 0.96; correctAt += 0.02) {
    for (let unsureAt = 0.4; unsureAt < correctAt; unsureAt += 0.04) {
      let mistakes = 0, unsure = 0;
      for (const c of all) {
        const v = verdict(c, correctAt, unsureAt);
        if (v === 'unsure') unsure++;
        else if ((v === 'correct') !== c.correct) mistakes++;
      }
      grid.push({ correctAt, unsureAt, mistakes, unsure, score: mistakes + unsure / 4 });
    }
  }
  const current = grid.reduce((best, g) => (Math.abs(g.correctAt - JUDGE_THRESHOLDS.correctAt) + Math.abs(g.unsureAt - JUDGE_THRESHOLDS.unsureAt)
    < Math.abs(best.correctAt - JUDGE_THRESHOLDS.correctAt) + Math.abs(best.unsureAt - JUDGE_THRESHOLDS.unsureAt) ? g : best));
  for (const g of [current, ...grid.sort((x, y) => x.score - y.score).slice(0, 8)]) {
    console.log(`${g === current ? '*' : ' '} ${g.correctAt.toFixed(2)} / ${g.unsureAt.toFixed(2)}                     ${String(g.mistakes).padStart(5)}   ${String(g.unsure).padStart(5)}`);
  }

  console.log('\nmistakes with current thresholds:');
  for (const c of all.filter(c => c.result.verdict !== 'unsure' && (c.result.verdict === 'correct') !== c.correct).slice(0, 40)) {
    const sim = c.result.similarity == null ? '' : ` ${c.result.similarity.toFixed(2)}`;
    console.log(`  ${c.category.padEnd(34)} "${c.given}" vs "${c.question.answer}" → ${c.result.verdict} (${c.result.method}${sim})`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
