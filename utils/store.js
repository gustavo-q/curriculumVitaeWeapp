/**
 * 全局简历 Store —— 移植自参考站 src/stores/resume.js（Pinia → 单例模块）
 *
 * 小程序没有 Pinia，这里用一个模块级单例承担同样的职责：
 *   · 页面直接读 store.state.resume / store.state.drafts，调 action 后由 store 统一广播
 *     （另有一个 getState() 返回深拷贝快照，目前没有页面使用，保留作外部只读入口）
 *   · 持久化改用 wx.setStorageSync（对应参考站的 localStorage）
 *   · 撤销 / 重做沿用参考站的「整份简历 JSON 全量快照」策略：
 *     数据量小、不会漏字段，连续输入会合并为一步，符合直觉。
 */

const {
  createBlankResume,
  createDefaultResume,
  normalizeResume,
  COLOR_PRESETS,
  getTemplate,
  applyTemplateToResume,
  nextId
} = require('./model.js')

const LS_DRAFTS = 'pb_drafts_v1'
const LS_CURRENT = 'pb_current_v1'

const clone = (o) => JSON.parse(JSON.stringify(o))

function readDrafts () {
  try {
    const arr = wx.getStorageSync(LS_DRAFTS)
    return Array.isArray(arr) ? arr : []
  } catch (e) {
    return []
  }
}

/**
 * 存储里是否已经写过草稿列表（哪怕是空数组）。
 *
 * 用来区分两种「一份草稿都没有」：
 *   · 键不存在（返回 ''）→ 第一次使用，应当播种示例简历；
 *   · 键存在但值是 []    → 用户主动清空 / 删光了最后一份，必须保持空态。
 * 之前不区分这两者，清空后一重启示例简历又回来了，看起来就像「清空不了」。
 */
function hasDraftsKey () {
  try {
    return wx.getStorageSync(LS_DRAFTS) !== ''
  } catch (e) {
    return false
  }
}

function writeDrafts (list) {
  try {
    wx.setStorageSync(LS_DRAFTS, list)
    return true
  } catch (e) {
    // 存储空间不足时静默失败，不阻塞编辑（与参考站一致）
    return false
  }
}

const state = {
  resume: createDefaultResume(),
  drafts: [],
  savedAt: 0,
  dirty: false,
  initialized: false,
  /** 最近一次保存时内容的快照，用于精确判断是否有未保存改动 */
  lastSavedJSON: '',
  /** 最近一次落盘是否成功；false 表示「有改动但没写进去」，UI 必须据此提示 */
  lastSaveOk: true,

  /* ---------- 撤销 / 重做内部状态 ---------- */
  _entries: [],
  _index: 0,
  _textOpen: false,
  _historyType: 'other',
  _undoLoading: false
}

/* ---------------- 订阅：任何变更都通知所有页面刷新 ---------------- */
const listeners = []
function subscribe (fn) {
  listeners.push(fn)
  return () => {
    const i = listeners.indexOf(fn)
    if (i >= 0) listeners.splice(i, 1)
  }
}
function emit () {
  listeners.slice().forEach((fn) => {
    try {
      fn()
    } catch (e) {
      console.error('[store] listener error', e)
    }
  })
}

const cloneResume = () => clone(state.resume)

/** 只读快照：页面 setData 用（深拷贝，避免页面直接改到 store 内部对象） */
function getState () {
  return {
    resume: clone(state.resume),
    drafts: clone(state.drafts),
    savedAt: state.savedAt,
    dirty: state.dirty,
    initialized: state.initialized
  }
}

const getters = {
  template: () => getTemplate(state.resume.templateId),
  visibleSections: () => state.resume.sections.filter((x) => x.visible),
  resumeTitle: () => state.resume.resumeName || '未命名简历',
  canUndo: () => state._index > 0,
  canRedo: () => state._index < state._entries.length - 1
}

/* ---------------- 撤销 / 重做 ---------------- */

