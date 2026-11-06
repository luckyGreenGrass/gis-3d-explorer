/* 足迹 · 三维周边探索 —— Cesium Ion 版
 * 三维数据：Cesium Ion（世界地形 + OSM 建筑）
 * 地名搜索：Ion Geocode 优先，OSM / Photon 兜底
 * 所有请求带超时；搜索状态与接口自检结果直接显示在页面上，无需打开控制台。
 */
'use strict';

window.CESIUM_BASE_URL = 'https://cesium.com/downloads/cesiumjs/releases/1.132/Build/Cesium/';

const TOKEN_KEY = 'cesium_ion_token';
const APP_VERSION = 'v3.0';
// Ion 的 Pelias 地理编码：路径 /v1/geocode/search，参数 text + access_token
const ION_GEOCODE_BASE = 'https://api.cesium.com/v1/geocode/';
// 备用源：OSM / Photon，免 Token
const PHOTON_GEOCODE_URL = 'https://photon.komoot.io/api/';
// 请求均带超时；失败会自动切换下一个搜索源

let viewer = null;
let currentToken = null;
let currentPlace = null;   // { name, lon, lat }
let entities = [];         // 当前标注（点 + 范围圈）
let searchTimer = null;
let searchSeq = 0;         // 丢弃过期请求的结果
let statusTimer = null;
let photoCartesian = null; // 照片拍摄点的世界坐标（用于引线跟随）
let photoObjectUrl = null; // 缩略图的本地 URL，切换照片时释放

/* ---------------- DOM ---------------- */
const tokenGate = document.getElementById('tokenGate');
const tokenInput = document.getElementById('tokenInput');
const tokenBtn = document.getElementById('tokenBtn');
const tokenError = document.getElementById('tokenError');
const uiPanel = document.getElementById('uiPanel');
const searchInput = document.getElementById('searchInput');
const resultsBox = document.getElementById('results');
const statusBar = document.getElementById('statusBar');
const diagBtn = document.getElementById('diagBtn');
const diagPanel = document.getElementById('diagPanel');
const diagClose = document.getElementById('diagClose');
const diagBody = document.getElementById('diagBody');
const infoCard = document.getElementById('infoCard');
const placeNameEl = document.getElementById('placeName');
const placeCoordsEl = document.getElementById('placeCoords');
const closeInfoBtn = document.getElementById('closeInfo');
const radiusGroup = document.getElementById('radiusGroup');
const loadingTip = document.getElementById('loadingTip');

/* 照片定位相关 DOM */
const photoBtn = document.getElementById('photoBtn');
const photoPanel = document.getElementById('photoPanel');
const photoPanelClose = document.getElementById('photoPanelClose');
const pickPhotoBtn = document.getElementById('pickPhotoBtn');
const samplePhotoBtn = document.getElementById('samplePhotoBtn');
const photoInput = document.getElementById('photoInput');
const photoMsg = document.getElementById('photoMsg');
const dropZone = document.getElementById('dropZone');
const dropHint = document.getElementById('dropHint');
const leaderSvg = document.getElementById('leaderSvg');
const leaderPath = document.getElementById('leaderPath');
const leaderDot = document.getElementById('leaderDot');
const photoAnchor = document.getElementById('photoAnchor');
const photoCard = document.getElementById('photoCard');
const photoCardClose = document.getElementById('photoCardClose');
const photoThumb = document.getElementById('photoThumb');
const photoMeta = document.getElementById('photoMeta');
const photoCoords = document.getElementById('photoCoords');

/* ---------------- 页面内状态条 ---------------- */
function setStatus(msg, kind) {
  statusBar.textContent = msg;
  statusBar.className = 'status-bar' + (kind ? ' ' + kind : '');
  statusBar.classList.remove('hidden');
  clearTimeout(statusTimer);
  if (kind !== 'error') {
    statusTimer = setTimeout(() => statusBar.classList.add('hidden'), 7000);
  }
}

// 脚本错误也直接显示在页面上，不再需要 F12 控制台
window.addEventListener('error', (e) => {
  if (e && e.message) setStatus('页面脚本错误：' + e.message, 'error');
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e && e.reason;
  setStatus('异步错误：' + String((reason && reason.message) || reason || '未知'), 'error');
});

