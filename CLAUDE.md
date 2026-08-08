# CLAUDE.md

## What is magpie

Remote browser instance service: a single headless Chromium opened to a default
URL (`https://gitee.com`), streamed to a single remote user over WebRTC video.
Mouse / keyboard / navigation round-trip back over a signaling WebSocket.

**Session model: single-instance, single-user.** One Chromium, one target page,
one WebRTC peer, at a time. v1 has no multi-session, no auth, no audio, no
clipboard, no runtime resize.

## Commands

```bash
npm install
npx playwright install chromium   # download the browser once
npm start                         # node src/index.js -> http://localhost:8080/
npm test                          # node --test (unit + integration + spike + e2e)
```

Env (defaults in `src/index.js`): `PORT` (8080), `HOST` (`0.0.0.0`; `127.0.0.1`
for local-only), `MAGPIE_URL` (https://gitee.com), `MAGPIE_NO_SANDBOX` (`1` only
in Docker).

Docker:

```bash
docker compose up -d                # magpie + coturn sibling service
curl -s http://localhost:8080/healthz   # -> ok
docker compose down
```

## Architecture — the pipeline is the whole point

```
target page ──CDP Page.startScreencast (JPEG)──▶ Node (BrowserSession)
Node ──/internal WS (binary JPEG)──▶ streamer page (a second Chromium context)
streamer page: createImageBitmap→drawImage→<canvas>→canvas.captureStream()
            → page-side RTCPeerConnection (Chromium native libwebrtc) ──▶ client <video>
```

- **Video downlink** uses Chromium's *own* libwebrtc running inside the streamer
  page — not a Node-side encoder. The `<canvas>` is only a relay/feeder for
  libwebrtc; it is **not** the pixel source.
- **Input / control** (`mouse`/`wheel`/`key`/`navigate`) travels over the
  `/signaling` WS → Node → CDP. It does **not** go over WebRTC. WebRTC carries
  video only (the client peer is recvonly).

### Why capture MUST be CDP (do not change this)

Arbitrary sites are DOM, not a `<canvas>`; `canvas.captureStream()` only streams
pixels *already drawn onto a canvas* — it cannot capture a website's rendered
output. Under headless Chromium:

- `getDisplayMedia()` needs an OS screen-capture backend → **unavailable**.
- Playwright **headless cannot load extensions** → `chrome.tabCapture` is
  **unavailable**.
- headed + Xvfb violates the headless constraint.

So headless + arbitrary-site pixels can only come from CDP
`Page.startScreencast` → Node. If anyone proposes tabCapture / getDisplayMedia /
an extension, this is why they're ruled out. Canonical design:
`docs/superpowers/specs/2026-08-08-magpie-remote-browser-design.md`.

## Module map

| Path | Role |
|---|---|
| `src/index.js` | Entry. Launches ONE shared Playwright `browser`; wires BrowserSession + StreamerPeer + InputChannel + server; owns the crash→restart flow. |
| `src/server.js` | `node:http` + `ws`. Serves `/`, `/client.html`, `/streamer.html`, `/healthz`. WS `/signaling` (client) and `/internal` (frame relay). `server.broadcast({t:'reload'})` on crash. |
| `src/browser/BrowserSession.js` | Target page: Playwright context+page+CDP session. `startScreencast/dispatchMouse/dispatchWheel/dispatchKey/navigate/getViewport/getUrl/onCrash/restart`. Accepts an injected shared browser. |
| `src/browser/launch-options.js` | **Single source** for Chromium launch flags — both `index.js` (shared browser) and `BrowserSession` (self-launch) call it. `MAGPIE_NO_SANDBOX=1` → `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage` (avoids the 64MB container `/dev/shm` crash). |
| `src/streamer/StreamerPeer.js` | Manages the streamer page in the shared browser (separate context). `relayOffer(sdp)→answerSdp` via `page.evaluate(window.relayOffer)`; `pushFrame(jpeg)` over the `/internal` socket. |
| `src/streamer/streamer.html` | canvas + `captureStream(15)` + page-side `RTCPeerConnection`; receives JPEG frames on `/internal`; sets `window.__ready=true` when ready. |
| `src/webrtc/InputChannel.js` | Parses `/signaling` input msgs → maps coords → dispatches to BrowserSession. |
| `src/webrtc/coords.js` | Pure: client `<video>` rect → page CSS coords (assumes no letterboxing; client video is `width:100%`). |
| `src/webrtc/keys.js` | Pure: CDP key map (`key/code/windowsVirtualKeyCode/text`) + input-message parsing. |
| `src/webrtc/ice-servers.js` | Builds STUN+TURN `iceServers` from a coturn host; returns `[]` when no host/creds (native run). |
| `src/public/client.html` | Client: `/signaling` WS + `RTCPeerConnection(recvonly)` + input capture. `?relay=1` forces `iceTransportPolicy:'relay'` (debug TURN). |

