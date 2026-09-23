/**
 * 排版布局引擎 —— 用 JS 复刻纸张的 CSS 排版规则
 *
 * 为什么需要它
 * ------------
 * 参考站在浏览器里靠「真实 DOM 测量」做两件事：
 *   1. A4 软分页（哪些区块要被推到下一页、一共几页）
 *   2. 智能压缩到一页（反复改参数、量高度、二分收敛）
 * 小程序里这两件事如果用 wx.createSelectorQuery() 逐次测量，每试一组参数
 * 都要等一次渲染 + 一次异步查询，二分几十轮下来页面会明显卡顿；
 * 而且纸张为了适配手机宽度做了 transform 缩放，量出来的坐标还要反推。
 *
 * 因此这里把纸张的排版规则在 JS 里实现一遍，用 canvas 的 measureText 做文本测量。
 * 高度、页数、分页推挤都能同步算出来；PNG 导出也直接复用同一份几何数据
 * ——「屏幕上看到的」「共 N 页」与「导出的长图」因此必然一致。
 *
 * 与 WXSS 的关系：components/resume-paper/paper.wxss 是这套规则的视觉呈现，
 * 两边必须同源。任何一边改了字号系数或间距倍数，另一边都要跟着改。
 */

const { BASE_FIELDS, ITEM_META } = require('./model.js')

const A4_W = 794
const A4_H = 1123
/** 判页容差：与参考站 onePage.js 的 PAGINATION_SLACK 同值、同含义 */
const PAGINATION_SLACK = 1

/** 颜色（与 paper.wxss 中出现的字面色值一一对应） */
const C = {
  ink: '#23282f',
  ink2: '#5b6570',
  label: '#6b7280',
  right: '#4b5560',
  white: '#ffffff',
  dot: '#1f4e79'
}

/** 设计字号 → canvas 可用字体族（小程序 canvas 只认有限的几个通用族） */
const CANVAS_FAMILY = {
  system: 'sans-serif',
  heiti: 'sans-serif',
  arial: 'Arial',
  songti: 'serif',
  kaiti: 'serif',
  fangsong: 'serif',
  times: 'serif'
}

let _ctx = null
let _ctxFailed = false

/** 取一个离屏 2D 上下文，只用于 measureText；失败时退化为估算模型 */
function getCtx () {
  if (_ctx || _ctxFailed) return _ctx
  try {
    const canvas = wx.createOffscreenCanvas({ type: '2d', width: 16, height: 16 })
    _ctx = canvas.getContext('2d')
  } catch (e) {
    _ctxFailed = true
    _ctx = null
  }
  return _ctx
}

const fontOf = (size, weight, familyId) =>
  (weight || 400) + ' ' + size + 'px ' + (CANVAS_FAMILY[familyId] || 'sans-serif')

/**
 * 可选的文本度量覆盖。
 *
 * 默认走 canvas.measureText()；回归测试会在浏览器里量出一张字体宽度表后
 * 注入进来，使「引擎的预测」与「浏览器的真实排版」使用同一套字体度量——
 * 否则逐像素比对测的是字体差别，而不是排版规则本身。
 */
let _measureOverride = null
function setMeasureOverride (fn) {
  _measureOverride = typeof fn === 'function' ? fn : null
}

/** 单行文本宽度（含字距） */
function textWidth (str, font, fontSpacing) {
  const s = String(str == null ? '' : str)
  if (!s) return 0
  const ls = Number(fontSpacing) || 0
  if (_measureOverride) return _measureOverride(s, font, ls)
  const ctx = getCtx()
  let w
  if (ctx) {
    ctx.font = font
    w = ctx.measureText(s).width
  } else {
    // 退化估算：中日韩字符按 1em，其余按 0.52em
    let em = 0
    for (let i = 0; i < s.length; i++) em += /[\u3000-\u9fff\uff00-\uffef]/.test(s[i]) ? 1 : 0.52
    const size = parseFloat(String(font).match(/(\d+(?:\.\d+)?)px/)[1])
    w = em * size
  }
  return w + ls * s.length
}

