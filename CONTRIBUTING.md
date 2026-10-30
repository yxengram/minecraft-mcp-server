# Welcome to Minecraft-MCP-Server Contributing Guide

## Prerequisites
- Git
- Node.js (>=22)
- A running Minecraft game (tested with Minecraft 26.1.2 Java Edition)
- Claude Desktop (or another MCP-compatible client)

### 1. Fork and Clone the Repository

1. Fork [yxengram/minecraft-mcp-server](https://github.com/yxengram/minecraft-mcp-server) on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/minecraft-mcp-server.git
   cd minecraft-mcp-server
   ```

### 2. Create a Feature Branch

`extra-tools` is the release branch and the repository's default branch, so a fresh clone starts on it. Create a new branch from it for your feature or bug fix:
```bash
git checkout extra-tools
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
2. Create a Pull Request from your fork to the `extra-tools` branch of [yxengram/minecraft-mcp-server](https://github.com/yxengram/minecraft-mcp-server)
3. Others can test your changes by pointing their config to your fork/branch

## Releasing

Only the owner of [yxengram/minecraft-mcp-server](https://github.com/yxengram/minecraft-mcp-server) releases. Contributors and agents never push a `v` tag, approve the `release` environment, publish to npm or create a GitHub Release; they may run `npm pack` and `npm publish --dry-run` in a throwaway clone, and start a dry run only when the owner agrees.

`.github/workflows/release.yml` does the work when a `v` tag is pushed:

- `verify` checks that the tag without its `v` equals the version in `package.json` and in `mcpb/manifest.json`, that `CHANGELOG.md` has a section for that version, and that the tagged commit is on `extra-tools`; a failed check names itself. It then runs the CI checks (lint, type check, unit tests, build), packs the package with its `npm-shrinkwrap.json`, installs it from that shrinkwrap and in an empty project and runs the smoke test on both, builds the `.mcpb` and runs the smoke test on it unpacked, uploads the `.tgz`, the `.mcpb` and the CHANGELOG section, and runs `npm publish --dry-run`.
- `publish` waits for your approval of the `release` environment. It then publishes the very `.tgz` that `verify` tested, with `npm publish --access public --provenance` (no new build), and creates the GitHub Release for the tag with the `.tgz` and the `.mcpb`, the CHANGELOG section as its notes. It fails, before publishing, if that Release already exists.

### Once, before the first release

1. Make the repository public: npm provenance does not support private repositories.
2. Set up npm: the `@yxengram` scope (your npm user or an organization) and publishing from CI. Prefer Trusted Publishing, which needs no long-lived token: in the package's settings on npmjs.com, add GitHub Actions as a trusted publisher with the repository `yxengram/minecraft-mcp-server`, the workflow `release.yml` and the environment `release`. If npm accepts that only once the package exists, either store a granular access token limited to this package as the `NPM_TOKEN` secret of the `release` environment, so that only the approved job can read it (the publish step passes it as `NODE_AUTH_TOKEN`), and delete it after the first release, or publish the first version once by hand. To publish by hand, push the tag (step 3 of Each release), wait until `verify` has passed, download the `release` artifact of that run (`gh run download <run-id> -n release`) and run `npm publish <its .tgz> --access public`. Never run `npm publish` in a clone: that packs a new build without `npm-shrinkwrap.json`, not the file `verify` tested. npm never takes the same version twice, so then reject the `release` environment for that run, and create that Release by hand as described at the end.
3. Create the `release` environment (Settings → Environments) and make yourself its required reviewer, before the first tag: GitHub creates an environment that a job names but that does not exist yet, without any protection. Allowing only `v*` tags to deploy to it is a good idea as well.

### Each release

1. On `extra-tools`, through a pull request as usual, update:
   - the version in `package.json`, in the root of `package-lock.json`, in `mcpb/manifest.json` and in the npx examples of `README.md` and `README.zh-CN.md`; `npm test` fails while one of them differs;
   - `CHANGELOG.md`: rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` (that section becomes the Release notes), and add a new, empty `## [Unreleased]` above it if you like.
2. If you like, a dry run: `gh workflow run release.yml --ref <branch>` runs `verify` only, never `publish`. Without a tag, it checks the manifest and the CHANGELOG against the version in `package.json` and skips the branch check, so it fails while `CHANGELOG.md` has no section for that version. GitHub offers a manual run only once the workflow file is on the default branch (`extra-tools`); `--ref` can then name another branch.
3. Tag the release commit on `extra-tools` and push the tag to this repository: `git tag vX.Y.Z <commit>`, then `git push <remote> vX.Y.Z`. Tags without the `v`, like upstream's `1.0.0` to `2.0.4`, do not start the workflow.
4. When `verify` has passed, look over its run and approve the `release` environment.
5. Afterwards, check that the npm page of the package shows provenance (not for a version you published by hand, which has none), that the Release has the `.tgz` and the `.mcpb`, that the README's download link (Releases/latest) gives that `.mcpb`, and that `npx -y @yxengram/minecraft-mcp-autopilot@X.Y.Z --version` prints `X.Y.Z`.

A published version can be unpublished only within 72 hours; after that, `npm deprecate` it instead. If `npm publish` succeeded but creating the Release failed, running the job again stops at `npm publish`: create the Release by hand from the files of the run (the `release` artifact) with `gh release create vX.Y.Z <tgz> <mcpb> --verify-tag --notes-file release-notes.md`.
