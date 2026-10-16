// Contract: docs/BLUEPRINT.md F-006.
import { z } from 'zod';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { BehaviorDefinition, delay } from '../task-manager.js';
import { legalHostilesNear } from '../threats.js';
import { DEFAULT_RETREAT_HEALTH, engage } from '../combat.js';
import { BotEntity, entityLabel, formatPosition, refreshEntity } from '../../tools/entity-utils.js';
import { stopPathfinder } from '../../tools/movement-utils.js';
import { resolveWaypoint } from './actions.js';
import { resolveTarget, targetLabel, targetShape } from './target.js';

const CHECK_INTERVAL_MS = 250;
const LOST_TIMEOUT_MS = 15000;
const POST_RANGE = 3;
// A mob that got away or could not be reached is left alone for a while instead of being chased in a loop.
const IGNORE_MS = 10000;
// Not getting any closer to the post for this long is reported once (the pathfinder may have no path); guarding goes on.
const RETURN_STALL_MS = 5000;
const MIN_RETURN_PROGRESS = 0.5;
// GoalFollow only re-anchors after the player moves 3 blocks and works on whole blocks, so a follower can rest a few
// blocks further than its range. Only a larger gap counts as not getting back.
const FOLLOW_SLACK = 4;

const schema = z.object({
  ...targetShape,
  waypoint: z.string().trim().min(1).optional().describe('Guard a saved waypoint'),
  x: z.coerce.number().finite().optional().describe('Guard this position (with y and z)'),
  y: z.coerce.number().finite().optional(),
  z: z.coerce.number().finite().optional(),
  radius: z.coerce.number().finite().min(2).max(24).default(8).describe('Attack hostile mobs this close to the guarded player or post (default: 8)'),
  maxChase: z.coerce.number().finite().min(4).max(64).default(16).describe('Stop chasing a mob once it is this far from the guarded player or post (default: 16; never less than radius)')
}).refine(params => [params.x, params.y, params.z].every(value => value === undefined) || [params.x, params.y, params.z].every(value => value !== undefined),
  'Give all of x, y and z, or none')
  .refine(params => [params.entityId !== undefined || params.target !== undefined, params.waypoint !== undefined, params.x !== undefined].filter(Boolean).length <= 1,
    'Guard one thing: a player or entity (entityId / target), a waypoint, or a position (x, y, z)');

type GuardParams = z.infer<typeof schema>;

// A mob inside the radius must always be worth chasing, so the chase limit is never below the radius.
const chaseLimit = (params: GuardParams) => Math.max(params.maxChase, params.radius);
type Post = { kind: 'entity'; entity: BotEntity } | { kind: 'point'; position: Vec3; label: string };

function describe(params: GuardParams): string {
  if (params.target !== undefined) return params.target;
  if (params.entityId !== undefined) return `entity ${params.entityId}`;
  if (params.waypoint !== undefined) return `waypoint ${params.waypoint}`;
  if (params.x !== undefined) return `position ${formatPosition({ x: params.x, y: params.y!, z: params.z! })}`;
  return 'current position';
}

