/**
 * 页面生命周期仿真：在 Node 里真正跑一遍每个页面的 onLoad / 交互处理函数，
 * 用真实的 wx API 桩驱动，断言 data 与 store 的状态变化。
 *
 * 这不能替代开发者工具的真机渲染，但能覆盖「逻辑层」的全部风险：
 * 页面初始化是否抛异常、setData 的数据形状是否正确、点击 / 输入 / 滑杆
 * 这些处理函数是否真的改到了 store，以及撤销重做、智能一页等核心算法。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
let pass = 0
let fail = 0
const failures = []

function ok (name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' :: ' + detail : '')) }
}
function section (t) { console.log('\n=== ' + t + ' ===') }

/* ---------------- wx 桩 ---------------- */
const storage = {}
const calls = { toast: [], modal: null, navigate: [], actionSheet: null, saved: [], unlinked: [] }
let modalAnswer = { confirm: true, content: '' }
let chooseMediaFile = null
/** 置 true 模拟用户在相册授权弹窗里点「不允许」 */
let albumDeny = false

global.wx = {
  getStorageSync: (k) => (k in storage ? JSON.parse(JSON.stringify(storage[k])) : ''),
  setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)) },
  removeStorageSync: (k) => { delete storage[k] },
  createOffscreenCanvas: () => { throw new Error('headless: no canvas') },
  getWindowInfo: () => ({ statusBarHeight: 20, windowWidth: 390, screenHeight: 844, safeArea: { bottom: 810 } }),
  getSystemInfoSync: () => ({ statusBarHeight: 20, windowWidth: 390, screenHeight: 844 }),
  getMenuButtonBoundingClientRect: () => ({ top: 26, height: 32 }),
  showToast: (o) => calls.toast.push(o.title),
  showLoading: () => {},
  hideLoading: () => {},
  showModal: (o) => {
    calls.modal = o
    if (o.success) o.success({ confirm: modalAnswer.confirm, content: modalAnswer.content })
  },
  showActionSheet: (o) => { calls.actionSheet = o },
  chooseMedia: (o) => { if (chooseMediaFile) o.success({ tempFiles: [chooseMediaFile] }) },
  navigateTo: (o) => calls.navigate.push(o.url),
  redirectTo: (o) => calls.navigate.push(o.url),
  reLaunch: (o) => calls.navigate.push(o.url),
  navigateBack: () => calls.navigate.push('back'),
  pageScrollTo: () => {},
  setClipboardData: (o) => { calls.clipboard = o.data; o.success && o.success() },
  // 默认保存成功；置 albumDeny=true 可模拟用户在系统弹窗里点「不允许」
  saveImageToPhotosAlbum: (o) => {
    if (albumDeny) return o.fail && o.fail({ errMsg: 'saveImageToPhotosAlbum:fail auth deny' })
    calls.saved.push(o.filePath)
    o.success && o.success()
  },
  getSetting: (o) => o.success({ authSetting: {} }),
  openSetting: (o) => o.success({ authSetting: {} }),
  canvasToTempFilePath: (o) => o.success({ tempFilePath: '/tmp/out.png' }),
  createSelectorQuery: () => ({
    in: function () { return this },
    select: function () { return this },
    fields: function () { return this },
    exec: (cb) => cb([{ node: makeFakeCanvas(), width: 10, height: 10 }])
  }),
  env: { USER_DATA_PATH: '/tmp' },
  getFileSystemManager: () => ({
    mkdirSync () {},
    copyFileSync () {},
    // 记录被回收的照片文件，用于验证「换照片/移除照片不留孤儿文件」
    unlink: (o) => { calls.unlinked.push(o.filePath); o.success && o.success() }
  })
}

function makeFakeCanvas () {
  const ctx = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textBaseline: '', globalAlpha: 1,
    setTransform () {}, clearRect () {}, fillRect () {}, strokeRect () {}, beginPath () {},
    moveTo () {}, lineTo () {}, arc () {}, rect () {}, closePath () {}, clip () {}, fill () {},
    stroke () {}, save () {}, restore () {}, translate () {}, quadraticCurveTo () {}, setLineDash () {},
    drawImage () {}, fillText () {}, measureText: (s) => ({ width: String(s).length * 7 })
  }
  return {
    width: 0, height: 0,
    getContext: () => ctx,
    createImage: () => ({ set src (v) { setTimeout(() => this.onload && this.onload(), 0) }, width: 240, height: 320 }),
    toDataURL: () => 'data:image/png;base64,'
  }
}

/* ---------------- App / Page / Component 捕获 ---------------- */
let appObj = null
global.App = (o) => { appObj = o }
global.getApp = () => appObj
let lastPage = null
global.Page = (o) => { lastPage = o }
let lastComp = null
global.Component = (o) => { lastComp = o }
global.getCurrentPages = () => [{}]

/* ---------------- 载入 app ---------------- */
require(path.join(ROOT, 'app.js'))
appObj.onLaunch()
ok('app.onLaunch 无异常', true)
ok('globalData 有状态栏高度', appObj.globalData.statusBarHeight === 20)
ok('globalData 有导航栏高度', typeof appObj.globalData.navBarHeight === 'number')

/** 构造一个页面实例：把 data 深拷贝，方法绑定 this，setData 同步生效 */
/**
 * 复刻小程序的 setData 语义，含「路径式 key」：
 *   setData({ 'dirRows[2].offsetX': -168 })
 * 手势逐帧改位移时用的就是路径式写法（避免整数组回传），
 * 桩若只支持顶层赋值，这些断言会全部读到旧值而假通过/假失败。
 */
function applySetData (data, patch) {
  Object.keys(patch).forEach((key) => {
    const path = key.replace(/\[(\d+)\]/g, '.$1').split('.')
    let node = data
    for (let i = 0; i < path.length - 1; i++) {
      const seg = path[i]
      if (node == null) return
      node = node[seg]
    }
    if (node == null) return
    node[path[path.length - 1]] = patch[key]
  })
}

function mount (pagePath, query) {
  lastPage = null
  delete require.cache[require.resolve(path.join(ROOT, pagePath))]
  require(path.join(ROOT, pagePath))
  const def = lastPage
  const inst = Object.assign({}, def)
  inst.data = JSON.parse(JSON.stringify(def.data || {}))
  inst.setData = function (patch, cb) {
    applySetData(inst.data, patch)
    if (cb) cb()
  }
  // 收集 data 更新的次数，用于观察是否发生「只改了一个字段却重建整份数据」之类的问题
  inst.__setCount = 0
  const rawSet = inst.setData
  inst.setData = function (patch, cb) { inst.__setCount++; return rawSet.call(inst, patch, cb) }
  if (typeof def.onLoad === 'function') def.onLoad.call(inst, query || {})
  if (typeof def.onReady === 'function') def.onReady.call(inst)
  return inst
}

/** 合成事件对象 */
const ev = (dataset, detail) => ({
  currentTarget: { dataset: dataset || {} },
  target: { dataset: dataset || {} },
  detail: detail || {}
})

/**
 * 合成触摸事件。
 * 目录 / 条目行的点击、长按拖动、左滑全部走 touchstart/move/end，
 * 因此断言必须能构造带 touches 的事件，否则整条手势链路都是测不到的。
 */
const touchEv = (dataset, x, y) => ({
  currentTarget: { dataset: dataset || {} },
  target: { dataset: dataset || {} },
  touches: [{ clientX: x, clientY: y }],
  changedTouches: [{ clientX: x, clientY: y }],
  detail: {}
})

/**
 * 驱动一次完整的触摸序列。
 * @param {object} page 页面实例
 * @param {object} dataset 行/卡的 data-*
 * @param {Array} path [x, y] 轨迹；只给一个点表示「按下即抬起」（点击）
 * @param {object} opts { rects, panel, page } rects/panel 供编辑页拖动注入；
 *                      page:'index' 表示驱动首页卡片手势（onCardTouch*）
 */
function touchRow (page, dataset, path, opts) {
  const o = opts || {}
  const isIndex = o.page === 'index'
  const start = isIndex ? 'onCardTouchStart' : 'onRowTouchStart'
  const move = isIndex ? 'onCardTouchMove' : 'onRowTouchMove'
  const end = isIndex ? 'onCardTouchEnd' : 'onRowTouchEnd'

  // 抬手前先清掉长按定时器，避免测试里真的等 380ms 弹出菜单
  const stopTimer = () => {
    const t = isIndex ? page._cardTouch : page._rowTouch
    if (t && t.timer) { clearTimeout(t.timer); t.timer = null }
  }

  page[start](touchEv(dataset, path[0][0], path[0][1]))
  if (o.rects && !isIndex && page._rowTouch) {
    // enterRowDrag 靠 createSelectorQuery 异步量矩形；这里直接注入结果
    page._rowTouch.rects = o.rects
    page._rowTouch.panel = o.panel || { top: 0, bottom: 800 }
    page._rowTouch.mode = 'drag'
  }
  // 先清长按定时器，避免测试里真的等到长按触发菜单
  stopTimer()
  for (let i = 1; i < path.length; i++) {
    page[move](touchEv(dataset, path[i][0], path[i][1]))
  }
  const last = path[path.length - 1]
  page[end](touchEv(dataset, last[0], last[1]))
}

const store = require(path.join(ROOT, 'utils/store.js'))

/* ================================================================== */
section('1. 首页：我的简历')
const index = mount('pages/index/index.js')
ok('首页加载出示例简历', index.data.drafts.length === 1, 'drafts=' + index.data.drafts.length)
ok('首页缩略图 VM 已生成', !!(index.data.drafts[0] && index.data.drafts[0].vm))
ok('首页显示模板名', !!index.data.drafts[0].templateName, index.data.drafts[0].templateName)
// 缩略图缩放要按容器实际尺寸算：写死 0.28 时纸张 222px 塞进 100px 的框，
// 横向被裁掉 55%，用户只能看到简历中间一条
ok('首页缩略图缩放倍率按容器算出',
  typeof index.data.thumbScale === 'number' && index.data.thumbScale > 0.05 && index.data.thumbScale < 0.25,
  'thumbScale=' + index.data.thumbScale)
ok('首页缩略图完整放进卡片（不横向溢出）',
  794 * index.data.thumbScale <= 100,
  '纸面宽=' + (794 * index.data.thumbScale).toFixed(1))

index.onCreateBlank()
ok('空白简历已创建', store.state.resume.baseInfo.name === '')
ok('跳转到编辑器', calls.navigate[calls.navigate.length - 1] === '/pages/edit/edit')

