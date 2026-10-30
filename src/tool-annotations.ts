import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

// Every tool's title and annotations (BLUEPRINT F-055), and the only source of the tool list: tools/list must name
// exactly these tools, and the number of tools comes from here alone. A tool is added or removed in this table in the
// same commit. The annotations are hints (the SDK says so), but a client may approve a readOnlyHint tool by itself or
// warn before a destructiveHint one, so the owner approved the classes (Q31, 2026-10-29). openWorldHint is left
// unset, which means true. Whether a tool needs the action lease is not decided here (BODY_TOOLS in tool-factory.ts).

/**
 * - read: only reads the world, inventory, events and policy in memory (list-decision-models reads OpenRouter's model
 *   catalog); does not move the bot or change the world.
 * - safe: changes the bot's own state, but does not dig, place or use anything up, and does not walk with the
 *   pathfinder.
 * - destructive: everything else. It walks with the pathfinder (which digs and places blocks on the way), digs,
 *   places or attacks; uses up, drops, trades, crafts or smelts items, or moves them in and out of containers; starts
 *   or resumes a task; changes the policy; or writes or deletes a waypoint. Body tools are never read.
 */
export type ToolClass = 'read' | 'safe' | 'destructive';

export interface ToolRow {
  readonly name: string;
  /** A short English title for clients to show. */
  readonly title: string;
  readonly class: ToolClass;
  /** A safe tool that may be called again with no further effect (cancel-task, stop-pathfinding, stop-all). */
  readonly idempotent?: boolean;
}

const CLASS_ANNOTATIONS: Record<ToolClass, ToolAnnotations> = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  safe: { readOnlyHint: false, destructiveHint: false },
  destructive: { readOnlyHint: false, destructiveHint: true }
};

