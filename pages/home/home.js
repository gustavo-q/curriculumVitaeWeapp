/**
 * Tab「简历」：草稿列表（手机端重做 v1）
 *
 *   卡片点击       → 打开编辑器
 *   点标题         → 就地改名
 *   左滑           → 复制 · 归档 · 删除（删除二次确认）
 *   长按拖动       → 调整顺序（只在未归档子集内排序，与参考站 moveDraft 同语义）
 *   底部「已归档 N」→ 折叠区；点开、左滑 恢复 · 删除
 *   右下 ＋        → 新建示例 / 新建空白 / 从聊天文件导入
 *
 * 手势统一用 touchstart/move/end 状态机判定，不用 bindtap：
 * 拖动或长按结束后系统仍可能补一个 tap，会误开编辑器。
 */
const store = require('../../utils/store.js')
const { normalizeResume, TEMPLATES } = require('../../utils/model.js')
const { buildPaperVM } = require('../../utils/paper.js')
const { toast, fmtTime } = require('../../utils/export.js')

const app = getApp()

/** 缩略图容器尺寸（与 home.wxss 的 .thumb 一致，A4 比例） */
const THUMB_W_RPX = 168
const THUMB_H_RPX = 238
const A4_W = 794
const A4_H = 1123

/** 左滑动作宽度（rpx），必须与 home.wxss 的 .acts-3 / .acts-2 一致 */
const ACTS_W = { active: 408, archived: 272 }

function windowWidth () {
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    return info.windowWidth || 375
  } catch (e) {
    return 375
  }
}

function thumbScale () {
  const k = windowWidth() / 750
  return Math.min((THUMB_W_RPX * k) / A4_W, (THUMB_H_RPX * k) / A4_H)
}

