# HTTP/2 push: directives split across several data chunks are silently dropped (PUSH_AUDIO_PLAYER_STATE, NotifyNowPlayingUpdated, …)

**Library version:** alexa-remote2 8.1.1
**Node.js:** 24.x (also reproducible on 20.x)
**Amazon page:** amazon.de, `usePushConnection: true` (HTTP/2 push, `bob-dispatch-prod-eu.amazon.com`)

## Summary

`alexa-http2push.js` parses every HTTP/2 `data` chunk as a complete multipart part
(`alexa-http2push.js:166`, `this.stream.on('data', chunk => { … JSON.parse(chunk.substring(indexOf('{'), lastIndexOf('}') + 1)) … })`).
Amazon's larger push directives — at least `PUSH_AUDIO_PLAYER_STATE` (which now contains a
`quality.badge` object with URLs) and `NotifyNowPlayingUpdated` — are delivered split across
two or more chunks. Each chunk then fails to parse and the message is dropped.

Small directives such as `PUSH_VOLUME_CHANGE` fit in a single chunk and work fine, which
makes the symptom confusing: volume events arrive, player-state/media events never do.

The failure is also invisible to users: the parse error is emitted as
`this.emit('unexpected-response', …)` on the `AlexaHttp2Push` instance, but `alexa-remote.js`
never subscribes to that event, so nothing is logged and no `ws-*` event fires.

## Steps to reproduce

1. `init()` with `usePushConnection: true` and register `alexa.on('ws-audio-player-state-change', console.log)`.
2. Additionally subscribe to the dropped errors to make them visible:
   ```js
   alexa.on('ws-connect', () => alexa.alexahttp2Push.on('unexpected-response', console.error));
   ```
3. Start music on an Echo (Amazon Music, HD quality) and skip to the next track.

## Observed

No `ws-audio-player-state-change` is emitted. The `unexpected-response` hook prints (trimmed):

```
Could not parse json: {"directive":{"header":{"namespace":"Alexa.Mobile.Push","name":"RenderUpdate","messageId":"62a78b6e-…"},"payload":{"renderingUpdates":[{"route":"EventBus:tcomm::message","resourceId":"PUSH_AUDIO_PLAYER_STATE","resourceMetadata":"{\"command\":\"PUSH_AUDIO_PLAYER_STATE\",\"payload\":\"{\\\"dopplerId\\\":{\\\"deviceSerialNumber\\\":\\\"G090…\\\",\\\"deviceType\\\":\\\"A1RABVCI4QCIKC\\\"},\\\"audioPlayerState\\\":\\\"INTERRUPTED\\\",\\\"quality\\\":{\\\"name\\\":\\\"High Definition\\\",\\\"badge\\\":{\\\"altText\\\":\\\"https://music-provider-logos.s3.amazonaws.com/badges/AmazonMusic/HD.png\\\"}: Unterminated string in JSON at position 635 (line 1 column 636)

Could not parse json: {"directive":{"header":{"namespace":"Alexa.Mobile.Push","name":"RenderUpdate","messageId":"3a04a4b5-…"}: Expected ',' or '}' after property value in JSON at position 129 (line 1 column 130)
```

The first chunk ends mid-string; the second message is cut after only 129 bytes — i.e. the
chunk boundaries are arbitrary and the remainder of each message arrives in a following
`data` event, which then does not start with `Content-Type: application/json` and is ignored.

## Expected

Chunks are buffered until a complete JSON object has been received, then parsed and
dispatched as `command`; `ws-audio-player-state-change`, `ws-now-playing-updated`, etc. fire.

## Suggested fix

Buffer the stream data per multipart part instead of parsing each chunk individually, e.g.:

```js
let buffer = '';
this.stream.on('data', chunk => {
  const text = chunk.toString();
  if (text.startsWith('------')) {
    /* existing ping / keep-alive handling */
  }
  buffer += text;
  for (;;) {
    const start = buffer.indexOf('{');
    if (start === -1) {
      buffer = '';
      return;
    }
    const end = findJsonEnd(buffer, start); // brace/string-aware scan, -1 if incomplete
    if (end === -1) return; // wait for the next chunk
    handleMessage(buffer.slice(start, end)); // existing renderingUpdates parsing
    buffer = buffer.slice(end);
  }
});
```

where `findJsonEnd` walks the string tracking `{`/`}` depth while skipping over quoted strings
(including escaped quotes). This also handles the opposite case of two messages arriving in one
chunk, which the current `indexOf('{')`/`lastIndexOf('}')` approach would also mis-parse.

Additionally, it would help a lot if `alexa-remote.js` forwarded `unexpected-response` from the
push client (e.g. as `ws-error` or a new `ws-unexpected-response` event), or at least logged it via
`this._options.logger`, so that dropped messages are not silent.

I have this reassembly approach running as an external wrapper around the stream's `data`
listener and can confirm it makes `PUSH_AUDIO_PLAYER_STATE` and `NotifyNowPlayingUpdated`
arrive reliably; happy to turn it into a PR if you agree with the approach.
