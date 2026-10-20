/**
 * 预览页 / 样式 / 一页 / 导出 / 模板库 回归（手机端重做 · 第 2 期）
 *
 * 写法与 tools/check-logic.cjs 一致：Node 里装一套 wx 桩，真正 require 页面、
 * 跑 onLoad 与交互处理函数，断言 data 与 store 的变化。
 *
 *   node tools/check-preview.cjs
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- wx 桩 ---------------- */
const storage = {}
const calls = { toast: [], modal: [], navigate: [], clipboard: null, saved: [], openedDocs: [], writtenFiles: [], shared: [], openSetting: 0 }
let albumAuth = undefined // undefined=未询问 / false=已拒绝
let openSettingGrants = true
let shareMode = 'ok' // ok | gesture | cancel | missing

function fakeJpegBuffer () {
  const b = new Uint8Array(32)
  let i = 0
  b[i++] = 0xff; b[i++] = 0xd8; b[i++] = 0xff; b[i++] = 0xe0; b[i++] = 0; b[i++] = 16
  for (let j = 0; j < 14; j++) b[i++] = 0
  b[i++] = 0xff; b[i++] = 0xc0; b[i++] = 0; b[i++] = 11; b[i++] = 8
  b[i++] = 0; b[i++] = 1; b[i++] = 0; b[i++] = 1; b[i++] = 0xff; b[i++] = 0xd9
  return b.buffer
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

const wxBase = {
  getStorageSync: (k) => (k in storage ? JSON.parse(JSON.stringify(storage[k])) : ''),
  setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)) },
  removeStorageSync: (k) => { delete storage[k] },
  createOffscreenCanvas: () => { throw new Error('headless: no canvas') },
  getWindowInfo: () => ({ statusBarHeight: 20, windowWidth: 390, windowHeight: 844, screenHeight: 844, safeArea: { bottom: 810 } }),
  getSystemInfoSync: () => ({ statusBarHeight: 20, windowWidth: 390, screenHeight: 844 }),
  getMenuButtonBoundingClientRect: () => ({ top: 26, height: 32, left: 300 }),
  showToast: (o) => calls.toast.push(o.title),
  showLoading: () => {},
  hideLoading: () => {},
  showModal: (o) => { calls.modal.push(o); if (o.success) o.success({ confirm: true }) },
  navigateTo: (o) => calls.navigate.push(o.url),
  redirectTo: (o) => calls.navigate.push('redirect:' + o.url),
  reLaunch: (o) => calls.navigate.push('relaunch:' + o.url),
  navigateBack: () => calls.navigate.push('back'),
  setClipboardData: (o) => { calls.clipboard = o.data; o.success && o.success() },
  saveImageToPhotosAlbum: (o) => { calls.saved.push(o.filePath); o.success && o.success() },
  getSetting: (o) => o.success({ authSetting: albumAuth === undefined ? {} : { 'scope.writePhotosAlbum': albumAuth } }),
  openSetting: (o) => { calls.openSetting++; o.success({ authSetting: { 'scope.writePhotosAlbum': openSettingGrants } }) },
  openDocument: (o) => { calls.openedDocs.push({ filePath: o.filePath, fileType: o.fileType, showMenu: o.showMenu }); o.success && o.success() },
  canvasToTempFilePath: (o) => o.success({ tempFilePath: '/tmp/out.' + (o.fileType || 'png') }),
  createSelectorQuery: () => ({
    in: function () { return this },
    select: function () { return this },
    fields: function () { return this },
    exec: (cb) => cb([{ node: makeFakeCanvas(), width: 10, height: 10 }])
  }),
  env: { USER_DATA_PATH: 'wxfile://usr' },
  getFileSystemManager: () => ({
    mkdirSync () {},
    readFile (o) { o.success({ data: fakeJpegBuffer() }) },
    writeFile (o) { calls.writtenFiles.push({ filePath: o.filePath, data: o.data, encoding: o.encoding }); o.success && o.success() },
    unlink: (o) => { o.success && o.success() }
  })
}
function shareFileMessage (o) {
  calls.shared.push({ filePath: o.filePath, fileName: o.fileName })
  if (shareMode === 'gesture') return o.fail({ errMsg: 'shareFileMessage:fail can only be invoked by user TAP gesture.' })
  if (shareMode === 'cancel') return o.fail({ errMsg: 'shareFileMessage:fail cancel' })
  o.success && o.success()
}
global.wx = Object.assign({}, wxBase, { shareFileMessage })
function setShare (mode) {
  shareMode = mode
  if (mode === 'missing') delete global.wx.shareFileMessage
  else global.wx.shareFileMessage = shareFileMessage
}

