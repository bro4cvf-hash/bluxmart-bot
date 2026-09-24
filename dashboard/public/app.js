/* =============================================================================
   Bluxmart Unified Bot & Delivery Console — SPA Controller
   ============================================================================= */

const $ = (id) => document.getElementById(id);
let CSRF = '';
let TEMPLATE = null;
let GUILDS = [];
let SELECTED_GUILD = null;
let GUILD_DETAIL = null;
let QUEUE = [];
let CURRENT_FILTER = 'all';
let SEARCH_QUERY = '';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function toast(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2800);
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': CSRF,
      ...(opts.headers || {})
    }
  });
  if (r.status === 401) {
    location.href = '/login';
    throw new Error('Session expired.');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status}).`);
  return j;
}

// =============================================================================
// 1. Navigation & View Switching
// =============================================================================
const TITLES = {
  overview: ['Overview', 'Unified status for Minecraft Auto-Delivery and Discord Bot'],
  delivery: ['Auto-Delivery', 'DonutSMP queue management, live synchronization, and manual orders'],
  botting: ['Minecraft Bot', 'TrafficerMC bot connection, anti-afk, safety controls, and live chat'],
  discord: ['Discord Bot', 'Bluxbot server roles, channels, ticket panels, and live sync'],
  settings: ['Security & Settings', 'Session authentication, admin password change, and security checks']
};

document.querySelectorAll('#nav .nav-btn').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#nav .nav-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    const v = b.dataset.view;
    document.querySelectorAll('.view').forEach((s) => s.classList.remove('active'));
    const target = $('view-' + v);
    if (target) target.classList.add('active');
    $('title').textContent = TITLES[v][0];
    $('subtitle').textContent = TITLES[v][1];
  });
});

// Subnav inside Discord View
document.querySelectorAll('.subnav-btn').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.subnav-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    const sub = b.dataset.sub;
    document.querySelectorAll('.subview').forEach((s) => s.classList.remove('active'));
    const target = $(sub);
    if (target) target.classList.add('active');
  });
});

// Quick action buttons jump to tabs
$('btn-goto-delivery')?.addEventListener('click', () => {
  document.querySelector('#nav .nav-btn[data-view="delivery"]')?.click();
});
$('btn-quick-sync-discord')?.addEventListener('click', () => {
  document.querySelector('#nav .nav-btn[data-view="discord"]')?.click();
});

// Sign out
$('logout')?.addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST', headers: { 'X-CSRF-Token': CSRF } }).catch(() => {});
  location.href = '/login';
});

// =============================================================================
// 2. Real-time Status Polling & SSE Log Streaming
// =============================================================================
function appendTerminalLine(consoleEl, text, type = 'info') {
  if (!consoleEl) return;
  const line = document.createElement('div');
  line.className = `terminal-line terminal-${type}`;
  const now = new Date().toTimeString().split(' ')[0];
  line.innerHTML = `<span class="terminal-time">[${now}]</span> ${esc(text)}`;
  consoleEl.appendChild(line);
  consoleEl.scrollTop = consoleEl.scrollHeight;
  while (consoleEl.children.length > 200) {
    consoleEl.removeChild(consoleEl.firstChild);
  }
}

function initSSE() {
  const es = new EventSource('/api/ipc/events');
  es.onmessage = (e) => {
    try {
      const { channel, args = [] } = JSON.parse(e.data);
      handleSSEEvent(channel, args);
    } catch {}
  };
  es.onerror = () => {
    // EventSource automatically retries
  };
}

function handleSSEEvent(channel, args) {
  const terminal = $('bot-live-terminal');
  const overviewTerm = $('overview-log-console');

  if (channel === 'chat') {
    const [botName, sender, message] = args;
    const txt = sender ? `<${sender}> ${message}` : String(botName || message);
    appendTerminalLine(terminal, txt, 'chat');
    appendTerminalLine(overviewTerm, txt, 'chat');
  } else if (channel === 'status' || channel === 'bot_action') {
    appendTerminalLine(terminal, `[Status] ${args.join(' ')}`, 'info');
    appendTerminalLine(overviewTerm, `[Bot] ${args.join(' ')}`, 'info');
    loadStatus();
  } else if (channel === 'error') {
    appendTerminalLine(terminal, `[Error] ${args.join(' ')}`, 'error');
    appendTerminalLine(overviewTerm, `[Error] ${args.join(' ')}`, 'error');
  } else if (channel === 'delivery_status') {
    appendTerminalLine(terminal, `[Order] ${args.join(' ')}`, 'success');
    appendTerminalLine(overviewTerm, `[Order] ${args.join(' ')}`, 'success');
    loadStatus();
  }
}

function fmtUptime(s) {
  if (!s && s !== 0) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

async function loadStatus() {
  try {
    const data = await api('/api/status');
    const { bot = {}, discord = {}, sync = {}, queue = [] } = data;
    QUEUE = queue;

    // Global topbar indicator
    const mcDot = $('dot');
    const mcState = $('botstate');
    if (bot.connected) {
      mcDot.className = 'dot on';
      mcState.textContent = `Bot: ${bot.username} • DonutSMP`;
    } else if (discord.ready) {
      mcDot.className = 'dot on';
      mcState.textContent = `Discord: ${discord.tag} • Online`;
    } else {
      mcDot.className = 'dot off';
      mcState.textContent = 'Bots Offline';
    }

    // Sidebar indicators
    const mcNavPill = $('mc-nav-pill');
    if (mcNavPill) mcNavPill.className = 'nav-status-dot ' + (bot.connected ? 'on' : 'off');
    const dcNavPill = $('dc-nav-pill');
    if (dcNavPill) dcNavPill.className = 'nav-status-dot ' + (discord.ready ? 'on' : 'off');
    const qBadge = $('queue-badge');
    if (qBadge) {
      const activeQ = queue.filter((q) => q.status === 'queued' || q.status === 'delivering').length;
      qBadge.textContent = activeQ;
      qBadge.style.display = activeQ > 0 ? 'inline-block' : 'none';
    }

    // Overview Stats
    $('stat-mc-badge').textContent = bot.connected ? 'Connected' : 'Offline';
    $('stat-mc-badge').className = 'badge ' + (bot.connected ? 'green' : 'red');
    $('stat-mc-user').textContent = bot.username || 'Not Spawned';
    $('stat-mc-sub').textContent = bot.host || 'donutsmp.net:25565';

    const queuedCount = queue.filter((q) => q.status === 'queued').length;
    const deliveringCount = queue.filter((q) => q.status === 'delivering').length;
    const completedCount = queue.filter((q) => q.status === 'completed').length;
    const failedCount = queue.filter((q) => q.status === 'failed').length;

    $('stat-queue-count').textContent = queuedCount + deliveringCount;
    $('stat-queue-sub').textContent = `${completedCount} completed • ${failedCount} failed`;

    $('stat-dc-badge').textContent = discord.ready ? 'Online' : 'Offline';
    $('stat-dc-badge').className = 'badge ' + (discord.ready ? 'green' : 'red');
    $('stat-dc-tag').textContent = discord.tag || 'Not Connected';
    $('stat-dc-sub').textContent = `${discord.guildCount || 0} server(s) • ${discord.ping >= 0 ? discord.ping + 'ms' : '—'}`;

    $('stat-sync-badge').textContent = sync.lastError ? 'Error' : 'Live';
    $('stat-sync-badge').className = 'badge ' + (sync.lastError ? 'red' : 'green');
    $('stat-sync-state').textContent = sync.lastError ? 'Sync issue' : 'Synchronized';
    $('stat-sync-sub').textContent = sync.lastSyncAt ? `Synced ${new Date(sync.lastSyncAt).toLocaleTimeString()}` : 'Ready';

    // Cloud Sync Card in Delivery View
    $('cloud-site-url').textContent = sync.siteUrl || 'https://bluxmart.com';
    $('cloud-sync-status-badge').textContent = sync.lastError ? 'Error: ' + sync.lastError : 'Active (Polling 5s)';
    $('cloud-sync-status-badge').className = 'badge ' + (sync.lastError ? 'red' : 'green');
    $('cloud-last-sync-time').textContent = sync.lastSyncAt ? new Date(sync.lastSyncAt).toLocaleString() : 'Never';
    $('cloud-worker-bot').textContent = bot.username || 'No active Minecraft bot';

    // Settings Environment info
    $('env-port').textContent = `0.0.0.0:${location.port || '9843'}`;
    $('env-mc').textContent = bot.host || 'donutsmp.net:25565';
    $('env-uptime').textContent = fmtUptime(data.uptimeSec || 0);

    // Render Queues
    renderDeliveryQueue();
    renderOverviewOrders();
  } catch (err) {
    console.error('[loadStatus error]', err);
  }
}

$('refresh')?.addEventListener('click', async () => {
  await loadStatus();
  toast('Status refreshed');
});

// =============================================================================
// 3. Auto-Delivery Queue Management
// =============================================================================
function formatOrderItems(order) {
  const parts = [];
  if (Number(order.money) > 0) parts.push(`💸 $${Number(order.money).toLocaleString()}`);
  if (Number(order.spawners) > 0) parts.push(`🦴 ${order.spawners}x Spawner`);
  if (Number(order.elytras) > 0) parts.push(`🪽 ${order.elytras}x Elytra`);
  return parts.join(' + ') || 'Custom Item Order';
}

function statusBadgeHtml(status) {
  switch (status) {
    case 'queued': return '<span class="badge orange">Queued</span>';
    case 'delivering': return '<span class="badge blue">Delivering…</span>';
    case 'completed': return '<span class="badge green">Completed</span>';
    case 'failed': return '<span class="badge red">Failed</span>';
    default: return `<span class="badge">${esc(status)}</span>`;
  }
}

function renderOverviewOrders() {
  const tbody = $('overview-orders-tbody');
  if (!tbody) return;
  const recent = (QUEUE || []).slice(0, 6);
  if (recent.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-cell">No active orders in delivery queue</td></tr>';
    return;
  }
  tbody.innerHTML = recent.map((o) => `
    <tr>
      <td>
        <img class="player-avatar" src="https://mc-heads.net/avatar/${encodeURIComponent(o.recipient || 'MHF_Steve')}/24" alt="${esc(o.recipient)}">
        <strong>${esc(o.recipient)}</strong>
      </td>
      <td class="mono">${esc(o.id)}</td>
      <td>${esc(formatOrderItems(o))}</td>
      <td>${statusBadgeHtml(o.status)}</td>
    </tr>
  `).join('');
}

function renderDeliveryQueue() {
  const tbody = $('delivery-queue-tbody');
  if (!tbody) return;

  const queuedCount = QUEUE.filter((q) => q.status === 'queued').length;
  const deliveringCount = QUEUE.filter((q) => q.status === 'delivering').length;
  const completedCount = QUEUE.filter((q) => q.status === 'completed').length;
  const failedCount = QUEUE.filter((q) => q.status === 'failed').length;

  $('count-all').textContent = QUEUE.length;
  $('count-queued').textContent = queuedCount;
  $('count-delivering').textContent = deliveringCount;
  $('count-completed').textContent = completedCount;
  $('count-failed').textContent = failedCount;

  let filtered = QUEUE.filter((o) => {
    if (CURRENT_FILTER !== 'all' && o.status !== CURRENT_FILTER) return false;
    if (SEARCH_QUERY) {
      const q = SEARCH_QUERY.toLowerCase();
      const matchId = String(o.id || '').toLowerCase().includes(q);
      const matchRec = String(o.recipient || '').toLowerCase().includes(q);
      if (!matchId && !matchRec) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">No orders match the selected filter.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map((o) => `
    <tr>
      <td>
        <img class="player-avatar" src="https://mc-heads.net/avatar/${encodeURIComponent(o.recipient || 'MHF_Steve')}/24" alt="${esc(o.recipient)}">
        <strong>${esc(o.recipient)}</strong>
      </td>
      <td class="mono">${esc(o.id)}</td>
      <td>${esc(formatOrderItems(o))}</td>
      <td>
        ${statusBadgeHtml(o.status)}
        ${o.error ? `<div class="hint" style="color:var(--danger)">${esc(o.error)}</div>` : ''}
      </td>
      <td class="mono">${o.createdAt ? new Date(o.createdAt).toLocaleTimeString() : '—'}</td>
      <td>
        <div class="table-actions">
          ${o.status === 'failed' || o.status === 'queued' ? `<button class="btn btn-secondary btn-sm" onclick="handleOrderAction('${esc(o.id)}', 'retry')">Retry</button>` : ''}
          ${o.status !== 'completed' ? `<button class="btn btn-secondary btn-sm" onclick="handleOrderAction('${esc(o.id)}', 'complete')">Done</button>` : ''}
          <button class="btn btn-danger btn-sm" onclick="handleOrderAction('${esc(o.id)}', 'delete')">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
}

