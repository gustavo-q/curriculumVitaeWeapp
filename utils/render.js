/**
 * Canvas 渲染器 —— 导出 PNG 长图
 *
 * 分工：
 *   · 编辑 / 预览用 WXML 渲染（矢量、清晰、可点击、原生中文换行）
 *   · 导出与相册保存走 canvas（小程序里没有别的办法把视图变成图片）
 *   · 智能一页的试算走 utils/layout.js（需要在同一帧里量几十次，不能等渲染）
 *
 * 三条路共用同一套样式常量（字号 / 行距 / 边距 / 栏宽比例 / 标题装饰），
 * 因此导出的长图与屏幕上的纸面是同一份排版，不会出现参考站早期
 * 「预览一页、导出两页」那种偏差。
 */

const L = require('./layout.js')
const { resolvePhoto } = require('./avatars.js')

const A4_W = L.A4_W
const A4_H = L.A4_H
const { fontOf } = L

/**
 * 按字距逐字绘制。
 *
 * 为什么不用 ctx.letterSpacing：该属性在部分基础库 / 平台不生效，
 * 而字距是模板风格的一部分（英文时报、疏朗衬线都靠它）。
 * 逐字绘制在任何版本上表现一致，代价只是长文本多几次 fillText。
 */
function drawText (ctx, text, x, y, opt) {
  const s = String(text == null ? '' : text)
  if (!s) return
  const ls = Number(opt.fontSpacing) || 0
  ctx.font = opt.font
  ctx.fillStyle = opt.color
  if (!ls) {
    /*
     * ★ 右对齐必须真的右对齐。
     *
     * fillText 默认从 x 起向右画（textAlign='start'），而右对齐栏传入的 x 是
     * 「列的右边缘」——直接 fillText(s, x) 会把整行画到列外，导出图 / PDF 里
     * 时间列、「精通」这类右栏全被纸边裁掉（屏幕预览走 CSS text-align:right，
     * 所以只有导出能看到）。先量出整串宽度再从 x-w 起画，与逐字路径同口径。
     */
    if (opt.align === 'right') {
      ctx.fillText(s, x - ctx.measureText(s).width, y)
      return
    }
    ctx.fillText(s, x, y)
    return
  }
  const chars = Array.from(s)
  if (opt.align === 'right') {
    let total = 0
    for (const ch of chars) total += ctx.measureText(ch).width + ls
    total -= ls
    let cx = x - total
    for (const ch of chars) {
      ctx.fillText(ch, cx, y)
      cx += ctx.measureText(ch).width + ls
    }
    return
  }
  let cx = x
  for (const ch of chars) {
    ctx.fillText(ch, cx, y)
    cx += ctx.measureText(ch).width + ls
  }
}

/** 画一行文本，垂直居中在自己的行盒里（对应 CSS 的行盒模型） */
function drawLine (ctx, text, x, y, lineBox, opt) {
  drawText(ctx, text, x, y + lineBox / 2, opt)
}

/** 预加载一张图；失败返回 null（不因此中断整张简历的导出） */
function loadImage (canvas, src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null)
    let img
    try {
      img = canvas.createImage()
    } catch (e) {
      return resolve(null)
    }
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    try {
      img.src = src
    } catch (e) {
      resolve(null)
    }
  })
}

/** 照片形状 → 裁剪路径 */
function clipPhoto (ctx, p) {
  const r = 6
  ctx.beginPath()
  if (p.shape === 'circle') {
    ctx.arc(p.x + p.w / 2, p.y + p.h / 2, Math.min(p.w, p.h) / 2, 0, Math.PI * 2)
  } else if (p.shape === 'rounded') {
    ctx.moveTo(p.x + r, p.y)
    ctx.lineTo(p.x + p.w - r, p.y)
    ctx.quadraticCurveTo(p.x + p.w, p.y, p.x + p.w, p.y + r)
    ctx.lineTo(p.x + p.w, p.y + p.h - r)
    ctx.quadraticCurveTo(p.x + p.w, p.y + p.h, p.x + p.w - r, p.y + p.h)
    ctx.lineTo(p.x + r, p.y + p.h)
    ctx.quadraticCurveTo(p.x, p.y + p.h, p.x, p.y + p.h - r)
    ctx.lineTo(p.x, p.y + r)
    ctx.quadraticCurveTo(p.x, p.y, p.x + r, p.y)
  } else {
    ctx.rect(p.x, p.y, p.w, p.h)
  }
  ctx.closePath()
}

