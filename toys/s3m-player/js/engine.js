/* ============================================================
 * engine.js —— 移动端优先的追踪器播放引擎 (ScriptProcessor)
 * ------------------------------------------------------------
 * 修复记录：
 *  - 触发淡入(0.8ms)消除硬切咔哒
 *  - loop 接缝 crossfade 消除"恒定非音乐杂音"(循环终点↔起点不连续)
 *    低音循环采样(sample0/sample1 直流偏置大、接缝跳变上万)高速循环时
 *    每周期一次硬跳 → 听感为恒定高频伪音。用跨窗线性混合平滑。
 * ============================================================ */

"use strict";

var PERIOD_BASE = 1712 * 8363;    // C-4@8363Hz → period 1712
var ROWS = 64;
var MASTER_SCALE = 0.85;          // 主输出预缩放(提高以保留力度动态; 齐奏不再被压平)
var XFADE_SAMPLES = 32;           // loop 接缝 crossfade 长度(采样帧)，约 0.73ms@44.1k

function TrackerEngine(module, ctx, opts) {
  opts = opts || {};
  this.module = module;
  this.ctx = ctx;
  this._dataDir = "data/";

  this.masterGain = ctx.createGain();
  // 直流/次声高通：采样有直流偏置(+700/-1500)，循环/触发会生成恒定伪音。
  // 高通去掉 <30Hz 分量，不影响 60Hz+ 的真实 bass。(注: 低音补偿已取消)
  this.dcFilter = ctx.createBiquadFilter();
  this.dcFilter.type = "highpass";
  this.dcFilter.frequency.value = 30;
  this.dcFilter.Q.value = 0.5;
  this.masterGain.connect(this.dcFilter);
  this.dcFilter.connect(ctx.destination);

  this.sampleBuffers = [];
  this.sampleRates = [];
  this.node = null;
  this._prepared = false;

  this.semis = 0; this.cents = 0;
  this._speedMul = 1;
  this._gain = 0.9;
  this.muteMask = [];
  this.onRowChange = null;
  this.onStop = null;
  this.onLevels = null;

  this._initState();
}

TrackerEngine.prototype.setDataDir = function (d) {
  this._dataDir = d.replace(/\/$/, "") + "/";
};

TrackerEngine.prototype._initState = function () {
  var m = this.module;
  this.ch = m.channels;
  this.order = m.order;
  this.pat = m.patterns;
  this.speed = m.initSpeed || 6;
  this.tempo = m.initTempo || 125;
  this.globalVol = (m.globalVolume != null ? m.globalVolume : 64) / 64;

  this.playing = false;
  this.mode = "song";
  this.selPat = 0; this.startRow = 0; this.loop = true;
  this.orderPos = 0; this.curPat = this.order[0] || 0; this.curRow = 0;
  this.tickIndex = 0; this.tickLeft = 0; this.outFrame = 0;
  this.endedFlag = false;
  // 流程控制(B/C)跳转标记
  this.jumpOrder = -1;      // Bxx: 跳转到 order 位置(-1=无)
  this.breakRow = -1;       // Cxx: 跳转到行号(-1=无)

  this.v = [];
  for (var c = 0; c < this.ch; c++) {
    var pan = (m.pan[c] != null) ? (m.pan[c] / 15) * 2 - 1 : 0;
    this.v.push({
      slot: null, noteRel: null, vol: 0, p: 0, on: false, pos: 0,
      targetP: null, memD: 0, mute: false, fadeIn: 0,
      vibPos: 0, vibSpeed: 0, vibDepth: 0,
      gl: Math.cos((pan + 1) * Math.PI / 4),
      gr: Math.sin((pan + 1) * Math.PI / 4)
    });
  }
  this.gmem = {};
};

