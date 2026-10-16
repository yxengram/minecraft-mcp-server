// Contract: docs/BLUEPRINT.md F-008.
import { z } from 'zod';
import minecraftData from 'minecraft-data';
import { BehaviorDefinition } from '../task-manager.js';
import { checkTarget } from '../threats.js';
import { combatSettings, engage } from '../combat.js';
import { countItems } from '../../tools/item-utils.js';
import { collectNearbyDrops, waitWhilePaused } from './actions.js';

export const MAX_HUNT_COUNT = 16;
// minecraft-data categories of living mobs; items, orbs, projectiles and vehicles cannot be attacked (the server
// kicks a client that tries).
const LIVING_CATEGORIES = new Set(['animal', 'passive', 'hostile', 'mob', 'ambient', 'water_creature']);
export const DEFAULT_HUNT_TIMEOUT_MS = 120000;

const schema = z.object({
  animal: z.string().trim().min(1).transform(name => name.toLowerCase())
    .refine(name => name !== 'player', 'Players cannot be hunted')
    .describe("Entity type to hunt, e.g. 'cow', 'pig', 'chicken', 'sheep', 'rabbit'"),
  count: z.coerce.number().int().min(1).max(MAX_HUNT_COUNT).default(1).describe(`How many to kill (default: 1, max: ${MAX_HUNT_COUNT})`),
  maxDistance: z.coerce.number().finite().positive().max(64).default(32).describe('Search and chase distance (default: 32)'),
  timeoutMs: z.coerce.number().int().min(1000).default(DEFAULT_HUNT_TIMEOUT_MS).describe(`Stop after this many milliseconds and report progress (default: ${DEFAULT_HUNT_TIMEOUT_MS})`)
});

type HuntParams = z.infer<typeof schema>;

export const huntBehavior: BehaviorDefinition<HuntParams, null> = {
  name: 'hunt',
  description: 'Kill a number of animals of one type and pick up their drops; never players or tamed animals',
  schema,
  summarize: params => `${params.count} ${params.animal} within ${params.maxDistance} blocks`,
  prepare: (bot, params) => {
    const info = minecraftData(bot.version).entitiesByName[params.animal];
    if (!info) return { error: `Unknown entity type: ${params.animal}` };
    if (!LIVING_CATEGORIES.has(info.type)) return { error: `${params.animal} is not a mob and cannot be hunted` };
    return { value: null };
  },
  async run(ctx) {
    const { bot, params, services, signal, isPaused, setStep, report } = ctx;
    const { animal, count, maxDistance } = params;
    const huntRules = () => ({ ...combatSettings(services.policy).rules, allowTypes: [animal] });
    const itemsBefore = countItems(bot.inventory.items());
    const deadline = Date.now() + params.timeoutMs;
    // Targets that got away or could not be reached are not chased again.
    const ignored = new Set<number>();
    let kills = 0;
    let stopReason = '';

    while (kills < count) {
      if (!(await waitWhilePaused(ctx, deadline)) || Date.now() > deadline) {
        stopReason = 'time limit reached';
        break;
      }

      setStep(`searching for ${animal}`);
      const self = bot.entity.position;
      const target = Object.values(bot.entities ?? {})
        .filter(entity => entity?.name === animal && entity.position && !ignored.has(entity.id)
          && entity.position.distanceTo(self) <= maxDistance && checkTarget(bot, entity, huntRules()).legal)
        .sort((a, b) => a.position.distanceTo(self) - b.position.distanceTo(self))[0];
      if (!target) {
        stopReason = `no huntable ${animal} within ${maxDistance} blocks`;
        break;
      }

      setStep(`chasing ${animal} (id ${target.id})`);
      const fight = await engage(bot, target, {
        signal,
        shouldStop: () => isPaused() || Date.now() > deadline,
        maxChase: maxDistance,
        retreatHealth: combatSettings(services.policy).retreatHealth,
        rules: huntRules()
      });
      signal.throwIfAborted();

      if (fight.outcome === 'killed') {
        kills++;
        report(`killed ${animal} (${kills} of ${count})`);
        setStep('collecting drops');
        await collectNearbyDrops(ctx, fight.lastPosition, deadline);
      } else if (fight.outcome === 'retreated') {
        stopReason = 'health too low to keep hunting';
        break;
      } else if (fight.outcome !== 'cancelled') {
        // lost, out_of_range or illegal_target: try another one.
        ignored.add(target.id);
        report(`gave up on ${animal} (id ${target.id}): ${fight.detail}`);
      }
    }

    const gained = countItems(bot.inventory.items()) - itemsBefore;
    let text = `Killed ${kills} of ${count} ${animal}; inventory gained ${gained} item(s)`;
    if (stopReason) text += `. Stopped: ${stopReason}`;
    if (kills === 0) throw new Error(text);
    return text;
  }
};
