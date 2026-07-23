const API_BASE = ""; // same origin on Render

let chart = null;
let candleSeries = null;
let currentInterval = "1min";
let chartPollInterval = null;

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

function logout(reason) {
  // pure local action — clears session and resets the UI even if
  // network calls elsewhere on the page are frozen/hanging
  localStorage.removeItem("accountId");
  accountId = null;
  document.getElementById("dashboard").style.display = "none";
  document.getElementById("login-screen").style.display = "flex";
  document.getElementById("login-status").innerText = reason || "";
}

function showDashboard() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("dashboard").style.display = "block";
  refreshAccount();
  refreshPositions();
  refreshAutotradeLog();
  loadChatHistory();
  startChart();
  setInterval(refreshAccount, 5000);
  setInterval(refreshPositions, 5000);
  setInterval(refreshAutotradeLog, 15000);
}

async function loadChatHistory() {
  try {
    const res = await fetch(`${API_BASE}/api/chat/history`);
    if (!res.ok) return;
    const history = await res.json();
    const el = document.getElementById("chat-messages");
    el.innerHTML = "";
    history.forEach((h) => appendChatBubble(h.role === "user" ? "user" : "ai", h.text));
  } catch (err) {
    // silent
  }
}

async function refreshAutotradeLog() {
  try {
    const res = await fetch(`${API_BASE}/api/autotrade/log`);
    if (!res.ok) return;
    const log = await res.json();
    const el = document.getElementById("autotrade-log");
    el.innerHTML = "";
    if (log.length === 0) {
      el.innerHTML = `<p class="empty-note">No AI checks yet — will appear here once the scheduler starts running</p>`;
      return;
    }
    log.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "autotrade-row";
      const time = new Date(entry.time).toLocaleString();
      const decision = entry.decision || {};
      let statusClass = "at-hold";
      let statusLabel = "HOLD";
      if (entry.status === "trade_placed") { statusClass = "at-trade"; statusLabel = decision.action ? decision.action.toUpperCase() : "TRADE"; }
      else if (entry.status === "error") { statusClass = "at-error"; statusLabel = "ERROR"; }
      else if (entry.status === "skipped") { statusClass = "at-skip"; statusLabel = "SKIPPED"; }
      row.innerHTML = `
        <div class="at-top">
          <span class="at-badge ${statusClass}">${statusLabel}</span>
          <span class="at-time">${time}</span>
        </div>
        <div class="at-reason">${entry.reason || decision.reason || ""}</div>
      `;
      el.appendChild(row);
    });
  } catch (err) {
    // silent — non-critical panel
  }
}

async function refreshAccount() {
  const res = await fetch(`${API_BASE}/api/account/${accountId}`);
  if (res.status === 404) { logout("Session expired — please log in again."); return; }
  if (!res.ok) return;
  const info = await res.json();
  document.getElementById("account-info").innerHTML = `
    <div><span class="stat-label">Balance</span>${info.balance} ${info.currency}</div>
    <div><span class="stat-label">Equity</span>${info.equity} ${info.currency}</div>
  `;
}

