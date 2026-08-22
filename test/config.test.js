import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from 'mqtt-interfaces-core';
import { OPTIONS, localIp } from '../src/config.js';

const pkg = { name: 'alexa-remote-mqtt', version: '2.0.0', homepage: 'https://example.invalid' };

function parse(argv = [], env = {}) {
  return parseConfig({ pkg, options: OPTIONS, defaults: { name: 'alexa' }, argv, env: { ...env } });
}

test('defaults: instance name alexa, ha discovery and json payloads on', () => {
  const config = parse();
  assert.equal(config.name, 'alexa');
  assert.equal(config.haDiscovery, true);
  assert.equal(config.jsonPayloads, true);
  assert.equal(config.maintenance, true);
  assert.equal(config.amazonPage, 'amazon.de');
  assert.equal(config.pollInterval, 300);
  assert.equal(config.verbosity, 'info');
});

test('environment variables are typed, cli wins over env', () => {
  const config = parse([], { ALEXA_REMOTE_MQTT_POLL_INTERVAL: '60', ALEXA_REMOTE_MQTT_HA_DISCOVERY: 'false' });
  assert.equal(config.pollInterval, 60);
  assert.equal(config.haDiscovery, false);
  assert.equal(parse(['--poll-interval', '30'], { ALEXA_REMOTE_MQTT_POLL_INTERVAL: '60' }).pollInterval, 30);
});

test('unprefixed broker variables are the fallback', () => {
  assert.equal(parse([], { MQTT_URL: 'mqtt://broker' }).mqttUrl, 'mqtt://broker');
  assert.equal(
    parse([], { MQTT_URL: 'mqtt://broker', ALEXA_REMOTE_MQTT_MQTT_URL: 'mqtt://own' }).mqttUrl,
    'mqtt://own',
  );
});

test('--config-schema prints the schema with x-env names', () => {
  let printed;
  parseConfig({
    pkg,
    options: OPTIONS,
    defaults: { name: 'alexa' },
    argv: ['--config-schema'],
    env: {},
    print: out => (printed = JSON.parse(out)),
    exit: () => {},
  });
  assert.equal(printed.properties['amazon-page']['x-env'], 'ALEXA_REMOTE_MQTT_AMAZON_PAGE');
  assert.equal(printed.properties['amazon-page'].default, 'amazon.de');
  assert.equal(printed.properties.name.default, 'alexa');
  // meta options are not part of an instance configuration
  assert.equal(printed.properties.install, undefined);
  assert.equal(printed['x-adapter'].envPrefix, 'ALEXA_REMOTE_MQTT');
});

test('localIp prefers a non-internal IPv4 address', () => {
  assert.equal(
    localIp({
      lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      eth0: [
        { family: 'IPv6', internal: false, address: 'fe80::1' },
        { family: 'IPv4', internal: false, address: '192.0.2.7' },
      ],
    }),
    '192.0.2.7',
  );
  assert.equal(localIp({ lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] }), '127.0.0.1');
});