/* ---------- 采样解码 ---------- */
TrackerEngine.prototype.loadSamples = function () {
  var self = this;
  var urls = this.module.sampleFiles.map(function (f, i) {
    // 支持两种来源:
    //  - data:URL (上传文件解析出的内嵌 WAV)
    //  - 相对文件名 (默认曲目, 走 _dataDir)
    var url = (f && f.indexOf("data:") === 0) ? f : (self._dataDir + f);
    return fetch(url)
      .then(function (r) { return r.arrayBuffer(); })
      .then(function (buf) { return self.ctx.decodeAudioData(buf); })
      .then(function (ab) {
        self.sampleBuffers[i] = ab.getChannelData(0);
        self.sampleRates[i] = ab.sampleRate || 44100;
      });
  });
  return Promise.all(urls);
};

TrackerEngine.prototype._insMeta = function () {
  var self = this;
  return this.module.instruments.map(function (ins, i) {
    var k = (self.sampleRates[i] || 44100) / 44100;
    return {
      c2spd: ins.c2spd, volume: ins.volume, loop: ins.loop,
      length: Math.max(1, Math.round((ins.length || 0) * k)),
      loopStart: Math.round((ins.loopStart || 0) * k),
      loopEnd: Math.round((ins.loopEnd || 0) * k),
      xfade: 0
    };
  });
};

TrackerEngine.prototype.prepare = function () {
  if (this._prepared) return Promise.resolve();
  this.insMeta = this._insMeta();
  // 对每个可循环采样，若接缝不连续则启用 crossfade
  var self = this;
  for (var i = 0; i < this.insMeta.length; i++) {
    var im = this.insMeta[i];
    var b = this.sampleBuffers[i];
    if (im.loop && im.loopEnd > im.loopStart && b && b.length) {
      var s0 = b[im.loopStart], sEnd = b[im.loopEnd - 1];
      // 循环窗较短时缩短 xfade，避免占满整个窗
      var wl = im.loopEnd - im.loopStart;
      im.xfade = Math.max(4, Math.min(XFADE_SAMPLES, Math.floor(wl / 4)));
    }
  }
  var size = 4096;
  var node = this.ctx.createScriptProcessor(size, 0, 2);
  var self2 = this;
  node.onaudioprocess = function (e) { self2._render(e); };
  node.connect(this.masterGain);
  this.node = node;
  this._prepared = true;
  return Promise.resolve();
};

/* 采样读取（含 loop 接缝 crossfade）：
   返回 pos 处经平滑的值；若 pos 已越过 loopEnd 自动折回。 */
TrackerEngine.prototype._read = function (x, im, b, delta) {
  var le = im.loopEnd, ls = im.loopStart;
  var xf = im.xfade || 0;
  // 越界折回（跨窗用 while，兼容大 delta）
  while (x.pos >= le) {
    x.pos -= (le - ls);
    x.on = false;   // 若完全越界(单次样本)则关——由上层处理
  }
  if (xf > 0 && x.pos > le - xf) {
    // 距终点 < xf：读取尾部样本 + 循环开头样本 线性混合
    var t = (le - x.pos) / xf;               // 1(近终点起点)→0(近终点)
    var p1 = x.pos, p2 = x.pos - (le - ls);  // p2 在循环开头附近
    if (p2 < 0) p2 = 0;
    var i0 = p1 | 0, fr = p1 - i0;
    var j0 = p2 | 0, fq = p2 - j0;
    var i1 = (i0 + 1 < b.length) ? i0 + 1 : i0;
    var j1 = (j0 + 1 < b.length) ? j0 + 1 : j0;
    var vTail = b[i0] + (b[i1] - b[i0]) * fr;
    var vHead = b[j0] + (b[j1] - b[j0]) * fq;
    // t: 1→0, 权重 tail=t, head=1-t
    return vTail * t + vHead * (1 - t);
  }
  var i0 = x.pos | 0, fr = x.pos - i0;
  var i1 = (i0 + 1 < b.length) ? i0 + 1 : i0;
  return b[i0] + (b[i1] - b[i0]) * fr;
};

