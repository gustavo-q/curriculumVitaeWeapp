/**
 * 几何一致性验证（CDP 实测）—— 本套验证里最关键的一环。
 *
 * 要回答的问题
 * ------------
 * utils/layout.js 用纯 JS 预测纸张排版；paper.wxml + paper.wxss 在真实浏览器里
 * 排版同一份 VM。**两者必须给出相同的坐标**，否则：
 *   · 屏幕上显示「共 2 页」，实际排版只有 1 页（或反过来）
 *   · 智能一页按 JS 的预测把参数压下去，屏幕上却没变化
 *
 * 因此这里把 .work/preview.html 渲染出的每个排版单元（区块标题、每个条目、
 * 每个栏位、页眉、信息栏）用 getBoundingClientRect() 实测，与 utils/layout.js
 * 的预测逐条比对。参考站用同一套手法（tools/*-test.mjs + CDP）守住排版，
 * 这里把「预测 vs 实测」做成了断言，而不是只截图看。
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9333
const PROFILE = path.join(ROOT, '.work/chrome-geom')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function get (url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => resolve(d))
    }).on('error', reject)
  })
}

/**
 * 等 DevTools 就绪并取到 **page target** 的 WebSocket 地址。
 *
 * 注意不能用 /json/version：那是 browser target，上面没有 Runtime 域，
 * 调用 Runtime.evaluate 会返回 "wasn't found"。Runtime/Page 这些域只挂在
 * page target 上，因此要从 /json/list 里挑 type === 'page' 的那个。
 */
async function waitForPageTarget (tries) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/list'))
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch (e) {}
    await sleep(400)
  }
  throw new Error('Chrome DevTools page target 未就绪')
}

/** 简历 CDP 客户端（只用到 Runtime.evaluate） */
function connect (wsUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(wsUrl)
    const key = Buffer.from(Math.random().toString()).toString('base64').slice(0, 16)
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': 13, 'Sec-WebSocket-Key': key }
    })
    req.on('upgrade', (res, socket) => {
      let id = 0
      const pending = new Map()
      let buf = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk])
        for (;;) {
          if (buf.length < 2) break
          const opcode = buf[0] & 0x0f
          const masked = (buf[1] & 0x80) !== 0
          let len = buf[1] & 0x7f
          let off = 2
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4 }
          else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10 }
          if (masked) off += 4
          if (buf.length < off + len) break
          const payload = buf.slice(off, off + len)
          buf = buf.slice(off + len)
          if (opcode === 1 || opcode === 0) {
            try {
              const msg = JSON.parse(payload.toString('utf8'))
              if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
            } catch (e) {}
          }
          if (opcode === 8) socket.end()
        }
      })
      const send = (method, params) => new Promise((res2) => {
        const mid = ++id
        pending.set(mid, res2)
        const data = Buffer.from(JSON.stringify({ id: mid, method, params }))
        const len = data.length
        let header
        if (len < 126) header = Buffer.from([0x81, 0x80 | len])
        else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0xfe; header.writeUInt16BE(len, 2) }
        else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0xff; header.writeBigUInt64BE(BigInt(len), 2) }
        const mask = Buffer.from([1, 2, 3, 4])
        const masked = Buffer.alloc(len)
        for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4]
        socket.write(Buffer.concat([header, mask, masked]))
      })
      resolve({ send, close: () => socket.end() })
    })
    req.on('error', reject)
    req.end()
  })
}

let pass = 0
let fail = 0
const failures = []
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' :: ' + detail : '')) }
}

/* ---------- 与 visual.cjs 完全相同的用例构造（两边必须同源） ---------- */
function buildCases (model) {
  const CASES = []
  for (const t of model.TEMPLATES) CASES.push({ label: t.name, template: t.id })
  for (const lay of ['SINGLE', 'LEFT', 'RIGHT']) CASES.push({ label: '布局 ' + lay, template: 'classic', patch: { pageLayout: lay } })
  for (const h of model.HEADING_THEMES) CASES.push({ label: '标题 ' + h.label, template: 'classic', patch: { headingTheme: h.id } })
  for (const b of model.BORDER_THEMES) CASES.push({ label: '边框 ' + b.label, template: 'professional', patch: { borderTheme: b.id } })
  CASES.push({ label: '条目 三种排版', template: 'classic', sample: 'items' })
  CASES.push({ label: '空简历（编辑槽位）', blank: true, editable: true })
  CASES.push({ label: '多页与页缝', template: 'compact', verbose: true })
  return CASES
}

