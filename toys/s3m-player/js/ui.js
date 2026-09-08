/* ============================================================
 * ui.js —— 播放器界面逻辑
 * 关键设计：UI 构建不依赖音频；音频引擎(含 AudioWorklet)在
 * 首次点击播放时懒加载(ensureAudio)，任何错误都可见而非卡死页面。
 * ============================================================ */
"use strict";

const ui = {
  module: null,
  ctx: null, engine: null, audioReady: false, audioError: null,
  playing: false, mode: "song", selPat: 0, startRow: 0,
  rowEls: [], channelMuted: [], renderPat: -1,
  follow: true,
  lastPat: 0, lastRow: 0, lastTime: 0,
  // 未就绪前的临时用户设置，就绪后一次性套用
  pending: { speed: 100, gain: 100, semis: 0, cents: 0 },
};
const $ = (id) => document.getElementById(id);

/* ---------- 数据加载（UI 已先行可用，加载进度实时显示） ---------- */
async function loadData(dataDir) {
  setStatus("读取 song.json / patterns.json …");
  ui.module = await TrackerModule.load(dataDir);
  buildUI();
}

/* 根据 ui.module 重建整个界面（默认曲目 / 上传文件都走这里） */
function buildUI() {
  setStatus("构建界面…");
  ui.playing = false; ui.audioReady = false; ui.audioError = null;
  ui.renderPat = -1; ui.lastPat = 0; ui.lastRow = 0; ui.lastTime = 0;
  ui.channelMuted = [];
  if (ui.engine) { try { ui.engine.stop(); } catch (e) {} ui.engine = null; }
  fillMeta();
  buildPatternList();
  buildGrid();
  renderPattern(0);
  buildInstrumentList();
  setMode("song");
  updatePos(0);
  syncView(0, 0);
  setTransportUI();
  setStatus("就绪 · " + ui.module.title + " · 采样 " + ui.module.instruments.length +
            " · 通道 " + ui.module.channels + " · 按 ▶ 播放");
}

/* ---------- 上传 S3M 文件 ---------- */
function bindUpload() {
  var btn = $("uploadbtn"), input = $("fileinput");
  if (!btn || !input) return;
  btn.addEventListener("click", function () { input.click(); });
  input.addEventListener("change", function () {
    var f = input.files && input.files[0];
    if (!f) return;
    handleUpload(f);
    input.value = "";      // 允许重复上传同一文件
  });
}

function showProgress(pct, show) {
  var w = $("progresswrap"), b = $("progressbar");
  if (!w || !b) return;
  w.style.display = show ? "block" : "none";
  if (show) b.style.width = Math.max(0, Math.min(100, pct)) + "%";
}
/* 节流的状态更新(解析密集回调时避免卡 UI) */
var _lastStatusT = 0, _lastStatusText = "";
function setStatusThrottled(txt) {
  var now = Date.now();
  if (txt !== _lastStatusText && now - _lastStatusT > 60) {
    _lastStatusT = now; _lastStatusText = txt;
    setStatus(txt);
  }
}

async function handleUpload(file) {
  // 停止当前播放
  ui.playing = false;
  if (ui.engine) { try { ui.engine.stop(); } catch (e) {} }
  setTransportUI();

  setStatus("📂 读取文件：" + file.name + " (" + (file.size / 1024).toFixed(0) + " KB)…");
  showProgress(2, true);

  try {
    var buf = await file.arrayBuffer();

    // 解析(带进度回调)
    var mod = await S3MParser.parse(buf, function (stepText, pct) {
      setStatusThrottled("🔍 " + stepText);
      showProgress(pct, true);
    });

    showProgress(100, true);
    setStatus("✅ 解析完成，构建界面…");
    ui.module = mod;
    buildUI();
    showProgress(0, false);
    setStatus("✅ 已载入《" + mod.title + "》· 采样 " + mod.instruments.length +
              " · 通道 " + mod.channels + " · 按 ▶ 播放");
  } catch (err) {
    console.error(err);
    showProgress(0, false);
    setStatus("❌ 解析失败：" + (err && err.message ? err.message : err));
  }
}

