/**
 * 简历攻略（分包 tools）—— 对应参考站 /guide
 *
 * 入口：
 *   /packages/tools/guide/guide                 文章列表（分类筛选）
 *   /packages/tools/guide/guide?id=star         直接打开某篇
 *   /packages/tools/guide/guide?topic=教育背景   按区块标题打开最相关的一篇（找不到退回列表）
 *
 * 列表点文章 → navigateTo 同一页面带 ?id=，这样系统返回 / 右滑就能回到列表，
 * 不需要页内再做一层「返回」。
 */
const G = require('./guideData.js')

function dec (v) {
  if (v == null) return ''
  try {
    return decodeURIComponent(String(v))
  } catch (e) {
    return String(v)
  }
}

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    mode: 'list',
    cats: G.CATS,
    cat: '全部',
    list: G.ARTICLES,
    article: null,
    topicMissed: ''
  },

  onLoad (query) {
    const q = query || {}
    const g = getApp().globalData || {}
    this.setData({ statusBarHeight: g.statusBarHeight || 20, navBarHeight: g.navBarHeight || 44 })
    const id = dec(q.id)
    const topic = dec(q.topic)
    const art = (id && G.getArticle(id)) || (topic && G.findArticleByTopic(topic)) || null
    if (art) {
      this.setData({ mode: 'detail', article: art })
    } else if (topic) {
      this.setData({ topicMissed: topic })
    }
  },

  onCat (e) {
    const cat = e.currentTarget.dataset.cat
    if (!cat) return
    this.setData({
      cat,
      list: cat === '全部' ? G.ARTICLES : G.ARTICLES.filter((a) => a.cat === cat)
    })
  },

  onOpen (e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/packages/tools/guide/guide?id=' + encodeURIComponent(id) })
  },

  onAll () {
    wx.redirectTo({ url: '/packages/tools/guide/guide' })
  },

  /** 边看边写：从编辑器过来就返回编辑器；否则去简历 tab */
  onWrite () {
    const pages = getCurrentPages()
    const prev = pages.length > 1 ? pages[pages.length - 2] : null
    if (prev && prev.route && prev.route.indexOf('pages/edit/edit') >= 0) return wx.navigateBack()
    wx.switchTab({ url: '/pages/home/home' })
  },

  onShareAppMessage () {
    const a = this.data.article
    return a
      ? { title: a.title, path: '/packages/tools/guide/guide?id=' + a.id }
      : { title: '简历攻略：命名、STAR 写法、关键词与避坑清单', path: '/packages/tools/guide/guide' }
  }
})
