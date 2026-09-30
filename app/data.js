'use strict';
const fs = require('node:fs');
const path = require('node:path');
const scraper = require('./scraper');
const { OWN_SOURCE_ID } = require('./store');

function prepareLibrary(file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = scraper.connect(file);
  db.prepare("UPDATE questions SET source_id = ? WHERE origin = 'own' AND source_id <> ?").run(OWN_SOURCE_ID, OWN_SOURCE_ID);
  db.close();
  return file;
}

module.exports = { prepareLibrary };