/** 序列化当前简历；忽略每次保存都会变的 updateDatetime，避免无意义的历史点 */
function snapshotJson () {
  return JSON.stringify(state.resume, (key, value) => (key === 'updateDatetime' ? undefined : value))
}

function snapshot () {
  if (state._undoLoading) return
  const json = snapshotJson()
  if (json === state._entries[state._index]) return
  if (state._historyType === 'text' && state._textOpen) {
    // 同一串连续输入：覆盖当前历史点，与其合并为一步
    state._entries[state._index] = json
  } else {
    state._entries.splice(state._index + 1)
    state._entries.push(json)
    if (state._entries.length > 60) state._entries.shift()
    state._index = state._entries.length - 1
    state._textOpen = state._historyType === 'text'
  }
  state._historyType = 'other'
}

/** 声明本次改动来自连续键入（true 时与同一串输入合并为一步撤销） */
function typingIfEditing (editing) {
  state._historyType = editing ? 'text' : 'other'
}

function commitTextHistory () {
  state._textOpen = false
  state._historyType = 'other'
}

function restore (json) {
  state._undoLoading = true
  state.resume = normalizeResume(JSON.parse(json))
  state.resume.updateDatetime = Date.now()
  try {
    wx.setStorageSync(LS_CURRENT, state.resume.id)
  } catch (e) {}
  refreshDirty()
  state._undoLoading = false
}

function resetHistory () {
  state._entries = [snapshotJson()]
  state._index = 0
  state._textOpen = false
  state._historyType = 'other'
}

/**
 * 判断「当前内容是否与已保存的一致」。
 *
 * 比较时必须排除 updateDatetime —— 它每次保存都会变成新值，
 * 而 restore()（撤销/重做）也会刷新它。若用完整 JSON 比较，
 * 「改一个字 → 撤销回原样」之后 dirty 会误报 true：
 * 界面一直显示「未保存」，退出时还会多做一次无意义的落盘。
 * 口径与 snapshotJson() 保持一致。
 */
function contentJson (resume) {
  return JSON.stringify(resume, (key, value) => (key === 'updateDatetime' ? undefined : value))
}

function refreshDirty () {
  state.dirty = contentJson(state.resume) !== state.lastSavedJSON
}

/* ---------------- 生命周期 ---------------- */

/**
 * 启动：优先恢复上次编辑。
 *
 * 只有**第一次使用**（存储里从来没有过草稿列表）才播种示例简历；
 * 存储里已有列表但为空，说明用户清空过或删光了，此时保持空态，
 * 否则「清空」在一重启之后就被撤销，用户看到的就是「清空不了」。
 */
function init () {
  if (state.initialized) return state.resume
  const list = readDrafts()
  state.drafts = list
  let currentId = ''
  try {
    currentId = wx.getStorageSync(LS_CURRENT) || ''
  } catch (e) {}
  const found = list.find((d) => d.id === currentId) || list[0]
  state.initialized = true

  if (found) {
    state.resume = normalizeResume(clone(found))
    state.savedAt = state.resume.updateDatetime || 0
    state.lastSavedJSON = contentJson(state.resume)
    state.dirty = false
  } else if (hasDraftsKey()) {
    // 用户主动清空 / 删光最后一份：保持空态，不播种示例。
    // 仍然准备一份内存里的默认简历，供「新建」与空态页的预览使用；
    // 它不落盘，也不会出现在草稿列表里。
    state.resume = createDefaultResume()
    state.savedAt = 0
    state.lastSavedJSON = contentJson(state.resume)
    state.dirty = false
  } else {
    // 首次使用：播种示例简历
    state.resume = createDefaultResume()
    save(true)
  }
  resetHistory()
  emit()
  return state.resume
}

