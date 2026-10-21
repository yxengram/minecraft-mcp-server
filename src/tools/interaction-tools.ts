import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';
import { approachEntity, entityLabel, resolveTargetEntity } from './entity-utils.js';
import { isAir, overlapsBot, PLACE_REACH, sleep } from './block-utils.js';
import { bedWakeWarning, wokeUpInsideBlock } from './terrain-utils.js';

const BLOCK_REACH = 4;
const ENTITY_REACH = 3;
const DEFAULT_ENTITY_SEARCH = 16;
const DISMOUNT_WAIT_MS = 600;
const SNEAK_HOLD_MS = 300;
// The server moves the player off the bed right after waking; check where the head ended up after that (E-014).
export const WAKE_SETTLE_MS = 1000;
// How long a right-click may take to show in the world before activate-block calls it "no visible change" (E-017).
export const ACTIVATE_SETTLE_MS = 300;
// How long use-item waits for the held item or the target cell to change (E-017).
export const USE_ITEM_WAIT_MS = 1000;
const USE_ITEM_POLL_MS = 50;
// use-item refuses to pour lava this close to another player (E-017, user decision 2026-10-22).
export const LAVA_PLAYER_RADIUS = 10;
const EYE_HEIGHT = 1.62;
const FACES = [
  new Vec3(0, -1, 0), new Vec3(0, 1, 0),
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1), new Vec3(0, 0, -1)
];

type BlockLike = { name: string; stateId?: number; boundingBox?: string; getProperties?: () => Record<string, unknown> };

/**
 * What use-item and activate-block compare before and after (E-017): the held item (with its wear, so lighting a fire
 * counts), the target cell and any `also` cells (activate-block: the cell above the clicked top face, where a fire or
 * a lit portal appears), and the open window.
 */
function snapshot(bot: mineflayer.Bot, pos: Vec3 | null, also: Vec3[] = []) {
  const held = bot.heldItem as { name: string; count: number; durabilityUsed?: number } | null;
  const block = pos ? (bot.blockAt(pos) as BlockLike | null) : null;
  const describe = (cell: BlockLike | null) => (cell ? `${cell.name}#${cell.stateId ?? ''}` : 'unloaded');
  return {
    held: held ? `${held.name} x${held.count}` : 'nothing',
    heldName: held?.name ?? null,
    wear: held?.durabilityUsed ?? null,
    cell: [block, ...also.map(other => bot.blockAt(other) as BlockLike | null)].map(describe).join(' '),
    cellName: block?.name ?? 'an unloaded block',
    window: (bot as { currentWindow?: unknown }).currentWindow ?? null
  };
}

type Snapshot = ReturnType<typeof snapshot>;
const changed = (a: Snapshot, b: Snapshot) => a.held !== b.held || a.wear !== b.wear || a.cell !== b.cell || a.window !== b.window;

function dimensionName(bot: mineflayer.Bot): string | undefined {
  const dimension = (bot.game as { dimension?: string } | undefined)?.dimension;
  return dimension?.replace(/^minecraft:/, '');
}

function isLiquidSource(block: BlockLike | null): boolean {
  if (!block) return false;
  if (block.name === 'powder_snow') return true;
  if (block.name !== 'water' && block.name !== 'lava') return false;
  const level = block.getProperties?.().level;
  return level === undefined || Number(level) === 0;
}

/** Fills a cell when used: water, lava, powder snow and the buckets with a fish or axolotl in them; not milk. */
function isFilledBucket(name: string): boolean {
  return name.endsWith('_bucket') && name !== 'milk_bucket';
}

