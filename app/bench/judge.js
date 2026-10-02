'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ai = require('../ai');
const { Store, fold } = require('../store');
const { JUDGE_THRESHOLDS, answerCandidates, editDistance, judgeAnswer } = require('../judge');
const { environment, fileSha1 } = require('./environment');

const DB = process.env.QUIZ_DB || path.join(__dirname, '..', '..', 'data', 'kimhardane.sqlite');
const N = +process.argv[2] || 300;

let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = list => list[Math.floor(rand() * list.length)];

const LETTERS = 'abcdefgəhxıijkqlmnoöprsştuüvyz';
const isPlainWord = word => /^\p{Ll}/u.test(word) || (/^\p{L}+$/u.test(word) && !/^[MDCLXVI]+$/.test(word));
function typo(text, edits) {
  const words = text.split(' ');
  const typable = words.map((w, k) => k).filter(k => isPlainWord(words[k]) && !/\d/.test(words[k]));
  if (!typable.length) return null;
  const i = typable.reduce((best, k) => (words[k].length > words[best].length ? k : best));
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
const squash = text => fold(text).replace(/[^\p{L}\p{N}]+/gu, '');
const clean = text => text.replace(/[.«»"“”]/g, '').trim();
const isExactOnly = question => /yalniz deqiq/.test(fold(question.accepted_answers ?? ''));

function cases(q, others, byPrefix) {
  const a = clean(q.answer);
  const out = [];
  const add = (category, given, correct, question = q) => given && fold(given) !== '' && out.push({ category, given, correct, question });
  const longest = Math.max(...a.split(' ').filter(w => !/\d/.test(w)).map(w => w.length), 0);
  const typoCategory = edits => (isExactOnly(q) ? `- ${edits} on an exact-only question` : `+ ${edits}`);
  add('+ exact', a, true);
  add('+ lowercase, no diacritics', fold(a), true);
  if (longest >= 5) add(typoCategory('1 typo'), typo(a, 1), !isExactOnly(q));
  if (longest >= 9) add(typoCategory('2 typos'), typo(a, 2), !isExactOnly(q));
  if (/[əşçığöü]/i.test(a)) add('+ ə→a, ş→sh', translit(a), true);
  const ps = parts(a);
  if (ps.length === 2 && ps.every(p => p.length >= 3)) {
    add('+ list joined with və', ps.join(' və '), true);
    add('+ list reversed', `${ps[1]}, ${ps[0]}`, true);
    add('- half of a list', ps[0], false);
  }
  const alts = answerCandidates(q).map(clean).filter(c => fold(c) !== fold(a) && c.length <= 40);
  if (alts.length && !isExactOnly(q)) add('+ accepted alternative (AI only)', pick(alts), true, { ...q, accepted_answers: null });
  add('- other answer', clean(pick(others).answer), false);
  const near = (byPrefix.get(fold(a).slice(0, 3)) ?? []).filter(o => Math.abs(o.length - a.length) <= 3 && editDistance(squash(o), squash(a)) >= 3);
  if (near.length) add('- similar-looking answer', pick(near), false);
  return out;
}

const MAX_FALSE_ACCEPT = 0.02;
const HAND = JSON.parse(fs.readFileSync(path.join(__dirname, 'answers.json'), 'utf8')).cases;
const slug = model => model.replace(/[^\w.-]+/g, '_');
const splitOf = answer => (crypto.createHash('sha1').update(squash(answer)).digest()[0] % 2 ? 'test' : 'dev');

function buildCases(store) {
  const pool = store.rows.filter(r => r.answer && clean(r.answer).length >= 3 && clean(r.answer).length <= 40);
  const byPrefix = new Map();
  for (const r of pool) {
    const key = fold(clean(r.answer)).slice(0, 3);
    if (!byPrefix.has(key)) byPrefix.set(key, []);
    byPrefix.get(key).push(clean(r.answer));
  }
  const questions = new Map();
  for (let tries = 0; questions.size < N && tries < N * 20; tries++) {
    const r = pick(pool);
    if (!questions.has(squash(r.answer))) questions.set(squash(r.answer), store.get(r.uid));
  }
  const synthetic = [...questions.values()].flatMap(q => cases(q, pool, byPrefix).map(c => ({ ...c, source: 'synthetic' })));
  const hand = HAND.map(h => ({ category: h.category, given: h.given, correct: h.correct, source: 'hand-labeled', question: { answer: h.answer, accepted_answers: null } }));
  const seen = new Set();
  const unique = [...hand, ...synthetic].filter(c => {
    const key = `${squash(c.given)}|${squash(c.question.answer)}|${c.question.accepted_answers ?? ''}`;
    return !seen.has(key) && seen.add(key);
  });
  return { cases: unique.map(c => ({ ...c, split: splitOf(c.question.answer), results: {} })), duplicates: hand.length + synthetic.length - unique.length };
}

function readVectorCache(file, space) {
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cached.space !== space.id) return {};
    return Object.fromEntries(Object.entries(cached.vectors).filter(([, v]) => v.length === space.dim && v.every(Number.isFinite)));
  } catch {
    return {};
  }
}

async function judgeAll(all, model) {
  const space = ai.embeddingSpace(model);
  const file = path.join(__dirname, 'cache', `judge-${slug(model)}.json`);
  const vectors = readVectorCache(file, space);
  const embedTexts = async texts => {
    const todo = [...new Set(texts.filter(t => !vectors[t]))];
    if (todo.length) (await ai.embed(todo, 'query', model)).forEach((v, i) => (vectors[todo[i]] = Array.from(v, x => +x.toFixed(5))));
    return texts.map(t => vectors[t]);
  };
  for (const c of all) {
    const production = await judgeAnswer(c.question, c.given, embedTexts);
    c.results[model] = { production, rejudge: production.method === 'ai' ? thresholds => judgeAnswer(c.question, c.given, embedTexts, thresholds) : null };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ space: space.id, vectors }));
}

