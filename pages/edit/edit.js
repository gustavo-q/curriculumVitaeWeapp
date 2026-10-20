/**
 * 编辑器 · 表单优先（手机端重做 v1）
 *
 * 旧版靠点 A4 纸面改字：375px 屏上纸张缩到约 45%，正文只有 5px，误触很多。
 * 现在默认是「填写」：区块卡片纵向排列、大输入框；纸面预览移到「预览」页。
 *
 *   基本信息卡   每个字段一行 + 显示开关；键盘「下一项」跳到下一个输入框
 *   照片卡       内置头像 / 相册或拍照 + 微信原生裁剪（一寸 / 二寸 / 方图）
 *   区块卡       可改标题；条目摘要点进条目子页（pages/entry）；长按条目拖动排序
 *                标题栏左滑 → 显示/隐藏 · 删除；长按标题栏 → 进入「调整顺序」模式
 *   底部固定栏   填写 / 样式 / 预览 / 导出
 *   更多         撤销 / 重做 / 切换模板 / JD 匹配 / 重命名
 *
 * 文本写回策略：输入期间只记 pending，失焦 / 键盘确认时才写进 store 并记一个
 * 历史点——每次 setData 回写同一个值都可能让光标跳到末尾，这是小程序表单的老坑。
 * 自动保存每 4 秒落盘一次（onHide / onUnload 补存），没有保存按钮。
 */
const store = require('../../utils/store.js')
const model = require('../../utils/model.js')
const { resolvePhoto, isBuiltinPhoto } = require('../../utils/avatars.js')
const { toast } = require('../../utils/export.js')

const app = getApp()

/** 基本信息字段的输入方式（键盘类型 / 选择器） */
const FIELD_KIND = {
  phone: 'number',
  age: 'number',
  email: 'email',
  birthday: 'month',
  gender: 'gender'
}
const FIELD_PH = {
  name: '你的姓名',
  age: '例如 25',
  education: '例如 本科',
  phone: '11 位手机号',
  email: 'name@example.com',
  jobIntention: '例如 产品经理',
  city: '例如 上海',
  experience: '例如 3 年',
  politics: '例如 共青团员',
  ethnicity: '例如 汉族',
  hometown: '例如 浙江杭州'
}
const GENDERS = ['男', '女', '不填']

/** 添加区块的预设标题（模型里写作建议覆盖的区块 + 常见补充） */
const SECTION_PRESETS = ['工作经历', '项目经历', '实习经历', '校园经历', '荣誉奖项', '技能证书', '自我评价', '兴趣爱好', '教育背景']

/**
 * 证件照裁剪比例。wx.cropImage 只接受 16:9 / 9:16 / 4:3 / 3:4 / 5:4 / 4:5 / 1:1，
 * 二寸 5:7 不在其中：裁剪框用最接近的 3:4，纸面照片框仍按 5:7 显示（aspectFill 两侧各裁约 2.5%）。
 */
const CROP_RATIOS = [
  { id: 'one', label: '一寸 3:4', scale: '3:4', w: 3, h: 4 },
  { id: 'two', label: '二寸 5:7', scale: '3:4', w: 5, h: 7 },
  { id: 'square', label: '方图 1:1', scale: '1:1', w: 1, h: 1 }
]

/** 区块标题栏左滑宽度（rpx），与 edit.wxss 的 .head-acts 一致 */
const HEAD_ACTS_W = 300

function itemSummary (it) {
  const pick = [it.leftContent, it.centerContent, it.rightContent].map((x) => String(x || '').replace(/\s+/g, ' ').trim())
  const main = pick.find((x) => !!x) || ''
  const sub = it.type !== 'ONE' && pick[2] && pick[2] !== main ? pick[2] : ''
  return {
    main: main ? (main.length > 32 ? main.slice(0, 32) + '…' : main) : '',
    sub
  }
}

function typeLabel (type) {
  if (type === 'ONE') return '一行'
  if (type === 'TWO') return '两栏'
  return '三栏'
}

/** 'YYYY.MM' / '1999-01' / '1999年1月' → 'YYYY-MM'（picker 用）；解析不了返回 '' */
function toPickerMonth (text) {
  const m = String(text || '').match(/(\d{4})\D+(\d{1,2})/)
  if (!m) return ''
  return m[1] + '-' + ('0' + m[2]).slice(-2)
}

function fromPickerMonth (v) {
  const m = String(v || '').match(/^(\d{4})-(\d{1,2})/)
  return m ? m[1] + '.' + ('0' + m[2]).slice(-2) : ''
}

