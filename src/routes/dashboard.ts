import { Router } from "express";

export const dashboardRouter = Router();

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>atproto-tailnet</title>
  <style>
    :root {
      --bg: #0a0a0f;
      --surface: #13131a;
      --border: #23232f;
      --text: #e4e4ed;
      --text-dim: #8888a0;
      --accent: #6366f1;
      --accent-hover: #818cf8;
      --success: #22c55e;
      --danger: #ef4444;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 24px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }
    header h1 { font-size: 18px; font-weight: 600; }
    .user-info {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .user-info img {
      width: 28px;
      height: 28px;
      border-radius: 50%;
    }
    .user-info span { color: var(--text-dim); font-size: 14px; }
    main { max-width: 960px; margin: 0 auto; padding: 24px; }
    .section { margin-bottom: 32px; }
    .section h2 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 12px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 12px;
    }
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .card-header h3 { font-size: 16px; font-weight: 600; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
    }
    .badge-running { background: #22c55e20; color: var(--success); }
    .badge-stopped { background: #ef444420; color: var(--danger); }
    .badge-owner { background: #6366f120; color: var(--accent); }
    .badge-member { background: #8888a020; color: var(--text-dim); }
    .code-block {
      background: #000;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 13px;
      color: var(--success);
      overflow-x: auto;
      cursor: pointer;
      position: relative;
    }
    .code-block:hover::after {
      content: 'click to copy';
      position: absolute;
      right: 8px;
      top: 8px;
      color: var(--text-dim);
      font-size: 11px;
    }
    .device-list { list-style: none; }
    .device-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
    }
    .device-item:last-child { border-bottom: none; }
    .device-name { font-weight: 500; }
    .device-ip { color: var(--text-dim); font-family: monospace; font-size: 13px; }
    .online-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
    }
    .online-dot.on { background: var(--success); }
    .online-dot.off { background: var(--text-dim); }
    button, .btn {
      background: var(--accent);
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 14px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    button:hover, .btn:hover { background: var(--accent-hover); }
    .btn-sm { padding: 4px 10px; font-size: 12px; }
    .btn-danger { background: var(--danger); }
    .btn-danger:hover { background: #dc2626; }
    .btn-ghost {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text);
    }
    .btn-ghost:hover { background: var(--surface); }
    input[type="text"] {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 14px;
      width: 100%;
    }
    input[type="text"]::placeholder { color: var(--text-dim); }
    .inline-form {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .inline-form input { flex: 1; }
    .member-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
    }
    .member-item:last-child { border-bottom: none; }
    .member-info {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .member-info img {
      width: 24px;
      height: 24px;
      border-radius: 50%;
    }
    .invitation-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px;
      border-bottom: 1px solid var(--border);
    }
    .invitation-item:last-child { border-bottom: none; }
    .empty-state {
      text-align: center;
      padding: 32px;
      color: var(--text-dim);
    }
    .tab-bar {
      display: flex;
      gap: 4px;
      margin-bottom: 16px;
    }
    .tab {
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      color: var(--text-dim);
      background: transparent;
      border: none;
    }
    .tab.active { background: var(--surface); color: var(--text); }
    .tab:hover { color: var(--text); }
    .hidden { display: none; }
    #login-page {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 80vh;
      gap: 24px;
    }
    #login-page h1 { font-size: 32px; }
    #login-page p { color: var(--text-dim); max-width: 400px; text-align: center; }
    #login-page form {
      display: flex;
      gap: 8px;
      width: 100%;
      max-width: 400px;
    }
    #login-page form input { flex: 1; }
    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: var(--surface);
      border: 1px solid var(--border);
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 14px;
      z-index: 1000;
      animation: fadeIn 0.2s;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } }
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
    const app = document.getElementById('app');
    let state = { user: null, tenants: [], invitations: [], currentTenant: null, tab: 'devices' };

    function esc(s) {
      if (s == null) return '';
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }
    function safeUrl(url) {
      if (!url || typeof url !== 'string') return '';
      try { const u = new URL(url); if (u.protocol === 'https:' || u.protocol === 'http:') return esc(url); } catch(e) {}
      return '';
    }

    async function api(path, opts) {
      try {
        const res = await fetch(path, {
          headers: { 'Content-Type': 'application/json' },
          ...opts,
        });
        if (res.status === 401) { render(); return null; }
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Request failed' }));
          toast(err.error || 'Something went wrong');
          return null;
        }
        return res.json();
      } catch (e) {
        toast('Network error \\u2014 check your connection');
        return null;
      }
    }

    function toast(msg) {
      const el = document.createElement('div');
      el.className = 'toast';
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 3000);
    }

    function copyToClipboard(text) {
      navigator.clipboard.writeText(text);
      toast('Copied to clipboard');
    }

    let pollTimer = null;

    async function init() {
      state.user = await api('/api/me');
      if (state.user) {
        state.tenants = await api('/api/tenants') || [];
        state.invitations = await api('/api/invitations') || [];
        if (state.tenants.length > 0 && !state.currentTenant) {
          state.currentTenant = state.tenants[0];
        }
        // Auto-refresh while any tenant is provisioning
        if (state.tenants.some(t => t.status === 'provisioning')) {
          if (!pollTimer) pollTimer = setInterval(() => init(), 3000);
        } else if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      }
      render();
    }

    function renderLogin() {
      return '<div id="login-page">' +
        '<h1>atproto-tailnet</h1>' +
        '<p>Create private mesh networks with your Bluesky identity. Invite anyone by their handle.</p>' +
        '<form action="/auth/login" method="get">' +
          '<input type="text" name="handle" placeholder="yourname.bsky.social" required />' +
          '<button type="submit">Sign in</button>' +
        '</form>' +
      '</div>';
    }

    function renderDevices(devices) {
      if (!devices || devices.length === 0) {
        return '<div class="empty-state">No devices connected yet. Generate an auth key to add your first device.</div>';
      }
      return '<ul class="device-list">' + devices.map(d =>
        '<li class="device-item">' +
          '<div>' +
            '<span class="online-dot ' + (d.online ? 'on' : 'off') + '"></span>' +
            '<span class="device-name">' + esc(d.name) + '</span>' +
            (d.user ? ' <span style="color:var(--text-dim);font-size:12px">(' + esc(d.user) + ')</span>' : '') +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:12px">' +
            '<span class="device-ip">' + esc((d.ipAddresses || []).join(', ')) + '</span>' +
            '<button class="btn-sm btn-danger" onclick="deleteDevice(\\'' + d.id + '\\')">Remove</button>' +
          '</div>' +
        '</li>'
      ).join('') + '</ul>';
    }

    function renderMembers(members) {
      if (!members || members.length === 0) return '<div class="empty-state">No members</div>';
      return members.map(m =>
        '<div class="member-item">' +
          '<div class="member-info">' +
            (safeUrl(m.avatarUrl) ? '<img src="' + safeUrl(m.avatarUrl) + '" />' : '') +
            '<span>' + esc(m.displayName || m.handle) + '</span>' +
            '<span class="badge badge-' + m.role + '">' + m.role + '</span>' +
          '</div>' +
          (m.role !== 'owner' && state.currentTenant?.role === 'owner'
            ? '<button class="btn-sm btn-danger" onclick="removeMember(\\'' + m.id + '\\')">Remove</button>'
            : '') +
        '</div>'
      ).join('');
    }

    function renderInvitationsReceived() {
      if (!state.invitations || state.invitations.length === 0) return '';
      return '<div class="section"><h2>Pending Invitations</h2><div class="card">' +
        state.invitations.map(inv =>
          '<div class="invitation-item">' +
            '<div>' +
              '<strong>' + esc(inv.tenantName) + '</strong>' +
              '<br><span style="color:var(--text-dim);font-size:13px">from ' + esc(inv.inviterDisplayName || inv.inviterHandle) + '</span>' +
            '</div>' +
            '<div style="display:flex;gap:8px">' +
              '<button class="btn-sm" onclick="acceptInvitation(\\'' + inv.id + '\\')">Accept</button>' +
              '<button class="btn-sm btn-ghost" onclick="declineInvitation(\\'' + inv.id + '\\')">Decline</button>' +
            '</div>' +
          '</div>'
        ).join('') +
      '</div></div>';
    }

    function renderDashboard() {
      const t = state.currentTenant;
      return '<header>' +
        '<h1>atproto-tailnet</h1>' +
        '<div class="user-info">' +
          (safeUrl(state.user.avatarUrl) ? '<img src="' + safeUrl(state.user.avatarUrl) + '" />' : '') +
          '<span>' + esc(state.user.handle) + '</span>' +
          '<form action="/auth/logout" method="post" style="display:inline"><button class="btn-sm btn-ghost">Sign out</button></form>' +
        '</div>' +
      '</header>' +
      '<main>' +
        renderInvitationsReceived() +
        (t ? renderTenantView(t) : '<div class="empty-state">No tailnets. This shouldn\\'t happen!</div>') +
      '</main>';
    }

    function renderTenantView(t) {
      if (t.status === 'provisioning') {
        return '<div class="section"><div class="card">' +
          '<div class="card-header"><h3>' + esc(t.name) + '</h3>' +
            '<span class="badge" style="background:#f59e0b20;color:#f59e0b">provisioning</span></div>' +
          '<p style="color:var(--text-dim);margin-top:8px">Your tailnet is being set up. This usually takes 10-15 seconds. The page will refresh automatically.</p>' +
        '</div></div>';
      }
      if (t.status === 'error') {
        return '<div class="section"><div class="card">' +
          '<div class="card-header"><h3>' + esc(t.name) + '</h3>' +
            '<span class="badge" style="background:#ef444420;color:#ef4444">error</span></div>' +
          '<p style="color:var(--text-dim);margin-top:8px">Something went wrong provisioning your tailnet. Try signing out and back in, or contact support.</p>' +
        '</div></div>';
      }
      return '<div class="section">' +
        '<div class="card">' +
          '<div class="card-header">' +
            '<h3>' + esc(t.name) + '</h3>' +
            '<div style="display:flex;gap:8px">' +
              '<span class="badge badge-' + t.status + '">' + t.status + '</span>' +
              '<span class="badge badge-' + t.role + '">' + t.role + '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div class="tab-bar">' +
        '<button class="tab ' + (state.tab === 'devices' ? 'active' : '') + '" onclick="switchTab(\\'devices\\')">Devices</button>' +
        '<button class="tab ' + (state.tab === 'members' ? 'active' : '') + '" onclick="switchTab(\\'members\\')">Members</button>' +
        '<button class="tab ' + (state.tab === 'invite' ? 'active' : '') + '" onclick="switchTab(\\'invite\\')">Invite</button>' +
        '<button class="tab ' + (state.tab === 'connect' ? 'active' : '') + '" onclick="switchTab(\\'connect\\')">Add Device</button>' +
      '</div>' +

      '<div id="tab-devices" class="' + (state.tab !== 'devices' ? 'hidden' : '') + '">' +
        '<div class="card"><div id="device-list">Loading...</div></div>' +
      '</div>' +

      '<div id="tab-members" class="' + (state.tab !== 'members' ? 'hidden' : '') + '">' +
        '<div class="card"><div id="member-list">Loading...</div></div>' +
      '</div>' +

      '<div id="tab-invite" class="' + (state.tab !== 'invite' ? 'hidden' : '') + '">' +
        '<div class="card">' +
          '<p style="margin-bottom:12px;color:var(--text-dim)">Invite someone by their Bluesky handle</p>' +
          '<div class="inline-form">' +
            '<input type="text" id="invite-handle" placeholder="friend.bsky.social" />' +
            '<button onclick="sendInvitation()">Send Invite</button>' +
          '</div>' +
          '<div id="sent-invitations" style="margin-top:16px"></div>' +
        '</div>' +
      '</div>' +

      '<div id="tab-connect" class="' + (state.tab !== 'connect' ? 'hidden' : '') + '">' +
        '<div class="card">' +
          '<p style="margin-bottom:12px;color:var(--text-dim)">Generate a one-time key to connect a new device to this tailnet.</p>' +
          '<button onclick="generateAuthKey()">Generate Auth Key</button>' +
          '<div id="auth-key-output" style="margin-top:16px"></div>' +
        '</div>' +
      '</div>';
    }

    function switchTab(tab) {
      state.tab = tab;
      render();
      if (tab === 'devices') loadDevices();
      if (tab === 'members') loadMembers();
      if (tab === 'invite') loadSentInvitations();
    }

    async function loadDevices() {
      if (!state.currentTenant) return;
      const devices = await api('/api/tenants/' + state.currentTenant.id + '/devices');
      const el = document.getElementById('device-list');
      if (el) el.innerHTML = renderDevices(devices);
    }

    async function loadMembers() {
      if (!state.currentTenant) return;
      const members = await api('/api/tenants/' + state.currentTenant.id + '/members');
      const el = document.getElementById('member-list');
      if (el) el.innerHTML = renderMembers(members);
    }

    async function loadSentInvitations() {
      if (!state.currentTenant) return;
      const invs = await api('/api/tenants/' + state.currentTenant.id + '/invitations');
      const el = document.getElementById('sent-invitations');
      if (!el || !invs) return;
      if (invs.length === 0) { el.innerHTML = ''; return; }
      el.innerHTML = '<h4 style="margin-bottom:8px;color:var(--text-dim)">Sent</h4>' +
        invs.map(i =>
          '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">' +
            '<span>' + esc(i.inviteeHandle) + ' <span class="badge" style="font-size:11px">' + esc(i.status) + '</span></span>' +
          '</div>'
        ).join('');
    }

    async function generateAuthKey() {
      if (!state.currentTenant) return;
      const result = await api('/api/tenants/' + state.currentTenant.id + '/devices/auth-key', { method: 'POST' });
      if (!result) return;
      const el = document.getElementById('auth-key-output');
      if (el) {
        el.innerHTML = '<p style="margin-bottom:8px;color:var(--text-dim)">Run this on the device you want to connect:</p>' +
          '<div class="code-block" onclick="copyToClipboard(this.textContent)">' + esc(result.command) + '</div>';
      }
    }

    async function deleteDevice(nodeId) {
      if (!state.currentTenant) return;
      if (!confirm('Remove this device?')) return;
      await api('/api/tenants/' + state.currentTenant.id + '/devices/' + nodeId, { method: 'DELETE' });
      loadDevices();
    }

    async function removeMember(userId) {
      if (!state.currentTenant) return;
      if (!confirm('Remove this member?')) return;
      await api('/api/tenants/' + state.currentTenant.id + '/members/' + userId, { method: 'DELETE' });
      loadMembers();
    }

    async function sendInvitation() {
      if (!state.currentTenant) return;
      const input = document.getElementById('invite-handle');
      const handle = input.value.trim();
      if (!handle) return;
      const result = await api('/api/tenants/' + state.currentTenant.id + '/invitations', {
        method: 'POST',
        body: JSON.stringify({ handle }),
      });
      if (result) {
        input.value = '';
        toast('Invitation sent to ' + handle);
        loadSentInvitations();
      }
    }

    async function acceptInvitation(id) {
      await api('/api/invitations/' + id + '/accept', { method: 'POST' });
      await init();
    }

    async function declineInvitation(id) {
      await api('/api/invitations/' + id + '/decline', { method: 'POST' });
      await init();
    }

    function render() {
      if (!state.user) {
        app.innerHTML = renderLogin();
      } else {
        app.innerHTML = renderDashboard();
        if (state.tab === 'devices') loadDevices();
        if (state.tab === 'members') loadMembers();
        if (state.tab === 'invite') loadSentInvitations();
      }
    }

    init();
  </script>
</body>
</html>`;

dashboardRouter.get("/", (req, res) => {
  res.type("html").send(DASHBOARD_HTML);
});