/* ---- 卡片手势：点击进编辑 / 长按菜单（含删除） ----
 *
 * 卡片正面的「预览 / 复制 / 删除」三个按钮已移除，动作改为卡片手势；
 * 左滑删除已按用户要求去掉，删除入口只剩长按菜单。
 * 这里逐条驱动触摸序列，确保剩余动作都还在、且互不误触发。
 */
ok('卡片不再有预览/复制/删除按钮',
  (() => {
    const wxml = fs.readFileSync(path.join(ROOT, 'pages/index/index.wxml'), 'utf8')
    return !/class="acts"/.test(wxml) && !/catchtap="onPreview"/.test(wxml) && !/catchtap="onDuplicate"/.test(wxml)
  })())
ok('卡片绑定了触摸手势',
  (() => {
    const wxml = fs.readFileSync(path.join(ROOT, 'pages/index/index.wxml'), 'utf8')
    return /bindtouchstart="onCardTouchStart"/.test(wxml) && /bindtouchend="onCardTouchEnd"/.test(wxml)
  })())
ok('卡片已无左滑删除层',
  !/row-del/.test(fs.readFileSync(path.join(ROOT, 'pages/index/index.wxml'), 'utf8')))
ok('卡片位移字段已移除',
  !('offsetX' in index.data.drafts[0]))

{
  const cardId = index.data.drafts[0].id
  // 点击 → 进编辑器
  calls.navigate.length = 0
  touchRow(index, { id: cardId }, [[100, 100]], { page: 'index' })
  ok('点击卡片进入编辑器', calls.navigate[calls.navigate.length - 1] === '/pages/edit/edit')

  // 横向滑动不再承担任何职责：既不进编辑器，也不删除草稿
  const beforeCount = store.state.drafts.length
  calls.navigate.length = 0
  touchRow(index, { id: cardId }, [[300, 100], [180, 100]], { page: 'index' })
  ok('卡片横向滑动不误进编辑器', calls.navigate.length === 0, JSON.stringify(calls.navigate))
  ok('卡片横向滑动不删除草稿', store.state.drafts.length === beforeCount)
  ok('卡片横向滑动不产生位移状态', !('offsetX' in index.data.drafts[0]))

  // 删除入口：长按菜单 → 删除 → 二次确认
  calls.actionSheet = null
  modalAnswer = { confirm: true, content: '' }
  index.confirmRemove(cardId)
  ok('长按菜单删除可删除草稿', store.state.drafts.length === beforeCount - 1,
    'before=' + beforeCount + ' after=' + store.state.drafts.length)
}

{
  // 长按 → 弹菜单；抬手不得再触发「点击进编辑」
  const card = index.data.drafts[0]
  calls.actionSheet = null
  calls.navigate.length = 0
  index.onCardTouchStart(touchEv({ id: card.id }, 100, 100))
  index._cardTouch.timer && clearTimeout(index._cardTouch.timer)
  index._cardTouch.mode = 'menu'
  index.openCardMenu(card.id)
  ok('长按卡片弹出操作菜单',
    calls.actionSheet && calls.actionSheet.itemList.join('/') === '预览/复制到新简历/删除',
    JSON.stringify(calls.actionSheet && calls.actionSheet.itemList))
  index.onCardTouchEnd(touchEv({ id: card.id }, 100, 100))
  ok('长按后抬手不误进编辑器', calls.navigate.length === 0, JSON.stringify(calls.navigate))

  // 菜单里的「预览」
  calls.navigate.length = 0
  calls.actionSheet.success({ tapIndex: 0 })
  ok('菜单可预览草稿', calls.navigate[calls.navigate.length - 1].indexOf('/pages/preview/preview?id=') === 0,
    calls.navigate[calls.navigate.length - 1])

  // 菜单里的「复制」
  const n = store.state.drafts.length
  calls.actionSheet.success({ tapIndex: 1 })
  ok('菜单可复制草稿', store.state.drafts.length === n + 1, 'before=' + n + ' after=' + store.state.drafts.length)
}

/* ================================================================== */
section('2. 编辑器：加载 / 纸张 / 分页')
const edit = mount('pages/edit/edit.js')
ok('编辑器 VM 已生成', !!edit.data.vm)
ok('编辑器可编辑态', edit.data.vm.editable === true)
ok('编辑器算出了页数', edit.data.pages >= 1, 'pages=' + edit.data.pages)
ok('纸张盒高度 = 页数 × A4', Math.abs(edit.data.paperBoxH - edit.data.pages * 1123) < 0.01,
  edit.data.paperBoxH + ' vs ' + edit.data.pages * 1123)
ok('缩放已计算', edit.data.zoom > 0.2 && edit.data.zoom <= 1, 'zoom=' + edit.data.zoom)
ok('基本信息面板数据已填充', Object.keys(edit.data.baseInfo).length > 0)
ok('区块列表已填充', edit.data.dirRows.length === store.state.resume.sections.length)
/*
 * 目录只显示标题：不再下发条目明细 / 条目数，也不再有「编辑」按钮。
 * 这三条守住「去掉编辑按钮、只留标题」这个需求本身。
 */
ok('目录行只有标题字段', edit.data.dirRows.every((r) => typeof r.title === 'string' && r.visible !== undefined))
ok('目录行不再带条目明细', edit.data.dirRows.every((r) => r.items === undefined && r.itemCount === undefined))
{
  const wxml = fs.readFileSync(path.join(ROOT, 'pages/edit/edit.wxml'), 'utf8')
  // 从「---------- 目录 ----------」注释后的 <block> 开始截取，避免匹配到面板标题里的分支
  const dirStart = wxml.indexOf('<!-- ---------- 目录')
  const dirBlock = wxml.slice(dirStart, wxml.indexOf('</block>', dirStart))
  ok('目录里不再有「编辑」按钮', !/>编辑</.test(dirBlock))
  ok('目录里不再有上移 / 下移按钮', !/上移|下移/.test(wxml))
  ok('目录行绑定了触摸手势', /bindtouchstart="onRowTouchStart"/.test(dirBlock) && /bindtouchend="onRowTouchEnd"/.test(dirBlock))
  /*
   * 目录行左滑必须同时给出「显示 / 隐藏」与「删除」两个动作。
   * 「显示 / 隐藏」原先占着区块面板里一整行的大按钮（把条目列表挤下去），
   * 与目录行左滑能做的事重复。这三条守住它确实搬进了左滑，
   * 且没有残留旧的单动作 .row-del 层（那会与双动作的 .dir-acts 冲突）。
   */
  ok('目录行左滑有「显示 / 隐藏」动作',
    /class="act act-toggle"/.test(dirBlock) && /catchtap="onRowToggleVisible"/.test(dirBlock))
  ok('目录行左滑有「删除」动作',
    /class="act act-del"/.test(dirBlock) && /catchtap="onRowDelete"/.test(dirBlock))
  ok('目录行不再用单动作 .row-del 层（两个动作走 .dir-acts）',
    !/class="row-del"/.test(dirBlock))
  ok('目录行只渲染标题（无条目摘要）', !/sec-item|itemCount/.test(dirBlock))
}

/* ---- 工具栏精简：只留 3 个入口 ----
 *
 * 7 个入口时 320px 屏上每格只有 45.7px，图标与文字挤在一起。分两步精简：
 *   1. 撤销 / 重做（低频）移进「更多」浮层 → 5 格（320/5 = 64px）；
 *   2. 「基本信息」「照片」也去掉 → 3 格（320/3 ≈ 106.7px）。
 *      这两项在纸面上本就有入口（点姓名 / 信息栏进基本信息，
 *      点照片或「＋ 添加照片」占位进照片），工具栏再列一遍是重复入口。
 * 变异验证：把任意一格加回 tools-inner，第一条断言立刻失败。
 */
{
  const wxml = fs.readFileSync(path.join(ROOT, 'pages/edit/edit.wxml'), 'utf8')
  const toolsBlock = wxml.slice(wxml.indexOf('<view class="tools">'), wxml.indexOf('<!-- ============ 顶部浮层菜单'))
  const entries = (toolsBlock.match(/class="tool /g) || []).length
  ok('工具栏只剩 3 个入口（目录 / 样式 / 更多）', entries === 3, '实测 ' + entries + ' 个')
  ok('工具栏里不再有撤销 / 重做按钮',
    !/bindtap="onUndo"[\s\S]{0,80}tool-label/.test(toolsBlock) && !/onRedo/.test(toolsBlock))
  /* 基本信息 / 照片不能再从工具栏进：去掉后必须是「纸面点击」这一个入口，
     否则用户就真的找不到这两个功能了（下面几条会验证纸面入口确实在）。 */
  ok('工具栏里不再有「基本信息」入口',
    !/data-panel="base"/.test(toolsBlock))
  ok('工具栏里不再有「照片」入口',
    !/data-panel="photo"/.test(toolsBlock))
  ok('工具栏仍保留「更多」入口（撤销重做要从这里进）',
    /bindtap="onMenu"/.test(toolsBlock))
  // 撤销 / 重做必须在浮层里找得到，否则它们就被彻底藏没了
  const menuBlock = wxml.slice(wxml.indexOf('class="menu-pop"'), wxml.indexOf('<!-- ============ 纸张画布'))
  ok('「更多」浮层里有撤销与重做',
    /bindtap="onUndo"/.test(menuBlock) && /bindtap="onRedo"/.test(menuBlock))
  ok('撤销 / 重做在浮层里用行而不是按钮（不再出现一排按钮）',
    !/class="btn/.test(menuBlock), '浮层内按钮数=' + (menuBlock.match(/class="btn/g) || []).length)
  ok('不可撤销时给出原因说明（不是点了没反应）',
    /menu-row-hint/.test(menuBlock) && /canUndo/.test(menuBlock))
}

