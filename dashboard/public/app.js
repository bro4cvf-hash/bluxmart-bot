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
  overview: ['Overview', 'System status and recent activity'],
  delivery: ['Auto-Delivery', 'Order queue and cloud synchronization'],
  botting: ['Minecraft Bot', 'Session controls, inventory, and telemetry'],
  discord: ['Discord Bot', 'Server configuration, roles, and tickets'],
  settings: ['Security & Settings', 'Access control and console security']
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
  // Smart bottom scroll detection: only auto-scroll if user is already near bottom
  const isNearBottom = (consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight) <= 40;
  const line = document.createElement('div');
  line.className = `terminal-line terminal-${type}`;
  const now = new Date().toTimeString().split(' ')[0];
  line.innerHTML = `<span class="terminal-time">[${now}]</span> ${esc(text)}`;
  consoleEl.appendChild(line);
  while (consoleEl.children.length > 200) {
    consoleEl.removeChild(consoleEl.firstChild);
  }
  if (isNearBottom) {
    consoleEl.scrollTop = consoleEl.scrollHeight;
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
    const [orderId, recipient, status, err, currentStep, fullOrder] = args;
    const type = (status === 'failed' || status === 'aborted') ? 'error' : (status === 'completed' ? 'success' : 'info');
    const msg = `[Order] ${orderId} (${recipient}) ${status}${err ? `: ${err}` : ''}`;
    appendTerminalLine(terminal, msg, type);
    appendTerminalLine(overviewTerm, msg, type);

    // Update order in QUEUE array directly
    let existing = (QUEUE || []).find((o) => (o.id || o.orderId) === orderId);
    if (existing) {
      if (fullOrder && typeof fullOrder === 'object') {
        Object.assign(existing, fullOrder);
      }
      if (recipient) existing.recipient = recipient;
      if (status) existing.status = status;
      if (err !== undefined) existing.lastError = err;
      if (currentStep !== undefined && currentStep !== null) existing.currentStep = currentStep;
      existing.updatedAt = Date.now();
    } else {
      const newOrder = (fullOrder && typeof fullOrder === 'object') ? { ...fullOrder } : {
        id: orderId,
        orderId,
        recipient,
        status,
        lastError: err,
        currentStep,
        updatedAt: Date.now()
      };
      if (!QUEUE) QUEUE = [];
      QUEUE.unshift(newOrder);
    }

    renderActiveDeliveryStepper(QUEUE);
    renderOverviewOrders();
    renderDeliveryQueue();
  } else if (channel === 'botEvent') {
    const info = args[0] || {};
    if (info.event === 'chat') {
      appendTerminalLine(terminal, `[${info.id}] ${info.message}`, 'chat');
      appendTerminalLine(overviewTerm, `[${info.id}] ${info.message}`, 'chat');
    } else if (info.event === 'login') {
      appendTerminalLine(terminal, `[${info.id}] Successfully connected to server!`, 'success');
      loadStatus();
    } else if (info.event === 'kicked') {
      appendTerminalLine(terminal, `[${info.id}] Kicked from server: ${info.message}`, 'error');
      loadStatus();
    } else if (info.event === 'end') {
      appendTerminalLine(terminal, `[${info.id}] Disconnected: ${info.message}`, 'error');
      loadStatus();
    } else if (info.event === 'reconnecting') {
      appendTerminalLine(terminal, `[${info.id}] Reconnecting: ${info.message}`, 'info');
    } else if (info.event === 'inventory') {
      renderBotInventory(info.message);
    } else if (info.event === 'authmsg') {
      showMicrosoftDeviceCodeBanner(info.message, 'https://www.microsoft.com/link', `Microsoft sign-in for ${info.id}`);
    } else if (info.event === 'easymcAuth') {
      appendTerminalLine(terminal, `[EasyMC] Alt token required. Get one at https://easymc.io/get`, 'error');
    }
  } else if (channel === 'microsoftAuth') {
    const info = args[0] || {};
    if (info.status === 'code') {
      showMicrosoftDeviceCodeBanner(info.code, info.verificationUri || 'https://www.microsoft.com/link', 'Sign in with your Microsoft account');
    } else if (info.status === 'success') {
      hideMicrosoftDeviceCodeBanner();
      toast(`Microsoft account "${info.name}" linked successfully!`);
      if ($('mc-username')) $('mc-username').value = info.accountId || info.name;
      loadStatus();
    } else if (info.status === 'error') {
      hideMicrosoftDeviceCodeBanner();
      toast(`Microsoft sign-in failed: ${info.message}`);
    }
  } else if (channel === 'notify') {
    const [title, body, type] = args;
    toast(`${title}: ${body}`);
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

    // Populate Active Bot Selector
    const botSelect = $('mc-active-bot-select');
    if (botSelect) {
      const activeUsers = bot.activeUsernames || (bot.username ? [bot.username] : []);
      const prevVal = botSelect.value;
      botSelect.innerHTML = `<option value="*">All Connected Bots (${activeUsers.length})</option>` +
        activeUsers.map((u) => `<option value="${esc(u)}">${esc(u)} (Connected)</option>`).join('');
      if (prevVal && (prevVal === '*' || activeUsers.includes(prevVal))) {
        botSelect.value = prevVal;
      }
    }

    // Populate Connection Profile Inputs if not focused
    const cfg = data.config?.value || {};
    const cfgBool = data.config?.boolean || {};
    const setIfClean = (id, val) => {
      const el = $(id);
      if (el && document.activeElement !== el && val !== undefined) {
        if (el.type === 'checkbox') el.checked = Boolean(val);
        else el.value = val;
      }
    };

    setIfClean('mc-host', cfg.server || 'donutsmp.net:25565');
    setIfClean('mc-username', cfg.username || '');
    setIfClean('mc-auth', cfg.authType || 'microsoft');
    setIfClean('mc-version', cfg.version || '1.20.4');
    setIfClean('mc-bot-max', cfg.botMax || 1);
    setIfClean('mc-joindelay', cfg.joinDelay || 1000);
    setIfClean('mc-join-msg', cfg.joinMessage || '');
    setIfClean('mc-name-type', cfg.nameType || 'default');
    $('mc-name-type')?.dispatchEvent(new Event('change'));
    setIfClean('mc-safe-cmd', cfg.safeReturnCommand || '/home 1');
    setIfClean('mc-safety-radius', cfg.safetyRadius || 5);
    setIfClean('mc-tpa-timeout', cfg.tpaTimeout || 45);
    setIfClean('mc-antiafk-toggle', cfgBool.antiAfk !== undefined ? cfgBool.antiAfk : true);
    setIfClean('mc-autoreconnect-toggle', cfgBool.autoReconnect !== undefined ? cfgBool.autoReconnect : true);

    // Render Linked Microsoft Accounts & Account Presets
    renderLinkedMicrosoftAccounts(data.linkedMicrosoftAccounts || []);
    renderAccountPresets(data.accountPresets || []);
    if (cfg.accListPreset && $('mc-acclist-preset')) {
      $('mc-acclist-preset').value = cfg.accListPreset;
    }

    // Render Bot Viewer & Radar if data exists
    if (bot.viewer) {
      renderBotViewer(bot.viewer);
    }

    // Render Queues
    renderDeliveryQueue();
    renderOverviewOrders();
    renderActiveDeliveryStepper(QUEUE);
  } catch (err) {
    console.error('[loadStatus error]', err);
  }
}

$('refresh')?.addEventListener('click', async () => {
  await loadStatus();
  toast('Status refreshed');
});

// =============================================================================
// 3. Auto-Delivery Queue Management & Stepper
// =============================================================================
const DELIVERY_STEPS = [
  { key: 'online_check', label: 'Online Check', icon: '👤' },
  { key: 'ec_prep',      label: 'Base & EC Prep', icon: '🏠' },
  { key: 'withdraw',     label: 'Retrieving Items', icon: '💎' },
  { key: 'tpa_request',  label: 'Sending TPA',   icon: '✉️' },
  { key: 'teleport',     label: 'Teleporting',   icon: '⚡' },
  { key: 'safety_check', label: 'Safety Check',  icon: '🛡️' },
  { key: 'toss_items',   label: 'Tossing Items', icon: '🎁' },
  { key: 'return_home',  label: 'Returning /home 1', icon: '🏠' },
  { key: 'completed',    label: 'Delivered',     icon: '✅' }
];