/** Where to look so the server's ray from the eyes lands on the target cell (E-017). */
function aimFor(bot: mineflayer.Bot, pos: Vec3, item: string): { point: Vec3 } | { error: string } {
  const block = bot.blockAt(pos) as BlockLike | null;
  const center = pos.offset(0.5, 0.5, 0.5);
  const at = `(${pos.x}, ${pos.y}, ${pos.z})`;
  if (item === 'bucket') {
    if (!isLiquidSource(block)) return { error: `An empty bucket needs a liquid source block at ${at}; it holds ${block?.name ?? 'an unloaded block'}` };
    return { point: center };
  }
  if (isFilledBucket(item)) {
    // The server's ray passes through liquids and the liquid goes into the cell next to the face it hits, so aim at a
    // face of a solid neighbour that the eyes can see. A lava cell can be the target: water poured there turns the
    // lava around it into obsidian (the live test's lava lake had nothing solid next to the air above it).
    if (block && !isAir(block) && block.boundingBox !== 'empty') return { error: `Cannot empty ${item} into ${at}: it holds ${block.name}` };
    const eyes = bot.entity.position.offset(0, EYE_HEIGHT, 0);
    const raycast = (bot.world as { raycast?: (from: Vec3, dir: Vec3, range: number) => { position: Vec3 } | null } | undefined)?.raycast;
    for (const offset of FACES) {
      const reference = bot.blockAt(pos.plus(offset)) as BlockLike | null;
      if (!reference || isAir(reference) || reference.boundingBox === 'empty') continue;
      const point = center.plus(offset.scaled(0.5));
      if (raycast) {
        const hit = raycast.call(bot.world, eyes, point.minus(eyes).normalize(), PLACE_REACH + 1);
        if (!hit || !hit.position.equals(pos.plus(offset))) continue;
      }
      return { point };
    }
    return { error: `Cannot empty ${item} into ${at}: no solid block next to it that the bot can aim at from here` };
  }
  return { point: center };
}

/** Why pouring lava into the cell is refused (E-017), or null. */
function lavaProblem(bot: mineflayer.Bot, pos: Vec3): string | null {
  const feet = bot.entity.position.floored();
  const dy = pos.y - feet.y;
  if (Math.abs(pos.x - feet.x) <= 1 && Math.abs(pos.z - feet.z) <= 1 && dy >= -1 && dy <= 2) {
    return 'the cell is in or next to the bot itself';
  }
  const center = pos.offset(0.5, 0.5, 0.5);
  const near = Object.values(bot.players ?? {}).find(player => player.username !== bot.username && player.entity &&
    player.entity.position.distanceTo(center) <= LAVA_PLAYER_RADIUS);
  return near ? `${near.username} is within ${LAVA_PLAYER_RADIUS} blocks of it` : null;
}

function findInventoryItem(bot: mineflayer.Bot, itemName: string) {
  const name = itemName.toLowerCase();
  const items = bot.inventory.items();
  return items.find(item => item.name === name) ?? items.find(item => item.name.includes(name));
}

