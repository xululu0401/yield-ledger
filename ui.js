/* 出成率对账台 · ui.js
 * 界面：读输入 → AppCore.analyze → 渲染结论/KPI/产值图/要点/下一步/反推/两张表/敏感性/自检
 * 交互：输入即时重算、加删部位、内置场景、本机保存与读取、导入备份、四种导出（CSV/MD/JSON/PNG 结果卡）
 * 口径：所有展示数字都来自同一次 analyze 的结果；PNG 结果卡用 canvas 画，自底向上排版避免叠字。
 */
(function () {
  'use strict';
  const C = window.AppCore;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const STORE_KEY = 'yield-ledger:v1';
  const FONT = '-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';

  const state = { res: null, renders: 0, exports: 0, lastBad: [] };

  /* ── 读输入 ─────────────────────────────────────── */
  function readCfg() {
    const parts = [];
    document.querySelectorAll('#parts .item').forEach((it, i) => {
      const val = (k) => {
        const el = it.querySelector('[data-k="' + k + '"]');
        return el ? el.value : '';
      };
      parts.push({
        name: val('name'),
        yieldPct: val('yieldPct'),
        pricePerKg: val('pricePerKg'),
        cookPct: val('cookPct'),
        cookedPricePerKg: val('cookedPricePerKg'),
      });
    });
    return {
      name: $('g-name').value,
      grossKg: $('g-grossKg').value,
      pricePerKg: $('g-pricePerKg').value,
      processCost: $('g-processCost').value,
      targetDiscountPct: $('g-targetDiscountPct').value,
      minutes: $('g-minutes').value,
      hourlyRate: $('g-hourlyRate').value,
      parts,
    };
  }

  /* ── 渲染部位输入行 ─────────────────────────────── */
  function partRow(p, i) {
    const num = (v) => (v === null || v === undefined ? '' : String(v));
    return '<div class="item" data-part="' + i + '">'
      + '<div class="itemhead"><span class="idx">第 ' + (i + 1) + ' 块</span>'
      + '<input type="text" data-k="name" maxlength="24" value="' + esc(p.name) + '" aria-label="部位名称">'
      + '<button type="button" class="tiny" data-del="' + i + '" title="删除这一块">删</button></div>'
      + '<div class="gridp">'
      + '<label>出成率 %（占毛重）<input type="text" data-k="yieldPct" value="' + esc(num(p.yieldPct)) + '"></label>'
      + '<label>这块的市价 元/kg<input type="text" data-k="pricePerKg" value="' + esc(num(p.pricePerKg)) + '"></label>'
      + '<label>熟制率 %（做熟后剩）<input type="text" data-k="cookPct" value="' + esc(num(p.cookPct)) + '"></label>'
      + '<label>成品熟食 元/kg<input type="text" data-k="cookedPricePerKg" value="' + esc(num(p.cookedPricePerKg)) + '"></label>'
      + '</div></div>';
  }
  function renderParts(parts) {
    $('parts').innerHTML = parts.map(partRow).join('');
    $('partCount').textContent = parts.length + ' / ' + C.PART_MAX + ' 块';
  }
  function fillCfg(cfg) {
    const c = C.normCfg(cfg);
    $('g-name').value = c.name;
    $('g-grossKg').value = String(c.grossKg);
    $('g-pricePerKg').value = String(c.pricePerKg);
    $('g-processCost').value = String(c.processCost);
    $('g-targetDiscountPct').value = String(c.targetDiscountPct);
    $('g-minutes').value = String(c.minutes);
    $('g-hourlyRate').value = String(c.hourlyRate);
    renderParts(c.parts.length ? c.parts : C.defaults().parts);
  }

  /* ── 计算与渲染 ─────────────────────────────────── */
  function compute() {
    const cfg = readCfg();
    const res = C.analyze(cfg);
    state.res = res;
    state.renders++;
    if (!res.ok) { renderErrors(res); return; }
    renderErrors({ ok: true, errors: [] });
    renderAll(res);
  }

  function renderErrors(res) {
    const box = $('errBox');
    document.querySelectorAll('input.bad').forEach((el) => el.classList.remove('bad'));
    if (res.ok) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="errbox"><b>先把这几处改对</b><ul>'
      + res.errors.map((e) => '<li>' + esc(e.msg) + '</li>').join('') + '</ul></div>';
    res.errors.forEach((e) => {
      let target = null;
      if (e.field && e.field.indexOf('p-') === 0) {
        const bits = e.field.split('-');       // p-<key>-<index>
        target = document.querySelector('#parts .item[data-part="' + bits[2] + '"] [data-k="' + bits[1] + '"]');
      } else if (e.field && e.field !== 'parts') {
        target = $('g-' + e.field);
      }
      if (target) target.classList.add('bad');
    });
    $('resultCard').style.opacity = '.45';
  }

  const pillClass = (id) => (id === 'whole' ? 'ok' : (id === 'even' ? 'tight' : (id === 'parts' ? 'bad' : 'tight')));

  function renderAll(res) {
    $('resultCard').style.opacity = '1';
    const k = res.kpis;
    $('verdictPill').innerHTML = '<span class="pill ' + pillClass(res.verdict.id) + '">' + esc(res.verdict.label) + '</span>';
    $('verdictDetail').innerHTML = [
      ['这本账怎么算的', '到手总成本 ' + esc(C.fmtMoney(k.totalCost)) + ' ÷ 分部位市值合计 ' + esc(C.fmtMoney(k.marketValue))
        + ' = 折扣率 ' + esc(C.fmtNum(k.discountRate, 4))],
      ['结论', esc(res.verdict.note)],
      ['净料口径', '毛重 ' + esc(C.fmtKg(k.grossKg)) + ' 里有 ' + esc(C.fmtKg(k.wasteKg)) + '（' + esc(C.fmtPct(res.wastePct, 2))
        + '）不可食，净料 ' + esc(C.fmtKg(k.netKg)) + '，净料单价 ' + esc(C.fmtUnit(k.netUnit))],
      ['回本部位数', k.minCover === null ? '分部位市值合计都盖不住到手成本，没有任何组合能回本'
        : '按产值降序，用掉前 ' + k.minCover + ' 块（' + esc(res.ranked.slice(0, k.minCover).map((p) => p.name).join(' + '))
          + '）就覆盖到手成本，这 ' + k.minCover + ' 块占市值 ' + esc(C.fmtPct((k.coverShare || 0) * 100))],
    ].map(([a, b]) => '<span class="k">' + esc(a) + '</span><span class="v">' + b + '</span>').join('');

    $('kpis').innerHTML = [
      ['整只买价', C.fmtMoney0(k.boughtPrice) + ' 元', '毛重 × 毛重单价'],
      ['到手总成本', C.fmtMoney0(k.totalCost) + ' 元', '含处理成本 ' + C.fmtMoney0(C.num(res.cfg.processCost)) + ' 元'],
      ['分部位市值', C.fmtMoney0(k.marketValue) + ' 元', '按你填的市价合计'],
      ['折扣率 r', C.fmtNum(k.discountRate, 4), '成本 ÷ 市值，< 1 即划算'],
      ['省下（多付）', C.fmtMoney0(k.saved) + ' 元', k.saved >= 0 ? '相对按市价买分部位' : '买整只反而多花的'],
      ['净料总重', C.fmtNum(k.netKg, 3) + ' kg', '不可食 ' + C.fmtNum(k.wasteKg, 3) + ' kg'],
      ['净料单价', C.fmtMoney0(k.netUnit) + ' 元/kg', '到手成本 ÷ 净料重'],
      ['回本部位数', k.minCover === null ? '做不到' : k.minCover + ' 块', k.minCover === null ? '市值盖不住成本' : '前 ' + k.minCover + ' 块覆盖成本'],
    ].map(([a, b, c]) => '<div class="kpi"><div class="lab">' + esc(a) + '</div><div class="val">' + esc(b) + '</div><div class="note">' + esc(c) + '</div></div>').join('');
    $('baselineNote').innerHTML = '整只买价与分部位市价都是<b>你填的数字</b>（默认来自虚构示例，不是行情）；'
      + '本页不联网、不查价、不预测涨跌。净料单价 ' + esc(C.fmtUnit(k.netUnit)) + ' 是把不可食与处理成本都摊到净料上的口径。';
    $('grossTag').textContent = '毛重 ' + C.fmtNum(k.grossKg, 3) + ' kg';
    $('boughtTxt').textContent = C.fmtMoney(k.boughtPrice);
    $('costTxt').textContent = C.fmtMoney(k.totalCost);

    // 部位合计
    $('yieldTotal').textContent = C.fmtPct(res.sumY, 2);
    $('yieldTotal').className = res.sumY > 100 ? 'bad' : '';
    $('wasteTxt').textContent = C.fmtPct(res.wastePct, 2) + '（' + C.fmtKg(k.wasteKg) + '）';
    const gap = 100 - res.sumY;
    $('yieldGap').innerHTML = gap >= 0
      ? '——剩下的 ' + esc(C.fmtPct(gap, 2)) + ' 按不可食算'
      : '<b>超出 100%：' + esc(C.fmtPct(-gap, 2)) + '</b>';

    renderChart(res);
    $('insights').innerHTML = res.insights.map((x) => '<li><b>' + esc(x.t) + '</b><span>' + esc(x.d) + '</span></li>').join('');
    renderSteps(res);
    renderRev(res);
    renderPartsTable(res);
    renderCookTable(res);
    renderSens(res);
    renderChecks(res);
    $('chartTag').textContent = res.ranked.length + ' 块 · 成本线在 ' + C.fmtPct((k.discountRate || 0) * 100) + ' 处';
  }

  function renderSteps(res) {
    $('steps').innerHTML = res.steps.map((s, i) => {
      const btn = s.apply
        ? '<button class="tiny" data-apply="' + esc(s.apply) + '" data-val="' + esc(s.val) + '" style="margin-top:6px">' + esc(s.btn || '按这个数改输入') + '</button>'
        : '';
      return '<li data-step="' + i + '"><b>' + esc(s.t) + '</b>' + (s.d ? '<span>' + esc(s.d) + '</span>' : '') + btn + '</li>';
    }).join('');
  }

  function renderRev(res) {
    const k = res.kpis;
    $('revTag').textContent = k.discountRate === null ? '不可反推' : 'r = ' + C.fmtNum(k.discountRate, 3);
    if (k.discountRate === null) {
      $('revBox').innerHTML = '<div class="warnbox">分部位市价合计是 0，没有可比的市场口径，反推不成立。至少给一块填一个大于 0 的市价。</div>';
      return;
    }
    const rows = res.rev.singleCover.map((s, i) => {
      const p = res.parts[i];
      return '<tr><td>' + esc(s.name) + '</td><td>' + C.fmtKg(s.w) + '</td><td>' + C.fmtUnit(s.priceNow) + '</td>'
        + '<td>' + C.fmtUnit(s.priceNeeded) + '</td><td>' + (s.ratio === null ? '—' : C.fmtNum(s.ratio, 2) + '×') + '</td>'
        + '<td>' + (p.cookUnit === null ? '—' : C.fmtUnit(p.cookUnit)) + '</td>'
        + '<td>' + (p.cookBreakEvenPct === null ? '—' : C.fmtPct(p.cookBreakEvenPct)) + '</td></tr>';
    }).join('');
    $('revBox').innerHTML =
      '<div class="kv" style="margin-bottom:8px">'
      + '<span class="k">盈亏平衡毛重单价</span><span class="v">' + esc(C.fmtUnit(res.rev.breakevenPrice))
      + '（含处理成本口径；填这个价，r 恰好 = 1）</span>'
      + '<span class="k">不含处理成本口径</span><span class="v">' + esc(C.fmtUnit(res.rev.breakevenPriceNoProcess)) + '</span>'
      + '<span class="k">目标折扣率 ' + esc(C.fmtPct(res.rev.targetDiscountPct, 0)) + ' 的买价上限</span><span class="v">'
      + esc(C.fmtMoney(Math.max(0, res.rev.targetCapTotal))) + '，对应毛重单价 ≤ ' + esc(C.fmtUnit(Math.max(0, res.rev.targetCapPrice)))
      + '（当前 ' + (res.rev.targetOk ? '已满足' : '未满足') + '）</span>'
      + '<span class="k">折算时薪</span><span class="v">' + (res.rev.savedPerHour === null ? '未填耗时'
        : esc(C.fmtNum(res.rev.savedPerHour, 2)) + ' 元/h（省 ' + esc(C.fmtMoney(res.rev.saved)) + ' ÷ ' + esc(C.fmtNum(C.num(res.cfg.minutes), 0)) + ' 分钟；你的时间价格 ' + esc(C.fmtNum(C.num(res.cfg.hourlyRate), 2)) + ' 元/h）') + '</span>'
      + '</div>'
      + '<div class="tw"><table id="revTable"><thead><tr><th>部位</th><th>净重</th><th>市价</th><th>单独覆盖成本要卖到</th><th>倍数</th><th>熟食成本</th><th>临界熟制率</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table></div>'
      + '<p class="footnote scrollhint">表格比屏幕宽：左右滑动可以看到全部列。</p>'
      + '<p class="footnote">「单独覆盖成本要卖到」= 到手总成本 ÷ 这一块的净重：意思是如果只靠这一块把整只的钱挣回来，它得卖到这个价。倍数 = 该价 ÷ 你填的市价。</p>'
      + (res.rev.breakevenPrice !== null && res.rev.breakevenPrice <= 0
        ? '<div class="warnbox">处理成本已经高于分部位市值合计，盈亏平衡价算出来是负的（' + esc(C.fmtNum(res.rev.breakevenPrice, 2))
          + ' 元/kg）——这说明不管毛重单价多少都回不了本，如实给出，不硬凑一个正数。</div>' : '');
  }

  function renderPartsTable(res) {
    $('partBody').innerHTML = res.parts.map((p) => '<tr>'
      + '<td>' + esc(p.name) + (p.w === 0 ? ' <span style="color:#9a5b00">（出成率 0）</span>' : '') + '</td>'
      + '<td>' + C.fmtPct(p.yieldPct, 2) + '</td>'
      + '<td>' + C.fmtKg(p.w) + '</td>'
      + '<td>' + C.fmtUnit(p.pricePerKg) + '</td>'
      + '<td>' + C.fmtMoney(p.v) + '</td>'
      + '<td>' + (p.share === null ? '—' : C.fmtPct(p.share * 100)) + '</td>'
      + '<td>' + C.fmtMoney(p.alloc) + '</td>'
      + '<td>' + C.fmtUnit(p.allocUnit) + '</td>'
      + '<td style="color:' + (p.save === null ? '' : (p.save >= 0 ? '#0f7b52' : '#b42318')) + '">'
      + (p.save === null ? '—' : (p.save >= 0 ? '省 ' : '多付 ') + C.fmtMoney(Math.abs(p.save))) + '</td>'
      + '</tr>').join('');
    const k = res.kpis;
    $('tfYield').textContent = C.fmtPct(res.sumY, 2);
    $('tfNet').textContent = C.fmtKg(k.netKg);
    $('tfWaste').textContent = '不可食 ' + C.fmtPct(res.wastePct, 2);
    $('tfValue').textContent = C.fmtMoney(k.marketValue);
    $('tfShare').textContent = k.marketValue > 0 ? '100.0%' : '—';
    $('tfCost').textContent = C.fmtMoney(k.totalCost);
    $('tfUnit').textContent = C.fmtUnit(k.netUnit);
    $('tfSave').textContent = C.fmtMoney(k.saved);
  }

  function renderCookTable(res) {
    const rows = res.parts.filter((p) => p.cookSavePerKg !== null);
    if (!rows.length) {
      $('cookBody').innerHTML = '<tr><td colspan="7">没有填成品熟食市价，熟制账没有可比对象（填 0 表示不比）。</td></tr>';
      return;
    }
    $('cookBody').innerHTML = rows.map((p) => '<tr>'
      + '<td>' + esc(p.name) + '</td>'
      + '<td>' + C.fmtPct(p.cookPct, 1) + '</td>'
      + '<td>' + C.fmtKg(p.cookKg) + '</td>'
      + '<td>' + C.fmtUnit(p.cookUnit) + '</td>'
      + '<td>' + C.fmtUnit(p.cookedPricePerKg) + '</td>'
      + '<td style="color:' + (p.cookSavePerKg >= 0 ? '#0f7b52' : '#b42318') + '">'
      + (p.cookSavePerKg >= 0 ? '省 ' : '多付 ') + C.fmtUnit(Math.abs(p.cookSavePerKg)) + '</td>'
      + '<td>' + (p.cookBreakEvenPct === null ? '—' : C.fmtPct(p.cookBreakEvenPct) + (p.cookSavePerKg < 0 ? '（已经低于）' : '')) + '</td>'
      + '</tr>').join('');
  }

  function renderSens(res) {
    const rows = C.sensitivity(res.cfg);
    $('sensBody').innerHTML = rows.map((x) => '<tr>'
      + '<td>' + esc(x.label) + '</td>'
      + '<td>' + (x.discountRate === null ? '—' : C.fmtNum(x.discountRate, 4)) + '</td>'
      + '<td>' + C.fmtUnit(x.netUnit) + '</td>'
      + '<td>' + (x.saved === null ? '—' : C.fmtMoney(x.saved)) + '</td>'
      + '<td>' + (x.minCover === null ? '—' : x.minCover + ' 块') + '</td>'
      + '<td>' + esc(x.verdict) + '</td></tr>').join('');
  }

  function renderChecks(res) {
    $('checkTag').textContent = res.checkSummary.pass + ' / ' + res.checkSummary.total;
    $('checkTag').className = res.checkSummary.pass === res.checkSummary.total ? 'tag gray' : 'tag';
    $('checks').innerHTML = res.checks.map((c) => '<li class="' + (c.pass ? '' : 'no') + '"><b>' + (c.pass ? '✔' : '✘') + '</b> '
      + esc(c.name) + (c.detail ? '（' + esc(c.detail) + '）' : '') + '</li>').join('');
  }

  /* ── 产值图（内联 SVG，横条 + 成本线） ───────────
   * 窄屏不是把同一张图整体缩小（那样字会小到看不清），而是换一套几何：
   * 更窄的 viewBox + 名称在左、数值放到条下方 + 只保留 0/50/100 三个刻度。
   * 纵轴刻度用 max(市值, 成本)：成本高于市值时成本线不会跑到画布外面。
   */
  function textWidth(str, fs) {
    let w = 0;
    for (const ch of String(str)) w += (ch.charCodeAt(0) > 0x2e80 ? 1 : 0.56) * fs;
    return w;
  }
  function clipText(str, fs, maxW) {
    let t = String(str);
    if (textWidth(t, fs) <= maxW) return t;
    while (t.length > 1 && textWidth(t + '…', fs) > maxW) t = t.slice(0, -1);
    return t + '…';
  }
  function renderChart(res) {
    const V = res.kpis.marketValue, Cc = res.kpis.totalCost;
    if (!(V > 0)) {
      $('chart').innerHTML = '<p style="padding:14px;color:#7b8794;font-size:13px">分部位市价合计为 0，画不出产值图。给至少一块填一个大于 0 的市价。</p>';
      return;
    }
    const narrow = (window.innerWidth || 1280) < 620;
    const W = narrow ? 380 : 820;
    const L = narrow ? 94 : 132, R = narrow ? 10 : 26;
    const rowH = narrow ? 44 : 34, top = narrow ? 26 : 30;
    const fsName = narrow ? 12 : 12.5, fsVal = narrow ? 11 : 11.5, fsAxis = narrow ? 10.5 : 11;
    const rows = res.ranked;
    const H = top + rows.length * rowH + (narrow ? 46 : 34);
    const axisMax = Math.max(V, Cc);            // 成本高于市值时也画得下
    const plotW = W - L - R;
    const x = (v) => L + (v / axisMax) * plotW;
    const covIdx = res.kpis.minCover === null ? -1 : res.kpis.minCover - 1;
    let s = '<svg id="chartSvg" viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-width:100%;height:auto;display:block" role="img" aria-label="各部位产值与成本覆盖图">';
    // 刻度文案：数值过大时用紧凑记法，免得标签比图还长
    const axisLabel = (v) => (v === 0 ? '0' : (Math.abs(v) >= 1e7 ? v.toExponential(2).replace('e+', 'e') : C.fmtMoney0(v)));
    let ticks = narrow ? [0, 50, 100] : [0, 25, 50, 75, 100];
    if (ticks.some((p) => axisLabel(axisMax * p / 100).length > 12)) ticks = narrow ? [0, 100] : [0, 50, 100];
    ticks.forEach((p) => {
      const xx = L + plotW * p / 100;
      // 两端的刻度标签向内收，避免被画布裁掉
      const anchor = p === 0 ? 'start' : (p === 100 ? 'end' : 'middle');
      const tx = p === 0 ? L : (p === 100 ? W - R : xx);
      s += '<line x1="' + xx.toFixed(1) + '" y1="' + (top - 10) + '" x2="' + xx.toFixed(1) + '" y2="' + (top + rows.length * rowH) + '" stroke="#eef1f5"/>';
      s += '<text x="' + tx.toFixed(1) + '" y="' + (top - 14) + '" font-size="' + fsAxis + '" fill="#7b8794" text-anchor="' + anchor + '">'
        + esc(axisLabel(axisMax * p / 100)) + '</text>';
    });
    rows.forEach((p, i) => {
      const y = top + i * rowH;
      const bw = Math.max(1.5, (p.v / axisMax) * plotW);
      const cumX = x(p.cumV);
      const name = clipText(p.name, fsName, L - 12);
      s += '<text x="' + (L - 8) + '" y="' + (y + (narrow ? 24 : 21)) + '" font-size="' + fsName + '" fill="#161b22" text-anchor="end">' + esc(name) + '</text>';
      s += '<rect x="' + L + '" y="' + (y + (narrow ? 10 : 6)) + '" width="' + bw.toFixed(1) + '" height="' + (narrow ? 14 : 18) + '" rx="3" fill="' + (i === covIdx ? '#0f7b52' : '#0f5fa6') + '"/>';
      s += '<rect x="' + L + '" y="' + (y + (narrow ? 26 : 24)) + '" width="' + Math.max(0, cumX - L).toFixed(1) + '" height="4" rx="2" fill="#9ec4e4"/>';
      const val = C.fmtMoney0(p.v) + ' 元 · ' + C.fmtPct((p.share || 0) * 100, 0) + (i === covIdx ? ' · 累计过线' : '');
      if (narrow) {
        s += '<text x="' + L + '" y="' + (y + 42) + '" font-size="' + fsVal + '" fill="#4a5568">' + esc(clipText(val, fsVal, W - L - R)) + '</text>';
      } else {
        const vx = Math.min(W - R - 4, L + bw + 8);
        s += '<text x="' + vx.toFixed(1) + '" y="' + (y + 20) + '" font-size="' + fsVal + '" fill="#4a5568">' + esc(val) + '</text>';
      }
    });
    const costX = x(Cc);
    s += '<line x1="' + costX.toFixed(1) + '" y1="' + (top - 10) + '" x2="' + costX.toFixed(1) + '" y2="' + (top + rows.length * rowH + 4) + '" stroke="#b42318" stroke-width="2" stroke-dasharray="5 4"/>';
    const costLabel = '成本 ' + C.fmtMoney0(Cc) + ' 元（市值 ' + C.fmtPct((res.kpis.discountRate || 0) * 100)
      + (Cc > V ? '；成本高于市值，刻度按成本取' : '') + '）';
    // 成本线文案独占一行：窄屏靠左起排，宽屏贴着线但两端都收进画布
    const cLy = top + rows.length * rowH + (narrow ? 32 : 20);
    if (narrow) {
      s += '<text x="' + L + '" y="' + cLy + '" font-size="' + fsVal + '" fill="#b42318">' + esc(clipText(costLabel, fsVal, W - L - R)) + '</text>';
    } else {
      const cw = textWidth(costLabel, fsVal);
      const anchor = (costX + 5 + cw > W - R) ? 'end' : 'start';
      const cx = anchor === 'end' ? Math.max(L + cw, costX - 5) : Math.min(W - R - cw, costX + 5);
      s += '<text x="' + cx.toFixed(1) + '" y="' + cLy + '" font-size="' + fsVal + '" fill="#b42318" text-anchor="' + anchor + '">' + esc(costLabel) + '</text>';
    }
    s += '</svg>';
    $('chart').innerHTML = s;
  }

  /* ── 四种导出 ───────────────────────────────────── */
  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
    state.exports++;
  }

  /* 按「词元」换行：数字/英文/百分号整体不拆开，避免出现 38.32 被断成 3 + 8.32 */
  function wrapLines(g, text, maxW) {
    const tokens = String(text).match(/[A-Za-z0-9][A-Za-z0-9.,%\/\-]*|\s+|[\s\S]/g) || [];
    const lines = [];
    let cur = '';
    tokens.forEach((tk) => {
      if (/^\s+$/.test(tk)) { if (cur) cur += '';  return; }
      const t = cur + tk;
      if (g.measureText(t).width > maxW && cur) { lines.push(cur); cur = tk; }
      else cur = t;
    });
    if (cur) lines.push(cur);
    return lines;
  }

  function drawCard(res) {
    const W = 1080, H = 1350, PAD = 64;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#0f5fa6'; g.fillRect(0, 0, W, 12);
    const setFont = (size, weight) => { g.font = (weight || 400) + ' ' + size + 'px ' + FONT; };
    const k = res.kpis;
    const textW = W - PAD * 2;

    /* 先量高度，再自顶向下画（内容变长时整体上移，不叠字） */
    const blocks = [];
    setFont(44, 700);
    blocks.push({ type: 'h', lines: ['出成率对账台'] });
    setFont(24, 400);
    blocks.push({ type: 'p', color: '#4a5568', lines: wrapLines(g, res.name + ' · 结论：' + res.verdict.label + '（' + res.verdict.note + '）', textW) });
    const kpi = [
      ['到手总成本', C.fmtMoney0(k.totalCost) + ' 元'],
      ['分部位市值', C.fmtMoney0(k.marketValue) + ' 元'],
      ['折扣率 r', C.fmtNum(k.discountRate, 4)],
      ['净料单价', C.fmtMoney0(k.netUnit) + ' 元/kg'],
      ['净料/不可食', C.fmtNum(k.netKg, 3) + ' / ' + C.fmtNum(k.wasteKg, 3) + ' kg'],
      ['回本部位数', k.minCover === null ? '做不到' : k.minCover + ' 块'],
    ];
    blocks.push({ type: 'kpi', items: kpi });
    setFont(25, 600);
    blocks.push({ type: 'h2', lines: ['反推'] });
    setFont(23, 400);
    blocks.push({
      type: 'p', color: '#4a5568', lines: wrapLines(g,
        '盈亏平衡毛重单价 ' + C.fmtUnit(res.rev.breakevenPrice) + '（含处理成本）；目标折扣率 ' + C.fmtPct(res.rev.targetDiscountPct, 0)
        + ' 对应毛重单价上限 ' + C.fmtUnit(Math.max(0, res.rev.targetCapPrice)) + '；折算时薪 '
        + (res.rev.savedPerHour === null ? '未填耗时' : C.fmtNum(res.rev.savedPerHour, 2) + ' 元/h'), textW).slice(0, 3),
    });
    setFont(25, 600);
    blocks.push({ type: 'h2', lines: ['要记住的几条'] });
    res.insights.slice(0, 3).forEach((x, i) => {
      setFont(23, 600);
      const head = wrapLines(g, (i + 1) + '. ' + x.t, textW - 8).slice(0, 2);
      // 要点正文只取第一句：宁可少说一句，也不要在卡上留下半截被裁掉的话
      const firstSentence = String(x.d).split('。')[0] + '。';
      setFont(21, 400);
      let body = wrapLines(g, firstSentence, textW - 8);
      if (body.length > 2) body = body.slice(0, 2).map((l, j) => (j === 1 ? l.slice(0, Math.max(0, l.length - 1)) + '…' : l));
      blocks.push({ type: 'ins', lines: head.concat(body) });
    });
    setFont(20, 400);
    blocks.push({ type: 'p', color: '#0f7b52', lines: ['结构自检 ' + res.checkSummary.pass + ' / ' + res.checkSummary.total + ' 通过（每次重算都跑）'] });
    setFont(19, 600);
    blocks.push({ type: 'h2', lines: ['口径与边界'] });
    setFont(19, 400);
    blocks.push({
      type: 'p', color: '#4a5568', lines: [
        '口径：出成率以毛重为基准；联合成本按相对售价法分摊；熟制只按质量缩水。',
        '边界：不含运费、税费、包装、冰箱电费与存放损耗；不做食品卫生与安全判定。',
      ],
    });
    setFont(18, 400);
    blocks.push({ type: 'p', color: '#7b8794', lines: ['价格与出成率全部由用户填写，页面不联网、不查行情 · ' + new Date().toLocaleString('zh-CN')] });

    const height = (b) => {
      if (b.type === 'h') return 78;
      if (b.type === 'h2') return 44;
      if (b.type === 'kpi') return 2 * 92 + 14;
      if (b.type === 'ins') return b.lines.length * 30 + 14;
      return b.lines.length * 30 + 10;
    };
    let total = 0;
    blocks.forEach((b) => { total += height(b); });
    // 内容偏短时整体略微下移居中，内容过长时从顶部开始
    let y = Math.max(88, Math.round((H - total) / 2));

    blocks.forEach((b) => {
      if (b.type === 'h') {
        setFont(44, 700); g.fillStyle = '#161b22';
        g.fillText(b.lines[0], PAD, y + 40);
        g.fillStyle = '#0f5fa6'; g.fillRect(PAD, y + 56, 120, 5);
        y += height(b); return;
      }
      if (b.type === 'h2') {
        setFont(25, 600); g.fillStyle = '#0f5fa6';
        g.fillText(b.lines[0], PAD, y + 30);
        y += height(b); return;
      }
      if (b.type === 'kpi') {
        const cw = (W - PAD * 2 - 2 * 18) / 3;
        b.items.forEach(([lab, val], i) => {
          const cx = PAD + (i % 3) * (cw + 18);
          const cy = y + Math.floor(i / 3) * 92;
          g.fillStyle = '#fafbfc'; g.fillRect(cx, cy, cw, 80);
          g.strokeStyle = '#e3e6eb'; g.lineWidth = 2; g.strokeRect(cx, cy, cw, 80);
          setFont(18, 400); g.fillStyle = '#7b8794';
          g.fillText(lab, cx + 16, cy + 28);
          setFont(28, 700); g.fillStyle = '#161b22';
          let t = String(val);
          while (g.measureText(t).width > cw - 32 && t.length > 2) { t = t.slice(0, -2) + '…'; }
          g.fillText(t, cx + 16, cy + 62);
        });
        y += height(b); return;
      }
      if (b.type === 'ins') {
        b.lines.forEach((l, j) => {
          const isHead = j === 0 || (b.lines.length > 1 && /^\d+\. /.test(l));
          setFont(isHead ? 23 : 21, isHead ? 600 : 400);
          g.fillStyle = isHead ? '#161b22' : '#4a5568';
          g.fillText(l, PAD + 8, y + 24 + j * 30);
        });
        y += height(b); return;
      }
      setFont(b.fontSize || 23, 400);
      b.lines.forEach((l, j) => {
        g.fillStyle = b.color || '#4a5568';
        g.fillText(l, PAD, y + 24 + j * 30);
      });
      y += height(b);
    });

    cv.toBlob((b) => {
      const url = URL.createObjectURL(b);
      const a = document.createElement('a');
      a.href = url; a.download = '出成率对账台-结果卡.png'; a.style.display = 'none';
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
      state.exports++;
    }, 'image/png', 0.94);
  }

  /* ── 本机保存 / 读取 / 导入 ─────────────────────── */
  function saveLocal(silent) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(readCfg()));
      if (!silent) toast('已保存到本机（刷新后自动恢复）');
      $('storeNote').textContent = '已保存到本机（localStorage）——最后一次改动的时间：' + new Date().toLocaleString('zh-CN');
    } catch (e) { if (!silent) toast('本机保存失败：' + e.message); }
  }
  function loadLocal(showToast) {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) { if (showToast) toast('本机没有保存过的设置'); return false; }
      fillCfg(JSON.parse(raw));
      compute();
      if (showToast) toast('已读取本机保存的设置');
      return true;
    } catch (e) { if (showToast) toast('读取失败：' + e.message); return false; }
  }
  function importBackup(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        fillCfg(C.readBackup(String(fr.result)));
        $('scenario').value = '';
        compute();
        toast('已导入备份并重算');
      } catch (e) { toast('导入失败：' + e.message); }
    };
    fr.readAsText(file);
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 2200);
  }

  function applyPatch(kind, val) {
    const v = C.num(val);
    if (!Number.isFinite(v) || v <= 0) { toast('这个反推值不可用（' + val + '）'); return; }
    if (kind === 'breakeven' || kind === 'target') {
      const el = $('g-pricePerKg');
      el.value = String(C.round(v, 4));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      toast(kind === 'breakeven' ? '毛重单价已改为盈亏平衡价' : '毛重单价已改为目标折扣率上限');
    }
  }

  /* ── 事件绑定 ───────────────────────────────────── */
  function bind() {
    const recompute = () => compute();
    ['g-name', 'g-grossKg', 'g-pricePerKg', 'g-processCost', 'g-targetDiscountPct', 'g-minutes', 'g-hourlyRate']
      .forEach((id) => {
        const el = $(id);
        el.addEventListener('input', recompute);
        el.addEventListener('change', recompute);
      });
    $('parts').addEventListener('input', recompute);
    $('parts').addEventListener('change', recompute);
    $('parts').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-del]');
      if (!btn) return;
      const rows = document.querySelectorAll('#parts .item');
      if (rows.length <= 1) { toast('至少要留一个部位'); return; }
      const parts = readCfg().parts;
      parts.splice(Number(btn.getAttribute('data-del')), 1);
      renderParts(parts);
      compute();
    });
    $('btnAddPart').addEventListener('click', () => {
      const parts = readCfg().parts;
      if (parts.length >= C.PART_MAX) { toast('最多 ' + C.PART_MAX + ' 个部位'); return; }
      const used = C.sum(parts.map((p) => C.num(p.yieldPct) || 0));
      const rest = Math.max(0, 100 - used);
      parts.push({ name: '新部位', yieldPct: Math.min(rest, 10), pricePerKg: 30, cookPct: 80, cookedPricePerKg: 0 });
      renderParts(parts);
      compute();
    });
    $('btnDelPart').addEventListener('click', () => {
      const parts = readCfg().parts;
      if (parts.length <= 1) { toast('至少要留一个部位'); return; }
      parts.pop();
      renderParts(parts);
      compute();
    });
    $('steps').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-apply]');
      if (!btn) return;
      applyPatch(btn.getAttribute('data-apply'), btn.getAttribute('data-val'));
    });
    $('scenario').addEventListener('change', (e) => {
      const id = e.target.value;
      if (!id) return;
      fillCfg(C.scenarioCfg(id));
      compute();
      toast('已载入场景：' + (C.scenarios.filter((s) => s.id === id)[0] || {}).name);
    });
    $('btnReset').addEventListener('click', () => { $('scenario').value = ''; fillCfg(C.defaultsClone()); compute(); toast('已恢复默认（虚构示例）'); });
    $('btnSave').addEventListener('click', () => saveLocal(false));
    $('btnLoad').addEventListener('click', () => loadLocal(true));
    $('importFile').addEventListener('change', (e) => { if (e.target.files && e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; });
    $('btnCsv').addEventListener('click', () => {
      if (!state.res || !state.res.ok) { toast('先修正输入错误再导出'); return; }
      download('出成率对账台.csv', '\ufeff' + C.toCsv(state.res), 'text/csv;charset=utf-8');
    });
    $('btnMd').addEventListener('click', () => {
      if (!state.res || !state.res.ok) { toast('先修正输入错误再导出'); return; }
      download('出成率对账台.md', C.toMd(state.res), 'text/markdown;charset=utf-8');
    });
    $('btnJson').addEventListener('click', () => download('出成率对账台-备份.json', C.backupJson(readCfg()), 'application/json'));
    $('btnPng').addEventListener('click', () => {
      if (!state.res || !state.res.ok) { toast('先修正输入错误再导出'); return; }
      drawCard(state.res);
    });
    $('btnPrint').addEventListener('click', () => window.print());
  }

  /* ── 启动 ───────────────────────────────────────── */
  let resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.res && state.res.ok) renderChart(state.res);
    }, 200);
  }

  function boot() {
    $('scenario').innerHTML = '<option value="">— 自己填 —</option>'
      + C.scenarios.map((s) => '<option value="' + s.id + '">' + esc(s.name) + '</option>').join('');
    let cfg = null;
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) cfg = JSON.parse(raw);
    } catch (e) { cfg = null; }
    let filled = false;
    if (cfg) {
      try { fillCfg(cfg); filled = true; } catch (e) { filled = false; }
    }
    if (!filled) fillCfg(C.defaultsClone());
    bind();
    window.addEventListener('resize', onResize);
    compute();
    /* 验收用的只读/半只读钩子：读状态、按真实事件改输入 */
    window.__yl = {
      __v: 46,
      res: function () { return state.res; },
      cfg: function () { return C.normCfg(readCfg()); },
      exports: function () { return state.exports; },
      renders: function () { return state.renders; },
      checks: function () { return state.res && state.res.ok ? state.res.checks : []; },
      setField: function (id, value) {
        const el = $(id);
        if (!el) return false;
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      },
      setPart: function (i, key, value) {
        const el = document.querySelector('#parts .item[data-part="' + i + '"] [data-k="' + key + '"]');
        if (!el) return false;
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      },
      addPart: function () { $('btnAddPart').click(); return document.querySelectorAll('#parts .item').length; },
      delPart: function (i) {
        const btn = document.querySelector('#parts .item[data-part="' + i + '"] [data-del]');
        if (!btn) return false;
        btn.click();
        return document.querySelectorAll('#parts .item').length;
      },
      pickScenario: function (id) {
        const el = $('scenario');
        el.value = id;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      },
      saveLocal: function () { saveLocal(true); return localStorage.getItem(STORE_KEY); },
      sens: function () { return C.sensitivity(C.normCfg(readCfg())); },
      toCsv: function () { return state.res && state.res.ok ? C.toCsv(state.res) : ''; }
    };
    window.__yieldReady = true;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