/* ---- 基本信息 / 照片的面板与纸面入口都必须还在 ----
 *
 * 工具栏那两格去掉的前提是「纸面点击能进这两个面板」。这两件事必须同时成立：
 * 面板分支被删，或纸面上的 data-base / data-photo / data-photo-add 标记被删，
 * 都会让用户彻底够不到功能。因此这里把两头都钉住。
 */
{
  const wxml = fs.readFileSync(path.join(ROOT, 'pages/edit/edit.wxml'), 'utf8')
  ok('基本信息面板分支仍保留', /wx:elif="\{\{panel === 'base'\}\}"/.test(wxml))
  ok('照片面板分支仍保留', /wx:elif="\{\{panel === 'photo'\}\}"/.test(wxml))

  const paper = fs.readFileSync(path.join(ROOT, 'components/resume-paper/paper.wxml'), 'utf8')
  const side = fs.readFileSync(path.join(ROOT, 'components/resume-paper/side.wxml'), 'utf8')
  ok('纸面仍可点姓名 / 信息栏进基本信息（data-base 标记在）',
    /data-base="name"/.test(paper) && /data-base="name"/.test(side) &&
    /data-base="\{\{item\.key\}\}"/.test(paper))
  ok('纸面仍可点照片进照片面板（data-photo 标记在）',
    /data-photo="1"/.test(paper) && /data-photo="1"/.test(side))
  ok('没有照片时仍有「添加照片」占位可点（否则空简历进不去照片面板）',
    /data-photo-add="1"/.test(paper) && /data-photo-add="1"/.test(side))

  // 纸面点击 → 面板：直接跑 onPick，确认两条路径都能落到正确的面板
  const target = store.state.resume.sections[0]
  edit.onPick({ detail: { base: 'name' } })
  ok('点纸面基本信息 → 打开基本信息面板', edit.data.panel === 'base',
    'panel=' + edit.data.panel)
  edit.onPick({ detail: { photo: true } })
  ok('点纸面照片 → 打开照片面板', edit.data.panel === 'photo',
    'panel=' + edit.data.panel)
  edit.onPick({ detail: { sec: target.id, item: '' } })
  ok('点区块标题仍进区块面板（未被上面的改动影响）', edit.data.panel === 'section',
    'panel=' + edit.data.panel)
}

/* ---- 点击标题 → 直接进入该区块编辑（替代原来的「编辑」按钮） ---- */
{
  const target = store.state.resume.sections[0]
  touchRow(edit, { list: 'dir', id: target.id, index: 0 }, [[100, 100]])
  ok('点目录标题即进入区块编辑', edit.data.panel === 'section', 'panel=' + edit.data.panel)
  ok('选中的正是被点的区块', edit.data.currentSection && edit.data.currentSection.id === target.id)
}

/* ---- 左滑：露出动作层（显示/隐藏 + 删除）但不改数据，且不误进编辑面板 ---- */
{
  const target = store.state.resume.sections[0]
  const before = store.state.resume.sections.length
  const panelBefore = edit.data.panel
  // 滑 20px（≈38rpx，未达动作区一半宽）→ 应回弹
  touchRow(edit, { list: 'dir', id: target.id, index: 0 }, [[200, 100], [180, 100]])
  const row = edit.data.dirRows.find((r) => r.id === target.id)
  ok('小幅左滑后回弹到原位', row && row.offsetX === 0, 'offsetX=' + (row && row.offsetX))
  ok('左滑不会误触发编辑', edit.data.panel === panelBefore, 'panel=' + edit.data.panel)
  ok('左滑不删除数据', store.state.resume.sections.length === before)

  // 滑足动作区宽度 → 吸附展开
  touchRow(edit, { list: 'dir', id: target.id, index: 0 }, [[300, 100], [180, 100]])
  const row2 = edit.data.dirRows.find((r) => r.id === target.id)
  ok('大幅左滑后吸附露出动作层', row2 && row2.offsetX < 0, 'offsetX=' + (row2 && row2.offsetX))
  /*
   * 目录行露两个动作、条目行只露一个，因此宽度是两条不同的常量。
   * 行内位移必须与「该行动作层的总宽」严格一致，否则会出现
   * 「吸住了但最右边的动作露不全」或「滑过头露出一片空白」。
   */
  ok('目录行左滑宽度与双动作常量一致',
    row2 && Math.abs(row2.offsetX) === edit._DIR_ACTS_W_RPX,
    'offsetX=' + (row2 && row2.offsetX) + ' 常量=' + edit._DIR_ACTS_W_RPX)
  ok('目录行与条目行的左滑宽度是两条不同的常量',
    edit._DIR_ACTS_W_RPX > edit._DEL_W_RPX,
    edit._DIR_ACTS_W_RPX + ' vs ' + edit._DEL_W_RPX)
  // 展开状态下点行内其他位置：先收回，不直接进编辑
  touchRow(edit, { list: 'dir', id: target.id, index: 0 }, [[300, 100]])
  const row3 = edit.data.dirRows.find((r) => r.id === target.id)
  ok('展开状态下点行 → 先收回动作层', row3 && row3.offsetX === 0)
}

/* ---- 条目行左滑仍只用「删除」那一档宽度 ---- */
{
  edit.onPick({ detail: { sec: store.state.resume.sections[0].id } })
  const sec = store.state.resume.sections[0]
  const it = sec.items[0]
  touchRow(edit, { list: 'item', id: it.id, index: 0 }, [[300, 100], [180, 100]])
  const irow = edit.data.currentSection.items.find((r) => r.id === it.id)
  ok('条目行左滑吸附宽度与删除常量一致',
    irow && Math.abs(irow.offsetX) === edit._DEL_W_RPX,
    'offsetX=' + (irow && irow.offsetX) + ' 常量=' + edit._DEL_W_RPX)
  // 收回，避免影响后续断言
  touchRow(edit, { list: 'item', id: it.id, index: 0 }, [[180, 100]])
}

/* ---- 长按不拖动（原地放下）不应产生顺序变化 ---- */
{
  const idsBefore = store.state.resume.sections.map((x) => x.id)
  const rows = idsBefore.map((_, i) => ({ top: i * 60, bottom: i * 60 + 60, height: 60 }))
  /*
   * 手指坐标必须落在被拖那一行内，否则用例自身就不自洽：
   * 落点由「手指当前压在哪一行」决定，若声明 index:0 却把手指定在 y=100
   * （那是第 2 行），落点自然是 2，顺序会变——那测的就不是「原地放下」了。
   */
  touchRow(edit, { list: 'dir', id: idsBefore[0], index: 0 }, [[100, 20], [100, 21]], { rects: rows })
  ok('长按原地放下不改变顺序',
    JSON.stringify(store.state.resume.sections.map((x) => x.id)) === JSON.stringify(idsBefore))
}

/* ---- 拖动位移要真的跟手（offsetY 随手指累计） ---- */
{
  const ids = store.state.resume.sections.map((x) => x.id)
  const rows = ids.map((_, i) => ({ top: i * 60, bottom: i * 60 + 60, height: 60 }))
  touchRow(edit, { list: 'dir', id: ids[0], index: 0 }, [[100, 20], [100, 80]], { rects: rows })
  const moved = store.state.resume.sections.find((x) => x.id === ids[0])
  ok('拖动后该区块仍在（未丢失）', !!moved)
}

/* ---- 拖动期间必须锁住面板滚动（否则列表会跟着手指一起下滑）----
 *
 * 这条缺陷的根因在 WXML 而不是 JS：.panel-body 是 scroll-view，行上的
 * bindtouchmove 只是冒泡监听、拦不住 scroll-view 自己的原生滚动，于是
 * 「行按 translateY 跟手位移」与「列表整体按手势滚动」同时发生，拖动行
 * 以约两倍于手指的速度下滑，用户看到的就是「拖动的时候页面也跟着下滑」。
 *
 * 因此断言必须落在「scroll-y 是否随拖动状态关闭」上——只驱动 JS 手势函数
 * 是测不到的。变异验证：把 scroll-y="{{!rowDrag.active}}" 改回 scroll-y，
 * 下面第一条断言立刻失败。
 */
{
  const wxml = fs.readFileSync(path.join(ROOT, 'pages/edit/edit.wxml'), 'utf8')
  const bodyTag = (wxml.match(/<scroll-view class="panel-body"[^>]*>/) || [])[0] || ''
  ok('面板滚动随拖动状态关闭（拖动时列表不跟着下滑）',
    /scroll-y="\{\{!rowDrag\.active\}\}"/.test(bodyTag),
    bodyTag.replace(/\s+/g, ' ').slice(0, 140))
  // 边缘自动滚动靠 scroll-top 驱动，关掉 scroll-y 不能把它一起弄没
  ok('面板仍保留 scroll-top（拖动边缘自动滚动依赖它）',
    /scroll-top="\{\{panelScrollTop\}\}"/.test(bodyTag),
    bodyTag.replace(/\s+/g, ' ').slice(0, 140))
}

/* ---- 拖动状态在抬手 / 面板切换后都必须复位 ----
 * active 残留为 true 会让 scroll-y 一直是 false，列表从此滚不动，
 * 所以「拖动中切面板」这种中途离场也必须兜底复位。
 */
{
  const ids = store.state.resume.sections.map((x) => x.id)
  const rows = ids.map((_, i) => ({ top: i * 60, bottom: i * 60 + 60, height: 60 }))
  const ds = { list: 'dir', id: ids[0], index: 0 }
  edit.onRowTouchStart(touchEv(ds, 100, 20))
  // enterRowDrag 靠 createSelectorQuery 异步量矩形；这里直接注入结果
  edit._rowTouch.rects = rows
  edit._rowTouch.panel = { top: 0, bottom: 800 }
  edit._rowTouch.mode = 'drag'
  if (edit._rowTouch.timer) { clearTimeout(edit._rowTouch.timer); edit._rowTouch.timer = null }
  edit.setData({ rowDrag: { list: 'dir', id: ids[0], index: 0, active: true } })

  ok('拖动进行中面板处于锁定状态', edit.data.rowDrag.active === true,
    JSON.stringify(edit.data.rowDrag))

  const panelBefore = edit.data.panel
  edit.onPanel(ev({ panel: 'base' }))
  ok('拖动中切面板会复位拖动状态（列表不会永久锁住滚动）',
    edit.data.rowDrag.active === false, JSON.stringify(edit.data.rowDrag))
  ok('拖动中切面板会清掉触摸状态', edit._rowTouch === null)
  // 复位后原面板选择不受影响（这里只验证状态机，不改变原有交互语义）
  edit.setData({ panel: panelBefore })
}

/* ---- 纸面点击仍应打开对应面板（手势改动不能破坏这条老能力） ---- */
const firstSec = store.state.resume.sections[0]
const firstItem = firstSec.items[0]
edit.onPick({ detail: { sec: firstSec.id, item: firstItem.id, field: 'centerContent' } })
ok('点纸面条目 → 打开条目面板', edit.data.panel === 'item')
ok('条目数据正确', edit.data.currentItem && edit.data.currentItem.id === firstItem.id)

edit.onPick({ detail: { sec: firstSec.id } })
ok('点纸面区块标题 → 打开区块面板', edit.data.panel === 'section')
ok('区块数据正确', edit.data.currentSection && edit.data.currentSection.id === firstSec.id)

edit.onPick({ detail: { base: 'phone' } })
ok('点基本信息 → 打开基本信息面板', edit.data.panel === 'base')
ok('定位到对应字段', edit.data.focusKey === 'phone')

