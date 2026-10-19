// Contract: docs/BLUEPRINT.md F-009.
import { z } from 'zod';
import type mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { BehaviorDefinition } from '../task-manager.js';
import { DeadlineReached, resolveWaypoint, ResolvedWaypoint, walkTo } from './actions.js';
import { bedWakeWarning } from '../../tools/terrain-utils.js';

export const DEFAULT_RETURN_TIMEOUT_MS = 120000;
const ARRIVE_RANGE = 3;
const BED_SEARCH_RADIUS = 8;
const STEP_UPDATE_MS = 500;
// The same window mineflayer and the server accept for sleeping.
const NIGHT_START = 12541;
const NIGHT_END = 23458;

const schema = z.object({
  waypoint: z.string().trim().min(1).default('home').describe("Waypoint to go to (default: 'home')"),
  sleep: z.boolean().default(true).describe('At night, sleep in a bed near the waypoint (default: true)'),
  timeoutMs: z.coerce.number().int().min(1000).default(DEFAULT_RETURN_TIMEOUT_MS).describe(`Give up after this many milliseconds (default: ${DEFAULT_RETURN_TIMEOUT_MS})`)
});

type ReturnHomeParams = z.infer<typeof schema>;

export function canSleepNow(bot: mineflayer.Bot): boolean {
  if (bot.thunderState > 0) return true;
  const time = bot.time?.timeOfDay;
  return typeof time === 'number' && time >= NIGHT_START && time <= NIGHT_END;
}

export const returnHomeBehavior: BehaviorDefinition<ReturnHomeParams, ResolvedWaypoint> = {
  name: 'return-home',
  description: "Walk to a saved waypoint (default 'home') and, at night, sleep in a bed next to it",
  schema,
  summarize: params => `waypoint ${params.waypoint}${params.sleep ? ', sleep at night' : ''}`,
  prepare: (bot, params, services) => resolveWaypoint(bot, services, params.waypoint),
  async run(ctx) {
    const { bot, params, prepared: home, signal, setStep } = ctx;
    const deadline = Date.now() + params.timeoutMs;
    const where = `waypoint '${home.name}'`;
    const { x, y, z } = home.position;

    const showDistance = () => setStep(`walking to ${where} (${bot.entity.position.distanceTo(home.position).toFixed(1)} blocks left)`);
    showDistance();
    const ticker = setInterval(showDistance, STEP_UPDATE_MS);
    try {
      await walkTo(ctx, new goals.GoalNear(x, y, z, ARRIVE_RANGE - 1), deadline);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof DeadlineReached) throw new Error(`could not reach ${where} within ${params.timeoutMs / 1000}s`);
      throw new Error(`could not reach ${where}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearInterval(ticker);
    }

    const distance = bot.entity.position.distanceTo(home.position);
    if (distance > ARRIVE_RANGE) throw new Error(`stopped ${distance.toFixed(1)} blocks from ${where}`);
    const arrived = `Arrived at ${where}`;
    if (!params.sleep) return arrived;
    if (bot.isSleeping) return `${arrived}; already sleeping`;
    if (!canSleepNow(bot)) return `${arrived} (daytime, no need to sleep)`;

    setStep('looking for a bed');
    const bed = bot.findBlock({ point: home.position, matching: block => bot.isABed(block), maxDistance: BED_SEARCH_RADIUS });
    if (!bed) return `${arrived}; no bed within ${BED_SEARCH_RADIUS} blocks to sleep in`;
    const bedAt = `${bed.name} at (${bed.position.x}, ${bed.position.y}, ${bed.position.z})`;

    if (bot.entity.position.distanceTo(bed.position) > 2) {
      try {
        await walkTo(ctx, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), deadline);
      } catch (error) {
        signal.throwIfAborted();
        return `${arrived} but could not reach the ${bedAt}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    setStep(`getting into the ${bedAt}`);
    try {
      await bot.sleep(bed);
    } catch (error) {
      signal.throwIfAborted();
      return `${arrived} but could not sleep in the ${bedAt}: ${error instanceof Error ? error.message : String(error)}`;
    }
    // Cancelled while getting into bed: get up again.
    if (signal.aborted) {
      await bot.wake().catch(() => {});
      signal.throwIfAborted();
    }
    const warning = bedWakeWarning(bot, bed);
    return `${arrived} and sleeping in the ${bedAt}${warning ? `; ${warning}` : ''}`;
  }
};
