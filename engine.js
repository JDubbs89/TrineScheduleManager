/* Pure scheduling logic: no DOM. Loaded before app.js.
 * Everything takes an explicit `ctx` (courses, settings, current term key) and an
 * `assign` map (courseId -> termId|null) so the optimizer can evaluate hypotheticals. */
(function (root) {
  'use strict';

  const SEASON_NAME = { FA: 'Fall', SP: 'Spring', SU: 'Summer' };
  const SEASON_ORD = { SP: 0, SU: 1, FA: 2 };
  const GRADE_PTS = { 'A+': 4, A: 4, 'A-': 3.7, 'B+': 3.3, B: 3, 'B-': 2.7, 'C+': 2.3, C: 2, 'C-': 1.7, 'D+': 1.3, D: 1, 'D-': 0.7, F: 0 };
  const GRADES = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'F', 'W', 'T'];
  const DEFAULTS = { minLoad: 12, maxLoad: 18, targetCredits: 120, jrAt: 60, srAt: 90, summerAll: false, currentTerm: 'auto' };

  const tid = (season, year) => season + String(year).slice(-2);
  function tinfo(id) {
    if (id === 'TR') return { id, season: 'TR', year: 0, key: -1e9, label: 'Transfer' };
    const m = /^(FA|SP|SU)(\d\d)$/.exec(id);
    if (!m) throw new Error('bad term id ' + id);
    const year = 2000 + Number(m[2]);
    return { id, season: m[1], year, key: year * 3 + SEASON_ORD[m[1]], label: `${SEASON_NAME[m[1]]} ${year}` };
  }
  const tkey = (id) => tinfo(id).key;
  function nextTermId(id, withSummer) {
    const t = tinfo(id);
    if (t.season === 'FA') return tid('SP', t.year + 1);
    if (t.season === 'SP') return withSummer ? tid('SU', t.year) : tid('FA', t.year);
    return tid('FA', t.year);
  }
  function currentTermId(settings, now = new Date()) {
    if (settings.currentTerm && settings.currentTerm !== 'auto') return settings.currentTerm;
    const m = now.getMonth() + 1, y = now.getFullYear();
    return m >= 8 ? tid('FA', y) : m >= 6 ? tid('SU', y) : tid('SP', y);
  }

  const gradePts = (g) => (g in GRADE_PTS ? GRADE_PTS[g] : null);
  const earnsCredit = (c) => !['F', 'W', 'WF'].includes(c.grade);
  function meetsGrade(c, min) {
    if (!min || !c.grade || c.grade === 'T') return true;
    const a = gradePts(c.grade), b = gradePts(min);
    return a == null || b == null ? true : a >= b;
  }

  /* ---------- prerequisite text -> structure (mirrors tools/build_data.py) ---------- */
  function normCode(s) {
    const m = /^\s*([A-Za-z]{2,9})\s*(\d{3,4})\s*$/.exec(s);
    if (!m) return null;
    let p = m[1].toUpperCase();
    if (p === 'BIOLOGY') p = 'BIO';
    return p + ' ' + m[2];
  }
  function parsePrereq(text) {
    const out = { groups: [], standing: null, notes: [] };
    const t = (text || '').trim();
    if (!t) return out;
    let m = /^(Jr|Sr)\.? Standing$/i.exec(t);
    if (m) { out.standing = m[1].toUpperCase(); return out; }
    if (/approval|HS Math/i.test(t)) { out.notes.push(t); return out; }
    m = /^"([A-F][+-]?)" or better in (.+)$/i.exec(t);
    if (m) { out.groups.push({ codes: m[2].split(/\s+or\s+/i).map(normCode).filter(Boolean), minGrade: m[1].toUpperCase() }); return out; }
    for (const chunk of t.split(/,|\s+and\s+/i)) {
      const codes = chunk.split(/\s+or\s+/i).map(normCode).filter(Boolean);
      if (codes.length) out.groups.push({ codes, minGrade: null });
    }
    return out;
  }

  /* ---------- context ---------- */
  function makeCtx(courses, settings, opts = {}) {
    const idx = {};
    for (const c of courses) for (const code of [c.code, ...(c.alt || [])]) (idx[code] = idx[code] || []).push(c);
    const dependents = {};
    for (const c of courses) {
      for (const g of c.prereq.groups) for (const code of g.codes) for (const p of idx[code] || []) {
        if (p.id !== c.id) (dependents[p.id] = dependents[p.id] || new Set()).add(c);
      }
    }
    const curId = currentTermId(settings, opts.now);
    return { courses, settings, idx, dependents, curId, curKey: tinfo(curId).key, summerAll: opts.summerAll ?? settings.summerAll, depthMemo: {} };
  }
  function statusOf(ctx, c) {
    if (!c.term) return 'unscheduled';
    if (c.term === 'TR') return 'done';
    const k = tkey(c.term);
    return k < ctx.curKey ? 'done' : k === ctx.curKey ? 'current' : 'planned';
  }
  const currentAssign = (ctx) => Object.fromEntries(ctx.courses.map((c) => [c.id, c.term || null]));

  function depth(ctx, c, seen = new Set()) {
    if (ctx.depthMemo[c.id] != null) return ctx.depthMemo[c.id];
    if (seen.has(c.id)) return 1;
    seen.add(c.id);
    let d = 1;
    for (const x of ctx.dependents[c.id] || []) d = Math.max(d, 1 + depth(ctx, x, seen));
    seen.delete(c.id);
    return (ctx.depthMemo[c.id] = d);
  }

  /* ---------- rule checks ---------- */
  function creditsBefore(ctx, assign, key) {
    let n = 0;
    for (const c of ctx.courses) { const t = assign[c.id]; if (t && tkey(t) < key && earnsCredit(c)) n += Number(c.credits) || 0; }
    return n;
  }
  function offerProblem(ctx, c, termId) {
    const o = c.offered, t = tinfo(termId);
    if (!o) return null;
    if (o === 'ALL') return t.season === 'SU' && !ctx.summerAll ? 'Summer offering not confirmed for "any term" courses' : null;
    return o === t.season ? null : `Only offered in ${SEASON_NAME[o] || o}`;
  }
  function prereqProblems(ctx, assign, c, termId) {
    const k = tkey(termId), out = [];
    for (const g of c.prereq.groups) {
      const cat = g.codes.flatMap((x) => ctx.idx[x] || []).filter((x) => x.id !== c.id);
      if (!cat.length) continue; // external / placement prereq – assumed satisfied
      const ok = cat.some((x) => { const xt = assign[x.id]; return xt && tkey(xt) < k && meetsGrade(x, g.minGrade); });
      if (ok) continue;
      const names = g.codes.filter((x) => ctx.idx[x]).join(' or ');
      const early = cat.filter((x) => assign[x.id] && tkey(assign[x.id]) < k);
      const later = cat.some((x) => assign[x.id] && tkey(assign[x.id]) >= k);
      out.push(early.length ? `Needs ${g.minGrade} or better in ${names}`
        : later ? `${names} must be taken in an earlier term` : `${names} is not scheduled before this term`);
    }
    if (c.prereq.standing) {
      const need = c.prereq.standing === 'SR' ? ctx.settings.srAt : ctx.settings.jrAt;
      const have = creditsBefore(ctx, assign, k);
      if (have < need) out.push(`${c.prereq.standing === 'SR' ? 'Senior' : 'Junior'} standing needs ${need} cr; ${have} earned by then`);
    }
    return out;
  }
  const termLoad = (ctx, assign, termId) => ctx.courses.reduce((n, c) => n + (assign[c.id] === termId ? Number(c.credits) || 0 : 0), 0);

  /* every problem in an assignment (current + future terms only) */
  function computeIssues(ctx, assign) {
    const byCourse = {}, byTerm = {}, all = [];
    const push = (map, id, level, msg, extra) => { (map[id] = map[id] || []).push({ level, msg }); all.push({ level, msg, ...extra }); };
    const terms = new Set();
    for (const c of ctx.courses) {
      const t = assign[c.id];
      if (!t || t === 'TR') continue;
      terms.add(t);
      if (tkey(t) < ctx.curKey) continue;
      const lab = tinfo(t).label;
      const op = offerProblem(ctx, c, t);
      if (op) push(byCourse, c.id, 'error', op, { course: c.id, term: t, where: `${c.code} · ${lab}` });
      for (const p of prereqProblems(ctx, assign, c, t)) push(byCourse, c.id, 'error', p, { course: c.id, term: t, where: `${c.code} · ${lab}` });
    }
    const future = [...terms].filter((t) => tkey(t) >= ctx.curKey).sort((a, b) => tkey(a) - tkey(b));
    const last = future.length ? future[future.length - 1] : null;
    for (const t of future) {
      const load = termLoad(ctx, assign, t), ti = tinfo(t);
      if (load > ctx.settings.maxLoad) push(byTerm, t, 'error', `${load} credits exceeds max of ${ctx.settings.maxLoad}`, { term: t, where: ti.label });
      else if (ti.season !== 'SU' && t !== last && load < ctx.settings.minLoad && tkey(t) > ctx.curKey)
        push(byTerm, t, 'warn', `${load} credits is below full-time minimum of ${ctx.settings.minLoad}`, { term: t, where: ti.label });
    }
    return { byCourse, byTerm, all };
  }

  /* problems if course c were moved to termId (used for drag highlighting + chips) */
  function placementProblems(ctx, assign, c, termId) {
    const probs = [];
    const op = offerProblem(ctx, c, termId);
    if (op) probs.push({ level: 'error', msg: op });
    for (const p of prereqProblems(ctx, assign, c, termId)) probs.push({ level: 'error', msg: p });
    const a2 = { ...assign, [c.id]: termId };
    const load = termLoad(ctx, a2, termId);
    if (load > ctx.settings.maxLoad) probs.push({ level: 'error', msg: `Term would have ${load} cr (max ${ctx.settings.maxLoad})` });
    for (const d of ctx.dependents[c.id] || []) {
      const dt = a2[d.id];
      if (!dt || tkey(dt) < ctx.curKey) continue;
      if (prereqProblems(ctx, a2, d, dt).length > prereqProblems(ctx, assign, d, dt).length)
        probs.push({ level: 'error', msg: `Would break prerequisite for ${d.code} (${tinfo(dt).label})` });
    }
    return probs;
  }

  /* ---------- stats ---------- */
  function totals(ctx) {
    const t = { done: 0, current: 0, planned: 0, unscheduled: 0, all: 0, pts: 0, gpaCr: 0, ptsCur: 0, gpaCrCur: 0 };
    for (const c of ctx.courses) {
      const cr = Number(c.credits) || 0, st = statusOf(ctx, c);
      t.all += cr;
      if (st === 'done') { if (earnsCredit(c)) t.done += cr; }
      else t[st] += cr;
      const p = gradePts(c.grade);
      if (p != null && c.grade !== 'W') {
        if (st === 'done') { t.pts += p * cr; t.gpaCr += cr; }
        if (st === 'done' || st === 'current') { t.ptsCur += p * cr; t.gpaCrCur += cr; }
      }
    }
    t.gpa = t.gpaCr ? t.pts / t.gpaCr : null;
    t.gpaCur = t.gpaCrCur ? t.ptsCur / t.gpaCrCur : null;
    return t;
  }
  function planStats(ctx, assign) {
    const loads = {};
    for (const c of ctx.courses) {
      const t = assign[c.id];
      if (t && t !== 'TR' && tkey(t) > ctx.curKey) loads[t] = (loads[t] || 0) + (Number(c.credits) || 0);
    }
    const ids = Object.keys(loads).filter((t) => loads[t] > 0).sort((a, b) => tkey(a) - tkey(b));
    const rows = ids.map((t) => ({ term: t, label: tinfo(t).label, credits: loads[t], summer: tinfo(t).season === 'SU' }));
    return {
      rows, terms: rows.length, finish: ids.length ? ids[ids.length - 1] : ctx.curId,
      peak: rows.reduce((m, r) => Math.max(m, r.credits), 0),
      summerCredits: rows.filter((r) => r.summer).reduce((n, r) => n + r.credits, 0),
      unscheduled: ctx.courses.filter((c) => !assign[c.id]).length,
    };
  }

  /* ---------- optimizer ---------- */
  function futureTermIds(ctx, withSummer, extra = 14) {
    const ids = []; let t = ctx.curId;
    for (let i = 0; i < extra; i++) { t = nextTermId(t, withSummer); ids.push(t); }
    return ids;
  }
  /* Greedy list-scheduler: walk terms in order, fill each up to `cap` credits with the eligible
   * courses that have the longest downstream chain first, then the most restricted offering. */
  function plan(settings, courses, opts) {
    const ctx = makeCtx(courses, settings, { summerAll: opts.summers ? true : settings.summerAll, now: opts.now });
    const assign = {}, pending = [];
    for (const c of ctx.courses) {
      const st = statusOf(ctx, c);
      const movable = !c.locked && (st === 'unscheduled' || (st === 'planned' && opts.scopeAll));
      if (movable) { assign[c.id] = null; pending.push(c); } else assign[c.id] = c.term || null;
    }
    const prio = (c) => [-depth(ctx, c), c.offered === 'ALL' || !c.offered ? 1 : 0, -(Number(c.credits) || 0)];
    pending.sort((a, b) => { const x = prio(a), y = prio(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return a.id < b.id ? -1 : 1; });
    for (const t of futureTermIds(ctx, opts.summers)) {
      let load = termLoad(ctx, assign, t);
      for (const c of pending) {
        if (assign[c.id] !== null) continue;
        const cr = Number(c.credits) || 0;
        if (load + cr > opts.cap) continue;
        if (offerProblem(ctx, c, t) || prereqProblems(ctx, assign, c, t).length) continue;
        assign[c.id] = t; load += cr;
      }
      if (pending.every((c) => assign[c.id] !== null)) break;
    }
    const unplaced = pending.filter((c) => assign[c.id] === null);
    const stats = planStats(ctx, assign);
    return { assign, pending, unplaced, stats, finishKey: unplaced.length ? Infinity : tkey(stats.finish), feasible: !unplaced.length, opts, ctx };
  }

  function scenarios(settings, courses, scopeAll) {
    const base = { scopeAll };
    const max = settings.maxLoad, out = [];
    const mk = (id, title, blurb, p, extra = {}) => ({ id, title, blurb, plan: p, ...extra });
    const search = (summers, limitKey) => {
      for (let cap = 6; cap <= max; cap++) { const p = plan(settings, courses, { ...base, cap, summers }); if (p.feasible && p.finishKey <= limitKey) return p; }
      return null;
    };
    const fast = plan(settings, courses, { ...base, cap: max, summers: false });
    if (fast.feasible) {
      out.push(mk('fast', 'Fastest, no summers', `Fill each term up to ${max} cr, earliest possible finish.`, fast));
      const bal = search(false, fast.finishKey);
      if (bal) out.push(mk('balanced', 'Balanced, same finish', 'Smallest per-term cap that still finishes as early as possible.', bal));
    }
    const fastS = plan(settings, courses, { ...base, cap: max, summers: true });
    let best = fast.feasible ? fast.finishKey : Infinity;
    if (fastS.feasible && fastS.finishKey < best) { out.push(mk('fast-summer', 'Fastest, using summers', 'Uses summer terms to finish sooner.', fastS)); best = fastS.finishKey; }
    if (isFinite(best)) {
      const lite = search(true, best);
      if (lite && lite.stats.summerCredits > 0) out.push(mk('summer-light', 'Lightest peak, using summers', 'Spreads credits into summer terms to cut the heaviest semester.', lite));
    }
    const slow = plan(settings, courses, { ...base, cap: settings.minLoad, summers: false });
    if (slow.feasible && slow.finishKey > best) out.push(mk('slow', `Minimum full-time pace (${settings.minLoad} cr)`, 'Lowest load that keeps full-time status; graduation moves later.', slow));
    // de-duplicate identical assignments
    const seen = new Set();
    return out.filter((s) => { const sig = JSON.stringify(s.plan.pending.map((c) => [c.id, s.plan.assign[c.id]])); if (seen.has(sig)) return false; seen.add(sig); return true; });
  }

  root.Engine = {
    SEASON_NAME, GRADES, GRADE_PTS, DEFAULTS, tid, tinfo, tkey, nextTermId, currentTermId, gradePts, earnsCredit,
    parsePrereq, normCode, makeCtx, statusOf, currentAssign, depth, creditsBefore, offerProblem, prereqProblems, termLoad,
    computeIssues, placementProblems, totals, planStats, plan, scenarios, futureTermIds,
  };
})(typeof window !== 'undefined' ? window : globalThis);
