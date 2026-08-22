import test from 'node:test';
import assert from 'node:assert/strict';
import { AlexaRemoteMqtt, isRealDevice, topicName } from '../src/bridge.js';

const DEVICES = [
  { accountName: 'Kitchen', serialNumber: 'G090', deviceType: 'A1', hasMusicPlayer: true, online: true },
  { accountName: 'Bath', serialNumber: 'G091', deviceType: 'A1', isControllable: true, online: true },
  { accountName: 'This Device', serialNumber: 'APP1', deviceFamily: 'VOX' },
];

/** Minimal stand-ins for the adapter (mqtt side) and alexa-remote2. */
function setup({ devices = DEVICES } = {}) {
  const published = [];
  const logged = [];
  const log = {};
  for (const level of ['debug', 'info', 'warn', 'error']) {
    log[level] = (...args) => logged.push([level, args.join(' ')]);
  }
  const state = new Map();
  const adapter = {
    log,
    pkg: { name: 'alexa-remote-mqtt', version: '2.0.0' },
    status: { state },
    get: item => state.get(item),
    pubStatus: (item, value, options) => {
      state.set(item, value);
      published.push({ item, value, retain: options?.retain !== false });
    },
    clearStatus: item => state.delete(item),
    publishInfo: () => {},
    setDeviceConnected: () => {},
    shutdown: () => {},
  };

  const calls = [];
  const alexa = {
    serialNumbers: Object.fromEntries(devices.map(d => [d.serialNumber, d])),
    find: needle => devices.find(d => d.serialNumber === needle || d.accountName === needle),
    sendCommand: (device, command, value, cb) => {
      calls.push({ type: 'command', device: device.accountName, command, value });
      cb(null, {});
    },
    sendSequenceCommand: (deviceOrList, command, value, cb) => {
      calls.push({ type: 'sequence', device: deviceOrList, command, value });
      cb(null, {});
    },
    setDoNotDisturb: (device, enabled, cb) => {
      calls.push({ type: 'dnd', device: device.accountName, enabled });
      cb(null, {});
    },
  };

  const bridge = new AlexaRemoteMqtt({
    config: { name: 'alexa', amazonPage: 'amazon.de', cookieFile: '/tmp/none.json', pollInterval: 0 },
    adapter,
  });
  bridge.alexa = alexa;
  bridge.alexaReady = true;
  return { bridge, adapter, published, calls, logged, state };
}

const last = (published, item) => published.filter(p => p.item === item).at(-1);

test('topicName strips mqtt wildcards and keeps "bridge" for the bridge itself', () => {
  assert.equal(topicName('Echo Kitchen'), 'Echo Kitchen');
  assert.equal(topicName('A/B+C#'), 'A_B_C_');
  assert.equal(topicName('bridge'), 'bridge_');
  assert.equal(topicName(' Bath '), 'Bath');
});

test('app registrations are not devices', () => {
  assert.equal(isRealDevice(DEVICES[0]), true);
  assert.equal(isRealDevice(DEVICES[2]), false);
  const { bridge } = setup();
  assert.deepEqual(
    bridge.devices().map(d => d.accountName),
    ['Kitchen', 'Bath'],
  );
});

test('the device list is published and warns about a reserved topic level', () => {
  const { bridge, published, logged } = setup({
    devices: [{ accountName: 'bridge', serialNumber: 'G0', hasMusicPlayer: true }],
  });
  bridge.publishDeviceList();
  const list = last(published, 'bridge/devices').value;
  assert.deepEqual(
    list.map(d => [d.name, d.topic]),
    [['bridge', 'bridge_']],
  );
  assert.ok(logged.some(([level, msg]) => level === 'warn' && msg.includes('bridge_')));
});

test('status items of a device that is gone are cleared', () => {
  const { bridge, adapter, state } = setup();
  bridge.publishDeviceList();
  adapter.pubStatus('Bath/volume', 20);
  bridge.alexa.serialNumbers = { G090: DEVICES[0] };
  bridge.publishDeviceList();
  assert.equal(state.has('Bath/volume'), false);
  assert.equal(state.has('bridge/devices'), true);
});

test('mute is emulated: volume 0 and restore', async () => {
  const { bridge, adapter, published, calls } = setup();
  adapter.pubStatus('Kitchen/volume', 42);
  await bridge.handleSet(['Kitchen', 'mute'], true, 'alexa/set/Kitchen/mute', 'true');
  assert.deepEqual(calls.at(-1), { type: 'command', device: 'Kitchen', command: 'volume', value: 0 });
  assert.equal(last(published, 'Kitchen/mute').value, true);
  await bridge.handleSet(['Kitchen', 'mute'], false, 'alexa/set/Kitchen/mute', 'false');
  assert.deepEqual(calls.at(-1), { type: 'command', device: 'Kitchen', command: 'volume', value: 42 });
  assert.equal(last(published, 'Kitchen/mute').value, false);
});

test('set/all/announcement is one request for every music device', async () => {
  const { bridge, calls } = setup();
  await bridge.handleSet(['all', 'announcement'], 'Dinner', 'alexa/set/all/announcement', 'Dinner');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { type: 'sequence', device: ['G090', 'G091'], command: 'announcement', value: 'Dinner' });
});

