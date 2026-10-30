// Contract: docs/BLUEPRINT.md F-018: get-policy, set-policy (M3) and list-decision-models (M4). Never prints the API key (I4).
// E-036: the decision model's health from the key check, shown the same way here, in get-observation, in the instinct
// events and on stderr. E-037: a pause after a failure shows the same way, and the Spend line counts every request.
import { ToolFactory } from '../tool-factory.js';
import type { Autopilot } from '../autopilot/autopilot.js';
import type { EventStore } from '../event-store.js';
import type { DecisionHealth, SpendStats } from '../decisions/openrouter-client.js';
import { chatUpdateSchema, combatUpdateSchema, decisionsUpdateSchema, describePolicy, instinctUpdateSchema } from '../autopilot/policy.js';

/** "HH:MM UTC" for the time of a check or of the last decision that succeeded. */
function checkedAt(at: number | undefined): string {
  return at === undefined ? 'an unknown time' : `${new Date(at).toISOString().slice(11, 16)} UTC`;
}

/** "OFFLINE (<reason>)", or during a pause (E-037) "OFFLINE for 7 more s (paused after HTTP 429)". */
function offlineState(health: DecisionHealth): string {
  return health.pausedMs !== undefined ? `OFFLINE for ${Math.ceil(health.pausedMs / 1000)} more s (${health.reason})` : `OFFLINE (${health.reason})`;
}

/** "$0.0081"; amounts under a hundredth of a cent get two more decimals, since one decision costs about $0.00002. */
function dollars(amount: number): string {
  return `$${amount > 0 && amount < 0.0001 ? amount.toFixed(6) : amount.toFixed(4)}`;
}

/**
 * "Spend since the server started: 412 call(s) (instinct 380 incl. 12 second requests, chat 30, check 2), 3 failed;
 * $0.0081 reported, about $0.0004 estimated for 20 call(s) without a cost" (E-037).
 */
export function spendLine(spend: SpendStats): string {
  const uncosted = spend.withoutCost === 0
    ? ''
    : spend.estimatedCost === null
      ? `, unknown for ${spend.withoutCost} call(s) without a cost`
      : `, about ${dollars(spend.estimatedCost)} estimated for ${spend.withoutCost} call(s) without a cost`;
  return `Spend since the server started: ${spend.calls} call(s) (instinct ${spend.instinct} incl. ${spend.secondRequests} second requests, ` +
    `chat ${spend.chat}, check ${spend.check}), ${spend.failed} failed; ${dollars(spend.reportedCost)} reported${uncosted}`;
}

/** The key's state for the Decision model line of get-policy. */
function keyState(health: DecisionHealth): string {
  if (health.state === 'offline') return offlineState(health);
  if (health.state === 'online') return `key checked at ${checkedAt(health.at)}`;
  return `key not checked yet${health.reason ? ` (${health.reason})` : ''}`;
}

/**
 * What the instinct can do now (E-036), for the Instinct line of get-policy and get-observation alike. An OFFLINE health
 * comes first, then the policy switches, then a failed last request; otherwise online or not checked yet. Before the
 * bot has joined there is no instinct engine, and so no last request to report.
 */
export function instinctState(autopilot: Autopilot): string {
  const health = autopilot.decisions.health();
  if (health.state === 'offline') return `${offlineState(health)}: the bot does not react to dangers by itself`;
  const policy = autopilot.policy.get();
  if (!policy.instinct.enabled) return 'turned off in the policy';
  if (!policy.decisions.enabled) {
    return 'offline (decisions are turned off in the policy); dangers are only reported as instinct events, the bot does not act on them';
  }
  const offline = autopilot.isReady() ? autopilot.instinct.status().offline : null;
  // A backoff was no request, and every 429 starts a pause, so a throttled last request is that pause (E-037): it shows
  // as the health while it lasts, and the health from before it once it is over.
  if (offline && !offline.startsWith('backoff:') && !offline.startsWith('throttled:')) return `offline at the last request (${offline}); dangers are left to you`;
  if (health.state === 'online') return `online (key checked at ${checkedAt(health.at)})`;
  return `not checked yet${health.reason ? ` (${health.reason})` : ''}`;
}

export function registerPolicyTools(factory: ToolFactory, getAutopilot: () => Autopilot, events: EventStore): void {
  factory.registerTool(
    "get-policy",
    "Show the autopilot policy: the instinct (the decision model choosing what to do about dangers) and whether it is online, the combat rules, the chat settings and the decision model. The policy goes back to its defaults whenever the bot (re)joins the game",
    {},
    async () => {
      const autopilot = getAutopilot();
      const lines = [describePolicy(autopilot.policy.get())];
      const status = autopilot.decisions.status();
      // Shown before the bot joins too: the server checks the key when it starts.
      const key = keyState(autopilot.decisions.health());
      lines.push('', !status.configured
        ? `Decision model: disabled, ${key}; chat is sorted by rules: whispers and messages naming the bot are reported`
        : `Decision model: ${status.enabled ? 'enabled' : 'turned off in the policy'}, ${status.model}, ${key}; ${status.callsLastHour} call(s) in the last hour`);
      lines.push(spendLine(autopilot.decisions.spend()));
      if (autopilot.isReady()) {
        const instinct = autopilot.instinct.status();
        lines.push('');
        lines.push(`Instinct: ${instinctState(autopilot)}; ${status.instinctCallsLastMinute} call(s) in the last minute`);
        lines.push(instinct.running ? `Instinct action running now: ${instinct.running.action} (${(instinct.running.ms / 1000).toFixed(1)}s; ${instinct.running.reason})` : 'No instinct action is running');
        if (instinct.lastDecision) lines.push(`Last instinct decision: ${instinct.lastDecision}`);
        const { ticks, averageMs, maxMs } = instinct.timing;
        lines.push(`Instinct checks: ${ticks} ticks, ${averageMs.toFixed(3)} ms on average, ${maxMs.toFixed(2)} ms at most`);
      }
      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "set-policy",
    "Change part of the autopilot policy; fields you leave out keep their values, unknown fields are rejected. Example: { \"instinct\": { \"intent\": \"exploring an underwater cave on purpose\" }, \"combat\": { \"retreatHealth\": 8 } }. Instinct (the decision model chooses what to do about fire, lava, water, creepers, attacks, low health and hunger): enabled, intent (up to 300 characters telling it what you are doing, so it does not rescue the bot from a situation it is in on purpose), lowAir, lowHealth, hostileRadius, food, reaskMs, actThreshold, urgentThreshold (0-1), maxCallsPerMinute. Combat: attackPlayers, avoidNeutral, retreatHealth. Chat: triage (report messages meant for the bot), commandsFrom (list of player names whose clear commands such as 'follow me' run without asking you; empty by default, replaces the whole list), replyInChat. Decisions: enabled, model, actThreshold, cautiousThreshold (0-1), maxCallsPerMinute. Health and food are 0-20, radius 1-32",
    {
      instinct: instinctUpdateSchema.optional().describe("Instinct settings to change"),
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
          ? factory.createResponse(`Not configured: ${catalog.message}. Without a key the instinct is offline: the bot does not react to dangers by itself; chat is sorted by rules`)
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
