BLUEPRINT_PLACEHOLDER — NOT IMPLEMENTED — DO NOT RUN

# src/autopilot/behaviors/return-home.ts

本文件目前只有设计说明，不是可执行代码或有效运行配置。不要运行、导入、构建、格式化或把它当成已完成的测试。
它位于 blueprint/ 镜像目录；实现时在项目根目录的最终路径 src/autopilot/behaviors/return-home.ts 创建真实代码，并删除本占位文件。

所属模块：M-TASK 任务与行为
实现里程碑：M2
实现状态：placeholder
设计状态：暂定：床的搜索范围 8 格
设计版本：v0.3
契约位置：docs/BLUEPRINT.md 中的 F-009

## 职责与边界

主要职责：走到指定路标（默认 home）；如果是夜晚且允许睡觉，找附近的床睡下。
不负责：不放置床；不保存路标（由现有路标工具负责）。

## 输入

来源：src/autopilot/task-manager.ts。
内容与形式：路标名（默认 home）、是否睡觉（默认 true）、时间上限（默认 120 秒）。
关键限制：路标必须存在且在当前维度。

## 输出

去向：src/autopilot/task-manager.ts。
内容与形式：当前步骤：walking to <路标>（剩余距离）、looking for a bed、sleeping。结果：已到达（并已入睡 / 白天无需睡觉 / 附近没有床）或失败原因。
成功含义：bot 到达路标 3 格内；夜晚且附近有床时进入睡眠。

## 与其他文件的关系

谁调用或使用本文件：src/autopilot/task-manager.ts；tests/movement-behaviors.test.ts。
本文件调用或依赖谁：src/autopilot/task-manager.ts（行为契约）；src/waypoint-store.ts（现有，读取路标）；src/tools/movement-utils.ts（现有，带超时的寻路）。
外部依赖：mineflayer（isABed、sleep）、mineflayer-pathfinder。

关系尚未实现；不要把计划关系写成已经观察到的运行事实。

## 状态、副作用与约束

持有或改变的状态：无。
外部副作用：移动、睡觉。
关键约束：暂停时停止移动；睡眠中被取消则起床。
失败处理：路标不存在或在其他维度 → 启动失败；不可达或超时 → 失败。

## 如何验收

正常场景：白天，路标 home 在 20 格外 → 到达后完成“arrived (daytime)”。
边界或失败场景：夜晚，路标旁有床 → 完成“arrived and sleeping”；路标不存在 → 失败并说明。
验证位置：tests/movement-behaviors.test.ts
验证状态：未执行；本文件尚未实现。

## 替换为代码时

先读取并遵守项目的 README.md、docs/BLUEPRINT.md、docs/PLAN.md 及 AGENTS.md。只有获得对应里程碑的实现授权、并实际写入实现时，才删除这份占位说明。完整文件契约继续保留在蓝图中；设计变化必须同步记录。
