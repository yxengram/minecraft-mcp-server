import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';

type Goal = InstanceType<typeof pathfinderPkg.goals.Goal>;

// pathfinder.stop() only raises a flag that is cleared when the bot reaches its next path node.
// If no path is active the flag stays set and silently cancels the next goal, so clear it right away.
export function stopPathfinder(bot: mineflayer.Bot): void {
  bot.pathfinder.stop();
  bot.pathfinder.setGoal(null);
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
