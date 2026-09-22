/**
 * 编辑器（对应参考站 /edit 页面）
 *
 * 布局与参考站一致：顶部工具栏 + 中间纸张画布 + 底部面板。
 * 小程序屏幕窄，参考站那种「左侧目录 + 右侧纸面」的双栏改成「纸面在上、
 * 面板在下」，但信息架构不变：纸面负责所见即所得，面板负责结构化编辑。
 *
 * 页面的三个技术要点：
 *   1. 纸张按 794 设计像素排版，再整体 scale 到手机宽度；
 *      缩放只改 transform，不改布局尺寸，因此与参考站同一套坐标体系。
 *   2. VM 与分页都由 utils 同步算出（不依赖 DOM 测量），输入时不会抖动。
 *   3. 文本在输入停顿后才写回 store —— 避免每敲一个字就重建 VM 导致
 *      输入框被重置、光标跳到末尾（这是小程序里文本编辑最常见的坑）。
 */
const store = require('../../utils/store.js')
const model = require('../../utils/model.js')
const { buildPaperVM } = require('../../utils/paper.js')
const L = require('../../utils/layout.js')
const onePage = require('../../utils/onePage.js')
const { renderToContext } = require('../../utils/render.js')
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
const { resolvePhoto } = require('../../utils/avatars.js')
const { PHOTO_PRESETS, PHOTO_SHAPES, PHOTO_BORDERS, PHOTO_RATIOS } = model

const app = getApp()

/** 面板切换时的默认目标 */
const PANEL_NONE = ''