export const TOOL_TABLE: readonly ToolRow[] = [
  { name: 'get-position', title: 'Get position', class: 'read' },
  { name: 'get-block-info', title: 'Get block info', class: 'read' },
  { name: 'find-blocks', title: 'Find blocks', class: 'read' },
  { name: 'get-cursor-target', title: 'Get cursor target', class: 'read' },
  { name: 'read-chat', title: 'Read chat', class: 'read' },
  { name: 'list-recipes', title: 'List recipes', class: 'read' },
  { name: 'get-recipe', title: 'Get recipe', class: 'read' },
  { name: 'can-craft', title: 'Check if craftable', class: 'read' },
  { name: 'find-entity', title: 'Find entity', class: 'read' },
  { name: 'list-entities', title: 'List entities', class: 'read' },
  { name: 'list-players', title: 'List players', class: 'read' },
  { name: 'get-events', title: 'Get events', class: 'read' },
  { name: 'wait-for-event', title: 'Wait for event', class: 'read' },
  { name: 'detect-gamemode', title: 'Detect game mode', class: 'read' },
  { name: 'get-observation', title: 'Get observation', class: 'read' },
  { name: 'list-inventory', title: 'List inventory', class: 'read' },
  { name: 'find-item', title: 'Find item', class: 'read' },
  { name: 'get-policy', title: 'Get policy', class: 'read' },
  { name: 'list-decision-models', title: 'List decision models', class: 'read' },
  { name: 'list-tasks', title: 'List tasks', class: 'read' },
  { name: 'list-waypoints', title: 'List waypoints', class: 'read' },
  { name: 'ground-height', title: 'Get ground height', class: 'read' },
  { name: 'scan-area', title: 'Scan area', class: 'read' },
  { name: 'render-map', title: 'Render map', class: 'read' },

  { name: 'look-at', title: 'Look at position', class: 'safe' },
  { name: 'jump', title: 'Jump', class: 'safe' },
  { name: 'move-in-direction', title: 'Move in direction', class: 'safe' },
  { name: 'equip-item', title: 'Equip item', class: 'safe' },
  { name: 'unequip-item', title: 'Unequip item', class: 'safe' },
  { name: 'fly-to', title: 'Fly to position', class: 'safe' },
  { name: 'wake', title: 'Wake up', class: 'safe' },
  { name: 'dismount', title: 'Dismount', class: 'safe' },
  { name: 'cancel-task', title: 'Cancel task', class: 'safe', idempotent: true },
  { name: 'stop-pathfinding', title: 'Stop pathfinding', class: 'safe', idempotent: true },
  { name: 'stop-all', title: 'Stop everything', class: 'safe', idempotent: true },

  { name: 'activate-block', title: 'Activate block', class: 'destructive' },
  { name: 'activate-entity', title: 'Activate entity', class: 'destructive' },
  { name: 'attack-entity', title: 'Attack entity', class: 'destructive' },
  { name: 'clear-region', title: 'Clear region', class: 'destructive' },
  { name: 'collect-block', title: 'Collect blocks', class: 'destructive' },
  { name: 'consume', title: 'Eat or drink', class: 'destructive' },
  { name: 'container-deposit', title: 'Deposit into container', class: 'destructive' },
  { name: 'container-withdraw', title: 'Withdraw from container', class: 'destructive' },
  { name: 'craft-item', title: 'Craft item', class: 'destructive' },
  { name: 'delete-waypoint', title: 'Delete waypoint', class: 'destructive' },
  { name: 'dig-block', title: 'Dig block', class: 'destructive' },
  { name: 'dig-tunnel', title: 'Dig tunnel', class: 'destructive' },
  { name: 'fill-region', title: 'Fill region', class: 'destructive' },
  { name: 'flee-from', title: 'Flee from entity', class: 'destructive' },
  { name: 'follow-entity', title: 'Follow entity', class: 'destructive' },
  { name: 'goto-waypoint', title: 'Go to waypoint', class: 'destructive' },
  { name: 'lead-animal', title: 'Lead animal', class: 'destructive' },
  // Walks to the villager with the pathfinder, like read-container to the container (Q31).
  { name: 'list-trades', title: 'List villager trades', class: 'destructive' },
  { name: 'mount-entity', title: 'Mount entity', class: 'destructive' },
  { name: 'move-to-position', title: 'Move to position', class: 'destructive' },
  { name: 'place-block', title: 'Place block', class: 'destructive' },
  { name: 'read-container', title: 'Read container', class: 'destructive' },
  { name: 'resume-task', title: 'Resume task', class: 'destructive' },
  // With --allow-commands it runs server commands such as /kill or /fill; always destructive is simplest.
  { name: 'send-chat', title: 'Send chat message', class: 'destructive' },
  { name: 'set-policy', title: 'Set policy', class: 'destructive' },
  { name: 'set-waypoint', title: 'Set waypoint', class: 'destructive' },
  { name: 'sleep', title: 'Sleep in bed', class: 'destructive' },
  { name: 'smelt-item', title: 'Smelt item', class: 'destructive' },
  { name: 'start-task', title: 'Start task', class: 'destructive' },
  { name: 'toss-item', title: 'Toss items', class: 'destructive' },
  { name: 'trade', title: 'Trade with villager', class: 'destructive' },
  { name: 'use-item', title: 'Use item', class: 'destructive' }
];

/** The names in the table, in its order: the tool list, and its length the number of tools. */
export const TOOL_NAMES: readonly string[] = TOOL_TABLE.map(row => row.name);

// A Map, not an object: a name such as 'constructor' must not find anything.
const ROWS = new Map(TOOL_TABLE.map(row => [row.name, row]));

/**
 * The title and annotations registerTool gives a tool (E-044). Undefined for a name not in the table, so a tool a test
 * registers for itself is left as it is. Each call returns new objects, which the SDK keeps as the tool's own.
 */
export function annotationsFor(name: string): { title: string; annotations: ToolAnnotations } | undefined {
  const row = ROWS.get(name);
  if (!row) return undefined;
  const annotations: ToolAnnotations = { ...CLASS_ANNOTATIONS[row.class] };
  if (row.idempotent) annotations.idempotentHint = true;
  return { title: row.title, annotations };
}
