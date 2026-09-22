/**
 * 简历数据模型 —— 移植自参考站 src/data/model.js
 *
 * 与参考站保持一致的约定：
 *   · 结构：resume → sections[] → items[] → { type: ONE|TWO|THREE, left/center/right }
 *   · 模板 = 一整套风格（配色 + 字体 + 标题装饰 + 栏式 + 字号行距 + 页边距），换模板不改内容
 *   · normalizeResume() 负责补齐历史 / 导入数据，因此旧备份仍可打开
 *
 * 唯一差异：参考站默认照片是一张 20KB 的 base64 证件照，小程序里每次 setData
 * 都要序列化整份简历，这么大的字符串会成为明显负担，因此默认照片改用内置矢量
 * 头像（avatar:man），与参考站 buildThumbSample() 的做法一致。
 */

/**
 * 简历数据模型
 * 一套「区块(section) → 条目(item)」的通用结构，
 * 条目有三种排版类型（对齐参考站的 ONE / TWO / THREE）。
 */


const ITEM_TYPE = {
  ONE: 'ONE', // 只有中间内容：自定义内容、实习经历、工作内容等
  TWO: 'TWO', // 左 + 右：学校/公司 + 时间
  THREE: 'THREE' // 左 + 中 + 右：学校/公司 + 职位/专业 + 时间
}

const ITEM_META = {
  [ITEM_TYPE.ONE]: {
    label: '整行',
    hint: '自定义内容、实习经历、工作内容等。',
    leftPlaceholder: '',
    centerPlaceholder: '自定义内容、实习经历、工作内容等。',
    rightPlaceholder: ''
  },
  [ITEM_TYPE.TWO]: {
    label: '左+右',
    hint: '左右两栏，常用于「证书 / 时间」类信息。',
    leftPlaceholder: '学校/公司等',
    centerPlaceholder: '',
    rightPlaceholder: '202x.07 - 202x.09'
  },
  [ITEM_TYPE.THREE]: {
    label: '左+中+右',
    hint: '三栏，常用于「学校 + 专业 + 时间」类信息。',
    leftPlaceholder: '学校/公司等',
    centerPlaceholder: '职位/专业/学位等等',
    rightPlaceholder: '202x.07 - 202x.09'
  }
}

/** 基本信息可展示字段（可自由开关） */
const BASE_FIELDS = [
  { key: 'name', label: '姓名', defaultOn: true },
  { key: 'gender', label: '性别', defaultOn: true },
  { key: 'age', label: '年龄', defaultOn: true },
  { key: 'education', label: '学历', defaultOn: true },
  { key: 'phone', label: '电话', defaultOn: true },
  { key: 'email', label: '邮箱', defaultOn: true },
  { key: 'jobIntention', label: '求职意向', defaultOn: false },
  { key: 'city', label: '现居城市', defaultOn: false },
  { key: 'experience', label: '工作年限', defaultOn: false },
  { key: 'birthday', label: '出生日期', defaultOn: false },
  { key: 'politics', label: '政治面貌', defaultOn: false },
  { key: 'ethnicity', label: '民族', defaultOn: false },
  { key: 'hometown', label: '籍贯', defaultOn: false }
]

/** 头像样式选项 */
const PHOTO_PRESETS = [
  { id: 'man', label: '男士', url: 'avatar:man' },
  { id: 'woman', label: '女士', url: 'avatar:woman' }
]

/** 照片外形 */
const PHOTO_SHAPES = [
  { id: 'rect', label: '方角' },
  { id: 'rounded', label: '圆角' },
  { id: 'circle', label: '圆形' },
  { id: 'square', label: '正方' }
]

/** 照片边框 */
const PHOTO_BORDERS = [
  { id: 'none', label: '无' },
  { id: 'thin', label: '细线' },
  { id: 'theme', label: '主题色' },
  { id: 'shadow', label: '投影' }
]

/** 常用证件照比例（宽/高） */
const PHOTO_RATIOS = [
  { id: 'id', label: '一寸 3:4', ratio: 3 / 4 },
  { id: 'two', label: '二寸 5:7', ratio: 5 / 7 },
  { id: 'square', label: '方图 1:1', ratio: 1 },
  { id: 'free', label: '自由', ratio: null }
]

