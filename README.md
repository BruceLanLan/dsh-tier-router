# dsh-tier-router — Tiered model routing for DeepSeek Harness

按任务难度分层路由模型：**强档（默认 deepseek-v4-pro）负责规划 / 架构 / 评审**，
**弱档（默认 deepseek-v4-flash）负责日常编码实现**。灵感来自 Cloud Code / Claude
Code 的 `/advisor`（困难决策时咨询更强模型）与 `opusplan`（计划模式用强模型、执行切便宜模型），
在 DeepSeek Harness 里用官方机制实现，并扩展了难度升级门、失败自动升级与 subagent 分层。

## 功能

- **自动分层路由（auto 模式，opusplan 式）**：进入计划模式时步骤跑强档，执行步骤跑弱档。
  主会话通过写入会话 `request/header` 生效（api-proxy 选择层的官方缝隙，参考社区
  `dsh-model-router` 的做法）；子代理通过 `agent/request` 每步切换。
- **按需咨询（advisor 式）**：`/advisor <问题>` 命令 + `tier_advisor` 工具，把一个问题
  加已有证据交给强档模型，返回建议 / 证据 / 风险 / 验收条件；实现仍由当前档执行。
- **评审阶段**：`tier_review` 工具 + `/tier review <焦点>`，强档模型对变更与验证结果
  给出 `APPROVE / NEEDS-CHANGES / BLOCKED` 及分级问题清单。
- **失败自动升级**：同一会话在窗口内连续出错（默认 60s 内 2 次）自动临时切到强档
  （默认 180s），并从会话日志中给出诊断，避免弱档在异常时反复撞墙。
- **可配置双档**：`/tier set <strong|cheap> <provider> <model> [effort]` 或
  `tier_configure` 工具，任意已注册 provider / model 均可（默认
  `deepseek-official/deepseek-v4-pro(max)` 与 `deepseek-official/deepseek-v4-flash(high)`）。
- **高危升级门（确定性守卫）**：当执行档为弱档时，`tools/pre-execute` 拦截高危工具调用，
  要求先切到强档再执行，不依赖模型自觉。守卫规则（纯逻辑，单元测试覆盖）：
  - `rm -rf` 全拼写：合并参数（`-rf`）、拆分参数（`-r -f`）、大小写（`-R`）、长参数
    （`--recursive --force`）、前缀命令（`sudo rm -rf`）；
  - 破坏性命令：`mkfs`、`dd if=`、`sudo`、`shutdown/reboot/halt`、`git push --force/-f`、
    `curl|sh`、`wget|sh`、`chmod` 到 `.ssh`、`chown`；
  - 敏感路径：`.env`（`.env.example/.template` 白名单例外）、`credentials`/`secrets`
    常见扩展名、`.ssh/`、`id_rsa` 等私钥、`.pem`、`.key`；
  - 散文不误伤：`echo rm -rf`、`grep sudo` 之类不触发（锚定命令位置）。
- **subagent 分层**：`tier_worker` 按档派发子代理（`agentOptions` 注入模型），支持
  `outputSchema`（结构化结果）、`toolFilter`（限制子代理工具）、`maxDepth`（深度上限）；
  `/tier subagent <inherit|cheap|strong>` 设置所有子代理步骤的全局档位策略。
- **难度升级规则注入**：向系统提示词注入升级门（歧义未消、架构 / 安全 / 数据完整性、
  两次失败、收尾高风险等条件），模型在决策点调用 `tier_advisor` / `tier_review`。

## 安装

```sh
# 本地目录安装（开发 / 验证）
git clone https://github.com/BruceLanLan/dsh-tier-router.git
cd dsh-tier-router
dsh plugin --profile web add .

# 重启 DSH 后生效；安装包正式发布后可一行安装
# dsh plugin --profile web add dsh-tier-router
```

卸载：

```sh
dsh plugin --profile web remove dsh-tier-router
```

安装已实测：`dsh plugin --profile <name> add <path>` 成功链接 bundle，
`dsh --profile <name> --dump-config` 确认插件行 `- id: tier-routing / name: dsh-tier-router`
正确插入组合；模块加载冒烟通过（`name=tier-routing, apply=function`）。

## 使用

### 斜杠命令（在输入框直接输入）

```
/advisor <决策问题>                          # 强档模型一次咨询
/tier status                                # 查看路由状态、升级状态与诊断计数器
/tier strong | cheap                        # 强制所有步骤走某档（并持久化为会话默认）
/tier auto                                  # 恢复自动（计划模式→强档，执行→弱档）
/tier off                                   # 关闭每步路由，并将会话恢复到默认模型
/tier plan                                  # auto + 进入计划模式，并立即应用强档 header
/tier models                                # 列出已注册 provider 与其模型
/tier set <strong|cheap> <provider> <model> [effort]
/tier subagent <inherit|cheap|strong>       # 子代理全局档位策略
/tier review <评审焦点>                       # 强档模型评审
```