const isWordChar = (c) => /[A-Za-z0-9@._%+\-/'’]/.test(c)

/**
 * 文本折行 —— 逼近浏览器的换行行为：
 *   · 明确换行符（\n）强制断行
 *   · 连续的西文字母 / 数字视为一个不可拆的词，整体换行
 *   · 单个词比整行还宽时按字符硬断，避免溢出
 *   · 中日韩字符逐字换行（与浏览器断行规则一致）
 */
function wrapText (str, maxWidth, font, fontSpacing) {
  const raw = String(str == null ? '' : str)
  if (!raw) return ['']
  if (!(maxWidth > 0)) return [raw]
  const out = []
  const paragraphs = raw.split('\n')
  for (let p = 0; p < paragraphs.length; p++) {
    const para = paragraphs[p]
    if (!para) {
      out.push('')
      continue
    }
    const chars = Array.from(para)
    let line = ''
    let i = 0
    while (i < chars.length) {
      let token = ''
      if (chars[i] === ' ' || chars[i] === '\t') {
        while (i < chars.length && (chars[i] === ' ' || chars[i] === '\t')) token += chars[i++]
      } else if (isWordChar(chars[i])) {
        while (i < chars.length && isWordChar(chars[i])) token += chars[i++]
      } else {
        token = chars[i++]
      }
      const candidate = line + token
      if (line && textWidth(candidate, font, fontSpacing) > maxWidth) {
        out.push(line)
        line = token.replace(/^[ \t]+/, '')
        while (line && textWidth(line, font, fontSpacing) > maxWidth) {
          let cut = 1
          while (cut < line.length && textWidth(line.slice(0, cut + 1), font, fontSpacing) <= maxWidth) cut++
          out.push(line.slice(0, cut))
          line = line.slice(cut)
        }
      } else if (!line && textWidth(token, font, fontSpacing) > maxWidth) {
        let rest = token
        while (rest && textWidth(rest, font, fontSpacing) > maxWidth) {
          let cut = 1
          while (cut < rest.length && textWidth(rest.slice(0, cut + 1), font, fontSpacing) <= maxWidth) cut++
          out.push(rest.slice(0, cut))
          rest = rest.slice(cut)
        }
        line = rest
      } else {
        line = candidate
      }
    }
    out.push(line)
  }
  return out.length ? out : ['']
}

/** 列表正文判据（与 paper.js / 参考站同源） */
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

/* ------------------------------------------------------------------ */
/*  排版参数                                                           */
/* ------------------------------------------------------------------ */

function resolveStyle (resume, params) {
  const r = params ? Object.assign({}, resume, params) : resume
  const fontSize = Number(r.fontSize) || 14
  const hPad = Number(r.horizontalPadding) || 48
  const vPad = Number(r.verticalPadding) || 36
  return {
    resume: r,
    fontSize,
    lineHeight: Number(r.lineHeight) || 1.65,
    fontSpacing: Number(r.fontSpacing) || 0,
    hPad,
    vPad,
    sectionSpacing: Number(r.sectionSpacing == null ? 18 : r.sectionSpacing),
    baseInfoRatio: Number(r.baseInfoRatio) || 50,
    fontFamily: r.fontFamily || 'system',
    contentWidth: A4_W - 2 * hPad,
    lineBox: fontSize * (Number(r.lineHeight) || 1.65)
  }
}

/* ------------------------------------------------------------------ */
/*  区块标题                                                           */
/* ------------------------------------------------------------------ */

/** 标题盒的额外高度（上下 padding / border），与 paper.wxss 的 .th-* 同源 */
function headingExtra (theme) {
  switch (theme) {
    case 'block': return 4
    case 'filled': return 8
    case 'outline': return 6
    case 'tint': return 6
    case 'line': return 5.5
    // 双线：paper.wxss 里 .th-double 用 !important 把 border-bottom-width 钉成 1px
    // （双线的第二道线是 ::after 绝对定位画的，不占高度），因此与单线的
    // 1.5px 边框几乎等高。此前按 3px double 估算，每个区块多算 2px，
    // 6 个区块累积 10px，足以让分页判定与实际排版错开。
    case 'double': return 5
    default: return 0
  }
}

/** 标题在色块 / 描边 / 淡底装饰下需要绘制的背景 */
function headingBox (resume, fontSize, lineBox, width) {
  const t = resume.headingTheme
  if (t === 'block' || t === 'filled' || t === 'tint' || t === 'outline') {
    return {
      fill: t === 'tint' ? resume.headingColor + '22' : (t === 'outline' ? '' : resume.headingColor),
      stroke: t === 'outline' ? resume.headingColor : '',
      size: { w: width, h: lineBox + headingExtra(t) }
    }
  }
  return null
}

function headingTextColor (resume) {
  const t = resume.headingTheme
  if (t === 'block' || t === 'filled') return C.white
  if (t === 'outline' || t === 'tint') return resume.headingColor
  return resume.headingFontColor || C.ink
}

/* ------------------------------------------------------------------ */
/*  条目：三种分栏                                                     */
/* ------------------------------------------------------------------ */

/**
 * 该条目类型实际渲染哪几栏。
 *
 * ★ 必须与 utils/paper.js 的 usesCol() 完全同源，且必须区分编辑态 / 只读态：
 *   编辑态空栏会渲染成可点击的占位落点（真实占一行），因此按「该类型是否
 *   使用这一栏」补出空栏；只读态空栏什么都不渲染、高度为 0。
 *
 *   此前这里漏了 editable 这一维（只读态也按类型补空栏），于是
 *   「THREE 条目只填了正文」时：屏幕上只渲染 1 个栏位、按 CSS grid 落在
 *   第 1 列，而引擎却按 3 栏把正文算到第 2 列 —— 预览页与导出图里
 *   文字横向错位约一整列。24 种「类型 × 填充组合」里有 17 种不一致。
 *   注释所称「已如实复刻」与实现直接矛盾，正是这里。
 */
function renderedFields (item, editable) {
  const type = String(item.type || 'ONE').toUpperCase()
  const order = ['leftContent', 'centerContent', 'rightContent']
  const has = (f) => !!(item[f] && String(item[f]).trim())
  return order.filter((f) => {
    if (has(f)) return true
    // 只读态：空栏不渲染（与 paper.js usesCol 的 !editable 分支一致）
    if (!editable) return false
    if (type === 'ONE') return f === 'centerContent'
    if (type === 'TWO') return f === 'leftContent' || f === 'rightContent'
    if (type === 'THREE') return true
    return f === 'centerContent'
  })
}

const TRACKS = {
  ONE: [{ w: 1, auto: false }],
  TWO: [{ w: 1, auto: false }, { w: 0, auto: true }],
  THREE: [{ w: 0.9, auto: false }, { w: 1, auto: false }, { w: 0, auto: true }]
}
const COLUMN_GAP = 14

const FIELD_STYLE = {
  leftContent: { weight: 600, color: C.ink, wrap: true },
  centerContent: { weight: 400, color: C.ink, wrap: true },
  rightContent: { weight: 400, color: C.right, wrap: false }
}

/**
 * 单个条目的完整几何。
 *
 * 关键点：CSS grid 的轨道由 .t-one / .t-two / .t-three 的 grid-template-columns
 * 定义，与「实际渲染了几个子元素」无关——子元素按顺序自动落位。因此只读态下
 * THREE 条目若只剩中间一栏，它会落在第一列（0.9fr）而不是中间列。这里如实复刻，
 * 避免屏幕排版与导出 / 页数判定各说各话。
 */
function layoutItem (S, item, editable) {
  const type = String(item.type || 'ONE').toUpperCase()
  const tracks = TRACKS[type] || TRACKS.ONE
  const fields = renderedFields(item, editable)
  if (!fields.length) return { height: 0, rows: 0, cells: [] }

  const slots = fields.map((field, idx) => ({ field, trackIdx: Math.min(idx, tracks.length - 1) }))

  /**
   * 该栏参与宽度计算时所用的文字。
   *
   * 编辑态下空栏渲染的是**占位文案**（「学校/公司等」「202x.07 - 202x.09」），
   * 而 auto 轨道按内容宽度收缩——占位文案有多宽，右栏就占多宽。
   * 若这里按空串测量，右栏会被算成 0 宽，比例列于是宽出几十像素，
   * 「屏幕上的排版」与「引擎算出的页数 / 导出」就此分家。只读态空栏不渲染，
   * 才真正按空串计。
   */
  const meta = ITEM_META[type] || ITEM_META.ONE
  const contentOf = (field) => {
    const raw = item[field]
    const text = raw == null ? '' : String(raw)
    if (text.trim()) return text
    if (!editable) return ''
    if (field === 'leftContent') return meta.leftPlaceholder || ''
    if (field === 'rightContent') return meta.rightPlaceholder || ''
    return meta.centerPlaceholder || ''
  }

  // auto 轨道按内容宽度（nowrap）计
  let autoTotal = 0
  for (const s of slots) {
    if (tracks[s.trackIdx].auto) {
      const st = FIELD_STYLE[s.field]
      autoTotal += textWidth(contentOf(s.field), fontOf(S.fontSize, st.weight, S.fontFamily), S.fontSpacing)
    }
  }
  const gaps = (tracks.length - 1) * COLUMN_GAP
  const remaining = Math.max(0, S.contentWidth - gaps - autoTotal)
  const frTotal = tracks.reduce((a, t) => a + (t.auto ? 0 : t.w), 0) || 1

  // 先算每栏宽度，再逐个定位
  const widths = slots.map((s) => {
    const t = tracks[s.trackIdx]
    if (t.auto) return textWidth(contentOf(s.field), fontOf(S.fontSize, FIELD_STYLE[s.field].weight, S.fontFamily), S.fontSpacing)
    return remaining * (t.w / frTotal)
  })

  let maxRows = 0
  const cells = []
  let x = 0
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]
    const st = FIELD_STYLE[s.field]
    const font = fontOf(S.fontSize, st.weight, S.fontFamily)
    const width = widths[i]
    const isList = s.field === 'centerContent' && isListContent(item[s.field])
    const padLeft = isList ? 2.8 * S.fontSize : 0
    const inner = Math.max(1, width - padLeft)
    /*
     * 空栏的高度取决于渲染模式，这是屏幕排版与页数判定必须同源的一个细节：
     *   编辑态：WXML 渲染 <text class="cell-ph">占位文字</text>，真实占一行；
     *   只读态：WXML 什么都不渲染，该栏高度为 0。
     * 若一律按「一行」估算，只读预览就会比编辑态矮一截（反之亦然），
     * 「共几页」于是跟着两种模式各说各话。
     */
    const rawText = item[s.field]
    const text = rawText == null ? '' : String(rawText)
    const isEmpty = !text.trim()
    let lines
    if (isEmpty && !editable) lines = []
    else if (st.wrap) lines = wrapText(text, inner, font, S.fontSpacing)
    else lines = [text]
    maxRows = Math.max(maxRows, lines.length)
    cells.push({
      field: s.field,
      x,
      width,
      trackAuto: !!tracks[s.trackIdx].auto,
      padLeft,
      lines,
      isList,
      font,
      weight: st.weight,
      color: st.color,
      align: st.wrap ? 'left' : 'right'
    })
    x += width + COLUMN_GAP
  }
  return { height: maxRows * S.lineBox, rows: maxRows, cells, type }
}

