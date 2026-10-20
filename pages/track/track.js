/**
 * Tab「投递」：投递记录列表（对应参考站 /track 看板）
 *
 * 手机上不做看板拖拽，改为：
 *   · 顶部分段 已投 / 面试中 / 已结束（带计数）
 *   · 卡片左滑露出「改状态 · 删除」；点卡片进详情编辑
 *   · 按简历筛选（picker，不受 actionSheet 6 项上限限制）
 *   · 右下 ＋ 新记一笔
 *
 * 数据全部经 utils/trackStore（pb_tracks_v1），onShow 每次重读：
 * 从详情页保存 / 从 JD 匹配记一笔回来时列表自动是最新的。
 *
 * 跨页筛选：tab 页不能带 query，其他页面要「打开投递并按某份简历筛选」时，
 * 先设 getApp().globalData.trackResumeFilter = 简历 id，再 wx.switchTab 过来。
 */
const store = require('../../utils/store.js')
const T = require('../../utils/trackStore.js')

/** 左滑露出的操作区宽度（rpx）：两个 136rpx 按钮 */
const ACTION_RPX = 272

function rpx2px (rpx) {
  let w = 375
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    w = info.windowWidth || 375
  } catch (e) {}
  return Math.round((rpx * w) / 750)
}

function resumeNameOf (id) {
  if (!id) return '未关联简历'
  const d = store.state.drafts.find((x) => x.id === id)
  return d ? d.resumeName || '未命名简历' : '简历已删除'
}

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    seg: 'applied',
    segments: [
      { id: 'applied', label: '已投', count: 0 },
      { id: 'interviewing', label: '面试中', count: 0 },
      { id: 'closed', label: '已结束', count: 0 }
    ],
    list: [],
    total: 0,
    /** 按简历筛选 */
    filterId: '',
    filterLabel: '全部简历',
    filterNames: ['全部简历'],
    filterIndex: 0,
    showFilter: false
  },

  onLoad () {
    const g = getApp().globalData || {}
    store.init()
    this._actionPx = rpx2px(ACTION_RPX)
    this._filterIds = ['']
    this.setData({
      statusBarHeight: g.statusBarHeight || 20,
      navBarHeight: g.navBarHeight || 44
    })
  },

  onShow () {
    const g = getApp().globalData || {}
    if (g.trackResumeFilter) {
      this.setData({ filterId: g.trackResumeFilter })
      g.trackResumeFilter = ''
    }
    this._openId = ''
    this.refresh()
  },

  /** 重读存储 → 计数 → 当前分段的卡片 */
  refresh () {
    const all = T.loadTracks()
    // 筛选选项：只列出投递记录里出现过的简历，外加「未关联」
    const ids = []
    let hasNone = false
    for (const t of all) {
      if (!t.resumeId) hasNone = true
      else if (ids.indexOf(t.resumeId) < 0) ids.push(t.resumeId)
    }
    const filterIds = [''].concat(ids, hasNone ? ['__none__'] : [])
    const filterNames = ['全部简历'].concat(ids.map(resumeNameOf), hasNone ? ['未关联简历'] : [])
    let filterId = this.data.filterId
    if (filterIds.indexOf(filterId) < 0) filterId = ''
    this._filterIds = filterIds

    const view = T.filterByResume(all, filterId)
    const counts = T.countByColumn(view)
    const seg = this.data.seg
    const col = T.TRACK_COLUMNS.find((c) => c.id === seg)
    const now = Date.now()
    const rows = T.sortForColumn(view.filter((t) => col.states.indexOf(t.status) >= 0), seg, now).map((t) => ({
      id: t.id,
      company: t.company,
      role: t.role,
      resumeName: resumeNameOf(t.resumeId),
      appliedAt: t.appliedAt,
      status: t.status,
      statusLabel: T.statusLabel(t.status),
      interview: t.interviewAt ? T.fmtInterview(t.interviewAt, now) : '',
      interviewPast: !!t.interviewAt && t.interviewAt < now,
      interviewSoon: T.isInterviewSoon(t.interviewAt, now),
      x: 0,
      /** 手指拖动中：去掉过渡动画，跟手 */
      d: false
    }))

    this.setData({
      segments: this.data.segments.map((s) => Object.assign({}, s, { count: counts[s.id] })),
      list: rows,
      total: all.length,
      filterId,
      filterNames,
      filterIndex: Math.max(0, filterIds.indexOf(filterId)),
      filterLabel: filterNames[Math.max(0, filterIds.indexOf(filterId))],
      showFilter: filterIds.length > 2
    })
  },

  onSeg (e) {
    const id = e.currentTarget.dataset.id
    if (!id || id === this.data.seg) return
    this.setData({ seg: id })
    this._openId = ''
    this.refresh()
  },

  onFilter (e) {
    const i = Number(e.detail.value) || 0
    this.setData({ filterId: this._filterIds[i] || '' })
    this.refresh()
  },

  onClearFilter () {
    this.setData({ filterId: '' })
    this.refresh()
  },

  /* ---------------- 左滑 ---------------- */

  indexOf (id) {
    return this.data.list.findIndex((x) => x.id === id)
  },

  closeOpen (exceptId) {
    const id = this._openId
    if (!id || id === exceptId) return
    const i = this.indexOf(id)
    if (i >= 0) this.setData({ ['list[' + i + '].x']: 0 })
    this._openId = ''
  },

  onTouchStart (e) {
    const id = e.currentTarget.dataset.id
    const p = e.touches[0]
    const i = this.indexOf(id)
    this._touch = {
      id,
      i,
      x0: p.clientX,
      y0: p.clientY,
      base: i >= 0 ? this.data.list[i].x : 0,
      dir: '',
      moved: false
    }
    this.closeOpen(id)
  },

  onTouchMove (e) {
    const tc = this._touch
    if (!tc || tc.i < 0) return
    const p = e.touches[0]
    const dx = p.clientX - tc.x0
    const dy = p.clientY - tc.y0
    if (!tc.dir) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      tc.dir = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'
    }
    if (tc.dir !== 'h') return
    const x = Math.max(-this._actionPx, Math.min(0, tc.base + dx))
    const patch = { ['list[' + tc.i + '].x']: x }
    if (!tc.moved) patch['list[' + tc.i + '].d'] = true
    tc.moved = true
    this.setData(patch)
  },

  onTouchEnd () {
    const tc = this._touch
    this._touch = null
    if (!tc || tc.i < 0 || tc.dir !== 'h') return
    const cur = (this.data.list[tc.i] || {}).x || 0
    const open = cur < -this._actionPx / 3
    this.setData({ ['list[' + tc.i + '].x']: open ? -this._actionPx : 0, ['list[' + tc.i + '].d']: false })
    this._openId = open ? tc.id : ''
    // 刚滑完的这次抬手不算点击
    this._swipedAt = Date.now()
  },

  onCardTap (e) {
    const id = e.currentTarget.dataset.id
    if (this._swipedAt && Date.now() - this._swipedAt < 300) return
    const i = this.indexOf(id)
    if (i >= 0 && this.data.list[i].x !== 0) {
      this.setData({ ['list[' + i + '].x']: 0 })
      this._openId = ''
      return
    }
    wx.navigateTo({ url: '/pages/track-edit/track-edit?id=' + encodeURIComponent(id) })
  },

  /* ---------------- 左滑操作 ---------------- */

  onChangeStatus (e) {
    const id = e.currentTarget.dataset.id
    const rec = T.getTrack(id)
    if (!rec) return this.refresh()
    const items = T.TRACK_STATUSES.map((s) => (s.id === rec.status ? '✓ ' : '') + s.label)
    wx.showActionSheet({
      itemList: items,
      success: (res) => {
        const next = T.TRACK_STATUSES[res.tapIndex]
        if (!next || next.id === rec.status) return this.refresh()
        if (!T.setStatus(id, next.id)) {
          wx.showToast({ title: '保存失败，存储空间可能已满', icon: 'none' })
          return
        }
        const moved = T.columnOf(next.id) !== this.data.seg
        wx.showToast({
          title: moved ? '已移到「' + T.TRACK_COLUMNS.find((c) => c.id === T.columnOf(next.id)).label + '」' : '已改为' + next.label,
          icon: 'none'
        })
        this.refresh()
        if (next.id === 'interviewing' && !rec.interviewAt) {
          setTimeout(() => {
            wx.showModal({
              title: '约好面试了？',
              content: '填上面试时间，可以一键加到手机日历提醒。',
              confirmText: '去填写',
              cancelText: '稍后',
              success: (r) => {
                if (r.confirm) wx.navigateTo({ url: '/pages/track-edit/track-edit?id=' + encodeURIComponent(id) })
              }
            })
          }, 600)
        }
      },
      fail: () => this.closeOpen()
    })
  },

  onDelete (e) {
    const id = e.currentTarget.dataset.id
    const rec = T.getTrack(id)
    if (!rec) return this.refresh()
    wx.showModal({
      title: '删除这条投递？',
      content: rec.company + ' · ' + rec.role + '\n删除后无法恢复。',
      confirmText: '删除',
      confirmColor: '#b3261e',
      success: (r) => {
        if (!r.confirm) return this.closeOpen()
        T.removeTrack(id)
        wx.showToast({ title: '已删除', icon: 'none' })
        this._openId = ''
        this.refresh()
      }
    })
  },

  /* ---------------- 入口 ---------------- */

  onAdd () {
    wx.navigateTo({ url: '/pages/track-edit/track-edit' })
  },

  onGoMatch () {
    wx.navigateTo({ url: '/packages/tools/match/match' })
  }
})
