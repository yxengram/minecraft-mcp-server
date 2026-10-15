BLUEPRINT_PLACEHOLDER — NOT IMPLEMENTED — DO NOT RUN

# src/autopilot/combat.ts

本文件目前只有设计说明，不是可执行代码或有效运行配置。不要运行、导入、构建、格式化或把它当成已完成的测试。
它位于 blueprint/ 镜像目录；实现时在项目根目录的最终路径 src/autopilot/combat.ts 创建真实代码，并删除本占位文件。

所属模块：M-CMB 战斗与威胁
实现里程碑：M2
实现状态：placeholder
设计状态：暂定：冷却数值与撤退血量默认值待情景测试调整
设计版本：v0.3
契约位置：docs/BLUEPRINT.md 中的 F-011

## 职责与边界

主要职责：对一个合法目标进行近战：装备最好的近战武器，接近到攻击距离，看向目标，按武器攻击冷却出手；目标死亡、丢失或超出追击距离时结束；自身血量低于阈值时撤退。
不负责：不选择目标（由调用者给出）；不判断是否应该参战；不使用弓、弩、盾牌（本版本非目标）。

## 输入

来源：src/autopilot/behaviors/guard.ts、src/autopilot/behaviors/hunt.ts、src/autopilot/reflexes.ts（self-defense）。
内容与形式：目标实体、最大追击距离、撤退血量、取消信号。
关键限制：目标必须通过 src/autopilot/threats.ts 的合法性检查，否则立即返回非法目标，不出手。

## 输出

去向：调用者。
内容与形式：结果：killed / lost / out_of_range / retreated / cancelled / illegal_target，附攻击次数与耗时。
成功含义：结束时没有残留的寻路目标或按键状态。

## 与其他文件的关系

谁调用或使用本文件：src/autopilot/behaviors/guard.ts、src/autopilot/behaviors/hunt.ts、src/autopilot/reflexes.ts（调用）；tests/combat.test.ts（验证）；tests/work-behaviors.test.ts（作为被测行为的依赖）；scripts/test-scenarios.mjs（zombie-wave，经 MCP 服务器间接使用）。
本文件调用或依赖谁：src/autopilot/threats.ts（合法性与目标状态）；src/tools/movement-utils.ts（现有，stopPathfinder）。
外部依赖：mineflayer（attack、lookAt、equip）、mineflayer-pathfinder（GoalFollow）、minecraft-data（武器攻击速度）。

关系尚未实现；不要把计划关系写成已经观察到的运行事实。

## 状态、副作用与约束

持有或改变的状态：战斗过程中的临时状态（上次出手时间、攻击次数）。
外部副作用：攻击实体、移动、切换手持物品。
关键约束：两次出手的间隔不小于武器冷却（剑约 0.625 秒，其他武器按 minecraft-data 攻击速度，暂定）；收到取消信号后 1 刻内停止出手；结束时调用 stopPathfinder。
失败处理：寻路失败 → lost；装备失败 → 空手继续；目标中途变为非法（例如被驯服）→ 立即结束为 illegal_target。

## 如何验收

正常场景：模拟目标在若干次攻击后失效 → killed，攻击间隔不小于冷却。
边界或失败场景：自身血量降到撤退阈值 → retreated；目标为玩家 → illegal_target 且攻击次数为 0；取消信号 → cancelled 且寻路目标被清除。
验证位置：tests/combat.test.ts；scripts/test-scenarios.mjs
验证状态：未执行；本文件尚未实现。

## 替换为代码时

先读取并遵守项目的 README.md、docs/BLUEPRINT.md、docs/PLAN.md 及 AGENTS.md。只有获得对应里程碑的实现授权、并实际写入实现时，才删除这份占位说明。完整文件契约继续保留在蓝图中；设计变化必须同步记录。