const PAGE_LAYOUTS = [
  { id: 'SINGLE', label: '单栏' },
  { id: 'LEFT', label: '左右两栏（信息左）' },
  { id: 'RIGHT', label: '左右两栏（信息右）' }
]

const FONT_FAMILIES = [
  { id: 'system', label: '系统默认', stack: "-apple-system, \"PingFang SC\", \"Helvetica Neue\", sans-serif" },
  {
    id: 'songti',
    label: '宋体 / 思源宋体',
    stack: '"Songti SC", "SimSun", "Source Han Serif SC", serif'
  },
  { id: 'heiti', label: '黑体 / 苹方', stack: '"PingFang SC", "Heiti SC", "Microsoft YaHei", sans-serif' },
  { id: 'kaiti', label: '楷体', stack: '"Kaiti SC", "KaiTi", "STKaiti", serif' },
  { id: 'fangsong', label: '仿宋', stack: '"FangSong", "STFangsong", serif' },
  { id: 'times', label: 'Times New Roman', stack: '"Times New Roman", Times, serif' },
  { id: 'arial', label: 'Arial / Helvetica', stack: 'Arial, Helvetica, sans-serif' }
]

/** 标题主题（区块标题的装饰样式） */
const HEADING_THEMES = [
  { id: 'line', label: '下划线' },
  { id: 'double', label: '双线' },
  { id: 'block', label: '色块' },
  { id: 'filled', label: '填充条' },
  { id: 'bar', label: '竖线' },
  { id: 'dot', label: '圆点' },
  { id: 'outline', label: '描边' },
  { id: 'tint', label: '淡底' },
  { id: 'plain', label: '无装饰' }
]

const BORDER_THEMES = [
  { id: 'none', label: '无' },
  { id: 'thin', label: '细线' },
  { id: 'double', label: '双线' },
  { id: 'dashed', label: '虚线' }
]

const COLOR_PRESETS = [
  { id: 'navy', label: '藏青', value: '#1f4e79', second: '#2f6ba3', font: '#23282f' },
  { id: 'graphite', label: '墨黑', value: '#33383d', second: '#4c5257', font: '#23282f' },
  { id: 'teal', label: '松绿', value: '#12695c', second: '#1c8875', font: '#1f2a28' },
  { id: 'wine', label: '酒红', value: '#8c2f39', second: '#ad4351', font: '#2a2224' },
  { id: 'indigo', label: '靛蓝', value: '#3b4a9c', second: '#5462b8', font: '#22263c' },
  { id: 'amber', label: '赭金', value: '#9a6b1f', second: '#bd8a33', font: '#2b2418' },
  { id: 'rose', label: '绛紫', value: '#7a3b6a', second: '#9a5588', font: '#2a2028' }
]

