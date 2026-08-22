# alexa-remote-mqtt

Node.js CLI that bridges Amazon Echo devices to MQTT, built on
[alexa-remote2](https://www.npmjs.com/package/alexa-remote2) and
[mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core).
It follows the [mqtt-smarthome](https://github.com/mqtt-smarthome/mqtt-smarthome) convention and
is a lightweight replacement for a Node-RED flow using
[node-red-contrib-alexa-remote2-applestrudel](https://github.com/bbindreiter/node-red-contrib-alexa-remote2-applestrudel).

> **Upgrading from 1.x?** Topics, payloads and the CLI changed — see
> [Upgrading from 1.x](#upgrading-from-1x).

## Topics

`alexa` is the instance name (`--name`, also the topic prefix). `<device>` is the name shown in
the Alexa app (`/`, `+`, `#` replaced with `_`); the serial number works too, and for commands
`all` addresses every music-capable device at once.

Status payloads are `{"val": …, "ts": …, "lc": …}` JSON (`ts` = time published, `lc` = last
change); `--no-json-payloads` publishes the plain value instead. They are retained unless noted.
`set` payloads may be a plain value or `{"val": …}`.

| Topic                            | Payload                                                                |
| -------------------------------- | ---------------------------------------------------------------------- |
| `alexa/connected`                | `0` offline (LWT), `1` MQTT only, `2` MQTT + Alexa                     |
| `alexa/info`                     | JSON about the running instance, incl. `amazonPage`, `devices`, `push` |
| `alexa/status/bridge/devices`    | list of devices (name, topic, serial, type, capabilities)              |
| `alexa/status/bridge/routines`   | list of Alexa routines (after the first use of the `routine` command)  |
| `alexa/maintenance/set/loglevel` | `error` / `warn` / `info` / `debug` at runtime (`--no-maintenance`)    |
| `alexa/maintenance/set/restart`  | graceful restart (systemd starts the service again)                    |

### Status: `alexa/status/<device>/…`

| Item                       | Value                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `player_state`             | `PLAYING`, `PAUSED`, `IDLE`, `INTERRUPTED`, `FINISHED`                                                |
| `volume`                   | `0`-`100`                                                                                             |
| `mute`                     | `true` / `false` (volume 0 counts as muted)                                                           |
| `title`, `artist`, `album` | current track / station info (empty when idle)                                                        |
| `provider`                 | source, e.g. `TuneIn`, `Spotify`, `Amazon Music`                                                      |
| `image_url`                | cover art URL                                                                                         |
| `media`                    | `{state, title, artist, album, provider, image_url, media_id}`                                        |
| `progress`                 | `{progress, length}` in ms — **event, not retained**, at most every 10 s                              |
| `last_voice_command`       | text spoken to this device (without wake word) — **event, not retained**                              |
| `last_activity`            | `{text, response, utterance_type, timestamp}` of the last utterance                                   |
| `notifications`            | timers/alarms/reminders: `[{id, type, status, label, time, trigger_time, remaining_time, recurring}]` |
| `dnd`                      | Do-Not-Disturb `true` / `false`                                                                       |
| `bluetooth`                | `{connected, name, address, paired: [{name, address, connected, profiles}]}`                          |
| `equalizer`                | `{bass, mid, treble}` (push only, after a change)                                                     |
| `microphone`               | raw microphone-state push payload                                                                     |
| `connected`                | device online `true` / `false`                                                                        |

### Commands: `alexa/set/<device>/…`

| Item                                | Payload                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| `play`, `pause`, `next`, `previous` | any (may be empty)                                                                      |
| `player_state`                      | `PLAYING` / `PAUSED` (or `play` / `pause`, `true` / `false`)                            |
| `shuffle`, `repeat`                 | `true` / `false`                                                                        |
| `volume`                            | `0`-`100`                                                                               |
| `mute`                              | `true` / `false` — emulated as volume 0 and restore                                     |
| `tunein`                            | TuneIn guide id, e.g. `s25111`, or `{"id":"p12345","type":"show"}`                      |
| `text_command`                      | text as if spoken to Alexa, e.g. `play SWR3`, `next track`, `set a timer for 5 minutes` |
| `speak`                             | text-to-speech on the device                                                            |
| `announcement`                      | announcement with chime; `alexa/set/all/announcement` plays on all devices in sync      |
| `ssml`                              | SSML, must start with `<speak>`                                                         |
| `sound`                             | Amazon sound id, e.g. `amzn_sfx_doorbell_chime_01`                                      |
| `routine`                           | Alexa routine by name, trigger utterance or id                                          |
| `dnd`                               | `true` / `false`                                                                        |
| `bluetooth`                         | paired device name or address to connect, `false` to disconnect                         |
| `equalizer`                         | `{"bass":2,"mid":0,"treble":-1}` or `2,0,-1` (range usually -6..6)                      |
| `refresh`                           | re-poll all state of this device now                                                    |

Aliases: `say` (`speak`), `announce` (`announcement`), `text` (`text_command`), `prev`
(`previous`), `skip` (`next`), `do_not_disturb` (`dnd`). Text commands (`speak`, `announcement`,
`ssml`, `text_command`, `routine`, `sound`) take the payload as it is, so `42` or `true` are said
as written.

State updates arrive instantly via the Alexa push connection; additionally the full state is
polled every `--poll-interval` seconds (default 300) to resynchronise.

### Home Assistant

MQTT discovery is **on by default** (`--no-ha-discovery` disables it and clears what was
announced). Every music-capable Echo becomes one HA device linked to a bridge device, with
sensors (player state, title, artist, album, source, last voice command, bluetooth, timers),
a volume slider, mute/DND switches, transport buttons, a text entity for text commands and
notify entities for speak/announcement. An Echo that Amazon reports as offline shows as
unavailable on its own.

## Install & run

Requires Node.js ^20.19, ^22.12 or >= 24.

```sh
npm install -g alexa-remote-mqtt
alexa-remote-mqtt --mqtt-url mqtt://broker.local --amazon-page amazon.de
```

From a checkout: `npm install && npm link` (or `npm start -- …`). Lint with `npm run lint`, test with `npm test`.

### Docker

Images are published to `ghcr.io/hobbyquaker/alexa-remote-mqtt` (`latest`, `X.Y`, `X.Y.Z`). Mount a volume
for the login data and publish the login-proxy port for the first start:

```sh
docker run -d --name alexa-remote-mqtt -v alexa-remote-mqtt:/data -p 3001:3001 \
  -e ALEXA_REMOTE_MQTT_MQTT_URL=mqtt://broker.local -e ALEXA_REMOTE_MQTT_AMAZON_PAGE=amazon.de \
  ghcr.io/hobbyquaker/alexa-remote-mqtt
```

Inside the container `--proxy-own-ip` defaults to `127.0.0.1`; open `http://<docker-host>:3001/` for the login.

### First start: login

On the first start no Amazon login exists yet. alexa-remote-mqtt starts a local login proxy and logs
a URL like `http://192.168.1.10:3001/` (at `warn`, so it is visible at any log level). Open it in
a browser (on the same network), sign in with your Amazon account, and the login is stored in
`~/.alexa-remote-mqtt/cookie.json` (override with `--cookie-file`). Subsequent starts reuse and
auto-refresh it.

`--proxy-own-ip` must be the IP address (not hostname) under which you reach the machine
running alexa-remote-mqtt; it defaults to the first non-internal IPv4 address.

**WSL2 / Docker:** the auto-detected IP is the VM's/container's internal address, which your
browser can't reach. Pass `--proxy-own-ip 127.0.0.1` and open `http://127.0.0.1:3001/` on the
host (WSL2 forwards localhost ports; for Docker publish port 3001), or use a host IP that is
actually routed to the process (e.g. WSL2 mirrored networking mode).

### Run as a systemd service

```sh
sudo alexa-remote-mqtt --install --name alexa --mqtt-url mqtt://broker --amazon-page amazon.de --proxy-own-ip 192.168.1.10
```

`--install` sets up the template service `alexa-remote-mqtt@<name>`, so a second Amazon account is
just another instance (with its own `--proxy-port`):

- `/etc/alexa-remote-mqtt/<name>.env` — the given options as `ALEXA_REMOTE_MQTT_*` variables;
  edit and `systemctl restart alexa-remote-mqtt@<name>`.
- `/etc/mqtt-interfaces/broker.env` — optional, shared by all mqtt-interfaces adapters
  (`MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`).
- `/var/lib/alexa-remote-mqtt/<name>/cookie.json` — the login. An existing one (`--cookie-file`,
  the invoking user's `~/.alexa-remote-mqtt/cookie.json` or a 1.x service) is copied there;
  otherwise the service starts the login proxy: `journalctl -u alexa-remote-mqtt@<name> -f`.

`sudo alexa-remote-mqtt --uninstall --name <name>` removes the instance and keeps its login.

Since the maintenance topics can restart the process and speak on your devices, restrict
`alexa/maintenance/#` and `alexa/set/#` with a broker ACL if the broker is not on a trusted
network — or run with `--no-maintenance`.

## Options

```
-u, --mqtt-url               MQTT broker URL                       [default: "mqtt://localhost"]
    --mqtt-username          MQTT username
    --mqtt-password          MQTT password
    --mqtt-client-id-prefix  Prefix for the MQTT client id
    --mqtt-tls-ca            CA certificate file for mqtts://
-n, --name                   Instance name, also the topic prefix          [default: "alexa"]
-a, --amazon-page            Amazon domain of your account                 [default: "amazon.de"]
    --alexa-service-host     Alexa API host                        [default: "layla.amazon.com"]
-c, --cookie-file            File to persist the Amazon login
                                              [default: "~/.alexa-remote-mqtt/cookie.json"]
    --proxy-own-ip           IP of this machine for the login proxy        [default: auto]
    --proxy-port             Port of the login proxy                       [default: 3001]
-p, --poll-interval          Seconds between full state polls, 0 = push only  [default: 300]
    --json-payloads          {val, ts, lc} status payloads   [default: true, --no-json-payloads]
    --ha-discovery           Home Assistant MQTT discovery     [default: true, --no-ha-discovery]
    --ha-prefix              Home Assistant discovery prefix    [default: "homeassistant"]
    --maintenance            Accept maintenance topics         [default: true, --no-maintenance]
-v, --verbosity              Log level: error, warn, info, debug           [default: "info"]
    --install / --uninstall  Install/remove the systemd service alexa-remote-mqtt@<name>
    --config-schema          Print the JSON Schema of all options and exit
```

Every option can also be given as an environment variable with the prefix `ALEXA_REMOTE_MQTT_`,
e.g. `ALEXA_REMOTE_MQTT_MQTT_URL=mqtt://broker.local`; the broker settings fall back to the
unprefixed `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`.

## Example

```sh
mosquitto_sub -v -t 'alexa/#'
mosquitto_pub -t 'alexa/set/Kitchen/pause' -m ''
mosquitto_pub -t 'alexa/set/Kitchen/volume' -m 30
mosquitto_pub -t 'alexa/set/Kitchen/text_command' -m 'play SWR3'
mosquitto_pub -t 'alexa/set/all/announcement' -m 'Dinner is ready'
mosquitto_pub -t 'alexa/set/Kitchen/routine' -m 'Good night'
```

## Upgrading from 1.x

2.0 moves the adapter onto mqtt-interfaces-core and the mqtt-smarthome 2.x spec. There are no
compatibility shims — topics, payloads and options changed:

| 1.x                                                           | 2.0                                                                   |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| `alexa/status/bridge/connected`                               | `alexa/connected`                                                     |
| plain status payloads                                         | `{"val": …, "ts": …, "lc": …}` (`--no-json-payloads` for the old way) |
| `audioPlayerState`, `playerState`                             | `player_state`                                                        |
| `isMuted` (`ON`/`OFF`)                                        | `mute` (`true`/`false`)                                               |
| `imageUrl`, `lastVoiceCommand`, `lastActivity`, `textCommand` | `image_url`, `last_voice_command`, `last_activity`, `text_command`    |
| `ON`/`OFF` booleans                                           | `true`/`false` everywhere                                             |
| `--topic-prefix` / `-t`                                       | `--name` / `-n` (same default `alexa`)                                |
| `--verbose` / `-v`                                            | `--verbosity debug`                                                   |
| `--ha-discovery` (off by default)                             | on by default, `--no-ha-discovery`                                    |
| service `alexa-remote-mqtt`                                   | template service `alexa-remote-mqtt@<name>`                           |
| `/etc/default/alexa-remote-mqtt`                              | `/etc/alexa-remote-mqtt/<name>.env`                                   |
| `/var/lib/alexa-remote-mqtt/cookie.json`                      | `/var/lib/alexa-remote-mqtt/<name>/cookie.json`                       |

New: `alexa/info`, the maintenance topics, `--config-schema`, typed environment variables with the
shared `MQTT_*` fallback, per-device availability and a bridge device in Home Assistant.

`sudo alexa-remote-mqtt --install --name alexa …` copies the login of the 1.x service and tells you
how to remove the old unit:

```sh
sudo systemctl disable --now alexa-remote-mqtt
sudo rm /etc/systemd/system/alexa-remote-mqtt.service /etc/default/alexa-remote-mqtt
```

The 1.x Home Assistant discovery used one config topic per entity; those retained messages are not
cleared automatically. Remove them once with:

```sh
mosquitto_sub -v -t 'homeassistant/+/alexa-remote-mqtt_+/+/config' --retained-only -W 2 |
  awk '{print $1}' | xargs -I{} mosquitto_pub -r -n -t {}
```

## Known upstream issue

alexa-remote2 8.x drops push messages that are split across several HTTP/2 chunks (all larger
media/player events). alexa-remote-mqtt works around this by reassembling chunks before they reach the
library; see `alexa-remote2-issue-draft.md`.

## Credits

alexa-remote-mqtt is a thin layer on top of the hard work of others:

- [alexa-remote2](https://github.com/Apollon77/alexa-remote) by [Ingo Fischer (Apollon77)](https://github.com/Apollon77),
  originally by [Michael Geramb (soef)](https://github.com/soef) — the library that does all the actual talking to
  Amazon's Alexa API, including the push connection, routines and the login/cookie handling via
  [alexa-cookie2](https://github.com/Apollon77/alexa-cookie).
- [node-red-contrib-alexa-remote2-applestrudel](https://github.com/bbindreiter/node-red-contrib-alexa-remote2-applestrudel)
  by Bernhard Bindreiter, whose Node-RED nodes served as the reference for how to set up and use alexa-remote2.
- [MQTT.js](https://github.com/mqttjs/MQTT.js) and [yargs](https://github.com/yargs/yargs).

## License

MIT © Sebastian "hobbyquaker" Raff <hobbyquaker@gmail.com> — see [LICENSE](LICENSE).
