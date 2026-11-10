/* 出成率对账台 · 核心测试（node --test tests/core.test.cjs）
 *
 * 覆盖：独立锚点（Python decimal，另一套实现）、联合成本分摊恒等式、最小回本部位数与 2^n 穷举对拍、
 *       盈亏平衡价回代、临界熟制率闭式 vs 独立二分、单调性、单位换算、退化与边界、
 *       非法输入逐条核字段、输出契约、确定性、不修改入参、结构自检（默认 + 9 场景 + 300 组随机压力）、
 *       导出与备份往返、判定三档阈值两侧、常识与量纲独立检查。
 *
 * 「独立锚点」的来历：`make-anchors.py`（Python，decimal 精度 40 位，从零重算，不引用本文件任何代码）
 * 生成 evidence/默认锚点.json；它同时给了两条独立路径：穷举子集求最小回本部位数、二分法求临界熟制率。
 * 参考实现与工程实现对拍只能证明两边一致，所以另外单独核查了恒等式、量纲、边界与常识量级。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'core.js'));

const ANCHOR_PATH = path.join(__dirname, '..', '..', 'evidence', '默认锚点.json');
const ANCHORS = JSON.parse(fs.readFileSync(ANCHOR_PATH, 'utf8'));

const near = (a, b, tol, msg) => {
  const d = Math.abs(a - b);
  assert.ok(d <= tol, (msg || '') + ' |实际 ' + a + ' 期望 ' + b + ' 差 ' + d + ' 容差 ' + tol);
};
const rel = (a, b, tol, msg) => {
  const d = Math.abs(a - b) / Math.max(1e-12, Math.abs(b));
  assert.ok(d <= tol, (msg || '') + ' |实际 ' + a + ' 期望 ' + b + ' 相对差 ' + d + ' 容差 ' + tol);
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const an = (cfg) => {
  const r = C.analyze(cfg);
  assert.ok(r.ok, '应通过校验，实际报错：' + JSON.stringify(r.errors));
  return r;
};
const sc = (id) => {
  const hit = C.scenarios.filter((x) => x.id === id)[0];
  assert.ok(hit, '找不到场景 ' + id);
  return C.scenarioCfg(id);
};
const F = (s) => parseFloat(s);

/* 确定性伪随机（不用 Math.random，保证可复现） */
function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomCfg(rnd) {
  const n = 1 + Math.floor(rnd() * 6);
  let budget = 40 + Math.floor(rnd() * 60);   // 保证 Σ出成率 ≤ 100
  const parts = [];
  for (let i = 0; i < n; i++) {
    const y = i === n - 1 ? budget : Math.floor(rnd() * Math.max(1, budget / (n - i)));
    budget -= y;
    parts.push({
      name: '部位' + (i + 1),
      yieldPct: y,
      pricePerKg: rnd() < 0.08 ? 0 : Math.round(rnd() * 400 * 100) / 100,
      cookPct: rnd() < 0.06 ? 0.5 + Math.round(rnd() * 2990) / 10 : Math.round((30 + rnd() * 100) * 10) / 10,
      cookedPricePerKg: rnd() < 0.25 ? 0 : Math.round(rnd() * 500 * 100) / 100,
    });
  }
  return {
    name: '随机示例',
    grossKg: Math.round((0.05 + rnd() * 40) * 1000) / 1000,
    pricePerKg: Math.round((0.5 + rnd() * 300) * 100) / 100,
    processCost: Math.round(rnd() * 80 * 100) / 100,
    targetDiscountPct: 1 + Math.round(rnd() * 1990) / 10,
    minutes: Math.round(rnd() * 600),
    hourlyRate: Math.round(rnd() * 200 * 100) / 100,
    parts,
  };
}

/* ── 1. 默认场景：与 Python decimal 锚点逐项对拍 ── */
test('默认场景关键量对拍独立锚点（Python decimal）', () => {
  const a = ANCHORS.scenarios.duck;
  const r = an(C.defaults());
  rel(r.kpis.grossKg, F(a.gross), 1e-12);
  rel(r.kpis.boughtPrice, F(a.bought), 1e-12);
  rel(r.kpis.totalCost, F(a.total), 1e-12);
  rel(r.kpis.marketValue, F(a.market), 1e-12);
  rel(r.kpis.discountRate, F(a.discount), 1e-12, '折扣率');
  rel(r.kpis.netKg, F(a.net_kg), 1e-12, '净料总重');
  rel(r.kpis.wasteKg, F(a.waste_kg), 1e-12, '不可食');
  rel(r.kpis.netUnit, F(a.net_unit), 1e-12, '净料单价');
  rel(r.kpis.netUnitNoProcess, F(a.net_unit_no_proc), 1e-12, '不含处理成本净料单价');
  rel(r.kpis.weightedAvgPrice, F(a.weighted_avg_price), 1e-12, '加权平均市价');
  rel(r.kpis.saved, F(a.saved), 1e-12, '省下');
  rel(r.rev.savedPerHour, F(a.saved_per_hour), 1e-12, '折算时薪');
  rel(r.rev.breakevenPrice, F(a.breakeven_price), 1e-12, '盈亏平衡价');
  rel(r.rev.breakevenPriceNoProcess, F(a.breakeven_price_no_proc), 1e-12);
  rel(r.rev.targetCapTotal, F(a.target_cap_total), 1e-12);
  rel(r.rev.targetCapPrice, F(a.target_cap_price), 1e-12);
  assert.strictEqual(r.kpis.minCover, a.min_cover_prefix);
  assert.strictEqual(r.kpis.minCover, a.min_cover_subset, '前缀口径要与穷举口径一致');
  rel(r.kpis.coverShare, F(a.cover_share), 1e-12);
  rel(r.kpis.topShare, F(a.top_share), 1e-12);
  assert.strictEqual(r.verdict.id, 'whole');
  assert.strictEqual(r.kpis.wastePct.toFixed(10), (100 - 92).toFixed(10));
});