/* 启动：先把所有按钮绑上(不依赖数据/音频)，再异步加载数据 */
function boot() {
  bindTransport();          // 立即生效，任何情况都可点
  bindUpload();             // 上传功能
  setStatus("页面已就绪，读取数据中…");
  loadData("data/").catch(function (err) {
    console.error(err);
    setStatus("⚠ 数据加载失败：" + (err && err.message ? err.message : err));
  });
}

/* ---------- 音频引擎懒初始化 ---------- */
async function ensureAudio() {
  step("AUDIO-INIT");
  if (!ui.module) throw new Error("模块数据未就绪");
  if (ui.audioReady) return true;
  if (ui.audioError) throw ui.audioError;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error("此浏览器不支持 WebAudio");
    ui.ctx = new AC({ sampleRate: 44100 });
    await ui.ctx.resume().catch(() => {});          // 部分环境要求
    ui.engine = new TrackerEngine(ui.module, ui.ctx);
    ui.engine.setDataDir("data/");
    ui.engine.onRowChange = onRow;
    ui.engine.onLevels = onLevels;
    ui.engine.onStop = () => { ui.playing = false; setTransportUI(); setStatus("播放结束"); };
    await ui.engine.loadSamples();                    // fetch 采样 + 解码
    await ui.engine.prepare();                        // AudioWorklet 装载

    // 套用播放前就调好的用户设置
    ui.engine.setPitch(ui.pending.semis, ui.pending.cents);
    ui.engine.setSpeedMul(ui.pending.speed / 100);
    ui.engine.setUserGain(ui.pending.gain / 100);
    ui.engine.setChannelMuteAll(ui.channelMuted);

    ui.audioReady = true;
    return true;
  } catch (err) {
    ui.audioError = err;
    console.error("音频初始化失败:", err);
    setStatus("⚠ 音频引擎不可用：" + err.message);
    throw err;
  }
}

/* ---------- 元信息 ---------- */
function fillMeta() {
  const m = ui.module;
  $("title").textContent = m.title;
  $("meta").textContent =
    [m.madeBy, m.date, m.format + " · " + m.tracker].filter(Boolean).join("  /  ");
  $("songinfo").textContent =
    "通道 " + m.channels + " · order " + m.order.length + " · pattern " + m.patterns.length +
    " · speed=" + m.initSpeed + " tempo=" + m.initTempo;
  const msg = $("message");
  if (m.comment && m.comment.length)
    msg.textContent = "作者藏在采样名里的留言： " + m.comment.map(s => s.trim()).filter(Boolean).join("  ");
}

/* ---------- pattern 选择 ---------- */
function buildPatternList() {
  const wrap = $("patternlist"); wrap.innerHTML = "";
  ui.module.patterns.forEach((pat, i) => {
    const notes = pat.reduce((a, row) => a + row.reduce((n, ev) => n + (ev && ev.note !== null && ev.note >= 0 ? 1 : 0), 0), 0);
    const b = document.createElement("button");
    b.className = "pat-chip"; b.dataset.pat = i;
    b.textContent = "P" + i; b.title = "pattern " + i + " · " + notes + " 音符";
    b.addEventListener("click", () => {
      ui.selPat = i;
      renderPattern(i);
      if (ui.playing && ui.engine) ui.engine.jump(i, ui.startRow);
      setStatus("已选 P" + i + (ui.playing ? "（已跳转）" : "（未播放，可预览谱面）"));
      refreshChips();
    });
    wrap.appendChild(b);
  });
  refreshChips();
}
function refreshChips() {
  document.querySelectorAll(".pat-chip").forEach(b =>
    b.classList.toggle("active", +b.dataset.pat === ui.selPat));
}

