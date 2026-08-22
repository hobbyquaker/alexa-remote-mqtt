/**
 * Home Assistant MQTT discovery (device-based, HA >= 2024.11); the scaffold (topic, origin,
 * availability, common entity fields) comes from mqtt-interfaces-core.
 *
 * One HA device per music-capable Echo plus one device for the bridge itself; the Echos are
 * linked to it via `via_device`. HA has no MQTT media_player platform, so each Echo is a bundle
 * of entities: sensors (player state, track info, last voice command, bluetooth, timers), a
 * volume slider, mute/DND switches, transport buttons, a text entity for text commands and
 * notify entities for speak/announcement.
 */

import { availability, discoveryId, entity } from 'mqtt-interfaces-core';

const SENSORS = [
  { item: 'player_state', label: 'Player state', icon: 'mdi:play-pause' },
  { item: 'title', label: 'Title', icon: 'mdi:music-note' },
  { item: 'artist', label: 'Artist', icon: 'mdi:account-music' },
  { item: 'album', label: 'Album', icon: 'mdi:album' },
  { item: 'provider', label: 'Source', icon: 'mdi:radio' },
  { item: 'last_voice_command', label: 'Last voice command', icon: 'mdi:microphone-message' },
];

const BUTTONS = [
  { item: 'play', label: 'Play', icon: 'mdi:play' },
  { item: 'pause', label: 'Pause', icon: 'mdi:pause' },
  { item: 'next', label: 'Next', icon: 'mdi:skip-next' },
  { item: 'previous', label: 'Previous', icon: 'mdi:skip-previous' },
];

/**
 * Device block(s) + entity maps from the last known status values (for createAdapter's `discovery`).
 * The Echos come from the published device list, so nothing is announced before the first poll.
 *
 * @param {object} input
 * @param {string} input.name instance name / topic prefix
 * @param {(item: string) => *} input.get last known value of a status item
 * @param {{name: string, version: string}} input.pkg
 * @param {boolean} [input.jsonPayloads] status payloads are {val, ts, lc} JSON
 * @returns {Array<object> | null}
 */
export function discoveryModel({ name, get, pkg, jsonPayloads = true }) {
  const devices = get('bridge/devices');
  if (!Array.isArray(devices)) return null;

  // VAL is the status value; as a condition a plain payload is the string "true"
  const tpl = expr => `{{ ${expr.replace(/VAL/g, jsonPayloads ? 'value_json.val' : 'value')} }}`;
  const boolTpl = expr => `{{ ${expr.replace(/VAL/g, jsonPayloads ? 'value_json.val' : "value == 'true'")} }}`;
  const onOffTpl = boolTpl("'ON' if VAL else 'OFF'");
  const switchState = {
    stat_on: 'true',
    stat_off: 'false',
    pl_on: 'true',
    pl_off: 'false',
    val_tpl: boolTpl("'true' if VAL else 'false'"),
  };

  const bridgeId = discoveryId(pkg.name, name);
  const bridge = {
    id: bridgeId,
    // the bridge entities report the connection itself, so they stay available without Alexa
    availabilityMin: 1,
    device: { mf: 'Amazon', mdl: 'alexa-remote-mqtt bridge', sw: pkg.version },
    components: {
      devices: entity({
        id: bridgeId,
        name,
        item: 'bridge/devices',
        uid: 'devices',
        platform: 'sensor',
        label: 'Echo devices',
        icon: 'mdi:amazon-alexa',
        category: 'diagnostic',
        jsonPayloads,
        extra: {
          val_tpl: tpl('VAL | length'),
          json_attr_t: `${name}/status/bridge/devices`,
          json_attr_tpl: `{"devices": ${tpl('VAL | tojson')} }`,
        },
      }),
      push: entity({
        id: bridgeId,
        name,
        item: 'push',
        platform: 'binary_sensor',
        label: 'Push connection',
        category: 'diagnostic',
        jsonPayloads,
        // <name>/info is a flat object, not a {val, ts, lc} status item
        extra: {
          stat_t: `${name}/info`,
          val_tpl: "{{ 'ON' if value_json.push else 'OFF' }}",
          dev_cla: 'connectivity',
        },
      }),
    },
  };

  const echos = devices
    .filter(d => d.hasMusicPlayer || d.isControllable)
    .map(d => {
      const id = discoveryId(pkg.name, d.serialNumber);
      const e = (item, platform, label, extra = {}, more = {}) =>
        entity({ id, name, item: `${d.topic}/${item}`, uid: item, platform, label, jsonPayloads, ...more, extra });

      const components = {};
      for (const sensor of SENSORS) {
        components[sensor.item] = e(sensor.item, 'sensor', sensor.label, {}, { icon: sensor.icon });
      }
      components.bluetooth = e(
        'bluetooth',
        'sensor',
        'Bluetooth',
        {
          val_tpl: tpl("VAL.name or 'disconnected'"),
          json_attr_t: `${name}/status/${d.topic}/bluetooth`,
          json_attr_tpl: tpl('VAL | tojson'),
        },
        { icon: 'mdi:bluetooth-audio' },
      );
      components.notifications = e(
        'notifications',
        'sensor',
        'Timers & alarms',
        {
          val_tpl: tpl('VAL | length'),
          json_attr_t: `${name}/status/${d.topic}/notifications`,
          json_attr_tpl: `{"items": ${tpl('VAL | tojson')} }`,
        },
        { icon: 'mdi:alarm' },
      );
      components.connected = e(
        'connected',
        'binary_sensor',
        'Online',
        { val_tpl: onOffTpl, dev_cla: 'connectivity' },
        { category: 'diagnostic' },
      );
      components.volume = e(
        'volume',
        'number',
        'Volume',
        { min: 0, max: 100, step: 1, mode: 'slider' },
        { command: true, icon: 'mdi:volume-high' },
      );
      components.mute = e('mute', 'switch', 'Mute', switchState, { command: true, icon: 'mdi:volume-mute' });
      components.dnd = e('dnd', 'switch', 'Do not disturb', switchState, { command: true, icon: 'mdi:minus-circle' });
      for (const button of BUTTONS) {
        components[button.item] = e(
          button.item,
          'button',
          button.label,
          { pl_prs: '1' },
          { command: true, icon: button.icon },
        );
      }
      // HA's text platform needs a state topic; the last utterance is the closest thing to one
      components.text_command = e(
        'text_command',
        'text',
        'Text command',
        {
          stat_t: `${name}/status/${d.topic}/last_activity`,
          val_tpl: tpl('VAL.text'),
        },
        { command: true, icon: 'mdi:message-text' },
      );
      // speak/announcement have no state at all -> notify entities (stateless, HA 2024.6+)
      components.speak = e('speak', 'notify', 'Speak', {}, { command: true, icon: 'mdi:account-voice' });
      components.announcement = e(
        'announcement',
        'notify',
        'Announcement',
        {},
        { command: true, icon: 'mdi:bullhorn' },
      );

      return {
        id,
        device: { name: d.name, mf: 'Amazon', mdl: d.deviceType, via_device: bridgeId },
        // an Echo that Amazon reports as offline is unavailable on its own (G-2)
        availability: [
          ...availability(name, 2),
          {
            t: `${name}/status/${d.topic}/connected`,
            avty_tpl: boolTpl("'online' if VAL else 'offline'"),
          },
        ],
        components,
      };
    });

  return [bridge, ...echos];
}
