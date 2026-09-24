/* Bluxmart Admin SPA — vanilla JS, no dependencies. */
const $ = (id) => document.getElementById(id);
let CSRF = '';
let TEMPLATE = null;
let GUILDS = [];
let SELECTED = null;
let GUILD_DETAIL = null;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2600);
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF, ...(opts.headers || {}) },
  });
  if (r.status === 401) { location.href = '/login'; throw new Error('Session expired.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status}).`);
  return j;
}

// ---- nav ----
const TITLES = {
  overview: ['Overview', 'Live bot status and server configuration.'],
  servers: ['Servers', 'Edit per-server channel mappings saved in data/guilds.json.'],
  template: ['Roles & Channels', 'Live template edits are applied in place without recreating the server.'],
  tickets: ['Tickets & Panels', 'Ticket buttons, prompts and message embeds.'],
  settings: ['Settings', 'Connection info and admin credentials.'],
};
document.querySelectorAll('#nav .nav-btn').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#nav .nav-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    const v = b.dataset.view;
    document.querySelectorAll('.view').forEach((s) => s.classList.remove('active'));
    $('view-' + v).classList.add('active');
    $('title').textContent = TITLES[v][0];
    $('subtitle').textContent = TITLES[v][1];
  });
});

$('logout').addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST', headers: { 'X-CSRF-Token': CSRF } }).catch(() => {});
  location.href = '/login';
});

