BLUEPRINT_PLACEHOLDER — NOT IMPLEMENTED — DO NOT RUN

# src/tools/task-tools.ts

本文件目前只有设计说明，不是可执行代码或有效运行配置。不要运行、导入、构建、格式化或把它当成已完成的测试。
它位于 blueprint/ 镜像目录；实现时在项目根目录的最终路径 src/tools/task-tools.ts 创建真实代码，并删除本占位文件。

所属模块：M-MCP 工具接口
实现里程碑：M1
实现状态：placeholder
设计状态：已确定：工具名与参数；输出措辞暂定
设计版本：v0.3
契约位置：docs/BLUEPRINT.md 中的 F-017

## 职责与边界

主要职责：注册 4 个 MCP 工具：start-task（behavior、params、replace）、list-tasks（当前任务与最近的已结束任务）、resume-task（id，默认当前暂停的任务，用于恢复被手动命令挂起的任务）、cancel-task（id，默认当前任务）。
不负责：不含任务逻辑；不校验行为参数的细节（由任务管理器按行为模式校验）。

## 输入

来源：LLM（经 MCP）。
内容与形式：start-task：行为名（6 种之一）、参数对象、是否替换（默认 true）。resume-task、cancel-task：可选任务 id。
关键限制：行为名用 zod 枚举限制；参数对象原样交给任务管理器。

## 输出

去向：LLM（工具返回文字）。
内容与形式：start-task：任务 id、行为、参数摘要，或错误（校验失败、已有任务、未知行为）。list-tasks：每个任务一行，含状态、暂停原因、当前步骤与进度。resume-task：已恢复的任务，或错误（没有暂停的任务、任务不是暂停状态）。cancel-task：被取消的任务，或“没有运行中的任务”。
成功含义：start-task 在 200 毫秒内返回，不等待任务结束。

## 与其他文件的关系

谁调用或使用本文件：src/main.ts（注册）；tests/task-tools.test.ts（验证）；scripts/test-live-world.mjs（实机覆盖）。
本文件调用或依赖谁：src/tool-factory.ts（现有，注册工具）；src/autopilot/task-manager.ts（经 src/autopilot/autopilot.ts 取得）。
外部依赖：zod。

关系尚未实现；不要把计划关系写成已经观察到的运行事实。

## 状态、副作用与约束

持有或改变的状态：无。
外部副作用：启动或取消任务。
关键约束：工具本身不申请身体控制权（任务由任务管理器申请）；bot 未就绪时返回明确错误。
失败处理：任务管理器返回的错误原样转为工具错误响应。

## 如何验收

正常场景：start-task follow → 返回 t1；list-tasks 显示 t1 running；手动命令后 list-tasks 显示 t1 paused（manual）；resume-task → t1 running；cancel-task → t1 cancelled。
边界或失败场景：未知行为名 → 校验错误列出 6 种行为；没有任务时 cancel-task → 说明没有运行中的任务；对运行中的任务调用 resume-task → 明确错误。
验证位置：tests/task-tools.test.ts；scripts/test-live-world.mjs
验证状态：未执行；本文件尚未实现。

## 替换为代码时

先读取并遵守项目的 README.md、docs/BLUEPRINT.md、docs/PLAN.md 及 AGENTS.md。只有获得对应里程碑的实现授权、并实际写入实现时，才删除这份占位说明。完整文件契约继续保留在蓝图中；设计变化必须同步记录。
