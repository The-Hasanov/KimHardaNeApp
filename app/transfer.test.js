'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { Store } = require('./store');
const { tempDb } = require('./testDb');
const { exportFile, importOwnQuestions, importList, readFile } = require('./transfer');

const newStore = () => {
  const store = new Store(tempDb());
  store.buildIndex();
  return store;
};
const roundTrip = data => JSON.parse(JSON.stringify(data));
const ownQuestions = store => store.rows.filter(row => row.package_id === 0).map(row => store.get(row.uid));

function withPicture(store) {
  const question = store.createQuestion({ text: 'Bu hansı şəhərdir?', answer: 'Şəki', comment: 'Xan sarayı', sources: 'https://a.az\nhttps://b.az' });
  const picture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-picture-')), 'handout.png');
  fs.writeFileSync(picture, 'png bytes');
  store.setOwnImage(question.uid, 'rekvizit_url', picture);
  return store.get(question.uid);
}

test('your own questions export with their pictures and import on another computer once', () => {
  const source = newStore();
  withPicture(source);
  source.createQuestion({ text: 'İkinci sual', answer: 'Cavab' });
  const file = roundTrip(exportFile(ownQuestions(source)));
  assert.equal(file.questions.length, 2);
  assert.equal(file.questions[0].handoutPicture.type, 'image/png');
  assert.equal(file.questions[0].uid, undefined);

  const target = newStore();
  target.createQuestion({ text: 'ikinci   SUAL', answer: 'cavab' });
  const first = importOwnQuestions(target, file);
  assert.deepEqual(first.summary, { fromDataset: 0, alreadyYours: 1, added: 1, invalid: 0 });
  const imported = target.get(first.createdUids[0]);
  assert.deepEqual([imported.text, imported.comment, imported.sources], ['Bu hansı şəhərdir?', 'Xan sarayı', ['https://a.az', 'https://b.az']]);
  assert.equal(fs.readFileSync(fileURLToPath(imported.rekvizit_src), 'utf8'), 'png bytes');
  assert.deepEqual(importOwnQuestions(target, file).summary, { fromDataset: 0, alreadyYours: 2, added: 0, invalid: 0 });
});

test('a list exports dataset and own questions, and imports as a new list that adds the missing ones', () => {
  const source = newStore();
  const own = withPicture(source);
  const listId = source.createList('Friday');
  source.addToList(listId, '1:question:2');
  source.addToList(listId, own.uid);
  source.addToList(listId, '1:question:1');
  const file = roundTrip(exportFile(source.listQuestions(listId), { list: { name: 'Friday' } }));
  assert.deepEqual(file.questions.map(q => [q.origin, q.uid ?? null]), [['dataset', '1:question:2'], ['own', null], ['dataset', '1:question:1']]);

  const target = newStore();
  target.createList('Friday');
  const result = importList(target, file);
  assert.deepEqual(result.summary, { fromDataset: 2, alreadyYours: 0, added: 1, invalid: 0, total: 3 });
  const list = target.allLists().find(l => l.id === result.listId);
  assert.equal(list.name, 'Friday (2)');
  assert.deepEqual(target.listQuestions(result.listId).map(q => q.answer), ['Ağdam', 'Şəki', 'Bakı']);
  assert.equal(importList(target, file).summary.added, 0, 'a second import reuses the question it added');
});

test('dataset questions missing on this computer become your own questions', () => {
  const file = {
    format: 'kimhardaneapp-questions', version: 1, list: { name: 'Old' },
    questions: [
      { origin: 'dataset', uid: '999:question:1', text: 'Sual bazada yoxdur', answer: 'Yeni', sources: [], handoutPicture: { url: 'https://img.az/x.png' } },
      { origin: 'own', text: '', answer: 'boş' },
    ],
  };
  const target = newStore();
  const result = importList(target, file);
  assert.deepEqual(result.summary, { fromDataset: 0, alreadyYours: 0, added: 1, invalid: 1, total: 1 });
  const [question] = target.listQuestions(result.listId);
  assert.deepEqual([question.package_id, question.text, question.rekvizit_src], [0, 'Sual bazada yoxdur', 'https://img.az/x.png']);
});

test('only KimHardaNeApp files of this version or older are read', () => {
  assert.throws(() => readFile({ questions: [] }), /not a KimHardaNeApp/);
  assert.throws(() => readFile({ format: 'kimhardaneapp-questions', version: 99, questions: [] }), /newer/);
});
