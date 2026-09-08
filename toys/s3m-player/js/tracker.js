/* ============================================================
 * tracker.js —— 通用追踪器模块模型 & 加载器
 * ------------------------------------------------------------
 * 设计目标：引擎不绑定任何具体格式。
 *   - 归一化音符: 相对 C4 的半音数 (C4=0, B4=11, C2=-24…)
 *   - 事件单元:   [note, ins, vol, fxCode, fxParam]
 *                  note:>=0 有音高 | -1=note-off | -2=无音高 | null=无
 *                  ins :1..N (1基, 对应 sampleFiles[ins-1]) | 0/未写=沿用当前采样
 *                  vol :0..64 | null=未写
 *                  fxCode:'D'..'Z' 字母码 + fxParam 0..255
 *   未来加 MOD/IT/MTM 等：各自 loader 产出一份相同形状的 JSON 即可复用本引擎。
 * ============================================================ */

"use strict";

class TrackerModule {
  constructor() {
    this.format = null;      // "S3M" / 未来 "MOD"...
    this.title = "";
    this.madeBy = "";
    this.tracker = "";
    this.date = "";
    this.channels = 0;
    this.pan = [];           // 每声道 0..15（或 null 表示中置）
    this.order = [];         // 播放顺序：pattern 编号列表
    this.patterns = [];      // patterns[i] = 64 行 * channels 列 的事件
    this.instruments = [];   // 每个: {index,file,title,volume,c2spd,loop,loopStart,loopEnd,length}
    this.sampleFiles = [];   // wav 相对 URL（顺序与 instruments 对齐）
    this.initSpeed = 6;      // 每行多少帧(tick)
    this.initTempo = 125;    // 每秒多少帧
    this.globalVolume = 64;
    this.comment = [];       // 作者留言行
  }

  /* 载入：dataDir 下需有 song.json / patterns.json（带 8s 超时，避免卡死无响应） */
  static async load(dataDir) {
    const base = dataDir.replace(/\/$/, "");
    async function getJson(u) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const r = await fetch(u, { signal: ctrl.signal });
        if (!r.ok) throw new Error("HTTP " + r.status + " " + u);
        return await r.json();
      } finally { clearTimeout(timer); }
    }
    const [song, pt] = await Promise.all([
      getJson(base + "/song.json"),
      getJson(base + "/patterns.json")
    ]);
    const m = new TrackerModule();
    Object.assign(m, {
      format: song.format || "?",
      title: song.title, madeBy: song.madeBy || "", tracker: song.tracker || "",
      date: song.date || "",
      channels: song.channels, pan: song.pan, order: song.order,
      instruments: song.instrument || [],
      sampleFiles: song.sampleFiles || [],
      initSpeed: song.initSpeed || 6, initTempo: song.initTempo || 125,
      globalVolume: song.globalVolume == null ? 64 : song.globalVolume,
      comment: song.sampleComment || [],
    });
    m.patterns = pt.patterns.map(pat => {
      // 统一补齐 64 行 * channels 列
      const out = [];
      for (let r = 0; r < 64; r++) {
        const src = pat[r];
        const row = new Array(m.channels).fill(null);
        if (src) for (let c = 0; c < Math.min(m.channels, src.length); c++) {
          const ev = src[c];
          if (ev) row[c] = { note: ev[0], ins: ev[1], vol: ev[2], fx: ev[3] ? { code: ev[3], param: ev[4] } : null };
        }
        out.push(row);
      }
      return out;
    });
    return m;
  }

  /* 采样槽位：ST3 乐器号(1基) -> instruments 下标 */
  insSlot(n) { return (n >= 1 && n <= this.instruments.length) ? n - 1 : null; }

  rowCount(pat) { return this.patterns[pat] ? this.patterns[pat].length : 0; }
}

/* 便捷：把音符号(相对C4半音)显示成 C-4 / D#2 之类 */
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function fmtRel(note) {
  if (note === null || note === undefined) return "···";
  if (note === -1) return "OFF";
  if (note === -2) return "---";
  const o = Math.floor((note + 48) / 12);       // C4=0 -> 记为第4个八度
  const s = ((note % 12) + 12) % 12;
  return NOTE_NAMES[s] + "-" + o;
}
function fmtVol(v) { return v === null || v === undefined ? "···" : String(Math.round(v)).padStart(2, "0"); }
function fmtFx(fx) { return fx ? fx.code + fx.param.toString(16).toUpperCase().padStart(2, "0") : "···"; }
