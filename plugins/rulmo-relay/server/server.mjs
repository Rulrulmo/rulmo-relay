#!/usr/bin/env node
// Zero-dependency Rulmo Relay MCP server.
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import readline from 'node:readline';

const DEFAULT_BASE_URL = "https://company-relay2.rulrulmo.work";
const DEFAULT_WORKSPACE = "company-main";
const BASE_URL = (process.env.RELAY_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
const WORKSPACE = process.env.RELAY_WORKSPACE || DEFAULT_WORKSPACE;
const TOKEN = process.env.RULMO_RELAY_TOKEN || process.env.RELAY_TOKEN || '';
const CWD = process.env.RELAY_WORKDIR || process.cwd();
const MACHINE = process.env.RELAY_MACHINE || hostname();
let peerSummary = process.env.RELAY_PEER_NAME || process.env.RELAY_PEER_SUMMARY || 'Rulmo Relay Claude Code peer';
let peerAlias = process.env.RELAY_PEER_ALIAS || peerSummary;
let peerGroups = [...new Set([...(process.env.RELAY_PEER_GROUP || '').split(','), ...(process.env.RELAY_PEER_GROUPS || '').split(',')].map(s => s.trim()).filter(Boolean))];
const POLL_INTERVAL_MS = Number(process.env.RELAY_POLL_INTERVAL_MS || process.env.RELAY_POLL_INTERVAL || '1000');
const HEARTBEAT_INTERVAL_MS = 15000;
const CHANNEL_RETRY_INTERVAL_MS = Number(process.env.RELAY_CHANNEL_RETRY_INTERVAL_MS || '15000');
let myId = null;
let nextId = 1;
let pollTimer = null;
let heartbeatTimer = null;
let retryTimer = null;
let pollingStarted = false;
let cleanupStarted = false;
const pendingChannelMessages = new Map();

const TOOLS = [
  { name:'relay_status', description:"Show this live Claude Code session's relay peer id and broker connection status.", inputSchema:{type:'object',properties:{}} },
  { name:'set_peer_name', description:'Set a human-friendly name for this relay peer, e.g. RC, RAG, SQ.', inputSchema:{type:'object',properties:{name:{type:'string'}},required:['name']} },
  { name:'set_summary', description:'Alias for set_peer_name.', inputSchema:{type:'object',properties:{summary:{type:'string'}},required:['summary']} },
  { name:'join_group', description:'Join an additional relay group without leaving existing groups.', inputSchema:{type:'object',properties:{group:{type:'string'}},required:['group']} },
  { name:'leave_group', description:'Leave one relay group without leaving other groups.', inputSchema:{type:'object',properties:{group:{type:'string'}},required:['group']} },
  { name:'change_group', description:'Replace all current group memberships with one group. Empty group leaves all groups.', inputSchema:{type:'object',properties:{group:{type:'string'}},required:['group']} },
  { name:'set_peer_group', description:'Backwards-compatible alias for change_group.', inputSchema:{type:'object',properties:{group:{type:'string'}},required:['group']} },
  { name:'list_groups', description:'List relay groups this peer currently belongs to.', inputSchema:{type:'object',properties:{}} },
  { name:'list_peers', description:'List active peers sharing any group with this peer, or peers in a specified group.', inputSchema:{type:'object',properties:{group:{type:'string'}}} },
  { name:'send_to_peer_name', description:'Send an A2A request to another live relay peer by name, optionally within a specific shared group.', inputSchema:{type:'object',properties:{peer_name:{type:'string'},message:{type:'string'},group:{type:'string'},role_name:{type:'string'},skill_name:{type:'string'},context_hash:{type:'string'}},required:['peer_name','message']} },
  { name:'check_messages', description:'Manually check and inject pending relay messages.', inputSchema:{type:'object',properties:{}} },
  { name:'complete_task', description:'Complete a relay task after handling a rulmo-relay channel message.', inputSchema:{type:'object',properties:{task_id:{type:'string'},summary:{type:'string'},status:{type:'string',enum:['completed','failed'],default:'completed'},artifacts:{type:'array',items:{type:'object'},default:[]}},required:['task_id','summary']} }
];

function log(msg) { console.error(`[rulmo-relay] ${msg}`); }
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function result(id, value) { send({ jsonrpc:'2.0', id, result:value }); }
function error(id, code, message) { send({ jsonrpc:'2.0', id, error:{ code, message } }); }
function notify(method, params) { send({ jsonrpc:'2.0', method, params }); }
function isBrokerNotFound(error) { return error instanceof Error && /returned 404:/.test(error.message); }

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
function normalizeGroups(groups) { return [...new Set(groups.map(g => String(g || '').trim()).filter(Boolean))]; }
function sharesGroup(peerGroupsFromBroker, requestedGroup='') {
  const groups = Array.isArray(peerGroupsFromBroker) ? peerGroupsFromBroker : [];
  if (requestedGroup) return peerGroups.includes(requestedGroup) && groups.includes(requestedGroup);
  if (peerGroups.length === 0) return groups.length === 0;
  return groups.some(g => peerGroups.includes(g));
}
async function joinPeerGroup(group) {
  if (!myId) throw new Error('relay peer is not registered yet');
  const g = String(group || '').trim();
  if (!g) throw new Error('group is required');
  const res = await requestJson('POST', `/v0/peers/${myId}/groups`, { group_name: g });
  peerGroups = normalizeGroups(res.group_names || [...peerGroups, g]);
}
async function leavePeerGroup(group) {
  if (!myId) throw new Error('relay peer is not registered yet');
  const g = String(group || '').trim();
  if (!g) throw new Error('group is required');
  const res = await requestJson('DELETE', `/v0/peers/${myId}/groups/${encodeURIComponent(g)}`);
  peerGroups = normalizeGroups(res.group_names || peerGroups.filter(x => x !== g));
}
async function changePeerGroup(group) {
  if (!myId) throw new Error('relay peer is not registered yet');
  const g = String(group || '').trim();
  const groups = g ? [g] : [];
  await requestJson('PATCH', `/v0/peers/${myId}`, { group_names: groups });
  peerGroups = groups;
}
function buildChannelContent(m) {
  if ((m.text || '').startsWith('__COMPANY_RELAY_REPLY__')) {
    return m.text.replace(/^__COMPANY_RELAY_REPLY__\s*/, '').trim();
  }
  // Match the working claude-peers-mcp pattern: send the sender's message as
  // plain channel content and put routing/task metadata in meta. Claude Code
  // renders meta as channel attributes for the model; embedding our own
  // synthetic wrapper or long instruction block in content is unnecessary and
  // can make debugging the channel handoff ambiguous.
  return m.text || '';
}
function pushChannelMessage(m, reason='poll') {
  notify('notifications/claude/channel', { content: buildChannelContent(m), meta: { source:'rulmo-relay', task_id:m.task_id, from_id:m.from_id, sent_at:m.sent_at, role_name:m.role_name||'', skill_name:m.skill_name||'', context_hash:m.context_hash||'', peer_id:myId, cwd:CWD, retry_reason:reason } });
  log(`Pushed relay task ${m.task_id} from ${m.from_id} (${reason})`);
}
async function taskStillQueued(taskId) {
  try {
    const task = await requestJson('GET', `/v0/tasks/${encodeURIComponent(taskId)}`);
    return task.status === 'queued';
  } catch (e) {
    log(`task status check failed for ${taskId}: ${e.message}`);
    return false;
  }
}
async function pollAndPushMessages() {
  if (!myId) return 0;
  let data;
  try {
    data = await requestJson('GET', `/v0/peers/${myId}/messages`);
  } catch (e) {
    if (isBrokerNotFound(e)) {
      log(`peer ${myId} no longer exists on broker; re-registering before polling`);
      myId = null;
      await register();
      data = await requestJson('GET', `/v0/peers/${myId}/messages`);
    } else {
      throw e;
    }
  }
  let pushed = 0;
  for (const m of (data.messages || [])) {
    pendingChannelMessages.set(m.task_id, m);
    pushChannelMessage(m, 'poll');
    pushed++;
  }
  return pushed;
}
async function retryPendingChannelMessages(force=false) {
  if (!myId || pendingChannelMessages.size === 0) return 0;
  let pushed = 0;
  for (const [taskId, m] of [...pendingChannelMessages.entries()]) {
    if (!(await taskStillQueued(taskId))) {
      pendingChannelMessages.delete(taskId);
      continue;
    }
    pushChannelMessage(m, force ? 'manual-retry' : 'completion-timeout-retry');
    pushed++;
  }
  return pushed;
}
async function callTool(name, args={}) {
  if (name === 'relay_status') return { content:[{type:'text', text:JSON.stringify({peer_id:myId, base_url:BASE_URL, workspace:WORKSPACE, machine:MACHINE, peer_alias:peerAlias, group_name:peerGroups[0] || '', group_names:peerGroups, cwd:CWD, peer_name:peerSummary, summary:peerSummary}, null, 2)}] };
  if (name === 'set_peer_name' || name === 'set_summary') { const n = String(args.name ?? args.summary ?? '').trim(); if (!n) throw new Error('name/summary is required'); await updatePeerSummary(n); return {content:[{type:'text', text:`Relay peer name set to: ${n}`}]}; }
  if (name === 'join_group') { const g = String(args.group ?? '').trim(); await joinPeerGroup(g); return {content:[{type:'text', text:`Joined relay group: ${g}. Current groups: ${peerGroups.join(', ') || '(none)'}`}]}; }
  if (name === 'leave_group') { const g = String(args.group ?? '').trim(); await leavePeerGroup(g); return {content:[{type:'text', text:`Left relay group: ${g}. Current groups: ${peerGroups.join(', ') || '(none)'}`}]}; }
  if (name === 'change_group' || name === 'set_peer_group') { const g = String(args.group ?? '').trim(); await changePeerGroup(g); return {content:[{type:'text', text:g ? `Changed relay groups to: ${g}` : 'Left all relay groups.'}]}; }
  if (name === 'list_groups') { return {content:[{type:'text', text:JSON.stringify({group_names:peerGroups}, null, 2)}]}; }
  if (name === 'list_peers') { const requestedGroup = String(args.group || '').trim(); const data = await requestJson('GET', '/v0/peers'); const peers = (data.peers||[]).filter(p => p.id !== myId).filter(p => sharesGroup(p.group_names || (p.group_name ? [p.group_name] : []), requestedGroup)).map(p => ({peer_id:p.id, address:p.peer_address||'', name:p.summary||'', group_name:p.group_name||'', group_names:p.group_names||[], cwd:p.cwd||'', branch:p.git_branch||'', status:p.status||'', age_seconds:p.age_seconds ?? null, last_seen:p.last_seen||''})); return {content:[{type:'text', text:JSON.stringify({group_names:peerGroups, peers}, null, 2)}]}; }
  if (name === 'send_to_peer_name') { if (!myId) throw new Error('relay peer is not registered yet'); const peer_name = String(args.peer_name||'').trim(); const message = String(args.message||'').trim(); const group_name = String(args.group||args.group_name||'').trim(); if (!peer_name || !message) throw new Error('peer_name and message are required'); const r = await requestJson('POST', `/v0/peers/${myId}/send`, {to_peer_name:peer_name, text:message, group_name, role_name:String(args.role_name||''), skill_name:String(args.skill_name||''), context_hash:String(args.context_hash||'')}); return {content:[{type:'text', text:`Sent to ${peer_name} (${r.to_peer_id}) as ${r.task_id}${r.group_name ? ` via group ${r.group_name}` : ''}. The reply will arrive as a rulmo-relay channel message.`}]}; }
  if (name === 'check_messages') { const n = await pollAndPushMessages(); const retried = await retryPendingChannelMessages(true); return {content:[{type:'text', text:(n + retried) === 0 ? 'No new relay messages.' : `Pushed ${n} new relay message(s) and retried ${retried} pending queued message(s) into this session.`}]}; }
  if (name === 'complete_task') { const task_id = String(args.task_id||'').trim(); const summary = String(args.summary||'').trim(); const status = String(args.status||'completed').trim() || 'completed'; if (!task_id || !summary) throw new Error('task_id and summary are required'); await requestJson('POST', `/v0/tasks/${task_id}/complete`, {status, summary, artifacts:Array.isArray(args.artifacts)?args.artifacts:[]}); return {content:[{type:'text', text:`Task ${task_id} completed with status ${status}.`}]}; }
  throw new Error(`Unknown tool: ${name}`);
}
function startPollingLoops() {
  if (pollingStarted) return;
  pollingStarted = true;
  pollTimer = setInterval(() => { pollAndPushMessages().catch(e => log(`poll error: ${e.message}`)); }, POLL_INTERVAL_MS);
  retryTimer = setInterval(() => { retryPendingChannelMessages(false).catch(e => log(`retry error: ${e.message}`)); }, CHANNEL_RETRY_INTERVAL_MS);
  heartbeatTimer = setInterval(() => { if (myId) requestJson('POST', `/v0/peers/${myId}/heartbeat`, {}).catch(e => { if (isBrokerNotFound(e)) { log(`peer ${myId} heartbeat returned 404; re-registering`); myId = null; register().catch(err => log(`re-register failed: ${err.message}`)); } }); }, HEARTBEAT_INTERVAL_MS);
  setTimeout(() => { pollAndPushMessages().catch(e => log(`initial poll error: ${e.message}`)); }, 100);
  log('channel polling active');
}
async function register() {
  if (!TOKEN) throw new Error('missing relay token');
  const gitRoot = await git(['rev-parse','--show-toplevel']);
  const gitBranch = await git(['branch','--show-current']);
  const reg = await requestJson('POST', '/v0/peers/register', { kind:'claude-code-mcp-zero-config', pid:process.pid, cwd:CWD, git_root:gitRoot, git_branch:gitBranch, group_names:peerGroups, group_name:peerGroups[0] || '', summary:peerSummary, machine:MACHINE, peer_alias:peerAlias, capabilities:['mcp','claude/channel','tasks','complete_task','set_peer_name','join_group','leave_group','change_group','set_peer_group','list_groups','list_peers','send_to_peer_name','a2a'] });
  myId = reg.peer_id; log(`Registered as ${myId} cwd=${CWD}`);
}
async function cleanup(reason) {
  if (cleanupStarted) return; cleanupStarted = true;
  if (pollTimer) clearInterval(pollTimer); if (heartbeatTimer) clearInterval(heartbeatTimer); if (retryTimer) clearInterval(retryTimer);
  const id = myId; myId = null;
  if (id) { try { await requestJson('DELETE', `/v0/peers/${id}`); log(`Unregistered ${id} (${reason})`); } catch (e) { log(`unregister failed: ${e.message}`); } }
  process.exit(0);
}
async function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return;
  if (msg.method === 'initialize') {
    result(msg.id, { protocolVersion: msg.params?.protocolVersion || '2024-11-05', capabilities: { experimental: {'claude/channel':{}}, tools: {} }, serverInfo: { name:'rulmo-relay', version:'0.4.4' }, instructions: 'You are connected to the Rulmo Relay. Incoming <channel source="rulmo-relay" task_id="..." ...> messages are A2A requests for this live Claude Code session. Treat them like a coworker tapping you on the shoulder: respond immediately, preserve session context, and when finished call the MCP tool complete_task with the task_id from the channel attributes, status="completed" or "failed", and a concise Korean user-facing summary. For channel messages with kind="peer-reply", read them as informational replies and do not call complete_task unless explicitly asked for more work.' }); return;
  }
  if (msg.method === 'notifications/initialized') { startPollingLoops(); return; }
  if (msg.method === 'tools/list') { result(msg.id, { tools: TOOLS }); return; }
  if (msg.method === 'tools/call') { try { result(msg.id, await callTool(msg.params?.name, msg.params?.arguments || {})); } catch (e) { result(msg.id, { content:[{type:'text', text:e.message || String(e)}], isError:true }); } return; }
  if (msg.id !== undefined) result(msg.id, {});
}
await register();
const rl = readline.createInterface({ input:process.stdin });
rl.on('line', line => { try { void handle(JSON.parse(line)); } catch (e) { log(`bad json: ${e.message}`); } });
rl.on('close', () => { void cleanup('stdin close'); });
for (const sig of ['SIGINT','SIGTERM','SIGHUP']) process.once(sig, () => { void cleanup(sig); });
log('MCP connected; waiting for initialized notification before channel polling');
