'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { answerCandidates, matchesAsText, matchesExactly, numbersIn, judgeAnswer } = require('./judge');

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
  const camouflage = { answer: 'Gəmi kamuflyajı', accepted_answers: null };
  const meaning = await judgeAnswer(camouflage, 'ship camouflage', fakeEmbeddings({ 'Gəmi kamuflyajı': 0.9 }));
  assert.deepEqual([meaning.verdict, meaning.method, meaning.closestAnswer], ['correct', 'ai', 'Gəmi kamuflyajı']);
  assert.equal((await judgeAnswer(question, 'second mouse', embed)).verdict, 'unsure');
  assert.equal((await judgeAnswer(question, 'the mouse', fakeEmbeddings({ 'İkinci siçan': 0.7 }))).verdict, 'unsure');
  assert.equal((await judgeAnswer(question, 'birinci pişik', fakeEmbeddings({ 'İkinci siçan': 0.4 }))).verdict, 'wrong');
  assert.equal((await judgeAnswer(question, '  ', embed)).verdict, 'wrong');
  const exactOnly = { answer: 'Senator', accepted_answers: 'Yalnız dəqiq cavablar' };
  assert.equal((await judgeAnswer(exactOnly, 'Parlament üzvü', fakeEmbeddings({ Senator: 0.9 }))).verdict, 'wrong');
});

test('a typed number that differs from the answer is wrong however close the meaning', async () => {
  const question = { answer: '1945-ci il', accepted_answers: null };
  const embed = fakeEmbeddings({ '1945-ci il': 0.99 });
  assert.equal((await judgeAnswer(question, '1944-cü il', embed)).verdict, 'wrong');
  assert.equal((await judgeAnswer({ answer: '12 aprel', accepted_answers: null }, '12 aprel 1961', fakeEmbeddings({ '12 aprel': 0.99 }))).verdict, 'correct');
  assert.equal((await judgeAnswer({ answer: 'VIII Henri', accepted_answers: null }, 'vii henri', fakeEmbeddings({ 'VIII Henri': 0.99 }))).verdict, 'wrong');
  assert.equal((await judgeAnswer({ answer: 'XIV Ludovik', accepted_answers: null }, 'Ludovik 14', fakeEmbeddings({ 'XIV Ludovik': 0.99 }))).verdict, 'correct');
  assert.equal((await judgeAnswer({ answer: '1918-ci il', accepted_answers: null }, '1918-ci ildə', fakeEmbeddings({ '1918-ci il': 0.99 }))).verdict, 'correct');
  assert.equal((await judgeAnswer({ answer: '9 ay hamiləlik', accepted_answers: null }, 'doqquz ay hamiləlik', fakeEmbeddings({ '9 ay hamiləlik': 0.99 }))).verdict, 'correct');
});

test('without AI search the host decides every answer that was given', async () => {
  const question = { answer: 'Bakı', accepted_answers: null };
  assert.deepEqual(await judgeAnswer(question, 'Bakı', null), { verdict: 'unsure', similarity: null, closestAnswer: null, method: 'host' });
  assert.equal((await judgeAnswer(question, '  ', null)).verdict, 'wrong');
});

test('a typo never changes a number, by text or by meaning', async () => {
  assert.ok(!matchesAsText('12346', '12345'));
  assert.ok(matchesAsText('12345', '12345'));
  assert.ok(!matchesAsText('Boeing 737', 'Boeing 747'));
  assert.ok(!matchesAsText('xvii lui', 'XVIII Lui'));
  assert.ok(matchesAsText('Apolon 11', 'Apollon 11'));
  assert.ok(!matchesAsText('Apolon 12', 'Apollon 11'));
  const number = { answer: '12345', accepted_answers: null };
  assert.equal((await judgeAnswer(number, '12346', fakeEmbeddings({ 12345: 0.99 }))).verdict, 'wrong');
  const date = { answer: '12 aprel 1961', accepted_answers: null };
  const sure = fakeEmbeddings({ '12 aprel 1961': 0.97 });
  assert.equal((await judgeAnswer(date, '12 may 1961', sure)).verdict, 'wrong');
  assert.equal((await judgeAnswer(date, '13 aprel 1961', sure)).verdict, 'wrong');
  assert.equal((await judgeAnswer(date, '12.04.1961', sure)).verdict, 'correct');
  assert.equal((await judgeAnswer(date, '1961-ci il aprelin 12-si', sure)).verdict, 'correct');
});

