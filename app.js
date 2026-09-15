/* ══════════════════════════════════════════════════════════════════════════
   스마트팩토리 품질 모니터링 — Kraken 디자인 시스템 (v3)
   · 라이트/다크 테마: 토큰 재배정만. JS·CSS에 hex 리터럴 없음.
   · 공정 라인 애니메이션: 실제 판정 tick으로 구동. prefers-reduced-motion 존중.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ══════════════ 테마 (탭 위 세그먼트) ══════════════ */
const THEME_KEY = 'sf-dash-theme';
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  Array.prototype.forEach.call($('segTheme').children, b =>
    b.setAttribute('aria-pressed', b.dataset.theme === t ? 'true' : 'false'));
  try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
}
(function initTheme() {
  let t = null;
  try { t = localStorage.getItem(THEME_KEY); } catch (e) {}
  if (t !== 'light' && t !== 'dark') {
    t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark' : 'light';
  }
  applyTheme(t);
})();
$('segTheme').addEventListener('click', e => {
  const b = e.target.closest('button[data-theme]');
  if (b) applyTheme(b.dataset.theme);
});

/* ── 데이터 로딩 실패 → 에러 상태 ─────────────────────────────────── */
if (!window.DASH_DATA || !window.DASH_DATA.meta) {
  $('banners').innerHTML =
    '<div class="banner banner-bad" role="alert">' +
      '<div><div class="bt">데이터 파일을 읽지 못했습니다</div>' +
      '<div class="bd">data.js가 로드되지 않았습니다. file:// 로 열지 않고 로컬 서버로 실행했는지 ' +
      '확인하세요. 예: <code>python -m http.server 8823</code></div></div>' +
      '<div class="bx"><button class="btn btn-primary btn-sm" onclick="location.reload()">다시 시도</button></div>' +
    '</div>';
  return;
}

const D = window.DASH_DATA;
const FAMS = ['A', 'TO'];
const LABELS = D.meta.class_labels;
const KEY = D.meta.key_sensors;
const MODEL = { A: D.meta.perf.A.model, TO: D.meta.perf.TO.model };

const GTOK = ['var(--g0)', 'var(--g1)', 'var(--g2)'];
const GBADGE = ['b-bad', 'b-good', 'b-warn'];
const FAMTOK = { A: 'var(--fam-a)', TO: 'var(--fam-to)' };

const IMPORTANCE = {
  A: {S02:.166,S01:.159,S03:.135,S05:.100,S08:.084,S11:.068,
      S04:.062,S09:.059,S06:.057,S07:.045,S10:.041,S12:.022},
  TO: {S15:.535, S13:.28, S14:.185}
};
const RMSE = { A: 0.00489, TO: 0.00306 };
const NOISE_SCALE = 0.4;

/* 학습 기준선 (class_counts 실측) */
const BASE = (() => {
  const o = {}; let bad = 0, tot = 0;
  FAMS.forEach(f => {
    const c = D[f].class_counts, n = D[f].n;
    const b = (+c['0'] || 0) + (+c['2'] || 0);
    o[f] = { defect: b / n, n: n, bad: b };
    bad += b; tot += n;
  });
  o.ALL = { defect: bad / tot, n: tot, bad: bad };
  return o;
})();
const BASE_RECALL = { A: D.meta.perf.A.recall0_after, TO: D.meta.perf.TO.recall0_after };
const QUEUE_OK = 8;   // 재검 대기 적정 상한

const IDX = {};
FAMS.forEach(f => { IDX[f] = {}; D[f].sensors.forEach((s, i) => IDX[f][s.code] = i); });
const sstat = (f, code) => D[f].sensors[IDX[f][code]];
const THR = JSON.parse(JSON.stringify(D.meta.thresholds));

/* ──────────────────────────────────────────────────────────────────
   라인(호기) — train_식별컬럼매칭완료.csv 의 LINE 컬럼 실측값 (lines.js)
   제품 ID 908건 전수 매칭. 제품군(A·TO)과 별개인 범주형 차원이며
   A 제품군에 4개 라인, TO 제품군에 2개 라인이 귀속됩니다.
   ────────────────────────────────────────────────────────────────── */
const L = window.DASH_LINES || null;
const LINES = L ? L.lines : FAMS.slice();                 /* 폴백: 제품군을 라인으로 대체 */
const LINE_FAM = L ? L.lineFam : { A: 'A', TO: 'TO' };
const FAM_LINES = L ? L.famLines : { A: ['A'], TO: ['TO'] };
/* 라인별 학습 기준 불량률 (CSV 실제 Y_Class) */
const LINE_BASE = {};
LINES.forEach(ln => {
  const b = L ? L.base[ln] : { n: BASE[ln].n, bad: BASE[ln].bad };
  LINE_BASE[ln] = { n: b.n, bad: b.bad, defect: b.n ? b.bad / b.n : 0 };
});
/* 제품 ID → 라인. lines.js가 없으면 제품군으로 대체 */
function lineOf(id, fam) {
  if (!L) return fam || null;
  const i = L.byId[String(id).replace('SAMPLE_', '')];
  return i == null ? (fam || null) : LINES[i];
}
const lineChip = (id, fam) => {
  const ln = lineOf(id, fam);
  if (!ln) return '<span class="muted">–</span>';
  if (!L) return '<span class="muted">–</span>';
  return `<span class="lineChip"><span class="ld"
    style="background:${FAMTOK[LINE_FAM[ln]]}"></span>${ln}</span>`;
};

/* 진단 탭에 띄우는 핵심 센서 4종 (A 상위 3 + TO 지배 1) */
const WATCH = [
  { fam: 'A', code: 'S02' }, { fam: 'A', code: 'S01' },
  { fam: 'A', code: 'S03' },  { fam: 'TO', code: 'S15' }
];

/* ══════════════ 상태 ══════════════ */
const state = {
  tab: 'now', filterFam: 'all',
  running: true, speed: 1, timer: null, phase: 'loading',
  page: 1, perPage: 12,
  filterLine: 'all',
  search: '',
  cntLine: {}, totLine: {}, recLine: {},   /* 라인 단위 단일 출처 */
  confusion: { A: [[0,0,0],[0,0,0],[0,0,0]], TO: [[0,0,0],[0,0,0],[0,0,0]] },
  log: [], stream: [], risk: [], alerts: [],
  spark: { A:{}, TO:{} }, missWindow: { A:[], TO:[] }, driftWin: { A:{}, TO:{} },
  vclock: (() => { const d = new Date(); d.setHours(9,0,0,0); return d.getTime(); })(),
  selected: null, alertSeq: 0, seq: 0,
  apiAlive: false, apiEverAlive: false, lastApiOk: null, ingestFails: 0,
  reportDay: null, reportWeek: null, reportMonth: null,
  ai: { built: false, seq: 0 }
};
FAMS.forEach(f => {
  KEY[f].forEach(c => { state.spark[f][c] = []; });
  D[f].sensors.forEach(s => { state.driftWin[f][s.code] = []; });
});
LINES.forEach(ln => {
  state.cntLine[ln] = {0:0,1:0,2:0};
  state.totLine[ln] = 0;
  state.recLine[ln] = [0,0];
});

const activeFams = () => state.filterFam === 'all' ? FAMS : [state.filterFam];
/* 라인 필터가 걸리면 그 라인만, 아니면 선택된 제품군의 모든 라인 */
function activeLines() {
  if (state.filterLine !== 'all') return [state.filterLine];
  const out = [];
  activeFams().forEach(f => (FAM_LINES[f] || []).forEach(ln => out.push(ln)));
  return out;
}
/* 라인 → 제품군 집계 (제품군 카운터는 라인 합으로 유도) */
function famCount(f, g) {
  return (FAM_LINES[f] || []).reduce((s, ln) => s + state.cntLine[ln][g], 0);
}
function famTotal(f) {
  return (FAM_LINES[f] || []).reduce((s, ln) => s + state.totLine[ln], 0);
}
function famRecall(f) {
  return (FAM_LINES[f] || []).reduce((s, ln) =>
    [s[0] + state.recLine[ln][0], s[1] + state.recLine[ln][1]], [0,0]);
}

