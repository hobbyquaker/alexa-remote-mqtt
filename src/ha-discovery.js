/**
 * Home Assistant MQTT discovery configs for one Echo device.
 * HA has no MQTT media_player platform, so each Echo is exposed as a set of entities
 * (sensors, number, switches, buttons, text inputs) grouped under one HA device.
 */

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * @param {object} p
 * @param {string} p.prefix    alexa-remote-mqtt topic prefix, e.g. "alexa"
 * @param {string} p.haPrefix  HA discovery prefix, e.g. "homeassistant"
 * @param {{name:string, topic:string, serialNumber:string, deviceType:string}[]} p.devices
 * @returns {{topic:string, config:object}[]}
 */
export function buildDiscoveryConfigs({ prefix, haPrefix, devices }) {
  const out = [];
  const availability = [
    { topic: `${prefix}/status/bridge/connected`, payload_available: '2', payload_not_available: '0' },
  ];

  for (const d of devices) {
    const status = `${prefix}/status/${d.topic}`;
    const set = `${prefix}/set/${d.topic}`;
    const device = {
      identifiers: [`alexa-remote-mqtt_${d.serialNumber}`],
      name: d.name,
      manufacturer: 'Amazon',
      model: d.deviceType,
      via_device: 'alexa-remote-mqtt_bridge',
    };
    const base = (component, key, cfg) => {
      const objectId = `${slug(d.name)}_${key}`;
      out.push({
        topic: `${haPrefix}/${component}/alexa-remote-mqtt_${d.serialNumber}/${key}/config`,
        config: {
          name: cfg.name,
          unique_id: `alexa-remote-mqtt_${d.serialNumber}_${key}`,
          object_id: objectId,
          device,
          availability,
          ...cfg,
        },
      });
    };

    base('sensor', 'state', {
      name: 'Player state',
      state_topic: `${status}/audioPlayerState`,
      icon: 'mdi:play-pause',
    });
    base('sensor', 'title', { name: 'Title', state_topic: `${status}/title`, icon: 'mdi:music-note' });
    base('sensor', 'artist', { name: 'Artist', state_topic: `${status}/artist`, icon: 'mdi:account-music' });
    base('sensor', 'album', { name: 'Album', state_topic: `${status}/album`, icon: 'mdi:album' });
    base('sensor', 'provider', { name: 'Source', state_topic: `${status}/provider`, icon: 'mdi:radio' });
    base('sensor', 'last_voice_command', {
      name: 'Last voice command',
      state_topic: `${status}/lastVoiceCommand`,
      icon: 'mdi:microphone-message',
    });
    base('sensor', 'bluetooth', {
      name: 'Bluetooth',
      state_topic: `${status}/bluetooth`,
      value_template: '{{ value_json.name or "disconnected" }}',
      json_attributes_topic: `${status}/bluetooth`,
      icon: 'mdi:bluetooth-audio',
    });
    base('sensor', 'notifications', {
      name: 'Timers & alarms',
      state_topic: `${status}/notifications`,
      value_template: '{{ value_json | length }}',
      json_attributes_topic: `${status}/notifications`,
      json_attributes_template: '{"items": {{ value }} }',
      icon: 'mdi:alarm',
    });
    base('binary_sensor', 'connected', {
      name: 'Online',
      state_topic: `${status}/connected`,
      payload_on: 'true',
      payload_off: 'false',
      device_class: 'connectivity',
    });
    base('number', 'volume', {
      name: 'Volume',
      state_topic: `${status}/volume`,
      command_topic: `${set}/volume`,
      min: 0,
      max: 100,
      step: 1,
      mode: 'slider',
      icon: 'mdi:volume-high',
    });
    base('switch', 'mute', {
      name: 'Mute',
      state_topic: `${status}/isMuted`,
      command_topic: `${set}/isMuted`,
      state_on: 'ON',
      state_off: 'OFF',
      payload_on: 'ON',
      payload_off: 'OFF',
      icon: 'mdi:volume-mute',
    });
    base('switch', 'dnd', {
      name: 'Do not disturb',
      state_topic: `${status}/dnd`,
      command_topic: `${set}/dnd`,
      state_on: 'true',
      state_off: 'false',
      payload_on: 'on',
      payload_off: 'off',
      icon: 'mdi:minus-circle',
    });
    base('button', 'play', { name: 'Play', command_topic: `${set}/play`, payload_press: '1', icon: 'mdi:play' });
    base('button', 'pause', { name: 'Pause', command_topic: `${set}/pause`, payload_press: '1', icon: 'mdi:pause' });
    base('button', 'next', { name: 'Next', command_topic: `${set}/next`, payload_press: '1', icon: 'mdi:skip-next' });
    base('button', 'previous', {
      name: 'Previous',
      command_topic: `${set}/previous`,
      payload_press: '1',
      icon: 'mdi:skip-previous',
    });
    base('text', 'text_command', {
      name: 'Text command',
      command_topic: `${set}/textCommand`,
      icon: 'mdi:message-text',
    });
    base('text', 'speak', { name: 'Speak', command_topic: `${set}/speak`, icon: 'mdi:account-voice' });
    base('text', 'announcement', { name: 'Announcement', command_topic: `${set}/announcement`, icon: 'mdi:bullhorn' });
  }
  return out;
}