window.handleOrderAction = async function (id, action) {
  try {
    const res = await api('/api/order/action', {
      method: 'POST',
      body: JSON.stringify({ id, action })
    });
    if (res.queue) QUEUE = res.queue;
    renderDeliveryQueue();
    renderOverviewOrders();
    toast(`Order ${action}d successfully`);
  } catch (err) {
    toast(`Action failed: ${err.message}`);
  }
};

// Filter tab clicks
document.querySelectorAll('#order-status-filters .filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#order-status-filters .filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    CURRENT_FILTER = btn.dataset.filter;
    renderDeliveryQueue();
  });
});

$('order-search-input')?.addEventListener('input', (e) => {
  SEARCH_QUERY = e.target.value.trim();
  renderDeliveryQueue();
});

// Force Sync with Bluxmart Cloud
async function syncBluxmartCloudNow() {
  try {
    const res = await api('/api/sync-now', { method: 'POST' });
    toast('Cloud sync completed');
    await loadStatus();
  } catch (err) {
    toast(`Sync failed: ${err.message}`);
  }
}
$('btn-sync-cloud-now')?.addEventListener('click', syncBluxmartCloudNow);
$('btn-quick-sync-orders')?.addEventListener('click', syncBluxmartCloudNow);

// Manual Order Modal
const modal = $('create-order-modal');
$('btn-open-create-order-modal')?.addEventListener('click', () => {
  if (modal) modal.style.display = 'flex';
});
$('btn-quick-create-order')?.addEventListener('click', () => {
  if (modal) modal.style.display = 'flex';
});
$('btn-close-order-modal')?.addEventListener('click', () => {
  if (modal) modal.style.display = 'none';
});
$('btn-cancel-order-modal')?.addEventListener('click', () => {
  if (modal) modal.style.display = 'none';
});

