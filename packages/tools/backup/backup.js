/**
 * 数据备份与恢复（分包 tools）—— 对应参考站「数据管家」
 *
 *   备份全部：复制 JSON 到剪贴板 / 写成 .json 文件发到微信聊天（电脑上用网页版直接导入）
 *   恢复：从聊天里选 .json 文件，或从剪贴板粘贴 → 预览 + 同名查重 → 确认后导入
 *   清空：两次确认后删除全部简历草稿（投递记录不受影响）
 *
 * 备份格式与网页版逐字节一致（store.exportAllDraftsJSON = JSON.stringify(drafts, null, 2)）。
 * 预览态零写盘：取消即丢弃。
 */
const store = require('../../../utils/store.js')
const T = require('../../../utils/trackStore.js')
const B = require('./backupUtil.js')

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    view: 'main',
    draftCount: 0,
    trackCount: 0,
    storage: '已用 0 KB / 10 MB',
    storagePct: 0,
    canShareFile: true,
    // 导入预览
    source: '',
    rows: [],
    dupCount: 0,
    total: 0
  },

  onLoad () {
    const g = getApp().globalData || {}
    store.init()
    this._pending = []
    this.setData({
      statusBarHeight: g.statusBarHeight || 20,
      navBarHeight: g.navBarHeight || 44,
      canShareFile: typeof wx.shareFileMessage === 'function'
    })
  },

  onShow () {
    this.recalc()
  },

  recalc () {
    let info = null
    try {
      info = wx.getStorageInfoSync()
    } catch (e) {
      info = null
    }
    const st = B.storageText(info)
    this.setData({
      draftCount: (store.state.drafts || []).length,
      trackCount: T.loadTracks().length,
      storage: st.text,
      storagePct: Math.round(st.ratio * 100)
    })
  },

  /* ---------------- 备份 ---------------- */

  backupText () {
    // 先把编辑器里未落盘的改动存下来，备份才是最新的
    if (store.state.dirty) store.save(true)
    return store.exportAllDraftsJSON()
  },

  onCopyBackup () {
    if (!(store.state.drafts || []).length) return wx.showToast({ title: '还没有可备份的简历', icon: 'none' })
    const text = this.backupText()
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制 ' + store.state.drafts.length + ' 份简历的备份', icon: 'none' }),
      fail: () => wx.showModal({
        title: '复制失败',
        content: '备份内容可能太大（例如带了照片），请改用「发到微信聊天」。',
        showCancel: false
      })
    })
  },

  /**
   * 写文件 + 转发到聊天。
   * wx.shareFileMessage 需要在用户点击的同步调用链里触发，所以这里用 writeFileSync，
   * 不走异步写文件。
   */
  onShareBackup () {
    if (!(store.state.drafts || []).length) return wx.showToast({ title: '还没有可备份的简历', icon: 'none' })
    const text = this.backupText()
    if (typeof wx.shareFileMessage !== 'function') return this.fallbackCopy('当前微信版本不支持发送文件')
    const name = B.backupFileName()
    const dir = wx.env.USER_DATA_PATH + '/exports'
    const filePath = dir + '/' + name
    try {
      const fs = wx.getFileSystemManager()
      try { fs.mkdirSync(dir, true) } catch (e) {}
      fs.writeFileSync(filePath, text, 'utf8')
    } catch (e) {
      return this.fallbackCopy('写入备份文件失败')
    }
    wx.shareFileMessage({
      filePath,
      fileName: name,
      success: () => wx.showToast({ title: '已发送', icon: 'success' }),
      fail: (err) => {
        const msg = String((err && err.errMsg) || '')
        if (/cancel/i.test(msg)) return
        this.fallbackCopy('发送失败')
      }
    })
  },

  fallbackCopy (reason) {
    wx.showModal({
      title: reason,
      content: '可以改为复制备份内容，粘贴到「文件传输助手」保存。',
      confirmText: '复制',
      success: (r) => { if (r.confirm) this.onCopyBackup() }
    })
  },

  /* ---------------- 恢复 ---------------- */

  /** 解析 → 校验 → 查重 → 进预览；失败给出原因 */
  acceptText (text, source) {
    const res = B.parseBackup(text)
    if (!res.ok) {
      wx.showToast({ title: res.error, icon: 'none' })
      return false
    }
    const dedup = B.dedupByName(res.list, store.state.drafts)
    this._pending = res.list
    this.setData({
      view: 'preview',
      source: source || '',
      rows: B.previewRows(res.list, dedup),
      dupCount: dedup.dupCount,
      total: dedup.total
    })
    return true
  },

  onPickFile () {
    if (typeof wx.chooseMessageFile !== 'function') return wx.showToast({ title: '当前微信版本不支持选择聊天文件', icon: 'none' })
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['json', 'txt'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0]
        if (!f) return
        if (f.size > 8 * 1024 * 1024) return wx.showToast({ title: '文件太大了', icon: 'none' })
        wx.getFileSystemManager().readFile({
          filePath: f.path,
          encoding: 'utf8',
          success: (r) => this.acceptText(r.data, f.name || '聊天文件'),
          fail: () => wx.showToast({ title: '读取文件失败', icon: 'none' })
        })
      }
    })
  },

  onPasteImport () {
    wx.getClipboardData({
      success: (res) => {
        const s = String((res && res.data) || '').trim()
        if (!s) return wx.showToast({ title: '剪贴板是空的', icon: 'none' })
        this.acceptText(s, '剪贴板')
      }
    })
  },

  onCancelImport () {
    this._pending = []
    this.setData({ view: 'main', rows: [], source: '', dupCount: 0, total: 0 })
  },

  onConfirmImport () {
    this.doImport(false)
  },

  onImportSkipDup () {
    this.doImport(true)
  },

  doImport (skipDuplicates) {
    const list = this._pending || []
    if (!list.length) return this.onCancelImport()
    const r = B.importDrafts(store, list, { skipDuplicates })
    this._pending = []
    this.setData({ view: 'main', rows: [], source: '', dupCount: 0, total: 0 })
    if (r.ok) {
      const tail = r.skipped ? '，跳过同名 ' + r.skipped + ' 份' : ''
      wx.showToast({ title: '已导入 ' + r.count + ' 份' + tail, icon: 'none' })
    } else {
      wx.showModal({ title: '导入失败', content: '本地存储空间可能不足，请先删除不用的简历再试。', showCancel: false })
    }
    this.recalc()
  },

  /* ---------------- 清空 ---------------- */

  onClear () {
    const n = (store.state.drafts || []).length
    if (!n) return wx.showToast({ title: '已经没有简历了', icon: 'none' })
    wx.showModal({
      title: '清空全部简历？',
      content: '将删除本机上的 ' + n + ' 份简历草稿。建议先「备份全部」。投递记录不受影响。',
      confirmText: '继续',
      confirmColor: '#b3261e',
      success: (r1) => {
        if (!r1.confirm) return
        wx.showModal({
          title: '再确认一次',
          content: '清空后无法恢复，确定删除全部 ' + n + ' 份简历？',
          confirmText: '确认清空',
          confirmColor: '#b3261e',
          success: (r2) => {
            if (!r2.confirm) return
            store.clearAll()
            wx.showToast({ title: '已清空', icon: 'none' })
            this.recalc()
          }
        })
      }
    })
  }
})