/** 模板库 */
const TEMPLATES = [
  {
    id: 'classic',
    name: '经典蓝',
    desc: '藏青配色 + 下划线标题，最通用的求职款',
    tags: ['通用', '应届生', '社招'],
    brand: '#1f4e79',
    second: '#2f6ba3',
    headingTheme: 'line',
    fontFamily: 'system',
    headingCenter: false,
    photo: true,
    layout: 'SINGLE',
    popularity: 98
  },
  {
    id: 'minimal',
    name: '极简黑',
    desc: '去掉一切装饰，纯文字排版，A4 一页刚好',
    tags: ['简历', '互联网'],
    brand: '#33383d',
    second: '#4c5257',
    headingTheme: 'plain',
    fontFamily: 'heiti',
    headingCenter: false,
    photo: false,
    layout: 'SINGLE',
    fontSize: 13.5,
    lineHeight: 1.72,
    fontSpacing: 0.4,
    horizontalPadding: 46,
    verticalPadding: 38,
    sectionSpacing: 22,
    popularity: 95
  },
  {
    id: 'elegant',
    name: '雅致衬线',
    desc: '宋体衬线标题居中，适合国企、教师、事业单位',
    tags: ['国企', '教师', '事业单位'],
    brand: '#12695c',
    second: '#1c8875',
    headingTheme: 'filled',
    fontFamily: 'songti',
    headingCenter: true,
    photo: true,
    layout: 'SINGLE',
    popularity: 91
  },
  {
    id: 'campus',
    name: '清新校园',
    desc: '左侧信息栏，突出教育背景与校园经历',
    tags: ['应届生', '校招', '实习'],
    brand: '#3b4a9c',
    second: '#5462b8',
    headingTheme: 'block',
    fontFamily: 'system',
    headingCenter: false,
    photo: true,
    layout: 'LEFT',
    popularity: 89
  },
  {
    id: 'professional',
    name: '商务稳重',
    desc: '双线外框 + 双线标题，十年社招经验感',
    tags: ['社招', '管理岗', '金融'],
    brand: '#8c2f39',
    second: '#ad4351',
    headingTheme: 'double',
    fontFamily: 'heiti',
    headingCenter: false,
    photo: true,
    layout: 'SINGLE',
    borderTheme: 'double',
    popularity: 84
  },
  {
    id: 'modern',
    name: '现代侧栏',
    desc: '右侧色块信息栏 + 淡底标题，设计/运营岗的加分项',
    tags: ['设计', '运营', '市场'],
    brand: '#7a3b6a',
    second: '#9a5588',
    headingTheme: 'tint',
    fontFamily: 'system',
    headingCenter: false,
    photo: true,
    layout: 'RIGHT',
    accentBlock: true,
    popularity: 80
  },
  {
    id: 'academic',
    name: '学术严谨',
    desc: '宋体 + 双线下划线标题 + 窄边距，一页塞更多论文与项目',
    tags: ['科研', '教师', '事业单位'],
    brand: '#2f4f6f',
    second: '#4a6d8c',
    headingTheme: 'double',
    fontFamily: 'songti',
    headingCenter: false,
    photo: false,
    layout: 'SINGLE',
    fontSize: 13.5,
    lineHeight: 1.5,
    horizontalPadding: 34,
    verticalPadding: 30,
    sectionSpacing: 12,
    popularity: 88
  },
  {
    id: 'compact',
    name: '紧凑一页',
    desc: '最小边距与行距，专治内容太多溢出到第二页',
    tags: ['通用', '社招', '互联网'],
    brand: '#3a4a56',
    second: '#556675',
    headingTheme: 'tint',
    fontFamily: 'heiti',
    headingCenter: false,
    photo: true,
    layout: 'SINGLE',
    fontSize: 13,
    lineHeight: 1.45,
    horizontalPadding: 30,
    verticalPadding: 26,
    sectionSpacing: 10,
    popularity: 90
  },
  {
    id: 'corporate',
    name: '国企正式',
    desc: '细线边框 + 居中色块标题，规矩、不出错的体制内风格',
    tags: ['国企', '事业单位', '管理岗'],
    brand: '#7d2c2c',
    second: '#9b4242',
    headingTheme: 'block',
    fontFamily: 'songti',
    headingCenter: true,
    photo: true,
    layout: 'SINGLE',
    borderTheme: 'thin',
    fontSize: 14,
    lineHeight: 1.7,
    sectionSpacing: 20,
    popularity: 86
  },
  {
    id: 'techsidebar',
    name: '极客侧栏',
    desc: '右侧深色信息栏，技能与证书成列，技术岗一眼看到重点',
    tags: ['互联网', '社招', '设计'],
    brand: '#1b3a5c',
    second: '#2d5c8a',
    headingTheme: 'bar',
    fontFamily: 'system',
    headingCenter: false,
    photo: true,
    layout: 'RIGHT',
    accentBlock: true,
    baseInfoRatio: 30,
    fontSize: 13.5,
    lineHeight: 1.55,
    sectionSpacing: 14,
    popularity: 87
  },
  {
    id: 'warm',
    name: '暖调创意',
    desc: '赭金配色 + 淡底标题，适合内容、品牌与市场岗',
    tags: ['设计', '运营', '市场'],
    brand: '#9a6b1f',
    second: '#bd8a33',
    headingTheme: 'filled',
    fontFamily: 'system',
    headingCenter: false,
    photo: true,
    layout: 'SINGLE',
    fontSize: 14.5,
    lineHeight: 1.75,
    sectionSpacing: 22,
    popularity: 82
  },
  {
    id: 'serifwide',
    name: '疏朗衬线',
    desc: '大字号与大间距，经历少也能撑满一页，读起来很舒服',
    tags: ['应届生', '通用', '教师'],
    brand: '#12695c',
    second: '#1c8875',
    headingTheme: 'outline',
    fontFamily: 'songti',
    headingCenter: true,
    photo: true,
    layout: 'SINGLE',
    fontSize: 15,
    lineHeight: 1.85,
    horizontalPadding: 52,
    verticalPadding: 42,
    sectionSpacing: 24,
    popularity: 79
  },
  {
    id: 'sidebarleft',
    name: '左栏名片',
    desc: '左侧窄信息栏做成名片样式，照片与联系方式更醒目',
    tags: ['应届生', '校招', '设计'],
    brand: '#3b4a9c',
    second: '#5462b8',
    headingTheme: 'dot',
    fontFamily: 'system',
    headingCenter: false,
    photo: true,
    layout: 'LEFT',
    accentBlock: true,
    baseInfoRatio: 28,
    fontSize: 13.5,
    lineHeight: 1.6,
    sectionSpacing: 15,
    popularity: 81
  },
  {
    id: 'kaiwen',
    name: '楷体文雅',
    desc: '楷体 + 圆点标题 + 疏排版面，教师、编辑与文案岗的稳妥选择',
    tags: ['教师', '事业单位', '通用'],
    brand: '#5b4636',
    second: '#7a6248',
    headingTheme: 'dot',
    fontFamily: 'kaiti',
    headingCenter: true,
    photo: true,
    layout: 'SINGLE',
    fontSize: 15,
    lineHeight: 1.88,
    fontSpacing: 0.6,
    horizontalPadding: 54,
    verticalPadding: 44,
    sectionSpacing: 24,
    popularity: 78
  },
  {
    id: 'paperplain',
    name: '素纸无饰',
    desc: '完全去掉标题装饰与边框，只靠字号与留白分区，最克制的一款',
    tags: ['简历', '互联网', '科研'],
    brand: '#2b2f33',
    second: '#4a5056',
    headingTheme: 'plain',
    fontFamily: 'heiti',
    headingCenter: false,
    photo: false,
    layout: 'SINGLE',
    fontSize: 14,
    lineHeight: 1.8,
    fontSpacing: 0.2,
    horizontalPadding: 50,
    verticalPadding: 42,
    sectionSpacing: 24,
    popularity: 83
  },
  {
    id: 'inkframe',
    name: '墨线外框',
    desc: '虚线外框 + 竖线标题，版面像一张有边框的登记表，稳重有辨识度',
    tags: ['社招', '管理岗', '金融'],
    brand: '#334155',
    second: '#556580',
    headingTheme: 'bar',
    fontFamily: 'fangsong',
    headingCenter: false,
    photo: true,
    layout: 'SINGLE',
    borderTheme: 'dashed',
    fontSize: 14.5,
    lineHeight: 1.7,
    horizontalPadding: 40,
    verticalPadding: 34,
    sectionSpacing: 19,
    popularity: 76
  },
  {
    id: 'latinside',
    name: '侧栏简历',
    desc: '右侧信息栏 + 无装饰标题，联系信息成列排布，技术岗一页看清',
    tags: ['互联网', '社招', '设计'],
    brand: '#37474f',
    second: '#546e7a',
    headingTheme: 'plain',
    fontFamily: 'system',
    headingCenter: false,
    photo: true,
    layout: 'RIGHT',
    accentBlock: false,
    baseInfoRatio: 34,
    fontSize: 13.5,
    lineHeight: 1.6,
    horizontalPadding: 38,
    verticalPadding: 32,
    sectionSpacing: 16,
    popularity: 77
  },
  {
    id: 'timesglobal',
    name: '英文时报',
    desc: 'Times 衬线 + 大写字母间距，投外企与海外岗位时更自然',
    tags: ['金融', '社招', '科研'],
    brand: '#1c2b3a',
    second: '#3c5169',
    headingTheme: 'double',
    fontFamily: 'times',
    headingCenter: true,
    photo: false,
    layout: 'SINGLE',
    fontSize: 14.5,
    lineHeight: 1.75,
    fontSpacing: 0.3,
    horizontalPadding: 52,
    verticalPadding: 40,
    sectionSpacing: 21,
    popularity: 74
  }
]

