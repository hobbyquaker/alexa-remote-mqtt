import test from 'node:test';
import assert from 'node:assert/strict';
import { envFile, unitFile } from '../src/install.js';

test('envFile writes only set options as ALEXA_REMOTE_MQTT_* variables', () => {
  const out = envFile({
    mqttUrl: 'mqtt://broker',
    mqttUsername: undefined,
    mqttPassword: '',
    topicPrefix: 'alexa',
    amazonPage: 'amazon.de',
    alexaServiceHost: 'layla.amazon.com',
    proxyOwnIp: '192.168.1.10',
    proxyPort: 3001,
    pollInterval: 300,
    haDiscovery: true,
    haPrefix: 'homeassistant',
  });
  assert.match(out, /^ALEXA_REMOTE_MQTT_MQTT_URL=mqtt:\/\/broker$/m);
  assert.match(out, /^ALEXA_REMOTE_MQTT_HA_DISCOVERY=true$/m);
  assert.match(out, /^ALEXA_REMOTE_MQTT_PROXY_PORT=3001$/m);
  assert.doesNotMatch(out, /MQTT_USERNAME|MQTT_PASSWORD/);
});

test('unitFile references ExecStart, env file and state dir', () => {
  const unit = unitFile('/usr/bin/node /usr/local/lib/node_modules/alexa-remote-mqtt/bin/alexa-remote-mqtt.js');
  assert.match(
    unit,
    /^ExecStart=\/usr\/bin\/node \/usr\/local\/lib\/node_modules\/alexa-remote-mqtt\/bin\/alexa-remote-mqtt\.js$/m,
  );
  assert.match(unit, /^EnvironmentFile=-\/etc\/default\/alexa-remote-mqtt$/m);
  assert.match(unit, /^StateDirectory=alexa-remote-mqtt$/m);
  assert.match(unit, /^WantedBy=multi-user\.target$/m);
});
