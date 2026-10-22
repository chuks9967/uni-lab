'use strict';
/** 🧭 ACADEMIC STANDARDS — the ONE engine for how an institution GRADES, AVERAGES, CLASSIFIES and
 *  NAMES things. PURE (no database, no Node APIs) so the desktop services, the renderer (via IPC data),
 *  the hub portal and the Supabase Edge copy (vendored by scripts/build-edge.js) all run the SAME rules.
 *
 *  Why this exists: universities do not share one standard. A Nigerian university grades A=70+ on a
 *  5-point scale; an NBTE polytechnic uses AA/AB/BC/CD on 4 points; the University of Ghana has B+/C+/D+
 *  on 4 points with a 1:1:2:2 year-weighted final; a CAMES/LMD francophone university marks out of 20
 *  and awards a MENTION on the credit-weighted average; UK/Kenya/South Africa classify on a weighted
 *  average PERCENTAGE; the US uses plus/minus letters and Latin honours; India a 10-point CBCS scale;
 *  Australia a 7-point GPA with honours on the weighted average mark. Before this module the
 *  Nigerian 5-point scale was hard-coded in 11+ places.
 *
 *  A PROFILE is plain data: a score scale, a grade table (letter → min score, grade point, pass),
 *  how GPA is formed ('points' = Σ gp×cu / Σ cu; 'score' = the credit-weighted average MARK, which is
 *  how /20 and percentage systems work), classification bands (on the GPA or on the weighted average
 *  mark, optionally year-weighted), the calendar/level/rank/officer VOCABULARY, and credit naming.
 *
 *  DEFAULT = 'ng-nuc-5', which reproduces the previous hard-coded behaviour byte-for-byte, so an
 *  institution that never touches this setting sees no change at all.
 *
 *  Sources consulted for the catalogue (2026-09): NUC/NBTE (Nigeria), University of Ghana handbook
 *  summaries, CAMES LMD référentiel, UGC CBCS guidance (India), SACM (Saudi Arabia), Wikipedia
 *  "Academic grading in …" pages, and institution handbooks summarised by OpenEduCat/Scholaro. Every
 *  preset is a STARTING POINT — institutions differ even within one country, which is why every field
 *  is overridable and the detector suggests corrections from the institution's own records.
 */