/* ------------------------------------------------------------------ */
/*  页眉 / 侧栏                                                        */
/* ------------------------------------------------------------------ */

function basePairsOf (r) {
  const on = r.baseFields || []
  const info = r.baseInfo || {}
  return BASE_FIELDS
    .filter((f) => on.includes(f.key) && String(info[f.key] == null ? '' : info[f.key]).trim())
    .filter((f) => f.key !== 'name')
    .map((f) => ({ key: f.key, label: f.label, value: String(info[f.key]) }))
}

/** 照片盒（含编辑态的空照片占位块） */
function photoBox (S, opts, x) {
  const r = S.resume
  const w = Number(r.personalPhotoWidth) || 90
  if (r.personalPhoto) {
    const h = Number(r.personalPhotoHeight) || 112
    const top = Number(r.personalPhotoTop) || 0
    return {
      show: true, x, y: top, w, h,
      shape: r.personalPhotoShape || 'rect',
      border: r.personalPhotoBorder || 'none',
      borderColor: r.headingColor,
      src: r.personalPhoto,
      marginTop: top,
      marginRight: Number(r.personalPhotoRight) || 0
    }
  }
  if (opts && opts.editable) {
    return { show: true, x, y: 0, w, h: 120, placeholder: true, marginTop: 0, marginRight: 0 }
  }
  return { show: false, h: 0, w: 0, marginTop: 0, marginRight: 0 }
}

