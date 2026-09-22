/**
 * 纯 JS 的 PDF 组装器 —— 把一页一页的 A4 位图拼成一份多页 PDF 文件。
 *
 * 为什么不引第三方库
 * ----------------
 * 小程序沙箱没有 Node 的 Buffer / fs，浏览器那种「打印窗口」也没有；
 * 而 PDF 1.4 里「一页 = 一个 XObject 嵌一张 JPEG」的结构非常简单，
 * 在 JS 里手写二进制组装反而最可靠：
 *
 *   · JPEG 原样嵌入（/Filter /DCTDecode，无需重新编码）—— canvas 每页
 *     导出的 JPEG 就是一张照片，直接塞进 PDF 即可；
 *   · 全文没有任何文字对象，因此**不涉及字体嵌入**，中文不会出现
 *     「PDF 里全是乱码 / 方块」这类经典问题；
 *   · 文件由 Uint8Array 拼装，走 wx.getFileSystemManager().writeFile 的
 *     ArrayBuffer 通道，不经过 base64 字符串，内存占用可控。
 *
 * 页尺寸是真实的 A4（595.28 × 841.89 pt），微信「用其他应用打开」、
 * WPS、macOS 预览、Chrome 都能直接打开并打印。
 */

/** pt：1 pt = 1/72 inch。A4 = 210 × 297 mm */
const PDF_A4_W = 595.28
const PDF_A4_H = 841.89

/**
 * 解析 JPEG 的 SOF 段拿到像素宽高。
 * PDF 拼装本身不依赖它（尺寸由 /Width /Height 声明决定），这里只用于
 * 校验「canvas 导出的确是一张有效 JPEG」，防止把空文件拼成损坏 PDF。
 */
function jpegSize (u8) {
  if (!u8 || u8.length < 4) return null
  if (u8[0] !== 0xff || u8[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < u8.length) {
    if (u8[i] !== 0xff) { i++; continue }
    const marker = u8[i + 1]
    // 连续填充字节 / 无长度字段的独立标记（TEM、RST0-7）
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    if (marker === 0xda) break // 扫描数据开始，后面不再有 SOF
    const len = (u8[i + 2] << 8) | u8[i + 3]
    // SOF0-SOF15，排除不含帧信息的 DHT(C4)/JPG(C8)/DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: (u8[i + 5] << 8) | u8[i + 6],
        width: (u8[i + 7] << 8) | u8[i + 8]
      }
    }
    i += 2 + len
  }
  return null
}

/**
 * 把若干张 JPEG 页面组装成一份多页 PDF（Uint8Array）。
 *
 * 对象编号分配：
 *   1 = Catalog，2 = Pages，之后每页占 3 个对象：
 *   页(Page)、内容流、图像 XObject；最后一个是文档 Info。
 *
 * @param {Array<{data:ArrayBuffer|Uint8Array, width?:number, height?:number}>} pages
 *        每页的 JPEG 数据；width/height 是像素尺寸（决定清晰度），
 *        缺省时从 JPEG 头里解析。
 * @param {object} [opts]
 * @param {number} [opts.pageW=595.28] PDF 页面宽（pt）
 * @param {number} [opts.pageH=841.89] PDF 页面高（pt）
 * @param {string} [opts.producer] Info 里的 Producer 字符串（仅 ASCII）
 * @returns {Uint8Array} 完整的 PDF 文件字节
 */
