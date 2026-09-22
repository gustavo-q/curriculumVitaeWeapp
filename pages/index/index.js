/**
 * 我的简历（对应参考站 / 与 /user 页面）
 *
 * 首页即草稿列表：新建 / 导入 / 备份全部 / 复制 / 删除 / 预览，
 * 点卡片任意位置直接进编辑器（与参考站「整张卡片即入口」一致）。
 */
const store = require('../../utils/store.js')
const { normalizeResume, TEMPLATES } = require('../../utils/model.js')
const { buildPaperVM } = require('../../utils/paper.js')
const { copyText, toast, fmtTime } = require('../../utils/export.js')

const app = getApp()

/** 缩略图容器的设计尺寸（与 index.wxss 的 .thumb 保持一致） */
const THUMB_W_RPX = 200
const THUMB_H_RPX = 268
/** 纸张设计尺寸（与 utils/paper.js 的 A4 一致） */
const A4_W = 794
const A4_H = 1123

/**
 * 缩略图缩放倍率。原来写死 0.28：纸张 794px 缩到 222px，而容器只有
 * 100px 宽（200rpx），横向被裁掉 55%，用户只能看到简历中间一条，
 * 完全看不出单栏还是双栏。这里按容器实际尺寸算出「整页刚好放下」的倍率。
 */
function thumbScale () {
  let winW = 375
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    winW = info.windowWidth || 375
  } catch (e) {}
  const k = winW / 750
  const boxW = THUMB_W_RPX * k
  const boxH = THUMB_H_RPX * k
  return Math.min(boxW / A4_W, boxH / A4_H)
}