/* ---------- 控制 ---------- */
TrackerEngine.prototype.start = function (mode, pat, startRow, loop) {
  var self = this;
  if (!this._prepared) return this.prepare().then(function () { self.start(mode, pat, startRow, loop); });
  this.mode = mode || "song";
  this.selPat = (pat != null) ? pat : 0;
  this.startRow = startRow || 0;
  this.loop = (loop !== undefined) ? loop : true;
  this._seekStart();
  this.playing = true;
  this.endedFlag = false;
  this.tickLeft = 0;
  this.speed = this.module.initSpeed || 6;
  this.tempo = this.module.initTempo || 125;
  this._notifyRow();
  return Promise.resolve();
};
TrackerEngine.prototype._seekStart = function () {
  for (var i = 0; i < this.v.length; i++) {
    var x = this.v[i]; x.on = false; x.slot = null; x.p = 0; x.vol = 0; x.pos = 0;
  }
  this.orderPos = 0;
  if (this.mode === "pattern") { this.curPat = this.selPat; this.curRow = this.startRow; }
  else { this.curPat = this.order[0] != null ? this.order[0] : 0; this.curRow = 0; }
  this.tickIndex = 0;
};
TrackerEngine.prototype.pause = function () { this.playing = false; };
TrackerEngine.prototype.resume = function () {
  if (this.endedFlag) { this._seekStart(); this.endedFlag = false; this.speed = this.module.initSpeed || 6; this.tempo = this.module.initTempo || 125; }
  this.playing = true; this.tickLeft = 0; this._notifyRow();
};
TrackerEngine.prototype.stop = function () { this.playing = false; this._initState(); };
TrackerEngine.prototype.jump = function (pat, row) {
  this.curPat = pat; this.curRow = row || 0; this.tickIndex = 0; this.tickLeft = 0; this._notifyRow();
};

TrackerEngine.prototype.setPitch = function (semis, cents) {
  this.semis = semis; this.cents = cents;
  for (var i = 0; i < this.v.length; i++) {
    var x = this.v[i];
    if (x.on && x.slot != null) {
      var f = this._sampleFreq(x.slot, x.noteRel);
      x.p = f ? PERIOD_BASE / f : 0;
    }
  }
};
TrackerEngine.prototype.getPitch = function () { return [this.semis, this.cents]; };
TrackerEngine.prototype.setSpeedMul = function (mul) { this._speedMul = mul; };
TrackerEngine.prototype.setUserGain = function (g) { this._gain = g; };
TrackerEngine.prototype.setBassBoost = function (db) { /* 低音补偿已取消: 空操作 */ };
TrackerEngine.prototype.setChannelMuteAll = function (mask) {
  this.muteMask = mask || [];
  for (var i = 0; i < this.v.length; i++) this.v[i].mute = !!(this.muteMask[i]);
};

TrackerEngine.prototype._transpose = function () { return this.semis + this.cents / 100; };
TrackerEngine.prototype._sampleFreq = function (slot, rel) {
  var ins = this.module.instruments[slot];
  if (!ins) return 0;
  return ins.c2spd * Math.pow(2, (rel + this._transpose()) / 12);
};
TrackerEngine.prototype._rowCells = function () {
  return (this.pat[this.curPat] && this.pat[this.curPat][this.curRow]) || null;
};
TrackerEngine.prototype._notifyRow = function () {
  if (this.onRowChange) {
    try {
      var d = {
        timeSec: this.outFrame / this.ctx.sampleRate,
        orderPos: this.mode === "song" ? this.orderPos : -1,
        mode: this.mode
      };
      this.onRowChange(this.curPat, this.curRow, d);
    } catch (e) {}
  }
};

/* 颤音(Hxy)/颤音+音量滑(Kxy) —— ST3 语义:
   x = 速度(相位每 tick 步进), y = 深度(period 偏移幅度)
   参数为 0 时沿用记忆。用正弦表(64 相)调制 period。 */
var VIB_SIN = (function () {
  var t = [], i;
  for (i = 0; i < 64; i++) t.push(Math.sin(i / 64 * 2 * Math.PI));
  return t;
})();

