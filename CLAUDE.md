# CLAUDE.md

## What is magpie

Remote browser instance service: single headless Chromium streamed to a single remote user over WebRTC video, with mouse/keyboard/navigation control via WebSocket signaling.

**Session model**: single-instance, single-user, multi-tab. One Chromium instance with multiple tabs, one active tab streamed at a time.

**Authentication**: single-admin-user JWT authentication with cookie storage. Browser requests use cookie; API requests use `Authorization: Bearer <token>`; WebSocket uses `?token=<token>`.

## Commands

```bash
npm install
npx playwright install chromium
npm start                         # http://localhost:8080/
npm test                          # node --test
```

Environment: `src/env.js` auto-loads `.env` at startup. Key variables:
- Server: `PORT`, `HOST`, `MAGPIE_URL`
- Video: `MAGPIE_WIDTH`, `MAGPIE_HEIGHT`, `MAGPIE_QUALITY`, `MAGPIE_FPS`, `MAGPIE_MAX_BITRATE`, `MAGPIE_DEGRADATION`
- Auth: `MAGPIE_ADMIN_USER`, `MAGPIE_ADMIN_PASSWORD`, `MAGPIE_JWT_SECRET`, `MAGPIE_JWT_EXPIRES_IN`
- TURN: `MAGPIE_HOST_IP`, `MAGPIE_TURN_HOST`, `MAGPIE_TURN_USER`, `MAGPIE_TURN_PASS`

Docker: **Do NOT auto-execute Docker commands. Prompt user to run them manually.**

```bash
docker compose up -d
curl -s http://localhost:8080/healthz
docker compose down
```

## Architecture

```
target page ──CDP screencast──▶ Node ──/internal WS──▶ streamer page
            ──canvas.captureStream()──▶ RTCPeerConnection ──▶ client <video>
```

**Video**: CDP `Page.startScreencast` → Node → streamer page canvas → `captureStream()` → WebRTC. The canvas is only a relay; the actual encoder is Chromium's libwebrtc.

**Why CDP**: Headless Chromium cannot use `getDisplayMedia()` (needs OS backend) or extensions (Playwright headless can't load them). Arbitrary sites need CDP screencast.

**Input**: Mouse/keyboard/navigation over `/signaling` WebSocket → Node → CDP. WebRTC carries video only.

## Key Modules

| Module | Purpose |
|--------|---------|
| `src/index.js` | Entry point, shared browser lifecycle, crash→restart |
| `src/browser/BrowserSession.js` | Multi-tab management, screencast, CDP input |
| `src/streamer/StreamerPeer.js` | Streamer page management, WebRTC offer/answer |
| `src/webrtc/InputChannel.js` | Parse input messages, coordinate mapping |
| `src/routes/api/login.js` | Login endpoint, JWT generation, cookie setting |
| `src/middleware/auth.js` | Authentication middleware (header/cookie), JWT verification |
| `src/config.js` | Config loading, auth config, video parameter validation |

**Important**: WebRTC peer is the streamer page (server-side), not the client (recvonly). Client waits for `iceServers` in `hello` message before starting peer.

## Testing

`npm test` runs `node --test`:
- Unit: `test/webrtc/`, `test/browser/launch-options.test.js`
- Integration: `test/browser/BrowserSession.*.test.js` (screencast, input, multi-tab)
- E2E: `test/e2e.test.js` (full stack with real browser)

Tests use `node:test` + `node:assert/strict`. Tests mutating `process.env` must clean up in `finally`.

## Authentication

**Flow**:
- Browser: cookie → authenticated or redirect to `/login.html`
- API: `Authorization: Bearer <token>` header → 401 if invalid
- WebSocket: `?token=<token>` query parameter → reject if invalid

**Implementation**:
- Login endpoint (`/api/login`) validates credentials, generates JWT, sets cookie
- Cookie stored token allows seamless browser authentication
- Middleware checks `Authorization` header first, falls back to cookie
- Empty `MAGPIE_ADMIN_PASSWORD` disables auth (test mode)

## Multi-tab

- `_pages` Map: `pageId → { page, cdp, title, url }`
- `_activePageId`: current screencast target
- Operations: `newPage()`, `switchPage()`, `closePage()` with race condition protection
- Client tab bar renders from `{t:'tabs', ...}` messages

## Client Features

- Left navigation panel (项目介绍 / 远程访问浏览器)
- Manual connection control with status indicator
- Tab bar UI with close buttons
- Clipboard support: Ctrl+C/V/X/A sync between local and remote

## Code Conventions

- ESM, explicit `.js` extensions, no build step
- Plain JS classes with `_`-prefixed private fields
- Pure functions for testable logic (coords, keys, SDP)
- **Four runtime deps**: `playwright`, `ws`, `hono`, `@hono/node-server`

## Docker Notes

- `shm_size: 2gb` required (default 64MB crashes Chromium)
- macOS Docker: WebRTC video won't reach Mac browser (container ICE unroutable)
- TURN relay needed for non-same-host clients
- `docker compose` auto-loads `.env` into container

## Docs

- Architecture: `docs/superpowers/specs/2026-08-08-magpie-remote-browser-design.md`
- Plans: `docs/superpowers/plans/`
- Workflow: brainstorm → spec → plan → implement