$('manual-order-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const recipient = $('order-modal-recipient').value.trim();
  const money = Number($('order-modal-money').value || 0);
  const spawners = Number($('order-modal-spawners').value || 0);
  const elytras = Number($('order-modal-elytras').value || 0);

  if (!recipient) {
    toast('Player username is required');
    return;
  }

  try {
    const id = 'TEST-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    await api('/api/deliver', {
      method: 'POST',
      body: JSON.stringify({ id, recipient, money, spawners, elytras })
    });
    if (modal) modal.style.display = 'none';
    $('manual-order-form').reset();
    toast(`Order ${id} queued for ${recipient}!`);
    await loadStatus();
  } catch (err) {
    $('modal-order-msg').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
});

// =============================================================================
// 4. Minecraft Bot Controls & Chat Console
// =============================================================================
async function dispatchBotAction(action) {
  try {
    await api('/api/bot/action', {
      method: 'POST',
      body: JSON.stringify({ action })
    });
    toast(`Bot command '${action}' sent`);
    setTimeout(loadStatus, 1500);
  } catch (err) {
    toast(`Bot action failed: ${err.message}`);
  }
}

$('btn-bot-start')?.addEventListener('click', () => dispatchBotAction('start'));
$('btn-quick-start-bot')?.addEventListener('click', () => dispatchBotAction('start'));
$('btn-bot-stop')?.addEventListener('click', () => dispatchBotAction('stop'));
$('btn-quick-stop-bot')?.addEventListener('click', () => dispatchBotAction('stop'));
$('btn-bot-reconnect')?.addEventListener('click', () => dispatchBotAction('reconnect'));

