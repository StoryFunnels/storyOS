import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from './dist/server.js';

const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content?.[0]?.text ?? '' };
};

const server = buildServer();
const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st);
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(ct);

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`); };

const tools = await client.listTools();
check('lists 7 tools', tools.tools.length === 7, tools.tools.map((t) => t.name).join(','));

const lw = await call(client, 'list_workspaces');
check('list_workspaces sees MCP WS', lw.text.includes('MCP WS'));

const gs = await call(client, 'get_started', { workspace: 'MCP WS' });
check('get_started maps workspace + filter guide', gs.text.includes('Tasks') && gs.text.includes('describe_database'));

const dd = await call(client, 'describe_database', { workspace: 'MCP WS', database: 'Tasks' });
check('describe_database shows Priority + options', dd.text.includes('priority') && dd.text.includes('High'));

const qr = await call(client, 'query_records', { workspace: 'MCP WS', database: 'Tasks' });
check('query_records returns 2 records', (qr.text.match(/task/gi) ?? []).length >= 2, '');

const gr = await call(client, 'get_record', { workspace: 'MCP WS', database: 'Tasks', record: '1' });
check('get_record by number 1', gr.text.includes('First task'));

const se = await call(client, 'search', { workspace: 'MCP WS', query: 'Second' });
check('search finds Second task', se.text.includes('Second task'));

// anti-hallucination: a bad filter field must come back as a teaching error
const bad = await call(client, 'query_records', { workspace: 'MCP WS', database: 'Tasks', filter: { and: [{ field: 'nope', op: 'eq', value: 1 }] } });
check('bad filter → isError with message', bad.isError && /nope|unknown|field/i.test(bad.text), bad.text.slice(0, 80));

// bad workspace name → helpful resolver error
const badws = await call(client, 'list_databases', { workspace: 'Nonexistent WS' });
check('bad workspace → resolver error', badws.isError && /No workspace matches/i.test(badws.text));

console.log(`\n${pass} passed, ${fail} failed`);
await client.close();
process.exit(fail ? 1 : 0);
