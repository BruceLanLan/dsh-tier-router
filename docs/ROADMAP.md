# dsh-tier-router 路线图（2026-09-03 起）

依据：`docs/REVIEW-2026-09-03.md`。每个里程碑按 T6 交接单写法：目标、背景事实、约束、带验证点的步骤、范围边界、完成定义。按风险与信息增益排序，最不确定的在前。M0 已完成，M1 是下一步。

通用约束（每个里程碑都适用）：
- 不改宿主 DSH，只用官方接缝（事件、服务、settings、session log）。
- 不动 `~/.dsh/vendor/*`，部署走 `dsh plugin --profile web add <仓库路径>` + 重启。
- 每个行为变更配 `node:test` 用例，并做一次负控制（去掉修复该用例必须失败）。
- 文档中文优先（README.zh.md 与 README.md 同步），代码与 commit 英文。
- 宣布完成前跑 `npm test && npm run check && node --check client/client.js`，把真实输出贴进完成声明。

---

## M0 · v0.5.1 评审修复 —— 已完成

见 REVIEW 报告「本轮改动清单」。`npm test` 86/86。

---

## M1 · 实机验收 0.5.1（下一步，1 次会话）

目标：在真实 DSH 进程里确认 M0 的三个修复生效，并把 README「已实测」表格更新为 0.5.1 的记录。

背景事实：
- 本机 DSH 0.1.0-rc.8，web profile 通过 vendor link 使用 0.5.0；`~/.dsh/logs/web-supervisor.log` 里能看到 `tier: active — …` 启动行。
- `tier_worker` 竞态在 `mode=auto`、计划未激活、`subagentPolicy=inherit` 下最容易复现。
- `TIMEOUT` 可用一个指向不可达 `baseURL` 的 pi-ai provider 制造；`NO_ADAPTER` 可用未注册的 provider 名制造。

步骤：
1. 部署：`dsh plugin --profile web add /Users/bruce/Documents/deepseek_harness_test/dsh-tier-router`，重启 dsh web → 验证点：supervisor 日志出现新的 `tier: active` 行，`/tier status` 显示 `config persisted: yes`。失败：回滚到 vendor 0.5.0 链接，上报。
2. worker 竞态：新建 tiered 会话，保持 auto/计划关闭/inherit，让模型调用 `tier_worker({ task: "回答 1+1", tier: "strong" })` → 验证点：子会话 session log 的首个 `request/header` 为强档 provider/model 且 `reasoningEffort` 等于强档 effort；工具返回 `model` 与之一致。失败：贴子会话 header 到 issue，回到 M0 排查 `adoptPendingWorker` 匹配条件。
3. 回退触发：`/tier set cheap <坏provider> <model> medium --fallback deepseek-official deepseek-v4-flash high`，发一条消息 → 验证点：session log 出现 `llm/retry`（宿主退避）之后才出现插件写的 `request/header`（回退路由），`/tier status` 的 `lastFallback` 含 `TIMEOUT` 或 `NO_ADAPTER`。失败：记录 failure.code 实际值，回 `classifyFallback`。
4. 守卫：弱档下让模型执行 `sh -c "rm -rf /tmp/x"` → 验证点：被 deny，理由含 `recursive force delete`。
5. 更新 README 两份「已实测」表格为 0.5.1 结果，附日期。

范围边界：不做新功能；不发布 npm。
完成定义：4 个验证点都有日志/截图证据；README 表格更新并提交。

---

## M2 · 安全模型收紧（小，1 次会话）

目标：弱档模型不能一次调用就持久化改全局配置；守卫定位在文档里说清。

背景事实：`tier_configure` 默认 `sessionOnly: false` 直接写 settings；守卫拒绝理由会引导模型调 `tier_route strong`；`tools/pre-execute` 支持返回 `ask` 走宿主审批（无审批能力时退化为 deny）。