function templateName (id) {
  return (TEMPLATES.find((t) => t.id === id) || TEMPLATES[0]).name
}

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    thumbScale: 0.1,
    cards: [],
    archived: [],
    archivedOpen: false,
    total: 0,
    renamingId: '',
    renameValue: '',
    dragId: '',
    dropIndex: -1,
    movingId: '',
    scrollEnabled: true
  },

  onLoad () {
    const g = app.globalData || {}
    store.init()
    this.setData({
      statusBarHeight: g.statusBarHeight || 20,
      navBarHeight: g.navBarHeight || 44,
      thumbScale: thumbScale()
    })
    this.unsubscribe = store.subscribe(() => this.refresh())
    this.refresh()
  },

  onUnload () {
    if (this.unsubscribe) this.unsubscribe()
  },

  onShow () {
    this._hidden = false
    this.refresh()
  },

  /* 编辑器压在上面时首页不可见：store 的每次广播都重建全部缩略图太浪费，回来再刷 */
  onHide () {
    this._hidden = true
  },

  onResize () {
    this.setData({ thumbScale: thumbScale() })
  },

  refresh () {
    if (this._hidden) return
    // 拖动 / 改名进行中不重建列表，避免手势状态与行数据错位
    if (this._touch && this._touch.mode === 'drag') return
    const currentId = store.state.resume.id
    const cards = store.activeDrafts().map((d) => {
      const r = normalizeResume(d)
      return {
        id: d.id,
        name: d.resumeName || '未命名简历',
        time: fmtTime(d.updateDatetime),
        sectionCount: (d.sections || []).length,
        templateName: templateName(r.templateId),
        isCurrent: d.id === currentId,
        vm: buildPaperVM(r, { editable: false }),
        offsetX: 0,
        offsetY: 0
      }
    })
    const archived = store.archivedDrafts().map((d) => ({
      id: d.id,
      name: d.resumeName || '未命名简历',
      time: fmtTime(d.archivedAt || d.updateDatetime),
      offsetX: 0
    }))
    this.setData({
      cards,
      archived,
      total: cards.length + archived.length,
      archivedOpen: archived.length ? this.data.archivedOpen : false
    })
  },

  /* ================= 新建 / 导入 ================= */

  onFab () {
    const actions = ['新建示例简历', '新建空白简历', '从聊天文件导入']
    wx.showActionSheet({
      itemList: actions,
      success: (res) => {
        const label = actions[res.tapIndex]
        if (label === '新建示例简历') this.onCreateSample()
        else if (label === '新建空白简历') this.onCreateBlank()
        else if (label === '从聊天文件导入') this.onImportFile()
      },
      fail: () => {}
    })
  },

  saveCurrentIfDirty () {
    if (store.state.dirty) store.save(true)
  },

  onCreateSample () {
    this.saveCurrentIfDirty()
    store.create({ blank: false })
    wx.navigateTo({ url: '/pages/edit/edit' })
  },

  onCreateBlank () {
    this.saveCurrentIfDirty()
    store.create({ blank: true })
    wx.navigateTo({ url: '/pages/edit/edit' })
  },

  /**
   * 从聊天文件导入：电脑端「导出 JSON / 备份全部」发到微信，这里选那份文件。
   * Web ↔ 小程序同一数据结构，单份 / 备份数组都能读。
   */
  onImportFile () {
    if (typeof wx.chooseMessageFile !== 'function') {
      toast('当前微信版本不支持选择聊天文件')
      return
    }
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['json'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0]
        if (!f) return
        if (f.size > 8 * 1024 * 1024) {
          toast('文件太大（超过 8MB）')
          return
        }
        try {
          wx.getFileSystemManager().readFile({
            filePath: f.path,
            encoding: 'utf8',
            success: (r) => this.handleImportText(r.data),
            fail: () => toast('读取文件失败')
          })
        } catch (e) {
          toast('读取文件失败')
        }
      },
      fail: () => {}
    })
  },

  /** 解析 → 查重 → 确认 → 写入。拆出来便于测试。 */
  handleImportText (text) {
    const parsed = store.parseImport(text)
    if (!parsed.ok) {
      wx.showModal({ title: '无法导入', content: parsed.error, showCancel: false })
      return
    }
    const n = parsed.list.length
    const keepArchived = parsed.kind === 'backup'
    const dup = parsed.dup
    if (!dup.dupCount) {
      this.finishImport(parsed.list, { keepArchived })
      return
    }
    const names = dup.dupNames.slice(0, 3).join('、') + (dup.dupNames.length > 3 ? ' 等' : '')
    const fresh = n - dup.dupCount
    const actions = ['全部导入（' + n + ' 份，同名也保留）']
    if (fresh > 0) actions.push('跳过同名，只导入 ' + fresh + ' 份')
    wx.showActionSheet({
      alertText: '其中 ' + dup.dupCount + ' 份与现有简历同名：' + names,
      itemList: actions,
      success: (res) => {
        if (res.tapIndex === 0) this.finishImport(parsed.list, { keepArchived })
        else if (res.tapIndex === 1) this.finishImport(parsed.list, { keepArchived, skipDuplicates: true })
      },
      fail: () => {}
    })
  },

  finishImport (list, opts) {
    const r = store.importDrafts(list, opts)
    if (r.error) {
      toast(r.error)
      return r
    }
    if (r.added) {
      // 归档的备份项也导入了：展开归档区，免得用户以为少了
      if (list.some((d) => d && d.archived === true) && opts && opts.keepArchived) {
        this.setData({ archivedOpen: true })
      }
      toast('已导入 ' + r.added + ' 份' + (r.skipped ? '，跳过 ' + r.skipped + ' 份' : ''))
    } else {
      toast('没有新的简历需要导入')
    }
    return r
  },

  /* ================= 打开 / 改名 ================= */

  openDraft (id) {
    if (store.state.resume.id !== id) {
      this.saveCurrentIfDirty()
      if (!store.open(id)) return
    }
    wx.navigateTo({ url: '/pages/edit/edit' })
  },

  startRename (id) {
    const d = store.state.drafts.find((x) => x.id === id)
    if (!d) return
    this.setData({ renamingId: id, renameValue: d.resumeName || '' })
  },

  onRenameInput (e) {
    this._renameValue = e.detail.value
  },

  onRenameDone (e) {
    const id = this.data.renamingId
    if (!id) return
    const v = e && e.detail && e.detail.value != null ? e.detail.value : this._renameValue
    this._renameValue = null
    this.setData({ renamingId: '', renameValue: '' })
    const name = String(v == null ? '' : v).trim()
    if (!name) {
      toast('名称不能为空')
      return
    }
    if (store.renameDraft(id, name)) toast('已重命名')
  },

  /* ================= 卡片手势 ================= */

  _LONG_PRESS_MS: 420,
  _TAP_SLOP_PX: 8,
  _SWIPE_SLOP_PX: 12,
  _touch: null,

  rpxOf (px) {
    if (!this._rpx) this._rpx = 750 / windowWidth()
    return px * this._rpx
  },

  listOf (kind) {
    return kind === 'archived' ? this.data.archived : this.data.cards
  },

  keyOf (kind) {
    return kind === 'archived' ? 'archived' : 'cards'
  },

  onTouchStart (e) {
    const touch = e.touches && e.touches[0]
    if (!touch) return
    const ds = e.currentTarget.dataset
    const kind = ds.kind === 'archived' ? 'archived' : 'active'
    const list = this.listOf(kind)
    const index = list.findIndex((x) => x.id === ds.id)
    if (index < 0) return
    // 别的行左滑开着：先收起
    this.closeOpenRows(ds.id)
    const role = (e.target && e.target.dataset && e.target.dataset.role) || ''
    this._touch = {
      kind,
      id: ds.id,
      index,
      dropIndex: index,
      role,
      startX: touch.clientX,
      startY: touch.clientY,
      openX: list[index].offsetX || 0,
      offsetX: list[index].offsetX || 0,
      mode: 'idle',
      rects: [],
      timer: null
    }
    if (kind === 'active' && !this.data.renamingId) {
      this._touch.timer = setTimeout(() => this.enterDrag(), this._LONG_PRESS_MS)
    }
  },

  enterDrag () {
    const t = this._touch
    if (!t || t.mode !== 'idle') return
    wx.createSelectorQuery()
      .in(this)
      .selectAll('.draft-card')
      .boundingClientRect()
      .exec((res) => {
        const cur = this._touch
        if (!cur || cur !== t || cur.mode !== 'idle') return
        cur.rects = (res && res[0]) || []
        cur.mode = 'drag'
        this.setData({ dragId: cur.id, dropIndex: cur.index, scrollEnabled: false, movingId: cur.id })
        if (wx.vibrateShort) wx.vibrateShort({ type: 'light', fail: () => {} })
      })
  },

  onTouchMove (e) {
    const t = this._touch
    const touch = e.touches && e.touches[0]
    if (!t || !touch) return
    const dx = touch.clientX - t.startX
    const dy = touch.clientY - t.startY

    if (t.mode === 'idle') {
      if (Math.abs(dx) <= this._TAP_SLOP_PX && Math.abs(dy) <= this._TAP_SLOP_PX) return
      this.clearTimer()
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > this._SWIPE_SLOP_PX && !this.data.renamingId) {
        t.mode = 'swipe'
      } else {
        t.mode = 'scroll'
        return
      }
    }

    if (t.mode === 'swipe') {
      const max = ACTS_W[t.kind]
      const x = Math.max(-max, Math.min(0, t.openX + this.rpxOf(dx)))
      t.offsetX = x
      if (this.data.movingId !== t.id) this.setData({ movingId: t.id })
      this.patchRow(t.kind, t.id, { offsetX: x })
      return
    }

    if (t.mode === 'drag') {
      this.patchRow('active', t.id, { offsetY: this.rpxOf(dy) })
      const idx = this.dropIndexAt(touch.clientY)
      if (idx !== t.dropIndex) {
        t.dropIndex = idx
        this.setData({ dropIndex: idx })
      }
    }
  },

  onTouchEnd () {
    const t = this._touch
    if (!t) return
    this.clearTimer()
    this._touch = null

    if (t.mode === 'drag') {
      this.setData({ dragId: '', dropIndex: -1, scrollEnabled: true, movingId: '' })
      this.patchRow('active', t.id, { offsetY: 0 })
      if (t.dropIndex !== t.index && store.moveDraft(t.id, t.dropIndex)) toast('顺序已调整')
      return
    }
    if (t.mode === 'swipe') {
      const open = t.offsetX <= -ACTS_W[t.kind] / 2
      this.setData({ movingId: '' })
      this.patchRow(t.kind, t.id, { offsetX: open ? -ACTS_W[t.kind] : 0 })
      return
    }
    if (t.mode === 'scroll') return

    // 点击
    if (t.openX !== 0) {
      this.patchRow(t.kind, t.id, { offsetX: 0 })
      return
    }
    if (this.data.renamingId) return
    if (t.kind === 'active' && t.role === 'title') {
      this.startRename(t.id)
      return
    }
    this.openDraft(t.id)
  },

  onTouchCancel () {
    const t = this._touch
    if (!t) return
    this.clearTimer()
    this._touch = null
    this.setData({ dragId: '', dropIndex: -1, scrollEnabled: true, movingId: '' })
    this.patchRow(t.kind, t.id, { offsetX: t.mode === 'swipe' ? 0 : t.openX, offsetY: 0 })
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

  patchRow (kind, id, patch) {
    const key = this.keyOf(kind)
    const list = this.data[key]
    const i = list.findIndex((x) => x.id === id)
    if (i < 0) return
    const next = {}
    Object.keys(patch).forEach((k) => { next[key + '[' + i + '].' + k] = patch[k] })
    this.setData(next)
  },

  closeOpenRows (exceptId) {
    const next = {}
    ;['cards', 'archived'].forEach((key) => {
      this.data[key].forEach((x, i) => {
        if (x.id !== exceptId && x.offsetX) next[key + '[' + i + '].offsetX'] = 0
      })
    })
    if (Object.keys(next).length) this.setData(next)
  },

  /* ================= 左滑动作 ================= */

  onDuplicate (e) {
    const c = store.duplicate(e.currentTarget.dataset.id)
    if (c) toast('已复制「' + c.resumeName + '」')
  },

  onArchive (e) {
    const id = e.currentTarget.dataset.id
    this.saveCurrentIfDirty()
    if (store.archive(id)) toast('已归档，可在底部「已归档」找回')
  },

  onUnarchive (e) {
    if (store.unarchive(e.currentTarget.dataset.id)) toast('已恢复')
  },

  onDelete (e) {
    const id = e.currentTarget.dataset.id
    const d = store.state.drafts.find((x) => x.id === id)
    if (!d) return
    wx.showModal({
      title: '删除这份简历？',
      content: '「' + (d.resumeName || '未命名简历') + '」删除后不可恢复。',
      confirmText: '删除',
      confirmColor: '#b3261e',
      success: (res) => {
        if (!res.confirm) {
          this.closeOpenRows('')
          return
        }
        store.remove(id)
        toast('已删除')
      }
    })
  },

  onToggleArchived () {
    this.setData({ archivedOpen: !this.data.archivedOpen })
  },

  /* tap 兜底：动作按钮用 catchtap，这里只为阻止冒泡占位 */
  noop () {}
})