/** cover 裁剪：保持比例填满目标框（等价 CSS object-fit: cover） */
function drawCover (ctx, img, box) {
  const iw = img.width
  const ih = img.height
  if (!iw || !ih) return
  const scale = Math.max(box.w / iw, box.h / ih)
  const dw = iw * scale
  const dh = ih * scale
  ctx.drawImage(img, box.x + (box.w - dw) / 2, box.y + (box.h - dh) / 2, dw, dh)
}

/** 画照片（含形状裁剪与四种边框） */
function drawPhoto (ctx, p, img) {
  ctx.save()
  clipPhoto(ctx, p)
  ctx.clip()
  ctx.fillStyle = '#eceff2'
  ctx.fillRect(p.x, p.y, p.w, p.h)
  if (img) drawCover(ctx, img, { x: p.x, y: p.y, w: p.w, h: p.h })
  ctx.restore()

  if (p.border === 'thin') {
    ctx.strokeStyle = '#d5dae0'
    ctx.lineWidth = 1
    ctx.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1)
  } else if (p.border === 'theme') {
    ctx.strokeStyle = p.borderColor || '#1f4e79'
    ctx.lineWidth = 2
    ctx.strokeRect(p.x + 1, p.y + 1, p.w - 2, p.h - 2)
  }
}

/** 区块标题（含 9 种装饰） */
function drawSectionTitle (ctx, sec, resume) {
  const box = sec.titleBox
  const x = sec.titleDrawX
  const lineBox = sec.titleLineBox
  const extra = sec.titleExtra
  const top = sec.titleTop
  const th = resume.headingTheme

  /*
   * 背景块 / 描边。
   *
   * 原实现先把 fillRect 画了一遍、再设 fillStyle、又画一遍：第一次用的是
   * 上一次绘制遗留的颜色。对 block/filled（不透明）看不出差别，但 tint 的
   * 填充是半透明的 headingColor + '22'，底色会透出来导致偏色。
   * 现在只画一次，且先设好颜色。
   */
  if (box && box.fill) {
    ctx.fillStyle = box.fill
    if (th === 'tint') ctx.fillRect(x, top + extra / 2, box.size.w + 10, box.size.h)
    else ctx.fillRect(x, top + 2, box.size.w + 20, box.size.h)
  }
  if (box && box.stroke) {
    ctx.strokeStyle = box.stroke
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, top + 3.5, box.size.w + 18, box.size.h - 1)
  }
  if (th === 'bar') {
    ctx.fillStyle = resume.headingColor
    ctx.fillRect(x, top + 2, 3, Math.max(10, extra + lineBox - 4))
  }
  if (th === 'dot') {
    ctx.fillStyle = resume.headingColor
    ctx.globalAlpha = 0.85
    ctx.beginPath()
    ctx.arc(x + 4.5, top + lineBox * 0.52 + 3.5, 3.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1
  }
  /*
   * 下划线 / 双线。
   *
   * 这两种装饰在 paper.wxss 里是「块级元素 + border-bottom」，
   * 线的长度恒等于内容区宽度，与标题居中与否无关（已在浏览器实测：
   * 两种情况下线宽都是 698px = 794 - 48×2）。
   *
   * 原实现写的是 `resume.headingCenter ? box.size.w : sec.contentWidth`，
   * 而 titleBox 只对 block/filled/tint/outline 四种主题非 null，
   * line/double 恰好拿到 null —— 于是「默认主题 line + 打开标题居中 +
   * 导出长图」必然抛 TypeError，导出 100% 失败。
   */
  if (th === 'line' || th === 'double') {
    const y = top + lineBox + extra - 2
    const w = sec.contentWidth
    ctx.strokeStyle = resume.headingColor
    ctx.lineWidth = th === 'line' ? 1.5 : 1
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + w, y)
    ctx.stroke()
    if (th === 'double') {
      ctx.globalAlpha = 0.35
      ctx.beginPath()
      ctx.moveTo(x, y + 3)
      ctx.lineTo(x + w, y + 3)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
  }

  /*
   * 标题文字的起点。
   *
   * inline-block 类装饰（block/filled/outline/tint）在居中时整体右移半个
   * 剩余宽度 —— 浏览器实测：块级标题 left=内容区起点，inline-block+center 的
   * left 偏移 93px。box.size.w 就是这段的实际宽度，因此位移量即
   * (contentWidth - boxW) / 2。若不补偿，导出图里标题会贴在左边，
   * 而屏幕上它是居中的。
   */
  let tx = x
  if (th === 'bar') tx = x + 8
  else if (th === 'dot') tx = x + 13
  else if (th === 'block' || th === 'filled' || th === 'outline' || th === 'tint') {
    tx = x + 10
    if (resume.headingCenter && box) {
      tx += Math.max(0, (sec.contentWidth - box.size.w) / 2)
    }
  }
  const padTop = extra / 2
  for (let i = 0; i < sec.titleLines.length; i++) {
    drawLine(ctx, sec.titleLines[i], tx, top + padTop + i * lineBox, lineBox, {
      font: sec.titleFont,
      color: sec.titleColor,
      fontSpacing: resume.fontSpacing + 1
    })
  }
}

