BLUEPRINT_PLACEHOLDER — NOT IMPLEMENTED — DO NOT RUN

# src/autopilot/reflex-engine.ts

本文件目前只有设计说明，不是可执行代码或有效运行配置。不要运行、导入、构建、格式化或把它当成已完成的测试。
它位于 blueprint/ 镜像目录；实现时在项目根目录的最终路径 src/autopilot/reflex-engine.ts 创建真实代码，并删除本占位文件。

所属模块：M-RFX 反射
实现里程碑：M3
实现状态：placeholder
设计状态：已确定：每刻评估、优先级、冷却、超时；耗时目标待实测
设计版本：v0.3
契约位置：docs/BLUEPRINT.md 中的 F-012

## 职责与边界

主要职责：订阅每个游戏刻；按优先级评估已启用反射的触发条件；选出一个触发的反射，按其类别（关键反射 30、日常反射 15）取得身体控制权并执行；日常反射被手动命令打断时记为 interrupted；执行期间继续检查更高优先级的反射，可打断较低优先级的反射；管理冷却与最长时长；写 reflex 事件。
不负责：不定义具体反射（在 src/autopilot/reflexes.ts）；不等待网络；不管理任务（被抢占的任务由仲裁器通知任务管理器）。

## 输入

来源：src/autopilot/autopilot.ts（转交 mineflayer 的 physicsTick 与结构化受伤信息）；src/autopilot/reflexes.ts（反射定义）；src/autopilot/policy.ts（开关与阈值）。
内容与形式：每刻通知；最近一次受伤（攻击者实体 id、伤害类型、时间）；当前策略。
关键限制：评估阶段只能做内存计算，所有反射的评估总耗时目标低于 2 毫秒（目标，待实测）。

## 输出

去向：src/autopilot/action-arbiter.ts（申请与释放反射级租约）；src/event-store.ts（reflex 事件）。
内容与形式：reflex 事件：反射名、触发原因、结果（成功 / 失败 / 超时 / 被更高优先级反射打断 / 被手动命令打断）、耗时。
成功含义：触发条件成立的下一刻开始执行；冷却期内不重复触发。

## 与其他文件的关系

谁调用或使用本文件：src/autopilot/autopilot.ts（创建并转交每刻通知）；tests/reflexes.test.ts（验证）。
本文件调用或依赖谁：src/autopilot/reflexes.ts（导入反射定义）；src/autopilot/action-arbiter.ts（租约）；src/autopilot/policy.ts（读取）；src/event-store.ts（现有，写事件）。
外部依赖：无（mineflayer 的每刻事件经 src/autopilot/autopilot.ts 转交）。

关系尚未实现；不要把计划关系写成已经观察到的运行事实。

## 状态、副作用与约束

持有或改变的状态：每个反射的上次触发时间、当前执行中的反射及其取消控制器（内存）。
外部副作用：通过反射动作驱动 bot。
关键约束：同一时刻最多执行一个反射；每个反射动作有最长时长，超时强制取消并释放租约；关闭的反射不评估；评估异常不能影响下一刻。
失败处理：反射动作抛错 → 释放租约，写 reflex 事件（失败），进入冷却；触发条件评估抛错 → 跳过该反射本刻的评估并记录一次日志。

## 如何验收

正常场景：自卫和自动进食同时满足 → 只执行自卫；执行结束后进入冷却。
边界或失败场景：冷却期内条件再次满足 → 不触发；动作超过最长时长 → 被强制结束，事件结果为超时；执行自动进食时苦力怕开始膨胀 → 自动进食被打断，躲避苦力怕开始执行；手动命令到来时日常反射被打断（结果 interrupted），关键反射继续执行。
验证位置：tests/reflexes.test.ts
验证状态：未执行；本文件尚未实现。

## 替换为代码时

先读取并遵守项目的 README.md、docs/BLUEPRINT.md、docs/PLAN.md 及 AGENTS.md。只有获得对应里程碑的实现授权、并实际写入实现时，才删除这份占位说明。完整文件契约继续保留在蓝图中；设计变化必须同步记录。
