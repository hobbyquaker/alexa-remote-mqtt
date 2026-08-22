import test from 'node:test';
import assert from 'node:assert/strict';
import { ENV_OPTIONS, envFile, findExistingLogin, loginCandidates, unitFile } from '../src/install.js';

test('login candidates: configured file, invoking user, then the 1.0 / echo2mqtt locations', () => {
  const candidates = loginCandidates({
    argv: { cookieFile: '/etc/given/cookie.json' },
    env: {},
    home: '/home/basti',
  });
  assert.deepEqual(candidates, [
    '/etc/given/cookie.json',
    '/home/basti/.alexa-remote-mqtt/cookie.json',
    '/home/basti/.echo2mqtt/cookie.json',
    '/var/lib/alexa-remote-mqtt/cookie.json',
    '/var/lib/echo2mqtt/cookie.json',
  ]);
  assert.equal(loginCandidates({ argv: {}, env: {} }).length, 2);
  assert.equal(
    findExistingLogin(candidates, file => file.startsWith('/var/lib/alexa')),
    '/var/lib/alexa-remote-mqtt/cookie.json',
  );
  assert.equal(
    findExistingLogin(candidates, () => false),
    undefined,
  );
});

test('the env file holds every option except the instance name and the cookie file', () => {
  assert.ok(ENV_OPTIONS.includes('amazonPage'));
  assert.ok(ENV_OPTIONS.includes('mqttUrl'));
  assert.ok(!ENV_OPTIONS.includes('cookieFile'));
  assert.ok(!ENV_OPTIONS.includes('name'));
  assert.ok(!ENV_OPTIONS.some(option => ['install', 'uninstall', 'configSchema'].includes(option)));

  const out = envFile({
    name: 'alexa',
    mqttUrl: 'mqtt://broker',
    mqttUsername: undefined,
    amazonPage: 'amazon.de',
    alexaServiceHost: 'layla.amazon.com',
    cookieFile: '/home/basti/.alexa-remote-mqtt/cookie.json',
    proxyOwnIp: '192.0.2.10',
    proxyPort: 3001,
    pollInterval: 300,
    haDiscovery: true,
    verbosity: 'info',
  });
  assert.match(out, /^ALEXA_REMOTE_MQTT_MQTT_URL=mqtt:\/\/broker$/m);
  assert.match(out, /^ALEXA_REMOTE_MQTT_AMAZON_PAGE=amazon\.de$/m);
  assert.match(out, /^ALEXA_REMOTE_MQTT_PROXY_PORT=3001$/m);
  assert.match(out, /^ALEXA_REMOTE_MQTT_HA_DISCOVERY=true$/m);
  // the unit sets the cookie file itself - systemd reads EnvironmentFile after Environment=
  assert.doesNotMatch(out, /COOKIE_FILE/);
  assert.doesNotMatch(out, /ALEXA_REMOTE_MQTT_NAME=/);
  // options without a value are left out (the comment header mentions them, hence ^...=)
  assert.doesNotMatch(out, /^ALEXA_REMOTE_MQTT_MQTT_USERNAME=/m);
});

test('the template unit points at the per-instance login and the shared broker config', () => {
  const unit = unitFile('/usr/bin/node /usr/local/lib/node_modules/alexa-remote-mqtt/bin/alexa-remote-mqtt.js');
  assert.match(unit, /^Environment=ALEXA_REMOTE_MQTT_COOKIE_FILE=%S\/alexa-remote-mqtt\/%i\/cookie\.json$/m);
  assert.match(unit, /^Environment=ALEXA_REMOTE_MQTT_NAME=%i$/m);
  assert.match(unit, /^EnvironmentFile=-\/etc\/mqtt-interfaces\/broker\.env$/m);
  assert.match(unit, /^EnvironmentFile=\/etc\/alexa-remote-mqtt\/%i\.env$/m);
  assert.match(unit, /^StateDirectory=alexa-remote-mqtt\/%i$/m);
  assert.match(unit, /^SyslogIdentifier=alexa-remote-mqtt@%i$/m);
  // maintenance/set/restart exits cleanly and must come back
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node .*bin\/alexa-remote-mqtt\.js$/m);
  assert.match(unit, /^WantedBy=multi-user\.target$/m);
});
