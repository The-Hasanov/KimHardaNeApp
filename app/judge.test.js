'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { answerCandidates, matchesAsText, judgeAnswer } = require('./judge');

const fakeEmbeddings = similarityByText => async texts => texts.map((text, i) => {
  if (i === 0) return [1, 0];
  const similarity = similarityByText[text] ?? 0;
  return [similarity, Math.sqrt(1 - similarity ** 2)];
});

test('answer candidates keep alternatives and drop crediting rules', () => {
  assert.deepEqual(answerCandidates({ answer: 'Motsart', accepted_answers: 'Mozart' }), ['Motsart', 'Mozart']);
  assert.deepEqual(answerCandidates({ answer: 'Naf-Naf', accepted_answers: 'Nif-Nif ; Nuf-Nuf' }), ['Naf-Naf', 'Nif-Nif ; Nuf-Nuf', 'Nif-Nif', 'Nuf-Nuf']);
  assert.deepEqual(answerCandidates({ answer: 'Senator', accepted_answers: 'Yalnız dəqiq cavablar' }), ['Senator']);
  assert.deepEqual(answerCandidates({ answer: 'gəmi kamuflyajı', accepted_answers: 'mənaca oxşar cavablar' }), ['gəmi kamuflyajı']);
});

test('text matching ignores case, diacritics, punctuation and small typos', () => {
  assert.ok(matchesAsText('baki', 'Bakı'));
  assert.ok(matchesAsText('dinq', 'D,i,n,q'));
  assert.ok(matchesAsText('Nizami Gencevi', 'Nizami Gəncəvi'));
  assert.ok(matchesAsText('Prometeyy', 'Prometey'));
  assert.ok(!matchesAsText('Qod', 'Vol'));
  assert.ok(!matchesAsText('Gəncə', 'Bakı'));
  assert.ok(!matchesAsText('birinci siçan', 'İkinci siçan'));
  assert.ok(matchesAsText('ikinçi sican', 'İkinci siçan'));
  assert.ok(matchesAsText('Adəm və Həvva', 'Adəm,Həvva'));
  assert.ok(!matchesAsText('Adəm və Həvva', 'Adəm'));
  assert.ok(matchesAsText('Gunash va ay', 'Günəş və ay'));
  assert.ok(matchesAsText('Bsoton', 'Boston'));
  assert.ok(matchesAsText('Həvva, Adəm', 'Adəm və Həvva'));
  assert.ok(!matchesAsText('Həvva, Həvva', 'Adəm, Həvva'));
});

test('judging: text match, AI meaning match, unsure zone and exact-only questions', async () => {
  const question = { answer: 'İkinci siçan', accepted_answers: null };
  const embed = fakeEmbeddings({ 'İkinci siçan': 0.9 });
  assert.equal((await judgeAnswer(question, 'ikinci sican', embed)).method, 'text');
  const meaning = await judgeAnswer(question, 'second mouse', embed);
  assert.deepEqual([meaning.verdict, meaning.method, meaning.closestAnswer], ['correct', 'ai', 'İkinci siçan']);
  assert.equal((await judgeAnswer(question, 'the mouse', fakeEmbeddings({ 'İkinci siçan': 0.7 }))).verdict, 'unsure');
  assert.equal((await judgeAnswer(question, 'birinci pişik', fakeEmbeddings({ 'İkinci siçan': 0.4 }))).verdict, 'wrong');
  assert.equal((await judgeAnswer(question, '  ', embed)).verdict, 'wrong');
  const exactOnly = { answer: 'Senator', accepted_answers: 'Yalnız dəqiq cavablar' };
  assert.equal((await judgeAnswer(exactOnly, 'Parlament üzvü', fakeEmbeddings({ Senator: 0.9 }))).verdict, 'wrong');
});

test('without AI search the host decides every answer that was given', async () => {
  const question = { answer: 'Bakı', accepted_answers: null };
  assert.deepEqual(await judgeAnswer(question, 'Bakı', null), { verdict: 'unsure', similarity: null, closestAnswer: null, method: 'host' });
  assert.equal((await judgeAnswer(question, '  ', null)).verdict, 'wrong');
});