test('默认场景逐部位对拍独立锚点（含熟食与临界熟制率）', () => {
  const a = ANCHORS.scenarios.duck;
  const r = an(C.defaults());
  assert.strictEqual(r.parts.length, a.parts.length);
  r.parts.forEach((p, i) => {
    const q = a.parts[i];
    assert.strictEqual(p.name, q.name);
    rel(p.w, F(q.w), 1e-12, p.name + ' 净重');
    rel(p.v, F(q.v), 1e-12, p.name + ' 产值');
    rel(p.alloc, F(q.alloc), 1e-12, p.name + ' 分摊成本');
    rel(p.allocUnit, F(q.alloc_unit), 1e-12, p.name + ' 等效单价');
    rel(p.save, F(q.save), 1e-12, p.name + ' 省下');
    rel(p.cookKg, F(q.cook_kg), 1e-12, p.name + ' 熟重');
    if (q.cook_unit === null) assert.strictEqual(p.cookUnit, null);
    else rel(p.cookUnit, F(q.cook_unit), 1e-12, p.name + ' 熟食单价');
    if (q.cook_save_per_kg === null) assert.strictEqual(p.cookSavePerKg, null);
    else rel(p.cookSavePerKg, F(q.cook_save_per_kg), 1e-12, p.name + ' 熟食每公斤省');
    if (p.cookBreakEvenPct !== null) rel(p.cookBreakEvenPct, F(q.cook_be_closed), 1e-10, p.name + ' 临界熟制率');
  });
});

test('9 个内置场景全部通过校验、自检全过并与锚点一致', () => {
  C.scenarios.forEach((s) => {
    const a = ANCHORS.scenarios[s.id];
    assert.ok(a, '锚点里缺少场景 ' + s.id);
    const r = an(sc(s.id));
    assert.strictEqual(r.checkSummary.pass, r.checkSummary.total, s.id + ' 自检未全过');
    rel(r.kpis.discountRate, F(a.discount), 1e-12, s.id + ' 折扣率');
    rel(r.kpis.netUnit, F(a.net_unit), 1e-12, s.id + ' 净料单价');
    rel(r.kpis.saved, F(a.saved), 1e-12, s.id + ' 省下');
    if (a.min_cover_prefix === null) assert.strictEqual(r.kpis.minCover, null, s.id + ' 不该有回本部位数');
    else assert.strictEqual(r.kpis.minCover, a.min_cover_prefix, s.id + ' 回本部位数');
    assert.strictEqual(r.kpis.minCover, a.min_cover_subset, s.id + ' 前缀口径必须等于穷举口径');
    assert.ok(r.parts.every((p) => Number.isFinite(p.w) && Number.isFinite(p.v)), s.id + ' 出现非有限数');
    assert.ok(r.insights.length >= 2, s.id + ' 要点过少');
    assert.ok(r.steps.length >= 2, s.id + ' 下一步过少');
  });
  const ids = C.scenarios.map((s) => s.id);
  assert.strictEqual(new Set(ids).size, ids.length, '场景 id 不应重复');
  assert.strictEqual(ids.length, 9);
});

test('判定三档都有场景覆盖（整只更省 / 基本持平 / 分部位更省）', () => {
  const seen = {};
  C.scenarios.forEach((s) => { seen[an(sc(s.id)).verdict.id] = (seen[an(sc(s.id)).verdict.id] || 0) + 1; });
  assert.ok(seen.whole >= 1 && seen.even >= 1 && seen.parts >= 1, JSON.stringify(seen));
});

