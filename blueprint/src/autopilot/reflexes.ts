BLUEPRINT_PLACEHOLDER — NOT IMPLEMENTED — DO NOT RUN

# src/autopilot/reflexes.ts

本文件目前只有设计说明，不是可执行代码或有效运行配置。不要运行、导入、构建、格式化或把它当成已完成的测试。
它位于 blueprint/ 镜像目录；实现时在项目根目录的最终路径 src/autopilot/reflexes.ts 创建真实代码，并删除本占位文件。

所属模块：M-RFX 反射
实现里程碑：M3（self-defense 的 auto 姿态在 M5 接入决策）
实现状态：placeholder
设计状态：暂定：触发阈值与时长为默认值，待情景测试调整
设计版本：v0.3
契约位置：docs/BLUEPRINT.md 中的 F-013

## 职责与边界

主要职责：定义 5 个反射，每个包含触发条件、动作、类别、优先级、冷却与最长时长。前三个是关键反射（保命，手动命令不能打断），后两个是日常反射（手动命令可以打断）。按优先级从高到低：1. creeper-evade：7 格内有膨胀中的苦力怕 → 冲刺到 8 格以外，最长 3 秒。2. hazard-escape：着火、在岩浆中或氧气 ≤ 6 → 移到最近的安全方块（在水中则向上），最长 5 秒。3. low-health-retreat：血量低于阈值（默认 6）且 16 格内有敌对生物 → 远离到 16 格以外，有食物时进食，最长 10 秒。4. self-defense：刚被敌对生物攻击 → 按姿态还手（fight）、逃离（flee）或交给决策钩子（auto，等待结果期间按规则默认），最长 20 秒。5. auto-eat：饥饿值低于阈值（默认 14）、8 格内没有敌对生物且有食物 → 进食，最长 3 秒。
不负责：不负责调度、冷却计时和租约（由 src/autopilot/reflex-engine.ts 负责）。

## 输入

来源：src/autopilot/reflex-engine.ts（评估与执行时传入上下文）。
内容与形式：bot、威胁摘要、当前策略、最近一次受伤信息、取消信号。
关键限制：触发条件函数只能做内存计算。

## 输出

去向：src/autopilot/reflex-engine.ts。
内容与形式：触发条件结果（是否触发与原因文字）；动作结果（结果文字）。
成功含义：每个反射在其情景中达到预期效果（见验收）。

## 与其他文件的关系

谁调用或使用本文件：src/autopilot/reflex-engine.ts（导入）；tests/reflexes.test.ts；scripts/test-scenarios.mjs。
本文件调用或依赖谁：src/autopilot/threats.ts（威胁与逃离方向）；src/autopilot/combat.ts（还手）；src/decisions/decision-hooks.ts（auto 姿态的战斗判断）；src/tools/movement-utils.ts、src/tools/item-utils.ts（现有，寻路与食物选择）；src/autopilot/policy.ts（阈值）。
外部依赖：mineflayer（consume、setControlState）、mineflayer-pathfinder。

关系尚未实现；不要把计划关系写成已经观察到的运行事实。

## 状态、副作用与约束

持有或改变的状态：无（冷却由引擎管理）。
外部副作用：移动、攻击、进食。
关键约束：永远不攻击玩家（由 combat.ts 与 threats.ts 保证）；逃离使用 pathfinder 的安全移动，不跳下高处或走进岩浆；auto-eat 不在附近有敌对生物时进食；auto 姿态下决策结果到达前先执行规则默认动作。
失败处理：动作失败返回失败结果，由引擎记录；找不到食物时 auto-eat 不触发（触发条件包含“有食物”）。

## 如何验收

正常场景：creeper-evade：膨胀中的苦力怕在 4 格处 → 爆炸前距离 ≥ 8。auto-eat：饥饿 10、有面包、附近无怪 → 吃下面包。
边界或失败场景：self-defense 姿态 flee → 不还手而是逃离；auto 姿态且决策不可用 → 按规则（血量 ≥ 10 且敌对生物 ≤ 2 则还手，否则逃离）；被玩家攻击 → 不还手，只写事件。
验证位置：tests/reflexes.test.ts；scripts/test-scenarios.mjs
验证状态：未执行；本文件尚未实现。

## 替换为代码时

先读取并遵守项目的 README.md、docs/BLUEPRINT.md、docs/PLAN.md 及 AGENTS.md。只有获得对应里程碑的实现授权、并实际写入实现时，才删除这份占位说明。完整文件契约继续保留在蓝图中；设计变化必须同步记录。
