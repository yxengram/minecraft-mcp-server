// Contract: docs/BLUEPRINT.md F-004.
import { z } from 'zod';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { BehaviorDefinition, delay } from '../task-manager.js';
import { BotEntity, refreshEntity } from '../../tools/entity-utils.js';
import { stopPathfinder } from '../../tools/movement-utils.js';
import { describeTarget, needsTarget, resolveTarget, TARGET_REQUIRED, targetLabel, targetShape } from './target.js';

const CHECK_INTERVAL_MS = 250;
const LOST_TIMEOUT_MS = 10000;

const schema = z.object({
  ...targetShape,
  range: z.coerce.number().finite().min(1).max(16).default(3).describe('How close to stay to the target (default: 3)')
}).refine(needsTarget, TARGET_REQUIRED);

type FollowParams = z.infer<typeof schema>;

export const followBehavior: BehaviorDefinition<FollowParams, BotEntity> = {
  name: 'follow',
  description: 'Keep following a player or entity until cancelled',
  schema,
  summarize: params => `target ${describeTarget(params)}, range ${params.range}`,
  prepare: (bot, params) => resolveTarget(bot, params),
  async run({ bot, params, prepared, signal, isPaused, waitUntilRunning, setStep, report }) {
    let entity = prepared;
    const label = targetLabel(entity);
    let goal: InstanceType<typeof goals.GoalFollow> | null = null;
    let lostSince: number | null = null;

    for (;;) {
      if (isPaused()) {
        goal = null;
        await waitUntilRunning();
        continue;
      }

      const live = refreshEntity(bot, entity);
      if (!live) {
        if (goal) {
          stopPathfinder(bot);
          goal = null;
        }
        if (lostSince === null) {
          lostSince = Date.now();
          report(`lost sight of ${label}`);
        } else if (Date.now() - lostSince > LOST_TIMEOUT_MS) {
          throw new Error(`target lost: ${label} not seen for ${LOST_TIMEOUT_MS / 1000}s`);
        }
        setStep(`${label} out of sight`);
      } else {
        if (lostSince !== null) {
          lostSince = null;
          report(`found ${label} again`);
        }
        // Re-apply the goal whenever something else cleared it (a pause, a reflex) or the entity object changed.
        if (!goal || live !== entity || bot.pathfinder.goal !== goal) {
          entity = live;
          goal = new goals.GoalFollow(live, params.range);
          bot.pathfinder.setGoal(goal, true);
        }
        setStep(`following ${label} (distance ${bot.entity.position.distanceTo(live.position).toFixed(1)})`);
      }

      await delay(CHECK_INTERVAL_MS, signal);
    }
  }
};
