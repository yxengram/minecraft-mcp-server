import type mineflayer from 'mineflayer';

// Data-driven registries (biomes, enchantments, damage types, ...) are sent by the server during login and
// can differ from minecraft-data, so remember the entry order the server used for each bot.
const registries = new WeakMap<object, Map<string, string[]>>();

export function trackServerRegistries(bot: mineflayer.Bot): void {
  const known = new Map<string, string[]>();
  registries.set(bot, known);
  bot._client.on('registry_data', (packet: { id?: string; entries?: { key: string }[] }) => {
    if (typeof packet.id === 'string' && Array.isArray(packet.entries)) {
      known.set(packet.id.replace(/^minecraft:/, ''), packet.entries.map(entry => entry.key.replace(/^minecraft:/, '')));
    }
  });
}

/** Name of entry `index` in a server registry such as 'damage_type' or 'worldgen/biome'. */
export function serverRegistryName(bot: mineflayer.Bot, registry: string, index: number): string | undefined {
  return registries.get(bot)?.get(registry)?.[index];
}
