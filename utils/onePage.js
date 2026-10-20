/**
 * 智能一页：把简历参数压缩到「刚好一页」。
 *
 * 设计要点
 * --------
 * 1. 分级优先：不同参数的视觉损失差别很大。区块间距从 18px 压到 10px 几乎无感，
 *    而字号从 14px 压到 11px 会明显影响阅读。因此按损失从小到大排队，
 *    前面的参数尽量保留，实在不够才动后面的。
 * 2. 每级二分：找到「刚好放得下」的最宽松值，而不是一路压到下限。
 *    这样能在满足一页的前提下，尽可能少地牺牲排版。
 * 3. 无解时不假装成功：全部压到极限仍超过一页时如实返回 ok=false，
 *    并把最紧的参数一并给出，让调用方明确告知用户「内容确实太多」。
 */

/**
 * 行距的安全下限（无单位倍数）。
 *
 * 参考站 polebrief 的 decLineHeight 里有一条硬约束：行距小于 1.5 倍字号时不再下压
 * （那时代码直接 return）。它的行距以 px 存储、字号以 pt 存储，
 * 折算成「行距 / 字号」的倍数大约是 1.12——与我们滑杆的 min（1.1）几乎一致。
 *
 * 这个下限必须保留：行距是相对字号的无单位倍数，压得过小时
 * 中文字形会上下相接、几乎糊成一片。
 */
const MIN_LINE_HEIGHT_RATIO = 1.1;

/**
 * 可读性下限（智能一页压缩时不得越过）。
 *
 * 字号：中文正文低于 12px 时笔画开始粘连，屏幕上看着就"糊"，
 *   打印出来更吃力。参考站的字号是 11pt ≈ 14.67px，12px 已是相当克制的底线。
 *   滑杆允许到 10px 是留给用户手动微调的，但自动压缩不该主动走到那么小。
 * 行距：见 MIN_LINE_HEIGHT_RATIO 的说明。
 */
const MIN_READABLE_FONT_SIZE = 12;

/**
 * 判页容差（设计 px）——「内容算不算占用了下一页」的宽容量。
 *
 * 为什么需要它：内容高度由「行数 × 字号 × 行高」累加而来，天然带小数。
 * 实测这份简历内容底边 1087.9px，加上 36px 下边距得 1123.9px，而 A4 只有
 * 1123px——**只超出 0.9px**，浏览器却据此切出第 2 页，那一页只落着一两行，
 * 看着就像凭空多了一张纸。
 *
 * 取 1px 而不是更大：有效下边距会变成 `verticalPadding − 1`，而各回归用例
 * 与产品预期都以「每页底部至少留出 `verticalPadding − 1`」为准（见
 * tools/print-preview-test.mjs 的 MIN_GAP）。1px 恰好吸收这类亚像素取整误差，
 * 又不至于让页脚留白明显变窄。
 *
 * 这是**唯一事实来源**，三处必须取同一个值，否则会出现
 * 「屏幕 1 页、导出 2 页」或「智能一页说溢出、页数提示说刚好」的自相矛盾：
 *   1. 纸张判页与下内边距（ResumePaper）
 *   2. 打印分页（usePrintPageMargin 把它从 @page 的下边距里让出来）
 *   3. 智能一页试算（EditView 用它抬高目标高度）
 */
const PAGINATION_SLACK = 1

/** 智能一页的自动压缩下限；手动设置和模板预设仍可使用更小的边距。 */
const MIN_HORIZONTAL_PADDING = 40;
const MIN_VERTICAL_PADDING = 30;

/**
 * 压缩优先级（损失从小到大）与各自的安全下限。
 *
 * min 限制自动压缩；已有值低于下限时保留原值，不在压缩过程中放大。
 */
