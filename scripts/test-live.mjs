import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2] ?? 25565);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Pass a LAN port between 1 and 65535');
}

const client = new Client({ name: 'minecraft-compatibility-test', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    fileURLToPath(new URL('../dist/main.js', import.meta.url)),
    '--host', '127.0.0.1',
    '--port', String(port),
    '--username', 'MCPSmokeTest'
  ],
  stderr: 'pipe'
});

function responseText(result) {
  return result.content
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n');
}

async function callTool(name, args = {}) {
  const result = await client.callTool(
    { name, arguments: args }, undefined, { timeout: 10000 }
  );
  if (result.isError) throw new Error(responseText(result));
  return responseText(result);
}

const timeout = setTimeout(() => {
  console.error('Live compatibility test timed out');
  client.close().finally(() => process.exit(1));
}, 45000);

try {
  await client.connect(transport);
  transport.stderr?.on('data', data => process.stderr.write(data));
  const { tools } = await client.listTools();
  console.log('MCP tools: ' + tools.length);

  let position;
  for (let attempt = 0; attempt < 25; attempt++) {
    const result = await client.callTool({ name: 'get-position', arguments: {} });
    // The first reply after the join, success or error, would end with the version warning (E-030).
    if (responseText(result).includes('verified only with')) {
      throw new Error('A reply carries a version warning:\n' + responseText(result));
    }
    const match = responseText(result).match(
      /Current position: \((-?\d+), (-?\d+), (-?\d+)\)/
    );
    if (!result.isError && match) {
      position = match.slice(1).map(Number);
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!position) throw new Error('Bot did not spawn');
  console.log('Bot position: ' + position.join(', '));
  console.log(await callTool('detect-gamemode'));

  // Wait for the server's nearby chunks before checking block decoding.
  let block;
  for (let attempt = 0; attempt < 10; attempt++) {
    const [x, y, z] = position;
    block = await callTool('get-block-info', { x, y: y - 1, z });
    if (block.startsWith('Found ')) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!block?.startsWith('Found ')) throw new Error('Nearby block data was not loaded');
  console.log(block);

  const observation = await callTool('get-observation');
  if (!observation.includes('Health:') || observation.includes('undefined')) {
    throw new Error('get-observation returned unexpected output:\n' + observation);
  }
  console.log(observation.split('\n')[0]);
  await callTool('list-entities');
  await callTool('list-players');
  const events = await callTool('get-events');
  if (!events.includes('nextSince:')) throw new Error('get-events returned unexpected output');
  // E-030: the join writes a connection event with the server's version; the test world runs 26.1.2, so no warning.
  const joined = (await callTool('get-events', { types: ['connection'], limit: 1 }))
    .split('\n').find(line => line.includes('[connection] '));
  if (!joined) throw new Error('No connection event after joining');
  const connection = joined.slice(joined.indexOf('[connection] ') + '[connection] '.length);
  if (connection.includes('verified only with')) throw new Error('Version warning: ' + connection);
  console.log('Server version: ' + (connection.match(/\(Minecraft ([^)]+)\)/)?.[1] ?? connection));
  // E-033: this server runs without --allow-commands, so send-chat refuses a server command, also on a later line,
  // and sends nothing (the check stays read-only).
  const refusal = '"/time" is a server command and this MCP server was started without --allow-commands, so nothing was sent. ' +
    'Plain chat and /msg, /tell, /w, /me, /teammsg, /tm always work; other commands need the user to add ' +
    "--allow-commands to the server's arguments and restart it";
  for (const message of ['/time query daytime', 'hi\n/time query daytime']) {
    const result = await client.callTool({ name: 'send-chat', arguments: { message } }, undefined, { timeout: 10000 });
    if (!result.isError || !responseText(result).includes(refusal)) {
      throw new Error(`send-chat ${JSON.stringify(message)} should have been refused:\n${responseText(result)}`);
    }
  }
  console.log('send-chat refuses server commands without --allow-commands');
  console.log('Read-only tool checks passed');
  console.log('Live MCP compatibility test passed');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  await client.close();
}
