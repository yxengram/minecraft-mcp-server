# Welcome to Minecraft-MCP-Server Contributing Guide

## Prerequisites
- Git
- Node.js (>=22)
- A running Minecraft game (tested with Minecraft 26.1.2 Java Edition)
- Claude Desktop (or another MCP-compatible client)

### 1. Fork and Clone the Repository

1. Fork this repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/minecraft-mcp-server.git
   cd minecraft-mcp-server
   ```

### 2. Create a Feature Branch

Create a new branch for your feature or bug fix:
```bash
git checkout -b your-feature-name
```

### 3. Setup Minecraft Server

Create a singleplayer world and open it to LAN (ESC -> Open to LAN). The bot connects to localhost on port 25565 by default, and the example config below passes `--port 25565`, but Open to LAN picks its own port unless you give it one: the LAN World screen has a **Port Number** box (1024–65535). Enter `25565` there, and the same number each time you open the world to LAN. If you leave the box empty, Minecraft picks a different port each time and prints it in chat as `Local game hosted on port N`; put that N in `--port` and restart the client completely, because the server reads `--port` only when it starts.

For a more detailed setup guide, see the [README](README.md) (step 2, "Open a world to LAN").

### 4. Configure Your MCP Client

#### For Claude Desktop Users

Make sure [Claude Desktop](https://claude.ai/download) is installed. Open your desktop config file via Claude Desktop: `File -> Settings -> Developer -> Edit Config`

Alternatively, you can edit the config file directly:

**MacOS/Linux**
```bash
code ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

**Windows**
```bash
code $env:AppData\Claude\claude_desktop_config.json
```

#### For Other MCP Clients

If you're using a different MCP client, configure it according to your client's documentation to point to the npx command and arguments shown below.

### 5. Point Your Client to Your Development Branch

Update your MCP configuration to use your fork and branch:

**For Claude Desktop (`claude_desktop_config.json`):**
```json
{
  "mcpServers": {
    "minecraft": {
      "command": "npx",
      "args": [
        "-y",
        "github:YOUR_USERNAME/minecraft-mcp-server#your-feature-branch-name",
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

### 6. Development Workflow

1. Make your changes and commit them to your feature branch
2. Push your branch to your fork:
   ```bash
   git push origin your-feature-name
   ```
3. Restart your MCP client completely (for Claude Desktop, close from system tray)
4. Open your MCP client - it will automatically pull and run your latest changes
5. Test your changes through your client's chat interface

### 7. Debugging with MCP Inspector

The [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) is an excellent tool for debugging and testing your MCP server during development. It provides a user-friendly interface to:

- Test individual tools without needing a full MCP client
- Inspect requests and responses
- Debug connection issues
- Validate tool schemas and responses

To use the MCP Inspector with your development branch, follow the guide at: https://modelcontextprotocol.io/docs/tools/inspector

## Dependency versions

`mineflayer`, `mineflayer-pathfinder` and `minecraft-data` are pinned to exact versions in `package.json`. The server reads packets from `bot._client`, relies on mineflayer-pathfinder internals and corrects some of minecraft-data's tables, so a new release of any of them can break the bot in game while every unit test still passes. `tests/release.test.ts` fails if one of them becomes a range or differs from `package-lock.json`.

- Commit `package-lock.json` only, and do not run `npm shrinkwrap` in the repository. npm ignores the `package-lock.json` of a published package, so CI and the release workflow run `npm shrinkwrap` just before packing; the `npm-shrinkwrap.json` it produces ships in the package, and npm installs the locked tree from it when the package comes from the registry. It is listed in `.gitignore`.
- A pull request that changes the version of `mineflayer`, `mineflayer-pathfinder`, `minecraft-data`, `minecraft-protocol` or any `prismarine-*` package, in `package.json` or in `package-lock.json`, needs these runs before it is merged, in a throwaway world with cheats on:
  1. `npm run test:live:world -- <LAN_PORT> --allow-world-changes` twice: once without `OPENROUTER_API_KEY` and once with it;
  2. `npm run test:scenarios -- <LAN_PORT> --allow-world-changes`.

  Record the results in `docs/PLAN.md`. Dependabot opens one `mineflayer-stack` PR for the three pinned packages, and that PR falls under this rule.

## Submitting Changes

Once you're happy with your changes:
1. Push your feature branch to your fork
2. Create a Pull Request from your fork to the main repository
3. Others can test your changes by pointing their config to your fork/branch
