# dsh-tier-router — 分层模型路由 for DeepSeek Harness

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-ready-4B32C3)](https://github.com/topics/dsh-plugin)

按任务难度分层路由模型：**强档（默认 deepseek-v4-pro）负责规划 / 架构 / 评审**，
**弱档（默认 deepseek-v4-flash）负责日常编码实现**。灵感来自 Claude Code 的
`/advisor`（困难决策时咨询更强模型）与 `opusplan`（计划模式用强模型、执行切便宜模型），
在 DeepSeek Harness 里用官方机制实现，并扩展了难度升级门、失败自动升级与 subagent 分层。

[English](README.md) · 中文

## 工作原理

```mermaid
flowchart LR
    subgraph main["主会话（header 驱动）"]
      U["用户消息"] --> IN["agent/inbox/inserted"]
      IN -->|"auto 模式"| HW["写入 session request/header"]
      PM["plan/mode 翻转"] --> HW
      HW --> API["api-proxy 选择层"]
      API --> STEP["每步模型 = header 档位"]
    end
    subgraph child["子代理（agent/request 直改）"]
      W["tier_worker 派发"] -->|"agentOptions 注入"| C["子代理"]
      C --> AR["agent/request 瀑布"]
      AR -->|"按档位替换 provider/model"| STEP2["子代理步骤"]
    end
    G["tools/pre-execute 守卫"] -.->|"弱档 + 高危模式"| DENY["deny + 升级提示"]
    E["agent/error 连续失败"] -.->|"阈值内"| ESC["临时强档（TTL）"]
```

```mermaid
sequenceDiagram
    participant U as 用户
    participant S as 会话（主代理）
    participant A as 强档 v4-pro
    participant C as 弱档 v4-flash
    U->>S: /tier plan（进入计划模式）
    S->>S: 写 header → strong
    S->>A: 规划 / 架构 / 设计方案
    U->>S: 批准计划，退出计划模式
    S->>S: 写 header → cheap
    S->>C: 日常编码实现
    S->>A: tier_advisor（困难决策）/ tier_review（收尾评审）
    Note over S,C: 高危操作（rm -rf / 凭据文件）被守卫拦截，要求先切强档
```

## 功能

- **自动分层路由（auto 模式，opusplan 式）**：进入计划模式时步骤跑强档，执行步骤跑弱档。
  主会话通过写入会话 `request/header` 生效（api-proxy 选择层的官方缝隙，参考社区
  `dsh-model-router` 的做法）；子代理通过 `agent/request` 每步切换。
- **按会话隔离（per-session）**：`/tier strong|cheap|auto|off` 只影响当前会话，
  **进程内其他会话保持自己的档位**（全局默认 `auto`）。"别的会话被切换"不会再发生——
  不想被管理的会话发一次 `/tier off` 即可退出。
- **按需咨询（advisor 式）**：`/advisor <问题>` 命令 + `tier_advisor` 工具，把一个问题
  加已有证据交给强档模型，返回建议 / 证据 / 风险 / 验收条件；实现仍由当前档执行。
- **评审阶段**：`tier_review` 工具 + `/tier review <焦点>`，强档模型对变更与验证结果
  给出 `APPROVE / NEEDS-CHANGES / BLOCKED` 及分级问题清单。
- **失败自动升级**：同一会话在窗口内连续出错（默认 60s 内 2 次）自动临时切到强档
  （默认 180s），TTL 过期自动回落；`off` 会话不参与。
- **可配置双档（持久化）**：`/tier set <strong|cheap> <provider> <model> [effort]` 或
  `tier_configure` 工具，任意已注册 provider / model 均可（默认
  `deepseek-official/deepseek-v4-pro(max)` 与 `deepseek-official/deepseek-v4-flash(high)`）。
  配置持久化在 `tier-router` settings 命名空间，重启不丢；传 `sessionOnly: true` 可只改内存。
- **高危升级门（确定性守卫）**：当执行档为弱档时，`tools/pre-execute` 拦截高危工具调用，
  要求先切到强档再执行，不依赖模型自觉。守卫规则（纯逻辑 `lib/pure.js`，单元测试覆盖）：
  - `rm -rf` 全拼写：合并参数（`-rf`）、拆分参数（`-r -f`）、大小写（`-R`）、长参数
    （`--recursive --force`）、前缀命令（`sudo rm -rf`、`busybox rm`）；
  - 破坏性命令：`mkfs`、`dd if=`、`sudo`、`shutdown/reboot/halt`、`git push --force/-f`、
    `git clean -f*`、`find ... -delete` / `find ... -exec rm`、`python -c` 里的
    `shutil.rmtree` / `os.remove`、`curl|sh`、`wget|sh`、`chmod` 到 `.ssh`、`chown`；
  - 敏感路径：`.env`（`.env.example/.template` 白名单例外）、`credentials`/`secrets`
    常见扩展名、`.ssh/`、`id_rsa` 等私钥（大小写不敏感）、`.pem`、`.key`；
  - 散文不误伤：`echo rm -rf`、`grep sudo` 之类不触发（锚定命令位置）。
- **subagent 分层**：`tier_worker` 按档派发子代理（`agentOptions` 注入模型），支持
  `outputSchema`（结构化结果）、`toolFilter`（限制子代理工具）、`maxDepth`（深度上限）、
  `persona`（子代理人格）、`background`（jobs 后台执行）；
  `/tier subagent <inherit|cheap|strong>` 设置所有子代理步骤的全局档位策略。
- **难度升级规则注入**：向系统提示词注入升级门（歧义未消、架构 / 安全 / 数据完整性、
  两次失败、收尾高风险等条件），模型在决策点调用 `tier_advisor` / `tier_review`。

## 安装

> **作用域说明**：`dsh-tier-router` 贡献的是 **agent 层**能力——工具、斜杠命令、
> 提示词段落、逐步路由监听器——必须放在你的会话所用的 **agent preset** 里，
> 不能当作 host bundle 行安装。只装包（或依赖 host 插入行）不会激活任何功能。

```sh
# 1. 把包链接进你的 profile（开发：克隆本仓库后 add 本地路径；发布后：一行安装）
git clone https://github.com/BruceLanLan/dsh-tier-router.git
cd dsh-tier-router
dsh plugin --profile web add .

# 2. 把仓库自带的 preset（standard + tier-routing 行）拷进用户 preset 根目录
#    （${DSH_HOME:-$HOME/.dsh}/.agent-presets/）：
cp -R agent-presets/tiered "${DSH_HOME:-$HOME/.dsh}/.agent-presets/"

# 3. 设为默认 preset（加入 profile 的 cordis.patch.yml）：
#      - id: agent-presets
#        name: '@deepseek-ai/dsh-agent-presets'
#        config:
#          default: tiered
#    （或在会话预设选择器里手动选 "tiered"）

# 4. 重启 DSH（先杀掉 LISTEN 在 web 端口的进程），然后【新开一个会话】
#    （已存在的会话保留创建时的 preset），用 /tier status 验证。
```

卸载：从 preset 里删掉 `tier-routing` 行（或直接删除该 preset 目录），并执行
`dsh plugin --profile web remove dsh-tier-router` 移除包链接。

安装已实测：包能从 profile store 正确解析；仓库自带的 `agent-presets/tiered`
preset（standard 副本 + `- id: tier-routing / name: dsh-tier-router` 行）通过
`agentPresets.standingKeyFor` 挂载校验；模块加载冒烟通过；`npm pack` 内容干净
（lib + patch + preset + README/LICENSE）。

## 使用

### 斜杠命令（在输入框直接输入，只作用于当前会话）

```
/advisor <决策问题>                          # 强档模型一次咨询
/tier status                                # 查看路由状态、升级状态与诊断计数器
/tier strong | cheap                        # 本会话强制走某档（可选持久化为会话默认）
/tier auto                                  # 本会话恢复自动（计划模式→强档，执行→弱档）
/tier off                                   # 本会话关闭路由并恢复默认模型（不影响其他会话）
/tier plan                                  # auto + 进入计划模式，并立即应用强档 header
/tier models                                # 列出已注册 provider 与其模型
/tier set <strong|cheap> <provider> <model> [effort]
/tier subagent <inherit|cheap|strong>       # 子代理全局档位策略
/tier review <评审焦点>                       # 强档模型评审
```

示例输出（`/tier status`）：

```
Tiered model routing
  mode: global=auto, this session=auto (per-session via /tier strong|cheap|auto|off; escalate: 2 errors / 60s window -> 180s strong)
  strong: deepseek-official/deepseek-v4-pro (max)
  cheap:  deepseek-official/deepseek-v4-flash (high)
  subagents: inherit
  diag: requestSteps=42 guardChecks=31 guardDenies=3 headerWrites=4 errorsSeen=0 escalations=0
  session default: deepseek-official/deepseek-v4-pro (max)
  providers: deepseek-official, opencode-go, minimax
```

### 模型工具（由模型在需要时调用）

| 工具 | 用途 |
| --- | --- |
| `tier_advisor` | 强档咨询：一个问题 + 证据 → 建议 / 风险 / 验收条件 |
| `tier_review` | 强档评审：变更集 + 验证结果 → 判定与分级问题 |
| `tier_route` | 设置**本会话**档位（strong/cheap/auto/off，可选持久化） |
| `tier_configure` | 重配任意档位的 provider/model/effort 与 subagent 策略 |
| `tier_worker` | 按档派发子代理执行有界任务包；支持 outputSchema / toolFilter / maxDepth / persona |
| `tier_status` | 只读诊断：全局与本会话档位、升级状态、监听器计数器、生效档位 |

## 配置

运行时配置（无需重启）：

```sh
/tier set strong deepseek-official deepseek-v4-pro max
/tier set cheap deepseek-official deepseek-v4-flash high
```

`/tier set` 与 `tier_configure` 会把双档配置持久化到 `tier-router` settings 命名空间
（重启不丢；`sessionOnly: true` 可只改内存）。`tier_route strong|cheap` 只影响当前会话
且默认不持久化，传 `persist: true` 才写入会话默认模型（`agent-default-model`）。
失败自动升级参数（阈值 / 窗口 / 时长）当前为内建常量，后续版本可配置化。

## 测试

```sh
npm test        # node:test — 20 个用例：守卫正反矩阵、档位决策优先级、per-session 覆盖
npm run check   # 语法检查 lib/index.js 与 lib/pure.js
```

会话内严格多轮实测（动态插件形态）记录：

| 项目 | 结果 |
| --- | --- |
| 主会话每步路由（持久日志证据） | ✅ `request/header` 事件显示从 pro 切到 flash |
| 守卫矩阵（auto/strong/off） | ✅ auto 拒 / strong 放行 / off 放行并恢复默认档 / 恢复 auto 拒 |
| 守卫加固（拆分参数、前缀 rm、散文、.env 白名单、大小写） | ✅ 7/7 实测通过 |
| 工具正向 | ✅ advisor/review 真调强档；route 四种模式；configure 改档；worker 在 spawn 与 fork 两个 provider 上完成 |
| worker 新参数 | ✅ outputSchema 结构化结果、toolFilter 限制工具、maxDepth 拒绝超限、非法 filter 干净报错 |
| 工具反向用例 | ✅ 非法 provider 拒绝、非法 subagent provider 报错 |
| subagent 分层 | ✅ 弱档跑 flash、强档跑 pro（子代理日志与返回值证实） |
| 失败升级事件路径 | ✅ `agent/error` 真实触发、计数器自增、off 模式正确跳过 |
| 生命周期 | ✅ stop 后守卫与工具消失；重新 run 全部恢复且守卫生效 |
| 持久化 | ✅ `agent-default-model` 写入成功 |
| 跨回合监听器存活 | ✅ 诊断计数器跨回合持续自增 |

## FAQ

**Q: 为什么我另一个会话的模型被自动切换了？**
早期版本是进程级全局模式。v0.3.0 起 `/tier` 命令只作用于**当前会话**，
其他会话默认 `auto` 且互不影响；不想被管理的会话输入 `/tier off` 即可退出。

**Q: 切换档位后没有立刻生效？**
档位切换在步骤构建前写入会话 header，从**下一步**开始生效（一步延迟）。

**Q: 想用订阅渠道的模型（如 OpenCode Go / MiniMax）？**
先 `/tier models` 确认 provider 已注册、模型已配置，再
`/tier set cheap opencode-go deepseek-v4-flash`。pi-ai 类 provider 必须在
settings.yaml 中声明 `baseURL`/`api`/`models`，否则任何模型 id 都会被拒绝。

**Q: 高危操作被拦了怎么办？**
守卫的提示会告诉你：先 `tier_route` 切到 `strong`（或 `/tier strong`）再重试——
拦截本身就是为了避免弱档模型直接执行破坏性操作。

**Q: 装完 bundle 后 `/tier` 不出现？**
本插件是 agent 层插件：必须是你所用会话的 agent preset 里的一行（见"安装"）。
只作为 host bundle 行安装不会激活任何东西——agent 层服务（tools/commands/
systemPrompt）在 host 根作用域不可达，因此本包**故意不带 host 插入行**。加入
preset 行后重启 `dsh web` 并新开会话，用 `/tier status` 验证。（动态插件形态是
进程内临时实例，重启即消失。）

## 已知限制

- 档位切换从下一步生效（header 在步骤构建前写入）。
- 子代理全局档位策略（`/tier subagent`）是进程级的；worker 的单次派发档位始终优先。
- 失败自动升级的完整"失败→自愈"现场序列在会话内已验证事件路径与单元逻辑，端到端
  现场触发建议按 FAQ 操作验证。

## 许可

MIT
