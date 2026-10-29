import { z } from "zod";
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { ToolFactory, type ToolContext } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';
import { throwIfAborted } from './movement-utils.js';
import { formatPosition } from './entity-utils.js';

// mineflayer's flyTo only moves the bot's position and does not check for collisions: outside these modes the server
// pulls the bot back or kicks it for flying (E-032).
const FLYING_MODES = new Set(['creative', 'spectator']);
// How long the bot stays without gravity after flyTo before its position is checked: by then a server that refused the
// move has pulled it back (E-032).
const FLIGHT_SETTLE_MS = 300;
// How far from the target a flight may end and still count as arrived.
const FLIGHT_TOLERANCE = 1.5;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
      // The wait belongs to the flight: the time limit and the call's abort end it the same way.
      .then(() => sleep(FLIGHT_SETTLE_MS))
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
    "Fly in a straight line to a position. Creative or spectator mode only; the line must be clear of blocks",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate")
    },
    async ({ x, y, z }, ctx: ToolContext) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();

      // Refused before any flight: stopFlying restores the gravity flyTo saved, so it must not run without a flight.
      const mode = bot.game.gameMode;
      if (!FLYING_MODES.has(mode)) {
        return factory.createErrorResponse(
          `fly-to needs creative or spectator mode; the bot is in ${mode} mode. Walk with move-to-position instead`);
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
        // A copy: flyTo makes the Vec3 it is given the bot's position object, and a server correction changes that in
        // place, which would also move `destination` and hide the pull-back.
        await createCancellableFlightOperation(bot, destination.clone(), controller);
        const at = bot.entity.position;
        const off = at.distanceTo(destination);
        if (off > FLIGHT_TOLERANCE) {
          return factory.createErrorResponse(
            `Flight ended at ${formatPosition(at)}, ${off.toFixed(1)} blocks from (${x}, ${y}, ${z}): the server did not accept the move (blocked path?)`);
        }
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
