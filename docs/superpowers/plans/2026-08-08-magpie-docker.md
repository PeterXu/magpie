# magpie Docker Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make magpie deployable via Docker (`docker compose up` runs it; an external browser client reaches it over WebRTC on a Linux host).

**Architecture:** Chromium-only slim image built from `node:22-bookworm-slim` + `npx playwright install --with-deps chromium`. Two code changes make it container-correct: Chromium launched with `--no-sandbox` (etc.) when `MAGPIE_NO_SANDBOX=1`, and the HTTP server binds `HOST` (default `0.0.0.0`) instead of loopback. `docker-compose.yml` uses `network_mode: host` so WebRTC ICE host candidates are reachable by external clients, plus `shm_size` and a healthcheck.

**Tech Stack:** Docker, Docker Compose, Node 22, Playwright (Chromium only).

## Global Constraints

- **Branch:** `feat/docker`.
- **Runtime (host):** Node >= 18, ESM. Tests via `node:test` + `node:assert/strict`; run with `npm test`.
- **Runtime (container):** Node 22 (`node:22-bookworm-slim`); Chromium installed via `npx playwright install --with-deps chromium`.
- **Dependencies:** unchanged (`playwright` + `ws`). No new npm deps.
- **Commit convention:** every commit message ends with a blank line then `Co-Authored-By: Claude <noreply@anthropic.com>`.
- **No STUN/TURN, no multi-arch buildx, no registry push, no CI wiring** in v1 (YAGNI).

---

## File Structure

- `src/browser/launch-options.js` — **new**; `chromiumLaunchOptions()` (sandbox flags gated on `MAGPIE_NO_SANDBOX`).
- `src/index.js` — **modify**; launch via `chromiumLaunchOptions()`, bind `HOST` (default `0.0.0.0`).
- `src/browser/BrowserSession.js` — **modify**; self-launch via `chromiumLaunchOptions()`.
- `test/browser/launch-options.test.js` — **new**; unit test for the helper.
- `Dockerfile` — **new**; Chromium-only slim build.
- `.dockerignore` — **new**.
- `docker-compose.yml` — **new**; host networking + shm_size + healthcheck.
- `README.md` — **modify**; Docker section.

---

## Task 1: Container-correct launch options + HOST bind

**Files:**
- Create: `src/browser/launch-options.js`, `test/browser/launch-options.test.js`
- Modify: `src/index.js` (launch site ~line 12; `PORT`/listen ~lines 7, 21), `src/browser/BrowserSession.js` (launch site ~line 35)

**Interfaces:**
- Produces: `export function chromiumLaunchOptions() → { headless: true, args: string[] }`. `args` is empty by default; when `process.env.MAGPIE_NO_SANDBOX === "1"` it contains `["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]`.

- [ ] **Step 1: Write the failing test**

`test/browser/launch-options.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromiumLaunchOptions } from "../../src/browser/launch-options.js";

test("chromiumLaunchOptions: no flags by default", () => {
  delete process.env.MAGPIE_NO_SANDBOX;
  const opts = chromiumLaunchOptions();
  assert.equal(opts.headless, true);
  assert.deepEqual(opts.args, []);
});

test("chromiumLaunchOptions: adds sandbox flags when MAGPIE_NO_SANDBOX=1", () => {
  process.env.MAGPIE_NO_SANDBOX = "1";
  try {
    const opts = chromiumLaunchOptions();
    assert.equal(opts.headless, true);
    assert.ok(opts.args.includes("--no-sandbox"));
    assert.ok(opts.args.includes("--disable-setuid-sandbox"));
    assert.ok(opts.args.includes("--disable-dev-shm-usage"));
  } finally {
    delete process.env.MAGPIE_NO_SANDBOX;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/browser/launch-options.test.js`
Expected: FAIL — cannot find module `../../src/browser/launch-options.js`.

- [ ] **Step 3: Implement the helper**

`src/browser/launch-options.js`:

```js
// Build Playwright Chromium launch options. In Docker (MAGPIE_NO_SANDBOX=1)
// Chromium must run without the setuid sandbox and use /tmp instead of /dev/shm
// (avoids the default 64MB container /dev/shm crash). Single source for both
// launch sites (index.js shared browser + BrowserSession self-launch).
export function chromiumLaunchOptions() {
  const args = [];
  if (process.env.MAGPIE_NO_SANDBOX === "1") {
    args.push("--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage");
  }
  return { headless: true, args };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/browser/launch-options.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the helper into `src/browser/BrowserSession.js`**

Add the import at the top (next to `import { chromium } from "playwright";`):

```js
import { chromiumLaunchOptions } from "./launch-options.js";
```

Change the self-launch line (currently `this._browser = await chromium.launch({ headless: true });`) to:

```js
      this._browser = await chromium.launch(chromiumLaunchOptions());
```

- [ ] **Step 6: Wire the helper + HOST into `src/index.js`**

Add the import at the top:

```js
import { chromiumLaunchOptions } from "./browser/launch-options.js";
```

Add `HOST` next to the existing `PORT` line (currently `const PORT = Number(process.env.PORT ?? 8080);`):

```js
const HOST = process.env.HOST ?? "0.0.0.0";
```

Change the shared browser launch (currently `const browser = await chromium.launch({ headless: true });`) to:

```js
  const browser = await chromium.launch(chromiumLaunchOptions());