/* ══════════════ 포맷 ══════════════ */
const f1d = v => (Math.round(v * 10) / 10).toFixed(1);
const f2d = v => v.toFixed(2);
const f3d = v => v.toFixed(3);
const f4d = v => v.toFixed(4);
const f0d = v => Math.round(v).toString();
const fmtCount = n => n >= 10000 ? (n / 10000).toFixed(1) + '만' : n.toLocaleString('ko-KR');
const pct = (a, b) => b ? (a / b * 100) : 0;
function clockOf(ms) {
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function gauss() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/* 모션: OS 접근성 설정이 기본값이지만, 사용자가 대시보드에서 명시적으로 덮을 수 있음 */
const MOTION_KEY = 'sf-dash-motion';
let motionPref = 'on';                       // auto | on | off
function reducedMotion() { return false; } // 추가
// try { motionPref = localStorage.getItem(MOTION_KEY) || 'auto'; } catch (e) {}
// const osReduced = () =>
//   !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
// function reducedMotion() {
//   if (motionPref === 'on') return false;
//   if (motionPref === 'off') return true;
//   return osReduced();
// }

/* ══════════════ tick ══════════════ */
function classify(fam, y) { const t = THR[fam]; return y < t.t01 ? 0 : (y < t.t12 ? 1 : 2); }
function confidence(fam, y) {
  const t = THR[fam], span = (t.t12 - t.t01) || 0.01;
  const d = Math.min(Math.abs(y - t.t01), Math.abs(y - t.t12));
  return Math.max(.52, Math.min(.99, .55 + .44 * Math.min(1, d / span)));
}

function tick(warm) {
  const fam = Math.random() < (D.A.n / (D.A.n + D.TO.n)) ? 'A' : 'TO';
  const src = D[fam];
  const row = src.rows[Math.floor(Math.random() * src.rows.length)];
  const yhat = +(row.y + gauss() * RMSE[fam] * NOISE_SCALE).toFixed(6);
  const pred = classify(fam, yhat);
  const conf = confidence(fam, yhat);
  let miss = 0; row.v.forEach(x => { if (x == null) miss++; });
  state.vclock += 90 * 1000;

  const line = lineOf(row.id, fam);
  const rec = { id: row.id, fam, line, pred, actual: row.cls, conf, y: row.y, yhat,
                v: row.v, miss, vt: state.vclock, seq: state.seq++ };

  if (line) {
    state.totLine[line]++;
    state.cntLine[line][pred]++;
    if (row.cls !== 1) { state.recLine[line][1]++; if (pred !== 1) state.recLine[line][0]++; }
  }
  state.confusion[fam][row.cls][pred]++;
  state.log.push({ fam, line, predBad: pred !== 1, actBad: row.cls !== 1 });
  if (state.log.length > 600) state.log.shift();

  state.stream.unshift(rec);
  if (state.stream.length > 60) state.stream.pop();

  if (pred !== 1) {
    rec.wf = '대기';
    state.risk.unshift(rec);
    if (state.risk.length > 40) state.risk.pop();
    pushAlert('crit', '불량 검출 ' + rec.id + ' · 등급 ' + pred + ' ' + LABELS[pred],
      fam + ' 제품군 · 신뢰도 ' + f0d(conf * 100) + '% · 정밀검사 배정', rec.vt);
  }

  KEY[fam].forEach(code => {
    const val = row.v[IDX[fam][code]], st = sstat(fam, code);
    let out = false;
    if (val != null) {
      const ucl = st.mean + 3 * st.std, lcl = st.mean - 3 * st.std;
      out = (val > ucl || val < lcl);
      if (out && !warm) pushAlert('warn', '관리한계 이탈 ' + code,
        fam + ' 제품군 · 값 ' + f2d(val) + ' (한계 ' + f1d(lcl) + '~' + f1d(ucl) + ')', rec.vt);
    }
    const arr = state.spark[fam][code];
    arr.push({ v: val, out });
    if (arr.length > 40) arr.shift();
  });
  D[fam].sensors.forEach((s, i) => {
    const arr = state.driftWin[fam][s.code], v = row.v[i];
    if (v != null) { arr.push(v); if (arr.length > 60) arr.shift(); }
  });
  const mw = state.missWindow[fam];
  mw.push(miss / src.sensor_cols.length);
  if (mw.length > 60) mw.shift();

  advanceInspections();
  if (!warm) {
    const dk = dayKey(state.vclock), wk = weekKey(state.vclock), mk = monthKey(state.vclock);
    if (state.reportDay === null) { state.reportDay = dk; state.reportWeek = wk; state.reportMonth = mk; }
    else {
      if (dk !== state.reportDay)   { state.reportDay = dk;   sendReport('daily'); }
      if (wk !== state.reportWeek)  { state.reportWeek = wk;  sendReport('weekly'); }
      if (mk !== state.reportMonth) { state.reportMonth = mk; sendReport('monthly'); }
    }
    sendIngest(rec); feedStage(fam, pred);
  }
}

function pushAlert(kind, title, desc, vt) {
  state.alerts.unshift({ kind, title, desc, vt, id: state.alertSeq++ });
  if (state.alerts.length > 24) state.alerts.pop();
}

/* ══════════════ 집계 ══════════════ */
function agg() {
  const lines = activeLines();
  let total = 0, c = [0,0,0], rh = 0, rt = 0, bN = 0, bBad = 0, wR = 0, wW = 0;
  lines.forEach(ln => {
    total += state.totLine[ln];
    for (let g = 0; g < 3; g++) c[g] += state.cntLine[ln][g];
    rh += state.recLine[ln][0]; rt += state.recLine[ln][1];
    const lb = LINE_BASE[ln];
    if (lb) {
      bN += lb.n; bBad += lb.bad;
      const f = LINE_FAM[ln];
      wR += BASE_RECALL[f] * lb.bad; wW += lb.bad;   /* 불량 건수 가중 */
    }
  });
  const bad = c[0] + c[2];
  return { lines, total, c, bad, defect: pct(bad, total),
           baseDefect: pct(bBad, bN),
           recall: pct(rh, rt), recallHit: rh, recallTot: rt,
           baseRecall: wW ? wR / wW * 100 : 0 };
}
function buckets(size) {
  const lines = activeLines();
  const rows = state.log.filter(r => r.line && lines.indexOf(r.line) >= 0);
  const out = [];
  for (let i = 0; i + size <= rows.length; i += size) {
    const s = rows.slice(i, i + size);
    let bad = 0, hit = 0, act = 0;
    s.forEach(r => { if (r.predBad) bad++; if (r.actBad) { act++; if (r.predBad) hit++; } });
    out.push({ defect: bad / size * 100, recall: act ? hit / act * 100 : null });
  }
  return out;
}

/* ══════════════ 차트 헬퍼 ══════════════ */
function hostWidth(id, min, max) {
  const el = $(id);
  const w = el ? el.clientWidth : 0;
  return Math.max(min || 300, Math.min(max || 900, w || 600));
}

function sparkline(vals, opt) {
  const o = Object.assign({ w: 180, h: 36, color: 'var(--seq-4)', target: null }, opt || {});
  const clean = vals.filter(v => v != null);
  if (clean.length < 2) return '<div class="t-cap muted">집계 중</div>';
  const ext = clean.concat(o.target == null ? [] : [o.target]);
  const lo = Math.min.apply(null, ext), hi = Math.max.apply(null, ext);
  const rng = (hi - lo) || 1, pad = 3;
  const X = i => (i / (vals.length - 1)) * o.w;
  const Y = v => pad + (1 - (v - lo) / rng) * (o.h - pad * 2);
  const pts = vals.map((v, i) => v == null ? null : X(i).toFixed(1) + ',' + Y(v).toFixed(1))
                  .filter(Boolean).join(' ');
  const tl = o.target == null ? '' :
    `<line x1="0" y1="${Y(o.target).toFixed(1)}" x2="${o.w}" y2="${Y(o.target).toFixed(1)}"
       stroke="var(--border-strong)" stroke-width="1" stroke-dasharray="3 3"/>`;
  const last = clean[clean.length - 1];
  return `<svg class="chart" viewBox="0 0 ${o.w} ${o.h}" width="${o.w}" height="${o.h}"
      role="img" aria-label="추이, 마지막 값 ${f1d(last)}">
    ${tl}<polyline points="${pts}" fill="none" stroke="${o.color}" stroke-width="1.6"
      stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${X(vals.length - 1).toFixed(1)}" cy="${Y(last).toFixed(1)}" r="2.6" fill="${o.color}"/>
  </svg>`;
}

function lineChart(series, opt) {
  const o = Object.assign({ w: 640, h: 200, unit: '%', target: null, targetLabel: '',
                            color: 'var(--c1)', label: '', xFirst: '', xLast: '' }, opt || {});
  if (!series.length) return '';
  const W = o.w, H = o.h, mL = 42, mR = Math.max(58, Math.min(96, W * 0.16)), mT = 10, mB = 26;
  const iw = W - mL - mR, ih = H - mT - mB;
  const all = series.concat(o.target == null ? [] : [o.target]);
  let lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
  const padv = (hi - lo) * 0.18 || 1;
  lo = Math.max(0, lo - padv); hi = hi + padv;
  const X = i => mL + (series.length === 1 ? iw / 2 : i / (series.length - 1) * iw);
  const Y = v => mT + (1 - (v - lo) / (hi - lo)) * ih;
  const g = [];
  for (let i = 0; i <= 4; i++) {
    const v = lo + (hi - lo) * i / 4, y = Y(v);
    g.push(`<line x1="${mL}" y1="${y.toFixed(1)}" x2="${mL + iw}" y2="${y.toFixed(1)}"
      stroke="var(--grid)" stroke-width="1"/>
      <text class="axl" x="${mL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end">${f1d(v)}</text>`);
  }
  const pts = series.map((v, i) => X(i).toFixed(1) + ',' + Y(v).toFixed(1)).join(' ');
  const lastV = series[series.length - 1], lx = X(series.length - 1), ly = Y(lastV);
  const tgt = o.target == null ? '' :
    `<line x1="${mL}" y1="${Y(o.target).toFixed(1)}" x2="${mL + iw}" y2="${Y(o.target).toFixed(1)}"
       stroke="var(--border-strong)" stroke-width="1.5" stroke-dasharray="4 4"/>
     <text class="axl" x="${mL + iw}" y="${(Y(o.target) - 7).toFixed(1)}" text-anchor="end"
       >${esc(o.targetLabel)}</text>`;
  return `<svg class="chart cfix" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="${esc(o.label)} 추이, 마지막 값 ${f1d(lastV)}${o.unit}">
    ${g.join('')}${tgt}
    <polyline points="${pts}" fill="none" stroke="${o.color}" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3.5" fill="${o.color}"/>
    <text class="dirlab" x="${(lx + 9).toFixed(1)}" y="${(ly + 4).toFixed(1)}" fill="${o.color}"
      >${f1d(lastV)}${o.unit}${W > 480 ? ' ' + esc(o.label) : ''}</text>
    <text class="axl" x="${mL}" y="${H - 8}">${esc(o.xFirst)}</text>
    <text class="axl" x="${mL + iw}" y="${H - 8}" text-anchor="end">${esc(o.xLast)}</text>
  </svg>`;
}

function hbars(items) {
  return '<div class="hbars">' + items.map(it => {
    const w = Math.max(0, Math.min(100, it.pct));
    const marker = it.marker == null ? '' :
      `<span style="position:absolute;left:${Math.min(100, it.marker)}%;top:-3px;bottom:-3px;
        width:1px;background:var(--text-secondary)"></span>`;
    return `<div class="hb"><div class="hl">${it.label}</div>
      <div class="ht" style="position:relative;overflow:visible">
        <i style="width:${w.toFixed(1)}%;background:${it.color}"></i>${marker}</div>
      <div class="hv">${it.value}</div></div>`;
  }).join('') + '</div>';
}

function sensorSpark(arr, st, w, h) {
  w = w || 300; h = h || 44;
  const vals = arr.filter(a => a.v != null).map(a => a.v);
  if (!vals.length) return '<div class="t-cap muted">수집 중</div>';
  const ucl = st.mean + 3 * st.std, lcl = st.mean - 3 * st.std;
  const lo = Math.min.apply(null, vals.concat([lcl]));
  const hi = Math.max.apply(null, vals.concat([ucl]));
  const rng = (hi - lo) || 1, pad = 4;
  const X = i => (i / Math.max(1, arr.length - 1)) * w;
  const Y = v => pad + (1 - (v - lo) / rng) * (h - pad * 2);
  const yU = Y(ucl), yL = Y(lcl);
  let cur = '', segs = [];
  arr.forEach((a, i) => {
    if (a.v == null) { if (cur) segs.push(cur); cur = ''; }
    else cur += (cur ? ' ' : '') + X(i).toFixed(1) + ',' + Y(a.v).toFixed(1);
  });
  if (cur) segs.push(cur);
  const last = arr[arr.length - 1];
  const dot = (last && last.v != null)
    ? `<circle cx="${X(arr.length - 1).toFixed(1)}" cy="${Y(last.v).toFixed(1)}" r="3"
        fill="${last.out ? 'var(--bad)' : 'var(--seq-5)'}"/>` : '';
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"
      role="img" aria-label="최근 ${arr.length}건 추이, 관리한계 ${f1d(lcl)}~${f1d(ucl)}">
    <rect x="0" y="${Math.min(yU, yL).toFixed(1)}" width="${w}"
      height="${Math.abs(yL - yU).toFixed(1)}" fill="var(--surface-hover)"/>
    <line x1="0" y1="${yU.toFixed(1)}" x2="${w}" y2="${yU.toFixed(1)}"
      stroke="var(--border-strong)" stroke-width="1" stroke-dasharray="3 3"/>
    <line x1="0" y1="${yL.toFixed(1)}" x2="${w}" y2="${yL.toFixed(1)}"
      stroke="var(--border-strong)" stroke-width="1" stroke-dasharray="3 3"/>
    ${segs.map(s => `<polyline points="${s}" fill="none" stroke="var(--seq-5)"
      stroke-width="1.6" stroke-linejoin="round"/>`).join('')}
    ${dot}</svg>`;
}

/* ══════════════ 공용 조각 ══════════════ */
const infoTip = t => `<button class="info" type="button" aria-label="지표 정의">i<span class="tip"
  role="tooltip">${t}</span></button>`;
const gradeBadge = g => `<span class="badge ${GBADGE[g]}"><span class="sd"></span>${g} ${LABELS[g]}</span>`;
const famBadge = f => `<span class="fam fam-${f}">${f}</span>`;
const emptyState = (t, d, a) => `<div class="state"><div class="st-t">${t}</div>
  <div class="st-d">${d}</div>${a ? '<div class="st-a">' + a + '</div>' : ''}</div>`;
function deltaHTML(d, dir, unit, baseLabel) {
  let cls, arrow;
  if (Math.abs(d) < 0.05) { cls = 'flat'; arrow = '–'; }
  else if (d > 0) { arrow = '▲'; cls = (dir === 'inverse') ? 'down' : 'up'; }
  else { arrow = '▼'; cls = (dir === 'inverse') ? 'up' : 'down'; }
  return `<span class="${cls}">${arrow} ${f1d(Math.abs(d))}${unit}</span>
          <span class="base">vs ${baseLabel}</span>`;
}

/* ══════════════════════════════════════════════════════════════════════
   공정 흐름 애니메이션 — 물체가 스테이션을 하나씩 통과하는 모션
   · 등속 활강이 아니라 이송(ease) → 정지(체류) 를 반복합니다.
   · 물체는 기판 형태(둥근 사각)로 컨베이어 위에 올라가 있습니다.
   · 판정 스테이션에서 체류하는 동안 등급이 확정되고 색을 얻습니다.
   ══════════════════════════════════════════════════════════════════════ */
const STAGES = [
  { p: 0.00, name: '투입' },
  { p: 0.30, name: '센서 계측' },
  { p: 0.58, name: '모델 판정' },
  { p: 0.80, name: '등급 분기' }
];

/* 이송/체류 타임라인 (ms, 1× 기준) */
const TL = [
  { kind: 'hold', at: 0.00, dur: 420, st: 0 },
  { kind: 'move', from: 0.00, to: 0.30, dur: 1150 },
  { kind: 'hold', at: 0.30, dur: 820, st: 1 },
  { kind: 'move', from: 0.30, to: 0.58, dur: 1080 },
  { kind: 'hold', at: 0.58, dur: 1150, st: 2 },        /* 판정 — 여기서 등급 확정 */
  { kind: 'move', from: 0.58, to: 0.80, dur: 880 },
  { kind: 'hold', at: 0.80, dur: 520, st: 3 },
  { kind: 'move', from: 0.80, to: 1.04, dur: 1250 }
];
const TL_TOTAL = TL.reduce((s, x) => s + x.dur, 0);
/* 판정 체류 시작 시각 */
const JUDGE_AT = (function () {
  let t = 0;
  for (let i = 0; i < TL.length; i++) {
    if (TL[i].kind === 'hold' && TL[i].st === 2) return t;
    t += TL[i].dur;
  }
  return t;
})();

const easeInOut = x => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

/* 경과시간 → 위치·체류상태 */
function sampleTL(el) {
  let t = el;
  for (let i = 0; i < TL.length; i++) {
    const s = TL[i];
    if (t < s.dur) {
      if (s.kind === 'hold') return { p: s.at, st: s.st, ht: t / s.dur };
      return { p: s.from + (s.to - s.from) * easeInOut(t / s.dur), st: -1, ht: 0 };
    }
    t -= s.dur;
  }
  return { p: 1.04, st: -1, ht: 0, done: true };
}

let geo = null, flight = [], raf = null, lastT = 0, beltOff = 0;

function buildStage() {
  const host = $('lineStage');
  if (!host) return;
  const W = Math.max(300, host.clientWidth - 24 || 600);
  const compact = W < 580;
  const xL = compact ? 40 : 128;
  const xR = W - (compact ? 46 : 104);
  const top = compact ? 30 : 46;
  const gap = compact ? 84 : 98;
  const H = top + gap + 52;

  geo = {};
  FAMS.forEach((f, i) => {
    const base = top + i * gap;
    geo[f] = { xL, xR, base, reject: base + 34, judge: 0.58, branch: 0.80, compact: compact };
  });

  const parts = [];

  /* 스테이션 라벨 (넓은 폭에서만) */
  if (!compact) {
    STAGES.forEach(s => {
      const x = xL + s.p * (xR - xL);
      parts.push(`<text class="axl" x="${x.toFixed(1)}" y="12"
        text-anchor="${s.p === 0 ? 'start' : 'middle'}">${s.name}</text>`);
    });
  }

  FAMS.forEach(f => {
    const g = geo[f];
    const span = g.xR - g.xL;
    const xB = g.xL + g.branch * span;
    const xJ = g.xL + g.judge * span;
    const xD = g.xL + 0.93 * span;
    const beltY = g.base + 8;

    /* 컨베이어 벨트 (본선) */
    parts.push(`<rect x="${g.xL}" y="${beltY}" width="${span}" height="6" rx="3"
      fill="var(--border)"/>`);
    /* 벨트 텍스처 — stroke-dashoffset 을 굴려 이송감을 줌 */
    parts.push(`<line id="belt-${f}" x1="${g.xL + 2}" y1="${beltY + 3}" x2="${g.xR - 2}"
      y2="${beltY + 3}" stroke="var(--border-strong)" stroke-width="2"
      stroke-dasharray="5 9" stroke-linecap="round"/>`);

    /* 재검 분기: 디버터 → 하단 벨트 */
    parts.push(`<path d="M ${xB} ${beltY + 3} L ${xD} ${g.reject + 11} L ${g.xR} ${g.reject + 11}"
      fill="none" stroke="var(--border)" stroke-width="5" stroke-linecap="round"
      stroke-linejoin="round"/>`);
    /* 디버터 암 */
    parts.push(`<line x1="${xB}" y1="${beltY - 5}" x2="${(xB + 13).toFixed(1)}"
      y2="${(beltY + 9).toFixed(1)}" stroke="var(--bad)" stroke-width="2"
      stroke-linecap="round" opacity="0.8"/>`);

    /* 스테이션 게이트(설비 프레임) */
    if (!compact) {
      STAGES.forEach(s => {
        if (s.p === 0) return;
        const x = g.xL + s.p * span;
        const isJudge = s.st === 2 || Math.abs(s.p - g.judge) < 0.001;
        const w = isJudge ? 17 : 13, h = isJudge ? 26 : 20;
        const col = isJudge ? FAMTOK[f] : 'var(--border-strong)';
        parts.push(`<path d="M ${x - w} ${g.base + 6} L ${x - w} ${g.base - h}
          L ${x + w} ${g.base - h} L ${x + w} ${g.base + 6}" fill="none" stroke="${col}"
          stroke-width="${isJudge ? 2 : 1.4}" stroke-linejoin="round"/>`);
      });
      /* 판정 게이트 표식 */
      parts.push(`<circle cx="${xJ.toFixed(1)}" cy="${g.base - 26}" r="3" fill="${FAMTOK[f]}"/>`);
    }

    /* 좌측 라벨 블록: 제품군 · 모델 · 실시간 불량률 (한 곳에 모음) */
    if (compact) {
      parts.push(`<text x="0" y="${g.base - 4}" font-size="12" font-weight="600"
        fill="${FAMTOK[f]}">${f}</text>`);
      parts.push(`<text id="lnRate-${f}" x="0" y="${g.base + 12}" font-size="11"
        font-weight="600"></text>
        <text id="lnMeta-${f}" x="0" y="${g.base + 26}" font-size="11"
        fill="var(--axis)"></text>`);
    } else {
      parts.push(`<text x="0" y="${g.base - 6}" font-size="13" font-weight="600"
        fill="${FAMTOK[f]}">${f} 제품군</text>`);
        // <text class="axl" x="0" y="${g.base + 10}">${MODEL[f]}</text>
      parts.push(`<text id="lnRate-${f}" x="0" y="${g.base + 10}" font-size="12"
        font-weight="600"></text>
        <text id="lnMeta-${f}" class="axl" x="0" y="${g.base + 44}"></text>`);
      parts.push(`<text class="axl" x="${g.xR + 8}" y="${beltY + 7}">출하</text>
        <text x="${g.xR + 8}" y="${g.reject + 15}" font-size="12" font-weight="600"
          fill="var(--bad)">재검</text>`);
    }
  });

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
    aria-label="공정 흐름 도식. 제품이 투입·센서 계측·모델 판정·등급 분기 스테이션을 차례로 통과해
    출하 또는 재검으로 배출됩니다.">
    ${parts.join('')}<g id="piecesG"></g></svg>`;

  $('lineLegend').innerHTML = [
    ['var(--text-muted)', '판정 전'], [GTOK[1], '1 정상 → 출하'],
    [GTOK[0], '0 불량·저 → 재검'], [GTOK[2], '2 불량·고 → 재검']
  ].map(x => `<span style="display:flex;align-items:center;gap:5px">
      <span style="width:12px;height:8px;border-radius:2px;background:${x[0]};
        display:inline-block"></span>${x[1]}</span>`).join('')
    + (compact ? '<span class="muted">투입 → 센서 계측 → 모델 판정 → 등급 분기</span>' : '');

  updateStageLabels();
  paintPieces();
}

/* 구조는 유지하고 수치 라벨만 갱신 → 애니메이션이 끊기지 않음 */
function updateStageLabels() {
  FAMS.forEach(f => {
    const rate = $('lnRate-' + f), meta = $('lnMeta-' + f);
    if (!rate || !meta) return;
    const n = famTotal(f);
    const defect = pct(famCount(f, 0) + famCount(f, 2), n);
    const over = defect > BASE[f].defect * 100;
    rate.textContent = '불량률 ' + (n ? f1d(defect) + '%' : '–');
    rate.setAttribute('fill', over ? 'var(--bad)' : 'var(--good)');
    // meta.textContent = (geo && geo[f] && geo[f].compact)
    //   ? 'n=' + fmtCount(n)
    //   : '기준 ' + f1d(BASE[f].defect * 100) + '% · n=' + fmtCount(n);
  });
}

function posOf(lane, p, grade) {
  const g = geo[lane];
  const span = g.xR - g.xL;
  const x = g.xL + Math.min(1.04, p) * span;
  let y = g.base;
  if (grade !== 1 && p > g.branch) {
    const t = Math.min(1, (p - g.branch) / 0.13);
    y = g.base + easeInOut(t) * (g.reject - g.base);
  }
  return { x, y };
}

/* 모션을 켠 직후 빈 라인이 보이지 않도록 최근 판정으로 채움 */
function seedFlight() {
  flight = [];
  FAMS.forEach(f => {
    const recent = state.stream.filter(r => r.fam === f).slice(0, 4).reverse();
    recent.forEach((r, i) => {
      const el = TL_TOTAL * (0.74 - i * 0.19);
      if (el > 0) flight.push({ lane: f, grade: r.pred, el: el });
    });
  });
}

function feedStage(fam, grade) {
  if (reducedMotion()) return;
  flight.push({ lane: fam, grade: grade, el: 0 });
  if (flight.length > 30) flight.shift();
}

/* 모션 최소화: 최근 판정을 스테이션 위에 정지 표시 */
function staticPieces() {
  const out = [];
  const slots = [0.00, 0.30, 0.58, 0.80, 1.00];
  FAMS.forEach(f => {
    const recent = state.stream.filter(r => r.fam === f).slice(0, slots.length).reverse();
    recent.forEach((r, i) => out.push({ lane: f, grade: r.pred, p: slots[i],
      revealed: slots[i] >= 0.58, st: -1, ht: 0 }));
  });
  return out;
}

/* 기판 모양 물체 1개 = <g>(본체 + 상단 하이라이트 + 판정 링) */
function makePiece() {
  const g = document.createElementNS(NS, 'g');
  const ring = document.createElementNS(NS, 'circle');
  ring.setAttribute('r', '13'); ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke-width', '1.5'); ring.setAttribute('opacity', '0');
  const body = document.createElementNS(NS, 'rect');
  body.setAttribute('x', '-9'); body.setAttribute('y', '-5.5');
  body.setAttribute('width', '18'); body.setAttribute('height', '11');
  body.setAttribute('rx', '2.5');
  const hi = document.createElementNS(NS, 'rect');
  hi.setAttribute('x', '-6.5'); hi.setAttribute('y', '-3.5');
  hi.setAttribute('width', '13'); hi.setAttribute('height', '2'); hi.setAttribute('rx', '1');
  hi.setAttribute('fill', 'var(--surface)'); hi.setAttribute('opacity', '0.45');
  g.appendChild(ring); g.appendChild(body); g.appendChild(hi);
  return g;
}

function paintPieces() {
  const host = $('piecesG');
  if (!host || !geo) return;
  const items = reducedMotion() ? staticPieces() : flight;
  while (host.childElementCount < items.length) host.appendChild(makePiece());

  for (let i = 0; i < host.childElementCount; i++) {
    const el = host.children[i];
    if (i >= items.length) { el.setAttribute('opacity', '0'); continue; }
    const it = items[i], g = geo[it.lane];
    if (!g) { el.setAttribute('opacity', '0'); continue; }

    const s = it.p != null ? it : sampleTL(it.el);
    const p = it.p != null ? it.p : s.p;
    const revealed = it.revealed != null ? it.revealed : (it.el >= JUDGE_AT + 220);
    const pos = posOf(it.lane, p, it.grade);
    const col = revealed ? GTOK[it.grade] : 'var(--text-muted)';

    el.setAttribute('transform', `translate(${pos.x.toFixed(1)} ${pos.y.toFixed(1)})`);
    el.setAttribute('opacity', p > 0.99 ? String(Math.max(0, (1.04 - p) / 0.05)) : '1');
    el.children[1].setAttribute('fill', col);

    /* 판정 체류 중 링 펄스 */
    const ring = el.children[0];
    if (s.st === 2) {
      const t = s.ht;
      ring.setAttribute('stroke', revealed ? col : FAMTOK[it.lane]);
      ring.setAttribute('r', (10 + t * 8).toFixed(1));
      ring.setAttribute('opacity', (0.55 * (1 - t)).toFixed(2));
    } else {
      ring.setAttribute('opacity', '0');
    }
  }
}

function stageLoop(t) {
  if (!lastT) lastT = t;
  const dt = Math.min(80, t - lastT);
  lastT = t;
  const k = state.speed;
  for (let i = 0; i < flight.length; i++) flight[i].el += dt * k;
  flight = flight.filter(it => it.el < TL_TOTAL);

  /* 벨트 텍스처 이송 */
  beltOff = (beltOff + dt * 0.045 * k) % 14;
  FAMS.forEach(f => {
    const b = $('belt-' + f);
    if (b) b.setAttribute('stroke-dashoffset', (-beltOff).toFixed(1));
  });

  paintPieces();
  raf = requestAnimationFrame(stageLoop);
}
function startStage() {
  if (raf || reducedMotion()) { paintPieces(); return; }
  if (!flight.length) seedFlight();
  lastT = 0;
  raf = requestAnimationFrame(stageLoop);
}
function stopStage() { if (raf) { cancelAnimationFrame(raf); raf = null; } }
function syncStage() {
  if (state.tab === 'now' && state.running && state.phase === 'ready') startStage();
  else stopStage();
}

/* ══════════════ 배너 ══════════════ */
function renderBanners() {
  const out = [];
  if (state.ingestFails >= 3) {
    out.push(`<div class="banner banner-bad" role="alert">
      <div><div class="bt">판정 로그 전송이 ${state.ingestFails}회 연속 실패했습니다</div>
      <div class="bd">화면 수치는 정상이지만 Discord 알림과 데일리 리포트는 누락됩니다.
        FastAPI 서버(127.0.0.1:8000)를 재시작한 뒤 재연결하세요.</div></div>
      <div class="bx"><button class="btn btn-primary btn-sm" data-act="retry-api">재연결</button></div>
    </div>`);
  }
  if (state.apiEverAlive && !state.apiAlive) {
    out.push(`<div class="banner banner-warn" role="status">
      <div><div class="bt">연동 서버 연결이 끊겼습니다</div>
      <div class="bd">마지막 연결 성공 <b>${state.lastApiOk ? clockOf(state.lastApiOk) : '기록 없음'}</b>
        · 이후 로그·알림은 전송되지 않았습니다.</div></div>
      <div class="bx"><button class="btn btn-outline btn-sm" data-act="retry-api">다시 확인</button></div>
    </div>`);
  }
  if (!L) {
    out.push(`<div class="banner banner-warn" role="status">
      <div><div class="bt">라인 정보를 읽지 못해 제품군 단위로만 표시합니다</div>
      <div class="bd">lines.js가 index.html과 같은 폴더에 있는지 확인하세요.
        라인 필터와 라인별 불량률은 숨겨집니다.</div></div>
    </div>`);
  }
  if (!state.running && state.phase === 'ready') {
    out.push(`<div class="banner banner-warn" role="status">
      <div><div class="bt">재생이 멈춰 있어 화면이 과거 시점에 고정돼 있습니다</div>
      <div class="bd">기준시각 <b>${clockOf(state.vclock)}</b> 이후 새 판정이 들어오지 않았습니다.</div></div>
      <div class="bx"><button class="btn btn-primary btn-sm" data-act="resume">재생 시작</button></div>
    </div>`);
  }
  $('banners').innerHTML = out.join('');
}

/* ══════════════ 01 현황 ══════════════ */
function renderKPI() {
  const a = agg();
  const bk = buckets(20);
  const waiting = filteredRisk().filter(r => r.wf !== '완료').length;
  const done = filteredRisk().filter(r => r.wf === '완료').length;
  const queued = filteredRisk().length;
  const scope = state.filterFam === 'all' ? '전체' : state.filterFam + ' 제품군';

  const cards = [
    { lab: '불량률 · ' + scope,
      tip: '판정 등급 0 또는 2의 비율. 0은 규격 하한, 2는 상한 이탈로 <b>둘 다 불량</b>입니다.',
      val: a.total ? f1d(a.defect) : '–', unit: a.total ? '%' : '',
      delta: a.total ? deltaHTML(a.defect - a.baseDefect, 'inverse', '%p',
        '학습 기준 ' + f1d(a.baseDefect) + '%') : '<span class="flat">집계 중</span>',
      ctxL: '누적 판정 ' + fmtCount(a.total) + '건',
      ctxR: sparkline(bk.map(b => b.defect),
        { color: a.defect > a.baseDefect ? 'var(--bad)' : 'var(--good)', target: a.baseDefect }) },
    { lab: '불량 검출률 · ' + scope,
      tip: '실제 불량 중 불량으로 판정한 비율(재현율). 놓친 불량이 곧 유출 위험이라 정확도보다 이 값을 봅니다.',
      val: a.recallTot ? f1d(a.recall) : '–', unit: a.recallTot ? '%' : '',
      delta: a.recallTot ? deltaHTML(a.recall - a.baseRecall, 'normal', '%p',
        '학습 ' + f1d(a.baseRecall) + '%') : '<span class="flat">집계 중</span>',
      ctxL: '실제 불량 ' + fmtCount(a.recallTot) + '건 중 ' + fmtCount(a.recallHit) + '건 검출',
      ctxR: sparkline(bk.map(b => b.recall), { color: 'var(--seq-4)', target: a.baseRecall }) },
    { lab: '재검 대기',
      tip: '재검을 아직 시작하지 않은 건수. 밀리면 불량 제품이 라인에 남습니다.',
      val: fmtCount(waiting), unit: '건',
      delta: deltaHTML(waiting - QUEUE_OK, 'inverse', '건', '적정 ' + QUEUE_OK + '건'),
      ctxL: '검출 ' + fmtCount(queued) + '건 · 완료 ' + fmtCount(done) + '건',
      ctxR: '' }
  ];

  $('kpiRow').innerHTML = cards.map((c, i) => `<div class="card kpi${i === 0 ? ' hero' : ''}">
    <div class="klab">${c.lab}${infoTip(c.tip)}</div>
    <div class="kval">${c.val}<span class="unit">${c.unit}</span></div>
    <div class="kdelta">${c.delta}</div>
    <div class="kctx"><span>${c.ctxL}</span><span style="flex-shrink:0">${c.ctxR}</span></div>
  </div>`).join('');
}

function renderTrend() {
  const a = agg();
  const bk = buckets(20);
  // if (bk.length < 2) {
  //   $('trendTitle').textContent = '불량률 추이 · 집계 중';
  //   $('trendMeta').textContent = '단위 % · 20건 단위 집계';
  //   $('trendChart').innerHTML = emptyState('추이를 만들 표본이 부족합니다',
  //     '20건 단위로 집계하며 최소 2구간(40건)이 필요합니다. 현재 ' + fmtCount(a.total) + '건.',
  //     '<button class="btn btn-subtle btn-sm" data-act="resume">재생 시작</button>');
  //   return;
  // }
  const s = bk.map(b => b.defect);
  const dd = s[s.length - 1] - s[0];
  $('trendTitle').textContent = '불량률 추이';
    // ? '불량률이 구간 시작 대비 ' + f1d(Math.abs(dd)) + '%p 감소'
    // : dd >= 0.5 ? '불량률이 구간 시작 대비 ' + f1d(dd) + '%p 증가'
    // : '불량률이 ' + f1d(s[s.length - 1]) + '% 수준에서 횡보';
  // $('trendMeta').textContent = '단위 % · 20건 단위 집계 · n=' + fmtCount(bk.length * 20)
  //   + '건 · 점선은 학습 기준선 ' + f1d(a.baseDefect) + '%';
  $('trendChart').innerHTML = lineChart(s, {
    h:160, w: hostWidth('trendChart'), unit: '%', target: a.baseDefect,
    targetLabel: '학습 기준 ' + f1d(a.baseDefect) + '%',
    color: s[s.length - 1] > a.baseDefect ? 'var(--bad)' : 'var(--c1)',
    label: '불량률', xFirst: '오래된 구간', xLast: '최근 구간'
  });
}

function renderLineRank() {
  const card = $('lineRankChart') && $('lineRankChart').closest('.card');
  if (!L) { if (card) card.hidden = true; return; }
  const rows = LINES.map(ln => ({
    ln, fam: LINE_FAM[ln], n: state.totLine[ln],
    defect: pct(state.cntLine[ln][0] + state.cntLine[ln][2], state.totLine[ln]),
    base: (LINE_BASE[ln] || { defect: 0 }).defect * 100
  })).filter(r => activeLines().indexOf(r.ln) >= 0 && r.n > 0)
     .sort((x, y) => y.defect - x.defect);

  if (!rows.length) {
    $('lineRankTitle').textContent = '라인별 불량률';
    $('lineRankMeta').textContent = '단위 % · 세로선은 학습 기준선';
    $('lineRankChart').innerHTML = emptyState('집계된 라인이 없습니다',
      '재생을 시작하면 라인별로 나뉩니다.',
      '<button class="btn btn-subtle btn-sm" data-act="resume">재생 시작</button>');
    return;
  }

  const worst = rows[0], best = rows[rows.length - 1];
  $('lineRankTitle').textContent = worst.ln + ' 불량률 ' + f1d(worst.defect) ;
    // + '% — 최저 ' + best.ln + '보다 '
    //   + f1d(worst.defect - best.defect) + '%p 높음'
    // : worst.ln + ' 불량률 ' + f1d(worst.defect) + '%';
  // $('lineRankMeta').textContent = '단위 % · 세로선은 학습 기준선 · n='
  //   + fmtCount(rows.reduce((s, r) => s + r.n, 0)) + '건 · 색은 제품군(A·TO)';

  const max = Math.max.apply(null, rows.map(r => Math.max(r.defect, r.base))) * 1.15 || 1;
  $('lineRankChart').innerHTML = hbars(rows.map(r => ({
    label: famBadge(r.fam) + ' <b>' + r.ln + '</b>',
    pct: r.defect / max * 100, marker: r.base / max * 100,
    color: r.defect > r.base ? 'var(--bad)' : FAMTOK[r.fam],
    value: f1d(r.defect) + '%'
  })));
}

function renderLineHead() {
  const badge = $('lineBadge'), hint = $('motionHint');
  const stopped = reducedMotion();
  badge.innerHTML = '<span class="sd"></span>' +
    (stopped ? '정지 표시' : state.running ? '이송 중' : '일시정지');
  badge.className = 'badge ' + (!stopped && state.running ? 'b-good' : 'b-neutral');

  if (!hint) return;
  if (stopped && motionPref === 'auto') {
    hint.innerHTML = `<div class="banner banner-warn" style="margin:0 0 var(--s4)">
      <div><div class="bt">시스템 애니메이션 설정이 꺼져 있어 정지 화면입니다</div>
      <div class="bd">OS 설정을 바꾸지 않고 여기서만 켤 수 있습니다.</div></div>
      <div class="bx"><button class="btn btn-primary btn-sm" data-act="motion-on">모션 켜기</button></div>
    </div>`;
  } else if (stopped && motionPref === 'off') {
    hint.innerHTML = `<div class="t-cap" style="margin-bottom:var(--s3)">
      모션을 끈 상태 — 최근 판정을 정지 표시합니다.
      <button class="btn btn-subtle btn-xs" data-act="motion-on"
        style="margin-left:var(--s2)">모션 켜기</button></div>`;
  } else {
    hint.innerHTML = '';
  }
}

/* ══════════════ 02 판정 스트림 ══════════════ */
function filteredStream() {
  const lines = activeLines();
  const q = (state.search || '').toLowerCase();
  return state.stream.filter(r => r.line && lines.indexOf(r.line) >= 0
    && (!q || String(r.id).toLowerCase().indexOf(q) >= 0));
}

function renderStream() {
  const rows = filteredStream();
  $('streamCount').innerHTML = '<span class="sd"></span>' + fmtCount(rows.length) + '건';
  if (!rows.length) {
    $('streamHost').innerHTML = (state.filterFam !== 'all' || state.filterLine !== 'all')
      ? emptyState('선택한 조건의 판정이 없습니다',
          '현재 조건: ' + filterText() + '. 조건을 넓히면 결과가 나타납니다.',
          '<button class="btn btn-subtle btn-sm" data-act="reset-filter">조건 초기화</button>')
      : emptyState('아직 판정된 제품이 없습니다',
          '재생을 시작하면 90초마다 한 건씩 판정 결과가 쌓입니다.',
          '<button class="btn btn-subtle btn-sm" data-act="resume">재생 시작</button>');
    return;
  }
  const pages = Math.max(1, Math.ceil(rows.length / state.perPage));
  if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * state.perPage;
  const view = rows.slice(start, start + state.perPage);

  $('streamHost').innerHTML = `<div class="tablewrap">
    <table class="dt dense">
      <thead><tr><th>공정시각</th><th>제품 ID</th><th>제품군</th><th>라인</th>
        <th class="c">판정 등급</th><th class="r">신뢰도</th></tr></thead>
      <tbody>${view.map(r => `<tr class="rowsel" data-seq="${r.seq}"
        aria-selected="${state.selected === r.seq}" tabindex="0">
        <td data-h="공정시각" class="mono sec">${clockOf(r.vt)}</td>
        <td data-h="제품 ID" class="mono">${esc(r.id)}</td>
        <td data-h="제품군">${famBadge(r.fam)}</td>
        <td data-h="라인">${lineChip(r.id, r.fam)}</td>
        <td data-h="판정 등급" class="c">${gradeBadge(r.pred)}</td>
        <td data-h="신뢰도" class="r"><span class="cbar"><span class="track"
          ><i style="width:${(r.conf * 100).toFixed(0)}%"></i></span>
          <span class="mono">${f0d(r.conf * 100)}%</span></span></td></tr>`).join('')}</tbody>
    </table>
    <div class="tblfoot">
      <span>${fmtCount(rows.length)}건 중 ${start + 1}–${Math.min(start + state.perPage, rows.length)}</span>
      <span class="pager">
        <button data-act="page-prev" ${state.page <= 1 ? 'disabled' : ''} aria-label="이전 페이지">‹</button>
        <span class="num">${state.page} / ${pages}</span>
        <button data-act="page-next" ${state.page >= pages ? 'disabled' : ''} aria-label="다음 페이지">›</button>
      </span></div></div>`;
}

function renderDrill() {
  const rec = state.stream.concat(state.risk).filter(r => r.seq === state.selected)[0];
  if (!rec) {
    $('drillSub').textContent = '스트림에서 제품을 선택하세요.';
    $('drillBody').innerHTML = emptyState('선택된 제품이 없습니다',
      '왼쪽 표에서 행을 선택하면 어떤 센서가 판정을 끌어당겼는지 표시합니다.');
    return;
  }
  $('drillSub').innerHTML = `${famBadge(rec.fam)} ${lineChip(rec.id, rec.fam)}
    <b class="mono">${esc(rec.id)}</b> ·
    실제 등급 ${rec.actual} ${LABELS[rec.actual]}
    · 결측 ${rec.miss}/${D[rec.fam].sensor_cols.length}`;

  const imp = IMPORTANCE[rec.fam];
  const rows = D[rec.fam].sensors.map((s, i) => {
    const val = rec.v[i], im = imp[s.code] || 0.03;
    if (val == null) return { s, val: null, contrib: im * 0.6, missing: true };
    const z = s.std ? (val - s.mean) / s.std : 0;
    const ucl = s.mean + 3 * s.std, lcl = s.mean - 3 * s.std;
    const out = val > ucl ? 'hi' : (val < lcl ? 'lo' : 'ok');
    return { s, val, z, ucl, lcl, out, contrib: im * (0.4 + Math.abs(z)), missing: false };
  }).sort((a, b) => b.contrib - a.contrib).slice(0, 5);
  const maxc = Math.max.apply(null, rows.map(r => r.contrib)) || 1;

  const head = rec.pred === 1
    ? '<span class="badge b-good"><span class="sd"></span>1 정상 · 규격 이내</span>'
    : rec.pred === 0
    ? '<span class="badge b-bad"><span class="sd"></span>0 불량 · 규격 하한 이탈</span>'
    : '<span class="badge b-warn"><span class="sd"></span>2 불량 · 규격 상한 이탈</span>';

  $('drillBody').innerHTML = head + '<div class="drill">' + rows.map(r => {
    const nm = `<span class="d-nm"><b>${esc(r.s.name)}</b> <span class="mono muted">${r.s.code}</span></span>`;

    if (r.missing) return `<div class="drow2"><div class="d-top">${nm}
      <span class="d-flag warn">결측(신호)</span></span></div>
      <div class="d-bar"><i style="width:${(r.contrib / maxc * 100).toFixed(0)}%;background:var(--warn)"></i></div></div>`;
    const flag = r.out === 'hi' ? `<span class="d-flag hi">▲ 상한 +${f2d(r.val - r.ucl)} 초과</span>`
      : r.out === 'lo' ? `<span class="d-flag lo">▼ 하한 ${f2d(r.val - r.lcl)} 미달</span>`
      : '<span class="d-flag ok">정상 범위</span>';
    const col = r.out !== 'ok' ? 'var(--seq-6)' : 'var(--seq-4)';
    return `<div class="drow2"><div class="d-top">${nm}
      <span class="d-vf"><b class="mono">${f2d(r.val)}</b>
        <span class="muted mono">정상 ${f1d(r.lcl)}~${f1d(r.ucl)}</span>${flag}</span></div>
      <div class="d-bar"><i style="width:${(r.contrib / maxc * 100).toFixed(0)}%;background:${col}"></i></div></div>`;
  }).join('') + '</div>' +
    `<div class="t-cap" style="margin-top:var(--s3)">막대 = 기여도 순 · +/− 값은 정상범위(±3σ)까지 조정 목표량</div>`;
}

/* ══════════════ 03 정밀검사 ══════════════ */
const INSPECT_MS = 12 * 60 * 1000;   /* 재검 소요 = 공정시계 12분 */

function filteredRisk() {
  const lines = activeLines();
  return state.risk.filter(r => r.line && lines.indexOf(r.line) >= 0);
}
/* 검사중 항목은 공정시계가 흐르면 자동으로 완료 처리되고 큐에서 빠집니다 */
function advanceInspections() {
  let done = 0;
  state.risk.forEach(r => {
    if (r.wf === '검사중' && r.tStart != null && state.vclock - r.tStart >= INSPECT_MS) {
      r.wf = '완료';
      r.tDone = state.vclock;
      done++;
    }
  });
  if (done) pushAlert('info', '재검 완료 ' + done + '건', '검사가 끝나 큐에서 제외되었습니다',
    state.vclock);
  return done;
}
function startInspect(rec) {
  if (rec.wf !== '대기') return false;
  rec.wf = '검사중';
  rec.tStart = state.vclock;
  return true;
}

function renderRisk() {
  const all = filteredRisk();
  const rows = all.filter(r => r.wf !== '완료');
  const waiting = all.filter(r => r.wf === '대기').length;
  const doing = all.filter(r => r.wf === '검사중').length;
  const done = all.filter(r => r.wf === '완료').length;
  const oldest = rows.slice(-1)[0];

  $('riskStrip').innerHTML = [
    ['대기', fmtCount(waiting) + '건'], ['검사중', fmtCount(doing) + '건'],
    ['완료', fmtCount(done) + '건'],
    ['가장 오래된 대기', oldest ? clockOf(oldest.vt) : '없음']
  ].map(x => `<div class="si"><span class="sl">${x[0]}</span><span class="sv">${x[1]}</span></div>`).join('');
  const bulk = $('bulkBtn');
  if (bulk) {
    bulk.disabled = !waiting;
    bulk.textContent = waiting ? '전체 재검사 시작 (' + fmtCount(waiting) + '건)' : '대기 없음';
  }

  if (!rows.length) {
    $('riskHost').innerHTML = all.length
      ? emptyState('미처리 건이 없습니다',
          '검출된 ' + fmtCount(all.length) + '건 모두 재검이 종료되었습니다.')
      : (state.filterFam !== 'all' || state.filterLine !== 'all')
      ? emptyState('선택한 조건에서 검출된 불량이 없습니다',
          '현재 조건: ' + filterText() + '.',
          '<button class="btn btn-subtle btn-sm" data-act="reset-filter">조건 초기화</button>')
      : emptyState('규격 이탈 제품이 없습니다',
          '0·2 등급이 검출되면 이 큐에 자동으로 올라오고 n8n을 통해 Discord로 알림이 갑니다.');
    return;
  }

  $('riskHost').innerHTML = `<div class="tablewrap">
    <table class="dt">
      <thead><tr><th>제품 ID</th><th>제품군</th><th>라인</th><th class="c">판정 등급</th>
        <th>검출 시각</th><th class="c">재검 상태</th><th class="r">조치</th></tr></thead>
      <tbody>${rows.slice(0, 10).map(r => {
        const insp = r.wf === '검사중';
        const prog = insp ? Math.min(1, (state.vclock - r.tStart) / INSPECT_MS) : 0;
        const leftMin = insp ? Math.max(0, Math.ceil((INSPECT_MS * (1 - prog)) / 60000)) : 0;
        return `<tr class="rowsel" data-seq="${r.seq}">
        <td data-h="제품 ID" class="mono">${esc(r.id)}</td>
        <td data-h="제품군">${famBadge(r.fam)}</td>
        <td data-h="라인">${lineChip(r.id, r.fam)}</td>
        <td data-h="판정 등급" class="c">${gradeBadge(r.pred)}</td>
        <td data-h="검출 시각" class="mono sec">${clockOf(r.vt)}</td>
        <td data-h="재검 상태" class="c">${insp
          ? `<span class="badge b-neutral"><span class="sd"></span>검사중 ${leftMin}분</span>`
          : '<span class="badge b-warn"><span class="sd"></span>대기</span>'}</td>
        <td data-h="조치" class="r">${insp
          ? `<span class="cbar"><span class="track"><i style="width:${(prog * 100).toFixed(0)}%"
              ></i></span></span>`
          : `<button class="btn btn-outline btn-xs" data-wf="${r.seq}">재검사 시작</button>`}</td>
      </tr>`;
      }).join('')}</tbody>
    </table>
    <div class="tblfoot"><span>미처리 ${fmtCount(rows.length)}건 중 10건 · 최근 검출 순</span>
      <span class="sec">검사중은 공정시계 ${INSPECT_MS / 60000}분 뒤 자동 완료</span></div>
  </div>`;
}

function renderAlerts() {
  if (!state.alerts.length) {
    $('alertBody').innerHTML = emptyState('알림이 없습니다',
      '불량 검출과 센서 관리한계 이탈이 발생하면 여기에 기록됩니다.');
    return;
  }
  $('alertBody').innerHTML = '<div class="feed">' + state.alerts.slice(0, 10).map(a =>
    `<div class="fitem k-${a.kind}"><span class="fdot"></span>
      <div class="fm"><div class="ft">${esc(a.title)}</div><div class="fd">${esc(a.desc)}</div></div>
      <div class="fx">${clockOf(a.vt)}</div></div>`).join('') + '</div>';
}

/* ══════════════ 04 진단 ══════════════ */
function renderSensors() {
  const w = Math.max(200, Math.min(420, hostWidth('sensHost') - 340));
  $('sensHost').innerHTML = WATCH.map(item => {
    const st = sstat(item.fam, item.code);
    const arr = state.spark[item.fam][item.code] || [];
    const cur = arr.slice().reverse().filter(a => a.v != null)[0];
    const ucl = st.mean + 3 * st.std, lcl = st.mean - 3 * st.std;
    const out = cur && (cur.v > ucl || cur.v < lcl);
    const imp = IMPORTANCE[item.fam][item.code] || 0;
    return `<div class="srow">
      <div>
        <div class="sn">${famBadge(item.fam)} ${item.code}</div>
        <small>${esc(st.name)} · 중요도 ${f1d(imp * 100)}%</small>
      </div>
      <div>${sensorSpark(arr, st, w, 44)}</div>
      <div class="sv">
        <span class="v" style="color:${out ? 'var(--bad)' : 'var(--text)'}"
          >${cur ? f2d(cur.v) : '—'}</span>
        <span class="lim">한계 ${f1d(lcl)}~${f1d(ucl)}</span>
        <span class="badge ${out ? 'b-bad' : 'b-good'}" style="margin-top:4px"
          ><span class="sd"></span>${out ? '이탈' : '정상'}</span>
      </div></div>`;
  }).join('') + `<div class="t-cap" style="margin-top:var(--s3)">최근 40건 · 끊긴 구간 = 결측</div>`;
}

function renderPerf() {
  $('perfGrid').innerHTML = FAMS.map(f => {
    const p = D.meta.perf[f], m = state.confusion[f];
    const [hit, tot] = famRecall(f);
    const opRecall = tot ? pct(hit, tot) : null;
    const baseR = BASE_RECALL[f] * 100;
    const missed = m[0][1] + m[2][1];          // 실제 불량 → 정상 판정
    const over = m[1][0] + m[1][2];            // 실제 정상 → 불량 판정
    const n = m.reduce((s, r) => s + r.reduce((a, b) => a + b, 0), 0);
    return `<div class="card">
      <div class="cardhead"><h3>${f} 제품군 · ${p.model}</h3>${famBadge(f)}
        <span class="badge b-neutral"><span class="sd"></span>n=${fmtCount(n)}건</span></div>
      <div class="klab" style="margin-bottom:var(--s1)">불량 검출률 · 운영
        ${infoTip('실제 불량 중 불량으로 판정한 비율. 재생 중 누적값입니다.')}</div>
      <div class="kval">${opRecall == null ? '–' : f1d(opRecall) + '<span class="unit">%</span>'}</div>
      <div class="kdelta" style="font-size:12px;font-weight:600;display:flex;gap:var(--s1)">
        ${opRecall == null ? '<span class="flat">집계 중</span>'
          : deltaHTML(opRecall - baseR, 'normal', '%p', '학습 ' + f1d(baseR) + '%')}</div>

      <div class="strip" style="margin:var(--s4) 0">
        <div class="si"><span class="sl">놓친 불량</span>
          <span class="sv" style="color:var(--bad)">${fmtCount(missed)}건</span></div>
        <div class="si"><span class="sl">과검</span><span class="sv">${fmtCount(over)}건</span></div>
        <div class="si"><span class="sl">평가셋 macro-F1</span><span class="sv">${f3d(p.macro_f1)}</span></div>
      </div>

      <div class="t-brow" style="margin-bottom:var(--s3)">등급별 F1 · 평가셋</div>
      ${hbars(p.f1.map((v, g) => ({ label: gradeBadge(g), pct: v * 100,
        color: GTOK[g], value: f3d(v) })))}
      <div class="t-cap" style="margin-top:var(--s3)">정확도 ${f3d(p.acc)} — 불균형 착시라 쓰지 않음 ·
        누출 제거 후 검출률 ${f3d(p.recall0_before)} → <b>${f3d(p.recall0_after)}</b></div>
    </div>`;
  }).join('');
}

function renderReliability() {
  const mRows = FAMS.map(f => {
    const mw = state.missWindow[f];
    const avg = mw.length ? mw.reduce((a, b) => a + b, 0) / mw.length : 0;
    return { f, avg: avg * 100, n: mw.length, cols: D[f].sensor_cols.length };
  });
  const drift = [];
  FAMS.forEach(f => KEY[f].forEach(code => {
    const st = sstat(f, code), win = state.driftWin[f][code];
    if (!win.length) return;
    const cur = win.reduce((a, b) => a + b, 0) / win.length;
    drift.push({ f, code, z: st.std ? (cur - st.mean) / st.std : 0, n: win.length });
  }));
  drift.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));

  const missHTML = hbars(mRows.map(r => ({
    label: famBadge(r.f) + ' <span class="sec">센서 ' + r.cols + '개</span>',
    pct: r.avg, color: r.avg > 30 ? 'var(--warn)' : 'var(--seq-3)', value: f1d(r.avg) + '%'
  })));
  const driftHTML = drift.length ? drift.map(r => {
    const cl = Math.max(-3, Math.min(3, r.z));
    const left = 50 + Math.min(0, cl) / 3 * 50, w = Math.abs(cl) / 3 * 50;
    const over = Math.abs(r.z) > 2;
    return `<div class="drow"><div>${famBadge(r.f)} <b>${r.code}</b></div>
      <div class="dtrack"><span class="mid"></span>
        <i class="${over ? 'over' : ''}" style="left:${left.toFixed(1)}%;width:${w.toFixed(1)}%"></i></div>
      <div class="mono" style="text-align:right;color:${over ? 'var(--warn-text)' : 'var(--text)'}"
        >z=${f2d(r.z)}</div></div>`;
  }).join('') : '<div class="t-cap muted">수집 중</div>';

  $('relHost').innerHTML = `
    <div class="t-brow" style="margin-bottom:var(--s3)">결측률 · % · 최근 ${mRows[0].n || 0}건 평균</div>
    ${missHTML}
    <div class="t-cap" style="margin:var(--s3) 0 var(--s5)">A는 센서 약 <b>${f0d(mRows[0].avg)}%</b> 상시 결측</div>
    <div class="t-brow" style="margin-bottom:var(--s2)">드리프트 · σ · 가운데가 학습 평균</div>
    ${driftHTML}`;

  $('lineage').innerHTML = [
    ['판정값', '회귀 모델이 예측한 Y_Quality 값<br>KFold 오차 폭 (A ' + f4d(RMSE.A) + ' · TO ' + f4d(RMSE.TO) + ')'],
    ['등급화', '예측값을 임계값으로 잘라 등급 부여 <br>A ' + f4d(THR.A.t01) + ' / ' + f4d(THR.A.t12) + ' · TO ' + f4d(THR.TO.t01) + ' / ' + f4d(THR.TO.t12)],
    ['평가셋 성능', '학습 시점에 고정된 macro-F1 · 등급별 F1 <br>누출 제거 후 재학습한 기준'],
    ['운영 성능', '검출률 · 놓친 불량 · 과검 <br>재생 중 누적되므로 표본이 늘면 값이 변동'],
    ['피처 중요도', '모델 내장 gain importance (학습셋 기준)'],
    ['기여도', 'gain importance × |z| 근사값 <br>SHAP 아님 · 순위 참고용'],
    ['관리한계', '학습 데이터 평균 ±3σ'],
    ['결측 처리', '평균 대체 없이 결측 자체를 분기 신호로 사용'],
    ['기준선', '학습 데이터의 실제 등급 분포 <br>전체 ' + f1d(BASE.ALL.defect * 100) + '% · A '
      + f1d(BASE.A.defect * 100) + '% · TO ' + f1d(BASE.TO.defect * 100) + '%)'],
    ['라인(호기)', 'train_식별컬럼매칭완료.csv 의 LINE 실측값 <br>제품 ID 908건 전수 매칭 · '
      + LINES.length + '개 라인 (A ' + (FAM_LINES.A || []).length + ' · TO '
      + (FAM_LINES.TO || []).length + ')'],
    ['라인 기준선', '학습 데이터 실제 Y_Class 기준, 라인별 불량률'],
    ['재검 소요', '공정시계 ' + (INSPECT_MS / 60000) + '분 <br>검사중 상태가 지나면 자동 완료'],
    ['원천 데이터', '선택피처 데이터셋 <br>A 316행 · TO 592행']
  ].map(r => `<div class="lrow"><div class="lk">${r[0]}</div><div>${r[1]}</div></div>`).join('');
}