const getTemplate = (id) => TEMPLATES.find((t) => t.id === id) || TEMPLATES[0]

/** 排版尺寸默认值：与 createDefaultResume() 保持一致 */
const STYLE_DEFAULTS = {
  fontSize: 14,
  lineHeight: 1.65,
  fontSpacing: 0,
  horizontalPadding: 48,
  verticalPadding: 36,
  sectionSpacing: 18,
  baseInfoRatio: 50
}

/**
 * 模板 → 简历字段的唯一映射来源。
 * store.applyTemplate（应用模板）、模板库缩略图、编辑器模板弹窗三处都调用它，
 * 避免各写一份而逐渐不一致 —— 这正是此前「模板缩略图看不出区别」的根因之一。
 * 排版尺寸按「完整声明」处理：模板未声明的项回落到默认值，
 * 因此切换模板得到的是确定的一套排版，而不是新旧模板的混合样式。
 */
function applyTemplateToResume(resume, templateId) {
  const t = getTemplate(templateId)
  if (!resume || !t) return resume
  resume.templateId = t.id
  resume.pageLayout = t.layout || 'SINGLE'
  resume.headingTheme = t.headingTheme
  resume.headingColor = t.brand
  resume.headingSecondColor = t.second
  resume.headingFontColor = '#23282f'
  resume.borderColor = t.brand
  resume.borderTheme = t.borderTheme || 'none'
  resume.headingCenter = !!t.headingCenter
  resume.accentBlock = !!t.accentBlock
  resume.fontFamily = t.fontFamily
  resume.fontSize = t.fontSize ?? STYLE_DEFAULTS.fontSize
  resume.lineHeight = t.lineHeight ?? STYLE_DEFAULTS.lineHeight
  resume.fontSpacing = t.fontSpacing ?? STYLE_DEFAULTS.fontSpacing
  resume.horizontalPadding = t.horizontalPadding ?? STYLE_DEFAULTS.horizontalPadding
  resume.verticalPadding = t.verticalPadding ?? STYLE_DEFAULTS.verticalPadding
  resume.sectionSpacing = t.sectionSpacing ?? STYLE_DEFAULTS.sectionSpacing
  resume.baseInfoRatio = t.baseInfoRatio ?? STYLE_DEFAULTS.baseInfoRatio
  return resume
}