TrackerEngine.prototype._doVibrato = function (c, speed, depth, volSlideParam) {
  var x = this.v[c];
  if (!x || !x.on) return;
  if (speed) x.vibSpeed = speed;
  if (depth) x.vibDepth = depth;
  x.vibPos = (x.vibPos + (x.vibSpeed || 0)) & 63;
  // 以触发音高为基准做偏移, 避免累积漂移
  var baseP = x.p;
  if (x.noteRel != null && x.slot != null) {
    var f = this._sampleFreq(x.slot, x.noteRel);
    baseP = f ? PERIOD_BASE / f : x.p;
  }
  x.p = baseP + VIB_SIN[x.vibPos] * (x.vibDepth || 0) * 4;
  if (volSlideParam) this._volSlide(c, volSlideParam, false);
};

TrackerEngine.prototype._volSlide = function (c, param, firstTick) {
  var x = this.v[c];
  if (!x) return;
  if (param) x.memD = param; else param = x.memD || 0;
  var up = param >> 4, dn = param & 0x0F;
  if (firstTick) {
    if (up > 0 && dn === 15) { x.vol = Math.min(64, x.vol + up); return; }
    if (up === 15 && dn > 0) { x.vol = Math.max(0, x.vol - dn); return; }
    if (up === 15 && dn === 0) { x.vol = Math.min(64, x.vol + 15); return; }
    if (up === 0 && dn === 15) { x.vol = Math.max(0, x.vol - 15); return; }
    return;
  }
  if (dn > 0) x.vol = Math.max(0, x.vol - dn);
  else if (up > 0) x.vol = Math.min(64, x.vol + up);
};

