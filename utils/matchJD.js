/**
 * JD 关键词匹配 · 纯比较函数 —— 移植自参考站 src/utils/matchJD.js
 *
 * 红线（沿用参考站）：
 *  1. 纯本地、零网络。
 *  2. 检索宽松、不改写：大小写不敏感 + 子串匹配，不做词干化 / 同义词。
 *  3. 只比 baseInfo 13 key + 简历名 + 区块标题 + 条目三槽 + baseFields 字段标签；
 *     样式字段、archived 等元数据一概不参与。
 *
 * 入参是原始草稿，函数内部自行 normalizeResume()，调用方不要预先归一化。
 *
 * 小程序额外导出（参考站没有，纯函数、可单测）：
 *   guessSection(resume, kw)   缺失 / 弱匹配关键词「最该补到哪个区块」的猜测
 *   guessCompanyRole(jdText)   从 JD 头几行猜公司与岗位（记一笔投递时预填，可改）
 *   looksLikeJD(text)          剪贴板内容是否像一段岗位描述
 *   hashText(text)             剪贴板去重用的短哈希（不把剪贴板原文落盘）
 *
 * 与参考站唯一的算法差异：丢弃序号 / 薪资等纯数字串（见 NOISE_NUM_RE 注释）。
 *
 * 实现注意：不用 String.prototype.matchAll（低版本 iOS 基础库没有），一律 exec 循环。
 */
const { BASE_FIELDS, normalizeResume } = require('./model.js')

/* ---------------- 行内格式剥离（移植自参考站 inlineFormat.js 的最小子集） ---------------- */
const decodeEntities = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')

/** HTML → 纯文本：标签剥壳、实体还原；无标签时也要还原实体（参考站踩过的坑） */
function stripInlineFormat (html) {
  const raw = String(html == null ? '' : html)
  if (raw.indexOf('<') < 0) return decodeEntities(raw)
  let s = raw
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"])*)>/g, '')
  return decodeEntities(s)
}

/* ---------------- 停用词 ---------------- */
const STOPWORDS_ZH = [
  '的', '了', '和', '是', '在', '有', '与', '及', '或', '等', '对', '为', '并', '能', '会',
  '熟悉', '掌握', '了解', '精通', '相关', '优先', '以上', '以下', '经验', '能力', '工作',
  '岗位', '职位', '要求', '负责', '参与', '包括', '使用', '进行', '具备', '良好', '优秀',
  '较强', '一定', '其他', '各种', '我们', '你将', '候选', '符合', '满足', '加分', '至少',
  '年以上', '年及以上', '类似', '且', '者', '人员', '工程师',
  '岗位要求', '使用经验', '相关技术', '年以上经验', '开发经验', '工作经验',
  '优先考虑', '岗位职责', '任职要求', '加分项', '技术栈', '相关经验'
]
const STOPWORDS_EN = [
  'the', 'and', 'or', 'of', 'to', 'in', 'for', 'with', 'on', 'at', 'by', 'from', 'as',
  'is', 'are', 'be', 'a', 'an', 'we', 'you', 'our', 'your', 'will', 'can', 'must',
  'have', 'has', 'need', 'want', 'strong', 'good', 'plus', 'etc', 'job', 'work',
  'experience', 'skills', 'skill', 'years', 'year', 'ability', 'team', 'teams'
]
const STOPWORDS = new Set(STOPWORDS_ZH.concat(STOPWORDS_EN))
const SINGLE_STOP_RE = new RegExp('[' + STOPWORDS_ZH.filter((x) => x.length === 1).join('') + ']', 'g')

const t = (v) => stripInlineFormat(String(v == null ? '' : v)).trim()

/*
 * 小程序偏离参考站的唯一一处（有意为之）：丢掉「列表序号 / 薪资」这类纯数字拉丁串。
 * 手机上复制的 JD 几乎都带「1. 2. 3.」序号和「15-25K·13薪」，参考站会把它们抽成
 * 「3良好的沟通协作能」「15-25k」「13」这类假关键词，拉低覆盖率又没法补。
 * 规则只拦 1–2 位纯数字与薪资区间，985 / 211 / H5 / C++ 等照常保留。
 */