// ---------------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------------
const num = (v) => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const clone = (o) => JSON.parse(JSON.stringify(o));
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max || 120);
/** Canonical token for a grade letter: case/space-insensitive, unicode minus/dash → '-'. */
function gkey(g) { return String(g == null ? '' : g).trim().toUpperCase().replace(/[−–—]/g, '-').replace(/\s+/g, ''); }
/** Accent/case/punctuation-folded text for vocabulary matching. */
function fold(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// ---------------------------------------------------------------------------------------------------
// 📚 THE CATALOGUE
// ---------------------------------------------------------------------------------------------------
const G = (grade, min, point, remark, pass, extra) => Object.assign({ grade, min, point, remark: remark || '', pass: pass !== false }, extra || {});
const B = (key, min, label, short, award) => ({ key, min, label, short: short || label, award: award !== false });

const PRESETS = [
  {
    id: 'ng-nuc-5', name: 'Nigeria — NUC 5-point (universities)', country: 'NG', region: 'West Africa', system: 'NUC 5-point CGPA',
    summary: 'Nigerian university standard: A=70–100 (5 points) down to F; CGPA on 5.00; First Class from 4.50.',
    language: 'en', currency: 'NGN',
    score: { max: 100, passMark: 40 },
    grades: [G('A', 70, 5, 'Excellent'), G('B', 60, 4, 'Very Good'), G('C', 50, 3, 'Good'), G('D', 45, 2, 'Fair'), G('E', 40, 1, 'Pass'), G('F', 0, 0, 'Fail', false)],
    gpa: { label: 'CGPA', termLabel: 'GPA', basis: 'points', max: 5, decimals: 2, rounding: 'round' },
    classes: { basis: 'gpa', label: 'Class of Degree', yearWeights: null, bands: [
      B('first', 4.5, 'First Class', 'First Class'), B('upper', 3.5, 'Second Class (Upper Division)', 'Second Class (Upper)'),
      B('lower', 2.4, 'Second Class (Lower Division)', 'Second Class (Lower)'), B('third', 1.5, 'Third Class'),
      B('pass', 1.0, 'Pass'), B('probation', 0, 'Probation', 'Probation', false)] },
    watch: { low: 2.0, high: 4.5 },
    // the legend exactly as the registry sample prints it (the historical default stationery)
    legend: [['70 -100 %', 'A', 'Excellent'], ['60 -69%', 'B', 'Very Good'], ['50 – 59%', 'C', 'Good'], ['40 – 49%', 'D', 'Satisfactory']],
    calendar: { termWord: 'Semester', yearWord: 'Session', terms: ['First Semester', 'Second Semester', 'Summer'] },
    levels: ['100 Level', '200 Level', '300 Level', '400 Level', '500 Level', '600 Level'],
    credits: { label: 'Credit Units', short: 'CU' },
    ranks: ['Graduate Assistant', 'Assistant Lecturer', 'Lecturer II', 'Lecturer I', 'Senior Lecturer', 'Associate Professor (Reader)', 'Professor'],
    officers: { head: 'Vice-Chancellor', deputy: 'Deputy Vice-Chancellor', registrar: 'Registrar', dean: 'Dean', hod: 'Head of Department', bursar: 'Bursar', exams: 'Examinations Officer' },
    resitWord: 'Carry-over', awardPhrase: 'with {class}',
    sources: ['https://en.wikipedia.org/wiki/Academic_grading_in_Nigeria'],
  },
  {
    id: 'ng-nuc-4', name: 'Nigeria — NUC 4-point (2017/18 revision)', country: 'NG', region: 'West Africa', system: 'NUC 4-point CGPA',
    summary: 'The NUC-approved 4-point scale for intakes from 2017/2018: A=4 … D=1, pass mark 45; First Class from 3.50.',
    language: 'en', currency: 'NGN',
    score: { max: 100, passMark: 45 },
    grades: [G('A', 70, 4, 'Excellent'), G('B', 60, 3, 'Very Good'), G('C', 50, 2, 'Good'), G('D', 45, 1, 'Pass'), G('F', 0, 0, 'Fail', false)],
    gpa: { label: 'CGPA', termLabel: 'GPA', basis: 'points', max: 4, decimals: 2, rounding: 'round' },
    classes: { basis: 'gpa', label: 'Class of Degree', yearWeights: null, bands: [
      B('first', 3.5, 'First Class Honours', 'First Class'), B('upper', 3.0, 'Second Class Honours (Upper Division)', 'Second Class (Upper)'),
      B('lower', 2.0, 'Second Class Honours (Lower Division)', 'Second Class (Lower)'), B('third', 1.0, 'Third Class Honours', 'Third Class'),
      B('nodegree', 0, 'Below minimum (no degree)', 'Below minimum', false)] },
    watch: { low: 1.5, high: 3.5 },
    calendar: { termWord: 'Semester', yearWord: 'Session', terms: ['First Semester', 'Second Semester', 'Summer'] },
    levels: ['100 Level', '200 Level', '300 Level', '400 Level', '500 Level', '600 Level'],
    credits: { label: 'Credit Units', short: 'CU' },
    ranks: ['Graduate Assistant', 'Assistant Lecturer', 'Lecturer II', 'Lecturer I', 'Senior Lecturer', 'Associate Professor (Reader)', 'Professor'],
    officers: { head: 'Vice-Chancellor', deputy: 'Deputy Vice-Chancellor', registrar: 'Registrar', dean: 'Dean', hod: 'Head of Department', bursar: 'Bursar', exams: 'Examinations Officer' },
    resitWord: 'Carry-over', awardPhrase: 'with {class}',
    sources: ['https://dailytrust.com/universities-new-grading-regime/', 'https://en.wikipedia.org/wiki/Academic_grading_in_Nigeria'],
  },
  {
    id: 'ng-nbte-4', name: 'Nigeria — NBTE polytechnic (ND/HND)', country: 'NG', region: 'West Africa', system: 'NBTE 4-point CGPA',
    summary: 'Polytechnic ND/HND scale: A=75+ (4.00), AB, B, BC, C, CD, D, E=40–44 (2.00); Distinction from 3.50.',
    language: 'en', currency: 'NGN',
    score: { max: 100, passMark: 40 },
    grades: [G('A', 75, 4.0, 'Excellent', true, { aliases: ['AA'] }), G('AB', 70, 3.5, 'Very Good'), G('B', 65, 3.25, 'Good'), G('BC', 60, 3.0, 'Above Average'),
      G('C', 55, 2.75, 'Average'), G('CD', 50, 2.5, 'Fair'), G('D', 45, 2.25, 'Pass'), G('E', 40, 2.0, 'Poor Pass'), G('F', 0, 0, 'Fail', false)],
    gpa: { label: 'CGPA', termLabel: 'GPA', basis: 'points', max: 4, decimals: 2, rounding: 'round' },
    classes: { basis: 'gpa', label: 'Class of Diploma', yearWeights: null, bands: [
      B('distinction', 3.5, 'Distinction'), B('uppercredit', 3.0, 'Upper Credit'), B('lowercredit', 2.5, 'Lower Credit'),
      B('pass', 2.0, 'Pass'), B('fail', 0, 'Fail', 'Fail', false)] },
    watch: { low: 2.0, high: 3.5 },
    calendar: { termWord: 'Semester', yearWord: 'Session', terms: ['First Semester', 'Second Semester'] },
    levels: ['ND I', 'ND II', 'HND I', 'HND II'],
    credits: { label: 'Credit Units', short: 'CU' },
    ranks: ['Assistant Lecturer', 'Lecturer III', 'Lecturer II', 'Lecturer I', 'Senior Lecturer', 'Principal Lecturer', 'Chief Lecturer'],
    officers: { head: 'Rector', deputy: 'Deputy Rector', registrar: 'Registrar', dean: 'Dean of School', hod: 'Head of Department', bursar: 'Bursar', exams: 'Examinations Officer' },
    resitWord: 'Carry-over', awardPhrase: 'with {class}',
    sources: ['https://openeducat.org/gradebook/nigeria/polytechnic/'],
  },
  {
    id: 'gh-4', name: 'Ghana — 4-point with FGPA (University of Ghana style)', country: 'GH', region: 'West Africa', system: '4-point CGPA, year-weighted FGPA',
    summary: 'A=80–100 (4.0), B+, B, C+, C, D+, D=50–54 (1.0), E marginal fail; class on the FGPA (levels weighted 1:1:2:2); First from 3.60.',
    language: 'en', currency: 'GHS',
    score: { max: 100, passMark: 50 },
    grades: [G('A', 80, 4.0, 'Excellent'), G('B+', 75, 3.5, 'Very Good'), G('B', 70, 3.0, 'Good'), G('C+', 65, 2.5, 'Average'), G('C', 60, 2.0, 'Fair'),
      G('D+', 55, 1.5, 'Barely Satisfactory'), G('D', 50, 1.0, 'Weak Pass'), G('E', 45, 0.5, 'Marginal Fail', false), G('F', 0, 0, 'Fail', false)],
    gpa: { label: 'CGPA', termLabel: 'GPA', finalLabel: 'FGPA', basis: 'points', max: 4, decimals: 2, rounding: 'round' },
    classes: { basis: 'gpa', label: 'Class of Degree', yearWeights: [1, 1, 2, 2], bands: [
      B('first', 3.6, 'First Class Honours', 'First Class'), B('upper', 3.0, 'Second Class Honours (Upper Division)', 'Second Class (Upper)'),
      B('lower', 2.0, 'Second Class Honours (Lower Division)', 'Second Class (Lower)'), B('third', 1.5, 'Third Class Honours', 'Third Class'),
      B('pass', 1.0, 'Pass'), B('fail', 0, 'Fail', 'Fail', false)] },
    watch: { low: 1.5, high: 3.6 },
    calendar: { termWord: 'Semester', yearWord: 'Academic Year', terms: ['First Semester', 'Second Semester'] },
    levels: ['Level 100', 'Level 200', 'Level 300', 'Level 400'],
    credits: { label: 'Credits', short: 'Cr' },
    ranks: ['Assistant Lecturer', 'Lecturer', 'Senior Lecturer', 'Associate Professor', 'Professor'],
    officers: { head: 'Vice-Chancellor', deputy: 'Pro-Vice-Chancellor', registrar: 'Registrar', dean: 'Dean', hod: 'Head of Department', bursar: 'Finance Director', exams: 'Examinations Officer' },
    resitWord: 'Resit', awardPhrase: 'with {class}',
    sources: ['https://www.scholaro.com/db/Countries/Ghana/Grading-System/University-of-Ghana-25432', 'https://yen.com.gh/111918-university-ghana-legon-grading-system-gpa.html'],
  },
  {
    id: 'lmd-cames-20', name: 'Francophone LMD — CAMES (notes sur 20)', country: 'BJ', region: 'Francophone Africa', system: 'LMD /20, moyenne pondérée + mention',
    summary: 'Licence–Master–Doctorat: marks out of 20, a UE is validated at 10/20, 30 credits per semester; the MENTION follows the credit-weighted average (Passable ≥10, Assez Bien ≥12, Bien ≥14, Très Bien ≥16). Benin, Togo, Senegal, Côte d’Ivoire, Burkina Faso, Cameroon (FR)…',
    language: 'fr', currency: 'XOF',
    score: { max: 20, passMark: 10 },
    grades: [G('A', 16, 18, 'Très Bien'), G('B', 14, 15, 'Bien'), G('C', 12, 13, 'Assez Bien'), G('D', 10, 11, 'Passable'), G('E', 0, 5, 'Ajourné', false)],
    gpa: { label: 'Moyenne générale', termLabel: 'Moyenne semestrielle', basis: 'score', max: 20, decimals: 2, rounding: 'round' },
    classes: { basis: 'gpa', label: 'Mention', yearWeights: null, bands: [
      B('tb', 16, 'Très Bien'), B('b', 14, 'Bien'), B('ab', 12, 'Assez Bien'), B('p', 10, 'Passable'), B('aj', 0, 'Ajourné', 'Ajourné', false)] },
    watch: { low: 10, high: 16 },
    calendar: { termWord: 'Semestre', yearWord: 'Année académique', terms: ['Semestre 1', 'Semestre 2'] },
    levels: ['Licence 1', 'Licence 2', 'Licence 3', 'Master 1', 'Master 2', 'Doctorat'],
    credits: { label: 'Crédits (ECTS)', short: 'Cr', perTerm: 30, toGraduate: 180 },
    ranks: ['Assistant', 'Maître-Assistant', 'Maître de Conférences', 'Professeur Titulaire'],
    officers: { head: 'Recteur', deputy: 'Vice-Recteur', registrar: 'Secrétaire Général', dean: 'Doyen', hod: 'Chef de Département', bursar: 'Agent Comptable', exams: 'Service des Examens' },
    resitWord: 'Rattrapage', awardPhrase: 'Mention : {class}',
    sources: ['https://www.lecames.org/wp-content/uploads/2019/06/Referentiel-developpement-SI-CAMES.pdf', 'https://eduactions.bj/11-ans-de-mise-en-oeuvre-du-systeme-lmd-au-benin-des-etudiants-dressent-un-bilan-controverse-lapproche-pedagogique-et-linsertion-des-diplomes-en-question/'],
  },
  {
    id: 'uk-honours', name: 'United Kingdom — honours classification', country: 'GB', region: 'Europe', system: 'Percentage marks, weighted-average classification',
    summary: 'Module marks in %; the degree class follows the credit-weighted average (commonly year 2 : year 3 = 1 : 2): First ≥70, 2:1 ≥60, 2:2 ≥50, Third ≥40.',
    language: 'en', currency: 'GBP',
    score: { max: 100, passMark: 40 },
    grades: [G('A', 70, 85, 'First'), G('B', 60, 65, 'Upper Second'), G('C', 50, 55, 'Lower Second'), G('D', 40, 45, 'Third'), G('F', 0, 20, 'Fail', false)],
    gpa: { label: 'Weighted Average Mark', termLabel: 'Average Mark', basis: 'score', max: 100, decimals: 2, rounding: 'round' },
    classes: { basis: 'gpa', label: 'Degree Classification', yearWeights: [0, 1, 2], bands: [
      B('first', 70, 'First Class Honours', 'First'), B('upper', 60, 'Upper Second Class Honours (2:1)', '2:1'),
      B('lower', 50, 'Lower Second Class Honours (2:2)', '2:2'), B('third', 40, 'Third Class Honours', 'Third'),
      B('fail', 0, 'Fail', 'Fail', false)] },
    watch: { low: 45, high: 70 },
    calendar: { termWord: 'Term', yearWord: 'Academic Year', terms: ['Autumn Term', 'Spring Term', 'Summer Term'] },
    levels: ['Year 1 (Level 4)', 'Year 2 (Level 5)', 'Year 3 (Level 6)', 'Year 4 (Level 7)'],
    credits: { label: 'Credits (CATS)', short: 'Cr', perYear: 120, toGraduate: 360 },
    ranks: ['Teaching Fellow', 'Lecturer', 'Senior Lecturer', 'Associate Professor / Reader', 'Professor'],
    officers: { head: 'Vice-Chancellor', deputy: 'Pro-Vice-Chancellor', registrar: 'Academic Registrar', dean: 'Dean of Faculty', hod: 'Head of School', bursar: 'Director of Finance', exams: 'Examinations Office' },
    resitWord: 'Resit', awardPhrase: 'with {class}',
    sources: ['https://en.wikipedia.org/wiki/British_undergraduate_degree_classification'],
  },
  {
    id: 'ke-cue', name: 'Kenya — CUE percentage classification', country: 'KE', region: 'East Africa', system: 'Percentage marks, weighted-average classification',
    summary: 'Marks in %: A ≥70, B ≥60, C ≥50, D ≥40, E fail; degree class on the credit-weighted average (First ≥70, Upper Second ≥60, Lower Second ≥50, Pass ≥40). Health sciences often pass at 50 — set that per faculty.',
    language: 'en', currency: 'KES',
    score: { max: 100, passMark: 40 },
    grades: [G('A', 70, 85, 'Excellent'), G('B', 60, 65, 'Good'), G('C', 50, 55, 'Satisfactory'), G('D', 40, 45, 'Pass'), G('E', 0, 20, 'Fail', false)],
    gpa: { label: 'Weighted Average', termLabel: 'Average', basis: 'score', max: 100, decimals: 2, rounding: 'round' },
    classes: { basis: 'gpa', label: 'Degree Classification', yearWeights: null, bands: [
      B('first', 70, 'First Class Honours', 'First Class'), B('upper', 60, 'Second Class Honours (Upper Division)', 'Upper Second'),
      B('lower', 50, 'Second Class Honours (Lower Division)', 'Lower Second'), B('pass', 40, 'Pass'), B('fail', 0, 'Fail', 'Fail', false)] },
    watch: { low: 45, high: 70 },
    calendar: { termWord: 'Semester', yearWord: 'Academic Year', terms: ['Semester I', 'Semester II'] },
    levels: ['First Year', 'Second Year', 'Third Year', 'Fourth Year', 'Fifth Year'],
    credits: { label: 'Credit Hours', short: 'CH' },
    ranks: ['Tutorial Fellow', 'Assistant Lecturer', 'Lecturer', 'Senior Lecturer', 'Associate Professor', 'Professor'],
    officers: { head: 'Vice-Chancellor', deputy: 'Deputy Vice-Chancellor', registrar: 'Registrar (Academic Affairs)', dean: 'Dean', hod: 'Chairman of Department', bursar: 'Finance Officer', exams: 'Examinations Office' },
    resitWord: 'Supplementary examination', awardPhrase: 'with {class}',
    sources: ['https://en.wikipedia.org/wiki/Academic_grading_in_Kenya', 'https://openeducat.org/gradebook/kenya/university/'],
  },
  {
    id: 'za-pct', name: 'South Africa — percentage (UCT/UNISA style)', country: 'ZA', region: 'Southern Africa', system: 'Percentage marks, pass 50',
    summary: 'Marks in %: 1st ≥75 (distinction), 2+ 70–74, 2- 60–69, 3rd 50–59, fail below 50; qualification awarded with distinction on a ≥75 weighted average.',
    language: 'en', currency: 'ZAR',
    score: { max: 100, passMark: 50 },
    grades: [G('1', 75, 85, 'First class (distinction)'), G('2+', 70, 72, 'Upper second'), G('2-', 60, 65, 'Lower second'), G('3', 50, 55, 'Third (pass)'), G('F', 0, 25, 'Fail', false)],
    gpa: { label: 'Weighted Average', termLabel: 'Average', basis: 'score', max: 100, decimals: 2, rounding: 'round' },
    classes: { basis: 'gpa', label: 'Result', yearWeights: null, bands: [
      B('distinction', 75, 'Pass with Distinction', 'Distinction'), B('pass', 50, 'Pass'), B('fail', 0, 'Fail', 'Fail', false)] },
    watch: { low: 55, high: 75 },
    calendar: { termWord: 'Semester', yearWord: 'Academic Year', terms: ['Semester 1', 'Semester 2'] },
    levels: ['First Year', 'Second Year', 'Third Year', 'Honours'],
    credits: { label: 'Credits (SAQA)', short: 'Cr', perYear: 120, toGraduate: 360 },
    ranks: ['Junior Lecturer', 'Lecturer', 'Senior Lecturer', 'Associate Professor', 'Professor'],
    officers: { head: 'Vice-Chancellor', deputy: 'Deputy Vice-Chancellor', registrar: 'Registrar', dean: 'Dean', hod: 'Head of Department', bursar: 'Chief Financial Officer', exams: 'Examinations Office' },
    resitWord: 'Supplementary examination', awardPhrase: '{class}',
    sources: ['https://en.wikipedia.org/wiki/Academic_grading_in_South_Africa'],
  },
  {
    id: 'us-4', name: 'United States — 4.0 GPA with Latin honours', country: 'US', region: 'North America', system: '4.0 GPA, plus/minus letters',
    summary: 'A 93+ (4.0), A- 90 (3.7), B+ 87 (3.3) … D- 60 (0.7), F; credit hours; Latin honours (cum laude 3.5, magna 3.7, summa 3.9 — thresholds vary by college).',
    language: 'en', currency: 'USD',
    score: { max: 100, passMark: 60 },
    grades: [G('A', 93, 4.0, 'Excellent'), G('A-', 90, 3.7, 'Excellent'), G('B+', 87, 3.3, 'Good'), G('B', 83, 3.0, 'Good'), G('B-', 80, 2.7, 'Good'),
      G('C+', 77, 2.3, 'Satisfactory'), G('C', 73, 2.0, 'Satisfactory'), G('C-', 70, 1.7, 'Satisfactory'), G('D+', 67, 1.3, 'Poor'), G('D', 63, 1.0, 'Poor'),
      G('D-', 60, 0.7, 'Poor'), G('F', 0, 0, 'Failing', false)],
    gpa: { label: 'Cumulative GPA', termLabel: 'Term GPA', basis: 'points', max: 4, decimals: 2, rounding: 'round' },
    classes: { basis: 'gpa', label: 'Latin Honors', yearWeights: null, bands: [
      B('summa', 3.9, 'Summa Cum Laude'), B('magna', 3.7, 'Magna Cum Laude'), B('cum', 3.5, 'Cum Laude'),
      B('good', 2.0, 'Good Standing'), B('probation', 0, 'Academic Probation', 'Probation', false)] },
    watch: { low: 2.0, high: 3.5 },
    calendar: { termWord: 'Term', yearWord: 'Academic Year', terms: ['Fall Semester', 'Spring Semester', 'Summer Session'] },
    levels: ['Freshman', 'Sophomore', 'Junior', 'Senior'],
    credits: { label: 'Credit Hours', short: 'CH', toGraduate: 120 },
    ranks: ['Instructor', 'Lecturer', 'Assistant Professor', 'Associate Professor', 'Professor', 'Distinguished Professor'],
    officers: { head: 'President', deputy: 'Provost', registrar: 'University Registrar', dean: 'Dean', hod: 'Department Chair', bursar: 'Bursar', exams: 'Office of the Registrar' },
    resitWord: 'Repeat', awardPhrase: '{class}',
    sources: ['https://en.wikipedia.org/wiki/Academic_grading_in_the_United_States'],
  },
  {
    id: 'in-ugc-10', name: 'India — UGC CBCS 10-point', country: 'IN', region: 'South Asia', system: '10-point CGPA (SGPA/CGPA)',
    summary: 'O 85+ (10), A+ 75 (9), A 65 (8), B+ 55 (7), B 45 (6), C 40 (5), F; SGPA per semester, CGPA overall; % ≈ CGPA × 9.5 (UGC). Divisions: Distinction, First, Second, Pass.',
    language: 'en', currency: 'INR',
    score: { max: 100, passMark: 40 },
    grades: [G('O', 85, 10, 'Outstanding'), G('A+', 75, 9, 'Excellent'), G('A', 65, 8, 'Very Good'), G('B+', 55, 7, 'Good'), G('B', 45, 6, 'Above Average'),
      G('C', 40, 5, 'Average'), G('F', 0, 0, 'Fail', false, { aliases: ['AB'] })],
    gpa: { label: 'CGPA', termLabel: 'SGPA', basis: 'points', max: 10, decimals: 2, rounding: 'round', percentFactor: 9.5 },
    classes: { basis: 'gpa', label: 'Division', yearWeights: null, bands: [
      B('distinction', 7.9, 'First Class with Distinction', 'Distinction'), B('first', 6.3, 'First Class'), B('second', 5.3, 'Second Class'),
      B('pass', 4.2, 'Pass'), B('fail', 0, 'Fail', 'Fail', false)] },
    watch: { low: 5.0, high: 8.5 },
    calendar: { termWord: 'Semester', yearWord: 'Academic Year', terms: ['Odd Semester', 'Even Semester'] },
    levels: ['First Year', 'Second Year', 'Third Year', 'Fourth Year'],
    credits: { label: 'Credits', short: 'Cr' },
    ranks: ['Assistant Professor', 'Associate Professor', 'Professor'],
    officers: { head: 'Vice-Chancellor', deputy: 'Pro-Vice-Chancellor', registrar: 'Registrar', dean: 'Dean', hod: 'Head of Department', bursar: 'Finance Officer', exams: 'Controller of Examinations' },
    resitWord: 'Supplementary examination', awardPhrase: 'in {class}',
    sources: ['https://classeva.com/university/blog/grading-system-india', 'https://openeducat.org/gradebook/india/cbcs/'],
  },
  {
    id: 'au-7', name: 'Australia — 7-point GPA, honours on WAM', country: 'AU', region: 'Oceania', system: '7-point GPA + weighted average mark',
    summary: 'HD 85+ (7), D 75 (6), CR 65 (5), P 50 (4), N/F fail; honours class on the Weighted Average Mark: H1 ≥80, H2A ≥75, H2B ≥70, H3 ≥65.',
    language: 'en', currency: 'AUD',
    score: { max: 100, passMark: 50 },
    grades: [G('HD', 85, 7, 'High Distinction'), G('D', 75, 6, 'Distinction'), G('CR', 65, 5, 'Credit', true, { aliases: ['C'] }), G('P', 50, 4, 'Pass'), G('N', 0, 0, 'Fail', false, { aliases: ['F'] })],
    gpa: { label: 'GPA', termLabel: 'Semester GPA', basis: 'points', max: 7, decimals: 2, rounding: 'round' },
    classes: { basis: 'score', label: 'Honours', yearWeights: null, bands: [
      B('h1', 80, 'First Class Honours (H1)', 'H1'), B('h2a', 75, 'Second Class Honours, Division A (H2A)', 'H2A'),
      B('h2b', 70, 'Second Class Honours, Division B (H2B)', 'H2B'), B('h3', 65, 'Third Class Honours (H3)', 'H3'),
      B('pass', 50, 'Pass'), B('fail', 0, 'Fail', 'Fail', false)] },
    watch: { low: 4, high: 6 },
    calendar: { termWord: 'Semester', yearWord: 'Academic Year', terms: ['Semester 1', 'Semester 2', 'Summer Term'] },
    levels: ['Year 1', 'Year 2', 'Year 3', 'Honours Year'],
    credits: { label: 'Credit Points', short: 'CP' },
    ranks: ['Associate Lecturer (Level A)', 'Lecturer (Level B)', 'Senior Lecturer (Level C)', 'Associate Professor (Level D)', 'Professor (Level E)'],
    officers: { head: 'Vice-Chancellor', deputy: 'Deputy Vice-Chancellor (Academic)', registrar: 'Academic Registrar', dean: 'Executive Dean', hod: 'Head of School', bursar: 'Chief Financial Officer', exams: 'Examinations Office' },
    resitWord: 'Supplementary assessment', awardPhrase: 'with {class}',
    sources: ['https://openeducat.org/gradebook/australia/university/'],
  },
  {
    id: 'sa-5', name: 'Saudi Arabia — 5-point GPA', country: 'SA', region: 'Middle East', system: '5.0 GPA',
    summary: 'A+ 95+ (5.0), A 90 (4.75), B+ 85 (4.5), B 80 (4.0), C+ 75 (3.5), C 70 (3.0), D+ 65 (2.5), D 60 (2.0), F (1.0, fail). General rating on the cumulative GPA.',
    language: 'en', currency: 'SAR',
    score: { max: 100, passMark: 60 },
    grades: [G('A+', 95, 5.0, 'Exceptional'), G('A', 90, 4.75, 'Excellent'), G('B+', 85, 4.5, 'Superior'), G('B', 80, 4.0, 'Very Good'),
      G('C+', 75, 3.5, 'Above Average'), G('C', 70, 3.0, 'Good'), G('D+', 65, 2.5, 'High Pass'), G('D', 60, 2.0, 'Pass'), G('F', 0, 1.0, 'Fail', false)],
    gpa: { label: 'Cumulative GPA', termLabel: 'Semester GPA', basis: 'points', max: 5, decimals: 2, rounding: 'round' },
    classes: { basis: 'gpa', label: 'General Rating', yearWeights: null, bands: [
      B('excellent', 4.5, 'Excellent'), B('verygood', 3.75, 'Very Good'), B('good', 2.75, 'Good'), B('pass', 2.0, 'Pass'),
      B('warning', 0, 'Below minimum (academic warning)', 'Warning', false)] },
    watch: { low: 2.0, high: 4.5 },
    calendar: { termWord: 'Semester', yearWord: 'Academic Year', terms: ['First Semester', 'Second Semester', 'Summer Semester'] },
    levels: ['Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5', 'Level 6', 'Level 7', 'Level 8'],
    credits: { label: 'Credit Hours', short: 'CH' },
    ranks: ['Teaching Assistant', 'Lecturer', 'Assistant Professor', 'Associate Professor', 'Professor'],
    officers: { head: 'President', deputy: 'Vice-President for Academic Affairs', registrar: 'Dean of Admission and Registration', dean: 'Dean', hod: 'Chairman of Department', bursar: 'Finance Department', exams: 'Deanship of Admission and Registration' },
    resitWord: 'Repeat', awardPhrase: 'with a general rating of {class}',
    sources: ['https://www.sacm.org/ksa/education-in-saudi-arabia/grading-system'],
  },
];
// ---------------------------------------------------------------------------------------------------
// 📏 ACADEMIC POLICY + 🌍 EQUIVALENCE per standard (merged onto the presets above)
//
//  policy.retake       how a repeated course counts in the CGPA:
//                        'all'    every attempt counts (NUC carry-over: the F stays in the CGPA)
//                        'latest' the newest attempt replaces earlier ones (US grade replacement)
//                        'best'   the best attempt counts (LMD rattrapage, India improvement)
//                        'capped' the newest attempt counts but a RESIT mark is capped (UK 40, SA 50)
//  policy.compensation LMD: a semester whose credit-weighted average ≥ average is validated WHOLE —
//                      failed UEs are "compensated" (no resit) unless below the eliminatory floor
//  policy.condone      UK: failed modules marked ≥ from, up to maxCredits per year, count as passed
//  policy.probation    cumulative GPA below `below` at the end of a period → probation; `withdrawAfter`
//                      consecutive periods below → withdrawal (1 = immediate, e.g. University of Ghana)
//  policy.honours      Dean's list: term GPA ≥ termGpa over ≥ minUnits with no failure
//  policy.load         credit units a student may register per term
//  policy.graduation   minimum credits · maximum duration as a factor of the programme length
//  equivalence.knots   [value, index] points mapping the CLASSIFICATION scale onto a shared 0–100
//                      index anchored on UK honours marks (40 third · 50 2:2 · 60 2:1 · 70 first) — the
//                      common reference admissions offices and ENIC/NARIC comparisons use. INDICATIVE.
//  credits.perYear     full-time credits per year → 60 ECTS (ECTS defines a full-time year as 60)
// ---------------------------------------------------------------------------------------------------
const EXT = {
  'ng-nuc-5': { policy: { retake: 'all', probation: { below: 1.0, period: 'session', withdrawAfter: 2 }, load: { min: 15, max: 24 }, graduation: { maxYearsFactor: 1.5 } },
    equivalence: { knots: [[0, 0], [1.0, 35], [1.5, 40], [2.4, 50], [3.5, 60], [4.5, 70], [5, 100]] }, credits: { perYear: 48 } },
  'ng-nuc-4': { policy: { retake: 'all', probation: { below: 1.0, period: 'session', withdrawAfter: 2 }, load: { min: 15, max: 24 }, graduation: { maxYearsFactor: 1.5 } },
    equivalence: { knots: [[0, 0], [1.0, 40], [2.0, 50], [3.0, 60], [3.5, 70], [4, 100]] }, credits: { perYear: 48 } },
  'ng-nbte-4': { policy: { retake: 'all', probation: { below: 2.0, period: 'session', withdrawAfter: 2 }, load: { min: 15, max: 24 }, graduation: { maxYearsFactor: 1.5 } },
    equivalence: { knots: [[0, 0], [2.0, 40], [2.5, 50], [3.0, 60], [3.5, 70], [4, 100]] }, credits: { perYear: 48 } },
  'gh-4': { policy: { retake: 'all', probation: { below: 1.0, period: 'session', withdrawAfter: 1 } },
    equivalence: { knots: [[0, 0], [1.0, 35], [1.5, 40], [2.0, 50], [3.0, 60], [3.6, 70], [4, 100]] }, credits: { perYear: 36 } },
  'lmd-cames-20': { policy: { retake: 'best', compensation: { average: 10, floor: null }, graduation: { minCredits: 180 } },
    equivalence: { knots: [[0, 0], [10, 40], [12, 50], [14, 60], [16, 70], [20, 100]] }, credits: { perYear: 60 } },
  'uk-honours': { policy: { retake: 'capped', resitCap: 40, condone: { from: 30, maxCredits: 30 }, graduation: { minCredits: 360 } },
    equivalence: { knots: [[0, 0], [40, 40], [50, 50], [60, 60], [70, 70], [100, 100]] }, credits: { perYear: 120 } },
  'ke-cue': { policy: { retake: 'capped', resitCap: 40 },
    equivalence: { knots: [[0, 0], [40, 40], [50, 50], [60, 60], [70, 70], [100, 100]] }, credits: { perYear: 45 } },
  'za-pct': { policy: { retake: 'capped', resitCap: 50, graduation: { minCredits: 360 } },
    equivalence: { knots: [[0, 0], [50, 40], [60, 50], [70, 60], [75, 70], [100, 100]] }, credits: { perYear: 120 } },
  'us-4': { policy: { retake: 'latest', probation: { below: 2.0, period: 'term', withdrawAfter: 3 }, honours: { termGpa: 3.5, minUnits: 12, label: "Dean's List" }, load: { min: 12, max: 18 }, graduation: { minCredits: 120 } },
    equivalence: { knots: [[0, 0], [2.0, 40], [2.7, 50], [3.3, 60], [3.7, 70], [4, 100]] }, credits: { perYear: 30 } },
  'in-ugc-10': { policy: { retake: 'best' },
    equivalence: { knots: [[0, 0], [4.2, 40], [5.8, 50], [6.3, 60], [7.4, 70], [10, 100]] }, credits: { perYear: 44 } },
  'au-7': { policy: { retake: 'all', probation: { below: 4.0, period: 'term', withdrawAfter: 2 } },
    equivalence: { knots: [[0, 0], [50, 35], [65, 40], [70, 50], [75, 60], [80, 70], [100, 100]] }, credits: { perYear: 48 } },
  'sa-5': { policy: { retake: 'best', probation: { below: 2.0, period: 'term', withdrawAfter: 3 } },
    equivalence: { knots: [[0, 0], [2.0, 40], [2.75, 50], [3.75, 60], [4.5, 70], [5, 100]] }, credits: { perYear: 36 } },
};
const POLICY_SOURCES = {
  'ng-nuc-5': ['https://openeducat.org/gradebook/nigeria/reattempt/', 'https://www.unn.edu.ng/wp-content/uploads/2016/08/UNN-REGULATIONS.doc'],
  'gh-4': ['https://www.adomonline.com/university-of-ghana-directs-students-with-cgpa-below-1-0-to-withdraw/'],
  'uk-honours': ['https://openeducat.org/gradebook/uk/resit/', 'https://info.lse.ac.uk/staff/divisions/academic-registrars-division/student-services/assets/documents/Resit-capping.pdf'],
  'us-4': ['https://registrar.gsu.edu/academic-records/grading/repeat-to-replace/', 'https://registrar.arizona.edu/records-enrollment/enrollment/repeating-course-grading-repeated-courses'],
};
for (const p of PRESETS) {
  const x = EXT[p.id]; if (!x) continue;
  p.policy = x.policy; p.equivalence = x.equivalence; p.credits = Object.assign({}, p.credits, x.credits);
  for (const s of POLICY_SOURCES[p.id] || []) if (!(p.sources || []).includes(s)) (p.sources = p.sources || []).push(s);
}
const DEFAULT_ID = 'ng-nuc-5';
const BY_ID = {}; for (const p of PRESETS) BY_ID[p.id] = p;

// ---------------------------------------------------------------------------------------------------
// 🧪 VALIDATE / NORMALISE — a malformed profile must NEVER silently corrupt grading
// ---------------------------------------------------------------------------------------------------
/** Validate + normalise a full profile. Returns { ok, errors[], profile } (profile is null when not ok).
 *  Rules: grades 2–20 rows, unique tokens, strictly-decreasing mins with the floor at 0, points inside
 *  [0, gpa.max] on a 'points' scale, at least one passing grade; bands 1–12 strictly decreasing with a
 *  floor at 0 and inside the class basis' range. */
function validate(input) {
  const errors = [];
  const p = input && typeof input === 'object' ? clone(input) : null;
  if (!p) return { ok: false, errors: ['No profile supplied.'], profile: null };
  const out = {
    id: str(p.id || 'custom', 40) || 'custom', name: str(p.name || 'Custom standard', 90), country: str(p.country, 4).toUpperCase(),
    region: str(p.region, 40), system: str(p.system, 80), summary: str(p.summary, 400), language: str(p.language || 'en', 8), currency: str(p.currency, 6).toUpperCase(),
  };
  // score scale
  const sc = p.score || {};
  const sMax = num(sc.max) != null ? num(sc.max) : 100;
  if (!(sMax >= 5 && sMax <= 1000)) errors.push('The maximum score must be between 5 and 1000 (100 for percentage marks, 20 for notes sur 20).');
  const pm = num(sc.passMark);
  out.score = { max: sMax, passMark: pm != null ? clamp(pm, 0, sMax) : null };
  if (sc.round != null && sc.round !== '') { const r = num(sc.round); if (r != null && r >= 0 && r <= 2) out.score.round = r; }
  // gpa
  const gp = p.gpa || {};
  const basis = gp.basis === 'score' ? 'score' : 'points';
  const gMax = basis === 'score' ? sMax : (num(gp.max) != null ? num(gp.max) : 5);
  if (!(gMax > 0 && gMax <= 1000)) errors.push('The GPA scale maximum must be a positive number.');
  out.gpa = { label: str(gp.label || 'CGPA', 60), termLabel: str(gp.termLabel || 'GPA', 60), finalLabel: str(gp.finalLabel || '', 30), basis, max: gMax,
    decimals: clamp(Math.round(num(gp.decimals) != null ? num(gp.decimals) : 2), 0, 4), rounding: gp.rounding === 'truncate' ? 'truncate' : 'round' };
  if (num(gp.percentFactor) != null && num(gp.percentFactor) > 0) out.gpa.percentFactor = num(gp.percentFactor);
  // grades
  const gs = Array.isArray(p.grades) ? p.grades : [];
  if (gs.length < 2 || gs.length > 20) errors.push('A grade table needs between 2 and 20 grades.');
  const seen = {}; const grades = [];
  for (const g of gs) {
    const grade = str(g && g.grade, 8); const k = gkey(grade); const min = num(g && g.min);
    let point = num(g && g.point);
    if (!grade) { errors.push('Every grade needs a letter/symbol.'); continue; }
    if (seen[k]) { errors.push(`Grade "${grade}" appears twice.`); continue; }
    if (min == null || min < 0 || min > sMax) { errors.push(`Grade ${grade}: the minimum score must be between 0 and ${sMax}.`); continue; }
    if (point == null) { if (basis === 'score') point = min; else { errors.push(`Grade ${grade}: a grade point is required.`); continue; } }
    if (basis === 'points' && (point < 0 || point > gMax)) { errors.push(`Grade ${grade}: the grade point must be between 0 and ${gMax}.`); continue; }
    seen[k] = 1;
    const aliases = Array.isArray(g.aliases) ? g.aliases.map(a => str(a, 8)).filter(a => a && !seen[gkey(a)]) : [];
    for (const a of aliases) seen[gkey(a)] = 1;
    grades.push({ grade, min, point: basis === 'score' ? clamp(point, 0, sMax) : point, remark: str(g.remark, 40), pass: g.pass !== false, aliases });
  }
  grades.sort((a, b) => b.min - a.min);
  for (let i = 1; i < grades.length; i++) if (grades[i].min >= grades[i - 1].min) { errors.push('Grade minimum scores must strictly decrease from the top grade to the bottom grade.'); break; }
  // a grade that needs a HIGHER mark can never be worth FEWER points (catches "B from 60 = 4, A from 50 = 5")
  for (let i = 1; i < grades.length; i++) if (grades[i].point > grades[i - 1].point + 1e-9) { errors.push(`Grade ${grades[i - 1].grade} needs a higher mark than ${grades[i].grade} but is worth fewer points — the points must follow the marks.`); break; }
  if (grades.length && grades[grades.length - 1].min !== 0) errors.push('The lowest grade must start at 0 so every score has a grade.');
  if (grades.length && !grades.some(g => g.pass)) errors.push('At least one grade must count as a pass.');
  out.grades = grades;
  if (out.score.passMark == null) { const lp = grades.filter(g => g.pass).pop(); out.score.passMark = lp ? lp.min : 0; }
  // classes
  const cl = p.classes || {};
  const cBasis = cl.basis === 'score' ? 'score' : 'gpa';
  const cMax = cBasis === 'score' ? sMax : gMax;
  const bs = Array.isArray(cl.bands) ? cl.bands : [];
  if (!bs.length || bs.length > 12) errors.push('Classification needs between 1 and 12 bands.');
  const bands = [];
  const usedKeys = {};
  for (const b of bs) {
    const min = num(b && b.min); const label = str(b && b.label, 80);
    if (!label || min == null || min < 0 || min > cMax) { errors.push(`Each class band needs a label and a minimum between 0 and ${cMax}.`); continue; }
    let key = str(b.key, 16).toLowerCase().replace(/[^a-z0-9]/g, '') || fold(label).replace(/[^a-z]/g, '').slice(0, 10) || 'band';
    while (usedKeys[key]) key += 'x'; usedKeys[key] = 1;
    bands.push({ key, min, label, short: str(b.short || label, 40), award: b.award !== false });
  }
  bands.sort((a, b) => b.min - a.min);
  for (let i = 1; i < bands.length; i++) if (bands[i].min >= bands[i - 1].min) { errors.push('Class band minimums must strictly decrease.'); break; }
  if (bands.length && bands[bands.length - 1].min !== 0) errors.push('The lowest class band must start at 0 (the floor case).');
  let yw = null;
  if (Array.isArray(cl.yearWeights) && cl.yearWeights.length) {
    yw = cl.yearWeights.map(Number);
    if (yw.length > 8 || yw.some(w => !Number.isFinite(w) || w < 0) || !yw.some(w => w > 0)) { errors.push('Year weights must be up to 8 non-negative numbers with at least one above 0.'); yw = null; }
  }
  out.classes = { basis: cBasis, label: str(cl.label || 'Class of Degree', 40), yearWeights: yw, bands };
  // watch thresholds (academic-watch at-risk / excelling)
  const w = p.watch || {};
  const wl = num(w.low), wh = num(w.high);
  out.watch = { low: wl != null ? clamp(wl, 0, gMax) : Math.round(gMax * 0.4 * 100) / 100, high: wh != null ? clamp(wh, 0, gMax) : Math.round(gMax * 0.9 * 100) / 100 };
  // printed legend (optional explicit rows; else generated from the grade table)
  out.legend = Array.isArray(p.legend) && p.legend.length ? p.legend.filter(r => Array.isArray(r) && r.length >= 2).slice(0, 20).map(r => r.slice(0, 3).map(x => str(x, 40))) : null;
  // vocabulary
  const cal = p.calendar || {};
  out.calendar = { termWord: str(cal.termWord || 'Semester', 30), yearWord: str(cal.yearWord || 'Session', 30),
    terms: (Array.isArray(cal.terms) ? cal.terms : []).map(t => str(t, 40)).filter(Boolean).slice(0, 12) };
  out.levels = (Array.isArray(p.levels) ? p.levels : []).map(t => str(t, 40)).filter(Boolean).slice(0, 16);
  const cr = p.credits || {};
  out.credits = { label: str(cr.label || 'Credit Units', 40), short: str(cr.short || 'CU', 8) };
  for (const k of ['perTerm', 'perYear', 'toGraduate']) { const v = num(cr[k]); if (v != null && v > 0) out.credits[k] = v; }
  out.ranks = (Array.isArray(p.ranks) ? p.ranks : []).map(t => str(t, 60)).filter(Boolean).slice(0, 30);
  const of = p.officers || {};
  out.officers = {};
  for (const k of ['head', 'deputy', 'registrar', 'dean', 'hod', 'bursar', 'exams']) out.officers[k] = str(of[k], 60);
  out.resitWord = str(p.resitWord || 'Resit', 40);
  out.awardPhrase = str(p.awardPhrase || '{class}', 60);
  out.sources = (Array.isArray(p.sources) ? p.sources : []).map(s => str(s, 300)).filter(Boolean).slice(0, 8);
  if (p.base) out.base = str(p.base, 40);
  // 📏 policy (every part optional; absent = the historical behaviour: all attempts count, no rules)
  const po = p.policy || {}; const pol = { retake: ['all', 'latest', 'best', 'capped'].includes(po.retake) ? po.retake : 'all' };
  const cap = num(po.resitCap); if (cap != null) { if (cap < 0 || cap > sMax) errors.push(`The resit cap must be between 0 and ${sMax}.`); else pol.resitCap = cap; }
  if (pol.retake === 'capped' && pol.resitCap == null) pol.resitCap = out.score.passMark;
  if (po.compensation && typeof po.compensation === 'object') {
    const av = num(po.compensation.average), fl = num(po.compensation.floor);
    if (av == null || av < 0 || av > sMax) errors.push(`The compensation average must be a mark between 0 and ${sMax}.`);
    else pol.compensation = { average: av, floor: fl != null && fl >= 0 && fl < av ? fl : null };
  }
  if (po.condone && typeof po.condone === 'object') {
    const fr = num(po.condone.from), mc = num(po.condone.maxCredits);
    if (fr == null || fr < 0 || fr >= (out.score.passMark || sMax) || mc == null || mc <= 0) errors.push('Condonement needs a lowest condonable mark below the pass mark and a positive credit limit.');
    else pol.condone = { from: fr, maxCredits: mc };
  }
  if (po.probation && typeof po.probation === 'object') {
    const b = num(po.probation.below), wa = Math.round(num(po.probation.withdrawAfter) || 0);
    if (b == null || b < 0 || b > gMax) errors.push(`The probation threshold must be between 0 and ${gMax}.`);
    else pol.probation = { below: b, period: po.probation.period === 'term' ? 'term' : 'session', withdrawAfter: wa >= 1 && wa <= 10 ? wa : null };
  }
  if (po.honours && typeof po.honours === 'object') {
    const tg = num(po.honours.termGpa), mu = num(po.honours.minUnits);
    if (tg == null || tg <= 0 || tg > gMax) errors.push(`The honours (Dean's list) GPA must be between 0 and ${gMax}.`);
    else pol.honours = { termGpa: tg, minUnits: mu != null && mu >= 0 ? mu : 0, label: str(po.honours.label || "Dean's List", 40) };
  }
  if (po.load && typeof po.load === 'object') {
    const mn = num(po.load.min), mx = num(po.load.max), pm = num(po.load.probationMax);
    if ((mn != null && mn < 0) || (mx != null && mx <= 0) || (mn != null && mx != null && mn > mx)) errors.push('The credit load needs a minimum ≤ maximum.');
    else pol.load = { min: mn, max: mx, probationMax: pm != null && pm > 0 ? pm : null };
  }
  const gr = po.graduation || {}; const mc = num(gr.minCredits), mf = num(gr.maxYearsFactor);
  pol.graduation = { minCredits: mc != null && mc > 0 ? mc : null, maxYearsFactor: mf != null && mf >= 1 && mf <= 3 ? mf : null, noOutstandingFail: gr.noOutstandingFail !== false };
  out.policy = pol;
  // 🌍 equivalence knots — strictly increasing in BOTH the value and the index, from 0 to the scale top
  const topV = cBasis === 'score' ? sMax : gMax;
  let knots = Array.isArray(p.equivalence && p.equivalence.knots) ? p.equivalence.knots.map(k => [num(k && k[0]), num(k && k[1])]) : null;
  if (knots && (knots.length < 2 || knots.some(k => k[0] == null || k[1] == null) || knots.some((k, i) => i && (k[0] <= knots[i - 1][0] || k[1] <= knots[i - 1][1])))) { errors.push('Equivalence points must rise strictly in both the value and the index.'); knots = null; }
  if (!knots) {
    // derived: the award bands, top first, anchor at 70 / 60 / 50 / 40 / 35 on the shared index
    const aw = bands.filter(b => b.award && b.min > 0); const idx = [70, 60, 50, 40, 35];
    knots = [[0, 0]]; aw.slice(0, 5).reverse().forEach((b, i, arr) => knots.push([b.min, idx[arr.length - 1 - i]])); knots.push([topV, 100]);
    knots = knots.filter((k, i) => i === 0 || (k[0] > knots[i - 1][0] && k[1] > knots[i - 1][1]));
  }
  out.equivalence = { knots, derived: !(p.equivalence && p.equivalence.knots) };
  return errors.length ? { ok: false, errors, profile: null } : { ok: true, errors: [], profile: out };
}

// pre-validate the catalogue once — a broken preset is a programming error, fail loudly in tests
const COMPILED = {};
for (const p of PRESETS) { const v = validate(p); if (!v.ok) throw new Error('standards: invalid preset ' + p.id + ': ' + v.errors.join('; ')); v.profile.base = p.id; COMPILED[p.id] = v.profile; }

function preset(id) { return COMPILED[id] ? clone(COMPILED[id]) : null; }
function catalog() {
  return PRESETS.map(p => ({ id: p.id, name: p.name, country: p.country, region: p.region, system: p.system, summary: p.summary, language: p.language, currency: p.currency, sources: p.sources || [] }));
}
function defaultProfile() { return COMPILED[DEFAULT_ID]; }

// ---------------------------------------------------------------------------------------------------
// 🧩 SPEC → PROFILE (preset + overrides, scoped rules)
// ---------------------------------------------------------------------------------------------------
/** Deep-merge `over` onto `base`: objects merge, arrays and scalars REPLACE (a grade table override is
 *  the whole table, never a positional mix of two tables). */
function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = merge(out[k], v);
    else out[k] = clone(v);
  }
  return out;
}
/** One {preset, overrides} (or a whole profile) → a VALIDATED profile. An invalid override falls back
 *  to its preset (so grading keeps working) and reports why in `_errors`. */