function save (silent) {
  snapshot()
  state.resume.updateDatetime = Date.now()
  const snap = clone(state.resume)
  const i = state.drafts.findIndex((d) => d.id === snap.id)
  if (i >= 0) state.drafts[i] = snap
  else state.drafts.unshift(snap)
  /*
   * 落盘失败必须如实反映，不能「看起来已保存」。
   *
   * wx.setStorageSync 在存储写满（单 key 上限约 1MB、总量 10MB）时会抛错，
   * 而简历里可能带 base64 照片、草稿又多，撞上这个上限是完全可能的。
   * 原实现吞掉异常后照样把 dirty 清成 false、savedAt 设为当前时间，
   * 于是界面显示「已保存 12:34」而数据实际没写进去 —— 用户关掉小程序就丢稿，
   * 而且没有任何机会补救。
   *
   * 现在：写失败时保留 dirty（下次自动保存会重试）、不更新 savedAt，
   * 并置 lastSaveOk=false 供页面提示用户去「备份全部」。
   */
  const ok = writeDrafts(state.drafts)
  state.lastSaveOk = ok
  try {
    wx.setStorageSync(LS_CURRENT, snap.id)
  } catch (e) {}
  if (ok) {
    state.savedAt = snap.updateDatetime
    state.lastSavedJSON = contentJson(snap)
    state.dirty = false
  }
  if (!silent) emit()
  return ok
}

function undo () {
  if (state._index <= 0) return false
  state._textOpen = false
  state._index -= 1
  restore(state._entries[state._index])
  emit()
  return true
}

function redo () {
  if (state._index >= state._entries.length - 1) return false
  state._textOpen = false
  state._index += 1
  restore(state._entries[state._index])
  emit()
  return true
}

/* ---------------- 草稿管理 ---------------- */

function create (opts) {
  const o = opts || {}
  const r = o.blank ? createBlankResume() : createDefaultResume()
  state.resume = r
  if (o.templateId) applyTemplateToResume(state.resume, o.templateId)
  save(true)
  resetHistory()
  emit()
  return state.resume
}

function duplicate (id) {
  const src = state.drafts.find((d) => d.id === id)
  if (!src) return null
  const copy = normalizeResume(clone(src))
  copy.id = 'r_' + Date.now().toString(36)
  copy.resumeName = (copy.resumeName || '未命名简历') + ' 副本'
  copy.updateDatetime = Date.now()
  state.drafts.unshift(copy)
  writeDrafts(state.drafts)
  emit()
  return copy
}

function remove (id) {
  snapshot()
  const i = state.drafts.findIndex((d) => d.id === id)
  if (i >= 0) state.drafts.splice(i, 1)
  writeDrafts(state.drafts)
  if (state.resume.id === id) {
    const next = state.drafts[0]
    if (next) {
      state.resume = normalizeResume(clone(next))
      try {
        wx.setStorageSync(LS_CURRENT, state.resume.id)
      } catch (e) {}
      save(true)
    } else {
      /*
       * 删掉的是最后一份草稿：必须停在空态。
       *
       * 原来无条件走 save(true)，而 save() 会把 state.resume 重新 unshift 进
       * drafts —— 于是「删除最后一份」等于「把一份示例简历恢复出来」，
       * 用户看到草稿列表永远是 1 份，删不掉也清不空。
       */
      state.resume = createDefaultResume()
      try {
        wx.removeStorageSync(LS_CURRENT)
      } catch (e) {}
      state.savedAt = 0
      state.lastSavedJSON = contentJson(state.resume)
      state.dirty = false
    }
    resetHistory()
  }
  emit()
}

function open (id) {
  const found = state.drafts.find((d) => d.id === id)
  if (!found) return false
  state.resume = normalizeResume(clone(found))
  try {
    wx.setStorageSync(LS_CURRENT, id)
  } catch (e) {}
  state.savedAt = state.resume.updateDatetime || 0
  state.lastSavedJSON = contentJson(state.resume)
  state.dirty = false
  resetHistory()
  emit()
  return true
}

/* ---------------- 编辑动作 ---------------- */

