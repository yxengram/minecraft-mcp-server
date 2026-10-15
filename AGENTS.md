# 代理协作规则

本仓库的 MCP 服务器（`src/`、`tests/`、`scripts/` 中的现有文件）已经实现并通过测试。新增的 **Autopilot 子系统**目前只有设计：说明性占位文件放在 `blueprint/` 镜像目录中。

## 阅读顺序

1. `README.md`：项目入口与现有工具。
2. `docs/BLUEPRINT.md`：Autopilot 的总体设计、模块、逐文件契约（F-xxx）、对现有文件的计划改动（E-xxx）和跨模块约定（G 节，尤其是 G6 安全不变量）。
3. `docs/PLAN.md`：里程碑、当前状态、未决问题与进展记录。
4. 要修改的文件对应的蓝图条目；新增文件还要读 `blueprint/` 中对应的占位说明。

首次接手时，先辨认哪些文件仍是占位：`blueprint/` 下所有文件的第一行都是 `BLUEPRINT_PLACEHOLDER — NOT IMPLEMENTED — DO NOT RUN`。

## 修改边界

- 没有收到明确的实现指令时，只规划和维护文档与说明性骨架，不写实现代码。
- 收到实现指令时，一次只实现一个已授权的里程碑；不顺便重构无关部分。
- 实现新增文件时，在**项目根目录的最终路径**（例如 `src/autopilot/task-manager.ts`）创建代码，并删除 `blueprint/` 中对应的占位文件。完整契约继续保留在 `docs/BLUEPRINT.md`。
- 修改现有文件时，遵守蓝图 F2 节的“计划改动”与“不变的部分”，保持现有测试通过。
- 新增依赖、新的外部副作用（联网、费用、写磁盘）或架构变化必须先说明；改变产品范围、安全不变量或公开工具接口前先取得授权。
- 不能擅自覆盖用户改动或执行破坏性操作；实机测试只在开启作弊的测试世界中运行，并且需要 `--allow-world-changes`。

## 执行范围

- 占位文件不能进入程序执行、测试发现或构建。当前的保护措施：ava 只运行 `tests/**/*.test.ts`（见 `package.json`）；`tsconfig.json` 与 eslint 只读取 `src/`、`tests/`。不要把 `blueprint/` 加入这些范围，也不要为了消除错误把占位改成空 stub。
- 源文件存在不等于功能存在。

## 测试与证据

- 测试的预期结果来自蓝图中的契约、安全不变量和失败场景，而不是实现的实际输出。
- 区分“计划的验收”和“实际执行的检查”。只有真正运行过的检查才能记入 `docs/PLAN.md` 的进展，并写明结果。
- 文件状态按 `placeholder` → `implemented-unverified` → `verified` 更新；只有对应验证实际完成后才标为 verified。

## 文档同步

- 增删文件、改变边界或接口时，同步更新 `docs/BLUEPRINT.md` 的目录树与契约、剩余的占位副本，以及 `docs/PLAN.md`。
- 重要设计变更在 PLAN 的「进展与变更」中记录旧方案、新方案、原因和影响。

## 恢复

- 每个里程碑以独立提交完成，回退提交即可恢复代码。Autopilot 不保存持久数据；策略与任务只在内存中。
- 运行时的应急手段：`set-policy` 关闭反射或决策；`stop-pathfinding` 取消当前任务。

## 机密

- OpenRouter API key 只放在环境变量 `OPENROUTER_API_KEY` 中，绝不写入文件、日志、事件、测试或提交。
