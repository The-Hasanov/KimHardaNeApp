'use strict';
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const net = require('node:net');
const tls = require('node:tls');

const SSDP_GROUP = { address: '239.255.255.250', port: 1900 };
const SAMSUNG_SEARCH_TARGET = 'urn:samsung.com:service:MultiScreenService:1';
const INFO_PORT = 8001;
const REMOTE_CONTROL_PORT = 8002;
const SENDER_NAME = 'KimHardaNeApp';
const TV_BROWSER_APP_ID = 'org.tizen.browser';
const ANSWER_TIMEOUT_MS = 30000;

async function readTvInfo(address, infoPort = INFO_PORT) {
  const response = await fetch(`http://${address}:${infoPort}/api/v2/`, { signal: AbortSignal.timeout(3000) });
  const info = await response.json();
  return { address, name: info.name.replace(/^\[TV\]\s*/, ''), model: info.device?.modelName ?? '' };
}

function findSamsungTvs({ searchMs = 2500 } = {}) {
  return new Promise(resolve => {
    const addresses = new Set();
    const socket = dgram.createSocket('udp4');
    const search = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_GROUP.address}:${SSDP_GROUP.port}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${SAMSUNG_SEARCH_TARGET}\r\n\r\n`);
    const finish = async () => {
      socket.close();
      const found = await Promise.allSettled([...addresses].map(address => readTvInfo(address)));
      resolve(found.filter(result => result.status === 'fulfilled').map(result => result.value));
    };
    socket.on('message', (message, remote) => {
      if (message.toString().includes(SAMSUNG_SEARCH_TARGET)) addresses.add(remote.address);
    });
    socket.on('error', () => resolve([]));
    socket.bind(0, () => {
      socket.send(search, SSDP_GROUP.port, SSDP_GROUP.address);
      setTimeout(() => socket.send(search, SSDP_GROUP.port, SSDP_GROUP.address), 700);
      setTimeout(finish, searchMs);
    });
  });
}

function maskedTextFrame(text) {
  const payload = Buffer.from(text);
  const length = payload.length < 126 ? Buffer.from([0x80 | payload.length]) : Buffer.from([0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  const mask = crypto.randomBytes(4);
  return Buffer.concat([Buffer.from([0x81]), length, mask, payload.map((byte, index) => byte ^ mask[index % 4])]);
}

function openInTvBrowser(address, url, { port = REMOTE_CONTROL_PORT, isSecure = true } = {}) {
  return new Promise((resolve, reject) => {
    const connectOptions = { host: address, port, rejectUnauthorized: false };
    const socket = isSecure ? tls.connect(connectOptions) : net.connect(connectOptions);
    let received = '';
    let hasAskedToLaunch = false;
    const settle = error => {
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(new Error(error));
      else resolve();
    };
    const timeout = setTimeout(() => settle('The TV did not answer. Check that it is on, then allow KimHardaNeApp if the TV asks.'), ANSWER_TIMEOUT_MS);
    socket.once(isSecure ? 'secureConnect' : 'connect', () => {
      const name = Buffer.from(SENDER_NAME).toString('base64');
      socket.write([`GET /api/v2/channels/samsung.remote.control?name=${name} HTTP/1.1`, `Host: ${address}:${port}`, 'Upgrade: websocket',
        'Connection: Upgrade', `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', '', ''].join('\r\n'));
    });
    socket.on('data', chunk => {
      received += chunk.toString('utf8');
      if (received.includes('ms.channel.unauthorized')) return settle('The TV refused the connection. On the TV, allow KimHardaNeApp under Settings → General → External Device Manager.');
      if (!hasAskedToLaunch && received.includes('ms.channel.connect')) {
        hasAskedToLaunch = true;
        socket.write(maskedTextFrame(JSON.stringify({
          method: 'ms.channel.emit',
          params: { event: 'ed.apps.launch', to: 'host', data: { appId: TV_BROWSER_APP_ID, action_type: 'NATIVE_LAUNCH', metaTag: url } },
        })));
      }
      if (received.includes('"event":"ed.apps.launch"')) settle(/"data":200/.test(received) ? null : 'The TV could not open its web browser.');
    });
    socket.on('error', error => settle(`Could not reach the TV: ${error.message}`));
  });
}

module.exports = { findSamsungTvs, openInTvBrowser, readTvInfo, maskedTextFrame };
