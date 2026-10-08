"use strict";
const $ = id => document.getElementById(id);
const CAP = 100000;
let samples = [];
let lastTs = 0;
let booted = false;
let gpuPresent = false;
let cfgLoaded = false;
let renderMs = 2000;

document.documentElement.dataset.theme = localStorage.getItem("mini.theme") || "dark";
$("theme").onclick = () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  localStorage.setItem("mini.theme", t);
  drawAll();
};

async function api(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function text(id, v) { const el = $(id); const s = String(v); if (el.textContent !== s) el.textContent = s; }

function fmtBytes(bps) {
  if (bps == null || bps < 0) return "—";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let i = 0;
  while (bps >= 1024 && i < units.length - 1) { bps /= 1024; i++; }
  return `${bps >= 100 ? bps.toFixed(0) : bps.toFixed(1)} ${units[i]}`;
}
function fmtMb(mb) {
  if (mb == null || mb < 0) return "—";
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}
function fmtUptime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}
function fmtRetention(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
function fmtInterval(ms) {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
}

function updateCards(latest) {
  if (!latest) return;
  text("cpu-value", latest.cpu >= 0 ? `${latest.cpu.toFixed(1)}%` : "—");
  const memPct = latest.mem_total_mb > 0 ? (100 * latest.mem_used_mb / latest.mem_total_mb) : -1;
  text("mem-value", memPct >= 0 ? `${memPct.toFixed(1)}%` : "—");
  text("mem-detail", `${fmtMb(latest.mem_used_mb)} / ${fmtMb(latest.mem_total_mb)}`);
  text("disk-value", `↓ ${fmtBytes(latest.disk.read_bps)}  ↑ ${fmtBytes(latest.disk.write_bps)}`);
  text("net-value", `↓ ${fmtBytes(latest.net.down_bps)}  ↑ ${fmtBytes(latest.net.up_bps)}`);
  if (latest.gpu) {
    const g = latest.gpu;
    text("gpu-value", g.core_load >= 0 ? `${g.core_load.toFixed(1)}%` : "—");
    const parts = [];
    if (g.mem_total_mb > 0) parts.push(`VRAM ${fmtMb(g.mem_used_mb)} / ${fmtMb(g.mem_total_mb)}`);
    else if (g.mem_used_mb >= 0) parts.push(`VRAM ${fmtMb(g.mem_used_mb)}`);
    if (g.temp_c >= 0) parts.push(`${g.temp_c.toFixed(0)}°C`);
    if (g.power_w >= 0) parts.push(`${g.power_w.toFixed(0)}W`);
    text("gpu-detail", parts.join(" · "));
  }
}

function renderInfo(status) {
  text("info", `${status.machine} · ${status.os} · started ${new Date(status.started_at * 1000).toLocaleString()} · up ${fmtUptime(status.uptime_s)}`);
  text("cpu-name", `${status.cpu} (${status.cores} cores)`);
  gpuPresent = Boolean(status.gpu_present);
  $("gpu-card").hidden = !gpuPresent;
  $("gpu-chart").hidden = !gpuPresent;
  if (gpuPresent) $("gpu-card").querySelector(".label").textContent = status.gpu ? `GPU · ${status.gpu}` : "GPU";
  const drives = (status.drives || []).map(d => {
    const pct = d.total_mb > 0 ? (100 * d.used_mb / d.total_mb).toFixed(0) : "?";
    return `${d.name} ${fmtMb(d.used_mb)} / ${fmtMb(d.total_mb)} (${pct}%)`;
  }).join("   ");
  text("drives", drives);
}

function series(fn) { return samples.map(fn); }

function rgba(color, a) {
  color = color.trim();
  if (color.startsWith("#")) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  return color;
}

function draw(canvas, lines, opts) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr; canvas.height = h * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.documentElement);
  const muted = css.getPropertyValue("--muted").trim();
  ctx.clearRect(0, 0, w, h);

  const n = samples.length;
  if (n < 2) {
    ctx.fillStyle = muted;
    ctx.font = "12px sans-serif";
    ctx.fillText("Collecting…", 8, h / 2);
    return;
  }

  const t0 = samples[0].ts, t1 = samples[n - 1].ts;
  const span = Math.max(1, t1 - t0);
  const step = Math.max(1, Math.floor(n / w));

  let max = opts.max;
  if (max == null) {
    max = 1;
    for (const line of lines) for (let i = 0; i < n; i += step) if (line.data[i] > max) max = line.data[i];
    max *= 1.15;
  }

  ctx.strokeStyle = css.getPropertyValue("--border");
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (h * i) / 4;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  const point = (i, data) => [
    ((samples[i].ts - t0) / span) * w,
    h - Math.min(1, Math.max(0, data[i] / max)) * (h - 4) - 2
  ];

  for (const line of lines) {
    ctx.beginPath();
    for (let i = 0; i < n; i += step) {
      const [x, y] = point(i, line.data);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    if (line.fill) {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, rgba(line.color, 0.28));
      grad.addColorStop(1, rgba(line.color, 0.01));
      ctx.save();
      ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      for (let i = 0; i < n; i += step) {
        const [x, y] = point(i, line.data);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = line.color;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = "round";
    ctx.stroke();

    const [lx, ly] = point(n - 1, line.data);
    ctx.beginPath();
    ctx.arc(lx, ly, 2.8, 0, 7);
    ctx.fillStyle = line.color;
    ctx.fill();
  }

  ctx.fillStyle = muted;
  ctx.font = "10px sans-serif";
  ctx.fillText(opts.fmt ? opts.fmt(max) : max.toFixed(0), 4, 12);

  let lx = 4;
  for (const line of lines) {
    ctx.beginPath();
    ctx.arc(lx + 3, h - 7, 3, 0, 7);
    ctx.fillStyle = line.color;
    ctx.fill();
    ctx.fillStyle = muted;
    ctx.fillText(line.label, lx + 10, h - 4);
    lx += 10 + ctx.measureText(line.label).width + 16;
  }
}

function colors() {
  const css = getComputedStyle(document.documentElement);
  return { l1: css.getPropertyValue("--line1").trim(), l2: css.getPropertyValue("--line2").trim() };
}

function drawAll() {
  const c = colors();
  draw($("chart-cpu"), [
    { label: "CPU", data: series(s => Math.max(0, s.cpu)), color: c.l1, fill: true }
  ], { max: 100, fmt: v => `${v.toFixed(0)}%` });
  draw($("chart-mem"), [
    { label: "Memory", data: series(s => s.mem_total_mb > 0 ? 100 * s.mem_used_mb / s.mem_total_mb : 0), color: c.l1, fill: true }
  ], { max: 100, fmt: v => `${v.toFixed(0)}%` });
  draw($("chart-disk"), [
    { label: "Read", data: series(s => s.disk.read_bps), color: c.l1 },
    { label: "Write", data: series(s => s.disk.write_bps), color: c.l2 }
  ], { fmt: fmtBytes });
  draw($("chart-net"), [
    { label: "Down", data: series(s => s.net.down_bps), color: c.l1 },
    { label: "Up", data: series(s => s.net.up_bps), color: c.l2 }
  ], { fmt: fmtBytes });
  if (gpuPresent) {
    draw($("chart-gpu"), [
      { label: "Core %", data: series(s => s.gpu ? Math.max(0, s.gpu.core_load) : 0), color: c.l1, fill: true },
      { label: "Temp °C", data: series(s => s.gpu ? Math.max(0, s.gpu.temp_c) : 0), color: c.l2 }
    ], { max: 100, fmt: v => `${v.toFixed(0)}` });
  }
}

async function refresh() {
  try {
    const status = await api("/api/status");
    const metrics = await api(`/api/metrics?since=${lastTs}`);
    for (const s of metrics.samples) {
      samples.push(s);
      if (s.ts > lastTs) lastTs = s.ts;
    }
    if (samples.length > CAP) samples.splice(0, samples.length - CAP);
    renderInfo(status);
    updateCards(status.latest);
    drawAll();
    text("updated", `Live · updated ${new Date().toLocaleTimeString()}`);
    booted = true;
  } catch (e) {
    text("updated", booted ? "Disconnected · retrying" : `Cannot reach server (${e.message})`);
  }
}

function fillConfig(cfg) {
  renderMs = Math.max(1000, Math.min(5000, cfg.interval_ms));
  $("cfg-port").value = cfg.port;
  const retentionMin = Math.max(1, Math.min(1440, Math.round(cfg.retention_seconds / 60)));
  $("cfg-retention").value = retentionMin;
  text("cfg-retention-label", fmtRetention(retentionMin));
  const interval = Math.max(200, Math.min(10000, cfg.interval_ms));
  $("cfg-interval").value = interval;
  text("cfg-interval-label", fmtInterval(interval));
}

$("cfg-retention").oninput = () => text("cfg-retention-label", fmtRetention(Number($("cfg-retention").value)));
$("cfg-interval").oninput = () => text("cfg-interval-label", fmtInterval(Number($("cfg-interval").value)));

async function loadConfig() {
  try {
    fillConfig(await api("/api/config"));
    cfgLoaded = true;
  } catch (_) {}
}

function toast(msg, error = false, ms = 3200) {
  const el = document.createElement("div");
  el.className = `toast${error ? " error" : ""}`;
  el.textContent = msg;
  $("toasts").append(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, ms);
}

async function saveConfig(includePort, quiet = false) {
  const body = {
    retention_seconds: Number($("cfg-retention").value) * 60 || null,
    interval_ms: Number($("cfg-interval").value) || null
  };
  if (includePort) body.port = Number($("cfg-port").value) || null;
  try {
    const r = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const cfg = await r.json();
    if (!r.ok) throw new Error(cfg.error || `HTTP ${r.status}`);
    fillConfig(cfg);
    if (!quiet) toast("Settings applied");
    samples = [];
    lastTs = 0;
    await refresh();
    return true;
  } catch (e) {
    if (!quiet) toast(`Failed to apply settings: ${e.message}`, true);
    return false;
  }
}

let autoSaveTimer = null;
function autoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => saveConfig(false), 300);
}
$("cfg-retention").onchange = autoSave;
$("cfg-interval").onchange = autoSave;

async function control(action) {
  if (!confirm(action === "restart"
    ? "Restart the server? Current settings (incl. port) will be applied."
    : "Shut down the server?")) return;
  let targetPort = null;
  if (action === "restart") {
    if (!await saveConfig(true, true)) {
      toast("Could not save settings; restart aborted", true);
      return;
    }
    targetPort = Number($("cfg-port").value) || null;
  }
  try { await fetch(`/api/${action}`, { method: "POST" }); } catch (_) {}
  if (action === "restart") {
    text("updated", "Restarting…");
    toast("Restarting — settings applied");
    if (targetPort && String(targetPort) !== location.port) {
      setTimeout(() => { location.port = targetPort; }, 5000);
    }
  } else {
    text("updated", "Server stopped");
    toast("Server stopped");
  }
}
$("restart").onclick = () => control("restart");
$("shutdown").onclick = () => control("shutdown");

window.addEventListener("resize", drawAll);
loadConfig();
(async function poll() { await refresh(); if (!cfgLoaded) await loadConfig(); setTimeout(poll, renderMs); })();
