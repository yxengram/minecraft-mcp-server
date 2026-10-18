# 代理协作规则

本仓库的 MCP 服务器（`src/`、`tests/`、`scripts/`）已经实现并通过测试，包括 **Autopilot 子系统**（M1～M9 完成并通过实机验收；M8 起本能由决策模型承担，代码只做“小脑”，见 `docs/BLUEPRINT.md` I 节）。设计阶段用过的 `blueprint/` 占位目录已在 M6 删除；完整契约保留在 `docs/BLUEPRINT.md`。

## 阅读顺序

1. `README.md`：项目入口与现有工具。
2. `docs/BLUEPRINT.md`：Autopilot 的总体设计、模块、逐文件契约（F-xxx）、对现有文件的计划改动（E-xxx）和跨模块约定（G 节，尤其是 G6 安全不变量）。
3. `docs/PLAN.md`：里程碑、当前状态、未决问题与进展记录。
4. 要修改的文件对应的蓝图条目（F 节为新增文件的契约，F2 节为对现有文件的改动）。

规划新的工作（例如蓝图 H 节的远期设想）时，先在 `docs/BLUEPRINT.md` 写出契约，在 `docs/PLAN.md` 写出里程碑，再实现。

## 修改边界

- 没有收到明确的实现指令时，只规划和维护文档，不写实现代码。
- 收到实现指令时，一次只实现一个已授权的里程碑；不顺便重构无关部分。
- 新增文件直接在最终路径创建；完整契约写在 `docs/BLUEPRINT.md`。
- 修改现有文件时，遵守蓝图 F2 节的“计划改动”与“不变的部分”，保持现有测试通过。
- 新增依赖、新的外部副作用（联网、费用、写磁盘）或架构变化必须先说明；改变产品范围、安全不变量或公开工具接口前先取得授权。
- 不能擅自覆盖用户改动或执行破坏性操作；实机测试只在开启作弊的测试世界中运行，并且需要 `--allow-world-changes`。

## 执行范围

- ava 只运行 `tests/**/*.test.ts`（见 `package.json`）；`tsconfig.json` 与 eslint 只读取 `src/`、`tests/`。实机脚本（`scripts/`）需要开启作弊的测试世界，只在开发者显式运行时修改世界。
- 源文件存在不等于功能存在。

## 测试与证据

- 测试的预期结果来自蓝图中的契约、安全不变量和失败场景，而不是实现的实际输出。
- 区分“计划的验收”和“实际执行的检查”。只有真正运行过的检查才能记入 `docs/PLAN.md` 的进展，并写明结果。
- 文件状态按 `placeholder` → `implemented-unverified` → `verified` 更新；只有对应验证实际完成后才标为 verified。

## 文档同步

- 增删文件、改变边界或接口时，同步更新 `docs/BLUEPRINT.md` 的目录树与契约，以及 `docs/PLAN.md`。
- 重要设计变更在 PLAN 的「进展与变更」中记录旧方案、新方案、原因和影响。

## 恢复

- 每个里程碑以独立提交完成，回退提交即可恢复代码。Autopilot 不保存持久数据；策略与任务只在内存中。
- 运行时的应急手段：`set-policy` 关闭本能（`instinct.enabled`）或决策；`stop-pathfinding` 取消当前任务。M9 起没有代码反射：关闭本能或没有 key 时，bot 不会自己躲避或进食。

## 机密

- OpenRouter API key 只经环境变量 `OPENROUTER_API_KEY` 交给服务器，绝不写入仓库中的文件、日志、事件、测试或提交。本地实机测试时，key 存在仓库外、权限 600 的 `~/.minecraft-mcp-server/openrouter-key`（用户自己创建），命令里用 `OPENROUTER_API_KEY="$(cat ~/.minecraft-mcp-server/openrouter-key)"` 传入；代理不读取、不打印其内容（PLAN Q9）。
