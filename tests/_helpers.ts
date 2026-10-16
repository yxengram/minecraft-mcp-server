import sinon from 'sinon';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';

type ToolResult = { content: { text: string }[]; isError?: boolean };
type Executor = (args: Record<string, unknown>) => Promise<ToolResult>;

export function createFactory() {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(server, connection);

  const getTool = (name: string) => {
    const call = (server.tool as sinon.SinonStub).getCalls().find(c => c.args[0] === name);
    return call ? { description: call.args[1] as string, execute: call.args[3] as Executor } : undefined;
  };

  return { factory, getTool };
}

export function asBot(partial: unknown): () => mineflayer.Bot {
  return () => partial as mineflayer.Bot;
}

export function createFakeWorld(initial: Record<string, string>, botPosition = new Vec3(0, 64, 0)) {
  const blocks = new Map(Object.entries(initial));
  const key = (pos: Vec3) => `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
  const keyToVec = (k: string) => new Vec3(...(k.split(',').map(Number) as [number, number, number]));

  const bot = {
    version: '1.20.4',
    entity: { position: botPosition },
    entities: {},
    heldItem: null as unknown,
    pathfinder: { goto: sinon.stub().resolves(), bestHarvestTool: sinon.stub().returns(null), stop: sinon.stub(), setGoal: sinon.stub(), goal: null as unknown },
    clearControlStates: sinon.stub(),
    stopDigging: sinon.stub(),
    blockAt: (pos: Vec3) => {
      const name = blocks.get(key(pos)) ?? 'air';
      return { name, position: pos.floored(), diggable: name !== 'bedrock' };
    },
    canDigBlock: () => true,
    canSeeBlock: () => true,
    equip: sinon.stub().resolves(),
    dig: sinon.stub().callsFake(async (block: { position: Vec3 }) => { blocks.delete(key(block.position)); }),
    lookAt: sinon.stub().resolves(),
    placeBlock: sinon.stub(),
    findBlocks: sinon.stub(),
    inventory: { items: (): { name: string; count: number; type: number }[] => [] }
  };

  bot.placeBlock.callsFake(async (reference: { position: Vec3 }, face: Vec3) => {
    blocks.set(key(reference.position.plus(face)), String((bot.heldItem as { name: string } | null)?.name ?? 'stone'));
  });

  return { bot, blocks, key, keyToVec };
}
