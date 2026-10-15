BLUEPRINT_PLACEHOLDER — NOT IMPLEMENTED — DO NOT RUN

# src/autopilot/threats.ts

本文件目前只有设计说明，不是可执行代码或有效运行配置。不要运行、导入、构建、格式化或把它当成已完成的测试。
它位于 blueprint/ 镜像目录；实现时在项目根目录的最终路径 src/autopilot/threats.ts 创建真实代码，并删除本占位文件。

所属模块：M-CMB 战斗与威胁
实现里程碑：M2（M3 扩展环境危险）
实现状态：placeholder
设计状态：已确定：判定规则；中立生物名单暂定
设计版本：v0.3
契约位置：docs/BLUEPRINT.md 中的 F-010

## 职责与边界

主要职责：根据当前游戏状态计算威胁信息：附近的敌对生物（按距离）、即将爆炸的苦力怕、自身是否着火/在岩浆中/氧气过低/低血量，以及远离威胁的方向；判断某个实体能否作为攻击目标。
不负责：不移动 bot；不做任何决定；不调用网络。

## 输入

来源：src/autopilot/reflexes.ts、src/autopilot/combat.ts、src/autopilot/behaviors/guard.ts、src/autopilot/behaviors/hunt.ts、src/decisions/decision-hooks.ts。
内容与形式：bot（实体表、自身状态、方块查询）；当前策略中的攻击规则；可选的“明确允许的目标类型”（hunt 使用）。
关键限制：只读取内存数据；单次计算的目标耗时低于 1 毫秒（目标，待实测）。

## 输出

去向：上述调用者。
内容与形式：威胁摘要（敌对生物列表与距离、膨胀中的苦力怕、着火/岩浆/氧气/血量状态）；目标合法性（是或否，附原因）；逃离方向（水平单位向量）。
成功含义：同一状态下结果确定且可重复。

## 与其他文件的关系

谁调用或使用本文件：src/autopilot/reflexes.ts、src/autopilot/combat.ts、src/autopilot/behaviors/guard.ts、src/autopilot/behaviors/hunt.ts、src/decisions/decision-hooks.ts（调用）；tests/threats.test.ts（验证）；tests/combat.test.ts（作为被测模块的依赖）。
本文件调用或依赖谁：src/tools/entity-utils.ts（现有，附近实体与苦力怕状态）；src/tools/terrain-utils.ts（现有，方块可通行判断）；src/tools/gamestate-tools.ts（现有，自身氧气读取）；src/autopilot/policy.ts（读取攻击规则）。
外部依赖：mineflayer、minecraft-data。

关系尚未实现；不要把计划关系写成已经观察到的运行事实。

## 状态、副作用与约束

持有或改变的状态：无状态。
外部副作用：无。
关键约束：玩家永远不是合法目标，除非策略显式开启攻击玩家；被动生物只在被明确指定类型时合法；被驯服的动物永远不合法；默认中立生物（例如末影人、狼、猪灵、北极熊、蜜蜂）不合法。
失败处理：实体数据缺失或异常时视为非威胁并跳过，不抛错。

## 如何验收

正常场景：7 格内膨胀中的苦力怕被列为最高威胁；站在岩浆中被识别；逃离方向与威胁质心方向相反。
边界或失败场景：玩家在“不攻击玩家”时判为非法目标；被驯服的狼判为非法；没有威胁时返回空列表和零向量。
验证位置：tests/threats.test.ts
验证状态：未执行；本文件尚未实现。

## 替换为代码时

先读取并遵守项目的 README.md、docs/BLUEPRINT.md、docs/PLAN.md 及 AGENTS.md。只有获得对应里程碑的实现授权、并实际写入实现时，才删除这份占位说明。完整文件契约继续保留在蓝图中；设计变化必须同步记录。