/* ══════════════ 다이얼 ══════════════ */
function bindDial(id, fam, key) {
  const el = $(id), lab = $(id + 'lab');
  el.value = THR[fam][key];
  lab.textContent = f4d(+el.value);
  el.addEventListener('input', () => {
    THR[fam][key] = +el.value;
    lab.textContent = f4d(+el.value);
  });
}

/* ══════════════ 06 AI 에이전트 ══════════════ */
const srcBadge = s => s === 'live'
  ? '<span class="ai-src live">LIVE · AI</span>'
  : '<span class="ai-src sim">SIM</span>';

/* AI/SIM 텍스트 → 가벼운 마크다운 렌더 (굵게·불릿·소제목) */
function mdLite(t) {
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                            .replace(/_(.+?)_/g, '<em>$1</em>');
  const lines = String(t == null ? '' : t).split(/\r?\n/);
  let html = '', inList = false;
  lines.forEach(ln => {
    const li = ln.match(/^\s*[-•*]\s+(.*)/);
    const hd = ln.match(/^\s*#{1,4}\s+(.*)/);
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(li[1]) + '</li>'; return; }
    if (inList) { html += '</ul>'; inList = false; }
    if (hd) { html += '<h4>' + inline(hd[1]) + '</h4>'; return; }
    if (ln.trim() === '') { html += '<div style="height:6px"></div>'; return; }
    html += '<div>' + inline(ln) + '</div>';
  });
  if (inList) html += '</ul>';
  return html;
}

