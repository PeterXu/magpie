# magpie

Remote browser instance service. Runs a headless Chromium with multi-tab support
and streams the active tab to a single remote user over WebRTC video.

**Features:**
- 📋 **Project Introduction Panel**: Welcome page with feature overview
- 🌐 **Remote Browser Control**: Manual connection control with real-time status
- 🎨 **Professional UI**: Light theme inspired by lyrebird design
- 🔌 **Connection State Persistence**: Maintains connection when switching panels

Pipeline: CDP screencast (active tab) → Node → internal WebSocket → a streamer
page draws frames to a <canvas> → canvas.captureStream() → Chromium's native
RTCPeerConnection (libwebrtc) → client. Mouse/keyboard/navigation go over a
signaling WebSocket to Node → CDP. Tab switching is instant — only one tab is
streamed at a time.

## Run

```bash
npm install
npx playwright install chromium
npm start
# open http://localhost:8080/
```

Config via env: `PORT` (default 8080), `MAGPIE_URL` (default `about:blank`).

## Develop

```bash
npm test        # node:test unit + integration + spike + E2E
```

Design: `docs/superpowers/specs/2026-08-08-magpie-remote-browser-design.md`.
Comparison with neko: `docs/superpowers/2026-08-08-magpie-vs-neko.md`.

## Docker

```bash
docker build -t magpie .
# run via compose:
docker compose up -d
curl -s http://localhost:8080/healthz    # -> ok
# then open http://localhost:8080/ in a browser on the same host
docker compose down
```

Or without compose:

```bash
docker run --rm -d -p 8080:8080 --shm-size 2gb \
  -e MAGPIE_NO_SANDBOX=1 -e HOST=0.0.0.0 magpie
```

Open `http://localhost:8080/` in a browser:

**UI Overview:**
- **Left Panel**: Navigation with "项目介绍" (Project Intro) and "远程访问浏览器" (Remote Browser)
- **Project Intro**: Welcome page with feature cards and quick start
- **Remote Browser**: WebRTC video streaming with manual connection control

**Connection Control:**
- **"连接远程" button**: Click to establish WebSocket + WebRTC connection
- **"停止远程" button**: Click to disconnect (preserves state when switching panels)
- **Status Indicator**: Green dot + "已连接" when connected, gray dot + "未连接" when disconnected

**Tab Management:**
- **Tab bar**: Top of page shows all open tabs with titles. Click to switch, "×" to close, "+" to create new.
- **Blank tabs**: Show a magpie watermark background. Navigate to any URL in the address bar.

**Platform Notes:**
- **Linux (same host)**: You'll see and control the browser over WebRTC (the container's docker-bridge `172.x` candidates are host-routable).
- **macOS Docker Desktop**: The page loads and signaling works, but WebRTC video will NOT reach a Mac browser (the container's candidates live in the Docker VM, unroutable from macOS). To verify the WebRTC pipeline on macOS, run the container-network test: `docker run --rm --network container:$(docker compose ps -q magpie) -v "$PWD/docker/verify-webrtc.mjs:/app/verify.mjs:ro" -w /app magpie node verify.mjs` (expects `VIDEO_OK ...`).

Environment: `PORT` (8080), `HOST` (`0.0.0.0`; use `127.0.0.1` for local-only),
`MAGPIE_URL` (`about:blank`), `MAGPIE_NO_SANDBOX` (`1` in the container).

**Networking (production):** the default `ports` mode serves a browser on the same host. For LAN-attached remote clients, switch to host networking on Linux — in `docker-compose.yml` replace the `ports:` block with `network_mode: host`. For Internet clients, a TURN server is required (out of v1 scope).

Keep the `playwright` version in `package-lock.json` matching the Chromium
`npx playwright install` downloads in the image.

## TURN relay (Docker + browser video)

By default a browser on a different network scope than the container (e.g.
macOS Docker Desktop) can't reach the container's WebRTC candidates → the page
loads but `<video>` stays black. Run a coturn relay alongside magpie and tell
magpie the host's reachable IP:

```bash
MAGPIE_HOST_IP=192.168.1.42 docker compose up -d   # use the host's LAN IP
curl -s http://localhost:8080/healthz               # ok
# open http://192.168.1.42:8080/ in a browser -> browser over WebRTC (relayed)
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

## Reference Projects

The `lyrebird` and `mitmproxy` root are reference implementations for HTTP API
recording and traffic inspection features planned for future development.
They are not part of the magpie runtime.
