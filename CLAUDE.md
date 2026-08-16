# CLAUDE.md

## What is magpie

Remote browser instance service: single headless Chromium streamed to a single remote user over WebRTC video, with mouse/keyboard/navigation control via WebSocket signaling.

**Session model**: single-instance, single-user, multi-tab.

**Authentication**: single-admin-user JWT with cookie storage.

## Commands

```bash
npm install
npx playwright install chromium
npm start                         # http://localhost:8080/
npm test                          # node --test
```

**Environment**: `src/env.js` auto-loads `.env`. Key variables:
- Server: `PORT`, `HOST`, `MAGPIE_URL`, `MAGPIE_USER_DATA_DIR` (persistent profile dir; empty = in-memory)
- Video: `MAGPIE_WIDTH`, `MAGPIE_HEIGHT`, `MAGPIE_FPS`, `MAGPIE_MAX_BITRATE`, `MAGPIE_DEGRADATION`
- Auth: `MAGPIE_ADMIN_USER`, `MAGPIE_ADMIN_PASSWORD`, `MAGPIE_JWT_SECRET`
- TURN: `MAGPIE_HOST_IP`, `MAGPIE_TURN_HOST`, `MAGPIE_TURN_USER`, `MAGPIE_TURN_PASS`

## Docker

**DO NOT auto-execute Docker commands. Prompt user to run them manually.**

```bash
docker compose up -d
docker compose down
```

## Architecture

```
target page ──CDP screencast──▶ Node ──/internal WS──▶ streamer page
            ──canvas.captureStream()──▶ RTCPeerConnection ──▶ client <video>
```

**Key modules**:
- `src/index.js` - Entry point, browser lifecycle
- `src/browser/BrowserSession.js` - Multi-tab, screencast, CDP input
- `src/streamer/StreamerPeer.js` - WebRTC offer/answer
- `src/session/SessionManager.js` - Multi-client session management

## Testing

`npm test` runs `node --test`. Tests mutating `process.env` must clean up in `finally`.

## Code Conventions

- ESM, explicit `.js` extensions, no build step
- Plain JS classes with `_`-prefixed private fields
- **Four runtime deps**: `playwright`, `ws`, `hono`, `@hono/node-server`
- **Logging**: Only key control points. Format: `[Module] message`. No debug logs.