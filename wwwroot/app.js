"use strict";
const $ = id => document.getElementById(id);
const CAP = 3600;
let samples = [];
let lastTs = 0;
let booted = false;

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

let gpuPresent = false;

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
  ctx.clearRect(0, 0, w, h);

  const n = samples.length;
  if (n < 2) {
    ctx.fillStyle = css.getPropertyValue("--muted");
    ctx.font = "12px sans-serif";
    ctx.fillText("Collecting…", 8, h / 2);
    return;
  }

  const t0 = samples[0].ts, t1 = samples[n - 1].ts;
  const span = Math.max(1, t1 - t0);
  let max = opts.max;
  if (max == null) {
    max = 1;
    for (const line of lines) for (const v of line.data) if (v > max) max = v;
    max *= 1.15;
  }

  ctx.strokeStyle = css.getPropertyValue("--border");
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (h * i) / 4;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  for (const line of lines) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = ((samples[i].ts - t0) / span) * w;
      const y = h - Math.min(1, Math.max(0, line.data[i] / max)) * (h - 2) - 1;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = line.color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (line.fill) {
      const xEnd = w, xStart = 0;
      ctx.lineTo(xEnd, h); ctx.lineTo(xStart, h); ctx.closePath();
      ctx.fillStyle = line.fill;
      ctx.fill();
    }
  }

  ctx.fillStyle = css.getPropertyValue("--muted");
  ctx.font = "10px sans-serif";
  ctx.fillText(opts.fmt ? opts.fmt(max) : max.toFixed(0), 4, 12);
  ctx.fillText(lines.map(l => l.label).join("  "), 4, h - 4);
}

function colors() {
  const css = getComputedStyle(document.documentElement);
  return {
    l1: css.getPropertyValue("--line1").trim(),
    l2: css.getPropertyValue("--line2").trim(),
    fill: css.getPropertyValue("--fill").trim()
  };
}

function drawAll() {
  const c = colors();
  draw($("chart-cpu"), [
    { label: "CPU", data: series(s => Math.max(0, s.cpu)), color: c.l1, fill: c.fill }
  ], { max: 100, fmt: v => `${v.toFixed(0)}%` });
  draw($("chart-mem"), [
    { label: "Memory", data: series(s => s.mem_total_mb > 0 ? 100 * s.mem_used_mb / s.mem_total_mb : 0), color: c.l1, fill: c.fill }
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
      { label: "Core %", data: series(s => s.gpu ? Math.max(0, s.gpu.core_load) : 0), color: c.l1, fill: c.fill },
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

window.addEventListener("resize", drawAll);
(async function poll() { await refresh(); setTimeout(poll, 2000); })();