步骤：
1. `tier_configure` 默认改为内存生效，新增 `durable: true` 才持久化（`/tier set` 命令仍默认持久化，因为它是用户手打的） → 验证点：smoke 测试 `tier_configure persists … by default` 反转为「默认不持久化」，`/tier set` 用例仍通过。失败：保持现状，改为方案 2。
2. 备选/叠加：在 `tools/pre-execute` 对 `tier_configure` 且 `durable: true` 返回 `{ kind: 'ask' }` → 验证点：mock 中 `ask` 被返回；实机上弹出审批。
3. README「高危升级门」段落加一句定位声明：守卫是弱档的减速带，`tier_route strong` 本身就是设计内的升级通道；列出未覆盖的命令族。
4. 守卫扩展决策（需用户拍板，逐项 yes/no）：`git reset --hard`、`git branch -D`、`git checkout -- . / git restore .`、`rsync --delete`、`node -e/perl -e` 删除、`truncate`、`docker system prune`、`kubectl delete`、`terraform destroy`、`DROP TABLE/DATABASE`、`npm publish`、`pwsh Remove-Item -Recurse -Force`。每接受一项加正反测试。

范围边界：不引入权限系统；不改宿主审批 UI。
完成定义：默认调用 `tier_configure` 不再写 settings；文档定位段落上线；决策清单每项有明确 yes/no 记录在 CHANGELOG。

---

## M3 · 会话级模式持久化（中，1～2 次会话）

目标：`/tier strong|cheap|auto|delegated|off` 与手动 effort 在 DSH 重启、compact 后仍对该会话生效。

背景事实：
- 插件已经用「fold session log」的方式读计划状态（`planActive` 遍历 `plan/mode` 事件），同样的模式可用于自定义事件。
- `session.append(type, data)` 可写任意事件类型（`/tier plan` 已经在 planMode 不可达时追加 `plan/mode`）。
- 宿主有 `agent/session-start` 事件，`source` 为 `startup | resume | clear | compact`。

步骤：
1. 定义事件 `tier/mode`（data: `{ mode, effort?, by: 'command'|'tool' }`），`applyRoute`/`/tier effort` 在更新 WeakMap 的同时 append → 验证点：smoke 测试里 `main.writes` 出现 `tier/mode`。
2. `effectiveMode(agent)` 改为：WeakMap 有值用 WeakMap，否则 fold session log 最后一条 `tier/mode`，再否则全局默认 → 验证点：构造 events 里带 `tier/mode: off` 的 agent，inbox 处理器不写 header。
3. 监听 `agent/session-start`，`source === 'resume' | 'compact'` 时预热 WeakMap 并重新 `applyTarget` → 验证点：mock 触发 resume 后 `/tier status` 的 this session 与 log 一致。
4. 实机：设 `/tier off`，重启 DSH，恢复会话，`/tier status` 仍为 off。
5. 更新 README 已知限制。

范围边界：不持久化 escalation/fallback 的瞬态记录（它们本来就该过期）。
完成定义：单元 + 实机验证点通过；README 限制条目删除。

---

## M4 · 阈值与 TTL 可配置（小，1 次会话）

目标：`escalateThreshold/escalateWindowMs/escalateTtlMs/fallbackTtlMs/effortTtlMs` 进 settings 命名空间，WebUI 卡片可改。

步骤：
1. `tierSchema` 增加 5 个字段（带默认值与范围校验），`settingsScope.watch` 同步进 `state` → 验证点：smoke 测试改 mock settings 值后 `/tier status` 的 `escalate:` 行随之变化。
2. `client/client.js` 增加「阈值」卡片（5 个数字输入），删掉 `ttlNote` 文案 → 验证点：`node --check` 通过；实机页面能改并热生效。
3. README 配置段落更新。

范围边界：不做每会话阈值。
完成定义：设置改动无需重启即反映在 `/tier status`。

---

## M5 · 思考强度信号重构（中，需先拍板）

目标：effort 阶梯只由「模型在这个任务上吃力」的信号触发。

背景事实：现在可用性错误与守卫拒绝也会抬 effort（REVIEW 发现 5）。

决策点（先问用户）：是否接受删除这两个触发；是否接受新增「同一 turn 内工具结果 error ≥ 2 → 抬一级」。

步骤（若接受）：
1. `agent/error` 处理器里去掉 `raiseCheapEffort`；守卫 deny 去掉 raise → 验证点：对应两个 smoke 用例改为断言 effort 不变。
2. 监听 `tools/post-execute`（或 fold `tool/result` 事件），按 agent 统计当前 turn 内 `isError` 结果，达阈值抬一级并写 `diag.lastEffort` → 验证点：mock 两次 error 结果后 `/tier status` 显示 `cheap effort: high`。
3. 系统提示词段落同步措辞。

