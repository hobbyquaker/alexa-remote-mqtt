import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryModel } from '../src/ha-discovery.js';

const pkg = { name: 'alexa-remote-mqtt', version: '2.0.0' };

const DEVICES = [
  {
    name: 'Kitchen',
    topic: 'Kitchen',
    serialNumber: 'G090',
    deviceType: 'A1',
    hasMusicPlayer: true,
    isControllable: true,
  },
  {
    name: 'Echo Auto',
    topic: 'Echo Auto',
    serialNumber: 'G091',
    deviceType: 'A2',
    hasMusicPlayer: false,
    isControllable: false,
  },
];

function build({ devices = DEVICES, jsonPayloads = true, name = 'alexa' } = {}) {
  return discoveryModel({ name, get: item => (item === 'bridge/devices' ? devices : undefined), pkg, jsonPayloads });
}

test('nothing is announced before the device list is published', () => {
  assert.equal(discoveryModel({ name: 'alexa', get: () => undefined, pkg }), null);
});

test('one device for the bridge, one per music-capable echo', () => {
  const model = build();
  assert.equal(model.length, 2); // bridge + Kitchen, Echo Auto has no player
  const [bridge, kitchen] = model;
  assert.equal(bridge.id, 'alexa-remote-mqtt_alexa');
  assert.equal(bridge.availabilityMin, 1);
  assert.equal(bridge.device.mf, 'Amazon');
  assert.equal(bridge.device.sw, '2.0.0');
  assert.equal(kitchen.id, 'alexa-remote-mqtt_G090');
  assert.equal(kitchen.device.name, 'Kitchen');
  assert.equal(kitchen.device.via_device, 'alexa-remote-mqtt_alexa');
  assert.equal(kitchen.device.mdl, 'A1');
});

test('an echo is unavailable on its own when amazon reports it offline', () => {
  const [, kitchen] = build();
  assert.equal(kitchen.availability.length, 2);
  assert.equal(kitchen.availability[0].t, 'alexa/connected');
  assert.equal(kitchen.availability[1].t, 'alexa/status/Kitchen/connected');
  assert.match(kitchen.availability[1].avty_tpl, /value_json\.val/);
});

test('entity topics, unique ids and commands', () => {
  const [bridge, kitchen] = build();
  const c = kitchen.components;
  assert.equal(c.player_state.stat_t, 'alexa/status/Kitchen/player_state');
  assert.equal(c.player_state.uniq_id, 'alexa-remote-mqtt_G090_player_state');
  assert.equal(c.volume.cmd_t, 'alexa/set/Kitchen/volume');
  assert.deepEqual([c.volume.min, c.volume.max, c.volume.mode], [0, 100, 'slider']);
  assert.equal(c.mute.p, 'switch');
  assert.equal(c.mute.pl_on, 'true');
  assert.equal(c.mute.val_tpl, "{{ 'true' if value_json.val else 'false' }}");
  assert.equal(c.play.p, 'button');
  assert.equal(c.play.stat_t, undefined); // stateless
  assert.equal(c.play.pl_prs, '1');
  // the text platform needs a state topic: the last utterance is the closest thing to one
  assert.equal(c.text_command.stat_t, 'alexa/status/Kitchen/last_activity');
  assert.equal(c.text_command.val_tpl, '{{ value_json.val.text }}');
  assert.equal(c.text_command.cmd_t, 'alexa/set/Kitchen/text_command');
  // speak/announcement have no state at all
  assert.equal(c.speak.p, 'notify');
  assert.equal(c.speak.stat_t, undefined);
  assert.equal(c.announcement.cmd_t, 'alexa/set/Kitchen/announcement');
  // the bridge reports the push connection from <name>/info
  assert.equal(bridge.components.push.stat_t, 'alexa/info');
  assert.equal(bridge.components.push.val_tpl, "{{ 'ON' if value_json.push else 'OFF' }}");
  assert.equal(bridge.components.devices.val_tpl, '{{ value_json.val | length }}');

  const ids = new Set();
  for (const device of build()) {
    for (const entity of Object.values(device.components)) {
      assert.ok(!ids.has(entity.uniq_id), `duplicate unique id ${entity.uniq_id}`);
      ids.add(entity.uniq_id);
      assert.ok(entity.p && entity.name);
    }
  }
});

test('templates follow --no-json-payloads', () => {
  const [bridge, kitchen] = build({ jsonPayloads: false });
  assert.equal(kitchen.components.player_state.val_tpl, undefined); // plain value
  assert.equal(kitchen.components.mute.val_tpl, "{{ 'true' if value == 'true' else 'false' }}");
  assert.equal(kitchen.components.connected.val_tpl, "{{ 'ON' if value == 'true' else 'OFF' }}");
  assert.equal(kitchen.components.notifications.val_tpl, '{{ value | length }}');
  assert.equal(kitchen.availability[1].avty_tpl, "{{ 'online' if value == 'true' else 'offline' }}");
  // <name>/info is not a status item, its template never changes
  assert.equal(bridge.components.push.val_tpl, "{{ 'ON' if value_json.push else 'OFF' }}");
});

test('a renamed echo keeps its identity (serial), the topic level follows the name', () => {
  const [, kitchen] = build({
    devices: [{ ...DEVICES[0], name: 'Kitchen Echo', topic: 'Kitchen Echo' }],
  });
  assert.equal(kitchen.id, 'alexa-remote-mqtt_G090');
  assert.equal(kitchen.device.name, 'Kitchen Echo');
  assert.equal(kitchen.components.volume.cmd_t, 'alexa/set/Kitchen Echo/volume');
});
