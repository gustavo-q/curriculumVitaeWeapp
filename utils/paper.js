/**
 * 纸张视图模型构建器 —— 移植自参考站 src/components/ResumePaper.vue
 *
 * 参考站用 Vue 把样式写成 computed 后交给模板；小程序没有 computed，
 * 因此在 JS 里把「简历数据 → 一份可直接渲染的扁平 VM」算好，
 * 模板只做绑定。这样 WXSS 里没有任何模板相关的分支逻辑，样式与参考站一一对应。
 *
 * 关键约定（与参考站逐条对齐）：
 *   · A4 = 794 × 1123 设计像素，纸面宽度恒为 794，字号 / 行距 / 边距都用设计像素
 *   · 三种布局：SINGLE 单栏（顶部信息区）、LEFT 信息栏在左、RIGHT 信息栏在右
 *   · 条目三种排版：ONE 只用中栏、TWO 用左+右、THREE 三栏都用
 *   · 空栏只在该类型确实用这一栏时才渲染（否则会凭空撑高一行）
 *   · 8 种标题装饰、4 种边框、7 组配色、7 种字体
 */

const { BASE_FIELDS, FONT_FAMILIES, ITEM_META, ITEM_TYPE } = require('./model.js')
const { resolvePhoto } = require('./avatars.js')

const A4_W = 794
const A4_H = 1123

/** 样式默认值：与 createDefaultResume() 保持一致 */
const STYLE_DEFAULTS = {
  fontSize: 14,
  lineHeight: 1.65,
  fontSpacing: 0,
  horizontalPadding: 48,
  verticalPadding: 36,
  sectionSpacing: 18,
  baseInfoRatio: 50
}

const pickFontStack = (id) => (FONT_FAMILIES.find((f) => f.id === id) || FONT_FAMILIES[0]).stack

/** 标题装饰 → 内联样式（对应参考站 headingStyle computed） */
function buildHeadingStyle (r) {
  const s = { color: r.headingFontColor || '#23282f' }
  switch (r.headingTheme) {
    case 'block':
      s.background = r.headingColor
      s.color = '#ffffff'
      s.padding = '2px 10px'
      s.borderRadius = '3px'
      s.display = 'inline-block'
      break
    case 'filled':
      s.background = r.headingColor
      s.color = '#ffffff'
      s.padding = '4px 12px'
      s.borderRadius = '2px'
      break
    case 'line':
      s.borderBottom = '1.5px solid ' + r.headingColor
      s.paddingBottom = '4px'
      break
    case 'double':
      s.borderBottom = '3px double ' + r.headingColor
      s.paddingBottom = '4px'
      break
    case 'bar':
      s.borderLeft = '3px solid ' + r.headingColor
      s.paddingLeft = '8px'
      break
    case 'dot':
      s.paddingLeft = '13px'
      break
    case 'outline':
      s.border = '1px solid ' + r.headingColor
      s.color = r.headingColor
      s.padding = '2px 9px'
      s.borderRadius = '2px'
      s.display = 'inline-block'
      break
    case 'tint':
      s.background = r.headingColor + '22'
      s.borderLeft = '3px solid ' + r.headingColor
      s.color = r.headingColor
      s.padding = '3px 10px'
      s.borderRadius = '0 3px 3px 0'
      s.display = 'inline-block'
      break
    default:
      break
  }
  return s
}

/**
 * 需要补 px 单位的属性。
 *
 * 为什么不能「凡是数字就补 px」：fontWeight、lineHeight 这类值本身就是
 * 无单位数字，补成 700px / 1.65px 会被浏览器判为非法声明而整条丢弃——
 * 表现是侧栏姓名不粗、行距不生效，而且不报任何错，极难排查。
 */
const PX_PROPS = {
  width: 1, height: 1, minHeight: 1, maxHeight: 1, minWidth: 1, maxWidth: 1,
  top: 1, right: 1, bottom: 1, left: 1,
  margin: 1, marginTop: 1, marginRight: 1, marginBottom: 1, marginLeft: 1,
  padding: 1, paddingTop: 1, paddingRight: 1, paddingBottom: 1, paddingLeft: 1,
  fontSize: 1, letterSpacing: 1, borderRadius: 1, gap: 1, columnGap: 1, rowGap: 1,
  borderWidth: 1, borderTopWidth: 1, borderLeftWidth: 1, flexBasis: 1, textIndent: 1
}

/** 对象 → style 字符串（小程序内联样式只接受字符串） */
function styleOf (obj) {
  return Object.keys(obj)
    .filter((k) => obj[k] !== '' && obj[k] !== null && obj[k] !== undefined)
    .map((k) => {
      const v = obj[k]
      const unit = typeof v === 'number' && PX_PROPS[k] ? 'px' : ''
      return k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()) + ':' + v + unit
    })
    .join(';')
}