function build(spec) {
  const s = spec && typeof spec === 'object' ? spec : {};
  const baseId = BY_ID[s.preset] ? s.preset : DEFAULT_ID;
  const base = PRESETS.find(p => p.id === baseId);
  const hasOver = !!(s.overrides && typeof s.overrides === 'object' && Object.keys(s.overrides).length);
  const custom = hasOver || !!(s.profile && typeof s.profile === 'object');
  const raw = s.profile && typeof s.profile === 'object' ? merge(base, s.profile) : merge(base, hasOver ? s.overrides : {});
  raw.id = custom ? (str(s.id, 40) || baseId + '*') : baseId;
  if (custom && s.name) raw.name = s.name;
  const v = validate(raw);
  if (v.ok) { v.profile.base = baseId; v.profile.customised = custom; return v.profile; }
  const fb = clone(COMPILED[baseId]); fb._errors = v.errors; return fb;
}
/** First year in a session name ("2021/2022" → 2021), else null. */
function sessionYear(name) { const m = /(\d{4})/.exec(String(name || '')); return m ? Number(m[1]) : null; }
/** Which rule applies to a student context? ctx = { faculty_id, department_id, entry_year, level_id }.
 *  Rules are tried in order — the FIRST match wins — so an officer lists specific rules first. */
