# Agent instructions — alexa-remote-mqtt

## What this is

alexa-remote-mqtt is an MQTT interface ("bridge"/"adapter") for Amazon Echo devices, built on
[alexa-remote2](https://github.com/Apollon77/alexa-remote). It logs in to the Alexa web API
(cookie/proxy login via alexa-cookie2), listens on the HTTP/2 push connection, polls state
periodically and publishes everything to an MQTT broker; commands (play/pause, volume, TTS,
announcements, routines, ...) are accepted over MQTT. It replaces a Node-RED flow based on
node-red-contrib-alexa-remote2-applestrudel.

It is one of many `xyz2mqtt` adapters by the same author (lgsb2mqtt, lgtv2mqtt, hue2mqtt.js,
hm2mqtt.js, ...). All of them follow the
[mqtt-smarthome](https://github.com/mqtt-smarthome/mqtt-smarthome) architecture. Consistency
with that convention and with the sibling adapters is a hard requirement — the fleet-wide
modernization/unification effort is tracked in `../lgsb2mqtt/FLEET.md` (decisions, spec, core
lib plan). When in doubt, prefer the fleet-wide standard over a local quick fix.

## MQTT conventions

Topic structure is `<prefix>/<function>/<device>/<item>` with a configurable prefix
(default `alexa`, `--topic-prefix`). `<device>` is the name from the Alexa app with
`/`, `+`, `#` replaced by `_` (`topicName()` in `src/bridge.js`); the serial number is accepted
too, and `all` addresses every music-capable device for commands.

- `<prefix>/status/bridge/connected` — retained, LWT: `0` offline, `1` MQTT only,
  `2` MQTT + Alexa.
- `<prefix>/status/bridge/devices`, `.../routines` — retained JSON lists.
- `<prefix>/status/<device>/<item>` — state, retained except for one-shot items
  (`progress`, `lastVoiceCommand`). Plain values, `ON`/`OFF` for booleans of the media
  player, JSON objects for compound state (`media`, `notifications`, `bluetooth`, ...).
- `<prefix>/set/<device>/<item>` — commands, never retained. Aliases in `COMMAND_ALIASES`.
- QoS 0. Duplicate publishes are suppressed via the `state` map (last published attributes).

The full topic/payload table is in README.md — keep it in sync with `handleSet()` and the
`publishDeviceAttr()` call sites. Renaming topics or items is a breaking change: document in
CHANGELOG.md and README.md.

## Code layout

- `bin/alexa-remote-mqtt.js` — CLI (yargs, every option also via `ALEXA_REMOTE_MQTT_*` env
  vars, `--install`/`--uninstall`), signal handling, creates `AlexaRemoteMqtt`.
- `src/bridge.js` — `AlexaRemoteMqtt` class: MQTT connection, cookie load/save, alexa-remote2
  init + event registration (`registerAlexaEvents`), pollers (`pollAll`, `pollVolumes`,
  `pollDnd`, `pollBluetooth`, `pollNotifications`), player refresh after commands
  (`schedulePlayerRefresh`), command dispatch (`handleSet`). Exported pure helpers:
  `topicName`, `parseBool`, `onOff`, `isRealDevice`.
- `src/push-reassembly.js` — work-around wrapping alexa-remote2's HTTP/2 push `data` listener
  to reassemble JSON directives split across chunks (see "Known upstream issue" in README and
  `alexa-remote2-issue-draft.md`). Pure `findJsonEnd`/`createReassembler` are unit tested.
- `src/ha-discovery.js` — `buildDiscoveryConfigs()`: pure builder of Home Assistant MQTT
  discovery configs (one HA device per Echo, entities for sensors/number/switch/button/text).
- `src/install.js` — `--install`/`--uninstall` as systemd service `alexa-remote-mqtt`
  (`/etc/default/alexa-remote-mqtt`, `/var/lib/alexa-remote-mqtt/cookie.json`, system user
  `alexa-remote-mqtt`). Pure `envFile`/`unitFile` are unit tested.
- `test/` — node:test unit tests (`npm test`), no extra dependencies, no network.
- `deploy.sh` — pack + install on a remote host via ssh (author's own infrastructure).
- `Dockerfile` — ghcr.io image, login data in `/data`, login proxy on port 3001.

## Style & practices

- Plain Node.js ES modules (`"type": "module"`), no build step. 2-space indentation,
  semicolons, single quotes, `{ spaced }` braces — enforced by prettier + eslint
  (`npm run lint`, `npm run format`).
- Keep dependencies minimal; this runs on small always-on machines (Raspberry Pi etc.).
- Never make default config values point at personal infrastructure (LAN IPs, hostnames).
  `deploy.sh`'s default host is the one exception and is documented as such.
- Log via the injected `log`/`debug` functions, not `console.*` directly (outside `bin/`).
- Breaking changes to topics, payloads, or CLI options must be called out explicitly in
  CHANGELOG.md and follow the fleet-wide standard from FLEET.md.

## Running, testing, releasing

```
node bin/alexa-remote-mqtt.js --mqtt-url mqtt://<broker> --amazon-page amazon.de -v
```

Lint: `npm run lint`, fix: `npm run format`. Tests: `npm test`. CI (`.github/workflows/ci.yml`)
runs lint + tests + `--help` on Node 20/22/24. Release (`.github/workflows/release.yml`): bump
`version` in package.json, add a CHANGELOG entry, commit, tag `vX.Y.Z` and push the tag —
publishes to npm (provenance, needs `NPM_TOKEN` secret) and a multi-arch image to
`ghcr.io/hobbyquaker/alexa-remote-mqtt`.

## Known weak spots (be careful around these)

- Everything talks to an undocumented Amazon API through alexa-remote2; behaviour differs
  between regions (`--amazon-page`, `--alexa-service-host`) and changes without notice.
  There is no way to test against Amazon in CI — keep the Alexa-facing code thin and put
  logic into pure, testable functions.
- The login cookie (`cookie.json`) contains account credentials. Never log it, never commit it
  (it is git-ignored), never move its default location without a fallback for the old one (`loadCookie()` and
  `install.js` still read the pre-release `echo2mqtt` locations — this is deliberate, keep it).
- `src/push-reassembly.js` monkey-patches internals of alexa-remote2 (`alexa-http2push.js`).
  Re-check it whenever alexa-remote2 is upgraded; it should become a no-op once upstream
  fixes the chunking (see `alexa-remote2-issue-draft.md`).
- Mute is emulated (volume 0 + restore), see `publishMuted()`/`handleSet('isMuted')`.
- Commands trigger real devices (speech, announcements on `all`). Don't run `set` commands
  against an account in use without the owner's ok.
