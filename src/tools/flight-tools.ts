import { z } from "zod";
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { ToolFactory, type ToolContext } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';
import { throwIfAborted } from './movement-utils.js';

function createCancellableFlightOperation(
  bot: mineflayer.Bot,
  destination: Vec3,
  controller: AbortController
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let aborted = false;

    controller.signal.addEventListener('abort', () => {
      aborted = true;
      bot.creative.stopFlying();
      reject(new Error("Flight operation cancelled"));
    });

    bot.creative.flyTo(destination)
      .then(() => {
        if (!aborted) {
          resolve(true);
        }
      })
      .catch((err: Error) => {
        if (!aborted) {
          reject(err);
        }
      });
  });
}

export function registerFlightTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "fly-to",
    "Make the bot fly to a specific position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate")
    },
    async ({ x, y, z }, ctx: ToolContext) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();

      if (!bot.creative) {
        return factory.createResponse("Creative mode is not available. Cannot fly.");
      }

      const controller = new AbortController();
      const FLIGHT_TIMEOUT_MS = 20000;

      const timeoutId = setTimeout(() => {
        if (!controller.signal.aborted) {
          controller.abort();
        }
      }, FLIGHT_TIMEOUT_MS);
      // The call's abort (E-027) ends the flight the same way as the time limit, but is not reported as a timeout.
      const onAbort = () => controller.abort();
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      try {
        throwIfAborted(ctx.signal);
        const destination = new Vec3(x, y, z);
        await createCancellableFlightOperation(bot, destination, controller);
        return factory.createResponse(`Successfully flew to position (${x}, ${y}, ${z}).`);
      } catch (error) {
        throwIfAborted(ctx.signal);
        if (controller.signal.aborted) {
          const currentPosAfterTimeout = bot.entity.position;
          return factory.createErrorResponse(
            `Flight timed out after ${FLIGHT_TIMEOUT_MS / 1000} seconds. The destination may be unreachable. ` +
            `Current position: (${Math.floor(currentPosAfterTimeout.x)}, ${Math.floor(currentPosAfterTimeout.y)}, ${Math.floor(currentPosAfterTimeout.z)})`
          );
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
        ctx.signal.removeEventListener('abort', onAbort);
        bot.creative.stopFlying();
      }
    }
  );
}
