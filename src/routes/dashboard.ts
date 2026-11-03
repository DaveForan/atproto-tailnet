/**
 * @module routes/dashboard
 *
 * Inline single-page application served at `/`. Renders a dark-themed
 * dashboard with tabbed navigation: Devices, Members, Invite, Add Device,
 * Services, Board, Federation, Agents, Roles, Security, and Audit Log.
 *
 * Also serves the public join page at `/join/:slug` for tailnets that
 * have join requests enabled.
 *
 * All user-controlled data is HTML-escaped via `esc()` and avatar URLs
 * are validated via `safeUrl()` to prevent XSS.
 */
import { Router } from "express";

/** Main dashboard router — serves HTML pages (no JSON API). */
export const dashboardRouter = Router();

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="csrf-token" content="" />
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
    main { flex: 1; min-width: 0; padding: 24px; max-width: 100%; overflow-y: auto; }
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
    textarea {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 14px;
      width: 100%;
      resize: vertical;
      min-height: 60px;
      font-family: inherit;
    }
    textarea::placeholder { color: var(--text-dim); }
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
    .hidden { display: none; }
    .dashboard-layout {
      display: flex;
      min-height: calc(100vh - 60px);
    }
    .sidebar {
      width: 240px;
      flex-shrink: 0;
      background: var(--surface);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow-y: auto;
    }
    .sidebar-tenant {
      padding: 16px;
      border-bottom: 1px solid var(--border);
    }
    .sidebar-tenant h3 {
      font-size: 15px;
      font-weight: 600;
      margin-bottom: 6px;
    }
    .nav-group-header {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.8px;
      padding: 16px 16px 6px;
    }
    .nav-item {
      display: block;
      width: 100%;
      text-align: left;
      padding: 8px 16px;
      font-size: 14px;
      color: var(--text-dim);
      background: transparent;
      border: none;
      border-left: 3px solid transparent;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
      border-radius: 0;
    }
    .nav-item:hover {
      color: var(--text);
      background: rgba(99, 102, 241, 0.05);
    }
    .nav-item.active {
      color: var(--text);
      background: rgba(99, 102, 241, 0.08);
      border-left-color: var(--accent);
    }
    .hamburger-btn {
      display: none;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text);
      font-size: 20px;
      padding: 4px 8px;
      border-radius: 6px;
      cursor: pointer;
      line-height: 1;
    }
    .hamburger-btn:hover { background: var(--surface); }
    .sidebar-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      z-index: 99;
    }
    .sidebar-overlay.open { display: block; }
    .stat-row {
      display: flex;
      gap: 12px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .stat-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 16px;
      flex: 1;
      min-width: 140px;
    }
    .stat-label {
      font-size: 12px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .stat-value { font-size: 22px; font-weight: 600; }
    .stat-detail { font-size: 12px; color: var(--text-dim); margin-top: 2px; }
    .health-dot {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-right: 6px;
      vertical-align: middle;
    }
    .health-dot.healthy { background: var(--success); }
    .health-dot.unhealthy { background: var(--danger); }
    .wizard-overlay {
      position: fixed;
      inset: 0;
      background: var(--bg);
      z-index: 200;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .wizard-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 32px;
      max-width: 600px;
      width: 100%;
    }
    .wizard-card h2 { font-size: 20px; font-weight: 600; margin-bottom: 8px; }
    .wizard-card p { color: var(--text-dim); font-size: 14px; margin-bottom: 16px; }
    .wizard-steps {
      display: flex;
      justify-content: center;
      gap: 8px;
      margin-bottom: 24px;
    }
    .wizard-step-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--border);
    }
    .wizard-step-dot.active { background: var(--accent); }
    .wizard-nav {
      display: flex;
      justify-content: space-between;
      margin-top: 24px;
      gap: 8px;
    }
    @media (max-width: 768px) {
      .hamburger-btn { display: inline-flex; }
      .sidebar {
        position: fixed;
        top: 0;
        left: 0;
        bottom: 0;
        z-index: 100;
        transform: translateX(-100%);
        transition: transform 0.25s ease;
      }
      .sidebar.open { transform: translateX(0); }
      main { width: 100%; }
      .stat-row { flex-direction: column; }
      .stat-card { min-width: unset; }
    }
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
      showWizard: false,
      wizardStep: 1,
      wizardDismissed: false,
      stats: null,
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

    function getCsrfToken() {
      var meta = document.querySelector('meta[name="csrf-token"]');
      return meta ? meta.getAttribute('content') : '';
    }

    async function api(path, opts) {
      try {
        var headers = { 'Content-Type': 'application/json' };
        var csrfToken = getCsrfToken();
        if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
        var res = await fetch(path, {
          headers: headers,
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
        // Fetch CSRF token for state-changing requests
        var csrf = await api('/api/csrf-token');
        if (csrf && csrf.token) {
          var meta = document.querySelector('meta[name="csrf-token"]');
          if (meta) meta.setAttribute('content', csrf.token);
        }
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
          await loadStats();
          if (state.currentTenant.status === 'running' && state.stats && state.stats.totalDevices === 0 && !state.wizardDismissed) {
            state.showWizard = true;
          }
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
      if (state.showWizard && t) return renderWizard(t);
      return '<header>' +
        '<div style="display:flex;align-items:center;gap:12px">' +
          '<button class="hamburger-btn" onclick="toggleSidebar()">&#9776;</button>' +
          '<h1>atproto-tailnet</h1>' +
        '</div>' +
        '<div class="user-info">' +
          (safeUrl(state.user.avatarUrl) ? '<img src="' + safeUrl(state.user.avatarUrl) + '" />' : '') +
          '<span>' + esc(state.user.handle) + '</span>' +
          '<form action="/auth/logout" method="post" style="display:inline"><button class="btn-sm btn-ghost">Sign out</button></form>' +
        '</div>' +
      '</header>' +
      renderLockdownBanner() +
      (t ? renderTenantView(t) : '<main style="max-width:960px;margin:0 auto;padding:24px"><div class="empty-state">No tailnets. This shouldn\\'t happen!</div></main>');
    }

    function renderTenantView(t) {
      if (t.status === 'provisioning') {
        return '<main style="max-width:960px;margin:0 auto;padding:24px"><div class="section"><div class="card">' +
          '<div class="card-header"><h3>' + esc(t.name) + '</h3>' +
            '<span class="badge" style="background:#f59e0b20;color:#f59e0b">provisioning</span></div>' +
          '<p style="color:var(--text-dim);margin-top:8px">Your tailnet is being set up. This usually takes 10-15 seconds. The page will refresh automatically.</p>' +
        '</div></div></main>';
      }
      if (t.status === 'error') {
        return '<main style="max-width:960px;margin:0 auto;padding:24px"><div class="section"><div class="card">' +
          '<div class="card-header"><h3>' + esc(t.name) + '</h3>' +
            '<span class="badge" style="background:#ef444420;color:#ef4444">error</span></div>' +
          '<p style="color:var(--text-dim);margin-top:8px">Something went wrong provisioning your tailnet. Try signing out and back in, or contact support.</p>' +
        '</div></div></main>';
      }

      var canSecurity = hasPerm('manage_settings') || hasPerm('approve_devices') || hasPerm('approve_joins') || hasPerm('approve_services');
      var canAudit = hasPerm('view_audit_log');
      var canRoles = hasPerm('manage_roles');
      var canServices = hasPerm('manage_services') || hasPerm('approve_services');
      var canBoard = hasPerm('manage_board') || hasPerm('create_posts');
      var canAgents = state.settings && state.settings.allowAgentTokens;
      var canAcl = hasPerm('manage_acl');
      var canDevices = hasPerm('manage_devices');
      var canSettings = hasPerm('manage_settings');
      var hasManageGroup = hasPerm('invite') || canServices || canBoard || canSettings;
      var hasAccessGroup = canRoles || canAgents || canAcl;
      var hasAdminGroup = true;

      var roleBadge = t.isOriginator
        ? '<span class="badge badge-originator">originator</span>'
        : '<span class="badge badge-role">' + esc(t.roleName || 'citizen') + '</span>';

      return '<div class="dashboard-layout">' +
        '<aside id="sidebar" class="sidebar">' +
          '<div class="sidebar-tenant">' +
            '<h3>' + esc(t.name) + '</h3>' +
            '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">' +
              '<span class="badge badge-' + t.status + '">' + t.status + '</span>' +
              roleBadge +
            '</div>' +
          '</div>' +
          '<nav>' +
            '<div class="nav-group-header">Network</div>' +
            '<button class="nav-item' + (state.tab === 'status' ? ' active' : '') + '" onclick="switchTab(\\'status\\')">Status</button>' +
            (canAcl ? '<button class="nav-item' + (state.tab === 'derp' ? ' active' : '') + '" onclick="switchTab(\\'derp\\')">DERP Relays</button>' : '') +
            (canSettings ? '<button class="nav-item' + (state.tab === 'ipconfig' ? ' active' : '') + '" onclick="switchTab(\\'ipconfig\\')">IP Ranges</button>' : '') +
            (canDevices ? '<button class="nav-item' + (state.tab === 'routes' ? ' active' : '') + '" onclick="switchTab(\\'routes\\')">Routes</button>' : '') +
            '<button class="nav-item' + (state.tab === 'devices' ? ' active' : '') + '" onclick="switchTab(\\'devices\\')">Devices</button>' +
            '<button class="nav-item' + (state.tab === 'members' ? ' active' : '') + '" onclick="switchTab(\\'members\\')">Members</button>' +
            '<button class="nav-item' + (state.tab === 'connect' ? ' active' : '') + '" onclick="switchTab(\\'connect\\')">Add Device</button>' +
            (hasManageGroup ?
              '<div class="nav-group-header">Manage</div>' +
              (hasPerm('invite') ? '<button class="nav-item' + (state.tab === 'invite' ? ' active' : '') + '" onclick="switchTab(\\'invite\\')">Invite</button>' : '') +
              (canServices ? '<button class="nav-item' + (state.tab === 'services' ? ' active' : '') + '" onclick="switchTab(\\'services\\')">Services</button>' : '') +
              (canBoard ? '<button class="nav-item' + (state.tab === 'board' ? ' active' : '') + '" onclick="switchTab(\\'board\\')">Board</button>' : '') +
              (canSettings ? '<button class="nav-item' + (state.tab === 'federation' ? ' active' : '') + '" onclick="switchTab(\\'federation\\')">Federation</button>' : '')
            : '') +
            (hasAccessGroup ?
              '<div class="nav-group-header">Access Control</div>' +
              (canRoles ? '<button class="nav-item' + (state.tab === 'roles' ? ' active' : '') + '" onclick="switchTab(\\'roles\\')">Roles</button>' : '') +
              (canAgents ? '<button class="nav-item' + (state.tab === 'agents' ? ' active' : '') + '" onclick="switchTab(\\'agents\\')">Agents</button>' : '') +
              (canAcl ? '<button class="nav-item' + (state.tab === 'acl' ? ' active' : '') + '" onclick="switchTab(\\'acl\\')">ACL</button>' : '')
            : '') +
            (hasAdminGroup ?
              '<div class="nav-group-header">Admin</div>' +
              '<button class="nav-item' + (state.tab === 'usage' ? ' active' : '') + '" onclick="switchTab(\\'usage\\')">Usage</button>' +
              (canSecurity ? '<button class="nav-item' + (state.tab === 'security' ? ' active' : '') + '" onclick="switchTab(\\'security\\')">Security</button>' : '') +
              (canAudit ? '<button class="nav-item' + (state.tab === 'audit' ? ' active' : '') + '" onclick="switchTab(\\'audit\\')">Audit Log</button>' : '')
            : '') +
          '</nav>' +
        '</aside>' +
        '<div id="sidebar-overlay" class="sidebar-overlay" onclick="toggleSidebar()"></div>' +
        '<main>' +
          renderInvitationsReceived() +
          renderStatsSummary() +

          '<div id="tab-status" class="' + (state.tab !== 'status' ? 'hidden' : '') + '">' +
            '<div class="card"><div id="status-content">Loading...</div></div>' +
          '</div>' +

          (canAcl ?
            '<div id="tab-derp" class="' + (state.tab !== 'derp' ? 'hidden' : '') + '">' +
              '<div class="card">' +
                '<div class="card-header"><h3>DERP Relay Configuration</h3></div>' +
                '<p style="color:var(--text-dim);font-size:13px;margin-bottom:12px">DERP (Designated Encrypted Relay for Packets) relays help devices communicate when direct connections are not possible.</p>' +
                '<div id="derp-toggles">Loading...</div>' +
              '</div>' +
              '<div class="card" style="margin-top:12px">' +
                '<div class="card-header"><h3>Custom DERP Regions</h3></div>' +
                '<div id="derp-regions-list">Loading...</div>' +
                '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">' +
                  '<h4 style="margin-bottom:8px;font-size:14px">Add Region</h4>' +
                  '<div style="display:flex;flex-direction:column;gap:8px">' +
                    '<div class="inline-form">' +
                      '<input type="text" id="derp-region-id" placeholder="Region ID (900-999)" style="max-width:180px" />' +
                      '<input type="text" id="derp-region-code" placeholder="Region code (e.g. mycolo)" style="max-width:180px" />' +
                      '<input type="text" id="derp-region-name" placeholder="Region name" />' +
                    '</div>' +
                    '<div style="font-size:13px;color:var(--text-dim)">Initial node (at least one required):</div>' +
                    '<div class="inline-form">' +
                      '<input type="text" id="derp-node-name" placeholder="Node name" style="max-width:160px" />' +
                      '<input type="text" id="derp-node-host" placeholder="Hostname" />' +
                    '</div>' +
                    '<div class="inline-form">' +
                      '<input type="text" id="derp-node-stun" placeholder="STUN port (optional)" style="max-width:180px" />' +
                      '<input type="text" id="derp-node-derp" placeholder="DERP port (optional)" style="max-width:180px" />' +
                      '<button onclick="addDerpRegion()">Add Region</button>' +
                    '</div>' +
                  '</div>' +
                '</div>' +
              '</div>' +
              '<div style="margin-top:12px">' +
                '<button onclick="saveDerp()">Save DERP Configuration</button>' +
              '</div>' +
            '</div>' : '') +

          (canSettings ?
            '<div id="tab-ipconfig" class="' + (state.tab !== 'ipconfig' ? 'hidden' : '') + '">' +
              '<div class="card">' +
                '<div class="card-header"><h3>IP Range Configuration</h3></div>' +
                '<p style="color:var(--text-dim);font-size:13px;margin-bottom:12px">Configure the IP address prefixes and allocation strategy for this tailnet.</p>' +
                '<div style="background:#f59e0b15;border:1px solid #f59e0b40;border-radius:6px;padding:12px 16px;margin-bottom:16px;color:var(--warning);font-size:13px">' +
                  'Warning: Changing IP ranges will restart the Headscale container. All connected devices will need to re-register.' +
                '</div>' +
                '<div style="display:flex;flex-direction:column;gap:12px">' +
                  '<div>' +
                    '<label style="font-size:13px;color:var(--text-dim);display:block;margin-bottom:4px">IPv4 Prefix</label>' +
                    '<input type="text" id="ipconfig-v4" placeholder="100.64.0.0/10" />' +
                  '</div>' +
                  '<div>' +
                    '<label style="font-size:13px;color:var(--text-dim);display:block;margin-bottom:4px">IPv6 Prefix</label>' +
                    '<input type="text" id="ipconfig-v6" placeholder="fd7a:115c:a1e0::/48" />' +
                  '</div>' +
                  '<div>' +
                    '<label style="font-size:13px;color:var(--text-dim);display:block;margin-bottom:4px">IP Allocation Strategy</label>' +
                    '<select id="ipconfig-alloc">' +
                      '<option value="sequential">Sequential</option>' +
                      '<option value="random">Random</option>' +
                    '</select>' +
                  '</div>' +
                '</div>' +
                '<div style="margin-top:16px">' +
                  '<button onclick="saveIpConfig()">Save IP Configuration</button>' +
                '</div>' +
              '</div>' +
            '</div>' : '') +

          (canDevices ?
            '<div id="tab-routes" class="' + (state.tab !== 'routes' ? 'hidden' : '') + '">' +
              '<div class="card">' +
                '<div class="card-header"><h3>Exit Nodes</h3></div>' +
                '<div id="routes-exit-nodes">Loading...</div>' +
              '</div>' +
              '<div class="card" style="margin-top:12px">' +
                '<div class="card-header"><h3>Subnet Routers</h3></div>' +
                '<div id="routes-subnets">Loading...</div>' +
              '</div>' +
            '</div>' : '') +

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

      (canSettings ?
        '<div id="tab-federation" class="' + (state.tab !== 'federation' ? 'hidden' : '') + '">' +
          '<div class="card">' +
            '<div class="card-header"><h3>Request Federation</h3></div>' +
            '<p style="color:var(--text-dim);font-size:13px;margin-bottom:12px">Connect this tailnet with another by requesting federation. Federated tailnets can route traffic between each other over specified CIDR ranges.</p>' +
            '<div style="display:flex;flex-direction:column;gap:8px">' +
              '<input type="text" id="fed-target-slug" placeholder="Target tailnet slug" />' +
              '<textarea id="fed-message" placeholder="Optional message to the target tailnet admin" rows="2"></textarea>' +
              '<textarea id="fed-cidrs" placeholder="CIDRs to share (one per line, optional)" rows="2"></textarea>' +
              '<div><button onclick="requestFederation()">Send Request</button></div>' +
            '</div>' +
            '<div id="fed-outgoing" style="margin-top:12px"></div>' +
          '</div>' +
          '<div class="card" style="margin-top:12px">' +
            '<div class="card-header"><h3>Incoming Requests</h3></div>' +
            '<div id="fed-incoming">Loading...</div>' +
          '</div>' +
          '<div class="card" style="margin-top:12px">' +
            '<div class="card-header"><h3>Active Federations</h3></div>' +
            '<div id="fed-active">Loading...</div>' +
          '</div>' +
          '<div class="card" style="margin-top:12px">' +
            '<div class="card-header"><h3>History</h3></div>' +
            '<div id="fed-history">Loading...</div>' +
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

      (canAgents ?
        '<div id="tab-agents" class="' + (state.tab !== 'agents' ? 'hidden' : '') + '">' +
          '<div class="card">' +
            '<div class="card-header"><h3>Agent API Tokens</h3></div>' +
            '<p style="color:var(--text-dim);font-size:13px;margin-bottom:12px">API tokens allow AI agents and other programmatic clients to manage this tailnet on your behalf. Tokens are scoped to a subset of your permissions and carry a mandatory expiry.</p>' +
            '<div id="agent-tokens-list">Loading...</div>' +
            (hasPerm('create_agent_tokens') || isOriginator() ?
              '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">' +
                '<h4 style="margin-bottom:8px;font-size:14px">Create Token</h4>' +
                '<div class="inline-form" style="margin-bottom:8px">' +
                  '<input type="text" id="agent-token-name" placeholder="Token name (e.g. claude-code)" style="max-width:200px" />' +
                  '<select id="agent-token-expiry" style="max-width:150px">' +
                    '<option value="7">7 days</option>' +
                    '<option value="30" selected>30 days</option>' +
                    '<option value="90">90 days</option>' +
                    '<option value="365">365 days</option>' +
                  '</select>' +
                  '<button onclick="createAgentToken()">Create</button>' +
                '</div>' +
                '<div style="margin-bottom:8px">' +
                  '<span style="font-size:12px;color:var(--text-dim)">Token permissions (select which permissions to grant):</span>' +
                  '<div id="agent-token-perms" style="margin-top:4px"></div>' +
                '</div>' +
              '</div>' : '') +
            '<div id="agent-token-created" style="margin-top:12px"></div>' +
          '</div>' +
        '</div>' : '') +

      (canAcl ?
        '<div id="tab-acl" class="' + (state.tab !== 'acl' ? 'hidden' : '') + '">' +
          '<div class="card">' +
            '<div class="card-header"><h3>ACL Rules</h3></div>' +
            '<p style="color:var(--text-dim);font-size:13px;margin-bottom:12px">Network access control rules define which sources can reach which destinations. Rules are evaluated top-down; the first matching rule wins.</p>' +
            '<div id="acl-rules-list">Loading...</div>' +
            '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">' +
              '<h4 style="margin-bottom:8px;font-size:14px">Add Rule</h4>' +
              '<div style="display:flex;flex-direction:column;gap:8px">' +
                '<div class="inline-form">' +
                  '<select id="acl-src-select" multiple style="min-height:60px"><option value="*">* (all)</option></select>' +
                  '<div style="display:flex;flex-direction:column;gap:4px;flex:1">' +
                    '<select id="acl-dst-select" multiple style="min-height:60px"><option value="*">* (all)</option></select>' +
                    '<div class="inline-form">' +
                      '<input type="text" id="acl-dst-port" placeholder="Port (default: *)" style="max-width:150px" />' +
                    '</div>' +
                  '</div>' +
                  '<button onclick="addAclRule()">Add Rule</button>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="card" style="margin-top:12px">' +
            '<div class="card-header"><h3>Groups</h3></div>' +
            '<div id="acl-groups-list">Loading...</div>' +
            '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">' +
              '<h4 style="margin-bottom:8px;font-size:14px">Add Group</h4>' +
              '<div class="inline-form">' +
                '<input type="text" id="acl-group-name" placeholder="group:name" style="max-width:200px" />' +
                '<select id="acl-group-members" multiple style="min-height:40px"></select>' +
                '<button onclick="addAclGroup()">Add Group</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="card" style="margin-top:12px">' +
            '<div class="card-header"><h3>Host Aliases</h3></div>' +
            '<div id="acl-hosts-list">Loading...</div>' +
            '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">' +
              '<h4 style="margin-bottom:8px;font-size:14px">Add Host Alias</h4>' +
              '<div class="inline-form">' +
                '<input type="text" id="acl-host-alias" placeholder="Alias (e.g. webserver)" style="max-width:200px" />' +
                '<input type="text" id="acl-host-ip" placeholder="IP address (e.g. 100.64.0.1)" />' +
                '<button onclick="addAclHost()">Add Host</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;gap:8px;margin-top:12px">' +
            '<button onclick="saveAcl()">Save ACL Policy</button>' +
            '<button class="btn-danger" onclick="resetAclToAllowAll()">Reset to Allow-All</button>' +
          '</div>' +
        '</div>' : '') +

      '<div id="tab-usage" class="' + (state.tab !== 'usage' ? 'hidden' : '') + '">' +
        '<div class="card">' +
          '<div class="card-header"><h3>Current Usage</h3></div>' +
          '<div id="usage-current">Loading...</div>' +
        '</div>' +
        (hasPerm('manage_settings') ?
          '<div class="card" style="margin-top:12px">' +
            '<div class="card-header"><h3>Plan</h3></div>' +
            '<div id="usage-plan">Loading...</div>' +
          '</div>' : '') +
        '<div class="card" style="margin-top:12px">' +
          '<div class="card-header"><h3>Usage History</h3></div>' +
          '<div id="usage-history">Loading...</div>' +
        '</div>' +
      '</div>' +

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
        '</div>' : '') +
      '</main>' +
      '</div>';
    }

    function switchTab(tab) {
      state.tab = tab;
      var sb = document.getElementById('sidebar');
      var ov = document.getElementById('sidebar-overlay');
      if (sb) sb.classList.remove('open');
      if (ov) ov.classList.remove('open');
      render();
      if (tab === 'status') loadStatus();
      if (tab === 'devices') loadDevices();
      if (tab === 'members') loadMembers();
      if (tab === 'invite') loadSentInvitations();
      if (tab === 'services') loadServices();
      if (tab === 'board') loadBoard();
      if (tab === 'federation') loadFederation();
      if (tab === 'agents') loadAgents();
      if (tab === 'acl') loadAcl();
      if (tab === 'derp') loadDerp();
      if (tab === 'ipconfig') loadIpConfig();
      if (tab === 'routes') loadRoutes();
      if (tab === 'roles') loadRoles();
      if (tab === 'usage') loadUsage();
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

    // ── Federation tab ────────────────────────────────────────────

    async function loadFederation() {
      if (!state.currentTenant) return;
      var data = await api('/api/tenants/' + state.currentTenant.id + '/federation');
      if (!data) return;
      var links = data.links || [];

      // Outgoing pending (shown below the request form)
      var outgoing = links.filter(function(l) { return l.direction === 'outgoing' && l.status === 'pending'; });
      var outEl = document.getElementById('fed-outgoing');
      if (outEl) {
        if (outgoing.length === 0) {
          outEl.innerHTML = '';
        } else {
          outEl.innerHTML = '<h4 style="margin-bottom:8px;color:var(--text-dim)">Pending Outgoing</h4>' +
            outgoing.map(function(l) {
              return '<div class="role-card" style="border-left:3px solid var(--warning)">' +
                '<div class="role-card-header">' +
                  '<div>' +
                    '<strong>' + esc(l.peerName || l.peerSlug) + '</strong>' +
                    '<span class="badge" style="background:#f59e0b20;color:var(--warning);margin-left:8px">pending</span>' +
                  '</div>' +
                '</div>' +
                (l.message ? '<div style="font-size:13px;color:var(--text-dim);margin-bottom:4px">' + esc(l.message) + '</div>' : '') +
                (l.requesterCidrs && l.requesterCidrs.length > 0 ?
                  '<div style="font-size:12px;color:var(--text-dim)">Your CIDRs: <code style="color:var(--accent)">' + l.requesterCidrs.map(function(c) { return esc(c); }).join(', ') + '</code></div>' : '') +
                '<div style="font-size:12px;color:var(--text-dim);margin-top:4px">' + new Date(l.createdAt).toLocaleString() + '</div>' +
              '</div>';
            }).join('');
        }
      }

      // Incoming pending
      var incoming = links.filter(function(l) { return l.direction === 'incoming' && l.status === 'pending'; });
      var inEl = document.getElementById('fed-incoming');
      if (inEl) {
        if (incoming.length === 0) {
          inEl.innerHTML = '<div class="empty-state" style="padding:16px">No incoming requests</div>';
        } else {
          inEl.innerHTML = incoming.map(function(l) {
            return '<div class="role-card" style="border-left:3px solid var(--warning)">' +
              '<div class="role-card-header">' +
                '<div>' +
                  '<strong>' + esc(l.peerName || l.peerSlug) + '</strong>' +
                  '<span class="badge" style="background:#f59e0b20;color:var(--warning);margin-left:8px">pending</span>' +
                '</div>' +
              '</div>' +
              (l.message ? '<div style="font-size:13px;color:var(--text-dim);margin-bottom:8px">' + esc(l.message) + '</div>' : '') +
              (l.requesterCidrs && l.requesterCidrs.length > 0 ?
                '<div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">Their CIDRs: <code style="color:var(--accent)">' + l.requesterCidrs.map(function(c) { return esc(c); }).join(', ') + '</code></div>' : '') +
              '<div style="margin-bottom:8px">' +
                '<textarea id="fed-accept-cidrs-' + l.id + '" placeholder="Your CIDRs to share (one per line, optional)" rows="2"></textarea>' +
              '</div>' +
              '<div style="display:flex;gap:8px">' +
                '<button class="btn-sm" onclick="acceptFederation(\\'' + l.id + '\\')">Accept</button>' +
                '<button class="btn-sm btn-danger" onclick="rejectFederation(\\'' + l.id + '\\')">Reject</button>' +
              '</div>' +
            '</div>';
          }).join('');
        }
      }

      // Active federations
      var active = links.filter(function(l) { return l.status === 'active'; });
      var actEl = document.getElementById('fed-active');
      if (actEl) {
        if (active.length === 0) {
          actEl.innerHTML = '<div class="empty-state" style="padding:16px">No active federations</div>';
        } else {
          actEl.innerHTML = active.map(function(l) {
            return '<div class="role-card" style="border-left:3px solid var(--success)">' +
              '<div class="role-card-header">' +
                '<div>' +
                  '<strong>' + esc(l.peerName || l.peerSlug) + '</strong>' +
                  '<span class="badge badge-running" style="margin-left:8px">active</span>' +
                  '<span class="badge badge-role" style="margin-left:4px">' + esc(l.direction) + '</span>' +
                '</div>' +
                '<button class="btn-sm btn-danger" onclick="revokeFederation(\\'' + l.id + '\\')">Revoke</button>' +
              '</div>' +
              (l.requesterCidrs && l.requesterCidrs.length > 0 ?
                '<div style="font-size:12px;color:var(--text-dim);margin-bottom:4px">Requester CIDRs: <code style="color:var(--accent)">' + l.requesterCidrs.map(function(c) { return esc(c); }).join(', ') + '</code></div>' : '') +
              (l.targetCidrs && l.targetCidrs.length > 0 ?
                '<div style="font-size:12px;color:var(--text-dim)">Target CIDRs: <code style="color:var(--accent)">' + l.targetCidrs.map(function(c) { return esc(c); }).join(', ') + '</code></div>' : '') +
            '</div>';
          }).join('');
        }
      }

      // History (rejected/revoked)
      var history = links.filter(function(l) { return l.status === 'rejected' || l.status === 'revoked'; });
      var histEl = document.getElementById('fed-history');
      if (histEl) {
        if (history.length === 0) {
          histEl.innerHTML = '<div class="empty-state" style="padding:16px">No history</div>';
        } else {
          histEl.innerHTML = history.map(function(l) {
            var statusBadge = l.status === 'rejected'
              ? '<span class="badge" style="background:#8888a020;color:var(--text-dim);margin-left:8px">rejected</span>'
              : '<span class="badge" style="background:#8888a020;color:var(--text-dim);margin-left:8px">revoked</span>';
            return '<div class="role-card" style="border-left:3px solid var(--border);opacity:0.6">' +
              '<div class="role-card-header">' +
                '<div>' +
                  '<strong>' + esc(l.peerName || l.peerSlug) + '</strong>' +
                  statusBadge +
                  '<span class="badge badge-role" style="margin-left:4px">' + esc(l.direction) + '</span>' +
                '</div>' +
              '</div>' +
              '<div style="font-size:12px;color:var(--text-dim)">' + new Date(l.updatedAt).toLocaleString() + '</div>' +
            '</div>';
          }).join('');
        }
      }
    }

    async function requestFederation() {
      if (!state.currentTenant) return;
      var slugEl = document.getElementById('fed-target-slug');
      var msgEl = document.getElementById('fed-message');
      var cidrsEl = document.getElementById('fed-cidrs');
      var targetSlug = slugEl.value.trim();
      if (!targetSlug) { toast('Target tailnet slug is required'); return; }
      var cidrs = cidrsEl.value.trim().split('\\n').map(function(c) { return c.trim(); }).filter(function(c) { return c; });
      var body = { targetSlug: targetSlug };
      if (msgEl.value.trim()) body.message = msgEl.value.trim();
      if (cidrs.length > 0) body.cidrs = cidrs;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/federation', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (result) {
        slugEl.value = '';
        msgEl.value = '';
        cidrsEl.value = '';
        toast('Federation request sent');
        loadFederation();
      }
    }

    async function acceptFederation(linkId) {
      if (!state.currentTenant) return;
      var cidrsEl = document.getElementById('fed-accept-cidrs-' + linkId);
      var cidrs = [];
      if (cidrsEl && cidrsEl.value.trim()) {
        cidrs = cidrsEl.value.trim().split('\\n').map(function(c) { return c.trim(); }).filter(function(c) { return c; });
      }
      var body = {};
      if (cidrs.length > 0) body.cidrs = cidrs;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/federation/' + linkId + '/accept', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (result) {
        toast('Federation accepted');
        loadFederation();
      }
    }

    async function rejectFederation(linkId) {
      if (!state.currentTenant) return;
      if (!confirm('Reject this federation request?')) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/federation/' + linkId + '/reject', { method: 'POST' });
      if (result) {
        toast('Federation request rejected');
        loadFederation();
      }
    }

    async function revokeFederation(linkId) {
      if (!state.currentTenant) return;
      if (!confirm('Revoke this federation? Traffic routing between the tailnets will stop.')) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/federation/' + linkId + '/revoke', { method: 'POST' });
      if (result) {
        toast('Federation revoked');
        loadFederation();
      }
    }

    // ── Agents tab ─────────────────────────────────────────────────

    var agentTokenPerms = [];

    async function loadAgents() {
      if (!state.currentTenant) return;
      var tokens = await api('/api/tenants/' + state.currentTenant.id + '/agent-tokens') || [];
      var el = document.getElementById('agent-tokens-list');
      if (el) {
        if (tokens.length === 0) {
          el.innerHTML = '<div class="empty-state" style="padding:16px">No agent tokens</div>';
        } else {
          el.innerHTML = tokens.map(function(t) {
            var isExpired = new Date(t.expiresAt) < new Date();
            var statusBadge = t.status === 'revoked'
              ? '<span class="badge badge-stopped">revoked</span>'
              : isExpired
                ? '<span class="badge" style="background:#f59e0b20;color:var(--warning)">expired</span>'
                : '<span class="badge badge-running">active</span>';
            var ownerInfo = t.ownerId !== state.user.id
              ? '<br><span style="color:var(--text-dim);font-size:12px">Owner: ' + esc(t.ownerDisplayName || t.ownerHandle) + '</span>'
              : '';
            var permsHtml = (t.permissions || []).map(function(p) {
              return '<span class="badge-perm">' + esc(p) + '</span>';
            }).join('');
            var lastUsed = t.lastUsedAt
              ? '<br><span style="color:var(--text-dim);font-size:12px">Last used: ' + new Date(t.lastUsedAt).toLocaleString() + '</span>'
              : '<br><span style="color:var(--text-dim);font-size:12px">Never used</span>';
            var canRevoke = t.status === 'active' && !isExpired && (t.ownerId === state.user.id || hasPerm('manage_agent_tokens'));
            return '<div class="approval-item">' +
              '<div>' +
                '<strong>' + esc(t.name) + '</strong> ' + statusBadge +
                '<span style="color:var(--text-dim);font-size:12px;margin-left:8px">' + esc(t.tokenPrefix) + '...</span>' +
                ownerInfo +
                '<br><span style="color:var(--text-dim);font-size:12px">Expires: ' + new Date(t.expiresAt).toLocaleDateString() + '</span>' +
                lastUsed +
                '<br>' + permsHtml +
              '</div>' +
              (canRevoke ? '<button class="btn-sm btn-danger" onclick="revokeAgentToken(\\'' + t.id + '\\')">Revoke</button>' : '') +
            '</div>';
          }).join('');
        }
      }

      // Render permission chips for token creation
      var permEl = document.getElementById('agent-token-perms');
      if (permEl) {
        agentTokenPerms = [];
        permEl.innerHTML = state.allPerms.map(function(p) {
          return '<span class="perm-chip" id="atp-' + p + '" onclick="toggleAgentPerm(\\'' + p + '\\')">' + esc(p) + '</span>';
        }).join('');
      }
    }

    function toggleAgentPerm(perm) {
      var idx = agentTokenPerms.indexOf(perm);
      if (idx === -1) { agentTokenPerms.push(perm); } else { agentTokenPerms.splice(idx, 1); }
      var chip = document.getElementById('atp-' + perm);
      if (chip) { chip.className = 'perm-chip' + (agentTokenPerms.indexOf(perm) !== -1 ? ' active' : ''); }
    }

    async function createAgentToken() {
      if (!state.currentTenant) return;
      var nameEl = document.getElementById('agent-token-name');
      var expiryEl = document.getElementById('agent-token-expiry');
      var name = nameEl.value.trim();
      if (!name) { toast('Token name required'); return; }
      if (agentTokenPerms.length === 0) { toast('Select at least one permission'); return; }
      var result = await api('/api/tenants/' + state.currentTenant.id + '/agent-tokens', {
        method: 'POST',
        body: JSON.stringify({
          name: name,
          permissions: agentTokenPerms,
          expiresInDays: parseInt(expiryEl.value),
        }),
      });
      if (result) {
        nameEl.value = '';
        var el = document.getElementById('agent-token-created');
        if (el) {
          el.innerHTML = '<div class="card" style="background:var(--bg);border-color:var(--success)">' +
            '<p style="color:var(--success);font-weight:600;margin-bottom:8px">Token created! Copy it now \\u2014 it will not be shown again.</p>' +
            '<div class="code-block" onclick="copyToClipboard(this.textContent)">' + esc(result.token) + '</div>' +
          '</div>';
        }
        loadAgents();
      }
    }

    async function revokeAgentToken(tokenId) {
      if (!state.currentTenant) return;
      if (!confirm('Revoke this agent token? Any agent using it will lose access immediately.')) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/agent-tokens/' + tokenId, { method: 'DELETE' });
      if (result) {
        toast('Token revoked');
        loadAgents();
      }
    }

    // ── ACL tab ──────────────────────────────────────────────────

    var aclState = { acls: [], groups: {}, hosts: {}, users: [] };

    async function loadAcl() {
      if (!state.currentTenant) return;
      var data = await api('/api/tenants/' + state.currentTenant.id + '/acl');
      if (!data) return;
      var policy = data.policy || {};
      aclState.acls = policy.acls || [];
      aclState.groups = policy.groups || {};
      aclState.hosts = policy.hosts || {};
      aclState.users = data.users || [];
      renderAclRules();
      renderAclGroups();
      renderAclHosts();
      populateAclSelects();
    }

    function aclOptionValues() {
      var vals = aclState.users.slice();
      Object.keys(aclState.groups).forEach(function(g) {
        if (vals.indexOf(g) === -1) vals.push(g);
      });
      return vals;
    }

    function populateAclSelects() {
      var opts = aclOptionValues();
      var srcSelect = document.getElementById('acl-src-select');
      var dstSelect = document.getElementById('acl-dst-select');
      var grpMembers = document.getElementById('acl-group-members');
      if (srcSelect) {
        srcSelect.innerHTML = '<option value="*">* (all)</option>' +
          opts.map(function(v) {
            return '<option value="' + esc(v) + '">' + esc(v) + '</option>';
          }).join('');
      }
      if (dstSelect) {
        dstSelect.innerHTML = '<option value="*">* (all)</option>' +
          opts.map(function(v) {
            return '<option value="' + esc(v) + '">' + esc(v) + '</option>';
          }).join('');
      }
      if (grpMembers) {
        grpMembers.innerHTML = aclState.users.map(function(u) {
          return '<option value="' + esc(u) + '">' + esc(u) + '</option>';
        }).join('');
      }
    }

    function renderAclRules() {
      var el = document.getElementById('acl-rules-list');
      if (!el) return;
      if (aclState.acls.length === 0) {
        el.innerHTML = '<div class="empty-state" style="padding:16px">No ACL rules defined</div>';
        return;
      }
      el.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:6px 12px;display:flex;gap:12px;font-weight:600">' +
        '<span style="flex:1">Source(s)</span><span style="flex:1">Destination(s)</span><span style="width:70px">Action</span><span style="width:60px"></span>' +
      '</div>' +
      aclState.acls.map(function(rule, idx) {
        var srcList = (rule.src || []).map(function(s) { return esc(s); }).join(', ');
        var dstList = (rule.dst || []).map(function(d) { return esc(d); }).join(', ');
        return '<div class="approval-item" style="font-size:13px">' +
          '<span style="flex:1;font-family:monospace;word-break:break-all">' + srcList + '</span>' +
          '<span style="flex:1;font-family:monospace;word-break:break-all">' + dstList + '</span>' +
          '<span style="width:70px"><span class="badge badge-running">' + esc(rule.action || 'accept') + '</span></span>' +
          '<span style="width:60px"><button class="btn-sm btn-danger" onclick="removeAclRule(' + idx + ')">Del</button></span>' +
        '</div>';
      }).join('');
    }

    function renderAclGroups() {
      var el = document.getElementById('acl-groups-list');
      if (!el) return;
      var groupNames = Object.keys(aclState.groups);
      if (groupNames.length === 0) {
        el.innerHTML = '<div class="empty-state" style="padding:16px">No groups defined</div>';
        return;
      }
      el.innerHTML = groupNames.map(function(name) {
        var members = aclState.groups[name] || [];
        return '<div class="approval-item">' +
          '<div>' +
            '<strong>' + esc(name) + '</strong>' +
            '<br><span style="color:var(--text-dim);font-size:12px;font-family:monospace">' + members.map(function(m) { return esc(m); }).join(', ') + '</span>' +
          '</div>' +
          '<button class="btn-sm btn-danger" onclick="removeAclGroup(\\'' + esc(name).replace(/'/g, "\\\\'") + '\\')">Remove</button>' +
        '</div>';
      }).join('');
    }

    function renderAclHosts() {
      var el = document.getElementById('acl-hosts-list');
      if (!el) return;
      var hostNames = Object.keys(aclState.hosts);
      if (hostNames.length === 0) {
        el.innerHTML = '<div class="empty-state" style="padding:16px">No host aliases defined</div>';
        return;
      }
      el.innerHTML = hostNames.map(function(name) {
        var ip = aclState.hosts[name];
        return '<div class="approval-item">' +
          '<div>' +
            '<strong style="font-family:monospace">' + esc(name) + '</strong>' +
            '<span style="color:var(--text-dim);margin-left:12px;font-family:monospace">' + esc(String(ip)) + '</span>' +
          '</div>' +
          '<button class="btn-sm btn-danger" onclick="removeAclHost(\\'' + esc(name).replace(/'/g, "\\\\'") + '\\')">Remove</button>' +
        '</div>';
      }).join('');
    }

    function getSelectedValues(selectId) {
      var sel = document.getElementById(selectId);
      if (!sel) return [];
      var vals = [];
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].selected) vals.push(sel.options[i].value);
      }
      return vals;
    }

    function addAclRule() {
      var srcs = getSelectedValues('acl-src-select');
      var dsts = getSelectedValues('acl-dst-select');
      var portEl = document.getElementById('acl-dst-port');
      var port = portEl ? portEl.value.trim() : '';
      if (srcs.length === 0 || dsts.length === 0) { toast('Select at least one source and destination'); return; }
      var portSuffix = port && port !== '*' ? ':' + port : ':*';
      var formattedDsts = dsts.map(function(d) {
        if (d === '*') return '*:*';
        return d + portSuffix;
      });
      aclState.acls.push({ action: 'accept', src: srcs, dst: formattedDsts });
      renderAclRules();
      populateAclSelects();
      if (portEl) portEl.value = '';
      toast('Rule added (unsaved)');
    }

    function removeAclRule(idx) {
      aclState.acls.splice(idx, 1);
      renderAclRules();
      toast('Rule removed (unsaved)');
    }

    function addAclGroup() {
      var nameEl = document.getElementById('acl-group-name');
      var name = nameEl ? nameEl.value.trim() : '';
      if (!name) { toast('Group name is required'); return; }
      if (name.indexOf('group:') !== 0) { toast('Group name must start with group:'); return; }
      var members = getSelectedValues('acl-group-members');
      if (members.length === 0) { toast('Select at least one member'); return; }
      aclState.groups[name] = members;
      renderAclGroups();
      populateAclSelects();
      if (nameEl) nameEl.value = '';
      toast('Group added (unsaved)');
    }

    function removeAclGroup(name) {
      delete aclState.groups[name];
      renderAclGroups();
      populateAclSelects();
      toast('Group removed (unsaved)');
    }

    function addAclHost() {
      var aliasEl = document.getElementById('acl-host-alias');
      var ipEl = document.getElementById('acl-host-ip');
      var alias = aliasEl ? aliasEl.value.trim() : '';
      var ip = ipEl ? ipEl.value.trim() : '';
      if (!alias || !ip) { toast('Both alias and IP are required'); return; }
      aclState.hosts[alias] = ip;
      renderAclHosts();
      if (aliasEl) aliasEl.value = '';
      if (ipEl) ipEl.value = '';
      toast('Host alias added (unsaved)');
    }

    function removeAclHost(name) {
      delete aclState.hosts[name];
      renderAclHosts();
      toast('Host alias removed (unsaved)');
    }

    async function saveAcl() {
      if (!state.currentTenant) return;
      var policy = {
        acls: aclState.acls,
        groups: aclState.groups,
        hosts: aclState.hosts,
      };
      var result = await api('/api/tenants/' + state.currentTenant.id + '/acl', {
        method: 'PUT',
        body: JSON.stringify(policy),
      });
      if (result) {
        toast('ACL policy saved');
        loadAcl();
      }
    }

    async function resetAclToAllowAll() {
      if (!state.currentTenant) return;
      if (!confirm('Reset ACL to allow-all? This removes all rules, groups, and hosts.')) return;
      var policy = {
        acls: [{ action: 'accept', src: ['*'], dst: ['*:*'] }],
      };
      var result = await api('/api/tenants/' + state.currentTenant.id + '/acl', {
        method: 'PUT',
        body: JSON.stringify(policy),
      });
      if (result) {
        toast('ACL reset to allow-all');
        loadAcl();
      }
    }

    // ── DERP Relays tab ─────────────────────────────────────────────

    var derpState = { regions: [], embeddedDerpEnabled: false, usePublicDerp: true };

    async function loadDerp() {
      if (!state.currentTenant) return;
      var data = await api('/api/tenants/' + state.currentTenant.id + '/derp');
      if (!data) return;
      derpState.regions = data.regions || [];
      derpState.embeddedDerpEnabled = !!data.embeddedDerpEnabled;
      derpState.usePublicDerp = !!data.usePublicDerp;
      renderDerpToggles();
      renderDerpRegions();
    }

    function renderDerpToggles() {
      var el = document.getElementById('derp-toggles');
      if (!el) return;
      el.innerHTML =
        '<div class="toggle-row">' +
          '<div class="toggle-label"><span>Use public DERP relays</span><span>Allow connections through public relay infrastructure</span></div>' +
          '<label class="toggle"><input type="checkbox" ' + (derpState.usePublicDerp ? 'checked' : '') +
            ' onchange="derpState.usePublicDerp=this.checked" /><span class="slider"></span></label>' +
        '</div>' +
        '<div class="toggle-row">' +
          '<div class="toggle-label"><span>Embedded DERP server</span><span>Run a DERP relay inside this Headscale container (requires restart)</span></div>' +
          '<label class="toggle"><input type="checkbox" ' + (derpState.embeddedDerpEnabled ? 'checked' : '') +
            ' onchange="derpState.embeddedDerpEnabled=this.checked" /><span class="slider"></span></label>' +
        '</div>';
    }

    function renderDerpRegions() {
      var el = document.getElementById('derp-regions-list');
      if (!el) return;
      if (derpState.regions.length === 0) {
        el.innerHTML = '<div class="empty-state" style="padding:16px">No custom DERP regions defined</div>';
        return;
      }
      el.innerHTML = derpState.regions.map(function(region, rIdx) {
        var nodesHtml = region.nodes.map(function(node, nIdx) {
          return '<div class="approval-item" style="font-size:13px">' +
            '<div>' +
              '<strong>' + esc(node.name) + '</strong>' +
              '<span style="color:var(--text-dim);margin-left:8px;font-family:monospace">' + esc(node.hostname) + '</span>' +
              (node.stunPort ? '<span style="color:var(--text-dim);margin-left:8px;font-size:12px">STUN:' + esc(String(node.stunPort)) + '</span>' : '') +
              (node.derpPort ? '<span style="color:var(--text-dim);margin-left:8px;font-size:12px">DERP:' + esc(String(node.derpPort)) + '</span>' : '') +
            '</div>' +
            '<button class="btn-sm btn-danger" onclick="removeDerpNode(' + rIdx + ',' + nIdx + ')">Del</button>' +
          '</div>';
        }).join('');

        return '<div class="role-card">' +
          '<div class="role-card-header">' +
            '<div>' +
              '<strong>' + esc(region.regionName) + '</strong>' +
              '<span class="badge badge-role" style="margin-left:8px">' + esc(region.regionCode) + '</span>' +
              '<span style="color:var(--text-dim);font-size:12px;margin-left:8px">ID: ' + esc(String(region.regionId)) + '</span>' +
            '</div>' +
            '<button class="btn-sm btn-danger" onclick="removeDerpRegion(' + rIdx + ')">Remove</button>' +
          '</div>' +
          nodesHtml +
          '<div class="inline-form" style="margin-top:8px">' +
            '<input type="text" id="derp-add-node-name-' + rIdx + '" placeholder="Node name" style="max-width:140px" />' +
            '<input type="text" id="derp-add-node-host-' + rIdx + '" placeholder="Hostname" />' +
            '<input type="text" id="derp-add-node-stun-' + rIdx + '" placeholder="STUN port" style="max-width:100px" />' +
            '<input type="text" id="derp-add-node-derp-' + rIdx + '" placeholder="DERP port" style="max-width:100px" />' +
            '<button class="btn-sm" onclick="addDerpNode(' + rIdx + ')">Add Node</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function addDerpRegion() {
      var idEl = document.getElementById('derp-region-id');
      var codeEl = document.getElementById('derp-region-code');
      var nameEl = document.getElementById('derp-region-name');
      var nodeNameEl = document.getElementById('derp-node-name');
      var nodeHostEl = document.getElementById('derp-node-host');
      var nodeStunEl = document.getElementById('derp-node-stun');
      var nodeDerpEl = document.getElementById('derp-node-derp');

      var regionId = parseInt(idEl.value);
      var regionCode = codeEl.value.trim();
      var regionName = nameEl.value.trim();
      var nodeName = nodeNameEl.value.trim();
      var nodeHost = nodeHostEl.value.trim();

      if (!regionId || regionId < 900 || regionId > 999) { toast('Region ID must be between 900 and 999'); return; }
      if (!regionCode) { toast('Region code is required'); return; }
      if (!regionName) { toast('Region name is required'); return; }
      if (!nodeName || !nodeHost) { toast('At least one node with name and hostname is required'); return; }

      var node = { name: nodeName, hostname: nodeHost };
      var stunPort = parseInt(nodeStunEl.value);
      var derpPort = parseInt(nodeDerpEl.value);
      if (stunPort) node.stunPort = stunPort;
      if (derpPort) node.derpPort = derpPort;

      derpState.regions.push({
        regionId: regionId,
        regionCode: regionCode,
        regionName: regionName,
        nodes: [node],
      });

      idEl.value = '';
      codeEl.value = '';
      nameEl.value = '';
      nodeNameEl.value = '';
      nodeHostEl.value = '';
      nodeStunEl.value = '';
      nodeDerpEl.value = '';
      renderDerpRegions();
      toast('Region added (unsaved)');
    }

    function removeDerpRegion(idx) {
      derpState.regions.splice(idx, 1);
      renderDerpRegions();
      toast('Region removed (unsaved)');
    }

    function addDerpNode(regionIdx) {
      var nameEl = document.getElementById('derp-add-node-name-' + regionIdx);
      var hostEl = document.getElementById('derp-add-node-host-' + regionIdx);
      var stunEl = document.getElementById('derp-add-node-stun-' + regionIdx);
      var derpEl = document.getElementById('derp-add-node-derp-' + regionIdx);

      var name = nameEl.value.trim();
      var hostname = hostEl.value.trim();
      if (!name || !hostname) { toast('Node name and hostname are required'); return; }

      var node = { name: name, hostname: hostname };
      var stunPort = parseInt(stunEl.value);
      var derpPort = parseInt(derpEl.value);
      if (stunPort) node.stunPort = stunPort;
      if (derpPort) node.derpPort = derpPort;

      derpState.regions[regionIdx].nodes.push(node);
      renderDerpRegions();
      toast('Node added (unsaved)');
    }

    function removeDerpNode(regionIdx, nodeIdx) {
      derpState.regions[regionIdx].nodes.splice(nodeIdx, 1);
      renderDerpRegions();
      toast('Node removed (unsaved)');
    }

    async function saveDerp() {
      if (!state.currentTenant) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/derp', {
        method: 'PUT',
        body: JSON.stringify({
          regions: derpState.regions,
          embeddedDerpEnabled: derpState.embeddedDerpEnabled,
          usePublicDerp: derpState.usePublicDerp,
        }),
      });
      if (result) {
        toast('DERP configuration saved');
        loadDerp();
      }
    }

    // ── IP Config tab ─────────────────────────────────────────────

    async function loadIpConfig() {
      if (!state.currentTenant) return;
      var data = await api('/api/tenants/' + state.currentTenant.id + '/ip-config');
      if (!data) return;
      var v4El = document.getElementById('ipconfig-v4');
      var v6El = document.getElementById('ipconfig-v6');
      var allocEl = document.getElementById('ipconfig-alloc');
      if (v4El) v4El.value = data.ipv4Prefix || '';
      if (v6El) v6El.value = data.ipv6Prefix || '';
      if (allocEl) allocEl.value = data.ipAllocation || 'sequential';
    }

    async function saveIpConfig() {
      if (!state.currentTenant) return;
      var v4El = document.getElementById('ipconfig-v4');
      var v6El = document.getElementById('ipconfig-v6');
      var allocEl = document.getElementById('ipconfig-alloc');
      var ipv4Prefix = v4El ? v4El.value.trim() : '';
      var ipv6Prefix = v6El ? v6El.value.trim() : '';
      var ipAllocation = allocEl ? allocEl.value : 'sequential';
      if (!ipv4Prefix || !ipv6Prefix) { toast('Both IPv4 and IPv6 prefixes are required'); return; }
      var result = await api('/api/tenants/' + state.currentTenant.id + '/ip-config', {
        method: 'PUT',
        body: JSON.stringify({ ipv4Prefix: ipv4Prefix, ipv6Prefix: ipv6Prefix, ipAllocation: ipAllocation }),
      });
      if (result) {
        if (result.containerRestarted) {
          toast('IP configuration saved \\u2014 container restarted');
        } else {
          toast('IP configuration saved');
        }
      }
    }

    // ── Routes tab ─────────────────────────────────────────────────

    async function loadRoutes() {
      if (!state.currentTenant) return;
      var data = await api('/api/tenants/' + state.currentTenant.id + '/routes');
      if (!data) return;

      var exitEl = document.getElementById('routes-exit-nodes');
      if (exitEl) {
        var exits = data.exitNodes || [];
        if (exits.length === 0) {
          exitEl.innerHTML = '<div class="empty-state" style="padding:16px">No exit nodes advertised. Devices can advertise as exit nodes with <code style="color:var(--accent)">tailscale up --advertise-exit-node</code>.</div>';
        } else {
          exitEl.innerHTML = exits.map(function(r) {
            var online = r.node && r.node.online;
            var nodeName = r.node ? (r.node.givenName || r.node.name) : 'unknown';
            return '<div class="device-item">' +
              '<div style="display:flex;align-items:center;gap:8px">' +
                '<span class="online-dot ' + (online ? 'on' : 'off') + '"></span>' +
                '<span class="device-name">' + esc(nodeName) + '</span>' +
                '<span class="device-ip">' + esc(r.prefix) + '</span>' +
              '</div>' +
              '<div style="display:flex;align-items:center;gap:6px">' +
                '<button class="btn-sm ' + (r.enabled ? '' : 'btn-ghost') + '" style="' + (r.enabled ? 'background:var(--success)' : '') + '" onclick="toggleRoute(\\'' + r.id + '\\', ' + !!r.enabled + ')">' + (r.enabled ? 'Enabled' : 'Disabled') + '</button>' +
                '<button class="btn-sm btn-danger" onclick="deleteRoute(\\'' + r.id + '\\')">Delete</button>' +
              '</div>' +
            '</div>';
          }).join('');
        }
      }

      var subEl = document.getElementById('routes-subnets');
      if (subEl) {
        var subnets = data.subnets || [];
        if (subnets.length === 0) {
          subEl.innerHTML = '<div class="empty-state" style="padding:16px">No subnet routes advertised. Devices can advertise subnets with <code style="color:var(--accent)">tailscale up --advertise-routes=192.168.1.0/24</code>.</div>';
        } else {
          subEl.innerHTML = subnets.map(function(r) {
            var online = r.node && r.node.online;
            var nodeName = r.node ? (r.node.givenName || r.node.name) : 'unknown';
            return '<div class="device-item">' +
              '<div style="display:flex;align-items:center;gap:8px">' +
                '<span class="online-dot ' + (online ? 'on' : 'off') + '"></span>' +
                '<span class="device-name">' + esc(nodeName) + '</span>' +
                '<span class="device-ip">' + esc(r.prefix) + '</span>' +
              '</div>' +
              '<div style="display:flex;align-items:center;gap:6px">' +
                '<button class="btn-sm ' + (r.enabled ? '' : 'btn-ghost') + '" style="' + (r.enabled ? 'background:var(--success)' : '') + '" onclick="toggleRoute(\\'' + r.id + '\\', ' + !!r.enabled + ')">' + (r.enabled ? 'Enabled' : 'Disabled') + '</button>' +
                '<button class="btn-sm btn-danger" onclick="deleteRoute(\\'' + r.id + '\\')">Delete</button>' +
              '</div>' +
            '</div>';
          }).join('');
        }
      }
    }

    async function toggleRoute(routeId, currentlyEnabled) {
      if (!state.currentTenant) return;
      var action = currentlyEnabled ? 'disable' : 'enable';
      var result = await api('/api/tenants/' + state.currentTenant.id + '/routes/' + routeId + '/' + action, { method: 'POST' });
      if (result) {
        toast('Route ' + result.status);
        loadRoutes();
      }
    }

    async function deleteRoute(routeId) {
      if (!state.currentTenant) return;
      if (!confirm('Delete this route? The device will need to re-advertise it.')) return;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/routes/' + routeId, { method: 'DELETE' });
      if (result) {
        toast('Route deleted');
        loadRoutes();
      }
    }

    // ── Usage tab ──────────────────────────────────────────────────

    async function loadUsage() {
      if (!state.currentTenant) return;
      var data = await api('/api/tenants/' + state.currentTenant.id + '/usage');
      if (!data) return;

      var c = data.current || {};
      var p = data.plan || {};
      var l = data.limits || {};

      // Current Usage stats
      var el = document.getElementById('usage-current');
      if (el) {
        var devicesVal = String(c.deviceCount || 0);
        if (p.maxDevices > 0) devicesVal += ' / ' + p.maxDevices;
        var membersVal = String(c.memberCount || 0);
        if (p.maxMembers > 0) membersVal += ' / ' + p.maxMembers;
        el.innerHTML = '<div class="stat-row">' +
          '<div class="stat-card">' +
            '<div class="stat-label">Devices</div>' +
            '<div class="stat-value" style="' + (l.devicesExceeded ? 'color:var(--danger)' : '') + '">' + esc(devicesVal) + '</div>' +
          '</div>' +
          '<div class="stat-card">' +
            '<div class="stat-label">Online</div>' +
            '<div class="stat-value">' + (c.onlineDevices || 0) + '</div>' +
          '</div>' +
          '<div class="stat-card">' +
            '<div class="stat-label">Members</div>' +
            '<div class="stat-value" style="' + (l.membersExceeded ? 'color:var(--danger)' : '') + '">' + esc(membersVal) + '</div>' +
          '</div>' +
          '<div class="stat-card">' +
            '<div class="stat-label">Routes</div>' +
            '<div class="stat-value">' + (c.routeCount || 0) + '</div>' +
          '</div>' +
        '</div>';
      }

      // Plan management (manage_settings only)
      if (hasPerm('manage_settings')) {
        var planEl = document.getElementById('usage-plan');
        if (planEl) {
          var planName = p.name || 'free';
          var plans = ['free', 'starter', 'pro', 'enterprise'];
          planEl.innerHTML = '<div style="margin-bottom:12px">' +
            '<span class="badge badge-originator">' + esc(planName) + '</span>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;gap:12px">' +
            '<div>' +
              '<label style="font-size:13px;color:var(--text-dim);display:block;margin-bottom:4px">Plan</label>' +
              '<select id="plan-name">' +
                plans.map(function(pl) {
                  return '<option value="' + esc(pl) + '"' + (pl === planName ? ' selected' : '') + '>' + esc(pl) + '</option>';
                }).join('') +
              '</select>' +
            '</div>' +
            '<div>' +
              '<label style="font-size:13px;color:var(--text-dim);display:block;margin-bottom:4px">Max Devices (0 = unlimited)</label>' +
              '<input type="text" id="plan-max-devices" value="' + (p.maxDevices || 0) + '" />' +
            '</div>' +
            '<div>' +
              '<label style="font-size:13px;color:var(--text-dim);display:block;margin-bottom:4px">Max Members (0 = unlimited)</label>' +
              '<input type="text" id="plan-max-members" value="' + (p.maxMembers || 0) + '" />' +
            '</div>' +
            '<div>' +
              '<button onclick="savePlan()">Save Plan</button>' +
            '</div>' +
          '</div>';
        }
      }

      // Usage History table
      var histEl = document.getElementById('usage-history');
      if (histEl) {
        var history = (data.history || []).slice(0, 24);
        if (history.length === 0) {
          histEl.innerHTML = '<div class="empty-state" style="padding:16px">No usage history recorded yet</div>';
        } else {
          histEl.innerHTML = '<div style="overflow-x:auto">' +
            '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
              '<thead><tr style="border-bottom:1px solid var(--border)">' +
                '<th style="text-align:left;padding:8px 12px;color:var(--text-dim)">Time</th>' +
                '<th style="text-align:right;padding:8px 12px;color:var(--text-dim)">Devices</th>' +
                '<th style="text-align:right;padding:8px 12px;color:var(--text-dim)">Online</th>' +
                '<th style="text-align:right;padding:8px 12px;color:var(--text-dim)">Members</th>' +
                '<th style="text-align:right;padding:8px 12px;color:var(--text-dim)">Routes</th>' +
              '</tr></thead>' +
              '<tbody>' + history.map(function(h) {
                return '<tr style="border-bottom:1px solid var(--border)">' +
                  '<td style="padding:8px 12px;color:var(--text-dim)">' + new Date(h.recordedAt).toLocaleString() + '</td>' +
                  '<td style="text-align:right;padding:8px 12px">' + (h.deviceCount || 0) + '</td>' +
                  '<td style="text-align:right;padding:8px 12px">' + (h.onlineDevices || 0) + '</td>' +
                  '<td style="text-align:right;padding:8px 12px">' + (h.memberCount || 0) + '</td>' +
                  '<td style="text-align:right;padding:8px 12px">' + (h.routeCount || 0) + '</td>' +
                '</tr>';
              }).join('') + '</tbody>' +
            '</table>' +
          '</div>';
        }
      }
    }

    async function savePlan() {
      if (!state.currentTenant) return;
      var planNameEl = document.getElementById('plan-name');
      var maxDevicesEl = document.getElementById('plan-max-devices');
      var maxMembersEl = document.getElementById('plan-max-members');
      var result = await api('/api/tenants/' + state.currentTenant.id + '/plan', {
        method: 'PUT',
        body: JSON.stringify({
          planName: planNameEl ? planNameEl.value : undefined,
          maxDevices: maxDevicesEl ? parseInt(maxDevicesEl.value) || 0 : undefined,
          maxMembers: maxMembersEl ? parseInt(maxMembersEl.value) || 0 : undefined,
        }),
      });
      if (result) {
        toast('Plan updated');
        loadUsage();
      }
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
              '<div class="toggle-label"><span>Allow agent tokens</span><span>Enable API token generation for AI agents and automation</span></div>' +
              '<label class="toggle"><input type="checkbox" ' + (settings.allowAgentTokens ? 'checked' : '') +
                ' onchange="toggleSetting(\\'allowAgentTokens\\', this.checked)" /><span class="slider"></span></label>' +
            '</div>' +
            '<div class="toggle-row">' +
              '<div class="toggle-label"><span>Allow member agent tokens</span><span>Non-originator members can create their own agent tokens</span></div>' +
              '<label class="toggle"><input type="checkbox" ' + (settings.allowMemberAgentTokens ? 'checked' : '') +
                ' onchange="toggleSetting(\\'allowMemberAgentTokens\\', this.checked)" /><span class="slider"></span></label>' +
            '</div>' +
            '<div class="inline-form" style="margin-top:8px;margin-bottom:8px;align-items:center">' +
              '<label style="font-size:13px;color:var(--text-dim);white-space:nowrap">Auto-hibernate after</label>' +
              '<input type="number" id="hibernate-days-input" min="0" max="365" value="' + (settings.hibernateAfterDays || 0) + '" style="width:80px;padding:4px 8px;font-size:13px" />' +
              '<span style="font-size:13px;color:var(--text-dim)">days of inactivity (0 = never)</span>' +
              '<button class="btn-sm" onclick="saveHibernation()">Save</button>' +
            '</div>' +
            (settings.lastActivityAt ?
              '<div style="margin-bottom:8px;font-size:12px;color:var(--text-dim)">Last activity: ' + relativeTime(settings.lastActivityAt) + '</div>' : '') +
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
        agent_token_created: 'created agent token',
        agent_token_revoked: 'revoked agent token',
        tenant_deleted: 'deleted tenant',
        tenant_started: 'started tenant',
        tenant_stopped: 'stopped tenant',
        tenant_hibernated: 'tenant auto-hibernated',
        acl_updated: 'updated ACL policy',
        derp_updated: 'updated DERP relay config',
        ip_config_updated: 'updated IP prefix config',
        route_enabled: 'enabled route',
        route_disabled: 'disabled route',
        route_deleted: 'deleted route',
        plan_updated: 'updated plan/limits',
        federation_requested: 'requested federation',
        federation_accepted: 'accepted federation',
        federation_rejected: 'rejected federation',
        federation_revoked: 'revoked federation',
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
        agent_token_created: 'created agent token', agent_token_revoked: 'revoked agent token',
        tenant_deleted: 'deleted tenant', tenant_started: 'started tenant', tenant_stopped: 'stopped tenant',
        tenant_hibernated: 'tenant auto-hibernated',
        acl_updated: 'updated ACL policy',
        derp_updated: 'updated DERP relay config',
        ip_config_updated: 'updated IP prefix config',
        route_enabled: 'enabled route',
        route_disabled: 'disabled route',
        route_deleted: 'deleted route',
        plan_updated: 'updated plan/limits',
        federation_requested: 'requested federation',
        federation_accepted: 'accepted federation',
        federation_rejected: 'rejected federation',
        federation_revoked: 'revoked federation',
      };
      var html = data.entries.map(function(e) {
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
      }).join('');
      el.insertAdjacentHTML('beforeend', html);
    }

    function relativeTime(iso) {
      var diff = Date.now() - new Date(iso).getTime();
      var sec = Math.floor(diff / 1000);
      if (sec < 60) return 'just now';
      var min = Math.floor(sec / 60);
      if (min < 60) return min + 'm ago';
      var hr = Math.floor(min / 60);
      if (hr < 24) return hr + 'h ago';
      var days = Math.floor(hr / 24);
      if (days < 30) return days + 'd ago';
      var months = Math.floor(days / 30);
      if (months < 12) return months + 'mo ago';
      return Math.floor(months / 12) + 'y ago';
    }

    async function saveHibernation() {
      if (!state.currentTenant) return;
      var days = parseInt(document.getElementById('hibernate-days-input').value) || 0;
      if (days < 0) days = 0;
      if (days > 365) days = 365;
      var result = await api('/api/tenants/' + state.currentTenant.id + '/settings', {
        method: 'PATCH',
        body: JSON.stringify({ hibernateAfterDays: days }),
      });
      if (result) {
        state.settings = result;
        toast('Hibernation setting saved');
        loadSecurity();
      }
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

    // ── Sidebar toggle ────────────────────────────────────────────
    function toggleSidebar() {
      var sb = document.getElementById('sidebar');
      var ov = document.getElementById('sidebar-overlay');
      if (sb) sb.classList.toggle('open');
      if (ov) ov.classList.toggle('open');
    }

    // ── Stats ───────────────────────────────────────────────────
    async function loadStats() {
      if (!state.currentTenant) return;
      var tenantId = state.currentTenant.id;
      var devices = await api('/api/tenants/' + tenantId + '/devices');
      var members = await api('/api/tenants/' + tenantId + '/members');
      var health = await api('/api/tenants/' + tenantId + '/health');
      var totalDevices = 0;
      var onlineDevices = 0;
      if (devices && devices.byUser) {
        devices.byUser.forEach(function(group) {
          group.devices.forEach(function(d) {
            totalDevices++;
            if (d.online) onlineDevices++;
          });
        });
      }
      state.stats = {
        totalDevices: totalDevices,
        onlineDevices: onlineDevices,
        offlineDevices: totalDevices - onlineDevices,
        totalMembers: members ? members.length : 0,
        tenantStatus: state.currentTenant.status,
        healthy: health ? health.healthy : false,
      };
    }

    function renderStatsSummary() {
      if (!state.stats) return '';
      var s = state.stats;
      return '<div class="stat-row">' +
        '<div class="stat-card">' +
          '<div class="stat-label">Devices</div>' +
          '<div class="stat-value">' + s.totalDevices + '</div>' +
          '<div class="stat-detail">' + s.onlineDevices + ' online / ' + s.offlineDevices + ' offline</div>' +
        '</div>' +
        '<div class="stat-card">' +
          '<div class="stat-label">Members</div>' +
          '<div class="stat-value">' + s.totalMembers + '</div>' +
        '</div>' +
        '<div class="stat-card">' +
          '<div class="stat-label">Tenant</div>' +
          '<div class="stat-value"><span class="badge badge-' + s.tenantStatus + '">' + s.tenantStatus + '</span></div>' +
        '</div>' +
        '<div class="stat-card">' +
          '<div class="stat-label">Health</div>' +
          '<div class="stat-value"><span class="health-dot ' + (s.healthy ? 'healthy' : 'unhealthy') + '"></span>' + (s.healthy ? 'Healthy' : 'Unhealthy') + '</div>' +
        '</div>' +
      '</div>';
    }

    // ── Network Status tab ──────────────────────────────────────
    async function loadStatus() {
      if (!state.currentTenant) return;
      var tenantId = state.currentTenant.id;
      var health = await api('/api/tenants/' + tenantId + '/health');
      var devices = await api('/api/tenants/' + tenantId + '/devices');
      var el = document.getElementById('status-content');
      if (!el) return;

      var healthHtml = '<div style="margin-bottom:16px">' +
        '<h4 style="margin-bottom:8px">Instance Health</h4>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<span class="health-dot ' + (health && health.healthy ? 'healthy' : 'unhealthy') + '"></span>' +
          '<span style="font-size:16px;font-weight:500">' + (health && health.healthy ? 'Instance healthy' : 'Instance unhealthy') + '</span>' +
          '<span class="badge badge-' + state.currentTenant.status + '" style="margin-left:8px">' + state.currentTenant.status + '</span>' +
        '</div>' +
      '</div>';

      var totalDevices = 0;
      var onlineCount = 0;
      if (devices && devices.byUser) {
        devices.byUser.forEach(function(group) {
          group.devices.forEach(function(d) {
            totalDevices++;
            if (d.online) onlineCount++;
          });
        });
      }

      var summaryHtml = '<div style="margin-bottom:16px">' +
        '<h4 style="margin-bottom:8px">Device Summary</h4>' +
        '<div style="display:flex;gap:16px;color:var(--text-dim);font-size:14px">' +
          '<span>Total: <strong style="color:var(--text)">' + totalDevices + '</strong></span>' +
          '<span>Online: <strong style="color:var(--success)">' + onlineCount + '</strong></span>' +
          '<span>Offline: <strong style="color:var(--text-dim)">' + (totalDevices - onlineCount) + '</strong></span>' +
        '</div>' +
      '</div>';

      el.innerHTML = healthHtml + summaryHtml +
        '<h4 style="margin-bottom:8px">Devices</h4>' +
        renderDevices(devices);
    }

    // ── Setup Wizard ────────────────────────────────────────────
    function renderWizard(t) {
      var steps = '<div class="wizard-steps">' +
        '<div class="wizard-step-dot' + (state.wizardStep >= 1 ? ' active' : '') + '"></div>' +
        '<div class="wizard-step-dot' + (state.wizardStep >= 2 ? ' active' : '') + '"></div>' +
        '<div class="wizard-step-dot' + (state.wizardStep >= 3 ? ' active' : '') + '"></div>' +
      '</div>';

      var content = '';
      if (state.wizardStep === 1) {
        content = '<h2>Your tailnet is ready!</h2>' +
          '<p>Your private mesh network has been created and is running.</p>' +
          '<div style="margin-bottom:16px">' +
            '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">' +
              '<span style="color:var(--text-dim)">Name</span><strong>' + esc(t.name) + '</strong></div>' +
            '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">' +
              '<span style="color:var(--text-dim)">Status</span><span class="badge badge-' + t.status + '">' + t.status + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;padding:8px 0">' +
              '<span style="color:var(--text-dim)">Slug</span><span style="font-family:monospace;font-size:13px">' + esc(t.slug) + '</span></div>' +
          '</div>' +
          '<div class="wizard-nav"><div></div><button onclick="state.wizardStep=2;render()">Next</button></div>';
      } else if (state.wizardStep === 2) {
        content = '<h2>Connect your first device</h2>' +
          '<p>Generate a one-time auth key to connect a device to your tailnet.</p>' +
          '<button onclick="generateAuthKey()">Generate Auth Key</button>' +
          '<div id="auth-key-output" style="margin-top:16px"></div>' +
          '<div class="wizard-nav">' +
            '<button class="btn-ghost" onclick="state.wizardStep=1;render()">Back</button>' +
            '<button onclick="state.wizardStep=3;render()">Next</button>' +
          '</div>';
      } else {
        content = '<h2>Invite someone</h2>' +
          '<p>Invite a friend or colleague by their Bluesky handle.</p>' +
          (hasPerm('invite') ?
            '<div class="inline-form" style="margin-bottom:16px">' +
              '<input type="text" id="invite-handle" placeholder="friend.bsky.social" />' +
              '<button onclick="sendInvitation()">Send Invite</button>' +
            '</div>' +
            '<div id="sent-invitations"></div>' :
            '<p style="font-size:13px">You do not have invite permissions yet.</p>') +
          '<div class="wizard-nav">' +
            '<button class="btn-ghost" onclick="state.wizardStep=2;render()">Back</button>' +
            '<div style="display:flex;gap:8px">' +
              '<button class="btn-ghost" onclick="state.showWizard=false;state.wizardDismissed=true;render()">Skip</button>' +
              '<button onclick="state.showWizard=false;state.wizardDismissed=true;render()">Finish</button>' +
            '</div>' +
          '</div>';
      }

      return '<div class="wizard-overlay">' +
        '<div style="position:absolute;top:16px;right:24px">' +
          '<form action="/auth/logout" method="post" style="display:inline"><button class="btn-sm btn-ghost">Sign out</button></form>' +
        '</div>' +
        '<div class="wizard-card">' +
          steps +
          content +
        '</div>' +
      '</div>';
    }

    function render() {
      if (!state.user) {
        app.innerHTML = renderLogin();
      } else {
        app.innerHTML = renderDashboard();
        if (!state.showWizard) {
          if (state.tab === 'status') loadStatus();
          if (state.tab === 'devices') loadDevices();
          if (state.tab === 'members') loadMembers();
          if (state.tab === 'invite') loadSentInvitations();
          if (state.tab === 'services') loadServices();
          if (state.tab === 'board') loadBoard();
          if (state.tab === 'federation') loadFederation();
          if (state.tab === 'agents') loadAgents();
          if (state.tab === 'acl') loadAcl();
          if (state.tab === 'derp') loadDerp();
          if (state.tab === 'ipconfig') loadIpConfig();
          if (state.tab === 'routes') loadRoutes();
          if (state.tab === 'roles') loadRoles();
          if (state.tab === 'usage') loadUsage();
          if (state.tab === 'security') loadSecurity();
          if (state.tab === 'audit') loadAuditLog();
        }
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
  <meta name="csrf-token" content="" />
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

    function getCsrfToken() {
      var meta = document.querySelector('meta[name="csrf-token"]');
      return meta ? meta.getAttribute('content') : '';
    }

    async function api(path, opts) {
      try {
        var headers = { 'Content-Type': 'application/json' };
        var csrfToken = getCsrfToken();
        if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
        var res = await fetch(path, {
          headers: headers,
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

      // Fetch CSRF token for state-changing requests
      var csrf = await api('/api/csrf-token');
      if (csrf && csrf.token) {
        var csrfMeta = document.querySelector('meta[name="csrf-token"]');
        if (csrfMeta) csrfMeta.setAttribute('content', csrf.token);
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