const FIT_LEVELS = [
  { key: 'sectionSpacing', min: 6, max: 40, step: 1, label: '区块间距', unit: 'px', decimals: 0 },
  { key: 'verticalPadding', min: MIN_VERTICAL_PADDING, max: 80, step: 1, label: '上下边距', unit: 'px', decimals: 0 },
  { key: 'lineHeight', min: MIN_LINE_HEIGHT_RATIO, max: 2.4, step: 0.01, label: '行距', unit: '', decimals: 2 },
  { key: 'fontSpacing', min: -0.5, max: 3, step: 0.1, label: '字距', unit: 'px', decimals: 1 },
  { key: 'horizontalPadding', min: MIN_HORIZONTAL_PADDING, max: 90, step: 1, label: '左右边距', unit: 'px', decimals: 0 },
  { key: 'fontSize', min: MIN_READABLE_FONT_SIZE, max: 20, step: 0.5, label: '字号', unit: 'px', decimals: 1 }
]

/** 参与智能一页的字段名 */
const FIT_KEYS = FIT_LEVELS.map((l) => l.key)

/** 按各字段的步长对齐，避免出现 1.4300000000000002 这类浮点噪声 */
function alignTo(value, step) {
  const n = Math.round(value / step) * step
  // 步长含小数时按步长的小数位收敛，消除二进制浮点残差
  const decimals = String(step).includes('.') ? String(step).split('.')[1].length : 0
  return Number(n.toFixed(decimals))
}

/** 抽出当前排版参数 */
function readFitParams(resume) {
  const out = {}
  for (const k of FIT_KEYS) out[k] = Number(resume[k])
  return out
}

/** 从旧值到新值的变化清单，用于告诉用户「动了哪些参数」 */
function diffParams(before, after) {
  const changes = []
  for (const lv of FIT_LEVELS) {
    const a = Number(before[lv.key])
    const b = Number(after[lv.key])
    if (Math.abs(a - b) < 1e-6) continue
    changes.push({
      key: lv.key,
      label: lv.label,
      unit: lv.unit,
      decimals: lv.decimals,
      from: a,
      to: b
    })
  }
  return changes
}

/** 把变化清单格式化成一句人话，用于 toast 提示 */
function describeChanges(changes) {
  return changes
    .map((c) => `${c.label} ${c.from.toFixed(c.decimals)}${c.unit} → ${c.to.toFixed(c.decimals)}${c.unit}`)
    .join('，')
}

/**
 * 求一组能让内容「刚好撑满但不超过」targetHeight 的排版参数（双向）。
 *
 * 两个方向各自解决一个真实诉求：
 *  - 溢出时向下压缩：把内容收进一页（也见 fitToOnePage）。
 *  - 内容不足时向上撑满：一页简历只有半页内容会显得单薄，
 *    这里放大行距把它铺满整页（参考站 autoOnePage 的 ascLineHeight 就是这个意图）。
 *
 * 之所以把「撑满」也纳入：只做压缩的话，用户点完按钮可能得到
 * 「一页但下半页空白」的结果，观感反而不如原来。
 *
 * @param {object} start   当前参数
 * @param {(p: object) => number} measure 给定参数返回内容高度（含上下边距）
 * @param {number} targetHeight 目标高度，即一页 A4
 * @param {object} [opts]
 * @param {number} [opts.growKey] 用于撑满的参数（默认 lineHeight，与参考站一致）
 * @param {number} [opts.growMax] 该参数的上限
 * @param {number} [opts.tolerance] 视为「刚好」的容差（px）
 */