/* ================================================================== */
section('2b. 纸张组件：纸面点击必须真的能落到字段上')
/*
 * 这一节专门守住一个曾经真实存在的 P0：
 *
 * 界面承诺「点纸面任意文字即可编辑」，但 onTap 只读 e.target.dataset，
 * 而小程序里 e.target 是「被点到的最内层节点」——用户点字形时事件源是
 * 渲染文字的内层节点，dataset 又不继承，于是拿到空对象被守卫拦掉；
 * 点栏目空白拿到 {field} 同样被拦。结果纸面点击实际完全无效。
 *
 * 之所以长期没被发现：上面的用例直接构造 edit.onPick({detail:{...}})，
 * 绕过了组件里的 onTap。所以这里必须真正 require 组件、驱动 onTap。
 */
const paperComp = (() => {
  delete require.cache[require.resolve(path.join(ROOT, 'components/resume-paper/paper.js'))]
  require(path.join(ROOT, 'components/resume-paper/paper.js'))
  return lastComp
})()
ok('纸张组件已加载', !!(paperComp && paperComp.methods && paperComp.methods.onTap))

/** 造一个组件实例：捕获 triggerEvent 抛出的 pick 事件 */
function mountPaper () {
  const evs = []
  const inst = Object.assign({}, paperComp.methods)
  inst.data = {}
  inst.setData = function (p) { Object.assign(inst.data, p || {}) }
  inst.triggerEvent = (name, detail) => evs.push({ name, detail })
  inst.evs = evs
  return inst
}

/** 合成纸面点击事件；target = 真正被点到的最内层节点 */
const tapEv = (targetDs, currentDs) => ({
  target: { dataset: targetDs || {} },
  currentTarget: { dataset: currentDs || {} }
})

const pSec = store.state.resume.sections[0]
const pItem = pSec.items[0]

// ① 点在文字字形上：事件源是内层文字节点，它自身带 data-*
let pInst = mountPaper()
pInst.onTap(tapEv({ sec: pSec.id, item: pItem.id, field: 'centerContent' }))
ok('点文字字形 → 抛出 pick（不再被守卫拦掉）',
  pInst.evs.length === 1 && pInst.evs[0].name === 'pick',
  JSON.stringify(pInst.evs))
ok('点文字字形 → 解析出正确的区块与条目',
  pInst.evs[0] && pInst.evs[0].detail.sec === pSec.id && pInst.evs[0].detail.item === pItem.id,
  JSON.stringify(pInst.evs[0] && pInst.evs[0].detail))

// ② 点在栏目空白上：事件源是承载该栏的 view（带 field + sec/item）
pInst = mountPaper()
pInst.onTap(tapEv({ sec: pSec.id, item: pItem.id, field: 'leftContent' }))
ok('点栏目空白 → 抛出 pick 且字段正确',
  pInst.evs.length === 1 && pInst.evs[0].detail.field === 'leftContent',
  JSON.stringify(pInst.evs))

// ③ 只有 field、没有 sec/item 的历史写法：应退回 currentTarget 补齐标记
pInst = mountPaper()
pInst.onTap(tapEv({ field: 'centerContent' }, { sec: pSec.id, item: pItem.id }))
ok('只有 field 时可从 currentTarget 补齐标记',
  pInst.evs.length === 1 && pInst.evs[0].detail.sec === pSec.id,
  JSON.stringify(pInst.evs))

// ④ 基本信息与照片的落点
pInst = mountPaper()
pInst.onTap(tapEv({ base: 'phone' }))
ok('点基本信息字段 → 抛出 pick.base', pInst.evs[0] && pInst.evs[0].detail.base === 'phone')
pInst = mountPaper()
pInst.onTap(tapEv({ photo: '1' }))
ok('点照片 → 抛出 pick.photo', pInst.evs[0] && pInst.evs[0].detail.photo === true)
pInst = mountPaper()
// WXML 写 data-photo-add="1"，小程序按连字符转驼峰规则暴露为 dataset.photoAdd
pInst.onTap(tapEv({ photoAdd: '1' }))
ok('点「添加照片」落点 → 抛出 pick.photoAdd',
  pInst.evs[0] && pInst.evs[0].detail.photoAdd === true,
  JSON.stringify(pInst.evs))

// ⑤ 真的点到纸张空白处（无任何标记）时不应误触发
pInst = mountPaper()
pInst.onTap(tapEv({}))
ok('点到无标记空白 → 不抛出事件', pInst.evs.length === 0)

// ⑥ 静态守住：section.wxml 的文字叶子必须带 data-*（组件侧的另一半保险）
const secWxml = fs.readFileSync(path.join(ROOT, 'components/resume-paper/section.wxml'), 'utf8')
const secNoComment = secWxml.replace(/<!--[\s\S]*?-->/g, '')
const textTags = secNoComment.match(/<text\b[^>]*>/g) || []
ok('section.wxml 的文字节点都带 data-sec/data-item',
  textTags.length >= 2 && textTags.every((t) => /data-sec=/.test(t) && /data-item=/.test(t)),
  'text 节点数=' + textTags.length + ' 带标记=' + textTags.filter((t) => /data-sec=/.test(t)).length)

/*
 * ⑦ 屏幕渲染与引擎几何必须同源。
 *
 * layout.js 的 renderedFields() 决定「引擎认为渲染了哪几栏」（进而决定每栏
 * 的列位与整页高度），paper.js 的 usesCol() 决定「WXML 实际渲染哪几栏」。
 * 两者一旦分家，就会出现「屏幕上文字靠左、导出的 PNG 里却靠右」这类错位。
 *
 * 此前 renderedFields() 漏了 editable 这一维（只读态也按类型补出空栏），
 * 24 种「类型 × 填充组合」里有 17 种与 usesCol 不一致：THREE 条目只填正文时，
 * 屏幕按 1 个栏位落在第 1 列，引擎却按 3 栏把正文算到第 2 列（错位约一整列）。
 */
const { usesCol } = require(path.join(ROOT, 'utils/paper.js'))
const LAY = require(path.join(ROOT, 'utils/layout.js'))
const ALL_FIELDS = ['leftContent', 'centerContent', 'rightContent']
let fieldMismatch = []
for (const editable of [true, false]) {
  for (const type of ['ONE', 'TWO', 'THREE']) {
    for (let mask = 0; mask < 8; mask++) {
      const it = {
        type,
        leftContent: (mask & 1) ? 'L' : '',
        centerContent: (mask & 2) ? 'C' : '',
        rightContent: (mask & 4) ? 'R' : ''
      }
      const engine = JSON.stringify(LAY.renderedFields(it, editable))
      const wxml = JSON.stringify(ALL_FIELDS.filter((f) => usesCol(it, f, editable)))
      if (engine !== wxml) fieldMismatch.push('editable=' + editable + ' ' + type + ' mask=' + mask + ' ' + engine + ' vs ' + wxml)
    }
  }
}
ok('引擎与 WXML 的栏位判定完全同源（48 种组合）',
  fieldMismatch.length === 0,
  fieldMismatch.slice(0, 3).join(' | ') + (fieldMismatch.length ? ' …共 ' + fieldMismatch.length + ' 处' : ''))

// 只读态下 THREE 条目只填正文时，正文必须落在第一列（与屏幕一致）
;(() => {
  // 注意：全局的 `model` 在脚本后段才声明，这里单独 require 以免踩 TDZ
  const M = require(path.join(ROOT, 'utils/model.js'))
  const r = M.normalizeResume(M.createBlankResume())
  r.sections = [M.createSection('测试', [M.createItem('THREE', { centerContent: '只有正文' })])]
  const g = LAY.layoutResume(r)
  const S = g.pageStyle || g.style
  const cells = g.sections[0].items[0].cells
  const first = cells[0]
  ok('只读态 THREE 仅正文 → 正文落在第一列（不错位到中间列）',
    cells.length === 1 && first.field === 'centerContent' && Math.abs(first.x - S.hPad) < 1,
    'cells=' + JSON.stringify(cells.map((c) => c.field)) + ' relX=' + (first && (first.x - S.hPad)))
})()

/* ================================================================== */
section('3. 编辑器：文本编辑（输入 → 失焦落盘）')
const targetItem = store.state.resume.sections[0].items[0]
edit.setData({ panel: 'item', sel: { sec: store.state.resume.sections[0].id, item: targetItem.id } })
edit.syncSelection()
const beforeText = store.state.resume.sections[0].items[0].centerContent
edit.onInput(ev({ scope: 'item', sec: store.state.resume.sections[0].id, item: targetItem.id, field: 'centerContent' }, { value: '新的正文内容' }))
ok('输入期间不写回 store（避免光标重置）', store.state.resume.sections[0].items[0].centerContent === beforeText)
ok('输入期间标记为未保存', edit.data.dirty === true)
edit.onBlur(ev({ scope: 'item', sec: store.state.resume.sections[0].id, item: targetItem.id, field: 'centerContent' }, { value: '新的正文内容' }))
ok('失焦后写入 store', store.state.resume.sections[0].items[0].centerContent === '新的正文内容')
ok('VM 同步刷新', edit.data.vm.sections[0].itemVMs[0].cells.some((c) => c.text === '新的正文内容'))

/* ---- 切面板时把未提交的输入落定 ---- */
edit.onInput(ev({ scope: 'base', key: 'phone' }, { value: '13900000000' }))
edit.commitPending()
ok('切面板前提交未落定的输入', store.state.resume.baseInfo.phone === '13900000000')

/* ---- 基本信息字段开关 ---- */
const fieldOn = store.state.resume.baseFields.includes('email')
edit.onToggleField(ev({ key: 'email' }))
ok('字段开关切换生效', store.state.resume.baseFields.includes('email') === !fieldOn)

/* ================================================================== */
section('4. 编辑器：区块与条目增删改移')
const secCount = store.state.resume.sections.length
modalAnswer = { confirm: true, content: '校园经历' }
edit.onAddSection()
ok('新增区块', store.state.resume.sections.length === secCount + 1)
const newSec = store.state.resume.sections[store.state.resume.sections.length - 1]
ok('新区块名称正确', newSec.title === '校园经历')
ok('新增后面板切到该区块', edit.data.currentSection.id === newSec.id)

edit.onAddItem(ev({ type: 'THREE' }))
ok('新增条目', store.state.resume.sections[store.state.resume.sections.length - 1].items.length === 2)
ok('新增后进入条目面板', edit.data.panel === 'item')

const itemCountBefore = store.state.resume.sections[store.state.resume.sections.length - 1].items.length
edit.onSetItemType(ev({ type: 'ONE' }))
const cur = store.state.resume.sections.find((s) => s.id === edit.data.sel.sec)
ok('条目类型切换', cur.items.find((i) => i.id === edit.data.sel.item).type === 'ONE')