function ruleFor(spec, ctx) {
  const rules = spec && Array.isArray(spec.scopes) ? spec.scopes : [];
  if (!rules.length || !ctx) return null;
  for (const r of rules) {
    const m = (r && r.match) || {};
    if (m.faculty_id && m.faculty_id !== ctx.faculty_id) continue;
    if (m.department_id && m.department_id !== ctx.department_id) continue;
    if (m.level_id && m.level_id !== ctx.level_id) continue;
    if (m.entryFrom != null) { const y = num(ctx.entry_year); if (y == null || y < Number(m.entryFrom)) continue; }
    if (m.entryBefore != null) { const y = num(ctx.entry_year); if (y == null || y >= Number(m.entryBefore)) continue; }
    if (!m.faculty_id && !m.department_id && !m.level_id && m.entryFrom == null && m.entryBefore == null) continue; // an empty matcher never matches
    return r;
  }
  return null;
}
/** Resolve the profile governing a context: the first matching scoped rule, else the institution's. */
function resolve(spec, ctx) {
  const r = ruleFor(spec, ctx);
  if (r) { const p = build(r); p.scope = str(r.label || 'Scoped rule', 60); return p; }
  return build(spec);
}

// ---------------------------------------------------------------------------------------------------
// 🎓 GRADE / POINT / GPA
// ---------------------------------------------------------------------------------------------------
function P(p) { return p && p.grades ? p : defaultProfile(); }
/** Score → grade token. Non-numeric (blank/absent) → null so a skipped assessment stays BLANK. */
function gradeFor(p, score) {
  p = P(p);
  let s = num(score);
  if (s == null) return null;
  if (p.score.round != null) { const f = Math.pow(10, p.score.round); s = Math.round(s * f) / f; }
  for (const g of p.grades) if (s >= g.min) return g.grade;
  return p.grades[p.grades.length - 1].grade;
}
/** The grade row for a token (aliases honoured), or null. */
function gradeRow(p, grade) {
  p = P(p); const k = gkey(grade); if (!k) return null;
  for (const g of p.grades) { if (gkey(g.grade) === k) return g; if (g.aliases && g.aliases.some(a => gkey(a) === k)) return g; }
  return null;
}
/** The profile's own spelling of a token ("b+" → "B+", "AA" → "A" on NBTE), or the input trimmed. */
function canonGrade(p, grade) { const r = gradeRow(p, grade); return r ? r.grade : String(grade == null ? '' : grade).trim(); }
function pointFor(p, grade) { const r = gradeRow(p, grade); return r ? r.point : 0; }
function isPass(p, grade) { const r = gradeRow(p, grade); return r ? !!r.pass : false; }
function knowsGrade(p, grade) { return !!gradeRow(p, grade); }
/** The grade point to STORE for a freshly graded score: on a 'points' scale the letter's point; on a
 *  'score' scale the (clamped) mark itself — so Σ(gp×cu)/Σcu everywhere downstream IS the weighted
 *  average mark with no special-casing. */
