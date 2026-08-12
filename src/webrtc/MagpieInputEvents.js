import { EventEmitter } from './EventEmitter.js';

export class MagpieInputEvents extends EventEmitter {
  constructor(options = {}) {
    super();

    this.send = options.send || (() => {});

    // Persistent listener bindings recorded for destroy()
    this._handlers = [];

    // surface for remote mouse
    this.video = null;

    // Track if mouse is over video (remote browser context)
    this.mouseOverVideo = false;
    this.contextMenu = null;

    // Store last right-click position for menu actions
    this.lastContextMenuX = 0;
    this.lastContextMenuY = 0;
  }

  /**
   * Register a persistent listener and record it for cleanup in destroy()
   */
  _bind(target, type, handler) {
    target.addEventListener(type, handler);
    this._handlers.push({ target, type, handler });
  }

  initSurfaceEvent(video) {
    this.video = video;

    const coords = (evt) => {
      const r = this.video.getBoundingClientRect();
      return { x: evt.clientX - r.left, y: evt.clientY - r.top, displayW: r.width, displayH: r.height };
    };
    const btn = (b) => (b === 2 ? "right" : b === 1 ? "middle" : "left");

    // Track if mouse is over video (remote browser context)
    this._bind(video, "mouseenter", () => { this.mouseOverVideo = true; });
    this._bind(video, "mouseleave", () => { this.mouseOverVideo = false; });

    // Mouse events - use silent mode (don't warn on disconnect)
    this._bind(video, "mousemove", (e) => this.send({ t: "mouse", ...coords(e), type: "moved" }, true));
    this._bind(video, "mousedown", (e) => {
      // e.detail gives click count (1=single, 2=double, 3=triple)
      // Right-click (button=2) is handled here too - contextmenu event just prevents local menu
      this.send({ t: "mouse", ...coords(e), type: "pressed", button: btn(e.button), clickCount: e.detail || 1 }, true);
    });
    this._bind(video, "mouseup", (e) => {
      this.send({ t: "mouse", ...coords(e), type: "released", button: btn(e.button), clickCount: e.detail || 1 }, true);
    });
    this._bind(video, "dblclick", (e) => {
      // Double-click: send with clickCount: 2
      this.send({ t: "mouse", ...coords(e), type: "pressed", button: btn(e.button), clickCount: 2 }, true);
      this.send({ t: "mouse", ...coords(e), type: "released", button: btn(e.button), clickCount: 2 }, true);
    });
    this._bind(video, "wheel", (e) => {
      e.preventDefault();
      this.send({ t: "wheel", ...coords(e), deltaX: e.deltaX, deltaY: e.deltaY }, true);
    });

    // Right-click context menu (local UI that sends commands to remote)
    this._bind(video, "contextmenu", (e) => {
      e.preventDefault();
      this.showContextMenu(e.clientX, e.clientY, e);
    });
  }

  initContextMenu() {
    // Context menu element
    this.contextMenu = document.createElement('div');
    this.contextMenu.id = 'context-menu';
    this.contextMenu.style.cssText = `
      position: fixed;
      background: white;
      border: 1px solid #ddd;
      border-radius: 4px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.2);
      z-index: 10000;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      min-width: 150px;
      padding: 4px 0;
      display: none;
    `;
    document.body.appendChild(this.contextMenu);
  }