function applyColorPreset (id) {
  snapshot()
  const p = COLOR_PRESETS.find((c) => c.id === id) || COLOR_PRESETS[0]
  state.resume.headingColor = p.value
  state.resume.headingSecondColor = p.second
  state.resume.borderColor = p.value
  save()
}

/** 应用模板：整体风格 + 配色 + 字体 + 排版尺寸（保留内容） */
function applyTemplate (templateId, opts) {
  const o = opts || {}
  if (!getTemplate(templateId)) return
  snapshot()
  applyTemplateToResume(state.resume, templateId)
  if (o.keepContent === false) {
    const fresh = createDefaultResume()
    state.resume.sections = fresh.sections
    state.resume.baseInfo = fresh.baseInfo
    state.resume.baseFields = fresh.baseFields
  }
  save()
}

function toggleField (key) {
  snapshot()
  const i = state.resume.baseFields.indexOf(key)
  if (i >= 0) state.resume.baseFields.splice(i, 1)
  else state.resume.baseFields.push(key)
  save()
}

function setBaseInfo (key, value) {
  state.resume.baseInfo[key] = value
  refreshDirty()
  emit()
}

function setResumeName (name) {
  state.resume.resumeName = name
  refreshDirty()
  emit()
}

/** 通用字段写入：style 面板上的下拉 / 滑杆都走它 */
function setStyle (key, value) {
  state.resume[key] = value
  if (key === 'headingColor') state.resume.borderColor = value
  refreshDirty()
  emit()
}

function addSection (title, type) {
  snapshot()
  state.resume.sections.push({
    id: nextId(),
    title: title || '自定义区块',
    visible: true,
    items: [
      { id: nextId(), type: type || 'THREE', leftContent: '', centerContent: '', rightContent: '' }
    ]
  })
  save()
}

function removeSection (id) {
  snapshot()
  const i = state.resume.sections.findIndex((s) => s.id === id)
  if (i >= 0) state.resume.sections.splice(i, 1)
  save()
}

function moveSection (id, dir) {
  snapshot()
  const list = state.resume.sections
  const i = list.findIndex((s) => s.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= list.length) return
  const s = list.splice(i, 1)[0]
  list.splice(j, 0, s)
  save()
}

/**
 * 把区块移动到指定下标（拖动排序用）。
 *
 * 与 moveSection 的「相对方向」不同，这里接收的是落点下标：
 * 拖动手势算出的是「用户松手时落在第几行」，用绝对下标表达最直接，
 * 也避免「上移一格」在跨越多个行时被反复调用。
 */
function moveSectionTo (id, index) {
  const list = state.resume.sections
  const from = list.findIndex((s) => s.id === id)
  if (from < 0) return false
  const to = Math.max(0, Math.min(list.length - 1, Math.floor(index)))
  if (to === from) return false
  snapshot()
  const s = list.splice(from, 1)[0]
  list.splice(to, 0, s)
  save()
  return true
}

function toggleSectionVisible (id) {
  snapshot()
  const s = state.resume.sections.find((x) => x.id === id)
  if (!s) return
  s.visible = s.visible === false
  save()
}

function setSectionTitle (id, title) {
  const s = state.resume.sections.find((x) => x.id === id)
  if (!s) return
  s.title = title
  refreshDirty()
  emit()
}

function addItem (sectionId, type) {
  snapshot()
  const s = state.resume.sections.find((x) => x.id === sectionId)
  if (!s) return
  s.items.push({ id: nextId(), type: type || 'THREE', leftContent: '', centerContent: '', rightContent: '' })
  save()
}

function removeItem (sectionId, itemId) {
  snapshot()
  const s = state.resume.sections.find((x) => x.id === sectionId)
  if (!s) return
  const i = s.items.findIndex((x) => x.id === itemId)
  if (i >= 0) s.items.splice(i, 1)
  save()
}