/* 현재 대시보드 상태를 AI 컨텍스트로 요약 */
function buildAIContext() {
  const a = agg();
  const scope = state.filterFam === 'all' ? '전체' : state.filterFam + ' 제품군';
  let worst = [];
  if (L) {
    worst = LINES.map(ln => ({
      line: ln, fam: LINE_FAM[ln], n: state.totLine[ln],
      defect: +f1d(pct(state.cntLine[ln][0] + state.cntLine[ln][2], state.totLine[ln])),
      base: +f1d((LINE_BASE[ln] || { defect: 0 }).defect * 100)
    })).filter(r => activeLines().indexOf(r.line) >= 0 && r.n > 0)
      .sort((x, y) => y.defect - x.defect).slice(0, 5);
  }
  const family = {};
  FAMS.forEach(f => {
    const n = famTotal(f);
    family[f] = { n, defect: +f1d(pct(famCount(f, 0) + famCount(f, 2), n)),
                  base: +f1d(BASE[f].defect * 100) };
  });
  const sensors = [];
  WATCH.forEach(item => {
    const st = sstat(item.fam, item.code);
    const arr = state.spark[item.fam][item.code] || [];
    const cur = arr.slice().reverse().filter(x => x.v != null)[0];
    if (!cur) return;
    const ucl = st.mean + 3 * st.std, lcl = st.mean - 3 * st.std;
    const status = cur.v > ucl ? '상한초과' : (cur.v < lcl ? '하한미달' : '정상');
    sensors.push({ code: item.code, name: st.name, fam: item.fam,
      value: +f2d(cur.v), limit: [+f1d(lcl), +f1d(ucl)], status });
  });
  return {
    asOf: clockOf(state.vclock), scope, total: a.total,
    defect_rate: a.total ? +f1d(a.defect) : null,
    base_defect_rate: +f1d(a.baseDefect),
    detection_rate: a.recallTot ? +f1d(a.recall) : null,
    recheck_pending: filteredRisk().filter(r => r.wf !== '완료').length,
    family, worst_lines: worst, sensors
  };
}

