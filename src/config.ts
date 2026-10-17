import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

export interface ServerConfig {
  host: string;
  port: number;
  username: string;
  waypointFile?: string;
  /** Decision model id for chat triage and chat commands (BLUEPRINT E-006); the API key comes only from OPENROUTER_API_KEY. */
  decisionModel?: string;
}

export function parseConfig(): ServerConfig {
  return yargs(hideBin(process.argv))
    .option('host', {
      type: 'string',
      description: 'Minecraft server host',
      default: 'localhost'
    })
    .option('port', {
      type: 'number',
      description: 'Minecraft server port',
      default: 25565
    })
    .option('username', {
      type: 'string',
      description: 'Bot username',
      default: 'LLMBot'
    })
    .option('waypoint-file', {
      type: 'string',
      description: 'JSON file used to store waypoints (default: ~/.minecraft-mcp-server/waypoints.json)'
    })
    .option('decision-model', {
      type: 'string',
      description: 'OpenRouter decision model id used to sort chat (needs OPENROUTER_API_KEY in the environment)'
    })
    .help()
    .alias('help', 'h')
    .parseSync();
}
