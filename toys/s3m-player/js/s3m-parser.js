/* ============================================================
 * s3m-parser.js —— 浏览器端 S3M 解析器
 * ------------------------------------------------------------
 * 把 .s3m 字节流解析成引擎可直接播放的 TrackerModule 形状：
 *   { channels, pan, order, patterns, instruments, sampleFiles, ... }
 * 采样以 data:URL(内嵌 WAV) 提供，无需服务器文件。
 *
 * 解析进度通过 onProgress(step, pct) 回调，供 UI 显示。
 * 兼容性要点(与 tools/extract.py 保持一致):
 *   - 空采样槽位(type=0/无 SCRS): 生成静音占位, 保持乐器号 1:1 对齐
 *   - 空 pattern(parapointer=0): 返回 64 行空
 *   - 8/16bit、单声道/立体声、ADPCM(暂不支持, 跳过)
 * ============================================================ */
"use strict";

const S3MParser = (function () {

  function u8(d, o) { return d[o]; }
  function u16(d, o) { return d[o] | (d[o + 1] << 8); }
  function u32(d, o) { return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0; }

  function str(d, o, n) {
    var s = "", i;
    for (i = 0; i < n; i++) { var c = d[o + i]; if (c === 0) break; s += String.fromCharCode(c); }
    return s;
  }

  /* 生成 WAV 字节(16bit PCM mono) */
  function makeWav(samples16, rate) {
    var n = samples16.length;
    var buf = new ArrayBuffer(44 + n * 2);
    var v = new DataView(buf);
    var w = 0;
    function wstr(s) { for (var i = 0; i < s.length; i++) v.setUint8(w++, s.charCodeAt(i)); }
    function wu32(x) { v.setUint32(w, x, true); w += 4; }
    function wu16(x) { v.setUint16(w, x, true); w += 2; }
    wstr("RIFF"); wu32(36 + n * 2); wstr("WAVE");
    wstr("fmt "); wu32(16); wu16(1); wu16(1); wu32(rate); wu32(rate * 2); wu16(2); wu16(16);
    wstr("data"); wu32(n * 2);
    for (var i = 0; i < n; i++) { v.setInt16(w, samples16[i], true); w += 2; }
    return buf;
  }

  function toDataURL(arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer);
    var bin = "";
    var CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return "data:audio/wav;base64," + btoa(bin);
  }

  /* 主解析入口
     data: ArrayBuffer
     onProgress: function(stepText, percent)  —— 可选
     返回 Promise<TrackerModule 形状的对象> */
  function parse(arrayBuffer, onProgress) {
    return new Promise(function (resolve, reject) {
      var d = new Uint8Array(arrayBuffer);
      // 让出主线程的小工具: 使进度条/状态能真正刷新
      function yieldUI() { return new Promise(function (r) { setTimeout(r, 0); }); }
      var _prog = onProgress || function () {};
      var _pendingProg = null;
      function prog(text, pct) { _pendingProg = [text, pct]; }

      (async function () {
      try {
        // --- 1. 头部 ---
        prog("读取文件头…", 5);
        if (str(d, 44, 4) !== "SCRM") throw new Error("不是有效的 S3M 文件（缺少 SCRM 标识）");
        var title = str(d, 0, 28);
        var ordNum = u16(d, 32), smpNum = u16(d, 34), patNum = u16(d, 36);
        var cwtv = u16(d, 40);
        var globalVol = u8(d, 48), initSpeed = u8(d, 49), initTempo = u8(d, 50);
        var masterVol = u8(d, 51);
        var chSettings = d.subarray(64, 96);
        var orderRaw = [];
        for (var i = 0; i < ordNum; i++) orderRaw.push(d[96 + i]);
        var order = [];
        for (var i2 = 0; i2 < orderRaw.length; i2++) {
          if (orderRaw[i2] === 0xFF) break;
          order.push(orderRaw[i2]);   // 0xFE marker 保留, 播放时跳过
        }

        // 指针表
        var p = 96 + ordNum;
        var insPara = [], patPara = [];
        for (var s = 0; s < smpNum; s++) insPara.push(u16(d, p + s * 2));
        p += smpNum * 2;
        for (var t = 0; t < patNum; t++) patPara.push(u16(d, p + t * 2));
        p += patNum * 2;

        // pan 表(32字节) 与通道
        var panRaw = [];
        for (var q = 0; q < 32; q++) panRaw.push(d[p + q]);
        var usedCh = [], NCH = 0;
        for (var c = 0; c < 32; c++) { if (chSettings[c] !== 255) { usedCh.push(c); NCH = c + 1; } }
        if (NCH === 0) NCH = 8;
        var pan = [];
        for (var pc = 0; pc < NCH; pc++) {
          var b = panRaw[pc];
          pan.push((b !== 0xFF) ? (b & 0x0F) : 8);
        }

        prog("解析采样头…", 20); _prog.apply(null,_pendingProg); await yieldUI();
        // --- 2. 采样 ---
        var instruments = [], sampleFiles = [];
        var pendingSamples = [];   // {index, sampPara, length, flags, c2spd, raw}
        for (var si = 0; si < smpNum; si++) {
          var o = insPara[si] * 16;
          if (o + 80 > d.length) {   // 越界保护
            instruments.push({ index: si, file: "", title: "", volume: 64, c2spd: 8363,
              loop: false, loopStart: 0, loopEnd: 0, length: 0, empty: true });
            sampleFiles.push(null);
            continue;
          }
          var typ = d[o];
          var fname = str(d, o + 1, 12);
          var sampPara = (d[o + 13] << 16) | u16(d, o + 14);
          var length = u32(d, o + 16);
          var loopStart = u32(d, o + 20), loopEnd = u32(d, o + 24);
          var volume = d[o + 28];
          var pack = d[o + 30];
          var sflags = d[o + 31];
          var c2spd = u32(d, o + 32) || 8363;
          var smpTitle = str(d, o + 48, 28);
          var sig = str(d, o + 76, 4);
          var isPCM = (typ === 1) && length > 0 && sampPara > 0;

          instruments.push({
            index: si, file: fname, title: smpTitle, volume: volume, c2spd: c2spd,
            loop: !!(sflags & 1), loopStart: loopStart, loopEnd: loopEnd,
            length: isPCM ? length : 0, empty: !isPCM,
            _is16: !!(sflags & 4), _stereo: !!(sflags & 2), _pack: pack
          });
          if (isPCM) {
            pendingSamples.push({ index: si, sampPara: sampPara, length: length,
              flags: sflags, c2spd: c2spd, pack: pack });
          }
          sampleFiles.push(null);   // 稍后填充 data URL
        }

        // --- 3. 采样波形 → WAV data URL ---
        prog("解码采样波形…", 35); _prog.apply(null,_pendingProg); await yieldUI();
        var doneCount = 0;
        for (var ps = 0; ps < pendingSamples.length; ps++) {
          var sm = pendingSamples[ps];
          var start = sm.sampPara * 16;
          var rawLen = sm.length;
          var is16 = !!(sm.flags & 4), stereo = !!(sm.flags & 2);
          if (sm.pack === 1) { sampleFiles[sm.index] = null; continue; }  // ADPCM 暂不支持
          var avail = Math.max(0, Math.min(rawLen, d.length - start));
          var samples16 = [];
          if (is16) {
            var cnt = Math.floor(avail / 2);
            for (var k = 0; k < cnt; k++) {
              var lo = d[start + k * 2], hi = d[start + k * 2 + 1];
              var val = (hi << 8) | lo; if (val >= 32768) val -= 65536;
              samples16.push(val);
            }
          } else {
            for (var k2 = 0; k2 < avail; k2++) {
              samples16.push((d[start + k2] - 128) * 256);
            }
          }
          // 统一写 44100Hz: 引擎用 delta = freq/sampleRate 与 loop 按 sampleRate/44100 换算,
          // 均以 WAV 写为 44100 为前提(与 tools/extract.py 一致), 否则音高/循环会错。
          sampleFiles[sm.index] = toDataURL(makeWav(samples16, 44100));
          doneCount++;
          if (doneCount % 4 === 0) {
            prog("解码采样波形… (" + doneCount + "/" + pendingSamples.length + ")",
                 35 + Math.round(doneCount / Math.max(1, pendingSamples.length) * 25));
            _prog.apply(null, _pendingProg);
            await yieldUI();
          }
        }
        // 空槽位补静音
        for (var e = 0; e < sampleFiles.length; e++) {
          if (!sampleFiles[e]) sampleFiles[e] = toDataURL(makeWav([0], 44100));
        }

        prog("解析 pattern…", 62); _prog.apply(null,_pendingProg); await yieldUI();
        // --- 4. Pattern 解码 ---
        var patterns = [];
        for (var pi = 0; pi < patNum; pi++) {
          var rows = decodePattern(d, patPara[pi], NCH);
          patterns.push(rows);
          if (pi % 8 === 0) {
            prog("解析 pattern… (" + (pi + 1) + "/" + patNum + ")",
                 62 + Math.round((pi + 1) / Math.max(1, patNum) * 33));
            _prog.apply(null, _pendingProg);
            await yieldUI();
          }
        }

        prog("完成", 100); _prog.apply(null, _pendingProg);
        var module = {
          format: "S3M",
          title: title || "（无标题）",
          madeBy: "", tracker: "S3M (cwtv=0x" + cwtv.toString(16) + ")",
          date: "",
          channels: NCH, pan: pan, order: order,
          patterns: patterns,
          instruments: instruments,
          sampleFiles: sampleFiles,
          initSpeed: initSpeed || 6,
          initTempo: initTempo || 125,
          globalVolume: globalVol || 64,
          comment: []
        };
        resolve(module);

      } catch (err) {
        reject(err);
      }
      })();
    });
  }

  /* pattern 解码: 返回 64 行 × NCH 列, 每格 {note,ins,vol,fx:{code,param}} 或 null
     note: 相对 C4 半音(可负) | -1=note off | -2=无音高 | null=无 */
  function decodePattern(d, para, NCH) {
    var empty = [];
    for (var r0 = 0; r0 < 64; r0++) empty.push(new Array(NCH).fill(null));
    if (para === 0) return empty;                 // 空 pattern
    var off = para * 16;
    if (off + 2 > d.length) return empty;

    var pos = off + 2;                            // 跳过 2 字节长度字段
    var rows = [];
    for (var r = 0; r < 64; r++) {
      var cells = new Array(NCH).fill(null);
      while (true) {
        if (pos >= d.length) { rows.push(cells); return rows; }   // 越界保护
        var info = d[pos++];
        if (info === 0) break;
        var ch = info & 0x1F;
        if (ch >= NCH) ch = NCH - 1;
        var note = null, ins = null, vol = null, ec = null, ep = null;
        if (info & 0x20) {
          var nb = d[pos], inb = d[pos + 1]; pos += 2;
          ins = inb;
          if (nb === 0xFE) note = -1;
          else if (nb === 0xFF) note = -2;
          else note = ((nb >> 4) - 4) * 12 + (nb & 0x0F);
        }
        if (info & 0x40) { vol = d[pos++]; }
        if (info & 0x80) {
          var c = d[pos], pa = d[pos + 1]; pos += 2;
          ec = (c > 0 && c < 27) ? String.fromCharCode(0x40 + c) : (c === 0 ? "@" : "?");
          ep = pa;
        }
        cells[ch] = { note: note, ins: ins, vol: vol,
          fx: (ec !== null) ? { code: ec, param: ep } : null };
      }
      rows.push(cells);
    }
    return rows;
  }

  return { parse: parse };
})();