/* SIM 폴백 — n8n/AI 미연동 시 규칙 기반 응답 */
function simAI(mode, q, c) {
  const worst = (c.worst_lines && c.worst_lines[0]) || null;
  const oos = (c.sensors || []).filter(s => s.status !== '정상');
  if (mode === 'report') {
    let o = '## 진단 요약\n';
    o += '현재 ' + c.scope + ' 불량률은 **' + (c.defect_rate == null ? '집계 중' : c.defect_rate + '%')
       + '** (학습 기준 ' + c.base_defect_rate + '%). 재검 대기 ' + c.recheck_pending + '건.\n\n';
    o += '## 의심 원인\n';
    if (worst) o += '- **' + worst.line + '** 라인 불량률 ' + worst.defect + '% (기준 ' + worst.base + '%) — 최우선 점검\n';
    oos.forEach(s => o += '- 센서 **' + s.code + '** (' + s.name + ') ' + s.status + ', 값 ' + s.value
       + ' / 정상 ' + s.limit[0] + '~' + s.limit[1] + '\n');
    if (!worst && !oos.length) o += '- 이상 라인·이탈 센서 없음. 표본 누적 중\n';
    o += '\n## 권장 조치\n- 위 라인의 ±3σ 이탈 공정 변수부터 점검\n- 재검 대기건 우선 배정으로 유출 방지\n';
    o += '\n_SIM 응답 — n8n+AI 연동 시 실제 분석으로 대체됩니다._';
    return o;
  }
  if (/위험|최악|높/.test(q) && worst)
    return worst.line + ' 라인이 가장 위험합니다. 불량률 **' + worst.defect + '%** 로 학습 기준(' + worst.base + '%)을 웃돕니다.\n\n_SIM 응답_';
  if (/불량률/.test(q) && c.defect_rate != null)
    return '현재 ' + c.scope + ' 불량률은 **' + c.defect_rate + '%** 입니다 (학습 기준 ' + c.base_defect_rate + '%). 검출률 '
      + (c.detection_rate == null ? '집계 중' : c.detection_rate + '%') + '.\n\n_SIM 응답_';
  if (/센서|원인|변수|이탈/.test(q))
    return oos.length
      ? '이탈 센서: ' + oos.map(s => s.code + '(' + s.status + ')').join(', ') + '. 해당 공정 변수부터 점검하세요.\n\n_SIM 응답_'
      : '현재 관리한계를 벗어난 핵심 센서는 없습니다.\n\n_SIM 응답_';
  return '기준시각 ' + c.asOf + ' 기준 불량률 ' + (c.defect_rate == null ? '집계 중' : c.defect_rate + '%')
    + ', 재검 대기 ' + c.recheck_pending + '건입니다. 라인·센서·불량률 중 무엇이 궁금하신가요?\n\n_SIM 응답 — 실제 답변은 AI 연동 후._';
}

