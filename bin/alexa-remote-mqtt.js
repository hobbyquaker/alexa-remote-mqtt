#!/usr/bin/env node

import { createAdapter } from 'mqtt-interfaces-core';
import pkg from '../package.json' with { type: 'json' };
import config from '../src/config.js';
import { handle as handleInstall } from '../src/install.js';
import { AlexaRemoteMqtt } from '../src/bridge.js';
import { discoveryModel } from '../src/ha-discovery.js';

handleInstall(config);

let bridge;

const adapter = createAdapter({
  pkg,
  config,
  deviceLabel: 'alexa',
  info: () => bridge.infoExtra(),
  discovery: ({ get }) => discoveryModel({ name: config.name, get, pkg, jsonPayloads: config.jsonPayloads }),
  // the Echos are announced from the published device list
  discoveryTriggers: ['bridge/devices'],
  onSet: (parts, value, topic, raw) => bridge.handleSet(parts, value, topic, raw),
  // the Alexa login (and its proxy hint) starts once the broker is there
  onMqttConnect: () => bridge.start(),
  onShutdown: () => bridge.stop(),
});

bridge = new AlexaRemoteMqtt({ config, adapter });

adapter.start();