/* ---------- 行首 tick0 ---------- */
TrackerEngine.prototype._doRowStart = function () {
  var row = this._rowCells();
  if (!row) return;
  for (var c = 0; c < row.length && c < this.v.length; c++) {
    var ev = row[c];
    if (!ev) continue;
    var x = this.v[c];
    var fx = ev.fx;
    if (fx && fx.code === "A" && fx.param) this.speed = fx.param;
    if (fx && fx.code === "T" && fx.param >= 33) this.tempo = fx.param;
    if (fx && fx.code === "D") this._volSlide(c, fx.param, true);
    // 流程控制 B/C (S3M: 同一行多个只取第一个)
    if (fx && fx.code === "B" && this.jumpOrder < 0) this.jumpOrder = fx.param;
    if (fx && fx.code === "C" && this.breakRow < 0) {
      // Cxx: S3M 的 BCD 格式 (如 C24 = 第 24 行)
      this.breakRow = ((fx.param >> 4) * 10) + (fx.param & 0x0F);
    }

    var wantIns = (ev.ins && ev.ins >= 1 && ev.ins <= this.module.instruments.length) ? ev.ins - 1 : null;
    var offFrames = (fx && fx.code === "O") ? fx.param * 256 : 0;

    if (ev.vol != null && ev.vol >= 0 && ev.vol <= 64) x.vol = ev.vol;
    if (ev.note === -1) { x.on = false; x.p = 0; continue; }

    // 关键语义修正：
    //  音符归一化为“相对 C4 的半音”，可正可负(C2=-24, C4=0, C5=12)，
    //  因此“是否有真音符”不能用 >=0 判断，必须排除两个哨兵：
    //    -1 = Note Off ;  -2 = “---”(无音高, S3M 0xFF)
    //  -2 只换音色/音量、延续当前音高，绝不重触发、绝不该变频率
    //  (否则会把 -2 当音高重触发, 或把 C2 等负音高误判为无音符 → bass 全废)。
    if (ev.note != null && ev.note !== -1 && ev.note !== -2) {
      if (wantIns !== null) x.slot = wantIns;
      var isPorta = fx && fx.code === "G";
      if (isPorta && x.on && x.slot != null) {
        var tf = this._sampleFreq(x.slot, ev.note);
        x.targetP = tf ? PERIOD_BASE / tf : x.p;
        if (fx.param) this.gmem[c] = fx.param;
        continue;
      }
      if (x.slot == null) continue;
      x.noteRel = ev.note;
      var f = this._sampleFreq(x.slot, ev.note);
      x.p = f ? PERIOD_BASE / f : 0;
      x.targetP = null;
      var im = this.insMeta[x.slot];
      var maxf = im ? Math.max(0, im.length - 1) : 0;
      x.pos = Math.min(offFrames, maxf);
      x.on = true;
      x.fadeIn = 1;
      // 音量(关键，同时支持 P2 D 渐强 与 打击重音):
      //  带音量列 → 用音量列值。
      //  无音量列 →
      //    本行【带乐器号(Ix)】= 明确的新起音(如打击"打" I4 重触发) → 重置为采样默认音量
      //    本行【不带乐器号】 = 沿用/延音触发(如 G#5 每行无I) → 保留当前音量
      //      这样 G#5 的 D 渐强(2→…→52)能累积, 而"打"每次 I4 起音都够响。
      if (ev.vol == null && wantIns !== null) {
        x.vol = im ? im.volume : 0;
      }
      continue;
    }

    // note === -2 ("---", 无音高,S3M 0xFF) 或 null：以“当前音高”从采样头重触发。
    // ST3 语义：--- + 乐器号 = 沿用上一音高 retrigger；重触发会把音量重置为
    // 采样默认音量(除非本行带音量列)。这产生“力度一大一小”的脉冲：
    //   真音符触发(V默认64) → V10 压弱 → ---Ix 重触发(重置回64) → V10 压弱 → …
    // 这就是 bass 的脉冲律动来源(原曲中明显)，缺失则 bass 平淡无力。
    // 绝不重算频率(避免把 -2 当音高 → 40kHz 纯音 bug)。
    if (wantIns !== null) {
      if (x.on && x.slot != null && x.noteRel != null) {
        x.slot = wantIns;          // 换采样(或同采样)
        x.pos = 0;                 // 从采样头重触发 → 起音/脉冲
        x.fadeIn = 1;              // 极短淡入防咔哒
        if (ev.vol == null) {
          // 无音量列 → 重置为采样默认音量(产生 V64↔V10 的力度交替脉冲)
          var im2 = this.insMeta ? this.insMeta[x.slot] : null;
          if (im2) x.vol = im2.volume;
        }
      } else {
        // 当前没发声/没音高：只记录音色，等后续真实音符
        x.slot = wantIns;
        x.on = false;
      }
    }
  }
};

TrackerEngine.prototype._doTick = function () {
  var row = this._rowCells();
  if (!row) return;
  for (var c = 0; c < row.length && c < this.v.length; c++) {
    var ev = row[c];
    if (!ev || !ev.fx) continue;
    var x = this.v[c];
    if (!x.on) continue;
    var code = ev.fx.code, param = ev.fx.param;
    if (code === "G" && param) this.gmem[c] = param;
    if (code === "D") this._volSlide(c, param, false);
    else if (code === "H") this._doVibrato(c, param >> 4, param & 0x0F, 0);
    else if (code === "K") this._doVibrato(c, param >> 4, param & 0x0F, param);
    else if (code === "E") { if (param < 0xE0) x.p += 4 * param; }
    else if (code === "F") { if (param < 0xE0) x.p = Math.max(0.01, x.p - 4 * param); }
    else if (code === "G") {
      if (x.targetP != null) {
        var sp = param || this.gmem[c] || 0;
        if (sp) {
          if (Math.abs(x.p - x.targetP) <= sp) x.p = x.targetP;
          else x.p += (x.targetP > x.p ? 1 : -1) * sp;
        }
      }
    }
  }
};

