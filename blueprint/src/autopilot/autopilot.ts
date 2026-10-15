BLUEPRINT_PLACEHOLDER — NOT IMPLEMENTED — DO NOT RUN

# src/autopilot/autopilot.ts

本文件目前只有设计说明，不是可执行代码或有效运行配置。不要运行、导入、构建、格式化或把它当成已完成的测试。
它位于 blueprint/ 镜像目录；实现时在项目根目录的最终路径 src/autopilot/autopilot.ts 创建真实代码，并删除本占位文件。

所属模块：M-WIRE 组装
实现里程碑：M1（M3、M4 扩展）
实现状态：placeholder
设计状态：已确定：模块划分已获同意；回调名称暂定
设计版本：v0.3
契约位置：docs/BLUEPRINT.md 中的 F-001

## 职责与边界

主要职责：为当前 bot 创建并连接动作仲裁器、任务管理器、反射引擎、策略存储和决策钩子；bot 就绪时绑定，断线时解绑；bot 每次重新进入游戏（首次连接或断线后重连，例如重启游戏后）时把策略恢复为默认值；向工具层提供这些服务的访问入口。
不负责：不包含任何行为、反射或决策规则；不注册 MCP 工具（由 src/main.ts 注册）；不读取环境变量中的 API key（由 src/decisions/openrouter-client.ts 读取）。

## 输入

来源：src/main.ts（创建时传入）；src/bot-connection.ts 的新回调 onBotReady、onBotEnd、onDamage、onChatMessage、onWhisper（经 src/main.ts 转接）。
内容与形式：当前 bot 实例、现有 EventStore 与 WaypointStore、启动配置（决策模型 id）。聊天命令授权名单不属于启动配置，只能由 LLM 通过 set-policy 设置。
关键限制：同一时刻只绑定一个 bot；bot 未就绪时，工具层访问服务应得到“bot 未就绪”的明确错误，而不是空对象。

## 输出

去向：src/tools/task-tools.ts、src/tools/policy-tools.ts、src/tool-factory.ts、src/tools/follow-tools.ts、src/tools/gathering-tools.ts、src/tools/position-tools.ts（通过 src/main.ts 传入的访问函数取得服务）。
内容与形式：当前的仲裁器、任务管理器、策略存储、决策钩子实例，以及决策功能是否可用的状态。
成功含义：bot 就绪后反射开始每刻运行，策略为默认值并写入 policy 事件；断线后所有任务被取消、反射停止监听，事件流出现 task_cancelled（原因 disconnected）。

## 与其他文件的关系

谁调用或使用本文件：src/main.ts（导入并创建，并把服务访问函数传给工具）；src/tools/task-tools.ts、src/tools/policy-tools.ts、src/tool-factory.ts、src/tools/follow-tools.ts、src/tools/gathering-tools.ts、src/tools/position-tools.ts（经访问函数取得服务）；tests/autopilot.test.ts（验证绑定与解绑）。
本文件调用或依赖谁：src/autopilot/action-arbiter.ts、src/autopilot/task-manager.ts、src/autopilot/reflex-engine.ts、src/autopilot/policy.ts、src/decisions/decision-hooks.ts、src/decisions/openrouter-client.ts（导入并创建）；src/event-store.ts、src/waypoint-store.ts（现有，读写事件、读取路标）。
外部依赖：mineflayer：订阅 physicsTick（转交反射引擎）。

关系尚未实现；不要把计划关系写成已经观察到的运行事实。

## 状态、副作用与约束

持有或改变的状态：当前绑定的 bot 与各模块实例（内存）。
外部副作用：解绑时停止 bot 的移动；无持久副作用。
关键约束：绑定与解绑都必须幂等：重复的就绪回调不能创建第二套 physicsTick 监听；解绑后旧 bot 上不能残留监听器。
失败处理：某个可选模块初始化失败（例如没有 API key）时，把该功能标为不可用并继续，其余功能照常工作；必需模块初始化失败时，向工具层报告具体原因。

## 如何验收

正常场景：模拟 bot 就绪 → 反射引擎开始收到每刻通知；模拟断线 → 运行中的任务被取消并写入 task_cancelled（原因 disconnected），反射停止；修改策略后模拟断线再重连 → 策略恢复默认（含启动参数）并写入 policy 事件。
边界或失败场景：连续两次就绪回调只产生一套监听；没有 OPENROUTER_API_KEY 时决策功能报告 disabled，任务与反射仍可用；未就绪时取服务得到明确错误。
验证位置：tests/autopilot.test.ts
验证状态：未执行；本文件尚未实现。

## 替换为代码时

先读取并遵守项目的 README.md、docs/BLUEPRINT.md、docs/PLAN.md 及 AGENTS.md。只有获得对应里程碑的实现授权、并实际写入实现时，才删除这份占位说明。完整文件契约继续保留在蓝图中；设计变化必须同步记录。
