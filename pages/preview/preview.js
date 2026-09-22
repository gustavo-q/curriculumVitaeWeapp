/**
 * 简历预览（全屏纸面，对应参考站 UserView 的「查看大图」与 /print 视图的观感）
 *
 * 两种用法：
 *   · ?id=xxx     预览某份草稿（首页卡片点「预览」）
 *   · ?template=x 预览某个模板的示例排版（模板库点缩略图）
 *
 * 分页：纸张是连续的流，这里按 A4 切开并画页缝 —— 与编辑器共用
 * utils/layout.js 的 paginateResume()，两处页数必然一致。
 */
const store = require('../../utils/store.js')
const { buildThumbSample, normalizeResume, getTemplate } = require('../../utils/model.js')
const { buildPaperVM } = require('../../utils/paper.js')
const { paginateResume } = require('../../utils/layout.js')
const { saveImageToAlbum, toast } = require('../../utils/export.js')

const { renderToContext } = require('../../utils/render.js')

const app = getApp()

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    title: '',
    vm: null,
    seams: [],
    pages: 1,
    zoom: 0.5,
    paperBoxH: 0,
    resumeId: '',
    exporting: false
  },

  onLoad (query) {
    const g = app.globalData
    let resume = null
    let title = ''

    if (query.id) {
      const d = store.state.drafts.find((x) => x.id === query.id)
      if (d) {
        resume = normalizeResume(JSON.parse(JSON.stringify(d)))
        title = d.resumeName || '未命名简历'
      }
    } else if (query.template) {
      resume = normalizeResume(buildThumbSample(query.template))
      const t = getTemplate(query.template)
      title = t ? t.name + ' · 示例' : '模板预览'
    }
    if (!resume) {
      resume = normalizeResume(store.state.resume)
      title = resume.resumeName || '预览'
    }

    this.setData({
      statusBarHeight: g.statusBarHeight,
      navBarHeight: g.navBarHeight,
      title,
      resumeId: query.id || ''
    })
    this.buildPaper(resume)
    this.resume = resume
  },

  buildPaper (resume) {
    const vm = buildPaperVM(resume, { editable: false })
    const pag = paginateResume(resume)
    // 页缝页码列表：第 2..N 页
    const seams = []
    for (let i = 2; i <= pag.pages; i++) seams.push((i - 1) * 1123)
    this.setData({ vm, seams, pages: pag.pages, paperBoxH: pag.minHeight }, () => this.fit())
  },

  /** 纸张按可用宽度缩放（参考站编辑器的 fit()：留 48px 内边距，最大 1.15 倍） */
  fit () {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const availW = info.windowWidth - 32
    const zoom = Math.max(0.2, Number((availW / 794).toFixed(3)))
    this.setData({ zoom })
  },

  onEdit () {
    if (this.data.resumeId) {
      store.open(this.data.resumeId)
      wx.redirectTo({ url: '/pages/edit/edit' })
    } else {
      wx.navigateBack()
    }
  },

  /** 导出 PNG 长图：走 canvas 渲染，与屏幕上同一套几何 */
  async onExportImage () {
    if (this.data.exporting) return
    this.setData({ exporting: true })
    wx.showLoading({ title: '正在生成图片…', mask: true })
    try {
      const { canvas, ctx } = await this.getCanvas()
      const out = await renderToContext(ctx, canvas, this.resume, { scale: 2 })
      const filePath = await this.toFile(canvas)
      wx.hideLoading()
      await saveImageToAlbum(filePath)
      toast(out && out.limited ? '图片已保存（内容较长，已按画布上限降为 1 倍清晰度）' : '图片已保存到相册')
    } catch (err) {
      wx.hideLoading()
      if (err && err.cancelled) {
        toast('已取消保存')
        return
      }
      console.error('[preview] export failed', err)
      toast('导出失败：' + (err && err.message ? err.message : '未知错误'))
    } finally {
      this.setData({ exporting: false })
    }
  },

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
        fail: (e) => reject(new Error(e.errMsg || '生成图片失败'))
      })
    })
  },

  onCopyJSON () {
    const { copyText } = require('../../utils/export.js')
    copyText(store.exportJSON(), 'JSON 已复制，可粘贴保存')
  }
});
