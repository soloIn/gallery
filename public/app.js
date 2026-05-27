// ============================================================
// 115 Gallery — Admin Panel
// ============================================================

// --- State ---
let state = {
  authenticated: false,
};

const app = document.getElementById("app");

// --- Init ---
window.addEventListener("DOMContentLoaded", () => renderAdmin());

// --- API helpers ---
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  return { status: res.status, data: await res.json() };
}

// --- Toast System ---
function toast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.innerHTML = `
    <span>${escapeHtml(message)}</span>
    <div class="toast-progress"></div>
  `;
  container.appendChild(el);

  const remove = () => {
    el.classList.add("toast-exit");
    el.addEventListener("animationend", () => el.remove());
  };

  el.addEventListener("click", remove);
  setTimeout(remove, 3000);
}

// --- Skeleton helpers ---
function skeletonLine(width = "100%") {
  return `<div class="skeleton skeleton-line" style="width:${width}">&nbsp;</div>`;
}

function skeletonBlock(height = "40px") {
  return `<div class="skeleton skeleton-block" style="height:${height}">&nbsp;</div>`;
}

// --- Button loading helpers ---
function setBtnLoading(btn, loading) {
  if (!btn) return;
  if (loading) {
    btn.classList.add("btn-loading");
    btn.disabled = true;
  } else {
    btn.classList.remove("btn-loading");
    btn.disabled = false;
  }
}

// --- Copy to clipboard ---
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard", "success");
  } catch {
    toast("Failed to copy", "error");
  }
}

// --- Card icon map ---
const CARD_ICONS = {
  connection: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1v14M1 8h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  config: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  token: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="5" width="12" height="7" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M5 5V3.5a3 3 0 016 0V5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  folder: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4.5A1.5 1.5 0 013.5 3h3.086a1.5 1.5 0 011.06.44L9.06 4.853a.5.5 0 00.354.147H12.5A1.5 1.5 0 0114 6.5v5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" stroke="currentColor" stroke-width="1.5"/></svg>`,
  sync: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2.5 8a5.5 5.5 0 019.44-3.89M13.5 8a5.5 5.5 0 01-9.44 3.89" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M12 1v3.5H8.5M4 15v-3.5h3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  settings: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2.5" width="13" height="3" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="1.5" y="10.5" width="13" height="3" rx="1" stroke="currentColor" stroke-width="1.5"/><circle cx="5" cy="4" r="1" fill="currentColor"/><circle cx="11" cy="12" r="1" fill="currentColor"/></svg>`,
};

function cardIcon(type, color) {
  return `<div class="card-icon" style="background:${color}15;color:${color}">${CARD_ICONS[type] || ""}</div>`;
}

// ============================================================
// Admin View
// ============================================================
async function renderAdmin(query) {
  const { status } = await api("/admin/me");
  state.authenticated = status === 200;

  if (!state.authenticated) {
    renderLogin(query);
    return;
  }

  const params = new URLSearchParams(query || "");
  const successMsg = params.get("connected") ? "115 account connected!" : null;
  const errorMsg = params.get("error");

  if (successMsg) toast(successMsg, "success");
  if (errorMsg) toast(errorMsg, "error");

  app.innerHTML = `
    <div class="card">
      <div class="card-header">
        ${cardIcon("connection", "var(--success)")}
        <h2>115 Connection</h2>
      </div>
      <div class="card-body">
        <div id="connection-status">${skeletonLine("140px")}</div>
        <button id="connect-btn" class="btn-primary mt-md">Connect 115 Account</button>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        ${cardIcon("config", "var(--info)")}
        <h2>115 Configuration</h2>
      </div>
      <div class="card-body">
        <div id="eleven5-config">
          ${skeletonBlock()}
          <div class="mt-md">${skeletonBlock()}</div>
          <div class="mt-md">${skeletonLine("120px")}</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        ${cardIcon("token", "var(--accent)")}
        <h2>API Tokens</h2>
      </div>
      <div class="card-body">
        <div class="form-row mb-md">
          <button id="gen-token-btn" class="btn-primary">Generate Token</button>
        </div>
        <div id="tokens-list">
          ${skeletonLine("180px")}
          <div class="mt-md">${skeletonBlock()}</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        ${cardIcon("folder", "var(--accent)")}
        <h2>Gallery Directories</h2>
      </div>
      <div class="card-body">
        <div class="form-row mb-md">
          <div class="form-group" style="flex:1;margin-bottom:0">
            <input type="text" id="dir-id" placeholder="115 Directory ID">
          </div>
          <div class="form-group" style="margin-bottom:0">
            <input type="text" id="dir-name" placeholder="Name (optional)">
          </div>
          <button id="add-dir-btn" class="btn-primary">Add</button>
        </div>
        <div id="directories-list">
          ${skeletonLine("100%")}
          <div class="mt-sm">${skeletonLine("100%")}</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        ${cardIcon("sync", "var(--info)")}
        <h2>Sync</h2>
      </div>
      <div class="card-body">
        <button id="sync-btn" class="btn-primary">Sync Now</button>
        <div id="sync-status" class="mt-md"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        ${cardIcon("settings", "var(--text-secondary)")}
        <h2>Settings</h2>
      </div>
      <div class="card-body">
        <div id="settings-form" class="settings-grid">
          ${skeletonBlock()}
          <div>${skeletonBlock()}</div>
          <div>${skeletonLine("120px")}</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-body" style="display:flex;justify-content:flex-end">
        <button id="logout-btn" class="btn-ghost">Logout</button>
      </div>
    </div>
  `;

  // Load data in parallel
  loadConnectionStatus();
  loadTokens();
  loadDirectories();
  const { data: settingsData } = await api("/admin/settings");
  loadEleven5Config(settingsData);
  loadSettings(settingsData);

  // Bind events
  document.getElementById("connect-btn").addEventListener("click", () => {
    window.location.href = "/auth/115/login";
  });
  document.getElementById("gen-token-btn").addEventListener("click", generateToken);
  document.getElementById("add-dir-btn").addEventListener("click", addDirectory);
  document.getElementById("sync-btn").addEventListener("click", triggerSync);
  document.getElementById("logout-btn").addEventListener("click", logout);
}

// ============================================================
// Login View
// ============================================================
function renderLogin(query) {
  const params = new URLSearchParams(query || "");
  const errorMsg = params.get("error");

  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card card">
        <div class="login-brand">
          <div class="login-brand-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1.5" fill="white"/><rect x="14" y="3" width="7" height="7" rx="1.5" fill="white" opacity="0.6"/><rect x="3" y="14" width="7" height="7" rx="1.5" fill="white" opacity="0.6"/><rect x="14" y="14" width="7" height="7" rx="1.5" fill="white" opacity="0.3"/></svg>
          </div>
          <h1>115 GALLERY</h1>
          <p>Admin Console</p>
        </div>
        ${errorMsg ? `<div class="alert alert-error">${escapeHtml(errorMsg)}</div>` : ""}
        <form id="login-form">
          <div class="form-group">
            <label>Username</label>
            <input type="text" id="username" value="admin" autocomplete="username">
          </div>
          <div class="form-group">
            <label>Password</label>
            <input type="password" id="password" autocomplete="current-password">
          </div>
          <div id="login-error" class="alert alert-error" style="display:none"></div>
          <button type="submit" class="btn-primary" style="width:100%">Sign In</button>
        </form>
      </div>
    </div>
  `;

  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const username = document.getElementById("username").value;
    const password = document.getElementById("password").value;

    setBtnLoading(btn, true);

    const { status, data } = await api("/admin/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });

    setBtnLoading(btn, false);

    if (status === 200) {
      state.authenticated = true;
      renderAdmin();
    } else {
      const errEl = document.getElementById("login-error");
      errEl.style.display = "flex";
      errEl.textContent = data.error || "Login failed";
    }
  });
}