function renderActiveDeliveryStepper(queue) {
  const q = queue || QUEUE || [];
  const now = Date.now();
  const isRecent = (o) => {
    const t = o.updatedAt || o.completedAt || o.failedAt || o.timestamp || o.time;
    if (!t) return false;
    const ts = typeof t === 'number' ? t : new Date(t).getTime();
    return !isNaN(ts) && (now - ts) < 20000;
  };

  const activeOrder = q.find((o) => o.status === 'delivering') ||
                      q.find((o) => (o.status === 'completed' || o.status === 'failed' || o.status === 'aborted') && isRecent(o));

  const activeCont = $('active-delivery-container');
  const overviewCont = $('overview-delivery-container');

  if (!activeOrder) {
    if (activeCont) activeCont.style.display = 'none';
    if (overviewCont) overviewCont.style.display = 'none';
    return;
  }

  if (activeCont) activeCont.style.display = 'block';
  if (overviewCont) overviewCont.style.display = 'block';

  // Compute current step index using activeOrder.currentStep (fallback to deduction)
  let currentStepIndex = -1;
  const rawStep = activeOrder.currentStep;
  if (rawStep !== undefined && rawStep !== null && rawStep !== '') {
    if (typeof rawStep === 'number') {
      if (rawStep >= 0 && rawStep < DELIVERY_STEPS.length) currentStepIndex = rawStep;
      else if (rawStep >= 1 && rawStep <= DELIVERY_STEPS.length) currentStepIndex = rawStep - 1;
    } else {
      const s = String(rawStep).toLowerCase().trim();
      currentStepIndex = DELIVERY_STEPS.findIndex((st) => st.key.toLowerCase() === s || st.label.toLowerCase() === s);
      if (currentStepIndex === -1) {
        if (s.includes('online')) currentStepIndex = 0;
        else if (s.includes('prep') || s.includes('ec') || s.includes('base')) currentStepIndex = 1;
        else if (s.includes('withdr') || s.includes('retriev') || s.includes('item')) currentStepIndex = 2;
        else if (s.includes('tpa')) currentStepIndex = 3;
        else if (s.includes('teleport') || s.includes('tp')) currentStepIndex = 4;
        else if (s.includes('safe') || s.includes('hazard')) currentStepIndex = 5;
        else if (s.includes('toss') || s.includes('drop')) currentStepIndex = 6;
        else if (s.includes('home') || s.includes('return')) currentStepIndex = 7;
        else if (s.includes('complete') || s.includes('deliver')) currentStepIndex = 8;
      }
    }
  }

  // Fallback deduction
  if (currentStepIndex === -1) {
    if (activeOrder.status === 'completed') {
      currentStepIndex = DELIVERY_STEPS.length - 1;
    } else if (activeOrder.status === 'queued') {
      currentStepIndex = 0;
    } else {
      const err = String(activeOrder.lastError || activeOrder.err || activeOrder.error || '').toLowerCase();
      if (activeOrder.hazard || err.includes('hazard') || err.includes('safety') || err.includes('lava') || err.includes('enemy') || err.includes('pvp')) {
        currentStepIndex = 5; // safety_check
      } else if (err.includes('offline') || err.includes('not online')) {
        currentStepIndex = 0; // online_check
      } else if (err.includes('chest') || err.includes('withdraw') || err.includes('stock')) {
        currentStepIndex = 2; // withdraw
      } else if (err.includes('tpa') || err.includes('not accepted') || err.includes('timeout')) {
        currentStepIndex = 3; // tpa_request
      } else if (err.includes('teleport') || err.includes('tp')) {
        currentStepIndex = 4; // teleport
      } else if (err.includes('toss') || err.includes('drop')) {
        currentStepIndex = 6; // toss_items
      } else if (err.includes('home')) {
        currentStepIndex = 7; // return_home
      } else {
        currentStepIndex = 0;
      }
    }
  }

  const isCompletedOrder = activeOrder.status === 'completed';
  const isHazard = Boolean(
    activeOrder.hazard ||
    activeOrder.status === 'aborted' ||
    activeOrder.status === 'failed' ||
    (activeOrder.lastError && /hazard|abort|safety|threat|danger|lava|pvp/i.test(activeOrder.lastError))
  );

  // Update order header meta and status badges
  const orderId = activeOrder.id || activeOrder.orderId || '—';
  const recipient = activeOrder.recipient || activeOrder.minecraftUsername || '—';
  const metaText = `Order #${orderId} • Delivering to ${recipient}`;
  if ($('overview-delivery-meta')) $('overview-delivery-meta').textContent = metaText;
  if ($('active-delivery-meta')) $('active-delivery-meta').textContent = metaText;

  let badgeText = 'In Progress';
  let badgeClass = 'badge blue';
  if (isCompletedOrder) {
    badgeText = 'Delivered';
    badgeClass = 'badge green';
  } else if (isHazard) {
    badgeText = 'Hazard Aborted';
    badgeClass = 'badge red';
  } else if (DELIVERY_STEPS[currentStepIndex]) {
    badgeText = DELIVERY_STEPS[currentStepIndex].label;
    badgeClass = 'badge blue';
  }
  if ($('overview-delivery-step-badge')) {
    $('overview-delivery-step-badge').textContent = badgeText;
    $('overview-delivery-step-badge').className = badgeClass;
  }
  if ($('active-delivery-step-badge')) {
    $('active-delivery-step-badge').textContent = badgeText;
    $('active-delivery-step-badge').className = badgeClass;
  }

  // Build stepper nodes and connector links
  let html = '';
  for (let i = 0; i < DELIVERY_STEPS.length; i++) {
    const step = DELIVERY_STEPS[i];
    let nodeClass = 'pending';
    let icon = step.icon;

    if (isCompletedOrder) {
      nodeClass = 'completed';
      icon = '✓';
    } else if (isHazard) {
      if (i < currentStepIndex) {
        nodeClass = 'completed';
        icon = '✓';
      } else if (i === currentStepIndex) {
        nodeClass = 'hazard_aborted';
        icon = '⚠️';
      } else {
        nodeClass = 'pending';
        icon = step.icon;
      }
    } else {
      if (i < currentStepIndex) {
        nodeClass = 'completed';
        icon = '✓';
      } else if (i === currentStepIndex) {
        nodeClass = 'active';
        icon = step.icon;
      } else {
        nodeClass = 'pending';
        icon = step.icon;
      }
    }

    html += `<div class="stepper-node ${nodeClass}">` +
              `<div class="node-circle">${icon}</div>` +
              `<div class="node-label">${esc(step.label)}</div>` +
            `</div>`;

    if (i < DELIVERY_STEPS.length - 1) {
      let linkClass = '';
      if (isCompletedOrder) {
        linkClass = 'completed';
      } else if (i < currentStepIndex) {
        linkClass = 'completed';
      } else if (i === currentStepIndex && !isHazard) {
        linkClass = 'active';
      }
      html += `<div class="stepper-link ${linkClass}"></div>`;
    }
  }

  const graphEl = $('delivery-stepper-graph');
  if (graphEl) graphEl.innerHTML = html;
  const overviewGraphEl = $('overview-delivery-stepper');
  if (overviewGraphEl) overviewGraphEl.innerHTML = html;

  // Hazard Alert message handling
  const hazardAlertEl = $('delivery-stepper-alert');
  const overviewAlertEl = $('overview-delivery-alert');
  const hazardTextEl = $('delivery-stepper-alert-text');
  const overviewTextEl = $('overview-delivery-alert-text');

  if (isHazard) {
    const errMsg = activeOrder.lastError || (activeOrder.hazard ? `Hazard "${activeOrder.hazard.name || 'Threat'}" detected in vicinity. Delivery aborted!` : 'Delivery aborted due to hazard.');
    if (hazardAlertEl) hazardAlertEl.style.display = 'flex';
    if (overviewAlertEl) overviewAlertEl.style.display = 'flex';
    if (hazardTextEl) hazardTextEl.textContent = errMsg;
    if (overviewTextEl) overviewTextEl.textContent = errMsg;
  } else {
    if (hazardAlertEl) hazardAlertEl.style.display = 'none';
    if (overviewAlertEl) overviewAlertEl.style.display = 'none';
  }
}

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
        ${(o.lastError || o.error) ? `<div class="hint" style="color:var(--danger)">${esc(o.lastError || o.error)}</div>` : ''}
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
// 4. TrafficerMC Account Manager, Inventory Viewer, Bot Radar & Controller
// =============================================================================
let ACCOUNT_PRESETS = [];
let LINKED_MS_ACCOUNTS = [];
let SELECTED_PRESET_ID = null;
let CURRENT_VIEWER_BOT = '*';
let LAST_VIEWER_DATA = null;
let RADAR_ANIM_FRAME = null;