/* ---------------- 带超时的请求 ---------------- */
async function fetchJsonWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    let body = null;
    try { body = JSON.parse(await resp.text()); } catch (_) { /* 非 JSON */ }
    return { ok: resp.ok, status: resp.status, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err && err.name === 'AbortError'
        ? ('超过 ' + ms / 1000 + ' 秒无响应')
        : String((err && err.message) || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function resultText(r) {
  if (r.status === 0) return '网络失败 / ' + r.error;
  const msg = r.body && (r.body.message || r.body.code);
  return 'HTTP ' + r.status + (msg ? ' · ' + msg : '');
}

function hasFeatures(r) {
  return !!(r.ok && r.body && (r.body.features || []).length);
}

/* ---------------- Token 门 ---------------- */
tokenBtn.addEventListener('click', submitToken);
tokenInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitToken();
});

function submitToken() {
  const token = tokenInput.value.trim();
  if (!token) {
    tokenError.textContent = '请先粘贴 Token。';
    return;
  }
  bootWithToken(token)
    .then(() => localStorage.setItem(TOKEN_KEY, token))
    .catch((err) => {
      console.error(err);
      tokenError.textContent =
        'Token 校验失败，请确认已复制完整 Token 且账号有效。';
    });
}

async function bootWithToken(token) {
  loadingTip.textContent = '正在加载三维数据…';
  loadingTip.classList.remove('hidden');
  currentToken = token;
  Cesium.Ion.defaultAccessToken = token;

  if (!viewer) {
    viewer = new Cesium.Viewer('cesiumContainer', {
      animation: false,
      timeline: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      baseLayerPicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
    });
    viewer.scene.globe.enableLighting = true;
    viewer.scene.globe.depthTestAgainstTerrain = true;

    // 影像/地形瓦片在国内网络下可能要等十几秒，期间 globe 只是一片纯色，
    // 很容易被误认为"页面坏了"。这里把加载进度直接显示在页面上。
    viewer.scene.globe.tileLoadProgressEvent.addEventListener((pending) => {
      if (pending > 0) {
        loadingTip.textContent = '正在加载影像 / 地形瓦片…（剩余 ' + pending + '）';
        loadingTip.classList.remove('hidden');
      } else {
        loadingTip.classList.add('hidden');
      }
    });

    // 照片缩略图卡片随相机运动实时跟随锚点
    viewer.scene.postRender.addEventListener(updatePhotoOverlay);
  }

  // 用"世界地形 + OSM 建筑"来验证 Token 是否有效
  try {
    viewer.terrainProvider = await Cesium.createWorldTerrainAsync();
    // enableShowOutline:false 从加载阶段就不生成轮廓几何，避免 Cesium 输出
    // "Primitive outlines disable imagery draping" 并跳过影像贴合。
    // （只在创建后设 showOutline=false 太晚，轮廓 primitive 已经建好了）
    const buildings = await Cesium.createOsmBuildingsAsync({
      enableShowOutline: false,
      showOutline: false,
    });
    viewer.scene.primitives.add(buildings);
  } catch (err) {
    loadingTip.classList.add('hidden');
    throw err;
  }

  loadingTip.classList.add('hidden');
  tokenGate.classList.add('hidden');
  uiPanel.classList.remove('hidden');
  searchInput.focus();
  setStatus('就绪 · 搜索已启用（' + APP_VERSION + '）', 'ok');

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(105, 32, 9_000_000),
  });
}

/* ---------------- 搜索 ---------------- */
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) {
    hideResults();
    return;
  }
  setStatus('输入中，即将搜索「' + q + '」…');
  searchTimer = setTimeout(() => doSearch(q), 450);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideResults();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(searchTimer);
    const first = resultsBox.querySelector('.result-item');
    if (first) {
      first.click();               // 已有结果：回车直接飞到第一个
    } else {
      const q = searchInput.value.trim();
      if (q.length >= 2) doSearch(q);  // 否则立即发起搜索
    }
  }
});

