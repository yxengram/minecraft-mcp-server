// Contract: docs/BLUEPRINT.md F-005.
import { z } from 'zod';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { BehaviorDefinition, delay } from '../task-manager.js';
import { BotEntity, refreshEntity } from '../../tools/entity-utils.js';
import { stopPathfinder } from '../../tools/movement-utils.js';
import { describeTarget, needsTarget, resolveTarget, TARGET_REQUIRED, targetLabel, targetShape } from './target.js';

const CHECK_INTERVAL_MS = 250;
const HOLD_MS = 2000;
const STUCK_MS = 5000;
const MIN_PROGRESS = 0.5;

const schema = z.object({
  ...targetShape,
  distance: z.coerce.number().finite().min(2).max(64).default(16).describe('Distance to get away to (default: 16)')
}).refine(needsTarget, TARGET_REQUIRED);

type FleeParams = z.infer<typeof schema>;

export const fleeBehavior: BehaviorDefinition<FleeParams, BotEntity> = {
  name: 'flee',
  description: 'Run away from a player or entity until far enough away',
  schema,
  summarize: params => `from ${describeTarget(params)}, distance ${params.distance}`,
  prepare: (bot, params) => resolveTarget(bot, params),
  async run({ bot, params, prepared, signal, isPaused, waitUntilRunning, setStep }) {
    let entity = prepared;
    const label = targetLabel(entity);
    let goal: InstanceType<typeof goals.GoalInvert> | null = null;
    let best = 0;
    let lastProgressAt = Date.now();
    let reachedSince: number | null = null;

    for (;;) {
      if (isPaused()) {
        goal = null;
        await waitUntilRunning();
        // Time spent paused does not count as being stuck or as holding the distance.
        lastProgressAt = Date.now();
        reachedSince = null;
        continue;
      }

      const live = refreshEntity(bot, entity);
      if (!live) {
        stopPathfinder(bot);
        return `${label} is gone`;
      }

      if (!goal || live !== entity || bot.pathfinder.goal !== goal) {
        entity = live;
        goal = new goals.GoalInvert(new goals.GoalFollow(live, params.distance));
        bot.pathfinder.setGoal(goal, true);
      }

      const distance = bot.entity.position.distanceTo(live.position);
      setStep(`fleeing from ${label} (${distance.toFixed(1)} of ${params.distance} blocks)`);

      const now = Date.now();
      if (distance >= params.distance) {
        reachedSince ??= now;
        if (now - reachedSince >= HOLD_MS) {
          stopPathfinder(bot);
          return `Reached ${distance.toFixed(1)} blocks from ${label}`;
        }
      } else {
        reachedSince = null;
        if (distance > best + MIN_PROGRESS) {
          best = distance;
          lastProgressAt = now;
        } else if (now - lastProgressAt > STUCK_MS) {
          throw new Error(`cannot get further away from ${label} (stuck at ${distance.toFixed(1)} blocks)`);
        }
      }

      await delay(CHECK_INTERVAL_MS, signal);
    }
  }
};