test('numbers are read from digits, Roman numerals and Azerbaijani number words, not from ordinary words', () => {
  const read = (text, options) => [...numbersIn(text, options)].sort();
  assert.deepEqual(read('min doqquz yüz qırx beş'), ['1945']);
  assert.deepEqual(read('səkkiz ay'), ['8']);
  assert.deepEqual(read('sakkiz ay', { typed: true }), ['8']);
  assert.deepEqual(read('İkinci dünya müharibəsi'), ['2']);
  assert.deepEqual(read('on doqquzuncu əsr'), ['19']);
  assert.deepEqual(read('XIX əsr'), ['19']);
  assert.deepEqual(read('xix esr', { typed: true }), ['19']);
  assert.deepEqual(read('I Pyotr'), ['1']);
  assert.deepEqual(read('Papa X İnnokent'), ['10']);
  assert.deepEqual(read('bir milyon'), ['1000000']);
  for (const ordinary of ['V for Vendetta', 'V. Lenin', 'D vitamini', 'Bir dəfə Amerikada', 'I like to move it', 'Madam Bovari', 'Civil', 'Mix']) {
    assert.deepEqual(read(ordinary), [], ordinary);
  }
  assert.deepEqual(read('1945-ci il', { typed: true }), ['1945']);
  assert.deepEqual(read('12.04.1961'), ['12', '1961', 'month 4']);
});

test('a written number counts as the same number, and an answer that drops a number goes to the host', async () => {
  const months = { answer: '9 ay', accepted_answers: 'doqquz ay' };
  assert.equal((await judgeAnswer({ answer: '9 ay hamiləlik', accepted_answers: null }, 'səkkiz ay hamiləlik', fakeEmbeddings({ '9 ay hamiləlik': 0.99 }))).verdict, 'wrong');
  assert.equal((await judgeAnswer({ answer: '9 ay hamiləlik', accepted_answers: null }, 'doqquz ay hamilelik', fakeEmbeddings({ '9 ay hamiləlik': 0.99 }))).verdict, 'correct');
  assert.equal((await judgeAnswer(months, 'doqquz ay', null)).verdict, 'unsure');
  assert.ok(matchesAsText('doqquz ay', '9 ay'));
  assert.ok(matchesAsText('ikinci dunya muharibesi', 'II Dünya müharibəsi'));
  assert.ok(!matchesAsText('sekkiz ay', '9 ay'));
  assert.ok(!matchesAsText('on ay', '9 ay'));
  const war = { answer: 'I Dünya müharibəsi', accepted_answers: null };
  assert.equal((await judgeAnswer(war, 'Dünya müharibəsi', fakeEmbeddings({ 'I Dünya müharibəsi': 0.97 }))).verdict, 'unsure');
  assert.equal((await judgeAnswer(war, 'birinci dunya muharibesi', fakeEmbeddings({ 'I Dünya müharibəsi': 0.97 }))).verdict, 'correct');
  assert.equal((await judgeAnswer(war, 'II Dünya müharibəsi', fakeEmbeddings({ 'I Dünya müharibəsi': 0.97 }))).verdict, 'wrong');
});

test('"Yalnız dəqiq cavablar" accepts only the exact answer or its listed alternatives, up to case, punctuation and keyboard', async () => {
  const exactOnly = { answer: 'Poseydonun', accepted_answers: 'Yalnız dəqiq cavablar' };
  const embed = fakeEmbeddings({ Poseydonun: 0.99 });
  for (const typed of ['Poseydonun', 'poseydonun!', 'POSEYDONUN']) assert.equal((await judgeAnswer(exactOnly, typed, embed)).verdict, 'correct', typed);
  for (const typed of ['Poseydonu', 'Poseydon', 'Poseydonunn']) assert.equal((await judgeAnswer(exactOnly, typed, embed)).verdict, 'wrong', typed);
  const keyboard = { answer: 'Şokoladda', accepted_answers: 'Yalnız dəqiq cavablar.' };
  assert.equal((await judgeAnswer(keyboard, 'shokoladda', embed)).verdict, 'correct');
  assert.equal((await judgeAnswer({ answer: 'Fəlsəfə daşı', accepted_answers: 'Yalnız dəqiq cavablar' }, 'Falsafa dashi', embed)).verdict, 'correct');
  const withAlias = { answer: 'Motsart', accepted_answers: 'Mozart; yalnız dəqiq cavablar' };
  assert.deepEqual(answerCandidates(withAlias), ['Motsart', 'Mozart']);
  assert.equal((await judgeAnswer(withAlias, 'mozart', embed)).verdict, 'correct');
  assert.equal((await judgeAnswer(withAlias, 'Mozartt', embed)).verdict, 'wrong');
  assert.ok(matchesExactly('Xaç atası 2', 'Xac atasi 2'));
  assert.ok(!matchesExactly('Xaç atası 3', 'Xaç atası 2'));
});

test('a list answer is accepted only when every part is given', async () => {
  const pair = { answer: 'Adəm və Həvva', accepted_answers: null };
  const close = fakeEmbeddings({ 'Adəm və Həvva': 0.95 });
  assert.equal((await judgeAnswer(pair, 'Həvva, Adəm', close)).verdict, 'correct');
  assert.equal((await judgeAnswer(pair, 'Adam and Eve', close)).verdict, 'correct');
  assert.equal((await judgeAnswer(pair, 'Adəm peyğəmbər', close)).verdict, 'unsure');
});