document.addEventListener('click', (e) => {
  if (!resultsBox.contains(e.target) &&
      e.target !== searchInput &&
      e.target !== diagBtn) {
    hideResults();
  }
});

async function doSearch(q) {
  const seq = ++searchSeq;
  setStatus('正在搜索「' + q + '」…');
  hideResults();

  const text = encodeURIComponent(q);
  const token = encodeURIComponent(currentToken || '');
  const ionSearchUrl =
    ION_GEOCODE_BASE + 'search?text=' + text + '&access_token=' + token;
  const photonUrl =
    PHOTON_GEOCODE_URL + '?q=' + text + '&limit=8';

  // 1) Ion 地理编码（所有语言都试，4 秒超时）
  const ion = await fetchJsonWithTimeout(ionSearchUrl, 4000);
  if (seq !== searchSeq) return;
  if (hasFeatures(ion)) {
    renderResults(ion.body.features, 'ion');
    setStatus('找到 ' + ion.body.features.length + ' 个结果（Cesium Ion）', 'ok');
    return;
  }
  setStatus(
    ion.ok && ion.status === 200
      ? 'Ion 未找到「' + q + '」，正在用备用源…'
      : 'Ion 不可用（' + resultText(ion) + '），正在用备用源…'
  );

  // 2) OSM / Photon；超时或网络失败自动重试一次
  let photon = await fetchJsonWithTimeout(photonUrl, 8000);
  if (seq !== searchSeq) return;
  if (!hasFeatures(photon) && photon.status === 0) {
    setStatus('备用源超时，正在重试（1/1）…');
    photon = await fetchJsonWithTimeout(photonUrl, 8000);
    if (seq !== searchSeq) return;
  }
  if (hasFeatures(photon)) {
    const features = normalizePhoton(photon.body.features);
    renderResults(features, 'photon');
    setStatus('找到 ' + features.length + ' 个结果（OSM / Photon 备用源）', 'ok');
    return;
  }

  // 3) Ion 联想搜索最后兜底
  setStatus('备用源不可用，正在尝试 Ion 联想搜索…');
  const ionAuto = await fetchJsonWithTimeout(
    ION_GEOCODE_BASE + 'autocomplete?text=' + text + '&access_token=' + token,
    6000
  );
  if (seq !== searchSeq) return;
  if (hasFeatures(ionAuto)) {
    renderResults(ionAuto.body.features, 'ion');
    setStatus('找到 ' + ionAuto.body.features.length + ' 个结果（Ion 联想）', 'ok');
    return;
  }

  const photonReason = 'Photon ' + resultText(photon);
  showResultsEmpty('搜索失败：' + photonReason + '；换个关键词或点「自检」看看。');
  setStatus('搜索失败：' + photonReason, 'error');
}

function normalizePhoton(features) {
  return features.map((f) => {
    const props = { ...(f.properties || {}) };
    props.label = photonLabel(props);
    return { ...f, properties: props };
  });
}

function photonLabel(p) {
  const parts = [p.name, p.street, p.district, p.city, p.state, p.country]
    .filter((v, i, a) => v && a.indexOf(v) === i);
  return parts.join('，') || '未知地点';
}

function renderResults(features, source) {
  if (!features.length) {
    showResultsEmpty('没有找到匹配的地点。');
    return;
  }
  resultsBox.innerHTML = '';
  if (source === 'photon') {
    const note = document.createElement('div');
    note.className = 'source-note';
    note.textContent = '当前使用备用源（OSM / Photon）';
    resultsBox.appendChild(note);
  }
  features.slice(0, 8).forEach((f) => {
    const props = f.properties || {};
    const name = props.label || props.display_name || props.name || '未知地点';
    const item = document.createElement('div');
    item.className = 'result-item';
    const main = document.createElement('div');
    main.textContent = String(name).split(/[,，]/)[0];
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = name;
    item.appendChild(main);
    item.appendChild(sub);
    item.addEventListener('click', () => {
      hideResults();
      goToFeature(f, name);
    });
    resultsBox.appendChild(item);
  });
  resultsBox.classList.remove('hidden');
}

function showResultsEmpty(msg) {
  resultsBox.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = msg;
  resultsBox.appendChild(empty);
  resultsBox.classList.remove('hidden');
}

