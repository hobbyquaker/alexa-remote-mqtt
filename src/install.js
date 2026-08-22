import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SERVICE = 'alexa-remote-mqtt';
const UNIT_PATH = `/etc/systemd/system/${SERVICE}.service`;
const ENV_PATH = `/etc/default/${SERVICE}`;
const STATE_DIR = `/var/lib/${SERVICE}`;

function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] })
    .toString()
    .trim();
}

export function unitFile(execStart) {
  return `[Unit]
Description=alexa-remote-mqtt - Amazon Echo to MQTT bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=-${ENV_PATH}
ExecStart=${execStart}
Restart=on-failure
RestartSec=10
User=${SERVICE}
Group=${SERVICE}
StateDirectory=${SERVICE}
Environment=ALEXA_REMOTE_MQTT_COOKIE_FILE=${STATE_DIR}/cookie.json
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`;
}

/** Build the /etc/default/alexa-remote-mqtt content from the parsed CLI options. */
export function envFile(argv) {
  const vars = {
    MQTT_URL: argv.mqttUrl,
    MQTT_USERNAME: argv.mqttUsername,
    MQTT_PASSWORD: argv.mqttPassword,
    TOPIC_PREFIX: argv.topicPrefix,
    AMAZON_PAGE: argv.amazonPage,
    ALEXA_SERVICE_HOST: argv.alexaServiceHost,
    PROXY_OWN_IP: argv.proxyOwnIp,
    PROXY_PORT: argv.proxyPort,
    POLL_INTERVAL: argv.pollInterval,
    HA_DISCOVERY: argv.haDiscovery,
    HA_PREFIX: argv.haPrefix,
  };
  const lines = [
    '# alexa-remote-mqtt configuration, read by the systemd unit. Restart with: systemctl restart alexa-remote-mqtt',
  ];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined || v === null || v === '') continue;
    lines.push(`ALEXA_REMOTE_MQTT_${k}=${String(v).replace(/\n/g, ' ')}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Install alexa-remote-mqtt as a systemd service using the given CLI options as its configuration,
 * then enable and start it. Must run as root.
 * @param {object} argv parsed yargs options
 * @param {(...a:any[])=>void} log
 */
export function installService(argv, log) {
  if (os.platform() !== 'linux') throw new Error('--install is only supported on Linux with systemd');
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw new Error('--install must run as root, e.g. sudo alexa-remote-mqtt --install --mqtt-url mqtt://broker');
  }
  if (!fs.existsSync('/run/systemd/system')) throw new Error('systemd is not running on this system');

  const nodeBin = process.execPath;
  const script = fs.realpathSync(process.argv[1]);
  const execStart = `${nodeBin} ${script}`;

  // Service user
  try {
    run('id', ['-u', SERVICE]);
  } catch {
    log(`Creating system user ${SERVICE}`);
    run('useradd', ['--system', '--no-create-home', '--home-dir', STATE_DIR, '--shell', '/usr/sbin/nologin', SERVICE]);
  }

  // State dir + existing login, if the interactive user already logged in
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o750 });
  const target = path.join(STATE_DIR, 'cookie.json');
  if (!fs.existsSync(target)) {
    const candidates = [argv.cookieFile];
    const sudoUser = process.env.SUDO_USER;
    if (sudoUser) {
      try {
        const home = run('getent', ['passwd', sudoUser]).split(':')[5];
        candidates.push(path.join(home, '.alexa-remote-mqtt', 'cookie.json'));
        candidates.push(path.join(home, '.echo2mqtt', 'cookie.json')); // pre-rename location
      } catch {
        /* ignore */
      }
    }
    // Pre-rename service state dir
    candidates.push('/var/lib/echo2mqtt/cookie.json');
    const source = candidates.find(p => p && fs.existsSync(p));
    if (source) {
      log(`Copying existing Amazon login from ${source} to ${target}`);
      fs.copyFileSync(source, target);
    } else {
      log(
        'No existing Amazon login found - the service will start the login proxy; watch: journalctl -u alexa-remote-mqtt -f',
      );
    }
  }
  run('chown', ['-R', `${SERVICE}:${SERVICE}`, STATE_DIR]);
  if (fs.existsSync(target)) fs.chmodSync(target, 0o600);

  // Config + unit
  if (fs.existsSync(ENV_PATH)) {
    const backup = `${ENV_PATH}.bak`;
    fs.copyFileSync(ENV_PATH, backup);
    log(`Existing ${ENV_PATH} backed up to ${backup}`);
  }
  fs.writeFileSync(ENV_PATH, envFile(argv), { mode: 0o640 });
  run('chown', [`root:${SERVICE}`, ENV_PATH]);
  log(`Wrote ${ENV_PATH}`);
  fs.writeFileSync(UNIT_PATH, unitFile(execStart), { mode: 0o644 });
  log(`Wrote ${UNIT_PATH} (ExecStart=${execStart})`);

  run('systemctl', ['daemon-reload']);
  run('systemctl', ['enable', '--now', SERVICE]);
  log(`Service ${SERVICE} enabled and started. Logs: journalctl -u ${SERVICE} -f`);
}

/** Stop, disable and remove the systemd service. Keeps ${STATE_DIR} (the Amazon login). */
export function uninstallService(log) {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new Error('--uninstall must run as root');
  try {
    run('systemctl', ['disable', '--now', SERVICE]);
  } catch {
    /* not installed */
  }
  for (const f of [UNIT_PATH, ENV_PATH]) {
    if (fs.existsSync(f)) {
      fs.rmSync(f);
      log(`Removed ${f}`);
    }
  }
  run('systemctl', ['daemon-reload']);
  log(`Service ${SERVICE} removed. Login data kept in ${STATE_DIR}; delete it manually if no longer needed.`);
}
