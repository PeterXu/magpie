# 登录状态自定义检测 URL 设计

> 2026-08-22。支持为 group 根域名和单域名设置自定义 full check URL，持久化到磁盘。

## 1. 背景与目标

full 验证的检测 URL 由自动启发式选择（最大 origin → https 兜底），对部分站点不准——如 baidu.com 组的登录态实际由 `passport.baidu.com` 承载，自动选中的首页检测信号弱。本设计允许用户为任意 domain（含 UI 折叠组的根域名）配置检测 URL。

| 验收标准 | 验证方法 |
|------|------|
| 单域名条目可设置/清除检测 URL | ⚙ 弹窗保存后，full 验证访问该 URL |
| group 根域名可设置检测 URL | 组头 ⚙ 配置后，组头验证访问该 URL，结果记在组级 |
| 配置持久化 | 重启 Node 后配置仍在 |
| 未配置时行为不变 | 优先级链：用户配置 > 最大 origin > https 兜底 |

## 2. 存储

**文件**：`browser-data/session-check-urls.json`（user-data-dir 未设置时为项目根下同名目录）

```json
{ "baidu.com": "https://www.baidu.com", "github.com": "https://github.com/settings/profile" }
```

- `SessionRegistry` 构造时 `_loadCheckUrls()` 读入 `_checkUrls: Map<domain, url>`（文件不存在则空 Map）
- 写入原子化：临时文件 + rename
- key 无需存在于 cookie 分组——group 根域名（如 `baidu.com`）本身没有 cookie 条目

## 3. URL 优先级（`_doFullCheck`）

```
1. API 显式传入 checkUrl（测试注入）
2. _checkUrls.get(domain)      ← 用户配置（新增）
3. _pickCheckUrl(group)        ← 最大 origin
4. `https://${domain}`         ← 兜底
```

## 4. group 语义

组头「验证」调用 `check('baidu.com', 'full')`：

- `_checkUrls.get('baidu.com')` 命中第 2 级优先 → 组级单次检查
- 结果记在 `baidu.com` key（`_checkResults`），`list()` 子条目不含它
- 组头徽章：组级结果优先，无则显示成员最新结果（现有 latestCheck 聚合逻辑兜底）
- 子域名条目保留独立验证（自动选 URL）

## 5. API

`src/routes/api/sessions.js` 新增：

| 端点 | 方法 | 请求 | 响应 |
|------|------|------|------|
| `/api/sessions/:domain/check-url` | GET | - | `{ url: string \| null }` |
| `/api/sessions/:domain/check-url` | PUT | `{ url: string }` | `{ success: true, url }` |
| `/api/sessions/:domain/check-url` | DELETE | - | `{ success: true }` |

- PUT 校验：必须以 `http://` 或 `https://` 开头，否则 400；空串等同 DELETE
- 不校验 domain 存在于 cookie 分组
- 不依赖浏览器运行（配置层独立于浏览器生命周期，无 503 分支）

## 6. UI

1. **⚙ 入口**：单域名条目与 group 组头的 actions 区各一个「⚙」按钮，点击弹小对话框：
   - 输入框（预填当前配置，placeholder 提示「留空使用自动选择」）
   - [清除]（DELETE）[保存]（PUT），完成后关对话框并刷新列表
2. **标记**：已配置的条目/组头，徽章区追加 `⚙` 小图标，`title` 悬停显示 URL
3. **组头验证按钮**：新增，调用 `check(根域名, 'full')`，loading 态与 toast 同现有单条目行为

## 7. 影响范围

| 文件 | 变更 |
|------|------|
| `src/session/SessionRegistry.js` | `_checkUrls` Map、`_loadCheckUrls`/`_setCheckUrl`/`_clearCheckUrl`（含原子写盘）、`_doFullCheck` 优先级链插入第 2 级 |
| `src/routes/api/sessions.js` | 3 个 check-url 端点 |
| `src/public/client.html` | ⚙ 按钮 + 弹窗、组头验证按钮、配置标记 |
| `test/session/SessionRegistry.test.js` | 配置读写、优先级、group key、持久化（写盘后重建 registry 仍命中） |
| `test/routes/api/sessions.test.js` | 3 端点契约（含 400、空串→DELETE 语义） |

## 8. 测试

| 测试 | 断言 |
|------|------|
| 配置后优先级 | `_checkUrls` 有值时 `_doFullCheck` 用它而非最大 origin |
| 未配置不变 | 现有 URL 选择用例全部不改仍通过 |
| group key | `check('baidu.com', 'full')` 用组级配置，结果 key 为 `baidu.com` |
| 持久化 | `_setCheckUrl` 后 new 一个 registry（同文件），`_checkUrls` 命中 |
| 原子写 | 写入失败（目录只读模拟）不损坏原文件 |
| PUT 400 | 非 http(s) 前缀、无协议裸域名 |
| 空串 PUT | 语义等同 DELETE，GET 返回 null |

## 9. 不做（YAGNI）

- 每个_origin_粒度的配置（组/域两级已覆盖需求，origin 级配置界面无法承载）
- `session-rules.json` 完整规则体系（custom 策略的 `loggedInPattern` 等，留待该策略立项）
- 配置的导入/导出、批量编辑
- URL 有效性预检（配置时不访问网络，验证时自然暴露错误）