完成定义：CHANGELOG 记录语义变化；实机一轮验证。

---

## M6 · 成本可观测（中，价值最高，1～2 次会话）

目标：回答「这个会话各档各花了多少 token / 大约多少钱」，这是分层路由存在的理由。

背景事实：
- 宿主每步在 session log 追加 `assistant/message`，data 含 `message.source.provider/model` 与可选 `usage`。
- 插件已知每次路由变更的时刻与目标。

步骤：
1. 每次 `applyTarget` 成功后 append `tier/route`（data: `{ tier, provider, model, reasoningEffort, reason }`，reason ∈ inbox/plan/escalation/fallback/command/tool/worker） → 验证点：smoke 测试里每次 header 写入伴随一条 `tier/route`。
2. `/tier cost`：fold 本会话 `assistant/message` 的 usage，按 `source.provider/model` 汇总输入/输出 token，并按 `tier/route` 把每步归到档位 → 验证点：mock events 三步（2 强 1 弱）输出两行汇总。
3. 可选单价表（settings 里按 provider/model 填 ¥/百万 token），有则输出估算金额，无则只输出 token。
4. WebUI 卡片显示最近 N 个会话的汇总（可后置）。

范围边界：不接账单 API；不做跨进程持久化汇总。
完成定义：`/tier cost` 在实机上输出与 session log 手工统计一致的数字。

---

## M7 · 结构重构（中，纯重构，1 次会话）

目标：`lib/index.js` 拆成职责单一的模块，行为零变化。

步骤（每步跑全量测试）：
1. 抽 `lib/routing-state.js`：`state`、WeakMap 集合、`effectiveMode/planActive/tierNameFor/effectiveTarget/applyTarget/ensureHeader/captureBaseline`（导出工厂函数，注入 `llm/agentDefaultModel/diag`）。
2. 抽 `lib/fallback.js`：`triggerFallback/activeFallbackTarget/raiseCheapEffort/escalation`。
3. 抽 `lib/guard.js`：`tools/pre-execute` 监听器。
4. 抽 `lib/tools.js` 与 `lib/commands.js`、`lib/prompt.js`。
5. `lib/index.js` 只剩 `apply()` 组装与 preset sync 分支。

验证点：每步后 `npm test` 86/86，`npm pack --dry-run` 文件清单包含新模块（更新 CI 的打包回归列表）。
完成定义：`lib/index.js` < 300 行；测试与打包回归全部通过。

---

## M8 · 兼容与一致性收尾（小）

1. CI 增加 `@next` job：`npm install @deepseek-ai/dsh-tools@next @deepseek-ai/schemastery@latest` 后跑 smoke 套件，`continue-on-error: true` → 验证点：CI 页面出现该 job。
2. `tier_worker` 改用 `strongStandaloneTarget()` 决定强档目标（与 advisor/review 一致），工具返回值报告实际路由 → 验证点：followSession 下 worker 的 `agentOptions` 与返回的 `provider/model` 都等于会话选择。
2b. `pendingWorkers` 领养同时匹配父代理身份（`session.header.parentSession === parent.session.id`），避免并行普通子代理误领 → 验证点：smoke 里两个同路由子代理同时创建，只有 worker 那个进入 `childTiers`。
3. 默认强档回退链：改为空，或改成不同路由（需用户选） → 验证点：`migrateTierConfig('strong', null)` 用例更新。
4. WebUI 未注册时的 4s 轮询改为指数退避（上限 60s）。
5. `pwsh` 工具最小守卫（`Remove-Item -Recurse -Force`、`rm -r -fo`）。

---

## M9 · 发布（可选，需用户决定）

`dsh-tier-router` 目前不在 npm 上（`npm view dsh-tier-router` 为空），GitHub 仓库是唯一分发渠道。若要让别人 `dsh plugin add dsh-tier-router` 直接可用，需要：npm 账号、`npm publish --access public`、README 安装段落改为 npm 路径、CI 增加 tag 触发的发布 job。这一步涉及对外发布，不在任何自动化里执行。
