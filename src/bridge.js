import fs from 'node:fs';
import path from 'node:path';
import AlexaRemote from 'alexa-remote2';
import mqtt from 'mqtt';
import { installPushReassembly } from './push-reassembly.js';
import { buildDiscoveryConfigs } from './ha-discovery.js';

/**
 * Make a device name safe for use as a single MQTT topic level.
 * MQTT forbids '/', '+' and '#' inside a topic level; everything else (incl. spaces) is fine.
 */
export function topicName(name) {
  return String(name).replace(/[/+#]/g, '_').trim();
}

export function parseBool(payload) {
  const p = String(payload).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes', 'enable', 'enabled'].includes(p)) return true;
  if (['0', 'false', 'off', 'no', 'disable', 'disabled', ''].includes(p)) return false;
  return null;
}

export function onOff(b) {
  return b ? 'ON' : 'OFF';
}

function promisify(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (err, res) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(res)));
  });
}

const ALL = 'all';

export function isRealDevice(d) {
  return d.deviceFamily !== 'VOX' && d.accountName !== 'This Device';
}

/** Alternative command names, mostly mirroring the status topic names. */
const COMMAND_ALIASES = {
  mute: 'isMuted',
  audioPlayerState: 'playerState',
  doNotDisturb: 'dnd',
  prev: 'previous',
  skip: 'next',
  say: 'speak',
  announce: 'announcement',
  text: 'textCommand',
};

export class AlexaRemoteMqtt {
  /**
   * @param {object} opts
   * @param {string} opts.mqttUrl
   * @param {string} [opts.mqttUsername]
   * @param {string} [opts.mqttPassword]
   * @param {string} opts.topicPrefix        e.g. "alexa"
   * @param {string} opts.cookieFile         where alexa-remote2 registration data is persisted
   * @param {string} opts.amazonPage         e.g. "amazon.de"
   * @param {string} [opts.alexaServiceHost] e.g. "layla.amazon.com"
   * @param {string} opts.proxyOwnIp         IP of this machine, used for the one-time login proxy
   * @param {number} opts.proxyPort
   * @param {number} opts.pollInterval       seconds between full state polls, 0 = disabled
   * @param {boolean} [opts.haDiscovery]     publish Home Assistant MQTT discovery configs
   * @param {string} [opts.haPrefix]         Home Assistant discovery prefix (default "homeassistant")
   * @param {(...a:any[])=>void} opts.log
   * @param {(...a:any[])=>void} opts.debug
   */
  constructor(opts) {
    this.opts = opts;
    this.log = opts.log;
    this.debug = opts.debug;
    this.prefix = opts.topicPrefix.replace(/\/+$/, '');
    this.alexaReady = false;
    this.pollTimer = null;
    /** serialNumber -> last published attributes, used to suppress duplicate publishes */
    this.state = new Map();
    this.refreshTimers = new Map();
    this.lastMediaRef = new Map();
    this.lastProgressPublish = new Map();
    this.preMuteVolume = new Map();
    this.routines = null;
    this.routinesLoadedAt = 0;
    this.bluetoothStates = new Map();
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    this.connectMqtt();
    await this.connectAlexa();
    this.alexaReady = true;
    this.registerAlexaEvents();
    this.publish(`${this.prefix}/status/bridge/connected`, '2');
    const devices = this.devices();
    const ignored = Object.keys(this.alexa.serialNumbers).length - devices.length;
    this.log(
      `Bridging ${devices.length} device(s): ${devices.map(d => `"${d.accountName}"`).join(', ')}` +
        (ignored ? ` (ignoring ${ignored} app registration(s))` : ''),
    );
    this.publishDeviceList();
    if (this.opts.haDiscovery) this.publishHaDiscovery();
    await this.pollAll();
    setTimeout(() => this.checkPushConnection(), 20_000).unref();
    if (this.opts.pollInterval > 0) {
      this.pollTimer = setInterval(
        () => this.pollAll().catch(e => this.log('Poll failed:', e.message)),
        this.opts.pollInterval * 1000,
      );
    }
  }

