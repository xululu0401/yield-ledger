/* 出成率对账台 · core.js
 * 把「买整只回来自己拆」还是「直接买分部位」算成一本可以复算的账。
 *
 * ── 需求简报（详见 ../需求与调研.md） ─────────────────────────────
 * 输入范围与单位：
 *   grossKg 毛重 kg (0, 100000]；pricePerKg 毛重单价 元/kg (0, 1e6]；processCost 处理成本 元 [0, 1e6]
 *   parts[].yieldPct 出成率 % [0,100]（以毛重为基准）；pricePerKg 分部位市价 元/kg [0, 1e6]
 *   parts[].cookPct 熟制率 % (0, 300]；cookedPricePerKg 成品熟食市价 元/kg [0, 1e6]
 *   targetDiscountPct 目标折扣率 % [1, 200]；minutes 处理耗时 分钟 [0, 1e5]；hourlyRate 你的时间价格 元/h [0, 1e6]
 * 模型假设：
 *   A1 出成率以毛重为基准，不可食/未列出的部分 = 毛重 × (1 − Σ出成率)；不重复计列。
 *   A2 分部位市价由用户填，页面不联网、不查行情、不预测价格。
 *   A3 联合成本按「相对售价法」(sales value at split-off) 分摊：C_i = C总 × V_i / V总。
 *   A4 熟制只按质量缩水，不建模成分流失、不建模调味料（要算就填进处理成本）。
 * 关键公式：
 *   B = W·p_W（整只买价）        C = B + P（到手总成本）
 *   w_i = W·y_i                  净料总重 = Σw_i = W·Σy_i
 *   V_i = w_i·p_i                V = ΣV_i
 *   r = C / V（折扣率）          分摊 C_i = C·V_i/V   → 等效单价 = C_i/w_i = r·p_i
 *   省下 = V − C = (1−r)·V       净料单价 = C/Σw_i = r × (按净重加权的平均市价)
 *   熟重 = w_i·z_i               熟食成本单价 = C_i/熟重
 *   临界熟制率 z* = r·p_i / q_i  （自制熟食要便宜过买成品，熟制率必须高于它）
 *   盈亏平衡毛重单价（r=1）= (V − P)/W；不含处理成本口径 = V/W
 *   目标折扣率 x% 下的毛重单价上限 = (x%·V − P)/W
 *   回本最少部位数 k：按产值降序累加，首个 ≥ C 的前缀长度
 * 输出定义：判定三档（整只更省 / 基本持平 / 分部位更省）+ KPI + 部位账 + 帕累托集中度 +
 *           反推（盈亏平衡价、目标价上限、单块回本单价、临界熟制率、折算时薪）+ 敏感性 + 15 项结构自检
 * 默认场景：虚构白羽鸭 2.50 kg × 22.00 元/kg，6 个部位，处理成本 6 元 —— 明确是虚构示例
 * 边界：Σ出成率 > 100 报错；Σ出成率 = 0 报错（无净料，不返回 Infinity）；V = 0 → 折扣率记 null 不可判定；
 *       熟制率 0 → 熟食成本记 null 不可比较；部位数 1..12；W 与价格必须为正
 * 无法处理：不做食品卫生与安全判定、不判断是否新鲜、不查实时菜价、不预测行情、
 *           不判断「值不值得花时间」（只按你填的时间价格折算，不替你决定）
 */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : null;

  const SLUG = 'yield-ledger';
  const NAME = '出成率对账台';
  const VERSION = '1.0.0';
  const PART_MAX = 12;
  const PART_MIN = 1;

  /* ── 数值解析与格式化 ───────────────────────────── */
  function num(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    if (v === null || v === undefined) return NaN;
    let s = String(v).trim();
    if (!s) return NaN;
    s = s.replace(/[，,\s\u00a0]/g, '').replace(/[−–—]/g, '-').replace(/％/g, '%').replace(/[０-９．]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/。$/, '');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return NaN;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : NaN;
  }
  const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const round = (x, d) => { const m = Math.pow(10, d); return Math.round((x + Number.EPSILON * Math.abs(x)) * m) / m; };

  /* 自适应格式：极小非零值不显示成 0.00（如实标出量级） */
  function fmtNum(x, d) {
    if (x === null || x === undefined || !Number.isFinite(x)) return '—';
    const a = Math.abs(x);
    const p = d === undefined ? 2 : d;
    if (a !== 0 && a < Math.pow(10, -p) / 2) return '< ' + (Math.pow(10, -p) / 2).toFixed(p);
    if (a >= 1e15) return x.toExponential(3);   // 再大就真的读不动了，如实标成科学计数
    // 千分位分组（含负数与大额），比科学计数更接近一般人读金额的习惯
    return x.toLocaleString('zh-CN', { minimumFractionDigits: p, maximumFractionDigits: p });
  }
  const fmtMoney = (x) => (x === null || x === undefined || !Number.isFinite(x)) ? '—' : fmtNum(x, 2) + ' 元';
  const fmtMoney0 = (x) => (x === null || x === undefined || !Number.isFinite(x)) ? '—' : fmtNum(x, 2);
  const fmtKg = (x) => (x === null || x === undefined || !Number.isFinite(x)) ? '—' : fmtNum(x, 3) + ' kg';
  const fmtUnit = (x) => (x === null || x === undefined || !Number.isFinite(x)) ? '—' : fmtNum(x, 2) + ' 元/kg';
  const fmtPct = (x, d) => (x === null || x === undefined || !Number.isFinite(x)) ? '—' : fmtNum(x, d === undefined ? 1 : d) + '%';

  /* ── 默认配置与场景（全部为虚构示例，价格不是行情） ── */
  function defaults() {
    return {
      name: '整只白羽鸭（虚构示例）',
      grossKg: 2.5,
      pricePerKg: 22,
      processCost: 6,
      targetDiscountPct: 70,
      minutes: 50,
      hourlyRate: 40,
      parts: [
        { name: '鸭胸', yieldPct: 26, pricePerKg: 55, cookPct: 70, cookedPricePerKg: 62 },
        { name: '鸭腿', yieldPct: 22, pricePerKg: 45, cookPct: 72, cookedPricePerKg: 58 },
        { name: '鸭翅', yieldPct: 12, pricePerKg: 60, cookPct: 88, cookedPricePerKg: 78 },
        { name: '鸭头脖', yieldPct: 10, pricePerKg: 30, cookPct: 92, cookedPricePerKg: 42 },
        { name: '鸭架', yieldPct: 15, pricePerKg: 16, cookPct: 100, cookedPricePerKg: 0 },
        { name: '鸭油鸭皮', yieldPct: 7, pricePerKg: 20, cookPct: 45, cookedPricePerKg: 0 },
      ],
    };
  }

  const SCENARIOS = [
    { id: 'duck', name: '整只白羽鸭（虚构示例 · 默认）', cfg: defaults },
    {
      id: 'grasscarp', name: '一条草鱼 · 鱼柳 vs 整条（虚构示例）',
      cfg: () => ({
        name: '一条草鱼（虚构示例）', grossKg: 2.2, pricePerKg: 15, processCost: 0,
        targetDiscountPct: 70, minutes: 25, hourlyRate: 40,
        parts: [
          { name: '净鱼柳', yieldPct: 34, pricePerKg: 46, cookPct: 88, cookedPricePerKg: 68 },
          { name: '鱼头', yieldPct: 16, pricePerKg: 24, cookPct: 95, cookedPricePerKg: 0 },
          { name: '鱼骨鱼尾', yieldPct: 20, pricePerKg: 8, cookPct: 100, cookedPricePerKg: 0 },
          { name: '鱼皮', yieldPct: 4, pricePerKg: 18, cookPct: 80, cookedPricePerKg: 0 },
        ],
      }),
    },
    {
      id: 'lamb', name: '整只羊腿 · 剔骨分块（虚构示例）',
      cfg: () => ({
        name: '整只羊前腿（虚构示例）', grossKg: 4.6, pricePerKg: 44, processCost: 12,
        targetDiscountPct: 80, minutes: 90, hourlyRate: 45,
        parts: [
          { name: '羊腿肉（净）', yieldPct: 46, pricePerKg: 72, cookPct: 62, cookedPricePerKg: 118 },
          { name: '羊排块', yieldPct: 20, pricePerKg: 88, cookPct: 70, cookedPricePerKg: 138 },
          { name: '羊骨（炖汤）', yieldPct: 24, pricePerKg: 12, cookPct: 100, cookedPricePerKg: 0 },
          { name: '油膘筋皮', yieldPct: 6, pricePerKg: 14, cookPct: 60, cookedPricePerKg: 0 },
        ],
      }),
    },
    {
      id: 'beefshank', name: '整条牛腱 · 卤一锅（虚构示例）',
      cfg: () => ({
        name: '整条牛腱子（虚构示例）', grossKg: 1.8, pricePerKg: 73, processCost: 26,
        targetDiscountPct: 70, minutes: 150, hourlyRate: 45,
        parts: [
          { name: '腱子肉', yieldPct: 88, pricePerKg: 96, cookPct: 62, cookedPricePerKg: 158 },
          { name: '筋膜碎肉', yieldPct: 6, pricePerKg: 40, cookPct: 70, cookedPricePerKg: 90 },
        ],
      }),
    },
    {
      id: 'salmon', name: '整条三文鱼 · 刺身与边角（虚构示例）',
      cfg: () => ({
        name: '整条三文鱼（虚构示例）', grossKg: 3.2, pricePerKg: 95, processCost: 10,
        targetDiscountPct: 70, minutes: 45, hourlyRate: 50,
        parts: [
          { name: '中段刺身', yieldPct: 38, pricePerKg: 220, cookPct: 92, cookedPricePerKg: 300 },
          { name: '背肉边角（煎）', yieldPct: 22, pricePerKg: 120, cookPct: 82, cookedPricePerKg: 168 },
          { name: '鱼头鱼骨（汤）', yieldPct: 20, pricePerKg: 20, cookPct: 100, cookedPricePerKg: 0 },
          { name: '鱼皮（烤）', yieldPct: 8, pricePerKg: 26, cookPct: 62, cookedPricePerKg: 0 },
        ],
      }),
    },
    {
      id: 'wholechicken_dear', name: '反例：整只反而更贵（虚构示例）',
      cfg: () => ({
        name: '一只散养鸡（虚构示例 · 整只价偏高）', grossKg: 1.6, pricePerKg: 68, processCost: 6,
        targetDiscountPct: 70, minutes: 40, hourlyRate: 40,
        parts: [
          { name: '鸡腿', yieldPct: 24, pricePerKg: 46, cookPct: 74, cookedPricePerKg: 70 },
          { name: '鸡翅', yieldPct: 10, pricePerKg: 52, cookPct: 86, cookedPricePerKg: 84 },
          { name: '鸡胸', yieldPct: 22, pricePerKg: 38, cookPct: 68, cookedPricePerKg: 66 },
          { name: '鸡架', yieldPct: 26, pricePerKg: 10, cookPct: 100, cookedPricePerKg: 0 },
          { name: '鸡爪鸡脖', yieldPct: 9, pricePerKg: 30, cookPct: 90, cookedPricePerKg: 46 },
        ],
      }),
    },
    {
      id: 'bulkpork', name: '批发整扇排骨 · 大分量（虚构示例）',
      cfg: () => ({
        name: '整扇猪肋排（虚构示例 · 批发）', grossKg: 9.5, pricePerKg: 32, processCost: 15,
        targetDiscountPct: 75, minutes: 120, hourlyRate: 50,
        parts: [
          { name: '精肋排', yieldPct: 44, pricePerKg: 58, cookPct: 78, cookedPricePerKg: 96 },
          { name: '带骨边排', yieldPct: 22, pricePerKg: 36, cookPct: 80, cookedPricePerKg: 62 },
          { name: '脊骨', yieldPct: 18, pricePerKg: 14, cookPct: 100, cookedPricePerKg: 0 },
          { name: '板油碎肉', yieldPct: 8, pricePerKg: 18, cookPct: 55, cookedPricePerKg: 0 },
        ],
      }),
    },
    {
      id: 'zerowaste', name: '出成率合计正好 100%（虚构示例）',
      cfg: () => ({
        name: '去壳净虾仁（虚构示例 · 零不可食）', grossKg: 1.5, pricePerKg: 88, processCost: 0,
        targetDiscountPct: 70, minutes: 30, hourlyRate: 45,
        parts: [
          { name: '虾仁', yieldPct: 62, pricePerKg: 168, cookPct: 86, cookedPricePerKg: 210 },
          { name: '虾头虾壳（熬油）', yieldPct: 34, pricePerKg: 10, cookPct: 100, cookedPricePerKg: 0 },
          { name: '虾线杂质', yieldPct: 4, pricePerKg: 2, cookPct: 100, cookedPricePerKg: 0 },
        ],
      }),
    },
    {
      id: 'hardcook', name: '熟制缩水严重 · 熟食不划算（虚构示例）',
      cfg: () => ({
        name: '整块牛腩（虚构示例 · 长时间炖煮）', grossKg: 2.4, pricePerKg: 58, processCost: 30,
        targetDiscountPct: 70, minutes: 180, hourlyRate: 45,
        parts: [
          { name: '牛腩块', yieldPct: 90, pricePerKg: 82, cookPct: 48, cookedPricePerKg: 96 },
          { name: '筋膜', yieldPct: 8, pricePerKg: 26, cookPct: 60, cookedPricePerKg: 60 },
        ],
      }),
    },
  ];

  const scenarioCfg = (id) => {
    const s = SCENARIOS.filter((x) => x.id === id)[0];
    return s ? s.cfg() : defaults();
  };

  /* ── 归一化 ─────────────────────────────────────── */
  function normCfg(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const d = defaults();
    // 显式传空数组时保持为空、超过上限也不截断——两种情况都交给 validate 明确报错，
    // 不静默回落默认值、也不静默丢掉多出来的行（历史教训：静默兜底会掩盖输入错误）
    const parts = Array.isArray(r.parts) ? r.parts : d.parts;
    return {
      name: r.name === undefined || r.name === null ? d.name : String(r.name).slice(0, 60),
      grossKg: r.grossKg === undefined ? d.grossKg : r.grossKg,
      pricePerKg: r.pricePerKg === undefined ? d.pricePerKg : r.pricePerKg,
      processCost: r.processCost === undefined ? d.processCost : r.processCost,
      targetDiscountPct: r.targetDiscountPct === undefined ? d.targetDiscountPct : r.targetDiscountPct,
      minutes: r.minutes === undefined ? d.minutes : r.minutes,
      hourlyRate: r.hourlyRate === undefined ? d.hourlyRate : r.hourlyRate,
      parts: parts.map((p) => ({
        name: p && p.name !== undefined && p.name !== null ? String(p.name).slice(0, 24) : '部位',
        yieldPct: p ? p.yieldPct : 0,
        pricePerKg: p ? (p.pricePerKg === undefined ? 0 : p.pricePerKg) : 0,
        cookPct: p ? (p.cookPct === undefined ? 100 : p.cookPct) : 100,
        cookedPricePerKg: p ? (p.cookedPricePerKg === undefined ? 0 : p.cookedPricePerKg) : 0,
      })),
    };
  }
  const defaultsClone = () => normCfg(defaults());

  /* ── 校验：逐条给字段，UI 用它标红 ─────────────── */
  const FIELDS = [
    ['grossKg', '毛重', (v) => v > 0 && v <= 100000, '必须是 0 到 100000 kg 之间的正数'],
    ['pricePerKg', '毛重单价', (v) => v > 0 && v <= 1e6, '必须是 0 到 1000000 元/kg 之间的正数'],
    ['processCost', '处理成本', (v) => v >= 0 && v <= 1e6, '必须是 0 到 1000000 元之间'],
    ['targetDiscountPct', '目标折扣率', (v) => v >= 1 && v <= 200, '必须是 1% 到 200% 之间'],
    ['minutes', '处理耗时', (v) => v >= 0 && v <= 1e5, '必须是 0 到 100000 分钟之间'],
    ['hourlyRate', '你的时间价格', (v) => v >= 0 && v <= 1e6, '必须是 0 到 1000000 元/h 之间'],
  ];
  const PART_FIELDS = [
    ['yieldPct', '出成率', (v) => v >= 0 && v <= 100, '必须是 0% 到 100% 之间'],
    ['pricePerKg', '该部位市价', (v) => v >= 0 && v <= 1e6, '必须是 0 到 1000000 元/kg 之间'],
    ['cookPct', '熟制率', (v) => v > 0 && v <= 300, '必须大于 0 且不超过 300%'],
    ['cookedPricePerKg', '成品熟食市价', (v) => v >= 0 && v <= 1e6, '必须是 0 到 1000000 元/kg 之间'],
  ];

  function validate(cfg) {
    const c = normCfg(cfg);
    const errors = [];
    FIELDS.forEach(([k, label, ok, msg]) => {
      const v = num(c[k]);
      if (Number.isNaN(v)) errors.push({ field: k, label, msg: label + '不是有效数字', value: c[k] });
      else if (!ok(v)) errors.push({ field: k, label, msg: label + '：' + msg, value: v });
    });
    if (!Array.isArray(c.parts) || c.parts.length < PART_MIN) {
      errors.push({ field: 'parts', label: '部位清单', msg: '至少要有一个部位', value: c.parts && c.parts.length });
    } else if (c.parts.length > PART_MAX) {
      errors.push({ field: 'parts', label: '部位清单', msg: '最多 ' + PART_MAX + ' 个部位', value: c.parts.length });
    } else {
      c.parts.forEach((p, i) => {
        PART_FIELDS.forEach(([k, label, ok, msg]) => {
          const v = num(p[k]);
          const id = 'p-' + k + '-' + i;
          if (Number.isNaN(v)) errors.push({ field: id, label: label, msg: '第 ' + (i + 1) + ' 行「' + p.name + '」的' + label + '不是有效数字', value: p[k] });
          else if (!ok(v)) errors.push({ field: id, label, msg: '第 ' + (i + 1) + ' 行「' + p.name + '」' + label + '：' + msg, value: v });
        });
      });
    }
    if (!errors.length) {
      const sumY = sum(c.parts.map((p) => num(p.yieldPct)));
      if (sumY > 100 + 1e-9) {
        errors.push({
          field: 'parts', label: '出成率合计',
          msg: '出成率合计 ' + fmtPct(sumY, 2) + ' 超过 100%（多出 ' + fmtPct(sumY - 100, 2) + '）——出成率以毛重为基准，不能加总超过毛重',
          value: sumY,
        });
      }
      if (sumY <= 0) {
        errors.push({ field: 'parts', label: '出成率合计', msg: '出成率合计为 0：没有净料，这笔账不成立', value: sumY });
      }
    }
    return errors;
  }

  /* ── 主计算（纯计算，不跑自检，避免递归） ────────── */
  function compute(rawCfg) {
    const cfg = normCfg(rawCfg);
    const errors = validate(cfg);
    if (errors.length) return { ok: false, errors, slug: SLUG, version: VERSION };

    const W = num(cfg.grossKg);
    const pW = num(cfg.pricePerKg);
    const P = num(cfg.processCost);
    const target = num(cfg.targetDiscountPct);
    const minutes = num(cfg.minutes);
    const hourly = num(cfg.hourlyRate);

    const B = W * pW;                 // 整只买价
    const C = B + P;                  // 到手总成本
    const sumY = sum(cfg.parts.map((p) => num(p.yieldPct)));
    const netKg = W * sumY / 100;
    const wastePct = 100 - sumY;
    const wasteKg = W * wastePct / 100;

    const parts = cfg.parts.map((p, i) => {
      const y = num(p.yieldPct), pi = num(p.pricePerKg), z = num(p.cookPct), q = num(p.cookedPricePerKg);
      const w = W * y / 100;
      const v = w * pi;
      const cookKg = w * z / 100;
      return { i, name: p.name, yieldPct: y, pricePerKg: pi, cookPct: z, cookedPricePerKg: q, w, v, cookKg };
    });
    const V = sum(parts.map((p) => p.v));
    const r = V > 0 ? C / V : null;

    parts.forEach((p) => {
      p.share = V > 0 ? p.v / V : null;                  // 产值占比
      p.alloc = V > 0 ? C * p.v / V : null;              // 分摊成本
      p.allocUnit = (p.alloc !== null && p.w > 0) ? p.alloc / p.w : null;   // 等效单价 = r·p_i
      p.save = p.alloc !== null ? p.v - p.alloc : null;  // 相对直接买省下的钱
      p.cookUnit = (p.alloc !== null && p.cookKg > 0) ? p.alloc / p.cookKg : null;  // 熟食成本单价
      p.cookSavePerKg = (p.cookUnit !== null && p.cookedPricePerKg > 0) ? p.cookedPricePerKg - p.cookUnit : null;
      p.cookSave = p.cookSavePerKg !== null ? p.cookSavePerKg * p.cookKg : null;
      // 临界熟制率：自制熟食单价 = 买成品单价 → z* = r·p/z 里解出 z* = alloc/(w·q) = r·p/q
      p.cookBreakEvenPct = (r !== null && p.cookedPricePerKg > 0 && p.pricePerKg > 0 && p.w > 0)
        ? (r * p.pricePerKg / p.cookedPricePerKg) * 100 : null;
      p.cookVerdict = p.cookSavePerKg === null ? 'none'
        : (p.cookSavePerKg > Math.abs(p.cookUnit) * 0.03 ? 'cheaper' : (p.cookSavePerKg < -Math.abs(p.cookUnit) * 0.03 ? 'dearer' : 'even'));
    });

    const netUnit = netKg > 0 ? C / netKg : null;        // 净料单价（含处理成本）
    const netUnitNoProcess = netKg > 0 ? B / netKg : null;
    const weightedAvgPrice = netKg > 0 ? V / netKg : null;  // 按净重加权的平均市价

    /* 帕累托：按产值降序，回本最少部位数 */
    const ranked = parts.slice().sort((a, b) => (b.v - a.v) || (a.i - b.i));
    let cum = 0;
    ranked.forEach((p, k) => { cum += p.v; p.rank = k + 1; p.cumV = cum; p.cumShare = V > 0 ? cum / V : null; });
    let minCover = null;
    if (V > 0) {
      for (let k = 1; k <= ranked.length; k++) {
        if (ranked[k - 1].cumV >= C - 1e-9) { minCover = k; break; }
      }
    }
    const coverParts = minCover ? ranked.slice(0, minCover) : [];
    const coverShare = (minCover && V > 0) ? ranked[minCover - 1].cumV / V : null;
    const topShare = ranked.length && V > 0 ? ranked[0].v / V : null;

    /* 反推 */
    const breakevenPrice = W > 0 ? (V - P) / W : null;             // 含处理成本：让 r = 1
    const breakevenPriceNoProcess = W > 0 ? V / W : null;          // 不含处理成本
    const targetCapTotal = V * target / 100;
    const targetCapPrice = W > 0 ? (targetCapTotal - P) / W : null;
    const targetOk = r !== null && r <= target / 100 + 1e-12;
    const rev = {
      breakevenPrice, breakevenPriceNoProcess, targetCapTotal, targetCapPrice, targetOk,
      targetDiscountPct: target,
      // 只靠某一块回本需要的单价：p = C / w_i
      singleCover: parts.map((p) => ({
        name: p.name, w: p.w, priceNeeded: p.w > 0 ? C / p.w : null,
        priceNow: p.pricePerKg,
        ratio: (p.w > 0 && p.pricePerKg > 0) ? (C / p.w) / p.pricePerKg : null,
      })),
      // 只想要某一块时，为它买整只等于每公斤多少钱
      oneOnly: parts.map((p) => ({
        name: p.name, w: p.w, costPerKgOfPart: p.w > 0 ? C / p.w : null, priceNow: p.pricePerKg,
        dearer: (p.w > 0 && p.pricePerKg > 0) ? (C / p.w) > p.pricePerKg : null,
      })),
      minutes, hourly,
      saved: V - C,
      savedPerHour: minutes > 0 ? (V - C) / (minutes / 60) : null,
      netUnit, netUnitNoProcess, weightedAvgPrice,
    };

    /* 判定 */
    let verdict;
    if (r === null) verdict = { id: 'none', label: '无法判定', note: '分部位市价合计为 0，没有可比的市场口径' };
    else if (r < 0.97 - 1e-12) verdict = { id: 'whole', label: '整只更省', note: '按分部位市价采购同样这些净料，要比整只多花 ' + fmtMoney(V - C) };
    else if (r > 1.03 + 1e-12) verdict = { id: 'parts', label: '分部位更省', note: '整只买反而比按分部位市价采购多花 ' + fmtMoney(C - V) };
    else verdict = { id: 'even', label: '基本持平', note: '两条路线的总价差在 3% 以内（' + fmtMoney(Math.abs(V - C)) + '）' };

    const kpis = {
      grossKg: W, boughtPrice: B, totalCost: C, marketValue: V, discountRate: r,
      netKg, wasteKg, wastePct, netUnit, netUnitNoProcess, weightedAvgPrice,
      saved: V - C, savedPct: V > 0 ? (V - C) / V * 100 : null,
      minCover, coverShare, topShare,
    };

    return {
      ok: true, slug: SLUG, version: VERSION, cfg, errors: [],
      verdict, kpis, parts, ranked, rev, sumY, wastePct, wasteKg,
      name: cfg.name,
    };
  }

  /* analyze = compute + 要点/下一步/结构自检（自检内部只调 compute，不会递归） */
  function analyze(rawCfg) {
    const res = compute(rawCfg);
    if (!res.ok) return res;
    res.insights = insights(res);
    res.steps = steps(res);
    res.checks = selfChecks(res);
    res.checkSummary = { pass: res.checks.filter((c) => c.pass).length, total: res.checks.length };
    return res;
  }

  /* ── 结论要点（每个数字都能从上一次重算里回溯） ── */
  function insights(res) {
    const k = res.kpis, out = [];
    if (k.discountRate !== null) {
      out.push({
        t: '折扣率 r = ' + fmtNum(k.discountRate, 4) + ' 对每个部位都是同一个数',
        d: '按售价分摊下，任何部位的等效单价 = r × 它的市价（'
          + res.parts.slice(0, 3).map((p) => p.name + ' ' + fmtUnit(p.allocUnit)).join('、')
          + '）。所以「拆哪一块更划算」是个伪问题——真正的杠杆只有整只到手成本与分部位市值之比。',
      });
      out.push({
        t: '净料单价 = ' + fmtUnit(k.netUnit) + '（含处理成本）',
        d: '整只到手 ' + fmtMoney(k.totalCost) + ' ÷ 净料 ' + fmtKg(k.netKg) + '；去掉处理成本是 '
          + fmtUnit(k.netUnitNoProcess) + '。它等于 r × 按净重加权的平均市价（' + fmtUnit(k.weightedAvgPrice) + '）。'
          + '毛重里有 ' + fmtPct(res.wastePct, 2) + '（' + fmtKg(res.wasteKg) + '）进不了肚子，所以「整只 '
          + fmtNum(num(res.cfg.pricePerKg), 2) + ' 元/kg」不是你能吃到的单价。',
      });
    }
    if (k.minCover) {
      const names = res.ranked.slice(0, k.minCover).map((p) => p.name).join(' + ');
      out.push({
        t: '真正用掉前 ' + k.minCover + ' 块就能回本：' + names,
        d: '按产值降序累加，前 ' + k.minCover + ' 块合计 ' + fmtMoney(res.ranked[k.minCover - 1].cumV)
          + '（占市值 ' + fmtPct((res.ranked[k.minCover - 1].cumShare || 0) * 100) + '）已经覆盖到手成本 '
          + fmtMoney(k.totalCost) + '。最贵的一块占市值 ' + fmtPct((k.topShare || 0) * 100) + '。'
          + (k.minCover === 1 ? '这一块单独就够本。' : '反过来说，要是你只想要「' + res.ranked[0].name + '」这一块，为它买整只等于按 '
            + fmtUnit(res.rev.oneOnly[res.ranked[0].i] ? res.rev.oneOnly[res.ranked[0].i].costPerKgOfPart : null)
            + ' 承担成本（直接买现成的只要 ' + fmtUnit(res.ranked[0].pricePerKg) + '），差额得靠其它部位用掉才补得回来。'),
      });
    }
    const cookRows = res.parts.filter((p) => p.cookSavePerKg !== null);
    if (cookRows.length) {
      const best = cookRows.slice().sort((a, b) => b.cookSavePerKg - a.cookSavePerKg)[0];
      const worst = cookRows.slice().sort((a, b) => a.cookSavePerKg - b.cookSavePerKg)[0];
      out.push({
        t: '熟制缩水会二次推高单价：' + best.name + ' 熟食成本 ' + fmtUnit(best.cookUnit)
          + ' vs 成品 ' + fmtUnit(best.cookedPricePerKg) + '（' + (best.cookSavePerKg >= 0 ? '省 ' : '贵 ')
          + fmtUnit(Math.abs(best.cookSavePerKg)) + '）',
        d: '生重 ' + fmtKg(best.w) + ' × 熟制率 ' + fmtPct(best.cookPct, 0) + ' = 熟重 ' + fmtKg(best.cookKg)
          + '；分摊成本 ' + fmtMoney(best.alloc) + ' ÷ 熟重 = 上面的单价。'
          + '临界熟制率 ' + fmtPct(best.cookBreakEvenPct) + '：低于它，自制就贵过直接买成品。'
          + (worst.cookSavePerKg < 0 ? '这本账里 ' + worst.name + ' 已经贵过成品，贵 ' + fmtUnit(Math.abs(worst.cookSavePerKg)) + '。' : ''),
      });
    }
    if (res.rev.savedPerHour !== null && num(res.cfg.minutes) > 0) {
      out.push({
        t: '这次自己处理折算 ' + fmtNum(res.rev.savedPerHour, 2) + ' 元/h（按省下的钱 ÷ 花掉的时间）',
        d: '省下 ' + fmtMoney(res.rev.saved) + '、耗时 ' + fmtNum(num(res.cfg.minutes), 0) + ' 分钟；'
          + '你自己的时间价格填的是 ' + fmtNum(num(res.cfg.hourlyRate), 2) + ' 元/h——'
          + (res.rev.savedPerHour >= num(res.cfg.hourlyRate) ? '折算下来不低于它。' : '折算下来低于它，这笔省下的钱其实是在拿时间换。')
          + '这只是把两个你自己填的数字比一下，页面不替你决定时间值多少钱。',
      });
    }
    return out;
  }

  /* ── 下一步（都能真的改到输入上） ── */
  function steps(res) {
    const k = res.kpis, out = [];
    const be = res.rev.breakevenPrice;
    if (be !== null && be > 0) {
      out.push({
        t: '盈亏平衡毛重单价是 ' + fmtUnit(be) + '（含处理成本口径）',
        d: num(res.cfg.pricePerKg) <= be
          ? '你现在填的 ' + fmtUnit(num(res.cfg.pricePerKg)) + ' 低于它，所以这趟整只买得划算：'
            + '整只到手 ' + fmtMoney(res.kpis.totalCost) + ' 对应分部位市值 ' + fmtMoney(res.kpis.marketValue) + '。'
            + '低得越多，这本账给整只留的余地越大。'
          : '你现在填的 ' + fmtUnit(num(res.cfg.pricePerKg)) + ' 高于它：这样买整只比按分部位市价采购还贵 '
            + fmtMoney(res.kpis.totalCost - res.kpis.marketValue) + '。要不砍到它以下，要不直接买分部位。',
        apply: 'breakeven', val: be,
        btn: '按盈亏平衡价 ' + fmtNum(be, 2) + ' 元/kg 改输入',
      });
    }
    if (res.rev.targetCapPrice !== null) {
      const cap = Math.max(0, res.rev.targetCapPrice);
      out.push({
        t: '按你填的目标折扣率 ' + fmtPct(res.rev.targetDiscountPct, 0) + '，毛重单价上限是 ' + fmtUnit(cap),
        d: res.rev.targetOk ? '当前折扣率已经在这个目标之内。'
          : '当前折扣率 ' + fmtNum(k.discountRate, 3) + ' 高于目标 ' + fmtNum(res.rev.targetDiscountPct / 100, 2) + '，要做到得把毛重单价压到上限以内。',
        apply: 'target', val: cap,
        btn: '按目标折扣率 ' + fmtNum(cap, 2) + ' 元/kg 改输入',
      });
    }
    const dear = res.parts.filter((p) => p.cookSavePerKg !== null && p.cookSavePerKg < 0);
    if (dear.length) {
      out.push({
        t: '熟食别自己做：' + dear.map((p) => p.name).join('、'),
        d: '这几块自己熟制后的成本高于成品熟食市价（'
          + dear.map((p) => p.name + ' ' + fmtUnit(p.cookUnit) + ' vs ' + fmtUnit(p.cookedPricePerKg)).join('；')
          + '）。要么把熟制率提上去，要么直接买成品。',
      });
    }
    const over = res.parts.filter((p) => p.cookBreakEvenPct !== null && p.cookSavePerKg !== null && p.cookSavePerKg >= 0);
    if (over.length) {
      // 临界熟制率越高越难满足 → 最脆弱的是「要求熟制率最高」的那一块
      const w = over.slice().sort((a, b) => b.cookBreakEvenPct - a.cookBreakEvenPct)[0];
      out.push({
        t: '自制熟食最脆弱的一环是 ' + w.name + '：熟制率掉到 ' + fmtPct(w.cookBreakEvenPct) + ' 以下就不划算了',
        d: '临界熟制率 = r × 它的市价 ÷ 成品熟食市价。现在填的是 ' + fmtPct(w.cookPct, 0) + '。',
      });
    }
    if (res.kpis.minCover && res.kpis.minCover >= 2 && res.ranked[res.kpis.minCover - 1]) {
      out.push({
        t: '冰箱/饭量至少安排掉前 ' + res.kpis.minCover + ' 块',
        d: '按产值降序：' + res.ranked.slice(0, res.kpis.minCover).map((p) => p.name + ' ' + fmtKg(p.w)).join('、')
          + '——这几块合计覆盖到手成本，剩下的骨头油皮只能算添头。',
      });
    }
    return out;
  }

  /* ── 结构自检（每次重算都跑；只证明内部一致与量纲，不证明你的输入是真的） ── */
  function selfChecks(res) {
    const c = [];
    const ok = (name, pass, detail) => c.push({ name, pass: !!pass, detail: detail || '' });
    const k = res.kpis, parts = res.parts, V = k.marketValue, C = k.totalCost, W = k.grossKg;
    const near = (a, b, tol) => Math.abs(a - b) <= tol;

    ok('净重 + 不可食 = 毛重', near(k.netKg + k.wasteKg, W, 1e-9), '净 ' + k.netKg + ' + 废 ' + k.wasteKg + ' = ' + W);
    ok('分部位净重之和 = 净料总重', near(sum(parts.map((p) => p.w)), k.netKg, 1e-9), sum(parts.map((p) => p.w)).toString());
    ok('产值占比合计 = 100%', V > 0 ? near(sum(parts.map((p) => p.share)), 1, 1e-12) : true, V > 0 ? sum(parts.map((p) => p.share)).toString() : '无市值');
    if (V > 0) {
      ok('分摊成本合计 = 到手总成本', near(sum(parts.map((p) => p.alloc)), C, 1e-9), sum(parts.map((p) => p.alloc)).toString());
      ok('等效单价 = r × 市价（逐部位）', parts.every((p) => p.allocUnit === null || near(p.allocUnit, k.discountRate * p.pricePerKg, 1e-9)), '');
      ok('折扣率 = 到手成本 ÷ 分部位市值', near(k.discountRate, C / V, 1e-12), k.discountRate + ' vs ' + (C / V));
      ok('省下 = 市值 − 到手成本', near(k.saved, V - C, 1e-9), k.saved.toString());
      ok('净料单价 = r × 按净重加权平均市价', near(k.netUnit, k.discountRate * k.weightedAvgPrice, 1e-9), k.netUnit + ' vs ' + (k.discountRate * k.weightedAvgPrice));
      ok('盈亏平衡价回代后 r = 1', (() => {
        if (res.rev.breakevenPrice === null || res.rev.breakevenPrice <= 0) return true;
        const r2 = compute(Object.assign({}, res.cfg, { pricePerKg: res.rev.breakevenPrice }));
        return r2.ok && near(r2.kpis.discountRate, 1, 1e-9);
      })(), String(res.rev.breakevenPrice));
      const mc = k.minCover;
      ok('回本部位数取的是最小前缀', mc === null ? V < C : (res.ranked[mc - 1].cumV >= C - 1e-9 && (mc === 1 || res.ranked[mc - 2].cumV < C - 1e-9)), 'k=' + mc);
    } else {
      /* 市值为 0 时同样给满 7 项，保证「17 项」这个口径在任何输入下都成立 */
      ok('市值为 0 时折扣率记为不可判定', k.discountRate === null, '');
      ok('市值为 0 时不产生分摊成本', parts.every((p) => p.alloc === null && p.allocUnit === null), '');
      ok('市值为 0 时不给回本部位数', k.minCover === null, '');
      ok('市值为 0 时结论记「无法判定」', res.verdict.id === 'none', res.verdict.label);
      ok('市值为 0 时占比一律记 null', parts.every((p) => p.share === null), '');
      ok('市值为 0 时省下 = 0 − 到手成本', near(k.saved, -C, 1e-9), String(k.saved));
      ok('市值为 0 时净料单价仍按到手成本与净重给出', k.netKg > 0 ? near(k.netUnit, C / k.netKg, 1e-12) : k.netUnit === null, String(k.netUnit));
    }
    ok('熟重 = 净重 × 熟制率', parts.every((p) => near(p.cookKg, p.w * p.cookPct / 100, 1e-12)), '');
    ok('熟制率为 0 时不给熟食单价（不返回 Infinity）', parts.every((p) => p.cookPct > 0 || p.cookUnit === null), '');
    ok('临界熟制率回代 = 成品熟食市价', parts.every((p) => {
      if (p.cookBreakEvenPct === null) return true;
      const z = p.cookBreakEvenPct / 100;
      return near(p.alloc / (p.w * z), p.cookedPricePerKg, 1e-6 * Math.max(1, p.cookedPricePerKg));
    }), '');
    ok('全部输出都是有限数（无 NaN / Infinity）', parts.every((p) => ['w', 'v', 'alloc', 'allocUnit', 'save', 'cookKg', 'cookUnit'].every((f) => p[f] === null || Number.isFinite(p[f]))) && [C, V, k.netUnit].every(Number.isFinite), '');
    ok('毛重单价上涨不会让折扣率下降', (() => {
      const up = compute(Object.assign({}, res.cfg, { pricePerKg: num(res.cfg.pricePerKg) * 1.5 + 1 }));
      if (!up.ok || up.kpis.discountRate === null || k.discountRate === null) return true;
      return up.kpis.discountRate >= k.discountRate - 1e-12;
    })(), '单调性');
    ok('处理成本为 0 时折扣率与毛重无关', (() => {
      const zero = compute(Object.assign({}, res.cfg, { processCost: 0 }));
      const big = compute(Object.assign({}, res.cfg, { processCost: 0, grossKg: num(res.cfg.grossKg) * 3 }));
      if (!zero.ok || !big.ok || zero.kpis.discountRate === null) return true;
      // 恒等式为 r = 毛重单价 ÷ 按净重加权平均市价（与毛重无关）；极小市值下浮点相对误差会放大，容差 1e-9
      return Math.abs(big.kpis.discountRate - zero.kpis.discountRate) / Math.max(1e-12, Math.abs(zero.kpis.discountRate)) <= 1e-9;
    })(), 'r = 毛重单价 ÷ 按净重加权平均市价');
    ok('结论与折扣率同向', (k.discountRate === null && res.verdict.id === 'none')
      || (k.discountRate < 0.97 && res.verdict.id === 'whole')
      || (k.discountRate > 1.03 && res.verdict.id === 'parts')
      || (k.discountRate >= 0.97 && k.discountRate <= 1.03 && res.verdict.id === 'even'), res.verdict.id);
    return c;
  }

  /* ── 敏感性（每行完整重算，不是插值） ── */
  function sensitivity(cfg) {
    const base = compute(cfg);
    if (!base.ok) return [];
    const c = normCfg(cfg);
    const rows = [];
    const push = (label, mut) => {
      const r = compute(mut());
      rows.push({
        label,
        ok: r.ok,
        discountRate: r.ok ? r.kpis.discountRate : null,
        netUnit: r.ok ? r.kpis.netUnit : null,
        minCover: r.ok ? r.kpis.minCover : null,
        saved: r.ok ? r.kpis.saved : null,
        verdict: r.ok ? r.verdict.label : '输入不合法',
      });
    };
    const clone = () => JSON.parse(JSON.stringify(c));
    push('毛重单价 +10%', () => { const x = clone(); x.pricePerKg = num(x.pricePerKg) * 1.1; return x; });
    push('毛重单价 −10%', () => { const x = clone(); x.pricePerKg = num(x.pricePerKg) * 0.9; return x; });
    push('处理成本翻倍', () => { const x = clone(); x.processCost = num(x.processCost) * 2; return x; });
    push('处理成本归零', () => { const x = clone(); x.processCost = 0; return x; });
    push('所有出成率 × 0.9', () => { const x = clone(); x.parts.forEach((p) => { p.yieldPct = num(p.yieldPct) * 0.9; }); return x; });
    push('所有出成率 × 1.1（可能超过 100%）', () => { const x = clone(); x.parts.forEach((p) => { p.yieldPct = num(p.yieldPct) * 1.1; }); return x; });
    push('最贵部位市价 −10%', () => {
      const x = clone();
      const top = x.parts.slice().sort((a, b) => (num(b.yieldPct) * num(b.pricePerKg)) - (num(a.yieldPct) * num(a.pricePerKg)))[0];
      top.pricePerKg = num(top.pricePerKg) * 0.9; return x;
    });
    push('最贵部位市价 +10%', () => {
      const x = clone();
      const top = x.parts.slice().sort((a, b) => (num(b.yieldPct) * num(b.pricePerKg)) - (num(a.yieldPct) * num(a.pricePerKg)))[0];
      top.pricePerKg = num(top.pricePerKg) * 1.1; return x;
    });
    push('所有熟制率 −10 个百分点', () => { const x = clone(); x.parts.forEach((p) => { p.cookPct = Math.max(1, num(p.cookPct) - 10); }); return x; });
    push('毛重 +25%（多买一点）', () => { const x = clone(); x.grossKg = num(x.grossKg) * 1.25; return x; });
    return rows;
  }

  /* ── 导出 ───────────────────────────────────────── */
  function backupJson(cfg) {
    return JSON.stringify({ app: SLUG, version: VERSION, savedAt: new Date().toISOString(), cfg: normCfg(cfg) }, null, 2);
  }
  function readBackup(text) {
    let o;
    try { o = JSON.parse(String(text)); } catch (e) { throw new Error('不是合法的 JSON'); }
    if (!o || typeof o !== 'object') throw new Error('备份内容不是对象');
    const cfg = o.cfg && typeof o.cfg === 'object' ? o.cfg : o;
    if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.parts)) throw new Error('备份里找不到部位清单');
    const n = normCfg(cfg);
    const errs = validate(n);
    if (errs.length) throw new Error('备份内容校验失败：' + errs[0].msg);
    return n;
  }
  function toCsv(res) {
    if (!res || !res.ok) return '';
    const L = [];
    L.push(['出成率对账台', res.name].join(','));
    L.push(['毛重 kg', num(res.cfg.grossKg)].join(','));
    L.push(['毛重单价 元/kg', num(res.cfg.pricePerKg)].join(','));
    L.push(['处理成本 元', num(res.cfg.processCost)].join(','));
    L.push(['整只买价 元', res.kpis.boughtPrice].join(','));
    L.push(['到手总成本 元', res.kpis.totalCost].join(','));
    L.push(['分部位市值合计 元', res.kpis.marketValue].join(','));
    L.push(['折扣率 r', res.kpis.discountRate].join(','));
    L.push(['净料总重 kg', res.kpis.netKg].join(','));
    L.push(['不可食 kg', res.kpis.wasteKg].join(','));
    L.push(['净料单价 元/kg', res.kpis.netUnit].join(','));
    L.push(['结论', res.verdict.label].join(','));
    L.push('');
    L.push(['部位', '出成率%', '净重kg', '市价元/kg', '产值元', '产值占比%', '分摊成本元', '等效单价元/kg', '省(多付)元', '熟制率%', '熟重kg', '熟食成本元/kg', '成品熟食元/kg', '熟食省(多付)元/kg'].join(','));
    res.parts.forEach((p) => {
      L.push([p.name, p.yieldPct, round(p.w, 6), p.pricePerKg, round(p.v, 4), p.share === null ? '' : round(p.share * 100, 4),
        p.alloc === null ? '' : round(p.alloc, 4), p.allocUnit === null ? '' : round(p.allocUnit, 4),
        p.save === null ? '' : round(p.save, 4), p.cookPct, round(p.cookKg, 6),
        p.cookUnit === null ? '' : round(p.cookUnit, 4), p.cookedPricePerKg,
        p.cookSavePerKg === null ? '' : round(p.cookSavePerKg, 4)].join(','));
    });
    L.push('');
    L.push(['回本最少部位数', res.kpis.minCover === null ? '' : res.kpis.minCover].join(','));
    L.push(['盈亏平衡毛重单价 元/kg', res.rev.breakevenPrice === null ? '' : round(res.rev.breakevenPrice, 4)].join(','));
    L.push(['目标折扣率下毛重单价上限 元/kg', res.rev.targetCapPrice === null ? '' : round(res.rev.targetCapPrice, 4)].join(','));
    L.push(['折算时薪 元/h', res.rev.savedPerHour === null ? '' : round(res.rev.savedPerHour, 4)].join(','));
    L.push('');
    L.push(['结构自检', res.checkSummary.pass + '/' + res.checkSummary.total].join(','));
    L.push(['生成时间', new Date().toISOString()].join(','));
    return L.join('\n');
  }
  function toMd(res) {
    if (!res || !res.ok) return '';
    const L = [];
    L.push('# ' + NAME + ' · ' + res.name);
    L.push('');
    L.push('- 结论：**' + res.verdict.label + '**（' + res.verdict.note + '）');
    L.push('- 整只买价 ' + fmtMoney(res.kpis.boughtPrice) + '，处理成本 ' + fmtMoney(num(res.cfg.processCost)) + '，到手总成本 ' + fmtMoney(res.kpis.totalCost));
    L.push('- 分部位市值合计 ' + fmtMoney(res.kpis.marketValue) + '，折扣率 r = ' + fmtNum(res.kpis.discountRate, 4));
    L.push('- 净料 ' + fmtKg(res.kpis.netKg) + '（不可食 ' + fmtKg(res.kpis.wasteKg) + '），净料单价 ' + fmtUnit(res.kpis.netUnit));
    L.push('- 回本最少部位数 ' + (res.kpis.minCover === null ? '—' : res.kpis.minCover + ' 块'));
    L.push('');
    L.push('| 部位 | 出成率 | 净重 | 市价 | 产值 | 占比 | 分摊成本 | 等效单价 | 省(多付) | 熟重 | 熟食成本 | 成品熟食 | 熟食省(多付)/kg |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    res.parts.forEach((p) => L.push('| ' + p.name + ' | ' + fmtPct(p.yieldPct, 2) + ' | ' + fmtKg(p.w) + ' | ' + fmtUnit(p.pricePerKg) + ' | '
      + fmtMoney(p.v) + ' | ' + fmtPct((p.share || 0) * 100) + ' | ' + fmtMoney(p.alloc) + ' | ' + fmtUnit(p.allocUnit) + ' | '
      + fmtMoney(p.save) + ' | ' + fmtKg(p.cookKg) + ' | ' + fmtUnit(p.cookUnit) + ' | ' + fmtUnit(p.cookedPricePerKg) + ' | '
      + (p.cookSavePerKg === null ? '—' : fmtUnit(p.cookSavePerKg)) + ' |'));
    L.push('');
    L.push('## 要记住的几条');
    res.insights.forEach((x) => { L.push('- **' + x.t + '** ' + x.d); });
    L.push('');
    L.push('## 反推');
    L.push('- 盈亏平衡毛重单价（含处理成本）' + fmtUnit(res.rev.breakevenPrice) + '；不含处理成本 ' + fmtUnit(res.rev.breakevenPriceNoProcess));
    L.push('- 目标折扣率 ' + fmtPct(res.rev.targetDiscountPct, 0) + ' 下：买价上限 ' + fmtMoney(res.rev.targetCapTotal) + '，毛重单价上限 ' + fmtUnit(res.rev.targetCapPrice));
    L.push('- 折算时薪 ' + (res.rev.savedPerHour === null ? '—' : fmtNum(res.rev.savedPerHour, 2) + ' 元/h')
      + '（省 ' + fmtMoney(res.rev.saved) + ' ÷ ' + fmtNum(num(res.cfg.minutes), 0) + ' 分钟；你的时间价格 '
      + fmtNum(num(res.cfg.hourlyRate), 2) + ' 元/h）');
    L.push('');
    L.push('## 结构自检 ' + res.checkSummary.pass + '/' + res.checkSummary.total);
    res.checks.forEach((x) => L.push('- [' + (x.pass ? 'x' : ' ') + '] ' + x.name + (x.detail ? '（' + x.detail + '）' : '')));
    L.push('');
    L.push('> 生成时间 ' + new Date().toISOString() + '；价格与出成率全部来自你填的数字，页面不联网、不查行情。');
    return L.join('\n');
  }

  const api = {
    slug: SLUG, name: NAME, version: VERSION, PART_MAX, PART_MIN,
    defaults, defaultsClone, scenarios: SCENARIOS, scenarioCfg, normCfg, validate, analyze,
    sensitivity, insights, steps, selfChecks,
    backupJson, readBackup, toCsv, toMd,
    num, fmtNum, fmtMoney, fmtMoney0, fmtKg, fmtUnit, fmtPct, round, sum,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AppCore = api;
})();
