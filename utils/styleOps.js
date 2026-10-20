/**
 * 预览页的样式 / 智能排版 / 导出命名操作。
 *
 * 为什么单独一个文件：store.js 属于核心模块（另有人维护），这里只调用它
 * 已有的公开 API（state / setStyle / save / snapshot / applyTemplate），
 * 把预览页需要的「组合动作」收在一处，方便在 Node 里单测。
 *
 * 撤销约定（与 store 一致）：store.save() 内部会 snapshot()，把「改动后」
 * 的整份简历记为一个历史点；因此「改 → save」= 一步可撤销的操作。
 * 滑杆拖动中只调 setStyle（实时重绘、不落盘），松手时再 save，一次拖动一步撤销。
 */
const store = require('./store.js')
const model = require('./model.js')
const L = require('./layout.js')
const onePage = require('./onePage.js')
const { safeName } = require('./export.js')

/** 滑杆配置：与编辑页「排版尺寸」一致的取值范围 */
const SLIDERS = [
  { key: 'fontSize', label: '字号', min: 10, max: 20, step: 0.5, unit: 'px' },
  { key: 'lineHeight', label: '行距', min: 1.1, max: 2.4, step: 0.05, unit: '' },
  { key: 'horizontalPadding', label: '左右边距', min: 20, max: 90, step: 1, unit: 'px' },
  { key: 'verticalPadding', label: '上下边距', min: 20, max: 80, step: 1, unit: 'px' },
  { key: 'sectionSpacing', label: '区块间距', min: 6, max: 40, step: 1, unit: 'px' }
]

/** 布局：单栏 / 两栏（信息左）/ 两栏（信息右） */
const LAYOUT_OPTIONS = [
  { id: 'SINGLE', label: '单栏' },
  { id: 'LEFT', label: '两栏 · 信息左' },
  { id: 'RIGHT', label: '两栏 · 信息右' }
]

const STYLE_KEYS = [
  'templateId', 'pageLayout', 'headingTheme', 'headingColor', 'headingSecondColor', 'borderColor',
  'fontFamily', 'fontSize', 'lineHeight', 'fontSpacing', 'horizontalPadding', 'verticalPadding', 'sectionSpacing'
]

/** 当前样式摘要（页面 setData 用，只取样式字段，不含正文） */
function styleState (resume) {
  const r = resume || store.state.resume
  const out = {}
  STYLE_KEYS.forEach((k) => { out[k] = r[k] })
  const preset = model.COLOR_PRESETS.find((c) => String(c.value).toLowerCase() === String(r.headingColor || '').toLowerCase())
  out.colorId = preset ? preset.id : ''
  return out
}

/** 实时预览（不落盘、不记历史）：滑杆拖动中调用 */
function previewStyle (key, value) {
  store.setStyle(key, value)
}

/**
 * 写入一组样式字段并落盘（= 一步撤销）。
 * headingColor 联动 borderColor，与 store.setStyle 的口径一致。
 */
function applyStylePatch (patch) {
  const r = store.state.resume
  const keys = Object.keys(patch || {})
  if (!keys.length) return false
  keys.forEach((k) => {
    r[k] = patch[k]
    if (k === 'headingColor' && patch.borderColor == null) r.borderColor = patch[k]
  })
  store.save()
  return true
}

function applyColor (id) {
  if (!model.COLOR_PRESETS.find((c) => c.id === id)) return false
  store.applyColorPreset(id)
  return true
}

function applyFont (id) {
  if (!model.FONT_FAMILIES.find((f) => f.id === id)) return false
  return applyStylePatch({ fontFamily: id })
}

function applyHeading (id) {
  if (!model.HEADING_THEMES.find((h) => h.id === id)) return false
  return applyStylePatch({ headingTheme: id })
}

function applyLayout (id) {
  if (!LAYOUT_OPTIONS.find((l) => l.id === id)) return false
  return applyStylePatch({ pageLayout: id })
}

function applySlider (key, value) {
  const s = SLIDERS.find((x) => x.key === key)
  if (!s) return false
  const v = Math.max(s.min, Math.min(s.max, Number(value)))
  if (!Number.isFinite(v)) return false
  return applyStylePatch({ [key]: onePage.alignTo(v, s.step) })
}

