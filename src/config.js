/**
 * CLI options and environment configuration (mqtt-interfaces-core `parseConfig`).
 * Every option is also `ALEXA_REMOTE_MQTT_<OPTION>`; the broker settings fall back to the
 * unprefixed `MQTT_URL` / `MQTT_USERNAME` / `MQTT_PASSWORD`. `--config-schema` prints the schema.
 */

import os from 'node:os';
import path from 'node:path';
import { parseConfig } from 'mqtt-interfaces-core';
import pkg from '../package.json' with { type: 'json' };

/** First non-internal IPv4 address of this machine - the default for the login proxy URL. */
export function localIp(interfaces = os.networkInterfaces()) {
  for (const list of Object.values(interfaces)) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

export const DEFAULT_COOKIE_FILE = path.join(os.homedir(), '.alexa-remote-mqtt', 'cookie.json');

export const OPTIONS = {
  'amazon-page': {
    alias: 'a',
    type: 'string',
    describe: 'amazon domain of your account, e.g. amazon.de, amazon.com',
    default: 'amazon.de',
  },
  'alexa-service-host': {
    type: 'string',
    describe: 'alexa api host: layla.amazon.com (europe), pitangui.amazon.com (north america)',
    default: 'layla.amazon.com',
  },
  'cookie-file': {
    alias: 'c',
    type: 'string',
    describe: 'file the amazon login is persisted in',
    default: DEFAULT_COOKIE_FILE,
    // a credential written by the login proxy: management UIs show the path, nobody edits it
    file: { format: 'binary', describe: 'the Amazon login (written by the one-time login proxy)' },
  },
  'proxy-own-ip': {
    type: 'string',
    describe: 'ip address of this machine for the one-time login proxy (an ip, not a hostname)',
    default: localIp(),
  },
  'proxy-port': {
    type: 'number',
    describe: 'port of the one-time login proxy',
    default: 3001,
  },
  'poll-interval': {
    alias: 'p',
    type: 'number',
    describe: 'seconds between full state polls (0 = push events only)',
    default: 300,
  },
};

export default parseConfig({
  pkg,
  options: OPTIONS,
  defaults: { name: 'alexa' },
  examples: [
    ['$0 -u mqtt://broker -a amazon.de', 'run in the foreground'],
    ['sudo $0 --install -n alexa -u mqtt://broker', 'install as service alexa-remote-mqtt@alexa'],
  ],
});