/** 纸面样式（对应参考站 paperStyle computed） */
function buildPaperStyle (r) {
  const st = {
    width: A4_W + 'px',
    minHeight: A4_H + 'px',
    padding: r.verticalPadding + 'px ' + r.horizontalPadding + 'px',
    fontFamily: pickFontStack(r.fontFamily),
    fontSize: r.fontSize + 'px',
    letterSpacing: r.fontSpacing + 'px',
    lineHeight: String(r.lineHeight),
    background: '#ffffff',
    color: '#23282f',
    position: 'relative',
    boxSizing: 'border-box',
    overflow: 'hidden'
  }
  if (r.borderTheme === 'thin') {
    st.boxShadow = 'inset 0 0 0 1px ' + r.borderColor
  } else if (r.borderTheme === 'double') {
    st.boxShadow = 'inset 0 0 0 1px ' + r.borderColor + ', inset 0 0 0 5px #ffffff, inset 0 0 0 6px ' + r.borderColor
  } else if (r.borderTheme === 'dashed') {
    st.border = '1px dashed ' + r.borderColor
  }
  return st
}

/** 照片样式（对应参考站 photoStyle computed） */
function buildPhotoStyle (r) {
  const st = {
    width: r.personalPhotoWidth + 'px',
    height: r.personalPhotoHeight + 'px',
    marginRight: r.personalPhotoRight + 'px',
    marginTop: r.personalPhotoTop + 'px',
    objectFit: 'cover',
    display: 'block'
  }
  const shape = r.personalPhotoShape || 'rect'
  if (shape === 'circle') st.borderRadius = '50%'
  else if (shape === 'rounded') st.borderRadius = '6px'
  else if (shape === 'square') st.borderRadius = '0'
  const border = r.personalPhotoBorder || 'none'
  if (border === 'thin') st.border = '1px solid #d5dae0'
  else if (border === 'theme') st.border = '2px solid ' + r.headingColor
  else if (border === 'shadow') st.boxShadow = '0 2px 8px rgba(16,24,40,0.22)'
  return st
}

/**
 * 基本信息 → 展示项。
 * 姓名单独作为标题行，其余字段按「标签 + 值」成对排列（与参考站一致）。
 */
function buildBasePairs (r) {
  const on = r.baseFields || []
  const info = r.baseInfo || {}
  return BASE_FIELDS
    .filter((f) => on.includes(f.key) && String(info[f.key] == null ? '' : info[f.key]).trim())
    .filter((f) => f.key !== 'name')
    .map((f) => ({ key: f.key, label: f.label, value: String(info[f.key]) }))
}

/**
 * 该条目类型在语义上是否使用某一栏。
 * 有内容恒渲染；没内容时只在「该类型确实用这一栏」时才渲染成占位落点，
 * 否则 ONE 类型会凭空多出左右两个空行（参考站踩过的坑，见 ResumePaper.vue 注释）。
 */
function usesCol (item, field, editable) {
  const value = item[field]
  if (value && String(value).trim()) return true
  if (!editable) return false
  const t = String(item.type || ITEM_TYPE.ONE).toUpperCase()
  if (t === ITEM_TYPE.ONE) return field === 'centerContent'
  if (t === ITEM_TYPE.TWO) return field === 'leftContent' || field === 'rightContent'
  if (t === ITEM_TYPE.THREE) return true
  return field === 'centerContent'
}

/** 列表正文：换行且多数行带序号 / 项目符号 → 悬挂缩进（与参考站判据一致） */
const LIST_MARKER = /^\s*(?:\d+\s*[.、)）]|[(（]\s*\d+\s*[)）]|[•·▪◦*+-])\s*/
function isListContent (text) {
  const raw = String(text || '')
  if (!raw.trim()) return false
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length < 2) return false
  const marked = lines.filter((l) => LIST_MARKER.test(l)).length
  if (marked >= Math.ceil(lines.length * 0.6)) return true
  const labelled = lines.filter((l) => /^[^：:]{1,12}[：:]/.test(l)).length
  return labelled >= Math.ceil(lines.length * 0.6)
}

function itemPlaceholder (item, field) {
  const meta = ITEM_META[item.type] || {}
  if (field === 'leftContent') return meta.leftPlaceholder || ''
  if (field === 'rightContent') return meta.rightPlaceholder || ''
  return meta.centerPlaceholder || '内容'
}