### Wiring notes (easy to get wrong)

- The WebRTC peer is the **streamer page**, not the client. The client is
  recvonly. Two `RTCPeerConnection`s exist (one per side) but they peer with
  each other through SDP relayed by Node.
- Server-side peer (streamer page) reaches coturn by compose service name
  `coturn`; client-side peer reaches it by the host IP. Both empty when
  `MAGPIE_HOST_IP` is unset → pure host candidates. See `src/index.js`.
- Client waits for `iceServers` in the `hello` message **before** starting the
  peer — the TURN allocation is a round-trip, so the offer must include the
  relay candidate.

## Testing

`npm test` runs `node --test`, which picks up everything under `test/`. Layers:

- **Pure unit** — `test/webrtc/{coords,keys,ice-servers}.test.js`,
  `test/browser/launch-options.test.js`.
- **Integration** — `test/browser/BrowserSession.*.test.js`: screencast frames,
  CDP input injection against `test/fixtures/click-target.html`, crash→restart.
- **Spike** — `test/spike.capturestream.test.js`: proves headless
  `canvas.captureStream()` actually yields video (the biggest design risk; was
  an early gate task).
- **E2E** — `test/e2e.test.js`: boots the whole stack, drives a real Chromium as
  the client, asserts video plays and a click reaches the target page.

Tests use `node:test` + `node:assert/strict`; boot helpers inject a shared
`browser`. Tests that mutate `process.env` (e.g. `MAGPIE_NO_SANDBOX`) must clean
up in a `finally`.

## Code conventions

- ESM (`"type":"module"`), explicit `.js` extensions in imports, **no build
  step**, no TypeScript.
- Plain JS classes with `_`-prefixed private fields (no `#`). Dense `//`
  comments explaining *why*, especially around CDP / WebRTC.
- Keep pixel / coord / key / SDP logic **pure** so it's unit-testable
  (`coords.js`, `keys.js`, `ice-servers.js`); dispatch and IO live in classes.
- **Only two runtime deps**: `playwright` and `ws`. Don't add a build step,
  bundler, or TS layer without a strong reason — the design explicitly values
  pure JS + no build.

## Docker / TURN gotchas

- `shm_size: 2gb` is required for Chromium stability (the default 64MB
  `/dev/shm` crashes it).
- **macOS Docker Desktop**: the page loads and signaling works, but WebRTC
  video will NOT reach a Mac browser — container ICE candidates live in the
  Docker VM, unroutable from macOS. Verify the pipeline from the CLI with
  `docker/verify-webrtc.mjs` (expects `VIDEO_OK`), or use a TURN relay / Linux
  host networking.
- TURN relay (for non-same-host clients): set `MAGPIE_HOST_IP` to the host's LAN
  IP (must be reachable from both the browser and the container).
  `MAGPIE_TURN_USER`/`MAGPIE_TURN_PASS` default to `magpie`/`magpie`.
- Keep the `playwright` version in `package-lock.json` matching what
  `npx playwright install` downloads into the image.

## Docs & workflow

- Canonical architecture + rationale:
  `docs/superpowers/specs/2026-08-08-magpie-remote-browser-design.md`.
- Comparison with neko (self-hosted virtual desktop):
  `docs/superpowers/2026-08-08-magpie-vs-neko.md`.
- Implementation plans live in `docs/superpowers/plans/`
  (`remote-browser`, `docker`, `turn`).
- This project follows the `superpowers` workflow (brainstorm → spec → plan →
  implement). New features should get a spec + plan in `docs/superpowers/`
  before code.