function hideResults() {
  resultsBox.classList.add('hidden');
}

/* ---------------- 接口自检 ---------------- */
diagBtn.addEventListener('click', runDiagnostics);
diagClose.addEventListener('click', () => diagPanel.classList.add('hidden'));

async function runDiagnostics() {
  diagPanel.classList.remove('hidden');
  diagBody.innerHTML = '';

  const tests = [
    [
      'Cesium Ion 地形资产（验证 Token）',
      'https://api.cesium.com/v1/assets/1/endpoint?access_token=' +
        encodeURIComponent(currentToken || ''),
    ],
    [
      'Cesium Ion 地理编码（英文测试）',
      ION_GEOCODE_BASE + 'search?text=Beijing&access_token=' +
        encodeURIComponent(currentToken || ''),
    ],
    [
      'Cesium Ion 地理编码（中文测试）',
      ION_GEOCODE_BASE + 'search?text=' + encodeURIComponent('西湖') +
        '&access_token=' + encodeURIComponent(currentToken || ''),
    ],
    ['OSM / Photon 备用源', PHOTON_GEOCODE_URL + '?q=Beijing&limit=1'],
  ];

  const outcomes = [];
  for (const [label, url] of tests) {
    const line = document.createElement('div');
    line.className = 'diag-line';
    line.textContent = '… ' + label + '：检测中';
    diagBody.appendChild(line);

    const r = await fetchJsonWithTimeout(url, 8000);
    const ok = r.ok && r.status === 200;
    const count = r.body && Array.isArray(r.body.features)
      ? '，' + r.body.features.length + ' 条结果'
      : '';
    outcomes.push(ok);
    line.className = 'diag-line ' + (ok ? 'ok' : 'fail');
    line.textContent = (ok ? '✅ ' : '❌ ') + label + '：' + resultText(r) + count;
  }

  const tip = document.createElement('div');
  tip.className = 'diag-line';
  if (!outcomes[0]) {
    tip.textContent = '→ 地形资产不可达：Token 可能无效，或浏览器无法访问 api.cesium.com。';
  } else if (!outcomes[1]) {
    tip.textContent = '→ Token 有效，但地理编码不可用（常见于 Token 未开通 geocode 权限）。应用会自动使用备用源，不影响三维显示。';
  } else {
    tip.textContent = '→ Ion 地理编码可用；若中文字段返回 0 条结果，应用会自动改用 OSM / Photon。';
  }
  diagBody.appendChild(tip);

  if (!outcomes[3]) {
    const tip2 = document.createElement('div');
    tip2.className = 'diag-line';
    tip2.textContent = '→ 备用源也不可达：浏览器可能偶发超时，应用会自动重试一次；持续失败请检查代理/网络。';
    diagBody.appendChild(tip2);
  }
}

/* ---------------- 飞抵地点 + 范围圈 ---------------- */
/* 兼容多种地理编码返回结构：
 * Ion/Pelias 常只给 bbox；Photon 给 Point；也有结果把坐标嵌套在 Polygon 里 */
function findFirstPair(v) {
  if (!Array.isArray(v)) return null;
  if (v.length >= 2 && Number.isFinite(v[0]) && Number.isFinite(v[1])) {
    return [v[0], v[1]];
  }
  for (const item of v) {
    const pair = findFirstPair(item);
    if (pair) return pair;
  }
  return null;
}

function extractCoords(feature) {
  const props = feature.properties || {};
  const bbox = feature.bbox || props.bbox || props.extent;
  if (Array.isArray(bbox) && bbox.length >= 4 &&
      bbox.slice(0, 4).every(Number.isFinite)) {
    return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  }

  const geom = feature.geometry || {};
  if (Array.isArray(geom.coordinates)) {
    const pair = findFirstPair(geom.coordinates);
    if (pair) return pair;
  }
  if (Number.isFinite(props.lon) && Number.isFinite(props.lat)) {
    return [props.lon, props.lat];
  }
  if (Number.isFinite(props.lng) && Number.isFinite(props.lat)) {
    return [props.lng, props.lat];
  }
  return null;
}