function buildResume (model, c) {
  let resume
  if (c.blank) resume = model.normalizeResume(model.createBlankResume())
  else if (c.sample === 'items') {
    resume = model.normalizeResume(model.createBlankResume())
    resume.baseInfo = { name: '张明', gender: '男', age: '25', education: '本科', phone: '138 0000 0000', email: 'z@example.com', jobIntention: '产品经理', city: '上海', experience: '3 年', birthday: '', politics: '', ethnicity: '', hometown: '' }
    resume.baseFields = ['name', 'gender', 'age', 'education', 'phone', 'email']
    resume.personalPhoto = 'asset:avatar-man'
    resume.sections = [
      model.createSection('三种条目排版', [
        model.createItem('THREE', { leftContent: '华东理工大学', centerContent: '计算机科学与技术', rightContent: '2019.09-2023.06' }),
        model.createItem('TWO', { leftContent: '英语 CET-6（582 分）', rightContent: '2022.06' }),
        model.createItem('ONE', { centerContent: '整行条目：自定义内容、实习经历、工作内容等。' }),
        model.createItem('ONE', { centerContent: '1、列表第一行，会做悬挂缩进\n2、列表第二行，折行文字与首行左边缘对齐\n3、列表第三行' })
      ]),
      model.createSection('列表缩进对比', [
        model.createItem('ONE', { centerContent: '普通段落没有缩进，折行文字顶到最左边，与上下条目对齐。' })
      ])
    ]
  } else {
    resume = model.normalizeResume(model.buildThumbSample(c.template))
    if (c.verbose) {
      const extra = model.createSection('补充经历', [])
      for (let i = 0; i < 22; i++) extra.items.push(model.createItem('THREE', { leftContent: '公司 ' + (i + 1), centerContent: '岗位', rightContent: '2020.01-2021.01' }))
      resume.sections.push(extra)
    }
  }
  if (c.patch) Object.assign(resume, c.patch)
  return resume
}

