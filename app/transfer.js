'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { OWN_PACKAGE_ID, IMAGE_TYPES, fold } = require('./store');

const FORMAT = 'kimhardaneapp-questions';
const VERSION = 1;
const TEXT_FIELDS = ['text', 'answer', 'accepted_answers', 'comment', 'note_before', 'rekvizit_text'];
const PICTURES = [['rekvizit_url', 'rekvizit_src', 'handoutPicture'], ['source_media_url', 'source_media_src', 'answerPicture']];
const EXTENSION_OF_TYPE = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([extension, type]) => [type, extension]));

const sameText = text => fold(String(text ?? '')).replace(/\s+/g, ' ').trim();
const questionKey = question => `${sameText(question.text)}\n${sameText(question.answer)}`;

function exportedPicture(src) {
  if (!src) return null;
  if (!src.startsWith('file:')) return { url: src };
  const file = fileURLToPath(src);
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!type || !fs.existsSync(file)) return null;
  return { type, data: fs.readFileSync(file).toString('base64') };
}

function exportedQuestion(question) {
  const isOwn = question.package_id === OWN_PACKAGE_ID;
  const exported = {
    ...(!isOwn && { uid: question.uid, packageName: question.package_name, tournamentName: question.tournament_name }),
    origin: isOwn ? 'own' : 'dataset',
    ...Object.fromEntries(TEXT_FIELDS.map(field => [field, question[field] ?? null])),
    sources: question.sources ?? [],
  };
  for (const [, src, name] of PICTURES) {
    const picture = exportedPicture(question[src]);
    if (picture) exported[name] = picture;
  }
  return exported;
}

function exportFile(questions, { list = null } = {}) {
  return {
    format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(),
    ...(list && { list: { name: list.name } }),
    questions: questions.map(exportedQuestion),
  };
}

function readFile(data) {
  if (data?.format !== FORMAT || !Array.isArray(data.questions)) throw new Error('This is not a KimHardaNeApp questions file');
  if (data.version > VERSION) throw new Error('This file comes from a newer KimHardaNeApp. Update the app to import it.');
  return data;
}

function ownQuestionsByKey(store) {
  return new Map(store.rows.filter(row => row.package_id === OWN_PACKAGE_ID).map(row => [questionKey(row), row.uid]));
}

function addPictures(store, uid, question) {
  for (const [column, , name] of PICTURES) {
    const picture = question[name];
    const extension = EXTENSION_OF_TYPE[picture?.type];
    try {
      if (picture?.data && extension) store.setOwnImageBytes(uid, column, { bytes: Buffer.from(picture.data, 'base64'), extension });
      else if (picture?.url) store.setOwnImageBytes(uid, column, { remoteUrl: picture.url });
    } catch {}
  }
}

function createOwnQuestion(store, question) {
  const fields = Object.fromEntries(TEXT_FIELDS.map(field => [field, question[field] ?? null]));
  fields.sources = (Array.isArray(question.sources) ? question.sources : []).join('\n');
  const { uid } = store.createQuestion(fields);
  addPictures(store, uid, question);
  return uid;
}

function isImportable(question) {
  return sameText(question?.text) && sameText(question?.answer);
}

function resolveQuestions(store, questions, { useDataset }) {
  const ownByKey = ownQuestionsByKey(store);
  const summary = { fromDataset: 0, alreadyYours: 0, added: 0, invalid: 0 };
  const uids = [];
  const createdUids = [];
  for (const question of questions) {
    if (!isImportable(question)) {
      summary.invalid += 1;
      continue;
    }
    const datasetQuestion = question.origin === 'dataset' && question.uid ? store.get(question.uid) : null;
    if (datasetQuestion && datasetQuestion.package_id !== OWN_PACKAGE_ID) {
      summary.fromDataset += 1;
      if (useDataset) uids.push(datasetQuestion.uid);
      continue;
    }
    const existing = ownByKey.get(questionKey(question));
    if (existing) {
      summary.alreadyYours += 1;
      uids.push(existing);
      continue;
    }
    const uid = createOwnQuestion(store, question);
    ownByKey.set(questionKey(question), uid);
    summary.added += 1;
    uids.push(uid);
    createdUids.push(uid);
  }
  return { uids, createdUids, summary };
}

function importOwnQuestions(store, data) {
  const { createdUids, summary } = resolveQuestions(store, readFile(data).questions, { useDataset: false });
  return { createdUids, summary };
}

function freeListName(store, name) {
  const taken = new Set(store.allLists().map(list => list.name.toLowerCase()));
  const base = String(name ?? '').trim() || 'Imported list';
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} (${n})`.toLowerCase())) return `${base} (${n})`;
}

function importList(store, data, { fileName = null } = {}) {
  const file = readFile(data);
  const { uids, createdUids, summary } = resolveQuestions(store, file.questions, { useDataset: true });
  const listId = store.createList(freeListName(store, file.list?.name ?? fileName));
  for (const uid of [...new Set(uids)]) store.addToList(listId, uid);
  return { listId, createdUids, summary: { ...summary, total: new Set(uids).size } };
}

module.exports = { FORMAT, exportFile, importOwnQuestions, importList, readFile };