const verdictsAt = (cs, model, thresholds) => Promise.all(cs.map(async c => {
  const { production, rejudge } = c.results[model];
  return thresholds && rejudge ? (await rejudge(thresholds)).verdict : production.verdict;
}));

async function rates(cs, model, thresholds) {
  const verdicts = await verdictsAt(cs, model, thresholds);
  const pairs = cs.map((c, i) => [c, verdicts[i]]);
  const right = pairs.filter(([c]) => c.correct), wrong = pairs.filter(([c]) => !c.correct);
  return {
    n: cs.length, right: right.length, wrong: wrong.length,
    falseAccept: wrong.filter(([, v]) => v === 'correct').length / wrong.length,
    falseReject: right.filter(([, v]) => v === 'wrong').length / right.length,
    unsure: verdicts.filter(v => v === 'unsure').length / verdicts.length,
  };
}

async function calibrate(cs, model) {
  let best = null;
  for (let correctAt = 0.6; correctAt <= 0.995; correctAt += 0.01) {
    for (let unsureAt = 0.4; unsureAt <= correctAt + 1e-9; unsureAt += 0.02) {
      const thresholds = { correctAt: +correctAt.toFixed(2), unsureAt: +unsureAt.toFixed(2) };
      const r = await rates(cs, model, thresholds);
      const cost = r.falseReject + r.unsure / 4;
      if (r.falseAccept <= MAX_FALSE_ACCEPT && (!best || cost < best.cost - 1e-9)) best = { thresholds, cost };
    }
  }
  return best.thresholds;
}

