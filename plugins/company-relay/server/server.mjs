#!/usr/bin/env node
// Zero-dependency Company Relay MCP server. Generated from company-claude-relay.
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import readline from 'node:readline';

const DEFAULT_BASE_URL = "https://company-relay2.rulrulmo.work";
const DEFAULT_WORKSPACE = "company-main";
const DEFAULT_TOKEN = "JEDyNFoMcDwQmO4jLxCo57gWMr2CUt84xjPc_aoKgrY";
const BASE_URL = (process.env.RELAY_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
const WORKSPACE = process.env.RELAY_WORKSPACE || DEFAULT_WORKSPACE;
const TOKEN = process.env.RELAY_TOKEN || DEFAULT_TOKEN;
const CWD = process.env.RELAY_WORKDIR || process.cwd();
const MACHINE = process.env.RELAY_MACHINE || hostname();
let peerSummary = process.env.RELAY_PEER_NAME || process.env.RELAY_PEER_SUMMARY || 'Company Claude Code relay peer';
let peerAlias = process.env.RELAY_PEER_ALIAS || peerSummary;
let peerGroup = process.env.RELAY_PEER_GROUP || '';
const POLL_INTERVAL_MS = Number(process.env.RELAY_POLL_INTERVAL_MS || process.env.RELAY_POLL_INTERVAL || '1000');
const HEARTBEAT_INTERVAL_MS = 15000;
let myId = null;
let nextId = 1;
let pollTimer = null;
let heartbeatTimer = null;
let cleanupStarted = false;

const TOOLS = [
  { name:'relay_status', description:"Show this live Claude Code session's relay peer id and broker connection status.", inputSchema:{type:'object',properties:{}} },
  { name:'set_peer_name', description:'Set a human-friendly name for this relay peer, e.g. RC, RAG, SQ.', inputSchema:{type:'object',properties:{name:{type:'string'}},required:['name']} },
  { name:'set_summary', description:'Alias for set_peer_name.', inputSchema:{type:'object',properties:{summary:{type:'string'}},required:['summary']} },
  { name:'join_group', description:'Join or change relay group.', inputSchema:{type:'object',properties:{group:{type:'string'}},required:['group']} },
  { name:'change_group', description:'Alias for join_group.', inputSchema:{type:'object',properties:{group:{type:'string'}},required:['group']} },
  { name:'set_peer_group', description:'Alias for join_group.', inputSchema:{type:'object',properties:{group:{type:'string'}},required:['group']} },
  { name:'list_peers', description:'List active same-group relay peers.', inputSchema:{type:'object',properties:{}} },
  { name:'send_to_peer_name', description:'Send an A2A request to another live relay peer by name.', inputSchema:{type:'object',properties:{peer_name:{type:'string'},message:{type:'string'},role_name:{type:'string'},skill_name:{type:'string'},context_hash:{type:'string'}},required:['peer_name','message']} },
  { name:'check_messages', description:'Manually check and inject pending relay messages.', inputSchema:{type:'object',properties:{}} },
  { name:'complete_task', description:'Complete a relay task after handling a company-relay channel message.', inputSchema:{type:'object',properties:{task_id:{type:'string'},summary:{type:'string'},status:{type:'string',enum:['completed','failed'],default:'completed'},artifacts:{type:'array',items:{type:'object'},default:[]}},required:['task_id','summary']} }
];

function log(msg) { console.error(`[company-relay] ${msg}`); }
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function result(id, value) { send({ jsonrpc:'2.0', id, result:value }); }
function error(id, code, message) { send({ jsonrpc:'2.0', id, error:{ code, message } }); }
function notify(method, params) { send({ jsonrpc:'2.0', method, params }); }

async function requestJson(method, path, body) {
  if (!TOKEN) throw new Error('missing relay token');
  const ctrl = AbortSignal.timeout(30000);
  const res = await fetch(`${BASE_URL}${path}`, { method, signal: ctrl, headers: { Authorization:`Bearer ${TOKEN}`, 'X-Workspace-Id':WORKSPACE, Accept:'application/json', ...(body ? {'Content-Type':'application/json'} : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`broker ${method} ${path} returned ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}
function git(args) {
  return new Promise(resolve => {
    const p = spawn('git', args, {cwd:CWD, stdio:['ignore','pipe','ignore']});
    let out=''; p.stdout.on('data', d => out += d);
    p.on('error', () => resolve(null));
    p.on('close', code => resolve(code === 0 ? (out.trim() || null) : null));
  });
}
async function updatePeerSummary(summary) {
  if (!myId) throw new Error('relay peer is not registered yet');
  await requestJson('PATCH', `/v0/peers/${myId}`, { summary, peer_alias: summary });
  peerSummary = summary; peerAlias = summary;
}
async function updatePeerGroup(group) {
  if (!myId) throw new Error('relay peer is not registered yet');
  await requestJson('PATCH', `/v0/peers/${myId}`, { group_name: group });
  peerGroup = group;
}
function escapeAttr(v) { return String(v).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function attrs(m, kind) {
  const a = [`source="company-relay"`, `task_id="${escapeAttr(m.task_id)}"`, `from_id="${escapeAttr(m.from_id)}"`, `sent_at="${escapeAttr(m.sent_at)}"`];
  if (kind) a.push(`kind="${escapeAttr(kind)}"`);
  for (const k of ['role_name','skill_name','context_hash']) if (m[k]) a.push(`${k}="${escapeAttr(m[k])}"`);
  return a.join(' ');
}
function buildChannelContent(m) {
  if ((m.text || '').startsWith('__COMPANY_RELAY_REPLY__')) {
    const reply = m.text.replace(/^__COMPANY_RELAY_REPLY__\s*/, '').trim();
    return `<channel ${attrs(m,'peer-reply')}>
A relay peer replied to an A2A request previously sent from this live Claude Code session.

Reply:
${reply}

This is informational. Do not call complete_task for this reply unless the user explicitly asks for more work.
</channel>`;
  }
  const origin = m.from_id === 'hermes' ? 'Hermes/Discord' : `Relay peer ${m.from_id}`;
  return `<channel ${attrs(m)}>
${origin} sent an A2A relay task to this live Claude Code session.

Task:
${m.text}

When finished, call the MCP tool complete_task with task_id="${m.task_id}", status="completed" or "failed", and a concise Korean user-facing summary.
</channel>`;
}
async function pollAndPushMessages() {
  if (!myId) return 0;
  const data = await requestJson('GET', `/v0/peers/${myId}/messages`);
  let pushed = 0;
  for (const m of (data.messages || [])) {
    notify('notifications/claude/channel', { content: buildChannelContent(m), meta: { source:'company-relay', task_id:m.task_id, from_id:m.from_id, sent_at:m.sent_at, role_name:m.role_name||'', skill_name:m.skill_name||'', context_hash:m.context_hash||'', peer_id:myId, cwd:CWD } });
    pushed++; log(`Pushed relay task ${m.task_id} from ${m.from_id}`);
  }
  return pushed;
}
async function callTool(name, args={}) {
  if (name === 'relay_status') return { content:[{type:'text', text:JSON.stringify({peer_id:myId, base_url:BASE_URL, workspace:WORKSPACE, machine:MACHINE, peer_alias:peerAlias, group_name:peerGroup, cwd:CWD, peer_name:peerSummary, summary:peerSummary}, null, 2)}] };
  if (name === 'set_peer_name' || name === 'set_summary') { const n = String(args.name ?? args.summary ?? '').trim(); if (!n) throw new Error('name/summary is required'); await updatePeerSummary(n); return {content:[{type:'text', text:`Relay peer name set to: ${n}`}]}; }
  if (name === 'join_group' || name === 'change_group' || name === 'set_peer_group') { const g = String(args.group ?? '').trim(); await updatePeerGroup(g); return {content:[{type:'text', text:g ? `Joined relay group: ${g}` : 'Left relay group.'}]}; }
  if (name === 'list_peers') { const data = await requestJson('GET', '/v0/peers'); const peers = (data.peers||[]).filter(p => p.id !== myId).filter(p => (p.group_name||'') === peerGroup).map(p => ({peer_id:p.id, address:p.peer_address||'', name:p.summary||'', group_name:p.group_name||'', cwd:p.cwd||'', branch:p.git_branch||'', status:p.status||'', age_seconds:p.age_seconds ?? null, last_seen:p.last_seen||''})); return {content:[{type:'text', text:JSON.stringify({peers}, null, 2)}]}; }
  if (name === 'send_to_peer_name') { if (!myId) throw new Error('relay peer is not registered yet'); const peer_name = String(args.peer_name||'').trim(); const message = String(args.message||'').trim(); if (!peer_name || !message) throw new Error('peer_name and message are required'); const r = await requestJson('POST', `/v0/peers/${myId}/send`, {to_peer_name:peer_name, text:message, role_name:String(args.role_name||''), skill_name:String(args.skill_name||''), context_hash:String(args.context_hash||'')}); return {content:[{type:'text', text:`Sent to ${peer_name} (${r.to_peer_id}) as ${r.task_id}. The reply will arrive as a company-relay channel message.`}]}; }
  if (name === 'check_messages') { const n = await pollAndPushMessages(); return {content:[{type:'text', text:n === 0 ? 'No new relay messages.' : `Pushed ${n} relay message(s) into this session.`}]}; }
  if (name === 'complete_task') { const task_id = String(args.task_id||'').trim(); const summary = String(args.summary||'').trim(); const status = String(args.status||'completed').trim() || 'completed'; if (!task_id || !summary) throw new Error('task_id and summary are required'); await requestJson('POST', `/v0/tasks/${task_id}/complete`, {status, summary, artifacts:Array.isArray(args.artifacts)?args.artifacts:[]}); return {content:[{type:'text', text:`Task ${task_id} completed with status ${status}.`}]}; }
  throw new Error(`Unknown tool: ${name}`);
}
async function register() {
  if (!TOKEN) throw new Error('missing relay token');
  const gitRoot = await git(['rev-parse','--show-toplevel']);
  const gitBranch = await git(['branch','--show-current']);
  const reg = await requestJson('POST', '/v0/peers/register', { kind:'claude-code-mcp-zero-config', pid:process.pid, cwd:CWD, git_root:gitRoot, git_branch:gitBranch, group_name:peerGroup, summary:peerSummary, machine:MACHINE, peer_alias:peerAlias, capabilities:['mcp','claude/channel','tasks','complete_task','set_peer_name','join_group','change_group','set_peer_group','list_peers','send_to_peer_name','a2a'] });
  myId = reg.peer_id; log(`Registered as ${myId} cwd=${CWD}`);
}
async function cleanup(reason) {
  if (cleanupStarted) return; cleanupStarted = true;
  if (pollTimer) clearInterval(pollTimer); if (heartbeatTimer) clearInterval(heartbeatTimer);
  const id = myId; myId = null;
  if (id) { try { await requestJson('DELETE', `/v0/peers/${id}`); log(`Unregistered ${id} (${reason})`); } catch (e) { log(`unregister failed: ${e.message}`); } }
  process.exit(0);
}
async function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return;
  if (msg.method === 'initialize') {
    result(msg.id, { protocolVersion: msg.params?.protocolVersion || '2024-11-05', capabilities: { experimental: {'claude/channel':{}}, tools: {} }, serverInfo: { name:'company-relay', version:'0.2.0' }, instructions: 'You are connected to the Company Claude Relay. Incoming company-relay channel messages are A2A requests. Preserve session context and always call complete_task with the task_id when finished.' }); return;
  }
  if (msg.method === 'tools/list') { result(msg.id, { tools: TOOLS }); return; }
  if (msg.method === 'tools/call') { try { result(msg.id, await callTool(msg.params?.name, msg.params?.arguments || {})); } catch (e) { result(msg.id, { content:[{type:'text', text:e.message || String(e)}], isError:true }); } return; }
  if (msg.id !== undefined) result(msg.id, {});
}
await register();
const rl = readline.createInterface({ input:process.stdin });
rl.on('line', line => { try { void handle(JSON.parse(line)); } catch (e) { log(`bad json: ${e.message}`); } });
rl.on('close', () => { void cleanup('stdin close'); });
pollTimer = setInterval(() => { pollAndPushMessages().catch(e => log(`poll error: ${e.message}`)); }, POLL_INTERVAL_MS);
heartbeatTimer = setInterval(() => { if (myId) requestJson('POST', `/v0/peers/${myId}/heartbeat`, {}).catch(() => {}); }, HEARTBEAT_INTERVAL_MS);
for (const sig of ['SIGINT','SIGTERM','SIGHUP']) process.once(sig, () => { void cleanup(sig); });
log('MCP connected; channel polling active');
