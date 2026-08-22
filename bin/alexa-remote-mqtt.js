#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { AlexaRemoteMqtt } from '../src/bridge.js';
import { installService, uninstallService } from '../src/install.js';

function localIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

const argv = yargs(hideBin(process.argv))
  .scriptName('alexa-remote-mqtt')
  .usage('$0 [options]\n\nBridge Amazon Echo devices to MQTT.')
  .env('ALEXA_REMOTE_MQTT')
  .option('mqtt-url', { alias: 'u', type: 'string', default: 'mqtt://127.0.0.1', describe: 'MQTT broker URL' })
  .option('mqtt-username', { type: 'string', describe: 'MQTT username' })
  .option('mqtt-password', { type: 'string', describe: 'MQTT password' })
  .option('topic-prefix', { alias: 't', type: 'string', default: 'alexa', describe: 'MQTT topic prefix' })
  .option('amazon-page', {
    alias: 'a',
    type: 'string',
    default: 'amazon.de',
    describe: 'Amazon domain of your account (amazon.de, amazon.com, ...)',
  })
  .option('alexa-service-host', {
    type: 'string',
    default: 'layla.amazon.com',
    describe: 'Alexa API host (layla.amazon.com / pitangui.amazon.com)',
  })
  .option('cookie-file', {
    alias: 'c',
    type: 'string',
    default: path.join(os.homedir(), '.alexa-remote-mqtt', 'cookie.json'),
    describe: 'File to persist the Amazon login',
  })
  .option('proxy-own-ip', {
    type: 'string',
    default: localIp(),
    describe: 'IP of this machine for the one-time login proxy (use an IP, not a hostname)',
  })
  .option('proxy-port', { type: 'number', default: 3001, describe: 'Port of the one-time login proxy' })
  .option('poll-interval', {
    alias: 'p',
    type: 'number',
    default: 300,
    describe: 'Seconds between full state polls (0 = push events only)',
  })
  .option('ha-discovery', {
    type: 'boolean',
    default: false,
    describe: 'Publish Home Assistant MQTT discovery configs',
  })
  .option('ha-prefix', { type: 'string', default: 'homeassistant', describe: 'Home Assistant discovery topic prefix' })
  .option('verbose', {
    alias: 'v',
    type: 'boolean',
    default: false,
    describe: 'Verbose logging (includes alexa-remote2 log)',
  })
  .option('install', {
    type: 'boolean',
    default: false,
    describe: 'Install as systemd service (using the other options as its config), enable and start it. Needs root.',
  })
  .option('uninstall', {
    type: 'boolean',
    default: false,
    describe: 'Stop, disable and remove the systemd service. Needs root.',
  })
  .example('sudo $0 --install --mqtt-url mqtt://broker --amazon-page amazon.de', 'Install and start as a service')
  .help()
  .version()
  .strict()
  .parse();

const ts = () => new Date().toISOString();
const log = (...a) => console.log(ts(), ...a);
const debug = argv.verbose ? (...a) => console.log(ts(), '[debug]', ...a) : () => {};

if (argv.install || argv.uninstall) {
  try {
    if (argv.uninstall) uninstallService(log);
    else installService(argv, log);
    process.exit(0);
  } catch (err) {
    log('Error:', err.message);
    process.exit(1);
  }
}

const bridge = new AlexaRemoteMqtt({
  mqttUrl: argv.mqttUrl,
  mqttUsername: argv.mqttUsername,
  mqttPassword: argv.mqttPassword,
  topicPrefix: argv.topicPrefix,
  amazonPage: argv.amazonPage,
  alexaServiceHost: argv.alexaServiceHost,
  cookieFile: argv.cookieFile,
  proxyOwnIp: argv.proxyOwnIp,
  proxyPort: argv.proxyPort,
  pollInterval: argv.pollInterval,
  haDiscovery: argv.haDiscovery,
  haPrefix: argv.haPrefix,
  log,
  debug,
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal} received, shutting down...`);
  await bridge.stop();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

bridge.start().catch(err => {
  log('Fatal:', err.message || err);
  bridge.stop().finally(() => process.exit(1));
});