/* ── 2. 分摊恒等式与口径 ── */
test('联合成本分摊：合计等于总成本、等效单价 = r × 市价（默认 + 200 组随机）', () => {
  const rnd = mulberry(20261111);
  const cases = [C.defaults()];
  for (let i = 0; i < 200; i++) cases.push(randomCfg(rnd));
  cases.forEach((cfg, k) => {
    const r = an(cfg);
    const V = r.kpis.marketValue, Cc = r.kpis.totalCost;
    if (V === 0) { assert.ok(r.parts.every((p) => p.alloc === null), '第' + k + '组：市值为 0 时不该分摊'); return; }
    near(C.sum(r.parts.map((p) => p.alloc)), Cc, 1e-9 * Math.max(1, Cc), '第' + k + '组 分摊合计');
    near(C.sum(r.parts.map((p) => p.share)), 1, 1e-12, '第' + k + '组 占比合计');
    r.parts.forEach((p) => {
      if (p.allocUnit !== null) rel(p.allocUnit, r.kpis.discountRate * p.pricePerKg, 1e-12, '第' + k + '组 等效单价恒等式');
      near(p.save, p.v - p.alloc, 1e-9 * Math.max(1, Math.abs(p.v)), '第' + k + '组 省下');
    });
    rel(C.sum(r.parts.map((p) => p.save)), V - Cc, 1e-12, '第' + k + '组 省下合计');
  });
});

test('净料单价两条路径一致：C/净重 = r × 按净重加权平均市价', () => {
  const rnd = mulberry(777);
  const cases = [C.defaults()].concat(Array.from({ length: 150 }, () => randomCfg(rnd)));
  cases.forEach((cfg, k) => {
    const r = an(cfg);
    if (r.kpis.netKg <= 0 || r.kpis.marketValue === 0) return;
    rel(r.kpis.netUnit, r.kpis.discountRate * r.kpis.weightedAvgPrice, 1e-12, '第' + k + '组');
    rel(r.kpis.netUnit, r.kpis.totalCost / r.kpis.netKg, 1e-15, '第' + k + '组 定义式');
    assert.ok(r.kpis.netUnit >= r.kpis.netUnitNoProcess - 1e-12, '含处理成本的净料单价不该更低');
  });
});

/* ── 3. 最小回本部位数：与 2^n 穷举对拍 ── */
function bruteCover(values, cost) {
  const n = values.length;
  for (let k = 1; k <= n; k++) {
    const idx = [];
    const rec = (start, left) => {
      if (left === 0) {
        let s = 0;
        idx.forEach((i) => { s += values[i]; });
        return s >= cost - 1e-9;
      }
      for (let i = start; i <= n - left; i++) { idx.push(i); if (rec(i + 1, left - 1)) return true; idx.pop(); }
      return false;
    };
    if (rec(0, k)) return k;
  }
  return null;
}
test('最小回本部位数与前缀口径、与 2^n 穷举三边一致（默认 + 120 组随机）', () => {
  const rnd = mulberry(31415);
  const cases = [C.defaults()].concat(Array.from({ length: 120 }, () => randomCfg(rnd)));
  let compared = 0;
  cases.forEach((cfg, k) => {
    const r = an(cfg);
    const V = r.kpis.marketValue;
    if (V === 0 || r.parts.length > 10) return;
    const brute = bruteCover(r.parts.map((p) => p.v), r.kpis.totalCost);
    assert.strictEqual(r.kpis.minCover, brute, '第' + k + '组 前缀 vs 穷举');
    compared++;
    if (r.kpis.minCover !== null) {
      assert.ok(r.ranked[r.kpis.minCover - 1].cumV >= r.kpis.totalCost - 1e-9, '第' + k + '组 前 k 应够');
      if (r.kpis.minCover > 1) {
        assert.ok(r.ranked[r.kpis.minCover - 2].cumV < r.kpis.totalCost - 1e-9, '第' + k + '组 前 k−1 应不够');
      }
    }
    // 降序性：产值排序必须真的降序
    for (let i = 1; i < r.ranked.length; i++) {
      assert.ok(r.ranked[i - 1].v >= r.ranked[i].v - 1e-12, '第' + k + '组 排名未降序');
    }
  });
  assert.ok(compared > 100, '参与穷举对拍的组数太少：' + compared);
});

/* ── 4. 反推 ── */
test('盈亏平衡价回代后折扣率恰好为 1（默认 + 150 组随机）', () => {
  const rnd = mulberry(2718);
  const cases = [C.defaults()].concat(Array.from({ length: 150 }, () => randomCfg(rnd)));
  let n = 0;
  cases.forEach((cfg, k) => {
    const r = an(cfg);
    const be = r.rev.breakevenPrice;
    if (be === null || !(be > 0)) return;
    const back = an(Object.assign({}, cfg, { pricePerKg: be }));
    rel(back.kpis.discountRate, 1, 1e-12, '第' + k + '组 回代');
    rel(back.kpis.marketValue, r.kpis.marketValue, 1e-12, '第' + k + '组 市值不该变');
    n++;
  });
  assert.ok(n > 100, '回代样本太少：' + n);
});

