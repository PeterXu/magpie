# magpie

Remote browser instance service. Runs a headless Chromium and streams it to a
single remote user over WebRTC video.

Pipeline: CDP screencast (target page) → Node → internal WebSocket → a streamer
page draws frames to a <canvas> → canvas.captureStream() → Chromium's native
RTCPeerConnection (libwebrtc) → client. Mouse/keyboard/navigation go over a
signaling WebSocket to Node → CDP.

## Run

```bash
npm install
npx playwright install chromium
npm start
# open http://localhost:8080/
```

Config via env: `PORT` (default 8080), `MAGPIE_URL` (default https://gitee.com).

## Develop

```bash
npm test        # node:test unit + integration + spike + E2E
```

Design: `docs/superpowers/specs/2026-08-08-magpie-remote-browser-design.md`.

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
- **Linux (same host):** you'll see and control gitee.com over WebRTC (the container's docker-bridge `172.x` candidates are host-routable).
- **macOS Docker Desktop:** the page loads and signaling works, but WebRTC video will NOT reach a Mac browser (the container's candidates live in the Docker VM, unroutable from macOS). To verify the WebRTC pipeline on macOS, run the container-network test: `docker run --rm --network container:$(docker compose ps -q magpie) -v "$PWD/docker/verify-webrtc.mjs:/app/verify.mjs:ro" -w /app magpie node verify.mjs` (expects `VIDEO_OK ...`).

Environment: `PORT` (8080), `HOST` (`0.0.0.0`; use `127.0.0.1` for local-only),
`MAGPIE_URL` (https://gitee.com), `MAGPIE_NO_SANDBOX` (`1` in the container).

**Networking (production):** the default `ports` mode serves a browser on the same host. For LAN-attached remote clients, switch to host networking on Linux — in `docker-compose.yml` replace the `ports:` block with `network_mode: host`. For Internet clients, a TURN server is required (out of v1 scope).

Keep the `playwright` version in `package-lock.json` matching the Chromium
`npx playwright install` downloads in the image.