TrackerEngine.prototype._advanceRow = function () {
  this.tickIndex = 0;

  // ---- 流程控制 B/C (仅 song 模式; pattern 单段循环模式忽略) ----
  if (this.mode === "song" && (this.jumpOrder >= 0 || this.breakRow >= 0)) {
    var targetOrder = (this.jumpOrder >= 0) ? this.jumpOrder : (this.orderPos + 1);
    var targetRow = (this.breakRow >= 0) ? this.breakRow : 0;
    this.jumpOrder = -1; this.breakRow = -1;

    if (targetOrder >= this.order.length) { this._endSong(); return; }
    // order 里遇到 0xFF(歌尾) 或 0xFE(marker) 也结束/跳过
    var op = targetOrder;
    while (op < this.order.length && this.order[op] === 0xFE) op++;
    if (op >= this.order.length || this.order[op] === 0xFF) { this._endSong(); return; }

    this.orderPos = op;
    this.curPat = this.order[op];
    this.curRow = Math.min(targetRow, ROWS - 1);
    this._notifyRow();
    return;
  }

  if (this.curRow + 1 >= ROWS) {
    if (this.mode === "pattern") {
      if (this.loop) this.curRow = this.startRow;
      else { this._endSong(); return; }
    } else if (this.orderPos + 1 < this.order.length) {
      this.orderPos++;
      // 跳过 marker(0xFE), 遇到 0xFF(歌尾) 结束
      while (this.orderPos < this.order.length && this.order[this.orderPos] === 0xFE) this.orderPos++;
      if (this.orderPos >= this.order.length || this.order[this.orderPos] === 0xFF) {
        if (this.loop) { this.orderPos = 0; this.curPat = this.order[0] != null ? this.order[0] : 0; this.curRow = 0; this._notifyRow(); return; }
        this._endSong(); return;
      }
      this.curPat = this.order[this.orderPos]; this.curRow = 0;
    } else if (this.loop) {
      this.orderPos = 0; this.curPat = this.order[0] != null ? this.order[0] : 0; this.curRow = 0;
    } else { this._endSong(); return; }
  } else this.curRow++;
  this._notifyRow();
};
TrackerEngine.prototype._endSong = function () {
  this.playing = false; this.endedFlag = true;
  if (this.onStop) { try { this.onStop(); } catch (e) {} }
};
TrackerEngine.prototype._fpt = function () {
  return Math.max(1, this.ctx.sampleRate * 2.5 / (this.tempo * this._speedMul));
};