function windowWidth () {
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    return info.windowWidth || 375
  } catch (e) {
    return 375
  }
}

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,

    title: '未命名简历',
    titleHitStyle: '',
    dirty: false,
    canUndo: false,
    canRedo: false,

    /* 基本信息 */
    baseRows: [],
    focusKey: '',
    genders: GENDERS,

    /* 照片 */
    photo: { src: '', shape: 'rect', border: 'none', builtin: false, w: 90, h: 112 },
    photoPresets: model.PHOTO_PRESETS,
    photoShapes: model.PHOTO_SHAPES,
    photoBorders: model.PHOTO_BORDERS,
    cropRatios: CROP_RATIOS,
    cropRatio: 'one',

    /* 区块 */
    sections: [],
    sortMode: false,
    sortRows: [],
    drag: { list: '', id: '', secId: '', index: -1 },
    dropIndex: -1,
    movingId: '',
    scrollEnabled: true,
    scrollInto: '',
    flashId: '',

    /* 撤销条 */
    undoBar: { show: false, label: '' },

    /* 从其他简历复制 */
    copySheet: { show: false, targetSecId: '', targetTitle: '', drafts: [], count: 0 }
  },

  /* ================= 生命周期 ================= */

  onLoad (query) {
    const q = query || {}
    const g = app.globalData || {}
    store.init()
    if (q.id && q.id !== store.state.resume.id) {
      if (store.state.dirty) store.save(true)
      store.open(q.id)
    }
    // 模板库带模板进入：应用模板但保留内容（兼容旧入口）
    const tpl = q.template || g.pendingTemplateId
    if (tpl) {
      g.pendingTemplateId = ''
      store.applyTemplate(tpl, { keepContent: true })
    }
    this.setData({
      statusBarHeight: g.statusBarHeight || 20,
      navBarHeight: g.navBarHeight || 44,
      titleHitStyle: this.titleHitStyle(g)
    })
    this.unsubscribe = store.subscribe(() => this.refresh())
    this.refresh()
    this.startTimers()
    if (q.focus) {
      // 预览页 navigateTo 时会同时写 pendingFocus：这里已按 query 定位，清掉免得 onShow 再滚一次
      g.pendingFocus = ''
      this.focusCard(decodeURIComponent(q.focus))
    }
  },

  onShow () {
    this._hidden = false
    const g = app.globalData || {}
    if (g.pendingTemplateId) {
      const tpl = g.pendingTemplateId
      g.pendingTemplateId = ''
      store.applyTemplate(tpl, { keepContent: true })
    }
    this.refresh()
    // 预览页 / JD 匹配点某块后 navigateBack 回来：经 globalData.pendingFocus 传定位目标
    // （editFocus 为早期约定的别名，一并兼容）
    const f = g.pendingFocus || g.editFocus
    if (f) {
      g.pendingFocus = ''
      g.editFocus = ''
      this.focusCard(f)
    }
    // 条目子页删除后返回：显示「已删除 · 撤销」
    const hint = store.takeUndoHint(6000)
    if (hint) this.showUndo(hint.label)
  },

  onHide () {
    this.commitPending()
    if (store.state.dirty) store.save(true)
    // 条目子页压在上面时不必跟着每次写入重建，onShow 会整体刷新
    this._hidden = true
  },

  onUnload () {
    this.stopTimers()
    this.abortTouch()
    this.commitPending()
    if (this.unsubscribe) this.unsubscribe()
    if (store.state.dirty) store.save(true)
  },

  startTimers () {
    this.saveTimer = setInterval(() => {
      // 输入中的内容静默落定（不触发页面重建，光标不跳）
      this.commitPending({ quiet: true })
      store.commitTextHistory()
      if (store.state.dirty) store.save(true)
      if (this.data.dirty !== store.state.dirty) this.setData({ dirty: store.state.dirty })
    }, 4000)
  },

  stopTimers () {
    if (this.saveTimer) clearInterval(this.saveTimer)
    this.saveTimer = null
    if (this.undoTimer) clearTimeout(this.undoTimer)
    this.undoTimer = null
  },

  /**
   * 标题改名热区：横向只盖住标题，右侧必须让开胶囊 + 「更多」按钮，否则会吃掉「更多」的点击。
   * 胶囊让位与 nav-bar 的 fitCapsule 同口径，「更多」按钮约 64px 宽。
   */
  titleHitStyle (g) {
    const w = windowWidth()
    let capsule = 12
    const mb = g && g.menuButton
    if (mb && mb.left) capsule = Math.max(12, Math.round(w - mb.left) + 8)
    const right = capsule + 72
    const left = Math.round(w * 160 / 750)
    if (w - right - left < 60) return 'display:none'
    return 'left:' + left + 'px;right:' + right + 'px'
  },

  /* ================= 渲染 ================= */

  refresh () {
    if (this._mute || this._hidden) return
    // 拖动进行中不重建，避免行数据与手势错位
    if (this._touch && this._touch.mode === 'drag') return
    const r = store.state.resume
    const on = r.baseFields || []
    const baseRows = model.BASE_FIELDS.map((f) => {
      const kind = FIELD_KIND[f.key] || 'text'
      const value = r.baseInfo[f.key] || ''
      return {
        key: f.key,
        label: f.label,
        on: on.indexOf(f.key) >= 0,
        kind,
        value,
        ph: FIELD_PH[f.key] || '未填写',
        pickerValue: kind === 'month' ? toPickerMonth(value) : '',
        genderIndex: kind === 'gender' ? Math.max(0, GENDERS.indexOf(value)) : 0
      }
    })
    const sections = r.sections.map((s) => ({
      id: s.id,
      title: s.title,
      visible: s.visible !== false,
      offsetX: 0,
      items: s.items.map((it) => {
        const sum = itemSummary(it)
        return {
          id: it.id,
          main: sum.main,
          sub: sum.sub,
          empty: !sum.main,
          typeLabel: typeLabel(it.type),
          offsetY: 0
        }
      })
    }))
    const w = Number(r.personalPhotoWidth) || 90
    const h = Number(r.personalPhotoHeight) || 112
    this.setData({
      title: r.resumeName || '未命名简历',
      dirty: store.state.dirty,
      canUndo: store.getters.canUndo(),
      canRedo: store.getters.canRedo(),
      baseRows,
      sections,
      sortRows: this.data.sortMode ? sections.map((s) => ({ id: s.id, title: s.title, visible: s.visible, count: s.items.length, offsetY: 0 })) : [],
      photo: {
        src: resolvePhoto(r.personalPhoto),
        raw: r.personalPhoto || '',
        builtin: isBuiltinPhoto(r.personalPhoto) || /^asset:/.test(r.personalPhoto || ''),
        shape: r.personalPhotoShape,
        border: r.personalPhotoBorder,
        w,
        h,
        boxH: Math.round(150 * h / w)
      }
    })
  },

  syncHistoryFlags () {
    this.setData({
      dirty: store.state.dirty,
      canUndo: store.getters.canUndo(),
      canRedo: store.getters.canRedo()
    })
  },

  /** 把某张卡滚进视野并闪一下：focus = base | photo | <sectionId> */
  focusCard (focus) {
    let id = ''
    if (focus === 'base') id = 'card-base'
    else if (focus === 'photo') id = 'card-photo'
    else if (store.getSection(focus)) id = 'sec-' + focus
    if (!id) return false
    this.setData({ scrollInto: '' }, () => {
      this.setData({ scrollInto: id, flashId: id })
      setTimeout(() => { if (this.data.flashId === id) this.setData({ flashId: '' }) }, 1600)
    })
    return true
  },

  /* ================= 文本写回 ================= */

  /** 输入中：只记 pending，不写 store */
  onInput (e) {
    const ds = e.currentTarget.dataset
    this.pending = { scope: ds.scope, key: ds.key || '', sec: ds.sec || '', value: e.detail.value }
    if (!this.data.dirty) this.setData({ dirty: true })
  },

  onBlur (e) {
    const ds = e.currentTarget.dataset
    this.pending = null
    this.writeText({ scope: ds.scope, key: ds.key || '', sec: ds.sec || '', value: e.detail.value })
    if (ds.scope === 'base' && this.data.focusKey === ds.key) this.setData({ focusKey: '' })
  },

  readText (t) {
    const r = store.state.resume
    if (t.scope === 'base') return r.baseInfo[t.key] || ''
    if (t.scope === 'section') {
      const s = store.getSection(t.sec)
      return s ? s.title : ''
    }
    return null
  },

  /** 写一个文本字段并记一个历史点（同值不写，避免白推撤销记录） */
  writeText (t, opts) {
    if (!t || (t.scope !== 'base' && t.scope !== 'section')) return false
    const value = String(t.value == null ? '' : t.value)
    if (this.readText(t) === value) return false
    if (t.scope === 'section' && !value.trim()) return false
    const quiet = opts && opts.quiet
    if (quiet) this._mute = true
    try {
      if (t.scope === 'base') store.setBaseInfo(t.key, value)
      else store.setSectionTitle(t.sec, value)
      store.snapshot()
    } finally {
      this._mute = false
    }
    if (!quiet) this.syncHistoryFlags()
    return true
  },

  commitPending (opts) {
    if (!this.pending) return
    const p = this.pending
    this.pending = null
    this.writeText(p, opts)
  },

  /** 键盘「下一项」：跳到下一个文本输入框；最后一个则收起键盘 */
  onConfirmNext (e) {
    const key = e.currentTarget.dataset.key
    this.pending = null
    this.writeText({ scope: 'base', key, value: e.detail.value })
    const inputs = this.data.baseRows.filter((x) => x.kind === 'text' || x.kind === 'number' || x.kind === 'email')
    const i = inputs.findIndex((x) => x.key === key)
    const next = inputs[i + 1]
    this.setData({ focusKey: next ? next.key : '' })
  },

  onBirthday (e) {
    const v = fromPickerMonth(e.detail.value)
    if (v) this.writeText({ scope: 'base', key: e.currentTarget.dataset.key || 'birthday', value: v })
  },

  onGender (e) {
    const g = GENDERS[Number(e.detail.value)]
    this.writeText({ scope: 'base', key: 'gender', value: g === '不填' ? '' : g })
  },

  onToggleField (e) {
    this.commitPending()
    store.toggleField(e.currentTarget.dataset.key)
  },

  /* ================= 照片 ================= */

  onPreset (e) {
    store.snapshot()
    const old = store.state.resume.personalPhoto
    store.setPhotoField('personalPhoto', e.currentTarget.dataset.url)
    store.save()
    this.recyclePhoto(old, '')
  },

  onCropRatio (e) {
    const id = e.currentTarget.dataset.id
    this.setData({ cropRatio: id })
    // 已有照片时同步纸面上的照片框比例
    if (store.state.resume.personalPhoto) this.applyPhotoRatio(id)
  },

  applyPhotoRatio (id) {
    const r = CROP_RATIOS.find((x) => x.id === id) || CROP_RATIOS[0]
    const w = Number(store.state.resume.personalPhotoWidth) || 90
    store.snapshot()
    store.setPhotoField('personalPhotoHeight', Math.round(w * r.h / r.w))
    store.save()
  },

  onChoosePhoto () {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file) return
        if (file.size > 10 * 1024 * 1024) {
          toast('图片请小于 10MB')
          return
        }
        this.cropThenSave(file.tempFilePath)
      },
      fail: () => {}
    })
  },

  /** 微信原生裁剪；基础库不支持或裁剪出错时直接用原图（用户取消则什么都不做） */
  cropThenSave (src) {
    const ratio = CROP_RATIOS.find((x) => x.id === this.data.cropRatio) || CROP_RATIOS[0]
    if (typeof wx.cropImage !== 'function') {
      this.persistPhoto(src, ratio)
      return
    }
    wx.cropImage({
      src,
      cropScale: ratio.scale,
      success: (r) => this.persistPhoto(r.tempFilePath || src, ratio),
      fail: (err) => {
        const msg = String((err && err.errMsg) || '')
        if (/cancel/i.test(msg)) return
        this.persistPhoto(src, ratio)
      }
    })
  },

  /** 临时文件只在本次会话有效：复制到用户目录长期保存，再回收旧照片 */
  persistPhoto (tempPath, ratio) {
    const old = store.state.resume.personalPhoto
    let dest = tempPath
    try {
      const fs = wx.getFileSystemManager()
      const ext = (String(tempPath).match(/\.(\w+)$/) || [null, 'jpg'])[1]
      const dir = wx.env.USER_DATA_PATH + '/photos'
      try { fs.mkdirSync(dir, true) } catch (e) {}
      dest = dir + '/' + Date.now() + '.' + ext
      fs.copyFileSync(tempPath, dest)
    } catch (err) {
      dest = tempPath
      toast('照片已添加（未能长期保存）')
    }
    store.snapshot()
    store.setPhotoField('personalPhoto', dest)
    if (ratio) {
      const w = Number(store.state.resume.personalPhotoWidth) || 90
      store.setPhotoField('personalPhotoHeight', Math.round(w * ratio.h / ratio.w))
    }
    store.save()
    if (dest !== tempPath) this.recyclePhoto(old, dest)
  },

  /** 只删 USER_DATA_PATH/photos 下、且没有任何草稿引用的文件 */
  recyclePhoto (oldPath, keepPath) {
    try {
      const p = String(oldPath || '')
      if (!p || p === keepPath || p.indexOf('/photos/') < 0) return
      const used = (store.state.drafts || []).some((d) => d && d.personalPhoto === p) || store.state.resume.personalPhoto === p
      if (used) return
      const fs = wx.getFileSystemManager()
      if (typeof fs.unlink === 'function') fs.unlink({ filePath: p, fail: () => {} })
    } catch (e) {}
  },

  onRemovePhoto () {
    const old = store.state.resume.personalPhoto
    if (!old) return
    store.snapshot()
    store.setPhotoField('personalPhoto', '')
    store.save()
    this.recyclePhoto(old, '')
    this.showUndo('已移除照片')
  },

  onPhotoShape (e) {
    store.snapshot()
    store.setPhotoField('personalPhotoShape', e.currentTarget.dataset.id)
    store.snapshot()
    this.syncHistoryFlags()
  },

  onPhotoBorder (e) {
    store.snapshot()
    store.setPhotoField('personalPhotoBorder', e.currentTarget.dataset.id)
    store.snapshot()
    this.syncHistoryFlags()
  },

  /* ================= 区块 / 条目 ================= */

  onOpenItem (e) {
    const ds = e.currentTarget.dataset
    this.openItem(ds.sec, ds.id)
  },

  openItem (secId, itemId, isNew) {
    this.commitPending()
    wx.navigateTo({
      url: '/pages/entry/entry?sectionId=' + secId + '&itemId=' + itemId + (isNew ? '&isNew=1' : '')
    })
  },

  onAddItem (e) {
    const secId = e.currentTarget.dataset.sec
    const s = store.getSection(secId)
    if (!s) return
    this.commitPending()
    const last = s.items[s.items.length - 1]
    const id = store.addItem(secId, (last && last.type) || 'THREE')
    if (id) this.openItem(secId, id, true)
  },

  onGuide (e) {
    const title = e.currentTarget.dataset.title || ''
    wx.navigateTo({ url: '/packages/tools/guide/guide?topic=' + encodeURIComponent(title) })
  },

  onSectionMore (e) {
    const secId = e.currentTarget.dataset.sec
    const s = store.getSection(secId)
    if (!s) return
    const actions = ['从其他简历复制', s.visible === false ? '在简历上显示' : '在简历上隐藏', '调整区块顺序', '删除这个区块']
    wx.showActionSheet({
      itemList: actions,
      success: (res) => {
        const a = actions[res.tapIndex]
        if (a === '从其他简历复制') this.openCopySheet(secId)
        else if (a === '调整区块顺序') this.enterSortMode()
        else if (a === '删除这个区块') this.deleteSection(secId)
        else this.toggleSection(secId)
      },
      fail: () => {}
    })
  },

  onSectionMoreCopy (e) {
    this.openCopySheet(e.currentTarget.dataset.sec)
  },

  onHeadToggle (e) {
    this.toggleSection(e.currentTarget.dataset.sec)
  },

  onHeadDelete (e) {
    this.deleteSection(e.currentTarget.dataset.sec)
  },

  toggleSection (secId) {
    const s = store.getSection(secId)
    if (!s) return
    const wasHidden = s.visible === false
    this.commitPending()
    store.toggleSectionVisible(secId)
    toast(wasHidden ? '已显示' : '已隐藏，简历上不出现')
  },

  deleteSection (secId) {
    const s = store.getSection(secId)
    if (!s) return
    this.commitPending()
    const title = s.title
    if (store.removeSection(secId)) this.showUndo('已删除「' + title + '」')
  },

  onAddSection () {
    this.commitPending()
    const have = store.state.resume.sections.map((s) => s.title)
    const presets = SECTION_PRESETS.filter((t) => have.indexOf(t) < 0).slice(0, 5)
    const actions = presets.concat(['自定义名称…'])
    wx.showActionSheet({
      itemList: actions,
      success: (res) => {
        const a = actions[res.tapIndex]
        if (a === '自定义名称…') {
          wx.showModal({
            title: '新区块名称',
            editable: true,
            placeholderText: '例如：志愿者经历',
            success: (r) => {
              if (!r.confirm) return
              const t = String(r.content || '').trim()
              if (t) this.addSection(t)
            }
          })
        } else if (a) {
          this.addSection(a)
        }
      },
      fail: () => {}
    })
  },

  addSection (title) {
    const type = /评价|技能|兴趣|爱好|证书/.test(title) ? 'ONE' : 'THREE'
    const id = store.addSection(title, type)
    if (id) this.focusCard(id)
    return id
  },

  /* ================= 调整顺序模式 ================= */

  enterSortMode () {
    this.commitPending()
    this.setData({ sortMode: true })
    this.refresh()
    this.setData({ scrollInto: '' }, () => this.setData({ scrollInto: 'sort-top' }))
  },

  exitSortMode () {
    this.abortTouch()
    this.setData({ sortMode: false, sortRows: [] })
  },

  /* ================= 手势：条目长按拖动 / 标题栏左滑与长按 / 排序把手 =================
   *
   * 三类行共用一个状态机：
   *   list = 'item'  条目行：点击进子页；长按升级为拖动排序
   *   list = 'head'  区块标题栏：左滑露出 显示/隐藏 · 删除；长按进入调整顺序模式
   *   list = 'sort'  排序模式的把手：按下即拖（catchtouch，不会带动页面滚动）
   * 拖动期间关闭 scroll-view 的 scroll-y，否则行跟手位移与列表滚动会叠加。
   */

  _LONG_PRESS_MS: 380,
  _TAP_SLOP_PX: 8,
  _SWIPE_SLOP_PX: 12,
  _touch: null,

  rpxOf (px) {
    if (!this._rpx) this._rpx = 750 / windowWidth()
    return px * this._rpx
  },

  onRowStart (e) {
    const touch = e.touches && e.touches[0]
    if (!touch) return
    const ds = e.currentTarget.dataset
    const list = ds.list
    const role = (e.target && e.target.dataset && e.target.dataset.role) || ''
    const t = {
      list,
      id: ds.id,
      secId: ds.sec || '',
      index: Number(ds.index) || 0,
      dropIndex: Number(ds.index) || 0,
      role,
      startX: touch.clientX,
      startY: touch.clientY,
      openX: 0,
      offsetX: 0,
      mode: 'idle',
      rects: [],
      timer: null
    }
    if (list === 'head') {
      const s = this.data.sections.find((x) => x.id === ds.id)
      t.openX = (s && s.offsetX) || 0
      t.offsetX = t.openX
      this.closeHeads(ds.id)
    } else {
      this.closeHeads('')
    }
    this._touch = t
    if (list === 'sort') {
      this.enterDrag()
    } else if (!role) {
      t.timer = setTimeout(() => {
        if (t.list === 'head') {
          if (this._touch === t && t.mode === 'idle') {
            t.mode = 'done'
            if (wx.vibrateShort) wx.vibrateShort({ type: 'light', fail: () => {} })
            this.enterSortMode()
          }
        } else {
          this.enterDrag()
        }
      }, this._LONG_PRESS_MS)
    }
  },

  /** 量出同组所有行的矩形后进入拖动 */
  enterDrag () {
    const t = this._touch
    if (!t || t.mode !== 'idle') return
    const sel = t.list === 'sort' ? '.sort-row' : '.irow-' + t.secId
    t.mode = 'measuring'
    wx.createSelectorQuery()
      .in(this)
      .selectAll(sel)
      .boundingClientRect()
      .exec((res) => {
        const cur = this._touch
        if (!cur || cur !== t || cur.mode !== 'measuring') return
        cur.rects = (res && res[0]) || []
        cur.mode = 'drag'
        this.setData({
          drag: { list: cur.list, id: cur.id, secId: cur.secId, index: cur.index },
          dropIndex: cur.index,
          movingId: cur.id,
          scrollEnabled: false
        })
        if (cur.list === 'item' && wx.vibrateShort) wx.vibrateShort({ type: 'light', fail: () => {} })
      })
  },

  onRowMove (e) {
    const t = this._touch
    const touch = e.touches && e.touches[0]
    if (!t || !touch) return
    const dx = touch.clientX - t.startX
    const dy = touch.clientY - t.startY

    if (t.mode === 'idle') {
      if (Math.abs(dx) <= this._TAP_SLOP_PX && Math.abs(dy) <= this._TAP_SLOP_PX) return
      this.clearTimer()
      if (t.list === 'head' && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > this._SWIPE_SLOP_PX) {
        t.mode = 'swipe'
      } else {
        t.mode = 'scroll'
        return
      }
    }

    if (t.mode === 'swipe') {
      const x = Math.max(-HEAD_ACTS_W, Math.min(0, t.openX + this.rpxOf(dx)))
      t.offsetX = x
      if (this.data.movingId !== t.id) this.setData({ movingId: t.id })
      this.patchHead(t.id, { offsetX: x })
      return
    }

    if (t.mode === 'drag') {
      this.patchDragRow(t, { offsetY: this.rpxOf(dy) })
      const idx = this.dropIndexAt(touch.clientY)
      if (idx !== t.dropIndex) {
        t.dropIndex = idx
        this.setData({ dropIndex: idx })
      }
    }
  },

  onRowEnd () {
    const t = this._touch
    if (!t) return
    this.clearTimer()
    this._touch = null

    if (t.mode === 'drag') {
      this.endDrag(t, true)
      return
    }
    if (t.mode === 'measuring') {
      // 量矩形期间就抬手了：当作没拖
      this.endDrag(t, false)
      return
    }
    if (t.mode === 'swipe') {
      const open = t.offsetX <= -HEAD_ACTS_W / 2
      this.setData({ movingId: '' })
      this.patchHead(t.id, { offsetX: open ? -HEAD_ACTS_W : 0 })
      return
    }
    if (t.mode !== 'idle') return

    // 点击
    if (t.list === 'item') {
      this.openItem(t.secId, t.id)
    } else if (t.list === 'head' && t.openX !== 0) {
      this.patchHead(t.id, { offsetX: 0 })
    }
  },

  onRowCancel () {
    const t = this._touch
    if (!t) return
    this.clearTimer()
    this._touch = null
    if (t.mode === 'drag' || t.mode === 'measuring') this.endDrag(t, false)
    else if (t.mode === 'swipe') {
      this.setData({ movingId: '' })
      this.patchHead(t.id, { offsetX: 0 })
    }
  },

  endDrag (t, commit) {
    this.setData({ drag: { list: '', id: '', secId: '', index: -1 }, dropIndex: -1, movingId: '', scrollEnabled: true })
    this.patchDragRow(t, { offsetY: 0 })
    if (!commit || t.dropIndex === t.index) return
    const moved = t.list === 'sort'
      ? store.moveSectionTo(t.id, t.dropIndex)
      : store.moveItemTo(t.secId, t.id, t.dropIndex)
    if (moved) toast('顺序已调整')
  },

  abortTouch () {
    const t = this._touch
    if (!t) return
    this.clearTimer()
    this._touch = null
    if (t.mode === 'drag' || t.mode === 'measuring') this.endDrag(t, false)
  },

  clearTimer () {
    if (this._touch && this._touch.timer) {
      clearTimeout(this._touch.timer)
      this._touch.timer = null
    }
  },

  dropIndexAt (clientY) {
    const t = this._touch
    if (!t || !t.rects.length) return t ? t.dropIndex : 0
    let idx = t.rects.length - 1
    for (let i = 0; i < t.rects.length; i++) {
      const r = t.rects[i]
      if (clientY < r.top + r.height / 2) {
        idx = i
        break
      }
    }
    return Math.max(0, Math.min(t.rects.length - 1, idx))
  },

  patchDragRow (t, patch) {
    const next = {}
    if (t.list === 'sort') {
      const i = this.data.sortRows.findIndex((x) => x.id === t.id)
      if (i < 0) return
      Object.keys(patch).forEach((k) => { next['sortRows[' + i + '].' + k] = patch[k] })
    } else {
      const si = this.data.sections.findIndex((x) => x.id === t.secId)
      if (si < 0) return
      const ii = this.data.sections[si].items.findIndex((x) => x.id === t.id)
      if (ii < 0) return
      Object.keys(patch).forEach((k) => { next['sections[' + si + '].items[' + ii + '].' + k] = patch[k] })
    }
    this.setData(next)
  },

  patchHead (id, patch) {
    const i = this.data.sections.findIndex((x) => x.id === id)
    if (i < 0) return
    const next = {}
    Object.keys(patch).forEach((k) => { next['sections[' + i + '].' + k] = patch[k] })
    this.setData(next)
  },

  closeHeads (exceptId) {
    const next = {}
    this.data.sections.forEach((s, i) => {
      if (s.id !== exceptId && s.offsetX) next['sections[' + i + '].offsetX'] = 0
    })
    if (Object.keys(next).length) this.setData(next)
  },

  /* ================= 撤销条 ================= */

  showUndo (label) {
    if (this.undoTimer) clearTimeout(this.undoTimer)
    this.setData({ undoBar: { show: true, label: label || '已删除' } })
    this.undoTimer = setTimeout(() => {
      this.undoTimer = null
      this.setData({ undoBar: { show: false, label: '' } })
    }, 4000)
  },

  onUndoBar () {
    if (this.undoTimer) clearTimeout(this.undoTimer)
    this.undoTimer = null
    this.setData({ undoBar: { show: false, label: '' } })
    this.commitPending()
    store.commitTextHistory()
    if (store.undo()) {
      store.save(true)
      toast('已撤销')
    }
  },

  /* ================= 从其他简历复制 ================= */

  openCopySheet (secId) {
    const target = store.getSection(secId)
    if (!target) return
    this.commitPending()
    const curId = store.state.resume.id
    const drafts = store.state.drafts
      .filter((d) => d && d.id !== curId)
      .map((d) => {
        const secs = (d.sections || []).map((s) => ({
          id: s.id,
          title: s.title || '未命名区块',
          same: s.title === target.title,
          items: (s.items || []).map((it) => {
            const sum = itemSummary(it)
            return { id: it.id, main: sum.main || '（空条目）', sub: sum.sub, checked: false }
          })
        }))
        // 同名区块排前面：最常见的是「把另一份简历的实习经历搬过来」
        secs.sort((a, b) => (b.same ? 1 : 0) - (a.same ? 1 : 0))
        return { id: d.id, name: d.resumeName || '未命名简历', archived: d.archived === true, open: false, sections: secs }
      })
    if (drafts.length === 1) drafts[0].open = true
    this.setData({
      copySheet: { show: true, targetSecId: secId, targetTitle: target.title, drafts, count: 0 }
    })
  },

  closeCopySheet () {
    this.setData({ 'copySheet.show': false, 'copySheet.drafts': [] })
  },

  onCopyDraftToggle (e) {
    const i = Number(e.currentTarget.dataset.di)
    const d = this.data.copySheet.drafts[i]
    if (!d) return
    this.setData({ ['copySheet.drafts[' + i + '].open']: !d.open })
  },

  onCopyItemToggle (e) {
    const ds = e.currentTarget.dataset
    const di = Number(ds.di)
    const si = Number(ds.si)
    const ii = Number(ds.ii)
    const it = this.data.copySheet.drafts[di].sections[si].items[ii]
    const count = this.data.copySheet.count + (it.checked ? -1 : 1)
    this.setData({
      ['copySheet.drafts[' + di + '].sections[' + si + '].items[' + ii + '].checked']: !it.checked,
      'copySheet.count': count
    })
  },

  /** 整块复制为当前简历的新区块 */
  onCopyWholeSection (e) {
    const ds = e.currentTarget.dataset
    const d = this.data.copySheet.drafts[Number(ds.di)]
    const s = d && d.sections[Number(ds.si)]
    if (!s) return
    const r = store.copySectionFrom(d.id, s.id)
    this.closeCopySheet()
    if (r) {
      toast('已复制为新区块')
      this.focusCard(r.sectionId)
    }
  },

  /** 选中的条目加进当前区块 */
  onCopySelected () {
    const sheet = this.data.copySheet
    if (!sheet.count) {
      toast('先勾选要复制的条目')
      return
    }
    let total = 0
    sheet.drafts.forEach((d) => {
      d.sections.forEach((s) => {
        const ids = s.items.filter((x) => x.checked).map((x) => x.id)
        if (!ids.length) return
        const r = store.copySectionFrom(d.id, s.id, ids, sheet.targetSecId)
        if (r) total += r.count
      })
    })
    this.closeCopySheet()
    if (total) {
      toast('已加入 ' + total + ' 条')
      this.focusCard(sheet.targetSecId)
    }
  },

  /* ================= 顶栏 / 底栏 ================= */

  onRename () {
    this.commitPending()
    const r = store.state.resume
    wx.showModal({
      title: '简历名称',
      editable: true,
      placeholderText: '例如：张三_产品经理',
      content: r.resumeName || '',
      success: (res) => {
        if (!res.confirm) return
        const name = String(res.content || '').trim()
        if (!name) return
        store.snapshot()
        store.setResumeName(name)
        store.save()
      }
    })
  },

  onMore () {
    this.commitPending()
    const actions = [
      this.data.canUndo ? '撤销' : '撤销（没有可撤销的）',
      this.data.canRedo ? '重做' : '重做（没有可重做的）',
      '切换模板',
      'JD 匹配',
      '重命名简历'
    ]
    wx.showActionSheet({
      itemList: actions,
      success: (res) => {
        const i = res.tapIndex
        if (i === 0) this.onUndo()
        else if (i === 1) this.onRedo()
        else if (i === 2) this.goTool('/packages/tools/templates/templates')
        else if (i === 3) this.goTool('/packages/tools/match/match?id=' + store.state.resume.id)
        else if (i === 4) this.onRename()
      },
      fail: () => {}
    })
  },

  onUndo () {
    store.commitTextHistory()
    if (store.undo()) toast('已撤销')
    else toast('没有可撤销的操作')
  },

  onRedo () {
    store.commitTextHistory()
    if (store.redo()) toast('已重做')
    else toast('没有可重做的操作')
  },

  goTool (url) {
    this.commitPending()
    if (store.state.dirty) store.save(true)
    wx.navigateTo({ url })
  },

  onTab (e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === 'form') return
    let url = '/pages/preview/preview'
    if (tab === 'style') url += '?panel=style'
    else if (tab === 'export') url += '?panel=export'
    this.goTool(url)
  },

  noop () {}
})
