# Magpie Clipboard Support Design

**Date**: 2026-08-09
**Status**: Approved
**Scope**: Complete clipboard support for remote browser (copy, paste, cut, select-all)

## Overview

Enable bidirectional clipboard synchronization between local client and remote browser, supporting:
- Local copy → remote paste
- Remote copy → local paste
- Remote internal copy/paste

## Architecture

```
Local → Remote Paste:
  Client intercepts Ctrl/Command+V
  → Read local clipboard
  → WebSocket {t:"paste", text:"..."}
  → Server CDP Input.insertText

Remote → Local Copy:
  Server monitors remote copy event (CDP)
  → Read remote selection via CDP
  → WebSocket {t:"clipboard", text:"..."}
  → Client writes local clipboard

Remote Internal Copy/Paste:
  Correct modifier key transmission (Ctrl/Meta)
  → CDP Input.dispatchKeyEvent
  → Remote browser handles internally
```

## Core Components

### 1. Modifier Key Fix

**Problem**: Client hardcodes `modifiers: 0`, losing Ctrl/Meta state.

**Solution**: Calculate correct modifier bitmask.

**Bitmask values**:
- Alt = 1
- Ctrl = 2
- Meta/Command = 4
- Shift = 8

**Client implementation** (`src/public/client.html`):
```javascript
function getModifiers(e) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}
```

### 2. Clipboard Interception

**Client** (`src/public/client.html`):

```javascript
function isClipboardShortcut(e) {
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const mainKey = isMac ? e.metaKey : e.ctrlKey;
  return mainKey && ['c', 'v', 'x', 'a'].includes(e.key.toLowerCase());
}

async function handleClipboardShortcut(e) {
  const key = e.key.toLowerCase();

  if (key === 'v') {
    // Paste: read local clipboard, send to remote
    try {
      const text = await navigator.clipboard.readText();
      send({ t: "paste", text });
    } catch (err) {
      console.error('Failed to read clipboard:', err);
    }
  } else if (key === 'c' || key === 'x') {
    // Copy/Cut: request remote read
    send({ t: "copy", cut: key === 'x' });
  } else if (key === 'a') {
    // Select all: pass through
    send({ t: "key", type: "keyDown", key: e.key, code: e.code,
           keyCode: e.keyCode, modifiers: getModifiers(e) });
  }
}

// Receive remote clipboard
function handleMessage(msg) {
  if (msg.t === 'clipboard') {
    navigator.clipboard.writeText(msg.text).catch(err => {
      console.error('Failed to write clipboard:', err);
    });
  }
}
```

### 3. Server Message Handling

**InputChannel** (`src/webrtc/InputChannel.js`):

```javascript
async handle(raw) {
  let event;
  try { event = parseInputMessage(raw); } catch { return; }

  if (event.kind === "paste") {
    await this._bs.insertText(event.text);
  } else if (event.kind === "copy") {
    await this._bs.handleCopy(event.cut);
  }
  // ... existing handlers
}
```

**Message parser** (`src/webrtc/keys.js`):

```javascript
export function parseInputMessage(raw) {
  const str = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  let msg;
  try {
    msg = JSON.parse(str);
  } catch {
    throw new Error("invalid input message (not JSON)");
  }
  switch (msg.t) {
    // ... existing cases
    case "paste":
      return { kind: "paste", text: String(msg.text ?? "") };
    case "copy":
      return { kind: "copy", cut: Boolean(msg.cut) };
    default:
      throw new Error(`unknown input message type: ${msg.t}`);
  }
}
```

### 4. CDP Layer Operations

**BrowserSession** (`src/browser/BrowserSession.js`):

