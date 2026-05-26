// State
let state = {
  authenticated: false,
};

const app = document.getElementById("app");

// Init
window.addEventListener("DOMContentLoaded", renderAdmin);

// API helpers
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  return { status: res.status, data: await res.json() };
}

// --- Admin View ---
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

  app.innerHTML = `
    ${successMsg ? `<div class="alert alert-success">${escapeHtml(successMsg)}</div>` : ""}
    ${errorMsg ? `<div class="alert alert-error">${escapeHtml(errorMsg)}</div>` : ""}
    <div class="card">
      <h2>115 Connection</h2>
      <div id="connection-status" class="loading">Checking...</div>
      <button id="connect-btn" class="btn-primary" style="margin-top:1rem">Connect 115 Account</button>
    </div>
    <div class="card">
      <h2>115 Configuration</h2>
      <div id="eleven5-config">Loading...</div>
    </div>
    <div class="card">
      <h2>API Tokens</h2>
      <div class="form-row" style="margin-bottom:1rem">
        <button id="gen-token-btn" class="btn-primary">Generate Token</button>
      </div>
      <div id="tokens-list">Loading...</div>
    </div>
    <div class="card">
      <h2>Gallery Directories</h2>
      <div class="form-row" style="margin-bottom:1rem">
        <div class="form-group" style="flex:1">
          <input type="text" id="dir-id" placeholder="115 Directory ID">
        </div>
        <div class="form-group" style="margin-bottom:0">
          <input type="text" id="dir-name" placeholder="Name (optional)">
        </div>
        <button id="add-dir-btn" class="btn-primary">Add</button>
      </div>
      <div id="directories-list">Loading...</div>
    </div>
    <div class="card">
      <h2>Sync</h2>
      <button id="sync-btn" class="btn-primary">Sync Now</button>
      <div id="sync-status" style="margin-top:1rem"></div>
    </div>
    <div class="card">
      <h2>Settings</h2>
      <div id="settings-form" class="settings-grid">Loading...</div>
    </div>
    <div class="card">
      <button id="logout-btn" class="btn-danger">Logout</button>
    </div>
  `;

  loadConnectionStatus();
  loadEleven5Config();
  loadTokens();
  loadDirectories();
  loadSettings();

  document.getElementById("connect-btn").addEventListener("click", () => {
    window.location.href = "/auth/115/login";
  });
  document.getElementById("gen-token-btn").addEventListener("click", generateToken);
  document.getElementById("add-dir-btn").addEventListener("click", addDirectory);
  document.getElementById("sync-btn").addEventListener("click", triggerSync);
  document.getElementById("logout-btn").addEventListener("click", logout);
}

function renderLogin(query) {
  const params = new URLSearchParams(query || "");
  const errorMsg = params.get("error");

  app.innerHTML = `
    <div class="card" style="max-width:400px;margin:2rem auto">
      <h2>Admin Login</h2>
      ${errorMsg ? `<div class="alert alert-error">${escapeHtml(errorMsg)}</div>` : ""}
      <form id="login-form">
        <div class="form-group">
          <label>Username</label>
          <input type="text" id="username" value="admin">
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" id="password">
        </div>
        <div id="login-error" class="alert alert-error" style="display:none"></div>
        <button type="submit" class="btn-primary" style="width:100%">Login</button>
      </form>
    </div>
  `;

  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("username").value;
    const password = document.getElementById("password").value;

    const { status, data } = await api("/admin/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });

    if (status === 200) {
      state.authenticated = true;
      renderAdmin();
    } else {
      const errEl = document.getElementById("login-error");
      errEl.style.display = "block";
      errEl.textContent = data.error || "Login failed";
    }
  });
}

async function loadConnectionStatus() {
  const el = document.getElementById("connection-status");
  if (!el) return;

  const { data } = await api("/auth/115/status");
  el.innerHTML = `
    <div class="status">
      <span class="status-dot ${data.connected ? "connected" : "disconnected"}"></span>
      ${data.connected ? "Connected" : "Not connected"}
    </div>
  `;
}

