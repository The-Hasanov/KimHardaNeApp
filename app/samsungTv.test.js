'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { openInTvBrowser } = require('./samsungTv');

const serverTextFrame = text => {
  const payload = Buffer.from(text);
  return Buffer.concat([Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]), payload]);
};

function readClientFrame(bytes) {
  const shortLength = bytes[1] & 0x7f;
  const [length, maskStart] = shortLength === 126 ? [bytes.readUInt16BE(2), 4] : [shortLength, 2];
  const mask = bytes.subarray(maskStart, maskStart + 4);
  return Buffer.from(bytes.subarray(maskStart + 4, maskStart + 4 + length).map((byte, index) => byte ^ mask[index % 4])).toString();
}

function fakeTv({ refuses = false } = {}) {
  const launches = [];
  const server = net.createServer(socket => {
    let hasShakenHands = false;
    socket.on('data', bytes => {
      if (!hasShakenHands) {
        hasShakenHands = true;
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: WebSocket\r\nConnection: Upgrade\r\n\r\n');
        return socket.write(serverTextFrame(JSON.stringify({ event: refuses ? 'ms.channel.unauthorized' : 'ms.channel.connect', data: {} })));
      }
      launches.push(JSON.parse(readClientFrame(bytes)));
      socket.write(serverTextFrame(JSON.stringify({ data: 200, event: 'ed.apps.launch', from: 'host' })));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, launches, close: () => server.close() })));
}

test('opens the party TV page in the Samsung TV web browser', async () => {
  const tv = await fakeTv();
  try {
    await openInTvBrowser('127.0.0.1', 'http://192.168.1.20:8765/tv', { port: tv.port, isSecure: false });
    assert.deepEqual(tv.launches.map(launch => [launch.method, launch.params.data.appId, launch.params.data.metaTag]),
      [['ms.channel.emit', 'org.tizen.browser', 'http://192.168.1.20:8765/tv']]);
  } finally {
    tv.close();
  }
});

test('says so when the TV refuses the connection', async () => {
  const tv = await fakeTv({ refuses: true });
  try {
    await assert.rejects(openInTvBrowser('127.0.0.1', 'http://192.168.1.20:8765/tv', { port: tv.port, isSecure: false }), /refused/);
    assert.equal(tv.launches.length, 0);
  } finally {
    tv.close();
  }
});