function storedPoint(p, grade, score) {
  p = P(p);
  if (grade == null || grade === '') return null;
  if (p.gpa.basis === 'score') { const s = num(score); if (s != null) return clamp(s, 0, p.score.max); }
  return pointFor(p, grade);
}
function gradeAndPoint(p, score) { const g = gradeFor(p, score); return { grade: g, grade_point: g == null ? null : storedPoint(p, g, score) }; }
/** ⏸ "DEF" (a deferred exam — server/deferrules.js) is NOT graded yet: out of the GPA, never a fail, never a carry-over. */
function isDeferred(row) { return !!row && String(row.grade == null ? '' : row.grade).trim().toUpperCase() === 'DEF'; }
function isGraded(row) { return !!row && row.grade != null && String(row.grade).trim() !== '' && !isDeferred(row); }
/** The grade point a stored row weighs: its stored grade_point wins (it is the figure the record was
 *  computed with), clamped to the scale; else derived. NOTE Number(null)===0, so the null check comes
 *  FIRST — an imported "A" with no stored point must weigh its letter, never 0. */
function rowPoint(p, row) {
  p = P(p);
  if (!row) return 0;
  if (row.grade_point != null && row.grade_point !== '') { const n = Number(row.grade_point); if (Number.isFinite(n)) return clamp(n, 0, p.gpa.max); }
  if (p.gpa.basis === 'score') { const s = num(row.score); if (s != null) return clamp(s, 0, p.score.max); }
  return pointFor(p, String(row.grade == null ? '' : row.grade).trim());
}
function roundGpa(p, x) {
  p = P(p); const f = Math.pow(10, p.gpa.decimals);
  return p.gpa.rounding === 'truncate' ? Math.floor(x * f + 1e-9) / f : Math.round(x * f) / f;
}
/** Credit-weighted summary over rows → { qp, units, gpa, wam, wamUnits }. Ungraded rows are excluded
 *  (counting their units at 0 would silently penalise them as an F). `wam` = weighted average MARK
 *  over rows with a numeric score (what WAM-classified systems classify on). */
