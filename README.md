# 简历制作小程序

一个在微信里做简历的小工具：选模板、填内容、实时预览，导出 PNG 长图或 JSON 备份。

**所有数据只保存在手机本地（wx storage），不联网、不上传、不需要后端。**

---

## 功能

- **18 套模板**：切模板会同时换掉配色、字体、标题装饰、分栏方式、字号行距和页边距，但**不动已填内容**
- **首页管理草稿**：新建、复制、删除、预览（卡片点按进编辑，长按弹菜单）
- **所见即所得编辑**：点纸面上的文字就能改，不用分栏填表
- **三种条目排版**：ONE（整行）/ TWO（两栏）/ THREE（三栏），区块可长按拖动排序、左滑删除
- **照片**：内置头像或相册选图，支持外形、边框、尺寸、证件照比例
- **自动保存**：每 4 秒落盘，离开页面或切后台再补存一次，所以没有保存按钮
- **撤销 / 重做**：连续输入合并为一步
- **A4 软分页**：自动画页缝和页码，跨页的区块整体推到下一页
- **智能压缩到一页**：逐级调整字号行距，把内容压进一页
- **导出**：PNG 长图（2 倍高清，直接存相册）、JSON 备份（复制到剪贴板，换设备粘贴导入）

---

## 快速开始

1. 用微信开发者工具「导入项目」，选择本目录
2. AppID 填自己的测试号即可（本项目不请求任何接口，无需配置服务器域名）
3. 编译运行

`project.config.json` 已经配好，开箱可用。

---

## 项目结构

```
app.js / app.json / app.wxss    入口、页面登记、全局样式与设计变量
assets/                         内置证件照头像
components/
  nav-bar/                      自定义导航栏
  resume-paper/                 简历纸张渲染（纸面骨架 + 区块 + 双栏）
pages/
  index/      我的简历          edit/        编辑器
  preview/    全屏预览          templates/   模板库
utils/
  model.js       数据模型与模板常量
  store.js       全局状态
  paper.js       简历数据 → 纸张视图数据
  layout.js      排版引擎：几何计算与软分页
  render.js      canvas 渲染（导出 PNG 用）
  onePage.js     智能压缩到一页
  export.js      导出 / 剪贴板 / 相册等平台能力封装
tools/           开发期回归脚本（不参与打包）
```

---

## 数据模型

```text
resume
├── resumeName / templateId / updateDatetime
├── pageLayout / headingTheme / borderTheme / fontFamily / fontSize …
├── baseInfo        基本信息（含字段显示开关）
├── personalPhoto*  照片（形状、边框、宽高、位置）
└── sections[]      区块 → items[] → { type: ONE | TWO | THREE, left / center / right }
```

`normalizeResume()` 负责补齐历史数据和导入数据里缺失的字段，所以任何一份格式正确的
JSON 备份都能直接导入。

存储键：`pb_drafts_v1`（草稿列表）、`pb_current_v1`（当前草稿 id）。

---

## 几处设计约定

- **模板 = 一整套风格**：换模板得到的是确定的一套排版，而不是新旧模板的混合。
- **空栏不渲染**：只有该条目的排版类型真的用到某一栏时才渲染。否则 ONE（整行）条目会凭空
  多出左右两个空行，把一行内容撑高好几倍，用户还没法删——数据里本来就没有内容。
- **末尾区块的下边距不算内容**：它只影响盒子高度，不参与分页判定。
- **分页留 1px 容差**：吸收行高累加带来的亚像素误差，避免内容刚好贴边时被切出一张
  只有一两行的第二页。
- **屏幕与导出必须同源**：排版几何只在 `utils/layout.js` 里算一次，屏幕渲染、页数判定、
  PNG 导出共用同一套结果。改了样式常量，两边必须同步——`tools/check-geometry.cjs` 负责守住这条。

`utils/layout.js` 用纯 JS 复刻了纸张的排版规则，而不是像网页那样每轮都去做真实 DOM 测量：
智能压缩要反复试算几十组参数，逐次测量会让界面明显卡顿。

---

## 开发与验证

本机需要安装 Google Chrome（几何校验和布局实测都用无头浏览器真实排版，而不是读源码推断）。

```bash
npm run check            # 静态检查：模块可加载、页面登记齐全、WXML 事件处理函数存在
npm run check:package    # 代码包体积与打包完整性
npm run check:logic      # 逻辑与交互仿真：跑一遍各页面 onLoad 与全部交互处理函数
npm run check:geometry   # 排版几何：引擎预测 ↔ 真实 CSS 实测，逐坐标比对
npm run check:layout     # 编辑页布局实测（面板、工具栏、浮层菜单）
npm run check:indexlayout# 首页布局实测
npm run check:all        # 以上全部一起跑

npm run preview          # 生成纸面仿真页 .work/preview.html，可在浏览器里看
npm run shot             # 生成编辑页各面板的界面截图
```

当前代码包约 **292 KB / 42 个文件**，主包上限 1.5 MB，余量充足。
`tools/`、`.work/`、`node_modules/` 已通过 `project.config.json` 的 `packOptions` 排除，
不会打进小程序，`npm run check:package` 会持续守住这条基线。

---

## 已知限制

- **导出**：只有 PNG 长图和 JSON 备份。PDF / Word / HTML 都依赖浏览器打印和可写文件系统，
  小程序沙箱里没有这两样能力，所以不提供；需要 PDF 时，可以在电脑上用同一份 JSON 备份打印。
- **导入**：小程序没有文件选择器，读不到任意本地 `.json` 文件，因此改为粘贴 JSON 文本，功能等价。
- **照片裁剪**：不做自绘裁剪框，改用系统相册 / 相机自带的裁剪；证件照比例通过「比例」按钮
  调整尺寸得到。
- **字体**：和网页一样使用系统字体栈（宋体 / 黑体 / 楷体 / 仿宋 / Times / Arial），
  目标机器没装对应字体会回退，跨设备效果可能略有差异。

---

## License

仅供学习与个人使用。