test('临界熟制率：闭式与独立二分一致，且回代等于成品熟食市价', () => {
  const rnd = mulberry(555);
  const cases = [C.defaults()].concat(Array.from({ length: 150 }, () => randomCfg(rnd)));
  let n = 0;
  cases.forEach((cfg, k) => {
    const r = an(cfg);
    r.parts.forEach((p) => {
      if (p.cookBreakEvenPct === null) return;
      // 独立二分：解 alloc_熟 = q，其中 alloc_熟 = alloc / (w·z)；上界随闭式值放宽（可能远超 300%）
      let lo = 1e-12, hi = Math.max(3, p.cookBreakEvenPct / 100 * 2);
      for (let it = 0; it < 200; it++) {
        const mid = (lo + hi) / 2;
        if (p.alloc / (p.w * mid) > p.cookedPricePerKg) lo = mid; else hi = mid;
      }
      const z = (lo + hi) / 2;
      rel(p.cookBreakEvenPct, z * 100, 1e-6, '第' + k + '组 ' + p.name + ' 临界熟制率');
      rel(p.alloc / (p.w * p.cookBreakEvenPct / 100), p.cookedPricePerKg, 1e-9, '第' + k + '组 ' + p.name + ' 回代');
      n++;
    });
  });
  assert.ok(n > 100, '临界熟制率样本太少：' + n);
});

test('熟食判定与差值符号一致，且熟制率越大熟食单价越低', () => {
  const r = an(C.defaults());
  r.parts.forEach((p) => {
    if (p.cookSavePerKg === null) { assert.strictEqual(p.cookVerdict, 'none'); return; }
    if (p.cookSavePerKg > 0) assert.strictEqual(p.cookVerdict, 'cheaper');
    if (p.cookSavePerKg < 0) assert.strictEqual(p.cookVerdict, 'dearer');
  });
  const cfg = C.defaults();
  cfg.parts[0].cookPct = 60;
  const a = an(cfg);
  cfg.parts[0].cookPct = 90;
  const b = an(cfg);
  assert.ok(b.parts[0].cookUnit < a.parts[0].cookUnit, '熟制率越高，熟食单价应越低');
  assert.ok(b.parts[0].cookKg > a.parts[0].cookKg, '熟重应随熟制率上升');
});

/* ── 5. 单调性与量纲 ── */
test('毛重单价升高折扣率不降；分部位市价升高折扣率不升（随机 200 组）', () => {
  const rnd = mulberry(999);
  for (let i = 0; i < 200; i++) {
    const cfg = randomCfg(rnd);
    const base = an(cfg);
    if (base.kpis.discountRate === null) continue;
    const up = an(Object.assign({}, cfg, { pricePerKg: C.num(cfg.pricePerKg) * 1.3 + 0.01 }));
    assert.ok(up.kpis.discountRate >= base.kpis.discountRate - 1e-12, '第' + i + '组 毛重单价↑ 折扣率不该降');
    const p2 = clone(cfg);
    p2.parts.forEach((p) => { p.pricePerKg = C.num(p.pricePerKg) + 5; });
    const v2 = an(p2);
    assert.ok(v2.kpis.discountRate <= base.kpis.discountRate + 1e-12, '第' + i + '组 市价↑ 折扣率不该升');
    if (C.num(cfg.processCost) === 0) {
      const big = an(Object.assign({}, cfg, { grossKg: C.num(cfg.grossKg) * 3 }));
      rel(big.kpis.discountRate, base.kpis.discountRate, 1e-12, '第' + i + '组 处理成本为 0 时折扣率与毛重无关');
    }
  }
});

test('单位换算：毛重按克、单价按元/克，账不变（换算前后 12 个量一致）', () => {
  const r = an(C.defaults());
  const cfg = C.defaults();
  const g = clone(cfg);
  g.grossKg = C.num(cfg.grossKg) * 1000;           // 公斤 → 克
  g.pricePerKg = C.num(cfg.pricePerKg) / 1000;      // 元/kg → 元/g
  g.parts.forEach((p) => { p.pricePerKg = C.num(p.pricePerKg) / 1000; p.cookedPricePerKg = C.num(p.cookedPricePerKg) / 1000; });
  const q = an(g);
  rel(q.kpis.boughtPrice, r.kpis.boughtPrice, 1e-9, '整只买价');
  rel(q.kpis.totalCost, r.kpis.totalCost, 1e-9, '到手总成本');
  rel(q.kpis.marketValue, r.kpis.marketValue, 1e-9, '市值');
  rel(q.kpis.discountRate, r.kpis.discountRate, 1e-12, '折扣率');
  rel(q.kpis.saved, r.kpis.saved, 1e-9, '省下');
  rel(q.kpis.netKg, r.kpis.netKg * 1000, 1e-9, '净重应随单位放大 1000 倍');
  rel(q.kpis.netUnit, r.kpis.netUnit / 1000, 1e-9, '净料单价应随单位缩小 1000 倍');
  q.parts.forEach((p, i) => {
    // 这次换算把「公斤」当成「克单位」：单价随之缩小 1000 倍，所以每公斤单价也缩小 1000 倍，
    // 但金额、折扣率与「等效单价 ÷ 市价」的比率必须不变。
    rel(p.allocUnit, r.parts[i].allocUnit / 1000, 1e-9, p.name + ' 等效单价应随单位缩小 1000 倍');
    rel(p.alloc / p.w, p.allocUnit, 1e-12, p.name + ' 等效单价定义式');
    rel(p.allocUnit / p.pricePerKg, r.parts[i].allocUnit / r.parts[i].pricePerKg, 1e-12, p.name + ' 等效单价 ÷ 市价 = r');
    if (r.parts[i].cookUnit !== null) rel(p.cookUnit, r.parts[i].cookUnit / 1000, 1e-9, p.name + ' 熟食单价');
    rel(p.alloc, r.parts[i].alloc, 1e-9, p.name + ' 分摊金额');
  });
  assert.strictEqual(q.verdict.id, r.verdict.id);
});