### 模型工具（由模型在需要时调用）

| 工具 | 用途 |
| --- | --- |
| `tier_advisor` | 强档咨询：一个问题 + 证据 → 建议 / 风险 / 验收条件 |
| `tier_review` | 强档评审：变更集 + 验证结果 → 判定与分级问题 |
| `tier_route` | 切换本会话档位（strong/cheap/auto/off，可选持久化） |
| `tier_configure` | 重配任意档位的 provider/model/effort 与 subagent 策略 |
| `tier_worker` | 按档派发子代理执行有界任务包；支持 outputSchema / toolFilter / maxDepth |
| `tier_status` | 只读诊断：模式、双档配置、升级状态、监听器计数器、生效档位 |

## 配置

运行时配置（无需重启）：

```sh
/tier set strong deepseek-official deepseek-v4-pro max
/tier set cheap deepseek-official deepseek-v4-flash high
```

`tier_route strong|cheap` 默认会把选择持久化为会话默认模型（写入
`agent-default-model` 设置）。`tier_configure` 支持 `persist: true` 同样持久化。
失败自动升级参数（阈值 / 窗口 / 时长）当前为内建常量，后续版本可配置化。

## 架构

```
用户消息 → agent/inbox/inserted ──► (auto 模式) 写入 session request/header
          plan/mode 事件 ─────────► 切换 header 到强档 / 弱档
          agent/request（子代理）──► 每步直接替换 provider/model
          agent/error ─────────────► 连续错误 → 临时升级到强档（TTL 过期自动回落）
工具调用 → tools/pre-execute ──────► 弱档 + 高危模式 → deny（要求先切强档）
```

- **主会话**：DSH 的 api-proxy 选择层按「已记录 request/header」优先级决定每步模型，
  因此插件在步骤构建前写入 header（`agent/inbox/inserted` + `plan/mode` 事件），
  使选择层本身采用目标档位——比在 `agent/request` 里覆盖配置更稳定。
- **子代理**：子代理不经过 api-proxy 选择装配，直接在 `agent/request` 瀑布按档位替换
  provider/model（`tier_worker` 额外通过 `agentOptions` 在创建时注入模型）。
- **守卫**：与模型选择解耦，仅依据当前路由策略（mode + plan 状态 + 升级状态）判定档位，
  命中高危模式即拒绝执行，消息明确指导先 `tier_route strong`。
- **纯逻辑模块**：守卫模式与档位决策抽在 `lib/pure.js`，无 harness 依赖，
  `npm test`（node:test）即可离线验证。

## 测试

```sh
npm test        # node --test tests/ — 17 个用例，覆盖守卫正反矩阵与档位决策优先级
npm run check   # 语法检查 lib/index.js 与 lib/pure.js
```

会话内严格多轮实测（动态插件形态）记录：

| 项目 | 结果 |
| --- | --- |
| 主会话每步路由（持久日志证据） | ✅ `request/header` 事件显示从 pro 切到 flash |
| 守卫矩阵（auto/strong/off） | ✅ auto 拒 / strong 放行 / off 放行并恢复默认档 / 恢复 auto 拒 |
| 守卫加固（拆分参数、前缀 rm、散文、.env 白名单） | ✅ 7/7 实测通过 |
| 工具正向 | ✅ advisor/review 真调强档；route 四种模式；configure 改档；worker 在 spawn 与 fork 两个 provider 上完成 |
| worker 新参数 | ✅ outputSchema 结构化结果、toolFilter 限制工具、maxDepth 拒绝超限、非法 filter 干净报错 |
| 工具反向用例 | ✅ 非法 provider 拒绝、非法 subagent provider 报错 |
| subagent 分层 | ✅ 弱档跑 flash、强档跑 pro（子代理日志与返回值证实） |
| 生命周期 | ✅ stop 后守卫与工具消失；重新 run 全部恢复且守卫生效 |
| 持久化 | ✅ `agent-default-model` 写入成功 |
| 跨回合监听器存活 | ✅ 诊断计数器跨回合持续自增 |

已知限制：

- 档位切换从下一步生效（header 在步骤构建前写入，有一步延迟）。
- `/tier off` 会将会话恢复到默认模型并停止每步路由。
- 计划模式联动（`/tier plan` → 步骤切强档）需人工在输入框触发后观察。
- 动态插件形态进程重启即消失；本仓库即持久 bundle 形态。

## 许可

MIT
