// Fake StoryOS queue for the real-session run of scripts/agent-queue-stop-hook.sh (#340).
// Not a test (does not match *.test.mjs, so CI skips it). Usage:
//   mkdir -p /tmp/qrun/work /tmp/qrun/state
//   node scripts/agent-queue-stop-hook.stub-server.mjs /tmp/qrun     # reads /tmp/qrun/queue.json, port 18340
// queue.json: { "leaky": false, "tickets": [ { "number": 901, "prio": "urg|high|med|low",
//   "human": false, "title": "Create the file /tmp/qrun/work/a.txt containing exactly the letter A",
//   "done_file": "/tmp/qrun/work/a.txt" }, ... ] }
// A ticket leaves the queue once its done_file exists. Set "leaky": true to ignore the
// human = false condition and test the guardrail text on its own.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
const DIR = process.argv[2];
const OPT = { todo: 'o-todo', inprog: 'o-inprog', low: 'p1', med: 'p2', high: 'p3', urg: 'p4' };
const DBDEF = { fields: [
  { apiName: 'state', options: [{ id: OPT.todo, label: 'ToDo' }, { id: OPT.inprog, label: 'In Progress' }] },
  { apiName: 'priority', options: [{ id: OPT.low, label: 'Low' }, { id: OPT.med, label: 'Medium' }, { id: OPT.high, label: 'High' }, { id: OPT.urg, label: 'Urgent' }] } ] };
const matches = (r, n) => n.and ? n.and.every((x) => matches(r, x)) :
  n.op === 'has' ? (Array.isArray(r.values[n.field]) ? true : n.value.includes(r.values[n.field])) :
  n.op === 'eq' ? r.values[n.field] === n.value : n.op === 'not_empty' ? !!r.values[n.field] : true;
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const cfg = JSON.parse(readFileSync(`${DIR}/queue.json`, 'utf8'));
    const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'GET') return send(200, DBDEF);
    const filter = JSON.parse(b).filter;
    const live = cfg.tickets.filter((t) => !existsSync(t.done_file)).map((t, i) => ({
      number: t.number, title: t.title, created_at: `2026-09-0${i + 1}T00:00:00Z`, updated_at: '2026-10-01T00:00:00Z',
      values: { priority: OPT[t.prio], state: OPT.todo, human: !!t.human, agents: [1], acceptance_criteria: 'x' } }));
    // `leaky` simulates a broken server that ignores the human condition, to test the guardrail text on its own.
    const out = cfg.leaky ? live : live.filter((r) => matches(r, filter));
    require_log(out.map((r) => r.number));
    send(201, { data: out });
  });
}).listen(18340, '127.0.0.1', () => console.log('stub up'));
function require_log(n) { console.log(new Date().toISOString(), 'query ->', JSON.stringify(n)); }
