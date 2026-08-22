/**
 * Work-around for alexa-remote2's HTTP/2 push client (alexa-http2push.js):
 * it parses every incoming HTTP/2 data chunk on its own, but larger directives
 * (PUSH_AUDIO_PLAYER_STATE with quality/badge info, NotifyNowPlayingUpdated, ...)
 * are delivered split across several chunks, so they fail to parse and are dropped.
 *
 * We wrap the library's 'data' listener on the push stream: chunks are buffered
 * until they contain one complete JSON object, which is then handed to the
 * original listener as a single synthetic chunk.
 */

const MAX_BUFFER = 1024 * 1024;

/**
 * Find the end index (exclusive) of the first complete JSON object in `text`
 * starting at `start` (which must point at '{'). Returns -1 if incomplete.
 */
export function findJsonEnd(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Create a chunk handler that reassembles JSON parts and forwards them to `deliver`.
 * Non-JSON chunks (multipart boundaries used for the ping logic) are forwarded untouched.
 */
export function createReassembler(deliver, log = () => {}) {
  let buffer = '';

  return function onChunk(chunk) {
    const text = chunk.toString();

    if (!buffer) {
      if (text.startsWith('------')) {
        // Multipart boundary: the library uses it to trigger its ping/keep-alive logic.
        deliver(chunk);
        const rest = text.slice(text.indexOf('\n') + 1);
        if (!/Content-Type: application\/json/.test(rest)) return;
        buffer = rest.slice(rest.indexOf('Content-Type'));
      } else if (text.startsWith('Content-Type: application/json')) {
        buffer = text;
      } else if (text.trimStart().startsWith('{')) {
        buffer = `Content-Type: application/json\r\n\r\n${text}`;
      } else {
        deliver(chunk);
        return;
      }
    } else {
      buffer += text;
    }

    for (;;) {
      const start = buffer.indexOf('{');
      if (start === -1) {
        buffer = '';
        return;
      }
      const end = findJsonEnd(buffer, start);
      if (end === -1) {
        if (buffer.length > MAX_BUFFER) {
          log(`Push reassembly: dropping ${buffer.length} bytes of unparseable data`);
          buffer = '';
        }
        return;
      }
      deliver(`Content-Type: application/json\r\n\r\n${buffer.slice(start, end)}`);
      buffer = buffer.slice(end);
      // Anything left that is not another JSON object (boundary, CRLF) is discarded.
      if (!buffer.includes('{')) {
        buffer = '';
        return;
      }
    }
  };
}

/**
 * Install the reassembler on an AlexaHttp2Push instance's current stream.
 * Safe to call repeatedly (e.g. on every reconnect); a stream is only wrapped once.
 * @returns {boolean} true if the stream was (already) wrapped
 */
export function installPushReassembly(push, log = () => {}) {
  const stream = push?.stream;
  if (!stream) return false;
  if (stream.__armReassembly) return true;
  const originals = stream.listeners('data');
  if (originals.length === 0) return false;
  for (const fn of originals) stream.removeListener('data', fn);
  const deliver = chunk => {
    for (const fn of originals) fn(chunk);
  };
  stream.on('data', createReassembler(deliver, log));
  stream.__armReassembly = true;
  return true;
}
