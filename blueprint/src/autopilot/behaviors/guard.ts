BLUEPRINT_PLACEHOLDER — NOT IMPLEMENTED — DO NOT RUN

# src/autopilot/behaviors/guard.ts

本文件目前只有设计说明，不是可执行代码或有效运行配置。不要运行、导入、构建、格式化或把它当成已完成的测试。
它位于 blueprint/ 镜像目录；实现时在项目根目录的最终路径 src/autopilot/behaviors/guard.ts 创建真实代码，并删除本占位文件。

所属模块：M-TASK 任务与行为
实现里程碑：M2
实现状态：placeholder
设计状态：暂定：守卫半径与追击距离默认值待情景测试调整
设计版本：v0.3
契约位置：docs/BLUEPRINT.md 中的 F-006

## 职责与边界

主要职责：守卫一个玩家（贴身保镖）或一个地点：清理守卫半径内的合法敌对目标，之后回到守卫位置，直到被取消。
不负责：不攻击玩家、被动生物和默认的中立生物（由 src/autopilot/threats.ts 判定）；不处理自身危险（由反射负责）。

## 输入

来源：src/autopilot/task-manager.ts。
内容与形式：守卫对象：玩家名、实体 id、路标名或坐标之一（默认当前位置）；守卫半径（默认 8，范围 2–24）；最大追击距离（默认 16）。
关键限制：守卫玩家时该玩家必须可见；路标必须存在且在当前维度。

## 输出

去向：src/autopilot/task-manager.ts。
内容与形式：当前步骤：guarding <对象>、chasing <目标 id>、returning to post。进度：每次击杀（目标类型与累计数）、守卫对象暂时看不见。结果：只有失败（守卫玩家丢失超过 15 秒）或取消。
成功含义：有敌对生物进入守卫半径时开始战斗，战斗后回到守卫位置 3 格内。

## 与其他文件的关系

谁调用或使用本文件：src/autopilot/task-manager.ts；tests/work-behaviors.test.ts；scripts/test-scenarios.mjs（zombie-wave 情景）。
本文件调用或依赖谁：src/autopilot/task-manager.ts（行为契约）；src/autopilot/threats.ts（合法目标与附近敌对生物）；src/autopilot/combat.ts（战斗）；src/waypoint-store.ts（现有，读取路标）；src/tools/entity-utils.ts（现有）。
外部依赖：mineflayer-pathfinder：返回守卫位置。

关系尚未实现；不要把计划关系写成已经观察到的运行事实。

## 状态、副作用与约束

持有或改变的状态：累计击杀数（任务内）。
外部副作用：驱动 bot 移动与攻击。
关键约束：只攻击 threats.ts 判为合法的目标；追击超出最大距离时放弃并返回；暂停时中止当前战斗回合。
失败处理：守卫的玩家消失超过 15 秒 → 失败；寻路失败 → 记录进度并继续守卫，不终止任务。

## 如何验收

正常场景：守卫玩家时，一只僵尸进入 8 格 → 被击杀，进度报告击杀 1；bot 回到玩家身边。
边界或失败场景：一只猪进入守卫半径 → 不攻击；僵尸逃出 16 格 → 停止追击并返回。
验证位置：tests/work-behaviors.test.ts；scripts/test-scenarios.mjs
验证状态：未执行；本文件尚未实现。

## 替换为代码时

先读取并遵守项目的 README.md、docs/BLUEPRINT.md、docs/PLAN.md 及 AGENTS.md。只有获得对应里程碑的实现授权、并实际写入实现时，才删除这份占位说明。完整文件契约继续保留在蓝图中；设计变化必须同步记录。
