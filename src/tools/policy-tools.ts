// Contract: docs/BLUEPRINT.md F-018 (M3 scope: get-policy and set-policy; list-decision-models arrives in M4).
import { ToolFactory } from '../tool-factory.js';
import type { Autopilot } from '../autopilot/autopilot.js';
import type { EventStore } from '../event-store.js';
import { combatUpdateSchema, describePolicy, reflexesUpdateSchema } from '../autopilot/policy.js';

export function registerPolicyTools(factory: ToolFactory, getAutopilot: () => Autopilot, events: EventStore): void {
  factory.registerTool(
    "get-policy",
    "Show the autopilot policy: which reflexes are on and their thresholds, the self-defense stance and the combat rules. The policy goes back to its defaults whenever the bot (re)joins the game",
    {},
    async () => {
      const autopilot = getAutopilot();
      const lines = [describePolicy(autopilot.policy.get())];
      if (autopilot.isReady()) {
        const running = autopilot.reflexes.current();
        lines.push('', running ? `Reflex running now: ${running.name} (${running.reason}; ${(running.ms / 1000).toFixed(1)}s)` : 'No reflex is running');
        const { ticks, averageMs, maxMs } = autopilot.reflexes.timing();
        lines.push(`Reflex checks: ${ticks} ticks, ${averageMs.toFixed(3)} ms on average, ${maxMs.toFixed(2)} ms at most`);
      }
      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "set-policy",
    "Change part of the autopilot policy; fields you leave out keep their values, unknown fields are rejected. Example: { \"reflexes\": { \"autoEat\": { \"enabled\": false }, \"selfDefense\": { \"stance\": \"flee\" } }, \"combat\": { \"retreatHealth\": 8 } }. Reflexes: creeperEvade {enabled}, hazardEscape {enabled, lowAir}, lowHealthRetreat {enabled, health, radius}, selfDefense {enabled, stance: fight|flee|auto}, autoEat {enabled, food}. Combat: attackPlayers, avoidNeutral, retreatHealth. Health and food are 0-20, radius 1-32",
    {
      reflexes: reflexesUpdateSchema.optional().describe("Reflex settings to change"),
      combat: combatUpdateSchema.optional().describe("Combat rules to change")
    },
    async (args: Record<string, unknown>) => {
      const autopilot = getAutopilot();
      // The policy resets when the bot joins, so a change made before that would be lost without notice.
      if (!autopilot.isReady()) return factory.createErrorResponse('The bot is not in the game yet; the policy is reset to its defaults when it joins. Try again once it has joined');
      const result = autopilot.policy.update(args, 'llm');
      if (!result.ok) return factory.createErrorResponse(`Policy unchanged: ${result.errors.join('; ')}`);
      if (result.changed.length > 0) {
        events.addEvent('policy', `set-policy changed ${result.changed.join(', ')}`);
      }
      for (const warning of result.warnings) events.addEvent('policy', warning);
      const header = result.changed.length > 0 ? `Changed: ${result.changed.join(', ')}` : 'Nothing changed (the values were already set)';
      return factory.createResponse([header, ...result.warnings, '', describePolicy(result.policy)].join('\n'));
    },
    { strict: true }
  );
}