// ============================================================
// Data Loaders
// ============================================================
async function loadConnectionStatus() {
  const el = document.getElementById("connection-status");
  if (!el) return;

  const { data } = await api("/auth/115/status");
  const connected = data.connected;
  el.innerHTML = `
    <div class="status">
      <span class="status-dot ${connected ? "connected" : "disconnected"}"></span>
      ${connected ? "Connected" : "Not connected"}
    </div>
  `;
}

async function loadEleven5Config(data) {
  const el = document.getElementById("eleven5-config");
  if (!el) return;

  const hasSecret = data.eleven5_client_secret;
  el.innerHTML = `
    <div class="form-group">
      <label>Client ID</label>
      <input type="text" id="e5-client-id" value="${escapeHtml(data.eleven5_client_id || "")}" placeholder="115 OAuth Client ID">
    </div>
    <div class="form-group">
      <label>Client Secret</label>
      <input type="password" id="e5-client-secret" value="" placeholder="${hasSecret ? "••••••••" : "115 OAuth Client Secret"}">
    </div>
    <button id="save-e5-btn" class="btn-primary">Save 115 Config</button>
    <div id="e5-status" class="mt-sm"></div>
  `;

  document.getElementById("save-e5-btn").addEventListener("click", async () => {
    const btn = document.getElementById("save-e5-btn");
    const clientId = document.getElementById("e5-client-id").value.trim();
    const clientSecret = document.getElementById("e5-client-secret").value;
    const body = {};
    if (clientId) body.eleven5_client_id = clientId;
    if (clientSecret) body.eleven5_client_secret = clientSecret;

    setBtnLoading(btn, true);
    const { status } = await api("/admin/settings", { method: "PUT", body: JSON.stringify(body) });
    setBtnLoading(btn, false);

    if (status === 200) {
      toast("115 configuration saved", "success");
    } else {
      toast("Failed to save configuration", "error");
    }
  });
}

