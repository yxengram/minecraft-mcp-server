# blueprint/：Autopilot 说明性骨架（镜像目录）

> 这里的文件都是**设计说明，不是代码**。每个文件第一行都是 `BLUEPRINT_PLACEHOLDER — NOT IMPLEMENTED — DO NOT RUN`。不要运行、导入、构建或测试它们。

## 为什么放在这里

现有项目可以正常构建和测试。如果把占位文件直接放到最终路径（`src/…`、`tests/…`），TypeScript 编译、eslint 和 ava 会立即读取它们并失败。所以骨架按**最终相对路径**镜像存放在本目录下：

| 本目录中的路径 | 实现后的最终路径 |
|---|---|
| `blueprint/src/autopilot/task-manager.ts` | `src/autopilot/task-manager.ts` |
| `blueprint/tests/task-manager.test.ts` | `tests/task-manager.test.ts` |
| `blueprint/scripts/test-scenarios.mjs` | `scripts/test-scenarios.mjs` |

## 怎么读

1. 先读 [docs/BLUEPRINT.md](../docs/BLUEPRINT.md) 了解总体设计与模块。
2. 每个占位文件开头写着它的契约条目 ID（F-001 等），可在蓝图中找到同一份说明。
3. 实施顺序见 [docs/PLAN.md](../docs/PLAN.md)。

## 什么时候删除

实现某个文件时，在最终路径创建真实代码，同时删除本目录中对应的占位文件。M6 完成后本目录应为空，并整体删除。

## 保护措施

`package.json` 中 ava 的 `files` 只包含 `tests/**/*.test.ts`；`tsconfig.json` 与 eslint 只读取 `src/`、`tests/`。因此本目录不会被测试、编译或检查。
