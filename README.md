# 足迹 · 三维周边探索

用 CesiumJS + Cesium Ion 把"想去的地方"周边三维环境（真实地形 + 建筑白模）直接展示在浏览器里，出发前先"云踩点"。

## 功能

- 🔑 首次使用配置 Cesium Ion Token（仅保存在浏览器 localStorage）
- 📷 **照片定位**：拖入/选择一张照片 → 读取 EXIF 里的 GPS 拍摄坐标 → 飞抵该点 → 从定位点引出照片缩略图卡片（含拍摄时间、相机、海拔、经纬度）；内置示例照片可立即体验
- 🔍 任意地点搜索：Ion 地理编码 → OSM / Photon（超时自动重试）→ Ion 联想搜索，三级容错，任一源可用就不会卡住
- ⏎ 输入后可直接按**回车**选中第一个结果，无需鼠标点击
- 💬 搜索状态直接显示在页面顶部，**不用打开控制台**；点右上角「自检」可一键检查四个接口是否可用
- 📋 右上角「日志 N/N」按钮把控制台的 error / warning 搬到页面上（同一条消息自动合并计数），排查问题时无需 F12
- 🛰️ 影像 / 地形瓦片加载期间显示剩余数量，避免把"还在加载"误判成"页面坏了"
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

## 照片定位（EXIF GPS）

1. 点顶部「📷 照片」→ 「选择本地照片」，或直接把照片拖到页面任意位置
2. 页面用项目本地的 `exifr` 解析 EXIF 中的 GPS 经纬度，相机自动飞抵拍摄点
3. 该点出现脉冲光环，一条平滑引线连到缩略图卡片；卡片显示拍摄时间、相机型号、海拔、精确经纬度，点缩略图可看大图
4. 卡片随地图旋转 / 缩放实时跟随，锚点转到地球背面时自动隐藏
5. 手上没有合适的照片？点「试用内置示例」加载 `assets/sample-with-gps.jpg`（杭州西湖，30.2424°N / 120.1431°E）

**隐私**：照片只在浏览器本地通过 `URL.createObjectURL` 读取，不上传服务器、不写入代码、不提交 GitHub；切换照片时释放上一个 URL。

**示例照片可重新生成**：`python tools/make_sample_photo.py`（只依赖 Pillow，改脚本顶部的 `LAT` / `LON` / `PLACE` 即可换地点）。

### 哪些照片读不到 GPS

- 经微信 / QQ / 邮件用「压缩图片」发送过的图、网页下载图、截图 —— EXIF 会被剥离
- 拍照时相机未开启「记录位置信息」权限
- 部分安卓机型只写原始 GPS 标签（度分秒数组），本项目已做兜底解析

照片面板会给出具体诊断：「文件不含任何 EXIF 元数据」或「读到 N 个 EXIF 字段，其中没有任何定位字段」，据此可判断是文件本身没数据、还是解析环节的问题。HEIC 能读出 GPS，但 Chrome 无法渲染其缩略图，卡片会显示占位说明。

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

**Q：F12 开发者工具里显示若干"错误"和"问题"，要紧吗？**

A：区分三类，逐一对照：

1. **项目代码产生的 console.error / warn**：以 v2.3 为界，之前主要由「周边范围圈」引起 —— `Primitive outlines disable imagery draping`（贴地带描边椭圆会让 Cesium 跳过影像贴合，底图变纯色）、`Entity ... with heightReference must also have a defined height`、`Entity geometry outlines are unsupported on terrain`，外加 OSM 建筑默认开启的模型轮廓。现已全部修复：范围圈改为「独立贴地边界线」，建筑用 `createOsmBuildingsAsync({ enableShowOutline: false, showOutline: false })` 从加载阶段关掉轮廓。实测完整流程后页面日志为 **0 错误 / 0 警告**。
2. **Ion 地理编码接口 401 / 405 / CORS 预检失败**：旧版接口路径与鉴权写错导致，已在 `ab17bc0` 修复；若 Console 里仍看得见，多半是历史日志（开了 Preserve log 会跨刷新保留），点 Console 左上角的 🚫 清空后刷新即可。
3. **DevTools 右侧「Issues / 问题」面板**：多为浏览器对第三方跨站资源的提示（Cookie 的 SameSite / 第三方 Cookie 限制、弃用 API 等），来自 `cesium.com` 等外部域名，不是本项目脚本错误，也不影响渲染。**判断标准**：点右上角「日志」按钮，只要显示 `0/0`，就说明页面运行时没有产生任何 console 错误或警告。

如果清空并刷新后 Console 仍有红字，把具体文本发来即可定位。

**Q：地球只有一片纯色 / 星空，看不到影像？**

A：通常是 Ion 影像、地形瓦片还在下载（国内网络下可能十几秒到几十秒），此时 globe 显示的是 Cesium 的底色。页面左下（或中央）会显示「正在加载影像 / 地形瓦片…（剩余 N）」，等它消失即可。若长时间不消失，点「自检」确认 Ion 地形资产是否 `HTTP 200`；不是 200 则检查网络 / 代理。

**Q：我的照片提示"没有 GPS 信息"？**

A：见上方「哪些照片读不到 GPS」。最可靠的做法：在手机相机 App 里开启「记录位置信息」，拍完用数据线或「原图」方式传到电脑，不要经过微信 / QQ 压缩。照片面板里的诊断文字会明确告诉你是完全没有 EXIF，还是有 EXIF 但没有定位字段。

**Q：Token 保存在哪里？**

A：只存在浏览器 localStorage，不写入代码、不提交到 GitHub。

## 目录结构

```
gis-3d-explorer/
├── index.html                    # 页面骨架
├── css/style.css                 # 界面样式
├── js/console-capture.js         # 页面内控制台日志捕获器（须最先加载）
├── js/app.js                     # 核心逻辑（Token / 搜索 / 飞抵 / 照片定位）
├── js/vendor/exifr.full.umd.js   # 本地 EXIF 解析库（exifr 7.1.3，不依赖 CDN）
├── assets/sample-with-gps.jpg    # 带真实 GPS EXIF 的示例照片
└── tools/make_sample_photo.py    # 示例照片生成脚本（Pillow）
```

## Roadmap

- [ ] 多照片批量导入，串成一条旅行足迹时间线
- [ ] 多地点"心愿清单"收藏（localStorage）
- [ ] 倾斜摄影 / 高精度建筑（Ion 资产）
- [ ] 日照与阴影模拟，看某个时间点的光线
- [ ] 分享链接：把当前地点编码进 URL
