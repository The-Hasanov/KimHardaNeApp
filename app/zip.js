'use strict';
const zlib = require('node:zlib');

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const STORED = 0;
const DEFLATED = 8;
const UTF8_NAMES = 0x0800;
const MAX_ZIP_BYTES = 0xffffffff;
const MAX_ENTRIES = 0xffff;

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function createZip(entries, { now = new Date() } = {}) {
  if (entries.length > MAX_ENTRIES) throw new Error('Too many files for one archive');
  const { time, day } = dosDateTime(now);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, data, compress = true } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = compress ? zlib.deflateRawSync(data) : null;
    const useDeflate = deflated && deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(useDeflate ? DEFLATED : STORED, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(useDeflate ? DEFLATED : STORED, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, nameBytes, body);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
    if (offset > MAX_ZIP_BYTES) throw new Error('The archive would be larger than 4 GB');
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const isZip = buffer => buffer.length >= 4 && buffer.readUInt32LE(0) === LOCAL_HEADER;

class DamagedArchiveError extends Error {}

function readZip(buffer, { maxEntryBytes = 512 * 1024 * 1024, maxTotalBytes = 2 * 1024 * 1024 * 1024, maxEntries = MAX_ENTRIES } = {}) {
  const damaged = () => new DamagedArchiveError('This archive is damaged or not a KimHardaNeApp file');
  const within = (at, length) => at >= 0 && length >= 0 && at + length <= buffer.length;
  const endAt = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0 || !within(endAt, 22)) throw damaged();
  const count = buffer.readUInt16LE(endAt + 10);
  if (count > maxEntries) throw new Error('This archive holds too many files');
  let at = buffer.readUInt32LE(endAt + 16);
  let totalBytes = 0;
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (!within(at, 46) || buffer.readUInt32LE(at) !== CENTRAL_HEADER) throw damaged();
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localAt = buffer.readUInt32LE(at + 42);
    if (!within(at + 46, nameLength)) throw damaged();
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (size > maxEntryBytes) throw new Error(`${name} is too large to import`);
    totalBytes += size;
    if (totalBytes > maxTotalBytes) throw new Error('This archive is too large to import');
    if (![STORED, DEFLATED].includes(method)) throw new Error(`${name} uses a compression this app cannot read`);
    if (!within(localAt, 30) || buffer.readUInt32LE(localAt) !== LOCAL_HEADER) throw damaged();
    const dataAt = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
    if (!within(dataAt, compressedSize)) throw damaged();
    const body = buffer.subarray(dataAt, dataAt + compressedSize);
    files.set(name, {
      size,
      read() {
        let data;
        try {
          data = method === DEFLATED ? zlib.inflateRawSync(body, { maxOutputLength: Math.max(size, 1) }) : Buffer.from(body);
        } catch {
          throw damaged();
        }
        if (data.length !== size || zlib.crc32(data) !== crc) throw damaged();
        return data;
      },
    });
  }
  return files;
}

module.exports = { createZip, readZip, isZip, DamagedArchiveError };