// Subnav inside Minecraft Bot View
document.querySelectorAll('.mc-subnav-btn').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.mc-subnav-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    const subId = b.dataset.mcsub;
    document.querySelectorAll('.mc-subview').forEach((s) => s.classList.remove('active'));
    const target = $(subId);
    if (target) target.classList.add('active');
    if (subId === 'mc-sub-viewer' && LAST_VIEWER_DATA) {
      renderRadar(LAST_VIEWER_DATA);
    }
  });
});

// Active Bot Selector dropdown
$('mc-active-bot-select')?.addEventListener('change', (e) => {
  CURRENT_VIEWER_BOT = e.target.value;
  refreshViewerData();
});

// Microsoft Device Code Banner
function showMicrosoftDeviceCodeBanner(code, url, title) {
  const banner = $('mc-msa-code-banner');
  if (!banner) return;
  banner.style.display = 'block';
  if ($('mc-msa-code-display')) $('mc-msa-code-display').textContent = code;
  if ($('mc-msa-banner-title') && title) $('mc-msa-banner-title').textContent = title;
  if ($('mc-open-msa-link') && url) $('mc-open-msa-link').href = url;
  if ($('mc-msa-status-hint')) $('mc-msa-status-hint').textContent = 'Waiting for activation on microsoft.com/link…';
}

function hideMicrosoftDeviceCodeBanner() {
  const banner = $('mc-msa-code-banner');
  if (banner) banner.style.display = 'none';
}

$('btn-close-msa-banner')?.addEventListener('click', hideMicrosoftDeviceCodeBanner);

$('btn-copy-msa-code')?.addEventListener('click', async () => {
  const code = $('mc-msa-code-display')?.textContent?.trim();
  if (!code) return;
  await navigator.clipboard.writeText(code).catch(() => {});
  toast(`Copied code "${code}" to clipboard!`);
});

// Link Microsoft Account API Call
async function startMicrosoftAccountLink(presetId = null) {
  try {
    toast('Generating Microsoft sign-in code…');
    const res = await api('/api/bot/microsoft-auth', {
      method: 'POST',
      body: JSON.stringify({ presetId })
    });
    showMicrosoftDeviceCodeBanner('--------', 'https://www.microsoft.com/link', 'Sign in with your Microsoft account');
  } catch (err) {
    toast(`Failed to start Microsoft link: ${err.message}`);
  }
}

$('btn-quick-link-microsoft')?.addEventListener('click', () => startMicrosoftAccountLink());
$('btn-link-ms-account-card')?.addEventListener('click', () => startMicrosoftAccountLink());
$('btn-preset-add-ms')?.addEventListener('click', () => startMicrosoftAccountLink(SELECTED_PRESET_ID));

// Account source mode toggle
$('mc-name-type')?.addEventListener('change', (e) => {
  const isPreset = e.target.value === 'acclist';
  if ($('mc-preset-select-row')) $('mc-preset-select-row').style.display = isPreset ? 'block' : 'none';
  if ($('mc-single-user-row')) $('mc-single-user-row').style.display = isPreset ? 'none' : 'grid';
});

// Linked MS Picker dropdown change
$('mc-linked-ms-picker')?.addEventListener('change', (e) => {
  if (e.target.value && $('mc-username')) {
    $('mc-username').value = e.target.value;
    if ($('mc-auth')) $('mc-auth').value = 'microsoft';
  }
});

// Render Linked Microsoft Accounts
function renderLinkedMicrosoftAccounts(accounts = []) {
  LINKED_MS_ACCOUNTS = accounts;
  const listEl = $('mc-linked-ms-list');
  const countEl = $('mc-linked-ms-count');
  const pickerEl = $('mc-linked-ms-picker');

  if (countEl) countEl.textContent = accounts.length;

  if (pickerEl) {
    const currentVal = pickerEl.value;
    pickerEl.innerHTML = '<option value="">Linked MS Account…</option>' +
      accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name || a.id)}</option>`).join('');
    if (currentVal) pickerEl.value = currentVal;
  }

  if (!listEl) return;
  if (accounts.length === 0) {
    listEl.innerHTML = '<div class="empty-cell" style="padding:12px">No Microsoft accounts linked yet. Click "+ Add Microsoft Account" to sign in via microsoft.com/link.</div>';
    return;
  }

  const activeUser = $('mc-username')?.value?.trim();
  listEl.innerHTML = accounts.map((a) => {
    const isActive = activeUser === a.id || activeUser === a.name;
    return `
      <div class="linked-ms-row${isActive ? ' active-account' : ''}">
        <div style="display:flex;align-items:center;gap:10px">
          <img src="https://mc-heads.net/avatar/${encodeURIComponent(a.name || 'MHF_Steve')}/28" style="width:28px;height:28px;border-radius:4px;image-rendering:pixelated" alt="${esc(a.name)}">
          <div>
            <strong style="color:#fff">${esc(a.name)}</strong>
            <div class="muted" style="font-size:11px;font-family:monospace">${esc(a.id)}</div>
          </div>
        </div>
        <div style="display:flex;gap:6px">
          <button type="button" class="btn btn-secondary btn-sm" onclick="selectLinkedMicrosoftAccount('${esc(a.id)}', '${esc(a.name)}')">Use for Bot</button>
          <button type="button" class="btn btn-danger btn-sm" onclick="removeLinkedMicrosoftAccount('${esc(a.id)}')">Remove</button>
        </div>
      </div>
    `;
  }).join('');
}

window.selectLinkedMicrosoftAccount = function(id, name) {
  if ($('mc-username')) $('mc-username').value = id;
  if ($('mc-auth')) $('mc-auth').value = 'microsoft';
  if ($('mc-name-type')) {
    $('mc-name-type').value = 'default';
    $('mc-name-type').dispatchEvent(new Event('change'));
  }
  toast(`Selected Microsoft account "${name}"`);
  renderLinkedMicrosoftAccounts(LINKED_MS_ACCOUNTS);
};

window.removeLinkedMicrosoftAccount = async function(id) {
  const filtered = LINKED_MS_ACCOUNTS.filter((a) => a.id !== id);
  try {
    await api('/api/bot/accounts', {
      method: 'POST',
      body: JSON.stringify({ linkedMicrosoftAccounts: filtered })
    });
    renderLinkedMicrosoftAccounts(filtered);
    toast('Removed Microsoft account');
  } catch (err) {
    toast(`Failed to remove: ${err.message}`);
  }
};

// Account Presets Manager
function renderAccountPresets(presets = []) {
  ACCOUNT_PRESETS = presets;
  const listEl = $('mc-preset-list');
  const dropdownEl = $('mc-acclist-preset');

  if (dropdownEl) {
    const cur = dropdownEl.value;
    dropdownEl.innerHTML = presets.length === 0
      ? '<option value="">No presets created yet</option>'
      : presets.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.authType || 'offline')})</option>`).join('');
    if (cur) dropdownEl.value = cur;
  }

  if (!listEl) return;
  if (presets.length === 0) {
    listEl.innerHTML = '<div class="empty-cell" style="padding:16px">No presets yet</div>';
    if ($('mc-preset-editor')) $('mc-preset-editor').style.display = 'none';
    return;
  }

  listEl.innerHTML = presets.map((p) => `
    <button type="button" class="row-card${SELECTED_PRESET_ID === p.id ? ' selected' : ''}" onclick="selectAccountPreset('${esc(p.id)}')">
      <div class="grow">
        <strong>${esc(p.name)}</strong>
        <span class="muted" style="font-size:11px">${(p.accounts || '').split(/\r?\n/).filter(Boolean).length} accounts • ${esc(p.authType)}</span>
      </div>
      <span class="tag blue">${esc(p.authType === 'microsoft' ? 'MS' : p.authType === 'easymc' ? 'EasyMC' : 'Offline')}</span>
    </button>
  `).join('');

  if (SELECTED_PRESET_ID && presets.some((p) => p.id === SELECTED_PRESET_ID)) {
    selectAccountPreset(SELECTED_PRESET_ID);
  } else if (presets[0]) {
    selectAccountPreset(presets[0].id);
  }
}

