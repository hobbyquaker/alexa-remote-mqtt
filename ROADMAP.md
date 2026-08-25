# Roadmap & implementation spec — alexa-remote-mqtt 2.0

alexa-remote-mqtt 1.0 is a "gen 2" adapter (ESM, mqtt 5, yargs 18, HA discovery, `--install`)
built **without** [mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core).
2.0 is the same bridge on top of the core lib (mqtt-smarthome spec 2.x), migrated per Phase 3 of
the [master roadmap](https://github.com/hobbyquaker/mqtt-interfaces/blob/main/ROADMAP.md)
(decisions D-n), the core's [ROADMAP](https://github.com/hobbyquaker/mqtt-interfaces-core/blob/main/ROADMAP.md)
(C-n) and the reference migration lgtv2mqtt 2.0 → 3.0 (T-n). Decisions specific to this repo are
**A-n**; open questions continue the fleet numbering at **OQ-40+**.

This file is the implementation spec: everything needed to do the change is decided here; what
still has to land in the core first is listed in §1.2 (core 0.3.0). **Status 2026-08-25: implemented,
release pending** — core 0.3.0 (G-1, G-2, G-3) is on npm, §§1-7 are done, `npm run lint` and
`npm test` are green. OQ-40 is decided as (a) and implemented (notify entities for
speak/announcement), OQ-42 is closed (template unit + per-instance `--proxy-port`, documented in
the README, no code), OQ-41 stays open with the fleet. Left to do: §8's manual smoke test against
the real account, then §9 (tag `v2.0.0`) and the master roadmap inventory.

Contents: 1 core fit & gaps · 2 decisions · 3 topics (migration table) · 4 CLI/env · 5 Home
Assistant discovery · 6 systemd/Docker · 7 implementation steps · 8 tests · 9 release · 10 open
questions.

---

## 1. Core fit & gaps

### 1.1 What core 0.2.0 already covers

| concern                                                              | 1.0 (own code)                                               | 2.0 (core)                                                                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| CLI + env, precedence, `--config-schema`                             | `bin/alexa-remote-mqtt.js` yargs `.env()`                    | `parseConfig({pkg, defaults: {name: 'alexa'}, options})` — `ALEXA_REMOTE_MQTT_*` typed env, `MQTT_*` fallback (C-4)                       |
| MQTT connect, LWT, `connected` 0/1/2, reconnect                      | `connectMqtt()`, `status/bridge/connected`                   | `createAdapter()`: `<name>/connected`, `setDeviceConnected(alexaReady)`                                                                   |
| retained status + `{val, ts, lc}` + dedupe                           | `publishDeviceAttr()` + `state` map                          | `pubStatus(item, value)` with `StatusTracker` — item may contain `/` (→ `<name>/status/<device>/<item>`)                                  |
| non-retained events                                                  | `publish(topic, v, false)`                                   | `pubStatus(item, value, {retain: false})` — **see gap G-1**                                                                               |
| `set` dispatch, plain / `{val}` payloads                             | `handleSet(topic, payload)`                                  | `onSet(parts, value, topic, raw)` — `parts = [device, command]`, `raw` keeps the untouched text for `speak`/`textCommand`                 |
| `<name>/info`, `maintenance/set/loglevel`, `maintenance/set/restart` | —                                                            | built in (C-3, C-5); `info` extras: `amazonPage`, `devices` (count), `push` (bool)                                                        |
| logger                                                               | injected `log`/`debug` closures, `console.log` with own ts   | `adapter.log` (`createLogger`): levels, journald mode, `mqtt >`/`mqtt <` for free; `alexa >`/`alexa <` prefixes are ours                  |
| HA discovery, one device per Echo                                    | `buildDiscoveryConfigs()` — per-component topics (old style) | `discovery: () => [bridge, ...echos]` (core 0.2.0 array support), device-based `<ha-prefix>/device/<id>/config`, `via_device`, auto-clear |
| discovery re-publish when the device list changes                    | once at start                                                | `discoveryTriggers: ['bridge/devices']` — the list is a status item, so it triggers (coalesced, `discoveryDelay`)                         |
| graceful shutdown                                                    | `bin/` signal handlers + `stop()`                            | core SIGINT/SIGTERM → `onShutdown` (stop pollers, `alexa.stop()`) → `connected 0`                                                         |
| `--install` / `--uninstall`                                          | `src/install.js` single unit `alexa-remote-mqtt.service`     | `createInstaller({service, envPrefix, environment, beforeStart}).handle(config)` → template unit `alexa-remote-mqtt@<name>` (§6)          |

### 1.2 Gaps → core 0.3.0 (prerequisite, do first)

- **G-1 — non-retained items are re-published retained after an MQTT reconnect.**
  `pubStatus(item, v, {retain: false})` records the item in `StatusTracker`; `republishStatus()`
  then publishes every tracked item with `retain: true`. For `last_voice_command`/`progress` that
  would turn a one-shot event into a retained value. Fix in core: `StatusTracker` remembers
  `retain` per item (`update(item, val, {retain})`), `republishStatus()` skips non-retained items
  and `payload()` stays as is. Unit test: publish with `retain:false`, reconnect, assert no
  re-publish. (lgtv2mqtt is unaffected today but benefits.)
- **G-2 — per-device availability in discovery.** `devicePayload()` always emits
  `avty` from `<name>/connected`. An Echo that is offline (`status/<device>/connected false`)
  must show as unavailable in HA. Fix in core: the device block accepts an optional
  `availability` array that replaces the default (`{id, device, components, availabilityMin,
availability}`); `entity()` unchanged (component-level `avty` in `extra` keeps working for
  single entities). Used here as:

  ```js
  availability: [
    ...availability(config.name, 2),
    {t: `${config.name}/status/${d.topic}/connected`, avty_tpl: tpl("'online' if VAL else 'offline'")},
  ],
  availability_mode: 'all',
  ```

  (`avty_mode` is a top-level discovery key; core adds it when `availability` has more than one
  entry. `tpl()` substitutes `VAL` with `value_json.val` or `value == 'true'` depending on
  `config.jsonPayloads`, see §5.)

- **G-3 — `adapter.clearStatus(item)`** (nice-to-have, not blocking): publish an empty retained
  payload and `status.delete(item)`, used when an Echo disappears from the account
  (`status/<device>/*`). Until it exists, do it locally with
  `adapter.publish(adapter.topic('status', item), '', {retain: true}); adapter.status.delete(item)`.

Everything else below works against core 0.2.0 as published.

---

## 2. Decisions

| ID   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A-1  | **2.0.0 = core migration, hard break** (D-2): new topics/items, new CLI, no legacy shims, no `--legacy-topics`. CHANGELOG carries the migration table of §3.                                                                                                                                                                                                                                                                               |
| A-2  | **`--name/-n` replaces `--topic-prefix/-t`**, default `alexa` (topics stay `alexa/...` for default installs). `--verbosity/-v` (`error`, `warn`, `info`, `debug`) replaces `--verbose`.                                                                                                                                                                                                                                                    |
| A-3  | **Item names are snake_case** (T-9, fleet-settled): `audioPlayerState → player_state`, `isMuted → mute`, `imageUrl → image_url`, `lastVoiceCommand → last_voice_command`, `lastActivity → last_activity`, `textCommand → text_command`, `playerState → player_state`. Command aliases of 1.0 (`say`, `announce`, `text`, `prev`, `skip`, `doNotDisturb`) stay as aliases; `mute` is now the item itself.                                   |
| A-4  | **Booleans are `true`/`false`** (like lgtv2mqtt 2.0 `status/mute`), no more `ON`/`OFF` strings: `mute`, `dnd`, `connected`, `shuffle`/`repeat` on `set`. `set` accepts everything `toBoolean()` accepts (`1/0`, `on/off`, `yes/no`, `true/false`).                                                                                                                                                                                         |
| A-5  | **Bridge-level state lives under the pseudo device `bridge`**: `status/bridge/devices`, `status/bridge/routines` (unchanged topics). `status/bridge/connected` is dropped in favour of `<name>/connected` (the deviation noted in the master roadmap). An Echo literally named "bridge" in the Alexa app gets its topic level suffixed `bridge_` (`topicName()`), logged at `warn`.                                                        |
| A-6  | **Devices remain addressed by Alexa app name** (`topicName()`: `/`,`+`,`#` → `_`), serial accepted on `set`, `all` for music devices — unchanged from 1.0. Per-device items are status items with a slash: `pubStatus(`${d.topic}/volume`, 50)`.                                                                                                                                                                                           |
| A-7  | **HA discovery on by default** (D-5): one HA device per Echo (core array support) + one bridge device, all `via_device` → bridge. `--no-ha-discovery` clears retained configs. The 1.0 per-component topics (`homeassistant/<component>/alexa-remote-mqtt_<serial>/<key>/config`) are **not** cleared automatically — documented one-off `mosquitto_pub -r -n` in the README.                                                              |
| A-8  | **systemd template unit** `alexa-remote-mqtt@<name>` (core installer), one instance per Amazon account; cookie at `/var/lib/alexa-remote-mqtt/<name>/cookie.json`; `beforeStart` copies an existing login from the 1.0 / echo2mqtt locations. The 1.0 single unit is not removed automatically (A-9).                                                                                                                                      |
| A-9  | **Upgrade path from 1.0 service**: `--install` detects `/etc/systemd/system/alexa-remote-mqtt.service` and warns with the exact commands (`systemctl disable --now alexa-remote-mqtt; rm /etc/systemd/system/alexa-remote-mqtt.service /etc/default/alexa-remote-mqtt`) instead of deleting (destructive, and the user may want to diff the env file).                                                                                     |
| A-10 | **`{val, ts, lc}` JSON payloads by default** (D-3). JSON-valued items (`media`, `bluetooth`, `notifications`, `last_activity`, `equalizer`, `microphone`, `progress`, `bridge/devices`, `bridge/routines`) become `{"val": {...}, "ts", "lc"}`; HA templates use `value_json.val.<field>`. `--no-json-payloads` restores 1.0-style raw JSON objects.                                                                                       |
| A-11 | **Maintenance topics on** (D-9), `--no-maintenance` to disable; README carries the security note (a broker ACL on `<name>/maintenance/#`).                                                                                                                                                                                                                                                                                                 |
| A-12 | **Mute stays emulated** (volume 0 + restore) — `set/<device>/mute true` → `preMuteVolume`, `false` → restore (`30` if unknown). Unchanged behaviour, new name.                                                                                                                                                                                                                                                                             |
| A-13 | **Logging severities** per the Phase 1 rules: push connection lost / device offline = `warn` (transition only, recovery at `info`), Amazon API errors of a poll = `warn` once per poll cycle (not per device), login proxy "open http://…" = `warn` (action required, names the URL), every rejected `set` = `warn` with topic+payload+reason (core does this in `onSet`). Raw push frames at `debug` as `alexa <`, requests as `alexa >`. |

---

## 3. Topics — migration table 1.0 → 2.0

`<name>` = `--name` (default `alexa`). Payloads are `{val, ts, lc}` JSON unless
`--no-json-payloads` (A-10); the table shows `val`.

| 1.0 topic                                                                                                                                            | 2.0 topic                                            | `val` / notes                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `alexa/status/bridge/connected` `0/1/2`                                                                                                              | `<name>/connected`                                   | `0` LWT/shutdown, `1` mqtt only, `2` mqtt + Alexa (`setDeviceConnected`)             |
| —                                                                                                                                                    | `<name>/info`                                        | core fields + `amazonPage`, `devices` (count), `push` (push connection active)       |
| `alexa/status/bridge/devices`                                                                                                                        | `<name>/status/bridge/devices`                       | unchanged list `{name, topic, serialNumber, deviceType, …}`                          |
| `alexa/status/bridge/routines`                                                                                                                       | `<name>/status/bridge/routines`                      | unchanged                                                                            |
| `…/status/<dev>/audioPlayerState`                                                                                                                    | `…/status/<dev>/player_state`                        | `PLAYING`, `PAUSED`, `IDLE`, `INTERRUPTED`, `FINISHED`                               |
| `…/status/<dev>/volume`                                                                                                                              | unchanged                                            | `0`–`100`                                                                            |
| `…/status/<dev>/isMuted` `ON/OFF`                                                                                                                    | `…/status/<dev>/mute`                                | `true`/`false` (A-4)                                                                 |
| `…/status/<dev>/title`, `artist`, `album`, `provider`                                                                                                | unchanged                                            | strings, empty when idle                                                             |
| `…/status/<dev>/imageUrl`                                                                                                                            | `…/status/<dev>/image_url`                           |                                                                                      |
| `…/status/<dev>/media`                                                                                                                               | unchanged                                            | `{state, title, artist, album, provider, image_url, media_id}` (keys snake_case too) |
| `…/status/<dev>/progress` (not retained)                                                                                                             | unchanged, `retain: false`                           | `{progress, length}` ms, ≤ every 10 s — needs G-1                                    |
| `…/status/<dev>/lastVoiceCommand` (event)                                                                                                            | `…/status/<dev>/last_voice_command`, `retain: false` | published on every utterance even if identical — needs G-1                           |
| `…/status/<dev>/lastActivity`                                                                                                                        | `…/status/<dev>/last_activity`                       | `{text, response, utterance_type, timestamp}`                                        |
| `…/status/<dev>/notifications`                                                                                                                       | unchanged                                            | array; keys snake_case (`trigger_time`, `remaining_time`)                            |
| `…/status/<dev>/dnd` `true/false`                                                                                                                    | unchanged                                            |                                                                                      |
| `…/status/<dev>/bluetooth`                                                                                                                           | unchanged                                            | `{connected, name, address, paired: [...]}`                                          |
| `…/status/<dev>/equalizer`                                                                                                                           | unchanged                                            | `{bass, mid, treble}`                                                                |
| `…/status/<dev>/microphone`                                                                                                                          | unchanged                                            | raw push payload                                                                     |
| `…/status/<dev>/connected` `true/false`                                                                                                              | unchanged                                            | Echo online (Amazon's view); feeds per-device HA availability (G-2)                  |
| `alexa/set/<dev>/play`, `pause`, `next`, `previous`                                                                                                  | `<name>/set/<dev>/…`                                 | any payload (empty allowed)                                                          |
| `…/set/<dev>/playerState`                                                                                                                            | `…/set/<dev>/player_state`                           | `PLAYING`, `PAUSED`, `play`, `pause`, `true`, `false`                                |
| `…/set/<dev>/isMuted` (`mute` alias)                                                                                                                 | `…/set/<dev>/mute`                                   | boolean (A-4); `isMuted` is **not** kept as alias (A-1, hard break)                  |
| `…/set/<dev>/textCommand`                                                                                                                            | `…/set/<dev>/text_command`                           | raw text (`raw` argument of `onSet`, not `parsePayload`'d)                           |
| `…/set/<dev>/speak`, `announcement`, `ssml`, `sound`, `tunein`, `routine`, `dnd`, `bluetooth`, `equalizer`, `refresh`, `shuffle`, `repeat`, `volume` | unchanged                                            | as 1.0; booleans per A-4; `{val}` wrapper accepted (core)                            |
| `…/set/all/<command>`                                                                                                                                | unchanged                                            | every music device; `announcement` uses the native multi-device call                 |
| —                                                                                                                                                    | `<name>/maintenance/set/loglevel`, `…/restart`       | core (A-11)                                                                          |

Items that must use `raw` (never `parsePayload`'d, because `"42"`, `"on"`, `"true"` are valid
speech): `speak`, `announcement`, `ssml`, `text_command`, `routine`, `sound`, `bluetooth`
(names), `tunein` (ids like `s25111` are strings anyway, but `{...}` JSON is parsed — use
`value` when it is an object, else `raw`).

---

## 4. CLI / env

Shared set from the core (`--mqtt-url/-u/--url`, `--mqtt-username`, `--mqtt-password`,
`--mqtt-client-id-prefix`, `--mqtt-tls-ca`, `--name/-n`, `--json-payloads`, `--ha-discovery`,
`--ha-prefix`, `--maintenance`, `--verbosity/-v`, `--install`, `--uninstall`, `--config-schema`)
plus the adapter options, all as `ALEXA_REMOTE_MQTT_<OPTION>` env vars (typed, C-4), broker
fallback `MQTT_URL`/`MQTT_USERNAME`/`MQTT_PASSWORD`/…:

| option                  | alias | type    | default                            | notes                                                                                                      |
| ----------------------- | ----- | ------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `--amazon-page`         | `-a`  | string  | `amazon.de`                        | unchanged                                                                                                  |
| `--alexa-service-host`  |       | string  | `layla.amazon.com`                 | unchanged                                                                                                  |
| `--cookie-file`         | `-c`  | string  | `~/.alexa-remote-mqtt/cookie.json` | unchanged; systemd: `/var/lib/alexa-remote-mqtt/<name>/cookie.json` via unit `Environment=`                |
| `--proxy-own-ip`        |       | string  | first non-internal IPv4            | unchanged (`localIp()` moves to `src/config.js`)                                                           |
| `--proxy-port`          |       | number  | `3001`                             | unchanged                                                                                                  |
| `--poll-interval`       | `-p`  | number  | `300`                              | unchanged, `0` = push only                                                                                 |
| ~~`--topic-prefix/-t`~~ |       |         |                                    | **removed** → `--name/-n` (A-2); env `ALEXA_REMOTE_MQTT_TOPIC_PREFIX` → `ALEXA_REMOTE_MQTT_NAME`           |
| ~~`--verbose`~~         |       |         |                                    | **removed** → `--verbosity debug` (A-2); `ALEXA_REMOTE_MQTT_VERBOSE` → `ALEXA_REMOTE_MQTT_VERBOSITY=debug` |
| `--ha-discovery`        |       | boolean | **`true`** (was `false`)           | D-5; `--no-ha-discovery`                                                                                   |

`parseConfig` is called in `src/config.js` (exported `config`, like lgtv2mqtt 3.0) with
`defaults: {name: 'alexa'}` and `examples`. `--config-schema` comes for free.

alexa-remote2's `logger` option is wired to `log.debug` (prefix `alexa <`), `proxyLogLevel`
stays `warn`; `apiUserAgentPostfix` becomes `${pkg.name}/${pkg.version}` (currently hard-coded
`alexa-remote-mqtt/0.1.0`).

---

## 5. Home Assistant discovery

`discovery: ({get}) => [...]` returns an array (core 0.2.0); it reads the device list from
`get('bridge/devices')` (undefined before the first publish → return `null`, nothing published
yet). `discoveryTriggers: ['bridge/devices']`. Ids use `discoveryId(pkg.name, …)`.

1. **Bridge device** — `id: discoveryId(pkg.name, config.name)` (= the default single-device id,
   so the fleet's `+/device/<adapter>_<name>/config` convention holds), `device: {mf: 'Amazon',
mdl: 'alexa-remote-mqtt bridge', sw: pkg.version}`, components:
   - `sensor` `devices` — `stat_t: <name>/status/bridge/devices`, `val_tpl: {{ value_json.val | length }}`
     (plain: `{{ value | length }}`), `json_attributes_topic` + `_template` `{"devices": {{ value_json.val | tojson }} }`,
     `ent_cat: diagnostic`, `ic: mdi:amazon-alexa`.
   - `binary_sensor` `push` — from `<name>/info` `push` field (`stat_t: <name>/info`,
     `val_tpl: {{ 'ON' if value_json.push else 'OFF' }}`, `dev_cla: connectivity`, diagnostic).
     Requires `publishInfo()` on push connect/disconnect (cheap, retained).
2. **One device per music-capable Echo** (`musicDevices()`, as in 1.0) —
   `id: discoveryId(pkg.name, d.serialNumber)` (serial is the stable identity, the app name can
   change), `device: {name: d.name, mf: 'Amazon', mdl: d.deviceType, via_device:
discoveryId(pkg.name, config.name)}`, `availability` per G-2, components built with
   `entity({id, name: config.name, item: `${d.topic}/<item>`, uid: '<item>', jsonPayloads, …})`
   (`uid` keeps `uniq_id` = `<id>_<item>`, without the device name; `item` carries the slash):

   | key                                   | platform      | item                 | extra                                                                                                                                                                                                                                  |
   | ------------------------------------- | ------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `player_state`                        | sensor        | `player_state`       | `ic: mdi:play-pause`                                                                                                                                                                                                                   |
   | `title` `artist` `album` `provider`   | sensor        | same                 | icons as 1.0                                                                                                                                                                                                                           |
   | `last_voice_command`                  | sensor        | `last_voice_command` | `ic: mdi:microphone-message`                                                                                                                                                                                                           |
   | `bluetooth`                           | sensor        | `bluetooth`          | `val_tpl: {{ value_json.val.name or 'disconnected' }}`, `json_attr_t` same topic, `json_attr_tpl: {{ value_json.val \| tojson }}`                                                                                                      |
   | `notifications`                       | sensor        | `notifications`      | `val_tpl: {{ value_json.val \| length }}`, `json_attr_tpl: {"items": {{ value_json.val \| tojson }} }`                                                                                                                                 |
   | `connected`                           | binary_sensor | `connected`          | `val_tpl: {{ 'ON' if value_json.val else 'OFF' }}`, `dev_cla: connectivity`, diagnostic                                                                                                                                                |
   | `volume`                              | number        | `volume`             | `command: true`, `min 0 max 100 step 1 mode slider`                                                                                                                                                                                    |
   | `mute`                                | switch        | `mute`               | `command: true`, `pl_on: 'true'`, `pl_off: 'false'`, `stat_on: true`, `stat_off: false` (val_tpl yields bool)                                                                                                                          |
   | `dnd`                                 | switch        | `dnd`                | same as mute, `ic: mdi:minus-circle`                                                                                                                                                                                                   |
   | `play` `pause` `next` `previous`      | button        | same                 | `command: true`, `pl_prs: '1'`                                                                                                                                                                                                         |
   | `text_command` `speak` `announcement` | text          | same                 | `command: true`; HA's `text` platform requires a `stat_t` — `text_command` uses `<name>/status/<dev>/last_activity` with `val_tpl: {{ value_json.val.text }}`; `speak`/`announcement` become `notify` entities (stateless) — **OQ-40** |

   With `--no-json-payloads` the templates drop `.val` — build them through one helper
   `tpl(expr)` that inserts `value_json.val`/`value_json`/`value` depending on
   `config.jsonPayloads` (like lgtv2mqtt `lib/hadiscovery.js`).

3. Non-music devices (Echo Auto, Fire TV registrations…) get **no** HA device (as 1.0); they are
   still listed in `bridge/devices` and publish `notifications`/`connected`.
4. Removed/renamed Echos: the core clears config topics that vanish from the array. Their
   `status/<dev>/*` are cleared via G-3 when the device list shrinks (compare serials).

---

## 6. systemd / Docker

`createInstaller({ service: 'alexa-remote-mqtt', envPrefix: config.$envPrefix, description:
'alexa-remote-mqtt %i - Amazon Echo to MQTT', documentation: pkg.homepage, environment:
{ALEXA_REMOTE_MQTT_COOKIE_FILE: '/var/lib/alexa-remote-mqtt/%i/cookie.json'}, beforeStart })`
— the core writes `/etc/alexa-remote-mqtt/<name>.env` with every non-meta option except
`name` (`cookieFile` included, but the unit's `Environment=` line… **loses** to
`EnvironmentFile` in systemd: `EnvironmentFile` is read after `Environment=`, so the env file
must not contain `COOKIE_FILE`). Pass `envOptions` explicitly: all adapter + shared options
except `cookieFile`, `install`, `uninstall`, `configSchema`, `name`.

`beforeStart({name, argv, stateDir, log})`:

1. target `${stateDir}/cookie.json`; if missing, look for an existing login in order:
   `argv.cookieFile`, `$SUDO_USER`'s `~/.alexa-remote-mqtt/cookie.json`, `~/.echo2mqtt/cookie.json`,
   `/var/lib/alexa-remote-mqtt/cookie.json` (1.0 service), `/var/lib/echo2mqtt/cookie.json`;
   copy, `chmod 600` (the core chowns the state dir afterwards). This is the 1.0 logic moved
   into the hook — keep the legacy candidates (AGENTS.md: deliberate).
2. if `/etc/systemd/system/alexa-remote-mqtt.service` exists → `log` the A-9 warning.
3. no login found → `log` that the unit will start the login proxy and the `journalctl -u
alexa-remote-mqtt@<name> -f` command (the proxy URL appears there at `warn`).

Unit differences to 1.0 the CHANGELOG must mention: `Restart=always` (C-5), shared
`/etc/mqtt-interfaces/broker.env`, `SyslogIdentifier=alexa-remote-mqtt@<name>`,
`StateDirectory=alexa-remote-mqtt/<name>`, env file `/etc/alexa-remote-mqtt/<name>.env`
instead of `/etc/default/alexa-remote-mqtt`.

Dockerfile: env `ALEXA_REMOTE_MQTT_MQTT_URL` stays, add `ALEXA_REMOTE_MQTT_NAME=alexa`
(explicit), `ALEXA_REMOTE_MQTT_COOKIE_FILE=/data/cookie.json` and `PROXY_OWN_IP` unchanged;
`ALEXA_REMOTE_MQTT_VERBOSITY` replaces `_VERBOSE`. `deploy.sh`: restart `alexa-remote-mqtt@*`
instead of `alexa-remote-mqtt`.

---

## 7. Implementation steps (file by file)

Prerequisite: core 0.3.0 with G-1 and G-2 (G-3 optional) released to npm; `package.json`
`"mqtt-interfaces-core": "^0.3.0"`, drop `mqtt` and `yargs` from `dependencies` (the core
brings them).

1. **`src/config.js`** (new) — `parseConfig({pkg, defaults: {name: 'alexa'}, options: {…§4},
examples})`; `localIp()` moves here. Export `config`.
2. **`src/install.js`** — replace with `createInstaller({...§6})`; keep `beforeStart` logic
   pure-testable (`findExistingLogin(candidates, fs)` exported, `unitFile`/`envFile` tests move
   to asserting the core's output contains `ALEXA_REMOTE_MQTT_COOKIE_FILE=/var/lib/alexa-remote-mqtt/%i/cookie.json`
   and no `COOKIE_FILE` in the env file).
3. **`bin/alexa-remote-mqtt.js`** — shrinks to: import config, `createInstaller(...).handle(config)`,
   `new AlexaRemoteMqtt({config, adapter})`, `adapter.start()`. Signal handling is the core's.
4. **`src/bridge.js`** — `AlexaRemoteMqtt` keeps the Alexa side (cookie, `connectAlexa`,
   `registerAlexaEvents`, pollers, `schedulePlayerRefresh`, command table) and loses the MQTT
   side:
   - constructor gets `{config, adapter}`; `this.log = adapter.log`; `this.prefix`, `connectMqtt`,
     `publish`, `state` map, `stop()`'s MQTT part → removed.
   - `publishDeviceAttr(device, item, value)` → `adapter.pubStatus(`${topicName(device.accountName)}/${item}`, value)`
     (dedupe now in `StatusTracker`; it still publishes unchanged values — that is spec behaviour,
     `lc` stays). `publish(..., false)` call sites → `pubStatus(item, v, {retain: false})`.
   - `publishDeviceList()` → `pubStatus('bridge/devices', list)`; `loadRoutines()` →
     `pubStatus('bridge/routines', list)`.
   - `status/bridge/connected` call sites → `adapter.setDeviceConnected(true)` after
     `connectAlexa()` resolves; `false` on fatal re-init failure. Push connection state →
     `adapter.publishInfo()` via the `info` function (`push: !!this.alexa?.alexahttp2Push?.connectionActive`).
   - `handleSet(topic, payload)` → `handleSet(parts, value, topic, raw)`: `const [name, command] =
[parts.slice(0, -1).join('/'), parts.at(-1)]` (device names cannot contain `/`, so
     `parts.length === 2` — warn and return otherwise). Command table keys renamed per A-3, the
     `COMMAND_ALIASES` map extended with the 1.0 camelCase names **removed** (A-1) except the
     documented aliases. Text commands use `raw`. Errors are thrown — the core logs them at `warn`.
   - `parseBool` → core `toBoolean`; `onOff()` deleted (A-4); `topicName()` stays (A-5 suffix
     rule added), `isRealDevice()` stays.
   - `start()` → called from `adapter.onMqttConnect` **once** (guard with `this.started`), so the
     login proxy/Alexa init happens after the first broker connection (the 1.0 order); `stop()`
     → `onShutdown`.
   - Logging: `this.log(...)` → `log.info/warn/debug` per A-13; `debug` prefix `alexa <` for push
     payloads, `alexa >` for `sendCommand`/`sendSequenceCommand`.
5. **`src/ha-discovery.js`** — rewrite as `discoveryModel({name, devices, jsonPayloads, pkg})`
   returning the array of §5 using `entity()`/`discoveryId()`/`availability()` from the core;
   pure, unit tested. `buildDiscoveryConfigs()` is deleted.
6. **`src/push-reassembly.js`** — unchanged (only `log` signature: takes `log.warn`).
7. **README.md** — topic tables per §3, CLI per §4, maintenance security note, HA section (device
   per Echo, bridge device, one-off cleanup of 1.0 retained configs), systemd section (template
   unit, instance name, upgrade from 1.0, `journalctl -u alexa-remote-mqtt@alexa`), "Upgrading
   from 1.0" migration table. **AGENTS.md** — update the MQTT conventions (core, `<name>/connected`,
   snake_case, booleans, `{val,ts,lc}`) and the code layout; the pointer to `../lgsb2mqtt/FLEET.md`
   becomes the master roadmap + this file.
8. **CHANGELOG.md** — `## 2.0.0 (date)` with Breaking (topics table, CLI, systemd unit, HA ids),
   Added (`info`, maintenance, `--config-schema`, `MQTT_*` fallback, typed env, per-device HA
   availability, bridge HA device), Changed (`--ha-discovery` default).
9. **Dockerfile / deploy.sh** per §6. CI unchanged (lint + test + `--help`).

---

## 8. Tests (`node:test`, no network)

- `test/config.test.js` — `parseConfig` with `argv: []` gives `name === 'alexa'`,
  `haDiscovery === true`; `ALEXA_REMOTE_MQTT_POLL_INTERVAL=60` → number; `--config-schema` lists
  `amazon-page` with `x-env`.
- `test/ha-discovery.test.js` — `discoveryModel()` with two devices returns 3 blocks (bridge +
  2), ids `alexa-remote-mqtt_alexa` / `alexa-remote-mqtt_<serial>`, `via_device` on Echos,
  `availability` has 2 entries + `availability_mode: 'all'`, `uniq_id` without device name,
  templates switch on `jsonPayloads`; `devices: undefined` → `null`.
- `test/bridge.test.js` — `topicName()` incl. the `bridge` rule; command dispatch with a fake
  adapter (`pubStatus` spy) and a fake `alexa` (`sendCommand` spy): `set/Kitchen/mute true` →
  volume 0 + `mute true` published; `set/all/announcement` → one `sendSequenceCommand` with all
  serials; `set/Kitchen/speak 42` forwards the string `"42"`; unknown device/command → throws.
- `test/install.test.js` — `findExistingLogin()` candidate order; `envFile()` from the core
  installer contains `ALEXA_REMOTE_MQTT_AMAZON_PAGE` and not `COOKIE_FILE`; `unitFile()` contains
  the `%i/cookie.json` line.
- Existing `push-reassembly.test.js` unchanged.
- Manual smoke test against the real account on the home server (`deploy.sh`): login reuse from
  `/var/lib/alexa-remote-mqtt/cookie.json`, `connected 2`, push events, `set/all/announcement`,
  HA shows one device per Echo + bridge, `maintenance/set/loglevel debug`, restart over MQTT
  comes back (`Restart=always`).

---

## 9. Release

1. core 0.3.0 (G-1, G-2[, G-3]) tagged + on npm.
2. This repo: implement §7, `npm run lint`, `npm test`, smoke test §8.
3. `package.json` `2.0.0`, CHANGELOG `## 2.0.0 (YYYY-MM-DD)`, commit, tag `v2.0.0`, push tag →
   npm + ghcr + GitHub release (existing workflow).
4. Master roadmap inventory: alexa-remote-mqtt gen 2 → 3, deviations resolved.

---

## 10. Open questions

- **OQ-40 — HA `text` entities without state**: HA's MQTT `text` platform requires `state_topic`
  (it is not optional as in 1.0, where it silently worked because the entity never got a state).
  Options: (a) point `stat_t` at `last_activity`/`last_voice_command` for `text_command` only and
  drop `speak`/`announcement` as `text` entities in favour of `notify` platform entities (HA
  2024.6+ has MQTT `notify`, exactly "send a text to a device", no state) — **preferred**; (b) a
  per-device `status/<dev>/last_spoken` item. Decide while implementing §5; the core's `entity()`
  already treats `notify` as stateless.
- **OQ-41 — `media_player` for Echos** (shares OQ-17/OQ-22): once the fleet picks the MQTT Media
  Player custom component, alexa-remote-mqtt is the third test case (`player_state`, `media`,
  `volume`, `mute`, transport buttons all exist).
- **OQ-42 — Multi-account**: the template unit allows `alexa-remote-mqtt@work` with a second
  cookie; the login proxy port (`--proxy-port`) must differ per instance — document, no code.