function goToFeature(feature, name) {
  hidePhotoOverlay();          // 地名搜索与照片标注互斥，避免两套标注叠加
  const coords = extractCoords(feature);
  if (!coords) {
    setStatus('该结果没有可用坐标，换个关键词试试', 'error');
    return;
  }
  const [lon, lat] = coords;

  const radius = Number(radiusGroup.querySelector('.active').dataset.r);
  currentPlace = { name, lon, lat };

  placeNameEl.textContent = String(name).split(/[,，]/)[0];
  placeCoordsEl.textContent =
    '经度 ' + lon.toFixed(4) + '  ·  纬度 ' + lat.toFixed(4);
  infoCard.classList.remove('hidden');
  setStatus('已定位到「' + placeNameEl.textContent + '」', 'ok');

  drawPlace(lon, lat, radius);
  flyToPlace(lon, lat, radius);
}

function drawPlace(lon, lat, radius) {
  clearEntities();
  const position = Cesium.Cartesian3.fromDegrees(lon, lat);

  const pin = viewer.entities.add({
    position,
    point: {
      pixelSize: 12,
      color: Cesium.Color.fromCssColorString('#2563eb'),
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });

  // 不画贴地 ellipse 填充：Cesium 会把贴地椭圆拆成扇形三角片，
  // 半透明材质在起伏地形上叠加后会出现深色三角扇伪影（且会触发
  // outline/imagery-draping 相关警告）。仅用边界线表达范围，干净且零警告。
  // 边界改用独立的贴地折线，避免地形上的 outline 不支持问题
  const flatPositions = [];
  const latSpan = radius / 111320;
  const lonSpan = radius / (111320 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  for (let i = 0; i <= 64; i += 1) {
    const angle = (i / 64) * Math.PI * 2;
    flatPositions.push(lon + lonSpan * Math.cos(angle), lat + latSpan * Math.sin(angle));
  }
  const border = viewer.entities.add({
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray(flatPositions),
      width: 3,
      clampToGround: true,
      material: Cesium.Color.fromCssColorString('#2563eb').withAlpha(0.95),
    },
  });

  entities = [pin, border];
}

function flyToPlace(lon, lat, radius) {
  viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(lon, lat), radius),
    {
      duration: 2.2,
      offset: new Cesium.HeadingPitchRange(
        0,
        Cesium.Math.toRadians(-35),
        radius * 3.2
      ),
    }
  );
}

function clearEntities() {
  entities.forEach((e) => viewer.entities.remove(e));
  entities = [];
}

/* ---------------- 信息卡片交互 ---------------- */
closeInfoBtn.addEventListener('click', () => {
  clearEntities();
  currentPlace = null;
  infoCard.classList.add('hidden');
});

radiusGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('.radius-btn');
  if (!btn) return;
  radiusGroup.querySelectorAll('.radius-btn').forEach((b) =>
    b.classList.remove('active')
  );
  btn.classList.add('active');
  if (currentPlace) {
    const radius = Number(btn.dataset.r);
    drawPlace(currentPlace.lon, currentPlace.lat, radius);
    flyToPlace(currentPlace.lon, currentPlace.lat, radius);
  }
});

/* ---------------- 照片定位（EXIF GPS） ---------------- *
 * 用项目本地的 exifr 解析照片 EXIF，取出拍摄点经纬度，飞抵该点后
 * 引出一张随相机实时跟随的缩略图卡片。照片全程只在浏览器本地处理，
 * 不上传、不写入代码、也不会提交到 GitHub。                       */

photoBtn.addEventListener('click', () => {
  const willOpen = photoPanel.classList.contains('hidden');
  if (willOpen) photoMsg.classList.add('hidden');
  photoPanel.classList.toggle('hidden', !willOpen);
  photoBtn.classList.toggle('active', willOpen);
});
photoPanelClose.addEventListener('click', () => {
  photoPanel.classList.add('hidden');
  photoBtn.classList.remove('active');
});
pickPhotoBtn.addEventListener('click', () => photoInput.click());
dropZone.addEventListener('click', () => photoInput.click());
samplePhotoBtn.addEventListener('click', loadSamplePhoto);
photoInput.addEventListener('change', () => {
  const file = photoInput.files && photoInput.files[0];
  if (file) handlePhotoFile(file);
  photoInput.value = '';           // 允许连续选择同一张照片
});
photoCardClose.addEventListener('click', hidePhotoOverlay);

