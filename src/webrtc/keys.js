const PRINTABLE_TEXT = { Enter: "\r", Tab: "\t", Backspace: "\x08" };

export function mapKey({ key, code, keyCode }) {
  const vk = keyCode ?? 0;
  let text = "";
  if (key && key.length === 1) text = key;
  else if (PRINTABLE_TEXT[key]) text = PRINTABLE_TEXT[key];
  return { key: key ?? "", code: code ?? "", windowsVirtualKeyCode: vk, text };
}

export function parseInputMessage(raw) {
  const str = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  let msg;
  try {
    msg = JSON.parse(str);
  } catch {
    throw new Error("invalid input message (not JSON)");
  }
  switch (msg.t) {
    case "mouse":
      return {
        kind: "mouse",
        x: Number(msg.x), y: Number(msg.y),
        displayW: Number(msg.displayW), displayH: Number(msg.displayH),
        type: msg.type, button: msg.button ?? "left",
        clickCount: msg.clickCount ?? 1, buttons: msg.buttons ?? 0,
      };
    case "wheel":
      return {
        kind: "wheel",
        x: Number(msg.x), y: Number(msg.y),
        displayW: Number(msg.displayW), displayH: Number(msg.displayH),
        deltaX: Number(msg.deltaX ?? 0), deltaY: Number(msg.deltaY ?? 0),
      };
    case "key":
      return {
        kind: "key",
        type: msg.type, key: msg.key, code: msg.code,
        keyCode: Number(msg.keyCode ?? 0), modifiers: Number(msg.modifiers ?? 0),
        mapKey: mapKey({ key: msg.key, code: msg.code, keyCode: msg.keyCode }),
      };
    default:
      throw new Error(`unknown input message type: ${msg.t}`);
  }
}
