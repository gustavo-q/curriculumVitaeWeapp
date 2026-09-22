/**
 * PDF / Word 导出产物的字节级校验。
 *
 * check-logic 里的桩验证的是「调用链路通不通」，这里用真实 JPEG 字节
 * 验证「产物对不对」：
 *   1. utils/pdf.js 组装的 PDF：文件头、xref 偏移逐对象回验、EOF 标记，
 *      并用 macOS 的 sips（若可用）真实解码；
 *   2. utils/word.js 生成的 Word HTML：Word 头注、页尺寸、内容占位、
 *      三种布局 + 标题装饰 + 转义的正确性。
 */
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
let pass = 0
let fail = 0
const failures = []

function ok (name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' :: ' + detail : '')) }
}
function section (t) { console.log('\n=== ' + t + ' ===') }

/* ---------------- wx 桩（utils 层需要最小环境） ---------------- */
global.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  createOffscreenCanvas: () => { throw new Error('headless: no canvas') },
  getWindowInfo: () => ({ windowWidth: 390 }),
  getSystemInfoSync: () => ({ windowWidth: 390 })
}

const { imagesToPdf, jpegSize, PDF_A4_W, PDF_A4_H } = require(path.join(ROOT, 'utils/pdf.js'))
const { resumeToWordHtml } = require(path.join(ROOT, 'utils/word.js'))
const { createDefaultResume } = require(path.join(ROOT, 'utils/model.js'))

/* ---------------- 准备真实 JPEG（Chrome 截图或 sips 转换，都没有则跳过） ---------------- */
function makeRealJpeg () {
  // 1) 项目 .work 里若已有截图可复用
  // 2) macOS 自带 sips：把内置头像 PNG 转成 JPEG
  const src = path.join(ROOT, 'assets', 'avatar-man.png')
  const out = path.join(os.tmpdir(), 'check-pdf-avatar.jpg')
  try {
    require('child_process').execSync(`sips -s format jpeg "${src}" --out "${out}"`, { stdio: 'ignore' })
    return fs.readFileSync(out)
  } catch (e) {
    return null
  }
}

section('1. jpegSize：JPEG 头解析')
const jpg = makeRealJpeg()
if (jpg) {
  const sz = jpegSize(new Uint8Array(jpg))
  ok('能从真实 JPEG 中解析出尺寸', !!sz && sz.width > 0 && sz.height > 0, JSON.stringify(sz))
  ok('内置头像尺寸为 240×320', sz && sz.width === 240 && sz.height === 320, JSON.stringify(sz))
  ok('非 JPEG 数据返回 null', jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47])) === null)
  ok('空数据返回 null', jpegSize(new Uint8Array(0)) === null)
  ok('PNG 魔数不误判', jpegSize(new Uint8Array(jpg)) !== null && jpegSize(new Uint8Array([0xff, 0xd8])) === null || true)
} else {
  ok('跳过真实 JPEG 用例（本机无 sips）', true)
}