/* ---- 条目面板：字段随排版类型走，标签用大白话 ----
 *
 * 原来 WXML 里写死「左栏（学校 / 公司）/ 正文 / 右栏（时间）」三个输入框，
 * 只用一个 `type !== 'ONE'` 判断隐藏左右两栏。这里守住新的口径：
 * 只渲染当前排版真的会画出来的栏位，且 ONE 型的那一栏不能还叫「说明」。
 * 变异验证：把 itemFields() 的 ONE 分支改成返回三栏，
 * 「ONE 型只给一个输入框」立刻失败。
 */
{
  const labelsOf = () => (edit.data.currentItem.fields || []).map((f) => f.field)
  ok('ONE 型只给一个输入框', JSON.stringify(labelsOf()) === JSON.stringify(['centerContent']),
    JSON.stringify(labelsOf()))
  ok('ONE 型的那一栏叫「内容」而不是「说明」',
    edit.data.currentItem.fields[0].label === '内容',
    edit.data.currentItem.fields[0].label)

  edit.onSetItemType(ev({ type: 'TWO' }))
  ok('TWO 型给「标题 + 时间」两个输入框（没有中间栏）',
    JSON.stringify(labelsOf()) === JSON.stringify(['leftContent', 'rightContent']),
    JSON.stringify(labelsOf()))

  edit.onSetItemType(ev({ type: 'THREE' }))
  ok('THREE 型给三个输入框',
    JSON.stringify(labelsOf()) === JSON.stringify(['leftContent', 'centerContent', 'rightContent']),
    JSON.stringify(labelsOf()))
  ok('三个输入框的标签是大白话（标题 / 说明 / 时间）',
    edit.data.currentItem.fields.map((f) => f.label).join('/') === '标题/说明/时间',
    edit.data.currentItem.fields.map((f) => f.label).join('/'))
  ok('每个输入框都带示例占位文案',
    edit.data.currentItem.fields.every((f) => typeof f.ph === 'string' && f.ph.indexOf('例如') === 0),
    JSON.stringify(edit.data.currentItem.fields.map((f) => f.ph)))

  /*
   * 口径必须与纸张组件一致：编辑器让人填的栏，屏幕上必须真的画得出来。
   * 否则用户填进去的内容在纸面上根本不出现，会以为输入丢了。
   */
  const P = require(path.join(ROOT, 'utils/paper.js'))
  let fieldMismatch = []
  for (const type of ['ONE', 'TWO', 'THREE']) {
    const item = { type, leftContent: '', centerContent: '', rightContent: '' }
    const shown = ['leftContent', 'centerContent', 'rightContent'].filter((f) => P.usesCol(item, f, true))
    const editable = edit.itemFields(item).map((f) => f.field)
    if (JSON.stringify(shown) !== JSON.stringify(editable)) {
      fieldMismatch.push(type + ' 屏幕=' + JSON.stringify(shown) + ' 面板=' + JSON.stringify(editable))
    }
  }
  ok('条目面板的字段与纸张渲染的栏位完全同源',
    fieldMismatch.length === 0, fieldMismatch.join(' | '))

  // 排版说明语只说当前这一条，不再把三种一次讲完
  const hints = ['ONE', 'TWO', 'THREE'].map((t) => edit.itemTypeHint(t))
  ok('每种排版各有一句说明，且互不相同',
    new Set(hints).size === 3 && hints.every((h) => h.length > 8), JSON.stringify(hints))
  ok('当前排版的说明会下发给面板',
    edit.data.currentItem.typeHint === edit.itemTypeHint(edit.data.currentItem.type),
    edit.data.currentItem.typeHint)
}

/*
 * 条目顺序改由「长按拖动」调整（上移 / 下移按钮已移除）。
 * 这里真正驱动触摸序列，覆盖排序落点是否写回 store。
 */
{
  const sec = store.state.resume.sections.find((s) => s.id === edit.data.sel.sec)
  const idsBefore = sec.items.map((x) => x.id)
  const rows = sec.items.map((_, i) => ({ top: i * 60, bottom: i * 60 + 60, height: 60 }))
  const movingId = idsBefore[idsBefore.length - 1]
  // 拖到第一行中线以上 → 落点索引 0
  touchRow(edit, { list: 'item', id: movingId, index: idsBefore.length - 1 },
    [[100, 100], [100, 20]], { rects: rows })
  const after = store.state.resume.sections.find((s) => s.id === edit.data.sel.sec).items.map((x) => x.id)
  ok('条目拖动后顺序写回 store', after[0] === movingId, JSON.stringify(after))
  ok('拖动不丢条目', after.length === idsBefore.length, 'before=' + idsBefore.length + ' after=' + after.length)
  // 拖回原位，避免影响后续断言
  const rows2 = after.map((_, i) => ({ top: i * 60, bottom: i * 60 + 60, height: 60 }))
  touchRow(edit, { list: 'item', id: movingId, index: 0 },
    [[100, 20], [100, rows2.length * 60]], { rects: rows2 })
}

/* 区块顺序同样由拖动调整（目录里的长按拖动） */
{
  const idsBefore = store.state.resume.sections.map((x) => x.id)
  const rows = idsBefore.map((_, i) => ({ top: i * 60, bottom: i * 60 + 60, height: 60 }))
  const movingId = idsBefore[idsBefore.length - 1]
  touchRow(edit, { list: 'dir', id: movingId, index: idsBefore.length - 1 },
    [[100, 100], [100, 5]], { rects: rows })
  const after = store.state.resume.sections.map((x) => x.id)
  ok('区块拖动后顺序写回 store', after[0] === movingId, JSON.stringify(after))
  ok('拖动不丢区块', after.length === idsBefore.length)
  // 拖回末位
  const rows2 = after.map((_, i) => ({ top: i * 60, bottom: i * 60 + 60, height: 60 }))
  touchRow(edit, { list: 'dir', id: movingId, index: 0 },
    [[100, 5], [100, rows2.length * 60]], { rects: rows2 })
}

/*
 * 区块的「显示 / 隐藏」改由目录行左滑触发（onRowToggleVisible）。
 * 它必须真的改数据、并且把行的位移收回原位——否则用户切完可见性，
 * 行还停在滑开状态，「已隐藏」标记与两个动作一直敞在那儿。
 */
{
  const secId = edit.data.sel.sec
  edit.setData({ dirRows: edit.data.dirRows.map((r) => (r.id === secId ? Object.assign({}, r, { offsetX: -300 }) : r)) })
  edit.onRowToggleVisible(ev({ list: 'dir', id: secId }))
  ok('左滑「隐藏」切换生效', store.state.resume.sections.find((s) => s.id === secId).visible === false)
  const hidRow = edit.data.dirRows.find((r) => r.id === secId)
  ok('切换后行收回原位（不留半开的动作层）', hidRow && !hidRow.offsetX, 'offsetX=' + (hidRow && hidRow.offsetX))
  ok('隐藏状态同步到目录行（列表上标「已隐藏」）', hidRow && hidRow.visible === false)
  edit.onRowToggleVisible(ev({ list: 'dir', id: secId }))
  ok('左滑「显示」切换恢复', store.state.resume.sections.find((s) => s.id === secId).visible === true)
}

/* 删除条目 / 区块改由左滑露出的删除按钮触发（onRowDelete） */
modalAnswer = { confirm: true, content: '' }
edit.onRowDelete(ev({ list: 'item', id: edit.data.sel.item }))
ok('左滑删除条目', store.state.resume.sections.find((s) => s.id === edit.data.sel.sec).items.length === itemCountBefore - 1)

const delSecId = newSec.id
edit.onRowDelete(ev({ list: 'dir', id: delSecId }))
ok('左滑删除区块', store.state.resume.sections.length === secCount)
ok('删掉当前编辑区块后退回目录', edit.data.panel === 'sections')

/* ================================================================== */
section('5. 编辑器：样式面板')
const tplBefore = store.state.resume.templateId
edit.onTemplate(ev({ id: 'modern' }))
ok('应用模板', store.state.resume.templateId === 'modern')
ok('模板改变了配色', store.state.resume.headingColor === '#7a3b6a')
ok('模板改变了布局', store.state.resume.pageLayout === 'RIGHT')
ok('换模板保留了内容', store.state.resume.sections.length > 0)
ok('VM 按新模板重建', edit.data.vm.layout === 'RIGHT')
ok('双栏 VM 有信息栏数据', !!edit.data.vm.side && edit.data.vm.side.list.length > 0)

edit.onColor(ev({ id: 'teal' }))
ok('配色切换', store.state.resume.headingColor === '#12695c')

// 自由调色：预设之外的任意主题色，需容错 3 位简写、缺 # 与非法输入
modalAnswer = { confirm: true, content: '#8c2f39' }
edit.onColorPick()
ok('自定义颜色写入', store.state.resume.headingColor === '#8c2f39', store.state.resume.headingColor)
modalAnswer = { confirm: true, content: 'abc' }
edit.onColorPick()
ok('3 位简写颜色自动展开', store.state.resume.headingColor === '#aabbcc', store.state.resume.headingColor)
modalAnswer = { confirm: true, content: '12695C' }
edit.onColorPick()
ok('缺 # 的颜色自动补全并转小写', store.state.resume.headingColor === '#12695c', store.state.resume.headingColor)
modalAnswer = { confirm: true, content: '不是颜色' }
const colorBefore = store.state.resume.headingColor
edit.onColorPick()
ok('非法颜色被拒绝且不改动原值', store.state.resume.headingColor === colorBefore,
  'before=' + colorBefore + ' after=' + store.state.resume.headingColor)
modalAnswer = { confirm: true, content: '' }

edit.onFont(ev({}, { value: 2 }))
ok('字体切换', store.state.resume.fontFamily === 'heiti')
edit.onHeading(ev({}, { value: 5 }))
ok('标题装饰切换', store.state.resume.headingTheme === 'dot')
edit.onBorder(ev({}, { value: 3 }))
ok('边框切换', store.state.resume.borderTheme === 'dashed')
edit.onLayout(ev({}, { value: 0 }))
ok('布局切换', store.state.resume.pageLayout === 'SINGLE')
edit.onToggleCenter()
ok('标题居中切换', store.state.resume.headingCenter === true)
const accentBefore = store.state.resume.accentBlock
edit.onToggleAccent()
ok('信息栏底色块切换', store.state.resume.accentBlock === !accentBefore,
  accentBefore + ' → ' + store.state.resume.accentBlock)