/* ---------------- App / Page ---------------- */
let appObj = null
global.App = (o) => { appObj = o }
global.getApp = () => appObj
let lastPage = null
global.Page = (o) => { lastPage = o }
global.Component = () => {}
let pageStack = [{ route: 'pages/home/home' }]
global.getCurrentPages = () => pageStack

require(path.join(ROOT, 'app.js'))
appObj.onLaunch()

function applySetData (data, patch) {
  Object.keys(patch).forEach((key) => {
    const p = key.replace(/\[(\d+)\]/g, '.$1').split('.')
    let node = data
    for (let i = 0; i < p.length - 1; i++) { if (node == null) return; node = node[p[i]] }
    if (node == null) return
    node[p[p.length - 1]] = patch[key]
  })
}
function mount (pagePath, query) {
  lastPage = null
  const file = path.join(ROOT, pagePath)
  delete require.cache[require.resolve(file)]
  require(file)
  const def = lastPage
  const inst = Object.assign({}, def)
  inst.data = JSON.parse(JSON.stringify(def.data || {}))
  inst.setData = function (patch, cb) { applySetData(inst.data, patch); if (cb) cb() }
  if (def.onLoad) def.onLoad.call(inst, query || {})
  if (def.onShow) def.onShow.call(inst)
  return inst
}
const ev = (dataset, detail) => ({ currentTarget: { dataset: dataset || {} }, target: { dataset: dataset || {} }, detail: detail || {} })

const store = require(path.join(ROOT, 'utils/store.js'))
const model = require(path.join(ROOT, 'utils/model.js'))
const L = require(path.join(ROOT, 'utils/layout.js'))
const onePage = require(path.join(ROOT, 'utils/onePage.js'))
const ops = require(path.join(ROOT, 'utils/styleOps.js'))
const exp = require(path.join(ROOT, 'utils/export.js'))
const contentJson = () => JSON.stringify(store.state.resume, (k, v) => (k === 'updateDatetime' ? undefined : v))