$('btn-clear-bot-logs')?.addEventListener('click', () => {
  const t = $('bot-live-terminal');
  if (t) t.innerHTML = '<div class="terminal-line text-muted">[Console cleared]</div>';
});
$('btn-clear-overview-logs')?.addEventListener('click', () => {
  const t = $('overview-log-console');
  if (t) t.innerHTML = '<div class="terminal-line text-muted">[Console cleared]</div>';
});

// Send in-game chat or slash command
$('bot-chat-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('bot-chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';

  try {
    await api('/api/bot/chat', {
      method: 'POST',
      body: JSON.stringify({ message: msg })
    });
    appendTerminalLine($('bot-live-terminal'), `> ${msg}`, 'info');
  } catch (err) {
    toast(`Failed to send message: ${err.message}`);
  }
});

// Save Bot Config
$('btn-save-bot-config')?.addEventListener('click', async () => {
  const host = $('mc-host').value.trim();
  const username = $('mc-username').value.trim();
  const authType = $('mc-auth').value;
  const version = $('mc-version').value.trim();
  const joinDelay = Number($('mc-joindelay').value || 1000);
  const safeCmd = $('mc-safe-cmd').value.trim();
  const safetyRadius = Number($('mc-safety-radius').value || 5);
  const tpaTimeout = Number($('mc-tpa-timeout').value || 45);
  const antiAfk = $('mc-antiafk-toggle').checked;
  const autoReconnect = $('mc-autoreconnect-toggle').checked;

  try {
    await api('/api/bot/config', {
      method: 'POST',
      body: JSON.stringify({
        server: host,
        username,
        authType,
        version,
        joinDelay,
        safeReturnCommand: safeCmd,
        safetyRadius,
        tpaTimeout,
        antiAfk,
        autoReconnect
      })
    });
    $('bot-config-msg').innerHTML = '<div class="alert alert-ok">Bot connection settings saved!</div>';
    setTimeout(() => { $('bot-config-msg').innerHTML = ''; }, 3000);
    toast('Settings saved');
  } catch (err) {
    $('bot-config-msg').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
});

// =============================================================================
// 5. Discord Bot Management (Guilds, Roles, Channels, Tickets, Credentials)
// =============================================================================
async function syncDiscordNow() {
  try {
    toast('Syncing Discord server…');
    const res = await api('/api/discord/sync', { method: 'POST' });
    toast('Discord sync completed');
    await loadStatus();
  } catch (err) {
    toast(`Sync failed: ${err.message}`);
  }
}
$('btn-discord-sync-now')?.addEventListener('click', syncDiscordNow);

// Save Discord credentials
$('btn-save-discord-creds')?.addEventListener('click', async () => {
  const token = $('dc-token-input').value.trim();
  const clientId = $('dc-clientid-input').value.trim();
  const guildId = $('dc-guildid-input').value.trim();

  try {
    const res = await api('/api/discord/config', {
      method: 'POST',
      body: JSON.stringify({ token, clientId, guildId })
    });
    $('dc-creds-msg').innerHTML = '<div class="alert alert-ok">Credentials saved! Connecting bot…</div>';
    setTimeout(loadStatus, 2000);
    toast('Credentials saved');
  } catch (err) {
    $('dc-creds-msg').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
});

// Load Guilds & Mappings
async function loadGuilds() {
  try {
    const j = await api('/api/guilds');
    GUILDS = j.guilds || [];
    $('guildlist').innerHTML = GUILDS.length === 0
      ? '<div class="empty">No managed servers yet. The bot syncs automatically when invited.</div>'
      : GUILDS.map((g) => `<button class="row-card${SELECTED_GUILD === g.guildId ? ' selected' : ''}" data-id="${esc(g.guildId)}">
          <div class="grow"><strong>${esc(g.liveName || g.guildId)}</strong><span>${esc(g.guildId)} • ${g.roles} roles • ${g.channels} channels</span></div>
          <span class="tag blue">${esc((g.updatedAt || '').slice(0, 10) || 'saved')}</span>
        </button>`).join('');

    document.querySelectorAll('#guildlist .row-card').forEach((b) =>
      b.addEventListener('click', () => selectGuild(b.dataset.id))
    );
    if (!SELECTED_GUILD && GUILDS[0]) selectGuild(GUILDS[0].guildId);
  } catch {}
}

async function selectGuild(id) {
  SELECTED_GUILD = id;
  document.querySelectorAll('#guildlist .row-card').forEach((b) =>
    b.classList.toggle('selected', b.dataset.id === id)
  );
  try {
    const j = await api('/api/guilds/' + encodeURIComponent(id));
    GUILD_DETAIL = j.guild;
    const g = GUILD_DETAIL;
    $('gtitle').textContent = g.liveName || id;
    $('gsub').textContent = `Updated ${g.updatedAt || 'unknown'} • ${Object.keys(g.roles).length} roles • ${Object.keys(g.channels).length} channels`;

    const chOpts = Object.entries(g.channels).map(([k, v]) => `<option value="${esc(v)}">${esc(k)} — ${esc(v)}</option>`).join('');
    $('f-welcome').innerHTML = chOpts;
    $('f-log').innerHTML = chOpts;
    $('f-welcome').value = g.welcomeChannelId || '';
    $('f-log').value = g.logChannelId || '';
    $('f-cat').value = g.ticketCategoryId || '';

    const roleOpts = Object.entries(g.roles).map(([k, v]) => `<option value="${esc(v)}">${esc(k)} — ${esc(v)}</option>`).join('');
    $('f-role').innerHTML = roleOpts;
    $('f-role').value = g.autoRoleId || '';
    $('gform').style.display = 'block';

    $('gdetail').innerHTML = `
      <h3 style="margin-bottom:8px">Roles Mapped (${Object.keys(g.roles).length})</h3>
      <div class="table-scroll"><table><thead><tr><th>Role Name</th><th>ID</th></tr></thead><tbody>
      ${Object.entries(g.roles).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v)}</td></tr>`).join('')}
      </tbody></table></div>
      <h3 style="margin:14px 0 8px">Channels Mapped (${Object.keys(g.channels).length})</h3>
      <div class="table-scroll"><table><thead><tr><th>Channel Key</th><th>ID</th></tr></thead><tbody>
      ${Object.entries(g.channels).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v)}</td></tr>`).join('')}
      </tbody></table></div>`;
  } catch (err) {
    toast(`Failed to load server details: ${err.message}`);
  }
}

