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
const {
  saveImageToAlbum,
  copyText,
  toast,
  runExportTask,
  exportPdfFromCanvas,
  buildWordFile,
  openExportedFile,
  exportBaseName
} = require('../../utils/export.js')

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

  /** 「导出 ▾」按钮：ActionSheet 列出全部导出形态（对应编辑页「更多」里的导出组） */
  onExportMenu () {
    if (this.data.exporting) return
    wx.showActionSheet({
      itemList: ['导出 PDF（A4）', '导出 Word（可编辑）', '导出 PNG 长图', '复制 JSON 备份'],
      success: (res) => {
        if (res.tapIndex === 0) this.onExportPdf()
        else if (res.tapIndex === 1) this.onExportWord()
        else if (res.tapIndex === 2) this.onExportImage()
        else if (res.tapIndex === 3) this.onCopyJSON()
      },
      fail: () => {}
    })
  },

  /** 导出 PDF：逐页 A4 → JPEG → 组装 → 写盘 → 打开预览（与编辑页同一实现） */
  onExportPdf () {
    if (this.data.exporting) return Promise.resolve(false)
    this.setData({ exporting: true })
    return runExportTask('正在生成 PDF…', async () => {
      const out = await exportPdfFromCanvas(() => this.getCanvas(), this.resume, exportBaseName(this.resume))
      wx.hideLoading()
      await openExportedFile(out.filePath, 'pdf')
      toast('PDF 已导出（' + out.pages + ' 页）')
    }).finally(() => this.setData({ exporting: false }))
  },

  /** 导出 Word(.doc)：按当前排版生成 Word HTML，交给 Word / WPS */
  onExportWord () {
    if (this.data.exporting) return Promise.resolve(false)
    this.setData({ exporting: true })
    return runExportTask('正在生成 Word…', async () => {
      const out = await buildWordFile(this.resume, exportBaseName(this.resume))
      wx.hideLoading()
      await openExportedFile(out.filePath, 'doc')
      toast('Word 已导出，可用 WPS / Word 编辑')
    }).finally(() => this.setData({ exporting: false }))
  },

  /** 导出 PNG 长图：走 canvas 渲染，与屏幕上同一套几何 */
  onExportImage () {
    if (this.data.exporting) return Promise.resolve(false)
    this.setData({ exporting: true })
    return runExportTask('正在生成图片…', async () => {
      const { canvas, ctx } = await this.getCanvas()
      const out = await renderToContext(ctx, canvas, this.resume, { scale: 2 })
      const filePath = await this.toFile(canvas)
      wx.hideLoading()
      await saveImageToAlbum(filePath)
      toast(out && out.limited ? '图片已保存（内容较长，已按画布上限降为 1 倍清晰度）' : '图片已保存到相册')
    }).finally(() => this.setData({ exporting: false }))
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
