/**
 * --install / --uninstall: systemd template service alexa-remote-mqtt@<name>, one instance per
 * Amazon account (mqtt-interfaces-core installer). This adapter adds the login handling:
 *
 *   /var/lib/alexa-remote-mqtt/<name>/cookie.json   per-instance login (ALEXA_REMOTE_MQTT_COOKIE_FILE)
 *   /etc/alexa-remote-mqtt/<name>.env               per-instance config
 *   /etc/mqtt-interfaces/broker.env                 optional shared broker config
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInstaller, SHARED_OPTIONS } from 'mqtt-interfaces-core';
import { OPTIONS } from './config.js';

export const SERVICE = 'alexa-remote-mqtt';
export const ENV_PREFIX = 'ALEXA_REMOTE_MQTT';

/** The 1.0 single-instance service. --install warns about it instead of removing it (A-9). */
export const LEGACY_UNIT = `/etc/systemd/system/${SERVICE}.service`;
export const LEGACY_ENV = `/etc/default/${SERVICE}`;

/**
 * Options written to /etc/alexa-remote-mqtt/<name>.env: everything except the instance name and
 * the cookie file - the unit sets ALEXA_REMOTE_MQTT_COOKIE_FILE itself, and systemd reads
 * EnvironmentFile *after* Environment=, so an entry in the env file would override the unit.
 */
const NOT_IN_ENV_FILE = new Set(['name', 'cookie-file', 'install', 'uninstall', 'config-schema']);

export const ENV_OPTIONS = [...Object.keys(OPTIONS), ...Object.keys(SHARED_OPTIONS)]
  .filter(option => !NOT_IN_ENV_FILE.has(option))
  .map(option => option.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()));

function homeOf(user) {
  try {
    return execFileSync('getent', ['passwd', user]).toString().split(':')[5];
  } catch {
    return undefined;
  }
}

/**
 * Where an existing Amazon login may be found, most specific first: the configured file, the
 * invoking user's home directory (also under the pre-release name echo2mqtt) and the state
 * directories of the 1.0 / echo2mqtt services.
 */
export function loginCandidates({ argv = {}, env = process.env, home = env.SUDO_USER && homeOf(env.SUDO_USER) } = {}) {
  const candidates = [argv.cookieFile];
  if (home) {
    candidates.push(path.join(home, '.alexa-remote-mqtt', 'cookie.json'));
    candidates.push(path.join(home, '.echo2mqtt', 'cookie.json'));
  }
  candidates.push(`/var/lib/${SERVICE}/cookie.json`, '/var/lib/echo2mqtt/cookie.json');
  return candidates.filter(Boolean);
}

/** First candidate that exists. */
export function findExistingLogin(candidates, exists = file => fs.existsSync(file)) {
  return candidates.find(file => exists(file));
}

/**
 * Copy an existing Amazon login into the instance state directory (the core chowns it afterwards)
 * and point out a leftover 1.0 service. Without a login the service starts the login proxy.
 */
export function copyLogin({ name, argv, stateDir, log }) {
  const target = path.join(stateDir, 'cookie.json');
  if (fs.existsSync(target)) {
    log(`keeping existing login ${target}`);
  } else {
    const source = findExistingLogin(loginCandidates({ argv }));
    if (source) {
      log(`copying existing amazon login ${source} to ${target}`);
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o600);
    } else {
      log(
        `no existing amazon login found - the service starts the login proxy, ` +
          `follow it with: journalctl -u ${SERVICE}@${name} -f`,
      );
    }
  }
  if (fs.existsSync(LEGACY_UNIT)) {
    log(
      `note: the 1.0 service ${LEGACY_UNIT} is still installed and would run a second instance. ` +
        `remove it with:\n` +
        `  systemctl disable --now ${SERVICE}\n` +
        `  rm ${LEGACY_UNIT} ${LEGACY_ENV}`,
    );
  }
}

const installer = createInstaller({
  service: SERVICE,
  envPrefix: ENV_PREFIX,
  description: `${SERVICE} %i - Amazon Echo to MQTT bridge`,
  documentation: 'https://github.com/hobbyquaker/alexa-remote-mqtt',
  envOptions: ENV_OPTIONS,
  environment: { [`${ENV_PREFIX}_COOKIE_FILE`]: `%S/${SERVICE}/%i/cookie.json` },
  beforeStart: copyLogin,
});

export const { unitFile, envFile, installService, uninstallService, handle } = installer;
export { envVarName, instanceName } from 'mqtt-interfaces-core';
