/**
 * 预览页（手机端重做 · 第 2 期）
 *
 * 全屏纸面 + 底部三键：样式 / 一页 / 导出。
 *
 *   · 纸面：A4 软分页（页缝 + 页码，与编辑器共用 utils/layout.js 的 paginateResume），
 *     双击 / 双指捏合缩放（scroll-view 承载，缩放用 transform，稳定不抖）。
 *   · 点纸面某个区块 → 回编辑器并定位：
 *       focus = 区块 id | 'base'（基本信息）| 'photo'（照片）
 *     上一页就是编辑器时 navigateBack，并写 getApp().globalData.pendingFocus；
 *     否则 navigateTo('/pages/edit/edit?focus=…')，同时也写 pendingFocus（两种读法都能拿到）。
 *   · 样式面板：配色 / 字体 / 标题装饰 / 布局 / 尺寸 / 模板，改动实时生效，可撤销。
 *   · 一页：智能排版 v1.12（舒适下限 + 均衡压缩 + 多页兜底），列出改了哪些参数并可还原。
 *   · 导出：发给微信好友（PDF）/ 打开 PDF / Word / PNG 长图 / JSON 备份（复制 / 发到聊天）。
 *
 * 入参：
 *   ?panel=style|export  进入即打开对应面板
 *   ?id=xxx              预览某份草稿（会切换为当前简历）
 *   ?template=xxx        只读预览某模板的示例排版（不显示底栏）
 */
const store = require('../../utils/store.js')
const model = require('../../utils/model.js')
const { buildPaperVM, buildHeadingStyle, styleOf } = require('../../utils/paper.js')
const { paginateResume, A4_W } = require('../../utils/layout.js')
const ops = require('../../utils/styleOps.js')
const exp = require('../../utils/export.js')
const { renderToContext } = require('../../utils/render.js')

const app = getApp()

/** 双击判定窗口（ms）；单击的「回编辑器」也因此延后这么久，以便区分双击 */
const DOUBLE_TAP_MS = 300
/** 同一次物理点击会先后触发纸张 pick 与舞台 tap，两者间隔在这个范围内视为同一次 */
const SAME_TAP_MS = 40
/** 纸面左右留白（px） */
const STAGE_PAD = 12
/** 放大上限（设计 px 的倍数）：1 = 原尺寸 794px 宽 */
const MAX_ZOOM = 1.6

const STYLE_TABS = [
  { id: 'color', label: '配色' },
  { id: 'font', label: '字体' },
  { id: 'heading', label: '标题' },
  { id: 'layout', label: '布局' },
  { id: 'size', label: '尺寸' },
  { id: 'template', label: '模板' }
]

/** 标题装饰小样：直接复用纸张的 buildHeadingStyle，保证所见即所得 */
function headingSamples (color) {
  return model.HEADING_THEMES.map((h) => {
    const s = buildHeadingStyle({ headingTheme: h.id, headingColor: color, headingFontColor: '#23282f' })
    // 小样尺寸固定，padding 按比例缩一点
    return { id: h.id, label: h.label, style: styleOf(s), cls: 'th-' + h.id }
  })
}

function templateCards () {
  return model.TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    brand: t.brand,
    second: t.second,
    layout: t.layout || 'SINGLE',
    layoutLabel: t.layout === 'LEFT' || t.layout === 'RIGHT' ? '双栏' : '单栏'
  }))
}

