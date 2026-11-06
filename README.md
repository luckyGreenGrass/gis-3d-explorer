# 足迹 · 三维周边探索

用 CesiumJS + Cesium Ion 把"想去的地方"周边三维环境（真实地形 + 建筑白模）直接展示在浏览器里，出发前先"云踩点"。

## 功能

- 🔑 首次使用配置 Cesium Ion Token（仅保存在浏览器 localStorage）
- 🔍 任意地点搜索（Ion Geocode 服务，支持中文地名）
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