// 点击缩略图看大图
photoThumb.addEventListener('click', () => {
  if (!photoThumb.getAttribute('src')) return;
  const box = document.createElement('div');
  box.className = 'photo-lightbox';
  const big = document.createElement('img');
  big.src = photoThumb.src;
  big.alt = '照片大图';
  box.appendChild(big);
  box.addEventListener('click', () => box.remove());
  document.body.appendChild(box);
});
photoThumb.addEventListener('error', () => {
  // HEIC 等格式：GPS 能读到，但浏览器无法渲染图片，给出明确说明
  photoThumb.alt = '该格式浏览器无法预览（拍摄地点已成功定位）';
});

/* 全屏拖放 */
let dragDepth = 0;
function dragHasFiles(e) {
  return !!(e.dataTransfer &&
    Array.from(e.dataTransfer.types || []).indexOf('Files') !== -1);
}
document.addEventListener('dragenter', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dragDepth += 1;
  dropHint.classList.remove('hidden');
  dropZone.classList.add('over');
});
document.addEventListener('dragover', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    dropHint.classList.add('hidden');
    dropZone.classList.remove('over');
  }
});
document.addEventListener('drop', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropHint.classList.add('hidden');
  dropZone.classList.remove('over');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handlePhotoFile(file);
});

async function loadSamplePhoto() {
  setStatus('正在读取内置示例照片…');
  try {
    const resp = await fetch('assets/sample-with-gps.jpg');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const blob = await resp.blob();
    const file = new File([blob], '示例照片 · 杭州西湖.jpg', { type: 'image/jpeg' });
    await handlePhotoFile(file);
  } catch (err) {
    setStatus('示例照片读取失败：' + String((err && err.message) || err), 'error');
  }
}

async function handlePhotoFile(file) {
  if (!viewer) {
    setStatus('请先配置 Cesium Ion Token，再读取照片', 'error');
    return;
  }
  if (typeof exifr === 'undefined') {
    setStatus('EXIF 解析库未加载，请强制刷新页面（Ctrl + F5）', 'error');
    return;
  }

  setStatus('正在解析「' + file.name + '」的 EXIF…');
  try {
    const [gps, tags] = await Promise.all([
      exifr.gps(file).catch(() => null),
      exifr.parse(file, { tiff: true, ifd0: true, exif: true, gps: true })
        .catch(() => ({})),
    ]);

    const coord = extractGps(gps, tags);
    if (!coord) {
      // 明确区分「文件根本没有 EXIF」和「有 EXIF 但没有定位字段」
      const keys = tags ? Object.keys(tags) : [];
      const gpsKeys = keys.filter((k) => /gps|lat|lon/i.test(k));
      const diag = keys.length === 0
        ? '文件不含任何 EXIF 元数据'
        : '读到 ' + keys.length + ' 个 EXIF 字段，' +
          (gpsKeys.length
            ? '疑似定位字段：' + gpsKeys.slice(0, 6).join('、')
            : '其中没有任何定位字段');
      setPhotoMsg(
        '未读到拍摄坐标 · ' + diag +
        '。请用相机原图：拍照时开启定位，传图时关闭「压缩图片」。',
        false
      );
      photoPanel.classList.remove('hidden');
      photoBtn.classList.add('active');
      setStatus('「' + file.name + '」没有 GPS 信息，详情见照片面板', 'error');
      return;
    }
    const { lat, lon } = coord;
    setPhotoMsg('已读取拍摄坐标，见地图标注。', true);

    // 缩略图用本地 object URL，切换照片时释放上一个
    if (photoObjectUrl) URL.revokeObjectURL(photoObjectUrl);
    photoObjectUrl = URL.createObjectURL(file);
    photoThumb.alt = '照片缩略图';
    photoThumb.src = photoObjectUrl;

    const dateVal = tags && (tags.DateTimeOriginal || tags.CreateDate || tags.DateTime);
    const camera = [tags && tags.Make, tags && tags.Model]
      .filter(Boolean).join(' ').trim();
    const rows = [
      ['拍摄时间', formatExifDate(dateVal)],
      ['相机', camera || '未记录'],
      ['文件', file.name],
    ];
    if (tags && Number.isFinite(tags.GPSAltitude)) {
      rows.push(['海拔', Number(tags.GPSAltitude).toFixed(1) + ' m']);
    }
    renderPhotoMeta(rows);

    photoCoords.textContent =
      '纬度 ' + Math.abs(lat).toFixed(4) + '° ' + (lat >= 0 ? 'N' : 'S') +
      '  ·  经度 ' + Math.abs(lon).toFixed(4) + '° ' + (lon >= 0 ? 'E' : 'W');

    showPhotoOnMap(lon, lat);
    setStatus('已在地图上标出「' + file.name + '」的拍摄地点', 'ok');
  } catch (err) {
    setStatus('照片解析失败：' + String((err && err.message) || err) +
      '（请确认是 JPG / TIFF / HEIC 原图）', 'error');
  }
}