/** 单栏页眉：左侧姓名 + 两列信息，右侧照片 */
function layoutHead (S, opts) {
  const r = S.resume
  const pairs = basePairsOf(r)
  const nameSize = 1.85 * S.fontSize
  const nameBox = nameSize * S.lineHeight
  const nameMargin = 8
  const colW = (S.contentWidth - 18) / 2
  const font = fontOf(S.fontSize, 400, S.fontFamily)

  // 两列信息：第 i 项落在第 (i%2) 列
  const grid = []
  const rowsH = []
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]
    const col = i % 2
    const row = Math.floor(i / 2)
    const labelW = textWidth(p.label, font, S.fontSpacing)
    const valueX = col * (colW + 18) + labelW + 4
    const valueW = Math.max(1, colW - labelW - 4)
    const lines = wrapText(p.value, valueW, font, S.fontSpacing)
    grid.push({
      key: p.key,
      label: p.label,
      labelX: col * (colW + 18),
      valueX,
      lines,
      col
    })
    rowsH[row] = Math.max(rowsH[row] || 0, lines.length * S.lineBox)
  }
  let y = 0
  for (let row = 0; row < rowsH.length; row++) {
    for (const g of grid) {
      if (Math.floor(grid.indexOf(g) / 2) === row) g.y = y
    }
    y += rowsH[row] + (row > 0 ? 2 : 0)
  }

  const textH = nameBox + nameMargin + y
  const photo = photoBox(S, opts, 0)
  const photoH = photo.show ? photo.marginTop + photo.h : 0
  const height = Math.max(textH, photoH)

  // 照片靠右：x = 内容宽 - 照片宽 - 右边距
  if (photo.show) {
    photo.x = S.contentWidth - photo.w - photo.marginRight
    photo.y = photo.marginTop
  }

  return {
    height,
    marginBottom: 20,
    name: { text: (r.baseInfo && r.baseInfo.name) || '', size: nameSize, y: 0, box: nameBox, font: fontOf(nameSize, 700, S.fontFamily) },
    nameBox,
    nameMargin,
    grid,
    gridHeight: y,
    photo,
    pairs
  }
}

