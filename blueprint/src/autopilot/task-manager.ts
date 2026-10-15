BLUEPRINT_PLACEHOLDER — NOT IMPLEMENTED — DO NOT RUN

# src/autopilot/task-manager.ts

本文件目前只有设计说明，不是可执行代码或有效运行配置。不要运行、导入、构建、格式化或把它当成已完成的测试。
它位于 blueprint/ 镜像目录；实现时在项目根目录的最终路径 src/autopilot/task-manager.ts 创建真实代码，并删除本占位文件。

所属模块：M-TASK 任务与行为
实现里程碑：M1
实现状态：placeholder
设计状态：已确定：生命周期与事件；进度节流间隔与历史条数暂定
设计版本：v0.3
契约位置：docs/BLUEPRINT.md 中的 F-003

## 职责与边界

主要职责：管理后台任务的生命周期：查找已注册行为、校验参数、启动、记录进度与当前步骤、响应仲裁器的暂停与恢复、恢复被手动命令挂起的任务、取消和结束；提供当前任务的快照，供手动命令报告中断前的状态；为每次状态变化写事件；保存当前任务与最近 20 个已结束任务。同时定义行为必须遵守的契约：参数模式、运行上下文、进度与当前步骤的报告方式、取消信号与暂停等待。
不负责：不实现具体行为（在 src/autopilot/behaviors/）；不决定何时启动任务（由 LLM 或决策钩子决定）；不做威胁检测。

## 输入

来源：src/tools/task-tools.ts（启动、恢复、取消、查询）；src/decisions/decision-hooks.ts、src/tools/follow-tools.ts、src/tools/gathering-tools.ts、src/tools/position-tools.ts（启动、取消）；src/tool-factory.ts（读取快照）；src/autopilot/action-arbiter.ts（暂停与恢复回调，附抢占者类型）。
内容与形式：行为名、行为参数对象、是否替换当前任务（默认替换）、来源标记（llm / chat / tool）。
关键限制：同一时刻至多一个活动任务；参数必须通过该行为自己的 zod 模式；行为名必须已注册。

## 输出

去向：调用者（任务 id 与状态，或一个在任务结束时完成的等待对象）；src/event-store.ts（事件）；src/tools/task-tools.ts（任务列表）。
内容与形式：任务记录：id（t1、t2…）、行为、参数摘要、状态（running / paused / done / failed / cancelled）、暂停原因（reflex <名称> 或 manual <工具名>）、进度文字、当前步骤（例如“chasing zombie id 812”）、开始与结束时间、结果或失败原因、来源。快照：当前任务的上述信息与已运行时长。事件：task_started、task_progress（同一任务至少间隔 2 秒）、task_paused、task_resumed、task_done、task_failed、task_cancelled。
成功含义：每次状态变化都有且仅有一条对应事件；取消后 1 秒内 bot 停止该任务的动作。

## 与其他文件的关系

谁调用或使用本文件：src/tools/task-tools.ts、src/decisions/decision-hooks.ts、src/tools/follow-tools.ts、src/tools/gathering-tools.ts、src/tools/position-tools.ts（调用）；src/tool-factory.ts（读取快照）；src/autopilot/autopilot.ts（创建）；src/autopilot/behaviors/*.ts（导入行为契约）；tests/task-manager.test.ts（验证）；tests/movement-behaviors.test.ts、tests/decision-hooks.test.ts（作为被测模块的依赖）。
本文件调用或依赖谁：src/autopilot/action-arbiter.ts（申请任务级租约）；src/autopilot/behaviors/follow.ts、flee.ts、guard.ts、gather.ts、hunt.ts、return-home.ts（导入注册表）；src/event-store.ts（现有，写事件）；src/tools/movement-utils.ts（现有，取消时 stopPathfinder）。
外部依赖：无。

关系尚未实现；不要把计划关系写成已经观察到的运行事实。

## 状态、副作用与约束

持有或改变的状态：当前任务、历史记录、每个任务的取消控制器（内存）。
外部副作用：通过行为驱动 bot 的动作；取消时停止寻路。
关键约束：替换当前任务时，先完成旧任务的取消（写 task_cancelled，原因 replaced），再启动新任务；任务被暂停期间行为不能发出动作；被反射暂停的任务在反射结束后自动恢复，被手动命令暂停的任务保持 paused，直到 resume-task 或 cancel-task；恢复时重新申请任务级租约；进度事件节流；任务结束后必须释放租约。
失败处理：行为抛错 → task_failed，附错误信息；参数无效 → 不创建任务，返回全部校验错误；行为名未知 → 返回可用行为列表。

## 如何验收

正常场景：启动 follow → task_started；取消 → task_cancelled，bot 停止；行为正常结束 → task_done 附结果。
边界或失败场景：replace=false 时启动第二个任务 → 返回“已有任务运行”错误；行为抛错 → task_failed；被反射暂停 → task_paused 后自动 task_resumed；被手动命令暂停 → task_paused（原因 manual）且不自动恢复，resume 后 task_resumed；对非 paused 任务调用 resume → 明确错误；快照包含当前步骤；1 秒内多次进度只产生一条 task_progress。
验证位置：tests/task-manager.test.ts
验证状态：未执行；本文件尚未实现。

## 替换为代码时

先读取并遵守项目的 README.md、docs/BLUEPRINT.md、docs/PLAN.md 及 AGENTS.md。只有获得对应里程碑的实现授权、并实际写入实现时，才删除这份占位说明。完整文件契约继续保留在蓝图中；设计变化必须同步记录。
