/**
 * 数据备份与恢复 · 纯逻辑 + store 适配层（分包 tools/backup 专用）
 *
 * 备份格式与网页版「数据管家 → 备份全部」完全一致：
 *   JSON.stringify(drafts, null, 2) —— 一个草稿数组（pb_drafts_v1 的原样内容）。
 * 投递记录（pb_tracks_v1）不进备份，与网页版口径一致（参考站 PRD 10 §6）。
 *
 * 查重口径移植自参考站 src/utils/importDedup.js：resumeName trim 后完全相同即重复。
 */
const { normalizeResume } = require('../../../utils/model.js')

const MAX_IMPORT = 50

/** 按名字查重（口径与网页版 dedupByName 一致） */
function dedupByName (incoming, existing) {
  const inArr = Array.isArray(incoming) ? incoming : []
  const exArr = Array.isArray(existing) ? existing : []
  const existingNames = new Set(
    exArr.map((d) => String((d && d.resumeName) == null ? '' : d.resumeName).trim()).filter(Boolean)
  )
  const dupNames = []
  let dupCount = 0
  for (const d of inArr) {
    const name = String((d && d.resumeName) == null ? '' : d.resumeName).trim()
    if (name && existingNames.has(name)) {
      dupCount++
      if (dupNames.indexOf(name) < 0) dupNames.push(name)
    }
  }
  return { dupCount, dupNames, total: inArr.length }
}

/**
 * 解析备份文本 → { ok, list, error }。
 * 支持「备份全部」数组、单份简历对象，以及 { drafts: [...] } / { resumes: [...] } 包装（与 store.parseImport 同口径）；每份都必须像简历（有 sections 或 baseInfo），
 * 否则当作格式错误拒绝——剪贴板里随便一段 JSON 不能被当成简历导进来。
 */
function parseBackup (text) {
  const s = String(text == null ? '' : text).trim().replace(/^\uFEFF/, '')
  if (!s) return { ok: false, error: '内容是空的' }
  let data
  try {
    data = JSON.parse(s)
  } catch (e) {
    return { ok: false, error: '不是有效的备份文件' }
  }
  let arr
  if (Array.isArray(data)) arr = data
  else if (data && typeof data === 'object' && Array.isArray(data.drafts)) arr = data.drafts
  else if (data && typeof data === 'object' && Array.isArray(data.resumes)) arr = data.resumes
  else arr = [data]
  if (!arr.length) return { ok: false, error: '备份里没有简历' }
  const bad = arr.some((d) => !d || typeof d !== 'object' || Array.isArray(d) || (!('sections' in d) && !('baseInfo' in d)))
  if (bad) return { ok: false, error: '不是有效的备份文件' }
  if (arr.length > MAX_IMPORT) return { ok: false, error: '单次最多导入 ' + MAX_IMPORT + ' 份' }
  return { ok: true, list: arr.map((d) => normalizeResume(d)) }
}

/** 预览行：名字 + 是否与现有同名 */
function previewRows (list, dedup) {
  return list.map((r, i) => {
    const name = String(r.resumeName || '').trim()
    return {
      key: i,
      name: name || '未命名简历',
      dup: !!name && dedup.dupNames.indexOf(name) >= 0,
      sections: (r.sections || []).length
    }
  })
}

/**
 * 把草稿写进 store —— 适配层。
 *
 * 优先用 store.importDrafts(list, opts)（v1 store 已提供：逐份 normalize、换新 id、
 * 插到最前、落盘失败自动回滚，返回 { added, skipped, ids, error }）。
 * 老版本 store 没有它时，退回 store.importJSON(text, { asDraftList: true })，
 * 并事后核对存储：没写进去就回滚内存，避免「显示导入成功、重启就没了」。
 *
 * opts.skipDuplicates 跳过与现有同名的；恢复备份时保留归档标记（keepArchived）。
 * @returns {{ ok: boolean, count: number, skipped: number }}
 */
function importDrafts (store, list, opts) {
  const o = opts || {}
  const n = list.length
  if (!n) return { ok: true, count: 0, skipped: 0 }
  if (typeof store.importDrafts === 'function') {
    const r = store.importDrafts(list, { keepArchived: true, skipDuplicates: !!o.skipDuplicates }) || {}
    if (typeof r === 'number') return { ok: true, count: r, skipped: 0 }
    return { ok: !r.error, count: r.added == null ? 0 : r.added, skipped: r.skipped || 0 }
  }
  let src = list
  let skipped = 0
  if (o.skipDuplicates) {
    const names = new Set(store.state.drafts.map((d) => String(d.resumeName || '').trim()).filter(Boolean))
    src = list.filter((d) => !names.has(String(d.resumeName || '').trim()) || !String(d.resumeName || '').trim())
    skipped = n - src.length
    if (!src.length) return { ok: true, count: 0, skipped }
  }
  const before = store.state.drafts.slice()
  let count = 0
  try {
    count = store.importJSON(JSON.stringify(src), { asDraftList: true })
  } catch (e) {
    return { ok: false, count: 0, skipped: 0 }
  }
  let persisted = []
  try {
    persisted = wx.getStorageSync('pb_drafts_v1')
  } catch (e) {
    persisted = []
  }
  const ok = Array.isArray(persisted) && persisted.length === store.state.drafts.length
  if (!ok) {
    store.state.drafts.splice(0, store.state.drafts.length, ...before)
    if (typeof store.emit === 'function') store.emit()
    return { ok: false, count: 0, skipped: 0 }
  }
  return { ok: true, count, skipped }
}

/** 备份文件名：简历制作_全部备份_20261020.json（与网页版前缀一致） */
function backupFileName (now) {
  const d = new Date(now || Date.now())
  const p = (x) => String(x).padStart(2, '0')
  return '简历制作_全部备份_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.json'
}

/** 存储占用展示：已用 X KB / 10 MB（取不到上限时按 10MB） */
function storageText (info) {
  const used = Math.max(0, Math.round((info && info.currentSize) || 0))
  const limitKB = (info && info.limitSize) || 10240
  const limit = limitKB >= 1024 ? Math.round((limitKB / 1024) * 10) / 10 + ' MB' : limitKB + ' KB'
  return { text: '已用 ' + used + ' KB / ' + limit, ratio: Math.min(1, used / limitKB) }
}

module.exports = {
  MAX_IMPORT,
  dedupByName,
  parseBackup,
  previewRows,
  importDrafts,
  backupFileName,
  storageText
}
