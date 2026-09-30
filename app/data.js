'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { LISTS_SCHEMA, PLAY_SCHEMA, PARTY_RESULTS_SCHEMA, PARTY_PROFILES_SCHEMA, EMBEDDINGS_SCHEMA, OWN_IMAGE_PREFIX } = require('./store');

const columns = (db, schema, table) => db.prepare(`PRAGMA ${schema}.table_info(${table})`).all().map(c => c.name);
const shared = (db, table) => {
  const old = new Set(columns(db, 'old', table));
  return columns(db, 'main', table).filter(c => old.has(c)).join(', ');
};
const copy = (db, table, where, verb = 'INSERT OR REPLACE') => {
  const cols = shared(db, table);
  return cols ? db.prepare(`${verb} INTO main.${table} (${cols}) SELECT ${cols} FROM old.${table} WHERE ${where}`).run().changes : 0;
};

function keepNewer(db) {
  if (!columns(db, 'old', 'packages').includes('fetched_at') || !columns(db, 'main', 'packages').length) return 0;
  db.exec(`CREATE TEMP TABLE newer AS SELECT o.id FROM old.packages o LEFT JOIN main.packages m ON m.id = o.id
           WHERE o.status IN ('ok','empty','partial') AND (m.id IS NULL OR o.fetched_at > m.fetched_at)`);
  const n = db.prepare('SELECT COUNT(*) AS n FROM temp.newer').get().n;
  if (!n) return 0;
  const mine = 'package_id IN (SELECT id FROM temp.newer)';
  for (const t of ['questions', 'phases', 'themes']) db.exec(`DELETE FROM main.${t} WHERE ${mine}`);
  copy(db, 'packages', 'id IN (SELECT id FROM temp.newer)');
  for (const t of ['questions', 'phases', 'themes']) copy(db, t, mine);
  copy(db, 'tournaments', '1', 'INSERT OR IGNORE');
  copy(db, 'package_list', '1', 'INSERT OR IGNORE');
  copy(db, 'images', "status = 'ok' AND url NOT IN (SELECT url FROM main.images WHERE status = 'ok')");
  return n;
}

function carryEdits(fresh, old) {
  const db = new DatabaseSync(fresh);
  try {
    db.prepare('ATTACH DATABASE ? AS old').run(old);
    db.exec('BEGIN');
    const newer = keepNewer(db);
    if (columns(db, 'old', 'embeddings').length) {
      db.exec(EMBEDDINGS_SCHEMA);
      copy(db, 'embeddings', '1');
    }
    if (columns(db, 'old', 'lists').length) {
      db.exec(LISTS_SCHEMA);
      copy(db, 'lists', '1');
      copy(db, 'list_questions', '1');
    }
    if (columns(db, 'old', 'play_games').length) {
      db.exec(PLAY_SCHEMA);
      copy(db, 'play_games', '1');
      copy(db, 'play_answers', '1');
    }
    if (columns(db, 'old', 'party_results').length) {
      db.exec(PARTY_RESULTS_SCHEMA);
      copy(db, 'party_results', '1');
    }
    if (columns(db, 'old', 'party_profiles').length) {
      db.exec(PARTY_PROFILES_SCHEMA);
      copy(db, 'party_profiles', '1');
    }
    let carried = 0;
    if (columns(db, 'old', 'questions').includes('edited_at')) {
      if (!columns(db, 'main', 'questions').includes('edited_at')) db.exec('ALTER TABLE main.questions ADD COLUMN edited_at TEXT');
      carried = copy(db, 'questions', 'edited_at IS NOT NULL');
    }
    if (columns(db, 'old', 'images').length && columns(db, 'main', 'images').length) copy(db, 'images', `url LIKE '${OWN_IMAGE_PREFIX}%'`, 'INSERT OR IGNORE');
    db.exec('COMMIT');
    return { carried, newer };
  } finally {
    db.close();
  }
}

function installData({ bundled, dir, version }) {
  const db = path.join(dir, '3sual.sqlite');
  const marker = path.join(dir, 'data-version.txt');
  const installed = fs.existsSync(db) && fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : null;
  if (installed === version) return { db, replaced: false };
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${db}.new`;
  fs.copyFileSync(bundled, tmp);
  let kept = { carried: 0, newer: 0 };
  if (fs.existsSync(db)) {
    const old = new DatabaseSync(db);
    old.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    old.close();
    kept = carryEdits(tmp, db);
    fs.copyFileSync(db, path.join(dir, '3sual.previous.sqlite'));
    for (const ext of ['-wal', '-shm']) fs.rmSync(db + ext, { force: true });
  }
  fs.renameSync(tmp, db);
  fs.writeFileSync(marker, version);
  return { db, replaced: true, from: installed, ...kept };
}

module.exports = { installData, carryEdits };
