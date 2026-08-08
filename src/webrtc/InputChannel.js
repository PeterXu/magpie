import { parseInputMessage } from "./keys.js";
import { mapClientToPage } from "./coords.js";

export class InputChannel {
  constructor({ browserSession, viewportProvider }) {
    this._bs = browserSession;
    this._vp = viewportProvider;
  }

  async handle(raw) {
    let event;
    try { event = parseInputMessage(raw); } catch { return; }
    const vp = this._vp.getViewport();

    if (event.kind === "mouse") {
      if (!(event.displayW > 0 && event.displayH > 0)) return;
      const { x, y } = mapClientToPage({
        clientX: event.x, clientY: event.y,
        displayW: event.displayW, displayH: event.displayH,
        pageW: vp.width, pageH: vp.height,
      });
      if (!(Number.isFinite(x) && Number.isFinite(y))) return;
      await this._bs.dispatchMouse({ x, y, type: event.type, button: event.button, clickCount: event.clickCount, buttons: event.buttons });
    } else if (event.kind === "wheel") {
      if (!(event.displayW > 0 && event.displayH > 0)) return;
      const { x, y } = mapClientToPage({
        clientX: event.x, clientY: event.y,
        displayW: event.displayW, displayH: event.displayH,
        pageW: vp.width, pageH: vp.height,
      });
      if (!(Number.isFinite(x) && Number.isFinite(y))) return;
      await this._bs.dispatchWheel({ x, y, deltaX: event.deltaX, deltaY: event.deltaY });
    } else if (event.kind === "key") {
      await this._bs.dispatchKey({ type: event.type, mapKey: event.mapKey, modifiers: event.modifiers });
    }
  }
}
