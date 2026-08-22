# Agent instructions — alexa-remote-mqtt

## What this is

alexa-remote-mqtt is an MQTT interface ("bridge"/"adapter") for Amazon Echo devices, built on
[alexa-remote2](https://github.com/Apollon77/alexa-remote) and
[mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core). It logs in to the
Alexa web API (cookie/proxy login via alexa-cookie2), listens on the HTTP/2 push connection, polls
state periodically and publishes everything to an MQTT broker; commands (play/pause, volume, TTS,
announcements, routines, ...) are accepted over MQTT. It replaces a Node-RED flow based on
node-red-contrib-alexa-remote2-applestrudel.

It is one of many `xyz2mqtt` adapters by the same author (lgtv2mqtt, lgsb2mqtt, cul2mqtt,
hue2mqtt.js, hm2mqtt.js, ...), all following the
[mqtt-smarthome](https://github.com/mqtt-smarthome/mqtt-smarthome) architecture (spec 2.x).
Consistency with that convention and with the sibling adapters is a hard requirement: the shared
~80% lives in the core library, decisions for the whole fleet in the
[master roadmap](https://github.com/hobbyquaker/mqtt-interfaces) (D-n) and the core's ROADMAP
(C-n). `ROADMAP.md` in this repo is the local plan and the 2.0 implementation spec (A-n, OQ-40+);
lgtv2mqtt 3.0 is the reference migration. When in doubt, prefer the fleet-wide standard over a
local quick fix.

## MQTT conventions

Everything MQTT is the core's: `createAdapter()` owns the connection, `<name>/connected` (0/1/2
with LWT), `<name>/info`, `<name>/maintenance/set/{loglevel,restart}`, `set` dispatch, HA
discovery and the graceful shutdown. `<name>` is `--name` (default `alexa`), also the topic prefix.

- Status: `<name>/status/<device>/<item>`, retained, payload `{val, ts, lc}` (plain with
  `--no-json-payloads`). Items are **snake_case** (`player_state`, `image_url`,
  `last_voice_command`), booleans are `true`/`false`. Events (`progress`, `last_voice_command`)
  are published with `{retain: false}` and are not re-published after a reconnect.
- Bridge-level state lives under the pseudo device `bridge` (`bridge/devices`, `bridge/routines`);
  an Echo actually named "bridge" is published as `bridge_` (`topicName()`).
- Commands: `<name>/set/<device>/<command>`, plain or `{"val": …}` payloads, `all` addresses every
  music-capable device. Text commands (`speak`, `announcement`, `ssml`, `text_command`, `routine`,
  `sound`) must use the **raw** payload, never the parsed value ("42" and "true" are valid speech).
- Devices are addressed by their Alexa app name (`/`, `+`, `#` → `_`); the serial number works too.
- `handleSet()` throws on failure; the core logs it at warn with topic and payload.

The topic/payload tables in README.md are the contract — keep them in sync with `handleSet()` and
the `publishDeviceAttr()` call sites. Renaming topics or items is a breaking change: document it in
CHANGELOG.md and README.md.

## Code layout

- `bin/alexa-remote-mqtt.js` — wiring only: config, `--install`, `createAdapter()` with the
  bridge's callbacks, `adapter.start()`. Signals and shutdown are the core's.
- `src/config.js` — `parseConfig()` (yargs + typed `ALEXA_REMOTE_MQTT_*` env vars + `MQTT_*`
  fallback + `--config-schema`), adapter options in `OPTIONS`, `localIp()`. Exports the config.
- `src/bridge.js` — `AlexaRemoteMqtt`: the Alexa side only (cookie load/save, `connectAlexa`,
  `registerAlexaEvents`, pollers, `schedulePlayerRefresh`, command table, `handleSet`). It
  publishes through `adapter.pubStatus('<device>/<item>', value)`. Exported pure helpers:
  `topicName`, `isRealDevice`.
- `src/ha-discovery.js` — `discoveryModel()`: pure builder of the HA discovery model, one device
  per music-capable Echo plus a bridge device (`via_device`), per-device availability from
  `status/<device>/connected`. Templates switch on `jsonPayloads` via the local `tpl()` helper.
- `src/push-reassembly.js` — work-around wrapping alexa-remote2's HTTP/2 push `data` listener to
  reassemble JSON directives split across chunks (see "Known upstream issue" in README and
  `alexa-remote2-issue-draft.md`). Pure `findJsonEnd`/`createReassembler` are unit tested.
- `src/install.js` — `--install`/`--uninstall` via the core installer: template unit
  `alexa-remote-mqtt@<name>`, `/etc/alexa-remote-mqtt/<name>.env`,
  `/var/lib/alexa-remote-mqtt/<name>/cookie.json`. The `beforeStart` hook copies an existing login
  (`loginCandidates`/`findExistingLogin`) and warns about a leftover 1.x unit.
- `test/` — node:test unit tests (`npm test`), no extra dependencies, no network.
- `deploy.sh` — pack + install on a remote host via ssh (author's own infrastructure).
- `Dockerfile` — ghcr.io image, login data in `/data`, login proxy on port 3001.

## Style & practices

- Plain Node.js ES modules (`"type": "module"`), no build step. 2-space indentation, semicolons,
  single quotes, `{ spaced }` braces — enforced by prettier + eslint (`npm run lint`,
  `npm run format`). Note the core repo uses 4 spaces and no bracket spacing; each repo keeps its
  own style.
- Keep dependencies minimal; this runs on small always-on machines (Raspberry Pi etc.). Anything
  that is not Alexa-specific belongs in the core, not here.
- Never make default config values point at personal infrastructure (LAN IPs, hostnames).
  `deploy.sh`'s default host is the one exception and is documented as such.
- Log through `adapter.log` (`log.debug/info/warn/error`), never `console.*`. Severities: an
  unreachable device or a failed poll is `warn`, `error` is for things that need a human; raw
  traffic is `debug` with the `alexa >` / `alexa <` prefixes (`mqtt >`/`mqtt <` comes from the core).
- Breaking changes to topics, payloads, or CLI options must be called out explicitly in
  CHANGELOG.md and follow the fleet-wide standard.

## Running, testing, releasing

```
node bin/alexa-remote-mqtt.js --mqtt-url mqtt://<broker> --amazon-page amazon.de --verbosity debug
```

Lint: `npm run lint`, fix: `npm run format`. Tests: `npm test`. CI (`.github/workflows/ci.yml`)
runs lint + tests + `--help` on Node 20/22/24. Release (`.github/workflows/release.yml`): bump
`version` in package.json, add a CHANGELOG entry, commit, tag `vX.Y.Z` and push the tag —
publishes to npm (provenance, needs `NPM_TOKEN` secret), a multi-arch image to
`ghcr.io/hobbyquaker/alexa-remote-mqtt`, and a GitHub release whose notes are generated by
`.github/release-notes.js` (the matching CHANGELOG section + commits since the previous tag), so
the CHANGELOG heading must be `## X.Y.Z (date)`. `workflow_dispatch` re-releases an existing tag.
A release that needs an unreleased core change waits for that core version to be on npm.

## Known weak spots (be careful around these)

- Everything talks to an undocumented Amazon API through alexa-remote2; behaviour differs
  between regions (`--amazon-page`, `--alexa-service-host`) and changes without notice.
  There is no way to test against Amazon in CI — keep the Alexa-facing code thin and put
  logic into pure, testable functions.
- The login cookie (`cookie.json`) contains account credentials. Never log it, never commit it
  (it is git-ignored), never move its default location without a fallback for the old one
  (`loadCookie()` and `install.js` still read the 1.x and pre-release `echo2mqtt` locations —
  this is deliberate, keep it).
- The systemd unit sets `ALEXA_REMOTE_MQTT_COOKIE_FILE` via `Environment=`, so `cookieFile` must
  stay out of the instance env file: systemd reads `EnvironmentFile` _after_ `Environment=`
  (`ENV_OPTIONS` in `src/install.js`).
- `src/push-reassembly.js` monkey-patches internals of alexa-remote2 (`alexa-http2push.js`).
  Re-check it whenever alexa-remote2 is upgraded; it should become a no-op once upstream
  fixes the chunking (see `alexa-remote2-issue-draft.md`).
- Mute is emulated (volume 0 + restore), see `publishMuted()` / the `mute` command.
- Commands trigger real devices (speech, announcements on `all`). Don't run `set` commands
  against an account in use without the owner's ok.
