# magpie TURN/STUN Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a coturn STUN+TURN relay to the Docker deployment and wire `iceServers` (STUN+TURN) into both WebRTC peers, so a browser client gets video from the containerized magpie across the Docker network boundary.

**Architecture:** A `coturn` sibling service (bridge network, ports 3478 + fixed relay UDP range published, `--external-ip` = `MAGPIE_HOST_IP`) provides STUN+TURN. magpie builds two `iceServers` sets from env: server-side (addr `coturn`, used by the streamer page) and client-side (addr `MAGPIE_HOST_IP`, sent to the browser in the `hello` message). `iceTransportPolicy: all` lets WebRTC auto-select (direct on Linux host-net, relay under Docker).

**Tech Stack:** coturn, Docker Compose, Node 22, Playwright/Chromium WebRTC.

## Global Constraints

- **Branch:** `feat/docker`.
- **Runtime:** Node >= 18, ESM. Tests via `node:test` + `node:assert/strict` (`npm test`).
- **No new npm deps.**
- **Commit convention:** every commit ends with a blank line then `Co-Authored-By: Claude <noreply@anthropic.com>`.
- **`MAGPIE_HOST_IP`** is provided as an env at `docker compose up` time. It must be an IP/hostname reachable from **both** the browser client **and** the magpie container — i.e. the host's LAN IP (e.g. `192.168.x.x`), **not** `localhost` (which inside the container refers to the container itself). When unset, both `iceServers` sets are empty → pure host-candidate behavior (preserves native `npm start`).
- **coturn `--external-ip`** must equal `MAGPIE_HOST_IP` so coturn advertises reachable relay candidates.
- `iceTransportPolicy` stays `all` (default) — auto-select. A `?relay=1` debug toggle on the client forces relay for verification.
- **Docker Desktop caveat (verify, don't assume):** media relay depends on Docker Desktop hairpinning the container's traffic to the host's published relay ports. The forced-relay test (Task 4) uses the real path and will surface this; if it fails on macOS, the documented fallback is Linux host networking.

---

## File Structure

- `src/webrtc/ice-servers.js` — **new**; `buildIceServers({ host, user, pass, port })`.
- `src/index.js` — **modify**; build server/client iceServers from env, inject.
- `src/server.js` — **modify**; `createServer` takes `clientIceServers`; `hello` includes `iceServers`.
- `src/streamer/StreamerPeer.js` — **modify**; `start({ streamerUrl, iceServers })`, `relayOffer` passes it.
- `src/streamer/streamer.html` — **modify**; `relayOffer(offer, iceServers)` uses `new RTCPeerConnection({ iceServers })`.
- `src/public/client.html` — **modify**; use `hello.iceServers`; `?relay=1` → `iceTransportPolicy: "relay"`.
- `docker/turnserver.conf` — **new**.
- `docker-compose.yml` — **modify**; add `coturn` service + TURN env.
- `docker/verify-webrtc.mjs` — **modify**; load `/?relay=1` to force TURN relay.
- `README.md` — **modify**; TURN section.

---

## Task 1: buildIceServers helper + index.js wiring

**Files:**
- Create: `src/webrtc/ice-servers.js`, `test/webrtc/ice-servers.test.js`
- Modify: `src/index.js`

**Interfaces:**
- Produces: `export function buildIceServers({ host, user, pass, port = 3478 }) → iceServers[]`. Returns `[]` when any of `host`/`user`/`pass` is missing. Otherwise `[{ urls: "stun:<host>:<port>" }, { urls: "turn:<host>:<port>", username: user, credential: pass }]`.

- [ ] **Step 1: Write the failing test**

`test/webrtc/ice-servers.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIceServers } from "../../src/webrtc/ice-servers.js";

test("buildIceServers: empty when missing creds/host", () => {
  assert.deepEqual(buildIceServers({ host: "coturn" }), []);
  assert.deepEqual(buildIceServers({ host: "coturn", user: "u" }), []);
  assert.deepEqual(buildIceServers({ user: "u", pass: "p" }), []);
});

test("buildIceServers: stun + turn when complete", () => {
  const s = buildIceServers({ host: "coturn", user: "u", pass: "p" });
  assert.equal(s.length, 2);
  assert.equal(s[0].urls, "stun:coturn:3478");
  assert.equal(s[1].urls, "turn:coturn:3478");
  assert.equal(s[1].username, "u");
  assert.equal(s[1].credential, "p");
});

test("buildIceServers: custom port", () => {
  const s = buildIceServers({ host: "h", user: "u", pass: "p", port: 3478 });
  assert.equal(s[0].urls, "stun:h:3478");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/webrtc/ice-servers.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

`src/webrtc/ice-servers.js`:

```js
// Build WebRTC iceServers (STUN + TURN) for a reachable coturn host. coturn
// serves both STUN binding and TURN allocate on the same port (3478). Returns
// [] when TURN credentials or host are absent (e.g. native run, no relay).
export function buildIceServers({ host, user, pass, port = 3478 }) {
  if (!host || !user || !pass) return [];
  return [
    { urls: `stun:${host}:${port}` },
    { urls: `turn:${host}:${port}`, username: user, credential: pass },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/webrtc/ice-servers.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into `src/index.js`**

Add the import near the others:

```js
import { buildIceServers } from "./webrtc/ice-servers.js";
```

Add near the existing `PORT`/`HOST`/`DEFAULT_URL` constants:

```js
const HOST_IP = process.env.MAGPIE_HOST_IP ?? "";
const TURN_USER = process.env.MAGPIE_TURN_USER ?? "magpie";
const TURN_PASS = process.env.MAGPIE_TURN_PASS ?? "magpie";
// Server-side peer (streamer page) reaches coturn by compose service name;
// client-side peer reaches it via the host IP. Both empty when HOST_IP unset
// (native run -> pure host candidates).
const serverIceServers = HOST_IP ? buildIceServers({ host: "coturn", user: TURN_USER, pass: TURN_PASS }) : [];
const clientIceServers = buildIceServers({ host: HOST_IP, user: TURN_USER, pass: TURN_PASS });
```

Pass them through (the `createServer` and `StreamerPeer` changes land in Task 2; here only construct and pass — Task 2 makes the recipients accept them):

```js
  const server = createServer({ browserSession, inputChannel, streamerPeer, clientIceServers });
```

```js
  await streamerPeer.start({ streamerUrl: `${base}/streamer.html?w=${WIDTH}&h=${HEIGHT}`, iceServers: serverIceServers });
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS (35/35 — 32 existing + 3 new). Passing the new keys (`clientIceServers` to `createServer`, `iceServers` to `streamerPeer.start`) is harmless: Task 2 makes the recipients use them, but until then they're ignored (extra object keys).

- [ ] **Step 7: Commit**

```bash
git add src/webrtc/ice-servers.js src/index.js test/webrtc/ice-servers.test.js
git commit -m "feat(webrtc): add buildIceServers helper + index.js TURN env wiring

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Plumb iceServers to both peers

**Files:**
- Modify: `src/server.js`, `src/streamer/StreamerPeer.js`, `src/streamer/streamer.html`, `src/public/client.html`

**Interfaces:**
- `createServer({ browserSession, inputChannel, streamerPeer, clientIceServers = [] })` — `hello` now sends `{ t:"hello", viewport, url, iceServers: clientIceServers }`.
- `StreamerPeer.start({ streamerUrl, iceServers = [] })` stores it; `relayOffer(sdp)` calls `page.evaluate((o, ice) => window.relayOffer(o, ice), sdp, this._iceServers)`.
- `streamer.html`: `window.relayOffer = async (offer, iceServers) => { ... new RTCPeerConnection({ iceServers: iceServers || [] }) ... }`.
- `client.html`: read `hello.iceServers`; `new RTCPeerConnection({ iceServers: hello.iceServers || [] })`; `?relay=1` query param → also set `iceTransportPolicy: "relay"`.

- [ ] **Step 1: `src/server.js` — accept `clientIceServers`, include in hello**

Change the `createServer` signature and the `hello` send (find the existing `send({ t: "hello", viewport: ..., url: ... })`):

```js
export function createServer({ browserSession, inputChannel, streamerPeer, clientIceServers = [] }) {
```

```js
    send({ t: "hello", viewport: browserSession.getViewport(), url: browserSession.getUrl(), iceServers: clientIceServers });
```

- [ ] **Step 2: `src/streamer/StreamerPeer.js` — carry iceServers into the page**

In `start({ streamerUrl })` → rename to `start({ streamerUrl, iceServers = [] })` and store `this._iceServers = iceServers;`. Change `relayOffer`:

```js
  async relayOffer(offerSdp) {
    return this._page.evaluate((o, ice) => window.relayOffer(o, ice), offerSdp, this._iceServers ?? []);
  }
```

- [ ] **Step 3: `src/streamer/streamer.html` — use iceServers in relayOffer**

Change `window.relayOffer = async (offer) => {` to accept and use iceServers; the `new RTCPeerConnection()` line becomes:

```js
  window.relayOffer = async (offer, iceServers) => {
    if (pc) { try { pc.close(); } catch {} }
    pc = new RTCPeerConnection({ iceServers: iceServers || [] });
    pc.addTrack(stream.getVideoTracks()[0]);
```

(rest of `relayOffer` unchanged.)

- [ ] **Step 4: `src/public/client.html` — use hello iceServers + ?relay=1**

In the `hello` branch, store iceServers; in `startPeer`, use them and honor `?relay=1`:

```js
        if (msg.t === "hello") { urlInput.value = msg.url; window._iceServers = msg.iceServers || []; }
```

```js
    const relay = new URLSearchParams(location.search).get("relay") === "1";
    async function startPeer() {
      pc = new RTCPeerConnection({ iceServers: window._iceServers || [], iceTransportPolicy: relay ? "relay" : "all" });
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.ontrack = (e) => { video.srcObject = e.streams[0]; };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      window._ws.send(JSON.stringify({ t: "offer", sdp: pc.localDescription.sdp }));
    }
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (35/35). Existing `server.test.js` and `StreamerPeer.test.js` still pass: `hello` gains an extra `iceServers: []` key (the test checks specific fields, not exact-equality), and `StreamerPeer.test.js` calls `relayOffer(offer)` (iceServers default `[]`) — both fine.

- [ ] **Step 6: Commit**

```bash
git add src/server.js src/streamer/StreamerPeer.js src/streamer/streamer.html src/public/client.html
git commit -m "feat(webrtc): plumb iceServers to both peers (hello + relayOffer)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: coturn service + config + compose

**Files:**
- Create: `docker/turnserver.conf`
- Modify: `docker-compose.yml`, `README.md`

- [ ] **Step 1: Write `docker/turnserver.conf`**

```
# coturn config for magpie (STUN + TURN on 3478). user/external-ip are passed
# via CLI from env so magpie and coturn share one source of truth.
listening-port=3478
listening-ip=0.0.0.0
fingerprint
lt-cred-mech
realm=magpie
min-port=49160
max-port=49200
no-cli
no-tls
no-dtls
log-stdout
```

- [ ] **Step 2: Add the `coturn` service + TURN env to `docker-compose.yml`**

Add `MAGPIE_HOST_IP`/`MAGPIE_TURN_USER`/`MAGPIE_TURN_PASS` to the `magpie` service `environment:`, and add a `coturn` service. Resulting `magpie.environment` includes the existing entries plus:

```yaml
      - MAGPIE_HOST_IP=${MAGPIE_HOST_IP:-}
      - MAGPIE_TURN_USER=${MAGPIE_TURN_USER:-magpie}
      - MAGPIE_TURN_PASS=${MAGPIE_TURN_PASS:-magpie}
```

And append the `coturn` service (sibling, same default network so magpie reaches it as `coturn`; ports published for the browser):

```yaml
  coturn:
    image: coturn/coturn:latest
    command:
      - "-c"
      - "/turnserver.conf"
      - "--user"
      - "${MAGPIE_TURN_USER:-magpie}:${MAGPIE_TURN_PASS:-magpie}"
      - "--external-ip"
      - "${MAGPIE_HOST_IP:-127.0.0.1}"
    volumes:
      - "./docker/turnserver.conf:/turnserver.conf:ro"
    ports:
      - "3478:3478"
      - "3478:3478/udp"
      - "49160-49200:49160-49200/udp"
    restart: unless-stopped
```

- [ ] **Step 3: Add a TURN section to `README.md`**

Append a "TURN relay (Docker + browser video)" section:

```markdown

## TURN relay (Docker + browser video)

By default a browser on a different network scope than the container (e.g.
macOS Docker Desktop) can't reach the container's WebRTC candidates → the page
loads but `<video>` stays black. Run a coturn relay alongside magpie and tell
magpie the host's reachable IP:

```bash
MAGPIE_HOST_IP=192.168.1.42 docker compose up -d   # use the host's LAN IP
curl -s http://localhost:8080/healthz               # ok
# open http://192.168.1.42:8080/ in a browser -> gitee.com over WebRTC (relayed)
```

- `MAGPIE_HOST_IP` **must** be reachable from BOTH the browser and the container
  (the host's LAN IP, not `localhost`). The browser and the container both relay
  media through coturn at this address.
- `MAGPIE_TURN_USER` / `MAGPIE_TURN_PASS` (default `magpie`/`magpie`) are shared
  by magpie and coturn.
- Published ports: `3478/tcp+udp` (STUN/TURN) and `49160-49200/udp` (relay range).
- `iceTransportPolicy: all` → WebRTC auto-selects (direct on Linux host-net,
  relay under Docker). Add `?relay=1` to the client URL to force relay (debug).
- To verify the TURN path from the CLI (forces relay):
  `docker run --rm --network container:$(docker compose ps -q magpie) -v "$PWD/docker/verify-webrtc.mjs:/app/verify.mjs:ro" -w /app magpie node verify.mjs` — expects `VIDEO_OK` with relay forced.
- Note: on macOS Docker Desktop, relayed media depends on Docker Desktop
  hairpinning to the published relay ports. If `?relay=1` shows no video on Mac,
  use Linux host networking (no relay needed) — see Networking above.
- Production hardening: replace static creds with coturn `use-auth-secret` +
  time-limited HMAC credentials generated by magpie (not in v1).
```

- [ ] **Step 4: Validate compose + build coturn image**

Run: `docker compose config > /dev/null` → exits 0.
Run: `docker compose pull coturn` (or let `up` pull it) — confirms the image resolves.

- [ ] **Step 5: Commit**

```bash
git add docker/turnserver.conf docker-compose.yml README.md
git commit -m "feat(docker): add coturn STUN+TURN relay service + TURN docs

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Forced-relay verification

**Files:**
- Modify: `docker/verify-webrtc.mjs`

- [ ] **Step 1: Make the verify script load `/?relay=1`**

In `docker/verify-webrtc.mjs`, change the `page.goto` target so it forces TURN relay (proving media actually relays through coturn, not a host candidate):

```js
  await page.goto("http://localhost:8080/?relay=1", { waitUntil: "domcontentloaded", timeout: 30000 });
```

Also update the inline comment to say it forces relay (`iceTransportPolicy: relay` via the client's `?relay=1`).

- [ ] **Step 2: Bring up both services and run the forced-relay test**

From the repo root (use the host's actual LAN IP — find it first, e.g. `ipconfig getifaddr en0` on macOS):

```bash
HOST_IP=$(ipconfig getifaddr en0 || echo 127.0.0.1)
MAGPIE_HOST_IP=$HOST_IP docker compose up -d
# wait for both services:
for i in $(seq 1 40); do curl -sf http://localhost:8080/healthz >/dev/null && break; sleep 2; done
docker compose ps                       # magpie + coturn both Up
docker run --rm --network container:$(docker compose ps -q magpie) \
  -v "$PWD/docker/verify-webrtc.mjs:/app/verify.mjs:ro" -w /app magpie node verify.mjs
```
Expected: prints `HEALTHZ_OK` then `VIDEO_OK videoWidth=... videoHeight=...` — with `?relay=1` forcing `iceTransportPolicy: relay`, this proves media flows **through coturn**.

Then tear down: `docker compose down`.

- [ ] **Step 3: If the forced-relay test fails on macOS**

A failure here means Docker Desktop is not hairpinning the container's traffic to the published relay ports (a known macOS limitation). Do NOT mark the task failed for this — record the result in the report and note in the README that Linux host networking is the supported path for browser video; the TURN code/config is still correct and works where the network path allows (Linux). If `VIDEO_OK` is reached, the Mac browser path is expected to work too.

- [ ] **Step 4: Commit**

```bash
git add docker/verify-webrtc.mjs
git commit -m "test(docker): force TURN relay in verify-webrtc (iceTransportPolicy: relay)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Done criteria

- `npm test` passes (35/35 including the new `buildIceServers` tests).
- `docker compose up` brings up `magpie` + `coturn` both healthy.
- Forced-relay `docker/verify-webrtc.mjs` prints `VIDEO_OK` (TURN relays media) — or, on macOS where Docker Desktop hairpinning blocks it, the report records that and the README points to Linux host networking.
- All commits on `feat/docker`, each ending with the Co-Authored-By trailer.
