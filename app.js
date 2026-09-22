const store = require('./utils/store.js')

App({
  globalData: {
    /** 状态栏高度（自定义导航栏要用它做顶部留白） */
    statusBarHeight: 20,
    /** 胶囊按钮信息：纵向居中的安全区由它决定 */
    navBarHeight: 44,
    menuButton: null,
    safeBottom: 0,
    /** 跨页面的一次性参数（例如模板库 → 编辑器） */
    pendingTemplateId: ''
  },

  onLaunch () {
    // 先恢复草稿，再让页面 onLoad；store.init() 幂等，重复调用无副作用
    store.init()

    let info = null
    try {
      info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    } catch (e) {
      info = null
    }
    if (info) {
      this.globalData.statusBarHeight = info.statusBarHeight || 20
      this.globalData.safeBottom = info.safeArea ? Math.max(0, (info.screenHeight || 0) - info.safeArea.bottom) : 0
    }
    try {
      this.globalData.menuButton = wx.getMenuButtonBoundingClientRect()
    } catch (e) {
      this.globalData.menuButton = null
    }
    if (this.globalData.menuButton) {
      const mb = this.globalData.menuButton
      this.globalData.navBarHeight = (mb.top - this.globalData.statusBarHeight) * 2 + mb.height
    }
  },

  onShow () {
    // 从后台回到前台：把未落盘的改动存下来
    if (store.state.initialized && store.state.dirty) store.save(true)
  },

  onHide () {
    if (store.state.initialized && store.state.dirty) store.save(true)
  }
})