  async showContextMenu(clientX, clientY, originalEvent) {
    // Store position for menu actions
    this.lastContextMenuX = originalEvent.offsetX;
    this.lastContextMenuY = originalEvent.offsetY;

    // Check clipboard for paste availability
    let clipboardText = '';
    try {
      clipboardText = await navigator.clipboard.readText();
    } catch (e) {
      // Clipboard not accessible
    }

    // Menu items
    const items = [
      { label: '← 后退', action: 'back' },
      { label: '前进 →', action: 'forward' },
      { label: '⟳ 刷新', action: 'refresh' },
      { divider: true },
      { label: '复制', action: 'copy' },
      { label: '粘贴', action: 'paste', disabled: !clipboardText },
      { label: '全选', action: 'selectall' },
    ];

    this.contextMenu.innerHTML = items.map(item => {
      if (item.divider) {
        return '<div style="height: 1px; background: #eee; margin: 4px 0;"></div>';
      }
      const disabledStyle = item.disabled ? 'opacity: 0.4; cursor: default;' : 'cursor: pointer;';
      return `<div class="context-menu-item" data-action="${item.action}" data-disabled="${item.disabled || ''}" style="padding: 6px 16px; ${disabledStyle}">${item.label}</div>`;
    }).join('');

    // Position menu
    this.contextMenu.style.left = clientX + 'px';
    this.contextMenu.style.top = clientY + 'px';
    this.contextMenu.style.display = 'block';

    // Item elements are recreated each open via innerHTML, so their listeners
    // are GC'd with the old nodes — no need to track them for destroy().
    this.contextMenu.querySelectorAll('.context-menu-item').forEach(el => {
      if (el.dataset.disabled) {
        el.addEventListener('mouseenter', () => {}); // no hover effect
      } else {
        el.addEventListener('click', (ev) => this.handleContextMenuAction(ev));
        el.addEventListener('mouseenter', () => el.style.background = '#f0f0f0');
        el.addEventListener('mouseleave', () => el.style.background = '');
      }
    });
  }

  async handleContextMenuAction(e) {
    const action = e.target.dataset.action;
    this.hideContextMenu();

    switch (action) {
      case 'back':
        this.send({ t: 'back' });
        break;
      case 'forward':
        this.send({ t: 'forward' });
        break;
      case 'refresh':
        this.send({ t: 'refresh' });
        break;
      case 'copy':
        this.send({ t: 'copy', cut: false });
        break;
      case 'paste':
        // Read local clipboard and paste to remote
        try {
          const text = await navigator.clipboard.readText();
          if (text) {
            this.send({ t: 'paste', text });
          }
        } catch (err) {
          console.error('Paste failed:', err);
        }
        break;
      case 'selectall':
        // Double-click to select word/paragraph at the last context menu position
        const r = this.video.getBoundingClientRect();
        const x = this.lastContextMenuX;
        const y = this.lastContextMenuY;
        this.send({ t: 'mouse', x, y, displayW: r.width, displayH: r.height, type: 'pressed', button: 'left', clickCount: 2 }, true);
        this.send({ t: 'mouse', x, y, displayW: r.width, displayH: r.height, type: 'released', button: 'left', clickCount: 2 }, true);
        break;
    }
  }

  hideContextMenu() {
    this.contextMenu.style.display = 'none';
  }

  initDocumentEvents() {
    // Hide menu on click outside or escape
    this._bind(document, 'click', (e) => {
      if (!this.contextMenu.contains(e.target)) {
        this.hideContextMenu();
      }
    });
    this._bind(document, 'keydown', (e) => {
      if (e.key === 'Escape') {
        this.hideContextMenu();
      }
    });
  }