/**
 * 模板缩略图的示例简历 —— 唯一来源。
 *
 * 编辑器模板弹窗与模板库原先各自生成一份样例，且都直接复用默认简历里的
 * 大段说明文字。在 0.43 倍缩放下，那些长段落糊成一片灰色噪点，
 * 标题样式、栏式、行距的差异全部淹没 —— 这就是「图片上看不出模板区别」的根因。
 *
 * 这里改用「短句 + 明确分栏」的示例：
 * 每一行都短到缩略图里仍能分辨，区块标题保留真实中文，
 * 于是标题装饰、单栏/双栏、字号与行距的差别一眼可辨。
 */
function buildThumbSample(templateId) {
  const t = getTemplate(templateId)
  const r = normalizeResume(createDefaultResume())
  applyTemplateToResume(r, templateId)
  r.resumeName = t.name
  r.personalPhoto = t.photo ? 'avatar:man' : ''
  // 基本信息收敛为两行，把版面留给正文排版差异。
  // 两栏布局的「信息栏」本就该承载更多字段，多开几项，侧栏才不至于空半屏。
  const twoCol = (t.layout || 'SINGLE') !== 'SINGLE'
  r.baseFields = twoCol
    ? ['name', 'gender', 'age', 'phone', 'email', 'city', 'experience', 'jobIntention']
    : ['name', 'gender', 'age', 'phone', 'email']
  r.baseInfo = {
    ...r.baseInfo,
    name: '张明',
    gender: '男',
    age: '25',
    education: '本科',
    phone: '138 0000 0000',
    email: 'zhangming@example.com',
    city: '上海',
    experience: '3 年',
    jobIntention: '产品经理'
  }
  r.sections = [
    createSection('教育背景', [
      createItem(ITEM_TYPE.THREE, {
        leftContent: '华东理工大学',
        centerContent: '计算机科学与技术',
        rightContent: '2019.09-2023.06'
      }),
      createItem(ITEM_TYPE.ONE, { centerContent: 'GPA 3.8/4.0（专业前 5%）' }),
      createItem(ITEM_TYPE.ONE, { centerContent: '主修课程：数据结构、操作系统、数据库原理' })
    ]),
    createSection('实习经历', [
      createItem(ITEM_TYPE.THREE, {
        leftContent: '字节跳动',
        centerContent: '产品实习生',
        rightContent: '2023.07-2023.10'
      }),
      createItem(ITEM_TYPE.ONE, {
        centerContent: '负责需求调研与原型设计，上线后转化率提升 15%。'
      }),
      createItem(ITEM_TYPE.THREE, {
        leftContent: '美团',
        centerContent: '运营实习生',
        rightContent: '2022.07-2022.09'
      }),
      createItem(ITEM_TYPE.ONE, {
        centerContent: '搭建用户反馈看板，周均处理 200+ 条工单。'
      })
    ]),
    createSection('项目经历', [
      createItem(ITEM_TYPE.THREE, {
        leftContent: '二手交易平台',
        centerContent: '前端负责人',
        rightContent: '2022.09-2023.01'
      }),
      createItem(ITEM_TYPE.ONE, {
        centerContent: '主导流程重构，人均处理时长下降 30%。'
      }),
      createItem(ITEM_TYPE.THREE, {
        leftContent: '校园二手小程序',
        centerContent: '独立开发',
        rightContent: '2021.03-2021.06'
      }),
      createItem(ITEM_TYPE.ONE, {
        centerContent: '零预算冷启动，累计注册用户 3000+。'
      })
    ]),
    createSection('技能证书', [
      createItem(ITEM_TYPE.ONE, { centerContent: '英语 CET-6（582 分）' }),
      createItem(ITEM_TYPE.ONE, { centerContent: 'Excel 数据透视表 / Figma / Axure' }),
      createItem(ITEM_TYPE.ONE, { centerContent: '普通话二级甲等' })
    ]),
    createSection('校园经历', [
      createItem(ITEM_TYPE.THREE, {
        leftContent: '计算机协会',
        centerContent: '技术部部长',
        rightContent: '2020.09-2021.09'
      }),
      createItem(ITEM_TYPE.ONE, { centerContent: '组织 4 场技术分享，累计参与 500+ 人次。' })
    ]),
    createSection('自我评价', [
      createItem(ITEM_TYPE.ONE, {
        centerContent: '擅长需求拆解与数据驱动迭代，注重落地与复盘。'
      })
    ])
  ]
  // 两栏布局的主栏更窄、行数更多，末页显得空；
  // 补一个区块让侧栏与单栏的版面密度接近，缩略图不至于下半屏空白。
  if (twoCol) {
    r.sections.push(
      createSection('荣誉奖项', [
        createItem(ITEM_TYPE.THREE, {
          leftContent: '国家奖学金',
          centerContent: '校级',
          rightContent: '2021.10'
        }),
        createItem(ITEM_TYPE.ONE, { centerContent: '全国大学生数学建模竞赛省二等奖' })
      ])
    )
  }
  return r
}

