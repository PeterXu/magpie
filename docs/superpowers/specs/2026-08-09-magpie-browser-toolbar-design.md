# magpie browser-style toolbar — design

> Companion to the canonical remote-browser design
> (`2026-08-08-magpie-remote-browser-design.md`). Scope: the client page chrome +
> the navigation primitives behind it. The video pipeline is untouched.

## Goal

Replace the floating top-right `{url input + Go}` bar with a browser-style
**top toolbar** spanning the full width, sitting above a **body** that holds the
video. Toolbar: `Back | Forward | Refresh | URL input | Go`. Back/Forward/Refresh
are real (CDP/Playwright history + reload), the URL bar live-syncs as the remote
page navigates, and Back/Forward disable when there is no history in that
direction.

## Non-goals

Multi-session, auth, bookmarks, address-bar search/suggestions, tabs, forward
history pruning, SPA `history.pushState` sync (documented limitation — that is
not a real navigation, so `framenavigated` does not fire).

## Layout

```
┌──────────────────────────────────────────┐
│ ◀  ▶  ⟳  │ https://gitee.com      │ Go  │  ← #bar  (full-width, dark #222)
├──────────────────────────────────────────┤
│                                          │
│            <video>  (centered,           │  ← #stage (flex:1)
│            aspect-preserving)            │
│                                          │
└──────────────────────────────────────────┘
```

`body` is a flex column, `height:100vh`, `overflow:hidden`. `#bar` is
`flex:0 0 auto`. `#stage` is `flex:1`, a centered flex container. `#v` uses
`max-width:100%; max-height:100%; width:auto; height:auto` so it scales to fit
the stage while preserving aspect — the element box equals the content box (no
in-element letterboxing), so the existing no-letterbox assumption in
`coords.js` / `mapClientToPage` stays valid. Any leftover space is `#111` body
background around the video.

## Button → primitive mapping

| Button | Client sends | Server calls (BrowserSession) | Underlying |
|---|---|---|---|
| Back ◀   | `{t:"back"}`    | `goBack()`    | Playwright `page.goBack()` (CDP `Page.navigateToHistoryEntry`) |
| Forward ▶| `{t:"forward"}` | `goForward()` | Playwright `page.goForward()` |
| Refresh ⟳| `{t:"refresh"}` | `reload()`    | Playwright `page.reload()` |
| Go       | `{t:"navigate",url}` (existing) | `navigate(url)` (existing) | `page.goto()` |

All four use `waitUntil:"domcontentloaded"` to match the existing `navigate`.
Enter in the URL input still triggers Go (existing).

## Nav-state push — single path

One server→client message carries the address-bar + button-state:

```jsonc
{ "t":"nav", "url":"https://…", "canBack":true, "canForward":false }
```

It is sent on **every** main-frame navigation via a single mechanism:
`BrowserSession` listens for `page.on("framenavigated")` (main frame only) and
invokes an `onUrlChange` callback, which `index.js` wires to
`server.broadcast({t:"nav", ...browserSession.getNavState()})`. This covers:

- explicit actions (`navigate`/`back`/`forward`/`reload` — all real navigations,
  so `framenavigated` fires),
- **and** passive navigations (the user clicks a link / submits a form inside the
  remote page — no client→server message exists for these; only the frame event
  sees them).

`canBack`/`canForward` come from CDP `Page.getNavigationHistory`:
`currentIndex > 0` ⇒ canBack; `currentIndex < entries.length - 1` ⇒ canForward.
`getNavState()` returns `{url, canBack, canForward}` and never throws (defensive
defaults on any CDP error, like `loadConfig`).

The `hello` message gains `canBack`/`canForward` (alongside the existing `url`)
so the initial button states are correct before any navigation occurs.

`navigate-result` is **removed** — it was a unicast echo of the URL after Go;
`nav` (broadcast, richer) supersedes it. A requester may receive one `nav` from
the `framenavigated` broadcast during an action — that is the only nav message
now, no double-send.

### Edge cases / limitations

- **No history**: Back/Forward are disabled client-side (`canBack`/`canForward`
  false), so the click can't happen. If a no-op `goBack()` is invoked anyway,
  Playwright resolves null, no navigation, no `framenavigated` — no feedback,
  acceptable for v1.
- **Action failure**: a thrown `goto`/`goBack`/`reload` propagates to the
  server's catch → `{t:"error", error}` to the client. The URL bar keeps the
  last known good URL (the broadcast never fired).
- **SPA `pushState`/`replaceState`**: not real navigations; `framenavigated`
  does not fire. The URL bar will not track in-app route changes. Documented v1
  limitation.
- **Crash → restart**: `onUrlChange` is an instance-level field, so it survives
  `restart()`; the fresh page re-registers the listener in `start()`. The reset
  navigation broadcasts a `nav` with the default URL, and the existing `reload`
  broadcast reloads the client page.

## Files

| Path | Change |
|---|---|
| `src/browser/BrowserSession.js` | + `goBack`/`goForward`/`reload`/`getNavState`; + `onUrlChange` callback + `framenavigated` listener (main frame) registered in `start()`, removed in `stop()`. |
| `src/server.js` | `hello` += `canBack`/`canForward`; += `back`/`forward`/`reload` handlers; remove `navigate-result` (navigate sends nothing — broadcast covers it). |
| `src/index.js` | wire `browserSession.onUrlChange` → `server.broadcast({t:"nav",...getNavState()})` after the server exists (mirrors `onCrash` wiring). |
| `src/public/client.html` | toolbar markup + flex layout + CSS; back/forward/reload button handlers; `nav` + `hello` handlers set URL bar + `disabled` on back/forward; drop `navigate-result` handler. |

## Tests

- `test/browser/BrowserSession.nav.test.js` (new, real browser): `goBack`/`goForward`
  round-trip between `about:blank` and the click-target fixture; `reload` keeps
  URL, no throw; `getNavState` reports `canBack`/`canForward` correctly at each
  step; `onUrlChange` fires on `navigate`. Uses the existing shared-browser
  injection pattern from `BrowserSession.test.js`.
- `test/server.test.js` (update): drop the `navigate-result` assertion (navigate
  no longer sends a direct response); assert `back`/`forward`/`reload` invoke the
  mock's methods; `hello` includes `canBack`/`canForward`.
- `test/e2e.test.js` (light touch): the boot helper is unchanged; optionally
  assert a `nav` message arrives after load — only if cheap.
