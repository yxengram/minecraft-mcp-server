BLUEPRINT_PLACEHOLDER — NOT IMPLEMENTED — DO NOT RUN

# src/autopilot/policy.ts

本文件目前只有设计说明，不是可执行代码或有效运行配置。不要运行、导入、构建、格式化或把它当成已完成的测试。
它位于 blueprint/ 镜像目录；实现时在项目根目录的最终路径 src/autopilot/policy.ts 创建真实代码，并删除本占位文件。

所属模块：M-POL 策略
实现里程碑：M3（M4 增加聊天命令与决策字段）
实现状态：placeholder
设计状态：暂定：字段与默认值。已确认：不跨游戏重启保存（用户决定）
设计版本：v0.3
契约位置：docs/BLUEPRINT.md 中的 F-014

## 职责与边界

主要职责：定义策略结构（zod 模式）与默认值；提供读取当前策略、合并部分更新并校验、恢复默认值（含启动参数）、生成可读摘要；强制硬性安全规则。策略分组：reflexes（5 个反射的开关与阈值，self-defense 的姿态 fight / flee / auto）；combat（attackPlayers 默认 false，avoidNeutral 默认 true）；chat（triage 默认 true：用决策模型筛选与 bot 有关的聊天并上报 LLM；commandsFrom 默认空：哪些玩家的聊天命令可以不经 LLM 直接执行，已确认默认谁都不授权，只能由 LLM 修改；replyInChat 默认 true）；decisions（enabled、model、actThreshold 默认 0.85、cautiousThreshold 默认 0.5、maxCallsPerMinute 默认 30，阈值待 M5 探测后修订）。
不负责：不执行任何动作；不保存到磁盘；不读取环境变量。

## 输入

来源：src/tools/policy-tools.ts（部分更新，来源 llm）；src/autopilot/autopilot.ts（启动配置中的决策模型 id，来源 startup；bot 重新进入游戏时请求恢复默认）。
内容与形式：部分策略对象与来源标记。
关键限制：未知字段拒绝；血量与饥饿 0–20；距离 1–32；概率 0–1；速率 1–600 次/分钟；来源只能是 llm 或 startup。

## 输出

去向：src/autopilot/reflex-engine.ts、src/autopilot/reflexes.ts、src/autopilot/threats.ts、src/autopilot/behaviors/*.ts、src/decisions/decision-hooks.ts、src/decisions/openrouter-client.ts（读取）；src/tools/policy-tools.ts（更新结果与摘要）。
内容与形式：当前策略对象；更新结果（新策略与警告列表，或全部校验错误）；人类可读的摘要文字。
成功含义：更新后所有读取者立即看到新值；校验失败时策略保持不变。

## 与其他文件的关系

谁调用或使用本文件：src/autopilot/threats.ts、src/autopilot/reflex-engine.ts、src/autopilot/reflexes.ts、src/autopilot/behaviors/*.ts（M3 起读取阈值）、src/decisions/openrouter-client.ts、src/decisions/decision-hooks.ts（读取）；src/tools/policy-tools.ts（读取与更新）；src/autopilot/autopilot.ts（创建）；tests/policy.test.ts（验证）；tests/threats.test.ts、tests/openrouter-client.test.ts（作为被测模块的依赖）。
本文件调用或依赖谁：zod（外部，现有依赖）。
外部依赖：zod。

关系尚未实现；不要把计划关系写成已经观察到的运行事实。

## 状态、副作用与约束

持有或改变的状态：当前策略（内存）。MCP 服务器重启或 bot 重新进入游戏时恢复默认（含启动参数）。
外部副作用：无。
关键约束：combat.attackPlayers 只能被显式设为 true，且每次设为 true 都返回一条警告供调用者写入事件；任何来自聊天的路径都不能调用更新接口；chat.commandsFrom 只能由来源为 llm 的更新修改（startup 来源不能设置），名字区分大小写并按 Minecraft 用户名规则校验，每次修改返回一条提示供写入事件。
失败处理：校验失败 → 返回全部错误，原策略不变。

## 如何验收

正常场景：默认策略与本条目所列默认值一致（chat.commandsFrom 为空）；部分更新只改变指定字段；恢复默认后与启动时一致（包含启动参数设置的模型，授权名单清空）。
边界或失败场景：非法数值被拒绝且原策略不变；来源为 chat 的更新被拒绝；来源为 startup 的更新不能设置 chat.commandsFrom；把 attackPlayers 设为 true 返回警告。
验证位置：tests/policy.test.ts
验证状态：未执行；本文件尚未实现。

## 替换为代码时

先读取并遵守项目的 README.md、docs/BLUEPRINT.md、docs/PLAN.md 及 AGENTS.md。只有获得对应里程碑的实现授权、并实际写入实现时，才删除这份占位说明。完整文件契约继续保留在蓝图中；设计变化必须同步记录。
