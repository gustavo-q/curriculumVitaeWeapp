# 简历制作小程序

一个在微信里做简历的小工具：选模板、填内容、实时预览，导出 PDF / Word / PNG 长图或 JSON 备份。

**所有数据只保存在手机本地（wx storage），不联网、不上传、不需要后端。**

---

## 功能（2.0 手机端重做）

底部 3 个 Tab：

- **简历**：草稿卡片 + 缩略图；点标题重命名、左滑 复制 / 归档 / 删除、长按拖动排序；底部折叠「已归档」；右下 ＋ 新建示例 / 空白 / 从聊天文件导入（电脑导出的 JSON 用微信发给自己即可导入）
- **投递**：已投 / 面试中 / 已结束 三段；左滑改状态；面试时间一键加入手机日历
- **我的**：模板库、JD 匹配、简历攻略、数据备份与恢复、关于

编辑器改为**表单优先**：基本信息、照片、各区块纵向卡片；条目进全屏子页编辑，时间用滚轮选择（年月 / 至今）；
删除后可「撤销」；底部固定 填写 / 样式 / 预览 / 导出。预览里点纸面某块会跳回对应表单。

- **预览**：A4 分页、双击 / 双指缩放；样式面板（配色、字体、标题装饰、布局、字号行距边距、模板）；一键压到一页并列出改动、可还原
- **导出**：PDF / Word 直接**发给微信好友**，PNG 长图存相册，JSON 复制或发到聊天
- **模板库**：左右滑动，用你自己的内容预览 18 套模板
- **JD 匹配**：自动识别剪贴板里的岗位描述；缺失关键词一点跳去补；匹配完「记一笔投递」
- **证件照**：拍照 / 相册 + 原生裁剪（一寸 / 二寸 / 方图）

相比网页版去掉了：对照参考面板（改为「从其他简历复制」）、选区格式工具栏、快捷键、HTML 导出、看板拖拽。

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
  render.js      canvas 渲染（导出 PNG / PDF 逐页用）
  onePage.js     智能压缩到一页
  export.js      导出 / 剪贴板 / 相册等平台能力封装
  pdf.js         纯 JS 的 PDF 组装器（JPEG → 多页 PDF）
  word.js        简历 → Word(.doc) HTML 生成
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
  PNG 导出、PDF 逐页导出共用同一套结果。改了样式常量，两边必须同步——`tools/check-geometry.cjs` 负责守住这条。

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
npm run check:pdf        # PDF / Word 导出产物的字节级校验

npm run preview          # 生成纸面仿真页 .work/preview.html，可在浏览器里看
npm run shot             # 生成编辑页各面板的界面截图
```

当前代码包约 **327 KB / 44 个文件**，主包上限 1.5 MB，余量充足。
`tools/`、`.work/`、`node_modules/` 已通过 `project.config.json` 的 `packOptions` 排除，
不会打进小程序，`npm run check:package` 会持续守住这条基线。

---

## 已知限制

- **导出**：PDF / Word / PNG / JSON 四种。PDF 是「位图版式」——逐页截图嵌入，
  所见即所得且任何设备打开都不跑版，但文字不可选中（这是无后端小程序的边界；
  需要可编辑文本请用 Word 导出）。Word 是「Word HTML」格式，WPS / Word 打开后
  可编辑、可另存为 .docx，复杂装饰（如标题色块圆角）会取近似样式。
- **导入**：小程序没有文件选择器，读不到任意本地 `.json` 文件，因此改为粘贴 JSON 文本，功能等价。
- **照片裁剪**：不做自绘裁剪框，改用系统相册 / 相机自带的裁剪；证件照比例通过「比例」按钮
  调整尺寸得到。
- **字体**：和网页一样使用系统字体栈（宋体 / 黑体 / 楷体 / 仿宋 / Times / Arial），
  目标机器没装对应字体会回退，跨设备效果可能略有差异。

---

## License

仅供学习与个人使用。