  initWindowEvents() {
    this._bind(window, "keydown", (e) => {
      // Skip all key handling for local input elements (URL bar, etc.)
      if (this.isLocalInput(e)) {
        return;
      }

      // Handle clipboard shortcuts differently based on context
      if (this.isClipboardShortcut(e)) {
        const key = e.key.toLowerCase();

        // For paste (V): always intercept and read local clipboard
        if (key === 'v') {
          e.preventDefault();
          this.handleClipboardShortcut(e);
          return;
        }

        // For copy/cut (C/X): only intercept when in remote context
        if (key === 'c' || key === 'x') {
          if (this.mouseOverVideo) {
            // In remote video: intercept and handle
            e.preventDefault();
            this.handleClipboardShortcut(e);
            return;
          }
          // Outside video: don't intercept, let local browser handle it
          return;
        }

        // For select all (A): only intercept when in remote context
        if (key === 'a') {
          if (this.mouseOverVideo) {
            e.preventDefault();
            this.handleClipboardShortcut(e);
            return;
          }
          // Outside video: don't intercept, let local browser handle it
          return;
        }
      }

      // Normal key event with correct modifiers
      this.send({
        t: "key", type: "keyDown", key: e.key, code: e.code,
        keyCode: e.keyCode, modifiers: this.getModifiers(e)
      });
    });

    this._bind(window, "keyup", (e) => {
      // Skip all key handling for local input elements
      if (this.isLocalInput(e)) {
        return;
      }

      // Don't send keyUp for clipboard shortcuts that were intercepted
      if (this.isClipboardShortcut(e)) {
        const key = e.key.toLowerCase();
        // Paste always intercepted
        if (key === 'v') return;
        // Copy/cut/select-all only intercepted in remote context
        if ((key === 'c' || key === 'x' || key === 'a') && this.mouseOverVideo) return;
      }

      this.send({
        t: "key", type: "keyUp", key: e.key, code: e.code,
        keyCode: e.keyCode, modifiers: this.getModifiers(e)
      });
    });
  }

  // Handle clipboard shortcuts
  async handleClipboardShortcut(e) {
    const key = e.key.toLowerCase();

    if (key === 'v') {
      // Paste: always read local clipboard and send to remote
      if (!await this.requestClipboardPermission()) {
        console.warn('[Clipboard] Permission denied');
        return;
      }

      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          this.send({ t: "paste", text });
        }
      } catch (err) {
        console.error('[Clipboard] Read failed:', err);
      }
    } else if (key === 'c' || key === 'x') {
      // Copy/Cut: only handle when in remote video context
      // When outside video, let local browser handle it normally
      if (this.mouseOverVideo) {
        // In remote context: send to remote and sync back to local clipboard
        this.send({ t: "copy", cut: key === 'x' });
      }
      // else: don't preventDefault, let local browser handle copy normally
    } else if (key === 'a') {
      // Select all: send to remote with correct modifiers
      this.send({
        t: "key", type: "keyDown", key: e.key, code: e.code,
        keyCode: e.keyCode, modifiers: this.getModifiers(e)
      });
      this.send({
        t: "key", type: "keyUp", key: e.key, code: e.code,
        keyCode: e.keyCode, modifiers: this.getModifiers(e)
      });
    }
  }

  // Modifier key bitmask calculation (Alt=1, Ctrl=2, Meta=4, Shift=8)
  getModifiers(e) {
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  }

  // Request clipboard read permission
  async requestClipboardPermission() {
    try {
      const permission = await navigator.permissions.query({ name: 'clipboard-read' });
      if (permission.state === 'granted' || permission.state === 'prompt') {
        return true;
      }
      return false;
    } catch {
      // API not supported, try anyway
      return true;
    }
  }

  // Detect if key event is a clipboard shortcut
  isClipboardShortcut(e) {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const mainKey = isMac ? e.metaKey : e.ctrlKey;
    return mainKey && ['c', 'v', 'x', 'a'].includes(e.key.toLowerCase());
  }

  // Check if event target is a local input element
  isLocalInput(e) {
    const target = e.target;
    const tagName = target.tagName?.toLowerCase();
    return tagName === 'input' || tagName === 'textarea' || target.isContentEditable;
  }

  /**
   * Detach all persistent listeners and remove the context menu from the DOM.
   * Safe to call multiple times.
   */
  destroy() {
    for (const { target, type, handler } of this._handlers) {
      target.removeEventListener(type, handler);
    }
    this._handlers.length = 0;

    if (this.contextMenu && this.contextMenu.parentNode) {
      this.contextMenu.parentNode.removeChild(this.contextMenu);
    }
    this.contextMenu = null;
    this.video = null;
  }
}
