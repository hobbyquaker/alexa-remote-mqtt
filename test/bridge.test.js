import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBool, topicName } from '../src/bridge.js';
import { buildDiscoveryConfigs } from '../src/ha-discovery.js';

test('parseBool accepts common on/off spellings', () => {
  for (const v of ['1', 'true', 'ON', 'yes']) assert.equal(parseBool(v), true, v);
  for (const v of ['0', 'false', 'off', 'No', '']) assert.equal(parseBool(v), false, v);
  assert.equal(parseBool('maybe'), null);
});

test('topicName strips MQTT wildcard characters', () => {
  assert.equal(topicName('Echo Kitchen'), 'Echo Kitchen');
  assert.equal(topicName('A/B+C#'), 'A_B_C_');
});

test('HA discovery configs are well-formed', () => {
  const configs = buildDiscoveryConfigs({
    prefix: 'alexa',
    haPrefix: 'homeassistant',
    devices: [{ name: 'Echo Kitchen', topic: 'Echo Kitchen', serialNumber: 'G090', deviceType: 'A1' }],
  });
  assert.ok(configs.length >= 15);
  const ids = new Set();
  for (const { topic, config } of configs) {
    assert.match(topic, /^homeassistant\/[a-z_]+\/alexa-remote-mqtt_G090\/[a-z_]+\/config$/);
    assert.ok(!ids.has(config.unique_id), `duplicate unique_id ${config.unique_id}`);
    ids.add(config.unique_id);
    assert.deepEqual(config.device.identifiers, ['alexa-remote-mqtt_G090']);
    assert.equal(config.availability[0].topic, 'alexa/status/bridge/connected');
  }
  const volume = configs.find(c => c.config.unique_id === 'alexa-remote-mqtt_G090_volume').config;
  assert.equal(volume.command_topic, 'alexa/set/Echo Kitchen/volume');
  assert.equal(volume.state_topic, 'alexa/status/Echo Kitchen/volume');
});
