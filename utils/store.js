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
  _undoLoading: false,

  /** 跨页「已删除 · 撤销」信号，见 markDeleted() */
  undoHint: null
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
  if (i >= 0) {
    /*
     * 归档元数据以草稿列表里那份为准（与参考站 save() 同口径）：
     * 内容保存不得改变归档状态，归档 / 恢复只走 archive()/unarchive()。
     * 否则撤销回到「归档前」的快照再自动保存，会把归档悄悄抹掉。
     */
    const persisted = state.drafts[i]
    if (persisted && persisted.archived === true) {
      snap.archived = true
      snap.archivedAt = persisted.archivedAt
    } else {
      delete snap.archived
      delete snap.archivedAt
    }
    state.drafts[i] = snap
  } else {
    state.drafts.unshift(snap)
  }
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
  // 副本一律是未归档的新简历（参考站审查 L3）
  delete copy.archived
  delete copy.archivedAt
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
  const id = nextId()
  state.resume.sections.push({
    id,
    title: title || '自定义区块',
    visible: true,
    items: [
      { id: nextId(), type: type || 'THREE', leftContent: '', centerContent: '', rightContent: '' }
    ]
  })
  save()
  return id
}

function removeSection (id) {
  snapshot()
  const i = state.resume.sections.findIndex((s) => s.id === id)
  if (i < 0) return false
  state.resume.sections.splice(i, 1)
  save()
  return true
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
  const id = nextId()
  s.items.push({ id, type: type || 'THREE', leftContent: '', centerContent: '', rightContent: '' })
  save()
  return id
}