TrackerEngine.prototype._render = function (e) {
  var L = e.outputBuffer.getChannelData(0);
  var R = e.outputBuffer.getChannelData(1);
  var n = L.length;
  var playing = this.playing;
  var i, c;
  if (!playing) { for (i = 0; i < n; i++) { L[i] = 0; if (R !== L) R[i] = 0; } return; }
  var v = this.v, insMeta = this.insMeta, buf = this.sampleBuffers;
  var sr = this.ctx.sampleRate;
  var gVol = this.globalVol, uGain = this._gain * MASTER_SCALE;
  var nch = v.length;
  var perio = PERIOD_BASE;

  if (!this._vuAcc) this._vuAcc = new Array(nch).fill(0);
  var vuAcc = this._vuAcc;
  this._vuN = (this._vuN || 0) + n;
  var vuPeriod = Math.round(sr * 0.12);
  var vuDirty = false;

  for (i = 0; i < n; i++) {
    if (this.tickLeft <= 0) {
      if (this.tickIndex === 0) this._doRowStart(); else this._doTick();
      this.tickIndex++;
      if (this.tickIndex >= this.speed) this._advanceRow();
      this.tickLeft = this._fpt();
    }
    var sl = 0, srsum = 0;
    for (c = 0; c < nch; c++) {
      var x = v[c];
      if (!x.on || x.mute || x.slot == null) continue;
      var b = buf[x.slot];
      if (!b || !b.length) continue;
      var im = insMeta[x.slot];
      if (!im) continue;
      var amp = (x.vol / 64) * gVol * uGain;
      if (amp < 0.0008) continue;
      var rate = this.sampleRates[x.slot] || sr;
      var delta = (x.p ? perio / x.p : 0) / rate;
      var isLoop = im.loop && im.loopEnd > im.loopStart;
      var le = isLoop ? im.loopEnd : im.length;
      if (x.pos < 0) x.pos = 0;
      if (!isLoop && x.pos >= le) { x.on = false; continue; }

      // 读取（含 crossfade 与循环折回）
      var s = 0;
      if (isLoop) {
        // 先处理越界
        while (x.pos >= le) x.pos -= (le - im.loopStart);
        if (x.pos < im.loopStart) x.pos = im.loopStart;
        // crossfade 仅用于低频(实际基频 < LOW_XF) → 平滑 bass 脉冲并去接缝伪音；
        // 高频主旋律不启用，避免糊化音色(同采样高低音差异: bass C2 delta小, 高频 delta大 覆盖循环窗比例高)
        var LOW_XF = 100;   // Hz: 仅 <100Hz(即真正 bass C2≈66Hz)启用 crossfade; 主旋律 C3(133Hz)+ 全关保锐利
        var fundHz = (x.p ? perio / x.p : 0) / (le - im.loopStart);
        var xf = (fundHz < LOW_XF) ? (im.xfade || 0) : 0;
        if (xf > 0 && x.pos > le - xf) {
          var t = (le - x.pos) / xf;
          if (t < 0) t = 0; if (t > 1) t = 1;
          var p2 = x.pos - (le - im.loopStart);
          var q0 = (p2 < 0) ? 0 : (p2 | 0);
          var fq = p2 - q0;
          var q1 = (q0 + 1 < b.length) ? q0 + 1 : q0;
          var i0 = x.pos | 0, fr = x.pos - i0;
          var i1 = (i0 + 1 < b.length) ? i0 + 1 : i0;
          var vTail = b[i0] + (b[i1] - b[i0]) * fr;
          var vHead = b[q0] + (b[q1] - b[q0]) * fq;
          s = vTail * t + vHead * (1 - t);
        } else {
          var i0 = x.pos | 0, fr = x.pos - i0;
          var i1 = (i0 + 1 < b.length) ? i0 + 1 : i0;
          s = b[i0] + (b[i1] - b[i0]) * fr;
        }
      } else {
        var i0 = x.pos | 0, fr = x.pos - i0;
        var i1 = (i0 + 1 < b.length) ? i0 + 1 : i0;
        s = b[i0] + (b[i1] - b[i0]) * fr;
      }

      if (x.fadeIn > 0) {
        s *= (1 - x.fadeIn);
        x.fadeIn -= 1 / (sr * 0.0008);
        if (x.fadeIn < 0) x.fadeIn = 0;
      }
      sl += s * x.gl * amp;
      srsum += s * x.gr * amp;
      var se = (s > 0 ? s : -s);
      if (se > vuAcc[c]) vuAcc[c] = se;
      vuDirty = true;
      x.pos += delta;
      if (!isLoop && x.pos >= le) x.on = false;
    }
    var CLIP = 0.95;   // 提高限幅门限: 保留音量渐强与脉冲力度动态(过低的CLIP会把齐奏动态压平)
    var ax = sl < 0 ? -sl : sl;
    if (ax > CLIP) sl = (sl > 0 ? 1 : -1) * (CLIP + (ax - CLIP) / (1 + (ax - CLIP)));
    ax = srsum < 0 ? -srsum : srsum;
    if (ax > CLIP) srsum = (srsum > 0 ? 1 : -1) * (CLIP + (ax - CLIP) / (1 + (ax - CLIP)));
    L[i] = sl; R[i] = srsum;
    this.tickLeft -= 1; this.outFrame += 1;
  }
  if (vuDirty && this._vuN >= vuPeriod) {
    if (this.onLevels) { try { this.onLevels(vuAcc.slice()); } catch (e) {} }
    this._vuN = 0;
    for (c = 0; c < nch; c++) vuAcc[c] = 0;
  }
};
