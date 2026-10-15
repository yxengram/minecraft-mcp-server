import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';

export const VERSION = '1.21.8';
const mcData = minecraftData(VERSION);
const EMPTY = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'water', 'lava', 'torch']);

export interface WorldOptions {
  /** Block name at a position, or null when the chunk is not loaded. */
  blockAt: (x: number, y: number, z: number) => string | null;
  position?: Vec3;
  yaw?: number;
  entities?: Record<number, unknown>;
}

export function createVisionBot({ blockAt, position = new Vec3(0.5, 64, 0.5), yaw = 0, entities = {} }: WorldOptions) {
  const block = (pos: Vec3) => {
    const name = blockAt(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    if (name === null) return null;
    return { name, position: pos.floored(), boundingBox: EMPTY.has(name) ? 'empty' : 'block', type: mcData.blocksByName[name]?.id };
  };

  const self = { id: 1, position, yaw };
  return {
    version: VERSION,
    game: { dimension: 'overworld', minY: -64, height: 384 },
    entity: self,
    entities: { 1: self, ...entities },
    blockAt: block,
    findBlocks: ({ matching, maxDistance, point }: { matching: number[]; maxDistance: number; point: Vec3 }) => {
      const ids = new Set(matching);
      const found: Vec3[] = [];
      const r = Math.ceil(maxDistance);
      const center = point.floored();
      for (let x = center.x - r; x <= center.x + r; x++) {
        for (let y = center.y - r; y <= center.y + r; y++) {
          for (let z = center.z - r; z <= center.z + r; z++) {
            const pos = new Vec3(x, y, z);
            const info = block(pos);
            if (info && ids.has(info.type) && pos.distanceTo(point) <= maxDistance) found.push(pos);
          }
        }
      }
      return found.sort((a, b) => a.distanceTo(point) - b.distanceTo(point));
    }
  };
}
