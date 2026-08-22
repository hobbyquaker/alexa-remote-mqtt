/**
 * The Alexa side of the bridge: login/cookie handling, the alexa-remote2 push connection,
 * the pollers and the command dispatch. Everything MQTT is the adapter's (mqtt-interfaces-core);
 * state is published with `pubStatus('<device>/<item>', value)`.
 */

import fs from 'node:fs';
import path from 'node:path';
import AlexaRemote from 'alexa-remote2';
import { toBoolean, toVolume } from 'mqtt-interfaces-core';
import { installPushReassembly } from './push-reassembly.js';

/**
 * Make a device name safe for use as a single MQTT topic level: MQTT forbids '/', '+' and '#'
 * inside a level (everything else, spaces included, is fine). "bridge" is reserved for the
 * bridge's own items, an Echo of that name gets a suffix (A-5).
 */
export function topicName(name) {
  const level = String(name).replace(/[/+#]/g, '_').trim();
  return level === 'bridge' ? 'bridge_' : level;
}

/**
 * Real devices only. Amazon's device list also contains every Alexa app / alexa-remote
 * registration as a virtual "This Device" (deviceFamily VOX), which cannot do anything.
 */
export function isRealDevice(d) {
  return d.deviceFamily !== 'VOX' && d.accountName !== 'This Device';
}

function promisify(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (err, res) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(res)));
  });
}

const ALL = 'all';

/** Alternative command names kept from 1.0, plus snake_case spellings of the same commands. */
const COMMAND_ALIASES = {
  say: 'speak',
  announce: 'announcement',
  text: 'text_command',
  prev: 'previous',
  skip: 'next',
  doNotDisturb: 'dnd',
  do_not_disturb: 'dnd',
};

