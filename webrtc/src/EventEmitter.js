/**
 * Lightweight EventEmitter polyfill for browser environments
 * Mimics Node.js EventEmitter API used by MagpiePeer/MagpieConnection/MagpieNegotiator
 */
export class EventEmitter {
  constructor() {
    this._events = new Map();
  }

  on(event, listener) {
    if (!this._events.has(event)) {
      this._events.set(event, []);
    }
    this._events.get(event).push(listener);
    return this;
  }

  once(event, listener) {
    const onceWrapper = (...args) => {
      this.off(event, onceWrapper);
      listener(...args);
    };
    return this.on(event, onceWrapper);
  }

  off(event, listener) {
    if (!this._events.has(event)) return this;
    const listeners = this._events.get(event);
    const index = listeners.indexOf(listener);
    if (index > -1) {
      listeners.splice(index, 1);
    }
    return this;
  }

  emit(event, ...args) {
    if (!this._events.has(event)) return false;
    const listeners = this._events.get(event);
    listeners.forEach(listener => {
      try {
        listener(...args);
      } catch (err) {
        console.error('EventEmitter listener error:', err);
      }
    });
    return true;
  }

  removeAllListeners(event) {
    if (event) {
      this._events.delete(event);
    } else {
      this._events.clear();
    }
    return this;
  }
}