function decorate (drafts, currentId, scale) {
  return drafts.map((d) => {
    const r = normalizeResume(d)
    return {
      id: d.id,
      name: d.resumeName || '未命名简历',
      sectionCount: (d.sections || []).length,
      time: fmtTime(d.updateDatetime),
      isCurrent: d.id === currentId,
      templateName: (TEMPLATES.find((t) => t.id === r.templateId) || TEMPLATES[0]).name,
      // 缩略图只渲染纸张，不带编辑槽位（与参考站 buildThumbSample 的只读渲染一致）
      vm: buildPaperVM(r, { editable: false }),
      // 每张缩略图按自己的实际页数定高，避免多页简历在框里被硬裁
      thumbH: Math.round(A4_H * scale)
    }
  })
}

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    drafts: [],
    thumbScale: 0.12,
    paperH: 1123
  },

  onLoad () {
    const g = app.globalData
    store.init()
    this.setData({
      statusBarHeight: g.statusBarHeight,
      navBarHeight: g.navBarHeight,
      thumbScale: thumbScale()
    })
    this.unsubscribe = store.subscribe(() => this.refresh())
    this.refresh()
  },

  onUnload () {
    if (this.unsubscribe) this.unsubscribe()
  },

  onShow () {
    this.refresh()
  },

  onResize () {
    this.setData({ thumbScale: thumbScale() })
  },

  refresh () {
    this.setData({
      drafts: decorate(store.state.drafts, store.state.resume.id, this.data.thumbScale)
    })
  },

  onCreate () {
    store.create({ blank: false })
    wx.navigateTo({ url: '/pages/edit/edit' })
  },

  onCreateBlank () {
    store.create({ blank: true })
    wx.navigateTo({ url: '/pages/edit/edit' })
  },

  /* ================= 卡片手势：点击进编辑 / 长按菜单 =================
   *
   * 卡片正面此前挂着「预览 / 复制 / 删除」三个按钮，既占掉右侧一整块宽度，
   * 也让「点卡片进编辑」这个主路径被一排次级操作分散。现在两个动作都收敛到卡片：
   *
   *   点击   → 进编辑器打开这份简历
   *   长按   → 弹出「预览 / 复制 / 删除」（删除带二次确认，见 onCardMenu）
   *
   * 与 pages/edit 的目录行共用同一套状态机写法：不用 bindtap 判点击，
   * 因为长按弹出菜单后系统仍可能补一个 tap，会把菜单顶掉并误进编辑器。
   */

  /** 长按多久算「长按菜单」 */
  _LONG_PRESS_MS: 380,
  /** 位移超过它就不再算点击（px） */
  _TAP_SLOP_PX: 8,

  _cardTouch: null,

  onCardTouchStart (e) {
    const touch = e.touches && e.touches[0]
    if (!touch) return
    const id = e.currentTarget.dataset.id
    const card = this.data.drafts.find((x) => x.id === id)
    if (!card) return

    this._cardTouch = {
      id,
      startX: touch.clientX,
      startY: touch.clientY,
      mode: 'idle',
      timer: null
    }
    /*
     * 按住不动 → 弹菜单；一旦位移或抬手都会清掉它。
     * 必须把 mode 改成 'menu'：菜单弹出后用户才抬手，touchend 随后到达，
     * 若 mode 仍是 'idle' 会被判成「点击」，把菜单顶掉并误进编辑器。
     */
    this._cardTouch.timer = setTimeout(() => {
      if (this._cardTouch) this._cardTouch.mode = 'menu'
      this.openCardMenu(id)
    }, this._LONG_PRESS_MS)
  },

  onCardTouchMove (e) {
    const t = this._cardTouch
    const touch = e.touches && e.touches[0]
    if (!t || !touch) return

    const dxPx = touch.clientX - t.startX
    const dyPx = touch.clientY - t.startY
    if (Math.abs(dxPx) <= this._TAP_SLOP_PX && Math.abs(dyPx) <= this._TAP_SLOP_PX) return

    // 手指动了：取消长按判定，本卡不再参与手势（滑动交给页面滚动）
    this.clearCardTimer()
    t.mode = 'move'
  },

  onCardTouchEnd () {
    const t = this._cardTouch
    if (!t) return
    this.clearCardTimer()
    this._cardTouch = null

    // 滑动过、或已弹过长按菜单：抬手不触发「点击进编辑」
    if (t.mode !== 'idle') return
    this.openCard(t.id)
  },

  onCardTouchCancel () {
    if (!this._cardTouch) return
    this.clearCardTimer()
    this._cardTouch = null
  },

  clearCardTimer () {
    if (this._cardTouch && this._cardTouch.timer) {
      clearTimeout(this._cardTouch.timer)
      this._cardTouch.timer = null
    }
  },

  /** 点击卡片 → 打开编辑 */
  openCard (id) {
    store.open(id)
    wx.navigateTo({ url: '/pages/edit/edit' })
  },

  /** 长按卡片 → 弹出预览 / 复制 / 删除 */
  openCardMenu (id) {
    const d = this.data.drafts.find((x) => x.id === id)
    if (!d) return
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light', fail: () => {} })

    const actions = ['预览', '复制到新简历', '删除']
    wx.showActionSheet({
      itemList: actions,
      success: (res) => {
        const label = actions[res.tapIndex]
        if (label === '预览') {
          wx.navigateTo({ url: '/pages/preview/preview?id=' + id })
        } else if (label === '复制到新简历') {
          const c = store.duplicate(id)
          if (c) toast('已复制「' + c.resumeName + '」')
        } else if (label === '删除') {
          this.confirmRemove(id)
        }
      },
      fail: () => {}
    })
  },

  /**
   * 删除确认。长按菜单里的删除与「清空全部」共用同一套二次确认文案。
   */
  confirmRemove (id) {
    const d = store.state.drafts.find((x) => x.id === id)
    wx.showModal({
      title: '确定删除？',
      content: '将删除「' + ((d && d.resumeName) || '未命名简历') + '」，删除后不可恢复。',
      confirmText: '删除',
      confirmColor: '#b3261e',
      success: (res) => {
        if (!res.confirm) return
        store.remove(id)
        toast('已删除')
      }
    })
  },

  /* ================= 顶部入口 ================= */

  onTemplates () {
    wx.navigateTo({ url: '/pages/templates/templates' })
  },

  /** 备份全部：JSON 体积可能几十 KB，复制到剪贴板比弹窗展示更实用 */
  onBackupAll () {
    if (!store.state.drafts.length) return toast('还没有简历可备份')
    copyText(store.exportAllDraftsJSON(), '已复制 ' + store.state.drafts.length + ' 份简历的备份')
  },

  /** 导入：粘贴 JSON 文本。小程序无法读取任意本地 .json 文件（没有文件选择器），
   *  因此用「粘贴文本」替代参考站的 file input，功能等价。 */
  onImport () {
    wx.showModal({
      title: '导入简历',
      editable: true,
      placeholderText: '粘贴 JSON 文本（单份或备份全部）',
      success: (res) => {
        if (!res.confirm || !res.content) return
        try {
          const n = store.importJSON(res.content, { asDraftList: true })
          toast('已导入 ' + n + ' 份简历')
        } catch (err) {
          toast('JSON 格式不正确')
        }
      }
    })
  },

  onClearAll () {
    if (!store.state.drafts.length) return
    wx.showModal({
      title: '清空全部简历？',
      content: '将删除本机保存的所有草稿，不可恢复。建议先「备份全部」。',
      confirmText: '清空',
      confirmColor: '#b3261e',
      success: (res) => {
        if (!res.confirm) return
        store.clearAll()
        toast('已清空')
      }
    })
  }
});
