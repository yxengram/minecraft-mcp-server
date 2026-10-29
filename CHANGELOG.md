# Changelog

All notable changes to this project are written down in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions up to 2.0.4 are the upstream project's; their tags have no `v` prefix. This fork's releases start at 3.0.0, tagged `v3.0.0`.

## [Unreleased]

The first release of this fork. It builds on upstream version 2.0.4 (upstream `main` at `240c8ce`) and upstream pull request #274 for Minecraft 26.1.2, by lifat; see "Where this project comes from" in the README. Every upstream tool keeps its name and arguments. The README lists all the tools.

### Added

- **Support for Minecraft Java Edition 26.1.2** (protocol 775), from upstream pull request #274.
- **More tools**:
  - Moving: follow or flee from an entity, stop, saved waypoints.
  - Building and mining: collect a number of blocks, clear or fill a region, dig a tunnel, read and use containers, find the ground height far away.
  - Interacting: right-click blocks and entities, use an item such as a bucket, trade with villagers, sleep and wake, ride and dismount, lead an animal, and attack: `attack-entity` never attacks a player unless `combat.attackPlayers` is on, never attacks a tamed animal, and holds back a sword sweep that would hit a player or a tamed animal. Given a type, it picks the nearest entity of that type that it may attack.
- **Perception**:
  - `get-observation`: vitals, effects, armor, time, weather, equipment, inventory and nearby entities in one call.
  - `get-events` and `wait-for-event`: what a player would notice (damage and its source, hostile sounds, explosions, chat, deaths, pickups), plus task and instinct events. The LLM can wait for something to happen instead of polling.
  - `scan-area` describes the terrain in text; `render-map` draws a top-down map or a cross-section as an image; `get-cursor-target` says what is under the crosshair.
- **Autopilot**:
  - Background tasks: `follow`, `flee`, `guard`, `gather`, `hunt`, `return-home` and `lead`, started with `start-task` and managed with `list-tasks`, `resume-task` and `cancel-task`. Progress arrives as events.
  - One driver at a time: an action arbiter lets only one holder control the bot's body. A command from the LLM runs at once, and its reply says what it interrupted.
- **Instinct**: code senses danger (water and air, lava, fire, creepers and other mobs, low health, hunger, being cornered) and lists the moves possible right now. A decision model on OpenRouter picks one, and code carries it out, for example swimming to air, digging in, sprinting away, fighting or eating. The key is read only from `OPENROUTER_API_KEY`. Without a key the instinct is offline: the bot does not act on dangers by itself and reports each one once as an event.
- **Policy**: `get-policy`, `set-policy` and `list-decision-models` tune the instinct, combat, chat handling and the decision model. `instinct.intent` tells the instinct what the bot is doing on purpose.
- **Chat triage**: the decision model sorts chat, and only messages meant for the bot wake the LLM, as `chat_request` events. Players can give the bot chat commands only when the LLM allows them (nobody by default), and chat can never change the policy.
- **Command line**: `--help`, `--version`, `--waypoint-file` and `--decision-model`.
- **Connection errors in plain words**: a failed connection or a kick says what went wrong (nothing listening on the port, host not found, no answer, online mode, the same name already playing, a version mismatch, the whitelist, bans, a full server) and what to do about it.
- **A warning for other Minecraft versions**: when the server is not 26.1.2 (told from the version name the server reports, since 26.1, 26.1.1 and 26.1.2 share protocol 775), the bot still joins, but it writes a warning to stderr and to a new `connection` event, and the first tool reply after each join ends with the same sentence. On 26.1.2 the `connection` event only records the join.
- A startup line on stderr: `<command> v<version>, tested with Minecraft 26.1.2`.
- Tests: unit tests, a live test that runs every tool against a real server, a scenario test that compares the bot with and without the Autopilot, and a stdio smoke test. CI runs on Linux, macOS and Windows.

### Changed

- **Breaking:** the server checks its options when it starts. An unknown option, a `--port` that is not a whole number from 1 to 65535, an empty `--host`, or a `--username` that is empty, longer than 16 characters or contains spaces or control characters writes one line to stderr and exits with 1; before, the server started anyway. A name that passes but is not 3 to 16 letters, digits or underscores only gets a warning.
- mineflayer 4.39.0, mineflayer-pathfinder 2.4.5 and minecraft-data 3.117.0 are pinned to exact versions, and the package carries `npm-shrinkwrap.json`, so an install from npm gets the dependency tree that was tested.
- The package holds only the built JavaScript, `package.json`, `npm-shrinkwrap.json`, the READMEs, the license and this changelog. The MCP server reports the version from `package.json`.
- The link at the end of a connection error points to Getting started in this fork's README.
- Commands that drive the bot's body (moving, digging, placing, attacking, using items and the like) stop after about 50 seconds, before an MCP client's usual 60-second request timeout, and the reply says where the bot stopped. For now the region tools also stop at about 50 seconds, although their descriptions still give a default of 120 seconds. Tools that do not drive the body (queries, `wait-for-event`), `collect-block` and `lead-animal` are not stopped at 50 seconds.

### Fixed

- A connection attempt that fails before the bot joins now ends, instead of leaving the server "connecting" until it restarts.
- The pathfinder opens and closes wooden doors, keeps away from lava, and does not dig through built blocks or place scaffolding next to them.
- `place-block` picks a spot to stand on from which the block can be placed.
- `smelt-item` takes out all of the furnace's output, and first takes back a different fuel left in the furnace.
- `dig-block` picks a suitable tool and waits long enough for blocks that need an iron pickaxe or better.
- Body commands stop and say so when the bot dies.
- A body command that the MCP client cancels stops the bot at once; before, the bot kept walking toward the old target. The client drops the reply to a cancelled request, so a `command` event says what was cancelled and where the bot stopped. A cancelled `collect-block` or `lead-animal` cancels its task.
- A body command that is running when the bot leaves the game (kicked, or the connection is lost) returns at once with an error that gives the reason, for example "Kicked by an operator"; before, it did not return until the MCP client gave up. The next tool call reconnects.
