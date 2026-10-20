/**
 * 条目编辑子页（手机端重做 v1）
 *
 * 一条 = { type: ONE|TWO|THREE, leftContent, centerContent, rightContent }。
 * 字段名对用户说人话，并且只显示当前排版真的会渲染的栏（与旧编辑页 itemFields、
 * utils/paper.js usesCol 同一口径）：
 *   ONE   一行文字   centerContent = 内容（多行）
 *   TWO   左右两栏   leftContent = 标题，rightContent = 时间
 *   THREE 左中右三栏 leftContent = 标题，centerContent = 说明（多行），rightContent = 时间
 * 换排版只改 type，三栏内容原样保留，切回来还在。
 *
 * 时间：开始（年月）+ 结束（年月 / 至今）滚轮选择 → 「2021.09 - 至今」；
 * 解析不了的旧写法（如「201x.09-202x.06」「2021 春」）自动切到手动输入，不会被覆盖。
 */
const store = require('../../utils/store.js')
const { toast } = require('../../utils/export.js')

const app = getApp()

const LAYOUTS = [
  { id: 'ONE', label: '一行文字', hint: '整行写一段话：工作内容、自我评价' },
  { id: 'TWO', label: '左右两栏', hint: '标题 + 时间：证书、奖项' },
  { id: 'THREE', label: '左中右三栏', hint: '标题 + 说明 + 时间：学校、公司' }
]

const PRESENT_RE = /^(至今|今|现在|目前|present|now)$/i

/** 'YYYY-MM'（picker）→ 'YYYY.MM' */
function dot (v) {
  const m = String(v || '').match(/^(\d{4})-(\d{1,2})/)
  return m ? m[1] + '.' + ('0' + m[2]).slice(-2) : ''
}

function pickerOf (y, m) {
  const mm = Number(m)
  if (!y || !(mm >= 1 && mm <= 12)) return ''
  return y + '-' + ('0' + mm).slice(-2)
}

/**
 * 解析时间文本。能解析返回 { start, end, present }（start/end 为 picker 的 'YYYY-MM'），
 * 空串返回空结构，解析不了返回 null。
 */
function parseTime (text) {
  const s = String(text || '').trim()
  if (!s) return { start: '', end: '', present: false }
  const ym = '(\\d{4})\\s*[.\\-/年]\\s*(\\d{1,2})\\s*月?'
  const one = new RegExp('^' + ym + '$')
  const range = new RegExp('^' + ym + '\\s*(?:-|–|—|~|～|至|到)\\s*(?:' + ym + '|(\\S+))$')
  let m = s.match(one)
  if (m) {
    const start = pickerOf(m[1], m[2])
    return start ? { start, end: '', present: false } : null
  }
  m = s.match(range)
  if (!m) return null
  const start = pickerOf(m[1], m[2])
  if (!start) return null
  if (m[3]) {
    const end = pickerOf(m[3], m[4])
    return end ? { start, end, present: false } : null
  }
  if (m[5] && PRESENT_RE.test(m[5])) return { start, end: '', present: true }
  return null
}

/** 组合成纸面上的时间文本 */
function formatTime (start, end, present) {
  const a = dot(start)
  if (!a) return ''
  if (present) return a + ' - 至今'
  const b = dot(end)
  return b ? a + ' - ' + b : a
}