function fitOnePageSmart(start, measure, targetHeight, opts = {}) {
  const growKey = opts.growKey || 'lineHeight'
  const growLevel = FIT_LEVELS.find((l) => l.key === growKey) || FIT_LEVELS[2]
  const growMax = opts.growMax ?? 2.4
  const tolerance = opts.tolerance ?? 8

  const current = measure(start)

  // 溢出：先按优先级压缩
  if (current > targetHeight) {
    const fitted = fitToOnePage(start, measure, targetHeight)
    return { ...fitted, mode: fitted.ok ? (fitted.alreadyFits ? 'none' : 'shrink') : 'tight' }
  }

  // 已经比较满（差距在容差内）：不动，避免为了几像素做无谓改动
  if (targetHeight - current <= tolerance) {
    return { params: { ...start }, ok: true, alreadyFits: true, changes: [], mode: 'none' }
  }

  // 内容不足一页：先放大行距，行距到顶后再放大字号。
  //
  // 为什么要两级：行距只作用于「行与行之间」，内容行数很少时
  // （例如只有两行简介）把行距从 1.65 拉到上限也只能多占几十像素，
  // 仍然铺不满一页。此时放大字号才是有效手段——它同时增大行高与字面高度。
  // 参考站只做行距这一级，因此内容极少时它的撑满几乎看不出效果。
  const params = { ...start }
  let changed = false

  // 一级：行距（视觉损失小，优先）
  const lhBase = Number(params[growKey])
  if (lhBase > 0 && lhBase < growMax) {
    if (measure({ ...params, [growKey]: growMax }) <= targetHeight) {
      params[growKey] = alignTo(growMax, growLevel.step)
      changed = true
    } else {
      let lo = lhBase
      let hi = growMax
      while (hi - lo > growLevel.step) {
        const mid = alignTo((lo + hi) / 2, growLevel.step)
        if (!(mid > lo) || !(mid < hi)) break
        if (measure({ ...params, [growKey]: mid }) <= targetHeight) lo = mid
        else hi = mid
      }
      params[growKey] = alignTo(lo, growLevel.step)
      changed = true
    }
  }

  // 还不够满 → 二级：字号（在行距已达上限的基础上继续逼近目标）
  if (measure(params) < targetHeight - tolerance) {
    const fsLevel = FIT_LEVELS.find((l) => l.key === 'fontSize')
    const fsBase = Number(params.fontSize)
    const fsMax = opts.fontSizeMax ?? 20
    if (fsBase > 0 && fsBase < fsMax) {
      if (measure({ ...params, fontSize: fsMax }) <= targetHeight) {
        params.fontSize = alignTo(fsMax, fsLevel.step)
        changed = true
      } else {
        let lo = fsBase
        let hi = fsMax
        while (hi - lo > fsLevel.step) {
          const mid = alignTo((lo + hi) / 2, fsLevel.step)
          if (!(mid > lo) || !(mid < hi)) break
          if (measure({ ...params, fontSize: mid }) <= targetHeight) lo = mid
          else hi = mid
        }
        // 只在确实能放大时才写回，避免把字号改小
        if (lo > fsBase) {
          params.fontSize = alignTo(lo, fsLevel.step)
          changed = true
        }
      }
    }
  }

  // 三级：弹性留白（区块间距、上下边距）。
  //
  // 内容极少时（例如只填了姓名 + 电话），行距与字号都到顶也铺不满整页——
  // 因为「能撑高的只有那么几行」，这是内容量决定的，放大字号解决不了。
  // 此时唯一既不动内容、又不损伤可读性的手段是「把留白拉开」：
  // 区块之间、页面上下都多留些空间，让整页看起来舒展而不是挤在顶部。
  // 这也是排版软件里「垂直对齐 / 分散对齐」的常规做法。
  if (measure(params) < targetHeight - tolerance) {
    for (const key of opts.spreadKeys || ['sectionSpacing', 'verticalPadding']) {
      const lv = FIT_LEVELS.find((l) => l.key === key)
      if (!lv) continue
      const base = Number(params[key])
      const max = opts.spreadMax?.[key] ?? lv.max ?? base
      if (!(base > 0) || base >= max) continue
      if (measure({ ...params, [key]: max }) <= targetHeight) {
        params[key] = alignTo(max, lv.step)
        changed = true
        continue
      }
      let lo = base
      let hi = max
      while (hi - lo > lv.step) {
        const mid = alignTo((lo + hi) / 2, lv.step)
        if (!(mid > lo) || !(mid < hi)) break
        if (measure({ ...params, [key]: mid }) <= targetHeight) lo = mid
        else hi = mid
      }
      if (lo > base) {
        params[key] = alignTo(lo, lv.step)
        changed = true
      }
    }
  }

  const finalH = measure(params)

  // 一个参数都改不动 = 所有可放大的参数都已在上限。
  // 走到这里说明内容确实不足一页（内容够的情况在函数开头就已提前返回），
  // 因此必须报「撑不满」而不是「已经刚好一页」——否则用户会以为功能没生效。
  if (!changed) {
    return {
      params: { ...start },
      ok: true,
      alreadyFits: false,
      changes: [],
      mode: 'underfilled',
      filled: false,
      finalHeight: finalH
    }
  }

  // filled=false 表示参数已尽力仍不满一页：纯排版解决不了，需如实告知。
  return {
    params,
    ok: true,
    alreadyFits: false,
    changes: diffParams(start, params),
    mode: 'grow',
    filled: finalH >= targetHeight - tolerance,
    finalHeight: finalH
  }
}

