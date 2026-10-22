# Minecraft MCP Server — with Autopilot

**English** | [简体中文](README.zh-CN.md)

A Minecraft bot that a large language model (for example Claude) plays through the [Model Context Protocol](https://modelcontextprotocol.io) (MCP). The bot runs on [Mineflayer](https://github.com/PrismarineJS/mineflayer). The LLM sees the world and acts in it through 64 MCP tools.

What sets this fork apart is the **Autopilot**: background tasks for long jobs, and an **instinct** that reacts to danger within about a second. The instinct pairs a fast *decision model* with code that carries out the chosen move. Without it, the LLM would have to notice every creeper in time by itself.

> [!IMPORTANT]
> Verified with **Minecraft Java Edition 26.1.2** (protocol 775) and Mineflayer 4.39 or later. Other versions may not work.

---

## Where this project comes from

This is a fork of **[yuniko-software/minecraft-mcp-server](https://github.com/yuniko-software/minecraft-mcp-server)** (Apache 2.0, © Yuniko Software).

| Part | Source |
|---|---|
| The MCP server, the bot connection and the first **23 tools** (movement, inventory, blocks, crafting, a furnace, chat, flight, game mode) | Upstream `main` at `240c8ce` (version 2.0.4) |
| Support for **Minecraft Java 26.1.2** | Upstream [pull request #274](https://github.com/yuniko-software/minecraft-mcp-server/pull/274) (`a9c9111`, by lifat), merged into this fork |
| Everything else in this README: 40 more tools, perception, the Autopilot, the tests and the design documents | This fork ([yxengram/minecraft-mcp-server](https://github.com/yxengram/minecraft-mcp-server), branch `extra-tools`) |

The upstream project is a good, simple bridge: the LLM calls a tool, and the bot does one thing. This fork keeps that bridge and every upstream tool, with the same names and arguments. It adds what turned out to be missing when an LLM actually tries to survive in the game.

## What changed

### 1. More tools, and seeing like a player (23 → 64 tools)
- **Moving:** follow or flee from an entity, stop, saved waypoints.
- **Building and mining:** collect a number of blocks, clear or fill a region, dig a tunnel, read and use containers.
- **Interacting:** right-click blocks and entities, trade with villagers, sleep and wake, ride and dismount, attack.
- **Perception:**
  - `get-observation`: one-call snapshot of vitals, effects, armor, time, weather, equipment, inventory and nearby entities.
  - `get-events` and `wait-for-event`: everything a player would notice (damage and its source, hostile sounds, explosions, chat, deaths, pickups). The LLM can wait for something to happen instead of polling.
  - `scan-area`: terrain described in text.
  - `render-map`: a top-down map or cross-section as an image.
  - `get-cursor-target`: what is under the crosshair.

### 2. The Autopilot
- **Background tasks:** `follow`, `flee`, `guard`, `gather`, `hunt`, `return-home`. A tool call returns at once; progress arrives as events.
- **One body, one driver:** an action arbiter makes sure only one thing controls the bot's body at a time. A command from the LLM runs immediately, and the reply says what it interrupted.
- **Instinct:** code senses danger and works out what the bot can do; a decision model on [OpenRouter](https://openrouter.ai) picks the option; code carries it out. See [Design](#design).
- **Policy:** the LLM tunes the instinct, the combat rules, chat handling and the decision model with `get-policy` and `set-policy`. It can also say what it is up to (`instinct.intent`), so the instinct does not "rescue" the bot from something it is doing on purpose.
- **Chat triage:** the decision model sorts chat. Only messages meant for the bot wake the LLM, as `chat_request` events. Nobody can command the bot by chat unless the LLM allows it.

### 3. Tested in the game, not only on paper
- 820 unit tests.
- A live test that exercises all 64 tools against a real server.
- A scenario test that compares the bot with and without the Autopilot: zombie waves, being chased by zombies with bare hands, creepers, hunger, fire, drowning, diving on purpose, a lava shore, chat.
- A 10-day survival test on Normal difficulty. The bot survived all ten nights without dying and built a 7×7 house with a door, eight glass windows, a bed, a chest, a crafting table, a furnace and torches.
- A 5-day survival test on Hard difficulty, from an empty inventory. The bot survived all five nights without dying, sleeping in a sealed pit with a bed, and ended with iron armor and 14 cooked meals.

Problems found while playing were fixed and re-tested, for example:
- the bot drowning under a ceiling;
- tasks leading the bot back into danger;
- the pathfinder digging through the bot's own walls;
- placements failing because the bot stood in the target cell;
- the furnace keeping its output.

## Design

### The problem: an LLM is too slow for real time
Every "look, think, call a tool" round trip takes the LLM seconds. Minecraft runs at 20 ticks per second, and a lit creeper explodes in 1.5 s. Hand-writing a rule for every situation does not scale either. The first versions of this fork had code reflexes, which is how such bots are usually built. A drowning in the survival test showed the limit: the reflex only knew how to swim up, and the bot was under a stone ceiling. Fixing that with more rules leads to endless code. The next rule would be needed when the bot wants to dive to an ocean monument on purpose. And at that point, is it the LLM that plays, or the code?

### The answer: three roles, like a brain

| Role | Who | Speed | What it does | What it never does |
|---|---|---|---|---|
| **Cortex** | The LLM | seconds | Sets goals, starts tasks, plans, talks, adjusts the policy, states its intent | Steer every tick |
| **Instinct** | A decision model (default `perplexity/pplx-decider-v1.2-20261016`) | about 0.65 s | Picks one option from a menu, with a probability, and says whether it is urgent and whether the current task may carry on | Write text or invent options |
| **Cerebellum** | Code | every tick | Senses danger, works out which options are possible right now (an air pocket it can reach, a ceiling it can dig, water to put out a fire), and carries out the chosen move: swimming, digging, sprinting away, fighting, eating | Decide on its own to do something else ("if X then do Y") |

Decision models are a kind of model that does not generate text. Given a state and a question, they return calibrated probabilities for a fixed set of choices. That makes them fast and cheap (about $0.00002 per call), and a good fit for "which of these five things now?".

### Rules the code keeps
1. **Code never maps an event to a behavior.** It may sense, list what is possible, wake the decision model and carry out a choice. A macro either finishes or fails and reports; it never quietly switches to something else.
2. **No decision, no action.** Without a key, or on a timeout or error, the bot does not act on dangers by itself. It reports each one once as an `instinct offline` event, and the LLM decides.
3. **The LLM's commands come first.** Only a choice that the decision model marks *urgent* may interrupt them. The reply to the interrupted command says so.
4. **Safety stays in code, outside the model's reach.**
   - The instinct never attacks players, even with `combat.attackPlayers` on, and never attacks tamed animals or (by default) neutral mobs.
   - Chat can never change the policy.
   - Only one holder drives the body at a time.
   - The API key never appears in logs, events or tool output.
5. **Facts for the model, choices by the model.**
   - The model sees what code knows: earlier dangers, how often it was asked, the LLM's intent.
   - That is how it learned, for example, to stop a task that kept walking the bot back into the same water.
6. **Thresholds come from measurements.**
   - Probabilities and latencies were probed on the pinned model before the defaults were set: act at 0.3 or more, urgent at 0.6 or more.
   - They have to be probed again when the model changes.
7. **Everything is visible.** Every decision, its probabilities and its result is an event the LLM can read.

### Known limits
- A creeper that is **already lit** 4 blocks away leaves about 0.7 s, and the decision API sometimes answers in 1.0–1.3 s. That case is a stress test, not a guarantee. A creeper that walks up is asked about from 10 blocks away and is handled.
- Cornered at low health inside walls, the only option left is to run.
- The pathfinder treats wooden doors as passable and a door helper opens and closes them; iron doors are not handled.
- The pathfinder does not place scaffolding next to built blocks (fences, walls, doors, planks and the like, or under a roof) and does not dig the block a built block stands on. Near buildings it may therefore find no way where it used to tower up.

The full design, the contract of every file, and the evidence behind each choice are in [docs/BLUEPRINT.md](docs/BLUEPRINT.md) and [docs/PLAN.md](docs/PLAN.md), both in Chinese.

---

## Getting started

### Requirements
- Node.js 22 or later, and Git
- Minecraft Java Edition 26.1.2
- An MCP client, for example [Claude Desktop](https://claude.ai/download)
- Optional: an [OpenRouter](https://openrouter.ai) API key for the instinct and chat triage

### 1. Build the server
```bash
git clone https://github.com/yxengram/minecraft-mcp-server.git
cd minecraft-mcp-server
npm install
npm run build
```

### 2. Open a world to LAN
Start a world and choose `ESC → Open to LAN`. Note the port that Minecraft prints in chat. Turn cheats on if you want to run the live tests.

### 3. Add the server to your MCP client
For Claude Desktop, go to `Settings → Developer → Edit Config`, then add an entry to `claude_desktop_config.json`:

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

Leave out `env` to run without a decision model: everything else works, but the instinct is offline.

Restart the client completely. The bot joins the world once the client starts the server.

| Option | Default | Meaning |
|---|---|---|
| `--host` | `localhost` | Minecraft server host |
| `--port` | `25565` | Minecraft server port (the LAN port) |
| `--username` | `LLMBot` | The bot's name |
| `--waypoint-file` | `~/.minecraft-mcp-server/waypoints.json` | Where waypoints are stored (per server host) |
| `--decision-model` | `perplexity/pplx-decider-v1.2-20261016` | The OpenRouter decision model |

The API key is read only from the `OPENROUTER_API_KEY` environment variable. Do not put it in any file inside the repository.

### 4. Play
Ask the LLM to do things in Minecraft. A few habits make it much better at the game:
- Use `start-task` for long jobs, then `wait-for-event` (for example on `task_done`, `task_failed`, `instinct`, `chat_request`) instead of polling.
- Use `get-observation` for a quick look, and `scan-area` or `render-map` to understand the terrain.
- Before doing something risky on purpose, set the intent, for example `set-policy { "instinct": { "intent": "exploring an underwater cave on purpose" } }`.

---

## Tools (64)

A command that moves or uses the bot's body stops when the bot dies, and its reply says where and why the bot died and where it respawned. The pathfinder keeps away from lava shores when it can and never bridges lava.

### Movement
- `get-position`: the bot's position
- `move-to-position`: walk to coordinates; reports an error if the pathfinder stops short, the blocks it dug and placed on the way, and the trip when it ends in a Nether portal; refuses to move while the bot is walled in on every side (as after the instinct's dig_in) unless `leaveShelter: true` is passed, because the pathfinder would dig the shelter open
- `move-in-direction`: walk in a direction for a while
- `look-at`: look at coordinates
- `jump`: jump
- `stop-pathfinding`: stop moving, and cancel the current task
- `follow-entity`: keep following a player or mob (as a task)
- `flee-from`: run from an entity to a safe distance (as a task)
- `fly-to`: fly to coordinates (creative)

### Waypoints
- `set-waypoint`: save a named place
- `list-waypoints`: list waypoints with distances
- `delete-waypoint`: delete one
- `goto-waypoint`: walk to one (into the portal when the waypoint is in a Nether portal); reports and refuses like move-to-position

### Inventory and crafting
- `list-inventory`: items, with names, durability and enchantments
- `find-item`: look for an item
- `equip-item`: hold or wear an item
- `unequip-item`: take an item off
- `consume`: eat or drink
- `toss-item`: drop items
- `list-recipes`: recipes for an item
- `get-recipe`: one recipe in detail
- `can-craft`: whether an item can be crafted now
- `craft-item`: craft an item a number of times (recipes bigger than 2×2 need a crafting table placed within 16 blocks)
- `smelt-item`: smelt a whole batch in a furnace, blast furnace or smoker

### Blocks
- `get-block-info`: a block's state, light, biome and sign text
- `get-cursor-target`: the block face or entity under the crosshair
- `find-blocks`: nearby blocks of a type
- `place-block`: place a block; walks to a spot from which it can see a face to click, never into the target
- `dig-block`: dig a block with the best tool in the inventory; refuses when no tool the bot has makes it drop anything
- `collect-block`: mine and pick up a number of blocks of one type (runs as a `gather` task; skips blocks next to lava or water)
- `clear-region`: dig out a box (up to 512 blocks)
- `fill-region`: fill the empty cells of a box (up to 512 blocks)
- `dig-tunnel`: dig a straight tunnel
- `activate-block`: right-click a block (doors, buttons, levers); says when nothing changed
- `use-item`: use the held item: fill or empty a bucket, throw a pearl; reports what changed (never pours lava next to the bot or near another player)

### Containers
- `read-container`: look inside a chest, barrel, shulker box, hopper, dispenser or dropper
- `container-deposit`: put items in
- `container-withdraw`: take items out

### Entities
- `find-entity`: the nearest entity of a type
- `list-entities`: nearby entities, with details such as drops, owners, sheep colors, held items and creepers about to explode
- `list-players`: players online
- `attack-entity`: attack an entity in reach
- `activate-entity`: right-click an entity
- `list-trades`: what a villager offers, the stock left and how many times you can afford each trade
- `trade`: trade with a villager by the number list-trades shows
- `mount-entity`: ride a horse, boat or minecart
- `dismount`: get off
- `sleep`: sleep in a bed (refused outside the overworld, where beds explode)
- `wake`: get up

### Perception
- `get-observation`: one-call snapshot of the bot and its surroundings
- `get-events`: recent game events
- `wait-for-event`: wait (up to 55 s) for an event, a hostile mob coming close, or health dropping
- `scan-area`: the terrain in text: heights, slopes, surface, water and lava, notable blocks, entities
- `render-map`: a PNG map, top-down or cross-section (needs a client and model that accept images)
- `detect-gamemode`: the game mode

### Chat
- `send-chat`: say something, or run a command
- `read-chat`: recent chat and system messages

### Autopilot
- `start-task`: start a background task
- `list-tasks`: the current task and recently finished ones
- `resume-task`: resume a task that was held for you
- `cancel-task`: cancel the current task
- `get-policy`: show the policy and whether the instinct is online
- `set-policy`: change part of the policy
- `list-decision-models`: the decision models OpenRouter offers

## Autopilot reference

### Tasks
- `start-task` takes one of the behaviors below and returns at once:
  - `follow` `{ target | entityId, range? }`
  - `flee` `{ target | entityId, distance? }`
  - `guard` `{ target | waypoint | x,y,z, radius? }`
  - `gather` `{ blockType, count? }`
  - `hunt` `{ animal, count? }`
  - `return-home` `{ waypoint?, sleep? }`
- `guard` fights hostile mobs only. Piglins count as hostile unless the bot wears a piece of gold armor; zombified piglins and endermen are neutral.
- `hunt` never attacks players or tamed animals.
- A new task replaces the current one, unless `replace` is `false`.
- Any command that moves the bot pauses the current task, and its reply says so. Use `resume-task` or `cancel-task` afterwards.
- Events: `task_started`, `task_progress`, `task_paused`, `task_resumed`, `task_done`, `task_failed`, `task_cancelled`.

### Instinct
**What it notices (cues):**
- standing in lava (any part of the bot touching it, or the server burning it with lava), or burning;
- under water with a ceiling above, or low on air;
- a creeper within 10 blocks, or swelling within 7;
- being hit;
- low health with hostiles near;
- hunger, when there is safe food;
- a mob it ran from coming back.

**What it can choose:** swim up, swim to an air pocket, dig up, leave the lava, walk into water, step off the fire, run from a creeper, flee, fight, hold its ground, dig in (dig 3 blocks down and close the hole above its head, offered only where the ground is safe and no mob can reach the bot before the hole is closed), eat, keep going, pause the task, or leave it to the LLM.

**How it asks:** it asks when a cue appears, again every 1.5 s while the cue lasts (hunger every 20 s), and after each action ends. A new, more urgent danger does not wait behind an older question. Every decision and its result is an `instinct` event.

### Policy (defaults)

| Group | Fields |
|---|---|
| `instinct` | `enabled: true`, `intent: ""` (max 300 characters, set only by the LLM), `lowAir: 6`, `lowHealth: 6`, `hostileRadius: 16`, `food: 14`, `reaskMs: 1500`, `actThreshold: 0.3`, `urgentThreshold: 0.6`, `maxCallsPerMinute: 90` |
| `combat` | `attackPlayers: false` (a warning event whenever it is turned on), `avoidNeutral: true`, `retreatHealth: 6` |
| `chat` | `triage: true`, `commandsFrom: []` (players whose clear commands such as "follow me" run without the LLM; set only by the LLM), `replyInChat: true` |
| `decisions` | `enabled: true`, `model`, `actThreshold: 0.95`, `cautiousThreshold: 0.5` (chat), `maxCallsPerMinute: 30` (chat) |

The policy lives in memory only, and goes back to these defaults whenever the bot joins the game.

### Privacy and cost
**What is sent:** with a key, chat messages from other players and a summary of the bot's situation go to OpenRouter and the model provider. The summary covers health, food, air, the dangers, the options, the current task and the LLM's intent. Without a key, nothing is sent.

**Cost:** a call costs about $0.00002. The instinct is limited to 90 calls a minute and chat to 30. It only asks while a danger lasts.

---

## Testing

```bash
npm test             # 820 unit tests
npm run lint
npm run test:live -- <LAN_PORT>                                 # read-only check against a world
npm run test:live:world -- <LAN_PORT> --allow-world-changes      # every tool, in a throwaway world with cheats on
npm run test:scenarios -- <LAN_PORT> --allow-world-changes       # the Autopilot in dangerous situations
```

**Use a throwaway world** for `test:live:world` and `test:scenarios`. They build an arena at y=240, give items, summon mobs and can kill the bot.

**How the scenario test works:**
- It runs every scenario in three configurations: `llm-only` (instinct off), `no-key` (instinct offline) and `instinct` (with a key).
- It fails if a required scenario fails in the `instinct` configuration.
- `creeper-ambush` is reported but not required, because the decision API's latency doesn't always beat the fuse.
- Pass the key with `OPENROUTER_API_KEY="..."` in front of the command.

## Project documents
- [docs/BLUEPRINT.md](docs/BLUEPRINT.md): the design, the contract of every file, the cross-module rules and the safety invariants (in Chinese)
- [docs/PLAN.md](docs/PLAN.md): milestones M1–M11, open questions and the log of every check that was actually run (in Chinese)
- [AGENTS.md](AGENTS.md): rules for coding agents working on this repository (in Chinese)
- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute (from upstream)

## License and acknowledgements
Apache License 2.0; see [LICENSE](LICENSE). The upstream copyright (© 2025 Yuniko Software) is kept.

**Thanks to:**
- [yuniko-software/minecraft-mcp-server](https://github.com/yuniko-software/minecraft-mcp-server), the project this fork builds on, and lifat for the Minecraft 26.1.2 support in pull request #274;
- [PrismarineJS](https://github.com/PrismarineJS) for Mineflayer and mineflayer-pathfinder;
- [OpenRouter](https://openrouter.ai) for the Decisions API.