function moveItem (sectionId, itemId, dir) {
  snapshot()
  const s = state.resume.sections.find((x) => x.id === sectionId)
  if (!s) return
  const i = s.items.findIndex((x) => x.id === itemId)
  const j = i + dir
  if (i < 0 || j < 0 || j >= s.items.length) return
  const it = s.items.splice(i, 1)[0]
  s.items.splice(j, 0, it)
  save()
}

/** 把条目移动到指定下标（拖动排序用，语义同 moveSectionTo） */
function moveItemTo (sectionId, itemId, index) {
  const s = state.resume.sections.find((x) => x.id === sectionId)
  if (!s) return false
  const from = s.items.findIndex((x) => x.id === itemId)
  if (from < 0) return false
  const to = Math.max(0, Math.min(s.items.length - 1, Math.floor(index)))
  if (to === from) return false
  snapshot()
  const it = s.items.splice(from, 1)[0]
  s.items.splice(to, 0, it)
  save()
  return true
}

function setItemType (sectionId, itemId, type) {
  snapshot()
  const s = state.resume.sections.find((x) => x.id === sectionId)
  const it = s && s.items.find((x) => x.id === itemId)
  if (!it) return
  it.type = type
  save()
}

function setItemField (sectionId, itemId, field, value) {
  const s = state.resume.sections.find((x) => x.id === sectionId)
  const it = s && s.items.find((x) => x.id === itemId)
  if (!it) return
  it[field] = value
  refreshDirty()
  emit()
}

function setPhotoField (key, value) {
  state.resume[key] = value
  refreshDirty()
  emit()
}

/**
 * 导入 JSON。支持单份简历对象，也支持「备份全部」导出的数组。
 * 返回导入的份数。
 */
function importJSON (text, opts) {
  const o = opts || {}
  const data = JSON.parse(text)
  const arr = Array.isArray(data) ? data : [data]
  const imported = arr.map((d) => {
    const r = normalizeResume(d)
    r.id = 'r_' + nextId()
    r.updateDatetime = Date.now()
    return r
  })
  if (o.asDraftList) {
    state.drafts = imported.concat(state.drafts)
    writeDrafts(state.drafts)
    emit()
    return imported.length
  }
  state.resume = imported[0]
  save(true)
  resetHistory()
  emit()
  return imported.length
}

function exportJSON () {
  return JSON.stringify(state.resume, null, 2)
}

function exportAllDraftsJSON () {
  return JSON.stringify(state.drafts, null, 2)
}

/**
 * 删除全部草稿（危险操作，UI 层需二次确认）。
 *
 * 关键点：清空之后**不能再调 save()**。save() 的语义是「把当前简历写进草稿列表」，
 * 刚清空的列表会被它立刻塞回一份示例简历，用户看到的就是「点了清空、简历还在」。
 * 这里只落盘空列表 + 清掉当前草稿指针，并为「新建」准备一份内存中的默认简历。
 */
function clearAll () {
  state.drafts = []
  writeDrafts(state.drafts)
  try {
    wx.removeStorageSync(LS_CURRENT)
  } catch (e) {}
  state.resume = createDefaultResume()
  state.savedAt = 0
  state.lastSavedJSON = contentJson(state.resume)
  state.dirty = false
  resetHistory()
  emit()
}

module.exports = {
  state,
  subscribe,
  emit,
  getState,
  getters,
  init,
  save,
  refreshDirty,
  snapshot,
  typingIfEditing,
  commitTextHistory,
  undo,
  redo,
  resetHistory,
  create,
  duplicate,
  remove,
  open,
  applyColorPreset,
  applyTemplate,
  toggleField,
  setBaseInfo,
  setResumeName,
  setStyle,
  addSection,
  removeSection,
  moveSection,
  moveSectionTo,
  toggleSectionVisible,
  setSectionTitle,
  addItem,
  removeItem,
  moveItem,
  moveItemTo,
  setItemType,
  setItemField,
  setPhotoField,
  importJSON,
  exportJSON,
  exportAllDraftsJSON,
  clearAll,
  cloneResume
}
