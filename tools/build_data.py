#!/usr/bin/env python3
"""Regenerate data.js from the degree control-sheet .xlsx.

Usage:  python3 tools/build_data.py "BSCS_....xlsx" [out=data.js]

Reads sheet 'CS' (falls back to the first sheet). Layout assumed (same as the
original control sheet):
  A:C  requirement list (name | prereq text | offered ALL/FA/SP), in three
       sections whose header rows contain "<n> HRS"
  H:L  per-term blocks: header row = formula CONCATENATE("FALL ", $I$1+Gn);
       then rows of course | grade | credits | sem | notes
  N:O  minor courses (N) with grade (O)
"""
import json, re, sys
from pathlib import Path
import openpyxl

src = Path(sys.argv[1])
out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parent.parent / "data.js"

wb = openpyxl.load_workbook(src)  # formulas, not cached values
ws = wb["CS"] if "CS" in wb.sheetnames else wb.worksheets[0]
V = lambda ref: ws[ref].value

SEASON = {"FALL": "FA", "SPRING": "SP", "SUMMER": "SU"}
PREFIX_FIX = {"BIOLOGY": "BIO"}


def norm(s):
    s = re.sub(r"\s*-\s*-\s*", " - ", str(s))
    return re.sub(r"\s+", " ", s).strip()


def mk_code(pfx, num):
    pfx = PREFIX_FIX.get(pfx.upper(), pfx.upper())
    return f"{pfx} {num}"


CODE_RE = re.compile(r"^([A-Za-z]{2,9})\s*(\d{3,4})\b\s*(.*)$")


def parse_name(raw):
    """-> dict(slot, codes[], title, note, key)"""
    key = norm(raw)
    slot, rest = None, key
    m = re.match(r"^(Directed Elective \d+) \(\d+\) - (.*)$", key)
    if m:
        slot, rest = m.group(1), m.group(2)
    else:
        m = re.match(r"^(Humanities or Social Science Elective|Humanities Elective|Social Science Elective) - (.*)$", key)
        if m:
            slot, rest = m.group(1), m.group(2)
    codes, titles, note = [], [], None
    for part in re.split(r"\s+or\s+", rest, flags=re.I):
        mm = CODE_RE.match(part.strip())
        if mm:
            codes.append(mk_code(mm.group(1), mm.group(2)))
            t = mm.group(3).strip()
            if re.match(r"^\d\w\d", t):  # section id like "2O1 OL"
                note, t = f"Section {t}", ""
            titles.append(t)
        else:
            m2 = re.match(r"^([A-Z]{2,4})\s+([A-Za-z].*)$", part.strip())  # code without a number, e.g. "FLM Film Appreciation"
            if m2:
                codes.append(m2.group(1)); titles.append(m2.group(2))
            else:
                titles.append(part.strip())
    title = " / ".join(t for t in titles if t) or (slot or key)
    if slot and slot.endswith("Elective") and not any(titles):
        title = slot
    return dict(slot=slot, codes=codes, title=title, note=note, key=key)


def parse_prereq(text):
    """Structured prereq: groups = AND of OR-groups; standing; external text."""
    if not text:
        return dict(groups=[], standing=None, notes=[])
    t = str(text).strip()
    standing, notes, groups = None, [], []
    m = re.match(r"^(Jr|Sr)\. Standing$", t)
    if m:
        return dict(groups=[], standing=m.group(1).upper(), notes=[])
    if re.search(r"approval|HS Math", t, re.I):
        return dict(groups=[], standing=None, notes=[t])
    # "C" or better in X
    m = re.match(r'^"([A-F][+-]?)" or better in (.+)$', t)
    if m:
        c = [mk_code(*re.match(r"([A-Za-z]+)\s*(\d+)", x.strip()).groups()) for x in re.split(r"\s+or\s+", m.group(2))]
        return dict(groups=[dict(codes=c, minGrade=m.group(1))], standing=None, notes=[])
    for chunk in re.split(r",|\s+and\s+", t):
        c = [mk_code(*re.match(r"([A-Za-z]+)\s*(\d+)", x.strip()).groups())
             for x in re.split(r"\s+or\s+", chunk.strip()) if re.match(r"[A-Za-z]+\s*\d+", x.strip())]
        if c:
            groups.append(dict(codes=c, minGrade=None))
    return dict(groups=groups, standing=standing, notes=notes)


# ---------------------------------------------------------------- requirements
section = None
SECTION_CAT = {"GENERAL": "gened", "PROGRAM": "program", "ELECTIVES": "elective"}
reqs = []
for r in range(4, 60):
    a = V(f"A{r}")
    if a is None:
        continue
    if re.search(r"\d+\s*HRS", str(a)):
        section = SECTION_CAT[str(a).split()[0]]
        continue
    if section is None:
        continue
    p = parse_name(a)
    off = V(f"C{r}")
    reqs.append(dict(
        row=r, category=section, slot=p["slot"], codes=p["codes"], title=p["title"], key=p["key"],
        offered=(str(off).strip().upper() if off else None),
        prereqText=(str(V(f"B{r}")).strip() if V(f"B{r}") else ""),
        prereq=parse_prereq(V(f"B{r}")), note=p["note"] or "",
    ))
