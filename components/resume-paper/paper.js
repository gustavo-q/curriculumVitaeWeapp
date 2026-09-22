/**
 * 纸张渲染组件（对应参考站 components/ResumePaper.vue）
 *
 * 职责只有两件事：
 *   · 把 utils/paper.js 编译好的 VM 画出来
 *   · 把纸面上的点击还原成「哪个区块 / 哪个条目 / 哪一栏」并抛给页面
 * 组件不做测量、不碰 store——分页与智能一页都由页面用 utils/layout.js 算好后传入。
 */
Component({
  options: { addGlobalClass: true },

  properties: {
    /** paper.js buildPaperVM() 的结果 */
    vm: { type: Object, value: null },
    /** 页缝的页码列表（第 2..N 页） */
    seams: { type: Array, value: [] }
  },

  data: {
    style: '',
    layout: 'SINGLE',
    sections: [],
    cols: { show: false, style: '' },
    side: {},
    headStyle: '',
    headCells: [],
    name: '',
    nameCls: '',
    photo: { show: false, src: '', style: '' },
    photoSlot: { show: false, style: '' },
    editable: false
  },

  methods: {
    /**
     * 把纸面上的点击还原成具体字段，以自定义事件抛给页面。
     *
     * 为什么在组件内解析：e.target.dataset 只有事件源节点才有；在页面那层
     * 拿到的是组件宿主节点的 dataset（没有我们需要的标记）。组件负责解析，
     * 页面只消费结果。
     *
     * ★ 为什么 data-* 必须同时挂在「文字」节点上：
     *   小程序里 e.target 是真正被点到的最内层节点。用户点在字形上时，
     *   事件源是渲染该文字的 <text>；点在栏目空白处时，事件源是承载该栏的
     *   view。而 dataset 不做继承——只给外层 .item 挂属性时，这两种最常见的
     *   落点拿到的 dataset 分别是 {}（<text> 无属性）与 {field}（缺 sec/item），
     *   都会被下面的守卫拦掉，表现就是「界面写着『点纸面任意文字即可编辑』，
     *   实际怎么点都没反应」。
     *
     *   因此 section.wxml 给栏位与文字两层都挂了同一组 data-sec/item/field，
     *   这里就能稳定取到。守卫额外放行 data-field：即使某处只挂了栏位名，
     *   也能由外层 .paper 的 currentTarget 语义补齐（见 onPick 的兜底）。
     */
    onTap (e) {
      const ds = this.pickDataset(e)
      if (!ds.sec && !ds.base && !ds.photo && !ds.photoAdd) return
      this.triggerEvent('pick', {
        sec: ds.sec || '',
        item: ds.item || '',
        field: ds.field || '',
        base: ds.base || '',
        photo: !!ds.photo,
        photoAdd: !!ds.photoAdd
      })
    },

    /**
     * 取事件源的 dataset。
     *
     * 优先用 target（最内层节点，语义最精确：点哪一栏就是哪一栏）；
     * 它没有可用标记时退回 currentTarget。注意每层都用 mark 做一次自证，
     * 避免取到组件宿主节点的空 dataset 后误判为「点到了空白处」。
     */
    pickDataset (e) {
      const t = (e && e.target && e.target.dataset) || {}
      if (t.sec || t.base || t.photo || t.photoAdd) return t
      const c = (e && e.currentTarget && e.currentTarget.dataset) || {}
      if (c.sec || c.base || c.photo || c.photoAdd) return c
      return t
    }
  },

  observers: {
    vm (vm) {
      if (!vm) return
      this.setData({
        style: vm.paperStyle,
        layout: vm.layout,
        sections: vm.sections,
        cols: vm.cols,
        side: vm.side || {},
        headStyle: vm.headStyle || '',
        headCells: vm.headCells || [],
        name: vm.name,
        nameCls: vm.nameCls,
        photo: vm.photo,
        photoSlot: vm.photoSlot,
        editable: !!vm.editable
      })
    }
  }
});