/**
 * 求一组能让内容放进 targetHeight 的排版参数。
 *
 * @param {object} start   当前参数（readFitParams 的结果）
 * @param {(p: object) => number} measure 给定参数返回内容高度（含上下边距）
 * @param {number} targetHeight 目标高度，即一页 A4
 * @returns {{ params: object, ok: boolean, alreadyFits: boolean, changes: Array }}
 */
function fitToOnePage(start, measure, targetHeight) {
  const params = { ...start }

  // 本来就放得下：不做任何改动，交由调用方提示「已经是一页」
  if (measure(params) <= targetHeight) {
    return { params, ok: true, alreadyFits: true, changes: [] }
  }

  for (const lv of FIT_LEVELS) {
    const current = Number(params[lv.key])
    // 当前值已经在下限（或低于下限）：压无可压，交给下一级
    if (!(current > lv.min)) continue

    // 这一级压到下限是否就够？不够则锁定下限，继续下一级
    if (measure({ ...params, [lv.key]: lv.min }) > targetHeight) {
      params[lv.key] = lv.min
      continue
    }

    // 够：在 [min, current] 里二分，找最宽松的可行值
    let lo = lv.min
    let hi = current
    while (hi - lo > lv.step) {
      const mid = alignTo((lo + hi) / 2, lv.step)
      if (!(mid > lo) || !(mid < hi)) break
      if (measure({ ...params, [lv.key]: mid }) <= targetHeight) lo = mid
      else hi = mid
    }
    params[lv.key] = alignTo(lo, lv.step)

    return {
      params,
      ok: true,
      alreadyFits: false,
      changes: diffParams(start, params)
    }
  }

  // 所有级别都压到极限
  const ok = measure(params) <= targetHeight
  return { params, ok, alreadyFits: false, changes: diffParams(start, params) }
}


/* ================================================================== */
/*  智能排版 v1.12（移植自参考站 src/utils/onePage.js 的 smartLayout）  */
/*  「舒适下限 + 均衡压缩 + 多页兜底」——预览页「一页」按钮使用。      */
/*  上面的 fitOnePageSmart / fitToOnePage（逐级贪心）保留给旧调用方。   */
/* ================================================================== */

/** A4 设计高度（px，794 × 1123 设计坐标系） */
const A4_HEIGHT = 1123

/**
 * 舒适下限：自动压缩不得越过。
 * 字号另有一条相对模板的约束：不低于「模板默认字号 − FONT_DROP_MAX」（见 comfortFloors）。
 */
const COMFORT_FLOORS = {
  sectionSpacing: 10,
  verticalPadding: 36,
  horizontalPadding: 44,
  lineHeight: 1.4,
  fontSpacing: 0,
  fontSize: 12.5
}

/** 字号相对模板默认值最多下调多少（px） */
const FONT_DROP_MAX = 1.5

/** 撑满方向的上限（字号另取 min(模板默认 + GROW_FONT_OVER_TEMPLATE, fontSize)） */
const GROW_CAPS = {
  lineHeight: 1.8,
  fontSize: 15,
  sectionSpacing: 28,
  verticalPadding: 56
}
const GROW_FONT_OVER_TEMPLATE = 1

/** 内容占到一页的这个比例以上就不再撑 */
const GROW_TRIGGER = 0.9

/** 撑满时在页底保留的余量（占页高比例） */
const GROW_BOTTOM_RESERVE = 0.07

