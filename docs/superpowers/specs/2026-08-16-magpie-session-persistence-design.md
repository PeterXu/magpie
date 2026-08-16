# magpie 登录态持久化设计（v2）

> 2026-08-16。替代 `2026-08-09-magpie-session-persistence-design.md`（旧版基于已重构掉的共享 browser 架构撰写）。本文基于当前代码（BrowserSession 自管 browser、StreamerPeer 动态借用 browser、SessionHandler / IdleTimeoutManager 重构后）重新设计。

## 1. 背景与目标

magpie 每次重启后浏览器登录态丢失，用户需重新登录。目标：登录数据自动持久化到磁盘，服务重启后自动恢复，并提供登录状态的可视化管理。

| 验收标准 | 验证方法 |
|------|------|
| 登录态持久化 | 登录淘宝 → 重启服务 → 仍为登录状态 |
| 自动恢复 | 启动时自动加载，无需手动操作 |
| Docker 兼容 | 容器重启后数据不丢失 |
| 可视化管理 | UI 可见登录状态列表，支持检测、删除 |

## 2. 技术选型

采用 Playwright `launchPersistentContext(userDataDir)`：持久 cookie、localStorage、IndexedDB、Preferences 等全部浏览器数据由 Chromium 自动落盘与恢复，指纹一致性最好，无需手动导入导出。备选的 `storageState` 只覆盖 cookies/storage，不完整，弃用。

边界说明：

- sessionStorage 与无过期时间的 session cookie 默认不跨重启恢复（Chromium 行为）。主流站点登录态依赖持久 cookie，不受影响；验收时实测确认。
- WebSQL 已从 Chromium 移除，不在持久化范围。

**关键约束**：持久 context 的 `browser()` 返回 null，无法从它派生新 context。当前 StreamerPeer 启动时经 `browserSession.getBrowser()` 借用 browser（src/streamer/StreamerPeer.js:16），此链路在持久模式下断裂，必须重新设计（见 §3.2）。

## 3. 架构设计

### 3.1 现状

- BrowserSession 自管浏览器：`start()` 内 `chromium.launch()` + `newContext()`；index.js 只传配置，不传 browser 实例。
- StreamerPeer 启动时借用 BrowserSession 的 browser 开独立 context（为 crash 重启设计的动态获取）。
- index.js `shutdown()` 只关 HTTP 服务，浏览器进程靠 Playwright 兜底回收。

### 3.2 目标架构

| 模块 | 变更 |
|------|------|
| BrowserSession | 新增持久模式：设置 `MAGPIE_USER_DATA_DIR` 时 `start()` 走 `launchPersistentContext`；未设置或注入 browser 时保持现有 `launch + newContext` 路径（测试与向后兼容） |
| StreamerPeer | 不再借用 browser，自持独立 Chromium 实例并自管生命周期（`stop()` 关闭、`start()` 重启） |
| index.js | `shutdown()` 补充优雅关闭两个组件，确保 profile 落盘、避免残留 SingletonLock |

StreamerPeer 独立进程的理由：路径解耦（不依赖 `getBrowser()`）；streamer 页不进入用户 profile（history/cache 不被污染）；两个 Chromium 崩溃域隔离。代价是多一个进程（内存约 +200MB），单用户场景可接受。

备选方案：streamer 页放入持久 context 复用进程。省内存，但 streamer 页与用户数据同 profile、生命周期耦合，弃用。

### 3.3 行为修正（旧版文档的错误与遗漏）

1. **初始页处理**：持久 context 启动可能自带初始页。`start()` 需检查已有 pages，复用或关闭，不能假设首页由 `newPage()` 产生。
2. **stop() 语义**：持久模式下 `stop()` 关闭持久 context（即关闭该 Chromium 并落盘）。idle-timeout 的 stop→restart 循环天然成立：磁盘数据保留，重启即恢复登录态。旧版"只清理 pages 不关 context"会导致进程泄漏，不采用。
3. **idle restart 语义变化**：重启后不再是"全新会话"，而是恢复已保存登录态——这正是需求本身，明确接受。
4. **crash 恢复**：现有 onCrash 流程（stop → restart → reload → streamer start）结构不变，持久数据自动随重启恢复。

## 4. 配置与存储