/* ── 6. 退化、边界与非法输入 ── */
test('出成率合计 = 100 时不可食为 0，且不影响其余口径', () => {
  const cfg = sc('zerowaste');
  const r = an(cfg);
  near(r.sumY, 100, 1e-12);
  near(r.kpis.wasteKg, 0, 1e-12);
  near(r.kpis.netKg, C.num(cfg.grossKg), 1e-12);
});

test('出成率合计超过 100 与等于 0 都被拦下，且报错里带超出量', () => {
  const over = C.defaults();
  over.parts[0].yieldPct = 60;   // 合计 92 → 126
  const e1 = C.validate(over);
  const hit = e1.filter((x) => x.label === '出成率合计')[0];
  assert.ok(hit, '应报出成率合计错误');
  assert.ok(/26\.00%/.test(hit.msg), '报错应写清超出量：' + hit.msg);
  const zero = C.defaults();
  zero.parts.forEach((p) => { p.yieldPct = 0; });
  const e2 = C.validate(zero);
  assert.ok(e2.some((x) => /没有净料/.test(x.msg)), '应报「没有净料」：' + JSON.stringify(e2));
  assert.strictEqual(C.analyze(zero).ok, false);
});

test('非法输入逐条核字段（20 类）', () => {
  const cases = [
    ['grossKg', -1], ['grossKg', 0], ['grossKg', 1e9], ['grossKg', 'abc'], ['grossKg', ''],
    ['pricePerKg', 0], ['pricePerKg', -5], ['pricePerKg', 1e9],
    ['processCost', -1], ['processCost', 1e9],
    ['targetDiscountPct', 0], ['targetDiscountPct', 300],
    ['minutes', -1], ['minutes', 1e6],
    ['hourlyRate', -1], ['hourlyRate', 1e9],
  ];
  cases.forEach(([k, v]) => {
    const cfg = C.defaults();
    cfg[k] = v;
    const errs = C.validate(cfg);
    assert.ok(errs.some((e) => e.field === k), '字段 ' + k + '=' + JSON.stringify(v) + ' 应报错，实际 ' + JSON.stringify(errs));
    assert.strictEqual(C.analyze(cfg).ok, false, k + ' 不该通过 analyze');
  });
  const partCases = [
    ['yieldPct', -1], ['yieldPct', 101], ['yieldPct', 'x'],
    ['pricePerKg', -1], ['pricePerKg', 1e9],
    ['cookPct', 0], ['cookPct', -3], ['cookPct', 301],
    ['cookedPricePerKg', -1], ['cookedPricePerKg', 1e9],
  ];
  partCases.forEach(([k, v]) => {
    const cfg = C.defaults();
    cfg.parts[1][k] = v;
    const errs = C.validate(cfg);
    assert.ok(errs.some((e) => e.field === 'p-' + k + '-1'), '第 2 行 ' + k + '=' + JSON.stringify(v) + ' 应报错，实际 ' + JSON.stringify(errs.map((e) => e.field)));
  });
  const none = C.defaults();
  none.parts = [];
  assert.ok(C.validate(none).some((e) => e.field === 'parts'), '空清单应报错');
  const many = C.defaults();
  many.parts = Array.from({ length: 13 }, (_, i) => ({ name: 'p' + i, yieldPct: 1, pricePerKg: 1, cookPct: 100, cookedPricePerKg: 0 }));
  assert.ok(C.validate(many).some((e) => /最多 12/.test(e.msg)), '超过 12 个部位应报错');
});

