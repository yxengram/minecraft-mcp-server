BLUEPRINT_PLACEHOLDER — NOT IMPLEMENTED — DO NOT RUN

# scripts/test-scenarios.mjs

本文件目前只有设计说明，不是可执行代码或有效运行配置。不要运行、导入、构建、格式化或把它当成已完成的测试。
它位于 blueprint/ 镜像目录；实现时在项目根目录的最终路径 scripts/test-scenarios.mjs 创建真实代码，并删除本占位文件。

所属模块：M-VER 验证
实现里程碑：M6
实现状态：placeholder
设计状态：暂定：情景清单与成功标准待实现时根据实测调整
设计版本：v0.3
契约位置：docs/BLUEPRINT.md 中的 F-032

## 职责与边界

主要职责：在测试场地运行情景测试并比较配置：情景包括 zombie-wave（守卫任务应对有 AI 的僵尸）、creeper-ambush（4 格外生成已点燃的苦力怕）、hunger（饥饿值降低后自动进食）、fire（被点燃后离开火源）、chat-triage（辅助玩家说“<bot>, can you help me?” → 出现 chat_request；说“<bot>, follow me” → 默认不执行）。配置包括：仅 LLM 工具（反射关闭）、反射开启、反射加决策模型。输出每个情景每种配置的成功与否、存活情况和用时表格。
不负责：不代替 tests/ 下的单元测试；不在没有 --allow-world-changes 时修改世界；没有 API key 时跳过需要决策模型的配置并说明。

## 输入

来源：开发者命令行：npm run test:scenarios -- <LAN_PORT> --allow-world-changes [--only <情景名>]。
内容与形式：LAN 端口、是否允许修改世界、可选的情景筛选；环境变量 OPENROUTER_API_KEY（只透传给 MCP 服务器进程）。
关键限制：需要开启作弊的测试世界；会修改世界、召唤生物、杀死 bot。

## 输出

去向：终端输出；进程退出码（任一必选情景失败为 1）。
内容与形式：情景 × 配置的结果表；失败时附最近事件与位置诊断（沿用 test-live-world 的诊断方式）。
成功含义：每个情景在“反射开启”配置下达到成功标准：zombie-wave 60 秒内存活且击杀；creeper-ambush 爆炸时距离 ≥ 7 且存活；hunger 15 秒内进食；fire 6 秒内熄灭；chat-triage 在 3 秒内出现 chat_request，且默认策略下 bot 不开始跟随（有 key 的配置判断类别，无 key 的配置按规则上报）。

## 与其他文件的关系

谁调用或使用本文件：开发者与 PLAN 中的 M6 验收。
本文件调用或依赖谁：scripts/lib/live-arena.mjs（场地搭建、辅助玩家、诊断）；dist/main.js（构建后的 MCP 服务器，经 MCP 客户端启动）。
外部依赖：Minecraft 测试世界；MCP SDK 客户端（现有依赖）；mineflayer（辅助玩家）；OpenRouter（可选，经被测服务器）。

关系尚未实现；不要把计划关系写成已经观察到的运行事实。

## 状态、副作用与约束

持有或改变的状态：无持久状态。
外部副作用：修改测试世界（场地、生物、时间、游戏模式），结束时拆除场地并把 bot 送回地面。
关键约束：沿用 test-live-world 已验证的稳健做法：场地固定高度并带围墙、开局创造模式防摔、结束前送回地面、setup 失败立即中止、任何失败都打印诊断。
失败处理：setup 失败 → 中止并以退出码 1 结束；单个情景失败 → 记录诊断并继续下一个。

## 如何验收

正常场景：在开启作弊的测试世界中运行 → 输出完整结果表，反射开启配置下所有必选情景成功。
边界或失败场景：没有 --allow-world-changes → 拒绝运行；没有 key → 跳过决策配置并在表中标注 skipped；bot 中途离开场地 → 诊断并送回。
验证位置：人工运行并核对输出（PLAN M6 验收项）
验证状态：未执行；本文件尚未实现。

## 替换为代码时

先读取并遵守项目的 README.md、docs/BLUEPRINT.md、docs/PLAN.md 及 AGENTS.md。只有获得对应里程碑的实现授权、并实际写入实现时，才删除这份占位说明。完整文件契约继续保留在蓝图中；设计变化必须同步记录。
