BLUEPRINT_PLACEHOLDER — NOT IMPLEMENTED — DO NOT RUN

# src/autopilot/behaviors/hunt.ts

本文件目前只有设计说明，不是可执行代码或有效运行配置。不要运行、导入、构建、格式化或把它当成已完成的测试。
它位于 blueprint/ 镜像目录；实现时在项目根目录的最终路径 src/autopilot/behaviors/hunt.ts 创建真实代码，并删除本占位文件。

所属模块：M-TASK 任务与行为
实现里程碑：M2
实现状态：placeholder
设计状态：暂定
设计版本：v0.3
契约位置：docs/BLUEPRINT.md 中的 F-008

## 职责与边界

主要职责：猎杀指定数量的某种动物并拾取掉落物，用于获取食物等资源。
不负责：不攻击未指定类型的生物；不攻击玩家或被驯服的动物。

## 输入

来源：src/autopilot/task-manager.ts。
内容与形式：动物类型（例如 cow、pig、chicken、sheep、rabbit）、数量（1–16）、搜索距离（默认 32）、时间上限（默认 120 秒）。
关键限制：类型必须是 minecraft-data 中的实体名，且不能是 player。

## 输出

去向：src/autopilot/task-manager.ts。
内容与形式：当前步骤：searching、chasing <目标 id>、collecting drops。进度：已击杀数量。结果：击杀数量与背包新增物品摘要，失败时附原因。
成功含义：击杀数量达到要求，且附近掉落物被拾取。

## 与其他文件的关系

谁调用或使用本文件：src/autopilot/task-manager.ts；tests/work-behaviors.test.ts。
本文件调用或依赖谁：src/autopilot/task-manager.ts（行为契约）；src/autopilot/threats.ts（合法目标：被明确指定的被动生物，排除被驯服的）；src/autopilot/combat.ts（战斗）；src/tools/entity-utils.ts（现有，掉落物识别）。
外部依赖：mineflayer、mineflayer-pathfinder。

关系尚未实现；不要把计划关系写成已经观察到的运行事实。

## 状态、副作用与约束

持有或改变的状态：已击杀数量（任务内）。
外部副作用：攻击动物、移动、拾取物品。
关键约束：被驯服的动物（有主人）不是合法目标；每次击杀后先拾取掉落物再找下一个。
失败处理：附近找不到该动物 → 失败（若一只都没击杀）或以部分结果完成；超时同理。

## 如何验收

正常场景：附近有 2 头牛，要求 2 → 完成，背包出现牛肉。
边界或失败场景：指定 wolf，附近只有被驯服的狼 → 失败“no huntable wolf”；指定 player → 参数校验拒绝。
验证位置：tests/work-behaviors.test.ts
验证状态：未执行；本文件尚未实现。

## 替换为代码时

先读取并遵守项目的 README.md、docs/BLUEPRINT.md、docs/PLAN.md 及 AGENTS.md。只有获得对应里程碑的实现授权、并实际写入实现时，才删除这份占位说明。完整文件契约继续保留在蓝图中；设计变化必须同步记录。
