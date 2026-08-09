# magpie multi-tab support — design

> Extension to the browser-toolbar feature. Single WebRTC stream, multiple
> pages, tab-bar UI for switching. Target: `target="_blank"` links that open
> new tabs in the remote browser.

## Goal

Capture new browser pages (triggered by `target="_blank"` or `window.open`)
and expose them through a **tab bar** in the client UI. Users can switch
between open tabs, close tabs, and create new blank tabs. The WebRTC pipeline
remains single-stream: switching tabs switches which remote page is being
screencast.

## Non-goals

- Multiple concurrent WebRTC streams (each tab streaming in parallel).
- Tab persistence across sessions.
- Tab groups, pinned tabs, or other browser-advanced features.
- Audio per tab (audio not implemented at all in magpie v1).

## Architecture

**Single-stream switching model**:

```
remote browser
  └─ context
       ├─ page 1 (active) ── screencast ──┐
       ├─ page 2                          │
       └─ page 3                          ▼
                                    BrowserSession (manages _pages Map)
                                          │
                                    switchPage(id)
                                          │
                                    WebRTC stream (single)
                                          │
                                    client <video>
```

When the user clicks a tab, `BrowserSession.switchPage(id)` stops screencast
on the old page, starts it on the new page, and broadcasts the updated tab
list. The client redraws the tab bar and the video shows the new page.

## Components

### BrowserSession

**New fields**:

```js
this._pages = new Map();        // pageId → { page, cdp, title, url }
this._activePageId = null;
this._nextPageId = 1;
this.onTabsChange = null;       // fires with { pages, activeId }
```

**Page lifecycle**:

1. **Open**: `context.on('page')` fires → `_registerPage(page)`
2. **Active**: `_activePageId` tracks which page is being screencast
3. **Title update**: `page.on('titlechanged')` → update entry, fire `onTabsChange`
4. **Close**: `page.on('close')` → `_onPageClose(pageId)`

**Key methods**:

| Method | Behavior |
|--------|----------|
| `_registerPage(page)` | Assign pageId, create CDP session, wire events, add to `_pages`, fire `onTabsChange` |
| `switchPage(id)` | Stop screencast on old, start on new, update `_activePageId`, fire `onTabsChange` |
| `closePage(id)` | Close page, remove from `_pages`. If closing active, switch to another. If last, create new `about:blank`. |
| `newPage()` | Open a new `about:blank` page via `_context.newPage()` (will be captured by `context.on('page')`) |
| `getTabsState()` | Return `{ pages: [{id,title,url,active}], activeId }` |

**Closing the last tab**:

Auto-create a new `about:blank` tab (Chrome behavior). This keeps the session
alive and avoids a degenerate "zero pages" state.

### Protocol

**Client → Server**:

| Message | Payload | Effect |
|---------|---------|--------|
| `switch-tab` | `{t:"switch-tab", id}` | `browserSession.switchPage(id)` |
| `close-tab` | `{t:"close-tab", id}` | `browserSession.closePage(id)` |
| `new-tab` | `{t:"new-tab"}` | `browserSession.newPage()` |

**Server → Client**:

| Message | Payload | When |
|---------|---------|------|
| `tabs` | `{t:"tabs", pages:[...], activeId}` | Any page open/close/switch/title-change |
| `hello` | `...` + `pages`, `activeId` | Initial connection (extends existing hello) |

`pages` array structure:

```jsonc
[
  { "id": 1, "title": "Gitee", "url": "https://gitee.com", "active": true },
  { "id": 2, "title": "文档", "url": "https://docs.example.com", "active": false }
]
```

`nav` message (URL bar + history buttons) is **unchanged** and broadcasts
only for the **active page**. `tabs` broadcasts for **any page's state
change**. The two messages are orthogonal.

### server.js

Add handlers in the signaling message switch:

```js
} else if (msg.t === "switch-tab") {
  await browserSession.switchPage(msg.id);
} else if (msg.t === "close-tab") {
  await browserSession.closePage(msg.id);
} else if (msg.t === "new-tab") {
  await browserSession.newPage();
}
```

No direct response — state changes trigger `onTabsChange` which broadcasts
`tabs` to all clients.

### index.js

Wire `context.on('page')` before creating the first page:

```js
this._context = await this._browser.newContext(...);
this._context.on("page", (page) => this._registerPage(page));  // auto-capture new tabs
```

Wire `browserSession.onTabsChange` after server creation:

```js
browserSession.onTabsChange = (state) => server.broadcast({ t: "tabs", ...state });
```

### client.html

**Tab bar HTML** (inserted between `#bar` and `#stage`):

```html
<div id="tabs"></div>
```

**CSS**: dark theme, flex row, scrollable, 28px height. Active tab highlighted.
Close button (×) per tab. "+" button for new tab.

**Rendering**: `renderTabs(msg)` builds tab buttons from `msg.pages`. Click
handlers send `switch-tab`/`close-tab`. "New tab" button sends `new-tab`.

**Message handling**:

- `hello`: call `renderTabs` with `msg.pages`/`msg.activeId`
- `tabs`: call `renderTabs(msg)`

## Edge cases

| Scenario | Handling |
|----------|----------|
| Page title not yet loaded | Show URL as title; `titlechanged` updates it |
| Switch to non-existent pageId | Silently ignored (defensive check in `switchPage`) |
| Close non-active tab | Just remove from list; no page switch |
| Close active tab | Auto-switch to another tab; if last, create `about:blank` |
| Page crash | Existing crash/restart flow wipes `_pages` and starts fresh |
| Concurrent close of multiple tabs | Each `page.on('close')` fires independently; state stays consistent |

## Tests

**`test/browser/BrowserSession.tabs.test.js`** (new):

- New page opens via `context.on('page')` → `_pages` grows
- `switchPage` changes `_activePageId`, screencast switches target
- `closePage` on non-active tab removes it, no switch
- `closePage` on active tab switches to another
- Closing the last tab creates a new `about:blank`
- `onTabsChange` fires on open/close/switch/title-change

**`test/server.test.js`** (extend):

- `switch-tab`/`close-tab`/`new-tab` handlers invoke browserSession methods
- `hello` includes `pages` array

**`test/e2e.test.js`** (optional):

- Click a `target="_blank"` link in the remote page → client receives `tabs`
  message with 2 pages

## Files

| File | Change |
|------|--------|
| `src/browser/BrowserSession.js` | Multi-page management (`_pages`, `switchPage`, `closePage`, `newPage`, `getTabsState`, `onTabsChange`) |
| `src/server.js` | `switch-tab`/`close-tab`/`new-tab` handlers |
| `src/index.js` | Wire `context.on('page')`, `browserSession.onTabsChange` |
| `src/public/client.html` | Tab bar UI + `renderTabs` + message handlers |
| `test/browser/BrowserSession.tabs.test.js` | New file, multi-tab integration tests |
| `test/server.test.js` | Extend with new message tests |