// ---- status ----
async function loadStatus() {
  try {
    const j = await api('/api/status');
    const b = j.bot;
    $('dot').className = 'dot ' + (b.ready ? 'on' : 'off');
    $('botstate').textContent = b.ready ? `${b.tag} • ${b.ping}ms` : 'Offline';
    $('statgrid').innerHTML = [
      ['Servers', b.guilds, 'Discord guilds connected'],
      ['Latency', b.ping >= 0 ? b.ping + ' ms' : '—', 'Websocket ping'],
      ['Uptime', fmtUptime(b.uptimeSec), 'Dashboard process'],
      ['Sessions', j.dashboard.sessions, 'Active admin logins'],
    ].map(([k, v, s]) => `<div class="card"><h3>${esc(k)}</h3><div class="big">${esc(v)}</div><p class="muted" style="margin:0">${esc(s)}</p></div>`).join('');
    const kv = (k, v) => `<div><small>${esc(k)}</small><code class="mono">${esc(v)}</code></div>`;
    $('envkv').innerHTML =
      kv('Bot token', j.env.token) + kv('Client ID', j.env.clientId) + kv('Dev guild', j.env.guildId) + kv('Dashboard port', j.env.port);
    $('setenv').innerHTML = $('envkv').innerHTML;
  } catch (e) { toast(e.message); }
}
function fmtUptime(s) {
  if (!s && s !== 0) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
$('refresh').addEventListener('click', loadStatus);

// ---- servers ----
async function loadGuilds() {
  const j = await api('/api/guilds');
  GUILDS = j.guilds || [];
  $('guildcount').textContent = `${GUILDS.length} server${GUILDS.length === 1 ? '' : 's'}`;
  $('guildlist').innerHTML = GUILDS.length === 0
    ? '<div class="empty">No managed servers yet. The bot syncs automatically when it connects.</div>'
    : GUILDS.map((g) => `<button class="row-card${SELECTED === g.guildId ? ' selected' : ''}" data-id="${esc(g.guildId)}">
        <div class="grow"><strong>${esc(g.liveName || g.guildId)}</strong><span>${esc(g.guildId)} • ${g.roles} roles • ${g.channels} channels</span></div>
        <span class="tag blue">${esc((g.updatedAt || '').slice(0, 10) || 'saved')}</span>
      </button>`).join('');
  document.querySelectorAll('#guildlist .row-card').forEach((b) => b.addEventListener('click', () => selectGuild(b.dataset.id)));
  if (!SELECTED && GUILDS[0]) selectGuild(GUILDS[0].guildId);
}

async function selectGuild(id) {
  SELECTED = id;
  document.querySelectorAll('#guildlist .row-card').forEach((b) => b.classList.toggle('selected', b.dataset.id === id));
  const j = await api('/api/guilds/' + encodeURIComponent(id));
  GUILD_DETAIL = j.guild;
  const g = GUILD_DETAIL;
  $('gtitle').textContent = id;
  $('gsub').textContent = `Updated ${g.updatedAt || 'unknown'} • ${Object.keys(g.roles).length} roles • ${Object.keys(g.channels).length} channels`;
  // channel selects
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
  $('gdetail').innerHTML = `<h3 style="margin-bottom:8px">Roles</h3>
    <div class="table-scroll"><table><thead><tr><th>Role</th><th>ID</th></tr></thead><tbody>
    ${Object.entries(g.roles).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v)}</td></tr>`).join('')}
    </tbody></table></div>
    <h3 style="margin:14px 0 8px">Channels</h3>
    <div class="table-scroll"><table><thead><tr><th>Key</th><th>ID</th></tr></thead><tbody>
    ${Object.entries(g.channels).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

$('gsave').addEventListener('click', async () => {
  try {
    const j = await api('/api/guilds/' + encodeURIComponent(SELECTED), {
      method: 'PUT',
      body: JSON.stringify({
        welcomeChannelId: $('f-welcome').value,
        logChannelId: $('f-log').value,
        ticketCategoryId: $('f-cat').value.trim(),
        autoRoleId: $('f-role').value,
      }),
    });
    GUILD_DETAIL = j.guild;
    $('gmsg').innerHTML = '<div class="alert alert-ok">Saved.</div>';
    toast('Server mappings saved');
  } catch (e) { $('gmsg').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }
});

// ---- template ----
function colorHex(n) { return '#' + Number(n).toString(16).padStart(6, '0'); }
function colorNum(hex) {
  const h = String(hex).trim().replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return Number.isSafeInteger(v) && v >= 0 && v <= 0xffffff ? v : 0x5865f2;
}

async function loadTemplate() {
  const j = await api('/api/template');
  TEMPLATE = j.template;
  renderRoles();
  renderCats();
  renderTickets();
  renderPanels();
}

function renderRoles() {
  $('roles').innerHTML = TEMPLATE.roles.map((r, i) => `<tr>
    <td><input type="text" data-r="${i}" data-f="name" value="${esc(r.name)}" maxlength="32"></td>
    <td><input type="color" data-r="${i}" data-f="color" value="${esc(colorHex(r.color))}" style="height:40px;padding:4px"></td>
    <td><input type="text" data-r="${i}" data-f="perms" value="${esc((r.perms || []).join(', '))}" placeholder="ManageMessages, KickMembers"></td>
    <td><button class="btn btn-ghost" data-del-role="${i}">Remove</button></td>
  </tr>`).join('');
  document.querySelectorAll('#roles input').forEach((inp) => inp.addEventListener('change', () => {
    const i = +inp.dataset.r, f = inp.dataset.f;
    if (f === 'name') TEMPLATE.roles[i].name = inp.value.trim().slice(0, 32);
    else if (f === 'color') TEMPLATE.roles[i].color = colorNum(inp.value);
    else if (f === 'perms') TEMPLATE.roles[i].perms = inp.value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12);
  }));
  document.querySelectorAll('[data-del-role]').forEach((b) => b.addEventListener('click', () => {
    TEMPLATE.roles.splice(+b.dataset.delRole, 1);
    renderRoles();
  }));
}
$('role-add').addEventListener('click', () => {
  if (TEMPLATE.roles.length >= 50) return toast('Max 50 roles');
  TEMPLATE.roles.push({ name: 'New Role', color: 0x99aab5, perms: [] });
  renderRoles();
});