/* ---------- 网格 ---------- */
function buildGrid() {
  const table = $("grid"); table.innerHTML = "";
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  const th0 = document.createElement("th"); th0.textContent = "行"; hr.appendChild(th0);
  for (let c = 0; c < ui.module.channels; c++) {
    const th = document.createElement("th");
    const pan = ui.module.pan[c];
    const pn = pan == null ? "C" : (pan < 7 ? "L" + (7 - pan) : (pan > 7 ? "R" + (pan - 7) : "C"));
    th.innerHTML = (c + 1) + "\u2009" + pn + "<div class='chvu' id='vu" + c + "'></div>";
    th.title = "通道" + (c + 1) + " pan " + pn + "（点击静音）";
    th.addEventListener("click", () => toggleMute(c, th));
    hr.appendChild(th);
  }
  thead.appendChild(hr); table.appendChild(thead);

  const tbody = document.createElement("tbody");
  ui.rowEls = [];
  for (let r = 0; r < 64; r++) {
    const tr = document.createElement("tr"); tr.dataset.row = r;
    const td0 = document.createElement("td"); td0.className = "rownum";
    td0.textContent = r; tr.appendChild(td0);
    for (let c = 0; c < ui.module.channels; c++) {
      const td = document.createElement("td");
      td.dataset.ch = c;
      td.addEventListener("click", () => {
        ui.startRow = r; $("startrow").value = r;
        setStatus("单段起始行 = " + r);
        syncView(ui.renderPat, r);
      });
      tr.appendChild(td);
    }
    tbody.appendChild(tr); ui.rowEls.push(tr);
  }
  table.appendChild(tbody);
}

function velColor(v) {
  const t = Math.max(0, Math.min(64, v)) / 64;
  return "hsl(" + Math.round(t * 130) + " 90% " + (40 + Math.round(t * 30)) + "%)";
}

/* 渲染某 pattern 文字（切 pattern 时调用） */
function renderPattern(pat) {
  const p = ui.module.patterns[pat];
  for (let r = 0; r < 64; r++) {
    const row = p[r];
    const tds = ui.rowEls[r].querySelectorAll("td[data-ch]");
    for (let c = 0; c < tds.length; c++) {
      const ev = row[c], td = tds[c];
      td.dataset.ins = "";
      if (!ev) { td.innerHTML = ""; td.className = "cell empty"; continue; }
      let html = "<span class='n'>" + ((ev.note != null) ? fmtRel2(ev.note) : "···") + "</span>";
      if (ev.ins) html += "<span class='i'>I" + ev.ins + "</span>";
      if (ev.vol != null) {
        const v = Math.round(ev.vol);
        html += "<span class='v' style='color:" + velColor(v) + "'>V" +
                String(v).padStart(2, "0") + "</span>";
      }
      if (ev.fx) html += "<span class='fx'>" + ev.fx.code +
                ev.fx.param.toString(16).toUpperCase().padStart(2, "0") + "</span>";
      td.innerHTML = html;
      td.className = "cell";
      if (ev.ins) td.dataset.ins = ev.ins;
    }
  }
  ui.renderPat = pat;
}

function fmtRel2(n) {
  if (n === -1) return "OFF";
  if (n === -2) return "---";
  const o = Math.floor((n + 48) / 12);
  const s = ((n % 12) + 12) % 12;
  return NOTE_NAMES[s] + "-" + o;
}

function syncView(pat, row) {
  if (pat !== ui.renderPat) renderPattern(pat);
  ui.rowEls.forEach(tr => tr.classList.remove("cur"));
  const tr = ui.rowEls[row];
  if (!tr) return;
  tr.classList.add("cur");
  if (ui.follow) {
    const gw = document.querySelector(".gridwrap");
    if (gw) {
      // 让高亮行固定在视口内一个恒定水平位置(默认 40% 高度处),
      // 谱面内容从它下方滚过 —— 高亮行本身不再上下移动。
      var ANCHOR = 0.40;                       // 0=顶部, 1=底部
      var thead = gw.querySelector("thead");
      var headH = thead ? thead.offsetHeight : 0;   // 扣掉粘性表头高度, 避免高亮行被表头遮住
      var anchorPx = headH + (gw.clientHeight - headH) * ANCHOR;
      var target = tr.offsetTop - anchorPx;
      gw.scrollTop = Math.max(0, Math.round(target));
    }
  }
}

