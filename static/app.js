const API_BASE = ""; // same origin on Render

let accountId = localStorage.getItem("accountId");
if (accountId) showDashboard();

async function connectAccount() {
  const login = document.getElementById("login").value;
  const password = document.getElementById("password").value;
  const server = document.getElementById("server").value;
  const platform = document.getElementById("platform").value;

  document.getElementById("login-status").innerText = "Connecting... (can take 30-60s first time)";

  try {
    const res = await fetch(`${API_BASE}/api/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, password, server, platform }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    accountId = data.accountId;
    localStorage.setItem("accountId", accountId);
    showDashboard();
  } catch (err) {
    document.getElementById("login-status").innerText = "Failed: " + err.message;
  }
}

function logout() {
  // pure local action — clears session and resets the UI even if
  // network calls elsewhere on the page are frozen/hanging
  localStorage.removeItem("accountId");
  accountId = null;
  document.getElementById("dashboard").style.display = "none";
  document.getElementById("login-screen").style.display = "block";
  document.getElementById("login-status").innerText = "";
}

let chartInterval = null;

function showDashboard() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("dashboard").style.display = "block";
  refreshAccount();
  refreshPositions();
  loadChart();
  setInterval(refreshAccount, 5000);
  setInterval(refreshPositions, 5000);
  if (chartInterval) clearInterval(chartInterval);
  chartInterval = setInterval(loadChart, 15000); // refresh chart every 15s
}

async function loadChart() {
  const raw = (document.getElementById("chart-symbol").value || "XAUUSD").toUpperCase().replace("/", "");
  const symbol = raw.length === 6 ? `${raw.slice(0, 3)}/${raw.slice(3)}` : raw; // XAUUSD -> XAU/USD
  const statusEl = document.getElementById("chart-status");
  try {
    const res = await fetch(`${API_BASE}/api/chart/${encodeURIComponent(symbol)}?interval=5min&outputsize=100`);
    const data = await res.json();
    if (!res.ok) {
      statusEl.innerText = data.detail || "Chart failed to load";
      return;
    }
    statusEl.innerText = "";
    drawChart(data.candles);
  } catch (err) {
    statusEl.innerText = "Chart failed to load: " + err.message;
  }
}

function drawChart(candles) {
  const canvas = document.getElementById("chart-canvas");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!candles || candles.length === 0) return;

  const closes = candles.map((c) => c.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const stepX = canvas.width / (candles.length - 1 || 1);

  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 2;
  ctx.beginPath();
  candles.forEach((c, i) => {
    const x = i * stepX;
    const y = canvas.height - ((c.close - min) / range) * canvas.height;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = "#888";
  ctx.font = "12px sans-serif";
  ctx.fillText(max.toFixed(4), 4, 12);
  ctx.fillText(min.toFixed(4), 4, canvas.height - 4);
}

async function refreshAccount() {
  const res = await fetch(`${API_BASE}/api/account/${accountId}`);
  if (!res.ok) return;
  const info = await res.json();
  document.getElementById("account-info").innerText =
    `Balance: ${info.balance} | Equity: ${info.equity} | Currency: ${info.currency}`;
}

async function refreshPositions() {
  const res = await fetch(`${API_BASE}/api/positions/${accountId}`);
  if (!res.ok) return;
  const positions = await res.json();
  const el = document.getElementById("positions");
  el.innerHTML = "";
  positions.forEach((p) => {
    const div = document.createElement("div");
    div.className = "position";
    div.innerText = `${p.symbol} ${p.type} ${p.volume} lots | P/L: ${p.profit}`;
    const closeBtn = document.createElement("button");
    closeBtn.innerText = "Close";
    closeBtn.onclick = () => closePosition(p.id);
    div.appendChild(closeBtn);
    el.appendChild(div);
  });
}

async function trade(side) {
  const symbol = document.getElementById("symbol").value;
  const volume = document.getElementById("volume").value;
  const sl = document.getElementById("sl").value;
  const tp = document.getElementById("tp").value;

  document.getElementById("trade-status").innerText = "Placing order...";
  try {
    const res = await fetch(`${API_BASE}/api/trade/${accountId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, side, volume, sl, tp }),
    });
    if (!res.ok) throw new Error(await res.text());
    document.getElementById("trade-status").innerText = "Order placed.";
    refreshPositions();
  } catch (err) {
    document.getElementById("trade-status").innerText = "Failed: " + err.message;
  }
}

async function closePosition(positionId) {
  await fetch(`${API_BASE}/api/close/${accountId}/${positionId}`, { method: "POST" });
  refreshPositions();
}