/** 双栏侧栏：照片 + 姓名 + 信息列表 */
function layoutSide (S, opts, x, sideWidth) {
  const r = S.resume
  const accent = !!r.accentBlock
  const padX = accent ? 14 : 0
  const padY = accent ? 16 : 0
  const inner = Math.max(1, sideWidth - padX * 2)
  const font = fontOf(S.fontSize, 400, S.fontFamily)

  let y = padY
  const photo = photoBox(S, opts, x + padX)
  const photoWrap = { x: x + padX, y, w: inner, h: 0 }
  if (photo.show) {
    photo.x = x + padX
    photo.y = y + photo.marginTop
    photoWrap.h = photo.marginTop + photo.h
    y += photoWrap.h + (photo.show ? 12 : 0)
  }

  const nameSize = 1.5 * S.fontSize
  const nameBox = nameSize * S.lineHeight
  const nameMargin = 10
  const name = {
    text: (r.baseInfo && r.baseInfo.name) || '',
    x: x + padX, y, size: nameSize, box: nameBox,
    font: fontOf(nameSize, 700, S.fontFamily)
  }
  y += nameBox + nameMargin

  const labelSize = 0.95 * S.fontSize
  const list = []
  for (const p of basePairsOf(r)) {
    const labelY = y + 8
    const valueY = labelY + labelSize * S.lineHeight + 1
    const lines = wrapText(p.value, inner, font, S.fontSpacing)
    list.push({ key: p.key, label: p.label, labelX: x + padX, labelY, valueX: x + padX, valueY, lines })
    y = valueY + lines.length * S.lineBox
  }
  y += padY

  return {
    height: y, x, width: sideWidth, padX, padY, inner,
    accent,
    photo, photoWrap,
    name, nameMargin,
    list,
    style: accent ? { background: '#f5f6f8', padding: padY + 'px ' + padX + 'px', borderRadius: '6px' } : null
  }
}