/* ------------------------------------------------------------------ */
/*  默认简历内容（与参考站示例一致的占位文案）                          */
/* ------------------------------------------------------------------ */

let uid = 0
const nextId = () => `id_${Date.now().toString(36)}_${(uid++).toString(36)}`

const createItem = (type = ITEM_TYPE.THREE, preset = {}) => ({
  id: nextId(),
  type,
  leftContent: '',
  centerContent: '',
  rightContent: '',
  ...preset
})

const createSection = (title, items = []) => ({
  id: nextId(),
  title,
  visible: true,
  items
})

function createDefaultResume() {
  return {
    id: nextId(),
    resumeName: '简历_产品经理',
    userIdentity: '',
    templateId: 'classic',
    pageLayout: 'SINGLE',
    borderTheme: 'none',
    borderColor: '#1f4e79',
    headingTheme: 'line',
    headingColor: '#1f4e79',
    headingSecondColor: '#2f6ba3',
    headingFontColor: '#23282f',
    headingCenter: false,
    accentBlock: false,
    personalPhoto: 'avatar:man',
    personalPhotoWidth: 90,
    personalPhotoHeight: 112,
    personalPhotoRight: 0,
    personalPhotoTop: 0,
    personalPhotoShape: 'rect',
    personalPhotoBorder: 'none',
    fontFamily: 'system',
    fontSize: 14,
    fontSpacing: 0,
    lineHeight: 1.65,
    horizontalPadding: STYLE_DEFAULTS.horizontalPadding,
    verticalPadding: STYLE_DEFAULTS.verticalPadding,
    sectionSpacing: 18,
    baseInfoRatio: 50,
    baseInfo: {
      name: '简历',
      gender: '男',
      age: '25',
      education: '本科',
      phone: '18888888888',
      email: 'pb@polebrief.com',
      jobIntention: '产品经理',
      city: '上海',
      experience: '3 年',
      birthday: '',
      politics: '中共党员',
      ethnicity: '汉族',
      hometown: ''
    },
    baseFields: BASE_FIELDS.filter((f) => f.defaultOn).map((f) => f.key),
    sections: [
      createSection('教育背景', [
        createItem(ITEM_TYPE.THREE, {
          leftContent: '学校名称',
          centerContent: '专业名称',
          rightContent: '201x.09-202x.06'
        }),
        createItem(ITEM_TYPE.ONE, {
          centerContent: 'GPA：X.X/4.0（专业前X%或专业排名前10）'
        }),
        createItem(ITEM_TYPE.ONE, { centerContent: '荣誉/奖项：国家奖学金、校一等奖学金' }),
        createItem(ITEM_TYPE.ONE, {
          centerContent: '主修课程：计算机科学与技术等课程。（填写和求职相关的主修课程，可带高分数）'
        })
      ]),
      createSection('实习经历', [
        createItem(ITEM_TYPE.THREE, {
          leftContent: '公司名称',
          centerContent: '岗位名称',
          rightContent: '202x.09-202x.06'
        }),
        createItem(ITEM_TYPE.ONE, {
          centerContent:
            '1、时间倒序。\n2、可以简单描述公司。\n3、详细分析 JD 关键词，工作内容贴近招聘要求，可采用 STAR 法则详细描述，按照工作职责、工作内容、取得成果来写。\n· 在什么情况下（时间地点）+ 任务是什么 + 做了什么事情 + 获得了什么结果（在****地方参加****活动，负责****，获得了****）。\n· 管理/负责/开发（动词）+ 具体的工作内容 + 通过什么动作（运用****工具、与****协作）+ 取得什么可量化成果（如完成****的功能实现、增加粉丝/关注###个、避免了***的错误发生）。\n· 参与/协助/承担/负责/管理***部门***项目的调研/设计/开发，通过***、***等环节，完成了***的目标，实现了***的功能/需求，使销售额增长了30%，增加了2000个粉丝关注（使用量化描述工作成绩，这里要有数据）。'
        })
      ]),
      createSection('技能证书', [
        createItem(ITEM_TYPE.ONE, {
          centerContent:
            '描述和招聘要求相匹配的技能，包括掌握的软件、语言能力等。\n语言：英语 CET-6，具备良好的英文读写能力\n办公：Excel（数据透视表 / 函数）、PPT 方案撰写、Axure / Figma 原型设计'
        })
      ]),
      createSection('项目经历', [
        createItem(ITEM_TYPE.THREE, {
          leftContent: '项目名称',
          centerContent: '担任角色',
          rightContent: '202x.03-202x.08'
        }),
        createItem(ITEM_TYPE.ONE, {
          centerContent:
            '项目描述：一句话说明项目背景与目标。\n我的职责：负责需求调研、流程梳理与原型输出。\n项目成果：上线后转化率提升 15%，人均处理时长下降 30%。'
        })
      ]),
      createSection('自我评价', [
        createItem(ITEM_TYPE.ONE, {
          centerContent:
            '用 3 句话概括：专业能力 + 性格特质 + 与岗位的匹配度。避免出现「吃苦耐劳、认真负责」这类无信息量的词。'
        })
      ])
    ],
    updateDatetime: Date.now()
  }
}

