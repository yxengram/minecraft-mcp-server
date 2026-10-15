# Autopilot 子系统开发计划

> 本文中所有尚未执行的测试与验收都是**计划**，不能当作测试证据。只有「进展与变更」中记录的检查是实际执行过的。
>
> 设计依据：[docs/BLUEPRINT.md](BLUEPRINT.md)（设计版本 v0.3）。

## 里程碑总览

| 里程碑 | 目标（完成后新增的可观察能力） | 前置 | 状态 |
|---|---|---|---|
| M1 | 动作仲裁 + 后台任务 + follow / flee 行为 + 任务工具：LLM 可以启动、查看、恢复、取消后台任务，事件流可见；LLM 的身体类命令立即执行并报告被打断的任务 | 无 | implemented-unverified（单元测试通过；实机验收待游戏重新开放） |
| M2 | 威胁识别 + 近战 + guard / gather / hunt / return-home：bot 能自主守卫、采集、狩猎、回家 | M1 | planned |
| M3 | 反射 + 策略 + 策略工具：不依赖 LLM 的保命反应，LLM 可调整策略 | M2 | planned |
| M4 | OpenRouter 客户端 + 模型目录 + 聊天筛选与聊天命令：对 bot 说的话以 chat_request 交给 LLM；LLM 授权过的玩家可以直接下命令（默认无人授权） | M3；OpenRouter API key（开始前通知用户并给出提供步骤） | planned |
| M5 | 决策式战斗判断 + 阈值探测：自卫的 auto 姿态使用决策模型；所有阈值有观察依据 | M4 | planned |
| M6 | 情景测试 + 共享场地辅助 + 最终文档：用数据比较三种配置 | M1～M5 | planned |

---

## M1：动作仲裁与后台任务（最小端到端路径）

| 字段 | 内容 |
|---|---|
| 目标 | LLM 调用 `start-task {behavior: "follow", params: {target: "Thomas_Summon"}}` → 立即得到任务 id → bot 在后台跟随 → `list-tasks` 显示 running → `cancel-task` 后 bot 停下，事件流依次出现 task_started、task_cancelled。跟随中 LLM 直接调用 `move-to-position` → 立即执行，工具结果附带中断报告（任务 id、行为、目标、当前步骤、已运行时长）→ `list-tasks` 显示 paused（manual）→ `resume-task` 后继续跟随 |
| 前置条件 | 现有 273 个单元测试通过；测试世界可用（实机验收） |
| 范围 | 新增：F-001 `src/autopilot/autopilot.ts`、F-002 `src/autopilot/action-arbiter.ts`、F-003 `src/autopilot/task-manager.ts`、F-004 `src/autopilot/behaviors/follow.ts`、F-005 `src/autopilot/behaviors/flee.ts`、F-017 `src/tools/task-tools.ts`（start-task、list-tasks、resume-task、cancel-task）、F-019～F-021、F-026（follow/flee 部分）、F-030 测试。改动：E-001 `src/tool-factory.ts`、E-002 `src/tools/follow-tools.ts`、E-003 `src/tools/position-tools.ts`、E-005 `src/bot-connection.ts`（onBotReady、onBotEnd）、E-007 `src/main.ts`、E-009 `scripts/test-live-world.mjs`（任务工具） |
| 本步不做 | 战斗、反射、策略、决策模型；guard / gather / hunt / return-home |
| 实施顺序 | 1. 仲裁器及其测试。2. 任务管理器（含行为契约）及其测试。3. follow、flee 行为及测试。4. Autopilot 组装与 BotConnection 回调。5. 任务工具与 main.ts 注册。6. tool-factory 的身体类租约，以及 follow-tools、position-tools 改造。7. 实机验收 |
| 验收 | 正常：上面的端到端路径实机通过；`tests/action-arbiter.test.ts`、`tests/task-manager.test.ts`、`tests/task-tools.test.ts`、`tests/autopilot.test.ts` 通过。边界：手动工具打断任务后任务保持暂停、不自动恢复，中断报告内容完整；对运行中的任务调用 resume-task 返回错误；stop-pathfinding 取消任务；断线后任务被取消。回归：现有全部单元测试通过；`npm run test:live:world` 连续两轮通过且覆盖 start-task / list-tasks / resume-task / cancel-task 与中断报告流程 |
| 可运行边界 | 只在最终路径创建本里程碑的文件，同时删除 `blueprint/` 中对应的占位；ava 只运行 `tests/**/*.test.ts`，tsc 与 eslint 只读取 `src/`、`tests/`，所以剩余的 `blueprint/` 占位不会被读取 |
| 恢复 | 在 `extra-tools` 分支上以独立提交完成；回退该提交即可恢复。无外部数据或持久状态 |
| 状态与证据 | implemented-unverified：单元测试与静态检查已通过（见进展记录）；实机验收尚未完成 |