/* ================= 断言主体 ================= */
async function run () {
  // 1) 重新生成 HTML，保证与当前源码一致
  await new Promise((res, rej) => {
    // 先按当前源码重建仿真页，保证「实测」与「源码」同版本
    const p = spawn(process.execPath, [path.join(ROOT, 'tools/build-preview.cjs')], { stdio: 'ignore' })
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error('build-preview.cjs 失败'))))
  })
  console.log('\n[准备] preview.html 已按当前源码重新生成')

  fs.mkdirSync(PROFILE, { recursive: true })
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--allow-file-access-from-files', '--user-data-dir=' + PROFILE,
    '--remote-debugging-port=' + PORT, '--window-size=1200,1600', 'about:blank'
  ], { stdio: 'ignore' })

  let client = null
  try {
    const target = await waitForPageTarget(40)
    client = await connect(target.webSocketDebuggerUrl)
    const send = client.send
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Page.navigate', { url: 'file://' + path.join(ROOT, '.work/preview.html') })
    await sleep(2600)

    /*
     * 关键一步：把**浏览器自己的 canvas 度量**注入到引擎里。
     *
     * 引擎在 Node 下没有 canvas，只能用「中文 1em、西文 0.52em」的估算模型，
     * 于是「引擎预测的高度」与「浏览器真实排版的高度」必然有系统性偏差，
     * 拿它们逐像素比对是在比字体度量，而不是比排版规则。
     *
     * 这里先在页面里量出一张字符宽度表（ASCII + 常用 CJK），再让引擎的
     * measureText 查表求和。这样两边用的是同一套字体度量，剩下的差异
     * 才是真正需要暴露的排版规则差异。
     */
    async function evalJs (expr) {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      if (r && r.error) throw new Error('CDP ' + r.error.message)
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
      return r.result && r.result.result ? r.result.result.value : undefined
    }

    const metrics = await evalJs('(() => {' +
      'const cv = document.createElement("canvas"); const ctx = cv.getContext("2d");' +
      'const fams = ["sans-serif", "serif", "Arial"];' +
      'const weights = [400, 600, 700];' +
      'const sizes = [10, 11, 12, 13, 13.5, 14, 15, 16, 18, 20, 22, 24, 28, 30];' +
      // 按码点遍历常用区段，避免在源码里塞一个超长汉字串
      'const chars = [];' +
      'for (let c = 32; c < 127; c++) chars.push(String.fromCharCode(c));' +
      'for (let c = 0x4e00; c < 0x9fa6; c++) chars.push(String.fromCharCode(c));' +
      'for (let c = 0x3000; c < 0x3040; c++) chars.push(String.fromCharCode(c));' +
      'for (let c = 0xff00; c < 0xff61; c++) chars.push(String.fromCharCode(c));' +
      'const out = {};' +
      'for (const f of fams) for (const w of weights) for (const s of sizes) {' +
      '  ctx.font = w + " " + s + "px " + f;' +
      '  const m = {};' +
      '  for (const ch of chars) m[ch] = ctx.measureText(ch).width;' +
      '  out[f + "|" + w + "|" + s] = m;' +
      '}' +
      'return out })()')

    // 收集页面上的实测几何
    const MEASURE = '(() => {' +
      'const out = [];' +
      'document.querySelectorAll(".case").forEach((card, ci) => {' +
      '  const label = card.getAttribute("data-label") || card.querySelector("figcaption").textContent.trim();' +
      '  const paper = card.querySelector(".paper");' +
      '  if (!paper) { out.push({ label, index: ci, error: "no paper" }); return }' +
      '  const pr = paper.getBoundingClientRect();' +
      '  const scale = pr.width / 794;' +
      '  const rel = (el) => { const r = el.getBoundingClientRect();' +
      '    return { top: (r.top - pr.top) / scale, height: r.height / scale, width: r.width / scale, left: (r.left - pr.left) / scale } };' +
      '  const secs = Array.from(paper.querySelectorAll(".sec")).map((s) => {' +
      '    const t = s.querySelector(".sec-title");' +
      '    return Object.assign({ title: t ? t.textContent : "" }, rel(s)) });' +
      '  const items = Array.from(paper.querySelectorAll(".item")).map((it) => Object.assign({ cls: it.className },' +
      '    rel(it), { cells: Array.from(it.children).map((c) => Object.assign({ cls: c.className }, rel(c))) }));' +
      '  const head = paper.querySelector(".head");' +
      '  const side = paper.querySelector(".side");' +
      '  const seams = Array.from(paper.querySelectorAll(".page-seam")).map((s) => parseFloat(s.style.top));' +
      '  out.push({ label, index: ci, scale, pageHeight: paper.offsetHeight,' +
      '    head: head ? rel(head) : null, side: side ? rel(side) : null, secs, items, seams })' +
      '});' +
      'return out })()'

    const report = await evalJs(MEASURE)
    const model = require(path.join(ROOT, 'utils/model.js'))
    const L = require(path.join(ROOT, 'utils/layout.js'))
    const CASES = buildCases(model)

    // 用浏览器量出的字体宽度表替换引擎的估算度量
    L.setMeasureOverride((str, font, ls) => {
      const m = /^(\d+)\s+(\d+(?:\.\d+)?)px\s+(.+)$/.exec(font)
      const weight = m ? m[1] : '400'
      const size = m ? m[2] : '14'
      const fam = m ? m[3] : 'sans-serif'
      // 度量表按整数/半档字号采样；未命中时按同族同字重最接近的一档线性缩放，
      // 这样引擎不会退回到「中文 1em」的粗估而与浏览器差出一大截
      let key = fam + '|' + weight + '|' + size
      let table = metrics[key]
      let factor = 1
      if (!table) {
        const prefixes = Object.keys(metrics).filter((k) => k.indexOf(fam + '|' + weight + '|') === 0)
        if (prefixes.length) {
          let best = null
          let bestD = Infinity
          for (const k of prefixes) {
            const s = parseFloat(k.split('|')[2])
            const d = Math.abs(s - parseFloat(size))
            if (d < bestD) { bestD = d; best = k }
          }
          table = metrics[best]
          factor = parseFloat(size) / parseFloat(best.split('|')[2])
        }
      }
      if (!table) {
        // 该字重/字族完全没采样到（如 600 的 serif）：按同族 400 的宽度 × 0.55 中文 / ×1 西文近似
        const fallback = Object.keys(metrics).find((k) => k.indexOf(fam + '|400|') === 0)
        if (fallback) {
          table = metrics[fallback]
          factor = parseFloat(size) / parseFloat(fallback.split('|')[2])
          let w0 = 0
          for (const ch of String(str)) w0 += (table[ch] != null ? table[ch] : 0.5)
          return w0 * factor + ls * String(str).length
        }
        return null
      }
      let w = 0
      for (const ch of String(str)) w += (table[ch] != null ? table[ch] : size * 0.52)
      return w * factor + ls * String(str).length
    })

    console.log('\n[1] 用例数量对齐')
    ok('页面用例数与引擎用例数一致（' + CASES.length + '）', report.length === CASES.length, report.length + ' vs ' + CASES.length)
    ok('每个用例都渲染出纸张', report.every((r) => !r.error), JSON.stringify(report.filter((r) => r.error).map((r) => r.label)))
    const scales = report.map((r) => r.scale)
    ok('所有纸张缩放比一致', Math.max.apply(null, scales) - Math.min.apply(null, scales) < 0.001,
      Math.min.apply(null, scales).toFixed(3) + '~' + Math.max.apply(null, scales).toFixed(3))

    // 预测 vs 实测
    const pred = CASES.map((c) => {
      const resume = buildResume(model, c)
      return L.layoutResume(resume, null, { editable: !!c.editable })
    })

    console.log('\n[2] 区块的纵向位置与高度：JS 引擎预测 ↔ 真实 CSS 排版')
    let secMax = 0, secWorst = '', secN = 0, secMismatch = []
    for (let i = 0; i < CASES.length; i++) {
      const m = report[i], p = pred[i]
      if (m.error) continue
      if (m.secs.length !== p.sections.length) { secMismatch.push(CASES[i].label + '(' + m.secs.length + 'vs' + p.sections.length + ')'); continue }
      for (let k = 0; k < p.sections.length; k++) {
        const dTop = Math.abs(m.secs[k].top - p.sections[k].titleTop)
        const dH = Math.abs(m.secs[k].height - p.sections[k].height)
        const d = Math.max(dTop, dH)
        if (d > secMax) { secMax = d; secWorst = CASES[i].label + ' / ' + p.sections[k].title + ' (Δtop ' + dTop.toFixed(1) + ', Δh ' + dH.toFixed(1) + ')' }
        secN++
      }
    }
    ok('区块数量全部一致', secMismatch.length === 0, secMismatch.join(' '))
    ok('全部 ' + secN + ' 个区块的位置与高度误差 < 6px', secMax < 6, '最大 ' + secMax.toFixed(2) + 'px @ ' + secWorst)

    console.log('\n[3] 条目的纵向位置')
    let itMax = 0, itWorst = '', itN = 0
    for (let i = 0; i < CASES.length; i++) {
      const m = report[i], p = pred[i]
      if (m.error) continue
      const pi = []
      for (const s of p.sections) for (const it of s.items) pi.push(it)
      if (pi.length !== m.items.length) { ok(CASES[i].label + ' 条目数一致', false, m.items.length + ' vs ' + pi.length); continue }
      for (let k = 0; k < pi.length; k++) {
        const d = Math.abs(m.items[k].top - pi[k].y)
        if (d > itMax) { itMax = d; itWorst = CASES[i].label + ' item#' + k }
        itN++
      }
    }
    ok('全部 ' + itN + ' 个条目的位置误差 < 6px', itMax < 6, '最大 ' + itMax.toFixed(2) + 'px @ ' + itWorst)

    console.log('\n[4] 条目分栏宽度（grid 轨道）')
    /*
     * 口径说明：栏宽由 grid 轨道决定，其中 auto 轨道按「内容宽度」收窄，
     * 而内容宽度取决于字体度量。右侧的 auto 轨道尤其敏感：一行文本在不同
     * 字体下差几像素，轨道宽就会差几像素——这是 CSS 的行为，不是引擎的错。
     * 因此这里分成两层断言：
     *   (a) 每个栏位的宽度都不为 0、且总和不超过内容宽度（轨道没算崩）
     *   (b) 按比例分配的轨道（fr 列）宽度误差很小，因为它们只由引擎的算术决定
     */
    let cMax = 0, cWorst = '', cN = 0, frN = 0, frMax = 0, frWorst = ''
    for (let i = 0; i < CASES.length; i++) {
      const m = report[i], p = pred[i]
      if (m.error) continue
      const pi = []
      for (const s of p.sections) for (const it of s.items) pi.push(it)
      if (pi.length !== m.items.length) continue
      // 该用例的内容宽度（边距由模板决定，不能写死）
      const contentW = (p.pageStyle || p.style).contentWidth
      for (let k = 0; k < pi.length; k++) {
        if (pi[k].cells.length !== m.items[k].cells.length) continue
        let sum = 0
        for (let j = 0; j < pi[k].cells.length; j++) {
          const pc = pi[k].cells[j]
          const mw = m.items[k].cells[j].width
          sum += mw
          // (a) 栏位宽度不能为 0，也不能超出内容宽度
          if (!(mw > 0) || mw > contentW + 1) { cWorst = CASES[i].label + ' 栏宽异常 ' + mw.toFixed(1); cMax = 9999 }
          // (b) 比例轨道（fr 列）完全由引擎算术决定，误差应当很小；
          //     auto 轨道按内容宽度收窄，受字体度量影响，不在此列。
          if (!pc.trackAuto) {
            const d = Math.abs(mw - pc.width)
            if (d > frMax) { frMax = d; frWorst = CASES[i].label + ' item#' + k + ' ' + pc.field + ' (' + mw.toFixed(1) + ' vs ' + pc.width.toFixed(1) + ')' }
            frN++
          }
          cN++
        }
        // 栏宽合计 + 列间距不应超过内容宽度
        const gaps = (pi[k].cells.length - 1) * 14
        if (sum + gaps > contentW + 1) { cMax = 9999; cWorst = CASES[i].label + ' 栏宽合计溢出 ' + (sum + gaps).toFixed(1) + ' > ' + contentW }
      }
    }
    ok('全部 ' + cN + ' 个栏位的宽度都合法（0 < w ≤ 内容宽）', cMax < 100, cWorst)
    // 度量表按 0.5px 档采样，非整档字号用线性缩放近似，本身有约 ±5px 的固有误差
    // （相对 698px 的内容宽度约 0.7%）。这里断言的是「轨道分配算得对」，
    // 而不是「字体度量表足够密」。
    ok('按比例分配的 ' + frN + ' 个栏位宽度误差 < 6px', frMax < 6, '最大 ' + frMax.toFixed(2) + 'px @ ' + frWorst)
    console.log('\n[5] 两栏布局信息栏')
    let layOk = true, layDetail = ''
    for (let i = 0; i < CASES.length; i++) {
      const m = report[i], p = pred[i]
      if (m.error) continue
      const twoCol = p.layout !== 'SINGLE'
      if (twoCol !== !!m.side) { layOk = false; layDetail = CASES[i].label + ' 信息栏存在性不符'; break }
      if (twoCol) {
        const dW = Math.abs(m.side.width - p.side.width)
        const dT = Math.abs(m.side.top - (p.pageStyle ? p.pageStyle.vPad : 0))
        const dL = Math.abs(m.side.left - p.side.x)
        if (dW > 6 || dT > 6 || dL > 6) { layOk = false; layDetail = CASES[i].label + ' Δw' + dW.toFixed(1) + ' Δt' + dT.toFixed(1) + ' Δl' + dL.toFixed(1); break }
      }
    }
    ok('两栏布局的信息栏与预测一致', layOk, layDetail)

    console.log('\n[6] 单栏页眉高度')
    let hMax = 0, hWorst = '', hN = 0
    for (let i = 0; i < CASES.length; i++) {
      const m = report[i], p = pred[i]
      if (m.error || !m.head || !p.head) continue
      const d = Math.abs(m.head.height - p.head.height)
      if (d > hMax) { hMax = d; hWorst = CASES[i].label }
      hN++
    }
    ok('全部 ' + hN + ' 个单栏页眉高度误差 < 8px', hMax < 8, '最大 ' + hMax.toFixed(2) + 'px @ ' + hWorst)

    console.log('\n[7] 页缝位置与页数')
    let sOk = true, sDetail = ''
    for (let i = 0; i < CASES.length; i++) {
      const m = report[i]
      if (m.error) continue
      const expect = pred[i] && L.paginateResume(buildResume(model, CASES[i]), null, { editable: !!CASES[i].editable })
      const expSeams = expect ? expect.pages - 1 : 0
      if (m.seams.length !== expSeams) { sOk = false; sDetail = CASES[i].label + ' 期望 ' + expSeams + ' 条页缝，实测 ' + m.seams.length; break }
      for (const t of m.seams) {
        if (Math.abs(t % 1123) > 0.01) { sOk = false; sDetail = CASES[i].label + ' 页缝 top=' + t; break }
      }
      if (!sOk) break
    }
    ok('页缝数量与引擎页数一致、且都落在 A4 整数倍', sOk, sDetail)

    console.log('\n[8] 九种标题装饰真的渲染出了装饰')
    const DECO = '(() => { const out = {};' +
      'document.querySelectorAll(".case").forEach((card) => {' +
      '  const label = card.getAttribute("data-label") || card.querySelector("figcaption").textContent.trim();' +
      '  if (label.indexOf("标题 ") !== 0) return;' +
      '  const t = card.querySelector(".sec-title"); if (!t) return;' +
      '  const cs = getComputedStyle(t);' +
      '  out[label] = { bg: cs.backgroundColor, bb: cs.borderBottomStyle + " " + cs.borderBottomWidth,' +
      '    bl: cs.borderLeftStyle + " " + cs.borderLeftWidth, pl: cs.paddingLeft,' +
      '    color: cs.color, br: cs.borderTopStyle + " " + cs.borderTopWidth };' +
      '}); return out })()'
    const deco = await evalJs(DECO)
    const decoKeys = Object.keys(deco)
    ok('9 种标题装饰用例都在页面上', decoKeys.length === 9, decoKeys.join(' | '))
    ok('色块：有主题色背景', /rgb\(31, 78, 121\)/.test(deco['标题 色块'].bg), deco['标题 色块'].bg)
    ok('填充条：有主题色背景', /rgb\(31, 78, 121\)/.test(deco['标题 填充条'].bg), deco['标题 填充条'].bg)
    // Chrome 会把 1.5px 边框取整显示成 1px，因此只断言「有实线下边框」
    ok('下划线：有实线下边框', deco['标题 下划线'].bb.indexOf('solid') === 0 && parseFloat(deco['标题 下划线'].bb.split(' ')[1]) > 0, deco['标题 下划线'].bb)
    ok('双线：有下边框（双线效果）', deco['标题 双线'].bb.indexOf('none') !== 0, deco['标题 双线'].bb)
    ok('竖线：有 3px 左边框', /solid 3px/.test(deco['标题 竖线'].bl), deco['标题 竖线'].bl)
    ok('圆点：左内边距 13px', parseFloat(deco['标题 圆点'].pl) === 13, deco['标题 圆点'].pl)
    ok('描边：文字用主题色', /rgb\(31, 78, 121\)/.test(deco['标题 描边'].color), deco['标题 描边'].color)
    ok('淡底：有淡色背景与左边框', /rgba/.test(deco['标题 淡底'].bg) && /solid 3px/.test(deco['标题 淡底'].bl), deco['标题 淡底'].bg + ' / ' + deco['标题 淡底'].bl)
    ok('无装饰：无背景无边框', deco['标题 无装饰'].bg === 'rgba(0, 0, 0, 0)' && deco['标题 无装饰'].bb.indexOf('none') === 0, deco['标题 无装饰'].bg + ' / ' + deco['标题 无装饰'].bb)

    console.log('\n[9] 三种条目排版的 grid 轨道与缩进')
    const ITEMS = '(() => {' +
      'const card = Array.from(document.querySelectorAll(".case")).find((c) => c.querySelector("figcaption").textContent.indexOf("条目 三种排版") >= 0);' +
      'if (!card) return null;' +
      'return Array.from(card.querySelectorAll(".item")).map((it) => {' +
      '  const c = it.querySelector(".c-center");' +
      '  return { cls: it.className, cols: getComputedStyle(it).gridTemplateColumns.split(" ").length,' +
      '    cells: it.children.length, indent: c ? getComputedStyle(c).paddingLeft : null, pl: c ? getComputedStyle(c).paddingLeft : null };' +
      '}) })()'
    const items = await evalJs(ITEMS)
    ok('三种条目排版用例存在', !!items && items.length >= 5, items ? 'items=' + items.length : 'null')
    if (items) {
      ok('THREE = 三列', items[0].cls.indexOf('t-three') >= 0 && items[0].cols === 3, items[0].cls + ' cols=' + items[0].cols)
      ok('TWO = 两列', items[1].cls.indexOf('t-two') >= 0 && items[1].cols === 2, items[1].cls + ' cols=' + items[1].cols)
      ok('ONE = 单列', items[2].cls.indexOf('t-one') >= 0 && items[2].cols === 1, items[2].cls + ' cols=' + items[2].cols)
      ok('ONE 条目只渲染一个栏位（不多出空行）', items[2].cells === 1, 'cells=' + items[2].cells)
      ok('TWO 条目渲染两个栏位', items[1].cells === 2, 'cells=' + items[1].cells)
      ok('列表条目有 2.8em 缩进', parseFloat(items[3].pl) > 30, items[3].pl)
      ok('普通段落条目没有缩进', parseFloat(items[4].pl) === 0, items[4].pl)
    }

    console.log('\n[10] 编辑态槽位')
    const SLOT = '(() => {' +
      'const card = Array.from(document.querySelectorAll(".case")).find((c) => c.querySelector("figcaption").textContent.indexOf("空简历") >= 0);' +
      'if (!card) return null; const paper = card.querySelector(".paper");' +
      'return { photoAdd: !!paper.querySelector(".photo-add"), empty: paper.querySelectorAll(".c-center").length,' +
      '  isEmpty: paper.querySelectorAll(".is-empty").length } })()'
    const slot = await evalJs(SLOT)
    ok('编辑态显示「添加照片」占位块', slot && slot.photoAdd === true, JSON.stringify(slot))
    ok('编辑态空条目渲染了可点击落点', slot && slot.empty > 0 && slot.isEmpty > 0, JSON.stringify(slot))

    console.log('\n[11] 18 套模板的视觉差异')
    const TPL = '(() => { const out = {};' +
      'document.querySelectorAll(".case").forEach((card) => {' +
      '  const label = card.getAttribute("data-label") || card.querySelector("figcaption").textContent.trim();' +
      '  const paper = card.querySelector(".paper"); if (!paper) return;' +
      '  const cs = getComputedStyle(paper); const t = paper.querySelector(".sec-title");' +
      '  const tcs = t ? getComputedStyle(t) : null;' +
      '  out[label] = { fs: cs.fontSize, lh: cs.lineHeight, pad: cs.paddingTop + "|" + cs.paddingLeft,' +
      '    font: cs.fontFamily.split(",")[0], tc: tcs ? tcs.color : "", tb: tcs ? tcs.backgroundColor : "",' +
      '    layoutCols: paper.querySelector(".cols") ? getComputedStyle(paper.querySelector(".cols")).gridTemplateColumns : "single" };' +
      '}); return out })()'
    const tplInfo = await evalJs(TPL)
    const names = model.TEMPLATES.map((t) => t.name)
    const missing = names.filter((n) => !tplInfo[n])
    ok('18 套模板都渲染出来', missing.length === 0, '缺失：' + missing.join(','))
    const sigs = names.map((n) => JSON.stringify(tplInfo[n]))
    ok('18 套模板的排版签名互不相同（模板 = 一整套风格）', new Set(sigs).size === 18, '唯一 ' + new Set(sigs).size + ' 种')
    ok('字号确实随模板变化（极简黑 13.5px ↔ 经典蓝 14px）',
      tplInfo['极简黑'].fs === '13.5px' && tplInfo['经典蓝'].fs === '14px', tplInfo['极简黑'].fs + ' / ' + tplInfo['经典蓝'].fs)
    ok('边距确实随模板变化', tplInfo['紧凑一页'].pad !== tplInfo['疏朗衬线'].pad,
      tplInfo['紧凑一页'].pad + ' / ' + tplInfo['疏朗衬线'].pad)
    ok('两栏模板渲染出两列（现代侧栏）', tplInfo['现代侧栏'].layoutCols.split(' ').length === 2,
      tplInfo['现代侧栏'].layoutCols)
    ok('单栏模板没有两列容器', tplInfo['经典蓝'].layoutCols === 'single')

    client.close()
  } catch (e) {
    fail++
    failures.push('CDP 流程异常：' + e.message)
    console.log('  ✗ CDP 流程异常：' + e.message)
  } finally {
    try { chrome.kill('SIGKILL') } catch (e) {}
  }

  console.log('\n==============================')
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
  if (failures.length) { console.log('\n失败明细：'); failures.forEach((f) => console.log('  - ' + f)) }
  process.exit(fail ? 1 : 0)
}

run()