/** 新建空白简历 */
function createBlankResume() {
  const r = createDefaultResume()
  r.resumeName = '未命名简历'
  r.personalPhoto = ''
  r.baseInfo = {
    name: '',
    gender: '',
    age: '',
    education: '',
    phone: '',
    email: '',
    jobIntention: '',
    city: '',
    experience: '',
    birthday: '',
    politics: '',
    ethnicity: '',
    hometown: ''
  }
  r.sections = [createSection('教育背景', [createItem(ITEM_TYPE.THREE)])]
  return r
}

/** 迁移 / 补全字段，保证老草稿也能打开 */
function normalizeResume(raw) {
  const base = createDefaultResume()
  if (!raw || typeof raw !== 'object') return base
  const merged = { ...base, ...raw }
  merged.baseInfo = { ...base.baseInfo, ...(raw.baseInfo || {}) }
  if (!Array.isArray(merged.baseFields) || !merged.baseFields.length) {
    merged.baseFields = base.baseFields
  }
  // 老草稿没有照片外形字段：按现有宽高推断一个合理默认值
  if (!PHOTO_SHAPES.some((s) => s.id === merged.personalPhotoShape)) {
    merged.personalPhotoShape =
      merged.personalPhotoWidth === merged.personalPhotoHeight ? 'square' : 'rect'
  }
  if (!PHOTO_BORDERS.some((b) => b.id === merged.personalPhotoBorder)) {
    merged.personalPhotoBorder = 'none'
  }
  merged.sections = (Array.isArray(raw.sections) ? raw.sections : base.sections).map((s) => ({
    id: s.id || nextId(),
    title: s.title || '未命名区块',
    visible: s.visible !== false,
    items: (Array.isArray(s.items) ? s.items : []).map((it) => ({
      id: it.id || nextId(),
      type: ITEM_META[it.type] ? it.type : ITEM_TYPE.THREE,
      leftContent: it.leftContent || '',
      centerContent: it.centerContent || '',
      rightContent: it.rightContent || ''
    }))
  }))
  return merged
}