## M2：威胁、战斗与工作行为

| 字段 | 内容 |
|---|---|
| 目标 | `start-task guard`（守卫玩家）时僵尸进入半径会被击杀；`start-task gather` 能采集；`start-task hunt` 能猎到食物；`start-task return-home` 能回家并在夜晚睡觉；collect-block 改由 gather 行为实现且对外不变 |
| 前置条件 | M1 verified |
| 范围 | 新增：F-010 `src/autopilot/threats.ts`、F-011 `src/autopilot/combat.ts`、F-006 guard、F-007 gather、F-008 hunt、F-009 return-home，测试 F-023、F-024、F-026（return-home 部分）、F-027。改动：E-004 `src/tools/gathering-tools.ts` |
| 本步不做 | 反射、策略工具（行为暂用策略的默认值，策略模块在 M3 提供；M2 期间以常量形式读取默认值，M3 时改为读取策略，暂定） |
| 实施顺序 | 1. threats 及测试（含合法目标规则 I1）。2. combat 及测试。3. guard、hunt。4. gather（迁移现有逻辑，现有 gathering 测试保持通过）。5. return-home。6. 实机验收 |
| 验收 | 正常：实机守卫情景击杀一只僵尸（NoAI 与有 AI 各一次）；gather 3 根原木；hunt 1 头牛；return-home 白天到达、夜晚入睡。边界：守卫不攻击猪和玩家；hunt 拒绝 player；collect-block 现有测试与实机检查通过。回归：全部单元测试；全量实机测试 |
| 可运行边界 | 同 M1 |
| 恢复 | 独立提交；无外部状态 |
| 状态与证据 | planned；未执行 |

## M3：反射与策略

| 字段 | 内容 |
|---|---|
| 目标 | 没有 LLM 参与时，bot 能躲开膨胀的苦力怕、离开火和岩浆、低血量撤退、被攻击时还手或逃跑、饿了进食；LLM 用 `get-policy` / `set-policy` 调整这些行为；bot 重新进入游戏时策略恢复默认 |
| 前置条件 | M2 verified |
| 范围 | 新增：F-012 `src/autopilot/reflex-engine.ts`、F-013 `src/autopilot/reflexes.ts`、F-014 `src/autopilot/policy.ts`、F-018 `src/tools/policy-tools.ts`（get-policy、set-policy），测试 F-022、F-025、F-031。改动：E-005（onDamage）、E-007、E-009（策略工具） |
| 本步不做 | self-defense 的 auto 姿态接入决策模型（M5）；list-decision-models（M4） |
| 实施顺序 | 1. policy 及测试（含不变量 I1、I2 的策略部分）。2. reflex-engine 及测试（优先级、冷却、超时、I6）。3. 5 个反射逐个实现与测试，按优先级从高到低。4. 行为改为读取策略。5. 策略工具。6. 实机验收 |
| 验收 | 正常（实机）：已点燃的苦力怕在 4 格处生成 → 爆炸时 bot 距离 ≥ 7 且存活；被点燃 → 6 秒内熄灭；饥饿值 10 且有面包 → 吃下；守卫任务进行中触发反射 → 任务暂停后自动恢复。边界：set-policy 关闭某反射后不再触发；被玩家攻击不还手；冷却期内不重复；自动进食时调用 move-to-position → 进食被打断、命令立即执行；躲避苦力怕时调用 move-to-position → 命令等待反射结束后执行并说明等待；修改策略后断线重连 → 策略恢复默认。回归：全部单元测试；全量实机测试 |
| 可运行边界 | 同 M1 |
| 恢复 | 独立提交；反射可通过 set-policy 全部关闭作为运行时的应急手段 |
| 状态与证据 | planned；未执行 |