test('合法边界值全部通过：Σ=100、Σ→0+、零市价、极大毛重与价格、目标 1% 与 200%', () => {
  const edge = [
    () => { const c = sc('zerowaste'); return c; },
    () => { const c = C.defaults(); c.parts.forEach((p, i) => { p.yieldPct = i === 0 ? 1e-6 : 0; }); return c; },
    () => { const c = C.defaults(); c.parts.forEach((p) => { p.pricePerKg = 0; }); return c; },
    () => { const c = C.defaults(); c.parts.forEach((p) => { p.cookedPricePerKg = 0; }); return c; },
    () => { const c = C.defaults(); c.grossKg = 100000; c.pricePerKg = 1e6; return c; },
    () => { const c = C.defaults(); c.targetDiscountPct = 1; return c; },
    () => { const c = C.defaults(); c.targetDiscountPct = 200; return c; },
    () => { const c = C.defaults(); c.minutes = 0; c.hourlyRate = 0; c.processCost = 0; return c; },
    () => { const c = C.defaults(); c.parts[0].cookPct = 300; return c; },
  ];
  edge.forEach((mk, i) => {
    const cfg = mk();
    const errs = C.validate(cfg);
    assert.strictEqual(errs.length, 0, '边界 ' + i + ' 不该报错：' + JSON.stringify(errs));
    const r = an(cfg);
    assert.strictEqual(r.checkSummary.pass, r.checkSummary.total, '边界 ' + i + ' 自检未全过');
  });
});

test('所有市价为 0：折扣率记 null、不给分摊与回本部位数，且页面不出现 NaN', () => {
  const cfg = C.defaults();
  cfg.parts.forEach((p) => { p.pricePerKg = 0; });
  const r = an(cfg);
  assert.strictEqual(r.kpis.discountRate, null);
  assert.strictEqual(r.kpis.marketValue, 0);
  assert.strictEqual(r.kpis.minCover, null);
  assert.strictEqual(r.verdict.id, 'none');
  assert.ok(r.parts.every((p) => p.alloc === null && p.allocUnit === null && p.save === null));
  assert.ok(r.parts.every((p) => p.share === null));
  assert.ok(r.insights.every((x) => !/NaN|Infinity|undefined/.test(x.t + x.d)));
});

test('处理成本高于市值时分部位更省，且盈亏平衡价为负（如实给出，不硬凑）', () => {
  const cfg = C.defaults();
  cfg.processCost = 200;      // 61 → 255，远高于市值 95.5
  const r = an(cfg);
  assert.strictEqual(r.verdict.id, 'parts');
  assert.ok(r.rev.breakevenPrice < 0, '盈亏平衡价应为负：' + r.rev.breakevenPrice);
  assert.ok(r.kpis.minCover === null, '覆盖不了时不该给最小部位数');
  assert.ok(r.steps.length >= 2);
});

test('判定三档阈值两侧（0.97 / 1.03）按构造精确落在两侧', () => {
  const mk = (targetR) => {
    const cfg = C.defaults();
    const V = C.sum(cfg.parts.map((p) => C.num(p.yieldPct) * C.num(p.pricePerKg) * C.num(cfg.grossKg) / 100));
    cfg.pricePerKg = (targetR * V - C.num(cfg.processCost)) / C.num(cfg.grossKg);
    return cfg;
  };
  [0.96, 0.9699].forEach((x) => assert.strictEqual(an(mk(x)).verdict.id, 'whole', 'r=' + x));
  [0.97, 1, 1.03].forEach((x) => assert.strictEqual(an(mk(x)).verdict.id, 'even', 'r=' + x));
  [1.0301, 1.2].forEach((x) => assert.strictEqual(an(mk(x)).verdict.id, 'parts', 'r=' + x));
});

/* ── 7. 输出契约、确定性、不修改入参 ── */
test('输出契约：必需字段存在、类型正确、部位字段齐全', () => {
  const r = an(C.defaults());
  ['ok', 'slug', 'version', 'cfg', 'verdict', 'kpis', 'parts', 'ranked', 'rev', 'insights', 'steps', 'checks', 'checkSummary']
    .forEach((k) => assert.ok(k in r, '缺少字段 ' + k));
  assert.strictEqual(r.slug, 'yield-ledger');
  assert.strictEqual(r.version, C.version);
  ['grossKg', 'boughtPrice', 'totalCost', 'marketValue', 'discountRate', 'netKg', 'wasteKg', 'netUnit', 'saved', 'minCover']
    .forEach((k) => assert.ok(k in r.kpis, 'kpis 缺 ' + k));
  ['breakevenPrice', 'breakevenPriceNoProcess', 'targetCapTotal', 'targetCapPrice', 'targetOk', 'singleCover', 'oneOnly', 'savedPerHour']
    .forEach((k) => assert.ok(k in r.rev, 'rev 缺 ' + k));
  assert.strictEqual(r.rev.singleCover.length, r.parts.length);
  assert.strictEqual(r.rev.oneOnly.length, r.parts.length);
  r.parts.forEach((p) => {
    ['i', 'name', 'yieldPct', 'pricePerKg', 'cookPct', 'cookedPricePerKg', 'w', 'v', 'share', 'alloc', 'allocUnit', 'save', 'cookKg', 'cookUnit', 'cookSavePerKg', 'cookBreakEvenPct', 'cookVerdict']
      .forEach((k) => assert.ok(k in p, '部位缺字段 ' + k));
    assert.ok(Number.isFinite(p.w) && p.w >= 0);
    assert.ok(Number.isFinite(p.allocUnit));
  });
  assert.strictEqual(r.verdict.id !== undefined, true);
  ['id', 'label', 'note'].forEach((k) => assert.ok(r.verdict[k], 'verdict 缺 ' + k));
  r.checks.forEach((c) => { assert.strictEqual(typeof c.name, 'string'); assert.strictEqual(typeof c.pass, 'boolean'); });
});

