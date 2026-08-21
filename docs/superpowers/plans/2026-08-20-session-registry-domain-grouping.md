# SessionRegistry Domain 分组实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 登录状态列表按 cookie 语义归并 domain（`.baidu.com` 与 `www.baidu.com` 合并为一组），删除时整组清除且不误删相似后缀域名。

**Architecture:** `SessionRegistry` 新增内部 `_groupCookies()` 两遍分组算法（domain cookie 建组 → host-only cookie 按最长后缀匹配归组），`list()` 返回带 `subDomains` 的组列表，`delete()` 重建分组后按组内 cookie 原始 domain 值逐个 `clearCookies`。UI 在 stats 行展示子域。

**Tech Stack:** Playwright BrowserContext cookies API, 无新增依赖

## Global Constraints

- 运行时依赖：仅 playwright, ws, hono, @hono/node-server（本次不新增）
- ESM 模块，显式 `.js` 扩展名
- 日志格式：`[Module] message`
- 代码风格：`_` 前缀表示私有字段
- 测试文件命名：`test/**/*.test.js`（npm test 只匹配该模式）

---

## File Structure

| 文件 | 职责 |
|------|------|
| `src/session/SessionRegistry.js` | 修改：新增 `_groupCookies()`，重构 `list()` 与 `delete()` |
| `test/session/SessionRegistry.test.js` | 修改：新增分组、整组删除、不误删测试 |
| `src/public/client.html` | 修改：`renderSessions()` 显示子域（约 903-915 行） |

---

### Task 1: 分组算法与 list() 重构

**Files:**
- Modify: `src/session/SessionRegistry.js`
- Test: `test/session/SessionRegistry.test.js`

**Interfaces:**
- Consumes: 现有 `context.cookies()` API
- Produces: `list()` 返回 `Array<{domain: string, cookieCount: number, subDomains: string[]}>`；内部 `_groupCookies(cookies)` 返回 `Map<组键, {cookieCount: number, subDomains: Set, rawDomains: Set}>`（Task 2 的 delete 依赖此内部方法）

- [ ] **Step 1: 写失败测试**

在 `test/session/SessionRegistry.test.js` 末尾追加（保留现有 3 个测试不动）：

```javascript
test('SessionRegistry.list merges host-only subdomain into domain-cookie group', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  await context.addCookies([
    { name: 'a', value: '1', domain: '.baidu.com', path: '/' },
    { name: 'b', value: '2', domain: '.baidu.com', path: '/' },
    { name: 'c', value: '3', domain: 'www.baidu.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ context });
  const sessions = await registry.list();

  strictEqual(sessions.length, 1);
  strictEqual(sessions[0].domain, 'baidu.com');
  strictEqual(sessions[0].cookieCount, 3);
  strictEqual(sessions[0].subDomains.length, 1);
  strictEqual(sessions[0].subDomains[0], 'www.baidu.com');

  await context.close();
  await browser.close();
});

test('SessionRegistry.list keeps host-only domains separate without domain cookie', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // No ".example.com" domain cookie — subdomains are separate account systems.
  await context.addCookies([
    { name: 'a', value: '1', domain: 'app.example.com', path: '/' },
    { name: 'b', value: '2', domain: 'login.example.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ context });
  const sessions = await registry.list();

  strictEqual(sessions.length, 2);
  const domains = sessions.map(s => s.domain).sort();
  strictEqual(domains[0], 'app.example.com');
  strictEqual(domains[1], 'login.example.com');

  await context.close();
  await browser.close();
});

test('SessionRegistry.list folds bare-domain host-only cookie into its domain-cookie group', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // "example.com" (host-only) alongside ".example.com" (domain cookie) — one site.
  await context.addCookies([
    { name: 'a', value: '1', domain: '.example.com', path: '/' },
    { name: 'b', value: '2', domain: 'example.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ context });
  const sessions = await registry.list();

  strictEqual(sessions.length, 1);
  strictEqual(sessions[0].domain, 'example.com');
  strictEqual(sessions[0].cookieCount, 2);
  strictEqual(sessions[0].subDomains.length, 0);

  await context.close();
  await browser.close();
});

test('SessionRegistry.list joins longest matching group when multiple groups match', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // a.example.co matches both ".example.co" and ".co" groups (if a ".co"
  // domain cookie existed) — longest key wins. Here: two nested groups.
  await context.addCookies([
    { name: 'a', value: '1', domain: '.example.com', path: '/' },
    { name: 'b', value: '2', domain: '.sub.example.com', path: '/' },
    { name: 'c', value: '3', domain: 'x.sub.example.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ context });
  const sessions = await registry.list();

  // x.sub.example.com ends with ".sub.example.com" (longer) — joins that group,
  // not ".example.com".
  const sub = sessions.find(s => s.domain === 'sub.example.com');
  ok(sub, 'sub.example.com group exists');
  strictEqual(sub.subDomains.length, 1);
  strictEqual(sub.subDomains[0], 'x.sub.example.com');
  const top = sessions.find(s => s.domain === 'example.com');
  ok(top, 'example.com group exists');
  strictEqual(top.subDomains.length, 0);

  await context.close();
  await browser.close();
});
```

