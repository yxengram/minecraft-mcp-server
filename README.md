# Minecraft MCP Server

<a href="https://github.com/yuniko-software/minecraft-mcp-server/actions">
  <img alt="CI" src="https://github.com/yuniko-software/minecraft-mcp-server/actions/workflows/build.yml/badge.svg">
</a>
<a href="https://github.com/yuniko-software">
  <img alt="Contribution Welcome" src="https://img.shields.io/badge/Contribution-Welcome-blue">
</a>
<a href="https://github.com/yuniko-software/minecraft-mcp-server/releases/latest">
  <img alt="Latest Release" src="https://img.shields.io/github/v/release/yuniko-software/minecraft-mcp-server?label=Latest%20Release">
</a>

<img width="2063" height="757" alt="image" src="https://github.com/user-attachments/assets/3f0f0438-f079-4226-90bd-87b9e1311d19" />

___

> [!IMPORTANT]
> Minecraft Java 26.1.2 has been verified with Mineflayer 4.39.0 or later. Newer versions may not work with this MCP server, but we will add support as soon as possible.

https://github.com/user-attachments/assets/6f17f329-3991-4bc7-badd-7cde9aacb92f

A Minecraft bot powered by large language models and [Mineflayer API](https://github.com/PrismarineJS/mineflayer). This bot uses the [Model Context Protocol](https://github.com/modelcontextprotocol) (MCP) to enable Claude and other supported models to control a Minecraft character.

<a href="https://glama.ai/mcp/servers/@yuniko-software/minecraft-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@yuniko-software/minecraft-mcp-server/badge" alt="mcp-minecraft MCP server" />
</a>

## Prerequisites

- Git
- Node.js (>= 22)
- A running Minecraft game (the setup below was tested with Minecraft 26.1.2 Java Edition)
- An MCP-compatible client. Claude Desktop will be used as an example, but other MCP clients are also supported

## Getting started

This bot is designed to be used with Claude Desktop through the Model Context Protocol (MCP).

### Run Minecraft

Create a singleplayer world and open it to LAN (`ESC -> Open to LAN`). Bot will try to connect using port `25565` and hostname `localhost`. These parameters could be configured in `claude_desktop_config.json` on a next step. 

### MCP Configuration

Make sure that [Claude Desktop](https://claude.ai/download) is installed. Open `File -> Settings -> Developer -> Edit Config`. It should open installation directory. Find file with a name `claude_desktop_config.json` and insert the following code:

```json
{
  "mcpServers": {
    "minecraft": {
      "command": "npx",
      "args": [
        "-y",
        "github:yuniko-software/minecraft-mcp-server",
        "--host",
        "localhost",
        "--port",
        "25565",
        "--username",
        "ClaudeBot"
      ]
    }
  }
}
```

Double-check that right `--port` and `--host` parameters were used. Make sure to completely reboot the Claude Desktop application (should be closed in OS tray). 

## Running

Make sure Minecraft game is running and the world is opened to LAN. Then start Claude Desktop application and the bot should join the game. 

**It could take some time for Claude Desktop to boot the MCP server**. The marker that the server has booted successfully:

<img width="885" height="670" alt="image" src="https://github.com/user-attachments/assets/ccbb42f8-6544-462c-8ac1-8af13ddfcddd" />

You can give bot any commands through any active Claude Desktop chat. You can also upload images of buildings and ask bot to build them 😁

Don't forget to mention that bot should do something in Minecraft in your prompt. Because saying this is a trigger to run MCP server. It will ask for your permissions.

Using Claude Sonnet could give you some interesting results. The bot-agent would be really smart 🫡

Example usage: [shared Claude chat](https://claude.ai/share/535d5f69-f102-4cdb-9801-f74ea5709c0b)

## Available Commands

Once connected to a Minecraft server, Claude can use these commands:

### Movement
- `get-position` - Get the current position of the bot
- `move-to-position` - Move to specific coordinates
- `look-at` - Make the bot look at specific coordinates
- `jump` - Make the bot jump
- `move-in-direction` - Move in a specific direction for a duration
- `stop-pathfinding` - Stop the current movement
- `follow-entity` - Keep following a player or mob until `stop-pathfinding`
- `flee-from` - Run away from an entity until a safe distance

### Flight
- `fly-to` - Make the bot fly directly to specific coordinates

### Inventory
- `list-inventory` - List all items in the bot's inventory, with custom names, durability and enchantments
- `find-item` - Find a specific item in inventory
- `equip-item` - Equip a specific item
- `unequip-item` - Take off an equipped item
- `consume` - Eat or drink an item
- `toss-item` - Drop items on the ground

### Block Interaction
- `place-block` - Place a block at specified coordinates
- `dig-block` - Dig a block at specified coordinates
- `get-block-info` - Get information about a block: its state (open, facing, powered, ...), light level, biome and sign text
- `get-cursor-target` - What the bot is looking at: facing direction and the block face or entity under the crosshair
- `find-blocks` - Find one or more nearby blocks of a specific type
- `collect-block` - Mine and pick up a number of blocks of one type
- `clear-region` - Dig out a box between two corners (max 512 blocks)
- `fill-region` - Fill empty spaces in a box with a block from the inventory (max 512 blocks)
- `dig-tunnel` - Dig a straight horizontal tunnel
- `activate-block` - Right-click a block (doors, buttons, levers)

Digging tools pick the best tool in the inventory and skip blocks next to lava.

### Containers
- `read-container` - Look inside a chest, barrel, shulker box, hopper, dispenser or dropper
- `container-deposit` - Put inventory items into a container
- `container-withdraw` - Take items out of a container

### Furnace
- `smelt-item` - Smelt items using a furnace-like block

### Entity Interaction
- `find-entity` - Find the nearest entity of a specific type
- `list-entities` - List nearby entities, nearest first, with what dropped items are, custom names, babies, owners, sheep colors, held or worn items and creepers about to explode
- `list-players` - List players online on the server
- `attack-entity` - Attack an entity within reach
- `activate-entity` - Right-click an entity (villagers, animals)
- `sleep` / `wake` - Sleep in a bed (at night or during thunderstorms) and get up
- `mount-entity` / `dismount` - Ride and leave horses, boats and minecarts

### Waypoints
- `set-waypoint` - Save a named location (current position by default)
- `list-waypoints` - List saved waypoints with distances
- `delete-waypoint` - Delete a waypoint
- `goto-waypoint` - Walk to a saved waypoint

Waypoints are stored per server host in `~/.minecraft-mcp-server/waypoints.json`. Use `--waypoint-file <path>` to store them elsewhere, for example one file per world, since every LAN world is `localhost`.

### Communication
- `send-chat` - Send a chat message in-game
- `read-chat` - Get recent chat messages from players, plus system messages (command feedback, death messages, advancements), action bar text and titles

### Vision
- `scan-area` - Describe the surrounding terrain in text: height and slope in each direction, surface blocks, cliffs, water and lava, notable blocks (ores, chests, beds, trees, spawners) and entities
- `render-map` - Render a PNG map: a top-down view (north up) with the bot, its facing direction and entities marked, or a vertical cross-section through the bot

Both tools look down from the sky by default and switch to the bot's own level when it is under a roof, so caves and buildings show walkable floor and walls. `scan-area` only lists blocks exposed to air or water unless `xray` is set. `render-map` returns an image, so it needs an MCP client and model that support images. Both only see chunks the server has sent to the bot.

### Game State
- `detect-gamemode` - Detect the gamemode on game
- `get-observation` - One-call snapshot of vitals, status effects, armor, xp, position, time, weather, equipment, inventory and nearby entities
- `get-events` - Read recent game events (chat, system messages, titles, death, damage with its type and attacker, hostile mob sounds, loud sounds, explosions, item pickups, joins/leaves, kicks). Pass `nextSince` back as `since` to read only new events
- `wait-for-event` - Wait until something happens instead of polling: a new event (optionally of certain types), a hostile mob coming close or health dropping low (up to 55 seconds)

## Contributing

Feel free to submit pull requests or open issues for improvements. All refactoring commits, functional and test contributions, issues and discussion are greatly appreciated!

To get started with contributing, please see [CONTRIBUTING.md](CONTRIBUTING.md).

---

⭐ If you find this project useful, please consider giving it a star on GitHub! ⭐

Your support helps make this project more visible to other people who might benefit from it.

## Live compatibility check

After building the project, open a singleplayer world to LAN and run:

```sh
npm run test:live -- LAN_PORT
```

Replace `LAN_PORT` with the port shown in Minecraft chat. The test connects a bot on localhost, lists MCP tools, checks its position and game mode, reads a nearby block, and calls the read-only observation tools. It disconnects when finished and does not intentionally change blocks. The port defaults to `25565` when omitted.

### Full world test

To exercise every MCP tool against a real server, use a throwaway world with cheats enabled and run:

```sh
npm run test:live:world -- LAN_PORT --allow-world-changes
```

This test **modifies the world**. It builds a floating stone arena at y=240 above the bot (and removes it at the end), gives itself items with `/give`, summons a pig and a minecart, places a bed, crafting table, chest and furnace, changes the time and game mode, and kills the bot at the end to check death and respawn events. A second bot named `MCPHelper` joins to act as another player for the chat, whisper and follow tests. The script reports any tool it did not exercise, so newly added tools show up as missing coverage.

Minecraft Java 26.1.2 (protocol 775) was also manually verified with a Survival bot: place a dirt block, read it back, dig it, and restore the borrowed dirt to its original location.
