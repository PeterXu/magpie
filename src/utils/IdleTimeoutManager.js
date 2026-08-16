/**
 * IdleTimeoutManager - 管理浏览器空闲超时释放
 *
 * 监听 WebSocket 连接变化，当没有客户端连接超过指定时间时，
 * 发出 idle-stop 事件。当新客户端连接且浏览器已停止时，
 * 发出 idle-restart 事件。
 */
export class IdleTimeoutManager {
  /**
   * @param {Object} options
   * @param {BrowserSession} options.browserSession - 浏览器会话实例
   * @param {number} options.timeoutMinutes - 超时时间（分钟）
   */
  constructor({ timeoutMinutes = 30 }) {
    this._timeoutMinutes = timeoutMinutes;

    this._lastDisconnectTime = null;
    this._browserStopped = false;
    this._checkInterval = null;
    this._stopping = false;

    // Event callbacks
    this.onStop = null;     // Called when idle timeout triggers stop
    this.onRestart = null;   // Called when new client connects after stop
  }

  /**
   * 启动空闲超时管理
   * @param {number} initialClientCount - 启动时的客户端数量（默认 0）
   */
  start(initialClientCount = 0) {
    if (this._timeoutMinutes <= 0) {
      console.log('[IdleTimeout] Idle timeout disabled');
      return;
    }

    // 如果启动时没有客户端连接，立即开始空闲计时
    if (initialClientCount === 0) {
      this._lastDisconnectTime = Date.now();
      console.log('[IdleTimeout] No clients on startup, idle timer started');
    }

    // 每分钟检查一次
    this._checkInterval = setInterval(() => this._checkIdle(), 60 * 1000);
    console.log(`[IdleTimeout] Idle timeout enabled: ${this._timeoutMinutes} minutes`);
  }

  /**
   * 停止空闲超时管理（仅清理定时器；不触发 onStop —— 组件 teardown
   * 由调用方 shutdown 显式负责）
   */
  async stop() {
    if (this._checkInterval) {
      clearInterval(this._checkInterval);
      this._checkInterval = null;
    }
  }

  /**
   * 处理连接数量变化
   * @param {number} clientCount - 当前客户端数量
   */
  async handleConnectionChange(clientCount) {
    console.log(`[Connection] Client count: ${clientCount}`);

    if (clientCount === 0) {
      // 最后一个客户端断开
      this._lastDisconnectTime = Date.now();
      console.log('[Connection] Last client disconnected, idle timer started');
    } else {
      // 有客户端连接
      this._lastDisconnectTime = null;

      // 如果浏览器已停止，发出重启事件
      if (this._browserStopped) {
        console.log('[IdleTimeout] New client connecting, emitting idle-restart event');
        if (this.onRestart) {
          try {
            await this.onRestart();
            // 成功重启后重置标志
            this._browserStopped = false;
            console.log('[IdleTimeout] Browser restarted successfully');
          } catch (err) {
            console.error('[IdleTimeout] onRestart callback error:', err);
          }
        }
      }
    }
  }

  /**
   * 检查是否需要关闭浏览器
   */
  async _checkIdle() {
    if (this._stopping) {
      return;
    }

    if (!this._lastDisconnectTime || this._browserStopped) {
      return;
    }

    const idleMinutes = (Date.now() - this._lastDisconnectTime) / 1000 / 60;

    if (idleMinutes >= this._timeoutMinutes) {
      console.log(`[IdleTimeout] Browser idle for ${idleMinutes.toFixed(1)} minutes, emitting idle-stop event`);

      // Set stopping flag BEFORE async operation
      this._stopping = true;

      try {
        // 发出停止事件，让外部决定如何停止
        if (this.onStop) {
          await this.onStop();
        }
        this._browserStopped = true;
        this._lastDisconnectTime = null;
        console.log('[IdleTimeout] Browser stopped successfully');
      } catch (err) {
        console.error('[IdleTimeout] Failed to stop browser:', err);
      } finally {
        this._stopping = false;
      }
    }
  }
}