同时修改现有分组测试的断言（"groups cookies by domain" 测试现在需要适配新返回结构）：

```javascript
test('SessionRegistry.list groups cookies by domain', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // "example.com" without a leading dot is host-only; no domain cookie
  // exists, so each domain stays its own group (unchanged behavior).
  await context.addCookies([
    { name: 'session1', value: 'a', domain: 'example.com', path: '/' },
    { name: 'session2', value: 'b', domain: 'example.com', path: '/' },
    { name: 'session3', value: 'c', domain: 'other.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ context });
  const sessions = await registry.list();

  strictEqual(sessions.length, 2);
  const example = sessions.find(s => s.domain === 'example.com');
  ok(example);
  strictEqual(example.cookieCount, 2);

  await context.close();
  await browser.close();
});
```

（该测试原本就使用无前导点 domain，行为不变，仅需确认它仍然通过——若已通过则不改。）

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/session/SessionRegistry.test.js
```

Expected: 新增的 merge 测试失败（`sessions.length` 为 2 而非 1，且无 `subDomains` 字段）；独立/折叠/最长匹配测试同样失败。

- [ ] **Step 3: 实现 _groupCookies() 并重构 list()**

将 `src/session/SessionRegistry.js` 的 `list()` 与文件底部整体替换为：

```javascript
  /**
   * 获取所有 domain 分组及其统计
   * @returns {Promise<Array<{domain: string, cookieCount: number, subDomains: string[]}>>}
   */
  async list() {
    if (!this._context) return [];

    const cookies = await this._context.cookies();
    const groups = this._groupCookies(cookies);

    return [...groups.entries()]
      .map(([domain, g]) => ({ domain, cookieCount: g.cookieCount, subDomains: [...g.subDomains] }))
      .sort((a, b) => b.cookieCount - a.cookieCount);
  }

  // Internal: group cookies into domain-keyed entries.
  // Domain cookies (".baidu.com") become group keys ("baidu.com") — the site
  // declares its subdomains share login state. Host-only cookies join the
  // longest matching group key (www.baidu.com ends with ".baidu.com"), fold
  // into a same-key group (bare "example.com" vs ".example.com"), or form
  // their own group when no domain cookie claims them.
  //
  // rawDomains keeps the cookie domains verbatim (leading dot preserved) so
  // delete() can clear each exact value without substring-matching collateral.
  _groupCookies(cookies) {
    const groups = new Map(); // key -> { cookieCount, subDomains: Set, rawDomains: Set }

    // Pass 1: domain cookies (leading dot) establish shared groups.
    for (const cookie of cookies) {
      if (!cookie.domain.startsWith('.')) continue;
      const key = cookie.domain.slice(1);
      let g = groups.get(key);
      if (!g) { g = { cookieCount: 0, subDomains: new Set(), rawDomains: new Set() }; groups.set(key, g); }
      g.cookieCount += 1;
      g.rawDomains.add(cookie.domain);
    }

    // Pass 2: host-only cookies join the longest matching shared group.
    for (const cookie of cookies) {
      if (cookie.domain.startsWith('.')) continue;
      let target = null;
      for (const key of groups.keys()) {
        if (cookie.domain.endsWith('.' + key) && (!target || key.length > target.length)) {
          target = key;
        }
      }
      if (target) {
        const g = groups.get(target);
        g.cookieCount += 1;
        g.subDomains.add(cookie.domain);
        g.rawDomains.add(cookie.domain);
      } else if (groups.has(cookie.domain)) {
        // Bare-domain host-only cookie alongside ".example.com" — same site.
        const g = groups.get(cookie.domain);
        g.cookieCount += 1;
        g.rawDomains.add(cookie.domain);
      } else {
        groups.set(cookie.domain, { cookieCount: 1, subDomains: new Set(), rawDomains: new Set([cookie.domain]) });
      }
    }

    return groups;
  }