## M4：决策模型客户端、聊天筛选与聊天命令

| 字段 | 内容 |
|---|---|
| 目标 | 配置 `OPENROUTER_API_KEY` 后：其他玩家对 bot 说的话在 3 秒内以 chat_request 事件交给 LLM，无关闲聊不上报；默认策略下任何玩家的命令都不会直接执行；LLM 用 set-policy 授权某玩家后，该玩家说 “ClaudeBot, follow me” → bot 在 2 秒内开始跟随并确认；`list-decision-models` 返回实时目录 |
| 前置条件 | M3 verified；**开始 M4 前通知用户需要 OpenRouter API key，并给出逐步的提供方法**（用于 Claude Desktop 时写在其配置文件的 env 字段；用于本地测试时的方式在通知时说明）；用户已接受把聊天与游戏状态摘要发送给 OpenRouter（已确认） |
| 范围 | 新增：F-015 `src/decisions/openrouter-client.ts`、F-016 `src/decisions/decision-hooks.ts`（聊天筛选与聊天命令部分），测试 F-028、F-029（聊天部分）。改动：E-006 `src/config.ts`（只增加 --decision-model）、F-018 增加 list-decision-models、E-007、E-009 |
| 本步不做 | 战斗判断（M5）；正式阈值（M4 使用暂定阈值 0.85 / 0.5，M5 修订） |
| 实施顺序 | 1. 客户端及测试（模拟 fetch；I4）。2. 实测模型目录与一次真实请求，核对响应格式，更新蓝图中的“待验证”项。3. 从目录中选定并固定模型版本 id。4. 聊天筛选（含无 key 的规则退回）及测试。5. 授权玩家的聊天命令及测试（含对抗样例，I2）。6. 实机验收 |
| 验收 | 正常（实机，需 key）：辅助玩家说 “ClaudeBot, can you help me?” → 出现 chat_request；说一句与 bot 无关的话 → 不上报；默认策略下说 follow me → 不跟随；LLM 授权辅助玩家后说 follow me → 跟随开始。边界：对抗性原文 → 不产生攻击；断网或错误 key → 私聊与提到名字的消息按规则上报，其余功能正常（I5）。回归：全部单元测试；全量实机测试（无 key 时 list-decision-models 说明未配置） |
| 可运行边界 | 同 M1；没有 key 时决策功能为 disabled |
| 恢复 | 独立提交；运行时可用 set-policy 关闭 decisions 或撤销 key |
| 状态与证据 | planned；未执行（等待 API key） |

## M5：决策式战斗判断与阈值探测

