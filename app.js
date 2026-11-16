/* Schedule Manager UI. State lives in localStorage. */
(() => {
  'use strict';
  const E = window.Engine;
  const KEY = 'schedmgr.v1';
  const SKIP_DEFAULT_LOGIN_KEY = 'schedmgr.skipDefaultLogin';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const CAT_NAME = { gened: 'General Ed', program: 'Program', elective: 'Electives', transfer: 'Transfer' };
  const OFF_NAME = { ALL: 'Any term', FA: 'Fall', SP: 'Spring', SU: 'Summer' };

  let S, LIVE = null, undoStack = [], dragId = null, firstRender = true, scenarios = null, portalSyncBusy = false;
  let remoteSaveTimer = null, lastRemoteJson = '', hadLocalState = false;
  const account = { authenticated: false, user: null, revision: 0, updatedAt: null, syncing: false, conflict: null };
  const courseRefreshBusy = new Set();

  /* ================= state ================= */
  function fixCourse(c) {
    c.alt = c.alt || []; c.credits = Number(c.credits) || 0; c.notes = c.notes || ''; c.locked = !!c.locked;
    c.offered = c.offered || null; c.grade = c.grade || null; c.term = c.term || null; c.prereqText = c.prereqText || '';
    c.prereq = c.prereq || { groups: [], standing: null, notes: [] };
    c.portal = c.portal || { byTerm: {} }; c.portal.byTerm = c.portal.byTerm || {};
    c.section = c.section || null;
    return c;
  }
  const defaultUI = () => ({ tab: 'dashboard', showPast: false, showSummers: false, scopeAll: true, q: '', fStatus: '', fCat: '', sort: 'code', dir: 1, calendarMode: 'month', calendarDate: '', calendarTerm: '' });
  function blankState() {
    const current = E.currentTermId(E.DEFAULTS);
    return {
      v: 1,
      meta: { student: 'New plan', program: 'Custom schedule', source: 'blank plan' },
      minor: null,
      courses: [],
      terms: [current],
      settings: { ...E.DEFAULTS },
      ui: defaultUI(),
    };
  }
  function externalState(seed) {
    return {
      v: 1,
      meta: seed.meta || { student: 'New plan', program: 'Custom schedule', source: 'external seed' },
      minor: seed.minor || null,
      courses: Array.isArray(seed.courses) ? seed.courses.map(fixCourse) : [],
      terms: Array.isArray(seed.terms) ? seed.terms.map((t) => t.id || t) : [E.currentTermId(E.DEFAULTS)],
      settings: { ...E.DEFAULTS },
      ui: defaultUI(),
    };
  }
  function loadState() {
    try {
      const o = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (o && Array.isArray(o.courses) && Array.isArray(o.terms)) {
        o.courses.forEach(fixCourse); o.settings = { ...E.DEFAULTS, ...o.settings }; o.ui = { ...defaultUI(), ...o.ui };
        if (o.ui.tab === 'planner' || o.ui.tab === 'schedule') o.ui.tab = 'timeline';
        return o;
      }
    } catch (e) { /* storage blocked or corrupt: fall through to seed */ }
    return blankState();
  }
  async function loadExternalSeed() {
    if (!/^https?:$/.test(location.protocol)) return null;
    try {
      const response = await fetch('/api/seed-data', { headers: { Accept: 'application/json' } });
      if (!response.ok) return null;
      const data = await response.json();
      return data.available && data.seed ? externalState(data.seed) : null;
    } catch (error) {
      return null;
    }
  }
  const remoteState = () => ({ v: S.v, meta: S.meta, minor: S.minor, courses: S.courses, terms: S.terms, settings: S.settings });
  function saveLocal() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* private mode: state lives in memory only */ } }
  function save() { saveLocal(); queueRemoteSave(); }
  function queueRemoteSave() {
    if (!account.authenticated || !/^https?:$/.test(location.protocol)) return;
    const serialized = JSON.stringify(remoteState());
    if (serialized === lastRemoteJson) return;
    clearTimeout(remoteSaveTimer);
    remoteSaveTimer = setTimeout(() => pushRemoteSchedule(), 500);
  }
  function renderAccountIndicator() {
    $$('[data-act="settings"]').forEach((button) => {
      button.title = account.authenticated ? `Settings · ${account.user.username}` : 'Settings';
    });
  }
  function setSignedOut() {
    Object.assign(account, { authenticated: false, user: null, revision: 0, updatedAt: null, syncing: false, conflict: null });
    lastRemoteJson = '';
    clearTimeout(remoteSaveTimer);
    renderAccountIndicator();
  }
  function applyRemoteState(state) {
    if (!state || !Array.isArray(state.courses) || !Array.isArray(state.terms)) throw new Error('The server schedule is invalid');
    const ui = S.ui || defaultUI();
    S = {
      v: Number(state.v) || 1,
      meta: state.meta || { student: account.user?.username || 'User', program: 'Custom schedule', source: 'account' },
      minor: state.minor || null,
      courses: state.courses.map(fixCourse), terms: state.terms.map((term) => term.id || term),
      settings: { ...E.DEFAULTS, ...state.settings }, ui,
    };
    normalizeTerms(); saveLocal(); render();
  }
  async function pushRemoteSchedule(force = false, announce = false) {
    if (!account.authenticated || account.syncing) return false;
    clearTimeout(remoteSaveTimer);
    const state = remoteState(), serialized = JSON.stringify(state);
    if (!force && serialized === lastRemoteJson) return true;
    account.syncing = true; renderAccountIndicator();
    try {
      const response = await fetch('/api/schedule', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ state, revision: account.revision, force }),
      });
      const data = await response.json();
      if (response.status === 401) { setSignedOut(); throw new Error('Your session expired. Sign in again'); }
      if (response.status === 409) {
        account.conflict = { revision: data.revision, updatedAt: data.updatedAt };
        throw new Error('This schedule changed on another client. Open Settings → Profile to choose which copy to keep');
      }
      if (!response.ok) throw new Error(data.error || `Sync failed (${response.status})`);
      Object.assign(account, { revision: data.revision, updatedAt: data.updatedAt, conflict: null });
      lastRemoteJson = serialized;
      if (announce) toast('Schedule synced');
      return true;
    } catch (error) {
      toast(error.message);
      return false;
    } finally {
      account.syncing = false; renderAccountIndicator();
      if (account.authenticated && lastRemoteJson === serialized && JSON.stringify(remoteState()) !== lastRemoteJson) {
        clearTimeout(remoteSaveTimer);
        remoteSaveTimer = setTimeout(() => pushRemoteSchedule(), 100);
      }
    }
  }
  async function loadRemoteSchedule(announce = false) {
    if (!account.authenticated) return false;
    try {
      const response = await fetch('/api/schedule', { headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (response.status === 401) { setSignedOut(); throw new Error('Your session expired. Sign in again'); }
      if (!response.ok) throw new Error(data.error || `Load failed (${response.status})`);
      Object.assign(account, { revision: data.revision, updatedAt: data.updatedAt, conflict: null });
      if (data.state) {
        lastRemoteJson = JSON.stringify(data.state);
        applyRemoteState(data.state);
        if (announce) toast('Loaded the server schedule');
      } else if (hadLocalState || S.courses.length || S.meta?.source !== 'blank plan') {
        lastRemoteJson = '';
        return await pushRemoteSchedule(false, announce);
      }
      return true;
    } catch (error) {
      toast(error.message); return false;
    }
  }
  async function restoreAccount() {
    if (!/^https?:$/.test(location.protocol)) return;
    try {
      let response = await fetch('/api/session', { headers: { Accept: 'application/json' } });
      let data = await response.json();
      if ((!response.ok || !data.authenticated) && !localStorage.getItem(SKIP_DEFAULT_LOGIN_KEY)) {
        response = await fetch('/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ username: 'jonathan', password: 'password123' }),
        });
        data = await response.json();
      }
      if (!response.ok || !data.authenticated) return setSignedOut();
      Object.assign(account, { authenticated: true, user: data.user });
      renderAccountIndicator();
      await loadRemoteSchedule();
    } catch (error) { setSignedOut(); }
  }
  function normalizeTerms() {
    const ids = new Set(S.terms.map((t) => t.id || t));
    S.courses.forEach((c) => { if (c.term && c.term !== 'TR') ids.add(c.term); });
    S.terms = [...ids].sort((a, b) => E.tkey(a) - E.tkey(b));
  }
  const snapshot = () => JSON.stringify({ courses: S.courses, terms: S.terms, settings: S.settings, meta: S.meta });
  function mutate(fn) {
    undoStack.push(snapshot()); if (undoStack.length > 80) undoStack.shift();
    fn(); normalizeTerms(); save(); render();
  }
  function undo() {
    const s = undoStack.pop(); if (!s) return toast('Nothing to undo');
    Object.assign(S, JSON.parse(s)); save(); render(); toast('Undone');
  }
  const ctx = () => E.makeCtx(S.courses, S.settings, { transcript: S.meta?.transcript });
  const byId = (id) => S.courses.find((c) => c.id === id);

  /* ================= helpers ================= */
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200); }
  const tlabel = (id) => (id ? E.tinfo(id).label : 'Unscheduled');
  const tshort = (id) => (id === 'TR' ? 'TR' : id);
  const fmt = (n, d = 2) => (n == null ? '—' : n.toFixed(d));
  const cmpCode = (a, b) => a.code.localeCompare(b.code, undefined, { numeric: true });
  const sectionKey = (s) => s ? `${s.courseCode}|${s.beginDate}|${s.endDate}` : '';
  const sectionsFor = (c, term) => c.portal?.byTerm?.[term]?.sections || [];
  const sectionTime = (section) => E.sectionTimeLabel(section);
  const sectionProfessor = (section) => String(section?.faculty || '').trim() || 'Professor TBA';
  const dateValue = (value) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value || ''); return m ? new Date(+m[3], +m[1] - 1, +m[2]).getTime() : null; };
  const todayValue = () => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(); };
  const sectionNotStarted = (section) => { const start = dateValue(section?.beginDate); return start != null && start > todayValue(); };
  // Every semester remains editable, including completed and in-progress terms.
  const currentCourseEditable = () => true;
  function sectionsOverlap(a, b) {
    if (!a || !b) return false;
    const ab = dateValue(a.beginDate), ae = dateValue(a.endDate), bb = dateValue(b.beginDate), be = dateValue(b.endDate);
    if (ab != null && ae != null && bb != null && be != null && (ae < bb || be < ab)) return false;
    return (a.meetings || []).some((am) => (b.meetings || []).some((bm) =>
      am.days.some((day) => bm.days.includes(day)) && am.start < bm.end && bm.start < am.end));
  }
  function sectionConflicts(c, section, term) {
    return S.courses.filter((other) => other.id !== c.id && other.term === term && other.section && sectionsOverlap(section, other.section));
  }
  function recommendSection(c, term, preferredKey = '', upcomingOnly = false) {
    const sections = sectionsFor(c, term).filter((section) => !upcomingOnly || sectionNotStarted(section));
    const viable = sections.filter((section) => !sectionConflicts(c, section, term).length);
    const preference = (section) => {
      const note = `${c.notes} ${c.slot || ''}`.toUpperCase();
      const preferredOnline = section.onlineSession && note.includes(section.onlineSession);
      return [sectionKey(section) === preferredKey ? 1 : 0, preferredOnline ? 1 : 0, section.status === 'Open' ? 1 : 0, section.seatsOpen ?? -1];
    };
    viable.sort((a, b) => { const x = preference(a), y = preference(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]; return a.courseCode.localeCompare(b.courseCode); });
    return viable[0] || null;
  }
  function scheduleIssues() {
    const all = [], byCourse = {};
    for (const c of S.courses) {
      if (!c.term || !sectionsFor(c, c.term).length || c.section) continue;
      const issue = { level: 'error', msg: 'No conflict-free MyPortal section is selected', term: c.term, course: c.id, where: c.code };
      all.push(issue); (byCourse[c.id] ||= []).push(issue);
    }
    for (let i = 0; i < S.courses.length; i++) for (let j = i + 1; j < S.courses.length; j++) {
      const a = S.courses[i], b = S.courses[j];
      if (!a.term || a.term !== b.term || !a.section || !b.section || !sectionsOverlap(a.section, b.section)) continue;
      const msg = `${a.code} ${a.section.daysLabel} ${sectionTime(a.section)} overlaps ${b.code} ${b.section.daysLabel} ${sectionTime(b.section)}`;
      const issue = { level: 'error', msg, term: a.term, where: tlabel(a.term) };
      all.push(issue); (byCourse[a.id] ||= []).push(issue); (byCourse[b.id] ||= []).push(issue);
    }
    return { all, byCourse };
  }
  const sectionSummary = (s) => s ? `${s.onlineSession || s.sectionCode || 'Section'} · ${s.daysLabel} · ${sectionTime(s)} · ${sectionProfessor(s)}` : '';
  function placementProblems(cx, assign, c, term) {
    const problems = E.placementProblems(cx, assign, c, term);
    const known = sectionsFor(c, term);
    const upcomingOnly = false;
    if (known.length && !recommendSection(c, term, sectionKey(c.section), upcomingOnly)) problems.push({ msg: upcomingOnly ? 'no not-yet-started section fits your schedule' : 'all published sections overlap your schedule' });
    return problems;
  }
  function visibleTerms(cx) {
    const has = new Set(S.courses.map((c) => c.term).filter(Boolean));
    const out = [];
    if (S.ui.showPast) out.push('TR');
    for (const t of S.terms) {
      const ti = E.tinfo(t), past = ti.key < cx.curKey;
      // Completed semesters remain visible and editable so the plan can be corrected retroactively.
      if (ti.season === 'SU' && !S.ui.showSummers && !has.has(t)) continue;
      out.push(t);
    }
    return out;
  }
  function download(name, text, type = 'application/json') {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 500);
  }

  const calendarDate = () => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(S.ui.calendarDate || '')) {
      const date = new Date(`${S.ui.calendarDate}T12:00:00`);
      if (!Number.isNaN(date.getTime())) return date;
    }
    return new Date();
  };
  const isoDate = (date) => {
    const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };
  const dateLabel = (date, options) => date.toLocaleDateString(undefined, options);
  const addDays = (date, amount) => { const next = new Date(date); next.setDate(next.getDate() + amount); return next; };
  const dayIndex = (date) => date.getDay();
  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayCodes = ['U', 'M', 'T', 'W', 'R', 'F', 'S'];
  const scheduledSections = () => S.courses.filter((c) => c.term && c.section && c.section.meetings?.length && dateValue(c.section.beginDate) != null && dateValue(c.section.endDate) != null);
  const eventOnDate = (course, date) => {
    const section = course.section, start = dateValue(section.beginDate), end = dateValue(section.endDate);
    if (!section || start == null || end == null) return false;
    const value = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    return value >= start && value <= end && (section.meetings || []).some((meeting) => meeting.days.some((day) => dayCodes[dayIndex(date)] === day));
  };
  const eventTime = (course) => sectionTime(course.section);
  const meetingOnDate = (course, date) => {
    const section = course.section, day = dayCodes[dayIndex(date)];
    return (section?.meetings || []).find((meeting) => meeting.days.includes(day)) || null;
  };
  const formatClock = (minutes) => {
    const value = Number(minutes);
    if (!Number.isFinite(value)) return '';
    const hour = Math.floor(value / 60) % 24, minute = value % 60;
    if (S.settings.timeFormat === 'military') return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const suffix = hour >= 12 ? 'PM' : 'AM', displayHour = hour % 12 || 12;
    return `${displayHour}:${String(minute).padStart(2, '0')} ${suffix}`;
  };
  const meetingLabel = (meeting) => meeting ? `${formatClock(meeting.start)}–${formatClock(meeting.end)}` : '';
  const eventHtml = (course, meeting = null) => `<button class="calendar-event cat-${esc(course.category)}" data-act="open" data-id="${esc(course.id)}" style="${meeting ? `--event-start:${Math.max(0, (Number(meeting.start) || 0) - DAY_START_MINUTES)};--event-duration:${Math.max(30, (Number(meeting.end) || (Number(meeting.start) + 60)) - (Number(meeting.start) || 0))}` : ''}"><b>${esc(course.code)}</b><span>${esc(meeting ? meetingLabel(meeting) : eventTime(course))}</span></button>`;
  const DAY_START_MINUTES = 6 * 60;
  const DAY_END_MINUTES = 24 * 60;
  const hourLabels = () => Array.from({ length: 19 }, (_, index) => {
    const hour = 6 + index;
    return `<span>${esc(formatClock(hour * 60))}</span>`;
  }).join('');

  function viewCalendar(cx) {
    const mode = S.ui.calendarMode || 'month', selected = calendarDate();
    const semesterOptions = [...new Set(scheduledSections().map((course) => course.term))].sort((a, b) => E.tkey(a) - E.tkey(b));
    const selectedTerm = mode === 'semester' ? (S.ui.calendarTerm === 'all' ? 'all' : semesterOptions.includes(S.ui.calendarTerm) ? S.ui.calendarTerm : (semesterOptions.includes(cx.curId) ? cx.curId : semesterOptions[0] || 'all')) : cx.curId;
    const events = scheduledSections().filter((course) => selectedTerm === 'all' || course.term === selectedTerm);
    const title = mode === 'day' ? dateLabel(selected, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
      : mode === 'semester' ? `${selectedTerm === 'all' ? 'All semesters' : tlabel(selectedTerm)} · Weekly schedule` : dateLabel(selected, { month: 'long', year: 'numeric' });
    const termSelect = mode === 'semester' ? `<select class="calendar-term" data-act="calendar-term" aria-label="Semester schedule"><option value="all" ${selectedTerm === 'all' ? 'selected' : ''}>All semesters</option>${semesterOptions.map((term) => `<option value="${term}" ${selectedTerm === term ? 'selected' : ''}>${esc(tlabel(term))}</option>`).join('')}</select>` : '';
    const semesterNavDisabled = mode === 'semester' && selectedTerm === 'all' ? ' disabled' : '';
    const controls = `<div class="calendar-tools"><div class="calendar-nav"><button class="btn sm" data-act="calendar-prev" aria-label="Previous ${mode === 'day' ? 'day' : mode === 'month' ? 'month' : 'semester'}"${semesterNavDisabled}>‹</button><button class="btn sm" data-act="calendar-today">Today</button><button class="btn sm" data-act="calendar-next" aria-label="Next ${mode === 'day' ? 'day' : mode === 'month' ? 'month' : 'semester'}"${semesterNavDisabled}>›</button></div><strong>${esc(title)}</strong>${termSelect}<div class="calendar-modes"><button class="btn sm ${mode === 'day' ? 'primary' : ''}" data-act="calendar-mode" data-mode="day">Day</button><button class="btn sm ${mode === 'month' ? 'primary' : ''}" data-act="calendar-mode" data-mode="month">Month</button><button class="btn sm ${mode === 'semester' ? 'primary' : ''}" data-act="calendar-mode" data-mode="semester">Semester</button></div></div>`;
    let body = '';
    if (mode === 'day') {
      const dayEvents = events.filter((course) => eventOnDate(course, selected));
      body = `<div class="calendar-day"><div class="calendar-day-label">${esc(dateLabel(selected, { weekday: 'long' }))}</div><div class="day-schedule"><div class="hour-labels">${hourLabels()}</div><div class="day-grid">${dayEvents.length ? dayEvents.map((course) => eventHtml(course, meetingOnDate(course, selected))).join('') : '<div class="empty">No scheduled classes on this day.</div>'}</div></div></div>`;
    } else if (mode === 'month') {
      const first = new Date(selected.getFullYear(), selected.getMonth(), 1), gridStart = addDays(first, -dayIndex(first));
      body = `<div class="month-grid">${dayLabels.map((label) => `<div class="month-weekday">${label}</div>`).join('')}${Array.from({ length: 42 }, (_, i) => {
        const date = addDays(gridStart, i), outside = date.getMonth() !== selected.getMonth(), dayEvents = events.filter((course) => eventOnDate(course, date));
        return `<div class="month-cell ${outside ? 'outside' : ''} ${isoDate(date) === isoDate(new Date()) ? 'today' : ''}"><button class="date-number" data-act="calendar-day" data-date="${isoDate(date)}">${date.getDate()}</button><div class="month-events">${dayEvents.map(eventHtml).join('')}</div></div>`;
      }).join('')}</div>`;
    } else {
      const termForStart = selectedTerm !== 'all' ? selectedTerm : cx.curId;
      const termStart = new Date(Number(`20${termForStart.slice(2)}`), termForStart.startsWith('SP') ? 0 : termForStart.startsWith('SU') ? 5 : 7, 1);
      const firstEvent = events.reduce((min, c) => Math.min(min, dateValue(c.section.beginDate)), Infinity);
      const lastEvent = events.reduce((max, c) => Math.max(max, dateValue(c.section.endDate)), -Infinity);
      const start = Number.isFinite(firstEvent) ? new Date(firstEvent) : termStart, end = Number.isFinite(lastEvent) ? new Date(lastEvent) : addDays(start, 111);
      const weeks = [];
      for (let cursor = addDays(start, -dayIndex(start)); cursor <= end; cursor = addDays(cursor, 7)) weeks.push(cursor);
      body = `<div class="semester-weeks">${weeks.map((week) => {
        const dates = Array.from({ length: 7 }, (_, i) => addDays(week, i)), weekEvents = events.filter((course) => dates.some((date) => eventOnDate(course, date)));
        return `<div class="semester-week"><div class="week-label">Week of ${esc(dateLabel(week, { month: 'short', day: 'numeric' }))}</div><div class="week-days">${dates.map((date) => { const dayEvents = events.filter((course) => eventOnDate(course, date)); return `<div class="week-day"><b>${dayLabels[dayIndex(date)]}<small>${date.getMonth() + 1}/${date.getDate()}</small></b><div class="week-day-events">${dayEvents.length ? dayEvents.map((course) => eventHtml(course, meetingOnDate(course, date))).join('') : '<span class="muted">—</span>'}</div></div>`; }).join('')}</div></div>`;
      }).join('')}</div>`;
    }
    return `<div class="calendar-page">${controls}<div class="calendar-note">${mode === 'semester' ? `Showing ${esc(selectedTerm === 'all' ? 'all semesters' : tlabel(selectedTerm))}` : `Showing ${esc(tlabel(cx.curId))}`} · ${events.length} scheduled course${events.length === 1 ? '' : 's'}</div>${body}</div>`;
  }

  /* ================= render: shell ================= */
  function render() {
    const cx = ctx(), assign = E.currentAssign(cx), issues = E.computeIssues(cx, assign);
    const timing = scheduleIssues();
    issues.all.push(...timing.all);
    for (const [id, rows] of Object.entries(timing.byCourse)) (issues.byCourse[id] ||= []).push(...rows);
    LIVE = { cx, issues };
    const nav = {
      dashboard: ['Dashboard', 'Plan overview', '▦'],
      timeline: ['Timeline', 'Courses by term', '◫'],
      schedule: ['Schedule', 'Calendar view', '□'],
      reqs: ['Requirements', 'Degree progress', '✓'],
      catalog: ['Course catalog', 'Find and edit courses', '⌕'],
    };
    $('#tabs').innerHTML = Object.entries(nav).map(([k, [l, d, icon]]) => `<button class="tab" role="tab" data-act="tab" data-tab="${k}" aria-selected="${S.ui.tab === k}"><span class="tab-icon" aria-hidden="true">${icon}</span><span><b>${l}</b></span></button>`).join('');
    const active = nav[S.ui.tab];
    $('#stats').hidden = S.ui.tab !== 'dashboard';
    if (S.ui.tab === 'dashboard') renderStats(cx, assign, issues);
    else $('#stats').replaceChildren();
    const board = $('.board'); const keep = board ? board.scrollLeft : null;
    $('#view').innerHTML = { dashboard: viewDashboard, timeline: viewPlanner, schedule: viewCalendar, reqs: viewReqs, catalog: viewCatalog }[S.ui.tab](cx, assign, issues);
    const nb = $('.board');
    if (nb) {
      if (keep != null && !firstRender) nb.scrollLeft = keep;
      else { const cur = $('.col.current', nb); if (cur) nb.scrollLeft = Math.max(0, cur.offsetLeft - nb.offsetLeft - 8); }
    }
    firstRender = false;
  }

  function renderStats(cx, assign, issues) {
    const t = E.totals(cx), target = S.settings.targetCredits, ps = E.planStats(cx, assign);
    const denom = Math.max(target, t.all) || 1, pc = (n) => (n / denom) * 100;
    const standing = t.done >= S.settings.srAt ? 'Senior' : t.done >= S.settings.jrAt ? 'Junior' : t.done >= 30 ? 'Sophomore' : 'Freshman';
    const errs = issues.all.filter((i) => i.level === 'error').length, warns = issues.all.length - errs;
    const diff = t.all - target;
    $('#stats').innerHTML = `
      <div class="tile"><div class="k">Credits earned</div><div class="v">${t.done} <span class="muted" style="font-size:13px;font-weight:500">/ ${target}</span></div>
        <div class="bar" title="done / in progress / planned / unscheduled"><i class="b-done" style="width:${pc(t.done)}%"></i><i class="b-current" style="width:${pc(t.current)}%"></i><i class="b-planned" style="width:${pc(t.planned)}%"></i><i class="b-unsched" style="width:${pc(t.unscheduled)}%"></i></div>
        <div class="s">${t.current} in progress · ${t.planned} planned${t.unscheduled ? ` · ${t.unscheduled} unscheduled` : ''}</div></div>
      <div class="tile"><div class="k">GPA${t.transcript ? ' · MyPortal' : ''}</div><div class="v">${fmt(t.gpa, t.transcript ? 3 : 2)}</div><div class="s">${t.gpaCr} graded credits${t.transcript ? ` · imported ${esc(new Date(S.meta.transcript.fetchedAt).toLocaleDateString())}` : ''}${t.gpaCur != null && t.current ? `<br>incl. current grades: ${fmt(t.gpaCur)}` : ''}</div></div>
      <div class="tile"><div class="k">Standing</div><div class="v">${standing}</div><div class="s">Jr at ${S.settings.jrAt} · Sr at ${S.settings.srAt} cr</div></div>
      <div class="tile ${t.unscheduled ? 'meh' : 'good'}"><div class="k">Projected finish</div><div class="v">${t.unscheduled ? 'Incomplete' : esc(E.tinfo(ps.finish).label)}</div><div class="s">${t.unscheduled ? `${ps.unscheduled} course(s) unscheduled` : `${ps.terms} term(s) after ${esc(E.tinfo(cx.curId).label)}`}</div></div>
      <div class="tile ${diff === 0 ? 'good' : diff < 0 ? 'bad' : 'meh'}"><div class="k">Plan total</div><div class="v">${t.all} cr</div><div class="s">${diff === 0 ? `matches ${target} cr target` : diff < 0 ? `${-diff} cr short of ${target}` : `${diff} cr over ${target}`}</div></div>
      <button class="tile click ${errs ? 'bad' : warns ? 'meh' : 'good'}" data-act="issues"><div class="k">Conflicts</div><div class="v">${errs + warns ? `${errs} err · ${warns} warn` : 'None'}</div><div class="s">${errs + warns ? 'click for details' : 'prereqs, offerings, loads ok'}</div></button>`;
  }

  /* ================= render: planner ================= */
  function cardHtml(c, cx, issues, opts = {}) {
    const st = E.statusOf(cx, c), iss = issues.byCourse[c.id] || [];
    const errs = iss.filter((i) => i.level === 'error');
    const drag = (st === 'planned' || st === 'unscheduled' || (st === 'current' && currentCourseEditable(c, cx)));
    const chips = [];
    if (c.grade) chips.push(`<span class="chip ${st === 'current' ? 'prov' : 'grade'}" title="${st === 'current' ? 'grade so far (in progress)' : 'final grade'}">${esc(c.grade)}</span>`);
    if (st !== 'done' && c.offered) chips.push(`<span class="chip" title="Offered: ${esc(OFF_NAME[c.offered] || c.offered)}">${esc(c.offered)}</span>`);
    if (c.prereq.standing) chips.push(`<span class="chip" title="Requires ${c.prereq.standing === 'SR' ? 'Senior' : 'Junior'} standing">${c.prereq.standing}.</span>`);
    if (c.locked) chips.push('<span class="chip pin" title="Pinned: optimizer will not move it">pin</span>');
    if (errs.length) chips.push(`<span class="chip err" title="${esc(errs.map((i) => i.msg).join('\n'))}">! ${errs.length}</span>`);
    if (c.section?.onlineSession) chips.push(`<span class="chip prov">${esc(c.section.onlineSession)}</span>`);
    else if (c.section?.sectionCode) chips.push(`<span class="chip prov">${esc(c.section.sectionCode)}</span>`);
    if (c.term && c.portal?.byTerm?.[c.term]?.source === 'spreadsheet') chips.push('<span class="chip warn" title="No matching section was published in MyPortal">spreadsheet</span>');
    if (String(c.code || '').trim()) {
      if (/^[A-Z]{2,9}\s+\d{3,4}L?(?:\s+\d{1,4})?$/.test(c.code)) {
        chips.push(`<button class="portal-check" data-act="course-availability" data-id="${esc(c.id)}" draggable="false" title="Check future MyPortal availability">MyPortal</button>`);
      }
      chips.push(`<button class="portal-check" data-act="refresh-course" data-id="${esc(c.id)}" draggable="false" title="Search MyPortal directly and update the local SQLite catalog" ${courseRefreshBusy.has(c.id) ? 'disabled' : ''}>${courseRefreshBusy.has(c.id) ? 'Searching…' : '↻ Search MyPortal'}</button>`);
    }
    const slots = opts.slots ? `<div class="slots">${opts.slots}</div>` : '';
    const req = c.prereqText ? `<div class="card-detail" title="${esc(c.prereqText)}"><span>Requires</span>${esc(c.prereqText)}</div>` : '';
    const professor = c.section ? sectionProfessor(c.section) : '';
    const sectionDates = c.section ? [c.section.beginDate, c.section.endDate].filter(Boolean).join('–') || 'Dates TBA' : '';
    const section = c.section ? `<div class="section-detail"><b>${esc(c.section.daysLabel || c.section.modality || 'Schedule TBA')}</b><span class="section-time">${esc(sectionTime(c.section))}${c.section.timeOfDay ? ` · ${esc(c.section.timeOfDay)}` : ''}</span><small class="section-professor" title="Professor: ${esc(professor)}">${esc(professor)}</small><small class="section-dates" title="Class dates: ${esc(sectionDates)}">${esc(sectionDates)}</small></div>` : '';
    return `<div class="card cat-${esc(c.category)} ${errs.length ? 'has-err' : ''}" ${drag ? 'draggable="true"' : ''} data-act="open" data-id="${esc(c.id)}" tabindex="0" role="button">
      <div class="r1"><span class="code">${esc(c.code)}</span><span class="cr">${c.credits} cr</span></div>
      <div class="ttl">${esc(c.title)}${c.slot && !/Elective$/.test(c.title) ? ` <span class="muted">· ${esc(c.slot)}</span>` : ''}</div>
      ${section}${req}<div class="meta">${chips.join('')}</div>${slots}</div>`;
  }

  function scheduleSortKey(c) {
    const section = c.section || {};
    const online = String(section.modality || '').toLowerCase() === 'online'
      || Boolean(section.onlineSession)
      || !(section.meetings || []).length && /online/i.test(String(section.daysLabel || section.schedule || ''));
    const starts = (section.meetings || []).map((meeting) => Number(meeting.start)).filter(Number.isFinite);
    const start = starts.length ? Math.min(...starts) : Number.POSITIVE_INFINITY;
    return [online ? 1 : 0, start, c.code || ''];
  }
  function compareScheduledCourses(a, b) {
    const x = scheduleSortKey(a), y = scheduleSortKey(b);
    return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2], undefined, { numeric: true });
  }

  function colHtml(tid, cx, issues) {
    const ti = E.tinfo(tid), past = ti.key < cx.curKey, cur = tid === cx.curId;
    const cs = S.courses.filter((c) => c.term === tid).sort(compareScheduledCourses);
    const load = cs.reduce((n, c) => n + c.credits, 0);
    const ti_iss = issues.byTerm[tid] || [];
    const loadCls = past ? '' : ti_iss.some((i) => i.level === 'error') ? 'over' : ti_iss.length ? 'under' : load ? 'ok' : '';
    const pill = tid === 'TR' ? '<span class="pill">transfer</span>' : cur ? '<span class="pill cur">current</span>' : past ? '<span class="pill done">done</span>' : '';
    return `<section class="col ${past ? 'past' : ''} ${cur ? 'current' : ''} ${ti.season === 'SU' ? 'summer' : ''}" data-term="${tid}">
      <div class="timeline-dot" aria-hidden="true"></div>
      <div class="col-h"><div class="term-title"><span>${esc(ti.season === 'FA' ? 'Fall' : ti.season === 'SP' ? 'Spring' : 'Summer')}</span><b>${ti.year}</b></div>${pill}<span class="sp"></span><span class="load ${loadCls}" title="credit hours">${load} cr</span><button class="icon-btn" data-act="remove-term" data-term="${tid}" title="Remove ${esc(ti.label)}" aria-label="Remove ${esc(ti.label)}">×</button></div>
      ${ti_iss.map((i) => `<div class="col-issues ${i.level}">${esc(i.msg)}</div>`).join('')}
      <div class="dropmsg"></div>
      <div class="col-body">${cs.map((c) => cardHtml(c, cx, issues)).join('') || '<div class="empty">empty</div>'}</div>
      ${past || tid === 'TR' ? '' : `<div class="col-foot"><button class="btn sm" data-act="new" data-term="${tid}">+ Course</button></div>`}
    </section>`;
  }

  function poolHtml(cx, assign, issues) {
    const un = S.courses.filter((c) => !c.term).sort((a, b) => a.category.localeCompare(b.category) || cmpCode(a, b));
    const targets = S.terms.filter((t) => { const ti = E.tinfo(t); return ti.key >= cx.curKey && (ti.season !== 'SU' || S.ui.showSummers); });
    let lastCat = null, html = '';
    for (const c of un) {
      if (c.category !== lastCat) { html += `<div class="grp-h">${esc(CAT_NAME[c.category] || c.category)}</div>`; lastCat = c.category; }
      const slots = targets.map((t) => {
        const p = placementProblems(cx, assign, c, t);
        return p.length ? `<span class="slot bad" title="${esc(p.map((x) => x.msg).join('\n'))}">${tshort(t)}</span>`
          : `<button class="slot ok" data-act="place" data-id="${esc(c.id)}" data-term="${t}" title="Place in ${esc(tlabel(t))}">${tshort(t)}</button>`;
      }).join('');
      html += cardHtml(c, cx, issues, { slots });
    }
    return `<aside class="pool" data-pool="1">
      <div class="panel-h"><h2>Unscheduled (${un.length})</h2><button class="btn sm" data-act="new">+ Course</button></div>
      <div class="pool-body">${html || '<div class="empty">Every course has a term.<br>Drag a card here to unschedule it.</div>'}</div></aside>`;
  }

  function viewPlanner(cx, assign, issues) {
    const terms = visibleTerms(cx);
    return `<div class="planner">${poolHtml(cx, assign, issues)}
      <div class="board-wrap">
        <div class="board-tools">
          <div class="timeline-label"><b>Semester timeline</b><span>Drag courses to move them</span></div>
          <div class="tool-group"><label><input type="checkbox" data-act="toggle" data-k="showPast" ${S.ui.showPast ? 'checked' : ''}> Completed</label><label><input type="checkbox" data-act="toggle" data-k="showSummers" ${S.ui.showSummers ? 'checked' : ''}> Summer</label></div>
          <div class="tool-group tool-actions">${undoStack.length ? '<button class="btn sm" data-act="undo">↶ Undo</button>' : ''}<button class="btn sm" data-act="sync-portal" ${portalSyncBusy ? 'disabled' : ''}>${portalSyncBusy ? 'Syncing…' : 'Sync MyPortal'}</button><button class="btn sm" data-act="add-term">+ Term</button></div>
        </div>
        <div class="board">${terms.map((t) => colHtml(t, cx, issues)).join('')}</div>
      </div></div>`;
  }

  function viewDashboard(cx, assign, issues) {
    const terms = visibleTerms(cx).filter((t) => t !== 'TR').slice(0, 8);
    const upcoming = terms.map((term) => {
      const courses = S.courses.filter((c) => c.term === term).sort(cmpCode);
      const credits = courses.reduce((sum, c) => sum + c.credits, 0);
      return `<div class="dash-term ${term === cx.curId ? 'current' : ''}"><div class="dash-term-head"><span>${esc(tlabel(term))}</span><b>${credits} cr</b></div><div class="dash-courses">${courses.map((c) => `<button data-act="open" data-id="${esc(c.id)}"><span class="mono">${esc(c.code)}</span><small>${esc(c.section ? sectionSummary(c.section) : 'Section not selected')}</small></button>`).join('') || '<span class="muted">No courses</span>'}</div></div>`;
    }).join('');
    const unscheduled = S.courses.filter((c) => !c.term).length;
    const fallback = S.courses.filter((c) => c.term && c.portal?.byTerm?.[c.term]?.source === 'spreadsheet').length;
    const clashes = scheduleIssues().all.length;
    const syncText = S.meta.portalSyncedAt ? `Last synced ${new Date(S.meta.portalSyncedAt).toLocaleString()}` : 'MyPortal has not been synced yet';
    return `<div class="dashboard-grid">
      <section class="panel dashboard-roadmap"><div class="dashboard-panel-head"><div><h3>Upcoming terms</h3><span class="muted">Your courses by semester</span></div><div class="dashboard-roadmap-actions"><button class="icon-btn" data-act="dashboard-scroll" data-dir="-1" title="Previous terms" aria-label="Previous terms">‹</button><button class="icon-btn" data-act="dashboard-scroll" data-dir="1" title="Next terms" aria-label="Next terms">›</button><button class="btn primary" data-act="go-timeline">View timeline</button></div></div><div class="compact-timeline">${upcoming || '<div class="empty">Add a term to start planning.</div>'}</div></section>
      <section class="panel dashboard-attention"><h3>Things to review</h3>
        <button class="attention-row" data-act="go-timeline"><span>Unscheduled courses</span><b class="${unscheduled ? 'warn-text' : ''}">${unscheduled}</b></button>
        <button class="attention-row" data-act="issues"><span>Schedule overlaps</span><b class="${clashes ? 'err-text' : ''}">${clashes}</b></button>
        <button class="attention-row" data-act="go-timeline"><span>Spreadsheet fallbacks</span><b>${fallback}</b></button>
        <div class="callout ${clashes ? 'err' : 'ok'}">${clashes ? 'Resolve overlapping meeting times before finalizing registration.' : 'No selected sections overlap.'}</div>
      </section>
      <section class="panel dashboard-sync"><div class="dashboard-panel-head"><div><h3>MyPortal data</h3><span class="muted">${esc(syncText)}</span></div><button class="btn" data-act="sync-portal" ${portalSyncBusy ? 'disabled' : ''}>${portalSyncBusy ? 'Syncing…' : 'Refresh'}</button></div><p class="muted">Refresh published sections and meeting details for your courses.</p></section>
    </div>`;
  }

  /* ================= render: requirements ================= */
  function chainFrom(cx, c, remaining, seen = new Set()) {
    let best = [];
    seen.add(c.id);
    for (const d of cx.dependents[c.id] || []) {
      if (!remaining.has(d.id) || seen.has(d.id)) continue;
      const ch = chainFrom(cx, d, remaining, seen);
      if (ch.length > best.length) best = ch;
    }
    seen.delete(c.id);
    return [c, ...best];
  }
  function viewReqs(cx, assign) {
    const t = E.totals(cx), target = S.settings.targetCredits;
    const cats = {};
    for (const c of S.courses) {
      const k = c.category, st = E.statusOf(cx, c); const o = (cats[k] = cats[k] || { done: 0, current: 0, planned: 0, unscheduled: 0, n: 0 });
      o[st] += c.credits; o.n++;
    }
    const stack = (o, total) => `<div class="bar"><i class="b-done" style="width:${(o.done / total) * 100}%"></i><i class="b-current" style="width:${(o.current / total) * 100}%"></i><i class="b-planned" style="width:${(o.planned / total) * 100}%"></i><i class="b-unsched" style="width:${(o.unscheduled / total) * 100}%"></i></div>`;
    const catRows = Object.entries(cats).map(([k, o]) => {
      const tot = o.done + o.current + o.planned + o.unscheduled;
      return `<div class="category-progress"><div class="row"><span class="grow"><span class="dot" style="background:var(--${k})"></span>${esc(CAT_NAME[k] || k)}</span><span class="muted">${o.done} done · ${o.current} now · ${o.planned} planned${o.unscheduled ? ` · ${o.unscheduled} unsched.` : ''}</span><b>${tot} cr</b></div>${stack(o, tot || 1)}</div>`;
    }).join('');

    // minor tracker
    let minor = '';
    if (S.minor && S.minor.courses && S.minor.courses.length) {
      let cr = 0, got = 0;
      const rows = S.minor.courses.map((code) => {
        const c = (cx.idx[code] || [])[0];
        if (!c) return `<div class="row"><span class="mono">${esc(code)}</span><span class="grow muted">not in catalog</span><span class="chip err">missing</span></div>`;
        const st = E.statusOf(cx, c); cr += c.credits; if (st === 'done' || st === 'current') got += c.credits;
        const lab = { done: 'done', current: 'in progress', planned: 'planned', unscheduled: 'unscheduled' }[st];
        return `<div class="row"><span class="mono">${esc(code)}</span><button class="link grow" data-act="open" data-id="${esc(c.id)}">${esc(c.title)}</button><span class="muted">${esc(tlabel(c.term))}</span><span class="chip ${st === 'done' ? 'grade' : st === 'current' ? 'prov' : st === 'planned' ? '' : 'warn'}">${lab}</span></div>`;
      }).join('');
      minor = `<div class="panel"><h3>${esc(S.minor.name || 'Minor')}</h3><div class="muted">${got} of ${S.minor.credits || cr} credits done or in progress</div>${rows}</div>`;
    }

    // bottlenecks
    const remaining = S.courses.filter((c) => ['current', 'planned', 'unscheduled'].includes(E.statusOf(cx, c)));
    const groups = { FA: [], SP: [], SU: [], ALL: [] };
    remaining.forEach((c) => groups[c.offered || 'ALL'].push(c));
    const grpHtml = (k, label) => groups[k].length ? `<h4>${label} (${groups[k].length})</h4>` + groups[k].sort(cmpCode).map((c) => `<div class="row"><span class="mono">${esc(c.code)}</span><button class="link grow" data-act="open" data-id="${esc(c.id)}">${esc(c.title)}</button><span class="muted">${esc(tlabel(c.term))}</span></div>`).join('') : '';

    // critical path + earliest finish
    const remSet = new Set(remaining.map((c) => c.id));
    const chains = remaining.filter((c) => !c.prereq.groups.some((g) => g.codes.some((code) => (cx.idx[code] || []).some((p) => remSet.has(p.id) && p.id !== c.id))))
      .map((c) => chainFrom(cx, c, remSet)).filter((ch) => ch.length > 1).sort((a, b) => b.length - a.length);
    const fast = E.plan(S.settings, S.courses, { cap: S.settings.maxLoad, summers: false, scopeAll: true });
    const mine = E.planStats(cx, assign);
    const earliest = fast.feasible ? E.tinfo(fast.stats.finish).label : 'not reachable in 14 terms';
    const slack = fast.feasible ? (E.tkey(mine.finish) === fast.finishKey ? 'Your plan already finishes at the earliest term these rules allow.' : E.tkey(mine.finish) > fast.finishKey ? 'Your plan finishes later than necessary; try Optimize.' : '') : '';

    return `<div class="scroll requirements-page"><div class="grid2">
      <div class="panel"><h3>Credit progress</h3>
        ${stack({ done: t.done, current: t.current, planned: t.planned, unscheduled: t.unscheduled }, Math.max(t.all, target))}
        <div class="legend"><span><i class="b-done"></i>Done ${t.done}</span><span><i class="b-current"></i>In progress ${t.current}</span><span><i class="b-planned"></i>Planned ${t.planned}</span><span><i class="b-unsched"></i>Unscheduled ${t.unscheduled}</span></div>
        <h4>By category</h4>${catRows}</div>
      ${minor}
      <div class="panel"><h3>Critical path</h3>
        <div class="callout ${slack.startsWith('Your plan already') ? 'ok' : 'warn'}"><b>Earliest finish under current rules: ${esc(earliest)}.</b> Your plan: ${esc(E.tinfo(mine.finish).label)}. ${esc(slack)}</div>
        ${chains.length ? chains.map((ch) => `<div class="row"><span class="grow">${ch.map((c) => `<button class="link mono" data-act="open" data-id="${esc(c.id)}">${esc(c.code)}</button> <span class="muted">(${esc(c.term ? tshort(c.term) : '?')})</span>`).join(' → ')}</span></div>`).join('') : '<div class="muted">No remaining prerequisite chains.</div>'}
        <div class="muted" style="margin-top:8px">Chains cannot be compressed: each link needs the previous one in an earlier term, and each course runs only in its offered terms.</div></div>
      <div class="panel"><h3>Remaining courses by offering</h3>${grpHtml('FA', 'Fall only')}${grpHtml('SP', 'Spring only')}${grpHtml('SU', 'Summer only')}${grpHtml('ALL', 'Any term / unspecified')}${remaining.length ? '' : '<div class="muted">Nothing left.</div>'}</div>
      ${S.meta.masters && S.meta.masters.length ? `<div class="panel"><h3>Available masters (from control sheet)</h3><ul class="plain">${S.meta.masters.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>` : ''}
    </div></div>`;
  }

  /* ================= render: catalog ================= */
  function viewCatalog(cx) {
    const { q, fStatus, fCat, sort, dir } = S.ui;
    const ql = q.trim().toLowerCase();
    const stRank = { done: 0, current: 1, planned: 2, unscheduled: 3 };
    const rows = S.courses.filter((c) => {
      const st = E.statusOf(cx, c);
      return (!fStatus || st === fStatus) && (!fCat || c.category === fCat)
        && (!ql || `${c.code} ${c.alt.join(' ')} ${c.title} ${c.slot || ''} ${c.prereqText}`.toLowerCase().includes(ql));
    });
    const key = {
      code: (c) => c.code, title: (c) => c.title, cat: (c) => c.category, cr: (c) => c.credits, off: (c) => c.offered || 'zz',
      term: (c) => (c.term ? E.tkey(c.term) : 1e9), status: (c) => stRank[E.statusOf(cx, c)], grade: (c) => c.grade || '', unlocks: (c) => -E.depth(cx, c),
    }[sort] || ((c) => c.code);
    rows.sort((a, b) => { const x = key(a), y = key(b); return (typeof x === 'string' ? x.localeCompare(y, undefined, { numeric: true }) : x - y) * dir || cmpCode(a, b); });
    const th = (k, l) => `<th data-act="sort" data-k="${k}">${l}${sort === k ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
    return `<div class="catalog-page"><div class="filters">
        <input class="catalog-query" type="search" placeholder="Search code, title, prerequisite…" value="${esc(q)}" data-act="filter" data-k="q">
        <select data-act="filter" data-k="fStatus"><option value="">All statuses</option>${['done', 'current', 'planned', 'unscheduled'].map((s) => `<option ${fStatus === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <select data-act="filter" data-k="fCat"><option value="">All categories</option>${Object.entries(CAT_NAME).map(([k, v]) => `<option value="${k}" ${fCat === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <span class="catalog-count muted">${rows.length} of ${S.courses.length} courses</span>
        <div class="catalog-actions">${undoStack.length ? '<button class="btn" data-act="undo">↶ Undo</button>' : ''}<button class="btn" data-act="catalog-search">Saved catalog</button><button class="btn primary" data-act="live-search">MyPortal</button></div></div>
      <div class="scroll"><table class="t catalog-table"><thead><tr>${th('code', 'Code')}${th('title', 'Title')}${th('cat', 'Category')}${th('cr', 'Cr')}${th('off', 'Offered')}${th('term', 'Term')}${th('status', 'Status')}${th('grade', 'Grade')}<th>Prerequisites</th>${th('unlocks', 'Unlocks')}<th>Plan</th></tr></thead><tbody>
      ${rows.map((c) => { const st = E.statusOf(cx, c), n = (cx.dependents[c.id] || new Set()).size;
        const inSession = st === 'current' && !currentCourseEditable(c, cx);
        const action = st === 'done' ? '<span class="muted">Completed</span>'
          : inSession ? `<button class="btn sm" data-act="open" data-id="${esc(c.id)}" title="The semester stays fixed, but its section can be changed">Change section</button>`
          : `<button class="btn sm" data-act="schedule-course" data-id="${esc(c.id)}">${c.term ? 'Reschedule' : 'Schedule'}</button>`;
        return `<tr data-act="open" data-id="${esc(c.id)}"><td class="mono catalog-code" data-label="Course">${esc(c.code)}</td><td class="catalog-title" data-label="Title">${esc(c.title)}</td><td class="catalog-secondary" data-label="Category"><span class="dot" style="background:var(--${c.category})"></span>${esc(CAT_NAME[c.category] || c.category)}</td><td class="num" data-label="Credits">${c.credits}</td><td class="catalog-secondary" data-label="Offered">${esc(c.offered ? OFF_NAME[c.offered] || c.offered : '?')}</td><td data-label="Term">${esc(tlabel(c.term))}</td><td data-label="Status">${st}</td><td data-label="Grade">${esc(c.grade || '—')}</td><td class="muted catalog-prereq" data-label="Prerequisites">${esc(c.prereqText || 'None')}</td><td class="num catalog-secondary" data-label="Unlocks" title="${n} course(s) list this as a prerequisite; longest chain after it: ${E.depth(cx, c) - 1}">${n || '—'}</td><td class="catalog-plan" data-label="Plan">${action}</td></tr>`; }).join('')}
      </tbody></table></div></div>`;
  }

  /* ================= dialogs ================= */
  const dlg = $('#dlg');
  function openDlg(html, wide) { dlg.className = wide ? 'wide' : ''; dlg.innerHTML = html; if (!dlg.open) dlg.showModal(); }
  function closeDlg() { if (dlg.open) dlg.close(); }
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDlg(); });
  dlg.addEventListener('submit', (e) => {
    e.preventDefault(); const f = e.target.dataset.form;
    if (f === 'course') saveCourse();
    if (f === 'settings') saveSettings();
    if (f === 'live-search') searchMyPortal(e.target);
    if (f === 'account') authenticateAccount('login');
    if (f === 'password') changeAccountPassword();
    if (f === 'portal-cookies') uploadPortalCookies(e.target);
  });
  const dlgShell = (title, body, foot) => `<div class="dlg-h"><h2>${title}</h2><button class="btn sm" data-act="close">Close</button></div><div class="dlg-b">${body}</div>${foot ? `<div class="dlg-f">${foot}</div>` : ''}`;

  function themeButton() {
    return `<button class="btn theme-toggle" data-theme-toggle aria-label="Dark mode" title="${document.documentElement.dataset.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}" aria-pressed="${document.documentElement.dataset.theme === 'dark'}"><svg class="theme-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.9 13.1A9 9 0 0 1 10.9 3.1a9 9 0 1 0 10 10Z"/></svg><svg class="theme-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/></svg></button>`;
  }
  function openMobileTools() {
    openDlg(dlgShell('Planning tools', `<div class="mobile-tool-list"><button class="btn primary" data-act="optimize"><span aria-hidden="true">✦</span><span><b>Optimize plan</b><small>Compare faster schedules</small></span></button><div class="settings-controls"><button class="btn" data-act="settings"><span aria-hidden="true">⚙</span><span><b>Settings</b><small>Preferences, profile, and backups</small></span></button>${themeButton()}</div></div>`));
  }

  function openAccount() { openSettings('profile'); }

  function accountPanel() {
    if (!account.authenticated) {
      const body = `<form class="form" data-form="account" autocomplete="on"><div class="callout fld full"><b>Use your schedule on multiple clients</b><br>Your existing browser plan is uploaded when a new account has no saved schedule. Signing into an existing account loads its server copy.</div><label class="fld full"><span>Username</span><input name="username" minlength="3" maxlength="32" pattern="[A-Za-z0-9._-]+" autocomplete="username" required></label><label class="fld full"><span>Password</span><input name="password" type="password" minlength="10" maxlength="72" autocomplete="current-password" required><small>At least 10 characters. Passwords are stored as salted bcrypt hashes.</small></label><button hidden type="submit"></button></form>`;
      return { body, foot: '<button class="btn" data-act="account-register">Create account</button><button class="btn primary" data-act="account-login">Sign in</button>' };
    }
    const conflict = account.conflict ? `<div class="callout err"><b>Sync conflict</b><br>The server was updated by another client${account.conflict.updatedAt ? ` at ${esc(new Date(account.conflict.updatedAt).toLocaleString())}` : ''}. Reload its copy or overwrite it with this browser’s current plan.</div>` : '';
    const status = account.syncing ? 'Syncing…' : account.updatedAt ? `Last synced ${new Date(account.updatedAt).toLocaleString()}` : 'This account does not have a saved schedule yet';
    const passwordWarning = account.user.mustChangePassword ? '<div class="callout warn"><b>Change the default password</b><br>This account still uses the public default password, password123.</div>' : '';
    const body = `${passwordWarning}${conflict}<div class="account-summary"><span class="account-avatar" aria-hidden="true">${esc(account.user.username.slice(0, 1).toUpperCase())}</span><div><b>${esc(account.user.username)}</b><span>${esc(status)}</span></div></div><p class="muted">Changes are saved locally first, then synchronized to this account. You can sign into the same account from another browser or device that can reach this server.</p>
      <div class="portal-cookie-manager"><h3>MyPortal session</h3><p data-portal-session-status role="status">Current Session Status: <span data-portal-session-value>Checking…</span></p><p class="muted" data-portal-cookie-status role="status">Checking session settings…</p>
      <form class="form" data-form="portal-cookies" hidden><label class="fld full"><span>Cookie JSON file</span><input name="cookies" type="file" accept=".json,application/json" required aria-describedby="portal-cookie-help"></label><p id="portal-cookie-help" class="muted fld full">Sign in to MyPortal, then export its cookies as JSON. Uploading verifies your login and replaces the saved session on this server.</p><div class="fld full"><button class="btn primary" type="submit">Upload and update session</button></div></form></div>`;
    const conflictActions = account.conflict ? '<button class="btn" data-act="account-reload">Use server copy</button><button class="btn danger" data-act="account-overwrite">Use this browser copy</button>' : '<button class="btn primary" data-act="account-sync">Sync now</button>';
    return { body, foot: `<button class="btn grow" data-act="account-logout">Sign out</button><button class="btn" data-act="account-password">Change password</button>${conflictActions}` };
  }

  function renderPortalSessionStatus(manager, data) {
    const line = $('[data-portal-session-status]', manager);
    const value = $('[data-portal-session-value]', manager);
    line.hidden = data.canManage === false;
    value.textContent = data.valid ? (data.displayName || 'Session Valid') : 'Session Invalid';
    value.className = data.valid ? 'portal-session-valid' : 'portal-session-invalid';
  }

  async function loadPortalCookieStatus() {
    const status = $('[data-portal-cookie-status]', dlg);
    if (!status || !account.authenticated) return;
    const userId = account.user.id;
    try {
      const response = await fetch('/api/myportal-cookies', { headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load MyPortal session settings');
      if (!status.isConnected || account.user?.id !== userId) return;
      renderPortalSessionStatus(status.parentElement, data);
      status.textContent = data.canManage ? (data.configured ? 'A saved session is configured. Upload fresh cookies when it expires.' : 'No usable session is configured. Upload cookies to connect MyPortal.') : 'This server’s MyPortal session is managed by its owner account.';
      $('form[data-form="portal-cookies"]', status.parentElement).hidden = !data.canManage;
    } catch (error) {
      if (status.isConnected) {
        status.textContent = error.message;
        const value = $('[data-portal-session-value]', status.parentElement);
        value.textContent = 'Unable to check';
        value.className = '';
      }
    }
  }

  async function uploadPortalCookies(form) {
    const file = form.elements.cookies.files[0];
    if (!file || !account.authenticated) return;
    const status = $('[data-portal-cookie-status]', form.parentElement);
    const button = $('button[type="submit"]', form);
    button.disabled = true;
    form.setAttribute('aria-busy', 'true');
    status.textContent = 'Verifying your MyPortal login and saving the session…';
    try {
      if (file.size > 1_000_000) throw new Error('Choose a cookie JSON file smaller than 1 MB');
      let cookies;
      try { cookies = JSON.parse(await file.text()); }
      catch (error) { throw new Error('This file is not valid JSON. Choose a browser cookie export.'); }
      const response = await fetch('/api/myportal-cookies', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ cookies }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not update the MyPortal session');
      form.reset();
      renderPortalSessionStatus(form.parentElement, data);
      status.textContent = 'MyPortal login verified and session updated. You can now import your transcript.';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
      form.removeAttribute('aria-busy');
    }
  }

  function openPasswordChange() {
    const body = `<form class="form" data-form="password" autocomplete="on"><label class="fld full"><span>Current password</span><input name="currentPassword" type="password" autocomplete="current-password" required></label><label class="fld full"><span>New password</span><input name="newPassword" type="password" minlength="10" maxlength="72" autocomplete="new-password" required><small>At least 10 characters and no more than 72 UTF-8 bytes.</small></label><label class="fld full"><span>Confirm new password</span><input name="confirmPassword" type="password" minlength="10" maxlength="72" autocomplete="new-password" required></label><button hidden type="submit"></button></form>`;
    $('#settings-panel-profile', dlg).innerHTML = body + '<div class="settings-actions"><button class="btn" data-act="account">Cancel</button><button class="btn primary" data-act="account-password-save">Change password</button></div>';
  }

  async function changeAccountPassword() {
    const form = $('form[data-form="password"]', dlg); if (!form) return;
    const fd = new FormData(form), currentPassword = String(fd.get('currentPassword') || ''), newPassword = String(fd.get('newPassword') || ''), confirmation = String(fd.get('confirmPassword') || '');
    if (newPassword !== confirmation) return toast('New passwords do not match');
    const button = $('[data-act="account-password-save"]', dlg); if (button) button.disabled = true;
    try {
      const response = await fetch('/api/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await response.json();
      if (response.status === 401) throw new Error(data.error || 'Current password is incorrect');
      if (!response.ok) throw new Error(data.error || 'Password change failed');
      account.user.mustChangePassword = false;
      openSettings('profile'); toast('Password changed; other client sessions were signed out');
    } catch (error) {
      toast(error.message); if (button) button.disabled = false;
    }
  }

  async function authenticateAccount(mode) {
    const form = $('form[data-form="account"]', dlg); if (!form) return;
    const fd = new FormData(form), username = String(fd.get('username') || '').trim(), password = String(fd.get('password') || '');
    const buttons = $$('[data-act="account-login"], [data-act="account-register"]', dlg);
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const response = await fetch(mode === 'register' ? '/api/register' : '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `${mode === 'register' ? 'Registration' : 'Sign in'} failed`);
      Object.assign(account, { authenticated: true, user: data.user, revision: 0, updatedAt: null, conflict: null });
      localStorage.removeItem(SKIP_DEFAULT_LOGIN_KEY);
      lastRemoteJson = '';
      renderAccountIndicator();
      const synchronized = await loadRemoteSchedule();
      openSettings('profile');
      if (synchronized) toast(mode === 'register' ? 'Account created and schedule synced' : `Signed in as ${data.user.username}`);
    } catch (error) {
      toast(error.message);
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  async function logoutAccount() {
    try { await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (error) { /* Clear the local session view even if the server is unavailable. */ }
    localStorage.setItem(SKIP_DEFAULT_LOGIN_KEY, '1');
    setSignedOut(); openSettings('profile'); toast('Signed out; this browser copy remains available');
  }

  function openCatalogSchedule(id) {
    const c = byId(id); if (!c) return;
    const cx = ctx();
    if (c.term === cx.curId && !currentCourseEditable(c, cx)) return openCourse(id);
    const assign = E.currentAssign(cx);
    const terms = S.terms;
    const rows = terms.map((term) => {
      const problems = placementProblems(cx, assign, c, term);
      const assigned = c.term === term;
      return `<div class="row"><div class="grow"><b>${esc(tlabel(term))}</b>${problems.length && !assigned ? `<br><span class="muted">${esc(problems[0].msg)}</span>` : ''}</div><button class="btn sm ${term === cx.curId ? 'primary' : ''}" data-act="catalog-place" data-id="${esc(c.id)}" data-term="${term}" ${assigned ? 'disabled' : ''}>${assigned ? 'Scheduled' : 'Choose'}</button></div>`;
    }).join('');
    const foot = `${c.term ? '<button class="btn grow" data-act="catalog-unschedule" data-id="' + esc(c.id) + '">Unschedule</button>' : '<span class="grow"></span>'}<button class="btn" data-act="close">Cancel</button>`;
    openDlg(dlgShell(`Schedule ${esc(c.code)}`, `<div class="callout"><b>${esc(c.title)}</b><br>Select any semester. Schedule will load MyPortal sections and recommend a conflict-free option.</div>${rows || '<div class="empty">No current or future semesters are available.</div>'}`, foot));
  }

  let editing = null; // {course, isNew}
  async function openCourse(id, presetTerm) {
    const isNew = !id;
    const c = isNew ? fixCourse({ id: 'c' + Date.now().toString(36), code: '', title: '', category: 'elective', credits: 3, term: presetTerm || null, custom: true }) : byId(id);
    if (!isNew && c?.term && c.term !== 'TR' && /^https?:$/.test(location.protocol)) {
      try { await ensureSections(c, c.term); } catch (error) { /* Keep saved data when the local catalog is unavailable. */ }
    }
    editing = { c, isNew };
    const cx = isNew ? E.makeCtx([...S.courses, c], S.settings) : ctx();
    const assign = E.currentAssign(cx);
    const termLocked = !isNew && c.term === cx.curId && !currentCourseEditable(c, cx);
    const termOpts = ['', 'TR', ...S.terms].map((t) => {
      let note = '';
      if (t && t !== 'TR') { const p = placementProblems(cx, assign, c, t); note = p.length ? `  ✗ ${p[0].msg}` : '  ✓'; }
      return `<option value="${t}" ${c.term === t || (!c.term && t === '') ? 'selected' : ''}>${esc(t === 'TR' ? 'Transfer credit' : t ? tlabel(t) : 'Unscheduled')}${esc(note)}</option>`;
    }).join('');
    const st = E.statusOf(cx, c), cur = c.term ? E.tkey(c.term) : null;
    const pre = c.prereq.groups.map((g) => {
      const cat = g.codes.flatMap((x) => cx.idx[x] || []).filter((x) => x.id !== c.id);
      let ok = null;
      if (cat.length && cur != null) ok = cat.some((x) => assign[x.id] && E.tkey(assign[x.id]) < cur && (!g.minGrade || E.gradePts(x.grade) == null || E.gradePts(x.grade) >= E.gradePts(g.minGrade)));
      const mark = !cat.length ? '<span class="chip">external</span>' : ok === null ? '<span class="chip">—</span>' : ok ? '<span class="chip grade">met</span>' : '<span class="chip err">not met</span>';
      return `<li>${mark} ${g.codes.map(esc).join(' <span class="muted">or</span> ')}${g.minGrade ? ` <span class="muted">(${esc(g.minGrade)} or better)</span>` : ''}</li>`;
    });
    if (c.prereq.standing) pre.push(`<li><span class="chip">standing</span> ${c.prereq.standing === 'SR' ? 'Senior' : 'Junior'} (${c.prereq.standing === 'SR' ? S.settings.srAt : S.settings.jrAt} cr)</li>`);
    c.prereq.notes.forEach((n) => pre.push(`<li><span class="chip">note</span> ${esc(n)}</li>`));
    const deps = [...(cx.dependents[c.id] || [])];
    const myIssues = isNew ? [] : (LIVE.issues.byCourse[c.id] || []);
    const termSections = c.term ? sectionsFor(c, c.term) : [];
    const portalTerm = c.term ? c.portal?.byTerm?.[c.term] : null;
    const canRefresh = !isNew && /^[A-Z]{2,9}\s+\d{3,4}$/.test(c.code);
    const refreshSectionsButton = canRefresh
      ? `<button type="button" class="btn sm" data-act="refresh-course" data-id="${esc(c.id)}" ${courseRefreshBusy.has(c.id) ? 'disabled' : ''}>${courseRefreshBusy.has(c.id) ? 'Refreshing…' : '↻ Refresh from MyPortal'}</button>` : '';
    const sectionOptions = termSections.map((section) => {
      const label = [section.onlineSession || section.sectionCode, section.daysLabel, sectionTime(section), sectionProfessor(section), `${section.beginDate}–${section.endDate}`, section.status].filter(Boolean).join(' · ');
      return `<option value="${esc(sectionKey(section))}" ${sectionKey(section) === sectionKey(c.section) ? 'selected' : ''}>${esc(label)}</option>`;
    }).join('');
    const sectionBlock = c.term && c.term !== 'TR' ? `<div class="form-section-title with-action fld full"><span>Class schedule</span>${refreshSectionsButton}</div>
      ${termSections.length ? `<label class="fld full"><span>MyPortal section</span><select name="section"><option value="">Recommend a conflict-free section</option>${sectionOptions}</select><small>R means Thursday. Saving a changed term recommends a non-overlapping section automatically.</small></label>`
        : `<div class="callout warn fld full"><b>${portalTerm?.source === 'spreadsheet' ? 'Spreadsheet fallback' : 'Section data not loaded'}</b><br>${portalTerm?.source === 'spreadsheet' ? 'This course is not listed in MyPortal for this semester, so its spreadsheet information is retained.' : 'Sync MyPortal from the Timeline tab to load sections, dates, days, and times.'}</div>`}
      ${c.section ? `<div class="course-facts fld full"><div><span>Section</span><b>${esc(c.section.onlineSession || c.section.sectionCode || '—')}</b></div><div><span>Professor</span><b>${esc(sectionProfessor(c.section))}</b></div><div><span>Days</span><b>${esc(c.section.daysLabel || 'Online/TBA')}</b></div><div><span>Time</span><b>${esc(sectionTime(c.section))}</b></div><div><span>Class dates</span><b>${esc(c.section.beginDate || '—')}–${esc(c.section.endDate || '—')}</b></div></div>` : ''}` : '';
    const portalTerms = Object.entries(c.portal?.byTerm || {}).sort(([a], [b]) => E.tkey(a) - E.tkey(b));
    const portalOverview = portalTerms.length > 1 ? `<div class="form-section-title fld full"><span>Published MyPortal terms</span></div>
      <div class="portal-term-list fld full">${portalTerms.map(([term, data]) => {
        const sections = data.sections || [];
        const details = sections.length
          ? sections.map((section) => esc([section.onlineSession || section.sectionCode, section.daysLabel, sectionTime(section), sectionProfessor(section), `${section.beginDate}–${section.endDate}`].filter(Boolean).join(' · '))).join('<br>')
          : data.source === 'spreadsheet' ? 'Not published; spreadsheet data retained' : 'Not listed in this published term';
        return `<div class="portal-term-row"><b>${esc(data.termLabel || tlabel(term))}</b><span>${details}</span></div>`;
      }).join('')}</div>` : '';
    const body = `<form class="form" data-form="course" autocomplete="off">
      ${myIssues.length ? `<div class="callout err fld full">${myIssues.map((i) => esc(i.msg)).join('<br>')}</div>` : ''}
      <div class="course-facts fld full"><div><span>Status</span><b>${esc(st)}</b></div><div><span>Credits</span><b>${c.credits}</b></div><div><span>Offered</span><b>${esc(c.offered ? OFF_NAME[c.offered] || c.offered : 'Unknown')}</b></div><div><span>Category</span><b>${esc(CAT_NAME[c.category] || c.category)}</b></div></div>
      <div class="form-section-title fld full"><span>Course information</span></div>
      <label class="fld"><span>Code</span><input name="code" value="${esc(c.code)}" required class="mono"></label>
      <label class="fld"><span>Title</span><input name="title" value="${esc(c.title)}" required></label>
      <label class="fld"><span>Term</span>${termLocked ? `<input type="hidden" name="term" value="${esc(c.term)}">` : ''}<select name="term" ${termLocked ? 'disabled' : ''}>${termOpts}</select>${termLocked ? '<small>The class is already in session.</small>' : ''}</label>
      <label class="fld"><span>Grade ${st === 'current' ? '(so far)' : ''}</span><select name="grade"><option value=""></option>${E.GRADES.map((g) => `<option ${c.grade === g ? 'selected' : ''}>${g}</option>`).join('')}</select></label>
      <label class="fld"><span>Credits</span><input name="credits" type="number" min="0" max="12" step="1" value="${c.credits}"></label>
      <label class="fld"><span>Offered</span><select name="offered">${[['', 'Unknown'], ['ALL', 'Any term'], ['FA', 'Fall'], ['SP', 'Spring'], ['SU', 'Summer']].map(([v, l]) => `<option value="${v}" ${(c.offered || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="fld"><span>Category</span><select name="category">${['gened', 'program', 'elective'].map((k) => `<option value="${k}" ${c.category === k ? 'selected' : ''}>${CAT_NAME[k]}</option>`).join('')}</select></label>
      <label class="fld check"><input type="checkbox" name="locked" ${c.locked ? 'checked' : ''}><span>Pin to this term (optimizer won't move it)</span></label>
      ${sectionBlock}
      ${portalOverview}
      <div class="form-section-title fld full"><span>Requirements</span></div>
      <label class="fld full"><span>Prerequisites (text)</span><input name="prereq" value="${esc(c.prereqText)}" placeholder='e.g. "C" or better in MA 164 · CS 1123 or ECE 273 · SE 153, SE 233 · Sr. Standing'>
        <small>Parsed on save. Codes not in your catalog count as met (placement / transfer).</small></label>
      <div class="fld full"><span>Parsed prerequisites</span><ul class="plain">${pre.join('') || '<li class="muted">none</li>'}</ul></div>
      ${deps.length ? `<div class="fld full"><span>Required by</span><div>${deps.map((d) => `<button type="button" class="link mono" data-act="open" data-id="${esc(d.id)}">${esc(d.code)}</button> <span class="muted">(${esc(d.term ? tshort(d.term) : 'unscheduled')})</span>`).join(' · ')}</div></div>` : ''}
      <div class="form-section-title fld full"><span>Notes</span></div>
      <label class="fld full"><span>Notes</span><textarea name="notes" rows="2">${esc(c.notes)}</textarea></label>
      <button hidden type="submit"></button></form>`;
    const foot = `${!isNew ? (c.custom && !termLocked ? '<button class="btn danger grow" data-act="delete-course">Delete</button>' : c.term && !termLocked ? '<button class="btn grow" data-act="unschedule">Unschedule</button>' : '<span class="grow"></span>') : '<span class="grow"></span>'}
      <button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="save-course">${isNew ? 'Add course' : 'Save'}</button>`;
    openDlg(dlgShell(`${esc(c.code || 'New course')} ${c.title ? `<span class="muted" style="font-weight:400">— ${esc(c.title)}</span>` : ''}`, body, foot));
  }
  async function saveCourse() {
    const f = $('form[data-form="course"]', dlg); if (!f || !editing) return;
    const fd = new FormData(f), { c, isNew } = editing;
    const code = String(fd.get('code')).trim().toUpperCase().replace(/\s+/, ' '), title = String(fd.get('title')).trim();
    if (!code || !title) return toast('Code and title are required');
    const credits = Math.max(0, Math.min(12, Number(fd.get('credits')) || 0));
    const cx = ctx(), termLocked = !isNew && c.term === cx.curId && !currentCourseEditable(c, cx);
    const targetTerm = termLocked ? c.term : fd.get('term') || null;
    let selectedSection = targetTerm === c.term ? c.section : null;
    if (targetTerm && targetTerm !== 'TR') {
      try {
        if (isNew) Object.assign(c, { code, title });
        const sections = await ensureSections(c, targetTerm);
        const requested = targetTerm === c.term ? String(fd.get('section') || '') : '';
        const upcomingOnly = false;
        const requestedSection = sections.find((s) => sectionKey(s) === requested);
        selectedSection = requestedSection && (!upcomingOnly || sectionNotStarted(requestedSection)) ? requestedSection : recommendSection(c, targetTerm, sectionKey(c.section), upcomingOnly);
        if (sections.length && !selectedSection) return toast(`Cannot schedule ${code}: ${upcomingOnly ? 'no not-yet-started section fits your schedule' : 'every published section overlaps another class'}`);
        if (upcomingOnly && !selectedSection) return toast(`Cannot schedule ${code}: no compatible section is available`);
        const conflicts = selectedSection ? sectionConflicts(c, selectedSection, targetTerm) : [];
        if (conflicts.length) return toast(`${sectionSummary(selectedSection)} overlaps ${conflicts.map((x) => x.code).join(', ')}`);
      } catch (err) {
        if (targetTerm === cx.curId && (isNew || c.term !== cx.curId)) return toast(`Cannot verify a future start date for ${code}: ${err.message}`);
        selectedSection = targetTerm === c.term ? c.section : null;
        toast(`Could not check MyPortal; using spreadsheet data: ${err.message}`);
      }
    }
    mutate(() => {
      const target = isNew ? c : byId(c.id);
      Object.assign(target, { code, title, credits, term: targetTerm, section: selectedSection, grade: fd.get('grade') || null, offered: fd.get('offered') || null, category: fd.get('category'), notes: String(fd.get('notes')).trim(), locked: !!fd.get('locked') });
      const pt = String(fd.get('prereq')).trim();
      if (pt !== target.prereqText || isNew) { target.prereqText = pt; target.prereq = E.parsePrereq(pt); }
      if (isNew) S.courses.push(target);
    });
    closeDlg(); toast(isNew ? 'Course added' : 'Saved');
  }

  /* ---------- spreadsheet course enrichment ---------- */
  function coursePayload(c, term = c.term) { return { id: c.id, code: c.code, alt: c.alt || [], title: c.title, term: term || '' }; }
  function mergePortalData(data) {
    for (const [id, incoming] of Object.entries(data.courses || {})) {
      const c = byId(id); if (!c) continue;
      c.portal = { byTerm: incoming.byTerm || {} };
    }
    if (data.publishedTerms) S.meta.portalPublishedTerms = data.publishedTerms;
  }
  async function requestEnrichment(courses, fromTerm = E.currentTermId(S.settings)) {
    const response = await fetch('/api/course-enrichment', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ fromTerm, courses }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    mergePortalData(data);
    return data;
  }
  async function ensureSections(c, term) {
    if (!term || term === 'TR') return [];
    const cached = sectionsFor(c, term);
    const cachedTerm = c.portal?.byTerm?.[term];
    const preferred = sectionKey(c.section);
    let data;
    try {
      data = await requestEnrichment([coursePayload(c, term)], term);
    } catch (error) {
      // A listed section remains editable while the catalog is refreshing or
      // temporarily unavailable. The next successful hydration replaces it
      // with the canonical SQLite copy.
      if (cached.length) return cached;
      throw error;
    }
    if (!byId(c.id)) {
      c.portal ||= { byTerm: {} };
      Object.assign(c.portal.byTerm, data.courses?.[c.id]?.byTerm || {});
    }
    const current = byId(c.id) || c;
    const fresh = sectionsFor(current, term);
    const sections = E.sectionsForEdit(fresh, cached);
    if (sections === cached && cached.length && cachedTerm) {
      current.portal ||= { byTerm: {} };
      current.portal.byTerm[term] = cachedTerm;
    }
    if (current.term === term && current.section) {
      current.section = sections.find((section) => sectionKey(section) === preferred) || null;
      save();
    }
    return sections;
  }
  async function syncMyPortal(silent = false) {
    if (portalSyncBusy) return;
    portalSyncBusy = true; render();
    if (!silent) toast('Refreshing the local MyPortal catalog…');
    try {
      const preferred = new Map(S.courses.map((c) => [c.id, sectionKey(c.section)]));
      const refreshResponse = await fetch('/api/catalog-refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}',
      });
      const refreshed = await refreshResponse.json();
      if (!refreshResponse.ok) throw new Error(refreshed.error || `Catalog refresh failed (${refreshResponse.status})`);
      portal.options = null;
      const data = S.courses.length
        ? await requestEnrichment(S.courses.map((c) => coursePayload(c)))
        : { errors: [] };
      for (const c of S.courses) if (c.term && c.portal?.byTerm?.[c.term]) c.section = null;
      for (const c of [...S.courses].filter((x) => x.term).sort((a, b) => E.tkey(a.term) - E.tkey(b.term) || cmpCode(a, b))) {
        if (sectionsFor(c, c.term).length) c.section = recommendSection(c, c.term, preferred.get(c.id));
      }
      S.meta.portalSyncedAt = refreshed.catalog?.syncedAt || new Date().toISOString();
      save();
      const matched = S.courses.filter((c) => c.term && c.portal?.byTerm?.[c.term]?.source === 'myportal').length;
      const fallback = S.courses.filter((c) => c.term && c.portal?.byTerm?.[c.term]?.source === 'spreadsheet').length;
      if (!silent) toast(`MyPortal catalog: ${refreshed.sections} sections · ${matched} matched · ${fallback} spreadsheet fallback${data.errors?.length ? ` · ${data.errors.length} error(s)` : ''}`);
    } catch (err) {
      if (!silent) toast(`MyPortal sync failed: ${err.message}`);
    } finally { portalSyncBusy = false; render(); }
  }

  async function refreshCourse(id, button) {
    const c = byId(id);
    if (!c || courseRefreshBusy.has(id)) return;
    if (!/^[A-Z]{2,9}\s+\d{3,4}L?(?:\s+\d{1,4})?$/.test(c.code)) return toast('A standard course code is required to refresh sections');
    const reopen = dlg.open && editing?.c.id === id;
    const preferred = sectionKey(c.section);
    courseRefreshBusy.add(id);
    if (button instanceof HTMLButtonElement) { button.disabled = true; button.textContent = 'Refreshing…'; }
    render();
    toast(`Refreshing ${c.code} from MyPortal…`);
    try {
      const response = await fetch('/api/course-refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ courseCode: c.code, title: c.title }),
      });
      const refreshed = await response.json();
      if (!response.ok) throw new Error(refreshed.error || `Course refresh failed (${response.status})`);
      portal.options = null;
      await requestEnrichment([coursePayload(c)], c.term || E.currentTermId(S.settings));
      if (c.term) {
        const sections = sectionsFor(c, c.term);
        c.section = sections.find((section) => sectionKey(section) === preferred)
          || recommendSection(c, c.term, '', false);
      }
      S.meta.portalSyncedAt = refreshed.refreshedAt || S.meta.portalSyncedAt;
      save(); render();
      const termCount = refreshed.terms?.filter((term) => term.sections).length || 0;
      toast(`${c.code}: ${refreshed.sections} section${refreshed.sections === 1 ? '' : 's'} refreshed across ${termCount} term${termCount === 1 ? '' : 's'}`);
    } catch (error) {
      toast(`${c.code} refresh failed: ${error.message}`);
    } finally {
      courseRefreshBusy.delete(id);
      render();
      if (reopen && dlg.open) await openCourse(id);
    }
  }

  async function hydrateMyPortal() {
    if (!/^https?:$/.test(location.protocol) || !S.courses.length) return;
    try {
      const statusResponse = await fetch('/api/catalog-status', { headers: { Accept: 'application/json' } });
      const status = await statusResponse.json();
      if (!statusResponse.ok || !status.available) return;
      const preferred = new Map(S.courses.map((c) => [c.id, sectionKey(c.section)]));
      await requestEnrichment(S.courses.map((c) => coursePayload(c)));
      for (const c of S.courses) {
        if (!c.term || !c.portal?.byTerm?.[c.term]) continue;
        c.section = recommendSection(c, c.term, preferred.get(c.id));
      }
      S.meta.portalSyncedAt = status.syncedAt || S.meta.portalSyncedAt;
      save(); render();
    } catch (error) { /* The planner remains usable with its saved data. */ }
  }

  /* ---------- live MyPortal course search ---------- */
  let portal = { options: null, optionsMode: '', results: [], query: {}, loading: false, error: '', mode: 'live' };
  const optionsHtml = (items, value) => items.map((o) => `<option value="${esc(o.value)}" ${o.value === value ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
  function renderCatalogSearch() {
    if (!portal.options) {
      openPortalSearch('catalog');
      return;
    }
    portal.mode = 'catalog';
    renderPortalSearch();
  }

  function renderPortalSearch() {
    const live = portal.mode !== 'catalog';
    if (!portal.options) {
      openDlg(dlgShell('Search MyPortal', `<div class="callout ${portal.error ? 'err' : ''}">${portal.error ? esc(portal.error) : 'Loading current terms and search options…'}</div>`, portal.error ? '<button class="btn" data-act="close">Close</button><button class="btn primary" data-act="live-search">Try again</button>' : ''), true);
      return;
    }
    const o = portal.options, q = portal.query;
    const updated = o.catalog?.syncedAt ? ` Last updated ${new Date(o.catalog.syncedAt).toLocaleString()}.` : '';
    const title = live ? 'Search MyPortal live' : 'Search saved MyPortal catalog';
    const action = live ? 'live-search' : 'catalog-search';
    const form = `<form class="form portal-form" data-form="${action}" autocomplete="off">
      <div class="callout fld full"><b>${live ? 'Live MyPortal search' : 'Local MyPortal catalog'}</b><br>${live ? 'Searches contact MyPortal directly to find course metadata. Results can be added to your plan.' : `Searches use the completed SQLite snapshot and do not contact MyPortal.${esc(updated)} Results are read-only until you add one to the plan.`}</div>
      <label class="fld"><span>Term</span><select name="term" required>${optionsHtml(o.terms, q.term || o.terms.find((x) => x.value)?.value)}</select></label>
      <label class="fld"><span>Department</span><select name="department">${optionsHtml(o.departments, q.department || '')}</select></label>
      <label class="fld"><span>Course number</span><input name="courseNumber" value="${esc(q.courseNumber || '')}" placeholder="e.g. 253"></label>
      <label class="fld"><span>Title contains</span><input name="title" value="${esc(q.title || '')}" placeholder="e.g. artificial intelligence"></label>
      <label class="fld"><span>Division</span><select name="division">${optionsHtml(o.divisions, q.division || 'UG')}</select></label>
      <label class="fld"><span>Campus</span><select name="campus">${optionsHtml(o.campuses, q.campus || '')}</select></label>
      <label class="fld"><span>Section status</span><select name="status">${optionsHtml(o.statuses, q.status || 'OpenFull')}</select></label>
      <div class="fld" style="justify-content:flex-end"><button class="btn primary" type="submit" ${portal.loading ? 'disabled' : ''}>${portal.loading ? 'Searching…' : 'Search courses'}</button></div>
    </form>`;
    const results = portal.error ? `<div class="callout err">${esc(portal.error)}</div>` : portal.loading ? '<div class="empty">Searching MyPortal…</div>'
      : portal.searched && !portal.results.length ? '<div class="empty">No matching courses found.</div>'
      : portal.results.length ? `<div class="scroll portal-results"><table class="t"><thead><tr><th>Course</th><th>Title</th><th>Section</th><th>Professor</th><th>Seats</th><th>Status</th><th>Days / time</th><th>Cr</th><th>Dates</th><th></th></tr></thead><tbody>${portal.results.map((r, i) => {
        const existing = S.courses.some((c) => c.code === r.baseCode || (c.alt || []).includes(r.baseCode));
        return `<tr><td class="mono">${esc(r.courseCode)}</td><td>${esc(r.title)}</td><td><span class="chip prov">${esc(r.onlineSession || r.sectionCode || '—')}</span><br><span class="muted">${esc(r.modality || '')}</span></td><td>${esc(sectionProfessor(r))}</td><td>${esc(r.seats)}</td><td><span class="chip ${r.status === 'Open' ? 'grade' : 'warn'}">${esc(r.status)}</span></td><td><b>${esc(r.daysLabel || 'TBA')}</b><br>${esc(sectionTime(r))}<br><span class="muted">${esc(r.timeOfDay || '')}</span></td><td class="num">${esc(r.credits)}</td><td>${esc(r.beginDate)}<br><span class="muted">to ${esc(r.endDate)}</span></td><td><button class="btn sm" data-act="add-portal-course" data-i="${i}">${existing ? 'Schedule' : 'Add to plan'}</button></td></tr>`;
      }).join('')}</tbody></table></div>` : '';
    openDlg(dlgShell(title, form + results, '<button class="btn" data-act="close">Close</button>'), true);
  }
  async function openPortalSearch(mode = 'live') {
    portal.mode = mode;
    portal.error = '';
    if (portal.options && portal.optionsMode === portal.mode) return renderPortalSearch();
    portal.options = null;
    portal.optionsMode = portal.mode;
    renderPortalSearch();
    try {
      const optionsEndpoint = portal.mode === 'live' ? '/api/course-search-live/options' : '/api/course-search/options';
      const response = await fetch(optionsEndpoint, { headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      portal.options = data;
      portal.optionsMode = portal.mode;
    } catch (err) { portal.error = err.message + '. Start the app with python3 server.py.'; }
    renderPortalSearch();
  }
  async function searchMyPortal(form) {
    const fd = new FormData(form);
    portal.query = Object.fromEntries(fd.entries()); portal.loading = true; portal.error = ''; portal.searched = true; renderPortalSearch();
    try {
      const endpoint = portal.mode === 'catalog' ? '/api/course-search' : '/api/course-search-live';
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(portal.query) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      portal.results = data.results || [];
    } catch (err) { portal.error = err.message; portal.results = []; }
    portal.loading = false; renderPortalSearch();
  }
  function addPortalCourse(index) {
    const r = portal.results[index]; if (!r) return;
    const existing = S.courses.find((c) => c.code === r.baseCode || (c.alt || []).includes(r.baseCode));
    const currentTerm = E.currentTermId(S.settings);
    if (existing?.term === currentTerm && !currentCourseEditable(existing) && r.planTerm !== existing.term) return toast(`${existing.code} has already started and cannot be moved to another semester`);
    const conflictTarget = existing || { id: '__new__' };
    const conflicts = r.planTerm ? sectionConflicts(conflictTarget, r, r.planTerm) : [];
    if (conflicts.length) return toast(`${sectionSummary(r)} overlaps ${conflicts.map((c) => c.code).join(', ')}`);
    const detail = `MyPortal section: ${r.courseCode} · ${sectionProfessor(r)} · ${r.schedule || 'Schedule TBA'} · ${r.seats || 'Seats unknown'} · ${r.beginDate}–${r.endDate}`;
    mutate(() => {
      if (existing) {
        if (r.planTerm) Object.assign(existing, { term: r.planTerm, section: r });
        existing.portal ||= { byTerm: {} };
        if (r.planTerm) existing.portal.byTerm[r.planTerm] = { source: 'myportal', matchedBy: 'search', termLabel: r.termLabel, sections: [r] };
        existing.notes = `${existing.notes || ''}\n${detail}`.trim().replace(/(?:^|\n)MyPortal section:[^\n]*(?=\nMyPortal section:)/g, '');
        return;
      }
      S.courses.push(fixCourse({
        id: 'p' + Date.now().toString(36), code: r.baseCode || r.courseCode, alt: [], title: r.title,
        category: 'elective', credits: Number(r.credits) || 0, term: r.planTerm || null,
        offered: r.planTerm ? r.planTerm.slice(0, 2) : null, prereqText: '', notes: detail,
        custom: true, locked: false, section: r.planTerm ? r : null,
        portal: { byTerm: r.planTerm ? { [r.planTerm]: { source: 'myportal', matchedBy: 'search', termLabel: r.termLabel, sections: [r] } } : {} },
      }));
    });
    closeDlg(); toast(existing ? `${r.baseCode} scheduled from MyPortal` : `${r.baseCode} added from MyPortal`);
  }

  let availabilityRequest = 0;
  function renderAvailability(c, data, error = '') {
    if (error) {
      openDlg(dlgShell(`${esc(c.code)} availability`, `<div class="callout err">${esc(error)}</div>`, '<button class="btn" data-act="close">Close</button>'), true);
      return;
    }
    if (!data) {
      openDlg(dlgShell(`${esc(c.code)} availability`, '<div class="empty">Checking every published future term on MyPortal…</div>'), true);
      return;
    }
    const terms = data.terms || [];
    const summary = terms.length
      ? `<div class="callout ${data.availableTerms ? 'ok' : 'warn'}"><b>${data.availableTerms ? `Available in ${data.availableTerms} published term${data.availableTerms === 1 ? '' : 's'}` : 'Not found in any published future term'}.</b><br><span class="muted">MyPortal currently publishes ${terms.length} current or future term${terms.length === 1 ? '' : 's'} for this search.</span></div>`
      : '<div class="callout warn">MyPortal does not currently publish any terms at or after the planner’s current term.</div>';
    const rows = terms.map((term) => {
      const sections = term.results || [];
      if (!sections.length) return `<section class="availability-term"><h3>${esc(term.termLabel)} <span class="chip">not listed</span></h3><div class="muted">No ${esc(c.code)} sections were found.</div></section>`;
      return `<section class="availability-term"><h3>${esc(term.termLabel)} <span class="chip grade">${sections.length} section${sections.length === 1 ? '' : 's'}</span></h3>
        <div class="scroll"><table class="t"><thead><tr><th>Section</th><th>Type</th><th>Status</th><th>Seats</th><th>Professor</th><th>Days / time</th><th>Dates</th><th>Credits</th></tr></thead><tbody>${sections.map((r) => `<tr><td class="mono">${esc(r.courseCode)}</td><td><span class="chip prov">${esc(r.onlineSession || r.sectionCode || '—')}</span><br><span class="muted">${esc(r.modality || '')}</span></td><td><span class="chip ${r.status === 'Open' ? 'grade' : 'warn'}">${esc(r.status)}</span></td><td>${esc(r.seats)}</td><td>${esc(sectionProfessor(r))}</td><td><b>${esc(r.daysLabel || 'TBA')}</b><br>${esc(sectionTime(r))}<br><span class="muted">${esc(r.timeOfDay || '')}</span></td><td>${esc(r.beginDate)}<br><span class="muted">to ${esc(r.endDate)}</span></td><td class="num">${esc(r.credits)}</td></tr>`).join('')}</tbody></table></div>
      </section>`;
    }).join('');
    openDlg(dlgShell(`${esc(c.code)} availability`, summary + rows, '<button class="btn" data-act="close">Close</button>'), true);
  }
  async function openCourseAvailability(id) {
    const c = byId(id); if (!c) return;
    const token = ++availabilityRequest;
    renderAvailability(c, null);
    try {
      const response = await fetch('/api/course-availability', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ courseCode: c.code, fromTerm: E.currentTermId(S.settings) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      if (token === availabilityRequest) renderAvailability(c, data);
    } catch (err) {
      if (token === availabilityRequest) renderAvailability(c, null, err.message + (location.protocol === 'file:' ? '. Start the app with python3 server.py.' : ''));
    }
  }

  function openSettings(tab = 'general') {
    const profile = accountPanel();
    const panels = {
      general: generalPanel(),
      profile,
      data: { body: dataPanel(), foot: '' },
    };
    const labels = { general: 'General', profile: 'Account', data: 'Data & backup' };
    const tabs = Object.keys(panels).map((id) => `<button type="button" class="settings-tab" role="tab" id="settings-tab-${id}" aria-controls="settings-panel-${id}" aria-selected="${id === tab}" tabindex="${id === tab ? 0 : -1}" data-act="settings-tab" data-tab="${id}">${labels[id]}</button>`).join('');
    const content = Object.entries(panels).map(([id, panel]) => `<section id="settings-panel-${id}" role="tabpanel" aria-labelledby="settings-tab-${id}" tabindex="0" ${id === tab ? '' : 'hidden'}>${panel.body}${panel.foot ? `<div class="settings-actions">${panel.foot}</div>` : ''}</section>`).join('');
    openDlg(dlgShell('Settings', `<div class="settings-tabs" role="tablist" aria-orientation="vertical" aria-label="Settings sections">${tabs}</div>${content}`));
    dlg.classList.add('settings-dialog');
    loadPortalCookieStatus();
  }
  function selectSettingsTab(tab, focus = false) {
    $$('[data-act="settings-tab"]', dlg).forEach((button) => {
      const selected = button.dataset.tab === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
      document.getElementById(button.getAttribute('aria-controls')).hidden = !selected;
    });
  }
  function generalPanel() {
    const s = S.settings, num = (n, l, h) => `<label class="fld"><span>${l}</span><input type="number" name="${n}" value="${s[n]}" min="0" step="1">${h ? `<small>${h}</small>` : ''}</label>`;
    return { body: `<form class="form" data-form="settings">
      ${num('minLoad', 'Full-time minimum (cr / term)', 'Under this → warning (fall/spring only)')}
      ${num('maxLoad', 'Maximum load (cr / term)', 'Over this → error; optimizer cap')}
      ${num('targetCredits', 'Credits to graduate')}
      <label class="fld"><span>Current term</span><select name="currentTerm"><option value="auto" ${s.currentTerm === 'auto' ? 'selected' : ''}>Auto (from today's date: ${esc(tlabel(E.currentTermId({ currentTerm: 'auto' })))})</option>${S.terms.map((t) => `<option value="${t}" ${s.currentTerm === t ? 'selected' : ''}>${esc(tlabel(t))}</option>`).join('')}</select><small>Terms before this are treated as completed. Current-term sections can always be changed, even after classes begin.</small></label>
      ${num('jrAt', 'Junior standing at (cr earned)')}${num('srAt', 'Senior standing at (cr earned)', 'Check your catalog; used for “Jr./Sr. Standing” prereqs')}
      <label class="fld"><span>Schedule time format</span><select name="timeFormat"><option value="standard" ${s.timeFormat !== 'military' ? 'selected' : ''}>Standard (12-hour)</option><option value="military" ${s.timeFormat === 'military' ? 'selected' : ''}>Military (24-hour)</option></select><small>Controls the daily schedule hour labels and meeting times.</small></label>
      <label class="fld check full"><input type="checkbox" name="summerAll" ${s.summerAll ? 'checked' : ''}><span>Treat courses offered “ALL” as available in summer<br><small>Off by default: the control sheet does not say whether ALL includes summer. Confirm with your registrar before relying on summer plans.</small></span></label>
      <button hidden type="submit"></button></form>`, foot: '<button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="save-settings">Save</button>' };
  }
  function saveSettings() {
    const fd = new FormData($('form[data-form="settings"]', dlg));
    const n = (k) => Math.max(0, Number(fd.get(k)) || 0);
    if (n('minLoad') > n('maxLoad')) return toast('Minimum load cannot exceed maximum');
    mutate(() => Object.assign(S.settings, { minLoad: n('minLoad'), maxLoad: n('maxLoad'), targetCredits: n('targetCredits'), jrAt: n('jrAt'), srAt: n('srAt'), summerAll: !!fd.get('summerAll'), currentTerm: fd.get('currentTerm'), timeFormat: fd.get('timeFormat') === 'military' ? 'military' : 'standard' }));
    closeDlg(); toast('Settings saved');
  }

  function openData() { openSettings('data'); }

  function dataPanel() {
    return `<p class="muted">Changes are stored in this browser${account.authenticated ? ` and synchronized to ${esc(account.user.username)}` : ' (localStorage)'}. Export a JSON backup for an additional portable copy.</p>
      <div class="row"><span class="grow"><b>MyPortal transcript</b><br><span class="muted">Use official GPA credits and quality points. Sign in to the account that owns the portal cookie store.</span></span><button class="btn" data-act="import-transcript">Import transcript</button>${S.meta?.transcript ? '<button class="btn" data-act="clear-transcript">Use planner GPA</button>' : ''}</div>
      <div class="row"><span class="grow"><b>Backup</b><br><span class="muted">Full state: courses, terms, settings</span></span><button class="btn" data-act="export-json">Export JSON</button><button class="btn" data-act="import-json">Import JSON…</button></div>
      <div class="row"><span class="grow"><b>Schedule as CSV</b><br><span class="muted">One row per course. Code and Title are required; Term may be an ID such as FA26 or a label such as Fall 2026.</span></span><button class="btn" data-act="export-csv">Export CSV</button><button class="btn" data-act="import-csv">Import CSV…</button></div>
      <div class="row"><span class="grow"><b>Start a blank schedule</b><br><span class="muted">Removes the spreadsheet courses and starts with the current semester.</span></span><button class="btn danger" data-act="blank">Create blank…</button></div>
      <div class="row"><span class="grow"><b>Reset plan</b><br><span class="muted">Discards all courses and starts a blank local schedule.</span></span><button class="btn danger" data-act="reset">Reset…</button></div>`;
  }
  let transcriptBusy = false;
  async function importTranscript() {
    if (transcriptBusy) return;
    if (!account.authenticated) { toast('Sign in before importing your transcript'); openAccount(); return; }
    transcriptBusy = true;
    const ownerId = account.user.id, targetState = S;
    const button = $('[data-act="import-transcript"]', dlg);
    if (button) { button.disabled = true; button.textContent = 'Importing…'; }
    try {
      const response = await fetch('/api/transcript', { method: 'POST', headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Transcript import failed');
      if (!account.authenticated || account.user.id !== ownerId || S !== targetState)
        throw new Error('The active schedule changed. Import the transcript again');
      mutate(() => { S.meta = { ...S.meta, transcript: data }; });
      closeDlg(); toast('Transcript imported. GPA now uses MyPortal totals');
    } catch (error) {
      toast(error.message);
    } finally {
      transcriptBusy = false;
      if (button) { button.disabled = false; button.textContent = 'Import transcript'; }
    }
  }
  function exportCsv() {
    const cx = ctx(), q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Term', 'Code', 'Title', 'Credits', 'Grade', 'Status', 'Category', 'Offered', 'Section', 'Professor', 'Days', 'Time', 'Time of day', 'Class start', 'Class end', 'Source', 'Prerequisites'], ...[...S.courses].sort((a, b) => (a.term ? E.tkey(a.term) : 1e9) - (b.term ? E.tkey(b.term) : 1e9) || cmpCode(a, b))
      .map((c) => [tlabel(c.term), c.code, c.title, c.credits, c.grade || '', E.statusOf(cx, c), CAT_NAME[c.category] || c.category, c.offered || '', c.section?.onlineSession || c.section?.sectionCode || '', c.section?.faculty || '', c.section?.daysLabel || '', c.section ? sectionTime(c.section) : '', c.section?.timeOfDay || '', c.section?.beginDate || '', c.section?.endDate || '', c.term ? c.portal?.byTerm?.[c.term]?.source || 'spreadsheet' : 'spreadsheet', c.prereqText])];
    download('schedule.csv', rows.map((r) => r.map(q).join(',')).join('\n'), 'text/csv');
  }
  function parseCsv(text) {
    const rows = [], row = [], field = [];
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i], next = text[i + 1];
      if (ch === '"') {
        if (quoted && next === '"') { field.push('"'); i++; } else quoted = !quoted;
      } else if (ch === ',' && !quoted) { row.push(field.join('')); field.length = 0; }
      else if ((ch === '\n' || ch === '\r') && !quoted) {
        if (ch === '\r' && next === '\n') i++;
        row.push(field.join('')); field.length = 0;
        if (row.some((value) => value.trim())) rows.push(row.splice(0));
      } else field.push(ch);
    }
    if (field.length || row.length) { row.push(field.join('')); if (row.some((value) => value.trim())) rows.push(row); }
    if (rows.length < 2) throw new Error('CSV must include a header and at least one course');
    const headers = rows.shift().map((value) => value.trim().toLowerCase());
    const index = (names) => names.map((name) => headers.indexOf(name)).find((value) => value >= 0);
    const codeAt = index(['code', 'course code']);
    const titleAt = index(['title', 'course title', 'name']);
    if (codeAt == null || titleAt == null) throw new Error('CSV must have Code and Title columns');
    const at = (values, names) => { const i = index(names); return i == null ? '' : (values[i] || '').trim(); };
    const termId = (value) => {
      const raw = value.trim().toUpperCase();
      if (/^(FA|SP|SU)\d{2}$/.test(raw) || raw === 'TR') return raw;
      const match = /^(FALL|SPRING|SUMMER)\s+(\d{4})$/.exec(raw);
      return match ? ({ FALL: 'FA', SPRING: 'SP', SUMMER: 'SU' }[match[1]] + match[2].slice(-2)) : null;
    };
    const used = new Set(S.courses.map((c) => c.id));
    return rows.map((values, rowIndex) => {
      const code = values[codeAt].trim().toUpperCase().replace(/\s+/g, ' ');
      const title = values[titleAt].trim();
      if (!code || !title) throw new Error(`CSV row ${rowIndex + 2} needs both Code and Title`);
      const base = `csv-${code.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      let id = base, suffix = 2;
      while (used.has(id)) id = `${base}-${suffix++}`;
      used.add(id);
      const term = termId(at(values, ['term', 'semester']));
      if (at(values, ['term', 'semester']) && !term) throw new Error(`CSV row ${rowIndex + 2} has an invalid term`);
      const credits = Number(at(values, ['credits', 'credit hours'])) || 0;
      return fixCourse({
        id, code, title, credits: Math.max(0, Math.min(12, credits)), grade: at(values, ['grade']) || null,
        category: (at(values, ['category']) || 'program').toLowerCase(), offered: at(values, ['offered']) || null,
        prereqText: at(values, ['prerequisites', 'prerequisite']), prereq: E.parsePrereq(at(values, ['prerequisites', 'prerequisite'])),
        notes: at(values, ['notes']), term, custom: true,
      });
    });
  }

  function openIssues() {
    const all = LIVE.issues.all;
    openDlg(dlgShell('Conflicts', all.length ? all.map((i) => `<div class="issue"><span class="lvl ${i.level}">${i.level === 'error' ? 'ERR' : 'WARN'}</span><div>${i.course ? `<button class="link" data-act="open" data-id="${esc(i.course)}">${esc(i.where)}</button>` : `<b>${esc(i.where)}</b>`}<div class="muted">${esc(i.msg)}</div></div></div>`).join('')
      : '<div class="empty">No conflicts in current or future terms.</div>'));
  }

  /* ---------- optimizer ---------- */
  function termsBetween(a, b) { let n = 0, t = a; while (E.tkey(t) < E.tkey(b) && n < 40) { t = E.nextTermId(t, false); n++; } return n; }
  function proscons(sc, base) {
    const s = sc.plan.stats, pros = [], cons = [];
    const fk = E.tkey(s.finish), bk = E.tkey(base.finish);
    if (fk < bk) pros.push(`Finishes ${E.tinfo(s.finish).label}: ${termsBetween(s.finish, base.finish)} term(s) earlier than your plan`);
    else if (fk === bk) pros.push(`Finishes ${E.tinfo(s.finish).label}, no delay`);
    else cons.push(`Pushes graduation to ${E.tinfo(s.finish).label} (+${termsBetween(base.finish, s.finish)} term)`);
    if (s.peak < base.peak) pros.push(`Lower peak load: ${s.peak} cr (was ${base.peak})`);
    else if (s.peak > base.peak) cons.push(`Heavier peak load: ${s.peak} cr (was ${base.peak})`);
    if (s.peak >= 16) cons.push(`A ${s.peak}-credit term leaves little room for a bad exam week, a job, or an internship`);
    if (s.summerCredits) cons.push(`${s.summerCredits} cr in summer. Assumes “any term” courses actually run in summer (check with registrar); costs tuition and time off`);
    const rows = s.rows, last = rows[rows.length - 1];
    if (rows.length > 1 && last.credits <= 6 && !last.summer) pros.push(`Light final term (${last.credits} cr): room for job hunting or retakes`);
    if (rows.length > 1 && rows[0].credits - last.credits >= 6) cons.push('Front-loaded: heaviest work early, with little slack if something is dropped or failed');
    if (rows.some((r) => !r.summer && r.credits < S.settings.minLoad && r !== last)) cons.push(`A term under ${S.settings.minLoad} cr (below full-time)`);
    if (S.ui.scopeAll) cons.push('Moves courses you already placed (use Pin to protect any of them)');
    return { pros, cons };
  }
  function scenCard(title, blurb, stats, issuesCount, pc, applyIdx, same) {
    const max = Math.max(S.settings.maxLoad, ...stats.rows.map((r) => r.credits), 1);
    return `<div class="scen ${applyIdx == null ? 'base' : ''}"><h3>${esc(title)}</h3><div class="muted">${esc(blurb)}</div>
      <div class="kv"><div><b>${esc(E.tinfo(stats.finish).label)}</b>finish</div><div><b>${stats.terms}</b>terms</div><div><b>${stats.peak}</b>peak cr</div><div><b>${issuesCount}</b>conflicts</div></div>
      <div class="mini">${stats.rows.map((r) => `<div class="${r.summer ? 'su' : ''}" style="height:${(r.credits / max) * 100}%" title="${esc(r.label)}: ${r.credits} cr"><span>${r.credits}</span></div>`).join('')}</div>
      <div class="mini-l">${stats.rows.map((r) => `<span>${r.term}</span>`).join('')}</div>
      ${pc ? `<ul class="pc pros">${pc.pros.map((p) => `<li>${esc(p)}</li>`).join('')}</ul><ul class="pc cons">${pc.cons.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
      <span class="grow"></span>
      ${applyIdx != null ? (same ? '<div class="muted">Identical to your current plan</div>' : `<button class="btn primary" data-act="apply" data-i="${applyIdx}">Apply this plan</button>`) : ''}</div>`;
  }
  function openOptimizer() {
    const cx = ctx(), assign = E.currentAssign(cx), base = E.planStats(cx, assign), bi = E.computeIssues(cx, assign).all.length;
    scenarios = E.scenarios(S.settings, S.courses, S.ui.scopeAll);
    const pend = scenarios.length ? scenarios[0].plan.pending.length : 0;
    const body = `<div class="callout">Scenarios place courses so every offering, prerequisite, minimum-grade, standing and credit-limit rule holds. They respect pins, completed terms and the current term.
      <label style="display:flex;gap:6px;margin-top:6px;cursor:pointer"><input type="checkbox" data-act="scope" ${S.ui.scopeAll ? 'checked' : ''}> Re-plan future terms (uncheck to place only unscheduled courses and leave everything else where it is)</label></div>
      ${scenarios.length ? '' : '<div class="callout warn">No feasible schedule within 14 terms. Check Settings (max load, summer availability) or pinned courses.</div>'}
      <div class="scen-grid">${scenCard('Current plan', 'Current schedule', base, bi, null, null)}
      ${scenarios.map((sc, i) => scenCard(sc.title, sc.blurb, sc.plan.stats, E.computeIssues(sc.plan.ctx, sc.plan.assign).all.length, proscons(sc, base), i, sc.plan.pending.every((c) => sc.plan.assign[c.id] === c.term))).join('')}</div>
      <p class="muted">${pend} course(s) are movable. Summer bars are orange. Greedy scheduler: longest prerequisite chains first, then terms-restricted courses.</p>`;
    openDlg(dlgShell('Optimize schedule', body), true);
  }
  function applyScenario(i) {
    const sc = scenarios && scenarios[i]; if (!sc) return;
    mutate(() => { for (const c of sc.plan.pending) { const t = sc.plan.assign[c.id]; Object.assign(byId(c.id), { term: t, section: null }); } });
    closeDlg(); toast(`Applied “${sc.title}”. Undo is available`);
    hydrateMyPortal();
  }

  /* ================= events ================= */
  async function placeCourse(id, term) {
    const c = byId(id); if (!c || c.term === term) return false;
    const cx = ctx();
    // Courses can be moved even when their semester is complete or in progress.
    const probs = term ? E.placementProblems(cx, E.currentAssign(cx), c, term) : [];
    let section = null;
    if (term && term !== 'TR') {
      try {
        const sections = await ensureSections(c, term);
        const upcomingOnly = term === cx.curId;
        section = recommendSection(c, term, sectionKey(c.section), upcomingOnly);
        if (sections.length && !section) { toast(`Cannot place ${c.code}: ${upcomingOnly ? 'no not-yet-started section fits your schedule' : 'every published section overlaps another class'}`); return false; }
        if (upcomingOnly && !section) { toast(`Cannot place ${c.code}: no compatible section is available`); return false; }
      } catch (err) {
        if (term === cx.curId) { toast(`Cannot verify a future start date for ${c.code}: ${err.message}`); return false; }
        toast(`MyPortal unavailable; placing ${c.code} with spreadsheet data`);
      }
    }
    mutate(() => { Object.assign(byId(id), { term: term || null, section }); });
    if (section) toast(`Placed ${c.code} · recommended ${sectionSummary(section)}`);
    else if (probs.length) toast(`Placed with ${probs.length} academic conflict(s): ${probs[0].msg}`);
    return true;
  }
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    if (el instanceof HTMLButtonElement) e.preventDefault();
    if (el.matches('input, select')) return; // handled by change/input events
    if (e.target.closest('.slot.bad')) return;
    const act = el.dataset.act, d = el.dataset;
    switch (act) {
      case 'tab': S.ui.tab = d.tab; save(); render(); break;
      case 'go-schedule':
      case 'go-timeline': S.ui.tab = 'timeline'; save(); render(); break;
      case 'dashboard-scroll': {
        const timeline = $('.compact-timeline');
        if (timeline) timeline.scrollBy({ left: Number(d.dir) * Math.max(220, timeline.clientWidth * 0.8), behavior: 'smooth' });
        break;
      }
      case 'calendar-mode': S.ui.calendarMode = d.mode; save(); render(); break;
      case 'calendar-today':
        S.ui.calendarDate = isoDate(new Date());
        if (S.ui.calendarMode === 'semester') S.ui.calendarTerm = LIVE.cx.curId;
        save(); render(); break;
      case 'calendar-day': S.ui.calendarMode = 'day'; S.ui.calendarDate = d.date; save(); render(); break;
      case 'calendar-prev':
      case 'calendar-next': {
        const amount = act === 'calendar-prev' ? -1 : 1, date = calendarDate();
        if (S.ui.calendarMode === 'day') date.setDate(date.getDate() + amount);
        else if (S.ui.calendarMode === 'month') date.setMonth(date.getMonth() + amount);
        else {
          const options = [...new Set(scheduledSections().map((course) => course.term))].sort((a, b) => E.tkey(a) - E.tkey(b));
          const current = S.ui.calendarTerm === 'all' ? -1 : options.indexOf(S.ui.calendarTerm || LIVE.cx.curId);
          const next = current + amount;
          S.ui.calendarTerm = next >= 0 && next < options.length ? options[next] : next === -1 || next === options.length ? 'all' : S.ui.calendarTerm;
        }
        S.ui.calendarDate = isoDate(date); save(); render(); break;
      }
      case 'undo': undo(); break;
      case 'optimize': openOptimizer(); break;
      case 'settings': openSettings(); break;
      case 'settings-tab': selectSettingsTab(d.tab); break;
      case 'data': openData(); break;
      case 'import-transcript': importTranscript(); break;
      case 'clear-transcript': mutate(() => { delete S.meta.transcript; }); closeDlg(); toast('Using planner grades for GPA'); break;
      case 'mobile-tools': openMobileTools(); break;
      case 'account': openAccount(); break;
      case 'account-login': authenticateAccount('login'); break;
      case 'account-register': authenticateAccount('register'); break;
      case 'account-logout': logoutAccount(); break;
      case 'account-password': openPasswordChange(); break;
      case 'account-password-save': changeAccountPassword(); break;
      case 'account-sync': closeDlg(); pushRemoteSchedule(false, true); break;
      case 'account-reload': closeDlg(); loadRemoteSchedule(true); break;
      case 'account-overwrite': closeDlg(); pushRemoteSchedule(true, true); break;
      case 'live-search': openPortalSearch('live'); break;
      case 'catalog-search': openPortalSearch('catalog'); break;
      case 'sync-portal': syncMyPortal(); break;
      case 'add-portal-course': addPortalCourse(Number(d.i)); break;
      case 'course-availability': e.stopPropagation(); openCourseAvailability(d.id); break;
      case 'refresh-course': e.stopPropagation(); refreshCourse(d.id, el); break;
      case 'schedule-course': e.stopPropagation(); openCatalogSchedule(d.id); break;
      case 'catalog-place': e.stopPropagation(); placeCourse(d.id, d.term).then((placed) => { if (placed) closeDlg(); }); break;
      case 'catalog-unschedule': e.stopPropagation(); placeCourse(d.id, null).then((placed) => { if (placed) closeDlg(); }); break;
      case 'issues': openIssues(); break;
      case 'close': closeDlg(); break;
      case 'open': openCourse(d.id); break;
      case 'new': openCourse(null, d.term); break;
      case 'place': e.stopPropagation(); placeCourse(d.id, d.term); break;
      case 'save-course': saveCourse(); break;
      case 'save-settings': saveSettings(); break;
      case 'unschedule': mutate(() => { Object.assign(byId(editing.c.id), { term: null, section: null }); }); closeDlg(); break;
      case 'delete-course': if (confirm(`Delete ${editing.c.code}?`)) { mutate(() => { S.courses = S.courses.filter((c) => c.id !== editing.c.id); }); closeDlg(); } break;
      case 'add-term': { const last = S.terms[S.terms.length - 1] || E.currentTermId(S.settings); mutate(() => { S.terms.push(E.nextTermId(last, S.ui.showSummers)); }); break; }
      case 'remove-term': {
        const courses = S.courses.filter((c) => c.term === d.term), label = tlabel(d.term);
        const detail = courses.length ? ` ${courses.length} course${courses.length === 1 ? '' : 's'} will move to Unscheduled.` : '';
        if (confirm(`Remove ${label}?${detail}`)) {
          mutate(() => { S.courses.forEach((c) => { if (c.term === d.term) Object.assign(c, { term: null, section: null }); }); S.terms = S.terms.filter((t) => t !== d.term); });
          toast(`${label} removed${courses.length ? ` · ${courses.length} course${courses.length === 1 ? '' : 's'} unscheduled` : ''}`);
        }
        break;
      }
      case 'apply': applyScenario(Number(d.i)); break;
      case 'sort': S.ui.dir = S.ui.sort === d.k ? -S.ui.dir : 1; S.ui.sort = d.k; save(); render(); break;
      case 'export-json': download('schedule-backup.json', JSON.stringify({ app: 'schedule-manager', v: S.v, meta: S.meta, minor: S.minor, courses: S.courses, terms: S.terms, settings: S.settings }, null, 1)); break;
      case 'import-json':
      case 'import-csv': $('#file-import').dataset.format = act === 'import-csv' ? 'csv' : 'json'; $('#file-import').click(); break;
      case 'export-csv': exportCsv(); break;
      case 'reset': if (confirm('Discard all courses and start a blank schedule?')) { undoStack = []; S = blankState(); save(); closeDlg(); render(); toast('Blank schedule created'); } break;
      case 'blank': if (confirm('Discard this plan and start a blank schedule? Export a backup first if you need these courses later.')) { undoStack = []; S = blankState(); save(); closeDlg(); render(); toast('Blank schedule created'); } break;
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('[data-act="settings-tab"]') && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const tabs = $$('[data-act="settings-tab"]', dlg), index = tabs.indexOf(e.target);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length;
      selectSettingsTab(tabs[next].dataset.tab, true);
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.card[data-act="open"]')) { e.preventDefault(); openCourse(e.target.dataset.id); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.target.matches('input, textarea, select') && !dlg.open) { e.preventDefault(); undo(); }
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    if (el.dataset.act === 'toggle') { S.ui[el.dataset.k] = el.checked; save(); render(); }
    if (el.dataset.act === 'filter') { S.ui[el.dataset.k] = el.value; save(); render(); }
    if (el.dataset.act === 'calendar-term') { S.ui.calendarTerm = el.value; save(); render(); }
    if (el.dataset.act === 'scope') { S.ui.scopeAll = el.checked; save(); openOptimizer(); }
  });
  document.addEventListener('input', (e) => {
    const el = e.target; if (el.dataset && el.dataset.act === 'filter' && el.type === 'search') {
      S.ui.q = el.value; const pos = el.selectionStart; render(); const n = $('input[type="search"]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); }
    }
  });
  $('#file-import').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const text = await f.text();
      if ($('#file-import').dataset.format === 'csv' || /\.csv$/i.test(f.name)) {
        const imported = parseCsv(text);
        mutate(() => {
          S.courses.push(...imported);
          imported.forEach((c) => { if (c.term && !S.terms.includes(c.term)) S.terms.push(c.term); });
        });
        closeDlg(); toast(`${imported.length} course${imported.length === 1 ? '' : 's'} imported. Undo is available`);
      } else {
        const o = JSON.parse(text);
        if (!Array.isArray(o.courses) || !Array.isArray(o.terms)) throw new Error('Not a schedule backup');
        mutate(() => { S.courses = o.courses.map(fixCourse); S.terms = o.terms.map((t) => t.id || t); S.settings = { ...E.DEFAULTS, ...o.settings }; if (o.meta) S.meta = o.meta; if (o.minor) S.minor = o.minor; });
        closeDlg(); toast('Backup imported. Undo is available');
      }
    } catch (err) { toast('Import failed: ' + err.message); }
  });

  /* ---------- drag and drop ---------- */
  function markTargets(id) {
    const c = byId(id), cx = ctx(), assign = E.currentAssign(cx);
    $$('.col').forEach((col) => {
      const t = col.dataset.term;
      col.classList.remove('drop-ok', 'drop-bad', 'drop-na');
      const msg = $('.dropmsg', col);
      const p = placementProblems(cx, assign, c, t);
      col.classList.add(p.length ? 'drop-bad' : 'drop-ok');
      msg.textContent = p.length ? '✗ ' + p[0].msg + (p.length > 1 ? ` (+${p.length - 1})` : '') : '✓ fits here';
    });
    const pool = $('.pool'); if (pool && c.term) pool.classList.add('drop-ok');
  }
  document.addEventListener('dragstart', (e) => {
    if (e.target.closest && e.target.closest('button')) return;
    const el = e.target.closest && e.target.closest('.card[draggable="true"]'); if (!el) return;
    dragId = el.dataset.id; e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => { el.classList.add('dragging'); document.body.classList.add('dragging'); markTargets(dragId); }, 0);
  });
  document.addEventListener('dragend', () => { dragId = null; document.body.classList.remove('dragging'); $$('.drop-ok,.drop-bad,.drop-na,.dragging').forEach((n) => n.classList.remove('drop-ok', 'drop-bad', 'drop-na', 'dragging')); });
  document.addEventListener('dragover', (e) => { if (dragId && e.target.closest && (e.target.closest('.col') || e.target.closest('.pool'))) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (!dragId) return; const id = dragId;
    const col = e.target.closest('.col'), pool = e.target.closest('.pool');
    if (col) { e.preventDefault(); placeCourse(id, col.dataset.term); }
    else if (pool) { e.preventDefault(); placeCourse(id, null); }
  });

  /* ================= boot ================= */
  (async () => {
    const saved = localStorage.getItem(KEY);
    hadLocalState = Boolean(saved);
    S = saved ? loadState() : (await loadExternalSeed()) || blankState();
    normalizeTerms(); render();
    if (/^https?:$/.test(location.protocol)) {
      await restoreAccount();
      setTimeout(hydrateMyPortal, 0);
    }
    window.__sched = { get state() { return S; }, Engine: E, render };
  })();
})();