async function refreshPositions() {
  const res = await fetch(`${API_BASE}/api/positions/${accountId}`);
  if (res.status === 404) { logout("Session expired — please log in again."); return; }
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

// ---------- Chat with AI ----------

function appendChatBubble(role, text) {
  const el = document.getElementById("chat-messages");
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${role === "user" ? "chat-user" : "chat-ai"}`;
  bubble.innerText = text;
  el.appendChild(bubble);
  el.scrollTop = el.scrollHeight;
}

async function sendChat() {
  const input = document.getElementById("chat-input");
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  appendChatBubble("user", message);

  const thinking = document.createElement("div");
  thinking.className = "chat-bubble chat-ai chat-thinking";
  thinking.innerText = "...";
  document.getElementById("chat-messages").appendChild(thinking);

  try {
    const res = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();
    thinking.remove();
    if (!res.ok) {
      appendChatBubble("ai", data.detail || "Something went wrong");
      return;
    }
    appendChatBubble("ai", data.reply);
  } catch (err) {
    thinking.remove();
    appendChatBubble("ai", "Failed: " + err.message);
  }
}

function currentSymbol() {
  const raw = (document.getElementById("chart-symbol").value || "XAUUSD").toUpperCase().replace("/", "");
  return raw.length === 6 ? `${raw.slice(0, 3)}/${raw.slice(3)}` : raw; // XAUUSD -> XAU/USD
}

function initChartIfNeeded() {
  if (chart) return;
  const container = document.getElementById("chart-container");
  chart = LightweightCharts.createChart(container, {
    layout: { background: { color: "#0d1117" }, textColor: "#7a8494" },
    grid: {
      vertLines: { color: "#1a2029" },
      horzLines: { color: "#1a2029" },
    },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#232a35" },
    rightPriceScale: { borderColor: "#232a35" },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    autoSize: true,
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: "#1fae6b",
    downColor: "#ef4655",
    borderVisible: false,
    wickUpColor: "#1fae6b",
    wickDownColor: "#ef4655",
  });
}

function toChartTime(datetimeStr) {
  // Twelve Data returns "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DD" for daily
  return Math.floor(new Date(datetimeStr.replace(" ", "T") + "Z").getTime() / 1000);
}

async function loadChartHistory() {
  const statusEl = document.getElementById("chart-status");

  if (typeof LightweightCharts === "undefined") {
    statusEl.style.color = "#ef4655";
    statusEl.innerText = "Chart library failed to load (network/ad-blocker may be blocking the CDN script). Try disabling ad blockers for this site, or a different network.";
    return;
  }

  initChartIfNeeded();
  statusEl.style.color = "#7a8494";
  statusEl.innerText = "Loading chart...";
  try {
    const res = await fetch(
      `${API_BASE}/api/chart?symbol=${encodeURIComponent(currentSymbol())}&interval=${currentInterval}&outputsize=300`
    );
    const data = await res.json();
    if (!res.ok) {
      statusEl.style.color = "#ef4655";
      statusEl.innerText = data.detail || "Chart failed to load";
      return;
    }
    if (!data.candles || data.candles.length === 0) {
      statusEl.style.color = "#ef4655";
      statusEl.innerText = "No data returned for this symbol/timeframe";
      return;
    }
    statusEl.innerText = "";
    const formatted = data.candles.map((c) => ({
      time: toChartTime(c.time),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    candleSeries.setData(formatted);
    chart.timeScale().fitContent();
  } catch (err) {
    statusEl.style.color = "#ef4655";
    statusEl.innerText = "Chart failed to load: " + err.message;
  }
}

async function pollLatestCandle() {
  if (!candleSeries) return;
  try {
    const res = await fetch(
      `${API_BASE}/api/chart?symbol=${encodeURIComponent(currentSymbol())}&interval=${currentInterval}&outputsize=2`
    );
    if (!res.ok) return;
    const data = await res.json();
    const latest = data.candles[data.candles.length - 1];
    if (!latest) return;
    // update() moves/replaces the last bar or appends a new one without
    // resetting the user's current zoom/scroll position
    candleSeries.update({
      time: toChartTime(latest.time),
      open: latest.open,
      high: latest.high,
      low: latest.low,
      close: latest.close,
    });
  } catch (err) {
    // silent — next poll will retry
  }
}

function changeTimeframe(interval, btnEl) {
  currentInterval = interval;
  document.querySelectorAll(".tf-btn").forEach((b) => b.classList.remove("active"));
  btnEl.classList.add("active");
  loadChartHistory();
}

function changeSymbol() {
  loadChartHistory();
}

function startChart() {
  loadChartHistory();
  if (chartPollInterval) clearInterval(chartPollInterval);
  chartPollInterval = setInterval(pollLatestCandle, 20000); // stay under free-tier rate limits
}