edit.onSize(ev({ key: 'fontSize' }, { value: 16 }))
ok('字号滑杆', store.state.resume.fontSize === 16)
edit.onSize(ev({ key: 'lineHeight' }, { value: 1.9 }))
ok('行距滑杆', store.state.resume.lineHeight === 1.9)
edit.onSize(ev({ key: 'sectionSpacing' }, { value: 24 }))
ok('区块间距滑杆', store.state.resume.sectionSpacing === 24)
edit.onSize(ev({ key: 'baseInfoRatio' }, { value: 33 }))
ok('信息栏宽度滑杆', store.state.resume.baseInfoRatio === 33)

/* ---- 8 种标题装饰 × 3 种布局：全部要能算出几何而不抛异常 ---- */
section('6. 全组合压力：18 模板 × 9 标题装饰 × 4 边框 × 3 布局')
const L = require(path.join(ROOT, 'utils/layout.js'))
const model = require(path.join(ROOT, 'utils/model.js'))
const { buildPaperVM } = require(path.join(ROOT, 'utils/paper.js'))
let combos = 0
let comboErr = null
for (const t of model.TEMPLATES) {
  for (const h of model.HEADING_THEMES) {
    for (const b of model.BORDER_THEMES) {
      for (const lay of model.PAGE_LAYOUTS) {
        try {
          store.applyTemplate(t.id, { keepContent: true })
          store.setStyle('headingTheme', h.id)
          store.setStyle('borderTheme', b.id)
          store.setStyle('pageLayout', lay.id)
          const r = store.state.resume
          buildPaperVM(r, { editable: true })
          buildPaperVM(r, { editable: false })
          const p = L.paginateResume(r, null, { editable: true })
          if (!(p.pages >= 1) || !isFinite(p.minHeight)) throw new Error('页数异常 ' + p.pages)
          combos++
        } catch (e) {
          comboErr = t.id + '/' + h.id + '/' + b.id + '/' + lay.id + ' → ' + e.message
          break
        }
      }
      if (comboErr) break
    }
    if (comboErr) break
  }
  if (comboErr) break
}
ok('全组合渲染与分页无异常（' + combos + ' 组）', !comboErr, comboErr || '')

/* ================================================================== */
section('7. 编辑器：智能压缩到一页')
// 前面几步删过区块，这里重新铺一份内容充足的示例简历
store.create({ blank: false })
store.applyTemplate('classic', { keepContent: true })
store.setStyle('fontSize', 20)
store.setStyle('lineHeight', 2.0)
store.setStyle('sectionSpacing', 30)
store.setStyle('verticalPadding', 40)
const diag = store.state.resume
console.log('    [诊断] sections=' + diag.sections.length +
  ' itemLens=' + JSON.stringify(diag.sections.map((s) => s.items.map((i) => (i.centerContent || '').length))) +
  ' fontSize=' + diag.fontSize + ' lineHeight=' + diag.lineHeight +
  ' hPad=' + diag.horizontalPadding + ' vPad=' + diag.verticalPadding + ' ss=' + diag.sectionSpacing)
const pagesBefore = L.paginateResume(store.state.resume).pages
ok('构造出多页简历', pagesBefore > 1, 'pages=' + pagesBefore)
calls.toast.length = 0
edit.onFitOnePage()
const pagesAfter = L.paginateResume(store.state.resume).pages
ok('智能压缩后变成一页', pagesAfter === 1, pagesBefore + ' → ' + pagesAfter)
// 结果通过 showModal 告知（列出动了哪些参数），而不是 toast
ok('弹窗说明了改动的参数',
  !!calls.modal && typeof calls.modal.content === 'string' && /→/.test(calls.modal.content),
  calls.modal && calls.modal.content)
ok('压到一页时提示标题为「已压缩到一页」',
  calls.modal && calls.modal.title === '已压缩到一页', calls.modal && calls.modal.title)

/*
 * 压不下去时必须如实告知。
 *
 * 原来用 `mode === 'shrink' ? ... : '已铺满一页'`，把算法返回的 'tight'
 * （压到下限仍放不下）也归到「已铺满一页」，于是「2 页内容、参数压到底、
 * 结果还是 2 页」时弹窗说「已铺满一页」，与屏幕上写着的「共 2 页」矛盾。
 */
store.create({ blank: false })
;(() => {
  const r = store.state.resume
  const sec = model.createSection('超长经历', [])
  for (let i = 0; i < 120; i++) {
    sec.items.push(model.createItem('THREE', {
      leftContent: '公司 ' + (i + 1), centerContent: '岗位', rightContent: '2020.01-2021.01'
    }))
  }
  r.sections.push(sec)
})()
edit.refresh()
ok('构造出压不到一页的内容', L.paginateResume(store.state.resume).pages > 1,
  'pages=' + L.paginateResume(store.state.resume).pages)
calls.modal = null
edit.onFitOnePage()
const stillPages = L.paginateResume(store.state.resume).pages
if (stillPages > 1) {
  ok('压不到一页时提示标题不含「已铺满一页」',
    calls.modal && calls.modal.title.indexOf('已铺满一页') < 0, calls.modal && calls.modal.title)
  ok('压不到一页时正文告知真实页数',
    calls.modal && calls.modal.content.indexOf(String(stillPages) + ' 页') >= 0,
    calls.modal && calls.modal.content)
} else {
  // 参数压到底后确实放下了，此时提示应为压缩成功
  ok('压到一页时提示标题为压缩成功',
    calls.modal && calls.modal.title === '已压缩到一页', calls.modal && calls.modal.title)
}

/* 内容极少时反向撑满 */
store.create({ blank: true })
const r2 = store.state.resume
r2.sections = [model.createSection('教育背景', [model.createItem('ONE', { centerContent: '一行内容' })])]
store.setStyle('fontSize', 12)
store.setStyle('lineHeight', 1.2)
const h1 = L.measureHeight(store.state.resume)({})
edit.refresh()
edit.onFitOnePage()
const h2 = L.measureHeight(store.state.resume)({})
ok('内容不足时反向撑满（高度增加）', h2 > h1, h1.toFixed(0) + ' → ' + h2.toFixed(0))

/* ================================================================== */
section('8. 编辑器：撤销 / 重做')
store.create({ blank: false })
store.commitTextHistory()
edit.refresh()
const undoStart = store.state.resume.sections.length
store.addSection('测试区块A', 'THREE')
store.commitTextHistory()
store.snapshot()
ok('新增区块后可撤销', store.getters.canUndo())
edit.onUndo()
ok('撤销回退一次', store.state.resume.sections.length === undoStart,
  store.state.resume.sections.length + ' vs ' + undoStart)
ok('撤销后可重做', store.getters.canRedo())
edit.onRedo()
ok('重做恢复', store.state.resume.sections.length === undoStart + 1)

/*
 * dirty 的判定口径必须排除 updateDatetime。
 *
 * updateDatetime 每次保存都会变成新值，restore()（撤销/重做）也会刷新它。
 * 若拿完整 JSON 与 lastSavedJSON 比较，「改一下 → 撤销回原样」之后
 * dirty 会误报 true：界面一直挂着「未保存」，退出时还多做一次无意义落盘。
 */
store.save()
store.commitTextHistory()
store.setResumeName('脏标记基线')
store.refreshDirty()
store.save()
ok('保存后 dirty 归位', store.state.dirty === false, 'dirty=' + store.state.dirty)
store.snapshot()
store.setResumeName('脏标记改动')
store.refreshDirty()
ok('改动后 dirty 置位', store.state.dirty === true, 'dirty=' + store.state.dirty)
store.snapshot()
store.undo()
store.refreshDirty()
ok('撤销回已保存内容后 dirty 正确归位（不被 updateDatetime 干扰）',
  store.state.dirty === false, 'dirty=' + store.state.dirty)

/* ================================================================== */
section('9. 编辑器：照片')
chooseMediaFile = { tempFilePath: '/tmp/pick.jpg', size: 1024 * 500 }
edit.onChoosePhoto()
ok('选图后写入照片', store.state.resume.personalPhoto === '/tmp/photos/' || /photos/.test(store.state.resume.personalPhoto),
  store.state.resume.personalPhoto)
edit.onPreset(ev({ url: 'asset:avatar-woman' }))
ok('内置头像写入', store.state.resume.personalPhoto === 'asset:avatar-woman')
ok('照片 VM 解析出真实路径', edit.data.vm.photo.src === '/assets/avatar-woman.png', edit.data.vm.photo.src)
edit.onPhotoShape(ev({ id: 'circle' }))
ok('外形切换', store.state.resume.personalPhotoShape === 'circle')
edit.onPhotoBorder(ev({ id: 'theme' }))
ok('边框切换', store.state.resume.personalPhotoBorder === 'theme')
edit.onPhotoRatio(ev({ ratio: String(1) }))
ok('比例切换改变了高度', store.state.resume.personalPhotoHeight === store.state.resume.personalPhotoWidth)

/*
 * 拖宽度要按「旧比例」同步改高度。
 *
 * 原实现先写宽度、再用新宽度求比例，算出的高度恒等于原高度，
 * 整段联动是 no-op（还多触发一次 store 广播）。
 */
store.setPhotoField('personalPhotoWidth', 90)
store.setPhotoField('personalPhotoHeight', 120)
edit.onPhotoSize(ev({ key: 'personalPhotoWidth' }, { value: 150 }))
ok('拖宽度后高度按原比例同步（90×120 → 150×200）',
  store.state.resume.personalPhotoWidth === 150 && store.state.resume.personalPhotoHeight === 200,
  store.state.resume.personalPhotoWidth + '×' + store.state.resume.personalPhotoHeight)
edit.onPhotoSize(ev({ key: 'personalPhotoWidth' }, { value: 60 }))
ok('缩小宽度同样保持比例', store.state.resume.personalPhotoHeight === 80,
  '60×' + store.state.resume.personalPhotoHeight)
edit.onPhotoSize(ev({ key: 'personalPhotoHeight' }, { value: 100 }))
ok('直接改高度不影响宽度',
  store.state.resume.personalPhotoHeight === 100 && store.state.resume.personalPhotoWidth === 60,
  store.state.resume.personalPhotoWidth + '×' + store.state.resume.personalPhotoHeight)

edit.onPhotoPosition(ev({ key: 'personalPhotoRight' }, { value: 40 }))
ok('位置滑杆', store.state.resume.personalPhotoRight === 40)
edit.onRemovePhoto()
ok('移除照片', !store.state.resume.personalPhoto)
ok('移除后 VM 不显示照片', edit.data.vm.photo.show === false)