```

Change the server bind (currently `await new Promise((r) => server.listen(PORT, "127.0.0.1", r));`) to:

```js
  await new Promise((r) => server.listen(PORT, HOST, r));
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS (32/32 — the 30 existing tests + 2 new). Confirms the `BrowserSession` change didn't break the screencast/input/E2E tests.

- [ ] **Step 8: Verify the wiring (no runtime side effects)**

Run: `node --check src/index.js && node --check src/browser/BrowserSession.js && node -e "import('./src/browser/launch-options.js').then(m => { if (typeof m.chromiumLaunchOptions !== 'function') throw new Error('missing export'); console.log('ok'); })"`
Expected: prints `ok`. Confirms both modified files parse and the helper module loads with the expected export. (A full boot of `index.js` is verified in Task 2 via `docker compose up` + `/healthz`; `index.js` is an entry point with side effects — launching Chromium — so we avoid running it here.)

- [ ] **Step 9: Commit**

```bash
git add src/browser/launch-options.js src/browser/BrowserSession.js src/index.js test/browser/launch-options.test.js
git commit -m "feat: container-correct Chromium launch + HOST bind for Docker

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Docker packaging (Dockerfile, compose, ignore, docs)

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`
- Modify: `README.md` (append Docker section)

**Interfaces:**
- Consumes: Task 1's `MAGPIE_NO_SANDBOX` / `HOST` / `PORT` / `MAGPIE_URL` env knobs and the `/healthz` endpoint.

- [ ] **Step 1: Write `Dockerfile`**

```dockerfile
# Chromium-only slim build. Pin node:22 and let `playwright install` pull the
# matching Chromium + apt deps. Keep the playwright npm version (package-lock.json)
# in sync with whatever `npx playwright install` downloads.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci \
 && npx playwright install --with-deps chromium \
 && npm cache clean --force
COPY --chown=node:node src ./src
ENV NODE_ENV=production \
    MAGPIE_NO_SANDBOX=1 \
    HOST=0.0.0.0 \
    PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/index.js"]
```

- [ ] **Step 2: Write `.dockerignore`**

```
node_modules/
.git/
.superpowers/
*.log
.DS_Store
mitmproxy
```

(`mitmproxy` is a symlink to `../libs/mitmproxy` outside the repo; `COPY` would otherwise create a broken link.)

- [ ] **Step 3: Write `docker-compose.yml`**

```yaml
services:
  magpie:
    build: .
    # WebRTC: with bridge networking the streamer page's ICE host candidates are
    # the container's private IP and external clients can't reach them. Host
    # networking makes the candidates the host's IP. (Linux; see README caveats.)
    network_mode: host
    shm_size: 2gb            # Chromium stability (default 64MB /dev/shm can crash)
    environment:
      - MAGPIE_URL=https://gitee.com
      - MAGPIE_NO_SANDBOX=1
      - HOST=0.0.0.0
      - PORT=8080
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
```

- [ ] **Step 4: Append a Docker section to `README.md`**

Append:

```markdown

## Docker

```bash
docker build -t magpie .
# run via compose (uses host networking for WebRTC):
docker compose up -d
curl -s http://localhost:8080/healthz    # -> ok
# then open http://localhost:8080/ in a browser on the same host
docker compose down
```

Or without compose:

```bash
docker run --rm -d --network host --shm-size 2gb \
  -e MAGPIE_NO_SANDBOX=1 -e HOST=0.0.0.0 -p 8080:8080 magpie
```

Environment: `PORT` (8080), `HOST` (`0.0.0.0`; use `127.0.0.1` for local-only),
`MAGPIE_URL` (https://gitee.com), `MAGPIE_NO_SANDBOX` (`1` in the container).

Notes:
- **WebRTC networking:** compose uses `network_mode: host` so external browser
  clients can reach the WebRTC ICE candidates. `ports:` is ignored under host
  mode. On **Docker Desktop (macOS/Windows)** host networking is limited — for
  cross-host WebRTC you need a STUN/TURN server and `iceServers` config (not in v1).
- Keep the `playwright` version in `package-lock.json` matching the Chromium
  `npx playwright install` downloads in the image.
```
```

- [ ] **Step 5: Validate compose syntax**

Run: `docker compose config > /dev/null`
Expected: exits 0 (no errors). Confirms the YAML parses and the service definition is valid.

- [ ] **Step 6: Build the image**

Run: `docker build -t magpie .` (use a long timeout — e.g. 600000 ms; first build pulls `node:22-bookworm-slim` and runs `npx playwright install --with-deps chromium`, several minutes)
Expected: `Successfully tagged magpie` / build completes. If it fails on the `playwright install` step, read the apt/npm error before changing anything.

- [ ] **Step 7: Run the container and verify health**

Run: `docker compose up -d && sleep 3 && curl -s http://localhost:8080/healthz`
Expected: prints `ok`. Then `docker compose down`.

(Opening `http://localhost:8080/` in a browser on the same Linux host should show gitee.com over WebRTC. On Docker Desktop the healthz works but external WebRTC may not — that is the documented caveat, not a build failure.)

- [ ] **Step 8: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml README.md
git commit -m "feat: add Docker packaging (Dockerfile, compose, ignore, docs)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Done criteria

- `npm test` passes (32/32 including the new `chromiumLaunchOptions` tests).
- `docker build -t magpie .` succeeds.
- `docker compose up -d` + `curl http://localhost:8080/healthz` returns `ok`.
- All commits on `feat/docker`, each ending with the Co-Authored-By trailer.