/** 把用户输入的颜色规整成 #rrggbb；无法识别时返回空串 */
function normalizeHex (input) {
  let s = String(input == null ? '' : input).trim()
  if (!s) return ''
  if (s[0] !== '#') s = '#' + s
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    // #abc → #aabbcc
    s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]
  }
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : ''
}

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,

    /* ---- 纸张 ---- */
    vm: null,
    seams: [],
    pages: 1,
    paperBoxH: 1123,
    zoom: 0.45,

    /* ---- 工具栏状态 ---- */
    title: '未命名简历',
    dirty: false,
    /*
     * 撤销 / 重做的可用态。工具栏精简后它们不再有独立按钮，
     * 但仍是「更多」浮层里那两行的禁用依据，因此照旧下发。
     */
    canUndo: false,
    canRedo: false,

    /* ---- 选择与面板 ---- */
    panel: PANEL_NONE,
    sel: { sec: '', item: '' },
    focusKey: '',

    /* ---- 顶部浮层菜单 ---- */
    menuOpen: false,
    menuTop: 96,
    /*
     * 浮层内的二级页：'' = 菜单主页；'export' = 导出子页。
     * 子页共用同一个浮层（换标题 + 换列表 + 头部出现返回箭头），
     * 不另开一层遮罩，返回和关闭的层级关系才不会乱。
     */
    menuPage: '',

    /* ---- 面板数据 ---- */
    baseInfo: {},
    /* 基本信息每一行的渲染数据：{key,label,on}，on 由 refresh() 预计算。
       WXML 只做 item.on 的布尔判断，不做任何方法调用（见 refresh 里的说明）。 */
    baseRows: [],
    /*
     * 目录行：只承载区块标题与手势位移。
     * 条目明细不再进目录（那是「编辑」按钮的替代品），只保留在手势需要的
     * offsetX / offsetY 字段里——它们由触摸处理函数写，不参与业务数据。
     */
    dirRows: [],
    /* 同一时刻只会有一个列表处于拖动状态，用 list 区分是目录还是区块内条目 */
    rowDrag: { list: '', id: '', index: -1, active: false },
    /*
     * 正在跟手位移的行的 id（拖动或左滑）。这一行的 transform 过渡会被关掉，
     * 否则每帧 setData 的位移都追不上手指，拖动会「越拖越落后」。
     */
    rowMoving: '',
    /* 拖动到列表边缘时的自动滚动位置（见 onRowTouchMove） */
    panelScrollTop: 0,
    currentSection: null,
    currentItem: null,
    /*
     * 条目排版：用「示意图 + 大白话」代替术语。
     *
     * 原来这里是「整行 / 左+右 / 左+中+右」三个纯文字按钮，而下面三个输入框
     * 叫「左栏 / 正文 / 右栏」——那是数据模型的字段名，不是用户语言；
     * 用户得先在脑子里把「左+中+右」翻译成「学校 + 专业 + 时间」，
     * 再猜哪个框对应哪一栏。现在三个选项各配一张小示意图（一格 / 两格 / 三格），
     * 字段名换成「标题 / 说明 / 时间」，并且只显示当前排版确实会用到的输入框。
     */
    itemTypes: [
      { id: 'ONE', label: '一行文字', hint: '整行都用来写内容，适合自我介绍、工作描述。' },
      { id: 'TWO', label: '左右两栏', hint: '左边写标题、右边写时间，适合证书、奖项。' },
      { id: 'THREE', label: '左中右三栏', hint: '标题 + 说明 + 时间，适合学校、公司经历。' }
    ],

    /* ---- 样式面板 ---- */
    templates: model.TEMPLATES.map((t) => ({ id: t.id, name: t.name, desc: t.desc, layout: t.layout })),
    colors: model.COLOR_PRESETS,
    layouts: model.PAGE_LAYOUTS,
    fonts: model.FONT_FAMILIES.map((f) => ({ id: f.id, label: f.label })),
    headings: model.HEADING_THEMES,
    borders: model.BORDER_THEMES,
    style: {},
    fontIndex: 0,
    headingIndex: 0,
    borderIndex: 0,
    layoutIndex: 0,
    sizeLabels: ['字号', '行距', '字距', '左右边距', '上下边距', '区块间距', '信息栏宽度'],

    /* ---- 照片面板 ---- */
    photoPresets: PHOTO_PRESETS,
    photoShapes: PHOTO_SHAPES,
    photoBorders: PHOTO_BORDERS,
    photoRatios: PHOTO_RATIOS,
    photoSrc: '',
    photo: {},

    exporting: false
  },

  /* ================= 生命周期 ================= */

  onLoad (query) {
    const g = app.globalData
    store.init()
    // 模板库可能带模板进入：应用模板但保留已填内容
    const tpl = (query && query.template) || g.pendingTemplateId
    if (tpl) {
      g.pendingTemplateId = ''
      store.applyTemplate(tpl, { keepContent: true })
    }

    this.unsubscribe = store.subscribe(() => this.refresh())
    this.setData({
      statusBarHeight: g.statusBarHeight,
      navBarHeight: g.navBarHeight
    })
    this.refresh()
    this.startTimers()
  },

  onUnload () {
    this.stopTimers()
    this.abortRowDrag()
    if (this.unsubscribe) this.unsubscribe()
    // 离开编辑器一定落盘（对应参考站 onBeforeRouteLeave 里的补存）
    if (store.state.dirty) store.save(true)
  },

  onHide () {
    this.commitPending()
    if (store.state.dirty) store.save(true)
  },

  startTimers () {
    // 自动保存：每 4 秒落一次盘（与参考站同频）
    this.saveTimer = setInterval(() => {
      store.commitTextHistory()
      if (store.state.dirty) store.save(true)
    }, 4000)
    // 历史点：只在内容确实变过时生成，避免每 700ms 都序列化一次（照片大字段开销大）
    this.changeTick = 0
    this.snapTick = -1
    this.historyTimer = setInterval(() => {
      if (this.changeTick === this.snapTick) return
      this.snapTick = this.changeTick
      store.commitTextHistory()
      store.snapshot()
    }, 700)
  },

  stopTimers () {
    if (this.saveTimer) clearInterval(this.saveTimer)
    if (this.historyTimer) clearInterval(this.historyTimer)
    this.saveTimer = null
    this.historyTimer = null
  },

  /* ================= 渲染 ================= */

  /** 任何 store 变更后：重建 VM、重算分页、刷新所有面板数据 */
  refresh () {
    this.changeTick = (this.changeTick || 0) + 1
    const resume = store.state.resume
    const vm = buildPaperVM(resume, { editable: true })
    const pag = L.paginateResume(resume, null, { editable: true })

    const seams = []
    for (let i = 2; i <= pag.pages; i++) seams.push((i - 1) * L.A4_H)

    this.setData({
      vm,
      seams,
      pages: pag.pages,
      paperBoxH: pag.minHeight,
      title: resume.resumeName || '未命名简历',
      dirty: store.state.dirty,
      canUndo: store.getters.canUndo(),
      canRedo: store.getters.canRedo(),
      baseInfo: Object.assign({}, resume.baseInfo),
      activeFields: (resume.baseFields || []).slice(),
      /*
       * baseRows 是基本信息面板渲染用的行数据：把「该字段是否显示」
       * 直接算成布尔挂在每一行上。
       *
       * ★ 为什么不能在 WXML 里用 activeFields.indexOf(item.key) 判断：
       *   那是全项目 WXML 里唯一的方法调用，而渲染层对方法调用的支持
       *   是「异常时静默返回 undefined」（wcc 生成的 case 12 有
       *   try/catch → _r = undefined），一旦求值失败，`undefined >= 0`
       *   恒为 false —— 开关的 class 就永远算不出 'on'，用户看到的是
       *   「点了开关，颜色怎么都不变」。样式面板的开关之所以正常，
       *   正是它只用 `style.headingCenter` 这种简单属性访问。
       *   在 JS 侧预计算后，WXML 退化为 `item.on ? ... : ...` 的简单
       *   布尔判断，与正常工作的开关完全同一形态，不再依赖方法调用。
       */
      baseRows: model.BASE_FIELDS.map((f) => ({
        key: f.key,
        label: f.label,
        on: (resume.baseFields || []).indexOf(f.key) >= 0
      })),
      /*
       * 目录只显示标题。原来每行还挂着「N 个条目」与可点击的「编辑」按钮，
       * 现在整行可点即进编辑，因此这里不再下发 itemCount / items：
       * 面板数据少一层，行高也更接近纯标题。
       */
      dirRows: resume.sections.map((s, i) => ({
        id: s.id,
        title: s.title,
        visible: s.visible !== false,
        index: i + 1,
        offsetX: 0,
        offsetY: 0
      })),
      style: {
        templateId: resume.templateId,
        headingColor: resume.headingColor,
        fontFamily: resume.fontFamily,
        headingTheme: resume.headingTheme,
        borderTheme: resume.borderTheme,
        pageLayout: resume.pageLayout,
        headingCenter: !!resume.headingCenter,
        accentBlock: !!resume.accentBlock,
        fontSize: resume.fontSize,
        lineHeight: resume.lineHeight,
        fontSpacing: resume.fontSpacing,
        horizontalPadding: resume.horizontalPadding,
        verticalPadding: resume.verticalPadding,
        sectionSpacing: resume.sectionSpacing,
        baseInfoRatio: resume.baseInfoRatio
      },
      photo: {
        personalPhoto: resume.personalPhoto,
        shape: resume.personalPhotoShape,
        border: resume.personalPhotoBorder,
        width: resume.personalPhotoWidth,
        height: resume.personalPhotoHeight,
        right: resume.personalPhotoRight,
        top: resume.personalPhotoTop
      },
      photoSrc: resolvePhoto(resume.personalPhoto)
    })
    this.syncIndices()
    this.syncSelection()
  },

  syncIndices () {
    const r = store.state.resume
    const fi = model.FONT_FAMILIES.findIndex((f) => f.id === r.fontFamily)
    const hi = model.HEADING_THEMES.findIndex((h) => h.id === r.headingTheme)
    const bi = model.BORDER_THEMES.findIndex((b) => b.id === r.borderTheme)
    const li = model.PAGE_LAYOUTS.findIndex((l) => l.id === r.pageLayout)
    this.setData({
      fontIndex: fi < 0 ? 0 : fi,
      headingIndex: hi < 0 ? 0 : hi,
      borderIndex: bi < 0 ? 0 : bi,
      layoutIndex: li < 0 ? 0 : li
    })
  },

  /** 把选中项的最新数据同步到面板（条目可能在别处被改过类型） */
  syncSelection () {
    const { sec, item } = this.data.sel
    const resume = store.state.resume
    const s = resume.sections.find((x) => x.id === sec)
    if (!s) {
      if (sec) this.setData({ sel: { sec: '', item: '' }, currentSection: null, currentItem: null })
      return
    }
    const it = item ? s.items.find((x) => x.id === item) : null
    this.setData({
      currentSection: {
        id: s.id,
        title: s.title,
        visible: s.visible !== false,
        index: resume.sections.indexOf(s) + 1,
        total: resume.sections.length,
        /*
         * 条目行的 offsetX / offsetY 与目录行同义：左滑位移与拖动位移。
         * 每次重建都归零是正确的——顺序或内容一变，手势位移就不该保留。
         */
        items: s.items.map((x, i) => ({
          id: x.id,
          type: x.type,
          typeLabel: this.itemTypeLabel(x.type),
          index: i + 1,
          total: s.items.length,
          preview: this.itemPreview(x),
          offsetX: 0,
          offsetY: 0
        }))
      },
      currentItem: it
        ? {
            id: it.id,
            type: it.type,
            leftContent: it.leftContent || '',
            centerContent: it.centerContent || '',
            rightContent: it.rightContent || '',
            index: s.items.indexOf(it) + 1,
            total: s.items.length,
            /*
             * 当前排版的说明语也由 JS 给：WXML 里写不下「哪种排版配哪句话」
             * 这种三选一的映射，写在模板里会变成一堆 wx:if。
             */
            typeHint: this.itemTypeHint(it.type),
            /*
             * 字段名与「用得上哪几栏」一起下发。
             *
             * 原来 WXML 里写死「左栏（学校 / 公司）/ 正文 / 右栏（时间）」，
             * 并只用一个 `type !== 'ONE'` 判断隐藏左右两栏 —— 那是数据模型的语言，
             * 不是用户的语言；现在标签随类型走，且每一栏只在当前排版确实渲染它时出现
             * （与 utils/paper.js 的 usesCol 同一口径，屏幕上看得见的才需要填）。
             */
            fields: this.itemFields(it)
          }
        : null
    })
  },

  /**
   * 当前条目要用哪几个输入框。
   *
   * 口径必须与 paper.js 的 usesCol() 一致（ONE 只用中栏、TWO 用左右、THREE 三栏都用），
   * 否则会出现「排版里没有这一栏，编辑面板却让人填」——填进去的内容屏幕上看不见，
   * 用户会以为自己的输入丢了。
   */
  itemFields (it) {
    const type = it.type || 'THREE'
    const all = [
      { field: 'leftContent', label: '标题', ph: '例如：华东理工大学' },
      { field: 'centerContent', label: '说明', ph: '例如：计算机科学与技术' },
      { field: 'rightContent', label: '时间', ph: '例如：2020.09 - 2024.06' }
    ]
    if (type === 'ONE') {
      // 整行排版只有一栏，它承担的是「一段文字」，标签不能叫「说明」
      return [{ field: 'centerContent', label: '内容', ph: '例如：负责用户增长，月活提升 30%' }]
    }
    if (type === 'TWO') {
      // 左 + 右：没有中间栏，左栏此时是「主体」而不是「标题」的附属
      return [all[0], all[2]]
    }
    return all
  },

  /** 条目列表里的一行摘要 */
  itemPreview (it) {
    const t = (it.leftContent || it.centerContent || it.rightContent || '').replace(/\s+/g, ' ').trim()
    return t.length > 24 ? t.slice(0, 24) + '…' : (t || '（空）')
  },

  /**
   * 条目类型的短标签。
   *
   * 数据模型里的 ONE / TWO / THREE 对应的 label 是「整行 / 左+右 / 左+中+右」，
   * 那是排版术语；列表行只有很窄的位置，这里改用图形式的说法，
   * 与编辑面板里的示意图选择保持一致。
   */
  itemTypeLabel (type) {
    if (type === 'ONE') return '一行'
    if (type === 'TWO') return '两栏'
    return '三栏'
  },

  /**
   * 当前排版的说明语。
   *
   * 原来这段说明是写死在 WXML 里的一句话，把三种排版一次讲完：
   * 「整行＝只有正文；左+右＝常用于…；左+中+右＝常用于…」。
   * 用户看着自己做的那一条，却要读完整段才知道自己这一条是什么，
   * 所以改成「只说当前这一条」。
   */
  itemTypeHint (type) {
    if (type === 'ONE') return '整行都用来写内容，适合自我评价、工作内容这类成段文字。'
    if (type === 'TWO') return '左边写主体、右边写时间，适合证书、奖项、语言成绩。'
    return '标题 + 说明 + 时间三栏，适合学校、公司、项目经历。'
  },
  /* ================= 缩放 ================= */

  onReady () {
    this.fit()
  },

  fit () {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const availW = info.windowWidth - 24
    const zoom = Math.max(0.2, Number((availW / L.A4_W).toFixed(3)))
    this.setData({ zoom })
  },

  onResize () {
    this.fit()
  },

  /* ================= 纸面点击 ================= */

  onPick (e) {
    const d = e.detail
    if (d.photoAdd) {
      this.setData({ panel: 'photo', menuOpen: false })
      this.onChoosePhoto()
      return
    }
    if (d.photo) {
      this.setData({ panel: 'photo', menuOpen: false })
      return
    }
    if (d.sec && d.item) {
      this.setData({ panel: 'item', sel: { sec: d.sec, item: d.item }, focusKey: '', menuOpen: false })
      this.syncSelection()
      return
    }
    if (d.sec) {
      this.setData({ panel: 'section', sel: { sec: d.sec, item: '' }, focusKey: '', menuOpen: false })
      this.syncSelection()
      return
    }
    if (d.base) {
      this.setData({ panel: 'base', focusKey: d.base, sel: { sec: '', item: '' }, menuOpen: false })
      return
    }
  },

  /* ================= 列表手势：点击编辑 / 长按拖动排序 / 左滑删除 =================
   *
   * 目录原来每个区块都挂一个「编辑」按钮，区块/条目面板里还有一排
   * 「上移 / 下移 / 删除」，按钮既占行高，也让「改个标题」这种高频动作
   * 变成两跳。现在三件事都收敛到行本身：
   *
   *   点击      → 打开对应编辑面板（替代「编辑」按钮）
   *   长按拖动  → 调整顺序（替代「上移 / 下移」）
   *   左滑      → 露出删除按钮（替代「删除」）
   *
   * 三类手势共用一个触摸状态机：touchstart 先按「可能是点击」处理，
   * 位移超过阈值就升级为左滑，按住不动超过长按时长就升级为拖动。
   * 之所以不用 bindtap 判点击，是因为拖动结束后小程序仍可能补一个 tap，
   * 会直接把行打开成编辑面板——自己判定 touchend 才能保证互斥。
   */

  /** 长按多久算拖动 */
  _LONG_PRESS_MS: 260,
  /** 超过这个位移就不再算点击（px，触摸坐标系） */
  _TAP_SLOP_PX: 8,
  /** 横向位移超过它且大于纵向位移才算左滑（px） */
  _SWIPE_SLOP_PX: 12,
  /** 条目行左滑宽度：只有一个「删除」（rpx，必须与 edit.wxss 的 .row-del 一致） */
  _DEL_W_RPX: 168,
  /** 目录行左滑宽度：两个动作「显示 / 隐藏 + 删除」（rpx，与 .dir-acts 一致） */
  _DIR_ACTS_W_RPX: 300,
  /**
   * 目录行左滑露出几个动作，条目行只露出删除。
   *
   * 「显示 / 隐藏」原来占着区块编辑面板里一整行的大按钮——那是个低频开关，
   * 却把「区块名称 → 条目列表」这条主线推下去了。现在它跟着删除一起放到
   * 目录行的左滑里：同一件事只在一个地方，且不占面板空间。
   */
  swipeWidthOf (list) {
    return list === 'item' ? this._DEL_W_RPX : this._DIR_ACTS_W_RPX
  },
  /** 拖动到面板上下边缘多少像素内触发自动滚动 */
  _EDGE_PX: 56,
  /** 自动滚动每帧步长（px） */
  _EDGE_STEP: 9,

  /**
   * px → rpx 的换算系数。
   * 触摸事件给的是 px，而行内 transform 用 rpx（要随屏宽缩放），
   * 因此所有写进 data 的位移都先过这里，阈值判定则留在 px 里做。
   */
  rpxOf (px) {
    if (!this._rpx) {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      this._rpx = 750 / (info.windowWidth || 375)
    }
    return px * this._rpx
  },

  /** 行触摸状态机；每次 touchstart 重建 */
  _rowTouch: null,

  onRowTouchStart (e) {
    const touch = e.touches && e.touches[0]
    if (!touch) return
    const ds = e.currentTarget.dataset
    const list = ds.list === 'item' ? 'item' : 'dir'
    const id = ds.id
    const row = this.findRow(list, id)
    if (!row) return

    this._rowTouch = {
      list,
      id,
      startIndex: Number(ds.index) || 0,
      dropIndex: Number(ds.index) || 0,
      startX: touch.clientX,
      startY: touch.clientY,
      startScroll: this.panelScroll || 0,
      openX: row.offsetX || 0,
      offsetX: row.offsetX || 0,
      /* 拖动行相对手指的纵向位移（rpx） */
      dragY: 0,
      mode: 'idle',
      rects: [],
      panel: null,
      timer: null
    }
    // 按住不动 → 升级为拖动；一旦位移或抬手都会清掉它
    this._rowTouch.timer = setTimeout(() => this.enterRowDrag(), this._LONG_PRESS_MS)
  },

  /** 在 dirRows / currentSection.items 里按 id 找行 */
  findRow (list, id) {
    if (list === 'item') {
      const items = (this.data.currentSection && this.data.currentSection.items) || []
      return items.find((x) => x.id === id)
    }
    return this.data.dirRows.find((x) => x.id === id)
  },

  /**
   * 升级为拖动：先把面板里所有行的几何量出来。
   *
   * 落点索引不靠「行高 × 常量」硬算，而是用实测矩形——长标题会折行、
   * 各区块的行高并不一致，只有真实几何才能算出用户以为的那个落点。
   */
  enterRowDrag () {
    const t = this._rowTouch
    if (!t || t.mode !== 'idle') return
    const sel = t.list === 'item' ? '.item-row' : '.dir-row'
    wx.createSelectorQuery()
      .in(this)
      .selectAll(sel)
      .boundingClientRect()
      .select('.panel-body')
      .boundingClientRect()
      .exec((res) => {
        const cur = this._rowTouch
        // 查询是异步的：期间可能已经抬手或被新的触摸取代，必须重新校验
        if (!cur || cur !== t || cur.mode !== 'idle') return
        cur.rects = (res && res[0]) || []
        cur.panel = (res && res[1]) || null
        cur.mode = 'drag'
        this.setData({ rowDrag: { list: cur.list, id: cur.id, index: cur.startIndex, active: true } })
        if (wx.vibrateShort) wx.vibrateShort({ type: 'light', fail: () => {} })
      })
  },

  onRowTouchMove (e) {
    const t = this._rowTouch
    const touch = e.touches && e.touches[0]
    if (!t || !touch) return

    const dxPx = touch.clientX - t.startX
    const dyPx = touch.clientY - t.startY

    if (t.mode === 'idle') {
      // 还在点击容差内：什么都不做，继续等长按
      if (Math.abs(dxPx) <= this._TAP_SLOP_PX && Math.abs(dyPx) <= this._TAP_SLOP_PX) return
      if (Math.abs(dxPx) > Math.abs(dyPx) && Math.abs(dxPx) > this._SWIPE_SLOP_PX) {
        this.clearRowTimer()
        t.mode = 'swipe'
      } else if (Math.abs(dyPx) > Math.abs(dxPx) && Math.abs(dyPx) > this._SWIPE_SLOP_PX) {
        // 纵向滑动：交还给面板自身的滚动，本行不再参与手势
        this.clearRowTimer()
        t.mode = 'scroll'
        return
      } else {
        return
      }
    }

    if (t.mode === 'swipe') {
      // 只允许向左滑出动作按钮；向右最多回到原位
      const max = this.swipeWidthOf(t.list)
      const next = Math.max(-max, Math.min(0, t.openX + this.rpxOf(dxPx)))
      t.offsetX = next
      this.markRowMoving(t.id)
      this.applyRowOffset(t.list, t.id, { offsetX: next })
      return
    }

    if (t.mode === 'drag') {
      this.maybeAutoScroll(touch.clientY)
      /*
       * 面板自动滚动后，行矩形会整体上移；拖动行要补回滚动量，
       * 否则手指停在原地而内容已经滚走，拖动的行会「掉队」。
       */
      const scrolledPx = (this.panelScroll || 0) - t.startScroll
      t.dragY = this.rpxOf(dyPx + scrolledPx)
      this.markRowMoving(t.id)
      this.applyRowOffset(t.list, t.id, { offsetY: t.dragY })

      const idx = this.dropIndexAt(touch.clientY, scrolledPx)
      if (idx !== t.dropIndex) {
        t.dropIndex = idx
        this.setData({ rowDrag: { list: t.list, id: t.id, index: idx, active: true } })
      }
    }
  },

  onRowTouchEnd () {
    const t = this._rowTouch
    if (!t) return
    this.clearRowTimer()
    this.stopAutoScroll()
    this._rowTouch = null

    if (t.mode === 'drag') {
      this.commitRowDrag(t)
      return
    }
    if (t.mode === 'swipe') {
      // 滑过动作区一半宽就吸附展开，否则回弹
      this.snapRowSwipe(t, t.offsetX <= -this.swipeWidthOf(t.list) / 2)
      return
    }
    if (t.mode === 'scroll') return

    // 没升级过任何手势 → 判定为点击
    if (t.openX !== 0) {
      // 删除按钮已展开时，点行内其他位置先收回，不直接进编辑
      this.snapRowSwipe(t, false)
      return
    }
    this.openRowEditor(t)
  },

  onRowTouchCancel () {
    const t = this._rowTouch
    if (!t) return
    this.clearRowTimer()
    this.stopAutoScroll()
    this._rowTouch = null
    // 系统打断（来电、切后台）：一律回到静止态，不能留下悬在半路的行
    if (t.mode === 'swipe') {
      this.snapRowSwipe(t, false)
    } else if (t.mode === 'drag') {
      this.setData({ rowDrag: { list: '', id: '', index: -1, active: false }, rowMoving: '' })
      this.applyRowOffset(t.list, t.id, { offsetX: 0, offsetY: 0 })
    }
  },

  clearRowTimer () {
    if (this._rowTouch && this._rowTouch.timer) {
      clearTimeout(this._rowTouch.timer)
      this._rowTouch.timer = null
    }
  },

  /** 进入跟手位移状态（关掉该行的 transform 过渡） */
  markRowMoving (id) {
    if (this.data.rowMoving !== id) this.setData({ rowMoving: id })
  },

  /** 点击行 → 打开编辑（目录进区块，条目进条目） */
  openRowEditor (t) {
    if (t.list === 'item') {
      this.setData({ panel: 'item', sel: { sec: this.data.sel.sec, item: t.id } })
      this.syncSelection()
      return
    }
    this.setData({ panel: 'section', sel: { sec: t.id, item: '' } })
    this.syncSelection()
  },

  /** 把某行的位移写回面板数据（行内 transform 直接读这两个字段） */
  applyRowOffset (list, id, patch) {
    if (list === 'item') {
      const items = (this.data.currentSection && this.data.currentSection.items) || []
      const i = items.findIndex((x) => x.id === id)
      if (i < 0) return
      const next = {}
      Object.keys(patch).forEach((k) => { next['currentSection.items[' + i + '].' + k] = patch[k] })
      this.setData(next)
      return
    }
    const i = this.data.dirRows.findIndex((x) => x.id === id)
    if (i < 0) return
    const next = {}
    Object.keys(patch).forEach((k) => { next['dirRows[' + i + '].' + k] = patch[k] })
    this.setData(next)
  },

  snapRowSwipe (t, open) {
    // 先解除「跟手」状态让过渡恢复，位移归零/吸到动作宽度才会有回弹动画
    this.setData({ rowMoving: '' })
    this.applyRowOffset(t.list, t.id, { offsetX: open ? -this.swipeWidthOf(t.list) : 0 })
  },

  /**
   * 手指位置落在第几行。
   * rects 是拖动开始那一刻量的，面板滚动过就整体减去滚动量。
   */
  dropIndexAt (clientY, scrolled) {
    const t = this._rowTouch
    if (!t || !t.rects.length) return t ? t.dropIndex : 0
    let idx = t.rects.length - 1
    for (let i = 0; i < t.rects.length; i++) {
      const r = t.rects[i]
      if (clientY < r.top - scrolled + r.height / 2) {
        idx = i
        break
      }
    }
    return Math.max(0, Math.min(t.rects.length - 1, idx))
  },

  /** 拖动过程中手指贴近面板上下缘时自动滚动，否则长列表根本拖不到视野外 */
  maybeAutoScroll (clientY) {
    const t = this._rowTouch
    if (!t || !t.panel) return
    const top = t.panel.top
    const bottom = t.panel.bottom
    let dir = 0
    if (clientY < top + this._EDGE_PX) dir = -1
    else if (clientY > bottom - this._EDGE_PX) dir = 1

    if (!dir) {
      this.stopAutoScroll()
      return
    }
    if (this._scrollTimer) return
    this._scrollTimer = setInterval(() => this.autoScrollStep(dir), 16)
  },

  autoScrollStep (dir) {
    const t = this._rowTouch
    if (!t || t.mode !== 'drag') return this.stopAutoScroll()
    const next = Math.max(0, (this.panelScroll || 0) + dir * this._EDGE_STEP)
    if (next === this.panelScroll) return
    this.panelScroll = next
    // 标记这次位置变化来自程序而非手势，onPanelScroll 据此放行
    this._autoScrolling = true
    this.setData({ panelScrollTop: next })
  },

  stopAutoScroll () {
    if (this._scrollTimer) {
      clearInterval(this._scrollTimer)
      this._scrollTimer = null
    }
  },

  /** 面板滚动：记录真实位置，自动滚动与落点换算都要用它 */
  onPanelScroll (e) {
    this.panelScroll = e.detail.scrollTop
  },

  /** 拖动松手：真正写回顺序 */
  commitRowDrag (t) {
    // 解除跟手状态并清掉位移：行会从手指位置弹回布局位置
    this.setData({ rowDrag: { list: '', id: '', index: -1, active: false }, rowMoving: '' })
    this.applyRowOffset(t.list, t.id, { offsetX: 0, offsetY: 0 })
    // 落点没变就不要写库：否则白推一条撤销记录，用户「长按又放下」也算一步
    if (t.dropIndex === t.startIndex) return
    const moved = t.list === 'item'
      ? store.moveItemTo(this.data.sel.sec, t.id, t.dropIndex)
      : store.moveSectionTo(t.id, t.dropIndex)
    if (moved) toast('顺序已调整')
  },

  /** 左滑露出的删除按钮 */
  onRowDelete (e) {
    const ds = e.currentTarget.dataset
    const list = ds.list === 'item' ? 'item' : 'dir'
    const id = ds.id

    if (list === 'item') {
      const secId = this.data.sel.sec
      const s = store.state.resume.sections.find((x) => x.id === secId)
      const it = s && s.items.find((x) => x.id === id)
      if (!it) return
      wx.showModal({
        title: '删除条目？',
        content: this.itemPreview(it),
        confirmText: '删除',
        confirmColor: '#b3261e',
        success: (res) => {
          if (!res.confirm) return
          store.removeItem(secId, id)
          this.syncSelection()
        }
      })
      return
    }

    const s = store.state.resume.sections.find((x) => x.id === id)
    if (!s) return
    wx.showModal({
      title: '删除区块？',
      content: '「' + s.title + '」及其 ' + s.items.length + ' 个条目都会被删除。',
      confirmText: '删除',
      confirmColor: '#b3261e',
      success: (res) => {
        if (!res.confirm) return
        // 删掉的正是当前正在编辑的区块时，退回目录，避免面板停留在空选择上
        const patch = { sel: { sec: '', item: '' } }
        if (this.data.sel.sec === id) patch.panel = 'sections'
        this.setData(patch)
        store.removeSection(id)
        this.syncSelection()
      }
    })
  },

  /**
   * 左滑露出的「显示 / 隐藏」。
   *
   * 这个开关原先在区块编辑面板里占一整行大按钮，把「区块名称 → 条目列表」
   * 这条主线挤了下去；现在并到目录行的左滑动作里，与删除并列，
   * 于是「区块级别」的两个操作都落在目录这一处。
   */
  onRowToggleVisible (e) {
    const ds = e.currentTarget.dataset
    const id = ds.id
    const s = store.state.resume.sections.find((x) => x.id === id)
    if (!s) return
    const wasHidden = s.visible === false
    store.toggleSectionVisible(id)
    // 行要收回原位，否则「已隐藏」的标记和位移会一起留在屏幕上
    this.setData({ rowMoving: '' })
    this.applyRowOffset('dir', id, { offsetX: 0 })
    toast(wasHidden ? '已设为显示' : '已隐藏，导出时不出现')
  },

  /* ================= 面板切换 ================= */

  onPanel (e) {
    const panel = e.currentTarget.dataset.panel
    const next = this.data.panel === panel ? PANEL_NONE : panel
    // 打开任何面板都收起浮层菜单，避免两层遮罩叠在一起
    this.abortRowDrag()
    this.setData({ panel: next, menuOpen: false })
    this.syncSelection()
  },

  closePanel () {
    this.abortRowDrag()
    this.setData({ panel: PANEL_NONE })
  },

  /**
   * 丢弃进行中的拖动并复位状态。
   *
   * scroll-y 绑定在 rowDrag.active 上（见 edit.wxml），这是「拖动时列表不跟着
   * 下滑」的关键；反过来说，active 一旦残留为 true，面板列表就再也滚不动。
   * 正常抬手路径（onRowTouchEnd / onRowTouchCancel）都会清掉它，但面板切换会让
   * 列表整体重建，旧行的触摸不会再回来，因此必须在这里兜一道。
   */
  abortRowDrag () {
    if (!this.data.rowDrag.active && !this._rowTouch) return
    const t = this._rowTouch
    this.clearRowTimer()
    this.stopAutoScroll()
    this._rowTouch = null
    this.setData({ rowDrag: { list: '', id: '', index: -1, active: false }, rowMoving: '' })
    if (t && t.mode === 'drag') this.applyRowOffset(t.list, t.id, { offsetX: 0, offsetY: 0 })
  },

  /* ================= 文本编辑 ================= */

  /**
   * 输入框目标解析：把 data-* 标记翻译成「写哪里」。
   * scope = base | section | item
   */
  resolveTarget (ds) {
    if (ds.scope === 'base') return { kind: 'base', key: ds.key }
    if (ds.scope === 'item') return { kind: 'item', sec: ds.sec, item: ds.item, field: ds.field }
    if (ds.scope === 'section') return { kind: 'section', sec: ds.sec }
    if (ds.scope === 'resume') return { kind: 'resume' }
    return null
  },

  applyValue (target, value) {
    if (!target) return
    if (target.kind === 'base') store.setBaseInfo(target.key, value)
    else if (target.kind === 'item') store.setItemField(target.sec, target.item, target.field, value)
    else if (target.kind === 'section') store.setSectionTitle(target.sec, value)
    else if (target.kind === 'resume') store.setResumeName(value)
  },

  readValue (target) {
    const r = store.state.resume
    if (target.kind === 'base') return r.baseInfo[target.key] || ''
    if (target.kind === 'resume') return r.resumeName || ''
    if (target.kind === 'section') {
      const s = r.sections.find((x) => x.id === target.sec)
      return s ? s.title : ''
    }
    const s = r.sections.find((x) => x.id === target.sec)
    const it = s && s.items.find((x) => x.id === target.item)
    return it ? it[target.field] || '' : ''
  },

  onInput (e) {
    const target = this.resolveTarget(e.currentTarget.dataset)
    this.pending = { target, value: e.detail.value }
    if (!this.data.dirty) this.setData({ dirty: true })
    // 输入期间不写回 store：避免重建 VM 把输入框内容与光标重置
  },

  onBlur (e) {
    const target = this.resolveTarget(e.currentTarget.dataset)
    const value = e.detail.value
    this.pending = null
    const before = this.readValue(target)
    if (before === value) return
    store.typingIfEditing(true)
    this.applyValue(target, value)
  },

  /** 把还在输入中的值落定（切面板 / 页面隐藏时调用） */
  commitPending () {
    if (!this.pending) return
    const { target, value } = this.pending
    this.pending = null
    if (this.readValue(target) === value) return
    this.applyValue(target, value)
  },

  onResumeName () {
    this.closeMenu()
    const r = store.state.resume
    wx.showModal({
      title: '简历名称',
      editable: true,
      placeholderText: '例如：张三_产品经理',
      content: r.resumeName || '',
      success: (res) => {
        if (!res.confirm) return
        const name = (res.content || '').trim()
        if (!name) return
        store.setResumeName(name)
        store.save()
      }
    })
  },

  /* ================= 撤销 / 重做 =================
   * 保存不需要手动入口：startTimers 每 4 秒落一次盘，onHide / onUnload
   * 离开页面时也会补存，状态栏实时显示「已保存」，因此不提供「立即保存」按钮。 */

  onUndo () {
    this.closeMenu()
    store.commitTextHistory()
    if (store.undo()) toast('已撤销')
    else toast('没有可撤销的操作')
  },

  onRedo () {
    this.closeMenu()
    store.commitTextHistory()
    if (store.redo()) toast('已重做')
    else toast('没有可重做的操作')
  },

  /* ================= 区块与条目 ================= */

  onAddSection () {
    wx.showModal({
      title: '新增区块',
      editable: true,
      placeholderText: '区块名称，例如「校园经历」',
      success: (res) => {
        if (!res.confirm) return
        const title = (res.content || '').trim() || '自定义区块'
        store.addSection(title, 'THREE')
        const list = store.state.resume.sections
        const s = list[list.length - 1]
        this.setData({ panel: 'section', sel: { sec: s.id, item: '' } })
        this.syncSelection()
      }
    })
  },

  /**
   * 新增条目。
   *
   * 入口只剩一个（原先三个按钮各对应一种排版），因此没有 dataset.type 可用：
   * 新区块用 THREE（最常用、也最好改成别的），并直接打开条目面板——
   * 排版选择就在那里，用户看到示意图再决定，比在按钮上先猜一遍更省事。
   */
  onAddItem (e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const type = ds.type || 'THREE'
    const s = this.data.currentSection
    if (!s) return
    store.addItem(s.id, type)
    const sec = store.state.resume.sections.find((x) => x.id === s.id)
    const it = sec.items[sec.items.length - 1]
    this.setData({ panel: 'item', sel: { sec: s.id, item: it.id } })
    this.syncSelection()
  },

  onSetItemType (e) {
    const type = e.currentTarget.dataset.type
    const { sec, item } = this.data.sel
    if (!sec || !item) return
    store.setItemType(sec, item, type)
  },

  /* ================= 基本信息 ================= */

  onToggleField (e) {
    const key = e.currentTarget.dataset.key
    this.commitPending()
    store.toggleField(key)
  },

  /* ================= 样式面板 ================= */

  onTemplate (e) {
    const id = e.currentTarget.dataset.id
    this.commitPending()
    store.applyTemplate(id, { keepContent: true })
    toast('已应用模板')
  },

  onColor (e) {
    const id = e.currentTarget.dataset.id
    this.commitPending()
    store.applyColorPreset(id)
  },

  onFont (e) {
    const f = model.FONT_FAMILIES[Number(e.detail.value)]
    if (f) store.setStyle('fontFamily', f.id)
  },

  onHeading (e) {
    const h = model.HEADING_THEMES[Number(e.detail.value)]
    if (h) store.setStyle('headingTheme', h.id)
  },

  onBorder (e) {
    const b = model.BORDER_THEMES[Number(e.detail.value)]
    if (b) store.setStyle('borderTheme', b.id)
  },

  onLayout (e) {
    const l = model.PAGE_LAYOUTS[Number(e.detail.value)]
    if (l) store.setStyle('pageLayout', l.id)
  },

  onToggleCenter () {
    store.setStyle('headingCenter', !store.state.resume.headingCenter)
  },

  onToggleAccent () {
    store.setStyle('accentBlock', !store.state.resume.accentBlock)
  },

  onSize (e) {
    const key = e.currentTarget.dataset.key
    const value = Number(e.detail.value)
    store.setStyle(key, value)
  },

  /**
   * 自由调色：小程序没有取色器组件，也没有颜色输入框，
   * 因此用 showModal 的可编辑输入接收 #RRGGBB，并做一次格式校验。
   * 对应参考站 7 组预设之外的「自定义颜色」能力。
   */
  onColorPick () {
    this.commitPending()
    const cur = store.state.resume.headingColor || '#1f4e79'
    wx.showModal({
      title: '自定义主题色',
      editable: true,
      placeholderText: '例如 #1f4e79 或 1f4e79',
      content: cur,
      success: (res) => {
        if (!res.confirm) return
        const hex = normalizeHex(res.content)
        if (!hex) {
          toast('请输入 #RRGGBB 格式的颜色')
          return
        }
        store.setStyle('headingColor', hex)
        toast('主题色已更新')
      }
    })
  },

  /* ================= 照片 ================= */

  onChoosePhoto () {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file) return
        if (file.size > 6 * 1024 * 1024) {
          toast('图片请小于 6MB')
          return
        }
        // 小程序给的是临时路径，生命周期只到本次会话；直接存进简历虽能渲染，
        // 但重启后会失效，因此交给 persistPhoto() 复制到用户目录长期保存。
        this.persistPhoto(file.tempFilePath)
      },
      fail: () => {}
    })
  },

  persistPhoto (tempPath) {
    try {
      const fs = wx.getFileSystemManager()
      const ext = (tempPath.match(/\.(\w+)$/) || [null, 'jpg'])[1]
      const dir = wx.env.USER_DATA_PATH + '/photos'
      try {
        fs.mkdirSync(dir, true)
      } catch (e) {}
      const dest = dir + '/' + Date.now() + '.' + ext
      fs.copyFileSync(tempPath, dest)
      const old = store.state.resume.personalPhoto
      store.setPhotoField('personalPhoto', dest)
      if (!store.state.resume.personalPhotoHeight) {
        store.setPhotoField('personalPhotoWidth', 90)
        store.setPhotoField('personalPhotoHeight', 120)
      }
      store.save()
      // 新照片落定后再回收旧文件，避免中途失败导致照片丢失
      this.recyclePhoto(old, dest)
      toast('照片已添加，可调整外形与位置')
    } catch (err) {
      console.error('[photo] persist failed', err)
      // 复制失败时退回临时路径，本次会话内仍可用
      store.setPhotoField('personalPhoto', tempPath)
      toast('照片已添加（未持久化）')
    }
  },

  /**
   * 回收不再被任何草稿引用的照片文件。
   *
   * persistPhoto() 每次选图都会往 USER_DATA_PATH/photos 复制一份，
   * 而此前没有任何删除逻辑：反复换照片会持续占用用户目录配额，
   * 最终把 wx.setStorageSync 挤到写失败（进而触发「看起来已保存、
   * 其实没落盘」那类问题）。这里只删「确认没人引用」的文件。
   *
   * 判定依据：既不是当前照片，也不被草稿列表里任一份简历引用。
   * 只处理 /photos/ 目录下的文件，用户相册里的原图永不触碰。
   */
  recyclePhoto (oldPath, keepPath) {
    try {
      const p = String(oldPath || '')
      if (!p || p === keepPath) return
      if (p.indexOf('/photos/') < 0) return
      if (p.indexOf('asset:') === 0 || p.indexOf('data:') === 0) return
      // 草稿列表里还有人引用就保留
      const drafts = store.state.drafts || []
      const used = drafts.some((d) => d && d.personalPhoto === p)
      if (used) return
      const fs = wx.getFileSystemManager()
      if (typeof fs.unlink !== 'function') return
      fs.unlink({ filePath: p, fail: () => {} })
    } catch (e) {
      // 清理失败不影响主流程
    }
  },

  onPreset (e) {
    const url = e.currentTarget.dataset.url
    store.setPhotoField('personalPhoto', url)
    store.save()
  },

  onPhotoShape (e) {
    store.setPhotoField('personalPhotoShape', e.currentTarget.dataset.id)
  },

  onPhotoBorder (e) {
    store.setPhotoField('personalPhotoBorder', e.currentTarget.dataset.id)
  },

  onPhotoRatio (e) {
    const ratio = Number(e.currentTarget.dataset.ratio)
    if (!ratio) return
    const w = store.state.resume.personalPhotoWidth || 90
    store.setPhotoField('personalPhotoHeight', Math.round(w / ratio))
  },

  onPhotoSize (e) {
    const key = e.currentTarget.dataset.key
    const value = Number(e.detail.value)
    if (key !== 'personalPhotoWidth') {
      store.setPhotoField(key, value)
      return
    }
    /*
     * 拖宽度时保持当前宽高比，同步改高度。
     *
     * 这里必须先取「旧宽度」算比例再写值。原实现先 setPhotoField(宽度)，
     * 随后用 r.personalPhotoWidth（已经是新值）/ r.personalPhotoHeight 求比例，
     * 再算 value / ratio —— 恒等于原高度，整段联动是 no-op，
     * 还白白多触发一次 store 广播。
     */
    const r = store.state.resume
    const oldW = Number(r.personalPhotoWidth) || 0
    const oldH = Number(r.personalPhotoHeight) || 0
    store.setPhotoField(key, value)
    if (oldW > 0 && oldH > 0) {
      // 与滑杆的 min/max 保持一致（高度 60~240），否则滑杆显示的与实际不符
      const nextH = Math.min(240, Math.max(60, Math.round((value * oldH) / oldW)))
      if (nextH !== oldH) store.setPhotoField('personalPhotoHeight', nextH)
    }
  },

  onPhotoPosition (e) {
    const key = e.currentTarget.dataset.key
    store.setPhotoField(key, Number(e.detail.value))
  },

  onRemovePhoto () {
    const old = store.state.resume.personalPhoto
    store.setPhotoField('personalPhoto', '')
    store.save()
    // 移除后回收文件，避免用户目录里堆积孤儿照片
    this.recyclePhoto(old, '')
    toast('已移除照片')
  },

  /* ================= 智能一页 ================= */

  /**
   * 智能压缩到一页：与参考站同一个算法（utils/onePage.js 原样移植），
   * 只是「测量」换成了 utils/layout.js 的纯 JS 计算，因此二分试算
   * 可以在同一帧内跑完，不需要每次等一次渲染。
   */
  onFitOnePage () {
    this.closeMenu()
    this.commitPending()
    const resume = store.state.resume
    wx.showLoading({ title: '正在排版…', mask: true })
    try {
      const start = onePage.readFitParams(resume)
      const res = onePage.fitOnePageSmart(start, L.measureHeight(resume), L.A4_H)
      wx.hideLoading()

      if (res.mode === 'none') {
        toast(res.alreadyFits ? '已经刚好一页' : '内容已是一页')
        return
      }
      if (!res.changes.length) {
        toast('内容确实太少，排版参数已到上限，无法撑满一页')
        return
      }
      // 一次性写入全部参数，只触发一次重排
      const patch = {}
      for (const c of res.changes) patch[c.key] = c.to
      this.applyFit(patch)
      store.save()
      const desc = onePage.describeChanges(res.changes)
      /*
       * 提示语必须与「压完之后的真实页数」一致。
       *
       * mode 只说明算法走了哪条分支：'shrink' = 走了压缩、'tight' = 压到
       * 下限仍然放不下。原来的三元判断把 'tight' 也归到「已铺满一页」，
       * 于是「内容 2 页、参数已压到底、结果还是 2 页」时会告诉用户
       * 「已铺满一页」——这与屏幕上明明白白写着的「共 2 页」直接矛盾。
       */
      const after = L.paginateResume(store.state.resume).pages
      const done = after <= 1
      const title = done
        ? (res.mode === 'shrink' ? '已压缩到一页' : '已铺满一页')
        : '已压到最紧，但仍放不下'
      wx.showModal({
        title,
        content: (done ? '' : '内容仍为 ' + after + ' 页。可删减条目或换用紧凑模板。\n\n') + (desc || '未改动参数'),
        showCancel: false,
        confirmText: '知道了'
      })
    } catch (err) {
      wx.hideLoading()
      console.error('[fit] failed', err)
      toast('排版失败：' + (err && err.message ? err.message : '未知错误'))
    }
  },

  /** 批量写入排版参数（只广播一次） */
  applyFit (patch) {
    const r = store.state.resume
    Object.keys(patch).forEach((k) => {
      r[k] = patch[k]
    })
    store.snapshot()
    store.save()
  },

  /* ================= 导出与菜单 ================= */

  /**
   * 导出 PDF：逐页 A4 渲染 → JPEG → utils/pdf.js 组装 → 写用户目录 →
   * wx.openDocument 预览（可「用其他应用打开」转发给电脑 / 打印）。
   *
   * 与 PNG 导出共享同一个离屏画布：canvas 只有一个，导出期间以
   * exporting 标志互斥，菜单里的三行导出也按它降级置灰。
   */
  onExportPdf () {
    if (this.data.exporting) return Promise.resolve(false)
    this.closeMenu()
    this.commitPending()
    this.setData({ exporting: true })
    // 把 promise 返回出去：调用方（含回归脚本）await 到的是「导出真正结束」
    return runExportTask('正在生成 PDF…', async () => {
      const out = await exportPdfFromCanvas(() => this.getCanvas(), store.state.resume, exportBaseName(store.state.resume))
      wx.hideLoading()
      await openExportedFile(out.filePath, 'pdf')
      toast('PDF 已导出（' + out.pages + ' 页）')
    }).finally(() => this.setData({ exporting: false }))
  },

  /**
   * 导出 Word(.doc)：按当前排版参数生成 Word HTML 写盘 → openDocument。
   * Word / WPS 打开后可继续编辑、另存为 .docx。
   */
  onExportWord () {
    if (this.data.exporting) return Promise.resolve(false)
    this.closeMenu()
    this.commitPending()
    this.setData({ exporting: true })
    return runExportTask('正在生成 Word…', async () => {
      const out = await buildWordFile(store.state.resume, exportBaseName(store.state.resume))
      wx.hideLoading()
      await openExportedFile(out.filePath, 'doc')
      toast('Word 已导出，可用 WPS / Word 编辑')
    }).finally(() => this.setData({ exporting: false }))
  },

  /** 导出 PNG 长图（原导航栏「导出」按钮，现收进「更多」菜单） */
  onExportImage () {
    if (this.data.exporting) return Promise.resolve(false)
    this.closeMenu()
    this.commitPending()
    this.setData({ exporting: true })
    return runExportTask('正在生成图片…', async () => {
      const { canvas, ctx } = await this.getCanvas()
      const out = await renderToContext(ctx, canvas, store.state.resume, { scale: 2 })
      const filePath = await this.toFile(canvas)
      wx.hideLoading()
      await saveImageToAlbum(filePath)
      // 长简历会被画布上限强制降到 1 倍：如实告知，避免用户以为是「导出变糊了」
      toast(out && out.limited ? '长图已保存（内容较长，已按画布上限降为 1 倍清晰度）' : '长图已保存到相册')
    }).finally(() => this.setData({ exporting: false }))
  },

  /**
   * 顶部浮层菜单：开在「导航栏 + 工具栏」下方，一屏可见、点遮罩即关。
   * 放在顶部而不是底部面板，是因为菜单属于全局操作：底部会与编辑输入区
   * 抢空间，长列表还要再滚一次才能看到后面的项。
   */
  onMenu () {
    if (this.data.menuOpen) return this.closeMenu()
    this.commitPending()
    this.setData({ menuOpen: true, menuTop: this.menuTopPx() })
  },

  closeMenu () {
    if (!this.data.menuOpen) return
    this.setData({ menuOpen: false, menuPage: '' })
  },

  /** 进入导出二级页；从主页跳转，不重开遮罩 */
  onOpenExportMenu () {
    this.setData({ menuPage: 'export' })
  },

  /** 二级页返回菜单主页 */
  onMenuBack () {
    this.setData({ menuPage: '' })
  },

  /** 浮层顶边 = 状态栏 + 导航栏 + 工具栏，再留 8px 间隙。
   *  工具栏高度必须与 edit.wxss 的 .tool 一致（104rpx）；写 88 会让浮层
   *  压在工具栏上、盖住「目录」这些入口。 */
  menuTopPx () {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const rpx = (info.windowWidth || 375) / 750
    return Math.round(this.data.statusBarHeight + this.data.navBarHeight + 104 * rpx + 8)
  },

  onGoTemplates () {
    this.closeMenu()
    wx.navigateTo({ url: '/pages/templates/templates' })
  },

  onGoHome () {
    this.closeMenu()
    this.commitPending()
    if (store.state.dirty) store.save(true)
    wx.reLaunch({ url: '/pages/index/index' })
  },

  onGoPreview () {
    this.closeMenu()
    this.commitPending()
    if (store.state.dirty) store.save(true)
    wx.navigateTo({ url: '/pages/preview/preview' })
  },

  onCopyJSON () {
    this.closeMenu()
    this.commitPending()
    copyText(store.exportJSON(), 'JSON 已复制到剪贴板')
  },

  getCanvas () {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .in(this)
        .select('#exportCanvas')
        .fields({ node: true, size: true })
        .exec((res) => {
          const item = res && res[0]
          if (!item || !item.node) return reject(new Error('画布未就绪，请稍后重试'))
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
  }
});
