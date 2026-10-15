BLUEPRINT_PLACEHOLDER — NOT IMPLEMENTED — DO NOT RUN

# scripts/lib/live-arena.mjs

本文件目前只有设计说明，不是可执行代码或有效运行配置。不要运行、导入、构建、格式化或把它当成已完成的测试。
它位于 blueprint/ 镜像目录；实现时在项目根目录的最终路径 scripts/lib/live-arena.mjs 创建真实代码，并删除本占位文件。

所属模块：M-VER 验证
实现里程碑：M6
实现状态：placeholder
设计状态：已确定：从现有 scripts/test-live-world.mjs 中抽取已验证的辅助逻辑
设计版本：v0.3
契约位置：docs/BLUEPRINT.md 中的 F-033

## 职责与边界

主要职责：为实机测试脚本提供共享辅助：启动 MCP 客户端、等待 bot 生成、执行指令、搭建与拆除带围墙的固定高度场地、启动辅助玩家、场地检查与失败诊断。scripts/test-live-world.mjs 与 scripts/test-scenarios.mjs 共用。
不负责：不包含具体测试步骤或情景。

## 输入

来源：scripts/test-live-world.mjs、scripts/test-scenarios.mjs（导入）。
内容与形式：LAN 端口、bot 与辅助玩家的名字、场地高度与半径、MCP 服务器路径。
关键限制：只在开发者显式运行实机测试时使用。

## 输出

去向：导入它的测试脚本。
内容与形式：已连接的 MCP 客户端与调用函数、场地坐标、辅助玩家实例、诊断输出。
成功含义：两个脚本行为与抽取前的 test-live-world 一致（全量实机测试仍 54/54 以上通过）。

## 与其他文件的关系

谁调用或使用本文件：scripts/test-live-world.mjs、scripts/test-scenarios.mjs（导入）。
本文件调用或依赖谁：dist/main.js（作为子进程启动）。
外部依赖：MCP SDK 客户端、mineflayer、Minecraft 测试世界。

关系尚未实现；不要把计划关系写成已经观察到的运行事实。

## 状态、副作用与约束

持有或改变的状态：场地坐标与是否就绪（脚本运行期间）。
外部副作用：修改测试世界。
关键约束：保留现有防护：固定高度 y=240、围墙、创造模式开局、结束前 spreadplayers 送回地面、setup 失败抛出可识别错误。
失败处理：无法执行指令 → 抛出“需要开启作弊”的明确错误。

## 如何验收

正常场景：重构后 test-live-world 连续两轮全部通过。
边界或失败场景：bot 登录时在半空 → 不会摔死；场地已存在 → 被清空后重建。
验证位置：scripts/test-live-world.mjs 实机运行（人工）
验证状态：未执行；本文件尚未实现。

## 替换为代码时

先读取并遵守项目的 README.md、docs/BLUEPRINT.md、docs/PLAN.md 及 AGENTS.md。只有获得对应里程碑的实现授权、并实际写入实现时，才删除这份占位说明。完整文件契约继续保留在蓝图中；设计变化必须同步记录。