/* 多来源提取经纬度：
 * 1) exifr.gps() 已按 N/S/E/W 换算好的十进制值（最常用）
 * 2) parse() 返回的 latitude / longitude
 * 3) 原始 GPSLatitude / GPSLongitude（可能是度分秒数组，也可能已是数字）
 *    —— 部分相机、安卓机型只写原始标签，gps() 会返回 undefined */
function isNumericValue(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.trim() !== '' && Number.isFinite(Number(v));
  return false;
}

function coordFromTag(value, ref, negativeRefs) {
  let dec = NaN;
  if (Array.isArray(value)) {
    const d = Number(value[0]);
    const m = Number(value[1] || 0);
    const s = Number(value[2] || 0);
    if (Number.isFinite(d)) dec = d + m / 60 + s / 3600;
  } else if (isNumericValue(value)) {
    dec = Number(value);
  }
  if (!Number.isFinite(dec)) return NaN;
  if (negativeRefs.indexOf(String(ref || '').toUpperCase()) !== -1) dec = -dec;
  return dec;
}

function extractGps(gps, tags) {
  const t = tags || {};
  let lat = gps && isNumericValue(gps.latitude) ? Number(gps.latitude) : NaN;
  let lon = gps && isNumericValue(gps.longitude) ? Number(gps.longitude) : NaN;
  if (!Number.isFinite(lat) && isNumericValue(t.latitude)) lat = Number(t.latitude);
  if (!Number.isFinite(lon) && isNumericValue(t.longitude)) lon = Number(t.longitude);
  if (!Number.isFinite(lat)) {
    lat = coordFromTag(t.GPSLatitude, t.GPSLatitudeRef, ['S']);
  }
  if (!Number.isFinite(lon)) {
    lon = coordFromTag(t.GPSLongitude, t.GPSLongitudeRef, ['W']);
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }
  return { lat, lon };
}

function setPhotoMsg(text, ok) {
  photoMsg.textContent = text;
  photoMsg.className = 'photo-msg' + (ok ? ' ok' : '');
  photoMsg.classList.remove('hidden');
}

function formatExifDate(v) {
  if (!v) return '未记录';
  if (v instanceof Date && !isNaN(v.getTime())) {
    return v.toLocaleString('zh-CN', { hour12: false });
  }
  return String(v);
}

function renderPhotoMeta(rows) {
  photoMeta.innerHTML = '';
  rows.forEach(([label, value]) => {
    const div = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = label + '：';
    div.appendChild(b);
    div.appendChild(document.createTextNode(value));  // 文件名等用文本节点，避免注入
    photoMeta.appendChild(div);
  });
}

