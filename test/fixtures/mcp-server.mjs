#!/usr/bin/env node
/**
 * A tiny stdio MCP server for tests and smoke runs. Its one tool,
 * `secret_word`, answers with the SECRET_WORD environment variable, so a run
 * can prove both that the server started and that its secret arrived.
 */
import readline from 'node:readline';

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const TOOLS = [{
  name: 'secret_word',
  description: 'Returns the secret word for this project.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}];

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notifications
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'test-secrets', version: '1.0.0' } } });
  } else if (msg.method === 'tools/list') {
    send({ id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === 'tools/call' && msg.params?.name === 'secret_word') {
    send({ id: msg.id, result: { content: [{ type: 'text', text: process.env.SECRET_WORD ?? '(no secret word set)' }] } });
  } else if (msg.method === 'ping') {
    send({ id: msg.id, result: {} });
  } else {
    send({ id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } });
  }
});
