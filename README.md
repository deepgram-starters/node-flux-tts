# Node Flux Text-to-Speech

Get started using Deepgram's **Flux streaming text-to-speech** (v2 speak) with this Node demo app.

Unlike the Flux **transcription** starter ([`node-flux`](https://github.com/deepgram-starters/node-flux)), which is a raw WebSocket proxy, this starter uses the official [`@deepgram/sdk`](https://github.com/deepgram/deepgram-js-sdk) `speak.v2` client on the backend — so the SDK manages the Deepgram WebSocket, auth, and binary-audio framing for you.

## How it works

```
Browser  ──(JSON control: Speak / Flush / Close)──▶  Node backend  ──(@deepgram/sdk speak.v2)──▶  Deepgram Flux TTS
Browser  ◀──(binary audio frames + JSON control)───  Node backend  ◀──(@deepgram/sdk speak.v2)───  Deepgram Flux TTS
```

- The backend never exposes your API key — the browser authenticates to the backend with a short-lived JWT (`/api/session`), passed on the WebSocket `access_token.<jwt>` subprotocol.
- The backend opens one `client.speak.v2` connection per browser client and bridges messages both ways.
- Audio frames from Deepgram arrive as binary and are forwarded to the browser as binary; control messages (`Connected`, `SpeechStarted`, `SpeechMetadata`, `Flushed`, `Warning`, `Error`, …) are forwarded as JSON.

### Client → backend message protocol

Send JSON text frames on the `/api/tts` WebSocket:

```jsonc
{ "type": "Speak", "text": "Hello from Flux." }   // synthesize text
{ "type": "Flush" }                                // finish the current turn, flush audio
{ "type": "Close" }                                // end the session
```

## Prerequisites

> [!IMPORTANT]
> This starter depends on `@deepgram/sdk` **>= 5.6.0** — the release that adds `client.speak.v2` streaming support ([deepgram-js-sdk#515](https://github.com/deepgram/deepgram-js-sdk/pull/515)). Until that version is published:
> - install the SDK from the feature branch, or
> - `pnpm link` a local build of the SDK, then run this app.
>
> Also note this project's `.npmrc` sets `minimum-release-age=14400` (10 days); a brand-new SDK release may need that relaxed temporarily to install immediately after publish.

You'll need a Deepgram API key — get one at [console.deepgram.com](https://console.deepgram.com/).

## Local Development

### Makefile (Recommended)

```bash
make init
cp sample.env .env   # add your DEEPGRAM_API_KEY
make start           # backend on http://localhost:8081
```

### Node.js & pnpm

```bash
git clone https://github.com/deepgram-starters/node-flux-tts.git
cd node-flux-tts
corepack pnpm install
cp sample.env .env   # add your DEEPGRAM_API_KEY
node --no-deprecation server.js
```

## Configuration

Environment variables (see `sample.env`):

| Variable | Default | Description |
|---|---|---|
| `DEEPGRAM_API_KEY` | — | **Required.** Your Deepgram API key. |
| `PORT` | `8081` | Backend port. |
| `HOST` | `0.0.0.0` | Backend host. |
| `DEEPGRAM_TTS_MODEL` | `flux-alexis-en` | Flux voice (`flux-{voice}-{language}`). |
| `SESSION_SECRET` | random per boot | Set in production for stable JWT signing. |

The connection also accepts `model`, `encoding`, and `sample_rate` as query params on the `/api/tts` WebSocket.

## Status / TODO

This scaffold is **backend-first**. To reach parity with the other starters:

- [ ] **Frontend** — add a `flux-tts-html` submodule (text input → play streamed audio), mirroring how `node-flux` uses `flux-html`. Then restore the parallel backend+frontend `[start]` in `deepgram.toml` and the Caddy + frontend multi-stage `deploy/Dockerfile`.
- [ ] **Contracts** — add `run-flux-tts-app.sh` to [`deepgram/starter-contracts`](https://github.com/deepgram/starter-contracts) and wire the `contracts` submodule.
- [ ] **Publish** — bump to the released `@deepgram/sdk` version once `speak.v2` ships.

## License

MIT - See [LICENSE](./LICENSE)
