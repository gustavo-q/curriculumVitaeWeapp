/**
 * Tab「我的」：数量概览 + 工具入口 + 关于
 *
 * 工具都在分包 packages/tools 里（模板库 / JD 匹配 / 简历攻略 / 数据备份与恢复），
 * 主包只放这一页入口，保持主包小。
 */
const store = require('../../utils/store.js')
const T = require('../../utils/trackStore.js')

/** 本地开发 / 体验版拿不到线上版本号时显示的版本（与 package.json 保持一致） */
const APP_VERSION = '1.0.0'

function appVersion () {
  try {
    const info = wx.getAccountInfoSync && wx.getAccountInfoSync()
    const v = info && info.miniProgram && info.miniProgram.version
    if (v) return v
  } catch (e) {}
  return APP_VERSION
}

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    resumeCount: 0,
    trackCount: 0,
    interviewCount: 0,
    aboutOpen: false,
    version: APP_VERSION,
    cells: [
      { id: 'templates', icon: '🎨', title: '模板库', sub: '18 套模板，用自己的内容预览', url: '/packages/tools/templates/templates?from=mine' },
      { id: 'match', icon: '🎯', title: 'JD 匹配', sub: '粘贴岗位描述，看简历缺哪些关键词', url: '/packages/tools/match/match' },
      { id: 'guide', icon: '📘', title: '简历攻略', sub: '命名、STAR 写法、避坑清单', url: '/packages/tools/guide/guide' },
      { id: 'backup', icon: '🗂', title: '数据备份与恢复', sub: '与网页版互通，换手机不丢稿', url: '/packages/tools/backup/backup' }
    ]
  },

  onLoad () {
    const g = getApp().globalData || {}
    store.init()
    this.setData({
      statusBarHeight: g.statusBarHeight || 20,
      navBarHeight: g.navBarHeight || 44,
      version: appVersion()
    })
    this.unsubscribe = store.subscribe(() => this.refresh())
  },

  onUnload () {
    if (this.unsubscribe) this.unsubscribe()
  },

  onShow () {
    this.refresh()
  },

  refresh () {
    const tracks = T.loadTracks()
    const c = T.countByColumn(tracks)
    this.setData({
      resumeCount: (store.state.drafts || []).length,
      trackCount: tracks.length,
      interviewCount: c.interviewing
    })
  },

  onCell (e) {
    const id = e.currentTarget.dataset.id
    const cell = this.data.cells.find((x) => x.id === id)
    if (cell) wx.navigateTo({ url: cell.url })
  },

  onGoResumes () {
    wx.switchTab({ url: '/pages/home/home' })
  },

  onGoTracks () {
    wx.switchTab({ url: '/pages/track/track' })
  },

  onToggleAbout () {
    this.setData({ aboutOpen: !this.data.aboutOpen })
  }
})
