import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';

type Goal = InstanceType<typeof pathfinderPkg.goals.Goal>;

// pathfinder.stop() only raises a flag that is cleared when the bot reaches its next path node.
// If no path is active the flag stays set and silently cancels the next goal, so clear it right away.
export function stopPathfinder(bot: mineflayer.Bot): void {
  bot.pathfinder.stop();
  bot.pathfinder.setGoal(null);
}

/**
 * Why the bot is not where it was sent, or null when it arrived within `range` (plus a block of slack). The
 * pathfinder can report success without having moved, e.g. when the bot is boxed in (M7).
 */
export function arrivalProblem(bot: mineflayer.Bot, target: { x: number; y: number; z: number }, range: number): string | null {
  const at = bot.entity.position.floored();
  const distance = Math.hypot(at.x - Math.floor(target.x), at.y - Math.floor(target.y), at.z - Math.floor(target.z));
  if (distance <= range + 1) return null;
  return `stopped at (${at.x}, ${at.y}, ${at.z}), ${distance.toFixed(1)} blocks from the target: the pathfinder found no way closer`;
}

export async function gotoWithTimeout(bot: mineflayer.Bot, goal: Goal, timeoutMs?: number): Promise<void> {
  const gotoPromise = bot.pathfinder.goto(goal);
  if (timeoutMs === undefined) {
    await gotoPromise;
    return;
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Move timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([gotoPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
    if (timedOut) {
      stopPathfinder(bot);
      gotoPromise.catch(() => {});
    }
  }
}
