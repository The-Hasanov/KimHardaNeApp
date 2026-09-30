'use strict';
const fs = require('node:fs');
const path = require('node:path');
const scraper = require('./scraper');

const LIBRARY = 'kimhardane.sqlite';
const BEFORE_DATA_SOURCES = '3sual.sqlite';

function openLibraryFile(dir) {
  const file = path.join(dir, LIBRARY);
  const old = path.join(dir, BEFORE_DATA_SOURCES);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file) && fs.existsSync(old)) {
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(old + ext)) fs.renameSync(old + ext, file + ext);
  }
  prepareLibrary(file);
  return file;
}

const prepareLibrary = file => scraper.connect(file).close();

module.exports = { openLibraryFile, prepareLibrary };