| 字段 | 内容 |
|---|---|
| 目标 | self-defense 设为 auto 时，由决策模型在模糊情况下选择打、逃或守；聊天命令与战斗判断的阈值都有探测依据 |
| 前置条件 | M4 verified |
| 范围 | F-016 战斗判断部分、F-013 的 auto 姿态接入、F-029 战斗部分；阈值探测记录写入本文件 |
| 本步不做 | 新增其他决策钩子 |
| 实施顺序 | 1. 准备探测样例：聊天（明确请求、模糊请求、闲聊、否定句、对抗性文字、空消息）与战斗（不同血量、装备、怪物数量组合）。2. 对选定模型批量请求，记录原始概率与延迟。3. 根据观察值设定阈值并写入策略默认值。4. 实现战斗判断与缓存、失败退回规则。5. 实机验收 |
| 验收 | 正常：每类探测样例都得到期望的路由；实机中 auto 姿态面对一只僵尸选择 fight、面对四只且低血量时选择 flee。边界：决策超时 → 按规则执行。证据：阈值表附观察值 |
| 可运行边界 | 同 M1 |
| 恢复 | 独立提交；把姿态设回 fight 或 flee 即可绕过决策 |
| 状态与证据 | planned；未执行 |

## M6：情景测试与最终文档

| 字段 | 内容 |
|---|---|
| 目标 | `npm run test:scenarios -- <端口> --allow-world-changes` 输出“情景 × 配置”的结果表；README 给出真实可用的使用说明 |
| 前置条件 | M1～M5 verified（没有 key 时可以只跑不含决策的配置） |
| 范围 | 新增：F-033 `scripts/lib/live-arena.mjs`、F-032 `scripts/test-scenarios.mjs`。改动：E-008（test:scenarios 脚本）、E-009（改用共享辅助）、E-010 README。删除整个 `blueprint/` 目录（此时应已为空） |
| 本步不做 | 新功能 |
| 实施顺序 | 1. 从 test-live-world 抽取共享辅助，确认全量实机测试仍通过。2. 逐个实现情景。3. 三种配置各运行至少两轮。4. 更新 README（任务、策略、决策模型、隐私与费用说明）。5. 确认 `blueprint/` 已无剩余占位并删除 |
| 验收 | 反射开启配置下所有必选情景成功；结果表附在本文件；README 中的命令实际运行过；仓库中不再含有占位文件 |
| 可运行边界 | 全部实现完成，无剩余占位 |
| 恢复 | 独立提交 |
| 状态与证据 | planned；未执行 |

---

## 范围覆盖

| 功能 | 主要文件 | 里程碑 | 验收位置 |
|---|---|---|---|
| AP-1 动作仲裁 | F-002、E-001 | M1 | F-020；M1 实机 |
| AP-2 后台任务 | F-003、F-017、F-001 | M1 | F-021、F-030、F-019；M1 实机 |
| AP-3 行为库 | F-004～F-009、E-002、E-004 | M1、M2 | F-026、F-027；M2 实机 |
| AP-4 近战战斗 | F-011、F-010 | M2 | F-024、F-023；zombie-wave 情景 |
| AP-5 反射 | F-012、F-013 | M3 | F-025；creeper-ambush、fire、hunger 情景 |
| AP-6 策略 | F-014、F-018 | M3 | F-022、F-031 |
| AP-7 决策模型 | F-015、F-016、E-006 | M4、M5 | F-028、F-029；chat-triage 情景 |
| AP-8 决策可见性 | F-016、F-018 | M4 | F-029、F-031 |
| AP-9 情景测试 | F-032、F-033 | M6 | M6 结果表 |

## 风险与未决问题