/* 行回调（worklet 消息） */
function onRow(pat, row, info) {
  ui.lastPat = pat; ui.lastRow = row;
  if (info && info.timeSec != null) ui.lastTime = info.timeSec;
  updatePos(info);
  syncView(pat, row);
}
function updatePos(info) {
  const t = info && info.timeSec != null ? info.timeSec : ui.lastTime;
  const mt = (info && info.mode === "pattern")
    ? "单段"
    : (info && info.orderPos != null ? "order " + info.orderPos + "/" + ui.module.order.length : "");
  $("pos").textContent =
    (mt ? mt + "  " : "") + "P" + ui.lastPat + " · 行 " + ui.lastRow +
    " · " + fmtTime(t) + " / " + fmtTime(songEstimate());
}
function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return m + ":" + (s % 60).toFixed(1).padStart(4, "0");
}
function songEstimate() {
  // 行速 = tempo/(speed*2.5)  → 时长 = 行数*speed*2.5/tempo
  return ui.module.order.length * 64 * ui.module.initSpeed * 2.5 / ui.module.initTempo;
}

/* ---------- 采样试听 ---------- */
function buildInstrumentList() {
  const wrap = $("instrlist"); wrap.innerHTML = "";
  ui.module.instruments.forEach((ins, i) => {
    const b = document.createElement("button");
    b.className = "ins-chip";
    b.textContent = (i + 1) + ". " + (ins.title || ins.file || ("Sample" + i));
    b.title = "c2spd=" + ins.c2spd + " · vol=" + ins.volume + (ins.loop ? " · 循环" : "") + " · 点击试听";
    b.addEventListener("click", () => { try { audition(i); } catch (e) { setStatus("试听失败: " + e.message); } });
    wrap.appendChild(b);
  });
}
async function audition(slot) {
  if (!ui.module || !ui.module.instruments[slot]) return;
  await ensureAudio();
  const buf = ui.engine.sampleBuffers[slot];
  if (!buf) return;
  const ins = ui.module.instruments[slot];
  const [ts, tc] = ui.engine.getPitch();
  const freq = ins.c2spd * Math.pow(2, (-12 + ts + tc / 100) / 12);
  const rate = (ui.engine.sampleRates && ui.engine.sampleRates[slot]) || 44100;
  const ab = ui.ctx.createBuffer(1, buf.length, rate);
  ab.getChannelData(0).set(buf);
  const src = ui.ctx.createBufferSource(); src.buffer = ab;
  const g = ui.ctx.createGain(); g.gain.value = 0.6;
  src.connect(g);
  const p = ui.ctx.createStereoPanner ? ui.ctx.createStereoPanner() : null;
  if (p) { g.connect(p); p.connect(ui.ctx.destination); } else g.connect(ui.ctx.destination);
  src.playbackRate.value = freq / rate;
  src.loop = !!ins.loop;
  src.start();
  if (ins.loop) setTimeout(() => { try { src.stop(); } catch (e) {} }, 1300);
}

/* ---------- 静音 ---------- */
function toggleMute(ch, th) {
  ui.channelMuted[ch] = !ui.channelMuted[ch];
  th.classList.toggle("muted", ui.channelMuted[ch]);
  if (ui.engine) ui.engine.setChannelMuteAll(ui.channelMuted);
}

