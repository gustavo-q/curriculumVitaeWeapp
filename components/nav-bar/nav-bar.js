/**
 * 自定义导航栏。
 *
 * app.json 里 navigationStyle 为 custom（参考站也是全站自定义顶栏），
 * 因此每个页面都要自己处理状态栏高度与胶囊按钮的占位。
 * 高度在页面 onLoad 时从 app.globalData 传入，组件不再自己查一次。
 *
 * ★ 为什么必须为胶囊让位：
 * 微信右上角的胶囊按钮（··· 与 ◎）浮在页面最上层，且不属于页面节点树，
 * 任何排到它下面的按钮都会「看得见但点不动」——点击事件被胶囊截走。
 * 因此这里量出「胶囊左边缘到屏幕右边」的距离，作为导航栏的右内边距，
 * 右侧操作（导出 / 存图片）就永远落在胶囊左侧。
 */
Component({
  options: { addGlobalClass: true },
  properties: {
    title: { type: String, value: '' },
    /** 是否显示返回箭头 */
    back: { type: Boolean, value: true },
    /** 状态栏高度（px） */
    statusBarHeight: { type: Number, value: 20 },
    /** 导航栏内容区高度（px） */
    barHeight: { type: Number, value: 44 },
    /** 右侧文字（可选） */
    action: { type: String, value: '' }
  },

  data: {
    /** 内边距：右侧按胶囊实测宽度让位，拿不到胶囊信息时退回 24rpx */
    innerStyle: 'padding-left:24rpx;padding-right:12px'
  },

  lifetimes: {
    attached () {
      this.fitCapsule()
    }
  },

  methods: {
    /** 右侧预留胶囊宽度（含 8px 间隙），避免操作按钮被胶囊挡住 */
    fitCapsule () {
      const app = getApp()
      const g = (app && app.globalData) || {}
      const mb = g.menuButton
      let pad = 12 // 24rpx 的等效像素，作为兜底
      try {
        if (mb && mb.left) {
          const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
          pad = Math.max(12, Math.round(info.windowWidth - mb.left) + 8)
        }
      } catch (e) {}
      this.setData({
        innerStyle: 'padding-left:24rpx;padding-right:' + pad + 'px'
      })
    },

    onBack () {
      const pages = getCurrentPages()
      if (pages.length > 1) {
        wx.navigateBack()
      } else {
        wx.reLaunch({ url: '/pages/index/index' })
      }
    },

    onAction () {
      this.triggerEvent('action')
    }
  }
});