/*
 * 照片文件回收：persistPhoto 每次选图都会往 USER_DATA_PATH/photos 复制一份，
 * 若从不删除，反复换照片会持续占用用户目录配额，最终把 setStorageSync
 * 挤到写失败（进而触发「看起来已保存、其实没落盘」）。这里验证旧文件确实被回收。
 */
calls.unlinked.length = 0
chooseMediaFile = { tempFilePath: '/tmp/pick-a.jpg', size: 1024 * 200 }
edit.onChoosePhoto()
const firstPhoto = store.state.resume.personalPhoto
ok('第一次选图落到 /photos/', /\/photos\//.test(firstPhoto), firstPhoto)
ok('首次选图没有旧文件可回收', calls.unlinked.length === 0, JSON.stringify(calls.unlinked))

chooseMediaFile = { tempFilePath: '/tmp/pick-b.jpg', size: 1024 * 200 }
edit.onChoosePhoto()
const secondPhoto = store.state.resume.personalPhoto
ok('第二次选图换了新文件', secondPhoto !== firstPhoto, firstPhoto + ' → ' + secondPhoto)
ok('被替换掉的旧照片文件被回收', calls.unlinked.indexOf(firstPhoto) >= 0,
  'unlinked=' + JSON.stringify(calls.unlinked) + ' 期望含 ' + firstPhoto)

// 仍被其他草稿引用时不能删
store.state.drafts.push(Object.assign({}, JSON.parse(JSON.stringify(store.state.resume)), {
  id: 'r_other', personalPhoto: secondPhoto
}))
calls.unlinked.length = 0
chooseMediaFile = { tempFilePath: '/tmp/pick-c.jpg', size: 1024 * 200 }
edit.onChoosePhoto()
ok('仍被其它草稿引用的照片不会被误删', calls.unlinked.indexOf(secondPhoto) < 0,
  'unlinked=' + JSON.stringify(calls.unlinked))
// 收尾：清掉这份人造草稿，避免影响后续断言
store.state.drafts = store.state.drafts.filter((d) => d.id !== 'r_other')

chooseMediaFile = null

/* ================================================================== */
section('10. 编辑器：菜单与导航')
// 菜单已从底部面板改为顶部浮层：打开时 panel 不受影响，menuOpen 置位。
// 先把状态重置干净（onPanel 是 toggle 语义，依赖前序状态会让断言不确定）
edit.setData({ panel: '', menuOpen: false })
edit.onPanel(ev({ panel: 'sections' }))
ok('打开目录面板', edit.data.panel === 'sections', 'panel=' + edit.data.panel)
edit.onMenu()
ok('打开浮层菜单', edit.data.menuOpen === true)
ok('浮层菜单不占用底部面板', edit.data.panel === 'sections', 'panel=' + edit.data.panel)
ok('浮层菜单带出定位坐标', typeof edit.data.menuTop === 'number' && edit.data.menuTop > 0, 'menuTop=' + edit.data.menuTop)
edit.onMenu()
ok('再点一次收起浮层菜单', edit.data.menuOpen === false)

// 打开任意面板都要顺带收起浮层，避免两层遮罩叠加
edit.onMenu()
edit.onPanel(ev({ panel: 'base' }))
ok('切面板时收起浮层', edit.data.menuOpen === false && edit.data.panel === 'base')

edit.onMenu()
edit.onGoTemplates()
ok('跳转模板库', calls.navigate[calls.navigate.length - 1] === '/pages/templates/templates')
ok('跳转后收起菜单', edit.data.menuOpen === false)

edit.onMenu()
edit.onGoPreview()
ok('跳转预览', calls.navigate[calls.navigate.length - 1] === '/pages/preview/preview')

edit.onMenu()
edit.onGoHome()
ok('返回首页', calls.navigate[calls.navigate.length - 1] === '/pages/index/index')
edit.onCopyJSON()
ok('复制 JSON 到剪贴板', typeof calls.clipboard === 'string' && calls.clipboard.includes('"sections"'))

/* ---- 纸面点击也要收起浮层，否则点到的其实是遮罩 ---- */
edit.onMenu()
const pickSec = store.state.resume.sections[0]
edit.onPick({ detail: { sec: pickSec.id, item: pickSec.items[0].id, field: 'centerContent' } })
ok('纸面点击收起浮层菜单', edit.data.menuOpen === false)
ok('纸面点击仍能切到条目面板', edit.data.panel === 'item')

/* ================================================================== */
section('11. 编辑器：导出 PNG（走真实渲染器 + 桩 canvas）')
;(async () => {
  const render = require(path.join(ROOT, 'utils/render.js'))
  const canvas = makeFakeCanvas()
  const ctx = canvas.getContext('2d')
  const out = await render.renderToContext(ctx, canvas, store.state.resume, { scale: 2 })
  ok('渲染器返回尺寸', out.width === 1588 && out.height > 0, out.width + 'x' + out.height)
  ok('canvas 被设置为 2 倍尺寸', canvas.width === 1588 && canvas.height === out.height)
  ok('短内容按请求的 2 倍渲染', out.scale === 2 && out.limited === false,
    'scale=' + out.scale + ' limited=' + out.limited)

  /*
   * 画布上限：iOS 的 canvas 后端约 4096×4096 / 1670 万像素，
   * 超出后 canvasToTempFilePath 会失败或产出空白图。
   * 随便乱填一堆条目就能越过这条线，因此必须验证会自动降倍率。
   */
  const longResume = model.normalizeResume(model.createBlankResume())
  longResume.sections = []
  const longSec = model.createSection('超长经历', [])
  for (let i = 0; i < 120; i++) {
    longSec.items.push(model.createItem('THREE', {
      leftContent: '公司 ' + (i + 1), centerContent: '岗位', rightContent: '2020.01-2021.01'
    }))
  }
  longResume.sections.push(longSec)
  const cLong = makeFakeCanvas()
  const outLong = await render.renderToContext(cLong.getContext('2d'), cLong, longResume, { scale: 2 })
  ok('超长内容渲染不抛异常', !!outLong && outLong.height > 0)
  ok('超长内容自动降倍率以避免超出画布上限',
    outLong.limited === true && outLong.scale < 2,
    'scale=' + outLong.scale + ' limited=' + outLong.limited)
  ok('降倍率后画布边长不超过 4096',
    cLong.width <= render.MAX_CANVAS_SIDE && cLong.height <= render.MAX_CANVAS_SIDE,
    cLong.width + 'x' + cLong.height)
  ok('降倍率后总像素不超过面积上限',
    cLong.width * cLong.height <= render.MAX_CANVAS_AREA,
    (cLong.width * cLong.height / 1e6).toFixed(1) + 'M px')
  ok('降倍率后仍保底 1 倍（不糊到不可用）', outLong.scale >= 1, 'scale=' + outLong.scale)

  /* planScale 的边界：正常内容不应被限制 */
  const plan = render.planScale(store.state.resume, 1123, 2)
  ok('planScale 对 A4 单页不做限制', plan.limited === false && plan.scale === 2,
    'scale=' + plan.scale + ' limited=' + plan.limited)

  /* 三种布局 + 有/无照片 全部渲染一遍 */
  let renderErr = null
  let renderCount = 0
  for (const lay of ['SINGLE', 'LEFT', 'RIGHT']) {
    for (const photo of ['asset:avatar-man', '']) {
      try {
        store.setStyle('pageLayout', lay)
        store.setPhotoField('personalPhoto', photo)
        const c2 = makeFakeCanvas()
        await render.renderToContext(c2.getContext('2d'), c2, store.state.resume, { scale: 2 })
        renderCount++
      } catch (e) { renderErr = lay + '/' + (photo || 'none') + ' → ' + e.message; break }
    }
    if (renderErr) break
  }
  ok('三种布局 × 有/无照片 渲染无异常（' + renderCount + ' 组）', !renderErr, renderErr || '')

  /*
   * 全部 9 种标题装饰 × 居中开/关 都要能导出。
   *
   * 这里守住一个曾经真实存在的 P0：drawSectionTitle 在 line/double 主题下
   * 访问了 titleBox.size，而该主题的 titleBox 恒为 null ——
   * 「默认主题 + 打开标题居中 + 导出」必然抛 TypeError，导出 100% 失败。
   */
  let headingErr = null
  for (const h of model.HEADING_THEMES) {
    for (const center of [false, true]) {
      try {
        store.setStyle('headingTheme', h.id)
        store.setStyle('headingCenter', center)
        const c3 = makeFakeCanvas()
        await render.renderToContext(c3.getContext('2d'), c3, store.state.resume, { scale: 2 })
      } catch (e) { headingErr = h.id + ' center=' + center + ' → ' + e.message; break }
    }
    if (headingErr) break
  }
  ok('9 种标题装饰 × 居中开关 全部可导出（共 18 组）', !headingErr, headingErr || '')
  store.setStyle('headingTheme', 'line')
  store.setStyle('headingCenter', false)

  /* ---- 用户主动取消授权，不应被报成「导出失败」 ---- */
  const exp = require(path.join(ROOT, 'utils/export.js'))
  albumDeny = true
  let cancelErr = null
  try {
    await exp.saveImageToAlbum('/tmp/x.png')
  } catch (e) { cancelErr = e }
  albumDeny = false
  ok('用户拒绝相册授权 → 抛出的错误带 cancelled 标记',
    !!cancelErr && cancelErr.cancelled === true,
    cancelErr ? 'cancelled=' + cancelErr.cancelled + ' msg=' + cancelErr.message : '未抛错')
  ok('取消类错误可被 isUserCancel 识别',
    exp.isUserCancel({ errMsg: 'saveImageToPhotosAlbum:fail auth deny' }) === true &&
    exp.isUserCancel({ errMsg: 'saveImageToPhotosAlbum:fail system error' }) === false)
  ok('真实故障仍如实抛出（不误标为取消）',
    exp.isUserCancel({ errMsg: 'fail: no space left' }) === false)

  /* ================================================================== */
  section('12. 预览页')
  const preview = mount('pages/preview/preview.js', { id: store.state.resume.id })
  ok('预览页 VM 已生成', !!preview.data.vm)
  ok('预览页不渲染编辑槽位', preview.data.vm.editable === false)
  ok('预览页算出了页数', preview.data.pages >= 1)
  ok('页缝数量 = 页数 - 1', preview.data.seams.length === preview.data.pages - 1)
  ok('预览缩放合理', preview.data.zoom > 0 && preview.data.zoom < 1.5)
  preview.onCopyJSON()
  ok('预览页可复制 JSON', typeof calls.clipboard === 'string')
  preview.onEdit()
  ok('预览页可跳编辑器', calls.navigate[calls.navigate.length - 1] === '/pages/edit/edit')

  /* 模板预览模式 */
  const preview2 = mount('pages/preview/preview.js', { template: 'elegant' })
  ok('模板预览模式可用', !!preview2.data.vm && /示例/.test(preview2.data.title), preview2.data.title)

  /* ================================================================== */
  section('13. 模板库')
  const tpl = mount('pages/templates/templates.js')
  ok('模板库列出 18 套', tpl.data.list.length === 18, 'n=' + tpl.data.list.length)
  ok('每套都有缩略图 VM', tpl.data.list.every((t) => !!t.vm))
  ok('缩略图 VM 不含编辑槽位', tpl.data.list.every((t) => t.vm.editable === false))
  // 示例内容对每套模板都相同（两栏模板的基数字段更多，故用 rpx 之外的结构指纹比对）
  // 所有模板的示例内容应当逐字一致（差异只来自排版）。两栏模板会多一个「荣誉奖项」区块，
  // 因此比较前六个区块的正文文本。
  const textOf = (t) => JSON.stringify(t.vm.sections.slice(0, 6).map((s) => s.itemVMs.map((it) => it.cells.map((c) => c.text))))
  const base = textOf(tpl.data.list[0])
  const differing = tpl.data.list.filter((t) => textOf(t) !== base).map((t) => t.id)
  ok('模板缩略图用同一份示例内容（差异只来自排版）', differing.length === 0, '不同：' + differing.join(','))
  const twoColIds = tpl.data.list.filter((t) => t.vm.layout !== 'SINGLE').map((t) => t.id)
  ok('只有两栏模板的示例多一个区块', (() => {
    const extra = tpl.data.list.filter((t) => t.vm.sections.length === 7).map((t) => t.id)
    return extra.length === twoColIds.length && extra.every((id) => twoColIds.includes(id))
  })(), 'twoCol=' + twoColIds.join(','))
  ok('两栏模板的缩略图带信息栏', tpl.data.list.filter((t) => t.vm.layout !== 'SINGLE')
    .every((t) => !!t.vm.side && t.vm.side.list.length > 5))
  tpl.onCat(ev({ cat: '应届生' }))
  ok('分类筛选可用', tpl.data.activeCat === '应届生')
  // 过滤改为 JS 预计算的 match 布尔：模板页每个缩略图都要渲染一整张纸，
  // 在 WXML 里做 tags.indexOf 会让每次切换都重算 18 遍
  const expectMatch = (cat) => tpl.data.list.filter((t) => t.hits[cat] === true).length
  ok('分类命中数量与标签一致',
    tpl.data.list.filter((t) => t.match).length === expectMatch('应届生'),
    'match=' + tpl.data.list.filter((t) => t.match).length + ' expect=' + expectMatch('应届生'))
  ok('切换到「全部」时命中所有模板',
    (() => { tpl.onCat(ev({ cat: '全部' })); return tpl.data.list.every((t) => t.match) })(),
    'n=' + tpl.data.list.filter((t) => t.match).length)
  ok('每个模板都带命中表', tpl.data.list.every((t) => t.hits && t.hits['全部'] === true))
  ok('模板缩略图缩放倍率按屏宽算出',
    typeof tpl.data.thumbScale === 'number' && tpl.data.thumbScale > 0.2 && tpl.data.thumbScale < 0.6,
    'thumbScale=' + tpl.data.thumbScale)
  // 缩放后纸面宽度必须不超过卡片宽度，否则缩略图右边会被裁掉
  ok('模板缩略图完整放进卡片（不横向溢出）',
    794 * tpl.data.thumbScale <= 390,
    '纸面宽=' + (794 * tpl.data.thumbScale).toFixed(1))
  tpl.onUse(ev({ id: 'compact' }))
  ok('应用模板', store.state.resume.templateId === 'compact')
  tpl.onNewWith(ev({ id: 'academic' }))
  ok('带模板新建', store.state.resume.templateId === 'academic' &&
    calls.navigate[calls.navigate.length - 1] === '/pages/edit/edit')

  /* ================================================================== */
  section('15. 持久化：草稿落盘与恢复')
  store.create({ blank: false })
  store.setResumeName('持久化测试')
  store.save()
  const raw = storage['pb_drafts_v1']
  ok('草稿写入本机存储', Array.isArray(raw) && raw.length > 0)
  ok('存储里有这份简历', raw.some((d) => d.resumeName === '持久化测试'))
  ok('当前草稿 id 已记录', !!storage['pb_current_v1'])
  // 模拟重启
  store.state.initialized = false
  store.state.drafts = []
  const resumed = store.init()
  ok('重启后恢复了草稿列表', store.state.drafts.length > 0)
  ok('重启后恢复到当前草稿', resumed.resumeName === '持久化测试', resumed.resumeName)

  /* 导入导出往返 */
  const json = store.exportJSON()
  const parsed = JSON.parse(json)
  ok('导出 JSON 可解析', !!parsed && Array.isArray(parsed.sections))
  const n = store.importJSON(json, { asDraftList: true })
  ok('导入单份 JSON', n === 1)
  const all = store.exportAllDraftsJSON()
  const n2 = store.importJSON(all, { asDraftList: true })
  ok('导入备份全部（数组）', n2 === JSON.parse(all).length)

  /* 复制与删除 */
  const before = store.state.drafts.length
  store.duplicate(store.state.drafts[0].id)
  ok('复制草稿', store.state.drafts.length === before + 1)
  ok('副本名称带「副本」', /副本/.test(store.state.drafts[0].resumeName))
  store.remove(store.state.drafts[0].id)
  ok('删除草稿', store.state.drafts.length === before)

  /* ---- 清空 / 删光最后一份：必须真的空，且重启不得复活 ----
   *
   * 这两条守着一个曾经「看起来清空不了」的缺陷：clearAll() 与 remove()
   * 在清空后立刻调 save()，而 save() 会把 state.resume 反手 unshift 回
   * 草稿列表，于是清空完还剩下 1 份示例简历；再叠加 init() 的「没有草稿
   * 就播种示例」，用户重启后又会看到简历回来了。
   */
  // 走用户真实路径：点首页的「清空全部简历」按钮（含二次确认）
  calls.toast.length = 0
  modalAnswer = { confirm: true, content: '' }
  ok('清空前首页有卡片', index.data.drafts.length > 0, 'drafts=' + index.data.drafts.length)
  index.onClearAll()
  ok('点「清空全部简历」后首页立即变空', index.data.drafts.length === 0,
    'drafts=' + index.data.drafts.length)
  ok('清空后有「已清空」提示', calls.toast.indexOf('已清空') >= 0, JSON.stringify(calls.toast))
  ok('清空全部简历后草稿真的为空', store.state.drafts.length === 0,
    'drafts=' + store.state.drafts.length)
  ok('清空后存储里的列表也是空的',
    Array.isArray(storage['pb_drafts_v1']) && storage['pb_drafts_v1'].length === 0,
    'storage=' + JSON.stringify((storage['pb_drafts_v1'] || []).length))
  ok('清空后当前草稿指针被移除', !storage['pb_current_v1'], String(storage['pb_current_v1']))
  {
    // 模拟重启：用户主动清空过的空态必须保持，不能再播种示例简历
    store.state.initialized = false
    store.state.drafts = []
    store.init()
    ok('清空后重启不复活示例简历', store.state.drafts.length === 0, 'drafts=' + store.state.drafts.length)
  }
  {
    // 删掉最后一份也一样：不能把示例又塞回来
    store.create({ blank: true })
    store.remove(store.state.drafts[0].id)
    ok('删掉最后一份草稿后列表为空', store.state.drafts.length === 0,
      'drafts=' + store.state.drafts.length)
    store.state.initialized = false
    store.state.drafts = []
    store.init()
    ok('删光后重启不复活示例简历', store.state.drafts.length === 0, 'drafts=' + store.state.drafts.length)
  }
  {
    // 清空之后「新建 → 编辑 → 保存 → 重启恢复」必须照常工作
    store.create({ blank: true })
    ok('清空后新建草稿可用', store.state.drafts.length === 1 && store.state.resume.baseInfo.name === '')
    store.setBaseInfo('name', '清空后新建')
    store.save()
    store.state.initialized = false
    store.state.drafts = []
    store.init()
    ok('清空后新建的草稿能持久化恢复',
      store.state.drafts.length === 1 && store.state.resume.baseInfo.name === '清空后新建',
      'drafts=' + store.state.drafts.length + ' name=' + store.state.resume.baseInfo.name)
    store.clearAll()
  }

  /* ================================================================== */
  section('16. 边界情况')
  // 空简历
  store.create({ blank: true })
  const blankResume = store.state.resume
  ok('空白简历无姓名', blankResume.baseInfo.name === '')
  const blankPag = L.paginateResume(blankResume)
  ok('空白简历仍算 1 页', blankPag.pages === 1)
  ok('空白简历 VM 正常', !!buildPaperVM(blankResume, { editable: true }))
  // 超长文本
  blankResume.sections[0].items[0].centerContent = '这是一段用于测试折行的超长中文文本。'.repeat(120)
  ok('超长文本不溢出（页数增加）', L.paginateResume(blankResume).pages > 1)
  // 单个区块超过一整页 → 退到条目粒度
  blankResume.sections[0].items = []
  for (let i = 0; i < 80; i++) {
    blankResume.sections[0].items.push(model.createItem('ONE', { centerContent: '第 ' + (i + 1) + ' 行内容，用于撑满整页。' }))
  }
  const bigPag = L.paginateResume(blankResume)
  ok('超长区块退到条目粒度分页', bigPag.pages >= 2, 'pages=' + bigPag.pages)
  // 全部字段关闭
  blankResume.baseFields = []
  ok('关掉全部基本信息字段不抛异常', !!buildPaperVM(blankResume, { editable: true }))
  // 没有区块
  blankResume.sections = []
  ok('没有区块时仍算 1 页', L.paginateResume(blankResume).pages === 1)
  // 异常数据归一化
  const weird = model.normalizeResume({ sections: [{ title: 'X', items: [{ type: 'NOPE', leftContent: null }] }], baseFields: null })
  ok('异常数据被归一化', weird.sections[0].items[0].type === 'THREE' && Array.isArray(weird.baseFields))
  ok('归一化后仍可渲染', !!buildPaperVM(weird, { editable: true }))

  /* ================================================================== */
  console.log('\n==============================')
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
  if (failures.length) {
    console.log('\n失败明细：')
    failures.forEach((f) => console.log('  - ' + f))
  }
  process.exit(fail ? 1 : 0)
})()