function drawSectionBody (ctx, sec, S) {
  for (const item of sec.items) {
    for (const c of item.cells) {
      let x = c.x
      if (c.align === 'right') x = c.x + c.width
      if (c.padLeft) x += c.padLeft
      for (let i = 0; i < c.lines.length; i++) {
        drawText(ctx, c.lines[i], x, item.y + i * S.lineBox + S.lineBox / 2, {
          font: c.font,
          color: c.color,
          align: c.align,
          fontSpacing: S.fontSpacing
        })
      }
    }
  }
}

/** 单栏页眉：姓名 + 两列信息 + 照片 */
function drawHead (ctx, g, img) {
  const head = g.head
  const S = g.style
  const top = S.vPad
  drawLine(ctx, head.name.text, S.hPad, top + head.name.y, head.name.box, {
    font: head.name.font,
    color: '#23282f',
    fontSpacing: 2
  })
  const gridTop = top + head.name.box + head.nameMargin
  const font = fontOf(S.fontSize, 400, S.fontFamily)
  for (const cell of head.grid) {
    const rowY = gridTop + (cell.y || 0)
    drawLine(ctx, cell.label, S.hPad + cell.labelX, rowY, S.lineBox, {
      font, color: '#6b7280', fontSpacing: S.fontSpacing
    })
    for (let i = 0; i < cell.lines.length; i++) {
      drawLine(ctx, cell.lines[i], S.hPad + cell.valueX, rowY + i * S.lineBox, S.lineBox, {
        font, color: '#23282f', fontSpacing: S.fontSpacing
      })
    }
  }
  if (head.photo.show) {
    const p = Object.assign({}, head.photo, { y: top + head.photo.marginTop })
    drawPhoto(ctx, p, img)
  }
}