test('set/all/<command> runs on every music device', async () => {
  const { bridge, calls } = setup();
  await bridge.handleSet(['all', 'pause'], undefined, 'alexa/set/all/pause', '');
  assert.deepEqual(
    calls.map(c => c.device),
    ['Kitchen', 'Bath'],
  );
});

test('spoken text comes from the raw payload, not the parsed value', async () => {
  const { bridge, calls } = setup();
  await bridge.handleSet(['Kitchen', 'speak'], 42, 'alexa/set/Kitchen/speak', '42');
  assert.deepEqual(calls.at(-1), { type: 'sequence', device: DEVICES[0], command: 'speak', value: '42' });
  await bridge.handleSet(['Kitchen', 'text_command'], true, 'alexa/set/Kitchen/text_command', 'true');
  assert.equal(calls.at(-1).value, 'true');
  assert.equal(calls.at(-1).command, 'textCommand');
});

test('aliases, booleans and serial numbers are accepted', async () => {
  const { bridge, calls, published } = setup();
  await bridge.handleSet(['Kitchen', 'say'], 'hi', 'alexa/set/Kitchen/say', 'hi');
  assert.equal(calls.at(-1).command, 'speak');
  await bridge.handleSet(['G091', 'doNotDisturb'], 'on', 'alexa/set/G091/doNotDisturb', 'on');
  assert.deepEqual(calls.at(-1), { type: 'dnd', device: 'Bath', enabled: true });
  assert.equal(last(published, 'Bath/dnd').value, true);
  await bridge.handleSet(['Kitchen', 'player_state'], 'PAUSED', 'alexa/set/Kitchen/player_state', 'PAUSED');
  assert.equal(calls.at(-1).command, 'pause');
  await bridge.handleSet(['Kitchen', 'volume'], 30, 'alexa/set/Kitchen/volume', '30');
  assert.deepEqual(calls.at(-1), { type: 'command', device: 'Kitchen', command: 'volume', value: 30 });
});

test('bad topics, devices, commands and payloads are rejected', async () => {
  const { bridge } = setup();
  const fails = async (parts, value, raw, expected) =>
    assert.rejects(() => bridge.handleSet(parts, value, `alexa/set/${parts.join('/')}`, raw), expected);
  await fails(['Kitchen'], '', '', /expected <name>\/set/);
  await fails(['a', 'b', 'c'], '', '', /expected <name>\/set/);
  await fails(['Nowhere', 'pause'], '', '', /unknown device "Nowhere"/);
  await fails(['Kitchen', 'nonsense'], '', '', /unknown command "nonsense"/);
  await fails(['Kitchen', 'speak'], undefined, '  ', /empty payload/);
  await fails(['Kitchen', 'mute'], 'maybe', 'maybe', /invalid mute payload/);
  await fails(['Kitchen', 'volume'], 'loud', 'loud', /invalid volume/);
  await fails(['Kitchen', 'equalizer'], 'x', 'x', /invalid equalizer/);
  bridge.alexaReady = false;
  await fails(['Kitchen', 'pause'], '', '', /not ready/);
});

test('published items and payload shapes of the player state', () => {
  const { bridge, published } = setup();
  const device = DEVICES[0];
  bridge.publishDeviceAttr(device, 'progress', { progress: 1, length: 2 }, { retain: false });
  bridge.publishDeviceAttr(device, 'last_voice_command', 'play swr3', { retain: false });
  bridge.publishMuted(device, false, 0);
  bridge.publishDeviceAttr(device, 'nothing', undefined);
  assert.equal(last(published, 'Kitchen/progress').retain, false);
  assert.equal(last(published, 'Kitchen/last_voice_command').retain, false);
  assert.equal(last(published, 'Kitchen/mute').value, true); // volume 0 counts as muted
  assert.equal(last(published, 'Kitchen/nothing'), undefined);
});

test('a voice command publishes the utterance and the activity', () => {
  const { bridge, published } = setup();
  bridge.onDeviceActivity({
    deviceSerialNumber: 'G090',
    description: { summary: 'play swr3' },
    data: { utteranceType: 'GENERAL' },
    alexaResponse: 'ok',
    creationTimestamp: 1700000000000,
  });
  assert.equal(last(published, 'Kitchen/last_voice_command').value, 'play swr3');
  assert.deepEqual(last(published, 'Kitchen/last_activity').value, {
    text: 'play swr3',
    response: 'ok',
    utterance_type: 'GENERAL',
    timestamp: 1700000000000,
  });
  // the wake word alone is not a command
  const before = published.length;
  bridge.onDeviceActivity({
    deviceSerialNumber: 'G090',
    description: { summary: 'alexa' },
    data: { utteranceType: 'WAKE_WORD_ONLY' },
  });
  assert.equal(published.length, before);
});

test('info carries the amazon page, the device count and the push state', () => {
  const { bridge } = setup();
  assert.deepEqual(bridge.infoExtra(), { amazonPage: 'amazon.de', devices: 2, push: false });
  bridge.alexa.alexahttp2Push = { connectionActive: true };
  assert.equal(bridge.infoExtra().push, true);
});