async function main() {
  const models = process.argv[3] ? process.argv.slice(3) : Object.keys(ai.MODELS);
  const lines = [...await environment(models), ''];
  const { cases: all, duplicates } = buildCases(new Store(DB));
  const dev = all.filter(c => c.split === 'dev'), test = all.filter(c => c.split === 'test');
  const devAnswers = new Set(dev.map(c => squash(c.question.answer)));
  const shared = new Set(test.map(c => squash(c.question.answer)).filter(answer => devAnswers.has(answer)));
  const pct = x => `${(100 * x).toFixed(1)}%`.padStart(6);
  const count = (cs, source) => cs.filter(c => c.source === source).length;
  lines.push(`judge: judge.js sha1 ${fileSha1(path.join(__dirname, '..', 'judge.js'))}; production thresholds correct at ${JUDGE_THRESHOLDS.correctAt}, unsure at ${JUDGE_THRESHOLDS.unsureAt}`,
    `cases: ${all.length} after dropping ${duplicates} duplicates; dev/test split by answer identity (${shared.size} answers in both splits)`,
    `  hand-labeled: ${count(dev, 'hand-labeled')} dev / ${count(test, 'hand-labeled')} test; synthetic from ${N} questions: ${count(dev, 'synthetic')} dev / ${count(test, 'synthetic')} test`, '');
  const calibrated = {};
  for (const model of models) {
    await judgeAll(all, model);
    calibrated[model] = await calibrate(dev, model);
    console.log(`${model}: judged`);
  }
  const header = `${'model'.padEnd(38)} ${'set'.padEnd(13)}    n  false accept     false reject     unsure`;
  const table = async thresholdsOf => {
    for (const model of models) {
      for (const source of ['hand-labeled', 'synthetic']) {
        const r = await rates(test.filter(c => c.source === source), model, thresholdsOf(model));
        lines.push(`${model.padEnd(38)} ${source.padEnd(13)} ${String(r.n).padStart(4)}  ${pct(r.falseAccept)} of ${String(r.wrong).padStart(3)}  ${pct(r.falseReject)} of ${String(r.right).padStart(3)}  ${pct(r.unsure)}`);
      }
    }
  };
  lines.push(`## Production thresholds (${JUDGE_THRESHOLDS.correctAt} / ${JUDGE_THRESHOLDS.unsureAt}), test split`, header);
  await table(() => null);
  lines.push('', `## Thresholds calibrated on the dev split (false acceptance at most ${100 * MAX_FALSE_ACCEPT}% on dev), test split`,
    ...models.map(m => `${m}: ${calibrated[m].correctAt} / ${calibrated[m].unsureAt}`), header);
  await table(model => calibrated[model]);
  lines.push('', 'per category, test split, production thresholds: accepted / unsure / rejected %');
  lines.push(`${'category'.padEnd(40)}   n  ${models.map(m => m.split('/')[1].slice(0, 21).padEnd(22)).join('')}`);
  for (const category of [...new Set(all.map(c => c.category))].sort()) {
    const cs = test.filter(c => c.category === category);
    const cells = await Promise.all(models.map(async m => {
      const v = await verdictsAt(cs, m, null);
      const share = x => String(Math.round((100 * v.filter(y => y === x).length) / v.length)).padStart(3);
      return `${share('correct')} /${share('unsure')} /${share('wrong')}`.padEnd(22);
    }));
    lines.push(`${category.padEnd(40)} ${String(cs.length).padStart(3)}  ${cells.join('')}`);
  }
  for (const model of models) {
    const hand = test.filter(c => c.source === 'hand-labeled');
    const verdicts = await verdictsAt(hand, model, null);
    const mistakes = hand.map((c, i) => [c, verdicts[i]]).filter(([c, v]) => v !== 'unsure' && (v === 'correct') !== c.correct);
    lines.push('', `${model} hand-labeled test mistakes at production thresholds:`,
      ...mistakes.map(([c, v]) => `  ${c.category.padEnd(32)} "${c.given}" vs "${c.question.answer}" → ${v} (${c.results[model].production.method} ${c.results[model].production.similarity?.toFixed(2) ?? ''})`));
  }
  const text = lines.join('\n');
  console.log(text);
  fs.writeFileSync(path.join(__dirname, 'judge-results.txt'), `${text}\n`);
  await ai.stop();
}

main().catch(e => { console.error(e); process.exit(1); });