/* /ai 릴레이 호출 (실패·미연동 시 SIM 폴백) */
async function askAI(mode, question, context) {
  if (state.apiAlive) {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 60000);
      const r = await fetch(API_BASE + '/ai', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, question, context }), signal: ctl.signal });
      clearTimeout(to);
      if (r.ok) { const j = await r.json(); if (j && j.ok && j.text) return { text: j.text, source: 'live' }; }
    } catch (e) {}
  }
  return { text: simAI(mode, question, context), source: 'sim' };
}

async function aiRunReport() {
  const body = $('aiReportBody'); if (!body) return;
  const btn = $('aiRunBtn'), ctx = buildAIContext();
  if (btn) btn.disabled = true;
  body.dataset.filled = '1';
  body.innerHTML = '<div class="t-cap"><span class="ai-dots"></span> AI가 현재 상태를 진단하는 중…</div>';
  const res = await askAI('report', '', ctx);
  if (btn) btn.disabled = false;
  body.innerHTML = '<div style="display:flex;align-items:center;gap:var(--s2);margin-bottom:var(--s3)">'
    + srcBadge(res.source) + '<span class="t-cap">기준시각 ' + esc(ctx.asOf) + ' · ' + esc(ctx.scope) + '</span></div>'
    + '<div class="ai-report">' + mdLite(res.text) + '</div>';
}