export const guardBehavior: BehaviorDefinition<GuardParams, Post> = {
  name: 'guard',
  description: 'Guard a player (bodyguard) or a place: kill hostile mobs that come close, then return; never attacks players, animals or neutral mobs',
  schema,
  summarize: params => `${describe(params)}, radius ${params.radius}, max chase ${chaseLimit(params)}`,
  prepare: (bot, params, services) => {
    if (params.entityId !== undefined || params.target !== undefined) {
      const resolved = resolveTarget(bot, params);
      return 'error' in resolved ? resolved : { value: { kind: 'entity', entity: resolved.value } };
    }
    if (params.waypoint !== undefined) {
      const resolved = resolveWaypoint(bot, services, params.waypoint);
      return 'error' in resolved
        ? resolved
        : { value: { kind: 'point', position: resolved.value.position, label: `waypoint ${resolved.value.name}` } };
    }
    const position = params.x !== undefined
      ? new Vec3(params.x, params.y!, params.z!)
      : bot.entity.position.floored().offset(0.5, 0, 0.5);
    return { value: { kind: 'point', position, label: formatPosition(position) } };
  },
  async run({ bot, params, prepared, signal, isPaused, waitUntilRunning, setStep, report }) {
    let guarded = prepared.kind === 'entity' ? prepared.entity : null;
    const label = prepared.kind === 'entity' ? targetLabel(prepared.entity) : prepared.label;
    const ignoredUntil = new Map<number, number>();
    let goal: InstanceType<typeof goals.Goal> | null = null;
    let lostSince: number | null = null;
    let kills = 0;
    let closestToPost = Infinity;
    let stalledSince: number | null = null;
    let reportedStall = false;
    const resetReturn = () => {
      closestToPost = Infinity;
      stalledSince = null;
      reportedStall = false;
    };

    for (;;) {
      if (isPaused()) {
        goal = null;
        resetReturn();
        await waitUntilRunning();
        continue;
      }

      // Where the post is right now: next to the guarded player, or the fixed point.
      let post: Vec3;
      if (prepared.kind === 'entity') {
        const live = guarded ? refreshEntity(bot, guarded) : null;
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
          await delay(CHECK_INTERVAL_MS, signal);
          continue;
        }
        if (lostSince !== null) {
          lostSince = null;
          report(`found ${label} again`);
        }
        if (live !== guarded) goal = null;
        guarded = live;
        post = live.position;
      } else {
        post = prepared.position;
      }

      const now = Date.now();
      const fitToFight = typeof bot.health !== 'number' || bot.health > DEFAULT_RETREAT_HEALTH;
      const threat = fitToFight
        ? legalHostilesNear(bot, post, params.radius).find(({ entity }) => (ignoredUntil.get(entity.id) ?? 0) <= now)
        : undefined;

      if (threat) {
        const mob = threat.entity;
        const mobLabel = `${entityLabel(mob)} (id ${mob.id})`;
        setStep(`chasing ${mobLabel}`);
        const anchorEntity = guarded;
        const fight = await engage(bot, mob, {
          signal,
          shouldStop: isPaused,
          maxChase: chaseLimit(params),
          anchor: () => (anchorEntity ? refreshEntity(bot, anchorEntity)?.position ?? post : post),
          retreatHealth: DEFAULT_RETREAT_HEALTH
        });
        signal.throwIfAborted();
        // The fight cleared the pathfinder; the return trip sets a new goal.
        goal = null;
        resetReturn();

        if (fight.outcome === 'killed') {
          kills++;
          report(`killed ${entityLabel(mob)} (${kills} kill${kills === 1 ? '' : 's'})`);
        } else if (fight.outcome === 'out_of_range' || fight.outcome === 'lost' || fight.outcome === 'illegal_target') {
          ignoredUntil.set(mob.id, Date.now() + IGNORE_MS);
          report(`stopped chasing ${mobLabel}: ${fight.detail}`);
        } else if (fight.outcome === 'retreated') {
          report(`too hurt to keep fighting: ${fight.detail}`);
        }
        continue;
      }

      // No fight: stay at the post.
      const distance = bot.entity.position.distanceTo(post);
      if (prepared.kind === 'entity') {
        if (!goal || bot.pathfinder.goal !== goal) {
          goal = new goals.GoalFollow(guarded!, POST_RANGE);
          bot.pathfinder.setGoal(goal, true);
        }
      } else if (distance > POST_RANGE && (!goal || bot.pathfinder.goal !== goal)) {
        goal = new goals.GoalNear(post.x, post.y, post.z, POST_RANGE - 1);
        bot.pathfinder.setGoal(goal);
      }
      const stallDistance = prepared.kind === 'entity' ? POST_RANGE + FOLLOW_SLACK : POST_RANGE;
      if (distance > stallDistance) {
        if (distance < closestToPost - MIN_RETURN_PROGRESS) {
          closestToPost = distance;
          stalledSince = null;
        } else {
          stalledSince ??= now;
          if (!reportedStall && now - stalledSince > RETURN_STALL_MS) {
            reportedStall = true;
            report(`cannot get back to ${label} (${distance.toFixed(1)} blocks away, no path?); still guarding`);
            // Ask the pathfinder again on the next check.
            goal = null;
          }
        }
      } else {
        resetReturn();
      }
      const status = fitToFight ? `${kills} kill${kills === 1 ? '' : 's'}` : 'too hurt to fight';
      setStep(distance > POST_RANGE ? `returning to ${label} (${distance.toFixed(1)} blocks away; ${status})` : `guarding ${label} (${status})`);

      await delay(CHECK_INTERVAL_MS, signal);
    }
  }
};