function renderCats() {
  $('cats').innerHTML = TEMPLATE.structure.map((b, bi) => `<div style="border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:12px;min-width:0">
    <div class="form-row" style="align-items:end">
      <div class="field" style="margin:0"><label>Category name</label><input type="text" data-c="${bi}" data-f="category" value="${esc(b.category)}" maxlength="60"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-secondary" data-ch-add="${bi}">+ Channel</button>
        <button class="btn btn-ghost" data-cat-del="${bi}">Remove</button>
      </div>
    </div>
    <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
    ${b.channels.map((c, ci) => `<div class="form-row">
      <div class="field" style="margin:0"><label>Key</label><input type="text" data-c="${bi}" data-ch="${ci}" data-f="key" value="${esc(c.key)}" maxlength="30"></div>
      <div class="field" style="margin:0"><label>Name</label><input type="text" data-c="${bi}" data-ch="${ci}" data-f="name" value="${esc(c.name)}" maxlength="60"></div>
      <div class="field" style="margin:0"><label>Type</label><select data-c="${bi}" data-ch="${ci}" data-f="type"><option value="text"${c.type === 'text' ? ' selected' : ''}>text</option><option value="voice"${c.type === 'voice' ? ' selected' : ''}>voice</option></select></div>
      <div class="field" style="margin:0"><label>Topic</label><input type="text" data-c="${bi}" data-ch="${ci}" data-f="topic" value="${esc(c.topic || '')}" maxlength="200"></div>
      <div style="display:flex;align-items:flex-end"><button class="btn btn-ghost" data-ch-del="${bi}:${ci}">Remove</button></div>
    </div>`).join('')}
    </div>
  </div>`).join('');
  document.querySelectorAll('#cats input, #cats select').forEach((inp) => inp.addEventListener('change', () => {
    const bi = +inp.dataset.c, f = inp.dataset.f;
    if (inp.dataset.ch === undefined) { TEMPLATE.structure[bi][f] = inp.value.slice(0, 60); return; }
    const ci = +inp.dataset.ch;
    TEMPLATE.structure[bi].channels[ci][f] = inp.value;
  }));
  document.querySelectorAll('[data-cat-del]').forEach((b) => b.addEventListener('click', () => { TEMPLATE.structure.splice(+b.dataset.catDel, 1); renderCats(); }));
  document.querySelectorAll('[data-ch-add]').forEach((b) => b.addEventListener('click', () => {
    const blk = TEMPLATE.structure[+b.dataset.chAdd];
    if (blk.channels.length >= 25) return toast('Max 25 channels per category');
    blk.channels.push({ key: 'new_' + Math.floor(Math.random() * 1000), name: 'new-channel', type: 'text' });
    renderCats();
  }));
  document.querySelectorAll('[data-ch-del]').forEach((b) => b.addEventListener('click', () => {
    const [bi, ci] = b.dataset.chDel.split(':').map(Number);
    TEMPLATE.structure[bi].channels.splice(ci, 1);
    renderCats();
  }));
}
$('cat-add').addEventListener('click', () => {
  if (TEMPLATE.structure.length >= 12) return toast('Max 12 categories');
  TEMPLATE.structure.push({ category: 'New Category', channels: [{ key: 'new_' + Date.now() % 10000, name: 'new-channel', type: 'text' }] });
  renderCats();
});

async function saveTemplate(showMsg = true) {
  // Sync pending inputs through the existing change handlers, then apply live.
  const j = await api('/api/template', { method: 'PUT', body: JSON.stringify({ template: TEMPLATE }) });
  const sync = j.sync || {};
  const failed = (sync.failed || []).length;
  const applied = (sync.applied || []).length;
  const message = failed
    ? `Saved, but live sync failed on ${failed} server(s). Check the visible bot terminal.`
    : sync.queued
      ? 'Saved. Live sync is queued until the bot reconnects.'
      : `Saved and applied in place to ${applied} server(s). Nothing was recreated.`;
  if (showMsg) { $('tmsg').innerHTML = `<div class="alert ${failed ? 'alert-error' : 'alert-ok'}">${esc(message)}</div>`; toast(failed ? 'Saved with sync errors' : 'Saved and synced live'); }
  return j;
}
$('t-save').addEventListener('click', () => saveTemplate().catch((e) => { $('tmsg').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }));
$('t-reset').addEventListener('click', async () => {
  if (!confirm('Restore built-in defaults? Unsaved edits will be lost.')) return;
  const j = await api('/api/template/defaults');
  TEMPLATE = j.template;
  renderRoles(); renderCats(); renderTickets(); renderPanels();
  toast('Defaults loaded — press Save to keep them');
});

