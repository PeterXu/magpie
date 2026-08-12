const nativeConsole = globalThis.console;

function timestamp() {
  const now = new Date();
  return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`;
}

const logger = {
  debug(...args) {
    nativeConsole.debug(`[${timestamp()}]`, ...args);
  },

  log(...args) {
    nativeConsole.log(`[${timestamp()}]`, ...args);
  },

  info(...args) {
    nativeConsole.info(`[${timestamp()}]`, ...args);
  },

  warn(...args) {
    nativeConsole.warn(`[${timestamp()}]`, ...args);
  },

  error(...args) {
    nativeConsole.error(`[${timestamp()}]`, ...args);
  },
};

export default logger;