/* ============================================================
   镜花拾光 · main.js —— 兼容 IE6（JScript 5.6，ES3 语法）
   铁律：只能用 var / function / 字符串拼接，
   不能用 const / let / 箭头函数 / 模板字符串 / addEventListener

   注意：这个文件同时被 index.html 和 music.html 引用。
   点唱机相关函数只在 music.html 里生效（有 bgm-holder 才运行）。
   ============================================================ */

/* ---------- 1. 点唱机 ---------- */
/* ★ 改这里：你的歌单（name 显示名，src 放 media/ 目录下的 mp3） */
var tracks = [
  { name: '示例曲目一（替换成你的歌）', src: 'media/music1.mp3' },
  { name: '示例曲目二（替换成你的歌）', src: 'media/music2.mp3' },
  { name: '示例曲目三（替换成你的歌）', src: 'media/music3.mp3' }
];

var currentTrack = 0;   /* 当前曲目下标 */
var isPlaying = false;  /* 是否播放中 */

/* 在 IE6 上重建 <bgsound>：直接改 src 在 IE 里不总是生效，重建最稳 */
function setBgm(src) {
  var holder = document.getElementById('bgm-holder');
  if (!holder) { return; }   /* 首页没有点唱机，直接跳过 */
  var old = document.getElementById('bgm');
  if (old) { holder.removeChild(old); }
  if (src) {
    var b = document.createElement('bgsound');
    b.id = 'bgm';
    b.src = src;
    b.loop = 'infinite';
    holder.appendChild(b);
  }
}

/* 高亮曲目列表里的当前项 */
function highlightTrack() {
  var list = document.getElementById('track-list');
  if (!list) { return; }
  var links = list.getElementsByTagName('a');
  for (var i = 0; i < links.length; i++) {
    if (i === currentTrack) { links[i].className = 'track-link playing'; }
    else { links[i].className = 'track-link'; }
  }
}

/* 切到第 i 首并播放（HTML 里 onclick="pickTrack(0)" 调用） */
function pickTrack(i) {
  if (!document.getElementById('bgm-holder')) { return; }   /* 只在点唱机页生效 */
  currentTrack = i;
  setBgm(tracks[i].src);
  isPlaying = true;
  document.getElementById('play-btn').value = '暂停';
  document.getElementById('track-marquee').innerHTML = '♪ 正在播放：' + tracks[i].name + ' ♪';
  highlightTrack();
}

function nextTrack() {
  var i = currentTrack + 1;
  if (i >= tracks.length) { i = 0; }
  pickTrack(i);
}

function prevTrack() {
  var i = currentTrack - 1;
  if (i < 0) { i = tracks.length - 1; }
  pickTrack(i);
}

function togglePlay() {
  if (!document.getElementById('bgm-holder')) { return; }
  if (isPlaying) {
    setBgm('');   /* 清空即停止 */
    isPlaying = false;
    document.getElementById('play-btn').value = '播放';
    document.getElementById('track-marquee').innerHTML = '已暂停…点一下继续';
  } else {
    setBgm(tracks[currentTrack].src);
    isPlaying = true;
    document.getElementById('play-btn').value = '暂停';
    document.getElementById('track-marquee').innerHTML = '♪ 正在播放：' + tracks[currentTrack].name + ' ♪';
  }
}

/* ---------- 2. 实时时钟 ---------- */
function pad(n) { return (n < 10) ? '0' + n : '' + n; }

function updateClock() {
  var now = new Date();
  var s = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate()
    + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
  var el = document.getElementById('clock');
  if (el) { el.innerHTML = s; }
}
setInterval(updateClock, 1000);

/* ---------- 3. 建站天数（★ 改成你的建站日期：月份从 0 开始，7 = 八月） ---------- */
function updateDays() {
  var el = document.getElementById('runningDays');
  if (!el) { return; }
  var start = new Date(2026, 7, 23);
  var diff = new Date() - start;
  var days = Math.floor(diff / (1000 * 60 * 60 * 24));
  el.innerHTML = days;
}
updateDays();

/* ---------- 4. 今日运势（随机） ---------- */
var fortunes = ['大吉', '中吉', '小吉', '吉', '末吉', '大凶（才怪）'];
var fEl = document.getElementById('fortune');
if (fEl) { fEl.innerHTML = fortunes[Math.floor(Math.random() * fortunes.length)]; }

/* ---------- 5. 彩虹标题 + 闪烁星（IE6 没有 CSS 动画，用 JS 模拟） ---------- */
var rainbowColors = ['#FF0000', '#FF9900', '#FFFF00', '#00FF00', '#0099FF', '#9900FF'];
var rc = 0;
setInterval(function () {
  var el = document.getElementById('rainbow-text');
  if (el) {
    el.style.color = rainbowColors[rc];
    rc = (rc + 1) % rainbowColors.length;
  }
}, 300);

var sparkleOn = true;
setInterval(function () {
  sparkleOn = !sparkleOn;
  var spans = document.getElementsByTagName('span');
  for (var i = 0; i < spans.length; i++) {
    if (spans[i].className === 'sparkle') {
      spans[i].style.visibility = sparkleOn ? 'visible' : 'hidden';
    }
  }
}, 500);

/* 注意：自动播放不在 main.js 里执行了，
   改由 music.html 底部自行调用 pickTrack(0)，这样首页不会自动出声。 */
