import type mineflayer from 'mineflayer';
import { serverRegistryName } from '../server-registries.js';
import { quoteUntrusted } from '../format.js';

type Block = NonNullable<ReturnType<mineflayer.Bot['blockAt']>>;

const FACE_NAMES = ['bottom', 'top', 'north side', 'south side', 'west side', 'east side'];

export function faceName(face: number | undefined): string | undefined {
  return typeof face === 'number' ? FACE_NAMES[face] : undefined;
}

function biomeName(bot: mineflayer.Bot, block: Block): string | undefined {
  const biome = (block as { biome?: { id?: number; name?: string } }).biome;
  if (!biome) return undefined;
  if (biome.name) return biome.name;
  return typeof biome.id === 'number' ? serverRegistryName(bot, 'worldgen/biome', biome.id) : undefined;
}

function signText(block: Block): string[] {
  if (!/_sign$/.test(block.name) || typeof block.getSignText !== 'function') return [];
  const [front = '', back = ''] = block.getSignText();
  const clean = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean).join(' / ');
  const lines: string[] = [];
  // Players write sign text, so it is quoted and escaped like chat (E-035).
  if (clean(front)) lines.push(`Sign text (front): ${quoteUntrusted(clean(front))}`);
  if (clean(back)) lines.push(`Sign text (back): ${quoteUntrusted(clean(back))}`);
  if (lines.length === 0) lines.push('Sign text: blank');
  return lines;
}

/** Block state, light, biome and sign text, one fact per line. */
export function blockDetails(bot: mineflayer.Bot, block: Block): string[] {
  const lines: string[] = [];
  try {
    const properties = typeof block.getProperties === 'function' ? block.getProperties() : {};
    const state = Object.entries(properties ?? {}).map(([key, value]) => `${key}=${value}`);
    if (state.length > 0) lines.push(`State: ${state.join(', ')}`);

    const { light, skyLight } = block as { light?: number; skyLight?: number };
    if (typeof light === 'number' && typeof skyLight === 'number') {
      lines.push(`Light: ${light} from blocks, ${skyLight} from the sky`);
    }

    const biome = biomeName(bot, block);
    if (biome) lines.push(`Biome: ${biome}`);

    lines.push(...signText(block));
  } catch {
    // Missing block data must not break block queries.
  }
  return lines;
}