```javascript
async insertText(text) {
  const entry = this._pages.get(this._activePageId);
  if (!entry) return;

  // Limit text length (prevent oversized content)
  const maxLength = 100000; // 100KB
  const safeText = text.substring(0, maxLength);

  try {
    await entry.cdp.send("Input.insertText", { text: safeText });
  } catch (err) {
    console.error('CDP insertText failed:', err);
    // Fallback: send char by char
    await this._fallbackInsertText(entry, safeText);
  }
}

async _fallbackInsertText(entry, text) {
  for (const char of text) {
    await entry.cdp.send("Input.dispatchKeyEvent", {
      type: "char",
      text: char
    });
  }
}

async handleCopy(cut = false) {
  const entry = this._pages.get(this._activePageId);
  if (!entry) return;

  // Send Ctrl/Command+C or X
  const isMac = process.platform === 'darwin';
  const modifiers = isMac ? 4 : 2;

  await entry.cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: cut ? 'x' : 'c',
    code: cut ? 'KeyX' : 'KeyC',
    modifiers: modifiers
  });

  // Wait for browser to process
  await new Promise(resolve => setTimeout(resolve, 100));

  // Read remote clipboard
  try {
    const result = await entry.cdp.send("Runtime.evaluate", {
      expression: "navigator.clipboard.readText()",
      awaitPromise: true
    });

    if (result.result && result.result.value && this.onClipboardChange) {
      this.onClipboardChange({ text: result.result.value });
    }
  } catch (err) {
    console.error('Failed to read remote clipboard:', err);
  }
}
```

**Setup callback** (`src/index.js`):

```javascript
browserSession.onClipboardChange = (data) => {
  server.broadcast({ t: "clipboard", text: data.text });
};
```

### 5. WebSocket Protocol Extensions

**New message types**:

**Client → Server**:
- `{t: "paste", text: "..."}` - Insert text to remote
- `{t: "copy", cut: boolean}` - Request remote clipboard read

**Server → Client**:
- `{t: "clipboard", text: "..."}` - Remote clipboard content

### 6. Error Handling

**Client permission handling**:

```javascript
async function requestClipboardPermission() {
  try {
    const permission = await navigator.permissions.query({ name: 'clipboard-read' });
    if (permission.state === 'granted' || permission.state === 'prompt') {
      return true;
    }
    return false;
  } catch {
    return true; // Try anyway if API unsupported
  }
}

async function handleClipboardShortcut(e) {
  const key = e.key.toLowerCase();

  if (key === 'v') {
    if (!await requestClipboardPermission()) {
      console.warn('Clipboard permission denied');
      return;
    }

    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        send({ t: "paste", text });
      }
    } catch (err) {
      console.error('Clipboard read failed:', err);
      alert('无法访问剪贴板，请使用浏览器菜单粘贴');
    }
  }
  // ... other handling
}
```

**Server safeguards**:
- Text length limit (100KB)
- CDP error fallback (char-by-char insertion)
- Null/undefined checks

## Testing Strategy

### Unit Tests

**`test/webrtc/clipboard.test.js`**:
- Modifier bitmask calculation
- Clipboard shortcut detection
- Message parsing

### Integration Tests

**`test/browser/BrowserSession.clipboard.test.js`**:
- `insertText()` functionality
- `handleCopy()` clipboard read
- Fallback text insertion

### E2E Tests

**`test/e2e.clipboard.test.js`**:
- Complete paste flow (local → remote)
- Complete copy flow (remote → local)
- Cross-platform modifier handling

## Limitations

1. **Text only**: Only supports plain text, no rich content or files
2. **Browser permission**: Requires clipboard-read permission on client
3. **Remote clipboard API**: Depends on remote page supporting `navigator.clipboard.readText()`
4. **Timing**: 100ms delay for remote copy may need adjustment for slow pages

## Security Considerations

- Client-side permission prompt before reading clipboard
- Server-side text length limit prevents abuse
- No execution of clipboard content (text insertion only)
- HTTPS required for clipboard API in production

## Implementation Notes

- Preserve existing keyboard handling for non-clipboard shortcuts
- Graceful degradation when clipboard API unavailable
- Cross-platform detection (Mac vs Windows/Linux)
- Handle edge cases: empty clipboard, large text, special characters