/** 多页时末页填充低于该比例，视为「末页几乎空白」 */
const LAST_PAGE_MIN_FILL = 0.25

/** 多页且末页去不掉时「轻微放宽」的幅度（只动留白与行距，不动字号） */
const LOOSEN_DELTA = {
  lineHeight: 0.12,
  sectionSpacing: 6,
  verticalPadding: 6
}

/** 压缩曲线：t^γ；γ<1 先让（留白），γ>1 后让（字号） */
const SHRINK_CURVE = {
  sectionSpacing: 0.6,
  verticalPadding: 0.75,
  fontSpacing: 0.8,
  lineHeight: 0.9,
  horizontalPadding: 1.1,
  fontSize: 1.6
}

/** 撑满曲线：字号放大得最慢 */
const GROW_CURVE = {
  sectionSpacing: 0.9,
  lineHeight: 1,
  verticalPadding: 1.2,
  fontSize: 1.4
}

const STEP = {}
FIT_LEVELS.forEach((l) => { STEP[l.key] = l.step })

/** 模板未声明时的默认排版（与 model.js 的 STYLE_DEFAULTS 一致） */
const DEFAULT_TEMPLATE_PARAMS = {
  fontSize: 14,
  lineHeight: 1.65,
  fontSpacing: 0,
  horizontalPadding: 48,
  verticalPadding: 36,
  sectionSpacing: 18
}

/** 抽出当前排版参数（非数字回落到默认值，避免 NaN 一路传染到提示文案） */
function readFitParamsSafe (resume) {
  const out = {}
  for (const k of FIT_KEYS) {
    const n = Number(resume && resume[k])
    out[k] = Number.isFinite(n) ? n : DEFAULT_TEMPLATE_PARAMS[k]
  }
  return out
}

/** 模板的排版默认值（模板未声明的项回落到全局默认） */
function templateParams (tpl) {
  const out = {}
  for (const k of FIT_KEYS) {
    const n = Number(tpl && tpl[k])
    out[k] = tpl && tpl[k] != null && Number.isFinite(n) ? n : DEFAULT_TEMPLATE_PARAMS[k]
  }
  return out
}

/** 自动压缩的下限：min(当前值, 舒适下限)——绝不反向放大 */
function comfortFloors (start, tplParams) {
  const tp = tplParams || DEFAULT_TEMPLATE_PARAMS
  const abs = Object.assign({}, COMFORT_FLOORS)
  abs.fontSize = Math.max(COMFORT_FLOORS.fontSize, tp.fontSize - FONT_DROP_MAX)
  const out = {}
  for (const k of FIT_KEYS) out[k] = alignTo(Math.min(start[k], abs[k]), STEP[k])
  return out
}

/** 撑满的上限：max(当前值, 上限)——绝不反向缩小 */
function growCaps (start, tplParams) {
  const tp = tplParams || DEFAULT_TEMPLATE_PARAMS
  const abs = {
    lineHeight: GROW_CAPS.lineHeight,
    sectionSpacing: GROW_CAPS.sectionSpacing,
    verticalPadding: GROW_CAPS.verticalPadding,
    fontSize: Math.min(GROW_CAPS.fontSize, tp.fontSize + GROW_FONT_OVER_TEMPLATE)
  }
  const out = Object.assign({}, start)
  for (const k of Object.keys(abs)) out[k] = alignTo(Math.max(start[k], abs[k]), STEP[k])
  return out
}

/** 「舒适基线」：低于舒适下限的项放宽回模板默认值，其余保持用户选择 */
function relaxToComfort (start, tplParams) {
  const tp = tplParams || DEFAULT_TEMPLATE_PARAMS
  const abs = Object.assign({}, COMFORT_FLOORS)
  abs.fontSize = Math.max(COMFORT_FLOORS.fontSize, tp.fontSize - FONT_DROP_MAX)
  const out = Object.assign({}, start)
  for (const k of FIT_KEYS) {
    if (start[k] < abs[k] - 1e-9) out[k] = alignTo(Math.max(start[k], tp[k]), STEP[k])
  }
  return out
}

