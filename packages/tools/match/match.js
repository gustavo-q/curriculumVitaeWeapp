/**
 * JD 关键词匹配（分包 tools）—— 对应参考站 /match
 *
 * 入口：/packages/tools/match/match[?resumeId=<草稿 id>]（也认 ?id=）
 *
 * 手机流程：
 *   1. onShow 读剪贴板，像 JD（>30 字、不是刚处理过的那段）就顶部提示「一键粘贴」
 *   2. 选简历 → 匹配 → 覆盖率圆环 + 命中 / 弱匹配 / 缺失 三组词
 *   3. 点弱匹配 / 缺失的词：复制到剪贴板 + 跳编辑器对应区块（?focus=<区块 id|base>）
 *   4. 记一笔投递：带上简历、岗位关键词，并从 JD 开头猜公司和岗位
 *
 * 沿用参考站红线：纯本地零网络；匹配只读、不改简历；数据源只用草稿快照
 * （store.state.drafts），当前简历有未保存改动时给提示。
 */
const store = require('../../../utils/store.js')
const M = require('../../../utils/matchJD.js')

const LS_TERMS = 'pb_match_terms_v1'
/** 最近处理过的剪贴板内容的哈希（只存哈希，不存原文） */
const LS_CLIP = 'pb_match_clip_v1'

function loadTerms () {
  try {
    let arr = wx.getStorageSync(LS_TERMS)
    if (typeof arr === 'string' && arr) arr = JSON.parse(arr)
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.trim()) : []
  } catch (e) {
    return []
  }
}

function saveTerms (list) {
  try {
    wx.setStorageSync(LS_TERMS, list.filter((x) => typeof x === 'string' && x.trim()))
  } catch (e) {}
}

function lastClipHash () {
  try {
    return wx.getStorageSync(LS_CLIP) || ''
  } catch (e) {
    return ''
  }
}

function markClipHandled (text) {
  try {
    wx.setStorageSync(LS_CLIP, M.hashText(text))
  } catch (e) {}
}

/**
 * 剪贴板是否该弹「一键粘贴」提示（纯逻辑，便于测试）：
 * 像 JD、与上次处理过的不同、也不是输入框里已有的那段。
 */