/* ---------- 控制 ---------- */
function bindTransport() {
  const playBtn = $("play");
  playBtn.addEventListener("click", async () => {
    try {
      if (!ui.module) { setStatus("⚠ 数据尚未加载完成，请稍候…"); return; }
      await ensureAudio();
      await ui.ctx.resume();
      if (ui.playing) {
        ui.engine.pause(); ui.playing = false; setTransportUI(); setStatus("已暂停");
        return;
      }
      ui.playing = true;
      ui.engine.start(ui.mode, ui.selPat, ui.startRow, true);
      setTransportUI();
      setStatus((ui.mode === "pattern" ? "循环 P" + ui.selPat + "（起始行 " + ui.startRow + "）" : "全曲") + "播放中 · " + ui.module.title);
    } catch (err) {
      console.error(err);
      setStatus("无法播放：" + err.message);
      ui.playing = false; setTransportUI();
    }
  });

  $("stop").addEventListener("click", () => {
    if (ui.engine) ui.engine.stop();
    ui.playing = false; setTransportUI(); setStatus("已停止");
  });
  $("togglepanel").addEventListener("click", () => {
    const main = document.querySelector("main");
    main.classList.toggle("panel-hidden");
    $("togglepanel").textContent = main.classList.contains("panel-hidden") ? "☰ 展开" : "☰ 收起";
  });
  $("mode-song").addEventListener("click", () => setMode("song"));
  $("mode-pat").addEventListener("click", () => setMode("pattern"));
  $("follow").addEventListener("change", e => { ui.follow = e.target.checked; });

  $("speed").addEventListener("input", e => {
    const v = +e.target.value; ui.pending.speed = v;
    $("speedv").textContent = v + "%";
    if (ui.engine) { ui.engine.setSpeedMul(v / 100); updateStats(); }
  });
  $("volume").addEventListener("input", e => {
    const v = +e.target.value; ui.pending.gain = v;
    $("volumev").textContent = v + "%";
    if (ui.engine) ui.engine.setUserGain(v / 100);
  });
  $("semi").addEventListener("input", e => {
    ui.pending.semis = +e.target.value;
    $("semiv").textContent = (e.target.value > 0 ? "+" : "") + e.target.value + " st";
    applyPitch();
  });
  $("cents").addEventListener("input", e => {
    ui.pending.cents = +e.target.value;
    $("centsv").textContent = (e.target.value > 0 ? "+" : "") + e.target.value + " ct";
    applyPitch();
  });
  $("pitchreset").addEventListener("click", () => {
    $("semi").value = 0; $("cents").value = 0;
    ui.pending.semis = 0; ui.pending.cents = 0;
    $("semiv").textContent = "0 st"; $("centsv").textContent = "0 ct";
    applyPitch();
  });
  $("startrow").addEventListener("change", e => {
    ui.startRow = Math.max(0, Math.min(63, +e.target.value || 0));
  });

  document.addEventListener("keydown", e => { if (e.code === "Space") { e.preventDefault(); playBtn.click(); } });
}

function setMode(m) {
  ui.mode = m;
  $("mode-song").classList.toggle("active", m === "song");
  $("mode-pat").classList.toggle("active", m === "pattern");
  $("rowpicker").style.display = m === "pattern" ? "flex" : "none";
  setStatus(m === "song" ? "全曲模式：按 ▶ 从头播放整首" : "单段模式：选 P" + ui.selPat + " 后 ▶ 循环");
}
function applyPitch() {
  if (ui.engine) ui.engine.setPitch(ui.pending.semis, ui.pending.cents);
  const s = ui.pending.semis + ui.pending.cents / 100;
  $("pitchread").textContent = (s > 0 ? "+" : "") + s.toFixed(2) + " 半音";
}
function updateStats() {
  const v = ui.pending.speed / 100;
  $("stats").textContent =
    "tempo " + ui.module.initTempo + " · 行速≈" +
    (ui.module.initTempo * v / (ui.module.initSpeed * 2.5)).toFixed(1) + " 行/秒";
}
/* 每声道电平 → 表头 VU 条高度 */
function onLevels(levels) {
  for (var c = 0; c < levels.length; c++) {
    var el = document.getElementById("vu" + c);
    if (!el) continue;
    var l = Math.min(1, levels[c] * 1.8);   // 缩放
    el.style.width = (l * 100) + "%";
    el.style.background = l > 0.8 ? "#ff7a7a" : (l > 0.35 ? "#ffce54" : "#4fd6a8");
  }
}
function setTransportUI() {
  const b = $("play");
  b.textContent = ui.playing ? "❚❚ 暂停" : "▶ 播放";
  b.classList.toggle("active", ui.playing);
}
function setStatus(s) {
  const el = $("status"); if (el) el.textContent = s;
  const dg = document.getElementById("diag"); if (dg) dg.textContent = s;   // 同步到大红条
}
/* 调试打点：标记执行到哪一步 */
function step(tag) {
  var d = document.getElementById("diag");
  if (d) d.textContent = tag + " @" + (Date.now() - (window.__BOOT_TS||Date.now())) + "ms";
}

window.addEventListener("error", function (ev) {
  console.error("页面错误:", ev.error || ev.message);
  try { setStatus("⚠ 脚本错误：" + ((ev.error && ev.error.message) || ev.message || "未知")); } catch (e) {}
});
window.addEventListener("unhandledrejection", function (ev) {
  var r = ev.reason;
  var msg = (r && r.message) ? r.message : String(r);
  console.error("未处理异常:", r);
  try { setStatus("⚠ 异步错误：" + msg); } catch (e) {}
});
window.addEventListener("load", boot);