  async stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const timers of this.refreshTimers.values()) for (const t of timers) clearTimeout(t);
    try {
      this.alexa?.stop();
    } catch {
      /* ignore */
    }
    if (this.mqtt) {
      await new Promise(resolve =>
        this.mqtt.publish(`${this.prefix}/status/bridge/connected`, '0', { retain: true }, () => resolve()),
      );
      await new Promise(resolve => this.mqtt.end(false, {}, resolve));
    }
  }

  // --------------------------------------------------------------------- MQTT

  connectMqtt() {
    const { mqttUrl, mqttUsername, mqttPassword } = this.opts;
    this.mqtt = mqtt.connect(mqttUrl, {
      username: mqttUsername,
      password: mqttPassword,
      clientId: `alexa-remote-mqtt_${Math.random().toString(16).slice(2, 10)}`,
      will: { topic: `${this.prefix}/status/bridge/connected`, payload: '0', retain: true, qos: 0 },
    });
    this.mqtt.on('connect', () => {
      this.log(`MQTT connected to ${mqttUrl}`);
      this.publish(`${this.prefix}/status/bridge/connected`, this.alexaReady ? '2' : '1');
      const sub = `${this.prefix}/set/+/+`;
      this.mqtt.subscribe(sub, err => {
        if (err) this.log('MQTT subscribe failed:', err.message);
        else this.log(`MQTT subscribed to ${sub}`);
      });
    });
    this.mqtt.on('reconnect', () => this.debug('MQTT reconnecting...'));
    this.mqtt.on('close', () => this.debug('MQTT connection closed'));
    this.mqtt.on('error', err => this.log('MQTT error:', err.message));
    this.mqtt.on('message', (topic, payload) => {
      this.handleSet(topic, payload.toString()).catch(err => this.log(`Error handling ${topic}:`, err.message));
    });
  }

  publish(topic, value, retain = true) {
    if (!this.mqtt) return;
    const payload = typeof value === 'string' ? value : JSON.stringify(value);
    this.debug(`-> ${topic} = ${payload}`);
    this.mqtt.publish(topic, payload, { retain });
  }

  deviceTopic(device, attr) {
    return `${this.prefix}/status/${topicName(device.accountName)}/${attr}`;
  }

  /**
   * Mute is emulated with volume 0 (Echo devices have no separate mute over this API),
   * so a device counts as muted when Amazon reports it muted OR its volume is 0.
   */
  publishMuted(device, amazonMuted, volume) {
    if (typeof amazonMuted !== 'boolean' && typeof volume !== 'number') return;
    this.publishDeviceAttr(device, 'isMuted', onOff(amazonMuted === true || volume === 0));
  }

  /** Publish a device attribute only if it changed since the last publish. */
  publishDeviceAttr(device, attr, value) {
    if (value === undefined || value === null) return;
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    const key = device.serialNumber;
    const last = this.state.get(key) || {};
    if (last[attr] === str) return;
    last[attr] = str;
    this.state.set(key, last);
    this.publish(this.deviceTopic(device, attr), str);
  }

  publishDeviceList() {
    const list = this.devices().map(d => ({
      name: d.accountName,
      topic: topicName(d.accountName),
      serialNumber: d.serialNumber,
      deviceType: d.deviceType,
      deviceFamily: d.deviceFamily,
      online: d.online !== false,
      hasMusicPlayer: !!d.hasMusicPlayer,
      isControllable: !!d.isControllable,
      isMultiroomDevice: !!d.isMultiroomDevice,
      wakeWord: d.wakeWord || null,
    }));
    this.publish(`${this.prefix}/status/bridge/devices`, JSON.stringify(list));
  }

  publishHaDiscovery() {
    const configs = buildDiscoveryConfigs({
      prefix: this.prefix,
      haPrefix: this.opts.haPrefix || 'homeassistant',
      devices: this.musicDevices().map(d => ({
        name: d.accountName,
        topic: topicName(d.accountName),
        serialNumber: d.serialNumber,
        deviceType: d.deviceType,
      })),
    });
    for (const { topic, config } of configs) this.publish(topic, JSON.stringify(config));
    this.log(`Published ${configs.length} Home Assistant discovery configs`);
  }

  // ------------------------------------------------------------------ commands

  async handleSet(topic, payload) {
    const rest = topic.slice(`${this.prefix}/set/`.length);
    const idx = rest.lastIndexOf('/');
    if (idx < 0) return;
    const name = rest.slice(0, idx);
    const command = rest.slice(idx + 1);
    if (!this.alexaReady) {
      this.log(`Ignoring ${topic}: Alexa connection not ready`);
      return;
    }
    const handler = this.commands[command] || this.commands[COMMAND_ALIASES[command]];
    if (!handler) {
      this.log(`Unsupported command "${command}" in ${topic}`);
      return;
    }
    this.log(`<- ${topic}${payload ? ` (${payload})` : ''}`);

    if (name === ALL) {
      const devices = this.musicDevices();
      if (command === 'announcement') {
        // Native multi-device announcement: one request, all devices in sync.
        await this.sendSequenceCommand(
          devices.map(d => d.serialNumber),
          'announcement',
          payload.trim(),
        );
        return;
      }
      await Promise.all(
        devices.map(d =>
          handler.call(this, d, payload).catch(err => this.log(`${command} failed for ${d.accountName}:`, err.message)),
        ),
      );
      return;
    }

    const device = this.findDeviceByTopicName(name);
    if (!device) {
      this.log(`Unknown device "${name}" in ${topic}`);
      return;
    }
    await handler.call(this, device, payload);
  }

  /** Command name (last topic level of alexa/set/<device>/<command>) -> handler(device, payload). */
  commands = {
    play: d => this.sendCommand(d, 'play'),
    pause: d => this.sendCommand(d, 'pause'),
    next: d => this.sendCommand(d, 'next'),
    previous: d => this.sendCommand(d, 'previous'),
    // "PLAYING" / "PAUSED" / "play" / "pause" / true / false - handy for toggles that publish the state name.
    playerState: (d, p) => {
      const s = String(p).trim().toLowerCase();
      const play = ['playing', 'play', 'true', 'on', '1'].includes(s);
      const pause = ['paused', 'pause', 'stop', 'stopped', 'false', 'off', '0'].includes(s);
      if (!play && !pause) throw new Error(`invalid player state "${p}"`);
      return this.sendCommand(d, play ? 'play' : 'pause');
    },
    shuffle: (d, p) => this.sendCommand(d, 'shuffle', parseBool(p) ? 'on' : 'off'),
    repeat: (d, p) => this.sendCommand(d, 'repeat', parseBool(p) ? 'on' : 'off'),

    volume: async (d, p) => {
      const vol = Number(p);
      if (!Number.isFinite(vol) || vol < 0 || vol > 100) throw new Error(`invalid volume "${p}" (expected 0-100)`);
      await this.sendCommand(d, 'volume', Math.round(vol));
    },

    isMuted: async (d, p) => {
      const mute = parseBool(p);
      if (mute === null) throw new Error(`invalid isMuted payload "${p}" (expected ON/OFF)`);
      const current = Number(this.state.get(d.serialNumber)?.volume);
      if (mute) {
        if (current > 0) this.preMuteVolume.set(d.serialNumber, current);
        await this.sendCommand(d, 'volume', 0);
      } else {
        await this.sendCommand(d, 'volume', this.preMuteVolume.get(d.serialNumber) || 30);
      }
      this.publishDeviceAttr(d, 'isMuted', onOff(mute));
    },

    tunein: async (d, p) => {
      // "s25111" | {"id":"s25111","type":"station"}
      let id = p.trim();
      let type = 'station';
      if (id.startsWith('{')) ({ id, type = 'station' } = JSON.parse(id));
      if (!id) throw new Error('tunein needs a TuneIn guide id, e.g. s25111');
      await promisify(this.alexa.setTunein.bind(this.alexa), d, id, type);
      this.schedulePlayerRefresh(d);
    },

    textCommand: (d, p) => this.sendSequenceCommand(d, 'textCommand', this.requireText(p)),
    speak: (d, p) => this.sendSequenceCommand(d, 'speak', this.requireText(p)),
    announcement: (d, p) => this.sendSequenceCommand(d, 'announcement', this.requireText(p)),
    ssml: (d, p) => this.sendSequenceCommand(d, 'ssml', this.requireText(p)),
    sound: (d, p) => this.sendSequenceCommand(d, 'sound', this.requireText(p)),

    routine: async (d, p) => {
      const routine = await this.findRoutine(this.requireText(p));
      if (!routine) throw new Error(`routine "${p}" not found`);
      await promisify(this.alexa.executeAutomationRoutine.bind(this.alexa), d, routine);
    },

    dnd: async (d, p) => {
      const enabled = parseBool(p);
      if (enabled === null) throw new Error(`invalid dnd payload "${p}"`);
      await promisify(this.alexa.setDoNotDisturb.bind(this.alexa), d, enabled);
      this.publishDeviceAttr(d, 'dnd', enabled);
    },

    bluetooth: async (d, p) => {
      const arg = p.trim();
      if (parseBool(arg) === false || /^disconnect$/i.test(arg)) {
        await promisify(this.alexa.disconnectBluetooth.bind(this.alexa), d, undefined);
      } else {
        const paired = this.bluetoothStates.get(d.serialNumber)?.pairedDeviceList || [];
        const match = paired.find(b => b.address === arg || b.friendlyName?.toLowerCase() === arg.toLowerCase());
        const address = match?.address || (parseBool(arg) === true ? paired[0]?.address : arg);
        if (!address) throw new Error('no paired bluetooth device known; pass an address or name');
        await promisify(this.alexa.connectBluetooth.bind(this.alexa), d, address);
      }
      setTimeout(() => this.pollBluetooth().catch(() => {}), 2000);
    },

    equalizer: async (d, p) => {
      // {"bass":2,"mid":0,"treble":-1} | "2,0,-1"
      let bass, mid, treble;
      const s = p.trim();
      if (s.startsWith('{')) {
        const o = JSON.parse(s);
        ({ bass, treble } = o);
        mid = o.mid ?? o.midrange;
      } else {
        [bass, mid, treble] = s.split(/[,\s;]+/).map(Number);
      }
      await promisify(this.alexa.setEqualizerSettings.bind(this.alexa), d, bass, mid, treble);
      this.publishDeviceAttr(d, 'equalizer', { bass, mid, treble });
    },

    refresh: async d => {
      await this.refreshPlayer(d);
      await this.pollVolumes();
      await this.pollDnd();
      await this.pollBluetooth();
      await this.pollNotifications();
    },
  };

  requireText(p) {
    const text = String(p).trim();
    if (!text) throw new Error('empty payload');
    return text;
  }

  findDeviceByTopicName(name) {
    const direct = this.alexa.find(name);
    if (direct) return direct;
    return this.devices().find(d => topicName(d.accountName) === name);
  }

  /**
   * Real devices only. Amazon's device list also contains every Alexa app / alexa-remote
   * registration as a virtual "This Device" (deviceFamily VOX), which cannot do anything.
   */
  devices() {
    return Object.values(this.alexa.serialNumbers).filter(isRealDevice);
  }

  musicDevices() {
    return this.devices().filter(d => d.hasMusicPlayer || d.isControllable);
  }

  sendCommand(device, command, value) {
    return promisify(this.alexa.sendCommand.bind(this.alexa), device, command, value);
  }

  /** Send a routine-style sequence command, e.g. 'textCommand' = "talk to Alexa" via text. */
  sendSequenceCommand(deviceOrList, command, value) {
    return promisify(this.alexa.sendSequenceCommand.bind(this.alexa), deviceOrList, command, value);
  }

  async findRoutine(nameOrId) {
    const maxAge = 10 * 60 * 1000;
    const lookup = () => {
      const q = nameOrId.toLowerCase();
      return this.routines.find(
        r =>
          r.automationId === nameOrId ||
          r.name?.toLowerCase() === q ||
          r.triggers?.some(t => t.payload?.utterance?.toLowerCase() === q),
      );
    };
    if (!this.routines || Date.now() - this.routinesLoadedAt > maxAge) await this.loadRoutines();
    let routine = lookup();
    if (!routine && Date.now() - this.routinesLoadedAt > 5000) {
      // maybe newly created
      await this.loadRoutines();
      routine = lookup();
    }
    return routine;
  }

  async loadRoutines() {
    const res = await promisify(this.alexa.getAutomationRoutines.bind(this.alexa), 0);
    this.routines = Array.isArray(res) ? res : [];
    this.routinesLoadedAt = Date.now();
    this.debug(
      `Loaded ${this.routines.length} routines: ${this.routines
        .map(r => r.name || r.triggers?.[0]?.payload?.utterance)
        .filter(Boolean)
        .join(', ')}`,
    );
    this.publish(
      `${this.prefix}/status/bridge/routines`,
      JSON.stringify(
        this.routines.map(r => ({
          id: r.automationId,
          name: r.name || null,
          utterance: r.triggers?.[0]?.payload?.utterance || null,
        })),
      ),
    );
  }

  // -------------------------------------------------------------------- Alexa

  loadCookie() {
    const candidates = [this.opts.cookieFile];
    // Project was renamed from echo2mqtt: keep picking up a login saved under the old name.
    if (/[\\/]\.alexa-remote-mqtt[\\/]cookie\.json$/.test(this.opts.cookieFile)) {
      candidates.push(this.opts.cookieFile.replace(/\.alexa-remote-mqtt([\\/]cookie\.json)$/, '.echo2mqtt$1'));
    }
    for (const file of candidates) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.debug(`Loaded registration data from ${file}`);
        if (file !== this.opts.cookieFile)
          this.log(`Using legacy login from ${file}; it will be saved to ${this.opts.cookieFile}`);
        return data;
      } catch (err) {
        if (err.code !== 'ENOENT') this.log(`Could not read ${file}:`, err.message);
      }
    }
    return undefined;
  }

  saveCookie() {
    if (!this.alexa.cookieData) return;
    try {
      fs.mkdirSync(path.dirname(this.opts.cookieFile), { recursive: true });
      fs.writeFileSync(this.opts.cookieFile, JSON.stringify(this.alexa.cookieData), { encoding: 'utf8', mode: 0o600 });
      this.debug(`Saved registration data to ${this.opts.cookieFile}`);
    } catch (err) {
      this.log(`Could not write ${this.opts.cookieFile}:`, err.message);
    }
  }

  connectAlexa() {
    this.alexa = new AlexaRemote();
    this.alexa.on('cookie', () => this.saveCookie());

    const cookie = this.loadCookie();
    if (!cookie) {
      this.log('No saved login found. A one-time login proxy will be started -');
      this.log(`open http://${this.opts.proxyOwnIp}:${this.opts.proxyPort}/ in a browser and sign in to Amazon.`);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      this.alexa.init(
        {
          cookie,
          proxyOnly: true,
          proxyOwnIp: this.opts.proxyOwnIp,
          proxyPort: this.opts.proxyPort,
          proxyLogLevel: 'warn',
          amazonPage: this.opts.amazonPage,
          alexaServiceHost: this.opts.alexaServiceHost,
          usePushConnection: true,
          autoQueryActivityOnTrigger: true, // needed for ws-device-activity (last voice command)
          bluetooth: true,
          logger: this.debug,
          // Intentionally NOT overriding deviceAppName: the registration name is sent to Amazon as the
          // "Alexa app" identity, and Amazon only reliably delivers push events to the well-known default.
          apiUserAgentPostfix: 'alexa-remote-mqtt/0.1.0',
        },
        err => {
          // In proxy mode alexa-remote2 first reports "Please open http://..." as an error as soon
          // as the login proxy is listening, and calls back again once the browser login finished.
          if (!settled && err && /Please open http/i.test(err.message || String(err))) {
            this.log('Waiting for browser login:', err.message || err);
            return;
          }
          // alexa-remote2 calls this callback again after every automatic cookie refresh.
          if (settled) {
            if (err) this.log('Alexa re-initialisation failed:', err.message || err);
            else {
              this.log('Alexa connection refreshed');
              this.pollAll().catch(() => {});
            }
            return;
          }
          settled = true;
          if (err) return reject(err instanceof Error ? err : new Error(String(err)));
          this.log('Alexa connected');
          resolve();
        },
      );
    });
  }

  /** Report the state of the Alexa push (HTTP/2) connection that delivers the live events. */
  checkPushConnection() {
    const push = this.alexa.alexahttp2Push;
    if (!push) {
      this.log(
        'WARNING: Alexa push connection was never initialised - no live events will arrive. ' +
          'Run with -v and look for "WS-MQTT Push Connection" / "Access-Token" lines.',
      );
    } else if (!push.connectionActive) {
      this.log(
        'WARNING: Alexa push connection is not active (yet) - live events will not arrive until it is. ' +
          `Retries so far: ${push.errorRetryCounter}. Run with -v for details.`,
      );
    } else {
      this.log('Alexa push connection is active - live events enabled');
    }
  }

  registerAlexaEvents() {
    const a = this.alexa;
    a.on('ws-connect', () => this.log('Alexa push connection established'));
    a.on('ws-disconnect', (retries, msg) => this.log(`Alexa push connection lost (${msg}); retries: ${retries}`));
    a.on('ws-error', err => this.log('Alexa push error:', err?.message || err));
    a.on('command', ev => {
      this.debug('push command:', ev.command, JSON.stringify(ev.payload));
      if (ev.command === 'PUSH_MICROPHONE_STATE') this.onMicrophoneState(ev.payload);
    });
    a.on('ws-unknown-message', msg => this.debug('push unknown message:', msg));
    a.on('ws-unknown-command', (command, payload) =>
      this.debug('push unknown command:', command, JSON.stringify(payload)),
    );
    // alexa-remote2 parses each HTTP/2 chunk separately and silently drops messages that span
    // several chunks (all larger media events). Reassemble chunks and surface remaining failures.
    const hookPush = () => {
      const push = a.alexahttp2Push;
      if (!push) return;
      if (!push.__armHooked) {
        push.__armHooked = true;
        push.on('unexpected-response', msg => this.log('Push message could not be parsed:', msg));
      }
      if (installPushReassembly(push, this.log)) this.debug('Push chunk reassembly installed');
    };
    hookPush();
    a.on('ws-connect', hookPush);

    const dev = ev => a.find(ev.deviceSerialNumber);

    a.on('ws-audio-player-state-change', ev => {
      const device = dev(ev);
      if (!device) return;
      this.publishDeviceAttr(device, 'audioPlayerState', ev.audioPlayerState);
      this.schedulePlayerRefresh(device);
    });

    a.on('ws-volume-change', ev => {
      const device = dev(ev);
      if (!device) return;
      if (typeof ev.volume === 'number') this.publishDeviceAttr(device, 'volume', ev.volume);
      this.publishMuted(device, ev.isMuted, ev.volume);
    });

    a.on('ws-device-connection-change', ev => {
      const device = dev(ev);
      if (!device) return;
      this.publishDeviceAttr(device, 'connected', ev.connectionState === 'ONLINE');
    });

    // Track/source changes: the push event only carries a media reference, so fetch the details.
    a.on('ws-media-change', ev => {
      const d = dev(ev);
      if (d) this.schedulePlayerRefresh(d);
    });
    a.on('ws-media-queue-change', ev => {
      const d = dev(ev);
      if (d) this.schedulePlayerRefresh(d);
    });

    // Progress ticks carry the media reference: a new reference means a new track.
    a.on('ws-media-progress-change', ev => {
      const device = dev(ev);
      if (!device) return;
      if (ev.mediaReferenceId && this.lastMediaRef.get(device.serialNumber) !== ev.mediaReferenceId) {
        this.lastMediaRef.set(device.serialNumber, ev.mediaReferenceId);
        this.schedulePlayerRefresh(device);
      }
      // Progress is noisy: non-retained, at most every 10 s per device.
      const now = Date.now();
      if (now - (this.lastProgressPublish.get(device.serialNumber) || 0) >= 10_000 && ev.mediaProgress !== null) {
        this.lastProgressPublish.set(device.serialNumber, now);
        this.publish(
          this.deviceTopic(device, 'progress'),
          JSON.stringify({ progress: ev.mediaProgress, length: ev.mediaLength ?? null }),
          false,
        );
      }
    });

    // Newer Amazon backends send NotifyNowPlayingUpdated instead of PUSH_MEDIA_CHANGE. It has no
    // device identifier, so refresh every music-capable device (debounced per device).
    a.on('ws-now-playing-updated', ev => {
      this.debug('now-playing update:', ev.cause, ev.playerState, ev.mediaId);
      for (const device of this.musicDevices()) this.schedulePlayerRefresh(device);
    });

    a.on('ws-bluetooth-state-change', ev => {
      this.debug('bluetooth event:', ev.bluetoothEvent, ev.bluetoothEventSuccess);
      setTimeout(() => this.pollBluetooth().catch(() => {}), 1500);
    });

    a.on('ws-equilizer-state-change', ev => {
      const device = dev(ev);
      if (!device) return;
      this.publishDeviceAttr(device, 'equalizer', { bass: ev.bass, mid: ev.midrange, treble: ev.treble });
    });

    a.on('ws-notification-change', ev => {
      this.debug('notification change:', ev.eventType, ev.notificationId);
      clearTimeout(this.notificationTimer);
      this.notificationTimer = setTimeout(() => this.pollNotifications().catch(() => {}), 1000);
    });

    a.on('ws-device-activity', activity => this.onDeviceActivity(activity));
  }

  onDeviceActivity(activity) {
    const device = this.alexa.find(activity.deviceSerialNumber);
    if (!device) return;
    const text = activity.description?.summary || '';
    const utteranceType = activity.data?.utteranceType || null;
    if (!text || utteranceType === 'WAKE_WORD_ONLY') return;
    const info = {
      text,
      response: activity.alexaResponse || '',
      utteranceType,
      timestamp: activity.creationTimestamp || Date.now(),
    };
    // Every utterance is an event, even if identical to the previous one: publish unconditionally.
    this.publish(this.deviceTopic(device, 'lastVoiceCommand'), text, false);
    this.publish(this.deviceTopic(device, 'lastActivity'), JSON.stringify(info));
  }

  onMicrophoneState(payload) {
    const device = this.alexa.find(payload?.dopplerId?.deviceSerialNumber);
    if (!device) return;
    const { dopplerId, destinationUserId, ...rest } = payload;
    this.publishDeviceAttr(device, 'microphone', rest);
  }

  // ------------------------------------------------------------------ polling

  /** Query the full state of every device and publish it. */
  async pollAll() {
    const devices = this.musicDevices();
    this.debug(`Polling ${devices.length} device(s)`);
    await this.pollVolumes();
    for (const device of devices) await this.refreshPlayer(device);
    await this.pollDnd();
    await this.pollBluetooth();
    await this.pollNotifications();
  }

  async pollVolumes() {
    try {
      const res = await promisify(this.alexa.getAllDeviceVolumes.bind(this.alexa));
      const volumes = res?.volumes || [];
      this.debug('allDeviceVolumes:', JSON.stringify(volumes));
      for (const v of volumes) {
        const device = this.alexa.find(v.dsn);
        if (!device) continue;
        if (typeof v.speakerVolume === 'number') this.publishDeviceAttr(device, 'volume', v.speakerVolume);
        this.publishMuted(device, v.speakerMuted, v.speakerVolume);
      }
    } catch (err) {
      this.log('getAllDeviceVolumes failed:', err.message);
    }
  }

  async pollDnd() {
    try {
      const res = await promisify(this.alexa.getDoNotDisturb.bind(this.alexa));
      for (const s of res?.doNotDisturbDeviceStatusList || []) {
        const device = this.alexa.find(s.deviceSerialNumber);
        if (device && typeof s.enabled === 'boolean') this.publishDeviceAttr(device, 'dnd', s.enabled);
      }
    } catch (err) {
      this.log('getDoNotDisturb failed:', err.message);
    }
  }

  async pollBluetooth() {
    try {
      const res = await promisify(this.alexa.getBluetooth.bind(this.alexa), false);
      for (const s of res?.bluetoothStates || []) {
        const device = this.alexa.find(s.deviceSerialNumber);
        if (!device) continue;
        this.bluetoothStates.set(device.serialNumber, s);
        const paired = (s.pairedDeviceList || []).map(b => ({
          name: b.friendlyName,
          address: b.address,
          connected: !!b.connected,
          profiles: b.profiles || [],
        }));
        const active = paired.find(b => b.connected);
        this.publishDeviceAttr(device, 'bluetooth', {
          connected: !!active,
          name: active?.name || '',
          address: active?.address || '',
          paired,
        });
      }
    } catch (err) {
      this.log('getBluetooth failed:', err.message);
    }
  }

  async pollNotifications() {
    try {
      const res = await promisify(this.alexa.getNotifications.bind(this.alexa), false);
      const all = res?.notifications || [];
      const byDevice = new Map();
      for (const n of all) {
        if (!n.deviceSerialNumber || (n.status === 'OFF' && n.type === 'Timer')) continue;
        const list = byDevice.get(n.deviceSerialNumber) || [];
        list.push({
          id: n.notificationIndex || n.id,
          type: n.type, // Timer | Alarm | Reminder | MusicAlarm
          status: n.status, // ON | OFF | PAUSED
          label: n.reminderLabel || n.timerLabel || n.alarmLabel || '',
          time: n.alarmTime
            ? new Date(n.alarmTime).toISOString()
            : n.originalDate && n.originalTime
              ? `${n.originalDate}T${n.originalTime}`
              : null,
          triggerTime: n.triggerTime ? new Date(n.triggerTime).toISOString() : null,
          remainingTime: n.remainingTime ?? null, // ms, timers only
          recurring: n.recurringPattern || null,
        });
      }
      for (const device of this.devices()) {
        const list = byDevice.get(device.serialNumber) || [];
        list.sort((x, y) => String(x.triggerTime || x.time).localeCompare(String(y.triggerTime || y.time)));
        this.publishDeviceAttr(device, 'notifications', list);
      }
    } catch (err) {
      this.log('getNotifications failed:', err.message);
    }
  }

  /**
   * Push events for media changes arrive in bursts (queue change, media change, player state...).
   * Coalesce them into a few getPlayerInfo requests per device. Amazon's player endpoint can lag
   * behind the push event (e.g. "next track" inside a playlist starts immediately), so fetch once
   * quickly and verify again a little later; publishes are deduplicated.
   */
  schedulePlayerRefresh(device, delays = [1000, 4000, 10000]) {
    const key = device.serialNumber;
    for (const t of this.refreshTimers.get(key) || []) clearTimeout(t);
    this.refreshTimers.set(
      key,
      delays.map(ms =>
        setTimeout(() => {
          this.refreshPlayer(device).catch(() => {});
        }, ms),
      ),
    );
  }

  /** Fetch player info for one device and publish state, volume and now-playing media details. */
  async refreshPlayer(device) {
    let info;
    try {
      info = (await promisify(this.alexa.getPlayerInfo.bind(this.alexa), device))?.playerInfo;
    } catch (err) {
      this.log(`getPlayerInfo(${device.accountName}) failed:`, err.message);
      return;
    }
    this.debug(`playerInfo(${device.accountName}):`, JSON.stringify(info));
    if (!info) return;

    this.publishDeviceAttr(device, 'audioPlayerState', info.state);
    if (info.volume) {
      if (typeof info.volume.volume === 'number') this.publishDeviceAttr(device, 'volume', info.volume.volume);
      this.publishMuted(device, info.volume.muted, info.volume.volume);
    }
    this.publishDeviceAttr(device, 'connected', device.online !== false);

    const playing = info.state && info.state !== 'IDLE' && info.state !== 'FINISHED';
    const media = {
      state: info.state ?? null,
      title: (playing && info.infoText?.title) || '',
      artist: (playing && info.infoText?.subText1) || '',
      album: (playing && info.infoText?.subText2) || '',
      provider: (playing && (info.provider?.providerDisplayName || info.provider?.providerName)) || '',
      imageUrl: (playing && info.mainArt?.url) || '',
      mediaId: (playing && info.mediaId) || '',
    };
    for (const attr of ['title', 'artist', 'album', 'provider', 'imageUrl']) {
      this.publishDeviceAttr(device, attr, media[attr]);
    }
    this.publishDeviceAttr(device, 'media', media);
  }
}
