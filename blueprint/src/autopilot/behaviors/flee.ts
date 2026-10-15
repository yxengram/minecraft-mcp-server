BLUEPRINT_PLACEHOLDER — NOT IMPLEMENTED — DO NOT RUN

# src/autopilot/behaviors/flee.ts

本文件目前只有设计说明，不是可执行代码或有效运行配置。不要运行、导入、构建、格式化或把它当成已完成的测试。
它位于 blueprint/ 镜像目录；实现时在项目根目录的最终路径 src/autopilot/behaviors/flee.ts 创建真实代码，并删除本占位文件。

所属模块：M-TASK 任务与行为
实现里程碑：M1
实现状态：placeholder
设计状态：已确定；“保持 2 秒视为完成”暂定
设计版本：v0.3
契约位置：docs/BLUEPRINT.md 中的 F-005

## 职责与边界

主要职责：远离一个实体直到达到指定距离并保持 2 秒后完成。现有 flee-from 工具改由本行为实现。
不负责：不攻击；不选择逃离目标。

## 输入

来源：src/autopilot/task-manager.ts。
内容与形式：目标（entityId、玩家名或实体类型之一）、逃离距离（默认 16，范围 2–64）。
关键限制：目标在启动时必须可见。

## 输出

去向：src/autopilot/task-manager.ts。
内容与形式：当前步骤：fleeing from <目标>（当前距离 / 目标距离）。结果：完成（距离已达到）、完成（目标消失）、失败（无路可逃，连续 5 秒距离不增加）或取消。
成功含义：完成时与目标的距离不小于逃离距离。

## 与其他文件的关系

谁调用或使用本文件：src/autopilot/task-manager.ts；tests/movement-behaviors.test.ts。
本文件调用或依赖谁：src/autopilot/task-manager.ts（行为契约）；src/tools/entity-utils.ts（现有）；src/tools/movement-utils.ts（现有）。
外部依赖：mineflayer-pathfinder：GoalInvert(GoalFollow) 动态目标。

关系尚未实现；不要把计划关系写成已经观察到的运行事实。

## 状态、副作用与约束

持有或改变的状态：无持久状态。
外部副作用：驱动 bot 移动。
关键约束：遵守 pathfinder 的安全落差限制，不跳下高处或进入岩浆；暂停与取消时清除寻路目标。
失败处理：连续 5 秒距离没有增加 → 失败“cannot get further away”。

## 如何验收

正常场景：目标在 3 格处 → 任务完成时距离 ≥ 16。
边界或失败场景：bot 被墙围住 → 5 秒后失败；目标在逃离过程中消失 → 以“target gone”完成。
验证位置：tests/movement-behaviors.test.ts
验证状态：未执行；本文件尚未实现。

## 替换为代码时

先读取并遵守项目的 README.md、docs/BLUEPRINT.md、docs/PLAN.md 及 AGENTS.md。只有获得对应里程碑的实现授权、并实际写入实现时，才删除这份占位说明。完整文件契约继续保留在蓝图中；设计变化必须同步记录。