function windowWidth () {
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    return info.windowWidth || 375
  } catch (e) {
    return 375
  }
}

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    title: '预览',
    readonly: false,

    /* 纸面 */
    vm: null,
    seams: [],
    pages: 1,
    paperBoxH: 1123,
    zoom: 0.5,
    fitZoom: 0.5,
    zoomed: false,
    zoomPct: 100,
    stageW: 375,
    stageH: 600,
    stagePad: STAGE_PAD,
    scrollTop: 0,
    scrollLeft: 0,

    /* 面板 */
    sheet: '',
    styleTabs: STYLE_TABS,
    styleTab: 'color',
    style: {},
    colors: model.COLOR_PRESETS,
    fonts: model.FONT_FAMILIES,
    headings: [],
    layouts: ops.LAYOUT_OPTIONS,
    sliders: [],
    templates: [],
    canUndo: false,
    canRedo: false,

    /* 一页 */
    fit: { message: '', rows: [], canRestore: false, pages: 1 },

    /* 导出 */
    exporting: false,
    exportTip: '',
    canShare: true,
    readyShare: null
  },

  onLoad (query) {
    const q = query || {}
    const g = app.globalData
    this.setData({
      statusBarHeight: g.statusBarHeight,
      navBarHeight: g.navBarHeight,
      canShare: exp.canShareFile(),
      templates: templateCards()
    })

    if (q.template) {
      // 只读：某模板的示例排版
      this.resume = model.normalizeResume(model.buildThumbSample(q.template))
      const t = model.getTemplate(q.template)
      this.setData({ readonly: true, title: (t ? t.name : '模板') + ' · 示例' })
      this.buildPaper(this.resume)
      return
    }

    if (q.id && q.id !== store.state.resume.id) store.open(q.id)
    this.resume = store.state.resume
    this.syncFromStore()

    this._unsub = store.subscribe(() => this.onStoreChange())

    if (q.panel === 'style' || q.panel === 'export') this.openSheet(q.panel)
  },

  onShow () {
    this._hidden = false
    // 从编辑器 / 模板库回来：内容或样式可能已变
    if (this.data.readonly || !this._loadedOnce) { this._loadedOnce = true; return }
    this.resume = store.state.resume
    this.syncFromStore()
  },

  /** 被编辑器盖住时不跟着每次键入重排纸面，回来时 onShow 统一同步 */
  onHide () {
    this._hidden = true
  },

  onUnload () {
    if (this._unsub) this._unsub()
    this._unsub = null
    clearTimeout(this._tapTimer)
    clearTimeout(this._rebuildTimer)
  },

  onResize () {
    this.fit(true)
  },

  /* ================= 纸面 ================= */

  onStoreChange () {
    this.resume = store.state.resume
    if (this._hidden) return
    // 滑杆拖动中会高频触发：合并到 ~60ms 一次，避免每个刻度都整张重排
    if (this._dragging) {
      if (this._rebuildTimer) return
      this._rebuildTimer = setTimeout(() => {
        this._rebuildTimer = null
        this.syncFromStore()
      }, 60)
      return
    }
    this.syncFromStore()
  },

  syncFromStore () {
    const r = store.state.resume
    this.resume = r
    this.buildPaper(r)
    const style = ops.styleState(r)
    this.setData({
      style,
      headings: headingSamples(style.headingColor || '#1f4e79'),
      sliders: ops.SLIDERS.map((s) => Object.assign({}, s, { value: Number(r[s.key]) })),
      canUndo: store.getters.canUndo(),
      canRedo: store.getters.canRedo()
    })
  },

  buildPaper (resume) {
    const vm = buildPaperVM(resume, { editable: false })
    const pag = paginateResume(resume)
    const seams = []
    for (let i = 2; i <= pag.pages; i++) seams.push((i - 1) * 1123)
    this.setData({ vm, seams, pages: pag.pages, paperBoxH: pag.minHeight }, () => this.fit())
  },

  /** 适配宽度：fitZoom = 屏宽内放下整张纸。已放大时保持当前倍率 */
  fit (force) {
    const w = windowWidth()
    const fitZoom = Math.max(0.2, Number(((w - STAGE_PAD * 2) / A4_W).toFixed(3)))
    const zoom = this.data.zoomed && !force ? this.data.zoom : fitZoom
    this.applyZoom(zoom, fitZoom)
  },

  applyZoom (zoom, fitZoom, scroll) {
    const fz = fitZoom || this.data.fitZoom
    const z = Math.max(fz, Math.min(MAX_ZOOM, zoom))
    const patch = {
      zoom: z,
      fitZoom: fz,
      zoomed: z > fz + 0.001,
      zoomPct: Math.round((z / fz) * 100),
      stageW: Math.ceil(A4_W * z + STAGE_PAD * 2),
      stageH: Math.ceil(this.data.paperBoxH * z + STAGE_PAD * 2)
    }
    if (scroll) {
      patch.scrollTop = Math.max(0, Math.round(scroll.top))
      patch.scrollLeft = Math.max(0, Math.round(scroll.left))
    }
    this.setData(patch)
  },

  onStageScroll (e) {
    const d = (e && e.detail) || {}
    this._scroll = { top: d.scrollTop || 0, left: d.scrollLeft || 0 }
  },

  /** 双击切换：适配宽度 ↔ 原尺寸（以点击点为锚） */
  toggleZoom (pt) {
    const fz = this.data.fitZoom
    const from = this.data.zoom
    const to = this.data.zoomed ? fz : Math.min(MAX_ZOOM, Math.max(1, fz * 2))
    const s = this._scroll || { top: 0, left: 0 }
    const k = to / from
    const top0 = this.data.statusBarHeight + this.data.navBarHeight
    const px = pt && pt.x != null ? pt.x : windowWidth() / 2
    const py = pt && pt.y != null ? pt.y - top0 : 200
    const scroll = { left: (s.left + px) * k - px, top: (s.top + py) * k - py }
    this._scroll = scroll
    this.applyZoom(to, fz, scroll)
  },

  onZoomBtn () {
    this.toggleZoom()
  },

  /* ---------- 双指捏合 ---------- */
  onPinchStart (e) {
    const t = e.touches || []
    if (t.length !== 2) return
    this._pinch = { d0: dist(t[0], t[1]), z0: this.data.zoom, at: 0 }
  },

  onPinchMove (e) {
    const t = e.touches || []
    if (!this._pinch || t.length !== 2) return
    const p = this._pinch
    const now = Date.now()
    if (now - p.at < 40) return // 节流：每 40ms 最多重排一次
    p.at = now
    const d = dist(t[0], t[1])
    if (!(p.d0 > 0)) return
    this.applyZoom(p.z0 * (d / p.d0))
  },

  onPinchEnd () {
    if (!this._pinch) return
    this._pinch = null
    // 接近适配宽度时吸附回去，避免停在 103% 这种尴尬值
    if (this.data.zoom < this.data.fitZoom * 1.08) this.applyZoom(this.data.fitZoom)
  },

  /* ---------- 点击：单击回编辑器，双击缩放 ---------- */

  /** 纸张组件抛出的 pick（点到了区块 / 基本信息 / 照片） */
  onPaperPick (e) {
    this.registerTap((e && e.detail) || null, null)
  },

  /** 舞台上的 tap（纸面空白处、页边等也会到这里） */
  onStageTap (e) {
    const d = (e && e.detail) || {}
    this.registerTap(null, { x: d.x, y: d.y })
  },

  /**
   * 统一的点击判定。纸张内部的点击会先后触发 pick 与冒泡上来的 tap，
   * 二者合并为一次；300ms 内第二次点击 = 双击（取消待执行的跳转、切换缩放）。
   */
  registerTap (pick, pt) {
    if (this.data.readonly && pick) pick = null
    const now = Date.now()
    const last = this._tapAt || 0
    if (last && now - last < SAME_TAP_MS) {
      if (pick && this._tapState === 'single') this._tapPick = pick
      if (pt && !this._tapPt) this._tapPt = pt
      return
    }
    if (last && now - last < DOUBLE_TAP_MS && this._tapState === 'single') {
      clearTimeout(this._tapTimer)
      this._tapTimer = null
      this._tapPick = null
      this._tapAt = now
      this._tapState = 'double'
      this.toggleZoom(pt || this._tapPt)
      return
    }
    this._tapAt = now
    this._tapState = 'single'
    this._tapPick = pick
    this._tapPt = pt
    clearTimeout(this._tapTimer)
    this._tapTimer = setTimeout(() => {
      this._tapTimer = null
      const p = this._tapPick
      this._tapPick = null
      if (p && !this.data.sheet) this.goEdit(p)
    }, DOUBLE_TAP_MS)
  },

  /** pick 详情 → 编辑器定位目标 */
  focusOf (pick) {
    if (!pick) return ''
    if (pick.sec) return pick.sec
    if (pick.photo || pick.photoAdd) return 'photo'
    if (pick.base) return 'base'
    return ''
  },

  /**
   * 回编辑器并定位。上一页是编辑器 → navigateBack；否则 navigateTo。
   * 两种情况都写 globalData.pendingFocus（编辑器可在 onShow 里读取后清空）。
   */
  goEdit (pick) {
    const focus = typeof pick === 'string' ? pick : this.focusOf(pick)
    app.globalData.pendingFocus = focus
    const stack = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    const prev = stack.length >= 2 ? stack[stack.length - 2] : null
    if (prev && prev.route === 'pages/edit/edit') {
      wx.navigateBack()
      return 'back'
    }
    wx.navigateTo({ url: '/pages/edit/edit' + (focus ? '?focus=' + encodeURIComponent(focus) : '') })
    return 'navigate'
  },

  /** 兼容旧入口：不带定位地回编辑器 */
  onEdit () {
    return this.goEdit('')
  },

  /* ================= 面板 ================= */

  openSheet (name) {
    if (this.data.readonly) return
    const patch = { sheet: name, readyShare: null, exportTip: '' }
    this.setData(patch)
  },

  closeSheet () {
    this._dragging = false
    this.setData({ sheet: '', readyShare: null })
  },

  onOpenStyle () {
    this.openSheet(this.data.sheet === 'style' ? '' : 'style')
  },

  onOpenExport () {
    this.openSheet(this.data.sheet === 'export' ? '' : 'export')
  },

  noop () {},

  onStyleTab (e) {
    const id = e.currentTarget.dataset.id
    if (id) this.setData({ styleTab: id })
  },

  onColor (e) {
    ops.applyColor(e.currentTarget.dataset.id)
  },

  onFont (e) {
    ops.applyFont(e.currentTarget.dataset.id)
  },

  onHeading (e) {
    ops.applyHeading(e.currentTarget.dataset.id)
  },

  onLayout (e) {
    ops.applyLayout(e.currentTarget.dataset.id)
  },

  /** 滑杆拖动中：实时预览，不落盘 */
  onSliderChanging (e) {
    const key = e.currentTarget.dataset.key
    this._dragging = true
    ops.previewStyle(key, Number(e.detail.value))
  },

  /** 滑杆松手：落盘 + 记一步撤销 */
  onSliderChange (e) {
    const key = e.currentTarget.dataset.key
    this._dragging = false
    clearTimeout(this._rebuildTimer)
    this._rebuildTimer = null
    ops.applySlider(key, Number(e.detail.value))
  },

  onTemplatePick (e) {
    const id = e.currentTarget.dataset.id
    if (!id || id === this.data.style.templateId) return
    store.applyTemplate(id, { keepContent: true })
    exp.toast('已换成「' + model.getTemplate(id).name + '」')
  },

  onAllTemplates () {
    wx.navigateTo({ url: '/packages/tools/templates/templates?from=preview' })
  },

  onUndo () {
    if (!store.undo()) exp.toast('没有可撤销的操作')
  },

  onRedo () {
    if (!store.redo()) exp.toast('没有可重做的操作')
  },

  /* ================= 一页（智能排版） ================= */

  onSmartFit () {
    if (this.data.readonly) return null
    let res = null
    try {
      res = ops.runSmartFit()
    } catch (err) {
      console.error('[preview] smart fit failed', err)
      exp.toast('排版失败：' + (err && err.message ? err.message : '未知错误'))
      return null
    }
    this._fitBackup = res.applied ? res.backup : null
    if (!res.applied) {
      exp.toast(res.message)
      return res
    }
    this.setData({
      sheet: 'fit',
      fit: {
        message: res.message,
        rows: ops.changeRows(res.changes),
        canRestore: true,
        pages: res.pages
      }
    })
    return res
  },

  onFitRestore () {
    if (!this._fitBackup) return false
    ops.restoreFitParams(this._fitBackup)
    this._fitBackup = null
    this.setData({ sheet: '', 'fit.canRestore': false })
    exp.toast('已还原排版参数')
    return true
  },

  /* ================= 导出 ================= */

  /** 导出文件名（不含扩展名）：姓名-求职意向-简历 */
  fileBase () {
    return ops.exportFileBase(this.resume)
  },

  /** 同一份内容重复导出时复用已生成的文件（例如「需要再点一次发送」） */
  cacheKey (kind) {
    return kind + '|' + JSON.stringify(this.resume, (k, v) => (k === 'updateDatetime' ? undefined : v))
  },

  async makeFile (kind) {
    const key = this.cacheKey(kind)
    if (this._fileCache && this._fileCache.key === key) return this._fileCache
    const base = this.fileBase()
    let out = null
    if (kind === 'pdf') {
      out = await exp.exportPdfFromCanvas(() => this.getCanvas(), this.resume, base)
    } else if (kind === 'doc') {
      out = await exp.buildWordFile(this.resume, base)
    } else if (kind === 'json') {
      out = await exp.buildJsonFile(store.exportJSON(), base)
    }
    this._fileCache = { key, kind, filePath: out.filePath, fileName: base + '.' + kind, pages: out.pages || 0 }
    return this._fileCache
  },

  /** 统一外壳：防连点 + loading + 错误提示 */
  runTask (title, fn) {
    if (this.data.exporting) return Promise.resolve(false)
    this.setData({ exporting: true, readyShare: null })
    return exp.runExportTask(title, fn).finally(() => this.setData({ exporting: false }))
  },

  /**
   * 生成后发到聊天。shareFileMessage 不支持 → 退回 openDocument（PDF/Word）；
   * 因耗时生成导致手势上下文失效 → 面板里给一个「发送」按钮，再点一次即可。
   */
  async shareKind (kind) {
    const f = await this.makeFile(kind)
    wx.hideLoading()
    try {
      const via = await exp.shareFile(f.filePath, f.fileName, kind)
      if (via === 'open') exp.toast('当前微信不支持直接发送，可在右上角「…」里转发')
      return via
    } catch (err) {
      if (err && err.needTap) {
        this.setData({ readyShare: { kind, fileName: f.fileName } })
        return 'needTap'
      }
      if (err && err.unsupported && kind === 'json') {
        await exp.copyText(store.exportJSON(), '')
        wx.showModal({ title: '已复制到剪贴板', content: '当前微信版本不支持发送文件，JSON 备份已复制，可粘贴到聊天发给自己。', showCancel: false })
        return 'copied'
      }
      throw err
    }
  },

  /** 「发送」按钮：用户这一次点击里同步调用 shareFileMessage */
  onShareReady () {
    const r = this.data.readyShare
    const f = this._fileCache
    if (!r || !f) return Promise.resolve(false)
    return exp.shareFile(f.filePath, f.fileName, r.kind)
      .then(() => { this.setData({ readyShare: null }); return true })
      .catch((err) => {
        if (!(err && err.cancelled)) exp.toast('发送失败：' + (err && err.message ? err.message : '未知错误'))
        return false
      })
  },

  onSharePdf () {
    return this.runTask('正在生成 PDF…', () => this.shareKind('pdf'))
  },

  onOpenPdf () {
    return this.runTask('正在生成 PDF…', async () => {
      const f = await this.makeFile('pdf')
      wx.hideLoading()
      await exp.openExportedFile(f.filePath, 'pdf')
    })
  },

  onShareWord () {
    return this.runTask('正在生成 Word…', () => this.shareKind('doc'))
  },

  onSaveImage () {
    return this.runTask('正在生成长图…', async () => {
      const { canvas, ctx } = await this.getCanvas()
      const out = await renderToContext(ctx, canvas, this.resume, { scale: 2 })
      const filePath = await this.toFile(canvas)
      wx.hideLoading()
      await exp.saveImageToAlbum(filePath)
      exp.toast(out && out.limited ? '已保存（内容较长，已自动降低清晰度）' : '长图已保存到相册')
    })
  },

  onCopyJson () {
    return exp.copyText(store.exportJSON(), 'JSON 已复制，可粘贴到电脑端导入')
  },

  onShareJson () {
    return this.runTask('正在生成备份…', () => this.shareKind('json'))
  },

  /* 兼容旧方法名（编辑页 / 旧测试仍可能调用） */
  onExportPdf () { return this.onOpenPdf() },
  onExportWord () { return this.onShareWord() },
  onExportImage () { return this.onSaveImage() },
  onCopyJSON () { return this.onCopyJson() },

  getCanvas () {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .in(this)
        .select('#exportCanvas')
        .fields({ node: true, size: true })
        .exec((res) => {
          const item = res && res[0]
          if (!item || !item.node) return reject(new Error('画布未就绪'))
          resolve({ canvas: item.node, ctx: item.node.getContext('2d') })
        })
    })
  },

  toFile (canvas) {
    return new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas,
        fileType: 'png',
        success: (r) => resolve(r.tempFilePath),
        fail: (e) => reject(new Error((e && e.errMsg) || '生成图片失败'))
      })
    })
  }
})

function dist (a, b) {
  const dx = (a.clientX || a.pageX || 0) - (b.clientX || b.pageX || 0)
  const dy = (a.clientY || a.pageY || 0) - (b.clientY || b.pageY || 0)
  return Math.sqrt(dx * dx + dy * dy)
}