/* ------------------------------------------------------------------ */
/*  区块                                                               */
/* ------------------------------------------------------------------ */

function layoutSection (S, section, x, top, editable) {
  const titleSize = 1.12 * S.fontSize
  const titleFont = fontOf(titleSize, 700, S.fontFamily)
  const titleLines = wrapText(section.title || '', S.contentWidth, titleFont, S.fontSpacing + 1)
  const titleLineBox = titleSize * S.lineHeight
  const titleExtra = headingExtra(S.resume.headingTheme)
  const titleHeight = titleLines.length * titleLineBox + titleExtra
  // .sec-title { margin-bottom: 1.384em }，em 相对标题自身字号
  const titleMargin = 1.384 * titleSize
  // 标题盒宽度 = 最长一行的文字宽度；居中时用它把盒摆到中间
  let titleTextW = 0
  for (const l of titleLines) titleTextW = Math.max(titleTextW, textWidth(l, titleFont, S.fontSpacing + 1))
  titleTextW = Math.min(Math.max(titleTextW, 1), S.contentWidth)

  const gap = 0.18 * S.fontSize
  const items = []
  let y = top + titleHeight + titleMargin
  for (let i = 0; i < section.items.length; i++) {
    if (i > 0) y += gap
    const g = layoutItem(S, section.items[i], editable)
    items.push({
      id: section.items[i].id,
      y,
      height: g.height,
      rows: g.rows,
      // 栏位坐标从「区块正文左边缘」平移到绝对坐标
      cells: g.cells.map((c) => Object.assign({}, c, { x: c.x + x })),
      itemType: g.type
    })
    y += g.height
  }
  const bodyHeight = items.reduce((a, it) => a + it.height, 0) + (items.length > 1 ? (items.length - 1) * gap : 0)
  // 区块高度 = 标题 + 标题下间距 + 正文；标题若有装饰底（色块 / 淡底）则底宽取内容最宽处，
  // 与参考站 display:inline-block 的收缩行为一致——这里用最长标题行宽度近似。
  return {
    id: section.id,
    title: section.title,
    titleLines,
    titleFont,
    titleSize,
    titleLineBox,
    titleExtra,
    titleHeight,
    titleMargin,
    titleColor: headingTextColor(S.resume),
    titleBox: headingBox(S.resume, titleSize, titleLineBox, titleTextW),
    titleX: x,
    titleTop: top,
    titleTextW,
    headingCenter: !!S.resume.headingCenter,
    // 居中的标题（headingCenter）在块内水平居中
    titleDrawX: S.resume.headingCenter ? x + Math.max(0, (S.contentWidth - titleTextW) / 2) : x,
    contentX: x,
    contentWidth: S.contentWidth,
    items,
    bodyHeight,
    height: titleHeight + titleMargin + bodyHeight
  }
}

/* ------------------------------------------------------------------ */
/*  主布局                                                             */
/* ------------------------------------------------------------------ */

