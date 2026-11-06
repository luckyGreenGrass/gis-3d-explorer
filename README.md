# 足迹 · 三维周边探索

用 CesiumJS + Cesium Ion 把"想去的地方"周边三维环境（真实地形 + 建筑白模）直接展示在浏览器里，出发前先"云踩点"。

## 功能

- 🔑 首次使用配置 Cesium Ion Token（仅保存在浏览器 localStorage）
- 🔍 任意地点搜索：Ion 地理编码 → OSM / Photon（超时自动重试）→ Ion 联想搜索，三级容错，任一源可用就不会卡住
- ⏎ 输入后可直接按**回车**选中第一个结果，无需鼠标点击
- 💬 搜索状态直接显示在页面顶部，**不用打开控制台**；点右上角「自检」可一键检查三个接口是否可用
- ✈️ 相机自动飞抵目标地点，倾斜视角环视周边
- ⭕ 可切换 1 / 2 / 5 / 10 km 的"周边范围圈"标注
- 🏔️ 全球三维地形 + OSM 建筑模型实时渲染

## 运行

纯静态页面，无构建步骤。因为需要加载在线 Cesium 资源，建议用任意静态服务器打开，例如：

```bash
# 方式一：Python
python -m http.server 8080

# 方式二：Node
npx serve .
```

然后浏览器访问 http://localhost:8080 。

> 直接双击 index.html 也能打开，但部分浏览器对 file:// 协议下的资源加载有限制，推荐用静态服务器。

## 获取 Cesium Ion Token（免费）

1. 注册/登录 https://ion.cesium.com/signup
2. 打开 https://ion.cesium.com/tokens 复制默认 Token
3. 粘贴进页面首个弹窗即可

## 数据说明

- **三维地形 / 建筑**：Cesium Ion（World Terrain + OSM Buildings），需要 Ion Token
- **地名搜索**：优先使用 Ion 地理编码（`GET /v1/geocode/search?text=…&access_token=…`）；
  若 Ion 返回 401/403（如 Token 未开通 geocode 权限）或网络不可达，会自动切换到免 Token 的
  OSM / Photon 备用源，并在下拉框顶部提示当前来源。

## 常见问题

**Q：输入地址后没反应？**

A：已修复。原因有三个：① Ion 的地理编码对中文地名（如「杭州西湖」）常返回空结果；② 免费备用源 Photon 偶发超时且旧版没有超时/重试；③ 旧版不支持回车、也没有可见状态，请求还在进行/切换数据源时看起来像"没反应"。现在所有请求都有超时、三级容错 + 自动重试，顶部状态条实时显示进展，按回车可选中第一个结果。

**Q：`[geocode]` 日志在哪里看？浏览器控制台怎么打开？**

A：按 **F12**（或 `Ctrl + Shift + J`，macOS 为 `Cmd + Option + J`）打开开发者工具，切到 **Console / 控制台** 标签页，日志按时间从上到下排列，可用顶部 Filter 框输入 `geocode` 过滤。不过新版本已经把状态和错误直接显示在页面上，并提供了「自检」按钮，一般不再需要看控制台。

**Q：搜索失败但地球正常显示？**

A：说明 Ion Token 有效（地形/建筑已加载），只是搜索接口异常。点「自检」：

- 地形资产 `HTTP 200`、地理编码 `HTTP 401/403` → Token 未开通地理编码权限，应用已自动用备用源，可忽略
- 备用源失败 → 检查浏览器能否访问 `photon.komoot.io`
- 三项都正常但没有结果 → 换更具体的关键词，或用英文地名

**Q：Token 保存在哪里？**

A：只存在浏览器 localStorage，不写入代码、不提交到 GitHub。

## 目录结构

```
gis-3d-explorer/
├── index.html      # 页面骨架
├── css/style.css   # 界面样式
└── js/app.js       # 核心逻辑（Token 校验 / 搜索 / 飞抵 / 标注）
```

## Roadmap

- [ ] 多地点"心愿清单"收藏（localStorage）
- [ ] 倾斜摄影 / 高精度建筑（Ion 资产）
- [ ] 日照与阴影模拟，看某个时间点的光线
- [ ] 分享链接：把当前地点编码进 URL