function shouldOfferClip (clip, lastHash, currentJD) {
  if (!M.looksLikeJD(clip)) return false
  const h = M.hashText(clip)
  if (h === lastHash) return false
  if (String(currentJD || '').trim() && M.hashText(currentJD) === h) return false
  return true
}

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    jd: '',
    clipOffer: false,
    clipPreview: '',
    resumeNames: [],
    resumeIndex: 0,
    hasDrafts: false,
    dirtyTip: false,
    result: null,
    coverage: null,
    ringStyle: '',
    stale: false,
    customTerms: [],
    newTerm: ''
  },

  onLoad (query) {
    const q = query || {}
    const g = getApp().globalData || {}
    store.init()
    this._wantId = q.resumeId || q.id || ''
    this.setData({
      statusBarHeight: g.statusBarHeight || 20,
      navBarHeight: g.navBarHeight || 44,
      customTerms: loadTerms()
    })
    this.buildResumes()
  },

  onShow () {
    // 从编辑器补完关键词回来：草稿可能变了，重建选项并刷新结果
    this.buildResumes()
    if (this.data.result) this.runMatch(true)
    this.checkClipboard()
  },

  /* ---------------- 简历选择 ---------------- */

  buildResumes () {
    const drafts = store.state.drafts || []
    const ids = drafts.map((d) => d.id)
    let cur = this._selectedId
    if (!cur || ids.indexOf(cur) < 0) {
      if (this._wantId && ids.indexOf(this._wantId) >= 0) cur = this._wantId
      else if (store.state.resume && ids.indexOf(store.state.resume.id) >= 0) cur = store.state.resume.id
      else cur = ids[0] || ''
    }
    this._ids = ids
    this._selectedId = cur
    this.setData({
      resumeNames: drafts.map((d) => (d.resumeName || '未命名简历') + (d.archived ? '（已归档）' : '')),
      resumeIndex: Math.max(0, ids.indexOf(cur)),
      hasDrafts: ids.length > 0,
      dirtyTip: !!cur && store.state.resume && store.state.resume.id === cur && !!store.state.dirty
    })
  },

  selectedDraft () {
    return (store.state.drafts || []).find((d) => d.id === this._selectedId) || null
  },

  onResume (e) {
    const i = Number(e.detail.value) || 0
    this._selectedId = this._ids[i] || ''
    this.buildResumes()
    if (this.data.result) this.setData({ stale: true })
  },

  /* ---------------- 剪贴板 ---------------- */

  checkClipboard () {
    if (typeof wx.getClipboardData !== 'function') return
    wx.getClipboardData({
      success: (res) => {
        const clip = String((res && res.data) || '')
        if (!shouldOfferClip(clip, lastClipHash(), this.data.jd)) {
          if (this.data.clipOffer) this.setData({ clipOffer: false })
          return
        }
        this._clip = clip
        const s = clip.trim().replace(/\s+/g, ' ')
        this.setData({ clipOffer: true, clipPreview: s.length > 40 ? s.slice(0, 40) + '…' : s })
      },
      fail: () => {}
    })
  },

  onPasteClip () {
    const text = this._clip || ''
    if (!text) return this.setData({ clipOffer: false })
    markClipHandled(text)
    this.setData({ jd: text.trim().slice(0, 8000), clipOffer: false })
    if (this.selectedDraft()) this.runMatch()
  },

  onDismissClip () {
    if (this._clip) markClipHandled(this._clip)
    this.setData({ clipOffer: false })
  },

  /* ---------------- JD 输入 / 匹配 ---------------- */

  onJdInput (e) {
    this.setData({ jd: e.detail.value, stale: !!this.data.result })
  },

  onClearJd () {
    this.setData({ jd: '', result: null, coverage: null, stale: false })
  },

  runMatch (silent) {
    const draft = this.selectedDraft()
    if (!draft) {
      if (silent !== true) wx.showToast({ title: '先去新建一份简历', icon: 'none' })
      return
    }
    if (!String(this.data.jd).trim()) {
      if (silent !== true) wx.showToast({ title: '先粘贴岗位描述', icon: 'none' })
      return
    }
    // 深拷贝冻结快照：匹配期间编辑器状态变化不影响本次结果
    const snap = JSON.parse(JSON.stringify(draft))
    const r = M.matchJD(snap, this.data.jd, this.data.customTerms)
    const cov = r.summary.coverage
    const deg = cov == null ? 0 : Math.round(cov * 3.6)
    this.setData({
      result: r,
      coverage: cov,
      ringStyle: 'background: conic-gradient(var(--ring-fill) ' + deg + 'deg, var(--ring-track) 0deg);',
      stale: false
    })
  },

  onMatch () {
    this.runMatch()
  },

  /* ---------------- 自定义关键词 ---------------- */

  onTermInput (e) {
    this.setData({ newTerm: e.detail.value })
  },

  onAddTerm () {
    const w = String(this.data.newTerm || '').trim()
    if (!w) return
    if (this.data.customTerms.some((x) => x.toLowerCase() === w.toLowerCase())) {
      wx.showToast({ title: '已在词表中', icon: 'none' })
      this.setData({ newTerm: '' })
      return
    }
    const list = this.data.customTerms.concat([w.slice(0, 40)])
    saveTerms(list)
    this.setData({ customTerms: list, newTerm: '' })
    if (this.data.result) this.runMatch(true)
  },

  onRemoveTerm (e) {
    const w = e.currentTarget.dataset.w
    const list = this.data.customTerms.filter((x) => x !== w)
    saveTerms(list)
    this.setData({ customTerms: list })
    if (this.data.result) this.runMatch(true)
  },

  /* ---------------- 点缺失 / 弱匹配词：复制 + 去补 ---------------- */

  onKeyword (e) {
    const w = e.currentTarget.dataset.w
    const group = e.currentTarget.dataset.g
    if (!w || group === 'hit') return
    const draft = this.selectedDraft()
    if (!draft) return
    const focus = M.guessSection(draft, w)
    // 避免回到本页时把这个关键词当成新 JD 提示
    markClipHandled(w)
    const go = () => {
      // 编辑器编辑的是 store.state.resume：先切到这份草稿（有未保存改动先落盘）
      if (store.state.resume && store.state.resume.id !== draft.id) {
        if (store.state.dirty) store.save(true)
        store.open(draft.id)
      }
      wx.navigateTo({
        url: '/pages/edit/edit?id=' + encodeURIComponent(draft.id) + '&focus=' + encodeURIComponent(focus)
      })
    }
    wx.setClipboardData({
      data: w,
      success: () => {
        wx.showToast({ title: '已复制关键词，去补到简历里', icon: 'none', duration: 1800 })
        go()
      },
      fail: () => go()
    })
  },

  /* ---------------- 记一笔投递 ---------------- */

  trackUrl () {
    const r = this.data.result
    const draft = this.selectedDraft()
    const guess = M.guessCompanyRole(this.data.jd)
    // 关键词：缺失在前（面试前最该准备的），其次弱匹配、命中；最多 20 个，控制 URL 长度
    let kws = []
    if (r) {
      const g = {}
      r.groups.forEach((x) => { g[x.id] = x.items })
      kws = (g.miss || []).concat(g.weak || [], g.hit || []).slice(0, 20)
    }
    const q = [
      'resumeId=' + encodeURIComponent(draft ? draft.id : ''),
      'company=' + encodeURIComponent(guess.company),
      'role=' + encodeURIComponent(guess.role),
      'keywords=' + encodeURIComponent(kws.join(','))
    ]
    return '/pages/track-edit/track-edit?' + q.join('&')
  },

  onTrack () {
    wx.navigateTo({ url: this.trackUrl() })
  },

  onGoCreate () {
    wx.switchTab({ url: '/pages/home/home' })
  }
})

// 供 tools/check-tools.cjs 直测剪贴板判定逻辑（小程序运行时 module.exports 无副作用）
module.exports = { shouldOfferClip }