function summarize(p, rows) {
  p = P(p);
  let qp = 0, units = 0, ms = 0, mu = 0;
  for (const r of rows || []) {
    if (!isGraded(r)) continue;
    const u = Number(r.credit_unit != null ? r.credit_unit : r.unit) || 0;
    qp += rowPoint(p, r) * u; units += u;
    const s = num(r.score); if (s != null) { ms += s * u; mu += u; }
  }
  return { qp, units, gpa: units ? roundGpa(p, qp / units) : 0, wam: mu ? Math.round((ms / mu) * 100) / 100 : 0, wamUnits: mu };
}
function percentEquivalent(p, gpa) { p = P(p); if (!p.gpa.percentFactor) return null; return Math.round(Number(gpa || 0) * p.gpa.percentFactor * 100) / 100; }

// ---------------------------------------------------------------------------------------------------
// 🏅 CLASSIFICATION
// ---------------------------------------------------------------------------------------------------
/** The band a value falls in (highest band whose min ≤ value; the floor band otherwise). */
function band(p, value) {
  p = P(p); const x = Number(value) || 0; const bs = p.classes.bands;
  for (const b of bs) if (x >= b.min - 1e-9) return b;
  return bs[bs.length - 1];
}
/** Class label for a value. opts.short → the short label; opts.floor → text for a non-award band
 *  (e.g. '—' where a verification page must not print "Probation"). */
function classify(p, value, opts) {
  const o = opts || {}; const b = band(p, value);
  if (!b) return o.floor != null ? o.floor : '';
  if (o.floor != null && !b.award) return o.floor;
  return o.short ? b.short : b.label;
}
function bucketKey(p, value) { const b = band(p, value); return b ? b.key : ''; }
/** The value a record is CLASSIFIED on: the CGPA, or the weighted average mark on a WAM-classified
 *  profile, or — when year weights are set — the year-weighted final (Ghana FGPA 1:1:2:2, UK 0:1:2). */
function classValue(p, summary, semesters) {
  p = P(p);
  if (p.classes.yearWeights && Array.isArray(semesters) && semesters.length) {
    const f = weightedFinal(p, semesters); if (f != null) return f;
  }
  if (p.classes.basis === 'score' && p.gpa.basis !== 'score') return summary ? summary.wam : 0;
  return summary ? summary.gpa : 0;
}
/** Year-weighted final: semesters = [{ session, rows }] in calendar order. Year n = the n-th distinct
 *  session. Each year's aggregate is credit-weighted; the final is Σ(w×agg)/Σ(w) over years with data
 *  and a non-zero weight. Returns null when no weighted year has data. */
function weightedFinal(p, semesters) {
  p = P(p); const ws = p.classes.yearWeights; if (!ws) return null;
  const years = []; const idx = {};
  for (const s of semesters) {
    const key = String(s.session == null ? '' : s.session);
    if (idx[key] == null) { idx[key] = years.length; years.push([]); }
    for (const r of (s.rows || s.scores || s.courses || s.list || [])) years[idx[key]].push(r);
  }
  let num_ = 0, den = 0;
  years.forEach((rows, i) => {
    const w = ws[Math.min(i, ws.length - 1)] || 0; if (!w) return;
    const sm = summarize(p, rows); if (!sm.units) return;
    const v = (p.classes.basis === 'score' && p.gpa.basis !== 'score') ? sm.wam : sm.gpa;
    num_ += w * v; den += w;
  });
  return den ? roundGpa(p, num_ / den) : null;
}
function awardPhrase(p, label) { p = P(p); return String(p.awardPhrase || '{class}').replace('{class}', label || ''); }

// ---------------------------------------------------------------------------------------------------
// 🗓 TERM ORDER — multilingual, numeral- and season-aware (fixes "Semestre 2" sorting as a 1st term)
// ---------------------------------------------------------------------------------------------------
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
const ORD_WORDS = [
  [1, /\b(first|1st|premier|premiere|primer|primero|primera|primeiro|primo|prima|erste[rs]?|odd|harmattan|fall|autumn|michaelmas|advent)\b/],
  [2, /\b(second|2nd|deuxieme|seconde?|segundo|segunda|secondo|zweite[rs]?|even|rain|rainy|winter|lent|hilary|epiphany)\b/],
  [3, /\b(third|3rd|troisieme|tercer|tercero|tercera|terceiro|terzo|dritte[rs]?|spring)\b/],
  [4, /\b(fourth|4th|quatrieme|cuarto|quarto|vierte[rs]?|summer|trinity|easter|long vacation|ete)\b/],
];
/** Rank of a term name inside its academic year. A profile's own ordered `calendar.terms` wins; then
 *  numerals ("Semester 2", "S2", "Semestre II", "2ème"); then ordinal/season words in several
 *  languages; unknown → 1 (the historical default). Relative order matches the old /second|summer/
 *  rule for First/Second/Summer names. */
function termRank(p, name) {
  const f = fold(name);
  if (!f) return 1;
  const terms = p && p.calendar && Array.isArray(p.calendar.terms) ? p.calendar.terms : [];
  for (let i = 0; i < terms.length; i++) { const t = fold(terms[i]); if (t && (f === t)) return i + 1; }
  // a number ≤ 12 after a term word; a bigger one is a YEAR fragment ("Semester 23/24"), never a rank
  let m = /\b(?:s|sem|semester|semestre|term|terme|trimester|trimestre|quarter|q|t|periode|period)\s*(\d{1,2})\b/.exec(f);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return Number(m[1]);
  m = /\b(?:semester|semestre|term|trimester|trimestre|quarter)\s+(i{1,3}|iv|v|vi{0,3}|ix|x)\b/.exec(f);
  if (m && ROMAN[m[1]]) return ROMAN[m[1]];
  m = /^(\d{1,2})(?:st|nd|rd|th|er|ere|e|eme|o|a)?\b/.exec(f);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return Number(m[1]);
  for (const [n, re] of ORD_WORDS) if (re.test(f)) return n;
  for (let i = 0; i < terms.length; i++) { const t = fold(terms[i]); if (t && (f.indexOf(t) >= 0 || t.indexOf(f) >= 0)) return i + 1; }
  return 1;
}
/** Calendar comparator over { session, semester } names: session year, then term rank. Returns 0 when
 *  either session year is unparseable (callers keep their entry order). */
function compareTerms(p, a, b) {
  const ya = sessionYear(a.session), yb = sessionYear(b.session);
  if (ya == null || yb == null) return 0;
  if (ya !== yb) return ya - yb;
  return termRank(p, a.semester) - termRank(p, b.semester);
}

// ---------------------------------------------------------------------------------------------------
// 🖨 PRESENTATION HELPERS
// ---------------------------------------------------------------------------------------------------
const fmtN = (n) => String(Math.round(Number(n) * 100) / 100);
/** Rows for the printed GRADING SYSTEM legend: [range, grade, remark]. Explicit legend wins. */
function legendRows(p) {
  p = P(p);
  if (Array.isArray(p.legend) && p.legend.length) return p.legend.map(r => r.slice());
  const out = []; const gs = p.grades; const step = p.score.max <= 20 ? 0 : 1;
  for (let i = 0; i < gs.length; i++) {
    const hi = i === 0 ? p.score.max : gs[i - 1].min - step;
    const range = step ? `${fmtN(gs[i].min)} – ${fmtN(hi)}` : (i === 0 ? `${fmtN(gs[i].min)} – ${fmtN(hi)}` : `${fmtN(gs[i].min)} – <${fmtN(gs[i - 1].min)}`);
    out.push([p.score.max === 100 ? range + ' %' : range, gs[i].grade, gs[i].remark || '']);
  }
  return out;
}
/** Rows for the printed CLASSIFICATION legend: [range, label]. */
function classRows(p) {
  p = P(p); const bs = p.classes.bands; const top = p.classes.basis === 'score' && p.gpa.basis !== 'score' ? p.score.max : p.gpa.max;
  const dec = p.classes.basis === 'score' || p.gpa.basis === 'score' ? 0 : 2;
  return bs.map((b, i) => [i === 0 ? `${b.min.toFixed(dec)} – ${Number(top).toFixed(dec)}` : `${b.min.toFixed(dec)} – <${bs[i - 1].min.toFixed(dec)}`, b.label]);
}
/** One-line human description (UI cards, audit, assistant). */
function describe(p) {
  p = P(p);
  const top = p.grades[0]; const pass = p.grades.filter(g => g.pass).pop();
  const scale = p.gpa.basis === 'score' ? `credit-weighted average out of ${p.score.max}` : `${p.gpa.label} on ${fmtN(p.gpa.max)} points`;
  return `${p.name}: marks out of ${p.score.max}, ${p.grades.length} grades (${top.grade} from ${fmtN(top.min)}, pass from ${pass ? pass.grade + ' ' + fmtN(pass.min) : '—'}), ${scale}; ${p.classes.label.toLowerCase()} by ${p.classes.basis === 'score' && p.gpa.basis !== 'score' ? 'weighted average mark' : (p.classes.yearWeights ? 'year-weighted average (' + p.classes.yearWeights.join(':') + ')' : p.gpa.label)}.`;
}
/** A compact, JSON-safe copy for the renderer/portal (no functions, no internals). */
function compact(p) {
  p = P(p);
  return { id: p.id, base: p.base || p.id, name: p.name, country: p.country, language: p.language, score: p.score, grades: p.grades, gpa: p.gpa, classes: p.classes,
    watch: p.watch, calendar: p.calendar, levels: p.levels, credits: p.credits, ranks: p.ranks, officers: p.officers, resitWord: p.resitWord, awardPhrase: p.awardPhrase,
    legend: legendRows(p), classLegend: classRows(p), scope: p.scope || null, customised: !!p.customised, policy: p.policy, equivalence: p.equivalence };
}
/** Field-by-field differences between two profiles — for the impact preview + audit. */
function diff(a, b) {
  a = P(a); b = P(b); const out = [];
  if (a.score.max !== b.score.max) out.push({ field: 'score.max', from: a.score.max, to: b.score.max, label: `Marks out of ${a.score.max} → ${b.score.max}` });
  if (a.gpa.basis !== b.gpa.basis || a.gpa.max !== b.gpa.max) out.push({ field: 'gpa', from: `${a.gpa.basis}/${a.gpa.max}`, to: `${b.gpa.basis}/${b.gpa.max}`, label: `${a.gpa.label} ${a.gpa.basis === 'score' ? 'average /' + a.score.max : 'on ' + a.gpa.max} → ${b.gpa.label} ${b.gpa.basis === 'score' ? 'average /' + b.score.max : 'on ' + b.gpa.max}` });
  const ga = a.grades.map(g => `${g.grade}≥${g.min}=${g.point}${g.pass ? '' : '✗'}`).join(' '), gb = b.grades.map(g => `${g.grade}≥${g.min}=${g.point}${g.pass ? '' : '✗'}`).join(' ');
  if (ga !== gb) out.push({ field: 'grades', from: ga, to: gb, label: 'Grade table changes' });
  const ca = a.classes.bands.map(x => `${x.label}≥${x.min}`).join(' | '), cb = b.classes.bands.map(x => `${x.label}≥${x.min}`).join(' | ');
  if (ca !== cb || a.classes.basis !== b.classes.basis || String(a.classes.yearWeights) !== String(b.classes.yearWeights)) out.push({ field: 'classes', from: ca, to: cb, label: 'Classification changes' });
  const pa = a.policy || {}, pb = b.policy || {};
  if ((pa.retake || 'all') !== (pb.retake || 'all') || pa.resitCap !== pb.resitCap) out.push({ field: 'policy.retake', from: pa.retake || 'all', to: pb.retake || 'all', label: `Repeated courses: ${pa.retake || 'all'} → ${pb.retake || 'all'}${pb.retake === 'capped' ? ' (resit capped at ' + pb.resitCap + ')' : ''}` });
  if (JSON.stringify(pa.probation || null) !== JSON.stringify(pb.probation || null)) out.push({ field: 'policy.probation', label: 'Probation / withdrawal rule changes' });
  if (JSON.stringify(pa.compensation || null) !== JSON.stringify(pb.compensation || null) || JSON.stringify(pa.condone || null) !== JSON.stringify(pb.condone || null)) out.push({ field: 'policy.compensation', label: 'Compensation / condonement changes' });
  return out;
}
/** Is the POINT system of two profiles the same (so already-stored grade points stay meaningful)? */
function samePointSystem(a, b) {
  a = P(a); b = P(b);
  if (a.gpa.basis !== b.gpa.basis || a.gpa.max !== b.gpa.max || a.score.max !== b.score.max) return false;
  if (a.gpa.basis === 'score') return true;
  for (const g of a.grades) { const r = gradeRow(b, g.grade); if (r && r.point !== g.point) return false; }
  return true;
}