function showPhotoOnMap(lon, lat) {
  clearEntities();
  currentPlace = null;
  infoCard.classList.add('hidden');
  photoPanel.classList.add('hidden');
  photoBtn.classList.remove('active');
  hideResults();

  // 抬高 30 m：既避免被地形埋住，也让椭球遮挡判断在地表点上更稳定
  const position = Cesium.Cartesian3.fromDegrees(lon, lat, 30);
  const pin = viewer.entities.add({
    position,
    point: {
      pixelSize: 14,
      color: Cesium.Color.fromCssColorString('#f59e0b'),
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 3,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
  entities = [pin];
  photoCartesian = position;

  photoCard.classList.remove('hidden');
  photoCard.style.visibility = '';
  leaderSvg.classList.remove('hidden');
  photoAnchor.classList.remove('hidden');
  updatePhotoOverlay();          // 先定位一次，不必等下一帧

  viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(position, 700),
    {
      duration: 2.4,
      offset: new Cesium.HeadingPitchRange(
        0, Cesium.Math.toRadians(-40), 2100
      ),
    }
  );
}

/* 每帧把锚点的世界坐标投影到屏幕，更新引线、光环和卡片位置 */
function updatePhotoOverlay() {
  if (!viewer || !photoCartesian || photoCard.classList.contains('hidden')) return;

  const scene = viewer.scene;
  const toWindow = Cesium.SceneTransforms.worldToWindowCoordinates ||
                   Cesium.SceneTransforms.wgs84ToWindowCoordinates;
  const win = toWindow ? toWindow(scene, photoCartesian) : null;
  const w = scene.canvas.clientWidth;
  const h = scene.canvas.clientHeight;
  const occluder = new Cesium.EllipsoidalOccluder(
    Cesium.Ellipsoid.WGS84, viewer.camera.positionWC
  );
  const pad = 80;

  // 转到地球背面、或锚点跑出视口时暂时隐藏，转回来会自动恢复
  if (!win || !occluder.isPointVisible(photoCartesian) ||
      win.x < -pad || win.x > w + pad || win.y < -pad || win.y > h + pad) {
    leaderSvg.classList.add('hidden');
    photoAnchor.classList.add('hidden');
    photoCard.style.visibility = 'hidden';
    return;
  }
  leaderSvg.classList.remove('hidden');
  photoAnchor.classList.remove('hidden');
  photoCard.style.visibility = 'visible';

  const ax = win.x;
  const ay = win.y;
  const cardW = photoCard.offsetWidth || 242;
  const cardH = photoCard.offsetHeight || 250;
  // 默认放在锚点右侧偏上，再夹到视口内，避免卡片被裁掉
  const cx = Math.min(Math.max(16, ax + 110), Math.max(16, w - cardW - 16));
  const cy = Math.min(
    Math.max(86, ay - cardH * 0.72),
    Math.max(86, h - cardH - 16)
  );

  photoCard.style.left = cx + 'px';
  photoCard.style.top = cy + 'px';
  photoAnchor.style.left = ax + 'px';
  photoAnchor.style.top = ay + 'px';
  leaderDot.setAttribute('cx', ax);
  leaderDot.setAttribute('cy', ay);
  // 平滑贝塞尔曲线：从锚点水平出发，水平进入卡片左边缘中点
  const joinX = cx;
  const joinY = cy + cardH * 0.55;
  leaderPath.setAttribute(
    'd',
    'M ' + ax + ' ' + ay +
    ' C ' + (ax + 60) + ' ' + ay +
    ', ' + (joinX - 60) + ' ' + joinY +
    ', ' + joinX + ' ' + joinY
  );
}

function hidePhotoOverlay() {
  photoCartesian = null;
  photoCard.classList.add('hidden');
  photoCard.style.visibility = '';
  leaderSvg.classList.add('hidden');
  photoAnchor.classList.add('hidden');
  clearEntities();
  if (photoObjectUrl) {
    URL.revokeObjectURL(photoObjectUrl);
    photoObjectUrl = null;
  }
  photoThumb.removeAttribute('src');
}

/* ---------------- 启动 ---------------- */
(function init() {
  const saved = localStorage.getItem(TOKEN_KEY);
  if (saved) {
    tokenInput.value = saved;
    bootWithToken(saved).catch(() => {
      tokenGate.classList.remove('hidden');
      tokenError.textContent = '已保存的 Token 失效，请重新输入。';
      localStorage.removeItem(TOKEN_KEY);
    });
  } else {
    tokenGate.classList.remove('hidden');
  }
})();