const NOISE_NUM_RE = /^(?:\d{1,2}|\d+(?:\.\d+)?[-~]\d+(?:\.\d+)?[kKwW万千]?|\d+(?:\.\d+)?[kKwW万千])$/
const cleanLatin = (w) =>
  w
    .split('/')
    .map((x) => x.replace(/^[.\-]+|[.\-]+$/g, ''))
    .filter((x) => x && !NOISE_NUM_RE.test(x))

function allMatches (re, text) {
  const out = []
  re.lastIndex = 0
  let m
  while ((m = re.exec(text))) {
    out.push(m)
    if (m[0] === '') re.lastIndex++
  }
  return out
}

/** 从 JD 原文抽取候选关键词（口径与参考站完全一致，见其注释） */
function extractKeywords (jdText) {
  const text = String(jdText == null ? '' : jdText)
  if (!text.trim()) return []

  const raw = []
  const phraseRe = /([A-Za-z0-9][A-Za-z0-9+#.\-/]*)\s*([\u4e00-\u9fa5]{2,8})/g
  for (const m of allMatches(phraseRe, text)) {
    const parts = cleanLatin(m[1])
    if (!parts.length) continue
    const zh = m[2]
    if (STOPWORDS.has(zh)) {
      for (const x of parts) raw.push(x.toLowerCase())
    } else {
      for (const x of parts.slice(0, -1)) raw.push(x.toLowerCase())
      raw.push((parts[parts.length - 1] + zh).toLowerCase())
    }
  }
  const latin = text.match(/[A-Za-z0-9][A-Za-z0-9+#.\-/]*/g) || []
  for (const w of latin) for (const x of cleanLatin(w)) raw.push(x.toLowerCase())
  const zhSegments = text.match(/[\u4e00-\u9fa5]{2,}/g) || []
  for (const seg of zhSegments) {
    if (seg.length <= 8) raw.push(seg)
  }

  const uniq = []
  const seen = new Set()
  for (const w of raw) {
    const k = w.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    if (k.length < 2) continue
    if (STOPWORDS.has(k) || STOPWORDS.has(w)) continue
    if (k.replace(SINGLE_STOP_RE, '').length === 0) continue
    uniq.push(w)
  }
  return uniq
}

/** 简历侧参与匹配的全文（白名单口径同参考站） */
function buildResumeText (raw) {
  const r = normalizeResume(raw)
  const parts = []
  const info = r.baseInfo || {}
  for (const f of BASE_FIELDS) parts.push(t(info[f.key]))
  parts.push(t(r.resumeName))
  for (const s of r.sections || []) {
    parts.push(t(s.title))
    for (const it of s.items || []) {
      parts.push(t(it.leftContent), t(it.centerContent), t(it.rightContent))
    }
  }
  for (const key of r.baseFields || []) {
    const f = BASE_FIELDS.find((x) => x.key === key)
    if (f) parts.push(f.label)
  }
  return parts.filter(Boolean).join('\n')
}

const contains = (haystack, needle) => haystack.toLowerCase().indexOf(needle.toLowerCase()) >= 0

/** 弱匹配用的字面子词：纯字母数字 ≥4 或纯中文 ≥2 */
function subTerms (kw) {
  const out = new Set()
  const s = String(kw).toLowerCase()
  for (let n = 0; n < s.length; n++) {
    for (let len = 2; n + len <= s.length; len++) {
      const sub = s.slice(n, n + len)
      if (/^[a-z0-9]{4,}$/.test(sub) || /^[\u4e00-\u9fa5]{2,}$/.test(sub)) out.add(sub)
    }
  }
  return Array.from(out)
}

/**
 * 匹配一份简历对一段 JD。返回 { summary, groups }，结构同参考站。
 */
function matchJD (rawResume, jdText, customTerms) {
  const text = buildResumeText(rawResume)
  const custom = (customTerms || []).map((w) => String(w == null ? '' : w).trim()).filter(Boolean)
  const kwFromJd = extractKeywords(jdText)
  const all = kwFromJd.slice()
  const seen = new Set(kwFromJd.map((w) => w.toLowerCase()))
  for (const c of custom) {
    if (!seen.has(c.toLowerCase())) {
      seen.add(c.toLowerCase())
      all.push(c)
    }
  }

  const hit = []
  const weak = []
  const miss = []
  for (const kw of all) {
    if (contains(text, kw)) {
      hit.push(kw)
      continue
    }
    if (subTerms(kw).some((s) => contains(text, s))) weak.push(kw)
    else miss.push(kw)
  }

  const total = all.length
  const matched = hit.length + weak.length
  const denomZero = total === 0
  const coverage = denomZero ? null : Math.round((matched / total) * 100)
  const summary = {
    total,
    hit: hit.length,
    weak: weak.length,
    miss: miss.length,
    coverage,
    matched,
    denomZero,
    text: denomZero ? '未从这段 JD 中提取到有效关键词' : matched + ' / ' + total + ' · ' + coverage + '%'
  }
  const groups = [
    { id: 'hit', label: '命中', items: hit },
    { id: 'weak', label: '弱匹配', items: weak },
    { id: 'miss', label: '缺失', items: miss }
  ]
  return { summary, groups }
}

/* ================================================================== */
/*  小程序扩展：跳转补词 / 预填投递 / 剪贴板识别                         */
/* ================================================================== */

const SKILL_TITLE_RE = /技能|证书|专长|能力|语言/
const WORK_TITLE_RE = /工作|实习|职业|任职/
const PROJECT_TITLE_RE = /项目|作品/
const SUMMARY_TITLE_RE = /自我评价|个人总结|个人优势|关于我|自我介绍/
const EDU_TITLE_RE = /教育|学历|学习/

/** 关键词像不像「硬技能」：英文/数字串、或含工具/证书类字眼 */
const SKILL_KW_RE = /^[A-Za-z0-9+#.\-/ ]+$|证书|资格|英语|日语|CET|雅思|托福|驾照|Office|Excel|PPT|编程|语言|框架|工具|软件/i
const SUMMARY_KW_RE = /沟通|协作|责任|抗压|学习能力|主动|团队|自驱|细心|逻辑|表达|执行力|领导/
const EDU_KW_RE = /本科|硕士|博士|研究生|学历|专业|学位|毕业|985|211|双一流|GPA|绩点/i
const PROJECT_KW_RE = /项目|系统|平台|架构|设计|开发|上线|落地/

/**
 * 猜一个缺失 / 弱匹配关键词最该补到哪个区块。返回区块 id，或 'base'（基本信息）。
 *
 * 顺序：
 *   1. 求职意向 / 城市等基本信息字段名 → base
 *   2. 弱匹配：哪个可见区块里出现了它最长的字面子词，就补到那里（补全最自然）
 *   3. 按关键词类型找对应标题的区块：学历类→教育，软素质→自我评价，
 *      硬技能→技能证书，项目类→项目经历，其余→工作/实习经历
 *   4. 都找不到 → 第一个可见区块；连区块都没有 → base
 */
function guessSection (rawResume, kw) {
  const r = normalizeResume(rawResume)
  const word = String(kw == null ? '' : kw).trim()
  const sections = (r.sections || []).filter((s) => s.visible !== false)
  if (!word) return sections[0] ? sections[0].id : 'base'

  if (BASE_FIELDS.some((f) => word.indexOf(f.label) >= 0) || /求职意向|期望城市|到岗|薪资|籍贯/.test(word)) return 'base'

  // 2. 弱匹配：按最长子词定位
  const subs = subTerms(word).sort((a, b) => b.length - a.length)
  for (const sub of subs) {
    for (const s of sections) {
      const body = [s.title].concat(...s.items.map((it) => [it.leftContent, it.centerContent, it.rightContent])).map(t).join('\n')
      if (contains(body, sub)) return s.id
    }
  }

  // 3. 类型 → 标题
  const byTitle = (re) => {
    const s = sections.find((x) => re.test(x.title))
    return s ? s.id : ''
  }
  let id = ''
  if (EDU_KW_RE.test(word)) id = byTitle(EDU_TITLE_RE)
  else if (SUMMARY_KW_RE.test(word)) id = byTitle(SUMMARY_TITLE_RE)
  else if (SKILL_KW_RE.test(word)) id = byTitle(SKILL_TITLE_RE)
  else if (PROJECT_KW_RE.test(word)) id = byTitle(PROJECT_TITLE_RE) || byTitle(WORK_TITLE_RE)
  if (!id) id = byTitle(WORK_TITLE_RE) || byTitle(PROJECT_TITLE_RE) || byTitle(SKILL_TITLE_RE)
  if (id) return id
  return sections[0] ? sections[0].id : 'base'
}

const ROLE_WORD_RE = /工程师|开发|经理|专员|设计师|运营|实习生|产品|分析师|顾问|主管|总监|助理|销售|老师|教师|编辑|策划|架构师|测试|会计|律师|研究员|算法|前端|后端|客服|翻译|HR|人事|行政|Engineer|Developer|Manager|Designer|Analyst|Intern/i
const COMPANY_RE = /[\u4e00-\u9fa5A-Za-z0-9（）()·&]{2,30}(?:股份有限公司|有限责任公司|有限公司|集团|科技|公司|银行|研究院|工作室|事务所|学校|医院)/
const LABEL_COMPANY_RE = /^(?:公司(?:名称)?|企业(?:名称)?|招聘单位|单位|Company)\s*[:：]\s*(.+)$/i
const LABEL_ROLE_RE = /^(?:岗位(?:名称)?|职位(?:名称)?|招聘岗位|招聘职位|应聘岗位|Position|Job\s*Title|Title|Role)\s*[:：]\s*(.+)$/i

/** 去掉岗位名尾巴上的薪资、地点、经验、学历等（如 BOSS 直聘复制出来的「前端开发 15-25K·13薪」） */
function cleanRole (s) {
  return String(s || '')
    .replace(/[【\[]([^】\]]+)[】\]]/, '$1')
    .replace(/\s*\d+(?:\.\d+)?\s*[-~至]\s*\d+(?:\.\d+)?\s*[kK千万wW].*$/, '')
    .replace(/\s*\d+(?:\.\d+)?\s*[kK千万]\s*(?:以上|起)?.*$/, '')
    .replace(/\s*[|｜·•/].*$/, '')
    .replace(/\s*(?:薪资|月薪|年薪|面议|急招|包吃住).*$/, '')
    .replace(/^(?:招聘|诚聘|急聘|热招)\s*[:：]?\s*/, '')
    .trim()
    .slice(0, 30)
}

/**
 * 从 JD 前几行猜公司与岗位。只做简单启发式，结果一律可编辑；猜不到返回空串。
 */
function guessCompanyRole (jdText) {
  const lines = String(jdText || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 12)
  let company = ''
  let role = ''
  for (const line of lines) {
    const mc = LABEL_COMPANY_RE.exec(line)
    if (mc && !company) company = mc[1].trim().slice(0, 30)
    const mr = LABEL_ROLE_RE.exec(line)
    if (mr && !role) role = cleanRole(mr[1])
  }
  if (!company) {
    for (const line of lines.slice(0, 8)) {
      const m = COMPANY_RE.exec(line)
      if (m) {
        company = m[0].replace(/^(?:公司(?:名称)?|企业)\s*[:：]?/, '').trim()
        break
      }
    }
  }
  if (!role) {
    for (const line of lines.slice(0, 6)) {
      if (line.length > 40) continue
      if (/[:：]/.test(line) && !/^(?:招聘|诚聘)/.test(line)) continue
      if (/职责|要求|描述|福利|待遇|地址/.test(line)) continue
      if (ROLE_WORD_RE.test(line)) {
        const c = cleanRole(line)
        if (c && c !== company) { role = c; break }
      }
    }
  }
  return { company, role }
}

/** 剪贴板文本是否值得提示「一键粘贴」：长度 > 30、不像 JSON 备份 */
function looksLikeJD (text) {
  const s = String(text == null ? '' : text).trim()
  if (s.length <= 30) return false
  if (/^[[{]/.test(s)) return false
  if (/^https?:\/\/\S+$/.test(s)) return false
  return true
}

/** djb2 短哈希：只存哈希判断「是否处理过」，不把剪贴板原文写进存储 */
function hashText (text) {
  const s = String(text == null ? '' : text).trim()
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return s.length + ':' + (h >>> 0).toString(36)
}

module.exports = {
  stripInlineFormat,
  extractKeywords,
  buildResumeText,
  subTerms,
  matchJD,
  guessSection,
  guessCompanyRole,
  cleanRole,
  looksLikeJD,
  hashText,
  STOPWORDS
}