// ---------------------------------------------------------------------------------------------------
// 📏 POLICY ENGINE — retakes · compensation / condonement · standing · carry-overs · graduation · load
// ---------------------------------------------------------------------------------------------------
/** A course's identity across attempts (code skeleton, else title). */
function courseKey(r) { const c = String((r && (r.course_code || r.code)) || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return c || ('T:' + fold(r && (r.course_title || r.title))); }
const sesOf = (r) => r.session_name != null ? r.session_name : (r.session != null ? r.session : '');
const semOf = (r) => r.semester_name != null ? r.semester_name : (r.semester != null ? r.semester : '');
/** Chronological attempt order: session year → term rank → entry time. */
function attemptCmp(p, a, b) {
  const ya = sessionYear(sesOf(a)), yb = sessionYear(sesOf(b));
  if (ya != null && yb != null && ya !== yb) return ya - yb;
  const ta = termRank(p, semOf(a)), tb = termRank(p, semOf(b));
  if (ya != null && yb != null && ta !== tb) return ta - tb;
  return String(a.created_at || '').localeCompare(String(b.created_at || ''));
}
/** Did a graded row FAIL under the standard? (an unknown letter keeps the historical rule: only F fails) */
function failed(p, r) {
  p = P(p); if (!isGraded(r)) return false;
  const g = String(r.grade).trim();
  return knowsGrade(p, g) ? !isPass(p, g) : g.toUpperCase() === 'F';
}
/** Every row annotated with its attempt number and whether it COUNTS in the cumulative GPA under the
 *  retake policy. A capped resit gets derived `score/grade/grade_point` (the stored row is untouched;
 *  `original` keeps what was recorded). Ungraded rows pass through (they never count). */
function annotateAttempts(p, rows) {
  p = P(p); const pol = p.policy || { retake: 'all' };
  const out = (rows || []).map(r => { const c = Object.assign({}, r, { counts: isGraded(r), attempt: 1, attempts: 1 }); Object.defineProperty(c, '_src', { value: r, enumerable: false }); return c; });
  const groups = new Map();
  out.forEach((r) => { if (!isGraded(r)) return; const k = courseKey(r); (groups.get(k) || groups.set(k, []).get(k)).push(r); });
  for (const list of groups.values()) {
    list.sort((a, b) => attemptCmp(p, a, b));
    list.forEach((r, i) => { r.attempt = i + 1; r.attempts = list.length; });
    if (list.length < 2 || pol.retake === 'all') continue;
    let keep = list[list.length - 1];
    if (pol.retake === 'best') for (const r of list) if (rowPoint(p, r) > rowPoint(p, keep) + 1e-9) keep = r;
    for (const r of list) if (r !== keep) { r.counts = false; r.superseded = true; }
    if (pol.retake === 'capped' && list.slice(0, -1).some(r => failed(p, r))) {
      const cap = pol.resitCap != null ? pol.resitCap : p.score.passMark;
      const s = num(keep.score);
      if (s != null && s > cap) {
        const g = gradeFor(p, cap);
        keep.original = { score: keep.score, grade: keep.grade, grade_point: keep.grade_point };
        keep.score = cap; keep.grade = g; keep.grade_point = storedPoint(p, g, cap); keep.capped = true;
      } else if (s == null && rowPoint(p, keep) > storedPoint(p, gradeFor(p, cap), cap)) {
        const g = gradeFor(p, cap);
        keep.original = { grade: keep.grade, grade_point: keep.grade_point };
        keep.grade = g; keep.grade_point = storedPoint(p, g, cap); keep.capped = true;
      }
    }
  }
  return out;
}
/** Only the rows that COUNT in the cumulative GPA (retake policy applied; identity under 'all'). */
function countedRows(p, rows) { p = P(p); if (!p.policy || p.policy.retake === 'all') return rows || []; return annotateAttempts(p, rows).filter(r => r.counts); }
/** Cumulative summary under the retake policy. */
function cumulative(p, rows) { return summarize(p, countedRows(p, rows)); }
const unitOf = (r) => Number(r.credit_unit != null ? r.credit_unit : r.unit) || 0;
/** The outcome of one TERM (semester): average, credits earned, and which failed courses were
 *  COMPENSATED (LMD semester average ≥ threshold) — a compensated course needs no resit. */
function termOutcome(p, rows) {
  p = P(p); const graded = (rows || []).filter(isGraded);
  const sm = summarize(p, graded);
  const fails = graded.filter(r => failed(p, r));
  const comp = p.policy && p.policy.compensation;
  let compensated = [];
  let status = fails.length ? 'failures' : 'passed';
  if (comp && graded.length) {
    const avg = p.gpa.basis === 'score' ? sm.gpa : sm.wam;
    if (avg >= comp.average - 1e-9) {
      const blocked = comp.floor != null ? fails.filter(r => num(r.score) != null && num(r.score) < comp.floor) : [];
      if (!blocked.length) { compensated = fails.slice(); status = fails.length ? 'compensated' : 'validated'; }
      else status = 'failures';
    } else status = 'deferred';
  }
  const compSet = new Set(compensated);
  const earned = graded.reduce((a, r) => a + ((!failed(p, r) || compSet.has(r)) ? unitOf(r) : 0), 0);
  return { gpa: sm.gpa, units: sm.units, earned, fails: fails.filter(r => !compSet.has(r)), compensated, status };
}
/** UK condonement over one academic YEAR: failed modules marked ≥ from, up to maxCredits, count as
 *  passed — only when every other module of the year was passed. */
function condoneYear(p, rows) {
  p = P(p); const c = p.policy && p.policy.condone; if (!c) return [];
  const fails = (rows || []).filter(r => failed(p, r));
  if (!fails.length) return [];
  const ok = fails.filter(r => num(r.score) != null && num(r.score) >= c.from);
  if (ok.length !== fails.length) return [];                    // a fail below the condonable band blocks it
  const credits = ok.reduce((a, r) => a + unitOf(r), 0);
  return credits <= c.maxCredits ? ok : [];
}
/** Group rows into ordered terms / sessions: [{ session, semester, rows }]. */
function termsOf(p, rows) {
  const map = new Map();
  for (const r of rows || []) { const k = sesOf(r) + '|' + semOf(r); (map.get(k) || map.set(k, { session: sesOf(r), semester: semOf(r), rows: [], _t: r.created_at || '' }).get(k)).rows.push(r); }
  const list = [...map.values()];
  list.sort((a, b) => compareTerms(p, a, b) || String(a._t).localeCompare(String(b._t)));
  return list;
}
/** 📈 THE STANDING TIMELINE of one record: per term GPA, cumulative GPA (retake-aware), credits earned
 *  (compensation / condonement-aware), probation / withdrawal / Dean's list, LMD semester validation;
 *  plus the outstanding carry-overs, total credits earned and the final classification value. */
function standingTimeline(p, rows) {
  p = P(p); const pol = p.policy || {};
  const all = (rows || []).filter(Boolean);
  const terms = termsOf(p, all);
  const condoned = new Set();
  if (pol.condone) { const bySes = new Map(); for (const t of terms) (bySes.get(t.session) || bySes.set(t.session, []).get(t.session)).push(...t.rows); for (const yr of bySes.values()) for (const r of condoneYear(p, yr)) condoned.add(r); }
  const compensated = new Set();
  let cum = []; let streak = 0; let lastSession = null;
  const periods = [];
  terms.forEach((t, i) => {
    const out = termOutcome(p, t.rows);
    for (const r of out.compensated) compensated.add(r);
    cum = cum.concat(t.rows);
    const cg = cumulative(p, cum);
    const endOfPeriod = pol.probation && pol.probation.period === 'session' ? (i === terms.length - 1 || terms[i + 1].session !== t.session) : true;
    let status = 'good';
    if (pol.probation && endOfPeriod) {
      if (cg.gpa < pol.probation.below - 1e-9) streak++; else streak = 0;
    }
    if (pol.probation) status = streak === 0 ? 'good' : (pol.probation.withdrawAfter && streak >= pol.probation.withdrawAfter ? 'withdraw' : 'probation');
    if (pol.compensation) status = out.status === 'deferred' ? 'deferred' : (out.status === 'compensated' ? 'compensated' : (out.status === 'failures' ? 'failures' : 'validated'));
    const hon = pol.honours && out.units >= (pol.honours.minUnits || 0) && out.gpa >= pol.honours.termGpa - 1e-9 && !out.fails.length ? pol.honours.label : null;
    periods.push({ session: t.session, semester: t.semester, gpa: out.gpa, units: out.units, earned: out.earned, cgpa: cg.gpa, cumulativeUnits: cg.units,
      status, periodEnd: endOfPeriod, honours: hon, compensated: out.compensated.map(r => r.course_code || r.code), failed: out.fails.map(r => r.course_code || r.code) });
    lastSession = t.session;
  });
  // outstanding = counted attempts that failed and were neither compensated nor condoned
  const counted = annotateAttempts(p, all).filter(r => r.counts);
  const latestByCourse = new Map();
  for (const r of annotateAttempts(p, all).filter(isGraded)) { const k = courseKey(r); const prev = latestByCourse.get(k); if (!prev || attemptCmp(p, prev, r) <= 0) latestByCourse.set(k, r); }
  const origOf = (r) => r._src || all.find(x => (x.id && x.id === r.id)) || r;
  const passedEver = new Set(all.filter(r => isGraded(r) && (!failed(p, r) || compensated.has(r) || condoned.has(r))).map(courseKey));
  const outstanding = [];
  for (const [k, r] of latestByCourse) if (!passedEver.has(k) && failed(p, r) && !compensated.has(origOf(r)) && !condoned.has(origOf(r))) outstanding.push({ course_code: r.course_code || r.code || '', course_title: r.course_title || r.title || '', credit_unit: unitOf(r), attempts: r.attempts });
  let earned = 0; const seen = new Set();
  for (const r of all) { if (!isGraded(r)) continue; const k = courseKey(r); if (seen.has(k)) continue; if (!failed(p, r) || compensated.has(r) || condoned.has(r)) { earned += unitOf(r); seen.add(k); } }
  const sm = summarize(p, counted);
  const value = classValue(p, sm, terms.map(t => ({ session: t.session, rows: countedRows(p, t.rows) })));
  const last = periods[periods.length - 1] || null;
  return { periods, outstanding, creditsEarned: earned, cgpa: sm.gpa, units: sm.units, value, class: classify(p, value), classShort: classify(p, value, { short: true }),
    status: last ? last.status : 'good', condoned: [...condoned].map(r => r.course_code || r.code), lastSession,
    honoursCount: periods.filter(x => x.honours).length, retake: pol.retake || 'all' };
}
/** Credit-load check for one term. */
function loadCheck(p, units, opts) {
  p = P(p); const L = p.policy && p.policy.load; const u = Number(units) || 0;
  if (!L) return { ok: true, units: u };
  const max = (opts && opts.onProbation && L.probationMax) ? L.probationMax : L.max;
  if (max != null && u > max) return { ok: false, units: u, max, reason: `${u} ${p.credits.short} registered — above the maximum of ${max}` };
  if (L.min != null && u > 0 && u < L.min) return { ok: false, units: u, min: L.min, reason: `${u} ${p.credits.short} registered — below the minimum of ${L.min}` };
  return { ok: true, units: u, min: L.min, max };
}
/** 🎓 Graduation audit: credits earned vs required, outstanding failures, time limit. */
function graduationAudit(p, timeline, opts) {
  p = P(p); const g = (p.policy && p.policy.graduation) || {}; const o = opts || {};
  const reasons = [];
  const required = o.requiredCredits != null ? o.requiredCredits : g.minCredits;
  if (required && timeline.creditsEarned < required) reasons.push(`${timeline.creditsEarned}/${required} ${p.credits.short} earned`);
  if (g.noOutstandingFail !== false && timeline.outstanding.length) reasons.push(`${timeline.outstanding.length} outstanding failure(s): ${timeline.outstanding.slice(0, 5).map(x => x.course_code).join(', ')}`);
  let maxYears = null;
  if (g.maxYearsFactor && o.programmeYears) maxYears = Math.ceil(o.programmeYears * g.maxYearsFactor);
  if (maxYears && o.yearsElapsed != null && o.yearsElapsed > maxYears) reasons.push(`${o.yearsElapsed} years elapsed — beyond the ${maxYears}-year limit`);
  if (timeline.status === 'withdraw') reasons.push('required to withdraw (academic standing)');
  return { eligible: reasons.length === 0, reasons, creditsEarned: timeline.creditsEarned, requiredCredits: required || null, maxYears, class: timeline.class, value: timeline.value };
}

/** 📊 ECTS GRADING TABLE (ECTS Users' Guide 2015): the statistical distribution of PASSING grades in a
 *  reference group (a programme over several years), so a receiving institution can read a local grade
 *  — the % of passing results at each grade and the cumulative %, best grade first. `sufficient` flags a
 *  reference group large enough to be meaningful (≥ 100 passing results). */
function gradingTable(p, rows) {
  p = P(p); const counts = {}; let n = 0;
  for (const r of rows || []) {
    if (!isGraded(r)) continue;
    const g = gradeRow(p, r.grade); if (!g || !g.pass) continue;
    counts[g.grade] = (counts[g.grade] || 0) + 1; n++;
  }
  let cum = 0;
  const table = p.grades.filter(g => g.pass).map(g => { const c = counts[g.grade] || 0; const pc = n ? (c * 100) / n : 0; cum += pc; return { grade: g.grade, remark: g.remark, count: c, percent: Math.round(pc * 10) / 10, cumulative: Math.round(cum * 10) / 10 }; });
  return { n, rows: table, sufficient: n >= 100 };
}

// ---------------------------------------------------------------------------------------------------
// 🌍 EQUIVALENCE · CREDIT CONVERSION · TRANSFER CREDIT
// ---------------------------------------------------------------------------------------------------
function interp(knots, x, from, to) {
  const k = knots; if (x <= k[0][from]) return k[0][to];
  for (let i = 1; i < k.length; i++) if (x <= k[i][from] + 1e-12) { const a = k[i - 1], b = k[i]; const t = (x - a[from]) / ((b[from] - a[from]) || 1); return a[to] + t * (b[to] - a[to]); }
  return k[k.length - 1][to];
}
/** A classification-scale value → the shared 0–100 equivalence index (and back). */
function toIndex(p, v) { p = P(p); return Math.round(interp(p.equivalence.knots, Number(v) || 0, 0, 1) * 100) / 100; }
function fromIndex(p, i) { p = P(p); return interp(p.equivalence.knots, Number(i) || 0, 1, 0); }
/** INDICATIVE conversion of a classification value (CGPA / average / WAM) between two standards. */
function convert(pFrom, pTo, value) {
  pFrom = P(pFrom); pTo = P(pTo);
  const idx = toIndex(pFrom, value); const raw = fromIndex(pTo, idx);
  const v = pTo.gpa.basis === 'score' || (pTo.classes.basis === 'score') ? Math.round(raw * 10) / 10 : roundGpa(pTo, raw);
  return { from: { standard: pFrom.name, value: Number(value), class: classify(pFrom, value) }, index: idx, to: { standard: pTo.name, value: v, class: classify(pTo, v) } };
}
/** ECTS per credit unit of a standard (60 ECTS = one full-time year). */
function ectsPerUnit(p) { p = P(p); const y = p.credits && p.credits.perYear; return y ? 60 / y : 1; }
function convertCredits(pFrom, pTo, units) { return Math.round((Number(units) || 0) * ectsPerUnit(pFrom) / ectsPerUnit(pTo) * 100) / 100; }
/** The value a single COURSE result carries on the classification scale (a mark on WAM/average
 *  standards, the grade point otherwise). */
function courseValue(p, r) {
  p = P(p);
  const onScore = p.gpa.basis === 'score' || p.classes.basis === 'score';
  if (onScore) { const s = num(r.score); if (s != null) return s; const g = gradeRow(p, r.grade); if (!g) return null; const i = p.grades.indexOf(g); const hi = i === 0 ? p.score.max : p.grades[i - 1].min; return (g.min + hi) / 2; }
  if (r.grade_point != null && r.grade_point !== '' && Number.isFinite(Number(r.grade_point))) return Number(r.grade_point);
  if (r.grade != null && knowsGrade(p, r.grade)) return pointFor(p, r.grade);
  const s = num(r.score); if (s != null) return pointFor(p, gradeFor(p, s));
  return null;
}
/** 🔁 TRANSFER CREDIT evaluation (a student arriving from another institution). Passing courses
 *  transfer; credits are converted through ECTS; each grade gets an INDICATIVE local equivalent via
 *  the shared index. Nothing is written — the registry decides. */
function evaluateTransfer(pFrom, pTo, rows, opts) {
  pFrom = P(pFrom); pTo = P(pTo); const o = opts || {};
  const out = [];
  for (const r of rows || []) {
    const hasGrade = r.grade != null && String(r.grade).trim() !== '';
    const hasScore = num(r.score) != null;
    const grade = hasGrade ? canonGrade(pFrom, r.grade) : (hasScore ? gradeFor(pFrom, r.score) : null);
    const row = { code: r.code || r.course_code || '', title: r.title || r.course_title || '', creditsIn: unitOf(r), score: hasScore ? num(r.score) : null, gradeIn: grade };
    if (!grade) { out.push(Object.assign(row, { transferable: false, reason: 'no result' })); continue; }
    if (!knowsGrade(pFrom, grade)) { out.push(Object.assign(row, { transferable: false, reason: `“${grade}” is not a grade of ${pFrom.name}` })); continue; }
    if (!isPass(pFrom, grade)) { out.push(Object.assign(row, { transferable: false, reason: 'not a pass at the sending institution' })); continue; }
    const v = courseValue(pFrom, Object.assign({}, r, { grade }));
    const idx = toIndex(pFrom, v);
    if (o.minIndex != null && idx < o.minIndex) { out.push(Object.assign(row, { transferable: false, reason: 'below the minimum grade accepted for transfer', index: idx })); continue; }
    const tv = fromIndex(pTo, idx);
    let gradeOut;
    if (pTo.gpa.basis === 'score' || pTo.classes.basis === 'score') gradeOut = gradeFor(pTo, Math.min(pTo.score.max, tv));
    else { let best = null; for (const g of pTo.grades) if (g.pass && (best == null || Math.abs(g.point - tv) < Math.abs(best.point - tv))) best = g; gradeOut = best ? best.grade : null; }
    out.push(Object.assign(row, { transferable: true, index: idx, gradeOut, creditsOut: convertCredits(pFrom, pTo, row.creditsIn) }));
  }
  const tr = out.filter(r => r.transferable);
  return { from: pFrom.name, to: pTo.name, rows: out, transferable: tr.length, creditsIn: out.reduce((a, r) => a + r.creditsIn, 0),
    creditsOut: Math.round(tr.reduce((a, r) => a + r.creditsOut, 0) * 100) / 100, ectsIn: Math.round(tr.reduce((a, r) => a + r.creditsIn * ectsPerUnit(pFrom), 0) * 10) / 10 };
}

module.exports = {
  VERSION: 1, DEFAULT_ID, PRESETS, catalog, preset, defaultProfile, validate, build, resolve, ruleFor, merge,
  gradeFor, gradeRow, canonGrade, pointFor, isPass, knowsGrade, storedPoint, gradeAndPoint, isGraded, isDeferred, rowPoint, roundGpa, summarize,
  percentEquivalent, band, classify, bucketKey, classValue, weightedFinal, awardPhrase,
  termRank, compareTerms, sessionYear, legendRows, classRows, describe, compact, diff, samePointSystem, gkey, fold,
  // 📏 policy engine
  courseKey, attemptCmp, failed, annotateAttempts, countedRows, cumulative, termOutcome, condoneYear, termsOf, standingTimeline, loadCheck, graduationAudit,
  // 🌍 equivalence
  toIndex, fromIndex, convert, ectsPerUnit, convertCredits, courseValue, evaluateTransfer, gradingTable,
};
