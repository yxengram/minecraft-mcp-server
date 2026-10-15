BLUEPRINT_PLACEHOLDER — NOT IMPLEMENTED — DO NOT RUN

# src/decisions/openrouter-client.ts

本文件目前只有设计说明，不是可执行代码或有效运行配置。不要运行、导入、构建、格式化或把它当成已完成的测试。
它位于 blueprint/ 镜像目录；实现时在项目根目录的最终路径 src/decisions/openrouter-client.ts 创建真实代码，并删除本占位文件。

所属模块：M-DEC 决策
实现里程碑：M4
实现状态：placeholder
设计状态：已核实接口路径；响应细节与模型目录格式待验证
设计版本：v0.3
契约位置：docs/BLUEPRINT.md 中的 F-015

## 职责与边界

主要职责：调用 OpenRouter Decisions API（POST https://openrouter.ai/api/alpha/decisions）和决策模型目录（GET https://openrouter.ai/api/v1/models?output_modalities=decisions）；处理超时、速率限制、错误分类与响应校验。
不负责：不构造具体问题（由 src/decisions/decision-hooks.ts 负责）；不决定是否执行动作；不缓存决策结果。

## 输入

来源：src/decisions/decision-hooks.ts（决策请求）；src/tools/policy-tools.ts（查询模型目录）；环境变量 OPENROUTER_API_KEY（只在本文件读取）。
内容与形式：模型 id、state（对象）、questions（noul / choice / score，含 instructions 与 criteria）、超时（默认 1500 毫秒）。
关键限制：没有 API key 时不发请求，直接返回“disabled”；一次请求的问题数不超过 128；速率超过策略上限时直接拒绝。

## 输出

去向：调用者。
内容与形式：成功：按问题名返回的答案（noul 概率；choice 选项、各选项概率、置信度；score 分数与概率），以及响应中的模型名、用量与本地测得的延迟。失败：可区分的错误类型（disabled / rate_limited / timeout / http_error / invalid_response）与说明。模型目录：模型 id、名称、上下文长度、价格。
成功含义：成功结果中每个问题都有对应答案；失败从不以伪造的空答案返回。

## 与其他文件的关系

谁调用或使用本文件：src/decisions/decision-hooks.ts、src/tools/policy-tools.ts（调用）；src/autopilot/autopilot.ts（创建）；tests/openrouter-client.test.ts（验证）；tests/decision-hooks.test.ts（以模拟替身代替）。
本文件调用或依赖谁：src/autopilot/policy.ts（读取速率上限与默认模型）。
外部依赖：OpenRouter（HTTPS，可能产生费用）；Node.js 内置 fetch 与 AbortController。

关系尚未实现；不要把计划关系写成已经观察到的运行事实。

## 状态、副作用与约束

持有或改变的状态：最近一分钟的调用时间窗口、本小时调用次数（内存）。
外部副作用：联网；每次成功调用可能产生费用。
关键约束：API key 绝不写入日志、事件、错误信息或工具输出；请求超时后立即放弃，不自动重试；只在 decisions.enabled 为 true 且有 key 时发送请求。
失败处理：网络错误、非 2xx 状态、超时、响应缺少某个问题的答案 → 返回对应错误类型；不抛出未分类异常。

## 如何验收

正常场景：模拟服务器返回示例响应 → 解析出 noul 与 choice 答案、模型名和延迟。
边界或失败场景：没有 key → disabled 且未发起请求；模拟 2 秒无响应 → timeout；1 分钟内第 31 次调用 → rate_limited；响应缺少问题答案 → invalid_response；错误信息中不包含 key。
验证位置：tests/openrouter-client.test.ts
验证状态：未执行；本文件尚未实现。

## 替换为代码时

先读取并遵守项目的 README.md、docs/BLUEPRINT.md、docs/PLAN.md 及 AGENTS.md。只有获得对应里程碑的实现授权、并实际写入实现时，才删除这份占位说明。完整文件契约继续保留在蓝图中；设计变化必须同步记录。