test('确定性：同输入两次结果一致（含自检与要点）', () => {
  const cfg = C.defaults();
  const a = JSON.stringify(an(cfg));
  const b = JSON.stringify(an(clone(cfg)));
  assert.strictEqual(a, b);
});

test('不修改入参：analyze / sensitivity 前后传入对象逐字节相同', () => {
  const cfg = C.defaults();
  cfg.extra = { keep: 1 };
  const before = JSON.stringify(cfg);
  an(cfg);
  C.sensitivity(cfg);
  assert.strictEqual(JSON.stringify(cfg), before);
});

/* ── 8. 结构自检与随机压力 ── */
test('结构自检在默认与 9 个场景下全过', () => {
  const r = an(C.defaults());
  assert.strictEqual(r.checks.length, 17);
  assert.strictEqual(r.checkSummary.pass, 17);
  r.checks.forEach((c) => assert.ok(c.pass, '自检未过：' + c.name));
  C.scenarios.forEach((s) => {
    const x = an(sc(s.id));
    assert.strictEqual(x.checkSummary.pass, x.checkSummary.total, s.id + '：' + JSON.stringify(x.checks.filter((c) => !c.pass)));
  });
});

test('结构自检项数恒定：市值为 0 与市值正常时都是 17 项', () => {
  const zero = C.defaults();
  zero.parts.forEach((p) => { p.pricePerKg = 0; });
  assert.strictEqual(an(zero).checks.length, 17, '市值为 0 时也应是 17 项');
  assert.strictEqual(an(C.defaults()).checks.length, 17);
  assert.strictEqual(an(zero).checkSummary.pass, 17);
});

