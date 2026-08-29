# Changelog

## 2.0.0 (2026-08-25)

alexa-remote-mqtt now runs on [mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core)
(mqtt-smarthome spec 2.x), like the other adapters of the fleet. This is a hard break: topics,
payloads, CLI options and the systemd service changed, there are no compatibility shims.
See "Upgrading from 1.x" in the README for the full migration table and the one-off cleanup of the
1.x Home Assistant discovery topics.

### Changed

- mqtt-interfaces-core 0.6.0: `--config-schema` marks `--mqtt-password` as secret and declares
  `--cookie-file` as a file (`x-file`, binary — shown, not edited); `package.json` carries the
  `mqttInterfaces` field (`needs: network-host` for the login proxy) so she's Services page can
  describe the adapter. she lists adapters by their dependency on the core — no keyword needed.

### Breaking

- `alexa/status/bridge/connected` is now `alexa/connected` (same 0/1/2 semantics, LWT).
- Status payloads are `{"val": …, "ts": …, "lc": …}` JSON by default; `--no-json-payloads`
  restores plain values.
- Items are snake_case: `audioPlayerState` → `player_state`, `imageUrl` → `image_url`,
  `lastVoiceCommand` → `last_voice_command`, `lastActivity` → `last_activity`,
  `textCommand` → `text_command`; the keys inside `media`, `last_activity` and
  `notifications` follow.
- Booleans are `true`/`false` everywhere; `isMuted` (`ON`/`OFF`) is now `mute`.
- `--topic-prefix`/`-t` → `--name`/`-n` (default `alexa` as before),
  `--verbose`/`-v` → `--verbosity <level>`.
- Home Assistant discovery is on by default and device-based: one HA device per Echo plus a bridge
  device, one `<ha-prefix>/device/<id>/config` topic each. The 1.x per-entity config topics are
  not cleared automatically.
- `--install` installs the template service `alexa-remote-mqtt@<name>` with
  `/etc/alexa-remote-mqtt/<name>.env` and `/var/lib/alexa-remote-mqtt/<name>/cookie.json`
  (`Restart=always`, `SyslogIdentifier`, shared `/etc/mqtt-interfaces/broker.env`). The 1.x
  unit is left alone; `--install` copies its login and prints how to remove it.
- Requires Node.js ^20.19, ^22.12 or >= 24.

### Added

- `alexa/info` (retained): version, spec, host, pid, uptime plus `amazonPage`, the number of
  bridged devices and whether the push connection is up.
- `alexa/maintenance/set/loglevel` and `.../restart` (`--no-maintenance` to disable).
- `--config-schema`, typed environment variables for every option and the shared
  `MQTT_URL`/`MQTT_USERNAME`/`MQTT_PASSWORD` fallback.
- `--mqtt-client-id-prefix`, `--mqtt-tls-ca`, `--json-payloads`, `--maintenance`.
- Home Assistant: a bridge device (device count, push connection), per-device availability from
  `status/<device>/connected`, a text entity for text commands and notify entities for
  speak/announcement.
- Status topics of an Echo that disappeared from the account are cleared.
- Several instances side by side (one Amazon account each): `alexa-remote-mqtt@work` with its own
  `--name` and `--proxy-port`.

### Changed

- Poll failures are reported once per poll cycle instead of once per device; the login proxy URL
  is logged at `warn` so it is visible at any log level.

## 1.0.1 (2026-08-22)

- Release workflow: create a GitHub release with generated notes (CHANGELOG section + commits),
  `workflow_dispatch` to re-release an existing tag, npm publish skipped when the version is already published.
- Fix file modes in the repository (only `bin/` script and `deploy.sh` executable).
- README: drop the author-only "Deploy to a server" chapter.

## 1.0.0 (2026-08-22)

- Initial release.
- Status/command topics for Echo devices (player state, volume, mute, media info, voice commands,
  notifications, DND, bluetooth, equalizer, TTS/announcements, routines, TuneIn, text commands).
- Push connection with chunk reassembly work-around for alexa-remote2 8.x, periodic full state poll.
- Home Assistant MQTT discovery (`--ha-discovery`).
- `--install` / `--uninstall` systemd service, `deploy.sh`.
- eslint + prettier, CI on Node 20/22/24, release to npm and ghcr.io on `v*` tags, Dockerfile.