$('gsave')?.addEventListener('click', async () => {
  try {
    const j = await api('/api/guilds/' + encodeURIComponent(SELECTED_GUILD), {
      method: 'PUT',
      body: JSON.stringify({
        welcomeChannelId: $('f-welcome').value,
        logChannelId: $('f-log').value,
        ticketCategoryId: $('f-cat').value.trim(),
        autoRoleId: $('f-role').value
      })
    });
    GUILD_DETAIL = j.guild;
    $('gmsg').innerHTML = '<div class="alert alert-ok">Server mappings saved!</div>';
    setTimeout(() => { $('gmsg').innerHTML = ''; }, 3000);
    toast('Server mappings saved');
  } catch (e) {
    $('gmsg').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
});

// Roles & Template Editor
function colorHex(n) { return '#' + Number(n).toString(16).padStart(6, '0'); }
function colorNum(hex) {
  const h = String(hex).trim().replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return Number.isNaN(v) ? 0 : Math.max(0, Math.min(0xffffff, v));
}

async function loadTemplate() {
  try {
    const j = await api('/api/template');
    TEMPLATE = j.template;
    renderTemplate();
  } catch {}
}

function renderTemplate() {
  if (!TEMPLATE) return;
  // Roles table
  $('roles').innerHTML = (TEMPLATE.roles || []).map((r, i) => `
    <tr data-i="${i}">
      <td><input type="text" class="t-r-name" value="${esc(r.name)}" maxlength="32"></td>
      <td style="width:130px"><input type="color" class="t-r-col" value="${esc(colorHex(r.color))}" style="height:36px;padding:2px"></td>
      <td><input type="text" class="t-r-perms mono" value="${esc((r.perms || []).join(', '))}" placeholder="e.g. Administrator, ManageMessages"></td>
      <td style="width:80px"><button class="btn btn-danger btn-sm t-r-del" type="button">✕</button></td>
    </tr>
  `).join('');

  document.querySelectorAll('.t-r-del').forEach((b) => {
    b.addEventListener('click', (e) => {
      const idx = parseInt(e.target.closest('tr').dataset.i, 10);
      TEMPLATE.roles.splice(idx, 1);
      renderTemplate();
    });
  });

  // Categories & Channels
  $('cats').innerHTML = (TEMPLATE.structure || []).map((b, ci) => `
    <div class="card" style="margin-bottom:14px;background:#0d1320" data-ci="${ci}">
      <div class="form-row" style="margin-bottom:10px">
        <input type="text" class="t-c-name" value="${esc(b.category)}" placeholder="Category name (e.g. 📌 INFO)" style="font-weight:600">
        <div style="text-align:right">
          <button class="btn btn-secondary btn-sm t-ch-add" type="button">+ Channel</button>
          <button class="btn btn-danger btn-sm t-c-del" type="button">Delete Category</button>
        </div>
      </div>
      <div class="table-scroll"><table><thead><tr><th>Key</th><th>Name</th><th>Type</th><th>Topic</th><th></th></tr></thead><tbody>
        ${(b.channels || []).map((ch, chi) => `
          <tr data-chi="${chi}">
            <td style="width:140px"><input type="text" class="t-ch-key mono" value="${esc(ch.key)}" placeholder="rules" maxlength="30"></td>
            <td style="width:180px"><input type="text" class="t-ch-name" value="${esc(ch.name)}" placeholder="📜・rules"></td>
            <td style="width:100px"><select class="t-ch-type"><option value="text"${ch.type === 'text' ? ' selected' : ''}>text</option><option value="voice"${ch.type === 'voice' ? ' selected' : ''}>voice</option></select></td>
            <td><input type="text" class="t-ch-topic" value="${esc(ch.topic || '')}" placeholder="Channel description"></td>
            <td style="width:60px"><button class="btn btn-danger btn-sm t-ch-del" type="button">✕</button></td>
          </tr>
        `).join('')}
      </tbody></table></div>
    </div>
  `).join('');

  document.querySelectorAll('.t-c-del').forEach((b) => {
    b.addEventListener('click', (e) => {
      const ci = parseInt(e.target.closest('[data-ci]').dataset.ci, 10);
      TEMPLATE.structure.splice(ci, 1);
      renderTemplate();
    });
  });

  document.querySelectorAll('.t-ch-del').forEach((b) => {
    b.addEventListener('click', (e) => {
      const ci = parseInt(e.target.closest('[data-ci]').dataset.ci, 10);
      const chi = parseInt(e.target.closest('[data-chi]').dataset.chi, 10);
      TEMPLATE.structure[ci].channels.splice(chi, 1);
      renderTemplate();
    });
  });

  document.querySelectorAll('.t-ch-add').forEach((b) => {
    b.addEventListener('click', (e) => {
      const ci = parseInt(e.target.closest('[data-ci]').dataset.ci, 10);
      TEMPLATE.structure[ci].channels.push({ key: 'new_channel', name: '💬・new-channel', type: 'text', topic: '' });
      renderTemplate();
    });
  });

  // Ticket types table
  $('ttypes').innerHTML = (TEMPLATE.ticketTypes || []).map((t, i) => `
    <tr data-ti="${i}">
      <td style="width:140px"><input type="text" class="t-t-id mono" value="${esc(t.id)}" maxlength="30"></td>
      <td style="width:160px"><input type="text" class="t-t-label" value="${esc(t.label)}" maxlength="40"></td>
      <td style="width:70px"><input type="text" class="t-t-emoji" value="${esc(t.emoji)}" maxlength="8"></td>
      <td style="width:110px"><select class="t-t-style"><option value="Primary"${t.style === 'Primary' ? ' selected' : ''}>Primary</option><option value="Secondary"${t.style === 'Secondary' ? ' selected' : ''}>Secondary</option><option value="Success"${t.style === 'Success' ? ' selected' : ''}>Success</option><option value="Danger"${t.style === 'Danger' ? ' selected' : ''}>Danger</option></select></td>
      <td><input type="text" class="t-t-prompt" value="${esc((TEMPLATE.ticketPrompts || {})[t.id.replace('ticket_', '')] || '')}" placeholder="Prompt sent when opened"></td>
      <td style="width:60px"><button class="btn btn-danger btn-sm t-t-del" type="button">✕</button></td>
    </tr>
  `).join('');

  document.querySelectorAll('.t-t-del').forEach((b) => {
    b.addEventListener('click', (e) => {
      const idx = parseInt(e.target.closest('tr').dataset.ti, 10);
      TEMPLATE.ticketTypes.splice(idx, 1);
      renderTemplate();
    });
  });

  // Panels editor
  const p = TEMPLATE.panels || {};
  const panelField = (key, label, defaultTitle) => `
    <div class="card" style="margin-bottom:12px;background:#0d1320">
      <h4>${esc(label)}</h4>
      <div class="field"><label>Panel Embed Title</label><input type="text" class="t-p-title" data-k="${key}" value="${esc(p[key + 'Title'] || defaultTitle)}"></div>
      <div class="field"><label>Panel Description</label><textarea class="t-p-desc" data-k="${key}">${esc(p[key + 'Description'] || '')}</textarea></div>
    </div>`;

  $('panels').innerHTML =
    panelField('rules', 'Rules Panel', '📜 Rules') +
    panelField('welcome', 'Welcome Panel', 'Welcome! 🛒') +
    panelField('tickets', 'Support / Create Ticket Panel', '🎫 Support') +
    panelField('reviews', 'Review Submission Panel', '⭐ Reviews') +
    panelField('faq', 'FAQ Panel', '❓ FAQ') +
    panelField('partnership', 'Partnership Agreement Panel', '🤝 Sponsorship');
}

function scrapeTemplateForm() {
  const roles = [];
  document.querySelectorAll('#roles tr').forEach((tr) => {
    roles.push({
      name: tr.querySelector('.t-r-name').value.trim(),
      color: colorNum(tr.querySelector('.t-r-col').value),
      perms: tr.querySelector('.t-r-perms').value.split(',').map((s) => s.trim()).filter(Boolean)
    });
  });

  const structure = [];
  document.querySelectorAll('#cats > [data-ci]').forEach((cd) => {
    const category = cd.querySelector('.t-c-name').value.trim();
    const channels = [];
    cd.querySelectorAll('tbody tr').forEach((tr) => {
      channels.push({
        key: tr.querySelector('.t-ch-key').value.trim(),
        name: tr.querySelector('.t-ch-name').value.trim(),
        type: tr.querySelector('.t-ch-type').value,
        topic: tr.querySelector('.t-ch-topic').value.trim()
      });
    });
    structure.push({ category, channels });
  });

  const ticketTypes = [];
  const ticketPrompts = {};
  document.querySelectorAll('#ttypes tr').forEach((tr) => {
    const id = tr.querySelector('.t-t-id').value.trim();
    ticketTypes.push({
      id,
      label: tr.querySelector('.t-t-label').value.trim(),
      emoji: tr.querySelector('.t-t-emoji').value.trim(),
      style: tr.querySelector('.t-t-style').value
    });
    ticketPrompts[id.replace('ticket_', '')] = tr.querySelector('.t-t-prompt').value.trim();
  });

  const panels = {};
  document.querySelectorAll('.t-p-title').forEach((inp) => { panels[inp.dataset.k + 'Title'] = inp.value; });
  document.querySelectorAll('.t-p-desc').forEach((tx) => { panels[tx.dataset.k + 'Description'] = tx.value; });

  return { roles, structure, ticketTypes, ticketPrompts, panels };
}

$('role-add')?.addEventListener('click', () => {
  TEMPLATE.roles.push({ name: 'NewRole', color: 0x99aab5, perms: [] });
  renderTemplate();
});
$('cat-add')?.addEventListener('click', () => {
  TEMPLATE.structure.push({ category: '📁 NEW CATEGORY', channels: [{ key: 'chat', name: '💬・chat', type: 'text', topic: '' }] });
  renderTemplate();
});
$('t-add')?.addEventListener('click', () => {
  TEMPLATE.ticketTypes.push({ id: 'ticket_custom', label: 'Custom', emoji: '✨', style: 'Primary' });
  renderTemplate();
});

$('t-save')?.addEventListener('click', async () => {
  try {
    const t = scrapeTemplateForm();
    const res = await api('/api/template', { method: 'PUT', body: JSON.stringify({ template: t }) });
    TEMPLATE = t;
    $('tmsg').innerHTML = '<div class="alert alert-ok">Template saved! Reconciling Discord servers…</div>';
    setTimeout(() => { $('tmsg').innerHTML = ''; }, 3000);
    toast('Template saved & applied');
  } catch (err) {
    $('tmsg').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
});

$('k-save')?.addEventListener('click', async () => {
  try {
    const t = scrapeTemplateForm();
    await api('/api/template', { method: 'PUT', body: JSON.stringify({ template: t }) });
    TEMPLATE = t;
    $('kmsg').innerHTML = '<div class="alert alert-ok">Tickets and panels saved!</div>';
    setTimeout(() => { $('kmsg').innerHTML = ''; }, 3000);
    toast('Tickets and panels saved');
  } catch (err) {
    $('kmsg').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
});

$('t-reset')?.addEventListener('click', async () => {
  if (!confirm('Reset template to default roles and channels?')) return;
  try {
    const j = await api('/api/template/defaults');
    TEMPLATE = j.template;
    renderTemplate();
    toast('Restored defaults');
  } catch (err) {
    toast(`Failed: ${err.message}`);
  }
});

// =============================================================================
// 6. Security & Settings (Change Password)
// =============================================================================
$('pw-save')?.addEventListener('click', async () => {
  const currentPassword = $('pw-cur').value;
  const newUsername = $('pw-user').value.trim();
  const newPassword = $('pw-new').value;

  if (!currentPassword) {
    $('pwmsg').innerHTML = '<div class="alert alert-error">Current password is required.</div>';
    return;
  }
  if (!newPassword || newPassword.length < 10) {
    $('pwmsg').innerHTML = '<div class="alert alert-error">New password must be at least 10 characters.</div>';
    return;
  }

  try {
    await api('/api/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newUsername, newPassword })
    });
    $('pwmsg').innerHTML = '<div class="alert alert-ok">Password updated successfully!</div>';
    $('pw-cur').value = '';
    $('pw-new').value = '';
    toast('Password changed');
  } catch (err) {
    $('pwmsg').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
});

// =============================================================================
// 7. Initialization & Auth Boot
// =============================================================================
async function init() {
  try {
    const me = await api('/api/me');
    CSRF = me.csrf || '';
    $('uname').textContent = me.username || 'Admin';
    $('avatar').textContent = (me.username || 'A')[0].toUpperCase();

    // Start Real-time SSE Log Stream
    initSSE();

    // Load Live Data
    await loadStatus();
    await loadGuilds();
    await loadTemplate();

    // Recurring 5s polling for background queue updates
    setInterval(loadStatus, 5000);
  } catch (err) {
    console.warn('[init error]', err);
  }
}

init();
