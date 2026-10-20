/**
 * 模板库（tools 分包）
 *
 * 左右滑切换 18 套模板，每一页都用「用户自己的当前简历」套上该模板预览——
 * 套用发生在一份深拷贝上（applyTemplateToResume(clone)），点「用这套」之前
 * store 里的简历一个字段都不会变。
 *
 * 性能：swiper 只给 当前 ±1 页生成完整纸面 VM，其余是轻量占位（色条 + 名称）；
 * 网格模式的缩略图分批生成（每批 4 张），避免一次性 18 份 VM 卡住首帧。
 *
 * 入参：
 *   ?from=home|mine|preview  来源（from=home 且没有任何简历时，「用这套」= 用它新建一份）
 *   ?id=templateId           初始定位到某套模板
 */
const store = require('../../../utils/store.js')
const { TEMPLATES, getTemplate, applyTemplateToResume, normalizeResume, buildThumbSample } = require('../../../utils/model.js')
const { buildPaperVM } = require('../../../utils/paper.js')
const { paginateResume, A4_W, A4_H } = require('../../../utils/layout.js')

const app = getApp()

/** 预渲染半径：当前页前后各 1 页 */
const RENDER_RADIUS = 1
/** 网格每批生成几张缩略图 */
const GRID_BATCH = 4

const clone = (o) => JSON.parse(JSON.stringify(o))

function layoutLabel (layout) {
  return layout === 'LEFT' || layout === 'RIGHT' ? '双栏' : '单栏'
}

function windowInfo () {
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    return { w: info.windowWidth || 375, h: info.windowHeight || info.screenHeight || 667 }
  } catch (e) {
    return { w: 375, h: 667 }
  }
}

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    from: '',
    /** 没有任何已保存的简历：用示例内容预览，「用这套」改为新建 */
    noResume: false,
    current: 0,
    total: TEMPLATES.length,
    slides: [],
    currentId: '',
    appliedId: '',
    grid: false,
    gridItems: [],
    slideScale: 0.4,
    slideH: 449,
    gridScale: 0.2,
    gridH: 225
  },

  onLoad (query) {
    const q = query || {}
    const g = app.globalData
    const hasResume = store.state.drafts.some((d) => d.id === store.state.resume.id)
    const noResume = !hasResume
    // 预览所用的内容来源：有简历用当前简历；没有就用默认示例
    this.source = noResume ? normalizeResume(buildThumbSample('classic')) : clone(store.state.resume)

    const appliedId = hasResume ? store.state.resume.templateId : ''
    const startId = q.id || appliedId || TEMPLATES[0].id
    let current = TEMPLATES.findIndex((t) => t.id === startId)
    if (current < 0) current = 0

    this.vmCache = {}
    const slides = TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      desc: t.desc,
      brand: t.brand,
      layout: t.layout || 'SINGLE',
      layoutLabel: layoutLabel(t.layout),
      vm: null,
      pages: 0
    }))

    this.setData(Object.assign({
      statusBarHeight: g.statusBarHeight,
      navBarHeight: g.navBarHeight,
      from: q.from || '',
      noResume,
      appliedId,
      slides,
      current,
      currentId: TEMPLATES[current].id
    }, this.measure()))
    this.renderAround(current)
  },

  onUnload () {
    clearTimeout(this._gridTimer)
  },

  onResize () {
    this.setData(this.measure())
  },

  /** 按屏幕算缩放：纸面宽 ≤ 屏宽 - 96rpx，高 ≤ 可用高度 */
  measure () {
    const { w, h } = windowInfo()
    const k = w / 750
    const g = app.globalData || {}
    const chrome = (g.statusBarHeight || 20) + (g.navBarHeight || 44) + 420 * k // 顶栏 + 指示 + 底部按钮
    const byW = (w - 120 * k) / A4_W
    const byH = Math.max(200, h - chrome) / A4_H
    const slideScale = Math.max(0.2, Number(Math.min(byW, byH).toFixed(4)))
    const gridScale = Math.max(0.12, Number(((w - 28 * k * 2 - 20 * k) / 2 / A4_W).toFixed(4)))
    return {
      slideScale,
      slideH: Math.round(A4_H * slideScale),
      gridScale,
      gridH: Math.round(A4_H * gridScale)
    }
  },

  /** 非破坏性：在源内容的深拷贝上套模板 */
  previewResume (id) {
    const r = normalizeResume(clone(this.source))
    applyTemplateToResume(r, id)
    return r
  },

  vmOf (id) {
    if (!this.vmCache[id]) {
      const r = this.previewResume(id)
      this.vmCache[id] = { vm: buildPaperVM(r, { editable: false }), pages: paginateResume(r).pages }
    }
    return this.vmCache[id]
  },

  /** 只给 current ±1 生成完整 VM；其余释放为占位 */
  renderAround (cur) {
    const patch = {}
    this.data.slides.forEach((s, i) => {
      const near = Math.abs(i - cur) <= RENDER_RADIUS
      if (near && !s.vm) {
        const c = this.vmOf(s.id)
        patch['slides[' + i + '].vm'] = c.vm
        patch['slides[' + i + '].pages'] = c.pages
      } else if (!near && s.vm) {
        patch['slides[' + i + '].vm'] = null
      }
    })
    if (Object.keys(patch).length) this.setData(patch)
  },

  onSwiper (e) {
    const cur = Number(e.detail.current) || 0
    if (cur === this.data.current) return
    this.setData({ current: cur, currentId: TEMPLATES[cur].id })
    this.renderAround(cur)
  },

  /* ---------------- 网格 ---------------- */

  onToggleGrid () {
    const grid = !this.data.grid
    this.setData({ grid })
    if (grid && !this.data.gridItems.length) this.buildGrid()
  },

  buildGrid () {
    const items = TEMPLATES.map((t) => ({ id: t.id, name: t.name, brand: t.brand, layoutLabel: layoutLabel(t.layout), vm: null }))
    this.setData({ gridItems: items })
    let i = 0
    const step = () => {
      const patch = {}
      for (let n = 0; n < GRID_BATCH && i < items.length; n++, i++) {
        patch['gridItems[' + i + '].vm'] = this.vmOf(items[i].id).vm
      }
      this.setData(patch)
      if (i < items.length) this._gridTimer = setTimeout(step, 16)
    }
    step()
  },

  onGridPick (e) {
    const id = e.currentTarget.dataset.id
    const cur = TEMPLATES.findIndex((t) => t.id === id)
    if (cur < 0) return
    this.setData({ grid: false, current: cur, currentId: id })
    this.renderAround(cur)
  },

  /* ---------------- 应用 ---------------- */

  /** 用这套：写入 store（一步可撤销），返回上一页 */
  onUse () {
    const id = this.data.currentId
    if (!getTemplate(id)) return
    if (this.data.noResume) {
      store.create({ blank: false, templateId: id })
      wx.redirectTo({ url: '/pages/edit/edit' })
      return
    }
    store.applyTemplate(id, { keepContent: true })
    this.setData({ appliedId: id })
    wx.showToast({ title: '已换成「' + getTemplate(id).name + '」', icon: 'none' })
    setTimeout(() => wx.navigateBack(), 400)
  },

  /** 用这套新建一份（保留当前简历不动） */
  onNewWith () {
    const id = this.data.currentId
    if (!getTemplate(id)) return
    store.create({ blank: false, templateId: id })
    wx.redirectTo({ url: '/pages/edit/edit' })
  }
})