function imagesToPdf (pages, opts) {
  const o = opts || {}
  const pw = Number(o.pageW) || PDF_A4_W
  const ph = Number(o.pageH) || PDF_A4_H

  const list = (pages || []).map((p, idx) => {
    if (!p || !p.data) throw new Error('第 ' + (idx + 1) + ' 页没有图像数据，无法生成 PDF')
    const u8 = p.data instanceof Uint8Array ? p.data : new Uint8Array(p.data)
    const sz = jpegSize(u8)
    if (!sz) throw new Error('第 ' + (idx + 1) + ' 页不是有效的 JPEG，无法生成 PDF')
    return {
      u8,
      w: Number(p.width) || sz.width,
      h: Number(p.height) || sz.height
    }
  })
  if (!list.length) throw new Error('没有可写入 PDF 的页面')

  /* ---------- 顺序拼装：chunks + 运行长度，记录每个对象的偏移 ---------- */
  const chunks = []
  let length = 0
  const offsets = [] // offsets[objId] = 字节偏移

  const pushAscii = (s) => {
    // 内容全部是 ASCII（对象字典与流内容），逐字符编码即可，不依赖 TextEncoder
    const buf = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i) & 0xff
    chunks.push(buf)
    length += buf.length
  }
  const pushBytes = (u8) => {
    chunks.push(u8)
    length += u8.length
  }
  const beginObj = (id) => {
    offsets[id] = length
    pushAscii(id + ' 0 obj\n')
  }
  const endObj = () => pushAscii('endobj\n')

  const pageNum = list.length
  const infoId = 3 + pageNum * 3
  const pad2 = (x) => (x < 10 ? '0' : '') + x

  /* ---- 文件头（%PDF-1.4 + 推荐的二进制标记行） ---- */
  pushAscii('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')

  /* ---- 1: Catalog ---- */
  beginObj(1)
  pushAscii('<< /Type /Catalog /Pages 2 0 R >>\n')
  endObj()

  /* ---- 2: Pages ---- */
  const kids = []
  for (let i = 0; i < pageNum; i++) kids.push((3 + i * 3) + ' 0 R')
  beginObj(2)
  pushAscii('<< /Type /Pages /Count ' + pageNum + ' /Kids [' + kids.join(' ') + '] >>\n')
  endObj()

  /* ---- 每页：Page / 内容流 / 图像 ---- */
  for (let i = 0; i < pageNum; i++) {
    const pageId = 3 + i * 3
    const contId = pageId + 1
    const imgId = pageId + 2
    const { u8, w, h } = list[i]

    // 页对象：A4 页面，唯一资源就是本页图像
    beginObj(pageId)
    pushAscii('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw + ' ' + ph + '] ' +
      '/Resources << /XObject << /Im' + i + ' ' + imgId + ' 0 R >> >> ' +
      '/Contents ' + contId + ' 0 R >>\n')
    endObj()

    // 内容流：把图像按页面尺寸铺满（cm 矩阵 = 缩放 + 平移），b 是位图字节
    const content = 'q\n' + pw + ' 0 0 ' + ph + ' 0 0 cm\n/Im' + i + ' Do\nQ\n'
    beginObj(contId)
    pushAscii('<< /Length ' + content.length + ' >>\nstream\n' + content + 'endstream\n')
    endObj()

    // 图像 XObject：JPEG 原样嵌入（DCTDecode），流长度 = JPEG 字节数
    beginObj(imgId)
    pushAscii('<< /Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h +
      ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + u8.length + ' >>\nstream\n')
    pushBytes(u8)
    pushAscii('\nendstream\n')
    endObj()
  }

  /* ---- Info ---- */
  const d = new Date()
  const created = 'D:' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
    pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds())
  beginObj(infoId)
  pushAscii('<< /Producer (' + String(o.producer || 'resume-weapp').replace(/[^ -~]/g, '') + ')' +
    ' /CreationDate (' + created + ') >>\n')
  endObj()

  /* ---- xref 表 + trailer ---- */
  const total = infoId + 1
  const xrefOffset = length
  let xref = 'xref\n0 ' + total + '\n'
  xref += '0000000000 65535 f \n'
  for (let id = 1; id < total; id++) {
    const off = String(offsets[id] || 0)
    xref += ('0000000000' + off).slice(-10) + ' 00000 n \n'
  }
  xref += 'trailer\n<< /Size ' + total + ' /Root 1 0 R /Info ' + infoId + ' 0 R >>\n' +
    'startxref\n' + xrefOffset + '\n%%EOF\n'
  pushAscii(xref)

  /* ---------- 合并 chunks ---------- */
  const out = new Uint8Array(length)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

module.exports = { imagesToPdf, jpegSize, PDF_A4_W, PDF_A4_H }