| 编号 | 问题 | 影响范围 | 检查方式 | 最晚解决 | 可逆替代 |
|---|---|---|---|---|---|
| Q1 | 聊天命令默认授权谁？**已解决**：默认谁都不授权；只有 LLM 能通过 set-policy 授权；不提供启动参数 | M4 | 用户答复（2026-10-16） | — | — |
| Q2 | 策略是否需要跨重启保存？**已解决**：不保存，bot 重新进入游戏（例如重启游戏）时恢复默认 | M3 | 用户答复（2026-10-16） | — | — |
| Q3 | 手动工具对任务的影响？**已解决**：立即执行 LLM 的命令，任务保持暂停，工具结果报告被打断前的状态，由 LLM 用 resume-task 或 cancel-task 决定 | M1 | 用户答复（2026-10-16） | — | — |
| Q4 | 决策模型目录接口的响应格式 | M4 | 用真实 key 请求一次 | M4 第 2 步 | 改为在配置中手动指定模型 id |
| Q5 | 决策模型的实际延迟与准确度是否满足 | M4、M5 | 探测样例 | M5 | 只保留聊天命令，战斗判断完全用规则 |
| Q6 | 每刻反射评估的耗时 | M3 | 情景测试中记录 | M3 实机验收 | 降低评估频率（每 2–4 刻一次） |
| Q7 | 用户是否接受把聊天与游戏状态摘要发送给 OpenRouter？**已解决**：接受 | M4 | 用户答复（2026-10-16） | — | — |
| Q8 | 关键反射与日常反射的划分是否合适（自卫目前是日常反射，可被 LLM 命令打断） | M3 | 情景测试与用户体验 | M3 实机验收 | 把自卫改为关键反射 |
| Q9 | 本地测试时如何安全地提供 API key（Claude Desktop 用其配置的 env 字段；代理运行的测试进程看不到用户终端的环境变量） | M4 | M4 开始前与用户确认 | M4 开始前 | 读取用户主目录下权限为 600 的单独文件（需修订 F-015 的“只读环境变量”约束并记录） |

## 进展与变更

### 2026-10-16 规划阶段

- 完成：`docs/BLUEPRINT.md`（v0.1）、本文件、`AGENTS.md`、`blueprint/README.md`，以及 `blueprint/` 下 33 个说明性占位文件（18 个源文件、13 个测试文件、2 个脚本：情景测试与共享场地辅助）。
- 配置改动：`package.json` 的 ava 增加 `"files": ["tests/**/*.test.ts"]`，避免 `blueprint/tests/` 中的占位文件被当作测试运行。
- 实际执行的检查（2026-10-16）：
  - `npm test` → 273 个测试通过，与规划前相同，说明占位文件没有被测试发现。
  - `tsc --noEmit` 通过；`npm run lint` 无错误；`npm run build` 成功且没有生成 `dist/autopilot/`。
  - 文本核对：`blueprint/` 下 34 个文件与契约清单一致；每个占位文件首行都有标记、没有模板符号、最终路径上不存在同名真实文件；蓝图与占位副本的契约文字一致；新增文件之间的依赖与使用方双向一致；文档链接有效。
  - 这些检查只证明现有代码未受影响、文档结构一致，**不证明任何 Autopilot 功能**。
- 文件状态：Autopilot 全部新增文件为 `placeholder`；文档为 `documented`。

### 2026-10-16 设计 v0.2（按用户答复修订）

| 变更 | 旧方案（v0.1） | 新方案（v0.2） | 原因 | 影响 |
|---|---|---|---|---|
| LLM 直接命令与任务 | 手动命令暂停任务，命令结束后自动恢复 | 命令立即执行；任务保持暂停；工具结果附带中断报告；新增 `resume-task`，由 LLM 决定恢复或取消 | 用户决定 | F-002、F-003、F-017、E-001、G1～G3；工具总数 60 → 61；新增“当前步骤”报告要求（F-004～F-009） |
| 反射优先级 | 反射统一高于手动 | 关键反射（躲苦力怕、逃离火/岩浆/溺水、低血量撤退）高于手动；日常反射（自卫、进食）低于手动 | 满足“先执行 LLM 命令”，同时保留保命反应 | F-012、F-013、G1；新增 Q8 |
| 策略生命周期 | 重启 MCP 服务器才恢复默认 | 另外在 bot 每次重新进入游戏时恢复默认，并写入 `policy` 事件 | 用户决定：游戏重启后恢复默认 | F-001、F-014、G3 |
| 隐私 | 待确认 | 用户接受把聊天与游戏状态摘要发送给 OpenRouter | 用户答复 | Q7 关闭 |
| API key | 只说明从环境变量读取 | M4 开始前通知用户并给出逐步方法；本地测试的提供方式待定 | 用户要求 | M4 前置条件；新增 Q9 |