export function registerInteractionTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  const entityTarget = {
    entityId: z.coerce.number().int().optional().describe("Entity id from list-entities"),
    type: z.string().optional().describe("If no entityId is given, use the nearest entity matching this type/name or player username"),
    maxDistance: z.coerce.number().finite().positive().optional().describe(`Search distance when using type (default: ${DEFAULT_ENTITY_SEARCH})`)
  };

  factory.registerTool(
    "activate-block",
    "Right-click a block: open doors and trapdoors, press buttons, flip levers, use note blocks, etc. Use read-container for chests",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate")
    },
    async ({ x, y, z }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));
      const bot = getBot();
      const pos = new Vec3(x, y, z).floored();
      const block = bot.blockAt(pos);

      if (!block || block.name === 'air') {
        return factory.createErrorResponse(`No block at (${pos.x}, ${pos.y}, ${pos.z})`);
      }

      const center = pos.offset(0.5, 0.5, 0.5);
      if (bot.entity.position.distanceTo(center) > BLOCK_REACH) {
        await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2));
      }

      await bot.lookAt(center, true);
      // activateBlock clicks the top face, so a fire or a lit portal shows up in the cell above.
      const above = [pos.offset(0, 1, 0)];
      const before = snapshot(bot, pos, above);
      await bot.activateBlock(block);
      // A water bucket "activated" grass and reported success with nothing poured (E-017).
      await sleep(ACTIVATE_SETTLE_MS);
      const after = snapshot(bot, pos, above);
      const hint = changed(before, after) ? '' :
        `; no visible change${before.heldName ? `; to use the held ${before.heldName} on a liquid or into the air, use use-item` : ''}`;
      return factory.createResponse(`Activated ${block.name} at (${pos.x}, ${pos.y}, ${pos.z})${hint}`);
    }
  );

  factory.registerTool(
    "use-item",
    "Use (right-click) an item: fill or empty a bucket (water, lava, powder snow), throw a snowball or ender pearl, etc. With a position, aims at that cell: an empty bucket needs a liquid source there; a filled bucket pours into it from a solid neighbour. Reports what changed, and fails when nothing did. Refuses to pour lava next to the bot or within 10 blocks of another player. Use activate-block for doors and levers and consume for food",
    {
      itemName: z.string().optional().describe("Item to equip and use (default: the held item)"),
      x: z.coerce.number().optional().describe("X coordinate of the cell to use it on (omit all three to use it where the bot looks)"),
      y: z.coerce.number().optional().describe("Y coordinate"),
      z: z.coerce.number().optional().describe("Z coordinate")
    },
    async ({ itemName, x, y, z }) => {
      const bot = getBot();
      const given = [x, y, z].filter(value => value !== undefined).length;
      if (given !== 0 && given !== 3) return factory.createErrorResponse('Give all of x, y and z, or none of them');

      if (itemName) {
        const item = findInventoryItem(bot, itemName);
        if (!item) return factory.createErrorResponse(`No ${itemName} in the inventory`);
        if (bot.heldItem?.name !== item.name) await bot.equip(item, 'hand');
      }
      const held = bot.heldItem;
      if (!held) return factory.createErrorResponse('Not holding anything to use');

      let pos: Vec3 | null = null;
      if (given === 3) {
        ({ x, y, z } = coerceCoordinates(x!, y!, z!));
        pos = new Vec3(x, y, z).floored();
        if (held.name === 'lava_bucket') {
          const problem = lavaProblem(bot, pos);
          if (problem) return factory.createErrorResponse(`Refusing to pour lava at (${pos.x}, ${pos.y}, ${pos.z}): ${problem}`);
        }
        const eyes = () => bot.entity.position.offset(0, EYE_HEIGHT, 0);
        if (eyes().distanceTo(pos.offset(0.5, 0.5, 0.5)) > PLACE_REACH) {
          await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3));
        }
        if (overlapsBot(bot, pos)) return factory.createErrorResponse(`The bot stands in (${pos.x}, ${pos.y}, ${pos.z}); use the item from next to it`);
        // Checked again where the bot ended up: the walk may have brought it next to the cell.
        if (held.name === 'lava_bucket') {
          const problem = lavaProblem(bot, pos);
          if (problem) return factory.createErrorResponse(`Refusing to pour lava at (${pos.x}, ${pos.y}, ${pos.z}): ${problem}`);
        }
        const aim = aimFor(bot, pos, held.name);
        if ('error' in aim) return factory.createErrorResponse(aim.error);
        await bot.lookAt(aim.point, true);
      }

      const before = snapshot(bot, pos);
      bot.activateItem();
      let after = before;
      // The emptied bucket arrives before the block update (live test): with a target, wait for the cell itself.
      const settled = () => (pos ? after.cell !== before.cell : changed(before, after));
      for (let waited = 0; waited < USE_ITEM_WAIT_MS && !settled(); waited += USE_ITEM_POLL_MS) {
        await sleep(USE_ITEM_POLL_MS);
        after = snapshot(bot, pos);
      }
      bot.deactivateItem();

      const at = pos ? ` at (${pos.x}, ${pos.y}, ${pos.z})` : '';
      if (!changed(before, after)) {
        const cell = pos ? `the cell is still ${after.cellName} and ` : '';
        return factory.createErrorResponse(`Used ${held.name}${at} but nothing changed: ${cell}the bot still holds ${after.held}`);
      }
      if (pos && after.cell === before.cell) {
        return factory.createErrorResponse(`Used ${held.name}${at}, but the cell is still ${after.cellName}; the bot now holds ${after.held}, so it took effect somewhere else`);
      }
      const cell = pos ? `: the cell is now ${after.cellName}` : '';
      return factory.createResponse(`Used ${held.name}${at}${cell}; holding ${after.held}`);
    }
  );

  factory.registerTool(
    "activate-entity",
    "Right-click an entity: interact with a villager, feed or shear an animal, etc. Walks closer if needed",
    entityTarget,
    async ({ entityId, type, maxDistance = DEFAULT_ENTITY_SEARCH }) => {
      const bot = getBot();
      const resolved = resolveTargetEntity(bot, { entityId, type, maxDistance });
      if ('error' in resolved) {
        return factory.createErrorResponse(resolved.error);
      }

      await approachEntity(bot, resolved.entity, ENTITY_REACH);
      await bot.activateEntity(resolved.entity);
      return factory.createResponse(`Interacted with ${entityLabel(resolved.entity)} (id ${resolved.entity.id})`);
    }
  );

  factory.registerTool(
    "sleep",
    "Sleep in a bed. Uses the given bed position, or the nearest bed. Only works at night or during thunderstorms",
    {
      x: z.coerce.number().optional().describe("X coordinate of a bed (omit to find the nearest bed)"),
      y: z.coerce.number().optional().describe("Y coordinate of a bed"),
      z: z.coerce.number().optional().describe("Z coordinate of a bed"),
      maxDistance: z.coerce.number().finite().positive().optional().describe("Search distance when no position is given (default: 32)")
    },
    async ({ x, y, z, maxDistance = 32 }) => {
      const bot = getBot();

      if (bot.isSleeping) {
        return factory.createResponse("Already sleeping");
      }

      // Checked before looking for a bed: using one outside the overworld blows it up (E-017).
      const dimension = dimensionName(bot);
      if (dimension && dimension !== 'overworld') {
        return factory.createErrorResponse(`Beds explode in ${dimension}; the bot did not use the bed`);
      }

      let bed;
      if (x !== undefined && y !== undefined && z !== undefined) {
        ({ x, y, z } = coerceCoordinates(x, y, z));
        bed = bot.blockAt(new Vec3(x, y, z).floored());
        if (!bed || !bot.isABed(bed)) {
          return factory.createErrorResponse(`No bed at (${Math.floor(x)}, ${Math.floor(y)}, ${Math.floor(z)})`);
        }
      } else {
        bed = bot.findBlock({ matching: (block) => bot.isABed(block), maxDistance });
        if (!bed) {
          return factory.createErrorResponse(`No bed found within ${maxDistance} blocks`);
        }
      }

      if (bot.entity.position.distanceTo(bed.position) > 3) {
        await bot.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2));
      }

      await bot.sleep(bed);
      const warning = bedWakeWarning(bot, bed);
      return factory.createResponse(`Sleeping in ${bed.name} at (${bed.position.x}, ${bed.position.y}, ${bed.position.z})${warning ? `; ${warning}` : ''}`);
    }
  );

  factory.registerTool(
    "wake",
    "Get out of bed",
    {},
    async () => {
      const bot = getBot();
      if (!bot.isSleeping) {
        return factory.createResponse("Not sleeping");
      }
      await bot.wake();
      await sleep(WAKE_SETTLE_MS);
      return factory.createResponse(wokeUpInsideBlock(bot) ?? "Woke up");
    }
  );

  factory.registerTool(
    "mount-entity",
    "Ride an entity such as a horse, boat or minecart. Walks closer if needed",
    entityTarget,
    async ({ entityId, type, maxDistance = DEFAULT_ENTITY_SEARCH }) => {
      const bot = getBot();
      const resolved = resolveTargetEntity(bot, { entityId, type, maxDistance });
      if ('error' in resolved) {
        return factory.createErrorResponse(resolved.error);
      }

      await approachEntity(bot, resolved.entity, ENTITY_REACH);
      bot.mount(resolved.entity);
      return factory.createResponse(`Mounting ${entityLabel(resolved.entity)} (id ${resolved.entity.id})`);
    }
  );

  factory.registerTool(
    "dismount",
    "Get off the entity the bot is currently riding",
    {},
    async () => {
      const bot = getBot();
      const riding = () => Boolean((bot as unknown as { vehicle?: unknown }).vehicle);
      if (!riding()) {
        return factory.createResponse("Not riding anything");
      }

      bot.dismount();
      await sleep(DISMOUNT_WAIT_MS);

      // Newer servers only let the player off with the sneak key, which bot.dismount() does not press.
      if (riding()) {
        bot.setControlState('sneak', true);
        await sleep(SNEAK_HOLD_MS);
        bot.setControlState('sneak', false);
        await sleep(DISMOUNT_WAIT_MS);
      }

      if (riding()) {
        return factory.createErrorResponse("Still riding after trying to dismount");
      }
      return factory.createResponse("Dismounted");
    }
  );
}
