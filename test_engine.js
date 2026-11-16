const assert = require('node:assert/strict');

require('./engine.js');

assert.equal(
  Engine.requiresFutureSection({ courseTerm: 'FA26', targetTerm: 'FA26', currentTerm: 'FA26', isNew: false }),
  false,
  'editing an existing current-term course must allow its already-started section',
);
assert.equal(
  Engine.requiresFutureSection({ courseTerm: null, targetTerm: 'FA26', currentTerm: 'FA26', isNew: false }),
  true,
  'placing a course into the current term must require a future start',
);
assert.equal(
  Engine.sectionTimeLabel({
    meetings: [
      { startLabel: '9:00 AM', endLabel: '9:50 AM' },
      { startLabel: '2:00 PM', endLabel: '3:50 PM' },
    ],
    timeLabel: '9:00 AM–9:50 AM, 2:00 PM–3:50 PM',
  }),
  '9:00 AM–9:50 AM, 2:00 PM–3:50 PM',
  'the Schedule tab must display every meeting time',
);
const cachedSections = [{ courseCode: 'CS 1113 02' }];
assert.equal(
  Engine.sectionsForEdit([], cachedSections),
  cachedSections,
  'an empty or unavailable catalog lookup must not erase a section list already shown in the editor',
);

console.log('section-selection and Schedule-time regression checks passed');

const transcript = {
  source: 'myportal', gpa: 3.5, gpaCredits: 12, qualityPoints: 42,
  courses: [{ code: 'MA 313', grade: 'B+', repeat: '-', gpaCredits: 3, qualityPoints: 10.5 }],
};
const course = (code, term, grade) => ({ code, id: code, term, grade, credits: 3, prereq: { groups: [] } });
const settings = { ...Engine.DEFAULTS, currentTerm: 'FA26' };
const grades = [course('MA 313', 'SP26', 'A'), course('CS 100', 'FA26', 'B+')];
let totals = Engine.totals(Engine.makeCtx(grades, settings, { transcript }));
assert.equal(totals.gpa, 3.5, 'official totals override incomplete or edited planner history');
assert.equal(totals.gpaCr, 12, 'completed planner courses must not double-count transcript credits');
assert.equal(totals.gpaCur, 3.5, 'projections use the B+ value observed on the transcript');
assert.equal(totals.gpaCrCur, 15);
totals = Engine.totals(Engine.makeCtx([course('MA 313', 'FA26', 'A')], settings, { transcript }));
assert.equal(totals.gpaCrCur, 12, 'a recorded grade in a planner current term must not count again');
totals = Engine.totals(Engine.makeCtx([course('CS 100', 'FA26', 'F')], settings, { transcript }));
assert.equal(totals.gpaCur, 42 / 15, 'failed current courses add GPA credits and zero quality points');
totals = Engine.totals(Engine.makeCtx(grades, settings));
assert.equal(totals.gpa, 4, 'plans without a transcript retain their existing GPA calculation');
console.log('transcript GPA regression checks passed');