- 新增环境变量 `MAGPIE_USER_DATA_DIR`，默认 `./browser-data/default`；`.env.example` 与 docker-compose.yml 同步。
- 目录布局：`browser-data/` 为持久化根（Docker volume 挂载点）；其下 `default/` 为 Chromium profile（由 Chromium 自动管理，勿手动改动）；`session-registry.json` 放根目录、不进 profile 内部，与 Chromium 文件隔离。
- `.gitignore` 增加 `browser-data/`。
- Docker 权限：镜像以 `USER node` 运行，bind mount 新建目录默认 root 属主，Chromium 无法建 profile。方案：Dockerfile 预建 `/app/browser-data` 并 chown，配合 named volume；bind mount 用法在 README 说明需宿主预建目录并授权。

## 5. 登录状态管理（P1，依赖 §3 完成）

### 5.1 数据

`browser-data/session-registry.json` 记录各站点登录态元数据。字段：`id`、`domain`、`displayName`（可编辑）、`rootUrl`、`checkUrl`、`lastLogin`、`lastCheck`、`status`（valid / expired / unknown）、`cookieCount`。

规则库 `src/session/session-rules.json`：按 domain 预置 `loginPatterns` / `checkUrl` / `successPattern`，初始收录常用站点（淘宝、京东等）。

### 5.2 模块

| 模块 | 职责 |
|------|------|
| `src/session/SessionRegistry.js` | registry 的加载/保存与 session 记录的增删改查 |
| `src/session/SessionDetector.js` | 监听页面导航，按规则库识别"登录页 → 登录成功"跳转，生成/更新记录 |

识别不到的站点：以 domain 作为默认显示名，检测需用户手动配置 checkUrl。

### 5.3 操作与 UI

- 检测：在**后台 tab** 访问 checkUrl 判断是否被重定向到登录页，不抢占用户当前 tab。
- 删除：清除该 domain 相关 cookies + registry 记录；编辑：改显示名/备注；访问：导航到 rootUrl。
- UI：客户端 left-panel 新增"登录状态管理"入口，列表展示各站点状态与操作按钮；走现有 signaling WS 通道扩展消息类型（SessionHandler 增加对应 case）。

## 6. 实施计划

| 阶段 | 内容 | 产出 |
|------|------|------|
| Phase 1 基础持久化（P0） | BrowserSession 持久模式与初始页处理；StreamerPeer 独立化；shutdown 优雅关闭；Docker / gitignore / env 配置；单元与集成测试 | 重启不丢登录态 |
| Phase 2 登录状态管理（P1） | SessionRegistry / SessionDetector / 规则库；WS 消息扩展；客户端 UI；集成测试 | 可视化管理 |
| Phase 3 文档 | `.env.example`、CLAUDE.md、README（部署、目录清理、安全说明） | 验收 |

Phase 2 依赖 Phase 1；各阶段可独立提交验证。

## 7. 测试设计

- 单元：registry 读写；detector 的 domain 提取与规则匹配；持久模式配置解析。
- 集成（持久测试一律用 `fs.mkdtemp` 临时目录）：启动 → 写 cookie → stop → 重新 start → cookie 仍存在；持久模式初始页复用；stop 后进程退出干净。
- 兼容：注入 browser 的旧路径保留，现有 BrowserSession / StreamerPeer 测试按新架构调整后全绿。
- E2E：登录站点 → 重启服务 → 免登录；Docker restart → 免登录；列表展示与删除生效。

## 8. 风险与缓解

| 风险 | 缓解 |
|------|------|
| browser-data 长期增长占磁盘 | 暂不自动清理；README 说明手动清理 |
| 异常退出残留 SingletonLock | shutdown 优雅关闭；启动失败时提示目录被占用 |
| 多实例共用同一 userDataDir | 明确单实例设计，不做支持 |
| 未知站点无规则 | domain 作默认名；检测需手动配 checkUrl |
| 落盘数据含活 cookie（安全） | README 明确目录敏感性；建议收紧目录权限（0700） |
| session cookie 类登录态不恢复 | Chromium 行为限制；验收实测主流站点，必要时后续研究启动 flag |

## 9. 成功标准

- 重启服务 / Docker 容器后登录态保持，启动自动恢复。
- UI 可见登录状态列表，检测、删除可用。
- 无新增运行时依赖；现有功能与测试不受影响。
- 文档（.env.example / CLAUDE.md / README）同步更新。
