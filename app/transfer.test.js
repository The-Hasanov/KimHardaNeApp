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
  assert.ok(files.get('a/ə.txt').read().equals(text));
  assert.ok(zip.length < text.length);
  const damaged = Buffer.from(zip);
  damaged[40] ^= 0xff;
  assert.throws(() => [...readZip(damaged).values()].forEach(file => file.read()), /damaged/);
});

test('your own questions export as a zip with their media files and import on another computer once', () => {
  const source = newStore();
  const question = withMedia(source);
  assert.deepEqual([question.rekvizit_kind, question.source_media_kind], ['image', 'video']);
  source.createQuestion({ text: 'İkinci sual', answer: 'Cavab' });
  const { archive, count, mediaCount } = exportArchive(ownQuestions(source));
  assert.deepEqual([count, mediaCount], [2, 2]);
  const files = readZip(archive);
  const manifest = JSON.parse(files.get(MANIFEST).read());
  assert.equal(manifest.version, 2);
  assert.deepEqual(manifest.questions[0].answerMedia.type, 'video/mp4');
  assert.equal(files.get(manifest.questions[0].answerMedia.file).read().toString(), 'mp4 bytes');

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
  const manifest = JSON.parse(readZip(archive).get(MANIFEST).read());
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

const quzip = (manifest, media = []) => createZip([{ name: MANIFEST, data: Buffer.from(JSON.stringify({ format: 'kimhardaneapp-questions', version: 2, ...manifest })) }, ...media]);

test('hostile archives: zip bombs, lying sizes, huge entries and broken offsets are refused', () => {
  const zeros = Buffer.alloc(4 * 1024 * 1024);
  const bomb = createZip([{ name: 'media/bomb.png', data: zeros }]);
  assert.throws(() => readZip(bomb, { maxEntryBytes: 1024 * 1024 }), /too large/);
  assert.throws(() => readZip(bomb, { maxEntryBytes: 8 * 1024 * 1024, maxTotalBytes: 1024 * 1024 }), /too large/);
  const lying = Buffer.from(bomb);
  const centralAt = lying.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  lying.writeUInt32LE(100, centralAt + 24);
  assert.throws(() => readZip(lying).get('media/bomb.png').read(), /damaged/, 'inflating stops at the declared size');
  const broken = Buffer.from(bomb);
  broken.writeUInt32LE(0x7fffffff, centralAt + 42);
  assert.throws(() => readZip(broken), /damaged/);
  assert.throws(() => readArchive(Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(100)])), /damaged/);
});

test('hostile archives: file names cannot write outside the media folder, and only allowed media types are taken', () => {
  const store = newStore();
  const outside = path.join(path.dirname(store.roots[0]), 'evil.png');
  const archive = quzip({
    questions: [
      { origin: 'own', text: 'Birinci', answer: 'A', handoutMedia: { file: '../../evil.png', type: 'image/png' } },
      { origin: 'own', text: 'İkinci', answer: 'B', handoutMedia: { file: 'media/page.html', type: 'text/html' } },
      { origin: 'own', text: 'Üçüncü', answer: 'C', handoutMedia: { url: 'javascript:alert(1)' }, answerMedia: { url: 'file:///C:/Windows/win.ini' } },
    ],
  }, [{ name: '../../evil.png', data: Buffer.from('png bytes') }, { name: 'media/page.html', data: Buffer.from('<script>alert(1)</script>') }]);
  const { createdUids } = importOwnQuestions(store, readArchive(archive));
  const [first, second, third] = createdUids.map(uid => store.get(uid));
  assert.ok(!fs.existsSync(outside));
  assert.match(fileURLToPath(first.rekvizit_src), /images[\\/]own[\\/][0-9a-f]{64}\.png$/);
  assert.equal(fileURLToPath(first.rekvizit_src).startsWith(store.roots[0]), true);
  assert.deepEqual([second.rekvizit_src, third.rekvizit_src, third.source_media_src], [null, null, null]);
});

test('hostile archives: fields must be text, sizes are capped and lists get sane names', () => {
  const store = newStore();
  const long = 'ə'.repeat(50000);
  const archive = quzip({
    list: { name: `  ${'L'.repeat(500)}  ` },
    questions: [
      { origin: 'own', text: { toString: 1 }, answer: 'A' },
      { origin: 'own', text: ['x'], answer: 'B' },
      null, 7, 'text',
      { origin: 'dataset', uid: { $ne: 1 }, text: 'Sual', answer: 'Cavab', comment: 42, sources: ['https://a.az', { x: 1 }, 'line\nbreak'], note_before: long },
      { origin: 'own', text: '<img src=x onerror=alert(1)>', answer: '<script>alert(1)</script>' },
    ],
  });
  const result = importList(store, readArchive(archive));
  assert.deepEqual(result.summary, { fromDataset: 0, alreadyYours: 0, added: 2, invalid: 2, total: 2 });
  assert.equal(store.allLists().find(list => list.id === result.listId).name, 'L'.repeat(80));
  const [plain, markup] = store.listQuestions(result.listId);
  assert.deepEqual([plain.comment, plain.sources, plain.note_before.length], [null, ['https://a.az', 'line break'], 20000]);
  assert.deepEqual([markup.text, markup.answer], ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>'], 'markup stays plain text; every screen shows it as text');
  const many = quzip({ questions: Array.from({ length: 5001 }, (_, i) => ({ origin: 'own', text: `S${i}`, answer: 'C' })) });
  assert.throws(() => readArchive(many), /at most 5000/);
});