async function aiSendChat() {
  const inp = $('aiChatInput'); if (!inp) return;
  const q = inp.value.trim(); if (!q) return;
  inp.value = '';
  const feed = $('aiChatFeed');
  feed.insertAdjacentHTML('beforeend', '<div class="ai-msg u">' + esc(q) + '</div>');
  const tid = 'aithink' + (state.ai.seq++);
  feed.insertAdjacentHTML('beforeend', '<div class="ai-msg a" id="' + tid + '"><span class="ai-dots"></span></div>');
  feed.scrollTop = feed.scrollHeight;
  const res = await askAI('chat', q, buildAIContext());
  const el = $(tid);
  if (el) el.innerHTML = '<div style="margin-bottom:4px">' + srcBadge(res.source) + '</div>' + mdLite(res.text);
  feed.scrollTop = feed.scrollHeight;
}

/* 03섹션: 불량 알림 AI 해설 히스토리 (현재 SIM 예시 — 실검출 건에 해설 부여) */
function renderAIExplain() {
  const feed = $('aiExplainFeed'); if (!feed) return;
  const items = state.risk.slice(0, 6);
  if (!items.length) {
    feed.innerHTML = emptyState('아직 불량 알림이 없습니다',
      '0·2 등급이 검출되면 AI 해설과 함께 여기에 쌓입니다.');
    return;
  }
  feed.innerHTML = items.map(r => {
    const reason = '규격 ' + (r.pred === 0 ? '하한 이탈(저품질)' : '상한 이탈(고품질)')
      + ' — ' + r.fam + ' 제품군 핵심 공정변수 점검 권장';
    return '<div class="fitem k-crit"><span class="fdot"></span><div class="fm">'
      + '<div class="ft">' + esc(r.id) + ' · 등급 ' + r.pred + ' ' + esc(LABELS[r.pred]) + ' ' + srcBadge('sim') + '</div>'
      + '<div class="fd">' + esc(reason) + '</div></div>'
      + '<div class="fx">' + clockOf(r.vt) + '</div></div>';
  }).join('');
}

/* AI 탭 최초 진입 시 1회 빌드 (틱 재렌더로 대화·리포트가 지워지지 않게 함) */
function renderAI() {
  state.ai.built = true;
  const rb = $('aiReportBody');
  if (rb && !rb.dataset.filled)
    rb.innerHTML = emptyState('진단 대기', '상단 "AI 진단 실행" 버튼을 누르면 현재 상태를 분석합니다.');
  const feed = $('aiChatFeed');
  if (feed && !feed.childElementCount)
    feed.innerHTML = '<div class="ai-msg a">안녕하세요. 현재 공정 품질 데이터를 근거로 답합니다. 무엇이 궁금하신가요? '
      + srcBadge('sim') + '</div>';
  const chips = $('aiChips');
  if (chips && !chips.childElementCount)
    chips.innerHTML = ['지금 어느 라인이 제일 위험해?', '현재 불량률 어때?', '이탈한 센서 있어?']
      .map(q => '<button class="ai-qchip" data-q="' + esc(q) + '">' + esc(q) + '</button>').join('');
  renderAIExplain();
}

$('aiRunBtn') && $('aiRunBtn').addEventListener('click', aiRunReport);
$('aiChatSend') && $('aiChatSend').addEventListener('click', aiSendChat);
$('aiChatInput') && $('aiChatInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); aiSendChat(); }
});
$('aiChips') && $('aiChips').addEventListener('click', e => {
  const b = e.target.closest('button[data-q]');
  if (b) { $('aiChatInput').value = b.dataset.q; aiSendChat(); }
});

/* ══════════════ 탭 ══════════════ */
const TABS = {
  now:    { title: '현황', sub: '지금 정상인가' },
  ai:     { title: 'AI 에이전트', sub: 'AI 진단 · 챗봇 · 해설' },
  stream: { title: '판정 스트림', sub: '제품별 판정 결과와 근거' },
  risk:   { title: '정밀검사', sub: '재검 진행 상황' },
  sensor: { title: '공정 변수', sub: '관리한계 이탈과 원인 센서' },
  data:   { title: '데이터 신뢰성', sub: '결측 · 드리프트 · 임계값' }
};
const TAB_ORDER = Object.keys(TABS);

function selectTab(name, focus) {
  if (!TABS[name]) return;
  state.tab = name;
  TAB_ORDER.forEach(t => {
    const btn = $('tab-' + t), on = t === name;
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    btn.tabIndex = on ? 0 : -1;
    $('panel-' + t).hidden = !on;
  });
  $('pgTitle').textContent = TABS[name].title;
  // $('pgSub').textContent = TABS[name].sub;
  const el = $('pgSub'); // 추가
  if (el) el.textContent = TABS[name].sub; // 추가
  if (focus) $('tab-' + name).focus();
  if (name === 'now') { geo = null; }
  renderActive();
  syncStage();
}

/* ══════════════ 렌더 디스패치 ══════════════ */
let queued = false, lastRender = 0;
function scheduleRender() {
  if (queued) return;
  queued = true;
  setTimeout(() => { queued = false; lastRender = Date.now(); renderActive(); },
    Math.max(0, 250 - (Date.now() - lastRender)));
}

