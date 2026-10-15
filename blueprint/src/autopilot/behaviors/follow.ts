BLUEPRINT_PLACEHOLDER — NOT IMPLEMENTED — DO NOT RUN

# src/autopilot/behaviors/follow.ts

本文件目前只有设计说明，不是可执行代码或有效运行配置。不要运行、导入、构建、格式化或把它当成已完成的测试。
它位于 blueprint/ 镜像目录；实现时在项目根目录的最终路径 src/autopilot/behaviors/follow.ts 创建真实代码，并删除本占位文件。

所属模块：M-TASK 任务与行为
实现里程碑：M1
实现状态：placeholder
设计状态：已确定；“目标丢失”判定时长暂定 10 秒
设计版本：v0.3
契约位置：docs/BLUEPRINT.md 中的 F-004

## 职责与边界

主要职责：持续跟随一个实体（玩家名、实体 id 或类型），保持在指定距离内，直到被取消。现有 follow-entity 工具改由本行为实现。
不负责：不攻击；不处理威胁（由反射负责）；不决定跟随谁。

## 输入

来源：src/autopilot/task-manager.ts（运行时传入参数、上下文和取消信号）。
内容与形式：目标（entityId、玩家名或实体类型之一）、保持距离（默认 3，范围 1–16）、搜索距离（默认 32）。
关键限制：目标在启动时必须可见，否则启动失败；保持距离为正数。

## 输出

去向：src/autopilot/task-manager.ts（进度与结果）。
内容与形式：当前步骤：following <目标>（距离 N）或 target out of sight。进度：目标暂时看不见、重新看见。结果：只有失败（目标丢失超过 10 秒）或被取消，本行为不会自行完成。
成功含义：跟随期间与目标距离大多数时候不超过“保持距离 + 2”。

## 与其他文件的关系

谁调用或使用本文件：src/autopilot/task-manager.ts（注册与运行）；tests/movement-behaviors.test.ts（验证）。
本文件调用或依赖谁：src/autopilot/task-manager.ts（导入行为契约）；src/tools/entity-utils.ts（现有，解析目标）；src/tools/movement-utils.ts（现有，stopPathfinder）。
外部依赖：mineflayer-pathfinder：GoalFollow 动态目标。

关系尚未实现；不要把计划关系写成已经观察到的运行事实。

## 状态、副作用与约束

持有或改变的状态：无持久状态。
外部副作用：驱动 bot 移动。
关键约束：暂停时立即清除寻路目标，恢复时重新设置；取消时清除寻路目标且不留残留标志。
失败处理：目标消失超过 10 秒 → 失败“target lost”；启动时找不到目标 → 启动失败并说明原因。

## 如何验收

正常场景：目标在 6 格外 → 数秒内距离缩短到 3 格左右；取消后不再移动。
边界或失败场景：目标下线 → 10 秒后任务失败；暂停期间目标移动，bot 不动，恢复后继续跟随。
验证位置：tests/movement-behaviors.test.ts
验证状态：未执行；本文件尚未实现。

## 替换为代码时

先读取并遵守项目的 README.md、docs/BLUEPRINT.md、docs/PLAN.md 及 AGENTS.md。只有获得对应里程碑的实现授权、并实际写入实现时，才删除这份占位说明。完整文件契约继续保留在蓝图中；设计变化必须同步记录。
