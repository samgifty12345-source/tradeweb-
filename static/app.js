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
    const data = await res.json();
    if (!res.ok) {
      document.getElementById("login-status").innerText = data.detail || "Connect failed";
      return;
    }
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
  document.getElementById("login-screen").style.display = "flex";
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
  chartInterval = setInterval(loadChart, 15000);
}

async function refreshAccount() {
  const res = await fetch(`${API_BASE}/api/account/${accountId}`);
  if (!res.ok) return;
  const info = await res.json();
  document.getElementById("account-info").innerHTML = `
    <div><span class="stat-label">Balance</span>${info.balance} ${info.currency}</div>
    <div><span class="stat-label">Equity</span>${info.equity} ${info.currency}</div>
  `;
}

async function refreshPositions() {
  const res = await fetch(`${API_BASE}/api/positions/${accountId}`);
  if (!res.ok) return;
  const positions = await res.json();
  const el = document.getElementById("positions");
  el.innerHTML = "";

  if (positions.length === 0) {
    el.innerHTML = `<p class="empty-note">No open positions</p>`;
    return;
  }

  positions.forEach((p) => {
    const isProfit = p.profit >= 0;
    const row = document.createElement("div");
    row.className = "position-row";
    row.innerHTML = `
      <div>
        <strong>${p.symbol}</strong>
        <span class="pos-meta"> ${p.type} · ${p.volume} lots</span>
      </div>
      <div class="pos-profit ${isProfit ? "profit" : "loss"}">${isProfit ? "+" : ""}${p.profit.toFixed(2)}</div>
    `;
    const closeBtn = document.createElement("button");
    closeBtn.innerText = "Close";
    closeBtn.onclick = () => closePosition(p.id);
    row.appendChild(closeBtn);
    el.appendChild(row);
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
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Order failed");
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

// ---------- Live chart ----------

async function loadChart() {
  const raw = (document.getElementById("chart-symbol").value || "XAUUSD").toUpperCase().replace("/", "");
  const symbol = raw.length === 6 ? `${raw.slice(0, 3)}/${raw.slice(3)}` : raw; // XAUUSD -> XAU/USD
  const statusEl = document.getElementById("chart-status");
  try {
    const res = await fetch(`${API_BASE}/api/chart?symbol=${encodeURIComponent(symbol)}&interval=5min&outputsize=100`);
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
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!candles || candles.length === 0) return;

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const range = max - min || 1;
  const padding = { top: 10, bottom: 10, left: 8, right: 60 };
  const chartW = W - padding.left - padding.right;
  const chartH = H - padding.top - padding.bottom;
  const candleW = chartW / candles.length;

  const yFor = (price) => padding.top + chartH - ((price - min) / range) * chartH;

  candles.forEach((c, i) => {
    const x = padding.left + i * candleW + candleW / 2;
    const isUp = c.close >= c.open;
    ctx.strokeStyle = isUp ? "#1fae6b" : "#ef4655";
    ctx.fillStyle = isUp ? "#1fae6b" : "#ef4655";

    // wick
    ctx.beginPath();
    ctx.moveTo(x, yFor(c.high));
    ctx.lineTo(x, yFor(c.low));
    ctx.lineWidth = 1;
    ctx.stroke();

    // body
    const bodyTop = yFor(Math.max(c.open, c.close));
    const bodyBottom = yFor(Math.min(c.open, c.close));
    const bodyH = Math.max(bodyBottom - bodyTop, 1);
    ctx.fillRect(x - candleW * 0.35, bodyTop, candleW * 0.7, bodyH);
  });

  // price labels
  ctx.fillStyle = "#7a8494";
  ctx.font = "11px sans-serif";
  ctx.fillText(max.toFixed(4), W - padding.right + 8, yFor(max) + 4);
  ctx.fillText(min.toFixed(4), W - padding.right + 8, yFor(min) + 4);
  const last = candles[candles.length - 1].close;
  ctx.fillStyle = "#2f6dff";
  ctx.fillText(last.toFixed(4), W - padding.right + 8, yFor(last) + 4);
}
