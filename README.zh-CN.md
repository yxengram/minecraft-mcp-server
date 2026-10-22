# Minecraft MCP 服务器（带 Autopilot）

[English](README.md) | **简体中文**

这是一个由大语言模型（例如 Claude）通过 [Model Context Protocol](https://modelcontextprotocol.io)（MCP）操控的 Minecraft 机器人。机器人基于 [Mineflayer](https://github.com/PrismarineJS/mineflayer)，LLM 通过 64 个 MCP 工具观察世界并在其中行动。

这个分支的特点是 **Autopilot**：用后台任务处理长时间的工作，再加上一个约一秒内对危险作出反应的**本能**。本能由一个快速的*决策模型*和执行所选动作的代码配合完成。没有它，LLM 就得自己及时注意到每一只苦力怕。

> [!IMPORTANT]
> 已在 **Minecraft Java 版 26.1.2**（协议 775）和 Mineflayer 4.39 及以上版本验证。其他版本可能无法使用。

---

## 项目来源

本项目分叉自 **[yuniko-software/minecraft-mcp-server](https://github.com/yuniko-software/minecraft-mcp-server)**（Apache 2.0，© Yuniko Software）。

| 部分 | 来源 |
|---|---|
| MCP 服务器、机器人连接和最初的 **23 个工具**（移动、背包、方块、合成、熔炉、聊天、飞行、游戏模式） | 上游 `main` 的 `240c8ce`（2.0.4 版） |
| 对 **Minecraft Java 26.1.2** 的支持 | 上游 [pull request #274](https://github.com/yuniko-software/minecraft-mcp-server/pull/274)（`a9c9111`，作者 lifat），已合入本分支 |
| 本文介绍的其余全部内容：新增的 40 个工具、感知、Autopilot、测试和设计文档 | 本分支（[yxengram/minecraft-mcp-server](https://github.com/yxengram/minecraft-mcp-server)，分支 `extra-tools`） |

上游项目是一座简洁好用的桥：LLM 调用一个工具，机器人做一件事。本分支保留了这座桥和上游的全部工具，名称和参数都不变；补上的是 LLM 真正尝试在游戏里生存时发现缺少的东西。

## 做了哪些改变

### 1. 更多工具，像玩家一样看世界（23 → 64 个工具）
- **移动：**跟随或逃离某个实体、停止、保存路点。
- **建造与采集：**采集指定数量的方块、清空或填充一个区域、挖隧道、查看和使用容器。
- **交互：**右键方块和实体、与村民交易、睡觉和起床、骑乘和下来、攻击。
- **感知：**
  - `get-observation`：一次调用得到生命、效果、护甲、时间、天气、装备、背包和附近实体的快照。
  - `get-events` 和 `wait-for-event`：玩家会注意到的一切（受到的伤害及来源、敌对生物的声音、爆炸、聊天、死亡、拾取）。LLM 可以等待某件事发生，而不必轮询。
  - `scan-area`：用文字描述地形。
  - `render-map`：俯视图或剖面图，以图片返回。
  - `get-cursor-target`：准星下是什么。

### 2. Autopilot
- **后台任务：**`follow`、`flee`、`guard`、`gather`、`hunt`、`return-home`。工具调用立即返回，进展以事件报告。
- **一个身体，一个驾驶者：**动作仲裁器保证同一时间只有一方控制机器人的身体。LLM 的命令立即执行，回复会说明它打断了什么。
- **本能：**代码感知危险并算出机器人现在能做什么；[OpenRouter](https://openrouter.ai) 上的决策模型从中选择；代码执行。见[设计理念](#设计理念)。
- **策略：**LLM 用 `get-policy` 和 `set-policy` 调整本能、战斗规则、聊天处理和决策模型。它还可以说明自己在做什么（`instinct.intent`），这样本能就不会把它从有意为之的事情里“救”出来。
- **聊天分拣：**决策模型对聊天分类，只有发给机器人的消息才会以 `chat_request` 事件唤醒 LLM。除非 LLM 允许，任何人都不能通过聊天指挥机器人。

### 3. 在游戏里实测，而不只是纸面
- 820 个单元测试。
- 实机测试：在真实服务器上逐一运行全部 64 个工具。
- 情景测试：比较有无 Autopilot 时机器人的表现，包括僵尸潮、空手被僵尸追赶、苦力怕、饥饿、着火、溺水、有意潜水和聊天。
- 普通难度下的 10 天生存测试：机器人度过了全部十个夜晚，没有死亡，并建起一座 7×7 的房子，带门、八扇玻璃窗、床、箱子、工作台、熔炉和火把。
- 困难难度下的 5 天生存测试，从空背包开始：机器人度过了全部五个夜晚，没有死亡；夜里睡在挖出的封闭坑里的床上，最后穿着铁甲，还剩 14 份熟食。

玩的过程中发现的问题都已修复并重新测试，例如：
- 机器人在顶棚下溺水；
- 任务把机器人重新带回危险中；
- 寻路器挖穿机器人自己砌的墙；
- 机器人站在目标格里导致放置方块失败；
- 熔炉里的产物没有取完。

## 设计理念

### 问题：LLM 太慢，跟不上实时
LLM 每一轮“观察、思考、调用工具”都要几秒，而 Minecraft 每秒 20 个 tick，点燃的苦力怕 1.5 秒就会爆炸。为每种情况手写规则也行不通。本分支最初的版本用的是代码反射，这也是这类机器人常见的做法。生存测试中的一次溺水暴露了它的局限：反射只会往上游，而机器人头顶是一层石头。靠加规则来修，会写出没完没了的代码：等机器人想有意潜到海底神殿时，又得加下一条规则。到那时，玩游戏的到底是 LLM，还是代码？

### 答案：三种角色，像大脑一样分工

| 角色 | 由谁担任 | 速度 | 负责什么 | 从不做什么 |
|---|---|---|---|---|
| **大脑皮层** | LLM | 数秒 | 定目标、启动任务、规划、交谈、调整策略、说明意图 | 每个 tick 都去操控 |
| **本能** | 决策模型（默认 `perplexity/pplx-decider-v1.2-20261016`） | 约 0.65 秒 | 从菜单中选一个选项并给出概率，判断是否紧急、当前任务能否继续 | 写文字或自创选项 |
| **小脑** | 代码 | 每个 tick | 感知危险；算出此刻哪些选项可行（够得着的气穴、能挖开的顶棚、能灭火的水）；执行选中的动作：游泳、挖掘、冲刺逃离、战斗、进食 | 自行决定改做别的事（“如果 X 就做 Y”） |

决策模型是一类不生成文字的模型：给定状态和问题，它对一组固定选项返回校准过的概率。因此它又快又便宜（每次约 0.00002 美元），正适合回答“现在该做这五件事中的哪一件？”。

### 代码遵守的原则
1. **代码从不把事件映射成行为。**它可以感知、列出可行的选项、唤醒决策模型、执行选择。宏动作要么完成，要么失败并报告，绝不悄悄改做别的。
2. **没有决定，就没有动作。**没有 key、超时或出错时，机器人不会自行应对危险。每个危险只以 `instinct offline` 事件报告一次，由 LLM 决定。
3. **LLM 的命令优先。**只有决策模型标为*紧急*的选择才可以打断它们，被打断的命令的回复里会说明这一点。
4. **安全由代码守住，模型无法触及。**
   - 本能从不攻击玩家，即使开启了 `combat.attackPlayers` 也不会；也从不攻击驯服的动物，默认也不攻击中立生物。
   - 聊天永远不能修改策略。
   - 同一时间只有一方驾驶身体。
   - API key 绝不出现在日志、事件或工具输出中。
5. **事实交给模型，选择由模型做。**
   - 模型看到代码掌握的事实：之前的危险、被问过几次、LLM 的意图。
   - 正因如此，它学会了在任务一再把机器人带回同一片水里时停止那个任务。
6. **阈值来自测量。**
   - 默认值是在固定的模型上实测概率和延迟后定的：概率不低于 0.3 才行动，不低于 0.6 才算紧急。
   - 换模型时必须重新测量。
7. **一切都可见。**每个决定、它的概率和结果都是 LLM 可以读取的事件。

### 已知局限
- 4 格外**已经点燃**的苦力怕只留下约 0.7 秒，而决策 API 有时要 1.0–1.3 秒才回答。这种情况是压力测试，不作保证。走近的苦力怕在 10 格外就会被询问，能够应对。
- 在墙内低血量被困时，唯一剩下的选项是逃跑。
- 寻路器把木门视为可通行，并由开门助手负责开关；铁门没有处理。
- 寻路器不在建筑方块（栅栏、墙、门、木板等，或屋顶下）旁边放脚手架，也不挖建筑方块脚下的方块。所以在建筑附近，以前靠搭柱子能走的路，现在可能找不到。

完整的设计、每个文件的契约以及每个选择背后的证据见 [docs/BLUEPRINT.md](docs/BLUEPRINT.md) 和 [docs/PLAN.md](docs/PLAN.md)。

---

## 快速开始

### 环境要求
- Node.js 22 或以上，以及 Git
- Minecraft Java 版 26.1.2
- 一个 MCP 客户端，例如 [Claude Desktop](https://claude.ai/download)
- 可选：用于本能和聊天分拣的 [OpenRouter](https://openrouter.ai) API key

### 1. 构建服务器
```bash
git clone https://github.com/yxengram/minecraft-mcp-server.git
cd minecraft-mcp-server
npm install
npm run build
```

### 2. 对局域网开放世界
进入一个世界，选择 `ESC → 对局域网开放`，记下 Minecraft 在聊天栏显示的端口。如果要运行实机测试，请开启作弊。

### 3. 在 MCP 客户端中添加服务器
在 Claude Desktop 中进入 `Settings → Developer → Edit Config`，在 `claude_desktop_config.json` 中添加：

```json
{
  "mcpServers": {
    "minecraft": {
      "command": "node",
      "args": [
        "/path/to/minecraft-mcp-server/dist/main.js",
        "--host", "localhost",
        "--port", "25565",
        "--username", "ClaudeBot"
      ],
      "env": { "OPENROUTER_API_KEY": "sk-or-..." }
    }
  }
}
```

去掉 `env` 即可在没有决策模型的情况下运行：其他功能都正常，只是本能处于离线状态。

完全重启客户端。客户端启动服务器后，机器人会加入世界。

| 选项 | 默认值 | 含义 |
|---|---|---|
| `--host` | `localhost` | Minecraft 服务器地址 |
| `--port` | `25565` | Minecraft 服务器端口（即局域网端口） |
| `--username` | `LLMBot` | 机器人的名字 |
| `--waypoint-file` | `~/.minecraft-mcp-server/waypoints.json` | 路点的保存位置（按服务器地址分开） |
| `--decision-model` | `perplexity/pplx-decider-v1.2-20261016` | OpenRouter 上的决策模型 |

API key 只从环境变量 `OPENROUTER_API_KEY` 读取，不要把它写进仓库里的任何文件。

### 4. 开始玩
让 LLM 在 Minecraft 里做事。几个习惯能让它玩得好得多：
- 长时间的工作用 `start-task`，然后用 `wait-for-event` 等待（例如 `task_done`、`task_failed`、`instinct`、`chat_request`），不要轮询。
- 快速查看用 `get-observation`，了解地形用 `scan-area` 或 `render-map`。
- 有意做危险的事之前先设置意图，例如 `set-policy { "instinct": { "intent": "exploring an underwater cave on purpose" } }`。

---

## 工具（64 个）

### 移动
- `get-position`：机器人的位置
- `move-to-position`：走到指定坐标；寻路器中途停下时报错；报告途中挖掉和放下的方块；停在下界传送门里时报告是否到了另一个维度；机器人四面都被围住时（例如本能 dig_in 之后）拒绝移动，除非传入 `leaveShelter: true`，因为寻路器会挖开掩体
- `move-in-direction`：朝某个方向走一段时间
- `look-at`：看向指定坐标
- `jump`：跳
- `stop-pathfinding`：停止移动，并取消当前任务
- `follow-entity`：持续跟随玩家或生物（以任务运行）
- `flee-from`：逃离某个实体到安全距离（以任务运行）
- `fly-to`：飞到指定坐标（创造模式）

### 路点
- `set-waypoint`：保存一个命名地点
- `list-waypoints`：列出路点及距离
- `delete-waypoint`：删除一个路点
- `goto-waypoint`：走到某个路点（路点在下界传送门里时走进门里）；报告与被围住时的规则同 move-to-position

### 背包与合成
- `list-inventory`：物品，含名称、耐久和附魔
- `find-item`：查找物品
- `equip-item`：手持或穿戴物品
- `unequip-item`：卸下物品
- `consume`：吃或喝
- `toss-item`：丢出物品
- `list-recipes`：某个物品的配方
- `get-recipe`：某个配方的详情
- `can-craft`：现在能否合成某个物品
- `craft-item`：把某个物品合成若干次（大于 2×2 的配方需要 16 格内放好的工作台）
- `smelt-item`：在熔炉、高炉或烟熏炉中熔炼一整批

### 方块
- `get-block-info`：方块状态、亮度、生物群系和告示牌文字
- `get-cursor-target`：准星下的方块面或实体
- `find-blocks`：附近某种方块
- `place-block`：放置方块；会走到能看到可点击的面的位置，绝不走进目标格
- `dig-block`：用背包里最合适的工具挖方块；没有能让它掉落的工具时拒绝
- `collect-block`：采集并拾取一定数量的同种方块（以 `gather` 任务运行；跳过挨着岩浆或水的方块）
- `clear-region`：挖空一个长方体（最多 512 格）
- `fill-region`：填满长方体中的空格（最多 512 格）
- `dig-tunnel`：挖一条直隧道
- `activate-block`：右键方块（门、按钮、拉杆）；没有变化时会说明
- `use-item`：使用手里的物品：装满或倒空桶、扔末影珍珠；报告发生了什么变化（不在 bot 身边或其他玩家附近倒岩浆）

### 容器
- `read-container`：查看箱子、木桶、潜影盒、漏斗、发射器或投掷器的内容
- `container-deposit`：放入物品
- `container-withdraw`：取出物品

### 实体
- `find-entity`：最近的某类实体
- `list-entities`：附近的实体，附带掉落物、主人、羊的颜色、手持物品、即将爆炸的苦力怕等细节
- `list-players`：在线玩家
- `attack-entity`：攻击够得着的实体
- `activate-entity`：右键实体
- `list-trades`：村民提供的交易、剩余次数，以及每项能负担几次
- `trade`：按 list-trades 列出的编号与村民交易
- `mount-entity`：骑马、乘船或矿车
- `dismount`：下来
- `sleep`：在床上睡觉（主世界以外会爆炸，所以拒绝）
- `wake`：起床

### 感知
- `get-observation`：机器人及周围环境的一次性快照
- `get-events`：最近的游戏事件
- `wait-for-event`：等待（最多 55 秒）某个事件、敌对生物靠近或生命下降
- `scan-area`：用文字描述地形：高度、坡度、地表、水和岩浆、值得注意的方块、实体
- `render-map`：PNG 地图，俯视或剖面（需要支持图片的客户端和模型）
- `detect-gamemode`：游戏模式

### 聊天
- `send-chat`：说话或执行命令
- `read-chat`：最近的聊天和系统消息

### Autopilot
- `start-task`：启动后台任务
- `list-tasks`：当前任务和最近结束的任务
- `resume-task`：恢复一个为你保留的任务
- `cancel-task`：取消当前任务
- `get-policy`：显示策略以及本能是否在线
- `set-policy`：修改部分策略
- `list-decision-models`：OpenRouter 提供的决策模型

## Autopilot 参考

### 任务
- `start-task` 接受下列行为之一，并立即返回：
  - `follow` `{ target | entityId, range? }`
  - `flee` `{ target | entityId, distance? }`
  - `guard` `{ target | waypoint | x,y,z, radius? }`
  - `gather` `{ blockType, count? }`
  - `hunt` `{ animal, count? }`
  - `return-home` `{ waypoint?, sleep? }`
- `guard` 只与敌对生物战斗。bot 没穿金盔甲时，猪灵算敌对；僵尸猪灵和末影人算中立。
- `hunt` 从不攻击玩家或驯服的动物。
- 新任务会替换当前任务，除非 `replace` 为 `false`。
- 任何让机器人移动的命令都会暂停当前任务，回复里会说明。之后用 `resume-task` 或 `cancel-task`。
- 事件：`task_started`、`task_progress`、`task_paused`、`task_resumed`、`task_done`、`task_failed`、`task_cancelled`。

### 本能
**它会注意到（线索）：**
- 站在岩浆里，或身上着火；
- 在水下且头顶有遮挡，或氧气不足；
- 10 格内有苦力怕，或 7 格内有正在膨胀的苦力怕；
- 被攻击；
- 低血量且附近有敌对生物；
- 饥饿且有安全的食物；
- 逃开的怪又追回来。

**它可以选择：**向上游、游到气穴、向上挖、离开岩浆、走进水里、离开火、躲开苦力怕、逃跑、战斗、原地坚守、躲进地下（向下挖 3 格并封住头顶；只在地形安全、而且怪赶不到之前就能封好时提供）、进食、继续当前的事、暂停任务，或交给 LLM。

**它何时询问：**线索出现时询问，线索持续期间每 1.5 秒再问一次（饥饿每 20 秒），每个动作结束后也会问。更紧急的新危险不会排在旧问题后面。每个决定及其结果都是一个 `instinct` 事件。

### 策略（默认值）

| 组 | 字段 |
|---|---|
| `instinct` | `enabled: true`、`intent: ""`（最多 300 字符，只能由 LLM 设置）、`lowAir: 6`、`lowHealth: 6`、`hostileRadius: 16`、`food: 14`、`reaskMs: 1500`、`actThreshold: 0.3`、`urgentThreshold: 0.6`、`maxCallsPerMinute: 90` |
| `combat` | `attackPlayers: false`（每次开启都会发出警告事件）、`avoidNeutral: true`、`retreatHealth: 6` |
| `chat` | `triage: true`、`commandsFrom: []`（这些玩家的明确命令，如“follow me”，无需 LLM 即可执行；只能由 LLM 设置）、`replyInChat: true` |
| `decisions` | `enabled: true`、`model`、`actThreshold: 0.95`、`cautiousThreshold: 0.5`（聊天）、`maxCallsPerMinute: 30`（聊天） |

策略只保存在内存中，机器人每次加入游戏都会恢复为这些默认值。

### 隐私与费用
**发送什么：**有 key 时，其他玩家的聊天消息和机器人处境的摘要会发送给 OpenRouter 和模型提供方。摘要包括生命、饥饿、氧气、危险、可选项、当前任务和 LLM 的意图。没有 key 时什么都不发送。

**费用：**每次调用约 0.00002 美元。本能每分钟最多 90 次，聊天最多 30 次，而且只在危险持续期间询问。

---

## 测试

```bash
npm test             # 820 个单元测试
npm run lint
npm run test:live -- <局域网端口>                                 # 对世界做只读检查
npm run test:live:world -- <局域网端口> --allow-world-changes      # 在开启作弊的一次性世界中运行每个工具
npm run test:scenarios -- <局域网端口> --allow-world-changes       # Autopilot 在危险情景中的表现
```

**请使用一次性世界**运行 `test:live:world` 和 `test:scenarios`。它们会在 y=240 搭建场地、给予物品、召唤生物，还可能让机器人死亡。

**情景测试的方式：**
- 每个情景在三种配置下运行：`llm-only`（关闭本能）、`no-key`（本能离线）和 `instinct`（有 key）。
- 只要某个必需情景在 `instinct` 配置下失败，测试就失败。
- `creeper-ambush` 会报告结果但不要求通过，因为决策 API 的延迟不总能赶在引信之前。
- 在命令前加 `OPENROUTER_API_KEY="..."` 传入 key。

## 项目文档
- [docs/BLUEPRINT.md](docs/BLUEPRINT.md)：设计、每个文件的契约、跨模块约定和安全不变量
- [docs/PLAN.md](docs/PLAN.md)：里程碑 M1–M11、未决问题，以及每一次实际运行过的检查的记录
- [AGENTS.md](AGENTS.md)：在本仓库工作的编码代理须遵守的规则
- [CONTRIBUTING.md](CONTRIBUTING.md)：如何贡献（来自上游，英文）

## 许可与致谢
Apache License 2.0，见 [LICENSE](LICENSE)。保留上游版权（© 2025 Yuniko Software）。

**感谢：**
- [yuniko-software/minecraft-mcp-server](https://github.com/yuniko-software/minecraft-mcp-server)，本分支所依托的项目；以及 lifat 在 pull request #274 中对 Minecraft 26.1.2 的支持；
- [PrismarineJS](https://github.com/PrismarineJS) 的 Mineflayer 和 mineflayer-pathfinder；
- [OpenRouter](https://openrouter.ai) 的 Decisions API。