async function loadTokens() {
  const el = document.getElementById("tokens-list");
  if (!el) return;

  const { data } = await api("/admin/tokens");
  const count = data.count ?? 0;
  el.innerHTML = `
    <div style="color:var(--text-secondary);font-size:0.875rem;margin-bottom:var(--space-md)">${count} active token${count !== 1 ? "s" : ""}</div>
    <div class="form-row" style="margin-bottom:0">
      <div class="form-group" style="flex:1;margin-bottom:0">
        <input type="text" id="revoke-token-input" placeholder="Paste token to revoke">
      </div>
      <button id="revoke-token-btn" class="btn-danger btn-sm">Revoke</button>
    </div>
    <div id="token-status" class="mt-sm"></div>
  `;

  document.getElementById("revoke-token-btn").addEventListener("click", revokeToken);
}

async function generateToken() {
  const btn = document.getElementById("gen-token-btn");
  setBtnLoading(btn, true);

  const { status, data } = await api("/admin/tokens", { method: "POST" });

  setBtnLoading(btn, false);

  if (status === 200) {
    await loadTokens();
    const statusEl = document.getElementById("token-status");
    if (statusEl) {
      const token = escapeHtml(data.token);
      statusEl.innerHTML = `
        <div class="alert alert-success">
          Token created — copy it now, it won't be shown again:
        </div>
        <div class="token-display mt-sm">
          ${token}
          <button class="token-copy-btn" onclick="copyText('${token.replace(/'/g, "\\'")}')">Copy</button>
        </div>
      `;
    }
    toast("Token generated successfully", "success");
  }
}

async function revokeToken() {
  const input = document.getElementById("revoke-token-input");
  const token = input?.value?.trim();
  if (!token) return;

  const btn = document.getElementById("revoke-token-btn");
  setBtnLoading(btn, true);

  const { status } = await api("/admin/tokens", {
    method: "DELETE",
    body: JSON.stringify({ token }),
  });

  setBtnLoading(btn, false);

  if (status === 200) {
    toast("Token revoked", "success");
    input.value = "";
    loadTokens();
  } else {
    toast("Token not found", "error");
  }
}

async function loadDirectories() {
  const el = document.getElementById("directories-list");
  if (!el) return;

  const { data } = await api("/admin/directories");
  if (!data.length) {
    el.innerHTML = '<div class="empty">No directories configured</div>';
    return;
  }

  el.innerHTML = data.map((dir) => `
    <div class="list-item">
      <div>
        <strong>${escapeHtml(dir.name || dir.dir_id)}</strong>
        <div style="color:var(--text-muted);font-size:0.8rem;font-family:var(--font-display)">ID: ${escapeHtml(dir.dir_id)}</div>
      </div>
      <button class="btn-danger btn-sm" data-dir-id="${escapeHtml(dir.dir_id)}">Remove</button>
    </div>
  `).join("");

  el.querySelectorAll("button[data-dir-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const dirId = btn.dataset.dirId;
      setBtnLoading(btn, true);
      await api(`/admin/directories/${dirId}`, { method: "DELETE" });
      toast("Directory removed", "success");
      loadDirectories();
    });
  });
}

async function addDirectory() {
  const dirId = document.getElementById("dir-id").value.trim();
  const name = document.getElementById("dir-name").value.trim();
  if (!dirId) return;

  const btn = document.getElementById("add-dir-btn");
  setBtnLoading(btn, true);

  await api("/admin/directories", {
    method: "POST",
    body: JSON.stringify({ dir_id: dirId, name }),
  });

  setBtnLoading(btn, false);
  document.getElementById("dir-id").value = "";
  document.getElementById("dir-name").value = "";
  toast("Directory added", "success");
  loadDirectories();
}

async function triggerSync() {
  const btn = document.getElementById("sync-btn");
  const statusEl = document.getElementById("sync-status");

  setBtnLoading(btn, true);
  statusEl.innerHTML = '<div class="alert alert-info">Syncing...</div>';

  const { data } = await api("/admin/sync", { method: "POST" });

  setBtnLoading(btn, false);
  statusEl.innerHTML = "";
  toast(data.message || "Sync completed", "success");
}

async function loadSettings(data) {
  const el = document.getElementById("settings-form");
  if (!el) return;

  el.innerHTML = `
    <div class="form-group">
      <label>Sync Interval (cron)</label>
      <input type="text" id="sync-interval" value="${escapeHtml(data.sync_interval)}">
    </div>
    <div class="form-group">
      <label>Rate Limit (req/s)</label>
      <input type="number" id="rate-limit" value="${data.rate_limit_rps}" min="1" max="10">
    </div>
    <button id="save-settings" class="btn-primary">Save Settings</button>
  `;

  document.getElementById("save-settings").addEventListener("click", async () => {
    const btn = document.getElementById("save-settings");
    setBtnLoading(btn, true);

    await api("/admin/settings", {
      method: "PUT",
      body: JSON.stringify({
        sync_interval: document.getElementById("sync-interval").value,
        rate_limit_rps: parseInt(document.getElementById("rate-limit").value),
      }),
    });

    setBtnLoading(btn, false);
    toast("Settings saved", "success");
  });
}

async function logout() {
  await api("/admin/logout", { method: "POST" });
  state.authenticated = false;
  renderLogin();
}

// --- Utils ---
function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}