async function loadEleven5Config() {
  const el = document.getElementById("eleven5-config");
  if (!el) return;

  const { data } = await api("/admin/settings");
  el.innerHTML = `
    <div class="form-group">
      <label>Client ID</label>
      <input type="text" id="e5-client-id" value="${escapeHtml(data.eleven5_client_id || "")}" placeholder="115 OAuth Client ID">
    </div>
    <div class="form-group">
      <label>Client Secret</label>
      <input type="password" id="e5-client-secret" value="" placeholder="${data.eleven5_client_secret ? "****" : "115 OAuth Client Secret"}">
    </div>
    <button id="save-e5-btn" class="btn-primary">Save 115 Config</button>
    <div id="e5-status" style="margin-top:0.5rem"></div>
  `;

  document.getElementById("save-e5-btn").addEventListener("click", async () => {
    const clientId = document.getElementById("e5-client-id").value.trim();
    const clientSecret = document.getElementById("e5-client-secret").value;
    const body = {};
    if (clientId) body.eleven5_client_id = clientId;
    if (clientSecret) body.eleven5_client_secret = clientSecret;

    const { status } = await api("/admin/settings", { method: "PUT", body: JSON.stringify(body) });
    const statusEl = document.getElementById("e5-status");
    statusEl.innerHTML = status === 200
      ? '<span class="alert alert-success" style="display:inline-block;padding:0.25rem 0.5rem">Saved</span>'
      : '<span class="alert alert-error" style="display:inline-block;padding:0.25rem 0.5rem">Failed</span>';
    setTimeout(() => { if (statusEl) statusEl.innerHTML = ""; }, 2000);
  });
}

async function loadTokens() {
  const el = document.getElementById("tokens-list");
  if (!el) return;

  const { data } = await api("/admin/tokens");
  if (!data.tokens.length) {
    el.innerHTML = '<div class="empty">No API tokens</div>';
    return;
  }

  el.innerHTML = data.tokens.map((token) => `
    <div class="list-item">
      <code style="font-size:0.85rem">${escapeHtml(token)}</code>
      <button class="btn-danger btn-sm" data-token="${escapeHtml(token)}">Delete</button>
    </div>
  `).join("");

  el.querySelectorAll("button[data-token]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api(`/admin/tokens/${encodeURIComponent(btn.dataset.token)}`, { method: "DELETE" });
      loadTokens();
    });
  });
}

async function generateToken() {
  const { status, data } = await api("/admin/tokens", { method: "POST" });
  if (status === 200) {
    loadTokens();
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
        <div style="color:var(--text-muted);font-size:0.85rem">ID: ${escapeHtml(dir.dir_id)}</div>
      </div>
      <button class="btn-danger btn-sm" data-dir-id="${escapeHtml(dir.dir_id)}">Remove</button>
    </div>
  `).join("");

  el.querySelectorAll("button[data-dir-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const dirId = btn.dataset.dirId;
      await api(`/admin/directories/${dirId}`, { method: "DELETE" });
      loadDirectories();
    });
  });
}

async function addDirectory() {
  const dirId = document.getElementById("dir-id").value.trim();
  const name = document.getElementById("dir-name").value.trim();

  if (!dirId) return;

  await api("/admin/directories", {
    method: "POST",
    body: JSON.stringify({ dir_id: dirId, name }),
  });

  document.getElementById("dir-id").value = "";
  document.getElementById("dir-name").value = "";
  loadDirectories();
}

async function triggerSync() {
  const statusEl = document.getElementById("sync-status");
  statusEl.innerHTML = '<div class="alert alert-info">Syncing...</div>';

  const { data } = await api("/admin/sync", { method: "POST" });
  statusEl.innerHTML = `<div class="alert alert-success">${escapeHtml(data.message)}</div>`;

  setTimeout(() => {
    if (statusEl) statusEl.innerHTML = "";
  }, 3000);
}

async function loadSettings() {
  const el = document.getElementById("settings-form");
  if (!el) return;

  const { data } = await api("/admin/settings");
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
    await api("/admin/settings", {
      method: "PUT",
      body: JSON.stringify({
        sync_interval: document.getElementById("sync-interval").value,
        rate_limit_rps: parseInt(document.getElementById("rate-limit").value),
      }),
    });
  });
}

async function logout() {
  await api("/admin/logout", { method: "POST" });
  state.authenticated = false;
  renderLogin();
}

// Utils
function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}