/** 双栏信息栏 */
function drawSide (ctx, g, img) {
  const side = g.side
  const S = g.pageStyle
  const top = S.vPad
  if (side.accent) {
    const x = side.x
    const y = top
    const w = side.width
    const h = side.height
    const r = 6
    ctx.fillStyle = '#f5f6f8'
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + w - r, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y + r)
    ctx.lineTo(x + w, y + h - r)
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
    ctx.lineTo(x + r, y + h)
    ctx.quadraticCurveTo(x, y + h, x, y + h - r)
    ctx.lineTo(x, y + r)
    ctx.quadraticCurveTo(x, y, x + r, y)
    ctx.closePath()
    ctx.fill()
  }
  if (side.photo.show) {
    const p = Object.assign({}, side.photo, { y: top + side.photo.y })
    drawPhoto(ctx, p, img)
  }
  drawLine(ctx, side.name.text, side.name.x, top + side.name.y, side.name.box, {
    font: side.name.font, color: '#23282f', fontSpacing: 1
  })
  const labelSize = 0.95 * S.fontSize
  const labelFont = fontOf(labelSize, 400, S.fontFamily)
  const font = fontOf(S.fontSize, 400, S.fontFamily)
  for (const p of side.list) {
    drawLine(ctx, p.label, p.labelX, top + p.labelY, labelSize * S.lineHeight, {
      font: labelFont, color: '#6b7280', fontSpacing: S.fontSpacing
    })
    for (let i = 0; i < p.lines.length; i++) {
      drawLine(ctx, p.lines[i], p.valueX, top + p.valueY + i * S.lineBox, S.lineBox, {
        font, color: '#23282f', fontSpacing: S.fontSpacing
      })
    }
  }
}

/** 纸面边框（4 种） */
function drawPaperBorder (ctx, r, height) {
  if (r.borderTheme === 'thin') {
    ctx.strokeStyle = r.borderColor
    ctx.lineWidth = 1
    ctx.strokeRect(0.5, 0.5, A4_W - 1, height - 1)
  } else if (r.borderTheme === 'double') {
    ctx.strokeStyle = r.borderColor
    ctx.lineWidth = 1
    ctx.strokeRect(0.5, 0.5, A4_W - 1, height - 1)
    ctx.strokeRect(5.5, 5.5, A4_W - 11, height - 11)
  } else if (r.borderTheme === 'dashed') {
    ctx.save()
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = r.borderColor
    ctx.lineWidth = 1
    ctx.strokeRect(0.5, 0.5, A4_W - 1, height - 1)
    ctx.restore()
  }
}

/**
 * 导出画布的边长上限（设备像素）。
 *
 * iOS 的 canvas 后端对单张位图有约 4096×4096 的硬限制，超出后
 * canvasToTempFilePath 会失败或静默产出空白图；Android 各机型差异较大，
 * 但 4096 是公认的安全上界。2 倍高清下这只够约 1.8 页 A4，
 * 因此长图必须按此上限收敛倍率，而不是死守 2 倍。
 */
const MAX_CANVAS_SIDE = 4096

/** 面积上限：iOS 还限制总像素数（约 1670 万），单独限边不够 */
const MAX_CANVAS_AREA = 16777216

/**
 * 为一份简历选出可行的绘制倍率。
 *
 * 优先用请求的倍率；若导致边长或面积超限，则按上限等比缩小，
 * 并保底 1 倍（1 倍仍超限说明内容极长，此时由调用方提示分次导出）。
 *
 * @returns {{scale:number, limited:boolean, cssHeight:number}}
 */
function planScale (resume, cssH, requested) {
  const want = requested || 2
  // 两个约束各自允许的最大倍率，取更小者
  const bySide = MAX_CANVAS_SIDE / Math.max(A4_W, cssH)
  const byArea = Math.sqrt(MAX_CANVAS_AREA / (A4_W * cssH))
  const cap = Math.min(bySide, byArea)
  const scale = Math.max(1, Math.min(want, Number(cap.toFixed(4))))
  return { scale, limited: scale < want - 1e-6, cssHeight: cssH }
}