/** 在 from → to 之间按曲线插值；t=0 得 from，t=1 得 to */
function interpolate (from, to, t, curve) {
  const out = Object.assign({}, from)
  for (const k of FIT_KEYS) {
    if (Math.abs(to[k] - from[k]) < 1e-9) continue
    const g = curve[k] == null ? 1 : curve[k]
    const p = t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(t, g)
    out[k] = alignTo(from[k] + (to[k] - from[k]) * p, STEP[k])
  }
  return out
}

/** 二分：满足 ok(t) 的最小 t（前提 ok(1) 为真） */
function searchMinT (ok, iterations) {
  let lo = 0
  let hi = 1
  for (let i = 0; i < (iterations || 16); i++) {
    const mid = (lo + hi) / 2
    if (ok(mid)) hi = mid
    else lo = mid
  }
  return hi
}

/** 二分：满足 ok(t) 的最大 t（ok(0) 为真） */
function searchMaxT (ok, iterations) {
  let lo = 0
  let hi = 1
  if (ok(1)) return 1
  for (let i = 0; i < (iterations || 16); i++) {
    const mid = (lo + hi) / 2
    if (ok(mid)) lo = mid
    else hi = mid
  }
  return lo
}

/** 没有分页测量函数时的估算（单元测试 / 兜底） */
function estimatePages (height, params, pageH) {
  const ph = pageH || A4_HEIGHT + PAGINATION_SLACK
  const padY = params.verticalPadding || 0
  const usable = Math.max(1, ph - 2 * padY)
  const content = Math.max(0, height - 2 * padY)
  const pages = Math.max(1, Math.ceil(content / usable - 1e-9))
  const rest = content - (pages - 1) * usable
  return { pages, lastFill: Math.min(1, Math.max(0, rest / usable)) }
}

/**
 * 智能排版主入口（与参考站 smartLayout 同算法）。
 *
 * @param {object} start 当前排版参数
 * @param {object} env  { measure(p)→高度, measurePages?(p)→{pages,lastFill}, target?, template? }
 * @returns {{mode:'none'|'one-page'|'grow'|'multi-page', params, changes, pages, lastFill, fill,
 *            compressed, loosened, relaxed, atCap?}}
 */
function smartLayout (start, env) {
  const target = env.target == null ? A4_HEIGHT + PAGINATION_SLACK : env.target
  const tpl = templateParams(env.template)
  const measure = env.measure
  const pagesOf = (p) => (env.measurePages ? env.measurePages(p) : estimatePages(measure(p), p, target))
  const fits = (p) => measure(p) <= target

  const done = (mode, params, extra) => {
    const h = measure(params)
    const pg = mode === 'multi-page' ? pagesOf(params) : { pages: 1, lastFill: Math.min(1, h / target) }
    return Object.assign({
      mode,
      params,
      changes: diffParams(start, params),
      pages: pg.pages,
      lastFill: pg.lastFill,
      fill: Math.min(1, h / target),
      compressed: false,
      loosened: false,
      relaxed: false
    }, extra || {})
  }

  const h0 = measure(start)

  /* 一页放得下：视情况适度舒展 */
  if (h0 <= target) {
    if (h0 >= target * GROW_TRIGGER) return done('none', Object.assign({}, start))
    const caps = growCaps(start, tpl)
    const growTarget = target * (1 - GROW_BOTTOM_RESERVE)
    if (h0 >= growTarget) return done('none', Object.assign({}, start))
    const t = searchMaxT((x) => measure(interpolate(start, caps, x, GROW_CURVE)) <= growTarget)
    const params = interpolate(start, caps, t, GROW_CURVE)
    if (!diffParams(start, params).length) return done('none', Object.assign({}, start), { atCap: true })
    return done('grow', params)
  }

  /* 溢出：先在舒适下限内均衡压缩 */
  const floors = comfortFloors(start, tpl)
  if (fits(floors)) {
    const t = searchMinT((x) => fits(interpolate(start, floors, x, SHRINK_CURVE)))
    return done('one-page', interpolate(start, floors, t, SHRINK_CURVE), { compressed: true })
  }

  /* 舒适范围内放不进一页：按舒适排版分页 */
  const base = relaxToComfort(start, tpl)
  const relaxed = diffParams(start, base).length > 0
  const info = pagesOf(base)

  if (info.pages > 1 && info.lastFill < LAST_PAGE_MIN_FILL) {
    const fewer = info.pages - 1
    const floors2 = comfortFloors(base, tpl)
    if (pagesOf(floors2).pages <= fewer) {
      const t = searchMinT((x) => pagesOf(interpolate(base, floors2, x, SHRINK_CURVE)).pages <= fewer)
      const params = interpolate(base, floors2, t, SHRINK_CURVE)
      if (fewer === 1 && fits(params)) return done('one-page', params, { compressed: true, relaxed })
      if (pagesOf(params).pages <= fewer) return done('multi-page', params, { compressed: true, relaxed })
    }
    const loose = Object.assign({}, base)
    for (const k of Object.keys(LOOSEN_DELTA)) loose[k] = base[k] + LOOSEN_DELTA[k]
    const capped = growCaps(base, tpl)
    for (const k of Object.keys(LOOSEN_DELTA)) loose[k] = alignTo(Math.max(base[k], Math.min(loose[k], capped[k])), STEP[k])
    const t = searchMaxT((x) => pagesOf(interpolate(base, loose, x, GROW_CURVE)).pages <= info.pages)
    const params = interpolate(base, loose, t, GROW_CURVE)
    if (pagesOf(params).pages <= info.pages && diffParams(base, params).length) {
      return done('multi-page', params, { loosened: true, relaxed })
    }
  }

  return done('multi-page', base, { relaxed })
}

