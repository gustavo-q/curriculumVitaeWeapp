/**
 * Word(.doc) 导出 —— 生成「带 Word 头注的 HTML」让 Word / WPS 直接打开再编辑。
 *
 * 为什么是 HTML 而不是真 .docx
 * ----------------
 * .docx 是 ZIP 容器（OOXML），小程序没有打包 ZIP 的能力；而「Word HTML」
 * （HTML 前缀 Word 专有头注，扩展名 .doc）是 Word 与 WPS 原生支持的格式，
 * 双击即可打开、可继续编辑、可另存为 .docx —— 对简历这类以文字为主的
 * 文档，HTML 能把内容与结构完整带过去。
 *
 * 版式与屏幕 / PNG / PDF 同源：排版参数（字号 / 行距 / 字距 / 边距 /
 * 分栏 / 标题装饰 / 配色）全部取自简历数据本身，换模板后导出的 Word
 * 跟着变，和纸面看到的一致。px 单位按 96dpi 直出，Word 会按 A4 页面
 * 宽度重排，落点与纸面相同。
 */

const { BASE_FIELDS, FONT_FAMILIES, ITEM_META } = require('./model.js')

/** 与 paper.wxss 同源的默认值（与 utils/paper.js 的 STYLE_DEFAULTS 一致） */
const STYLE_DEFAULTS = {
  fontSize: 14,
  lineHeight: 1.65,
  fontSpacing: 0,
  horizontalPadding: 48,
  verticalPadding: 36,
  sectionSpacing: 18,
  baseInfoRatio: 50
}

/** 标题装饰（与 paper.js 的 buildHeadingStyle 同源，输出 CSS） */
function headingCss (r) {
  const c = r.headingColor || '#1f4e79'
  switch (r.headingTheme) {
    case 'block':
      return 'background:' + c + ';color:#ffffff;padding:2px 10px;border-radius:3px;'
    case 'filled':
      return 'background:' + c + ';color:#ffffff;padding:4px 12px;'
    case 'line':
      return 'border-bottom:1.5pt solid ' + c + ';padding-bottom:4px;color:' + (r.headingFontColor || '#23282f') + ';'
    case 'double':
      return 'border-bottom:3px double ' + c + ';padding-bottom:4px;color:' + (r.headingFontColor || '#23282f') + ';'
    case 'bar':
      return 'border-left:3px solid ' + c + ';padding-left:8px;color:' + (r.headingFontColor || '#23282f') + ';'
    case 'dot':
      return 'padding-left:13px;color:' + (r.headingFontColor || '#23282f') + ';'
    case 'outline':
      return 'border:1px solid ' + c + ';color:' + c + ';padding:2px 9px;'
    case 'tint':
      return 'background:' + c + '22;border-left:3px solid ' + c + ';color:' + c + ';padding:3px 10px;'
    default:
      return 'color:' + (r.headingFontColor || '#23282f') + ';'
  }
}

/** 标题盒的额外上下空间（与 layout.js 的 headingExtra 同源，单位 px） */
function headingExtra (theme) {
  switch (theme) {
    case 'block': return 4
    case 'filled': return 8
    case 'outline': return 6
    case 'tint': return 6
    case 'line': return 5.5
    case 'double': return 5
    default: return 0
  }
}

/** 字体栈：与 paper.js 的 pickFontStack 同源 */
function fontStack (id) {
  return (FONT_FAMILIES.find((f) => f.id === id) || FONT_FAMILIES[0]).stack
}

