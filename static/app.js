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

function showDashboard() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("dashboard").style.display = "block";
  refreshAccount();
  refreshPositions();
  setInterval(refreshAccount, 5000);
  setInterval(refreshPositions, 5000);
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
