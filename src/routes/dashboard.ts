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
    .badge-originator { background: #6366f120; color: var(--accent); }
    .badge-role { background: #8888a020; color: var(--text-dim); }
    .badge-perm { background: #6366f110; color: var(--accent); font-size: 11px; margin-left: 4px; }
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
    .btn-warning { background: var(--warning); color: #000; }
    .btn-warning:hover { background: #d97706; }
    .btn-ghost {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text);
    }
    .btn-ghost:hover { background: var(--surface); }
    input[type="text"], select {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 14px;
      width: 100%;
    }
    select { cursor: pointer; }
    select option { background: var(--bg); color: var(--text); }
    input[type="text"]::placeholder { color: var(--text-dim); }
    .inline-form {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .inline-form input, .inline-form select { flex: 1; }
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
      flex-wrap: wrap;
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
    .lockdown-banner {
      background: #f59e0b20;
      border: 1px solid #f59e0b40;
      color: var(--warning);
      padding: 12px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 14px;
      font-weight: 500;
    }
    .toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 0;
      border-bottom: 1px solid var(--border);
    }
    .toggle-row:last-child { border-bottom: none; }
    .toggle-label { display: flex; flex-direction: column; gap: 2px; }
    .toggle-label span:first-child { font-weight: 500; }
    .toggle-label span:last-child { font-size: 13px; color: var(--text-dim); }
    .toggle {
      position: relative;
      width: 44px;
      height: 24px;
      flex-shrink: 0;
    }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .toggle .slider {
      position: absolute;
      inset: 0;
      background: var(--border);
      border-radius: 12px;
      cursor: pointer;
      transition: 0.2s;
    }
    .toggle .slider::before {
      content: '';
      position: absolute;
      height: 18px;
      width: 18px;
      left: 3px;
      bottom: 3px;
      background: white;
      border-radius: 50%;
      transition: 0.2s;
    }
    .toggle input:checked + .slider { background: var(--accent); }
    .toggle input:checked + .slider::before { transform: translateX(20px); }
    .user-group {
      margin-bottom: 16px;
    }
    .user-group-header {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-dim);
      padding: 6px 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .approval-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
    }
    .approval-item:last-child { border-bottom: none; }
    .audit-item {
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
    }
    .audit-item:last-child { border-bottom: none; }
    .audit-time { color: var(--text-dim); font-size: 12px; }
    .audit-actor { color: var(--accent); font-weight: 500; }
    .audit-action { color: var(--text); }
    .role-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 8px;
      background: var(--bg);
    }
    .role-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .role-card-header strong { font-size: 14px; }
    .perm-chip {
      display: inline-block;
      padding: 2px 8px;
      margin: 2px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      border: 1px solid var(--border);
      color: var(--text-dim);
    }
    .perm-chip.active {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }
    .perm-chip.readonly { cursor: default; }
    .default-badge {
      background: #22c55e20;
      color: var(--success);
      font-size: 11px;
      padding: 1px 6px;
      border-radius: 4px;
      margin-left: 6px;
    }
    .system-badge {
      background: #8888a015;
      color: var(--text-dim);
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 4px;
      margin-left: 6px;
    }
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
    var app = document.getElementById('app');
    var state = {
      user: null,
      tenants: [],
      invitations: [],
      currentTenant: null,
      tab: 'devices',
      settings: null,
      roles: [],
      allPerms: [],
    };

    function esc(s) {
      if (s == null) return '';
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }
    function safeUrl(url) {
      if (!url || typeof url !== 'string') return '';
      try { var u = new URL(url); if (u.protocol === 'https:' || u.protocol === 'http:') return esc(url); } catch(e) {}
      return '';
    }

    async function api(path, opts) {
      try {
        var res = await fetch(path, {
          headers: { 'Content-Type': 'application/json' },
          ...opts,
        });
        if (res.status === 401) { render(); return null; }
        if (!res.ok) {
          var err = await res.json().catch(function() { return { error: 'Request failed' }; });
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
      var el = document.createElement('div');
      el.className = 'toast';
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(function() { el.remove(); }, 3000);
    }

    function copyToClipboard(text) {
      navigator.clipboard.writeText(text);
      toast('Copied to clipboard');
    }

    function isOriginator() {
      return state.currentTenant && state.currentTenant.isOriginator;
    }

    function hasPerm(perm) {
      if (isOriginator()) return true;
      var role = state.roles.find(function(r) { return r.id === state.currentTenant.roleId; });
      if (!role) return false;
      return role.permissions.indexOf(perm) !== -1;
    }

    var pollTimer = null;

    async function init() {
      state.user = await api('/api/me');
      if (state.user) {
        state.tenants = await api('/api/tenants') || [];
        state.invitations = await api('/api/invitations') || [];
        state.allPerms = await api('/api/permissions') || [];
        if (state.tenants.length > 0 && !state.currentTenant) {
          var detail = await api('/api/tenants/' + state.tenants[0].id);
          state.currentTenant = detail || state.tenants[0];
        }
        if (state.currentTenant) {
          state.settings = await api('/api/tenants/' + state.currentTenant.id + '/settings');
          state.roles = await api('/api/tenants/' + state.currentTenant.id + '/roles') || [];
        }
        if (state.tenants.some(function(t) { return t.status === 'provisioning'; })) {
          if (!pollTimer) pollTimer = setInterval(function() { init(); }, 3000);
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

    function renderDevices(data) {
      if (!data || !data.byUser || data.total === 0) {
        return '<div class="empty-state">No devices connected yet. Generate an auth key to add your first device.</div>';
      }
      return data.byUser.map(function(group) {
        return '<div class="user-group">' +
          '<div class="user-group-header">' +
            '<span>' + esc(group.hsUsername) + ' (' + group.devices.length + ' device' + (group.devices.length !== 1 ? 's' : '') + ')</span>' +
          '</div>' +
          '<ul class="device-list">' + group.devices.map(function(d) {
            return '<li class="device-item">' +
              '<div>' +
                '<span class="online-dot ' + (d.online ? 'on' : 'off') + '"></span>' +
                '<span class="device-name">' + esc(d.name) + '</span>' +
              '</div>' +
              '<div style="display:flex;align-items:center;gap:12px">' +
                '<span class="device-ip">' + esc((d.ipAddresses || []).join(', ')) + '</span>' +
                '<button class="btn-sm btn-danger" onclick="deleteDevice(\\'' + d.id + '\\')">Remove</button>' +
              '</div>' +
            '</li>';
          }).join('') + '</ul>' +
        '</div>';
      }).join('');
    }

    function renderMembers(members) {
      if (!members || members.length === 0) return '<div class="empty-state">No members</div>';
      var canManageRoles = hasPerm('manage_roles');
      var canLock = hasPerm('lock_devices');

      return members.map(function(m) {
        var roleHtml = '';
        if (m.isOriginator) {
          roleHtml = '<span class="badge badge-originator">originator</span>';
        } else {
          roleHtml = '<span class="badge badge-role">' + esc(m.roleName || 'no role') + '</span>';
        }

        var lockBadge = m.isLocked ? '<span class="badge" style="background:#f59e0b20;color:var(--warning);font-size:11px;margin-left:4px">locked</span>' : '';

        var roleSelect = '';
        if (canManageRoles && !m.isOriginator) {
          var assignableRoles = state.roles.filter(function(r) { return !(r.isSystem && r.name === 'originator'); });
          roleSelect = '<select style="width:auto;padding:2px 8px;font-size:12px" onchange="assignRole(\\'' + m.id + '\\', this.value)">';
          assignableRoles.forEach(function(r) {
            roleSelect += '<option value="' + r.id + '"' + (m.roleId === r.id ? ' selected' : '') + '>' + esc(r.name) + '</option>';
          });
          roleSelect += '</select>';
        }

        var actions = '<div style="display:flex;gap:6px;align-items:center">';
        if (canLock) {
          if (m.isLocked) {
            actions += '<button class="btn-sm btn-warning" onclick="unlockDevices(\\'' + m.id + '\\')">Unlock</button>';
          } else {
            actions += '<button class="btn-sm btn-ghost" onclick="lockDevices(\\'' + m.id + '\\')">Lock</button>';
          }
        }
        if (!m.isOriginator && hasPerm('kick')) {
          actions += '<button class="btn-sm btn-danger" onclick="removeMember(\\'' + m.id + '\\')">Remove</button>';
        }
        actions += '</div>';

        return '<div class="member-item">' +
          '<div class="member-info">' +
            (safeUrl(m.avatarUrl) ? '<img src="' + safeUrl(m.avatarUrl) + '" />' : '') +
            '<span>' + esc(m.displayName || m.handle) + '</span>' +
            roleHtml +
            lockBadge +
            (roleSelect ? '<span style="margin-left:4px">' + roleSelect + '</span>' : '') +
          '</div>' +
          actions +
        '</div>';
      }).join('');
    }

    function renderInvitationsReceived() {
      if (!state.invitations || state.invitations.length === 0) return '';
      return '<div class="section"><h2>Pending Invitations</h2><div class="card">' +
        state.invitations.map(function(inv) {
          return '<div class="invitation-item">' +
            '<div>' +
              '<strong>' + esc(inv.tenantName) + '</strong>' +
              '<br><span style="color:var(--text-dim);font-size:13px">from ' + esc(inv.inviterDisplayName || inv.inviterHandle) + '</span>' +
            '</div>' +
            '<div style="display:flex;gap:8px">' +
              '<button class="btn-sm" onclick="acceptInvitation(\\'' + inv.id + '\\')">Accept</button>' +
              '<button class="btn-sm btn-ghost" onclick="declineInvitation(\\'' + inv.id + '\\')">Decline</button>' +
            '</div>' +
          '</div>';
        }).join('') +
      '</div></div>';
    }

    function renderLockdownBanner() {
      if (!state.settings || !state.settings.lockdownMode) return '';
      return '<div class="lockdown-banner">' +
        '<span>LOCKDOWN MODE \\u2014 No new invitations, joins, or device registrations permitted.</span>' +
        (hasPerm('manage_settings') ? '<button class="btn-sm btn-warning" onclick="toggleSetting(\\'lockdownMode\\', false)">Disable</button>' : '') +
      '</div>';
    }

    function renderDashboard() {
      var t = state.currentTenant;
      return '<header>' +
        '<h1>atproto-tailnet</h1>' +
        '<div class="user-info">' +
          (safeUrl(state.user.avatarUrl) ? '<img src="' + safeUrl(state.user.avatarUrl) + '" />' : '') +
          '<span>' + esc(state.user.handle) + '</span>' +
          '<form action="/auth/logout" method="post" style="display:inline"><button class="btn-sm btn-ghost">Sign out</button></form>' +
        '</div>' +
      '</header>' +
      renderLockdownBanner() +
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

      var canSecurity = hasPerm('manage_settings') || hasPerm('approve_devices') || hasPerm('approve_joins') || hasPerm('approve_services');
      var canAudit = hasPerm('view_audit_log');
      var canRoles = hasPerm('manage_roles');
      var canServices = hasPerm('manage_services') || hasPerm('approve_services');
      var canBoard = hasPerm('manage_board') || hasPerm('create_posts');

      var tabBar = '<div class="tab-bar">' +
        '<button class="tab ' + (state.tab === 'devices' ? 'active' : '') + '" onclick="switchTab(\\'devices\\')">Devices</button>' +
        '<button class="tab ' + (state.tab === 'members' ? 'active' : '') + '" onclick="switchTab(\\'members\\')">Members</button>' +
        (hasPerm('invite') ? '<button class="tab ' + (state.tab === 'invite' ? 'active' : '') + '" onclick="switchTab(\\'invite\\')">Invite</button>' : '') +
        '<button class="tab ' + (state.tab === 'connect' ? 'active' : '') + '" onclick="switchTab(\\'connect\\')">Add Device</button>' +
        (canServices ? '<button class="tab ' + (state.tab === 'services' ? 'active' : '') + '" onclick="switchTab(\\'services\\')">Services</button>' : '') +
        (canBoard ? '<button class="tab ' + (state.tab === 'board' ? 'active' : '') + '" onclick="switchTab(\\'board\\')">Board</button>' : '') +
        (canRoles ? '<button class="tab ' + (state.tab === 'roles' ? 'active' : '') + '" onclick="switchTab(\\'roles\\')">Roles</button>' : '') +
        (canSecurity ? '<button class="tab ' + (state.tab === 'security' ? 'active' : '') + '" onclick="switchTab(\\'security\\')">Security</button>' : '') +
        (canAudit ? '<button class="tab ' + (state.tab === 'audit' ? 'active' : '') + '" onclick="switchTab(\\'audit\\')">Audit Log</button>' : '') +
      '</div>';

      var roleBadge = t.isOriginator
        ? '<span class="badge badge-originator">originator</span>'
        : '<span class="badge badge-role">' + esc(t.roleName || 'citizen') + '</span>';

      return '<div class="section">' +
        '<div class="card">' +
          '<div class="card-header">' +
            '<h3>' + esc(t.name) + '</h3>' +
            '<div style="display:flex;gap:8px">' +
              '<span class="badge badge-' + t.status + '">' + t.status + '</span>' +
              roleBadge +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +

      tabBar +

      '<div id="tab-devices" class="' + (state.tab !== 'devices' ? 'hidden' : '') + '">' +
        '<div class="card"><div id="device-list">Loading...</div></div>' +
      '</div>' +

      '<div id="tab-members" class="' + (state.tab !== 'members' ? 'hidden' : '') + '">' +
        '<div class="card"><div id="member-list">Loading...</div></div>' +
      '</div>' +

      (hasPerm('invite') ? '<div id="tab-invite" class="' + (state.tab !== 'invite' ? 'hidden' : '') + '">' +
        '<div class="card">' +
          '<p style="margin-bottom:12px;color:var(--text-dim)">Invite someone by their Bluesky handle</p>' +
          '<div class="inline-form">' +
            '<input type="text" id="invite-handle" placeholder="friend.bsky.social" />' +
            '<button onclick="sendInvitation()">Send Invite</button>' +
          '</div>' +
          '<div id="sent-invitations" style="margin-top:16px"></div>' +
        '</div>' +
      '</div>' : '') +

      '<div id="tab-connect" class="' + (state.tab !== 'connect' ? 'hidden' : '') + '">' +
        '<div class="card">' +
          '<p style="margin-bottom:12px;color:var(--text-dim)">Generate a one-time key to connect a new device to this tailnet.</p>' +
          '<button onclick="generateAuthKey()">Generate Auth Key</button>' +
          '<div id="auth-key-output" style="margin-top:16px"></div>' +
        '</div>' +
      '</div>' +

      (canServices ?
        '<div id="tab-services" class="' + (state.tab !== 'services' ? 'hidden' : '') + '">' +
          '<div class="card">' +
            '<div class="card-header"><h3>Service Devices</h3></div>' +
            '<div id="service-devices-list">Loading...</div>' +
            (hasPerm('manage_services') ?
              '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">' +
                '<h4 style="margin-bottom:8px;font-size:14px">Register Service Device</h4>' +
                '<div class="inline-form" style="margin-bottom:8px">' +
                  '<input type="text" id="svc-dev-name" placeholder="Device name" style="max-width:200px" />' +
                  '<input type="text" id="svc-dev-desc" placeholder="Description (optional)" />' +
                  '<button onclick="registerServiceDevice()">Register</button>' +
                '</div>' +
              '</div>' : '') +
          '</div>' +
          '<div class="card" style="margin-top:12px">' +
            '<div class="card-header"><h3>Services</h3></div>' +
            '<div id="services-list">Loading...</div>' +
            (hasPerm('manage_services') ?
              '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">' +
                '<h4 style="margin-bottom:8px;font-size:14px">Register Service</h4>' +
                '<div style="display:flex;flex-direction:column;gap:8px">' +
                  '<div class="inline-form">' +
                    '<input type="text" id="svc-name" placeholder="Service name" style="max-width:200px" />' +
                    '<input type="text" id="svc-url" placeholder="Service URL (e.g. http://node:8080)" />' +
                  '</div>' +
                  '<div class="inline-form">' +
                    '<input type="text" id="svc-desc" placeholder="Description (optional)" />' +
                    '<select id="svc-device-select" style="max-width:250px"><option value="">Select service device...</option></select>' +
                    '<button onclick="registerService()">Register</button>' +
                  '</div>' +
                '</div>' +
              '</div>' : '') +
          '</div>' +
        '</div>' : '') +

      (canBoard ?
        '<div id="tab-board" class="' + (state.tab !== 'board' ? 'hidden' : '') + '">' +
          '<div class="card">' +
            '<div class="card-header"><h3>Board Posts</h3>' +
              (state.settings && state.settings.boardEnabled && state.currentTenant ?
                '<a href="/board/' + esc(state.currentTenant.slug) + '" target="_blank" class="btn-sm btn-ghost" style="text-decoration:none">View public board</a>' : '') +
            '</div>' +
            '<div id="board-posts-list">Loading...</div>' +
            (hasPerm('create_posts') ?
              '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">' +
                '<h4 style="margin-bottom:8px;font-size:14px">Create Post</h4>' +
                '<div style="display:flex;flex-direction:column;gap:8px">' +
                  '<div class="inline-form">' +
                    '<input type="text" id="post-title" placeholder="Post title" />' +
                    '<select id="post-service-select" style="max-width:250px"><option value="">Link to service...</option></select>' +
                  '</div>' +
                  '<div class="inline-form">' +
                    '<input type="text" id="post-desc" placeholder="Description (optional)" />' +
                    '<button onclick="createPost()">Create Post</button>' +
                  '</div>' +
                '</div>' +
              '</div>' : '') +
          '</div>' +
        '</div>' : '') +

      (canRoles ?
        '<div id="tab-roles" class="' + (state.tab !== 'roles' ? 'hidden' : '') + '">' +
          '<div class="card">' +
            '<div class="card-header"><h3>Role Builder</h3></div>' +
            '<div id="roles-list">Loading...</div>' +
            '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">' +
              '<h4 style="margin-bottom:8px;font-size:14px">Create Role</h4>' +
              '<div class="inline-form" style="margin-bottom:8px">' +
                '<input type="text" id="new-role-name" placeholder="Role name" style="max-width:200px" />' +
                '<input type="text" id="new-role-desc" placeholder="Description (optional)" />' +
                '<button onclick="createRole()">Create</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="card" style="margin-top:12px">' +
            '<div class="card-header"><h3>Default Role for New Members</h3></div>' +
            '<div id="default-role-select">Loading...</div>' +
          '</div>' +
        '</div>' : '') +

      (canSecurity ?
        '<div id="tab-security" class="' + (state.tab !== 'security' ? 'hidden' : '') + '">' +
          (hasPerm('manage_settings') ?
            '<div class="card">' +
              '<h3 style="margin-bottom:12px">Tenant Settings</h3>' +
              '<div id="security-settings">Loading...</div>' +
            '</div>' : '') +
          (hasPerm('approve_services') ?
            '<div class="card" style="margin-top:12px">' +
              '<h3 style="margin-bottom:12px">Pending Service Approvals</h3>' +
              '<div id="service-approvals">Loading...</div>' +
            '</div>' : '') +
          (hasPerm('approve_joins') ?
            '<div class="card" style="margin-top:12px">' +
              '<h3 style="margin-bottom:12px">Pending Join Requests</h3>' +
              '<div id="join-requests">Loading...</div>' +
            '</div>' : '') +
          (hasPerm('approve_devices') ?
            '<div class="card" style="margin-top:12px">' +
              '<h3 style="margin-bottom:12px">Pending Device Approvals</h3>' +
              '<div id="device-approvals">Loading...</div>' +
            '</div>' : '') +
        '</div>' : '') +

      (canAudit ?
        '<div id="tab-audit" class="' + (state.tab !== 'audit' ? 'hidden' : '') + '">' +
          '<div class="card"><div id="audit-log">Loading...</div></div>' +
        '</div>' : '');
    }

    function switchTab(tab) {
      state.tab = tab;
      render();
      if (tab === 'devices') loadDevices();
      if (tab === 'members') loadMembers();
      if (tab === 'invite') loadSentInvitations();
      if (tab === 'services') loadServices();
      if (tab === 'board') loadBoard();
      if (tab === 'roles') loadRoles();
      if (tab === 'security') loadSecurity();
      if (tab === 'audit') loadAuditLog();
    }

    async function loadDevices() {
      if (!state.currentTenant) return;
      var data = await api('/api/tenants/' + state.currentTenant.id + '/devices');
      var el = document.getElementById('device-list');
      if (el) el.innerHTML = renderDevices(data);
    }

    async function loadMembers() {
      if (!state.currentTenant) return;
      var members = await api('/api/tenants/' + state.currentTenant.id + '/members');
      if (members && hasPerm('lock_devices')) {
        for (var i = 0; i < members.length; i++) {
          var locks = await api('/api/tenants/' + state.currentTenant.id + '/device-locks/' + members[i].id);
          if (locks) members[i].isLocked = locks.locked;
        }
      }
      var el = document.getElementById('member-list');
      if (el) el.innerHTML = renderMembers(members);
    }

    async function loadSentInvitations() {
      if (!state.currentTenant) return;
      var invs = await api('/api/tenants/' + state.currentTenant.id + '/invitations');
      var el = document.getElementById('sent-invitations');
      if (!el || !invs) return;
      if (invs.length === 0) { el.innerHTML = ''; return; }
      el.innerHTML = '<h4 style="margin-bottom:8px;color:var(--text-dim)">Sent</h4>' +
        invs.map(function(i) {
          var revokeBtn = '';
          if (i.status === 'pending') {
            revokeBtn = '<button class="btn-sm btn-danger" onclick="revokeInvitation(\\'' + i.id + '\\')">Revoke</button>';
          }
          return '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">' +
            '<span>' + esc(i.inviteeHandle) + ' <span class="badge" style="font-size:11px">' + esc(i.status) + '</span></span>' +
            revokeBtn +
          '</div>';
        }).join('');
    }

    function renderRoleCard(role) {
      var isDefault = state.settings && state.settings.defaultRoleId === role.id;
      var isOriginatorRole = role.isSystem && role.name === 'originator';
      var canEdit = !isOriginatorRole;

      var permChips = state.allPerms.map(function(p) {
        var active = role.permissions.indexOf(p) !== -1;
        if (isOriginatorRole) {
          return '<span class="perm-chip active readonly">' + esc(p) + '</span>';
        }
        return '<span class="perm-chip ' + (active ? 'active' : '') + '" ' +
          'onclick="toggleRolePerm(\\'' + role.id + '\\', \\'' + p + '\\', ' + !active + ')">' + esc(p) + '</span>';
      }).join('');

      var actions = '';
      if (!role.isSystem) {
        actions = '<button class="btn-sm btn-danger" onclick="deleteRole(\\'' + role.id + '\\')">Delete</button>';
      }

      return '<div class="role-card">' +
        '<div class="role-card-header">' +
          '<div>' +
            '<strong>' + esc(role.name) + '</strong>' +
            (role.isSystem ? '<span class="system-badge">system</span>' : '') +
            (isDefault ? '<span class="default-badge">default</span>' : '') +
          '</div>' +
          actions +
        '</div>' +
        (role.description ? '<div style="font-size:13px;color:var(--text-dim);margin-bottom:8px">' + esc(role.description) + '</div>' : '') +
        '<div>' + permChips + '</div>' +
      '</div>';
    }

    async function loadRoles() {
      if (!state.currentTenant) return;
      state.roles = await api('/api/tenants/' + state.currentTenant.id + '/roles') || [];
      var el = document.getElementById('roles-list');
      if (el) {
        if (state.roles.length === 0) {
          el.innerHTML = '<div class="empty-state" style="padding:16px">No roles defined</div>';
        } else {
          el.innerHTML = state.roles.map(renderRoleCard).join('');
        }
      }

      var dre = document.getElementById('default-role-select');
      if (dre) {
        var assignable = state.roles.filter(function(r) { return !(r.isSystem && r.name === 'originator'); });
        dre.innerHTML = '<p style="font-size:13px;color:var(--text-dim);margin-bottom:8px">New members who accept an invitation will be assigned this role.</p>' +
          '<select style="max-width:300px" onchange="setDefaultRole(this.value)">' +
          assignable.map(function(r) {
            return '<option value="' + r.id + '"' + (state.settings && state.settings.defaultRoleId === r.id ? ' selected' : '') + '>' + esc(r.name) + '</option>';
          }).join('') +
          '</select>';
      }
    }

    async function createRole() {
      if (!state.currentTenant) return;
      var nameEl = document.getElementById('new-role-name');
      var descEl = document.getElementById('new-role-desc');
      var name = nameEl.value.trim();
      if (!name) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/roles', {
        method: 'POST',
        body: JSON.stringify({ name: name, description: descEl.value.trim() || undefined, permissions: [] }),
      });
      if (result) {
        nameEl.value = '';
        descEl.value = '';
        toast('Role "' + name + '" created');
        loadRoles();
      }
    }

    async function deleteRole(roleId) {
      if (!state.currentTenant) return;
      if (!confirm('Delete this role? Members with this role will be unassigned.')) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/roles/' + roleId, { method: 'DELETE' });
      if (result) {
        toast('Role deleted');
        loadRoles();
      }
    }

    async function toggleRolePerm(roleId, perm, add) {
      if (!state.currentTenant) return;
      var role = state.roles.find(function(r) { return r.id === roleId; });
      if (!role) return;
      var perms = role.permissions.slice();
      if (add) { perms.push(perm); } else { perms = perms.filter(function(p) { return p !== perm; }); }
      var result = await api('/api/tenants/' + state.currentTenant.id + '/roles/' + roleId, {
        method: 'PATCH',
        body: JSON.stringify({ permissions: perms }),
      });
      if (result) {
        role.permissions = result.permissions;
        loadRoles();
      }
    }

    async function setDefaultRole(roleId) {
      if (!state.currentTenant) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/default-role', {
        method: 'PATCH',
        body: JSON.stringify({ roleId: roleId }),
      });
      if (result) {
        state.settings.defaultRoleId = roleId;
        toast('Default role set to ' + result.roleName);
      }
    }

    async function assignRole(userId, roleId) {
      if (!state.currentTenant) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/members/' + userId + '/role', {
        method: 'PUT',
        body: JSON.stringify({ roleId: roleId }),
      });
      if (result) {
        toast('Role changed to ' + result.roleName);
        loadMembers();
      }
    }

    // ── Services tab ────────────────────────────────────────────────

    async function loadServices() {
      if (!state.currentTenant) return;
      var svcDevices = await api('/api/tenants/' + state.currentTenant.id + '/service-devices') || [];
      var svcs = await api('/api/tenants/' + state.currentTenant.id + '/services') || [];

      var sdEl = document.getElementById('service-devices-list');
      if (sdEl) {
        if (svcDevices.length === 0) {
          sdEl.innerHTML = '<div class="empty-state" style="padding:16px">No service devices registered</div>';
        } else {
          sdEl.innerHTML = svcDevices.map(function(d) {
            var statusBadge = d.status === 'pending' ? '<span class="badge" style="background:#f59e0b20;color:var(--warning)">pending</span>' :
                             d.status === 'approved' ? '<span class="badge badge-running">approved</span>' :
                             '<span class="badge badge-stopped">rejected</span>';
            var actions = '';
            if (d.status === 'pending' && hasPerm('approve_services')) {
              actions = '<div style="display:flex;gap:6px">' +
                '<button class="btn-sm" onclick="approveServiceDevice(\\'' + d.id + '\\')">Approve</button>' +
                '<button class="btn-sm btn-danger" onclick="rejectServiceDevice(\\'' + d.id + '\\')">Reject</button>' +
              '</div>';
            } else if (hasPerm('manage_services') || d.ownerId === state.user.id) {
              actions = '<button class="btn-sm btn-danger" onclick="removeServiceDevice(\\'' + d.id + '\\')">Remove</button>';
            }
            return '<div class="approval-item">' +
              '<div>' +
                '<strong>' + esc(d.name) + '</strong> ' + statusBadge +
                (d.description ? '<br><span style="color:var(--text-dim);font-size:12px">' + esc(d.description) + '</span>' : '') +
                '<br><span style="color:var(--text-dim);font-size:12px">Owner: ' + esc(d.ownerDisplayName || d.ownerHandle) + '</span>' +
              '</div>' +
              actions +
            '</div>';
          }).join('');
        }
      }

      var sEl = document.getElementById('services-list');
      if (sEl) {
        if (svcs.length === 0) {
          sEl.innerHTML = '<div class="empty-state" style="padding:16px">No services registered</div>';
        } else {
          sEl.innerHTML = svcs.map(function(s) {
            var statusBadge = s.status === 'pending' ? '<span class="badge" style="background:#f59e0b20;color:var(--warning)">pending</span>' :
                             s.status === 'active' ? '<span class="badge badge-running">active</span>' :
                             '<span class="badge badge-stopped">disabled</span>';
            var actions = '';
            if (s.status === 'pending' && hasPerm('approve_services')) {
              actions = '<div style="display:flex;gap:6px">' +
                '<button class="btn-sm" onclick="approveService(\\'' + s.id + '\\')">Approve</button>' +
                '<button class="btn-sm btn-danger" onclick="rejectService(\\'' + s.id + '\\')">Reject</button>' +
              '</div>';
            } else if (hasPerm('manage_services') || s.ownerId === state.user.id) {
              actions = '<button class="btn-sm btn-danger" onclick="removeService(\\'' + s.id + '\\')">Remove</button>';
            }
            return '<div class="approval-item">' +
              '<div>' +
                '<strong>' + esc(s.name) + '</strong> ' + statusBadge +
                '<br><span style="color:var(--text-dim);font-size:12px">' + esc(s.url) + '</span>' +
                (s.description ? '<br><span style="color:var(--text-dim);font-size:12px">' + esc(s.description) + '</span>' : '') +
                '<br><span style="color:var(--text-dim);font-size:12px">Device: ' + esc(s.deviceName) + ' \\u2022 Owner: ' + esc(s.ownerDisplayName || s.ownerHandle) + '</span>' +
              '</div>' +
              actions +
            '</div>';
          }).join('');
        }
      }

      // Populate service device select for service registration
      var sdSelect = document.getElementById('svc-device-select');
      if (sdSelect) {
        var approved = svcDevices.filter(function(d) { return d.status === 'approved'; });
        sdSelect.innerHTML = '<option value="">Select service device...</option>' +
          approved.map(function(d) {
            return '<option value="' + d.id + '">' + esc(d.name) + '</option>';
          }).join('');
      }
    }

    async function registerServiceDevice() {
      if (!state.currentTenant) return;
      var nameEl = document.getElementById('svc-dev-name');
      var descEl = document.getElementById('svc-dev-desc');
      var name = nameEl.value.trim();
      if (!name) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/service-devices', {
        method: 'POST',
        body: JSON.stringify({ name: name, description: descEl.value.trim() || undefined }),
      });
      if (result) {
        nameEl.value = '';
        descEl.value = '';
        if (result.status === 'pending') {
          toast('Service device registered \\u2014 pending approval');
        } else if (result.command) {
          toast('Service device approved! Run the command on your device.');
        }
        loadServices();
      }
    }

    async function approveServiceDevice(deviceId) {
      if (!state.currentTenant) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/service-devices/' + deviceId + '/approve', { method: 'POST' });
      if (result) { toast('Service device approved'); loadServices(); }
    }

    async function rejectServiceDevice(deviceId) {
      if (!state.currentTenant) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/service-devices/' + deviceId + '/reject', { method: 'POST' });
      if (result) { toast('Service device rejected'); loadServices(); }
    }

    async function removeServiceDevice(deviceId) {
      if (!state.currentTenant) return;
      if (!confirm('Remove this service device? Associated services will also be affected.')) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/service-devices/' + deviceId, { method: 'DELETE' });
      if (result) { toast('Service device removed'); loadServices(); }
    }

    async function registerService() {
      if (!state.currentTenant) return;
      var nameEl = document.getElementById('svc-name');
      var urlEl = document.getElementById('svc-url');
      var descEl = document.getElementById('svc-desc');
      var deviceSelect = document.getElementById('svc-device-select');
      var name = nameEl.value.trim();
      var url = urlEl.value.trim();
      var deviceId = deviceSelect.value;
      if (!name || !url || !deviceId) { toast('All fields required'); return; }
      var result = await api('/api/tenants/' + state.currentTenant.id + '/services', {
        method: 'POST',
        body: JSON.stringify({ name: name, url: url, description: descEl.value.trim() || undefined, serviceDeviceId: deviceId }),
      });
      if (result) {
        nameEl.value = '';
        urlEl.value = '';
        descEl.value = '';
        toast(result.status === 'pending' ? 'Service registered \\u2014 pending approval' : 'Service registered and active');
        loadServices();
      }
    }

    async function approveService(serviceId) {
      if (!state.currentTenant) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/services/' + serviceId + '/approve', { method: 'POST' });
      if (result) { toast('Service approved'); loadServices(); }
    }

    async function rejectService(serviceId) {
      if (!state.currentTenant) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/services/' + serviceId + '/reject', { method: 'POST' });
      if (result) { toast('Service rejected'); loadServices(); }
    }

    async function removeService(serviceId) {
      if (!state.currentTenant) return;
      if (!confirm('Remove this service?')) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/services/' + serviceId, { method: 'DELETE' });
      if (result) { toast('Service removed'); loadServices(); }
    }

    // ── Board tab ─────────────────────────────────────────────────

    async function loadBoard() {
      if (!state.currentTenant) return;
      var posts = await api('/api/tenants/' + state.currentTenant.id + '/board-posts') || [];
      var svcs = await api('/api/tenants/' + state.currentTenant.id + '/services') || [];

      var el = document.getElementById('board-posts-list');
      if (el) {
        var activePosts = posts.filter(function(p) { return p.status === 'active'; });
        if (activePosts.length === 0) {
          el.innerHTML = '<div class="empty-state" style="padding:16px">No board posts</div>';
        } else {
          el.innerHTML = activePosts.map(function(p) {
            var canRemove = (p.authorId === state.user.id && hasPerm('create_posts')) || hasPerm('manage_board');
            return '<div class="approval-item">' +
              '<div>' +
                '<strong>' + esc(p.title) + '</strong>' +
                '<span class="badge" style="background:var(--accent);color:white;font-size:10px;margin-left:6px">' + esc(p.serviceName) + '</span>' +
                (p.description ? '<br><span style="color:var(--text-dim);font-size:12px">' + esc(p.description) + '</span>' : '') +
                '<br><span style="color:var(--text-dim);font-size:12px">by ' + esc(p.authorDisplayName || p.authorHandle) + ' \\u2022 ' + new Date(p.createdAt).toLocaleString() + '</span>' +
              '</div>' +
              (canRemove ? '<button class="btn-sm btn-danger" onclick="removePost(\\'' + p.id + '\\')">Remove</button>' : '') +
            '</div>';
          }).join('');
        }
      }

      // Populate service select for post creation
      var svcSelect = document.getElementById('post-service-select');
      if (svcSelect) {
        var active = svcs.filter(function(s) { return s.status === 'active'; });
        svcSelect.innerHTML = '<option value="">Link to service...</option>' +
          active.map(function(s) {
            return '<option value="' + s.id + '">' + esc(s.name) + '</option>';
          }).join('');
      }
    }

    async function createPost() {
      if (!state.currentTenant) return;
      var titleEl = document.getElementById('post-title');
      var descEl = document.getElementById('post-desc');
      var svcSelect = document.getElementById('post-service-select');
      var title = titleEl.value.trim();
      var serviceId = svcSelect.value;
      if (!title || !serviceId) { toast('Title and service are required'); return; }
      var result = await api('/api/tenants/' + state.currentTenant.id + '/board-posts', {
        method: 'POST',
        body: JSON.stringify({ title: title, description: descEl.value.trim() || undefined, serviceId: serviceId }),
      });
      if (result) {
        titleEl.value = '';
        descEl.value = '';
        toast('Post created');
        loadBoard();
      }
    }

    async function removePost(postId) {
      if (!state.currentTenant) return;
      if (!confirm('Remove this post from the board?')) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/board-posts/' + postId, { method: 'DELETE' });
      if (result) { toast('Post removed'); loadBoard(); }
    }

    async function loadSecurity() {
      if (!state.currentTenant) return;
      if (hasPerm('manage_settings')) {
        var settings = await api('/api/tenants/' + state.currentTenant.id + '/settings');
        state.settings = settings;
        var el = document.getElementById('security-settings');
        if (el && settings) {
          el.innerHTML =
            '<div class="toggle-row">' +
              '<div class="toggle-label"><span>Require device approval</span><span>New devices must be approved before connecting</span></div>' +
              '<label class="toggle"><input type="checkbox" ' + (settings.requireDeviceApproval ? 'checked' : '') +
                ' onchange="toggleSetting(\\'requireDeviceApproval\\', this.checked)" /><span class="slider"></span></label>' +
            '</div>' +
            '<div class="toggle-row">' +
              '<div class="toggle-label"><span>Allow join requests</span><span>Non-members can request to join via a public link</span></div>' +
              '<label class="toggle"><input type="checkbox" ' + (settings.allowJoinRequests ? 'checked' : '') +
                ' onchange="toggleSetting(\\'allowJoinRequests\\', this.checked)" /><span class="slider"></span></label>' +
            '</div>' +
            (settings.allowJoinRequests && state.currentTenant ?
              '<div style="margin-top:8px;font-size:13px;color:var(--text-dim)">Share this link: <code style="color:var(--accent);cursor:pointer" onclick="copyToClipboard(window.location.origin + \\'/join/' + esc(state.currentTenant.slug) + '\\')">' + esc(location.origin) + '/join/' + esc(state.currentTenant.slug) + '</code></div>' : '') +
            '<div class="toggle-row">' +
              '<div class="toggle-label"><span>Enable public board</span><span>Show a public message board at /board/' + esc(state.currentTenant.slug) + '</span></div>' +
              '<label class="toggle"><input type="checkbox" ' + (settings.boardEnabled ? 'checked' : '') +
                ' onchange="toggleSetting(\\'boardEnabled\\', this.checked)" /><span class="slider"></span></label>' +
            '</div>' +
            (settings.boardEnabled && state.currentTenant ?
              '<div style="margin-top:4px;margin-bottom:8px;font-size:13px;color:var(--text-dim)">Board link: <code style="color:var(--accent);cursor:pointer" onclick="copyToClipboard(window.location.origin + \\'/board/' + esc(state.currentTenant.slug) + '\\')">' + esc(location.origin) + '/board/' + esc(state.currentTenant.slug) + '</code></div>' +
              '<div class="inline-form" style="margin-bottom:8px">' +
                '<label style="font-size:13px;color:var(--text-dim);white-space:nowrap">Max posts:</label>' +
                '<input type="number" id="max-posts-input" value="' + (settings.maxBoardPosts || 20) + '" style="width:80px;padding:4px 8px;font-size:13px" />' +
                '<label style="font-size:13px;color:var(--text-dim);white-space:nowrap">Show on board:</label>' +
                '<input type="number" id="max-posts-displayed-input" value="' + (settings.maxBoardPostsDisplayed || 10) + '" style="width:80px;padding:4px 8px;font-size:13px" />' +
                '<button class="btn-sm" onclick="saveBoardLimits()">Save</button>' +
              '</div>' : '') +
            '<div class="toggle-row">' +
              '<div class="toggle-label"><span>Require service device approval</span><span>Service devices must be approved by an authorized member</span></div>' +
              '<label class="toggle"><input type="checkbox" ' + (settings.requireServiceDeviceApproval ? 'checked' : '') +
                ' onchange="toggleSetting(\\'requireServiceDeviceApproval\\', this.checked)" /><span class="slider"></span></label>' +
            '</div>' +
            '<div class="toggle-row">' +
              '<div class="toggle-label"><span>Require service approval</span><span>Services must be approved before going active</span></div>' +
              '<label class="toggle"><input type="checkbox" ' + (settings.requireServiceApproval ? 'checked' : '') +
                ' onchange="toggleSetting(\\'requireServiceApproval\\', this.checked)" /><span class="slider"></span></label>' +
            '</div>' +
            '<div class="toggle-row">' +
              '<div class="toggle-label"><span>Lockdown mode</span><span>Block all new invitations, joins, and device registrations</span></div>' +
              '<label class="toggle"><input type="checkbox" ' + (settings.lockdownMode ? 'checked' : '') +
                ' onchange="toggleSetting(\\'lockdownMode\\', this.checked)" /><span class="slider"></span></label>' +
            '</div>';
        }
      }

      if (hasPerm('approve_services')) {
        var svcDevices = await api('/api/tenants/' + state.currentTenant.id + '/service-devices') || [];
        var svcs = await api('/api/tenants/' + state.currentTenant.id + '/services') || [];
        var sae = document.getElementById('service-approvals');
        if (sae) {
          var pendingDevices = svcDevices.filter(function(d) { return d.status === 'pending'; });
          var pendingServices = svcs.filter(function(s) { return s.status === 'pending'; });
          if (pendingDevices.length === 0 && pendingServices.length === 0) {
            sae.innerHTML = '<div class="empty-state" style="padding:16px">No pending service approvals</div>';
          } else {
            var html = '';
            if (pendingDevices.length > 0) {
              html += '<div style="font-size:12px;color:var(--text-dim);padding:6px 12px;font-weight:600">Service Devices</div>';
              html += pendingDevices.map(function(d) {
                return '<div class="approval-item">' +
                  '<div>' +
                    '<strong>' + esc(d.name) + '</strong>' +
                    (d.description ? '<br><span style="color:var(--text-dim);font-size:12px">' + esc(d.description) + '</span>' : '') +
                    '<br><span style="color:var(--text-dim);font-size:12px">by ' + esc(d.ownerDisplayName || d.ownerHandle) + '</span>' +
                  '</div>' +
                  '<div style="display:flex;gap:6px">' +
                    '<button class="btn-sm" onclick="approveServiceDevice(\\'' + d.id + '\\')">Approve</button>' +
                    '<button class="btn-sm btn-danger" onclick="rejectServiceDevice(\\'' + d.id + '\\')">Reject</button>' +
                  '</div>' +
                '</div>';
              }).join('');
            }
            if (pendingServices.length > 0) {
              html += '<div style="font-size:12px;color:var(--text-dim);padding:6px 12px;font-weight:600;margin-top:8px">Services</div>';
              html += pendingServices.map(function(s) {
                return '<div class="approval-item">' +
                  '<div>' +
                    '<strong>' + esc(s.name) + '</strong>' +
                    '<br><span style="color:var(--text-dim);font-size:12px">' + esc(s.url) + '</span>' +
                    '<br><span style="color:var(--text-dim);font-size:12px">by ' + esc(s.ownerDisplayName || s.ownerHandle) + '</span>' +
                  '</div>' +
                  '<div style="display:flex;gap:6px">' +
                    '<button class="btn-sm" onclick="approveService(\\'' + s.id + '\\')">Approve</button>' +
                    '<button class="btn-sm btn-danger" onclick="rejectService(\\'' + s.id + '\\')">Reject</button>' +
                  '</div>' +
                '</div>';
              }).join('');
            }
            sae.innerHTML = html;
          }
        }
      }

      if (hasPerm('approve_joins')) {
        var joinReqs = await api('/api/tenants/' + state.currentTenant.id + '/join-requests');
        var jre = document.getElementById('join-requests');
        if (jre && joinReqs) {
          var pendingJoins = joinReqs.filter(function(r) { return r.status === 'pending'; });
          if (pendingJoins.length === 0) {
            jre.innerHTML = '<div class="empty-state" style="padding:16px">No pending join requests</div>';
          } else {
            jre.innerHTML = pendingJoins.map(function(r) {
              return '<div class="approval-item">' +
                '<div>' +
                  (safeUrl(r.requesterAvatarUrl) ? '<img src="' + safeUrl(r.requesterAvatarUrl) + '" style="width:24px;height:24px;border-radius:50%;vertical-align:middle;margin-right:6px" />' : '') +
                  '<strong>' + esc(r.requesterDisplayName || r.requesterHandle) + '</strong>' +
                  (r.message ? '<br><span style="color:var(--text-dim);font-size:12px">' + esc(r.message) + '</span>' : '') +
                  '<br><span style="color:var(--text-dim);font-size:12px">Requested ' + new Date(r.requestedAt).toLocaleString() + '</span>' +
                '</div>' +
                '<div style="display:flex;gap:8px">' +
                  '<button class="btn-sm" onclick="approveJoin(\\'' + r.id + '\\')">Approve</button>' +
                  '<button class="btn-sm btn-danger" onclick="rejectJoin(\\'' + r.id + '\\')">Reject</button>' +
                '</div>' +
              '</div>';
            }).join('');
          }
        }
      }

      if (hasPerm('approve_devices')) {
        var approvals = await api('/api/tenants/' + state.currentTenant.id + '/device-approvals');
        var ae = document.getElementById('device-approvals');
        if (ae && approvals) {
          var pending = approvals.filter(function(a) { return a.status === 'pending'; });
          if (pending.length === 0) {
            ae.innerHTML = '<div class="empty-state" style="padding:16px">No pending approvals</div>';
          } else {
            ae.innerHTML = pending.map(function(a) {
              return '<div class="approval-item">' +
                '<div>' +
                  '<strong>' + esc(a.requesterDisplayName || a.requesterHandle) + '</strong>' +
                  '<br><span style="color:var(--text-dim);font-size:12px">Requested ' + new Date(a.requestedAt).toLocaleString() + '</span>' +
                '</div>' +
                '<div style="display:flex;gap:8px">' +
                  '<button class="btn-sm" onclick="approveDevice(\\'' + a.id + '\\')">Approve</button>' +
                  '<button class="btn-sm btn-danger" onclick="rejectDevice(\\'' + a.id + '\\')">Reject</button>' +
                '</div>' +
              '</div>';
            }).join('');
          }
        }
      }
    }

    async function loadAuditLog() {
      if (!state.currentTenant) return;
      auditOffset = 0;
      var data = await api('/api/tenants/' + state.currentTenant.id + '/audit-log?limit=50');
      var el = document.getElementById('audit-log');
      if (!el || !data) return;
      if (data.entries.length === 0) {
        el.innerHTML = '<div class="empty-state" style="padding:16px">No audit events yet</div>';
        return;
      }
      var actionLabels = {
        invitation_created: 'invited',
        invitation_accepted: 'accepted invitation',
        invitation_declined: 'declined invitation',
        invitation_revoked: 'revoked invitation',
        member_removed: 'removed member',
        member_permissions_updated: 'updated permissions',
        device_auth_key_created: 'generated auth key',
        device_removed: 'removed device',
        device_approval_requested: 'requested device approval',
        device_approved: 'approved device',
        device_rejected: 'rejected device request',
        device_locked: 'locked devices',
        device_unlocked: 'unlocked devices',
        tenant_settings_updated: 'updated settings',
        lockdown_enabled: 'enabled lockdown',
        lockdown_disabled: 'disabled lockdown',
        role_created: 'created role',
        role_updated: 'updated role',
        role_deleted: 'deleted role',
        member_role_changed: 'changed member role',
        default_role_changed: 'changed default role',
        join_requests_enabled: 'enabled join requests',
        join_requests_disabled: 'disabled join requests',
        join_request_created: 'requested to join',
        join_request_approved: 'approved join request',
        join_request_rejected: 'rejected join request',
        board_enabled: 'enabled board',
        board_disabled: 'disabled board',
        board_settings_updated: 'updated board settings',
        board_post_created: 'created board post',
        board_post_removed: 'removed board post',
        service_device_requested: 'registered service device',
        service_device_approved: 'approved service device',
        service_device_rejected: 'rejected service device',
        service_device_removed: 'removed service device',
        service_created: 'registered service',
        service_approved: 'approved service',
        service_rejected: 'rejected service',
        service_removed: 'removed service',
      };
      el.innerHTML = data.entries.map(function(e) {
        var label = actionLabels[e.action] || e.action;
        var detail = '';
        if (e.metadata) {
          if (e.metadata.handle) detail = ' \\u2014 ' + esc(String(e.metadata.handle));
          else if (e.metadata.name) detail = ' \\u2014 ' + esc(String(e.metadata.name));
          else if (e.metadata.roleName) detail = ' \\u2014 ' + esc(String(e.metadata.roleName));
          else if (e.metadata.requireDeviceApproval !== undefined) detail = ' \\u2014 device approval: ' + (e.metadata.requireDeviceApproval ? 'on' : 'off');
        }
        return '<div class="audit-item">' +
          '<span class="audit-time">' + new Date(e.createdAt).toLocaleString() + '</span> ' +
          '<span class="audit-actor">' + esc(e.actorDisplayName || e.actorHandle) + '</span> ' +
          '<span class="audit-action">' + esc(label) + esc(detail) + '</span>' +
        '</div>';
      }).join('') +
      (data.total > 50 ? '<div style="text-align:center;padding:12px"><button class="btn-sm btn-ghost" onclick="loadMoreAudit()">Load more (' + (data.total - 50) + ' remaining)</button></div>' : '');
    }

    var auditOffset = 0;
    async function loadMoreAudit() {
      auditOffset += 50;
      var data = await api('/api/tenants/' + state.currentTenant.id + '/audit-log?limit=50&offset=' + auditOffset);
      if (!data) return;
      var el = document.getElementById('audit-log');
      if (!el) return;
      var actionLabels = {
        invitation_created: 'invited', invitation_accepted: 'accepted invitation',
        invitation_declined: 'declined invitation', invitation_revoked: 'revoked invitation',
        member_removed: 'removed member', member_permissions_updated: 'updated permissions',
        device_auth_key_created: 'generated auth key', device_removed: 'removed device',
        device_approval_requested: 'requested device approval', device_approved: 'approved device',
        device_rejected: 'rejected device request', device_locked: 'locked devices',
        device_unlocked: 'unlocked devices', tenant_settings_updated: 'updated settings',
        lockdown_enabled: 'enabled lockdown', lockdown_disabled: 'disabled lockdown',
        role_created: 'created role', role_updated: 'updated role', role_deleted: 'deleted role',
        member_role_changed: 'changed member role', default_role_changed: 'changed default role',
        join_requests_enabled: 'enabled join requests', join_requests_disabled: 'disabled join requests',
        join_request_created: 'requested to join', join_request_approved: 'approved join request',
        join_request_rejected: 'rejected join request',
        board_enabled: 'enabled board', board_disabled: 'disabled board',
        board_settings_updated: 'updated board settings', board_post_created: 'created board post',
        board_post_removed: 'removed board post', service_device_requested: 'registered service device',
        service_device_approved: 'approved service device', service_device_rejected: 'rejected service device',
        service_device_removed: 'removed service device', service_created: 'registered service',
        service_approved: 'approved service', service_rejected: 'rejected service',
        service_removed: 'removed service',
      };
      var html = data.entries.map(function(e) {
        var label = actionLabels[e.action] || e.action;
        return '<div class="audit-item">' +
          '<span class="audit-time">' + new Date(e.createdAt).toLocaleString() + '</span> ' +
          '<span class="audit-actor">' + esc(e.actorDisplayName || e.actorHandle) + '</span> ' +
          '<span class="audit-action">' + esc(label) + '</span>' +
        '</div>';
      }).join('');
      el.insertAdjacentHTML('beforeend', html);
    }

    async function saveBoardLimits() {
      if (!state.currentTenant) return;
      var maxPosts = parseInt(document.getElementById('max-posts-input').value) || 20;
      var maxDisplayed = parseInt(document.getElementById('max-posts-displayed-input').value) || 10;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/settings', {
        method: 'PATCH',
        body: JSON.stringify({ maxBoardPosts: maxPosts, maxBoardPostsDisplayed: maxDisplayed }),
      });
      if (result) {
        state.settings = result;
        toast('Board limits saved');
      }
    }

    async function toggleSetting(key, value) {
      if (!state.currentTenant) return;
      var body = {};
      body[key] = value;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/settings', {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      if (result) {
        state.settings = result;
        if (key === 'lockdownMode') render();
        toast(key + ' ' + (value ? 'enabled' : 'disabled'));
      }
    }

    async function approveDevice(approvalId) {
      if (!state.currentTenant) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/device-approvals/' + approvalId + '/approve', { method: 'POST' });
      if (result) {
        toast('Device approved');
        loadSecurity();
      }
    }

    async function rejectDevice(approvalId) {
      if (!state.currentTenant) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/device-approvals/' + approvalId + '/reject', { method: 'POST' });
      if (result) {
        toast('Device request rejected');
        loadSecurity();
      }
    }

    async function approveJoin(requestId) {
      if (!state.currentTenant) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/join-requests/' + requestId + '/approve', { method: 'POST' });
      if (result) {
        toast('Join request approved');
        loadSecurity();
      }
    }

    async function rejectJoin(requestId) {
      if (!state.currentTenant) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/join-requests/' + requestId + '/reject', { method: 'POST' });
      if (result) {
        toast('Join request rejected');
        loadSecurity();
      }
    }

    async function generateAuthKey() {
      if (!state.currentTenant) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/devices/auth-key', { method: 'POST' });
      if (!result) return;
      var el = document.getElementById('auth-key-output');
      if (!el) return;
      if (result.status === 'pending_approval') {
        el.innerHTML = '<div class="card" style="background:var(--bg)">' +
          '<p style="color:var(--warning)">Device approval required</p>' +
          '<p style="color:var(--text-dim);font-size:13px;margin-top:4px">Your request has been submitted and is waiting for approval. Check back later.</p>' +
        '</div>';
      } else {
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

    async function lockDevices(userId) {
      if (!state.currentTenant) return;
      if (!confirm('Lock this member to their current devices? They will not be able to add new devices.')) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/device-locks', {
        method: 'POST',
        body: JSON.stringify({ userId: userId }),
      });
      if (result) {
        toast('Devices locked (' + (result.devices ? result.devices.length : 0) + ' devices)');
        loadMembers();
      }
    }

    async function unlockDevices(userId) {
      if (!state.currentTenant) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/device-locks', {
        method: 'DELETE',
        body: JSON.stringify({ userId: userId }),
      });
      if (result) {
        toast('Devices unlocked');
        loadMembers();
      }
    }

    async function removeMember(userId) {
      if (!state.currentTenant) return;
      if (!confirm('Remove this member? Their devices will also be disconnected.')) return;
      await api('/api/tenants/' + state.currentTenant.id + '/members/' + userId, { method: 'DELETE' });
      loadMembers();
    }

    async function sendInvitation() {
      if (!state.currentTenant) return;
      var input = document.getElementById('invite-handle');
      var handle = input.value.trim();
      if (!handle) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/invitations', {
        method: 'POST',
        body: JSON.stringify({ handle: handle }),
      });
      if (result) {
        input.value = '';
        toast('Invitation sent to ' + handle);
        loadSentInvitations();
      }
    }

    async function revokeInvitation(invitationId) {
      if (!state.currentTenant) return;
      if (!confirm('Revoke this invitation?')) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/invitations/' + invitationId, { method: 'DELETE' });
      if (result) {
        toast('Invitation revoked');
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
        if (state.tab === 'services') loadServices();
        if (state.tab === 'board') loadBoard();
        if (state.tab === 'roles') loadRoles();
        if (state.tab === 'security') loadSecurity();
        if (state.tab === 'audit') loadAuditLog();
      }
    }

    init();
  </script>