```

保留 `delete()` / `check()` 现状（Task 2 处理），保留类结构与导出。

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test test/session/SessionRegistry.test.js
```

Expected: 全部通过（现有 3 个 + 新增 4 个）

- [ ] **Step 5: 提交**

```bash
git add src/session/SessionRegistry.js test/session/SessionRegistry.test.js
git commit -m "feat: group sessions by cookie domain semantics

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: delete() 整组删除

**Files:**
- Modify: `src/session/SessionRegistry.js`
- Test: `test/session/SessionRegistry.test.js`

**Interfaces:**
- Consumes: Task 1 的 `_groupCookies(cookies)`（返回 `Map<组键, {cookieCount, subDomains, rawDomains}>`）
- Produces: `delete(domain)` 删除组键对应的整组 cookies（组键 domain cookie + 全部 subDomains 的 host-only cookies）

- [ ] **Step 1: 写失败测试**

在 `test/session/SessionRegistry.test.js` 末尾追加：

```javascript
test('SessionRegistry.delete removes whole group including subdomains', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  await context.addCookies([
    { name: 'a', value: '1', domain: '.baidu.com', path: '/' },
    { name: 'b', value: '2', domain: 'www.baidu.com', path: '/' },
    { name: 'keep', value: '3', domain: 'other.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ context });
  await registry.delete('baidu.com');

  const cookies = await context.cookies();
  const remaining = cookies.map(c => c.name);
  strictEqual(remaining.length, 1);
  strictEqual(remaining[0], 'keep');

  await context.close();
  await browser.close();
});

test('SessionRegistry.delete does not remove lookalike domains', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // "notbaidu.com" contains "baidu.com" as a substring — must survive.
  await context.addCookies([
    { name: 'a', value: '1', domain: '.baidu.com', path: '/' },
    { name: 'b', value: '2', domain: '.notbaidu.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ context });
  await registry.delete('baidu.com');

  const cookies = await context.cookies();
  strictEqual(cookies.length, 1);
  strictEqual(cookies[0].domain, '.notbaidu.com');

  await context.close();
  await browser.close();
});

test('SessionRegistry.delete on unknown domain is a no-op', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  await context.addCookies([
    { name: 'a', value: '1', domain: '.example.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ context });
  await registry.delete('nomatch.com'); // must not throw

  const cookies = await context.cookies();
  strictEqual(cookies.length, 1);

  await context.close();
  await browser.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/session/SessionRegistry.test.js
```

Expected: "removes whole group" 失败（`clearCookies({domain: 'baidu.com'})` 子串匹配下 notbaidu 类域名会残留或整组测试因 www.baidu.com 未删而失败）；"lookalike" 失败（现行子串实现会误删 `.notbaidu.com`）；"no-op" 可能已通过。

- [ ] **Step 3: 重构 delete()**

将 `src/session/SessionRegistry.js` 中现有 `delete()` 替换为：

```javascript
  /**
   * 删除指定 domain 分组的全部 cookies（组键 domain cookie + 所有 subDomains）
   * 按组内 cookie 的原始 domain 值（保留前导点）逐个清除，
   * 不使用组键子串匹配，避免误删相似后缀域名。
   * @param {string} domain - 组键（list() 返回的 domain 字段）
   */
  async delete(domain) {
    if (!this._context) return;
    const cookies = await this._context.cookies();
    const group = this._groupCookies(cookies).get(domain);
    if (!group) return;
    for (const raw of group.rawDomains) {
      await this._context.clearCookies({ domain: raw });
    }
    logger.log(`[SessionRegistry] Deleted cookie group: ${domain} (${group.rawDomains.size} domains)`);
  }
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test test/session/SessionRegistry.test.js
```

Expected: 全部通过（含现有 "delete removes cookies for domain" 测试——该测试用 host-only `example.com` 独立组，组内 rawDomains 含 `example.com`，删除后为空，仍通过）

- [ ] **Step 5: 提交**

```bash
git add src/session/SessionRegistry.js test/session/SessionRegistry.test.js
git commit -m "feat: delete whole domain group with exact-match clearing

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: UI 显示子域信息

**Files:**
- Modify: `src/public/client.html`（`renderSessions()` 函数，约 897-915 行）

**Interfaces:**
- Consumes: Task 1 的 `list()` 返回结构 `{domain, cookieCount, subDomains}`
- Produces: 列表项 stats 行在有子域时显示“含子域: …”

- [ ] **Step 1: 修改 renderSessions()**

将 `src/public/client.html` 中：

```javascript
            <div class="session-stats">Cookies: ${session.cookieCount || 0} | 检查时间: ${session.lastChecked || '-'}</div>
```

替换为：

```javascript
            <div class="session-stats">Cookies: ${session.cookieCount || 0}${session.subDomains && session.subDomains.length ? ` · 含子域: ${session.subDomains.join(', ')}` : ''}</div>
```

（spec 的 UI 设计将“检查时间”移除——lastChecked 从未由后端填充，显示恒为 "-"，属死信息。若保守起见保留，则仅在其前插入子域片段；采用移除方案，与 spec §5 一致。）

- [ ] **Step 2: 手动验证**

```bash
npm start
```

浏览器打开 http://localhost:8080/ → 登录 → “远程浏览器”面板访问 baidu.com → 切到“登录状态管理”→ 刷新 → 确认只显示一条 `baidu.com` 且 stats 行含“含子域: www.baidu.com”。

- [ ] **Step 3: 提交**

```bash
git add src/public/client.html
git commit -m "feat: show subdomains in sessions list UI

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- [x] §2 分组算法（domain cookie 建组 / host-only 归组 / 最长匹配 / 裸域折叠）→ Task 1
- [x] §3 list() 返回 subDomains → Task 1
- [x] §4 delete() 整组精确删除、不误删、no-op → Task 2
- [x] §5 UI 显示子域 → Task 3
- [x] §6 测试矩阵（合并/独立/整组删除/不误删/空）→ Task 1+2 测试（空数组为现有测试覆盖）

**2. Placeholder scan:** 无 TBD/TODO；所有代码块完整可执行。

**3. Type consistency:** `_groupCookies` 返回的 `{cookieCount, subDomains: Set, rawDomains: Set}` 在 Task 1 定义、Task 2 消费，一致；`list()` 返回的 `subDomains: string[]`（已 spread 为数组）与 Task 3 UI 消费一致。