占位文件已按 v0.2 重新生成（33 个，内容与蓝图 F 节一致）。

### 2026-10-16 设计 v0.3（按用户答复修订）

| 变更 | 旧方案（v0.2） | 新方案（v0.3） | 原因 | 影响 |
|---|---|---|---|---|
| 关键反射例外 | 设计者提出，待确认 | 保留 | 用户确认 | Q8 仍保留为实测观察项 |
| 聊天命令授权 | 默认为空，可用 set-policy 或 `--chat-commands-from` 授权 | 默认为空，只有 LLM 能通过 set-policy 授权；去掉启动参数 | 用户决定：bot 是独立玩家，其他玩家不应随意改变它的“无意识行为”，有需要时对 bot 喊话、由 LLM 决定 | F-001、F-014、F-016、E-006、G6 I2；Q1 关闭 |
| 决策模型在聊天上的用途 | 主要用于执行授权玩家的命令 | 主要用于聊天筛选：判断是否对 bot 说的、属于哪类，只把相关消息以 chat_request 上报 LLM；授权命令变成次要路径 | 与用户决定一致：让 LLM 只被相关消息唤醒 | F-016、F-029、F-032（chat-triage 情景）、M4 |

占位文件已按 v0.3 重新生成（33 个，内容与蓝图 F 节一致）。

### 2026-10-16 M1 实现

- 新增：`src/autopilot/action-arbiter.ts`、`src/autopilot/task-manager.ts`、`src/autopilot/autopilot.ts`、`src/autopilot/behaviors/target.ts`（实现时新增，契约 F-034）、`src/autopilot/behaviors/follow.ts`、`src/autopilot/behaviors/flee.ts`、`src/tools/task-tools.ts`，测试 `tests/action-arbiter.test.ts`、`tests/task-manager.test.ts`、`tests/autopilot.test.ts`、`tests/movement-behaviors.test.ts`（follow / flee 部分）、`tests/task-tools.test.ts`。对应的 11 个 `blueprint/` 占位文件已删除。
- 改动：`src/tool-factory.ts`（身体类工具租约与中断报告）、`src/tools/follow-tools.ts`、`src/tools/position-tools.ts`、`src/bot-connection.ts`（onBotReady、onBotEnd）、`src/main.ts`、`src/tools/entity-utils.ts`（新增 refreshEntity）、`tests/interaction-tools.test.ts`（follow/flee 测试改为通过任务运行，断言的对外行为不变）、`scripts/test-live-world.mjs`（新增任务步骤）。
- 设计调整（不改变契约语义）：身体类工具改为在 `src/tool-factory.ts` 中集中列名单，并把 equip-item 纳入名单（E-001）；新增共享文件 `src/autopilot/behaviors/target.ts`（F-034）。
- 实现中发现并修复：任务从排队恢复后、行为开始运行前若被取消，行为会错过取消信号；任务管理器现在在调用行为前检查取消状态（有回归测试）。
- 实际执行的检查：`tsc --noEmit` 通过；`npm run lint` 无错误；`npm test` 313 个测试通过（原有 273 个全部保留，新增 40 个）；`npm run build` 成功。
- 实机验收：**未完成**。`npm run test:live:world` 在启动阶段失败，原因是 Minecraft 局域网端口 63320 已关闭（`nc` 确认端口不可连接），bot 无法进入游戏；与代码无关。另确认服务器在连接被拒绝时继续运行、不会退出。等待用户重新开放局域网并提供端口。
- 备注：连接被拒绝时日志会出现一条 “Unhandled rejection: ECONNREFUSED”，M1 之前即存在，不影响运行，暂不处理。