// ---- tickets & panels ----
const PANEL_FIELDS = [
  ['rulesTitle', 'Rules title', false], ['rulesDescription', 'Rules description', true],
  ['faqTitle', 'FAQ title', false], ['faqDescription', 'FAQ description', true],
  ['welcomeTitle', 'Welcome title', false], ['welcomeDescription', 'Welcome description', true],
  ['reviewsTitle', 'Reviews title', false], ['reviewsDescription', 'Reviews description', true],
  ['ticketsTitle', 'Tickets title', false], ['ticketsDescription', 'Tickets description', true],
  ['partnershipTitle', 'Partnership title', false], ['partnershipDescription', 'Partnership description', true],
];
function renderTickets() {
  $('ttypes').innerHTML = TEMPLATE.ticketTypes.map((t, i) => `<tr>
    <td><input type="text" data-t="${i}" data-f="id" value="${esc(t.id)}" maxlength="40"></td>
    <td><input type="text" data-t="${i}" data-f="label" value="${esc(t.label)}" maxlength="40"></td>
    <td><input type="text" data-t="${i}" data-f="emoji" value="${esc(t.emoji)}" maxlength="16" style="max-width:90px"></td>
    <td><select data-t="${i}" data-f="style">${['Primary', 'Secondary', 'Success', 'Danger'].map((s) => `<option${s === t.style ? ' selected' : ''}>${s}</option>`).join('')}</select></td>
    <td><input type="text" data-t="${i}" data-f="prompt" value="${esc(TEMPLATE.ticketPrompts[t.id.replace('ticket_', '')] || '')}" maxlength="300" placeholder="Prompt shown in ticket…"></td>
    <td><button class="btn btn-ghost" data-tdel="${i}">Remove</button></td>
  </tr>`).join('');
  document.querySelectorAll('#ttypes input, #ttypes select').forEach((inp) => inp.addEventListener('change', () => {
    const i = +inp.dataset.t, f = inp.dataset.f;
    if (f === 'prompt') {
      const key = TEMPLATE.ticketTypes[i].id.replace('ticket_', '');
      TEMPLATE.ticketPrompts[key] = inp.value.slice(0, 500);
    } else TEMPLATE.ticketTypes[i][f] = inp.value;
  }));
  document.querySelectorAll('[data-tdel]').forEach((b) => b.addEventListener('click', () => { TEMPLATE.ticketTypes.splice(+b.dataset.tdel, 1); renderTickets(); }));
}
$('t-add').addEventListener('click', () => {
  if (TEMPLATE.ticketTypes.length >= 10) return toast('Max 10 ticket types');
  TEMPLATE.ticketTypes.push({ id: 'ticket_new', label: 'New', emoji: '❓', style: 'Secondary' });
  renderTickets();
});

function renderPanels() {
  $('panels').innerHTML = PANEL_FIELDS.map(([k, label, big]) => `
    <div class="field"><label>${esc(label)}</label>
    ${big ? `<textarea data-p="${k}" maxlength="4000">${esc(TEMPLATE.panels[k] || '')}</textarea>`
          : `<input type="text" data-p="${k}" value="${esc(TEMPLATE.panels[k] || '')}" maxlength="200">`}
    </div>`).join('');
  document.querySelectorAll('#panels [data-p]').forEach((inp) => inp.addEventListener('change', () => { TEMPLATE.panels[inp.dataset.p] = inp.value; }));
}
$('k-save').addEventListener('click', async () => {
  try { await saveTemplate(false); $('kmsg').innerHTML = '<div class="alert alert-ok">Saved and applied live. Existing messages and channels were preserved.</div>'; toast('Tickets & panels synced live'); }
  catch (e) { $('kmsg').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }
});

// ---- settings ----
$('pw-save').addEventListener('click', async () => {
  try {
    await api('/api/change-password', { method: 'POST', body: JSON.stringify({
      currentPassword: $('pw-cur').value, newUsername: $('pw-user').value.trim(), newPassword: $('pw-new').value,
    }) });
    $('pwmsg').innerHTML = '<div class="alert alert-ok">Credentials updated.</div>';
    $('pw-cur').value = ''; $('pw-new').value = '';
    toast('Credentials updated');
  } catch (e) { $('pwmsg').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }
});

// ---- boot ----
(async () => {
  try {
    const me = await api('/api/me');
    CSRF = me.csrf;
    $('uname').textContent = me.username;
    $('avatar').textContent = (me.username || 'A')[0].toUpperCase();
    await loadStatus();
    await loadGuilds().catch((e) => toast(e.message));
    await loadTemplate().catch((e) => toast(e.message));
  } catch (e) {
    if (!String(e.message).includes('Session')) toast(e.message);
  }
})();