/** 区块内容提示（写作建议） */
const SECTION_TIPS = {
  基本信息: [
    '姓名与手机号最关键，务必核对无误。',
    '邮箱建议使用「姓名拼音 + 数字」的正式邮箱，避免花名邮箱。',
    '求职意向写具体岗位名称，与投递岗位保持一致。'
  ],
  教育背景: [
    '学校 + 专业 + 起止时间写在第一行，时间倒序。',
    'GPA 排名靠前一定要写，例如「3.8/4.0（专业前 5%）」。',
    '主修课程只写与目标岗位相关的 5-8 门，可附分数。'
  ],
  实习经历: [
    '使用 STAR 法则：情境、任务、行动、结果。',
    '动词开头：负责、主导、搭建、优化、推动。',
    '结果尽量量化：百分比、绝对值、排名、周期。'
  ],
  工作经历: [
    '按公司分段，时间倒序，最近的在最上面。',
    '每段 3-5 条要点，突出你独立负责的部分。',
    '避免只写职责，要写「做到了什么程度」。'
  ],
  项目经历: [
    '一句话交代项目背景、规模与你的角色。',
    '写清楚你负责的模块，以及用到的技术/方法。',
    '给出可验证的成果数据。'
  ],
  技能证书: [
    '把与岗位最匹配的技能放在最前面。',
    '语言能力写清等级，如「英语 CET-6（560）」。',
    '软件写熟练度：精通 / 熟练 / 了解。'
  ],
  自我评价: [
    '控制在 3 行以内，不要写空话。',
    '专业能力 + 性格特质 + 岗位匹配度。',
    '应届生可写学习能力与项目沉淀。'
  ]
}

const getSectionTip = (title) =>
  SECTION_TIPS[title] || SECTION_TIPS[String(title).replace(/(实习|工作|项目).*/, '$1经历')] || []

module.exports = {
  ITEM_TYPE,
  ITEM_META,
  BASE_FIELDS,
  PHOTO_PRESETS,
  PHOTO_SHAPES,
  PHOTO_BORDERS,
  PHOTO_RATIOS,
  PAGE_LAYOUTS,
  FONT_FAMILIES,
  HEADING_THEMES,
  BORDER_THEMES,
  COLOR_PRESETS,
  TEMPLATES,
  getTemplate,
  applyTemplateToResume,
  buildThumbSample,
  nextId,
  createItem,
  createSection,
  createDefaultResume,
  createBlankResume,
  normalizeResume,
  SECTION_TIPS,
  getSectionTip
}
