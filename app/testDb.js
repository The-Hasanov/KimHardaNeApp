'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function tempDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-')), 'q.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE questions (source_id TEXT, package_id INTEGER, kind TEXT, value_id INTEGER, uid TEXT UNIQUE, origin TEXT, ordinal INTEGER,
    package_name TEXT, package_played TEXT, tournament_name TEXT, game_id INTEGER, game_name TEXT, phase_path TEXT,
    theme_name TEXT, theme_round INTEGER, group_size INTEGER, group_index INTEGER, text TEXT, answer TEXT, comment TEXT,
    accepted_answers TEXT, note_before TEXT, rekvizit_text TEXT, rekvizit_url TEXT, source_media_url TEXT, sources TEXT,
    authors TEXT, raw_value TEXT, raw_parent TEXT)`);
  db.exec('CREATE TABLE images (url TEXT PRIMARY KEY, status TEXT, path TEXT, bytes INTEGER, content_type TEXT, sha256 TEXT, error TEXT, fetched_at TEXT)');
  const add = db.prepare("INSERT INTO questions (source_id, package_id, kind, value_id, uid, ordinal, game_id, game_name, text, answer, sources) VALUES ('3sual', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  add.run('question', 1, '1:question:1', 1, 1, 'NHN', 'Azərbaycanın paytaxtı hansı şəhərdir?', 'Bakı', '["https://a.az"]');
  add.run('question', 2, '1:question:2', 2, 1, 'NHN', 'Futbol klubu "Qarabağ" hansı şəhəri təmsil edir?', 'Ağdam', null);
  add.run('theme', 3, '1:theme:3', 3, 3, 'Fərdi Oyun', 'Bakının ən qədim məhəlləsi', 'İçərişəhər', null);
  add.run('question', 4, '1:question:4', 4, 1, 'NHN', '-', '-', null);
  db.exec(`UPDATE questions SET authors = '[{"id":7,"fullname":"Aysel"},{"id":9,"fullname":"Nicat"}]' WHERE value_id IN (1, 3);
    UPDATE questions SET authors = '[{"id":9,"fullname":"Nicat"}]' WHERE value_id = 2`);
  db.close();
  return file;
}

module.exports = { tempDb };