test('随机压力：300 组合法输入下 17 项自检全过、无 NaN/Infinity、不抛异常', () => {
  const rnd = mulberry(2026111102);
  let cases = 0, checks = 0;
  for (let i = 0; i < 300; i++) {
    const cfg = randomCfg(rnd);
    const errs = C.validate(cfg);
    if (errs.length) continue;   // 随机生成也可能非法，跳过（非法路径另有专门测试）
    const r = C.analyze(cfg);
    assert.ok(r.ok, '第' + i + '组应通过');
    assert.strictEqual(r.checkSummary.pass, r.checkSummary.total,
      '第' + i + '组自检失败：' + JSON.stringify(r.checks.filter((c) => !c.pass)));
    const flat = JSON.stringify(r, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? 'NONFINITE' : v));
    assert.ok(!/NONFINITE/.test(flat), '第' + i + '组出现非有限数');
    assert.ok(!/NaN/.test(flat.replace(/"name":"[^"]*"/g, '')), '第' + i + '组出现 NaN');
    cases++; checks += r.checks.length;
  }
  assert.ok(cases > 250, '合法样本太少：' + cases);
  assert.ok(checks > 4000, '累计断言太少：' + checks);
});

test('敏感性：10 行、每行都真的重算（与独立 analyze 结果逐位一致）', () => {
  const cfg = C.defaults();
  const rows = C.sensitivity(cfg);
  assert.strictEqual(rows.length, 10);
  rows.forEach((x) => { assert.ok(x.label); assert.ok(x.discountRate !== undefined); });
  const up = cfg;
  const p2 = clone(up);
  p2.pricePerKg = C.num(up.pricePerKg) * 1.1;
  rel(rows[0].discountRate, an(p2).kpis.discountRate, 1e-15, '「毛重单价 +10%」应等于独立重算');
  const p3 = clone(up);
  p3.processCost = 0;
  rel(rows[3].discountRate, an(p3).kpis.discountRate, 1e-15, '「处理成本归零」应等于独立重算');
  assert.strictEqual(rows[5].ok, false, '出成率 ×1.1 在默认下应超过 100% 而被拦下');
  assert.strictEqual(rows[5].verdict, '输入不合法');
});

/* ── 9. 导出、备份与格式化 ── */
test('CSV / Markdown 导出含关键字段且行数正确', () => {
  const r = an(C.defaults());
  const csv = C.toCsv(r);
  const lines = csv.trim().split('\n');
  assert.ok(lines[0].indexOf('出成率对账台') === 0);
  assert.strictEqual(lines.filter((l) => l.indexOf('鸭胸,') === 0).length, 1);
  assert.ok(lines.some((l) => l.indexOf('折扣率 r,') === 0));
  assert.ok(lines.some((l) => l.indexOf('净料单价 元/kg,') === 0));
  assert.ok(lines[lines.length - 1].indexOf('生成时间,') === 0);
  assert.strictEqual(lines.filter((l) => /^(鸭胸|鸭腿|鸭翅|鸭头脖|鸭架|鸭油鸭皮),/.test(l)).length, 6);
  const md = C.toMd(r);
  assert.ok(md.indexOf('# 出成率对账台 · ') === 0);
  assert.ok(md.indexOf('结构自检 17/17') > 0);
  assert.strictEqual((md.match(/\n\| 鸭/g) || []).length, 6);
  assert.ok(md.indexOf('盈亏平衡毛重单价') > 0);
  assert.strictEqual(C.toCsv({ ok: false }), '');
  assert.strictEqual(C.toMd({ ok: false }), '');
});

test('备份往返：backupJson → readBackup 得到等价配置；坏备份被拒', () => {
  const cfg = C.defaults();
  const back = C.readBackup(C.backupJson(cfg));
  assert.strictEqual(JSON.stringify(back), JSON.stringify(C.normCfg(cfg)));
  assert.strictEqual(JSON.stringify(an(back).kpis), JSON.stringify(an(cfg).kpis));
  assert.strictEqual(JSON.stringify(C.readBackup(JSON.stringify(cfg))), JSON.stringify(C.normCfg(cfg)), '裸配置也应接受');
  assert.throws(() => C.readBackup('{not json'), /JSON/);
  assert.throws(() => C.readBackup('[]'), /对象|清单/);
  assert.throws(() => C.readBackup('{"cfg":{}}'), /清单/);
  const bad = C.defaults();
  bad.parts.forEach((p) => { p.yieldPct = 50; });
  assert.throws(() => C.readBackup(JSON.stringify(bad)), /校验失败/);
});

test('格式化：极小非零值标量级、负数、千分位、非有限值给占位符', () => {
  assert.strictEqual(C.fmtNum(0.0001, 2), '< 0.01');
  assert.strictEqual(C.fmtNum(-0.0001, 2), '< 0.01');
  assert.ok(/^-?1,?234\.50$/.test(C.fmtNum(1234.5, 2)));
  assert.strictEqual(C.fmtNum(NaN), '—');
  assert.strictEqual(C.fmtMoney(null), '—');
  assert.strictEqual(C.fmtPct(0.05), '0.1%');
  assert.strictEqual(C.fmtKg(0.65), '0.650 kg');
  assert.strictEqual(C.fmtUnit(35.8), '35.80 元/kg');
  assert.strictEqual(C.num('１２３'), 123, '全角数字应能解析');
  assert.strictEqual(C.num('1,234.5'), 1234.5, '千分位应能解析');
  assert.strictEqual(C.num('  46  '), 46);
  assert.strictEqual(C.num('4 6'), 46, '内部空白按粘贴习惯去掉');
  assert.ok(Number.isNaN(C.num('abc')));
  assert.strictEqual(C.num('−3'), -3, 'Unicode 减号应能解析');
});

test('常识与量纲独立检查（不依赖被测实现的恒等式）', () => {
  const r = an(C.defaults());
  // 1) 净料单价 ≥ 毛重单价：因为不可食与处理成本都摊在净料上
  assert.ok(r.kpis.netUnit >= C.num(r.cfg.pricePerKg), '净料单价不该低于毛重单价');
  // 2) 净料单价 = 折扣率 × 加权平均市价 ≤ 加权平均市价（r ≤ 1 时）
  assert.ok(r.kpis.netUnit <= r.kpis.weightedAvgPrice + 1e-12);
  // 3) 净重 + 不可食 = 毛重；净重 ≤ 毛重
  near(r.kpis.netKg + r.kpis.wasteKg, C.num(r.cfg.grossKg), 1e-12);
  assert.ok(r.kpis.netKg <= C.num(r.cfg.grossKg) + 1e-12);
  // 4) 分部位市值合计 = Σ 净重 × 市价（直接加，不用引擎的中间量）
  const V = r.parts.reduce((s, p) => s + p.w * p.pricePerKg, 0);
  rel(r.kpis.marketValue, V, 1e-12);
  // 5) 折扣率量级：整只 55 元买 2.3 kg 净料，均价 41.52 元/kg 的市值 → 0.63 左右
  assert.ok(r.kpis.discountRate > 0.6 && r.kpis.discountRate < 0.67, '折扣率量级应可复核');
  // 6) 回本部位数：前 k 块产值合计必须 ≥ 到手成本
  assert.ok(r.ranked[r.kpis.minCover - 1].cumV >= r.kpis.totalCost - 1e-9);
});