</body>
</html>`;

dashboardRouter.get("/", (req, res) => {
  res.type("html").send(DASHBOARD_HTML);
});

const JOIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Join tailnet — atproto-tailnet</title>
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
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 32px;
      max-width: 480px;
      width: 100%;
      text-align: center;
    }
    h1 { font-size: 24px; font-weight: 600; margin-bottom: 8px; }
    .sub { color: var(--text-dim); font-size: 14px; margin-bottom: 24px; }
    button {
      background: var(--accent);
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 6px;
      font-size: 15px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    button:hover { background: var(--accent-hover); }
    .btn-ghost {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text);
    }
    .btn-ghost:hover { background: var(--surface); }
    textarea {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 10px 12px;
      border-radius: 6px;
      font-size: 14px;
      width: 100%;
      resize: vertical;
      min-height: 60px;
      margin-bottom: 12px;
    }
    textarea::placeholder { color: var(--text-dim); }
    .status-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 13px;
      font-weight: 500;
    }
    .status-pending { background: #f59e0b20; color: var(--warning); }
    .status-approved { background: #22c55e20; color: var(--success); }
    .status-rejected { background: #ef444420; color: var(--danger); }
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
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div id="join-app" class="card">Loading...</div>
  <script>
    var slug = window.location.pathname.split('/join/')[1];
    var app = document.getElementById('join-app');

    function esc(s) {
      if (s == null) return '';
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function toast(msg) {
      var el = document.createElement('div');
      el.className = 'toast';
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(function() { el.remove(); }, 3000);
    }

    async function api(path, opts) {
      try {
        var res = await fetch(path, {
          headers: { 'Content-Type': 'application/json' },
          ...opts,
        });
        if (res.status === 401) return { _unauth: true };
        if (!res.ok) {
          var err = await res.json().catch(function() { return { error: 'Request failed' }; });
          return { _error: err.error || 'Something went wrong' };
        }
        return res.json();
      } catch (e) {
        return { _error: 'Network error' };
      }
    }

    async function init() {
      var tenant = await api('/api/tenants/by-slug/' + encodeURIComponent(slug) + '/public');

      if (tenant._error) {
        app.innerHTML = '<h1>Tailnet not found</h1><p class="sub">This tailnet does not exist or is not accepting requests.</p>' +
          '<a href="/">Go to dashboard</a>';
        return;
      }

      if (!tenant.joinOpen) {
        app.innerHTML = '<h1>' + esc(tenant.name) + '</h1>' +
          '<p class="sub">This tailnet is not currently accepting join requests.</p>' +
          '<a href="/">Go to dashboard</a>';
        return;
      }

      var me = await api('/api/me');

      if (me._unauth || !me.id) {
        app.innerHTML = '<h1>' + esc(tenant.name) + '</h1>' +
          '<p class="sub">Sign in with your Bluesky identity to request access to this tailnet.</p>' +
          '<form action="/auth/login" method="get" style="display:flex;gap:8px;justify-content:center">' +
            '<input type="text" name="handle" placeholder="yourname.bsky.social" required ' +
              'style="background:var(--bg);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:6px;font-size:14px;width:220px" />' +
            '<input type="hidden" name="redirect" value="/join/' + esc(slug) + '" />' +
            '<button type="submit">Sign in</button>' +
          '</form>';
        return;
      }

      var mine = await api('/api/tenants/' + tenant.id + '/join-requests/mine');

      if (mine._error) {
        var existing = await api('/api/tenants/' + tenant.id);
        if (existing && existing.id) {
          app.innerHTML = '<h1>' + esc(tenant.name) + '</h1>' +
            '<p class="sub">You are already a member of this tailnet.</p>' +
            '<a href="/">Go to dashboard</a>';
          return;
        }
      }

      if (mine && !mine._error && mine.length > 0) {
        var latest = mine[0];
        if (latest.status === 'pending') {
          app.innerHTML = '<h1>' + esc(tenant.name) + '</h1>' +
            '<p class="sub">Your request to join is pending review.</p>' +
            '<span class="status-badge status-pending">Pending</span>' +
            '<p style="margin-top:16px;font-size:13px;color:var(--text-dim)">Submitted ' + new Date(latest.requestedAt).toLocaleString() + '</p>' +
            '<p style="margin-top:16px"><a href="/">Go to dashboard</a></p>';
          return;
        }
        if (latest.status === 'approved') {
          app.innerHTML = '<h1>' + esc(tenant.name) + '</h1>' +
            '<p class="sub">Your request was approved! You are now a member.</p>' +
            '<span class="status-badge status-approved">Approved</span>' +
            '<p style="margin-top:16px"><a href="/">Go to dashboard</a></p>';
          return;
        }
        if (latest.status === 'rejected') {
          app.innerHTML = '<h1>' + esc(tenant.name) + '</h1>' +
            '<p class="sub">Your previous request was declined.</p>' +
            '<span class="status-badge status-rejected">Rejected</span>' +
            '<div style="margin-top:16px">' +
              '<textarea id="join-message" placeholder="Add an optional message (max 500 chars)"></textarea>' +
              '<button onclick="submitRequest(\\'' + tenant.id + '\\')">Request Again</button>' +
            '</div>';
          return;
        }
      }

      app.innerHTML = '<h1>' + esc(tenant.name) + '</h1>' +
        '<p class="sub">Request to join this tailnet. The owner will review your request.</p>' +
        '<div>' +
          '<textarea id="join-message" placeholder="Add an optional message (max 500 chars)"></textarea>' +
          '<button onclick="submitRequest(\\'' + tenant.id + '\\')">Request to Join</button>' +
        '</div>';
    }

    async function submitRequest(tenantId) {
      var msgEl = document.getElementById('join-message');
      var message = msgEl ? msgEl.value.trim() : '';
      var result = await api('/api/tenants/' + tenantId + '/join-requests', {
        method: 'POST',
        body: JSON.stringify({ message: message || undefined }),
      });
      if (result._error) {
        toast(result._error);
        return;
      }
      toast('Request submitted!');
      init();
    }

    init();
  </script>
</body>
</html>`;

dashboardRouter.get("/join/:slug", (req, res) => {
  res.type("html").send(JOIN_PAGE_HTML);
});
