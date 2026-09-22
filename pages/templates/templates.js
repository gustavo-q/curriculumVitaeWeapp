/**
 * 模板库（对应参考站 /template 页面）
 *
 * 与参考站一致的两个约定：
 *   · 模板 = 一整套风格（配色 + 字体 + 标题装饰 + 栏式 + 字号行距 + 页边距）
 *   · 缩略图用「同一份示例内容」渲染，换模板换的是排版而不是内容，
 *     这样缩略图之间的差异才是模板本身的差异（而不是示例文案的差异）
 */
const store = require('../../utils/store.js')
const { TEMPLATES, buildThumbSample, normalizeResume } = require('../../utils/model.js')
const { buildPaperVM } = require('../../utils/paper.js')

const app = getApp()

/** 卡片左右各 28rpx 内边距（与 templates.wxss 的 .grid 一致） */
const GRID_PAD_RPX = 28
/** 纸张设计宽度（与 utils/paper.js 的 A4 一致） */
const A4_W = 794

/**
 * 缩略图缩放倍率。
 *
 * 原来写死 0.42：纸张 794px 缩到 333px，在 320px 宽的屏上卡片只有
 * 296px，横向溢出一截被裁掉（缩略图右边缺一块）。这里按卡片实际
 * 宽度反算，任何屏宽都能完整放下纸面。
 */
function thumbScale () {
  let winW = 375
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    winW = info.windowWidth || 375
  } catch (e) {}
  const k = winW / 750
  const cardW = winW - GRID_PAD_RPX * 2 * k
  return Math.max(0.2, Number((cardW / A4_W).toFixed(4)))
}

/**
 * 缩略图渲染数据（每个模板一份）。
 *
 * 注意这里产出的是 buildPaperVM() 编译过的 VM，不是原始简历：
 * 纸张组件只认 VM（paperStyle / sections[].itemVMs 这套结构），
 * 直接把简历塞进去会渲染成一片空白。
 */
function buildThumbs (list) {
  return list.map((t) => {
    const sample = normalizeResume(buildThumbSample(t.id))
    const tags = t.tags || []
    /**
     * 命中标记：按分类预先算好，避免在 WXML 里写 tags.indexOf(activeCat)。
     *
     * 模板页每个模板都要渲染一整张纸（18 份 VM），在 WXML 里做数组方法
     * 调用会让每次分类切换都重算 18 遍；而且 WXML 的表达式能力有限，
     * 这种判断放在 JS 里更可靠、也更好排查。分类数量固定在 9 个以内，
     * 预计算的开销可以忽略。
     */
    const hits = { 全部: true }
    for (const tag of tags) hits[tag] = true
    return {
      id: t.id,
      name: t.name,
      desc: t.desc,
      tags,
      hits,
      layout: t.layout || 'SINGLE',
      layoutLabel: t.layout === 'LEFT' ? '信息左' : t.layout === 'RIGHT' ? '信息右' : '单栏',
      popularity: t.popularity,
      brand: t.brand,
      vm: buildPaperVM(sample, { editable: false })
    }
  })
}

/**
 * 分类列表：从模板的 tags 自动派生，而不是手写一份。
 *
 * 手写列表很容易与模板数据脱节——原来写死 9 个分类，而模板实际用到 16 个
 * tag，导致「现代侧栏」「暖调创意」（tags 均为 设计/运营/市场）在任何具体
 * 分类下都筛不出来，只能从「全部」里翻到；而切到「设计」这种不存在的分类时
 * 整片列表还会空白且没有空状态文案。
 *
 * 现在：常用分类排在前面（保证顺序稳定、符合直觉），其余按模板出现顺序追加。
 */
const CAT_ORDER = ['通用', '应届生', '校招', '实习', '社招', '互联网', '国企', '事业单位', '简历', '科研', '教师']

function buildCats (list) {
  const seen = new Set()
  for (const t of list) for (const tag of (t.tags || [])) seen.add(tag)
  const head = CAT_ORDER.filter((c) => seen.has(c))
  const rest = [...seen].filter((c) => !CAT_ORDER.includes(c)).sort()
  return ['全部'].concat(head, rest)
}

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    list: [],
    cats: ['全部'],
    activeCat: '全部',
    /** 当前分类下是否有模板，用于渲染空状态 */
    emptyCat: false,
    currentId: 'classic',
    /** 缩略图缩放倍率，由 onLoad 按屏宽算出 */
    thumbScale: 0.42
  },

  onLoad () {
    const g = app.globalData
    const cat = this.data.activeCat
    // 首次进入就带上 match，避免模板列表先渲染一帧再被过滤
    const list = buildThumbs(TEMPLATES).map((t) => Object.assign(t, { match: t.hits[cat] === true }))
    this.setData({
      statusBarHeight: g.statusBarHeight,
      navBarHeight: g.navBarHeight,
      list,
      cats: buildCats(list),
      currentId: store.state.resume.templateId,
      thumbScale: thumbScale(),
      emptyCat: list.every((t) => !t.match)
    })
  },

  onResize () {
    this.setData({ thumbScale: thumbScale() })
  },

  onShow () {
    this.setData({ currentId: store.state.resume.templateId })
  },

  /** 分类切换：只改命中标记，不重建 18 份 VM（缩略图重算很贵） */
  onCat (e) {
    const cat = e.currentTarget.dataset.cat
    if (cat === this.data.activeCat) return
    this.applyCat(cat)
  },

  /**
   * 应用分类：把命中结果写成一个布尔字段 match，而不是让 WXML 做
   * `item.hits[activeCat]` 这种动态键取值——WXML 的表达式子集对动态
   * 键的支持在不同基础库上并不一致，落成布尔最稳。
   */
  applyCat (cat) {
    const list = this.data.list.map((t) => Object.assign({}, t, { match: t.hits[cat] === true }))
    this.setData({
      activeCat: cat,
      list,
      // 分类下没有模板时给出空状态，避免整片空白让人以为「加载失败」
      emptyCat: list.every((t) => !t.match)
    })
  },

  /** 应用模板：整体风格 + 配色 + 字体 + 排版尺寸（保留已填内容） */
  onUse (e) {
    const id = e.currentTarget.dataset.id
    store.applyTemplate(id, { keepContent: true })
    this.setData({ currentId: id })
    wx.showToast({ title: '已应用模板', icon: 'none' })
    setTimeout(() => wx.navigateBack(), 500)
  },

  /** 带模板新建一份简历 */
  onNewWith (e) {
    const id = e.currentTarget.dataset.id
    store.create({ blank: false, templateId: id })
    wx.reLaunch({ url: '/pages/edit/edit' })
  },

  /** 点击缩略图 → 全屏预览该模板示例（与参考站模板库的「看大图」一致） */
  onPreview (e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/preview/preview?template=' + id })
  }
});
