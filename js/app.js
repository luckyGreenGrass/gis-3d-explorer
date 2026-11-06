/* 足迹 · 三维周边探索 —— Cesium Ion 版
 * 三维数据：Cesium Ion（世界地形 + OSM 建筑）
 * 地名搜索：Ion Geocode 优先，OSM / Photon 兜底
 * 所有请求带超时；搜索状态与接口自检结果直接显示在页面上，无需打开控制台。
 */
'use strict';

window.CESIUM_BASE_URL = 'https://cesium.com/downloads/cesiumjs/releases/1.132/Build/Cesium/';

const TOKEN_KEY = 'cesium_ion_token';
const APP_VERSION = 'v2.3';
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