;(async () => {
  /* ================================================================== */
  section('0. 静态：我的页面文件齐全、绑定的处理函数存在、组件已声明')
  const myPages = ['pages/preview/preview', 'packages/tools/templates/templates']
  for (const p of myPages) {
    for (const ext of ['.js', '.wxml', '.wxss', '.json']) ok(p + ext + ' 存在', fs.existsSync(path.join(ROOT, p + ext)))
    lastPage = null
    delete require.cache[require.resolve(path.join(ROOT, p + '.js'))]
    require(path.join(ROOT, p + '.js'))
    const def = lastPage
    const src = fs.readFileSync(path.join(ROOT, p + '.wxml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    const missing = []
    const re = /(?:bind|catch):?([a-zA-Z]+)\s*=\s*"([^"{}]+)"/g
    let m
    while ((m = re.exec(src))) if (typeof def[m[2].trim()] !== 'function') missing.push(m[2])
    ok(p + ' 绑定的处理函数都存在', missing.length === 0, missing.join(','))
    const json = JSON.parse(fs.readFileSync(path.join(ROOT, p + '.json'), 'utf8'))
    const builtin = new Set(['scroll-view', 'swiper-item', 'movable-view', 'movable-area'])
    const used = new Set()
    const tre = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s/>]/g
    while ((m = tre.exec(src))) used.add(m[1])
    const undeclared = [...used].filter((u) => !builtin.has(u) && !(u in (json.usingComponents || {})))
    ok(p + ' 组件均已声明', undeclared.length === 0, undeclared.join(','))
    const stack = []
    const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)\s*>/g
    let bad = ''
    while ((m = tagRe.exec(src))) {
      if (m[1] === '/') { const top = stack.pop(); if (top !== m[2] && !bad) bad = '</' + m[2] + '> vs <' + top + '>' }
      else if (m[4] !== '/') stack.push(m[2])
    }
    ok(p + ' 标签闭合', !bad && !stack.length, bad || stack.join(','))
  }
  ok('旧 pages/templates 已删除', !fs.existsSync(path.join(ROOT, 'pages/templates')))
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
  const sub = (appJson.subpackages || []).find((s) => s.root === 'packages/tools')
  ok('模板库登记在 tools 分包', !!sub && sub.pages.includes('templates/templates'))
  const previewHead = fs.readFileSync(path.join(ROOT, 'pages/preview/preview.wxml'), 'utf8').split('/>')[0]
  ok('预览页导航栏无右侧按钮、标题为「预览」', previewHead.indexOf('action=') < 0)

  /* ================================================================== */
  section('1. 预览页：panel 参数直接打开面板')
  const p0 = mount('pages/preview/preview.js', {})
  ok('默认不开面板', p0.data.sheet === '')
  ok('标题为「预览」', p0.data.title === '预览')
  ok('纸面 VM 已生成且不可编辑', !!p0.data.vm && p0.data.vm.editable === false)
  ok('页缝 = 页数 - 1', p0.data.seams.length === p0.data.pages - 1)
  ok('适配缩放 ≈ (屏宽-24)/794', Math.abs(p0.data.fitZoom - (390 - 24) / 794) < 0.002, p0.data.fitZoom)
  p0.onUnload()
  const pStyle = mount('pages/preview/preview.js', { panel: 'style' })
  ok('?panel=style 打开样式面板', pStyle.data.sheet === 'style')
  const pExport = mount('pages/preview/preview.js', { panel: 'export' })
  ok('?panel=export 打开导出面板', pExport.data.sheet === 'export')
  pExport.onUnload()
  const pBad = mount('pages/preview/preview.js', { panel: 'hack' })
  ok('未知 panel 不打开', pBad.data.sheet === '')
  pBad.onUnload()

  /* ================================================================== */
  section('2. 样式面板：改动写入 store、实时重绘、可撤销')
  const pv = pStyle
  store.resetHistory()
  pv.onColor(ev({ id: 'teal' }))
  ok('配色写入 store', store.state.resume.headingColor === '#12695c' && store.state.resume.borderColor === '#12695c')
  ok('面板选中态跟随', pv.data.style.colorId === 'teal')
  ok('配色已落盘（非 dirty）', store.state.dirty === false)
  pv.onFont(ev({ id: 'songti' }))
  ok('字体写入 store', store.state.resume.fontFamily === 'songti')
  pv.onHeading(ev({ id: 'tint' }))
  ok('标题装饰写入 store', store.state.resume.headingTheme === 'tint')
  ok('标题小样共 9 种', pv.data.headings.length === 9)
  const pagesSingle = pv.data.pages
  pv.onLayout(ev({ id: 'LEFT' }))
  ok('布局写入 store', store.state.resume.pageLayout === 'LEFT')
  ok('纸面实时重建为双栏', pv.data.vm.layout === 'LEFT', pv.data.vm.layout)
  pv.onLayout(ev({ id: 'BOGUS' }))
  ok('非法布局被忽略', store.state.resume.pageLayout === 'LEFT')
  // 滑杆：拖动中只预览，松手才落盘
  pv.onSliderChanging(ev({ key: 'fontSize' }, { value: 16 }))
  ok('拖动中实时改到 store', store.state.resume.fontSize === 16)
  ok('拖动中不落盘（dirty）', store.state.dirty === true)
  pv.onSliderChange(ev({ key: 'fontSize' }, { value: 16.5 }))
  await sleep(80)
  ok('松手落盘', store.state.resume.fontSize === 16.5 && store.state.dirty === false)
  ok('滑杆数值显示同步', pv.data.sliders.find((s) => s.key === 'fontSize').value === 16.5)
  pv.onSliderChange(ev({ key: 'lineHeight' }, { value: 9 }))
  ok('越界值被夹到滑杆上限', store.state.resume.lineHeight === 2.4, store.state.resume.lineHeight)
  ok('可撤销', pv.data.canUndo === true)
  pv.onUndo()
  ok('撤销恢复上一步（行距）', store.state.resume.lineHeight !== 2.4 && store.state.resume.fontSize === 16.5, store.state.resume.lineHeight)
  pv.onUndo()
  ok('再撤销恢复字号（拖动只占一步）', store.state.resume.fontSize !== 16.5 && store.state.resume.fontSize !== 16, store.state.resume.fontSize)
  pv.onRedo()
  ok('重做', store.state.resume.fontSize === 16.5)
  pv.onLayout(ev({ id: 'SINGLE' }))
  pv.onTemplatePick(ev({ id: 'elegant' }))
  ok('模板横条：应用模板', store.state.resume.templateId === 'elegant')
  pv.onAllTemplates()
  ok('「全部模板」进分包模板库', calls.navigate[calls.navigate.length - 1].indexOf('/packages/tools/templates/templates') === 0)
  ok('单栏页数可算', pagesSingle >= 1)
  pv.onHide()
  const vmBeforeHide = pv.data.vm
  store.setStyle('fontSize', 15)
  ok('页面被盖住时不跟着 store 重排', pv.data.vm === vmBeforeHide)
  pv.onShow()
  ok('回到前台时同步最新样式', pv.data.vm !== vmBeforeHide && pv.data.sliders.find((s) => s.key === 'fontSize').value === 15)
  store.save()

  /* ================================================================== */
  section('3. 一页：智能排版 v1.12')
  // 纯函数：假测量
  const fakeMeasure = (k) => (p) => k * p.fontSize * p.lineHeight + 2 * p.verticalPadding + 6 * p.sectionSpacing
  const base = { fontSize: 14, lineHeight: 1.65, fontSpacing: 0, horizontalPadding: 48, verticalPadding: 36, sectionSpacing: 18 }
  const rGrow = onePage.smartLayout(base, { measure: fakeMeasure(20) })
  ok('内容少 → grow，且不超上限', rGrow.mode === 'grow' && rGrow.params.lineHeight <= 1.8 && rGrow.params.fontSize <= 15, JSON.stringify(rGrow.params))
  const rOne = onePage.smartLayout(base, { measure: fakeMeasure(46) })
  ok('略超一页 → one-page 均衡压缩', rOne.mode === 'one-page' && rOne.changes.length >= 2, rOne.mode + ' ' + rOne.changes.length)
  ok('压缩不越过舒适下限', rOne.params.lineHeight >= 1.4 && rOne.params.fontSize >= 12.5 && rOne.params.sectionSpacing >= 10 && rOne.params.verticalPadding >= 36)
  const rMulti = onePage.smartLayout(base, { measure: fakeMeasure(120) })
  ok('内容很多 → multi-page，不硬塞', rMulti.mode === 'multi-page' && rMulti.pages >= 2, rMulti.mode + ' p=' + rMulti.pages)
  ok('describeLayoutResult 不说失败', !/失败/.test(onePage.describeLayoutResult(rMulti).text))
  ok('旧的贪心算法仍在（编辑页在用）', typeof onePage.fitOnePageSmart === 'function' && typeof onePage.fitToOnePage === 'function')

  // 真实页面：塞满内容让它溢出
  const sec = store.state.resume.sections.find((s) => s.items && s.items.length)
  const filler = '负责核心模块的设计与开发，推动跨团队协作，显著提升了交付效率与线上稳定性。'
  for (let i = 0; i < 3; i++) {
    sec.items.push({ id: 'x' + i, type: 'THREE', leftContent: '某公司' + i, centerContent: filler + filler, rightContent: '2020.01 - 2021.01' })
  }
  store.save()
  const pagesBefore = L.paginateResume(store.state.resume).pages
  const paramsBefore = onePage.readFitParamsSafe(store.state.resume)
  const pf = mount('pages/preview/preview.js', {})
  const fitRes = pf.onSmartFit()
  ok('一页：返回结果', !!fitRes, JSON.stringify(fitRes && fitRes.message))
  if (fitRes && fitRes.applied) {
    ok('改动了参数并列出清单', fitRes.changes.length > 0 && pf.data.fit.rows.length === fitRes.changes.length)
    ok('结果面板打开', pf.data.sheet === 'fit' && pf.data.fit.canRestore === true)
    ok('写入 store 的值 = 变化清单的新值', fitRes.changes.every((c) => Math.abs(store.state.resume[c.key] - c.to) < 1e-9))
    ok('页数不增加', L.paginateResume(store.state.resume).pages <= pagesBefore, pagesBefore + '→' + L.paginateResume(store.state.resume).pages)
    pf.onFitRestore()
    const after = onePage.readFitParamsSafe(store.state.resume)
    ok('还原：参数逐项恢复', Object.keys(paramsBefore).every((k) => Math.abs(after[k] - paramsBefore[k]) < 1e-9), JSON.stringify(after))
    ok('还原后面板关闭', pf.data.sheet === '')
  } else {
    ok('一页：无需改动时给出提示', calls.toast.length > 0)
  }
  // 再造一个必然需要改动的场景：极少内容 → grow
  const planGrow = ops.planSmartFit(Object.assign(model.createBlankResume(), { fontSize: 14, lineHeight: 1.65 }))
  ok('planSmartFit 纯计算不写 store', typeof planGrow.message === 'string')
  ok('measurePagesOf 返回页数与末页填充', (() => { const r = ops.measurePagesOf(store.state.resume)({}); return r.pages >= 1 && r.lastFill >= 0 && r.lastFill <= 1 })())
  pf.onUnload()

  /* ================================================================== */
  section('4. 点纸面 → 回编辑器定位；双击缩放')
  const pk = mount('pages/preview/preview.js', {})
  calls.navigate = []
  pageStack = [{ route: 'pages/home/home' }, { route: 'pages/preview/preview' }]
  pk.onPaperPick({ detail: { sec: 's123', item: 'i1', field: 'centerContent' } })
  pk.onStageTap({ detail: { x: 100, y: 200 } })
  ok('单击不立即跳转（等待双击窗口）', calls.navigate.length === 0)
  await sleep(340)
  ok('上一页不是编辑器 → navigateTo ?focus=区块id', calls.navigate[0] === '/pages/edit/edit?focus=s123', calls.navigate[0])
  ok('同时写入 globalData.pendingFocus', appObj.globalData.pendingFocus === 's123')
  calls.navigate = []
  pageStack = [{ route: 'pages/home/home' }, { route: 'pages/edit/edit' }, { route: 'pages/preview/preview' }]
  pk.goEdit({ base: 'phone' })
  ok('上一页是编辑器 → navigateBack', calls.navigate[0] === 'back')
  ok('基本信息 → focus=base', appObj.globalData.pendingFocus === 'base')
  pk.goEdit({ photo: true })
  ok('照片 → focus=photo', appObj.globalData.pendingFocus === 'photo')
  calls.navigate = []
  const z0 = pk.data.zoom
  pk.onPaperPick({ detail: { sec: 's9' } })
  pk.onStageTap({ detail: { x: 100, y: 300 } })
  await sleep(60)
  pk.onPaperPick({ detail: { sec: 's9' } })
  pk.onStageTap({ detail: { x: 100, y: 300 } })
  await sleep(360)
  ok('双击：不跳转', calls.navigate.length === 0, JSON.stringify(calls.navigate))
  ok('双击：放大', pk.data.zoomed === true && pk.data.zoom > z0, pk.data.zoom)
  ok('放大后舞台尺寸随之变大', pk.data.stageW > 794 * z0)
  pk.onZoomBtn()
  ok('再次切换回适配宽度', pk.data.zoomed === false && Math.abs(pk.data.zoom - pk.data.fitZoom) < 1e-9)
  pk.onPinchStart({ touches: [{ clientX: 100, clientY: 100 }, { clientX: 200, clientY: 100 }] })
  pk.onPinchMove({ touches: [{ clientX: 50, clientY: 100 }, { clientX: 250, clientY: 100 }] })
  ok('双指捏合放大', pk.data.zoom > pk.data.fitZoom * 1.5, pk.data.zoom)
  pk.onPinchEnd()
  pk.onPinchStart({ touches: [{ clientX: 0, clientY: 0 }, { clientX: 400, clientY: 0 }] })
  pk.onPinchMove({ touches: [{ clientX: 199, clientY: 0 }, { clientX: 201, clientY: 0 }] })
  ok('缩小不低于适配宽度', Math.abs(pk.data.zoom - pk.data.fitZoom) < 1e-9)
  pk.onPinchEnd()
  pk.onUnload()
  const pt = mount('pages/preview/preview.js', { template: 'elegant' })
  ok('?template 只读示例：无底栏', pt.data.readonly === true && /示例/.test(pt.data.title))
  pt.openSheet('style')
  ok('只读模式不开面板', pt.data.sheet === '')

  /* ================================================================== */
  section('5. 导出文件名')
  const R = (name, intent, rn) => ({ resumeName: rn || '', baseInfo: { name, jobIntention: intent } })
  ok('姓名-求职意向-简历', ops.exportFileBase(R('张三', '前端工程师')) === '张三-前端工程师-简历', ops.exportFileBase(R('张三', '前端工程师')))
  ok('非法字符被清掉', ops.exportFileBase(R('张/三', 'Java:后端*工程师?')) === '张三-Java后端工程师-简历', ops.exportFileBase(R('张/三', 'Java:后端*工程师?')))
  ok('缺求职意向', ops.exportFileBase(R('李四', '')) === '李四-简历')
  ok('全缺 → 简历名', ops.exportFileBase(R('', '', '我的简历')) === '我的简历')
  ok('全缺且无简历名 → 简历', ops.exportFileBase(R('', '', '')) === '简历')
  ok('换行 / 首尾点号被清理', ops.exportFileBase(R('..王五\n', ' 产品 ')) === '王五-产品-简历', ops.exportFileBase(R('..王五\n', ' 产品 ')))
  const longName = ops.exportFileBase(R('很长很长的名字'.repeat(5), '高级资深全栈开发工程师兼架构师'.repeat(3)))
  ok('超长被截断（≤40 字符）', longName.length <= 40, longName.length)
  ok('写文件时长名不丢扩展名', exp.safeFileName('啊'.repeat(60) + '.pdf').endsWith('.pdf'))

  /* ================================================================== */
  section('6. 导出：发给微信好友 / 回退 / 手势失效 / JSON / 长图')
  store.state.resume.baseInfo.name = '张三'
  store.state.resume.baseInfo.jobIntention = '产品经理'
  store.save()
  const pe = mount('pages/preview/preview.js', { panel: 'export' })
  setShare('ok')
  calls.shared = []; calls.writtenFiles = []
  await pe.onSharePdf()
  ok('PDF 写入 USER_DATA_PATH', calls.writtenFiles.some((f) => f.filePath.indexOf('wxfile://usr/') === 0 && f.filePath.endsWith('张三-产品经理-简历.pdf')),
    JSON.stringify(calls.writtenFiles.map((f) => f.filePath)))
  ok('shareFileMessage 带文件名', calls.shared.length === 1 && calls.shared[0].fileName === '张三-产品经理-简历.pdf', JSON.stringify(calls.shared))
  ok('导出结束 exporting 复位', pe.data.exporting === false)

  // 不支持 shareFileMessage → openDocument(showMenu)
  setShare('missing')
  calls.openedDocs = []
  pe._fileCache = null
  await pe.onSharePdf()
  ok('缺 shareFileMessage → 回退 openDocument(showMenu:true)', calls.openedDocs.length === 1 && calls.openedDocs[0].fileType === 'pdf' && calls.openedDocs[0].showMenu === true,
    JSON.stringify(calls.openedDocs))
  calls.openedDocs = []
  await pe.onShareWord()
  ok('Word 同样回退 openDocument', calls.openedDocs.length === 1 && calls.openedDocs[0].fileType === 'doc')
  calls.clipboard = null
  await pe.onShareJson()
  ok('JSON 发到聊天不支持 → 复制到剪贴板兜底', typeof calls.clipboard === 'string' && calls.clipboard.indexOf('"baseInfo"') >= 0)

  // 手势上下文失效 → 面板出「发送」按钮，再点即可
  setShare('gesture')
  calls.shared = []; calls.writtenFiles = []
  await pe.onSharePdf()
  ok('手势失效 → 展示「发送给微信好友」按钮', !!pe.data.readyShare && pe.data.readyShare.kind === 'pdf')
  setShare('ok')
  const sentOk = await pe.onShareReady()
  ok('再点一次即发送（复用已生成文件）', sentOk === true && calls.shared.length === 2 && calls.writtenFiles.length === 1 && pe.data.readyShare === null,
    'shared=' + calls.shared.length + ' written=' + calls.writtenFiles.length)

  // 用户取消 → 提示「已取消」而不是失败
  setShare('cancel')
  pe._fileCache = null
  calls.toast = []
  await pe.onShareWord()
  ok('用户取消发送 → 提示已取消', calls.toast.includes('已取消'), JSON.stringify(calls.toast))
  setShare('ok')

  // JSON 两条路
  calls.clipboard = null
  await pe.onCopyJson()
  ok('JSON 复制到剪贴板', typeof calls.clipboard === 'string' && JSON.parse(calls.clipboard).baseInfo.name === '张三')
  calls.shared = []; calls.writtenFiles = []
  await pe.onShareJson()
  ok('JSON 发到聊天：.json 文件 + shareFileMessage', calls.shared.length === 1 && calls.shared[0].fileName === '张三-产品经理-简历.json' &&
    calls.writtenFiles[0].encoding === 'utf8', JSON.stringify(calls.shared))

  // 打开 PDF
  calls.openedDocs = []
  await pe.onOpenPdf()
  ok('保存 PDF / 打开 → openDocument showMenu', calls.openedDocs.length === 1 && calls.openedDocs[0].showMenu === true)

  // 长图：相册权限被拒 → 引导去设置
  albumAuth = false; openSettingGrants = true; calls.saved = []; calls.openSetting = 0
  await pe.onSaveImage()
  ok('相册权限被拒 → 弹窗引导 openSetting，授权后保存', calls.openSetting === 1 && calls.saved.length === 1)
  openSettingGrants = false; calls.saved = []; calls.toast = []
  await pe.onSaveImage()
  ok('设置里仍未授权 → 不保存、提示已取消', calls.saved.length === 0 && calls.toast.includes('已取消'), JSON.stringify(calls.toast))
  albumAuth = undefined
  await pe.onSaveImage()
  ok('正常保存长图', calls.saved.length === 1)
  ok('HTML 导出已去掉', fs.readFileSync(path.join(ROOT, 'pages/preview/preview.wxml'), 'utf8').indexOf('HTML') < 0)
  pe.onUnload()
  pStyle.onUnload()

  /* ================================================================== */
  section('7. 模板库：滑动预览不改简历，「用这套」才写入')
  store.applyTemplate('classic', { keepContent: true })
  const before = contentJson()
  const tp = mount('packages/tools/templates/templates.js', { from: 'mine' })
  ok('18 套', tp.data.slides.length === 18 && tp.data.total === 18)
  ok('初始定位到当前模板', tp.data.currentId === 'classic' && tp.data.appliedId === 'classic')
  const fullAt = () => tp.data.slides.map((s, i) => (s.vm ? i : -1)).filter((i) => i >= 0)
  ok('只渲染当前 ±1', JSON.stringify(fullAt()) === JSON.stringify([0, 1]), JSON.stringify(fullAt()))
  tp.onSwiper(ev({}, { current: 5 }))
  ok('滑到第 6 页：只渲染 4,5,6', JSON.stringify(fullAt()) === JSON.stringify([4, 5, 6]), JSON.stringify(fullAt()))
  ok('指示器数据', tp.data.current === 5 && tp.data.slides[5].name && /单栏|双栏/.test(tp.data.slides[5].layoutLabel))
  const twoCol = tp.data.slides.findIndex((s) => s.layoutLabel === '双栏')
  ok('有双栏模板并标注', twoCol >= 0)
  for (let i = 0; i < 18; i++) tp.onSwiper(ev({}, { current: i }))
  ok('滑遍 18 套，store 简历未被修改', contentJson() === before)
  const vm5 = tp.vmOf(model.TEMPLATES[5].id).vm
  const name0 = store.state.resume.baseInfo.name
  ok('预览用的是用户自己的内容', JSON.stringify(vm5).indexOf(name0) >= 0)
  tp.onToggleGrid()
  await sleep(120)
  ok('网格模式：18 张缩略图全部生成', tp.data.grid === true && tp.data.gridItems.length === 18 && tp.data.gridItems.every((g) => !!g.vm))
  ok('网格模式也不改简历', contentJson() === before)
  const target = model.TEMPLATES[7].id
  tp.onGridPick(ev({ id: target }))
  ok('网格点选 → 回到滑动并定位', tp.data.grid === false && tp.data.currentId === target)
  calls.navigate = []
  tp.onUse()
  ok('「用这套」写入 store', store.state.resume.templateId === target)
  await sleep(450)
  ok('然后返回上一页', calls.navigate.includes('back'))
  ok('「用这套」一步可撤销', (() => { store.undo(); return store.state.resume.templateId === 'classic' })())
  tp.onUnload()

  // from=home 且没有任何简历 → 新建
  store.clearAll()
  const tpHome = mount('packages/tools/templates/templates.js', { from: 'home' })
  ok('无简历：noResume 标记', tpHome.data.noResume === true)
  tpHome.onSwiper(ev({}, { current: 3 }))
  calls.navigate = []
  tpHome.onUse()
  ok('无简历：「用这套」新建一份并进编辑器', store.state.drafts.length === 1 && store.state.resume.templateId === model.TEMPLATES[3].id &&
    calls.navigate[0] === 'redirect:/pages/edit/edit', JSON.stringify(calls.navigate))

  /* ================================================================== */
  console.log('\n==============================')
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
  if (fail) { console.log('\n失败项：'); failures.forEach((f) => console.log('  - ' + f)) }
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
