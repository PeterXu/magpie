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
