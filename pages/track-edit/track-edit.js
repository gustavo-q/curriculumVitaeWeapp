/**
 * 投递详情 / 新记一笔
 *
 * 入口：
 *   /pages/track-edit/track-edit?id=<记录 id>          编辑
 *   /pages/track-edit/track-edit                        新建
 *   /pages/track-edit/track-edit?company=&role=&resumeId=&keywords=a,b&link=
 *                                                       从 JD 匹配「记一笔投递」带过来的预填（均 URL 编码）
 *
 * 面试时间可一键加到手机日历（wx.addPhoneCalendar，基础库 2.15.0+）。
 * 不支持或调用失败时退化为「复制面试信息」，用户自己贴到日历 / 备忘录。
 */
const store = require('../../utils/store.js')
const T = require('../../utils/trackStore.js')

function dec (v) {
  if (v == null) return ''
  try {
    return decodeURIComponent(String(v))
  } catch (e) {
    return String(v)
  }
}

function blankForm () {
  return {
    id: '',
    company: '',
    role: '',
    link: '',
    resumeId: '',
    status: 'applied',
    appliedAt: T.todayStr(),
    ivDate: '',
    ivTime: '',
    note: '',
    jdKeywords: []
  }
}

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    isEdit: false,
    fromMatch: false,
    form: blankForm(),
    statuses: T.TRACK_STATUSES,
    resumeNames: ['不关联简历'],
    resumeIndex: 0,
    today: T.todayStr(),
    canCalendar: true,
    notFound: false
  },

  onLoad (query) {
    const q = query || {}
    const g = getApp().globalData || {}
    store.init()
    this._resumeIds = ['']
    this.setData({
      statusBarHeight: g.statusBarHeight || 20,
      navBarHeight: g.navBarHeight || 44,
      canCalendar: typeof wx.addPhoneCalendar === 'function'
    })

    let form = blankForm()
    let isEdit = false
    let notFound = false
    if (q.id) {
      const rec = T.getTrack(dec(q.id))
      if (rec) {
        isEdit = true
        form = {
          id: rec.id,
          company: rec.company,
          role: rec.role,
          link: rec.link || '',
          resumeId: rec.resumeId || '',
          status: rec.status,
          appliedAt: rec.appliedAt,
          ivDate: rec.interviewAt ? T.dateStr(rec.interviewAt) : '',
          ivTime: rec.interviewAt ? T.timeStr(rec.interviewAt) : '',
          note: rec.note || '',
          jdKeywords: Array.isArray(rec.jdKeywords) ? rec.jdKeywords : []
        }
      } else {
        notFound = true
      }
    }
    const fromMatch = !isEdit && !!(q.company || q.role || q.resumeId || q.keywords)
    if (!isEdit) {
      if (q.company) form.company = dec(q.company).trim().slice(0, 40)
      if (q.role) form.role = dec(q.role).trim().slice(0, 40)
      if (q.link) form.link = dec(q.link).trim()
      if (q.resumeId) form.resumeId = dec(q.resumeId)
      if (q.keywords) form.jdKeywords = T.cleanKeywords(dec(q.keywords))
    }
    this._initialJSON = JSON.stringify(form)
    this.setData({ form, isEdit, fromMatch, notFound })
    this.buildResumeOptions(form.resumeId)
    if (notFound) wx.showToast({ title: '这条记录已不存在', icon: 'none' })
  },

  /** 所用简历：草稿列表；记录里关联的简历若已删，保留一项「简历已删除」免得静默丢关联 */
  buildResumeOptions (resumeId) {
    const drafts = store.state.drafts || []
    const ids = [''].concat(drafts.map((d) => d.id))
    const names = ['不关联简历'].concat(drafts.map((d) => (d.resumeName || '未命名简历') + (d.archived ? '（已归档）' : '')))
    if (resumeId && ids.indexOf(resumeId) < 0) {
      ids.push(resumeId)
      names.push('简历已删除')
    }
    this._resumeIds = ids
    this.setData({ resumeNames: names, resumeIndex: Math.max(0, ids.indexOf(resumeId)) })
  },

  /* ---------------- 表单输入 ---------------- */

  onInput (e) {
    const k = e.currentTarget.dataset.k
    if (!k) return
    this.setData({ ['form.' + k]: e.detail.value })
  },

  onResume (e) {
    const i = Number(e.detail.value) || 0
    this.setData({ resumeIndex: i, 'form.resumeId': this._resumeIds[i] || '' })
  },

  onStatus (e) {
    const id = e.currentTarget.dataset.id
    if (T.isStatus(id)) this.setData({ 'form.status': id })
  },

  onAppliedAt (e) {
    this.setData({ 'form.appliedAt': e.detail.value })
  },

  onIvDate (e) {
    const patch = { 'form.ivDate': e.detail.value }
    if (!this.data.form.ivTime) patch['form.ivTime'] = '10:00'
    // 填了面试时间却还是「已投」：顺手改成面试中（用户仍可改回）
    if (this.data.form.status === 'applied') patch['form.status'] = 'interviewing'
    this.setData(patch)
  },

  onIvTime (e) {
    const patch = { 'form.ivTime': e.detail.value }
    if (!this.data.form.ivDate) patch['form.ivDate'] = T.todayStr()
    this.setData(patch)
  },

  onClearIv () {
    this.setData({ 'form.ivDate': '', 'form.ivTime': '' })
  },

  onPasteLink () {
    wx.getClipboardData({
      success: (res) => {
        const s = String(res.data || '').trim()
        if (!s) return wx.showToast({ title: '剪贴板是空的', icon: 'none' })
        this.setData({ 'form.link': s.slice(0, 500) })
      }
    })
  },

  onRemoveKw (e) {
    const w = e.currentTarget.dataset.w
    this.setData({ 'form.jdKeywords': this.data.form.jdKeywords.filter((x) => x !== w) })
  },

  /* ---------------- 日历 ---------------- */

  interviewAt () {
    return T.combineDateTime(this.data.form.ivDate, this.data.form.ivTime)
  },

  calendarTitle () {
    const f = this.data.form
    return ('面试：' + (f.company || '').trim() + ' ' + (f.role || '').trim()).trim()
  },

  /** 退化方案：把面试信息复制下来，用户自己贴到日历 / 备忘录 */
  calendarFallback (reason) {
    const ts = this.interviewAt()
    const f = this.data.form
    const text = this.calendarTitle() + '\n时间：' + T.dateStr(ts) + ' ' + T.timeStr(ts) + (f.link ? '\n' + f.link : '')
    wx.showModal({
      title: reason || '当前微信版本不支持写入日历',
      content: '可以复制面试信息，自己添加到手机日历或备忘录。',
      confirmText: '复制信息',
      success: (r) => {
        if (!r.confirm) return
        wx.setClipboardData({
          data: text,
          success: () => wx.showToast({ title: '已复制面试信息', icon: 'none' })
        })
      }
    })
  },

  onAddCalendar () {
    const f = this.data.form
    const ts = this.interviewAt()
    if (!ts) return wx.showToast({ title: '先选面试日期和时间', icon: 'none' })
    if (!f.company.trim() || !f.role.trim()) return wx.showToast({ title: '先填公司和岗位', icon: 'none' })
    if (ts < Date.now()) return wx.showToast({ title: '面试时间已经过了', icon: 'none' })
    if (typeof wx.addPhoneCalendar !== 'function') return this.calendarFallback()
    wx.addPhoneCalendar({
      title: this.calendarTitle(),
      startTime: Math.floor(ts / 1000),
      description: [f.link, f.note].filter(Boolean).join('\n').slice(0, 500),
      alarm: true,
      alarmOffset: 3600,
      success: () => wx.showToast({ title: '已加到手机日历', icon: 'success' }),
      fail: (err) => {
        const msg = String((err && err.errMsg) || '')
        if (/cancel/i.test(msg)) return
        if (/auth|deny|denied|permission/i.test(msg)) return this.calendarFallback('没有日历权限')
        this.calendarFallback('写入日历失败')
      }
    })
  },

  /* ---------------- 保存 / 删除 ---------------- */

  collect () {
    const f = this.data.form
    return {
      id: f.id || undefined,
      company: f.company,
      role: f.role,
      link: f.link,
      resumeId: f.resumeId || null,
      status: f.status,
      appliedAt: f.appliedAt,
      interviewAt: this.interviewAt(),
      note: f.note,
      jdKeywords: f.jdKeywords
    }
  },

  onSave () {
    const f = this.data.form
    if (!String(f.company).trim()) return wx.showToast({ title: '请填写公司', icon: 'none' })
    if (!String(f.role).trim()) return wx.showToast({ title: '请填写岗位', icon: 'none' })
    const res = T.upsertTrack(this.collect())
    if (!res.record) return wx.showToast({ title: '请填写公司和岗位', icon: 'none' })
    if (!res.ok) return wx.showToast({ title: '保存失败，存储空间可能已满', icon: 'none' })
    this._initialJSON = ''
    this.setData({ 'form.id': res.record.id })
    wx.showToast({ title: this.data.isEdit ? '已保存' : '已记一笔', icon: 'success' })
    setTimeout(() => this.leave(), 500)
  },

  /** 从 JD 匹配来的：保存后直接去「投递」tab 看到这条；其余返回上一页 */
  leave () {
    if (this.data.fromMatch) return wx.switchTab({ url: '/pages/track/track' })
    const pages = getCurrentPages()
    if (pages.length > 1) wx.navigateBack()
    else wx.switchTab({ url: '/pages/track/track' })
  },

  onDelete () {
    const id = this.data.form.id
    if (!id) return
    wx.showModal({
      title: '删除这条投递？',
      content: '删除后无法恢复。',
      confirmText: '删除',
      confirmColor: '#b3261e',
      success: (r) => {
        if (!r.confirm) return
        T.removeTrack(id)
        wx.showToast({ title: '已删除', icon: 'none' })
        setTimeout(() => this.leave(), 400)
      }
    })
  }
})
