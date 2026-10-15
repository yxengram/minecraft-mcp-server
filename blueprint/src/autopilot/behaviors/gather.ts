BLUEPRINT_PLACEHOLDER — NOT IMPLEMENTED — DO NOT RUN

# src/autopilot/behaviors/gather.ts

本文件目前只有设计说明，不是可执行代码或有效运行配置。不要运行、导入、构建、格式化或把它当成已完成的测试。
它位于 blueprint/ 镜像目录；实现时在项目根目录的最终路径 src/autopilot/behaviors/gather.ts 创建真实代码，并删除本占位文件。

所属模块：M-TASK 任务与行为
实现里程碑：M2
实现状态：placeholder
设计状态：已确定：沿用现有 collect-block 的已验证逻辑
设计版本：v0.3
契约位置：docs/BLUEPRINT.md 中的 F-007

## 职责与边界

主要职责：寻找、挖掘并拾取指定数量的某种方块。逻辑从现有 src/tools/gathering-tools.ts 的 collect-block 迁移而来，collect-block 改为调用本行为并等待结果。
不负责：不合成、不存箱子；不在任务外挖掘其他方块（寻路自身的挖掘除外）。

## 输入

来源：src/autopilot/task-manager.ts（来自 start-task 或 collect-block）。
内容与形式：方块名、数量（1–64）、搜索距离（默认 32）、时间上限（默认 120 秒）。
关键限制：方块名必须存在于 minecraft-data。

## 输出

去向：src/autopilot/task-manager.ts；最终文字与现有 collect-block 的输出格式一致。
内容与形式：当前步骤：walking to / digging <方块坐标>、collecting drops。进度：已挖数量。结果：“Mined X of N <block>; inventory gained Y item(s)”，失败时附停止原因。
成功含义：与现有 collect-block 行为一致：完成数量正确计入寻路途中顺带挖掉的目标方块；跳过岩浆旁和够不到的方块。

## 与其他文件的关系

谁调用或使用本文件：src/autopilot/task-manager.ts；src/tools/gathering-tools.ts（经任务管理器委托）；tests/work-behaviors.test.ts。
本文件调用或依赖谁：src/autopilot/task-manager.ts（行为契约）；src/tools/block-utils.ts、src/tools/item-utils.ts（现有，挖掘与计数）。
外部依赖：minecraft-data、mineflayer、mineflayer-pathfinder。

关系尚未实现；不要把计划关系写成已经观察到的运行事实。

## 状态、副作用与约束

持有或改变的状态：已挖数量、跳过的位置（任务内）。
外部副作用：挖掘方块、移动、拾取物品。
关键约束：保持现有安全规则：不挖紧邻岩浆的方块；连续 5 次失败中止。暂停时停止挖掘，恢复后重新寻找目标。
失败处理：找不到更多方块、超时、连续失败 → 失败（若一个都没挖到）或以部分结果完成，与现有 collect-block 规则一致。

## 如何验收

正常场景：附近有 3 根原木，要求 3 → 完成，背包增加 3。
边界或失败场景：目标旁有岩浆 → 跳过并计入跳过数；现有 tests/gathering-tools.test.ts 全部继续通过。
验证位置：tests/work-behaviors.test.ts；tests/gathering-tools.test.ts（现有）
验证状态：未执行；本文件尚未实现。

## 替换为代码时

先读取并遵守项目的 README.md、docs/BLUEPRINT.md、docs/PLAN.md 及 AGENTS.md。只有获得对应里程碑的实现授权、并实际写入实现时，才删除这份占位说明。完整文件契约继续保留在蓝图中；设计变化必须同步记录。