function layoutResume (resume, params, opts) {
  const o = opts || {}
  const S = resolveStyle(resume, params)
  const r = S.resume
  const layout = r.pageLayout || 'SINGLE'
  const visible = (r.sections || []).filter((s) => s.visible !== false)

  if (layout === 'SINGLE') {
    const head = layoutHead(S, o)
    let top = S.vPad + head.height + head.marginBottom
    const sections = []
    for (const s of visible) {
      const box = layoutSection(S, s, S.hPad, top, o.editable)
      sections.push(box)
      top += box.height + S.sectionSpacing
    }
    // 内容底边 = 最后一个区块的底；没有区块时退化为页眉底
    const last = sections[sections.length - 1]
    const contentBottom = last ? last.titleTop + last.height : S.vPad + head.height
    return {
      style: S,
      layout,
      head,
      side: null,
      cols: null,
      mainX: S.hPad,
      mainWidth: S.contentWidth,
      sections,
      contentTop: S.vPad,
      contentBottom: Math.max(contentBottom, S.vPad + head.height),
      pageWidth: A4_W,
      colGap: 0
    }
  }

  // 列宽口径必须与 paper.wxss 的 grid-template-columns 完全一致，
  // 否则「屏幕上的排版」与「引擎算出的页数」会分道扬镳：
  //   .cols { gap: 26px; grid-template-columns: R% 1fr }   (LEFT)
  //   .cols { gap: 26px; grid-template-columns: 1fr R% }   (RIGHT)
  // 关键点：百分比轨道算的是**内容盒宽度**（不含 gap），auto 轨道再吃掉
  // 剩余空间。此前误用「先减 gap 再乘比例」，左栏因此宽了约 9px、
  // 右栏反而窄了 13px（因为 50% + 50% + 26px 会溢出，浏览器让 auto 轨道吸收）。
  const ratio = S.baseInfoRatio / 100
  const colGap = 26
  // 百分比轨道宽度：以内容盒宽度为基准（不含 gap）。LEFT 与 RIGHT 下
  // 百分比列都是**信息栏**，只是它在 grid 里的次序不同，宽度公式完全一样。
  const pctWidth = S.contentWidth * ratio
  // auto 轨道吃掉剩余空间（可能为负 → 夹到 0）
  const autoWidth = Math.max(0, S.contentWidth - colGap - pctWidth)

  /*
   * 百分比轨道**始终是信息栏**，auto 轨道始终是主栏：
   *   LEFT  → grid-template-columns: R% 1fr    → 第 1 列（侧栏）= R%
   *   RIGHT → grid-template-columns: 1fr R%    → 第 2 列（侧栏）= R%
   * 两条规则里的 R% 都算在内容盒宽度上、且第 1 列不扣 gap。
   * 浏览器实测（RIGHT / 50% / 内容宽 698）：grid 解析为 323px 349px，
   * 即主栏 323、侧栏 349 —— 与「侧栏 = 百分比列」完全吻合。
   */
  const sideWidth = pctWidth
  const mainWidth = autoWidth
  const sideX = layout === 'LEFT' ? S.hPad : S.hPad + mainWidth + colGap
  const mainX = layout === 'LEFT' ? S.hPad + sideWidth + colGap : S.hPad

  const side = layoutSide(S, o, sideX, sideWidth)
  const mainStyle = Object.assign({}, S, { contentWidth: mainWidth })

  let top = S.vPad
  const sections = []
  for (const s of visible) {
    const box = layoutSection(mainStyle, s, mainX, top, o.editable)
    sections.push(box)
    top += box.height + S.sectionSpacing
  }
  const last = sections[sections.length - 1]
  const mainBottom = last ? last.titleTop + last.height : S.vPad
  const mainHeight = mainBottom - S.vPad
  const colsHeight = Math.max(side.height, mainHeight)

  return {
    style: mainStyle,
    pageStyle: S,
    layout,
    head: null,
    side,
    cols: { top: S.vPad, height: colsHeight, sideHeight: side.height, mainHeight, mainBottom },
    mainX,
    mainWidth,
    sideX,
    sideWidth,
    colGap,
    sections,
    contentTop: S.vPad,
    contentBottom: S.vPad + colsHeight,
    pageWidth: A4_W
  }
}

/**
 * 智能一页用的测量函数：内容实际占用的高度（含上下边距）。
 * 口径与 paginateResume() 判页数时完全一致，避免
 * 「页数提示说刚好一页、智能一页却说溢出」这类自相矛盾。
 */
function measureHeight (resume) {
  return (params) => {
    const L = layoutResume(resume, params)
    const vPad = (L.pageStyle || L.style).vPad
    return L.contentBottom + vPad
  }
}