export class AlexaRemoteMqtt {
  /**
   * @param {object} opts
   * @param {object} opts.config parsed config (src/config.js)
   * @param {object} opts.adapter mqtt-interfaces-core adapter
   */
  constructor({ config, adapter }) {
    this.config = config;
    this.adapter = adapter;
    this.log = adapter.log;
    this.pkg = adapter.pkg;
    this.started = false;
    this.alexaReady = false;
    this.pollTimer = null;
    this.refreshTimers = new Map();
    this.lastMediaRef = new Map();
    this.lastProgressPublish = new Map();
    this.preMuteVolume = new Map();
    /** serial -> topic level, to clear the status items of devices that disappear */
    this.deviceTopics = new Map();
    this.routines = null;
    this.routinesLoadedAt = 0;
    this.bluetoothStates = new Map();
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Connect to Alexa. Called on the first MQTT connection (so the login proxy hint reaches the
   * broker's subscribers too) and a no-op on every later reconnect.
   */
  async start() {
    if (this.started) return;
    this.started = true;
    try {
      await this.connectAlexa();
    } catch (err) {
      this.log.error('alexa login failed:', err.message || err);
      this.adapter.shutdown('alexa login failed', 1);
      return;
    }
    this.alexaReady = true;
    this.adapter.setDeviceConnected(true);

    try {
      this.registerAlexaEvents();

      const devices = this.devices();
      const ignored = Object.keys(this.alexa.serialNumbers).length - devices.length;
      this.log.info(
        `alexa bridging ${devices.length} device(s): ${devices.map(d => `"${d.accountName}"`).join(', ')}` +
          (ignored ? ` (ignoring ${ignored} app registration(s))` : ''),
      );
      this.publishDeviceList();
      this.adapter.publishInfo();
      await this.pollAll();
      setTimeout(() => this.checkPushConnection(), 20_000).unref();
      if (this.config.pollInterval > 0) {
        this.pollTimer = setInterval(() => this.pollAll(), this.config.pollInterval * 1000);
        this.pollTimer.unref();
      }
    } catch (err) {
      // the connection itself is up, so keep running (push events still arrive) but say so
      this.log.error('alexa initial state could not be published:', err.message || err);
    }
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    clearTimeout(this.notificationTimer);
    for (const timers of this.refreshTimers.values()) for (const t of timers) clearTimeout(t);
    try {
      this.alexa?.stop();
    } catch {
      /* ignore */
    }
  }

  /** Extra fields for <name>/info. */
  infoExtra() {
    return {
      amazonPage: this.config.amazonPage,
      devices: this.alexa ? this.devices().length : 0,
      push: Boolean(this.alexa?.alexahttp2Push?.connectionActive),
    };
  }

  // ----------------------------------------------------------------- publish

  /** Publish a status item of one device: <name>/status/<device>/<item>. */
  publishDeviceAttr(device, item, value, options) {
    if (value === undefined || value === null) return;
    this.adapter.pubStatus(`${topicName(device.accountName)}/${item}`, value, options);
  }

  /**
   * Mute is emulated with volume 0 (Echo devices have no separate mute over this API),
   * so a device counts as muted when Amazon reports it muted OR its volume is 0.
   */
  publishMuted(device, amazonMuted, volume) {
    if (typeof amazonMuted !== 'boolean' && typeof volume !== 'number') return;
    this.publishDeviceAttr(device, 'mute', amazonMuted === true || volume === 0);
  }

  publishDeviceList() {
    const list = this.devices().map(d => ({
      name: d.accountName,
      topic: topicName(d.accountName),
      serialNumber: d.serialNumber,
      deviceType: d.deviceType,
      deviceFamily: d.deviceFamily,
      online: d.online !== false,
      hasMusicPlayer: Boolean(d.hasMusicPlayer),
      isControllable: Boolean(d.isControllable),
      isMultiroomDevice: Boolean(d.isMultiroomDevice),
      wakeWord: d.wakeWord || null,
    }));
    for (const d of list) {
      if (d.topic !== d.name) {
        this.log.warn(`alexa device "${d.name}" is published as "${d.topic}" (reserved or invalid topic level)`);
      }
    }
    this.forgetGoneDevices(list);
    this.adapter.pubStatus('bridge/devices', list);
  }

  /** Clear the status items of devices that are no longer in the account. */
  forgetGoneDevices(list) {
    const current = new Set(list.map(d => d.serialNumber));
    for (const [serial, topic] of this.deviceTopics) {
      if (current.has(serial)) continue;
      for (const item of [...this.adapter.status.state.keys()]) {
        if (item.startsWith(`${topic}/`)) this.adapter.clearStatus(item);
      }
      this.deviceTopics.delete(serial);
      this.log.info(`alexa device "${topic}" is gone, cleared its status topics`);
    }
    for (const d of list) this.deviceTopics.set(d.serialNumber, d.topic);
  }

  // ------------------------------------------------------------------ commands

  /**
   * <name>/set/<device>/<command>. Device names cannot contain a slash, so anything else is a
   * malformed topic. Failures are thrown: the adapter logs them at warn with topic and payload.
   */
  async handleSet(parts, value, topic, raw) {
    if (parts.length !== 2) throw new Error(`expected <name>/set/<device>/<command>`);
    const [name, item] = parts;
    const command = COMMAND_ALIASES[item] || item;
    const handler = this.commands[command];
    if (!handler) throw new Error(`unknown command "${item}"`);
    if (!this.alexaReady) throw new Error('alexa connection is not ready yet');

    if (name === ALL) {
      const devices = this.musicDevices();
      if (command === 'announcement') {
        // native multi-device announcement: one request, all devices in sync
        return this.sendSequenceCommand(
          devices.map(d => d.serialNumber),
          'announcement',
          this.requireText(raw),
        );
      }
      const results = await Promise.allSettled(devices.map(d => handler.call(this, d, value, raw)));
      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length > 0) {
        throw new Error(
          `${failed.length} of ${devices.length} device(s) failed: ${failed[0].reason?.message || failed[0].reason}`,
        );
      }
      return;
    }

    const device = this.findDeviceByTopicName(name);
    if (!device) throw new Error(`unknown device "${name}"`);
    return handler.call(this, device, value, raw);
  }

  /** Command (last topic level of <name>/set/<device>/<command>) -> handler(device, value, raw). */
  commands = {
    play: d => this.sendCommand(d, 'play'),
    pause: d => this.sendCommand(d, 'pause'),
    next: d => this.sendCommand(d, 'next'),
    previous: d => this.sendCommand(d, 'previous'),

    // "PLAYING" / "PAUSED" / "play" / "pause" / true / false - handy for toggles that publish the state name
    player_state: (d, value) => {
      const s = String(value).trim().toLowerCase();
      const play = ['playing', 'play', 'true', 'on', '1'].includes(s);
      const pause = ['paused', 'pause', 'stop', 'stopped', 'false', 'off', '0'].includes(s);
      if (!play && !pause) throw new Error(`invalid player state "${value}"`);
      return this.sendCommand(d, play ? 'play' : 'pause');
    },
    shuffle: (d, value) => this.sendCommand(d, 'shuffle', this.requireBool('shuffle', value) ? 'on' : 'off'),
    repeat: (d, value) => this.sendCommand(d, 'repeat', this.requireBool('repeat', value) ? 'on' : 'off'),

    volume: async (d, value) => {
      const volume = toVolume(value);
      if (volume === undefined) throw new Error(`invalid volume "${value}" (expected 0-100)`);
      await this.sendCommand(d, 'volume', volume);
      this.publishDeviceAttr(d, 'volume', volume);
      this.publishMuted(d, undefined, volume);
    },

    // emulated: Echo devices have no mute over this API, so mute means volume 0 and restore (A-12)
    mute: async (d, value) => {
      const mute = this.requireBool('mute', value);
      if (mute) {
        const current = Number(this.adapter.get(`${topicName(d.accountName)}/volume`));
        if (current > 0) this.preMuteVolume.set(d.serialNumber, current);
        await this.sendCommand(d, 'volume', 0);
      } else {
        await this.sendCommand(d, 'volume', this.preMuteVolume.get(d.serialNumber) || 30);
      }
      this.publishDeviceAttr(d, 'mute', mute);
    },

    tunein: async (d, value, raw) => {
      // "s25111" | {"id": "s25111", "type": "station"}
      const { id, type = 'station' } = value && typeof value === 'object' ? value : { id: this.requireText(raw) };
      if (!id) throw new Error('tunein needs a TuneIn guide id, e.g. s25111');
      await promisify(this.alexa.setTunein.bind(this.alexa), d, id, type);
      this.schedulePlayerRefresh(d);
    },

    // text is taken from the raw payload: "42", "on" and "true" are valid things to say
    text_command: (d, value, raw) => this.sendSequenceCommand(d, 'textCommand', this.requireText(raw)),
    speak: (d, value, raw) => this.sendSequenceCommand(d, 'speak', this.requireText(raw)),
    announcement: (d, value, raw) => this.sendSequenceCommand(d, 'announcement', this.requireText(raw)),
    ssml: (d, value, raw) => this.sendSequenceCommand(d, 'ssml', this.requireText(raw)),
    sound: (d, value, raw) => this.sendSequenceCommand(d, 'sound', this.requireText(raw)),

    routine: async (d, value, raw) => {
      const wanted = this.requireText(raw);
      const routine = await this.findRoutine(wanted);
      if (!routine) throw new Error(`routine "${wanted}" not found`);
      await promisify(this.alexa.executeAutomationRoutine.bind(this.alexa), d, routine);
    },

    dnd: async (d, value) => {
      const enabled = this.requireBool('dnd', value);
      await promisify(this.alexa.setDoNotDisturb.bind(this.alexa), d, enabled);
      this.publishDeviceAttr(d, 'dnd', enabled);
    },

    bluetooth: async (d, value, raw) => {
      const arg = String(raw ?? '').trim();
      if (toBoolean(value) === false || /^disconnect$/i.test(arg)) {
        await promisify(this.alexa.disconnectBluetooth.bind(this.alexa), d, undefined);
      } else {
        const paired = this.bluetoothStates.get(d.serialNumber)?.pairedDeviceList || [];
        const match = paired.find(b => b.address === arg || b.friendlyName?.toLowerCase() === arg.toLowerCase());
        const address = match?.address || (toBoolean(value) === true ? paired[0]?.address : arg);
        if (!address) throw new Error('no paired bluetooth device known; pass an address or a name');
        await promisify(this.alexa.connectBluetooth.bind(this.alexa), d, address);
      }
      setTimeout(() => this.pollBluetooth(), 2000).unref();
    },

    equalizer: async (d, value, raw) => {
      // {"bass": 2, "mid": 0, "treble": -1} | "2,0,-1"
      let bass, mid, treble;
      if (value && typeof value === 'object') {
        ({ bass, treble } = value);
        mid = value.mid ?? value.midrange;
      } else {
        [bass, mid, treble] = String(raw ?? '')
          .trim()
          .split(/[,\s;]+/)
          .map(Number);
      }
      if (![bass, mid, treble].every(Number.isFinite)) {
        throw new Error(`invalid equalizer "${raw}" (expected {"bass":0,"mid":0,"treble":0} or "0,0,0")`);
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

  requireText(raw) {
    const text = String(raw ?? '').trim();
    if (!text) throw new Error('empty payload');
    return text;
  }

  requireBool(item, value) {
    const bool = toBoolean(value);
    if (bool === undefined) throw new Error(`invalid ${item} payload "${value}" (expected true/false)`);
    return bool;
  }

  findDeviceByTopicName(name) {
    const direct = this.alexa.find(name);
    if (direct && isRealDevice(direct)) return direct;
    return this.devices().find(d => topicName(d.accountName) === name);
  }

  devices() {
    return Object.values(this.alexa.serialNumbers).filter(isRealDevice);
  }

  musicDevices() {
    return this.devices().filter(d => d.hasMusicPlayer || d.isControllable);
  }

  sendCommand(device, command, value) {
    this.log.debug('alexa >', command, device.accountName, value ?? '');
    return promisify(this.alexa.sendCommand.bind(this.alexa), device, command, value);
  }

  /** Send a routine-style sequence command, e.g. 'textCommand' = "talk to Alexa" via text. */
  sendSequenceCommand(deviceOrList, command, value) {
    this.log.debug('alexa >', command, Array.isArray(deviceOrList) ? `${deviceOrList.length} devices` : '', value);
    return promisify(this.alexa.sendSequenceCommand.bind(this.alexa), deviceOrList, command, value);
  }

  async findRoutine(nameOrId) {
    const maxAge = 10 * 60 * 1000;
    const lookup = () => {
      const wanted = nameOrId.toLowerCase();
      return this.routines.find(
        r =>
          r.automationId === nameOrId ||
          r.name?.toLowerCase() === wanted ||
          r.triggers?.some(t => t.payload?.utterance?.toLowerCase() === wanted),
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
    const list = this.routines.map(r => ({
      id: r.automationId,
      name: r.name || null,
      utterance: r.triggers?.[0]?.payload?.utterance || null,
    }));
    this.log.debug(`alexa loaded ${list.length} routines:`, list.map(r => r.name || r.utterance).join(', '));
    this.adapter.pubStatus('bridge/routines', list);
  }

  // -------------------------------------------------------------------- Alexa

  loadCookie() {
    const candidates = [this.config.cookieFile];
    // the project was called echo2mqtt before its first release: keep reading a login saved then
    if (/[\\/]\.alexa-remote-mqtt[\\/]cookie\.json$/.test(this.config.cookieFile)) {
      candidates.push(this.config.cookieFile.replace(/\.alexa-remote-mqtt([\\/]cookie\.json)$/, '.echo2mqtt$1'));
    }
    for (const file of candidates) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.log.debug('alexa loaded login from', file);
        if (file !== this.config.cookieFile) {
          this.log.info(`alexa using login from ${file}, it will be saved to ${this.config.cookieFile}`);
        }
        return data;
      } catch (err) {
        if (err.code !== 'ENOENT') this.log.warn(`alexa could not read ${file}:`, err.message);
      }
    }
    return undefined;
  }

  saveCookie() {
    if (!this.alexa.cookieData) return;
    try {
      fs.mkdirSync(path.dirname(this.config.cookieFile), { recursive: true });
      fs.writeFileSync(this.config.cookieFile, JSON.stringify(this.alexa.cookieData), {
        encoding: 'utf8',
        mode: 0o600,
      });
      this.log.debug('alexa saved login to', this.config.cookieFile);
    } catch (err) {
      this.log.warn(`alexa could not write ${this.config.cookieFile}:`, err.message);
    }
  }

  connectAlexa() {
    this.alexa = new AlexaRemote();
    this.alexa.on('cookie', () => this.saveCookie());

    const cookie = this.loadCookie();
    if (!cookie) {
      // action required, so warn: this is the one thing a user has to do to get the bridge running
      this.log.warn(
        `alexa no saved login found - open http://${this.config.proxyOwnIp}:${this.config.proxyPort}/ ` +
          'in a browser and sign in to your amazon account',
      );
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      this.alexa.init(
        {
          cookie,
          proxyOnly: true,
          proxyOwnIp: this.config.proxyOwnIp,
          proxyPort: this.config.proxyPort,
          proxyLogLevel: 'warn',
          amazonPage: this.config.amazonPage,
          alexaServiceHost: this.config.alexaServiceHost,
          usePushConnection: true,
          autoQueryActivityOnTrigger: true, // needed for ws-device-activity (last voice command)
          bluetooth: true,
          logger: (...args) => this.log.debug('alexa <', ...args),
          // Intentionally NOT overriding deviceAppName: the registration name is sent to Amazon as the
          // "Alexa app" identity, and Amazon only reliably delivers push events to the well-known default.
          apiUserAgentPostfix: `${this.pkg.name}/${this.pkg.version}`,
        },
        err => {
          // In proxy mode alexa-remote2 first reports "Please open http://..." as an error as soon
          // as the login proxy is listening, and calls back again once the browser login finished.
          if (!settled && err && /Please open http/i.test(err.message || String(err))) {
            this.log.warn('alexa waiting for browser login:', err.message || err);
            return;
          }
          // alexa-remote2 calls this callback again after every automatic cookie refresh
          if (settled) {
            if (err) {
              this.log.warn('alexa re-initialisation failed:', err.message || err);
              this.adapter.setDeviceConnected(false);
            } else {
              this.log.info('alexa connection refreshed');
              this.adapter.setDeviceConnected(true);
              this.pollAll();
            }
            return;
          }
          settled = true;
          if (err) return reject(err instanceof Error ? err : new Error(String(err)));
          this.log.info('alexa connected');
          resolve();
        },
      );
    });
  }

  /** Report the state of the Alexa push (HTTP/2) connection that delivers the live events. */
  checkPushConnection() {
    const push = this.alexa.alexahttp2Push;
    if (!push) {
      this.log.warn(
        'alexa push connection was never initialised - no live events will arrive. ' +
          'run with --verbosity debug and look for "WS-MQTT Push Connection" / "Access-Token" lines',
      );
    } else if (!push.connectionActive) {
      this.log.warn(
        'alexa push connection is not active (yet) - live events will not arrive until it is. ' +
          `retries so far: ${push.errorRetryCounter}`,
      );
    } else {
      this.log.info('alexa push connection is active - live events enabled');
    }
    this.adapter.publishInfo();
  }

  registerAlexaEvents() {
    const a = this.alexa;
    a.on('ws-connect', () => {
      this.log.info('alexa push connection established');
      this.adapter.publishInfo();
    });
    a.on('ws-disconnect', (retries, msg) => {
      this.log.warn(`alexa push connection lost (${msg}); retries: ${retries}`);
      this.adapter.publishInfo();
    });
    a.on('ws-error', err => this.log.warn('alexa push error:', err?.message || err));
    a.on('command', ev => {
      this.log.debug('alexa <', ev.command, JSON.stringify(ev.payload));
      if (ev.command === 'PUSH_MICROPHONE_STATE') this.onMicrophoneState(ev.payload);
    });
    a.on('ws-unknown-message', msg => this.log.debug('alexa < unknown message:', msg));
    a.on('ws-unknown-command', (command, payload) =>
      this.log.debug('alexa < unknown command:', command, JSON.stringify(payload)),
    );
    // alexa-remote2 parses each HTTP/2 chunk separately and silently drops messages that span
    // several chunks (all larger media events). Reassemble chunks and surface remaining failures.
    const hookPush = () => {
      const push = a.alexahttp2Push;
      if (!push) return;
      if (!push.__armHooked) {
        push.__armHooked = true;
        push.on('unexpected-response', msg => this.log.warn('alexa push message could not be parsed:', msg));
      }
      if (installPushReassembly(push, this.log.warn)) this.log.debug('alexa push chunk reassembly installed');
    };
    hookPush();
    a.on('ws-connect', hookPush);

    const dev = ev => a.find(ev.deviceSerialNumber);

    a.on('ws-audio-player-state-change', ev => {
      const device = dev(ev);
      if (!device) return;
      this.publishDeviceAttr(device, 'player_state', ev.audioPlayerState);
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
      const device = dev(ev);
      if (device) this.schedulePlayerRefresh(device);
    });
    a.on('ws-media-queue-change', ev => {
      const device = dev(ev);
      if (device) this.schedulePlayerRefresh(device);
    });

    // Progress ticks carry the media reference: a new reference means a new track.
    a.on('ws-media-progress-change', ev => {
      const device = dev(ev);
      if (!device) return;
      if (ev.mediaReferenceId && this.lastMediaRef.get(device.serialNumber) !== ev.mediaReferenceId) {
        this.lastMediaRef.set(device.serialNumber, ev.mediaReferenceId);
        this.schedulePlayerRefresh(device);
      }
      // Progress is noisy: an event (not retained), at most every 10 s per device.
      const now = Date.now();
      if (now - (this.lastProgressPublish.get(device.serialNumber) || 0) >= 10_000 && ev.mediaProgress !== null) {
        this.lastProgressPublish.set(device.serialNumber, now);
        this.publishDeviceAttr(
          device,
          'progress',
          { progress: ev.mediaProgress, length: ev.mediaLength ?? null },
          { retain: false },
        );
      }
    });

    // Newer Amazon backends send NotifyNowPlayingUpdated instead of PUSH_MEDIA_CHANGE. It has no
    // device identifier, so refresh every music-capable device (debounced per device).
    a.on('ws-now-playing-updated', ev => {
      this.log.debug('alexa < now-playing update:', ev.cause, ev.playerState, ev.mediaId);
      for (const device of this.musicDevices()) this.schedulePlayerRefresh(device);
    });

    a.on('ws-bluetooth-state-change', ev => {
      this.log.debug('alexa < bluetooth event:', ev.bluetoothEvent, ev.bluetoothEventSuccess);
      setTimeout(() => this.pollBluetooth(), 1500).unref();
    });

    a.on('ws-equilizer-state-change', ev => {
      const device = dev(ev);
      if (!device) return;
      this.publishDeviceAttr(device, 'equalizer', { bass: ev.bass, mid: ev.midrange, treble: ev.treble });
    });

    a.on('ws-notification-change', ev => {
      this.log.debug('alexa < notification change:', ev.eventType, ev.notificationId);
      clearTimeout(this.notificationTimer);
      this.notificationTimer = setTimeout(() => this.pollNotifications(), 1000);
      this.notificationTimer.unref();
    });

    a.on('ws-device-activity', activity => this.onDeviceActivity(activity));
  }

  onDeviceActivity(activity) {
    const device = this.alexa.find(activity.deviceSerialNumber);
    if (!device) return;
    const text = activity.description?.summary || '';
    const utteranceType = activity.data?.utteranceType || null;
    if (!text || utteranceType === 'WAKE_WORD_ONLY') return;
    // Every utterance is an event, even if identical to the previous one: not retained.
    this.publishDeviceAttr(device, 'last_voice_command', text, { retain: false });
    this.publishDeviceAttr(device, 'last_activity', {
      text,
      response: activity.alexaResponse || '',
      utterance_type: utteranceType,
      timestamp: activity.creationTimestamp || Date.now(),
    });
  }

  onMicrophoneState(payload) {
    const device = this.alexa.find(payload?.dopplerId?.deviceSerialNumber);
    if (!device) return;
    const { dopplerId, destinationUserId, ...rest } = payload;
    this.publishDeviceAttr(device, 'microphone', rest);
  }

  // ------------------------------------------------------------------ polling

  /** Query the full state of every device and publish it. One warning per poll cycle (A-13). */
  async pollAll() {
    const devices = this.musicDevices();
    this.log.debug(`alexa polling ${devices.length} device(s)`);
    const failures = [];
    const collect = async (what, fn) => {
      try {
        await fn();
      } catch (err) {
        failures.push(`${what}: ${err.message || err}`);
      }
    };
    await collect('volumes', () => this.pollVolumes({ rethrow: true }));
    for (const device of devices) {
      await collect(`player ${device.accountName}`, () => this.refreshPlayer(device, { rethrow: true }));
    }
    await collect('dnd', () => this.pollDnd({ rethrow: true }));
    await collect('bluetooth', () => this.pollBluetooth({ rethrow: true }));
    await collect('notifications', () => this.pollNotifications({ rethrow: true }));
    if (failures.length > 0) {
      this.log.warn(`alexa poll: ${failures.length} request(s) failed -`, failures.join('; '));
    }
  }

  /** Run an Amazon request, log at warn unless the caller collects the failures itself. */
  async poll(what, fn, { rethrow = false } = {}) {
    try {
      return await fn();
    } catch (err) {
      if (rethrow) throw err;
      this.log.warn(`alexa ${what} failed:`, err.message || err);
      return undefined;
    }
  }

  pollVolumes(options) {
    return this.poll(
      'getAllDeviceVolumes',
      async () => {
        const res = await promisify(this.alexa.getAllDeviceVolumes.bind(this.alexa));
        for (const v of res?.volumes || []) {
          const device = this.alexa.find(v.dsn);
          if (!device) continue;
          if (typeof v.speakerVolume === 'number') this.publishDeviceAttr(device, 'volume', v.speakerVolume);
          this.publishMuted(device, v.speakerMuted, v.speakerVolume);
        }
      },
      options,
    );
  }

  pollDnd(options) {
    return this.poll(
      'getDoNotDisturb',
      async () => {
        const res = await promisify(this.alexa.getDoNotDisturb.bind(this.alexa));
        for (const s of res?.doNotDisturbDeviceStatusList || []) {
          const device = this.alexa.find(s.deviceSerialNumber);
          if (device && typeof s.enabled === 'boolean') this.publishDeviceAttr(device, 'dnd', s.enabled);
        }
      },
      options,
    );
  }

  pollBluetooth(options) {
    return this.poll(
      'getBluetooth',
      async () => {
        const res = await promisify(this.alexa.getBluetooth.bind(this.alexa), false);
        for (const s of res?.bluetoothStates || []) {
          const device = this.alexa.find(s.deviceSerialNumber);
          if (!device) continue;
          this.bluetoothStates.set(device.serialNumber, s);
          const paired = (s.pairedDeviceList || []).map(b => ({
            name: b.friendlyName,
            address: b.address,
            connected: Boolean(b.connected),
            profiles: b.profiles || [],
          }));
          const active = paired.find(b => b.connected);
          this.publishDeviceAttr(device, 'bluetooth', {
            connected: Boolean(active),
            name: active?.name || '',
            address: active?.address || '',
            paired,
          });
        }
      },
      options,
    );
  }

  pollNotifications(options) {
    return this.poll(
      'getNotifications',
      async () => {
        const res = await promisify(this.alexa.getNotifications.bind(this.alexa), false);
        const byDevice = new Map();
        for (const n of res?.notifications || []) {
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
            trigger_time: n.triggerTime ? new Date(n.triggerTime).toISOString() : null,
            remaining_time: n.remainingTime ?? null, // ms, timers only
            recurring: n.recurringPattern || null,
          });
          byDevice.set(n.deviceSerialNumber, list);
        }
        for (const device of this.devices()) {
          const list = byDevice.get(device.serialNumber) || [];
          list.sort((x, y) => String(x.trigger_time || x.time).localeCompare(String(y.trigger_time || y.time)));
          this.publishDeviceAttr(device, 'notifications', list);
        }
      },
      options,
    );
  }

  /**
   * Push events for media changes arrive in bursts (queue change, media change, player state...).
   * Coalesce them into a few getPlayerInfo requests per device. Amazon's player endpoint can lag
   * behind the push event (e.g. "next track" inside a playlist starts immediately), so fetch once
   * quickly and verify again a little later.
   */
  schedulePlayerRefresh(device, delays = [1000, 4000, 10000]) {
    const key = device.serialNumber;
    for (const t of this.refreshTimers.get(key) || []) clearTimeout(t);
    this.refreshTimers.set(
      key,
      delays.map(ms => {
        const timer = setTimeout(() => this.refreshPlayer(device), ms);
        timer.unref();
        return timer;
      }),
    );
  }

  /** Fetch player info for one device and publish state, volume and now-playing media details. */
  refreshPlayer(device, options) {
    return this.poll(
      `getPlayerInfo(${device.accountName})`,
      async () => {
        const info = (await promisify(this.alexa.getPlayerInfo.bind(this.alexa), device))?.playerInfo;
        this.log.debug(`alexa < playerInfo(${device.accountName}):`, JSON.stringify(info));
        if (!info) return;

        this.publishDeviceAttr(device, 'player_state', info.state);
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
          image_url: (playing && info.mainArt?.url) || '',
          media_id: (playing && info.mediaId) || '',
        };
        for (const item of ['title', 'artist', 'album', 'provider', 'image_url']) {
          this.publishDeviceAttr(device, item, media[item]);
        }
        this.publishDeviceAttr(device, 'media', media);
      },
      options,
    );
  }
}
