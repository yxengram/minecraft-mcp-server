import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, ZodError, ZodRawShape, ZodType } from "zod";
import { BotConnection } from './bot-connection.js';
import type { Autopilot } from './autopilot/autopilot.js';
import { PRIORITY } from './autopilot/action-arbiter.js';

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type McpResponse = {
  content: McpContent[];
  isError?: boolean;
  [key: string]: unknown;
};

// Tools that move, look, attack or use items; they hold the action lease while running (BLUEPRINT E-001).
// collect-block is not listed: it runs a gather task, which takes the body at task priority itself (E-004).
export const BODY_TOOLS = new Set([
  'move-to-position', 'move-in-direction', 'look-at', 'jump', 'fly-to', 'goto-waypoint',
  'dig-block', 'place-block', 'activate-block', 'activate-entity', 'attack-entity',
  'mount-entity', 'dismount', 'sleep', 'consume', 'equip-item', 'craft-item', 'smelt-item',
  'read-container', 'container-deposit', 'container-withdraw',
  'clear-region', 'fill-region', 'dig-tunnel'
]);

export interface ToolOptions {
  /** The tool drives the bot's body (moving, looking, attacking, using items) and must hold the action lease. */
  body?: boolean;
  /** Reject unknown top-level arguments instead of silently dropping them (the SDK strips them otherwise). */
  strict?: boolean;
}

export class ToolFactory {
  private autopilotProvider: (() => Autopilot | null) | null = null;

  constructor(
    private server: McpServer,
    private connection: BotConnection
  ) {}

  setAutopilot(provider: () => Autopilot | null): void {
    this.autopilotProvider = provider;
  }

  registerTool(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: (args: any) => Promise<McpResponse>,
    options: ToolOptions = {}
  ): void {
    const handler = async (args: unknown): Promise<McpResponse> => {
      const connectionCheck = await this.connection.checkConnectionAndReconnect();

      if (!connectionCheck.connected) {
        return {
          content: [{ type: "text", text: connectionCheck.message! }],
          isError: true
        };
      }

      try {
        const parsedArgs = this.shouldValidateSchema(schema)
          ? this.parseArgs(schema as ZodRawShape, args)
          : args;
        if (options.body ?? BODY_TOOLS.has(name)) {
          return await this.runWithBody(name, () => executor(parsedArgs));
        }
        return await executor(parsedArgs);
      } catch (error) {
        return this.createErrorResponse(error as Error);
      }
    };

    if (options.strict) {
      // server.tool() only takes a raw shape, which the SDK turns into a stripping object schema.
      this.server.registerTool(name, { description, inputSchema: z.object(schema as ZodRawShape).strict() }, handler);
    } else {
      this.server.tool(name, description, schema, handler);
    }
  }

  // LLM commands run right away: they pause the current task and non-urgent instinct actions, and only wait (up to
  // 10 seconds) for urgent ones. The result tells the LLM what was interrupted. See BLUEPRINT G1.
  private async runWithBody(name: string, run: () => Promise<McpResponse>): Promise<McpResponse> {
    const autopilot = this.autopilotProvider?.();
    if (!autopilot || !autopilot.isReady()) {
      return run();
    }

    let interruptedBy: string | null = null;
    const acquired = await autopilot.arbiter.acquire({
      holder: `manual ${name}`,
      priority: PRIORITY.MANUAL,
      onSuspend: by => { interruptedBy = by.holder; }
    });
    if (!acquired.ok) {
      return this.createErrorResponse(`Busy: ${acquired.busy.holder} is controlling the bot (waited ${(acquired.waitedMs / 1000).toFixed(1)}s). Try again shortly`);
    }

    const report = autopilot.describeInterruption(
      acquired.preempted,
      acquired.waitedFor ? { holder: acquired.waitedFor.holder, ms: acquired.waitedMs } : undefined
    );
    let response: McpResponse;
    try {
      response = await run();
    } finally {
      acquired.lease.release();
    }

    const notes = [report, interruptedBy ? `This command was interrupted by ${interruptedBy}.` : null].filter(Boolean);
    if (notes.length === 0) return response;
    return { ...response, content: [...response.content, { type: "text", text: notes.join('\n') }] };
  }

  createResponse(text: string): McpResponse {
    return {
      content: [{ type: "text", text }]
    };
  }

  createImageResponse(text: string, image: Buffer, mimeType = "image/png"): McpResponse {
    return {
      content: [
        { type: "image", data: image.toString('base64'), mimeType },
        { type: "text", text }
      ]
    };
  }

  createErrorResponse(error: Error | string): McpResponse {
    const errorMessage = error instanceof Error ? error.message : error;
    return {
      content: [{ type: "text", text: `Failed: ${errorMessage}` }],
      isError: true
    };
  }

  private shouldValidateSchema(schema: Record<string, unknown>): boolean {
    const values = Object.values(schema);
    if (values.length === 0) {
      return true;
    }

    return values.every((value) => value instanceof ZodType);
  }

  private parseArgs(schema: ZodRawShape, args: unknown): unknown {
    try {
      return z.object(schema).passthrough().parse(args ?? {});
    } catch (error) {
      if (error instanceof ZodError) {
        throw new Error(this.formatZodError(error));
      }
      throw error;
    }
  }

  private formatZodError(error: ZodError): string {
    const details = error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${path}${issue.message}`;
      })
      .join('; ');

    return `Invalid tool arguments: ${details}`;
  }
}