/** HTML 转义 */
function esc (s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 文本 → HTML（保留换行与行首项目符号的悬挂缩进，判据与 layout.js 一致） */
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

function nl2br (s) {
  return esc(s).replace(/\r\n?/g, '\n').replace(/\n/g, '<br/>')
}

/** 基本信息「标签 + 值」对（与 paper.js 的 buildBasePairs 同源） */
function basePairs (r) {
  const on = r.baseFields || []
  const info = r.baseInfo || {}
  return BASE_FIELDS
    .filter((f) => on.includes(f.key) && String(info[f.key] == null ? '' : info[f.key]).trim())
    .filter((f) => f.key !== 'name')
    .map((f) => ({ key: f.key, label: f.label, value: String(info[f.key]) }))
}

/** 该条目类型实际渲染哪几栏（与 layout.js / paper.js 的只读口径一致） */
function renderedFields (item) {
  const type = String(item.type || 'ONE').toUpperCase()
  const order = ['leftContent', 'centerContent', 'rightContent']
  return order.filter((f) => !!(item[f] && String(item[f]).trim()))
}

/**
 * 简历 → Word HTML 文档全文。
 *
 * @param {object} resume 简历数据（草稿对象本身）
 * @returns {string} 完整 HTML（含 Word 头注），调用方直接写盘为 .doc
 */
function resumeToWordHtml (resume) {
  const r = resume || {}
  const fontSize = Number(r.fontSize) || STYLE_DEFAULTS.fontSize
  const lineHeight = Number(r.lineHeight) || STYLE_DEFAULTS.lineHeight
  const spacing = Number(r.fontSpacing) || 0
  const hPad = Number(r.horizontalPadding) || STYLE_DEFAULTS.horizontalPadding
  const vPad = Number(r.verticalPadding) || STYLE_DEFAULTS.verticalPadding
  const secSpacing = Number(r.sectionSpacing == null ? STYLE_DEFAULTS.sectionSpacing : r.sectionSpacing)
  const ratio = Number(r.baseInfoRatio) || STYLE_DEFAULTS.baseInfoRatio
  const layout = r.pageLayout || 'SINGLE'
  const theme = r.headingTheme || 'line'
  const pairs = basePairs(r)
  const name = (r.baseInfo && r.baseInfo.name) || ''

  // 主题色 → 条目左栏的强调色（标题装饰已经带色，这里只给「左栏加粗」正文用默认墨色）
  const gapY = secSpacing + 'px'

  const body = []
  /* ---------- 页眉 ---------- */
  if (layout === 'SINGLE') {
    const headCells = []
    const colW = Math.floor((794 - 2 * hPad - 18) / 2)
    for (let i = 0; i < pairs.length; i += 2) {
      const cells = [pairs[i], pairs[i + 1]].filter(Boolean)
        .map((p) => '<td style="width:' + colW + 'px;font-size:' + fontSize + 'px;color:#6b7280;line-height:' + lineHeight + ';">' +
          '<span style="color:#6b7280;">' + esc(p.label) + '</span>' +
          '<span style="color:#23282f;margin-left:4px;">' + nl2br(p.value) + '</span></td>')
      headCells.push('<tr>' + cells.join('') + '</tr>')
    }
    body.push(
      '<table style="width:100%;border-collapse:collapse;"><tr>' +
      '<td style="vertical-align:top;">' +
      '<div style="font-size:' + (fontSize * 1.85).toFixed(1) + 'px;font-weight:bold;letter-spacing:2px;color:#23282f;line-height:' + lineHeight + ';">' + esc(name || '未命名简历') + '</div>' +
      '<table style="width:100%;border-collapse:collapse;margin-top:8px;">' + headCells.join('') + '</table>' +
      '</td>' +
      '</tr></table>'
    )
  } else {
    // 双栏：信息栏 + 主栏并排。Word 对 float/grid 的支持有限，用表格实现最稳。
    const sideW = Math.floor((794 - 2 * hPad - 26) * ratio / 100)
    const sideRows = pairs.map((p) =>
      '<div style="margin-bottom:' + (fontSize * 0.95).toFixed(1) + 'px;">' +
      '<div style="font-size:' + (fontSize * 0.95).toFixed(1) + 'px;color:#6b7280;">' + esc(p.label) + '</div>' +
      '<div style="font-size:' + fontSize + 'px;color:#23282f;line-height:' + lineHeight + ';">' + nl2br(p.value) + '</div>' +
      '</div>'
    ).join('')
    const sideInner =
      '<div style="font-size:' + (fontSize * 1.5).toFixed(1) + 'px;font-weight:bold;letter-spacing:1px;color:#23282f;margin-bottom:10px;line-height:' + lineHeight + ';">' + esc(name || '未命名简历') + '</div>' +
      (r.accentBlock
        ? '<div style="background:#f5f6f8;border-radius:6px;padding:16px 14px;">' + sideRows + '</div>'
        : sideRows)
    const mainTd = '<td style="vertical-align:top;padding:0;">'
    const sideTd = '<td style="vertical-align:top;width:' + sideW + 'px;' + (layout === 'LEFT' ? 'padding-right:26px;' : 'padding-left:26px;') + '">'
    body.push('<table style="width:100%;border-collapse:collapse;"><tr>' +
      (layout === 'LEFT' ? sideTd + sideInner + '</td>' + mainTd + '{{MAIN}}</td>'
                         : mainTd + '{{MAIN}}</td>' + sideTd + sideInner + '</td>') +
      '</tr></table>')
  }

  /* ---------- 区块 ---------- */
  const sectionsHtml = []
  const visible = (r.sections || []).filter((s) => s.visible !== false)
  for (const s of visible) {
    const titleSize = 1.12 * fontSize
    const css = headingCss(r)
    const extra = headingExtra(theme)
    let h = '<div class="sec-title" style="font-size:' + titleSize.toFixed(1) + 'px;font-weight:bold;line-height:' + lineHeight + ';' +
      (theme === 'block' || theme === 'filled' || theme === 'outline' || theme === 'tint' ? 'display:inline-block;' : 'display:block;') +
      (r.headingCenter ? 'text-align:center;' : '') + css + 'padding-top:' + (extra / 2).toFixed(1) + 'px;padding-bottom:' + (extra / 2).toFixed(1) + 'px;">' +
      esc(s.title || '') + '</div>'
    const itemsHtml = (s.items || []).map((it) => {
      const fields = renderedFields(it)
      if (!fields.length) return ''
      const type = String(it.type || 'ONE').toUpperCase()
      const isList = isListContent(it.centerContent)
      // 栏宽比例与 layout.js 的 TRACKS 一致：ONE 整行、TWO 左 fr 右 auto、THREE 0.9fr/1fr/auto
      const listPad = isList ? (2.8 * fontSize).toFixed(1) + 'px' : '0'
      if (type === 'ONE') {
        return '<div style="font-size:' + fontSize + 'px;line-height:' + lineHeight + ';letter-spacing:' + spacing + 'px;color:#23282f;' +
          (isList ? 'padding-left:' + listPad + ';' : '') + 'margin-bottom:2px;">' + nl2br(it.centerContent) + '</div>'
      }
      // TWO / THREE：三格表格（Word 对 grid 支持差，表格最稳）
      const cells = []
      for (const f of ['leftContent', 'centerContent', 'rightContent']) {
        if (!fields.includes(f)) { cells.push(null); continue }
        const bold = f === 'leftContent'
        const color = f === 'rightContent' ? '#4b5560' : '#23282f'
        const align = f === 'rightContent' ? 'right' : 'left'
        const txt = f === 'centerContent' && isList ? nl2br(it[f]) : nl2br(it[f])
        cells.push({ f, bold, color, align, txt })
      }
      // 空列也要占位以保持列序
      const tds = cells.map((c) => c
        ? '<td style="vertical-align:top;text-align:' + c.align + ';font-size:' + fontSize + 'px;line-height:' + lineHeight + ';letter-spacing:' + spacing + 'px;' +
          (c.bold ? 'font-weight:bold;' : '') + 'color:' + c.color + ';' + (c.f === 'centerContent' && isList ? 'padding-left:' + listPad + ';' : '') + '">' + c.txt + '</td>'
        : '<td></td>')
      return '<table style="width:100%;border-collapse:collapse;margin-bottom:2px;"><tr>' + tds.join('') + '</tr></table>'
    }).join('')
    sectionsHtml.push(
      '<div style="margin-bottom:' + gapY + ';">' + h +
      '<div style="margin-top:' + (1.384 * 1.12 * fontSize).toFixed(1) + 'px;"></div>' + itemsHtml + '</div>'
    )
  }

  // 把区块填进主栏占位（双栏）或直接顺序输出（单栏）
  let content
  const mainHtml = sectionsHtml.join('')
  if (layout === 'SINGLE') {
    content = body.join('') + '<div style="margin-top:' + (20) + 'px;"></div>' + mainHtml
  } else {
    content = body.join('').replace('{{MAIN}}', mainHtml)
  }

  /* ---------- 整页文档 ---------- */
  const head =
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">' +
    '<head><meta charset="utf-8"/>' +
    '<title>' + esc(r.resumeName || '简历') + '</title>' +
    '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->' +
    '<style>@page { size: 210mm 297mm; margin: ' + vPad + 'px ' + hPad + 'px; }' +
    'body { font-family: ' + fontStack(r.fontFamily) + '; }' +
    '.sec-title { margin-bottom:0; }</style>' +
    '</head><body>'
  const foot = '</body></html>'
  return head + '<div style="font-size:' + fontSize + 'px;line-height:' + lineHeight + ';color:#23282f;">' + content + '</div>' + foot
}

module.exports = { resumeToWordHtml, STYLE_DEFAULTS }