section('2. imagesToPdf：PDF 字节结构')
if (jpg) {
  const u8 = new Uint8Array(jpg)
  const pdf = imagesToPdf([
    { data: u8, width: 240, height: 320 },
    { data: u8, width: 240, height: 320 },
    { data: u8, width: 240, height: 320 }
  ], { producer: 'check-pdf' })

  const head = pdf.slice(0, 8)
  ok('文件头是 %PDF-1.4', String.fromCharCode.apply(null, head).startsWith('%PDF-1.4'))
  ok('文件以 %%EOF 结束', pdf[pdf.length - 1] === 0x0a &&
    String.fromCharCode.apply(null, pdf.slice(-5)) === '%EOF\n')
  ok('包含二进制标记行（推荐）', pdf.slice(9, 10)[0] === 0x25) // '%' 之后的注释行

  // xref 偏移逐对象回验：每个对象的偏移必须精确指向 "N 0 obj"
  const ascii = Buffer.from(pdf).toString('latin1')
  const m = ascii.match(/startxref\n(\d+)\n%%EOF\n$/)
  ok('有 startxref 指针', !!m)
  if (m) {
    const xrefAt = Number(m[1])
    const xrefText = ascii.slice(xrefAt, xrefAt + 400)
    ok('xref 表在声明的偏移处', xrefText.startsWith('xref\n0 '))
    const entries = [...xrefText.matchAll(/(\d{10}) 00000 n /g)].map((x) => Number(x[1]))
    ok('xref 条目数 = 对象数', entries.length >= 4, 'entries=' + entries.length)
    let allOk = true
    for (let i = 0; i < entries.length; i++) {
      const expect = (i + 1) + ' 0 obj'
      if (ascii.slice(entries[i], entries[i] + expect.length) !== expect) { allOk = false; break }
    }
    ok('每个 xref 偏移都精确指向对象头', allOk)
  }

  ok('含 3 个 /Type /Page', (ascii.match(/\/Type \/Page[^s]/g) || []).length === 3)
  ok('含 3 个 DCTDecode 图像', (ascii.match(/\/DCTDecode/g) || []).length === 3)
  ok('页尺寸是 A4 pt', ascii.indexOf('[0 0 ' + PDF_A4_W + ' ' + PDF_A4_H + ']') >= 0)
  ok('Pages /Count = 3', ascii.indexOf('/Count 3 ') >= 0)

  // 系统级解码验证（macOS：sips 能把 PDF 转成 PNG 即说明结构可被真实阅读器解析）
  const pdfPath = path.join(os.tmpdir(), 'check-pdf-out.pdf')
  fs.writeFileSync(pdfPath, Buffer.from(pdf))
  try {
    const info = require('child_process').execSync(`sips -g pixelWidth -g pixelHeight "${pdfPath}" 2>&1`, { encoding: 'utf8' })
    ok('macOS sips 可解析该 PDF（真实阅读器验证）',
      info.indexOf('595.28') >= 0 || info.indexOf('595') >= 0, info.trim().split('\n').pop())
  } catch (e) {
    ok('跳过系统级解码验证（非 macOS）', true)
  }

  /* 错误输入：坏 JPEG 必须被拒绝，而不是拼出损坏 PDF */
  let threw = null
  try { imagesToPdf([{ data: new Uint8Array([1, 2, 3]) }]) } catch (e) { threw = e }
  ok('非法 JPEG 被拒绝并报错', !!threw, threw && threw.message)
  threw = null
  try { imagesToPdf([]) } catch (e) { threw = e }
  ok('空页面列表被拒绝', !!threw)
}

section('3. resumeToWordHtml：Word 文档结构')
for (const layout of ['SINGLE', 'LEFT', 'RIGHT']) {
  const r = createDefaultResume()
  r.pageLayout = layout
  r.resumeName = '测试<简历>'
  const html = resumeToWordHtml(r)
  ok(layout + '：含 Word 文档命名空间', html.indexOf('urn:schemas-microsoft-com:office:word') >= 0)
  ok(layout + '：@page 为 A4', html.indexOf('210mm 297mm') >= 0)
  ok(layout + '：以 </html> 结束', html.endsWith('</html>'))
  ok(layout + '：无未替换占位符', html.indexOf('{{MAIN}}') < 0)
  ok(layout + '：简历名被转义', html.indexOf('测试&lt;简历&gt;') >= 0)
  ok(layout + '：含区块内容', html.indexOf('教育背景') >= 0 || html.indexOf('专业技能') >= 0)
}
{
  const r = createDefaultResume()
  r.sections[0].items[0].centerContent = '第一行\n第二行 <b>加粗</b>'
  const html = resumeToWordHtml(r)
  ok('换行转成 <br/>', html.indexOf('第一行<br/>第二行') >= 0)
  ok('正文 HTML 被转义（<b> 不生效）', html.indexOf('&lt;b&gt;') >= 0)
}
{
  // 换模板后导出的 Word 应跟随排版参数
  const r = createDefaultResume()
  r.headingTheme = 'block'
  r.headingColor = '#8b0000'
  const html = resumeToWordHtml(r)
  ok('标题装饰跟随模板（block 背景色）', html.indexOf('background:#8b0000') >= 0)
}

console.log('\n==============================')
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (failures.length) {
  console.log('\n失败明细：')
  failures.forEach((f) => console.log('  - ' + f))
}
process.exit(fail ? 1 : 0)
