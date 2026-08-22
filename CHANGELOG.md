# Changelog

## 1.0.0

- Initial release.
- Status/command topics for Echo devices (player state, volume, mute, media info, voice commands,
  notifications, DND, bluetooth, equalizer, TTS/announcements, routines, TuneIn, text commands).
- Push connection with chunk reassembly work-around for alexa-remote2 8.x, periodic full state poll.
- Home Assistant MQTT discovery (`--ha-discovery`).
- `--install` / `--uninstall` systemd service, `deploy.sh`.
- eslint + prettier, CI on Node 20/22/24, release to npm and ghcr.io on `v*` tags, Dockerfile.