function thisMonth () {
  const d = new Date()
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2)
}

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    sectionId: '',
    itemId: '',
    isNew: false,
    sectionTitle: '',
    position: '',
    layouts: LAYOUTS,
    type: 'THREE',
    left: '',
    center: '',
    right: '',
    showTitle: true,
    showDesc: true,
    showTime: true,
    descLabel: '说明',
    timeFree: false,
    start: '',
    end: '',
    present: false,
    maxMonth: '2040-12',
    focusField: ''
  },

  onLoad (query) {
    const q = query || {}
    const g = app.globalData || {}
    store.init()
    this.setData({
      statusBarHeight: g.statusBarHeight || 20,
      navBarHeight: g.navBarHeight || 44,
      sectionId: q.sectionId || '',
      itemId: q.itemId || '',
      isNew: q.isNew === '1' || q.isNew === 1 || q.isNew === true,
      maxMonth: (new Date().getFullYear() + 10) + '-12'
    })
    if (!this.load()) {
      toast('这条内容已不存在')
      setTimeout(() => wx.navigateBack({ fail: () => {} }), 300)
    }
  },

  onHide () {
    this.commitPending()
    if (store.state.dirty) store.save(true)
  },

  onUnload () {
    this.commitPending()
    if (!this._deleted && this.data.isNew && this.isEmpty()) {
      // 新建后什么都没填就返回：不在简历上留一行空白
      store.removeItem(this.data.sectionId, this.data.itemId)
    }
    store.commitTextHistory()
    if (store.state.dirty) store.save(true)
  },

  /** 从 store 读条目到表单；条目不存在返回 false */
  load () {
    const { sectionId, itemId } = this.data
    const s = store.getSection(sectionId)
    const it = store.getItem(sectionId, itemId)
    if (!s || !it) return false
    const t = parseTime(it.rightContent)
    this.setData({
      sectionTitle: s.title,
      position: '第 ' + (s.items.indexOf(it) + 1) + ' / ' + s.items.length + ' 条',
      left: it.leftContent || '',
      center: it.centerContent || '',
      right: it.rightContent || '',
      timeFree: !t,
      start: t ? t.start : '',
      end: t ? t.end : '',
      present: t ? t.present : false
    })
    this.applyType(it.type || 'THREE')
    return true
  },

  applyType (type) {
    this.setData({
      type,
      showTitle: type !== 'ONE',
      showDesc: type !== 'TWO',
      showTime: type !== 'ONE',
      descLabel: type === 'ONE' ? '内容' : '说明'
    })
  },

  isEmpty () {
    const it = store.getItem(this.data.sectionId, this.data.itemId)
    if (!it) return false
    return !String(it.leftContent || '').trim() && !String(it.centerContent || '').trim() && !String(it.rightContent || '').trim()
  },

  /* ================= 写回 ================= */

  /** 写一个字段并记历史点（同值不写） */
  write (field, value) {
    const v = String(value == null ? '' : value)
    const it = store.getItem(this.data.sectionId, this.data.itemId)
    if (!it || it[field] === v) return false
    store.updateItem(this.data.sectionId, this.data.itemId, { [field]: v })
    return true
  },

  onInput (e) {
    this.pending = { field: e.currentTarget.dataset.field, value: e.detail.value }
  },

  onBlur (e) {
    const field = e.currentTarget.dataset.field
    this.pending = null
    this.write(field, e.detail.value)
    this.syncLocal(field, e.detail.value)
    if (this.data.focusField === field) this.setData({ focusField: '' })
  },

  /** 本页 data 跟着更新，切排版 / 切时间模式时显示的是最新值 */
  syncLocal (field, value) {
    const key = field === 'leftContent' ? 'left' : field === 'centerContent' ? 'center' : 'right'
    this.setData({ [key]: String(value == null ? '' : value) })
  },

  commitPending () {
    if (!this.pending) return
    const p = this.pending
    this.pending = null
    this.write(p.field, p.value)
    this.syncLocal(p.field, p.value)
  },

  /** 标题框「下一项」：跳到说明（三栏）或时间（两栏手动输入） */
  onTitleNext (e) {
    this.pending = null
    this.write('leftContent', e.detail.value)
    this.syncLocal('leftContent', e.detail.value)
    let next = ''
    if (this.data.showDesc) next = 'centerContent'
    else if (this.data.showTime && this.data.timeFree) next = 'rightContent'
    this.setData({ focusField: next })
  },

  onSetType (e) {
    const type = e.currentTarget.dataset.type
    if (!type || type === this.data.type) return
    this.commitPending()
    store.setItemType(this.data.sectionId, this.data.itemId, type)
    this.applyType(type)
  },

  /* ================= 时间 ================= */

  onStart (e) {
    const start = e.detail.value
    let end = this.data.end
    if (end && end < start) end = ''
    this.setData({ start, end })
    this.writeTime()
  },

  onEnd (e) {
    let end = e.detail.value
    if (this.data.start && end < this.data.start) {
      toast('结束不能早于开始')
      return
    }
    this.setData({ end, present: false })
    this.writeTime()
  },

  onTogglePresent () {
    const present = !this.data.present
    this.setData({ present, end: present ? '' : this.data.end })
    this.writeTime()
  },

  writeTime () {
    if (!this.data.start) return
    const text = formatTime(this.data.start, this.data.end, this.data.present)
    this.write('rightContent', text)
    this.setData({ right: text })
  },

  onClearTime () {
    this.setData({ start: '', end: '', present: false, right: '' })
    this.write('rightContent', '')
  },

  onToggleTimeFree () {
    this.commitPending()
    if (this.data.timeFree) {
      const t = parseTime(this.data.right)
      if (!t) {
        // 手写的内容滚轮表达不了：提醒一下，选了新时间才会覆盖
        toast('当前写法无法用滚轮表示，选择后将替换')
        this.setData({ timeFree: false, start: '', end: '', present: false })
        return
      }
      this.setData({ timeFree: false, start: t.start, end: t.end, present: t.present })
    } else {
      this.setData({ timeFree: true })
    }
  },

  /* ================= 底部 ================= */

  onDelete () {
    this.commitPending()
    if (store.removeItem(this.data.sectionId, this.data.itemId)) {
      this._deleted = true
      store.markDeleted('已删除条目')
      wx.navigateBack({ fail: () => wx.redirectTo({ url: '/pages/edit/edit' }) })
    }
  },

  onDone () {
    this.commitPending()
    store.commitTextHistory()
    if (store.state.dirty) store.save(true)
    wx.navigateBack({ fail: () => wx.redirectTo({ url: '/pages/edit/edit' }) })
  },

  noop () {}
})

/* 纯函数也挂出去，便于 tools/check-core.cjs 直接测 */
module.exports = { parseTime, formatTime, thisMonth }
