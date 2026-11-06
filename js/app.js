/* 足迹 · 三维周边探索 —— Cesium Ion 版
 * 功能：Ion Token 配置、地名搜索（Ion Geocode）、
 *      飞抵地点并绘制周边范围圈，展示周边三维地形与建筑。
 */
'use strict';

window.CESIUM_BASE_URL = 'https://cesium.com/downloads/cesiumjs/releases/1.132/Build/Cesium/';

const TOKEN_KEY = 'cesium_ion_token';
// Ion 的 Pelias 地理编码：路径 /v1/geocode/search，参数 text + access_token
// 注意：鉴权走 access_token 查询参数，不能用 Authorization 头（会触发 CORS 预检失败）
const ION_GEOCODE_BASE = 'https://api.cesium.com/v1/geocode/';
// 备用源：OSM / Photon，免 Token，Ion 地理编码不可用（权限/网络）时自动兜底
const PHOTON_GEOCODE_URL = 'https://photon.komoot.io/api/';

let viewer = null;
let currentToken = null;
let currentPlace = null;   // { name, lon, lat }
let entities = [];         // 当前标注（点 + 范围圈）
let searchTimer = null;
let searchSeq = 0;         // 丢弃过期请求的结果
let lastPhotonAt = 0;      // 备用源简单限流

/* ---------------- DOM ---------------- */
const tokenGate = document.getElementById('tokenGate');
const tokenInput = document.getElementById('tokenInput');
const tokenBtn = document.getElementById('tokenBtn');
const tokenError = document.getElementById('tokenError');
const uiPanel = document.getElementById('uiPanel');
const searchInput = document.getElementById('searchInput');
const resultsBox = document.getElementById('results');
const infoCard = document.getElementById('infoCard');
const placeNameEl = document.getElementById('placeName');
const placeCoordsEl = document.getElementById('placeCoords');
const closeInfoBtn = document.getElementById('closeInfo');
const radiusGroup = document.getElementById('radiusGroup');
const loadingTip = document.getElementById('loadingTip');

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
    .then(() => {
      localStorage.setItem(TOKEN_KEY, token);
    })
    .catch((err) => {
      console.error(err);
      tokenError.textContent =
        'Token 校验失败，请确认已复制完整 Token 且账号有效。';
    });
}

async function bootWithToken(token) {
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
  }

  // 用"世界地形 + OSM 建筑"来验证 Token 是否有效
  try {
    viewer.terrainProvider = await Cesium.createWorldTerrainAsync();
    const buildings = await Cesium.createOsmBuildingsAsync();
    viewer.scene.primitives.add(buildings);
  } catch (err) {
    loadingTip.classList.add('hidden');
    throw err;
  }

  loadingTip.classList.add('hidden');
  tokenGate.classList.add('hidden');
  uiPanel.classList.remove('hidden');
  searchInput.focus();

  // 预热一次地球视角：中国上空
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
  searchTimer = setTimeout(() => doSearch(q), 450);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideResults();
});

document.addEventListener('click', (e) => {
  if (!resultsBox.contains(e.target) && e.target !== searchInput) {
    hideResults();
  }
});

async function doSearch(q) {
  const seq = ++searchSeq;
  const ionUrl =
    ION_GEOCODE_BASE +
    'search?text=' + encodeURIComponent(q) +
    '&access_token=' + encodeURIComponent(currentToken);

  try {
    const resp = await fetch(ionUrl);
    if (!resp.ok) {
      let detail = '';
      try {
        const j = await resp.json();
        detail = j.message || j.code || '';
      } catch (_) { /* 忽略非 JSON 响应 */ }
      throw new Error('Ion ' + resp.status + (detail ? ' · ' + detail : ''));
    }
    const data = await resp.json();
    if (seq !== searchSeq) return;
    const features = data.features || [];
    if (features.length) {
      renderResults(features, 'ion');
    } else {
      await searchByPhoton(q, seq, '');
    }
  } catch (err) {
    if (seq !== searchSeq) return;
    console.warn('[geocode] Ion 搜索失败：', err.message);
    await searchByPhoton(q, seq, err.message);
  }
}

/* 备用地理编码：OSM / Photon，免 Token、支持中文地名 */
async function searchByPhoton(q, seq, reason) {
  const wait = Math.max(0, 1000 - (Date.now() - lastPhotonAt));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  if (seq !== searchSeq) return;
  lastPhotonAt = Date.now();

  try {
    const resp = await fetch(
      PHOTON_GEOCODE_URL + '?q=' + encodeURIComponent(q) + '&limit=8'
    );
    if (!resp.ok) throw new Error('Photon ' + resp.status);
    const data = await resp.json();
    if (seq !== searchSeq) return;

    const features = (data.features || []).map((f) => {
      const props = { ...(f.properties || {}) };
      props.label = photonLabel(props);
      return { ...f, properties: props };
    });
    if (features.length) {
      renderResults(features, 'photon');
    } else {
      showResultsEmpty('没有找到匹配的地点。' + (reason ? '（' + reason + '）' : ''));
    }
  } catch (err) {
    if (seq !== searchSeq) return;
    console.error(err);
    showResultsEmpty(
      '搜索失败：' + (reason || '未知原因') +
      '；备用源也不可用，请检查网络或 Token 权限。'
    );
  }
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
    note.textContent = 'Ion 地理编码不可用，已自动切换备用源（OSM / Photon）';
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

/* ---------------- 飞抵地点 + 范围圈 ---------------- */
function goToFeature(feature, name) {
  const geom = feature.geometry || {};
  let lon = null;
  let lat = null;

  if (geom.type === 'Point') {
    [lon, lat] = geom.coordinates;
  } else if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
    const rings = geom.type === 'Polygon'
      ? [geom.coordinates[0]]
      : geom.coordinates.map((p) => p[0]);
    let sumX = 0, sumY = 0, n = 0;
    rings.forEach((ring) =>
      ring.forEach(([x, y]) => { sumX += x; sumY += y; n += 1; })
    );
    lon = sumX / n;
    lat = sumY / n;
  }

  if (lon == null || lat == null) return;

  const radius = Number(
    radiusGroup.querySelector('.active').dataset.r
  );
  currentPlace = { name, lon, lat };

  placeNameEl.textContent = String(name).split(/[,，]/)[0];
  placeCoordsEl.textContent =
    '经度 ' + lon.toFixed(4) + '  ·  纬度 ' + lat.toFixed(4);
  infoCard.classList.remove('hidden');

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

  const circle = viewer.entities.add({
    position,
    ellipse: {
      semiMajorAxis: radius,
      semiMinorAxis: radius,
      material: Cesium.Color.fromCssColorString('#2563eb').withAlpha(0.15),
      outline: true,
      outlineColor: Cesium.Color.fromCssColorString('#2563eb').withAlpha(0.8),
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    },
  });

  entities = [pin, circle];
}

function flyToPlace(lon, lat, radius) {
  viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(
      Cesium.Cartesian3.fromDegrees(lon, lat),
      radius
    ),
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
