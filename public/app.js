// State
let state = {
  authenticated: false,
  mode: "next", // "next" | "random"
  clientId: localStorage.getItem("gallery_client_id") || "",
  autoAdvance: false,
  autoInterval: null,
  currentImage: null,
};

const app = document.getElementById("app");

// Router
function router() {
  const hash = window.location.hash || "#/gallery";
  const [path, query] = hash.slice(1).split("?");

  if (path.startsWith("/admin")) {
    renderAdmin(query);
  } else {
    renderGallery();
  }

  // Update nav active state
  document.querySelectorAll("nav a").forEach((a) => {
    a.classList.toggle("active", a.getAttribute("href") === "#" + path);
  });
}

window.addEventListener("hashchange", router);
window.addEventListener("DOMContentLoaded", router);

// API helpers
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  return { status: res.status, data: await res.json() };
}

// --- Gallery View ---
async function renderGallery() {
  app.innerHTML = `
    <div class="gallery-controls">
      <div class="form-group" style="margin-bottom:0">
        <input type="text" id="clientId" placeholder="Client ID" value="${escapeHtml(state.clientId)}">
      </div>
      <div class="toggle-group">
        <button id="mode-next" class="${state.mode === "next" ? "active" : ""}">Next</button>
        <button id="mode-random" class="${state.mode === "random" ? "active" : ""}">Random</button>
      </div>
      <button id="fetch-btn" class="btn-primary">Get Image</button>
      <button id="auto-btn" class="btn-secondary">${state.autoAdvance ? "Stop Auto" : "Auto Advance"}</button>
    </div>
    <div id="image-area" class="loading">Enter a Client ID and click Get Image</div>
    <div id="image-info" class="image-info" style="display:none"></div>
  `;

  document.getElementById("clientId").addEventListener("input", (e) => {
    state.clientId = e.target.value;
    localStorage.setItem("gallery_client_id", state.clientId);
  });

  document.getElementById("mode-next").addEventListener("click", () => {
    state.mode = "next";
    updateModeButtons();
  });

  document.getElementById("mode-random").addEventListener("click", () => {
    state.mode = "random";
    updateModeButtons();
  });

  document.getElementById("fetch-btn").addEventListener("click", fetchImage);
  document.getElementById("auto-btn").addEventListener("click", toggleAutoAdvance);

  // Auto-fetch if client ID exists
  if (state.clientId) {
    fetchImage();
  }
}

function updateModeButtons() {
  const nextBtn = document.getElementById("mode-next");
  const randomBtn = document.getElementById("mode-random");
  if (nextBtn) nextBtn.classList.toggle("active", state.mode === "next");
  if (randomBtn) randomBtn.classList.toggle("active", state.mode === "random");
}

async function fetchImage() {
  if (!state.clientId) {
    showImageArea("alert alert-error", "Please enter a Client ID");
    return;
  }

  showImageArea("loading", "Loading...");

  const endpoint = state.mode === "next" ? "/api/image/next" : "/api/image/random";
  const { status, data } = await api(`${endpoint}?client=${encodeURIComponent(state.clientId)}`);

  if (status !== 200) {
    showImageArea("alert alert-error", data.error || "Failed to fetch image");
    document.getElementById("image-info").style.display = "none";
    return;
  }

  state.currentImage = data;
  showImageArea("", `<img src="${escapeHtml(data.url)}" alt="${escapeHtml(data.name)}">`);

  const info = document.getElementById("image-info");
  info.style.display = "flex";
  info.innerHTML = `
    <span>${escapeHtml(data.name)}</span>
    <span>${data.index !== undefined ? `${data.index + 1} / ${data.total}` : `${data.remaining} remaining / ${data.total} total`}</span>
  `;
}

function showImageArea(className, content) {
  const area = document.getElementById("image-area");
  area.className = className;
  area.innerHTML = content;
}

function toggleAutoAdvance() {
  state.autoAdvance = !state.autoAdvance;
  const btn = document.getElementById("auto-btn");
  btn.textContent = state.autoAdvance ? "Stop Auto" : "Auto Advance";

  if (state.autoAdvance) {
    state.autoInterval = setInterval(fetchImage, 5000);
    fetchImage();
  } else {
    clearInterval(state.autoInterval);
    state.autoInterval = null;
  }
}

// --- Admin View ---
async function renderAdmin(query) {
  // Check auth status
  const { status } = await api("/admin/me");
  state.authenticated = status === 200;

  if (!state.authenticated) {
    renderLogin(query);
    return;
  }

  // Parse query params for messages
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
  loadDirectories();
  loadSettings();

  document.getElementById("connect-btn").addEventListener("click", () => {
    window.location.href = "/auth/115/login";
  });

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