/**
 * A4 软分页 —— 逐条移植参考站 ResumePaper.vue 的 layoutPages()。
 *
 * 1. 默认以「区块」为不可分割的整体：区块被页缝劈开会让人读不出条目属于哪个区块。
 * 2. 只有区块本身就超过一整页时才退到条目粒度，此时至少别让单个条目被劈开。
 * 3. 顺序推挤：某个区块被推到下一页，会把它后面的内容一起带走。
 * 4. 页数按「内容底边 + 下内边距」判，容差 PAGINATION_SLACK 体现在下内边距里。
 */
function paginateResume (resume, params, opts) {
  const L = layoutResume(resume, params, opts)
  const S = L.pageStyle || L.style
  const padY = S.vPad
  const padBottom = Math.max(0, padY - PAGINATION_SLACK)
  const pageBottom = (p) => (p + 1) * A4_H - padBottom
  const pageTop = (p) => p * A4_H + padY
  const usable = A4_H - padY - padBottom

  // 采集排版单元：区块放得下就用区块，否则降级到条目
  const units = []
  for (const box of L.sections) {
    if (box.height <= usable) {
      units.push({ kind: 'section', id: box.id, top: box.titleTop, height: box.height })
      continue
    }
    for (const it of box.items) units.push({ kind: 'item', id: it.id, top: it.y, height: it.height, secId: box.id })
  }

  const pushes = {}
  let wantSum = 0
  let page = 0
  /*
   * 单元位移计划（unitPlan）：按流式顺序记录每个排版单元最终应应用的
   * 纵向位移 shift（含此前所有推挤量的累积）。
   *
   * 为什么需要它：pushes 只记录「推挤发生了多少」，但自然流里仍会有单元
   * 横跨页缝（例如条目 y=1108、高 23，页缝 1123 正好从文字中间切过）。
   * 逐页导出（PDF）据此把每个单元搬到它最终的页面上绘制，页缝永远落在
   * 单元之间；长图 / 屏幕的连续流渲染不使用它，行为不变。
   */
  const unitPlan = []
  for (const u of units) {
    let top = u.top + wantSum
    // 先判溢出、再推进页码：反过来会让顶部已探出页底的单元被误判为「下一页的内容」
    if (u.height <= usable && top + u.height > pageBottom(page)) {
      page += 1
      const delta = pageTop(page) - top
      wantSum += delta
      top += delta
      pushes[u.id] = Math.round(delta)
    }
    while (top + u.height > pageBottom(page)) page += 1
    unitPlan.push({
      kind: u.kind,
      id: u.id,
      secId: u.secId || '',
      top: u.top,
      height: u.height,
      shift: wantSum
    })
  }

  // 推挤后的内容底边
  let bottom = L.contentBottom
  const pushedIds = Object.keys(pushes)
  if (pushedIds.length) {
    if (L.layout === 'SINGLE') {
      let acc = 0
      for (const s of L.sections) acc += pushes[s.id] || 0
      bottom = L.contentBottom + acc
    } else {
      // 双栏：区块被推挤会同时抬高主栏底边，侧栏高度不变
      let acc = 0
      for (const s of L.sections) acc += pushes[s.id] || 0
      const lastBox = L.sections[L.sections.length - 1]
      const mainBottom = (lastBox ? lastBox.titleTop + lastBox.height : L.contentTop) + acc
      bottom = L.contentTop + Math.max(L.side.height, mainBottom - L.contentTop)
    }
  }

  const total = Math.max(1, Math.ceil((bottom + padBottom - 0.5) / A4_H))
  return {
    pages: total,
    pushes,
    unitPlan,
    padBottom,
    minHeight: total * A4_H,
    contentBottom: bottom,
    layout: L
  }
}

module.exports = {
  A4_W,
  A4_H,
  PAGINATION_SLACK,
  COLORS: C,
  CANVAS_FAMILY,
  resolveStyle,
  layoutResume,
  layoutHead,
  layoutSide,
  layoutSection,
  layoutItem,
  paginateResume,
  measureHeight,
  wrapText,
  textWidth,
  setMeasureOverride,
  fontOf,
  headingExtra,
  headingTextColor,
  isListContent,
  basePairsOf,
  renderedFields
}