window.selectAccountPreset = function(id) {
  SELECTED_PRESET_ID = id;
  const preset = ACCOUNT_PRESETS.find((p) => p.id === id);
  if (!preset) return;

  document.querySelectorAll('#mc-preset-list .row-card').forEach((b) => b.classList.remove('selected'));
  const editor = $('mc-preset-editor');
  if (editor) editor.style.display = 'block';

  if ($('mc-preset-name')) $('mc-preset-name').value = preset.name || 'Unnamed';
  if ($('mc-preset-auth')) $('mc-preset-auth').value = preset.authType || 'offline';
  if ($('mc-preset-accounts')) {
    $('mc-preset-accounts').value = preset.accounts || '';
    updatePresetAccountCount();
  }
};

function updatePresetAccountCount() {
  const txt = $('mc-preset-accounts')?.value || '';
  const count = txt.split(/\r?\n/).filter((a) => a.trim()).length;
  if ($('mc-preset-acc-count')) $('mc-preset-acc-count').textContent = count;
}
$('mc-preset-accounts')?.addEventListener('input', updatePresetAccountCount);

$('btn-add-account-preset')?.addEventListener('click', () => {
  const newId = `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  ACCOUNT_PRESETS.push({
    id: newId,
    name: 'New Preset',
    authType: 'microsoft',
    accounts: ''
  });
  renderAccountPresets(ACCOUNT_PRESETS);
  selectAccountPreset(newId);
});

$('btn-save-preset')?.addEventListener('click', async () => {
  if (!SELECTED_PRESET_ID) return;
  const p = ACCOUNT_PRESETS.find((x) => x.id === SELECTED_PRESET_ID);
  if (!p) return;

  p.name = $('mc-preset-name')?.value.trim() || 'Unnamed';
  p.authType = $('mc-preset-auth')?.value || 'offline';
  p.accounts = $('mc-preset-accounts')?.value || '';

  try {
    await api('/api/bot/accounts', {
      method: 'POST',
      body: JSON.stringify({ accountPresets: ACCOUNT_PRESETS })
    });
    renderAccountPresets(ACCOUNT_PRESETS);
    toast(`Preset "${p.name}" saved!`);
  } catch (err) {
    toast(`Failed to save preset: ${err.message}`);
  }
});

$('btn-use-preset-now')?.addEventListener('click', async () => {
  if (!SELECTED_PRESET_ID) return;
  try {
    await api('/api/bot/accounts', {
      method: 'POST',
      body: JSON.stringify({
        accountPresets: ACCOUNT_PRESETS,
        accListPreset: SELECTED_PRESET_ID,
        nameType: 'acclist'
      })
    });
    if ($('mc-name-type')) {
      $('mc-name-type').value = 'acclist';
      $('mc-name-type').dispatchEvent(new Event('change'));
    }
    if ($('mc-acclist-preset')) $('mc-acclist-preset').value = SELECTED_PRESET_ID;
    toast('Account preset selected for bot spawning!');
  } catch (err) {
    toast(`Failed to set preset: ${err.message}`);
  }
});

$('btn-delete-preset')?.addEventListener('click', async () => {
  if (!SELECTED_PRESET_ID) return;
  ACCOUNT_PRESETS = ACCOUNT_PRESETS.filter((p) => p.id !== SELECTED_PRESET_ID);
  SELECTED_PRESET_ID = ACCOUNT_PRESETS[0]?.id || null;
  try {
    await api('/api/bot/accounts', {
      method: 'POST',
      body: JSON.stringify({ accountPresets: ACCOUNT_PRESETS })
    });
    renderAccountPresets(ACCOUNT_PRESETS);
    toast('Deleted preset');
  } catch (err) {
    toast(`Failed to delete preset: ${err.message}`);
  }
});

// Save Bot Connection Config
$('btn-save-bot-config')?.addEventListener('click', async () => {
  const host = $('mc-host')?.value.trim();
  const username = $('mc-username')?.value.trim();
  const authType = $('mc-auth')?.value;
  const nameType = $('mc-name-type')?.value;
  const accListPreset = $('mc-acclist-preset')?.value;
  const version = $('mc-version')?.value.trim();
  const botMax = Number($('mc-bot-max')?.value || 1);
  const joinDelay = Number($('mc-joindelay')?.value || 1000);
  const joinMessage = $('mc-join-msg')?.value.trim();
  const spoofMode = $('mc-spoof-mode')?.value;
  const safeCmd = $('mc-safe-cmd')?.value.trim();
  const safetyRadius = Number($('mc-safety-radius')?.value || 5);
  const tpaTimeout = Number($('mc-tpa-timeout')?.value || 45);
  const antiAfk = $('mc-antiafk-toggle')?.checked;
  const autoReconnect = $('mc-autoreconnect-toggle')?.checked;

  try {
    await api('/api/bot/config', {
      method: 'POST',
      body: JSON.stringify({
        server: host,
        username,
        authType,
        nameType,
        accListPreset,
        version,
        botMax,
        joinDelay,
        joinMessage,
        spoofMode,
        safeReturnCommand: safeCmd,
        safetyRadius,
        tpaTimeout,
        antiAfk,
        autoReconnect
      })
    });
    $('bot-config-msg').innerHTML = '<div class="alert alert-ok">Bot connection settings saved!</div>';
    setTimeout(() => { $('bot-config-msg').innerHTML = ''; }, 3000);
    toast('Connection settings saved');
    await loadStatus();
  } catch (err) {
    $('bot-config-msg').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
});

// Bot Action Buttons (Start, Stop, Reconnect)
async function dispatchBotAction(action) {
  try {
    const target = $('mc-active-bot-select')?.value || '*';
    await api('/api/bot/action', {
      method: 'POST',
      body: JSON.stringify({ action, target })
    });
    if (action === 'stop') {
      toast(target === '*' ? 'Stopped and disconnected all bots' : `Stopped bot ${target}`);
      appendTerminalLine($('bot-live-terminal'), `[Bot] Stop requested for ${target === '*' ? 'all bots' : target}`, 'error');
    } else if (action === 'start') {
      toast('Starting bot connection…');
      appendTerminalLine($('bot-live-terminal'), '[Bot] Starting connection…', 'info');
    } else {
      toast(`Bot command '${action}' sent`);
    }
    setTimeout(loadStatus, 400);
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

// Chat Sender Form
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

// -----------------------------------------------------------------------------
// Inventory & Container GUI Viewer
// -----------------------------------------------------------------------------
function ensureTooltip() {
  let el = $('itemTooltip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'itemTooltip';
    el.className = 'item-tooltip';
    el.style.display = 'none';
    el.style.top = '0';
    el.style.left = '0';
    document.body.appendChild(el);
  }
  return el;
}

function showItemTooltip(e, item, extraText = '') {
  if (!item) return;
  const tip = ensureTooltip();
  const cleanName = item.displayName || item.name.replace('minecraft:', '').replaceAll('_', ' ');
  let html = `<div class="tooltip-name">${esc(cleanName)}${item.count > 1 ? `<span class="tooltip-count">×${item.count}</span>` : ''}</div>`;
  if (Array.isArray(item.lore)) {
    for (const line of item.lore) {
      const isPrice = /\$/.test(line);
      html += `<div class="${isPrice ? 'tooltip-price' : 'tooltip-lore'}">${esc(line)}</div>`;
    }
  }
  if (extraText) {
    html += `<div class="tooltip-lore" style="color:#94a3b8">${esc(extraText)}</div>`;
  }
  tip.innerHTML = html;
  tip.style.display = 'block';
  positionItemTooltip(e, tip);
}

function positionItemTooltip(e, tip) {
  const pad = 14;
  const r = tip.getBoundingClientRect();
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  if (x + r.width > window.innerWidth) x = e.clientX - r.width - pad;
  if (y + r.height > window.innerHeight) y = e.clientY - r.height - pad;
  const posX = Math.max(4, Math.round(x));
  const posY = Math.max(4, Math.round(y));
  tip.style.transform = `translate3d(${posX}px, ${posY}px, 0)`;
}

function hideItemTooltip() {
  const tip = $('itemTooltip');
  if (tip) tip.style.display = 'none';
}

function createSlotElement(item, onClick, onRightClick, extraText = '') {
  const div = document.createElement('div');
  div.className = 'mc-slot';
  if (item) {
    const rawName = item.name.replace('minecraft:', '');
    const img = document.createElement('img');
    img.src = `/minecraft/textures/item/${rawName}.png`;
    img.alt = item.displayName || rawName;
    img.onerror = () => {
      img.onerror = () => {
        img.onerror = null;
        div.innerHTML = `<span class="item-fallback">${esc(rawName.replaceAll('_', ' '))}</span>`;
        if (item.count > 1) {
          const cnt = document.createElement('span');
          cnt.className = 'item-count';
          cnt.textContent = item.count;
          div.appendChild(cnt);
        }
      };
      img.src = `/minecraft/textures/block/${rawName}.png`;
    };
    div.appendChild(img);
    if (item.count > 1) {
      const cnt = document.createElement('span');
      cnt.className = 'item-count';
      cnt.textContent = item.count;
      div.appendChild(cnt);
    }
    div.addEventListener('mouseenter', (e) => showItemTooltip(e, item, extraText));
    div.addEventListener('mousemove', (e) => positionItemTooltip(e, ensureTooltip()));
    div.addEventListener('mouseleave', hideItemTooltip);
  }
  if (onClick) {
    div.addEventListener('click', onClick);
  }
  if (onRightClick) {
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      onRightClick(e);
    });
  }
  return div;
}

function renderBotInventory(snapshot) {
  if (!snapshot) return;
  const { username, inventory = [], hotbar = [], offhand = null, selectedSlot = 0, openWindow = null, windowId } = snapshot;

  if ($('mc-inv-bot-badge')) $('mc-inv-bot-badge').textContent = `Inspecting: ${username}`;

  // 1. Open Container Window Panel (Chests / Ender Chests / GUIs)
  const openPanel = $('mc-open-window-panel');
  const openGrid = $('mc-open-window-grid');
  const openTitle = $('mc-open-window-title');
  if (openWindow && openPanel && openGrid) {
    openPanel.style.display = 'block';
    if (openTitle) openTitle.textContent = `📦 ${openWindow.title || 'Open Container'}`;
    openGrid.innerHTML = '';
    (openWindow.slots || []).forEach((item, slotIdx) => {
      const slotEl = createSlotElement(
        item,
        (e) => handleWindowSlotClick(username, openWindow.id, slotIdx, 0, e.shiftKey ? 1 : 0),
        (e) => handleWindowSlotClick(username, openWindow.id, slotIdx, 1, e.shiftKey ? 1 : 0),
        'Container Slot • Left-click: move • Shift+Click: quick-move • Right-click: split'
      );
      openGrid.appendChild(slotEl);
    });
  } else if (openPanel) {
    openPanel.style.display = 'none';
  }

  // 2. Main 27-slot Inventory (slots 9..35)
  const invGrid = $('mc-inventory-grid');
  if (invGrid) {
    invGrid.innerHTML = '';
    inventory.forEach((item, i) => {
      const slotIndex = 9 + i;
      const slotEl = createSlotElement(
        item,
        (e) => handleWindowSlotClick(username, windowId, slotIndex, 0, e.shiftKey ? 1 : 0),
        (e) => handleWindowSlotClick(username, windowId, slotIndex, 1, e.shiftKey ? 1 : 0),
        'Inventory Slot • Left-click: move • Shift+Click: quick-move • Right-click: split'
      );
      invGrid.appendChild(slotEl);
    });
  }

  // 3. Hotbar (slots 36..44)
  const hotbarGrid = $('mc-hotbar-grid');
  if (hotbarGrid) {
    hotbarGrid.innerHTML = '';
    hotbar.forEach((item, i) => {
      const slotIndex = 36 + i;
      const slotEl = createSlotElement(
        item,
        (e) => {
          if (e.shiftKey) {
            handleWindowSlotClick(username, windowId, slotIndex, 0, 1);
          } else {
            setHotbarSlot(username, i);
          }
        },
        (e) => handleWindowSlotClick(username, windowId, slotIndex, 1, e.shiftKey ? 1 : 0),
        `Hotbar Slot ${i + 1} • Click to equip • Shift+Click to quick-move`
      );
      if (i === selectedSlot) slotEl.classList.add('held');
      hotbarGrid.appendChild(slotEl);
    });
  }

  // 4. Offhand (slot 45)
  const offhandEl = $('mc-offhand-slot');
  if (offhandEl) {
    offhandEl.innerHTML = '';
    const offhandSlot = createSlotElement(
      offhand,
      (e) => handleWindowSlotClick(username, windowId, 45, 0, e.shiftKey ? 1 : 0),
      (e) => handleWindowSlotClick(username, windowId, 45, 1, e.shiftKey ? 1 : 0),
      'Offhand Slot (45)'
    );
    offhandEl.appendChild(offhandSlot);
  }
}

async function handleWindowSlotClick(username, windowId, slot, mouseButton = 0, mode = 0) {
  try {
    const res = await api('/api/bot/window-click', {
      method: 'POST',
      body: JSON.stringify({ username, windowId, slot, mouseButton, mode })
    });
    if (res.inventory) renderBotInventory(res.inventory);
  } catch (err) {
    toast(`Click error: ${err.message}`);
  }
}

async function setHotbarSlot(username, slot) {
  try {
    const res = await api('/api/bot/hotbar', {
      method: 'POST',
      body: JSON.stringify({ username, slot })
    });
    if (res.inventory) renderBotInventory(res.inventory);
    toast(`Equipped Hotbar Slot ${slot + 1}`);
  } catch (err) {
    toast(`Hotbar error: ${err.message}`);
  }
}

$('btn-close-open-window')?.addEventListener('click', async () => {
  try {
    const res = await api('/api/bot/window-close', {
      method: 'POST',
      body: JSON.stringify({ username: CURRENT_VIEWER_BOT === '*' ? undefined : CURRENT_VIEWER_BOT })
    });
    if (res.inventory) renderBotInventory(res.inventory);
    toast('Closed container');
  } catch (err) {
    toast(`Failed to close container: ${err.message}`);
  }
});

$('btn-inv-open-ec')?.addEventListener('click', async () => {
  try {
    await api('/api/bot/chat', { method: 'POST', body: JSON.stringify({ message: '/ec' }) });
    toast('Executed /ec');
  } catch (err) {
    toast(`Failed: ${err.message}`);
  }
});

$('btn-inv-refresh')?.addEventListener('click', refreshViewerData);

$('btn-inv-drop-all')?.addEventListener('click', async () => {
  if (!confirm('Drop all items in the bot inventory?')) return;
  try {
    await api('/api/bot/control', {
      method: 'POST',
      body: JSON.stringify({ username: CURRENT_VIEWER_BOT, command: 'dropall' })
    });
    toast('Dropping all items…');
    setTimeout(refreshViewerData, 1000);
  } catch (err) {
    toast(`Failed: ${err.message}`);
  }
});

// -----------------------------------------------------------------------------
// Minecraft Bot Viewer & 2D World Radar
// -----------------------------------------------------------------------------
function renderBotViewer(viewer) {
  if (!viewer) return;
  LAST_VIEWER_DATA = viewer;

  if ($('mc-viewer-username')) $('mc-viewer-username').textContent = viewer.username || 'Not Spawned';
  if ($('mc-viewer-state-badge')) {
    $('mc-viewer-state-badge').textContent = viewer.connected ? 'Online' : 'Offline';
    $('mc-viewer-state-badge').className = `badge ${viewer.connected ? 'green' : 'red'}`;
  }
  if ($('mc-viewer-body-img')) {
    $('mc-viewer-body-img').src = `https://mc-heads.net/body/${encodeURIComponent(viewer.username || 'MHF_Steve')}/120`;
  }
  if ($('mc-viewer-dim-label')) {
    $('mc-viewer-dim-label').textContent = `Server: ${viewer.host} • ${viewer.dimension} • ${viewer.gameMode}`;
  }

  // Vitals
  if ($('mc-viewer-health-txt')) $('mc-viewer-health-txt').textContent = `${viewer.health} / 20`;
  if ($('mc-viewer-health-bar')) $('mc-viewer-health-bar').style.width = `${Math.min(100, Math.max(0, (viewer.health / 20) * 100))}%`;

  if ($('mc-viewer-food-txt')) $('mc-viewer-food-txt').textContent = `${viewer.food} / 20 (Sat: ${viewer.saturation})`;
  if ($('mc-viewer-food-bar')) $('mc-viewer-food-bar').style.width = `${Math.min(100, Math.max(0, (viewer.food / 20) * 100))}%`;

  if ($('mc-viewer-xp-txt')) $('mc-viewer-xp-txt').textContent = `Level ${viewer.xpLevel}`;
  if ($('mc-viewer-xp-bar')) $('mc-viewer-xp-bar').style.width = `${Math.min(100, Math.max(0, (viewer.xpProgress || 0) * 100))}%`;

  // Telemetry details
  if (viewer.position && $('mc-viewer-pos')) {
    $('mc-viewer-pos').textContent = `${viewer.position.x}, ${viewer.position.y}, ${viewer.position.z}`;
  }
  if ($('mc-viewer-rot')) $('mc-viewer-rot').textContent = `Yaw: ${viewer.yaw}° / Pitch: ${viewer.pitch}°`;
  if ($('mc-viewer-held')) {
    $('mc-viewer-held').textContent = viewer.heldItem ? `${viewer.heldItem.displayName || viewer.heldItem.name} ×${viewer.heldItem.count}` : 'Empty Hand';
  }
  if ($('mc-viewer-nearby-count')) {
    $('mc-viewer-nearby-count').textContent = `${(viewer.nearbyPlayers || []).length} players nearby`;
  }

  // Ping badge & latency display
  if ($('mc-viewer-ping-badge')) {
    if (viewer.connected && viewer.ping != null) {
      $('mc-viewer-ping-badge').style.display = 'inline-flex';
      if ($('mc-viewer-ping-txt')) $('mc-viewer-ping-txt').textContent = `${viewer.ping}ms`;
      $('mc-viewer-ping-badge').className = `badge ${viewer.ping < 120 ? 'green' : (viewer.ping < 300 ? 'yellow' : 'red')}`;
    } else {
      $('mc-viewer-ping-badge').style.display = 'none';
    }
  }
  if ($('mc-viewer-ping')) {
    $('mc-viewer-ping').textContent = viewer.ping != null ? `${viewer.ping} ms` : '—';
  }
  if ($('mc-viewer-scoreboard')) {
    const sb = viewer.scoreboard;
    $('mc-viewer-scoreboard').textContent = Array.isArray(sb) && sb.length > 0
      ? sb.slice(0, 4).join(' • ')
      : (typeof sb === 'string' && sb ? sb : '—');
  }

  // Nearby Players list
  const pListEl = $('mc-nearby-players-list');
  if (pListEl) {
    const list = viewer.nearbyPlayers || [];
    pListEl.innerHTML = list.length === 0
      ? '<div class="empty-cell" style="padding:10px">No other players within render distance</div>'
      : list.map((p) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:#0d1320;border:1px solid ${p.withinSafetyRadius ? 'var(--danger)' : 'var(--border)'};border-radius:6px;margin-bottom:4px">
          <div style="display:flex;align-items:center;gap:8px">
            <img src="https://mc-heads.net/avatar/${encodeURIComponent(p.username)}/20" style="width:20px;height:20px;border-radius:3px">
            <strong style="color:#fff">${esc(p.username)}</strong>
            <span class="muted" style="font-size:11px">${p.distance}m away</span>
            ${p.withinSafetyRadius ? '<span class="tag red">Perimeter Alert</span>' : ''}
          </div>
          <div style="display:flex;gap:4px">
            <button type="button" class="btn btn-secondary btn-sm" onclick="dispatchBotControl('pathfinder', ['follow', '${esc(p.username)}'])">Follow</button>
            <button type="button" class="btn btn-secondary btn-sm" onclick="dispatchBotChat('/tpa ${esc(p.username)}')">TPA</button>
          </div>
        </div>
      `).join('');
  }

  // Draw 2D Radar Canvas
  renderRadar(viewer);

  // If inventory snapshot is attached, render it as well
  if (viewer.inventory) renderBotInventory(viewer.inventory);
}

function renderRadar(viewer) {
  const canvas = $('mc-radar-canvas');
  if (!canvas || !viewer) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const maxRange = 32; // 32 blocks max radius
  const scale = (Math.min(w, h) / 2 - 16) / maxRange;

  ctx.clearRect(0, 0, w, h);

  // Background Grid Rings
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  [8, 16, 24, 32].forEach((r) => {
    ctx.beginPath();
    ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
    ctx.stroke();
  });

  // Crosshairs
  ctx.beginPath();
  ctx.moveTo(cx, 10); ctx.lineTo(cx, h - 10);
  ctx.moveTo(10, cy); ctx.lineTo(w - 10, cy);
  ctx.stroke();

  // Safety Radius Circle (e.g. 5 blocks)
  const sRad = viewer.safetyRadius || 5;
  ctx.strokeStyle = 'rgba(239, 68, 68, 0.7)';
  ctx.fillStyle = 'rgba(239, 68, 68, 0.08)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.arc(cx, cy, sRad * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);

  // Draw Nearby Entities
  for (const ent of viewer.nearbyEntities || []) {
    if (!viewer.position) break;
    const dx = ent.x - viewer.position.x;
    const dz = ent.z - viewer.position.z;
    const ex = cx + dx * scale;
    const ey = cy + dz * scale;
    if (ex >= 0 && ex <= w && ey >= 0 && ey <= h) {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
      ctx.beginPath();
      ctx.arc(ex, ey, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Draw Nearby Players
  for (const p of viewer.nearbyPlayers || []) {
    if (!viewer.position) break;
    const dx = p.x - viewer.position.x;
    const dz = p.z - viewer.position.z;
    const px = cx + dx * scale;
    const py = cy + dz * scale;
    if (px >= 0 && px <= w && py >= 0 && py <= h) {
      ctx.fillStyle = p.withinSafetyRadius ? '#ef4444' : '#10b981';
      ctx.beginPath();
      ctx.arc(px, py, 4.5, 0, Math.PI * 2);
      ctx.fill();

      // Label
      ctx.font = '10px JetBrains Mono, monospace';
      ctx.fillStyle = '#fff';
      ctx.fillText(`${p.username} (${p.distance}m)`, px + 6, py - 4);
    }
  }

  // Draw Bot Center Indicator (Yellow Triangle / Look Direction)
  ctx.save();
  ctx.translate(cx, cy);
  // Mineflayer yaw: 0 is south, -pi/2 is east, pi is north, pi/2 is west
  const yawAngle = -(viewer.yaw || 0);
  ctx.rotate(yawAngle);

  // Field of View Cone
  ctx.fillStyle = 'rgba(99, 102, 241, 0.2)';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, 48 * scale, -Math.PI / 4, Math.PI / 4);
  ctx.closePath();
  ctx.fill();

  // Bot Arrow
  ctx.fillStyle = '#fbbf24';
  ctx.beginPath();
  ctx.moveTo(0, 8);
  ctx.lineTo(6, -6);
  ctx.lineTo(0, -3);
  ctx.lineTo(-6, -6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Click Radar to Pathfind / Walk
$('mc-radar-canvas')?.addEventListener('click', (e) => {
  if (!LAST_VIEWER_DATA || !LAST_VIEWER_DATA.position) return;
  const canvas = $('mc-radar-canvas');
  const rect = canvas.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const maxRange = 32;
  const scale = (Math.min(canvas.width, canvas.height) / 2 - 16) / maxRange;

  const dx = (clickX - cx) / scale;
  const dz = (clickY - cy) / scale;
  const targetX = Math.round(LAST_VIEWER_DATA.position.x + dx);
  const targetY = Math.round(LAST_VIEWER_DATA.position.y);
  const targetZ = Math.round(LAST_VIEWER_DATA.position.z + dz);

  dispatchBotControl('pathfinder', ['goto', String(targetX), String(targetY), String(targetZ)]);
  toast(`Pathfinding to ${targetX} ${targetY} ${targetZ}…`);
});

$('btn-radar-stop-path')?.addEventListener('click', () => {
  dispatchBotControl('pathfinder', ['stop']);
  toast('Pathfinder stopped');
});

async function refreshViewerData() {
  try {
    const userParam = CURRENT_VIEWER_BOT !== '*' ? `?username=${encodeURIComponent(CURRENT_VIEWER_BOT)}` : '';
    const res = await api(`/api/bot/viewer${userParam}`);
    if (res.viewer) renderBotViewer(res.viewer);
    toast('Bot viewer updated');
  } catch (err) {
    toast(`Viewer error: ${err.message}`);
  }
}

// -----------------------------------------------------------------------------
// TrafficerMC Bot Controller & Scripting
// -----------------------------------------------------------------------------
async function dispatchBotControl(command, args = [], configUpdates = null) {
  try {
    const targetUser = CURRENT_VIEWER_BOT === '*' ? undefined : CURRENT_VIEWER_BOT;
    await api('/api/bot/control', {
      method: 'POST',
      body: JSON.stringify({
        username: targetUser,
        command,
        args,
        configUpdates
      })
    });
  } catch (err) {
    toast(`Control failed: ${err.message}`);
  }
}
window.dispatchBotControl = dispatchBotControl;

window.dispatchBotChat = async function(msg) {
  try {
    await api('/api/bot/chat', { method: 'POST', body: JSON.stringify({ message: msg }) });
    toast(`Sent: ${msg}`);
  } catch (err) {
    toast(`Failed to send: ${err.message}`);
  }
};

// Movement & D-Pad Status Helper
function updateMovementStatus() {
  const activeButtons = document.querySelectorAll('.dpad-btn[data-move].active-move');
  const isMoving = activeButtons.length > 0;
  const statusBadge = $('ctrl-move-status');
  const statusText = $('ctrl-move-status-text');

  if (statusText) {
    statusText.textContent = isMoving ? 'MOVING' : 'IDLE';
  } else if (statusBadge && !statusBadge.querySelector('*')) {
    statusBadge.textContent = isMoving ? 'MOVING' : 'IDLE';
  }

  if (statusBadge) {
    statusBadge.classList.toggle('active', isMoving);
  }
}

// Movement D-Pad Buttons
document.querySelectorAll('.dpad-btn[data-move]').forEach((btn) => {
  const moveType = btn.dataset.move;
  btn.addEventListener('click', () => {
    const isActive = btn.classList.toggle('active-move');
    updateMovementStatus();
    if (isActive) {
      dispatchBotControl('startmove', [moveType]);
      toast(`Started moving ${moveType}`);
    } else {
      dispatchBotControl('stopmove', [moveType]);
      toast(`Stopped moving ${moveType}`);
    }
  });
});

$('btn-ctrl-reset-move')?.addEventListener('click', () => {
  document.querySelectorAll('.dpad-btn[data-move]').forEach((b) => b.classList.remove('active-move'));
  updateMovementStatus();
  dispatchBotControl('resetmove');
  toast('Reset all movement controls');
});

// Look Direction Buttons
document.querySelectorAll('[data-look]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const dir = btn.dataset.look;
    dispatchBotControl('look', [dir]);
    toast(`Looked in direction ${dir}`);
    setTimeout(refreshViewerData, 600);
  });
});

// Hotbar Equip & Actions Helper
function selectHotbarSlot(slot) {
  const slotStr = String(slot);
  const select = $('mc-ctrl-hotbar-slot');
  if (select) {
    select.value = slotStr;
  }
  document.querySelectorAll('.mc-hotbar-slot-btn[data-slot]').forEach((b) => {
    b.classList.toggle('active', b.dataset.slot === slotStr);
  });
  dispatchBotControl('sethotbar', [slotStr]);
  toast(`Equipped slot ${Number(slotStr) + 1}`);
}

// Interactive Hotbar Strip Buttons
document.querySelectorAll('.mc-hotbar-slot-btn[data-slot]').forEach((btn) => {
  btn.addEventListener('click', () => {
    selectHotbarSlot(btn.dataset.slot);
  });
});

$('btn-ctrl-set-hotbar')?.addEventListener('click', () => {
  const slot = $('mc-ctrl-hotbar-slot')?.value || '0';
  selectHotbarSlot(slot);
});
$('mc-ctrl-hotbar-slot')?.addEventListener('change', (e) => {
  const slot = e.target.value;
  document.querySelectorAll('.mc-hotbar-slot-btn[data-slot]').forEach((b) => {
    b.classList.toggle('active', b.dataset.slot === slot);
  });
});
$('btn-ctrl-use-held')?.addEventListener('click', () => {
  dispatchBotControl('useheld');
  toast('Used held item');
});
$('btn-ctrl-swing')?.addEventListener('click', () => {
  dispatchBotControl('swingArm');
  toast('Swung arm');
});

// Pathfinder Run Button & Quick Chips
document.querySelectorAll('.path-chip-btn[data-cmd]').forEach((chip) => {
  chip.addEventListener('click', () => {
    const cmd = chip.dataset.cmd || '';
    const input = $('mc-ctrl-pathfinder');
    if (input) {
      input.value = cmd;
      input.focus();
    }
  });
});

$('btn-ctrl-run-pathfinder')?.addEventListener('click', () => {
  const raw = $('mc-ctrl-pathfinder')?.value.trim();
  if (!raw) return;
  const parts = raw.split(/\s+/);
  dispatchBotControl('pathfinder', parts);
  toast(`Pathfinder command dispatched: ${raw}`);
});

$('mc-ctrl-pathfinder')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('btn-ctrl-run-pathfinder')?.click();
  }
});

// Slot Macros (Left Click, Right Click, Drop Slot, Close Window)
$('btn-ctrl-win-left')?.addEventListener('click', () => {
  const slot = $('mc-ctrl-inv-slot')?.value || '0';
  dispatchBotControl('winclick', [slot, '0']);
  toast(`Left clicked slot ${slot}`);
});
$('btn-ctrl-win-right')?.addEventListener('click', () => {
  const slot = $('mc-ctrl-inv-slot')?.value || '0';
  dispatchBotControl('winclick', [slot, '1']);
  toast(`Right clicked slot ${slot}`);
});
$('btn-ctrl-drop-slot')?.addEventListener('click', () => {
  const slot = $('mc-ctrl-inv-slot')?.value || '0';
  dispatchBotControl('drop', [slot]);
  toast(`Dropped slot ${slot}`);
});
$('btn-ctrl-close-win')?.addEventListener('click', () => {
  dispatchBotControl('closewindow');
  toast('Closed window');
});

// KillAura Toggle & Controls
function updateKillAuraUI() {
  const toggle = $('mc-ctrl-killaura-toggle')?.checked || false;
  $('killaura-master-box')?.classList.toggle('active', toggle);
  $('ka-subtoggles-container')?.classList.toggle('dimmed', !toggle);

  const kaBadge = $('ka-status-badge');
  if (kaBadge) {
    kaBadge.textContent = toggle ? 'ACTIVE' : 'STANDBY';
    kaBadge.classList.toggle('active', toggle);
  }

  const range = $('mc-ka-range')?.value || '4';
  const delay = $('mc-ka-delay')?.value || '10';

  const rangeVal = $('mc-ka-range-val') || $('ka-range-val') || document.querySelector('.ka-range-val');
  if (rangeVal) rangeVal.textContent = `${range}m`;
  const rangeLabel = $('mc-ka-range-label') || $('ka-range-label');
  if (rangeLabel) rangeLabel.textContent = `Range: ${range} Blocks`;

  const delayVal = $('mc-ka-delay-val') || $('ka-delay-val') || document.querySelector('.ka-delay-val');
  if (delayVal) delayVal.textContent = `${delay}t`;
  const delayLabel = $('mc-ka-delay-label') || $('ka-delay-label');
  if (delayLabel) delayLabel.textContent = `Hit Delay: ${delay} Ticks`;
}

function updateKillAura() {
  updateKillAuraUI();
  const toggle = $('mc-ctrl-killaura-toggle')?.checked || false;
  const targetPlayer = $('mc-ka-player')?.checked || false;
  const targetMob = $('mc-ka-mob')?.checked || false;
  const targetAnimal = $('mc-ka-animal')?.checked || false;
  const rotate = $('mc-ka-rotate')?.checked || false;
  const range = Number($('mc-ka-range')?.value || 4);
  const delay = Number($('mc-ka-delay')?.value || 10);

  dispatchBotControl(null, [], {
    boolean: {
      killauraToggle: toggle,
      targetPlayer,
      targetMob,
      targetAnimal,
      killauraRotate: rotate
    },
    value: {
      killauraRange: range,
      killauraDelay: delay
    }
  });
  toast(`KillAura ${toggle ? 'enabled' : 'disabled'}`);
}

$('mc-ctrl-killaura-toggle')?.addEventListener('change', updateKillAura);
$('mc-ka-player')?.addEventListener('change', updateKillAura);
$('mc-ka-mob')?.addEventListener('change', updateKillAura);
$('mc-ka-animal')?.addEventListener('change', updateKillAura);
$('mc-ka-rotate')?.addEventListener('change', updateKillAura);
$('mc-ka-range')?.addEventListener('input', updateKillAuraUI);
$('mc-ka-range')?.addEventListener('change', updateKillAura);
$('mc-ka-delay')?.addEventListener('input', updateKillAuraUI);
$('mc-ka-delay')?.addEventListener('change', updateKillAura);

// Initialize visual controls states
updateKillAuraUI();
updateMovementStatus();

// Script Templates Presets
const SCRIPT_TEMPLATES = {
  afk: `# AFK Anti-Kick Routine
chat /afk
delay 2000
startmove forward
delay 400
stopmove forward
delay 1000
startmove back
delay 400
stopmove back
delay 1500
swingArm`,

  deposit: `# Deposit Macro
chat /deposit
delay 1500
winclick 54 0
delay 250
winclick 55 0
delay 250
winclick 56 0
delay 500
closewindow`,

  home: `# Return /home 1
chat /home 1
delay 3000
look 0
delay 500
sethotbar 0`,

  clear: ''
};

document.querySelectorAll('.script-tmpl-btn[data-tmpl]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tmplKey = (btn.dataset.tmpl || '').toLowerCase();
    const scriptArea = $('mc-ctrl-script-text');
    if (!scriptArea) return;

    let content = '';
    if (tmplKey.includes('afk') || tmplKey.includes('kick')) {
      content = SCRIPT_TEMPLATES.afk;
    } else if (tmplKey.includes('deposit')) {
      content = SCRIPT_TEMPLATES.deposit;
    } else if (tmplKey.includes('home')) {
      content = SCRIPT_TEMPLATES.home;
    } else if (tmplKey.includes('clear')) {
      content = SCRIPT_TEMPLATES.clear;
    } else if (SCRIPT_TEMPLATES[tmplKey] !== undefined) {
      content = SCRIPT_TEMPLATES[tmplKey];
    } else {
      content = btn.dataset.tmpl || '';
    }

    scriptArea.value = content;
    scriptArea.focus();
    toast(`Loaded script preset: ${btn.textContent.trim() || tmplKey}`);
  });
});

// TrafficerMC Scripting Engine
$('btn-ctrl-run-script')?.addEventListener('click', async () => {
  const txt = $('mc-ctrl-script-text')?.value || '';
  const onConnect = $('mc-script-on-connect')?.checked || false;
  const onSpawn = $('mc-script-on-spawn')?.checked || false;

  try {
    await api('/api/bot/control', {
      method: 'POST',
      body: JSON.stringify({
        username: CURRENT_VIEWER_BOT === '*' ? undefined : CURRENT_VIEWER_BOT,
        command: 'runScript',
        scriptText: txt,
        configUpdates: {
          boolean: {
            runOnConnect: onConnect,
            runOnSpawn: onSpawn
          },
          value: {
            scriptText: txt
          }
        }
      })
    });
    toast('Running TrafficerMC script sequence…');
  } catch (err) {
    toast(`Failed to run script: ${err.message}`);
  }
});

$('btn-ctrl-stop-script')?.addEventListener('click', async () => {
  try {
    await api('/api/bot/control', {
      method: 'POST',
      body: JSON.stringify({ command: 'stopScript' })
    });
    toast('Stopped script sequence');
  } catch (err) {
    toast(`Failed: ${err.message}`);
  }
});

// Keyboard Shortcuts: Controller & Scripting
$('mc-ctrl-script-text')?.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Enter') {
    e.preventDefault();
    $('btn-ctrl-run-script')?.click();
  }
});

window.addEventListener('keydown', (e) => {
  const ctrlView = $('mc-sub-controller');
  if (!ctrlView) return;
  const isVisible = ctrlView.classList.contains('active') ||
    (ctrlView.offsetParent !== null && window.getComputedStyle(ctrlView).display !== 'none');
  if (!isVisible) return;

  // Ctrl+Enter inside #mc-ctrl-script-text to run script
  if (e.ctrlKey && e.key === 'Enter' && document.activeElement?.id === 'mc-ctrl-script-text') {
    e.preventDefault();
    $('btn-ctrl-run-script')?.click();
    return;
  }

  // Ignore controller hotkeys if user is actively typing in an input/textarea/select
  const activeEl = document.activeElement;
  const tag = activeEl ? activeEl.tagName.toUpperCase() : '';
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (activeEl && activeEl.isContentEditable);
  if (isInput) return;

  // Escape: STOP ALL movement
  if (e.key === 'Escape') {
    e.preventDefault();
    $('btn-ctrl-reset-move')?.click();
    return;
  }

  // Prevent holding key repeating toggles
  if (e.repeat) return;

  // 1-9 for hotbar slots
  if (e.key >= '1' && e.key <= '9') {
    e.preventDefault();
    const slot = String(Number(e.key) - 1);
    const slotBtn = document.querySelector(`.mc-hotbar-slot-btn[data-slot="${slot}"]`);
    if (slotBtn) {
      slotBtn.click();
    } else {
      selectHotbarSlot(slot);
    }
    return;
  }

  // Movement & Action Keys (W/A/S/D/Arrows for movement, Space for jump, Shift for sneak)
  let moveType = null;
  if (e.code === 'KeyW' || e.key === 'ArrowUp') moveType = 'forward';
  else if (e.code === 'KeyS' || e.key === 'ArrowDown') moveType = 'back';
  else if (e.code === 'KeyA' || e.key === 'ArrowLeft') moveType = 'left';
  else if (e.code === 'KeyD' || e.key === 'ArrowRight') moveType = 'right';
  else if (e.code === 'Space' || e.key === ' ') moveType = 'jump';
  else if (e.key === 'Shift' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') moveType = 'sneak';

  if (moveType) {
    e.preventDefault();
    const btn = document.querySelector(`.dpad-btn[data-move="${moveType}"]`);
    if (btn) {
      btn.click();
    }
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
