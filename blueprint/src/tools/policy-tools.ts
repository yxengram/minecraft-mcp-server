BLUEPRINT_PLACEHOLDER — NOT IMPLEMENTED — DO NOT RUN

# src/tools/policy-tools.ts

本文件目前只有设计说明，不是可执行代码或有效运行配置。不要运行、导入、构建、格式化或把它当成已完成的测试。
它位于 blueprint/ 镜像目录；实现时在项目根目录的最终路径 src/tools/policy-tools.ts 创建真实代码，并删除本占位文件。

所属模块：M-MCP 工具接口
实现里程碑：M3（list-decision-models 在 M4）
实现状态：placeholder
设计状态：已确定：工具名；输出格式暂定
设计版本：v0.3
契约位置：docs/BLUEPRINT.md 中的 F-018

## 职责与边界

主要职责：注册 3 个 MCP 工具：get-policy（当前策略摘要，以及决策功能状态与本小时调用次数）、set-policy（部分更新）、list-decision-models（实时决策模型目录）。
不负责：不含策略规则与校验（在 src/autopilot/policy.ts）；不发 HTTP 请求本身（经 src/decisions/openrouter-client.ts）。

## 输入

来源：LLM（经 MCP）。
内容与形式：set-policy：部分策略对象。其余无参数。
关键限制：set-policy 的来源固定标记为 llm。

## 输出

去向：LLM；src/event-store.ts（策略警告，例如开启攻击玩家）。
内容与形式：get-policy：分组列出的策略与决策状态（disabled / enabled + 模型 + 本小时调用数）。set-policy：更新后的摘要与警告，或全部校验错误。list-decision-models：模型 id、上下文长度、价格，或“未配置 API key”。
成功含义：set-policy 后 get-policy 立即反映新值。

## 与其他文件的关系

谁调用或使用本文件：src/main.ts（注册）；tests/policy-tools.test.ts（验证）；scripts/test-live-world.mjs（实机覆盖）。
本文件调用或依赖谁：src/tool-factory.ts（现有）；src/autopilot/policy.ts（读写）；src/decisions/openrouter-client.ts（模型目录与调用统计）；src/event-store.ts（现有，写警告事件）。
外部依赖：zod。

关系尚未实现；不要把计划关系写成已经观察到的运行事实。

## 状态、副作用与约束

持有或改变的状态：无。
外部副作用：修改内存中的策略；list-decision-models 联网（无费用的目录查询，待验证）。
关键约束：输出中绝不包含 API key；校验失败时不改变策略。
失败处理：校验错误、无 key、网络错误都以明确的工具错误或说明返回。

## 如何验收

正常场景：set-policy 关闭 autoEat → get-policy 显示 autoEat disabled。
边界或失败场景：set-policy 传入未知字段 → 返回错误且策略不变；没有 key 时 list-decision-models 说明未配置。
验证位置：tests/policy-tools.test.ts；scripts/test-live-world.mjs
验证状态：未执行；本文件尚未实现。

## 替换为代码时

先读取并遵守项目的 README.md、docs/BLUEPRINT.md、docs/PLAN.md 及 AGENTS.md。只有获得对应里程碑的实现授权、并实际写入实现时，才删除这份占位说明。完整文件契约继续保留在蓝图中；设计变化必须同步记录。