/* ------------------------------------------------------------------ */
/*  智能排版（一页）                                                    */
/* ------------------------------------------------------------------ */

/** 分页测量：页数 + 末页填充比例（与纸面 / 导出同一套 paginateResume） */
function measurePagesOf (resume) {
  return (params) => {
    const pag = L.paginateResume(resume, params)
    const S = pag.layout.pageStyle || pag.layout.style
    const usable = Math.max(1, L.A4_H - S.vPad - pag.padBottom)
    const lastTop = (pag.pages - 1) * L.A4_H + S.vPad
    const rest = pag.contentBottom - lastTop
    return { pages: pag.pages, lastFill: Math.min(1, Math.max(0, rest / usable)) }
  }
}

/**
 * 纯计算：对一份简历跑智能排版，不写 store。
 * @returns {{ result, start, message, changes }}
 */
function planSmartFit (resume) {
  const start = onePage.readFitParamsSafe(resume)
  const result = onePage.smartLayout(start, {
    measure: L.measureHeight(resume),
    measurePages: measurePagesOf(resume),
    target: L.A4_H + L.PAGINATION_SLACK,
    template: model.getTemplate(resume.templateId)
  })
  return {
    result,
    start,
    changes: result.changes,
    message: onePage.describeLayoutResult(result).text
  }
}

/**
 * 跑智能排版并写入当前简历（一步撤销）。
 * @returns {{ applied:boolean, backup:object|null, changes:Array, message:string, mode:string, pages:number }}
 */
function runSmartFit () {
  const resume = store.state.resume
  const plan = planSmartFit(resume)
  if (!plan.changes.length) {
    return { applied: false, backup: null, changes: [], message: plan.message, mode: plan.result.mode, pages: plan.result.pages }
  }
  const patch = {}
  plan.changes.forEach((c) => { patch[c.key] = c.to })
  applyStylePatch(patch)
  const pages = L.paginateResume(store.state.resume).pages
  return { applied: true, backup: plan.start, changes: plan.changes, message: plan.message, mode: plan.result.mode, pages }
}

/** 还原到智能排版之前的参数（同样是一步撤销，可被重做） */
function restoreFitParams (backup) {
  if (!backup) return false
  const patch = {}
  onePage.FIT_KEYS.forEach((k) => { if (backup[k] != null) patch[k] = backup[k] })
  return applyStylePatch(patch)
}

/** 变化清单 → 可直接渲染的行 */
function changeRows (changes) {
  return (changes || []).map((c) => ({
    key: c.key,
    label: c.label,
    from: c.from.toFixed(c.decimals) + c.unit,
    to: c.to.toFixed(c.decimals) + c.unit,
    down: c.to < c.from
  }))
}

/* ------------------------------------------------------------------ */
/*  导出文件名                                                          */
/* ------------------------------------------------------------------ */

/**
 * 导出文件名（不含扩展名）：`${姓名}-${求职意向}-简历`。
 * 缺哪段就省哪段；全部缺失退回简历名 / 「简历」。非法字符替换、总长受限。
 */
function exportFileBase (resume) {
  const r = resume || {}
  const b = r.baseInfo || {}
  const clean = (s) => String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|\n\r\t]/g, '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .trim()
  const name = clean(b.name).slice(0, 16)
  const intent = clean(b.jobIntention).slice(0, 20)
  const parts = [name, intent].filter(Boolean)
  let base = parts.length ? parts.join('-') + '-简历' : (clean(r.resumeName).slice(0, 30) || '简历')
  if (parts.length === 0 && !/简历$/.test(base)) base += '-简历'
  return safeName(base)
}

module.exports = {
  SLIDERS,
  LAYOUT_OPTIONS,
  styleState,
  previewStyle,
  applyStylePatch,
  applyColor,
  applyFont,
  applyHeading,
  applyLayout,
  applySlider,
  measurePagesOf,
  planSmartFit,
  runSmartFit,
  restoreFitParams,
  changeRows,
  exportFileBase
}
