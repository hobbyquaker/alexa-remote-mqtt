import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createReassembler, findJsonEnd, installPushReassembly } from '../src/push-reassembly.js';

const payload = JSON.stringify({
  dopplerId: { deviceSerialNumber: 'G090', deviceType: 'A1' },
  audioPlayerState: 'PLAYING',
  quality: { badge: { altText: 'https://x/HD.png' } },
});
const meta = JSON.stringify({ command: 'PUSH_AUDIO_PLAYER_STATE', payload });
const message = JSON.stringify({
  directive: {
    header: { namespace: 'Alexa.Mobile.Push', name: 'RenderUpdate' },
    payload: { renderingUpdates: [{ route: 'EventBus:tcomm::message', resourceMetadata: meta }] },
  },
});
const part = `Content-Type: application/json\r\n\r\n${message}\r\n`;

/** Mimics alexa-http2push's per-chunk parser and returns the commands it would emit. */
function libraryParser(collected) {
  return chunk => {
    chunk = chunk.toString();
    if (chunk.startsWith('------')) {
      collected.push('BOUNDARY');
      return;
    }
    if (!chunk.startsWith('Content-Type: application/json')) return;
    const json = chunk.substring(chunk.indexOf('{'), chunk.lastIndexOf('}') + 1);
    const data = JSON.parse(json);
    for (const u of data.directive.payload.renderingUpdates) {
      collected.push(JSON.parse(u.resourceMetadata).command);
    }
  };
}

test('findJsonEnd handles nested braces inside strings', () => {
  const s = '{"a":"}{","b":{"c":1}}tail';
  assert.equal(s.slice(0, findJsonEnd(s, 0)), '{"a":"}{","b":{"c":1}}');
  assert.equal(findJsonEnd('{"a":', 0), -1);
});

test('single-chunk message passes through', () => {
  const out = [];
  const on = createReassembler(libraryParser(out));
  on(Buffer.from(part));
  assert.deepEqual(out, ['PUSH_AUDIO_PLAYER_STATE']);
});

test('message split across three chunks is reassembled', () => {
  const out = [];
  const on = createReassembler(libraryParser(out));
  const a = part.slice(0, 120),
    b = part.slice(120, 400),
    c = part.slice(400);
  on(Buffer.from(a));
  on(Buffer.from(b));
  assert.deepEqual(out, []);
  on(Buffer.from(c));
  assert.deepEqual(out, ['PUSH_AUDIO_PLAYER_STATE']);
});

test('boundary chunks still reach the library, even with content attached', () => {
  const out = [];
  const on = createReassembler(libraryParser(out));
  on(Buffer.from('------abc\r\n'));
  on(Buffer.from(`------abc\r\n${part}`));
  assert.deepEqual(out, ['BOUNDARY', 'BOUNDARY', 'PUSH_AUDIO_PLAYER_STATE']);
});

test('two messages in one chunk are both delivered', () => {
  const out = [];
  const on = createReassembler(libraryParser(out));
  on(Buffer.from(`${part}------abc\r\n${part}`));
  assert.deepEqual(out, ['PUSH_AUDIO_PLAYER_STATE', 'PUSH_AUDIO_PLAYER_STATE']);
});

test('installPushReassembly wraps the stream listener once', () => {
  const out = [];
  const stream = new EventEmitter();
  stream.on('data', libraryParser(out));
  const push = { stream };
  assert.equal(installPushReassembly(push), true);
  assert.equal(installPushReassembly(push), true);
  assert.equal(stream.listenerCount('data'), 1);
  stream.emit('data', Buffer.from(part.slice(0, 50)));
  stream.emit('data', Buffer.from(part.slice(50)));
  assert.deepEqual(out, ['PUSH_AUDIO_PLAYER_STATE']);
});
