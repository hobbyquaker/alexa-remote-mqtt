# alexa-remote-mqtt

Node.js CLI that bridges Amazon Echo devices to MQTT, built on
[alexa-remote2](https://www.npmjs.com/package/alexa-remote2).
It is a lightweight replacement for a Node-RED flow using
[node-red-contrib-alexa-remote2-applestrudel](https://github.com/bbindreiter/node-red-contrib-alexa-remote2-applestrudel).

## Topics

`<device>` is the name shown in the Alexa app (`/`, `+`, `#` replaced with `_`); the serial number
works too. For commands, `all` addresses every music-capable device at once.
Status topics are published **retained** unless noted otherwise.

### Status: `alexa/status/<device>/…`

| Topic                      | Payload                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `audioPlayerState`         | `PLAYING`, `PAUSED`, `IDLE`, `INTERRUPTED`, `FINISHED`                                                   |
| `volume`                   | `0`-`100`                                                                                                |
| `isMuted`                  | `ON` / `OFF`                                                                                             |
| `title`, `artist`, `album` | current track / station info (empty when idle)                                                           |
| `provider`                 | source, e.g. `TuneIn`, `Spotify`, `Amazon Music`                                                         |
| `imageUrl`                 | cover art URL                                                                                            |
| `media`                    | JSON `{state,title,artist,album,provider,imageUrl,mediaId}`                                              |
| `progress`                 | JSON `{progress,length}` in ms — **not retained**, max. every 10 s                                       |
| `lastVoiceCommand`         | text spoken to this device (without wake word) — **not retained**, one message per utterance             |
| `lastActivity`             | JSON `{text,response,utteranceType,timestamp}` of the last utterance                                     |
| `notifications`            | JSON array of timers/alarms/reminders: `{id,type,status,label,time,triggerTime,remainingTime,recurring}` |
| `dnd`                      | Do-Not-Disturb `true` / `false`                                                                          |
| `bluetooth`                | JSON `{connected,name,address,paired:[{name,address,connected,profiles}]}`                               |
| `equalizer`                | JSON `{bass,mid,treble}` (push only, after a change)                                                     |
| `microphone`               | JSON with the raw microphone-state push payload                                                          |
| `connected`                | device online `true` / `false`                                                                           |

Bridge-level:

| Topic                           | Payload                                                                |
| ------------------------------- | ---------------------------------------------------------------------- |
| `alexa/status/bridge/connected` | `0` offline, `1` MQTT only, `2` MQTT + Alexa (LWT)                     |
| `alexa/status/bridge/devices`   | JSON list of devices (name, topic, serial, type, capabilities)         |
| `alexa/status/bridge/routines`  | JSON list of Alexa routines (after first use of the `routine` command) |

### Commands: `alexa/set/<device>/…`

| Topic                               | Payload                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| `play`, `pause`, `next`, `previous` | any                                                                                     |
| `shuffle`, `repeat`                 | `on` / `off`                                                                            |
| `volume`                            | `0`-`100`                                                                               |
| `isMuted`                           | `ON` / `OFF` — implemented as volume 0 and restore (`mute` works as alias)              |
| `playerState`                       | `PLAYING` / `PAUSED` (or `play` / `pause`)                                              |
| `tunein`                            | TuneIn guide id, e.g. `s25111`, or `{"id":"p12345","type":"show"}`                      |
| `textCommand`                       | text as if spoken to Alexa, e.g. `play SWR3`, `next track`, `set a timer for 5 minutes` |
| `speak`                             | text-to-speech on the device                                                            |
| `announcement`                      | announcement with chime; `alexa/set/all/announcement` plays on all devices in sync      |
| `ssml`                              | SSML, must start with `<speak>`                                                         |
| `sound`                             | Amazon sound id, e.g. `amzn_sfx_doorbell_chime_01`                                      |
| `routine`                           | Alexa routine by name, trigger utterance or id                                          |
| `dnd`                               | `on` / `off`                                                                            |
| `bluetooth`                         | paired device name or address to connect, `off` to disconnect                           |
| `equalizer`                         | `{"bass":2,"mid":0,"treble":-1}` or `2,0,-1` (range usually -6..6)                      |
| `refresh`                           | re-poll all state of this device now                                                    |

State updates arrive instantly via the Alexa push connection; additionally the full
state is polled every `--poll-interval` seconds (default 300) to resynchronise.

### Home Assistant

With `--ha-discovery` the bridge publishes MQTT discovery configs so every Echo appears as a
device in Home Assistant with sensors (state, title, artist, album, source, last voice command,
bluetooth, timers), a volume slider, mute/DND switches, transport buttons and text inputs for
text command / speak / announcement.

## Install & run

Requires Node.js >= 20.

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

On the first start no Amazon login exists yet. alexa-remote-mqtt starts a local login proxy and prints
a URL like `http://192.168.1.10:3001/`. Open it in a browser (on the same network), sign in
with your Amazon account, and the login is stored in `~/.alexa-remote-mqtt/cookie.json`
(override with `--cookie-file`). Subsequent starts reuse and auto-refresh it.

`--proxy-own-ip` must be the IP address (not hostname) under which you reach the machine
running alexa-remote-mqtt; it defaults to the first non-internal IPv4 address.

**WSL2 / Docker:** the auto-detected IP is the VM's/container's internal address, which your
browser can't reach. Pass `--proxy-own-ip 127.0.0.1` and open `http://127.0.0.1:3001/` on the
host (WSL2 forwards localhost ports; for Docker publish port 3001), or use a host IP that is
actually routed to the process (e.g. WSL2 mirrored networking mode).

### Run as a systemd service

```sh
sudo alexa-remote-mqtt --install --mqtt-url mqtt://broker --amazon-page amazon.de --proxy-own-ip 192.168.1.10
```

`--install` creates a system user `alexa-remote-mqtt`, writes the given options to `/etc/default/alexa-remote-mqtt`
(`ALEXA_REMOTE_MQTT_*` variables — edit and `systemctl restart alexa-remote-mqtt` to change), installs
`/etc/systemd/system/alexa-remote-mqtt.service`, and enables + starts it. An existing Amazon login
(`--cookie-file` or the invoking user's `~/.alexa-remote-mqtt/cookie.json`) is copied to
`/var/lib/alexa-remote-mqtt/cookie.json`; otherwise the service starts the login proxy — follow
`journalctl -u alexa-remote-mqtt -f` for the URL. `sudo alexa-remote-mqtt --uninstall` removes the service again
(keeps the login data).

## Options

```
-u, --mqtt-url        MQTT broker URL                         [default: "mqtt://127.0.0.1"]
    --mqtt-username   MQTT username
    --mqtt-password   MQTT password
-t, --topic-prefix    MQTT topic prefix                       [default: "alexa"]
-a, --amazon-page     Amazon domain of your account           [default: "amazon.de"]
    --alexa-service-host  Alexa API host                      [default: "layla.amazon.com"]
-c, --cookie-file     File to persist the Amazon login        [default: "~/.alexa-remote-mqtt/cookie.json"]
    --proxy-own-ip    IP of this machine for the login proxy  [default: auto]
    --proxy-port      Port of the login proxy                 [default: 3001]
-p, --poll-interval   Seconds between full state polls, 0 = push only  [default: 300]
    --ha-discovery    Publish Home Assistant MQTT discovery configs
    --ha-prefix       Home Assistant discovery prefix          [default: "homeassistant"]
-v, --verbose         Verbose logging
```

Every option can also be given as an environment variable with prefix `ALEXA_REMOTE_MQTT_`,
e.g. `ALEXA_REMOTE_MQTT_MQTT_URL=mqtt://broker.local`.

## Example

```sh
mosquitto_sub -v -t 'alexa/#'
mosquitto_pub -t 'alexa/set/Kitchen/pause' -m ''
mosquitto_pub -t 'alexa/set/Kitchen/volume' -m 30
mosquitto_pub -t 'alexa/set/Kitchen/textCommand' -m 'play SWR3'
mosquitto_pub -t 'alexa/set/all/announcement' -m 'Dinner is ready'
mosquitto_pub -t 'alexa/set/Kitchen/routine' -m 'Good night'
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