# hard-coded row (A50 has literal D/E/F values rather than lookups)
by_key = {q["key"]: q for q in reqs}

# ---------------------------------------------------------------- term blocks
def term_from_formula(f):
    m = re.search(r'CONCATENATE\("(\w+) ",\$I\$1(?:\+(G\d+))?\)', str(f))
    if not m:
        return None
    year = V("I1") + (V(m.group(2)) or 0 if m.group(2) else 0)
    return SEASON[m.group(1).upper()], int(year)

blocks = []   # (season, year, row)
for r in range(1, 130):
    h = V(f"H{r}")
    if isinstance(h, str) and h.startswith("=CONCATENATE") and "$I$1" in h:
        blocks.append((*term_from_formula(h), r))

entries = []  # dict(termId, name, grade, credits, note)
def collect(r0, r1, term_id):
    for r in range(r0, r1):
        h = V(f"H{r}")
        if not h or str(h).startswith("=") or h in ("COURSES", "TRANSFER"):
            continue
        entries.append(dict(term=term_id, key=norm(h), grade=V(f"I{r}"), credits=V(f"J{r}"), note=V(f"L{r}") or ""))

collect(5, blocks[0][2], "TR")
for i, (s, y, r) in enumerate(blocks):
    end = blocks[i + 1][2] if i + 1 < len(blocks) else 130
    collect(r + 1, end, f"{s}{str(y)[2:]}")
# Row A50 literal: Directed Elective 6 (SP26, A, 3)
terms = [dict(id=f"{s}{str(y)[2:]}", season=s, year=y) for s, y, _ in blocks]

# ---------------------------------------------------------------- merge
used = set()
courses = []
for q in reqs:
    e = next((x for x in entries if x["key"] == q["key"] and id(x) not in used), None)
    if e is None:
        # tolerate "Directed Elective N (3) -  X" vs "... - X" differences already normed; try suffix match
        e = next((x for x in entries if id(x) not in used and q["codes"] and q["codes"][0].split()[1] in x["key"]
                  and x["key"].split()[-1] == q["key"].split()[-1]), None)
    if e: used.add(id(e))
    c = dict(
        id=f"r{q['row']}", code=q["codes"][0] if q["codes"] else q["title"], alt=q["codes"][1:], title=q["title"],
        slot=q["slot"], category=q["category"], offered=q["offered"], prereqText=q["prereqText"], prereq=q["prereq"],
        credits=(e["credits"] if e and e["credits"] else 3), term=(e["term"] if e else None),
        grade=(e["grade"] if e and e["grade"] else None), notes=" ".join(x for x in [q["note"], e["note"] if e else ""] if x),
        locked=False, custom=False,
    )
    courses.append(c)
if V("A50") and "HUM 173" in str(V("A50")):  # literal row
    for c in courses:
        if c["id"] == "r50":
            c.update(term="SP26", grade=V("E50") or c["grade"], credits=V("F50") or c["credits"])

# Transfer entries (not in the requirement list as courses): make them courses.
for q in list(courses):
    pass
for e in entries:
    if id(e) in used:
        continue
    if e["term"] == "TR":
        continue  # handled below
    print("!! unmatched term entry:", e, file=sys.stderr)
# Transfer rows map onto Directed Electives 1/2 (already in reqs) – ensure term TR and grade T
for c in courses:
    if c["term"] == "TR":
        c["grade"] = "T"

# ---------------------------------------------------------------- minor
minor = dict(name=None, courses=[])
for r in range(1, 40):
    n = V(f"N{r}")
    if n and "Minor" in str(n):
        minor["name"] = re.sub(r"\s*\(.*\)", "", str(n)).strip()
        m = re.search(r"\((\d+)\s*credits\)", str(n))
        minor["credits"] = int(m.group(1)) if m else None
        rr = r + 1
        while V(f"N{rr}"):
            mm = CODE_RE.match(str(V(f"N{rr}")))
            if mm:
                minor["courses"].append(mk_code(mm.group(1), mm.group(2)))
            rr += 1
        break
masters = [str(V(f"N{r}")) for r in range(2, 7) if V(f"N{r}")]

seed = dict(
    meta=dict(student=V("E1"), startYear=V("I1"), program=f"{V('A1')} - {V('A2')}".title().replace(" - ", " · "),
              minorLabel=V("H2"), source=src.name, masters=masters),
    terms=terms, courses=courses, minor=minor,
)
out.write_text("// Generated by tools/build_data.py from: %s\nwindow.SEED = %s;\n" % (src.name, json.dumps(seed, indent=1)))
print(f"wrote {out}: {len(courses)} courses, {len(terms)} terms; minor={minor['name']} {minor['courses']}")
unplaced = [c["code"] for c in courses if not c["term"]]
print("unplaced:", unplaced)