/**
 * 把简历画进一个 2D 上下文（导出长图用；不分页、不画槽位）。
 *
 * @param {object} ctx     2D 上下文（来自 canvas 组件 nodes 或离屏 canvas）
 * @param {object} canvas  该上下文所属的 canvas（用于 createImage）
 * @param {object} resume  简历数据
 * @param {object} [opts]
 * @param {number} [opts.scale=2] 期望绘制倍率，超限时会自动下调
 * @returns {Promise<{width:number, height:number, scale:number, limited:boolean, layout:object}>}
 */
async function renderToContext (ctx, canvas, resume, opts) {
  const o = opts || {}
  const g = o.layout || L.layoutResume(resume)
  const S = g.pageStyle || g.style
  // 长图高度 = 内容底边 + 下边距（与判页口径同源，因此一页内容就是一张 A4 比例的长图）
  const cssH = Math.max(A4_H, Math.ceil(g.contentBottom + S.vPad))
  // 倍率按画布上限收敛，避免长简历在 iOS 上导出空白图
  const plan = planScale(resume, cssH, o.scale)
  const scale = plan.scale
  const w = Math.round(A4_W * scale)
  const h = Math.round(cssH * scale)

  canvas.width = w
  canvas.height = h
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  ctx.clearRect(0, 0, A4_W, cssH)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, A4_W, cssH)

  const src = resolvePhoto(resume.personalPhoto)
  const img = src ? await loadImage(canvas, src) : null

  drawPaperBorder(ctx, S.resume, cssH)
  if (g.layout === 'SINGLE') drawHead(ctx, g, img)
  else drawSide(ctx, g, img)
  for (const sec of g.sections) {
    drawSectionTitle(ctx, sec, S.resume)
    drawSectionBody(ctx, sec, S)
  }
  return { width: w, height: h, cssHeight: cssH, scale, limited: plan.limited, layout: g }
}

/**
 * 逐页渲染 + 每页导出 JPEG（PDF 导出用）。
 *
 * 分页口径与屏幕同源：
 *   · 几何来自同一次 layoutResume()，页数来自同一个 paginateResume()；
 *   · 屏幕上的纸面是一条连续流，页缝只是画在 y = p×A4_H 的视觉标记；
 *     但连续流里仍会有条目横跨页缝（页缝从文字中间切过）—— paginateResume
 *   的 unitPlan 给出了每个排版单元（区块或条目）的最终纵向位移 shift，
 *   逐页导出据此把单元绘制在它最终落位的位置上，页缝永远落在单元之间。
 *
 * @param {object} ctx     2D 上下文（多页复用同一个 canvas）
 * @param {object} canvas  canvas 节点（用于 createImage）
 * @param {object} resume  简历数据
 * @param {object} [opts]
 * @param {number} [opts.scale=2]   每页渲染倍率（夹在 1~2）
 * @param {function} opts.toFile    async (canvas, pageNo) => filePath
 *                                  每页渲染完调用一次，返回该页文件路径
 * @returns {Promise<{pages:number, scale:number, files:string[]}>}
 */
