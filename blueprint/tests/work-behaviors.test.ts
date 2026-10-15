BLUEPRINT_PLACEHOLDER — NOT IMPLEMENTED — DO NOT RUN

# tests/work-behaviors.test.ts

本文件目前只有设计说明，不是可执行代码或有效运行配置。不要运行、导入、构建、格式化或把它当成已完成的测试。
它位于 blueprint/ 镜像目录；实现时在项目根目录的最终路径 tests/work-behaviors.test.ts 创建真实代码，并删除本占位文件。

所属模块：M-VER 验证
实现里程碑：M2
实现状态：placeholder
设计状态：已确定：覆盖范围；具体样例随实现补充，不能照抄实现行为
设计版本：v0.3
契约位置：docs/BLUEPRINT.md 中的 F-027

## 职责与边界

主要职责：验证 src/autopilot/behaviors/guard.ts、gather.ts、hunt.ts 的契约行为。
不负责：不连接真实 Minecraft 服务器或 OpenRouter；不测试其他模块的内部细节。

## 输入

来源：ava 测试运行器（npm test，仅运行 tests/**/*.test.ts）。
内容与形式：模拟的 bot、实体、方块、事件存储与时钟（沿用现有 tests/_helpers.ts、tests/_world.ts 的做法）。
关键限制：使用 sinon 假时钟控制时间，避免依赖真实等待；不发网络请求。

## 输出

去向：ava 测试报告。
内容与形式：每个场景的通过或失败。
成功含义：下列场景全部通过，且失败时能指出违反的契约。

## 与其他文件的关系

谁调用或使用本文件：npm test（ava）。
本文件调用或依赖谁：src/autopilot/behaviors/guard.ts、gather.ts、hunt.ts（被测）；src/autopilot/combat.ts；tests/_helpers.ts（现有 createFakeWorld）。
外部依赖：ava、sinon（现有开发依赖）。

关系尚未实现；不要把计划关系写成已经观察到的运行事实。

## 状态、副作用与约束

持有或改变的状态：无。
外部副作用：无。
关键约束：预期结果来自 docs/BLUEPRINT.md 的契约与不变量，而不是实现的实际输出；每个测试互相独立。
失败处理：断言失败时给出具体的期望与实际值。

## 如何验收

正常场景：guard 在敌对生物进入半径时调用战斗并在之后返回守卫位置；gather 在模拟世界中挖够数量并完成；hunt 击杀指定数量并拾取掉落。
边界或失败场景：guard 不攻击猪和玩家；追击超出距离放弃；gather 跳过岩浆旁方块并沿用现有完成计数规则；hunt 指定 player 被参数校验拒绝；只有被驯服的狼时失败。
验证位置：tests/work-behaviors.test.ts（本文件）
验证状态：未执行；本文件尚未实现。

## 替换为代码时

先读取并遵守项目的 README.md、docs/BLUEPRINT.md、docs/PLAN.md 及 AGENTS.md。只有获得对应里程碑的实现授权、并实际写入实现时，才删除这份占位说明。完整文件契约继续保留在蓝图中；设计变化必须同步记录。
