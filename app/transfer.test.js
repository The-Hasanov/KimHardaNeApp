'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { Store } = require('./store');
const { tempDb } = require('./testDb');
const { exportArchive, readArchive, importOwnQuestions, importList, MANIFEST } = require('./transfer');
const { createZip, readZip } = require('./zip');

const newStore = () => {
  const store = new Store(tempDb());
  store.buildIndex();
  return store;
};
const ownQuestions = store => store.rows.filter(row => row.package_id === 0).map(row => store.get(row.uid));
const tempFile = (name, content) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-media-')), name);
  fs.writeFileSync(file, content);
  return file;
};

function withMedia(store) {
  const question = store.createQuestion({ text: 'Bu hansı şəhərdir?', answer: 'Şəki', comment: 'Xan sarayı', sources: 'https://a.az\nhttps://b.az' });
  store.setOwnImage(question.uid, 'rekvizit_url', tempFile('handout.png', 'png bytes'));
  store.setOwnImage(question.uid, 'source_media_url', tempFile('answer.mp4', 'mp4 bytes'));
  return store.get(question.uid);
}

test('zip archives keep names and bytes, stored or compressed, and catch damage', () => {
  const text = Buffer.from('salam '.repeat(500));
  const zip = createZip([{ name: 'a/ə.txt', data: text }, { name: 'b.bin', data: Buffer.from([1, 2, 3]), compress: false }]);
  const files = readZip(zip);
  assert.deepEqual([...files.keys()], ['a/ə.txt', 'b.bin']);
  assert.ok(files.get('a/ə.txt').equals(text));
  assert.ok(zip.length < text.length);
  const damaged = Buffer.from(zip);
  damaged[40] ^= 0xff;
  assert.throws(() => readZip(damaged), /damaged|incorrect|invalid/i);
});

test('your own questions export as a zip with their media files and import on another computer once', () => {
  const source = newStore();
  const question = withMedia(source);
  assert.deepEqual([question.rekvizit_kind, question.source_media_kind], ['image', 'video']);
  source.createQuestion({ text: 'İkinci sual', answer: 'Cavab' });
  const { archive, count, mediaCount } = exportArchive(ownQuestions(source));
  assert.deepEqual([count, mediaCount], [2, 2]);
  const files = readZip(archive);
  const manifest = JSON.parse(files.get(MANIFEST));
  assert.equal(manifest.version, 2);
  assert.deepEqual(manifest.questions[0].answerMedia.type, 'video/mp4');
  assert.equal(files.get(manifest.questions[0].answerMedia.file).toString(), 'mp4 bytes');

  const target = newStore();
  target.createQuestion({ text: 'ikinci   SUAL', answer: 'cavab' });
  const first = importOwnQuestions(target, readArchive(archive));
  assert.deepEqual(first.summary, { fromDataset: 0, alreadyYours: 1, added: 1, invalid: 0 });
  const imported = target.get(first.createdUids[0]);
  assert.deepEqual([imported.text, imported.comment, imported.sources], ['Bu hansı şəhərdir?', 'Xan sarayı', ['https://a.az', 'https://b.az']]);
  assert.equal(fs.readFileSync(fileURLToPath(imported.rekvizit_src), 'utf8'), 'png bytes');
  assert.deepEqual([imported.source_media_kind, fs.readFileSync(fileURLToPath(imported.source_media_src), 'utf8')], ['video', 'mp4 bytes']);
  assert.deepEqual(importOwnQuestions(target, readArchive(archive)).summary, { fromDataset: 0, alreadyYours: 2, added: 0, invalid: 0 });
});

test('a list exports dataset and own questions, and imports as a new list that adds the missing ones', () => {
  const source = newStore();
  const own = withMedia(source);
  const listId = source.createList('Friday');
  source.addToList(listId, '1:question:2');
  source.addToList(listId, own.uid);
  source.addToList(listId, '1:question:1');
  const { archive } = exportArchive(source.listQuestions(listId), { list: { name: 'Friday' } });
  const manifest = JSON.parse(readZip(archive).get(MANIFEST));
  assert.deepEqual(manifest.questions.map(q => [q.origin, q.uid ?? null]), [['dataset', '1:question:2'], ['own', null], ['dataset', '1:question:1']]);

  const target = newStore();
  target.createList('Friday');
  const result = importList(target, readArchive(archive));
  assert.deepEqual(result.summary, { fromDataset: 2, alreadyYours: 0, added: 1, invalid: 0, total: 3 });
  assert.equal(target.allLists().find(l => l.id === result.listId).name, 'Friday (2)');
  assert.deepEqual(target.listQuestions(result.listId).map(q => q.answer), ['Ağdam', 'Şəki', 'Bakı']);
  assert.equal(importList(target, readArchive(archive)).summary.added, 0, 'a second import reuses the question it added');
});

test('older .json exports still import, and dataset questions missing here become your own', () => {
  const legacy = {
    format: 'kimhardaneapp-questions', version: 1, list: { name: 'Old' },
    questions: [
      { origin: 'dataset', uid: '999:question:1', text: 'Sual bazada yoxdur', answer: 'Yeni', sources: [], handoutPicture: { url: 'https://img.az/x.png' } },
      { origin: 'own', text: 'Şəkilli sual', answer: 'Bəli', answerPicture: { type: 'image/png', data: Buffer.from('old png').toString('base64') } },
      { origin: 'own', text: '', answer: 'boş' },
    ],
  };
  const target = newStore();
  const result = importList(target, readArchive(Buffer.from(JSON.stringify(legacy))));
  assert.deepEqual(result.summary, { fromDataset: 0, alreadyYours: 0, added: 2, invalid: 1, total: 2 });
  const [missing, withPicture] = target.listQuestions(result.listId);
  assert.deepEqual([missing.package_id, missing.text, missing.rekvizit_src], [0, 'Sual bazada yoxdur', 'https://img.az/x.png']);
  assert.equal(fs.readFileSync(fileURLToPath(withPicture.source_media_src), 'utf8'), 'old png');
});

test('only KimHardaNeApp files of this version or older are read', () => {
  assert.throws(() => readArchive(Buffer.from('{"questions":[]}')), /not a KimHardaNeApp/);
  assert.throws(() => readArchive(Buffer.from('not json')), /not a KimHardaNeApp/);
  assert.throws(() => readArchive(createZip([{ name: 'other.txt', data: Buffer.from('x') }])), /not a KimHardaNeApp/);
  assert.throws(() => readArchive(Buffer.from(JSON.stringify({ format: 'kimhardaneapp-questions', version: 99, questions: [] }))), /newer/);
});

test('own questions take pictures, videos and audio files, and say which kind each is', () => {
  const store = newStore();
  const { uid } = store.createQuestion({ text: 'Bu hansı mahnıdır?', answer: 'Sarı gəlin' });
  assert.equal(store.setOwnImage(uid, 'rekvizit_url', tempFile('song.mp3', 'mp3')).rekvizit_kind, 'audio');
  assert.equal(store.setOwnImage(uid, 'rekvizit_url', tempFile('clip.webm', 'webm')).rekvizit_kind, 'video');
  assert.throws(() => store.setOwnImage(uid, 'rekvizit_url', tempFile('clip.avi', 'avi')), /video \(MP4, WebM\)/);
});
