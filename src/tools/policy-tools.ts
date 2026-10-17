// Contract: docs/BLUEPRINT.md F-018: get-policy, set-policy (M3) and list-decision-models (M4). Never prints the API key (I4).
import { ToolFactory } from '../tool-factory.js';
import type { Autopilot } from '../autopilot/autopilot.js';
import type { EventStore } from '../event-store.js';
import { chatUpdateSchema, combatUpdateSchema, decisionsUpdateSchema, describePolicy, reflexesUpdateSchema } from '../autopilot/policy.js';

export function registerPolicyTools(factory: ToolFactory, getAutopilot: () => Autopilot, events: EventStore): void {
  factory.registerTool(
    "get-policy",
    "Show the autopilot policy: which reflexes are on and their thresholds, the self-defense stance and the combat rules. The policy goes back to its defaults whenever the bot (re)joins the game",
    {},
    async () => {
      const autopilot = getAutopilot();
      const lines = [describePolicy(autopilot.policy.get())];
      const status = autopilot.decisions.status();
      lines.push('', !status.configured
        ? 'Decision model: disabled (no OPENROUTER_API_KEY); chat is sorted by rules: whispers and messages naming the bot are reported'
        : `Decision model: ${status.enabled ? 'enabled' : 'turned off in the policy'}, ${status.model}; ${status.callsLastHour} call(s) in the last hour`);
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
    "Change part of the autopilot policy; fields you leave out keep their values, unknown fields are rejected. Example: { \"reflexes\": { \"autoEat\": { \"enabled\": false }, \"selfDefense\": { \"stance\": \"flee\" } }, \"combat\": { \"retreatHealth\": 8 } }. Reflexes: creeperEvade {enabled}, hazardEscape {enabled, lowAir}, lowHealthRetreat {enabled, health, radius}, selfDefense {enabled, stance: fight|flee|auto}, autoEat {enabled, food}. Combat: attackPlayers, avoidNeutral, retreatHealth. Chat: triage (report messages meant for the bot), commandsFrom (list of player names whose clear commands such as 'follow me' run without asking you; empty by default, replaces the whole list), replyInChat. Decisions: enabled, model, actThreshold, cautiousThreshold (0-1), maxCallsPerMinute. Health and food are 0-20, radius 1-32",
    {
      reflexes: reflexesUpdateSchema.optional().describe("Reflex settings to change"),
      combat: combatUpdateSchema.optional().describe("Combat rules to change"),
      chat: chatUpdateSchema.optional().describe("Chat settings to change"),
      decisions: decisionsUpdateSchema.optional().describe("Decision model settings to change")
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

  factory.registerTool(
    "list-decision-models",
    "List the decision models OpenRouter offers right now (id, context length, price), to pick one for set-policy decisions.model. Needs OPENROUTER_API_KEY",
    {},
    async () => {
      const autopilot = getAutopilot();
      const catalog = await autopilot.decisions.listModels();
      if (!catalog.ok) {
        return catalog.error === 'disabled'
          ? factory.createResponse(`Not configured: ${catalog.message}. Without a key, chat is sorted by rules and everything else works as usual`)
          : factory.createErrorResponse(`Could not read the catalog (${catalog.error}): ${catalog.message}`);
      }
      const current = autopilot.policy.get().decisions.model;
      const lines = catalog.models.map(model => {
        const parts = [model.id];
        if (model.canonicalSlug && model.canonicalSlug !== model.id) parts.push(`pinned id ${model.canonicalSlug}`);
        if (model.contextLength) parts.push(`context ${model.contextLength}`);
        if (model.promptPrice) parts.push(`$${(Number(model.promptPrice) * 1e6).toFixed(3)} per million input tokens`);
        if (model.id === current || model.canonicalSlug === current) parts.push('(in use)');
        return `- ${parts.join(', ')}`;
      });
      return factory.createResponse([`${catalog.models.length} decision model(s); in use: ${current}`, ...lines].join('\n'));
    }
  );
}
