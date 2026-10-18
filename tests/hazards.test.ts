// Contract: docs/BLUEPRINT.md F-036 (src/autopilot/hazards.ts): the nearest water within 8 blocks, found with a
// bounded scan (never mineflayer's whole-chunk findBlock), cached for 1 s per block the bot stands on, and water the
// bot just failed to reach ignored for 15 s. Moved here from tests/reflexes.test.ts when hazard-escape was removed
// (M8); the rest of hazards.ts is covered by tests/instinct.test.ts (F-041). Expected values come from the contract.
import test, { ExecutionContext } from 'ava';
import sinon from 'sinon';
import { Vec3 } from 'vec3';
import { markWaterUnreachable, nearestWater } from '../src/autopilot/hazards.js';

const TICK = 50;
const EMPTY_BLOCKS = new Set(['air', 'cave_air', 'water']);

/** A bot at (0.5, 64, 0.5) on stone (below y 64) and air (from y 64), with the given blocks by "x,y,z". */
function createWorld(blocks: Record<string, string> = {}) {
  const named = new Map(Object.entries(blocks));
  const self = { id: 1, position: new Vec3(0.5, 64, 0.5), metadata: [] as unknown[] };
  const bot = {
    entity: self,
    blockAt(pos: Vec3) {
      const p = pos.floored();
      const name = named.get(`${p.x},${p.y},${p.z}`) ?? (p.y < 64 ? 'stone' : 'air');
      return { name, position: p, boundingBox: EMPTY_BLOCKS.has(name) ? 'empty' : 'block' };
    },
    findBlock() {
      throw new Error('findBlock must not be used');
    }
  };
  return { bot, self };
}

function useClock(t: ExecutionContext) {
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  return clock;
}

test.serial('nearestWater: finds the nearest water within 8 blocks with a bounded scan, without findBlock', (t) => {
  useClock(t);
  const at = (blocks: Record<string, string>) => {
    const world = createWorld(blocks);
    const findBlock = sinon.spy(world.bot, 'findBlock');
    const blockAt = sinon.spy(world.bot, 'blockAt');
    const water = nearestWater(world.bot as never);
    t.true(findBlock.notCalled, 'no findBlock (it scans whole chunk sections)');
    t.true(blockAt.callCount <= 17 * 17 * 4, `a bounded scan (${blockAt.callCount} lookups)`);
    return water ? water.toArray() : null;
  };

  t.deepEqual(at({ '8,64,0': 'water' }), [8, 64, 0], 'water 8 blocks away');
  t.is(at({ '9,64,0': 'water' }), null, 'water 9 blocks away is too far');
  t.is(at({ '6,64,6': 'water' }), null, 'water 8.5 blocks away diagonally is too far');
  t.deepEqual(at({ '5,64,0': 'water', '-3,63,0': 'water' }), [-3, 63, 0], 'the nearer of two');
  t.is(at({}), null, 'no water');
});

test.serial('nearestWater: the result is reused for 1 s while the bot stays on the same block', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ '6,64,0': 'water' });
  const blockAt = sinon.spy(world.bot, 'blockAt');

  t.deepEqual(nearestWater(world.bot as never)?.toArray(), [6, 64, 0]);
  const scan = blockAt.callCount;
  t.true(scan > 0);

  await clock.tickAsync(TICK);
  world.self.position = new Vec3(0.8, 64, 0.2);
  t.deepEqual(nearestWater(world.bot as never)?.toArray(), [6, 64, 0]);
  t.is(blockAt.callCount, scan, 'no lookups on the next tick on the same block');

  world.self.position = new Vec3(1.5, 64, 0.5);
  t.deepEqual(nearestWater(world.bot as never)?.toArray(), [6, 64, 0]);
  t.true(blockAt.callCount > scan, 'another block is scanned again');
  const moved = blockAt.callCount;

  await clock.tickAsync(500);
  nearestWater(world.bot as never);
  t.is(blockAt.callCount, moved, 'still cached within the second');
  await clock.tickAsync(600);
  nearestWater(world.bot as never);
  t.true(blockAt.callCount > moved, 'scanned again after 1 s');
});

test.serial('nearestWater: water marked unreachable is skipped for 15 s, at once and without waiting for the cache', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ '3,64,0': 'water', '-6,64,0': 'water' });

  t.deepEqual(nearestWater(world.bot as never)?.toArray(), [3, 64, 0], 'the nearer water first');
  markWaterUnreachable(world.bot as never, new Vec3(3, 64, 0));
  t.deepEqual(nearestWater(world.bot as never)?.toArray(), [-6, 64, 0], 'right away, the other water instead');

  await clock.tickAsync(14000);
  t.deepEqual(nearestWater(world.bot as never)?.toArray(), [-6, 64, 0], 'still skipped after 14 s');
  await clock.tickAsync(1100);
  t.deepEqual(nearestWater(world.bot as never)?.toArray(), [3, 64, 0], 'offered again after 15 s');

  const alone = createWorld({ '3,64,0': 'water' });
  markWaterUnreachable(alone.bot as never, new Vec3(3, 64, 0));
  t.is(nearestWater(alone.bot as never), null, 'with no other water, there is none to offer');
});