function removeItem (sectionId, itemId) {
  snapshot()
  const s = state.resume.sections.find((x) => x.id === sectionId)
  if (!s) return
  const i = s.items.findIndex((x) => x.id === itemId)
  if (i < 0) return false
  s.items.splice(i, 1)
  save()
  return true
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


/* ================================================================== */
/*  手机端重做（v1）新增：草稿列表管理 / 导入 / 跨简历复制 / 条目工具      */
/* ================================================================== */

/** 未归档草稿（首页卡片）与已归档草稿；字段缺失一律按未归档（参考站同口径） */
const activeDrafts = () => state.drafts.filter((d) => d && d.archived !== true)
const archivedDrafts = () => state.drafts.filter((d) => d && d.archived === true)

/**
 * 归档 / 恢复。只改草稿对象自身的 archived / archivedAt，
 * 不刷新 updateDatetime、不进撤销栈（列表级元数据，与参考站 archiveDraft 一致）。
 * 恢复时删除字段而不是置 false，导出的 JSON 与参考站逐字段一致。
 */
function setArchived (id, archived) {
  const d = state.drafts.find((x) => x.id === id)
  if (!d) return false
  const next = !!archived
  if (!!d.archived === next) return false
  if (next) {
    d.archived = true
    d.archivedAt = Date.now()
  } else {
    delete d.archived
    delete d.archivedAt
  }
  if (state.resume.id === id) {
    if (next) {
      state.resume.archived = true
      state.resume.archivedAt = d.archivedAt
    } else {
      delete state.resume.archived
      delete state.resume.archivedAt
    }
    // 元数据变化不算「未保存的内容改动」
    if (!state.dirty) state.lastSavedJSON = contentJson(state.resume)
  }
  writeDrafts(state.drafts)
  emit()
  return true
}
const archive = (id) => setArchived(id, true)
const unarchive = (id) => setArchived(id, false)

/** 按 id 重命名草稿（首页就地改名）。空白名称拒绝；改的是当前简历时同步内存副本 */
function renameDraft (id, name) {
  const t = String(name == null ? '' : name).trim()
  if (!t) return false
  const d = state.drafts.find((x) => x.id === id)
  if (!d || d.resumeName === t) return false
  d.resumeName = t
  d.updateDatetime = Date.now()
  writeDrafts(state.drafts)
  if (state.resume.id === id) {
    const wasDirty = state.dirty
    state.resume.resumeName = t
    state.resume.updateDatetime = d.updateDatetime
    if (!wasDirty) {
      state.savedAt = d.updateDatetime
      state.lastSavedJSON = contentJson(state.resume)
      state.dirty = false
    } else {
      refreshDirty()
    }
  }
  emit()
  return true
}

/**
 * 子集内排序：在 drafts 全数组里找出 archived === flag 的子集，把 id 移到子集下标 toIndex，
 * 另一子集的槽位原样不动。与参考站 moveWithinSubset 同语义：不刷新时间、不进撤销栈。
 */
function moveWithinSubset (id, toIndex, archivedFlag) {
  const list = state.drafts
  const from = list.findIndex((d) => d.id === id)
  if (from < 0) return false
  if (Boolean(list[from].archived) !== archivedFlag) return false
  const slots = []
  const sub = []
  list.forEach((d, i) => {
    if (Boolean(d.archived) === archivedFlag) {
      slots.push(i)
      sub.push(d)
    }
  })
  const fromSub = sub.findIndex((d) => d.id === id)
  const to = Math.max(0, Math.min(sub.length - 1, Math.floor(Number(toIndex) || 0)))
  if (fromSub === to) return false
  const moved = sub.splice(fromSub, 1)[0]
  sub.splice(to, 0, moved)
  slots.forEach((slot, k) => { list[slot] = sub[k] })
  writeDrafts(list)
  emit()
  return true
}
const moveDraft = (id, toIndex) => moveWithinSubset(id, toIndex, false)
const moveArchived = (id, toIndex) => moveWithinSubset(id, toIndex, true)

/** 导入查重：resumeName trim 后完全相同即重复（与参考站 importDedup.dedupByName 同口径） */
function dedupByName (incoming, existing) {
  const inArr = Array.isArray(incoming) ? incoming : []
  const exArr = Array.isArray(existing) ? existing : []
  const names = new Set(exArr.map((d) => String((d && d.resumeName) || '').trim()).filter(Boolean))
  const dupNames = []
  let dupCount = 0
  inArr.forEach((d) => {
    const n = String((d && d.resumeName) || '').trim()
    if (n && names.has(n)) {
      dupCount++
      if (dupNames.indexOf(n) < 0) dupNames.push(n)
    }
  })
  return { dupCount, dupNames, total: inArr.length }
}

const MAX_IMPORT = 50

/**
 * 解析导入文件文本。接受：
 *   · 单份简历对象（参考站「导出 JSON」）
 *   · 简历数组（参考站「备份全部」= JSON.stringify(drafts)）
 *   · { drafts: [...] } / { resumes: [...] } 包装（防御性兼容）
 * 返回 { ok, kind: 'single'|'backup', list, dup, error }；list 已 normalize，尚未分配新 id。
 */
function parseImport (text, existing) {
  let data
  try {
    data = JSON.parse(String(text == null ? '' : text).replace(/^\uFEFF/, ''))
  } catch (e) {
    return { ok: false, error: '文件不是有效的 JSON' }
  }
  let kind = 'single'
  let arr
  if (Array.isArray(data)) {
    kind = 'backup'
    arr = data
  } else if (data && typeof data === 'object' && Array.isArray(data.drafts)) {
    kind = 'backup'
    arr = data.drafts
  } else if (data && typeof data === 'object' && Array.isArray(data.resumes)) {
    kind = 'backup'
    arr = data.resumes
  } else {
    arr = [data]
  }
  if (!arr.length) return { ok: false, error: '文件里没有简历' }
  const bad = arr.some((d) => !d || typeof d !== 'object' || Array.isArray(d) || (!('sections' in d) && !('baseInfo' in d)))
  if (bad) return { ok: false, error: '文件格式不正确，不是简历数据' }
  if (arr.length > MAX_IMPORT) return { ok: false, error: '单次最多导入 ' + MAX_IMPORT + ' 份' }
  const list = arr.map((d) => normalizeResume(d))
  return { ok: true, kind, list, dup: dedupByName(list, existing || state.drafts) }
}

/**
 * 把解析好的简历写进草稿列表（按原顺序插到最前面），每份分配新 id。
 * opts.skipDuplicates：跳过与现有草稿同名的
 * opts.keepArchived：保留 archived 标记（「备份全部」恢复时为 true；单份导入一律未归档）
 * 不切换当前编辑的简历。返回 { added, skipped, ids }。
 */
function importDrafts (list, opts) {
  const o = opts || {}
  const arr = Array.isArray(list) ? list : [list]
  const names = new Set(state.drafts.map((d) => String(d.resumeName || '').trim()).filter(Boolean))
  const out = []
  let skipped = 0
  arr.forEach((raw) => {
    const r = normalizeResume(clone(raw))
    const n = String(r.resumeName || '').trim()
    if (o.skipDuplicates && n && names.has(n)) {
      skipped++
      return
    }
    r.id = 'r_' + nextId()
    if (!o.keepArchived || r.archived !== true) {
      delete r.archived
      delete r.archivedAt
    }
    if (!r.updateDatetime) r.updateDatetime = Date.now()
    out.push(r)
  })
  if (out.length) {
    const prev = state.drafts
    state.drafts = out.concat(state.drafts)
    if (!writeDrafts(state.drafts)) {
      state.drafts = prev
      return { added: 0, skipped, ids: [], error: '存储空间不足，导入失败' }
    }
    emit()
  }
  return { added: out.length, skipped, ids: out.map((r) => r.id) }
}

const cloneItemFresh = (it) => ({
  id: nextId(),
  type: it.type || 'THREE',
  leftContent: it.leftContent || '',
  centerContent: it.centerContent || '',
  rightContent: it.rightContent || ''
})

/**
 * 从另一份草稿复制区块 / 条目到当前简历（替代参考站的对照参考面板）。
 *   itemIds 省略：复制整个区块；给出时只复制这些条目（保持源顺序）
 *   targetSectionId 给出：条目追加进当前简历的这个区块；否则新建同名区块放到末尾
 * 复制品全部换新 id，进撤销栈。返回 { sectionId, count } 或 null。
 */
function copySectionFrom (draftId, sectionId, itemIds, targetSectionId) {
  const src = draftId === state.resume.id ? state.resume : state.drafts.find((d) => d.id === draftId)
  if (!src) return null
  const sec = (src.sections || []).find((s) => s.id === sectionId)
  if (!sec) return null
  const pick = Array.isArray(itemIds) && itemIds.length
    ? (sec.items || []).filter((it) => itemIds.indexOf(it.id) >= 0)
    : (sec.items || [])
  const items = pick.map(cloneItemFresh)
  if (!items.length && Array.isArray(itemIds) && itemIds.length) return null
  snapshot()
  let targetId = targetSectionId
  const target = targetId ? state.resume.sections.find((s) => s.id === targetId) : null
  if (target) {
    items.forEach((it) => target.items.push(it))
  } else {
    targetId = nextId()
    state.resume.sections.push({ id: targetId, title: sec.title || '未命名区块', visible: true, items })
  }
  save()
  return { sectionId: targetId, count: items.length }
}

function getSection (sectionId) {
  return state.resume.sections.find((x) => x.id === sectionId) || null
}

function getItem (sectionId, itemId) {
  const s = getSection(sectionId)
  return (s && s.items.find((x) => x.id === itemId)) || null
}

/**
 * 一次写入条目的多个字段并记一个历史点。
 * opts.text=true：来自连续键入，与紧接着的同类改动合并成一步撤销（同参考站 typingIfEditing）。
 */
function updateItem (sectionId, itemId, patch, opts) {
  const it = getItem(sectionId, itemId)
  if (!it || !patch) return false
  let changed = false
  Object.keys(patch).forEach((k) => {
    if (it[k] !== patch[k]) {
      it[k] = patch[k]
      changed = true
    }
  })
  if (!changed) return false
  typingIfEditing(!!(opts && opts.text))
  snapshot()
  refreshDirty()
  emit()
  return true
}

/**
 * 「已删除 · 撤销」提示条的跨页信号：条目子页删除后返回编辑器，
 * 由编辑器 onShow 取走并显示撤销条（子页本身已经关闭，没法自己显示）。
 */
function markDeleted (label) {
  state.undoHint = { label: label || '已删除', at: Date.now() }
}

function takeUndoHint (maxAgeMs) {
  const h = state.undoHint
  state.undoHint = null
  if (!h) return null
  if (Date.now() - h.at > (maxAgeMs || 6000)) return null
  return h
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
  cloneResume,
  /* v1 手机端新增 */
  activeDrafts,
  archivedDrafts,
  archive,
  unarchive,
  setArchived,
  renameDraft,
  moveDraft,
  moveArchived,
  dedupByName,
  parseImport,
  importDrafts,
  copySectionFrom,
  getSection,
  getItem,
  updateItem,
  markDeleted,
  takeUndoHint,
  MAX_IMPORT
}