function renderActive() {
  if (state.phase !== 'ready') return;
  $('asOf').textContent = clockOf(state.vclock);
  $('navRisk').textContent = fmtCount(state.risk.filter(r => r.wf !== '완료').length);
  renderBanners();
  renderFilterChips();
  switch (state.tab) {
    case 'now':
      renderKPI();
      if (!geo) buildStage();
      updateStageLabels();
      renderLineHead();
      renderTrend();
      renderLineRank();
      break;
    case 'stream': renderStream(); renderDrill(); break;
    case 'risk':   renderRisk(); renderAlerts(); break;
    case 'sensor': renderSensors(); break;
    case 'data':   renderReliability(); break;
    case 'ai':     if (!state.ai.built) renderAI(); break;
  }
}

function filterText() {
  const p = [];
  if (state.filterFam !== 'all') p.push('제품군 ' + state.filterFam);
  if (state.filterLine !== 'all') p.push('라인 ' + state.filterLine);
  return p.length ? p.join(' · ') : '전체';
}
function renderFilterChips() {
  const on = state.filterFam !== 'all' || state.filterLine !== 'all';
  $('filterChips').innerHTML = on
    ? '적용된 조건 <b>' + filterText() + '</b>' : '조건 <b>전체</b>';
  $('resetFilter').hidden = !on;
}
function resetFilters() {
  state.filterFam = 'all'; state.filterLine = 'all'; state.page = 1;
  syncSeg('segFam', 'fam', 'all');
  buildLineSelect();
  renderActive();
}

/* 라인 select — 제품군 필터에 따라 목록을 좁힘 */
function buildLineSelect() {
  const el = $('selLine');
  if (!el) return;
  if (!L) { el.closest('.fgroup').hidden = true; return; }
  const fams = activeFams();
  const opts = ['<option value="all">전체 (' + fams.map(f => (FAM_LINES[f] || []).length)
    .reduce((a, b) => a + b, 0) + '개 라인)</option>'];
  fams.forEach(f => {
    const ls = FAM_LINES[f] || [];
    if (!ls.length) return;
    opts.push('<optgroup label="' + f + ' 제품군">' + ls.map(ln =>
      '<option value="' + ln + '">' + ln + '</option>').join('') + '</optgroup>');
  });
  el.innerHTML = opts.join('');
  el.value = LINES.indexOf(state.filterLine) >= 0 &&
    fams.indexOf(LINE_FAM[state.filterLine]) >= 0 ? state.filterLine : 'all';
  if (el.value === 'all') state.filterLine = 'all';
}
function syncSeg(hostId, attr, val) {
  const host = $(hostId); // 추가
  if (!host) return; // 추가 
  Array.prototype.forEach.call($(hostId).children, b =>
    b.setAttribute('aria-pressed', b.dataset[attr] === val ? 'true' : 'false'));
}

/* ══════════════ 이벤트 ══════════════ */
$('collapseBtn').addEventListener('click', () => {
  const app = $('app'), on = app.dataset.collapsed === 'true';
  app.dataset.collapsed = on ? 'false' : 'true';
  $('collapseBtn').textContent = on ? '‹' : '›';
  $('collapseBtn').setAttribute('aria-expanded', on ? 'true' : 'false');
  $('collapseBtn').setAttribute('aria-label', on ? '사이드바 접기' : '사이드바 펼치기');
  setTimeout(() => { geo = null; renderActive(); }, 60);
});

TAB_ORDER.forEach((t, i) => {
  const btn = $('tab-' + t);
  btn.addEventListener('click', () => selectTab(t));
  btn.addEventListener('keydown', e => {
    let n = null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') n = (i + 1) % TAB_ORDER.length;
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') n = (i - 1 + TAB_ORDER.length) % TAB_ORDER.length;
    if (e.key === 'Home') n = 0;
    if (e.key === 'End') n = TAB_ORDER.length - 1;
    if (n !== null) { e.preventDefault(); selectTab(TAB_ORDER[n], true); }
  });
});

$('segFam').addEventListener('click', e => {
  const b = e.target.closest('button[data-fam]');
  if (!b) return;
  state.filterFam = b.dataset.fam; state.page = 1;
  syncSeg('segFam', 'fam', state.filterFam);
  buildLineSelect();
  renderActive();
});
$('selLine').addEventListener('change', e => {
  state.filterLine = e.target.value;
  state.page = 1;
  renderActive();
});
const _ss = $('streamSearch');
if (_ss) _ss.addEventListener('input', e => {
  state.search = e.target.value.trim();
  state.page = 1;
  renderActive();
});
$('bulkBtn').addEventListener('click', () => {
  const targets = filteredRisk().filter(r => r.wf === '대기');
  if (!targets.length) return;
  targets.forEach(startInspect);
  pushAlert('info', '전체 재검사 시작 ' + targets.length + '건',
    '공정시계 ' + (INSPECT_MS / 60000) + '분 뒤 순차 완료됩니다', state.vclock);
  renderActive();
});
$('segSpeed')?.addEventListener('click', e => {
  const b = e.target.closest('button[data-speed]');
  if (!b) return;
  state.speed = +b.dataset.speed;
  syncSeg('segSpeed', 'speed', b.dataset.speed);
  startLoop();
});
$('segMotion')?.addEventListener('click', e => {
  const b = e.target.closest('button[data-motion]');
  if (b) setMotion(b.dataset.motion);
});
function setMotion(v) {
  motionPref = v;
  try { localStorage.setItem(MOTION_KEY, v); } catch (e) {}
  syncSeg('segMotion', 'motion', v);
  stopStage();
  flight = [];
  geo = null;
  renderActive();
  syncStage();
}
$('resetFilter').addEventListener('click', resetFilters);
$('playBtn')?.addEventListener('click', () => setRunning(!state.running));

function setRunning(on) {
  state.running = on;
  $('playBtn').textContent = on ? '일시정지' : '재생 시작';
  renderActive();
  syncStage();
}

document.addEventListener('click', e => {
  const act = e.target.closest('[data-act]');
  if (act) {
    const a = act.dataset.act;
    if (a === 'resume') setRunning(true);
    if (a === 'reset-filter') resetFilters();
    if (a === 'retry-api') { state.ingestFails = 0; checkAPI(); }
    if (a === 'motion-on') setMotion('on');
    if (a === 'page-prev') { state.page = Math.max(1, state.page - 1); renderActive(); }
    if (a === 'page-next') { state.page++; renderActive(); }
    return;
  }
  const wf = e.target.closest('button[data-wf]');
  if (wf) {
    const rec = state.risk.filter(r => r.seq === +wf.dataset.wf)[0];
    if (rec && startInspect(rec)) {
      pushAlert('info', '재검사 시작 ' + rec.id,
        (rec.line || rec.fam) + ' · 공정시계 ' + (INSPECT_MS / 60000) + '분 소요', state.vclock);
      renderActive();
    }
    return;
  }
  const tr = e.target.closest('tr.rowsel');
  if (tr) {
    state.selected = +tr.dataset.seq;
    if (state.tab === 'risk') selectTab('stream'); else renderActive();
  }
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const tr = e.target.closest && e.target.closest('tr.rowsel');
  if (tr) { e.preventDefault(); state.selected = +tr.dataset.seq; renderActive(); }
});

$('csvBtn').addEventListener('click', () => {
  const rows = filteredStream();
  if (!rows.length) return;
  const head = ['공정시각','제품ID','제품군','라인','판정등급','등급라벨','예측Y_Quality','신뢰도','결측센서수','센서총수'];
  const lines = [head.join(',')].concat(rows.map(r => [
    clockOf(r.vt), r.id, r.fam, lineOf(r.id, r.fam) || '', r.pred, LABELS[r.pred], f4d(r.yhat),
    f0d(r.conf * 100) + '%', r.miss, D[r.fam].sensor_cols.length].join(',')));
  const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'quality_stream_' + clockOf(state.vclock).replace(/:/g, '') + '.csv';
  a.click();
  URL.revokeObjectURL(url);
});

let rz = null;
window.addEventListener('resize', () => {
  clearTimeout(rz);
  rz = setTimeout(() => { geo = null; renderActive(); }, 180);
});

/* ══════════════ FastAPI / n8n ══════════════ */
const API_BASE =
  ['127.0.0.1', 'localhost'].includes(location.hostname)
    ? 'http://127.0.0.1:8000'
    : 'https://fpdashboard-production.up.railway.app';

/* 시뮬레이션 경계 판정용 키 (일/주/월) */
function dayKey(ms) { const d = new Date(ms); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
function weekKey(ms) { return Math.floor(ms / (7 * 86400000)); }
function monthKey(ms) { const d = new Date(ms); return d.getFullYear() * 12 + d.getMonth(); }

/* 시뮬레이션 경계가 지나면 서버에 해당 주기 리포트 발송 요청 */
function sendReport(period) {
  if (!state.apiAlive) return;
  fetch(API_BASE + '/report_now?period=' + period, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: '{}', keepalive: true }).catch(() => {});
}

function sendIngest(rec) {
  if (!state.apiAlive) return;
  fetch(API_BASE + '/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: rec.id, product_group: rec.fam, grade: rec.pred,
      grade_label: LABELS[rec.pred], y_quality: rec.yhat,
      confidence: +rec.conf.toFixed(3), missing: rec.miss }), keepalive: true })
    .then(r => { if (!r.ok) throw 0; state.ingestFails = 0; })
    .catch(() => { state.ingestFails++; });
}
async function checkAPI() {
  const badge = $('modeBadge'), note = $('modeNote');
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(API_BASE + '/health', { signal: ctl.signal });
    clearTimeout(to);
    if (!r.ok) throw 0;
    const j = await r.json();
    state.apiAlive = true; state.apiEverAlive = true; state.lastApiOk = Date.now();
    badge.className = 'badge ' + (j.n8n_alive ? 'b-good' : 'b-warn');
    badge.innerHTML = '<span class="sd"></span>' + (j.n8n_alive ? '연동 LIVE' : 'API 연결 · n8n 대기');
    note.textContent = j.n8n_alive ? '로그 기록 · 알림 발송 중' : 'n8n 워크플로우가 꺼져 있음';
  } catch (e) {
    state.apiAlive = false;
    badge.className = 'badge b-neutral';
    badge.innerHTML = '<span class="sd"></span>SIM 모드';
    note.textContent = '로그 서버 미연결';
  }
  if (state.phase === 'ready') renderBanners();
}

/* ══════════════ 루프 ══════════════ */
function startLoop() {
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (!state.running || state.phase !== 'ready') return;
    tick(false);
    scheduleRender();
  }, 900 / state.speed);
}

/* ══════════════ 부팅 ══════════════ */
function showSkeletons() {
  $('kpiRow').innerHTML = [0,1,2].map(() => `<div class="card kpi">
    <div class="sk w60"></div><div class="sk h32 w80" style="margin:var(--s3) 0"></div>
    <div class="sk w40"></div></div>`).join('');
  $('lineStage').innerHTML = '<div class="sk h180"></div>';
  $('trendChart').innerHTML = '<div class="sk h180"></div>';
}

function boot() {
  showSkeletons();
  bindDial('tA01', 'A', 't01');
  bindDial('tA12', 'A', 't12');
  bindDial('tTO01', 'TO', 't01');
  bindDial('tTO12', 'TO', 't12');
  syncSeg('segMotion', 'motion', motionPref);
  buildLineSelect();
  selectTab('now');

  let done = 0;
  const TOTAL = 400, CHUNK = 50;
  (function step() {
    for (let i = 0; i < CHUNK && done < TOTAL; i++, done++) tick(true);
    if (done >= 120 && state.phase === 'loading') { state.phase = 'ready'; renderActive(); }
    if (done < TOTAL) setTimeout(step, 0);
    else {
      state.phase = 'ready';
      renderActive();
      startLoop();
      syncStage();
      checkAPI();
      setInterval(checkAPI, 10000);
    }
  })();
}

boot();
})();