async function renderPagesToFiles (ctx, canvas, resume, opts) {
  const o = opts || {}
  if (typeof o.toFile !== 'function') throw new Error('renderPagesToFiles 需要 toFile 回调')
  const scale = Math.max(1, Math.min(2, Number(o.scale) || 2))
  const pag = L.paginateResume(resume)
  const g = pag.layout
  const S = g.pageStyle || g.style
  const pages = pag.pages
  const plan = pag.unitPlan || []

  const src = resolvePhoto(resume.personalPhoto)
  const img = src ? await loadImage(canvas, src) : null

  const files = []
  for (let p = 0; p < pages; p++) {
    canvas.width = Math.round(A4_W * scale)
    canvas.height = Math.round(A4_H * scale)
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    ctx.clearRect(0, 0, A4_W, A4_H)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, A4_W, A4_H)

    ctx.save()
    // 本页要画的单元：位移后落在 [p*A4_H, (p+1)*A4_H) 内的那批。
    // 页眉 / 侧栏（画在内容坐标系顶部）恒属第 1 页。
    const lo = p * A4_H
    const hi = (p + 1) * A4_H
    const inPage = (top, shift, height) => {
      const y = top + shift
      // 与本页窗口有交集即画（canvas 自带裁剪，交叠的部分自然被裁掉）
      return y < hi && y + height > lo
    }
    const plannedIds = new Set(plan.map((u) => u.id))
    // 单元绘制辅助：把一个区块盒 / 条目盒画出来（titleTop 或 y 加 shift）
    const drawSection = (sec, shift) => {
      const moved = Object.assign({}, sec, {
        titleTop: sec.titleTop + shift,
        items: sec.items.map((it) => Object.assign({}, it, { y: it.y + shift }))
      })
      drawSectionTitle(ctx, moved, S.resume)
      drawSectionBody(ctx, moved, S)
    }
    if (p === 0) {
      drawPaperBorder(ctx, S.resume, pages * A4_H)
      if (g.layout === 'SINGLE') drawHead(ctx, g, img)
      else drawSide(ctx, g, img)
      // 有计划的区块：只画位移后落在第 1 页窗口内的；整块直接画（canvas 裁剪兜底）
      for (const sec of g.sections) {
        const u = plan.find((x) => x.kind === 'section' && x.id === sec.id)
        if (u && plannedIds.has(sec.id)) {
          if (inPage(sec.titleTop, u.shift, sec.height)) drawSection(sec, u.shift)
        } else if (inPage(sec.titleTop, 0, sec.height)) {
          drawSection(sec, 0)
        }
      }
      // 被拆成条目粒度的区块：按条目计划逐个画（避免整块越页）
      for (const sec of g.sections) {
        if (!plan.some((x) => x.kind === 'item' && x.secId === sec.id)) continue
        for (const it of sec.items) {
          const u = plan.find((x) => x.kind === 'item' && x.id === it.id)
          if (!u) continue
          const y = it.y + u.shift
          if (y < hi && y + it.height > lo) {
            const moved = Object.assign({}, sec, {
              titleTop: sec.titleTop + u.shift,
              items: [Object.assign({}, it, { y })]
            })
            // 拆分区块的标题跟随区块自身计划的位移画一次
            drawSectionTitle(ctx, moved, S.resume)
            drawSectionBody(ctx, moved, S)
          }
        }
      }
    } else {
      drawPaperBorder(ctx, S.resume, (p + 1) * A4_H)
      for (const sec of g.sections) {
        const u = plan.find((x) => x.kind === 'section' && x.id === sec.id)
        if (u && inPage(sec.titleTop, u.shift, sec.height)) {
          drawSection(sec, u.shift)
        } else if (!u && inPage(sec.titleTop, 0, sec.height)) {
          drawSection(sec, 0)
        }
      }
      for (const sec of g.sections) {
        if (!plan.some((x) => x.kind === 'item' && x.secId === sec.id)) continue
        for (const it of sec.items) {
          const u = plan.find((x) => x.kind === 'item' && x.id === it.id)
          if (!u) continue
          const y = it.y + u.shift
          if (y < hi && y + it.height > lo) {
            const moved = Object.assign({}, sec, {
              titleTop: sec.titleTop + u.shift,
              items: [Object.assign({}, it, { y })]
            })
            drawSectionTitle(ctx, moved, S.resume)
            drawSectionBody(ctx, moved, S)
          }
        }
      }
    }
    ctx.restore()

    files.push(await o.toFile(canvas, p))
  }
  return { pages, scale, files }
}

module.exports = {
  renderToContext,
  renderPagesToFiles,
  planScale,
  MAX_CANVAS_SIDE,
  MAX_CANVAS_AREA,
  drawText,
  drawLine,
  loadImage,
  drawPhoto,
  drawSectionTitle,
  drawSectionBody
}