/** 智能排版结果 → 给用户看的一句话（纯中文、不说「失败」） */
function describeLayoutResult (result) {
  const summary = describeChanges(result.changes || [])
  const pct = Math.round((result.fill || 0) * 100)
  switch (result.mode) {
    case 'none':
      if (result.atCap) return { text: '排版已经很舒展了，内容约占 ' + pct + '% 页面，下方留白属正常', kind: 'ok' }
      return { text: '当前排版已经舒适合适，无需调整', kind: 'ok' }
    case 'grow':
      return { text: summary ? '已适度舒展排版：' + summary : '已适度舒展排版', kind: 'ok' }
    case 'one-page':
      return { text: summary ? '已舒适排成 1 页：' + summary : '已舒适排成 1 页', kind: 'ok' }
    case 'multi-page': {
      const head = '内容较多，已按舒适排版排成 ' + result.pages + ' 页'
      if (result.compressed) return { text: head + '（已略收紧，去掉了几乎空白的末页）', kind: 'ok' }
      if (result.loosened) return { text: head + '（已略放宽，让末页更饱满）', kind: 'ok' }
      if (result.relaxed) return { text: head + '（过紧的参数已恢复到舒适值）', kind: 'ok' }
      return { text: head, kind: 'ok' }
    }
    default:
      return { text: '排版已更新', kind: 'ok' }
  }
}

module.exports = {
  MIN_LINE_HEIGHT_RATIO,
  MIN_READABLE_FONT_SIZE,
  PAGINATION_SLACK,
  MIN_HORIZONTAL_PADDING,
  MIN_VERTICAL_PADDING,
  FIT_LEVELS,
  FIT_KEYS,
  alignTo,
  readFitParams,
  diffParams,
  describeChanges,
  fitOnePageSmart,
  fitToOnePage,
  // v1.12 智能排版
  A4_HEIGHT,
  COMFORT_FLOORS,
  FONT_DROP_MAX,
  GROW_CAPS,
  GROW_TRIGGER,
  GROW_BOTTOM_RESERVE,
  LAST_PAGE_MIN_FILL,
  LOOSEN_DELTA,
  SHRINK_CURVE,
  GROW_CURVE,
  DEFAULT_TEMPLATE_PARAMS,
  readFitParamsSafe,
  templateParams,
  comfortFloors,
  growCaps,
  relaxToComfort,
  interpolate,
  estimatePages,
  smartLayout,
  describeLayoutResult
}