/** 构造一个条目（对应参考站 .item 那套 class 与栏位） */
function buildItemVM (r, item, editable) {
  const type = String(item.type || ITEM_TYPE.ONE).toLowerCase()
  const cells = []
  const fields = [
    { field: 'leftContent', cls: 'c-left' },
    { field: 'centerContent', cls: 'c-center' },
    { field: 'rightContent', cls: 'c-right' }
  ]
  for (const f of fields) {
    if (!usesCol(item, f.field, editable)) continue
    const raw = item[f.field]
    const text = raw == null ? '' : String(raw)
    const isEmpty = !text.trim()
    const cls = [f.cls]
    if (isEmpty) cls.push('is-empty')
    if (f.field === 'centerContent' && isListContent(text)) cls.push('is-list')
    cells.push({
      field: f.field,
      text,
      cls: cls.join(' '),
      ph: itemPlaceholder(item, f.field),
      isEmpty
    })
  }
  return { id: item.id, type, cls: 't-' + type, cells }
}

function buildSectionVM (r, section, editable, extraStyle) {
  const style = Object.assign({ marginBottom: (r.sectionSpacing || 0) + 'px' }, extraStyle || {})
  return {
    id: section.id,
    title: section.title,
    titleCls: 'th-' + (r.headingTheme || 'line') + (r.headingCenter ? ' center' : ''),
    titleStyle: styleOf(buildHeadingStyle(r)),
    style: styleOf(style),
    itemVMs: section.items.map((it) => buildItemVM(r, it, editable))
  }
}

/**
 * 主入口：把一份简历编译成可直接渲染、也可直接测量的 VM。
 *
 * @param {object} resume 简历数据
 * @param {object} [opts]
 * @param {boolean} [opts.editable] 编辑态：空栏渲染成占位落点（可点）
 * @param {object}  [opts.params]   覆盖排版参数（智能一页试算时使用）
 */
function buildPaperVM (resume, opts) {
  const o = opts || {}
  const editable = !!o.editable
  // 智能一页试算会传入一套候选参数，其余字段沿用简历本身
  const r = o.params ? Object.assign({}, resume, o.params) : resume

  const layout = r.pageLayout || 'SINGLE'
  const photoSrc = resolvePhoto(r.personalPhoto)
  const basePairs = buildBasePairs(r)
  const name = (r.baseInfo && r.baseInfo.name) || ''
  const sections = (r.sections || [])
    .filter((s) => s.visible !== false)
    .map((s) => buildSectionVM(r, s, editable))

  const photoStyle = buildPhotoStyle(r)
  const photo = { show: !!photoSrc, src: photoSrc, style: styleOf(photoStyle) }
  // 编辑态且没有照片：给一个「＋ 添加照片」落点（对应参考站 photo-add 占位块）
  const photoSlot = { show: !photoSrc && editable, style: styleOf({ width: '90px', height: '120px' }) }

  const vm = {
    layout,
    paperStyle: styleOf(buildPaperStyle(r)),
    photo,
    photoSlot,
    basePairs,
    name,
    nameEmpty: !name,
    nameCls: name ? '' : 'is-empty',
    sections,
    editable,
    // 以下字段供测量与分页使用，模板不直接渲染
    metrics: {
      fontSize: r.fontSize,
      lineHeight: r.lineHeight,
      horizontalPadding: r.horizontalPadding,
      verticalPadding: r.verticalPadding,
      sectionSpacing: r.sectionSpacing,
      baseInfoRatio: r.baseInfoRatio,
      layout
    }
  }

  if (layout === 'SINGLE') {
    vm.headStyle = styleOf({ display: 'flex', alignItems: 'flex-start', gap: '16px', marginBottom: '20px' })
    vm.cols = { show: false }
    // 两列基本信息（对应 .head-grid）
    vm.headCells = basePairs.map((p) => ({
      key: p.key,
      label: p.label,
      value: p.value,
      empty: false
    }))
  } else {
    const ratio = r.baseInfoRatio || 50
    vm.cols = {
      show: true,
      style: styleOf({
        display: 'grid',
        gridTemplateColumns: layout === 'LEFT' ? ratio + '% 1fr' : '1fr ' + ratio + '%',
        gap: '26px',
        alignItems: 'start'
      })
    }
    vm.side = {
      before: layout === 'LEFT',
      name,
      nameEmpty: !name,
      list: basePairs,
      style: styleOf(r.accentBlock ? { background: '#f5f6f8', padding: '16px 14px', borderRadius: '6px' } : {}),
      nameStyle: styleOf({ fontSize: '1.5em', fontWeight: 700, letterSpacing: '1px', marginBottom: '10px' }),
      photoWrapStyle: styleOf({ marginBottom: '12px' })
    }
    vm.head = { show: false }
  }

  return vm
}

/** 简历 → JSON（导出备份用） */
function paperSize () {
  return { width: A4_W, height: A4_H }
}

module.exports = {
  A4_W,
  A4_H,
  STYLE_DEFAULTS,
  styleOf,
  pickFontStack,
  buildPaperVM,
  buildBasePairs,
  buildHeadingStyle,
  buildPhotoStyle,
  isListContent,
  usesCol,
  paperSize
}
