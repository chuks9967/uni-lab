'use strict';
/** 🌐 INTERNATIONAL FRAMEWORKS — the shared vocabulary that makes a programme comparable worldwide.
 *
 *  • UNESCO ISCED 2011 levels (5 short-cycle tertiary · 6 bachelor's · 7 master's · 8 doctoral) and the
 *    ISCED-F 2013 fields of education (the 4-digit detailed fields statistics offices, ENIC-NARIC
 *    centres and the Diploma Supplement use). ISCED-F codes below are UNESCO's.
 *  • EQF levels (European Qualifications Framework; the Bologna cycles map 6/7/8) and, where a
 *    national framework is well established, its level (UK FHEQ, South Africa NQF, Australia AQF).
 *  • Award types (bachelor/master/…) → ISCED/EQF level + the Open Badges 3.0 achievementType.
 *  • A short, factual NATIONAL HIGHER-EDUCATION SYSTEM description per country for section 8 of the
 *    Diploma Supplement — a starting text the institution can replace with its own.
 *
 *  PURE (no DB, no Node APIs) — used by the desktop services, the portal and the Supabase edge.
 */

// ---------------------------------------------------------------------------------------------------
// ISCED-F 2013 — broad fields and the detailed fields programmes are usually classified under
// ---------------------------------------------------------------------------------------------------
const ISCED_BROAD = {
  '00': 'Generic programmes and qualifications', '01': 'Education', '02': 'Arts and humanities',
  '03': 'Social sciences, journalism and information', '04': 'Business, administration and law',
  '05': 'Natural sciences, mathematics and statistics', '06': 'Information and Communication Technologies (ICTs)',
  '07': 'Engineering, manufacturing and construction', '08': 'Agriculture, forestry, fisheries and veterinary',
  '09': 'Health and welfare', '10': 'Services',
};
// [code, label, keywords (EN + FR, folded, word-start matches)]
const ISCED_F = [
  ['0111', 'Education science', ['education', 'educational', 'pedagogy', 'sciences de l education', 'pedagogie', 'guidance and counselling', 'curriculum']],
  ['0112', 'Training for pre-school teachers', ['early childhood', 'pre school', 'preschool', 'nursery education', 'prescolaire']],
  ['0113', 'Teacher training without subject specialisation', ['primary education', 'enseignement primaire']],
  ['0114', 'Teacher training with subject specialisation', ['science education', 'mathematics education', 'english education', 'education biology', 'education chemistry', 'education physics', 'education mathematics', 'education english', 'teacher']],
  ['0211', 'Audio-visual techniques and media production', ['film', 'cinema', 'audiovisual', 'audio visual', 'media production', 'broadcasting', 'multimedia', 'photography']],
  ['0212', 'Fashion, interior and industrial design', ['fashion', 'interior design', 'industrial design', 'graphic design', 'design']],
  ['0213', 'Fine arts', ['fine art', 'fine arts', 'visual arts', 'beaux arts', 'arts plastiques', 'painting', 'sculpture']],
  ['0214', 'Handicrafts', ['handicraft', 'crafts', 'artisanat', 'ceramics']],
  ['0215', 'Music and performing arts', ['music', 'musique', 'theatre', 'theater', 'dance', 'performing arts', 'arts du spectacle', 'drama', 'creative arts']],
  ['0221', 'Religion and theology', ['religion', 'religious', 'theology', 'theologie', 'islamic', 'christian', 'divinity', 'biblical']],
  ['0222', 'History and archaeology', ['history', 'histoire', 'archaeology', 'archeologie', 'heritage']],
  ['0223', 'Philosophy and ethics', ['philosophy', 'philosophie', 'ethics', 'ethique']],
  ['0231', 'Language acquisition', ['french', 'english', 'arabic', 'spanish', 'german', 'chinese', 'portuguese', 'yoruba', 'hausa', 'igbo', 'swahili', 'langues', 'languages', 'anglais', 'francais', 'modern languages', 'foreign languages']],
  ['0232', 'Literature and linguistics', ['linguistics', 'linguistique', 'literature', 'litterature', 'literary', 'lettres modernes', 'english and literary studies']],
  ['0311', 'Economics', ['economics', 'economic', 'economie', 'sciences economiques', 'econometrics']],
  ['0312', 'Political sciences and civics', ['political science', 'politics', 'sciences politiques', 'international relations', 'relations internationales', 'public administration', 'peace and conflict']],
  ['0313', 'Psychology', ['psychology', 'psychologie']],
  ['0314', 'Sociology and cultural studies', ['sociology', 'sociologie', 'anthropology', 'anthropologie', 'cultural studies', 'demography', 'criminology', 'gender studies', 'social studies']],
  ['0321', 'Journalism and reporting', ['journalism', 'journalisme', 'mass communication', 'communication', 'public relations', 'media studies']],
  ['0322', 'Library, information and archival studies', ['library', 'bibliotheque', 'information science', 'archival', 'archives', 'records management', 'documentation']],
  ['0411', 'Accounting and taxation', ['accounting', 'accountancy', 'comptabilite', 'taxation', 'audit', 'fiscalite']],
  ['0412', 'Finance, banking and insurance', ['finance', 'banking', 'banque', 'insurance', 'assurance', 'actuarial', 'financial']],
  ['0413', 'Management and administration', ['business administration', 'management', 'gestion', 'administration des affaires', 'human resource', 'entrepreneurship', 'project management', 'business', 'office management', 'logistics', 'supply chain']],
  ['0414', 'Marketing and advertising', ['marketing', 'advertising', 'publicite']],
  ['0415', 'Secretarial and office work', ['secretarial', 'office technology', 'secretariat']],
  ['0416', 'Wholesale and retail sales', ['retail', 'purchasing', 'procurement', 'commerce']],
  ['0421', 'Law', ['law', 'laws', 'droit', 'legal', 'jurisprudence', 'sciences juridiques', 'common law', 'civil law', 'sharia']],
  ['0511', 'Biology', ['biology', 'biologie', 'botany', 'zoology', 'microbiology', 'genetics', 'plant science', 'animal biology', 'biological sciences', 'cell biology']],
  ['0512', 'Biochemistry', ['biochemistry', 'biochimie', 'molecular biology', 'biotechnology']],
  ['0521', 'Environmental sciences', ['environmental science', 'environnement', 'environmental management', 'environmental studies']],
  ['0522', 'Natural environments and wildlife', ['wildlife', 'ecology', 'conservation', 'ecotourism']],
  ['0531', 'Chemistry', ['chemistry', 'chimie', 'industrial chemistry', 'pure and applied chemistry']],
  ['0532', 'Earth sciences', ['geology', 'geologie', 'earth science', 'geophysics', 'geography', 'geographie', 'meteorology', 'oceanography', 'geoscience', 'remote sensing']],
  ['0533', 'Physics', ['physics', 'physique', 'astronomy', 'applied physics', 'electronics physics']],
  ['0541', 'Mathematics', ['mathematics', 'mathematiques', 'maths', 'applied mathematics', 'pure mathematics']],
  ['0542', 'Statistics', ['statistics', 'statistique', 'data science', 'actuarial science']],
  ['0611', 'Computer use', ['computer applications', 'computer use', 'bureautique']],
  ['0612', 'Database and network design and administration', ['networking', 'network', 'cyber security', 'cybersecurity', 'information systems', 'systemes d information', 'database', 'reseaux', 'telecommunications']],
  ['0613', 'Software and applications development and analysis', ['computer science', 'informatique', 'software', 'computing', 'computer engineering', 'information technology', 'programming', 'artificial intelligence', 'genie logiciel']],
  ['0711', 'Chemical engineering and processes', ['chemical engineering', 'genie chimique', 'petroleum engineering', 'process engineering', 'petrochemical']],
  ['0712', 'Environmental protection technology', ['environmental engineering', 'water resources', 'waste management']],
  ['0713', 'Electricity and energy', ['electrical engineering', 'electrical', 'electrotechnique', 'energy', 'power engineering', 'renewable energy', 'genie electrique']],
  ['0714', 'Electronics and automation', ['electronics', 'electronique', 'automation', 'mechatronics', 'control engineering', 'electrical electronics', 'electronic engineering', 'instrumentation']],
  ['0715', 'Mechanics and metal trades', ['mechanical engineering', 'mechanical', 'genie mecanique', 'metallurgy', 'metallurgical', 'welding', 'production engineering']],
  ['0716', 'Motor vehicles, ships and aircraft', ['aeronautical', 'aerospace', 'automotive', 'marine engineering', 'naval']],
  ['0721', 'Food processing', ['food science', 'food technology', 'agroalimentaire', 'nutrition and dietetics', 'food processing']],
  ['0722', 'Materials (glass, paper, plastic and wood)', ['materials', 'polymer', 'wood', 'glass', 'paper technology']],
  ['0723', 'Textiles (clothes, footwear and leather)', ['textile', 'leather']],
  ['0724', 'Mining and extraction', ['mining', 'mines', 'mineral', 'extraction']],
  ['0731', 'Architecture and town planning', ['architecture', 'urban planning', 'urban and regional planning', 'town planning', 'urbanisme', 'estate management', 'quantity surveying', 'surveying', 'geomatics']],
  ['0732', 'Building and civil engineering', ['civil engineering', 'genie civil', 'building', 'construction', 'structural engineering']],
  ['0811', 'Crop and livestock production', ['agriculture', 'agronomy', 'agronomie', 'crop', 'animal science', 'animal production', 'soil science', 'agricultural', 'agricultural economics', 'agricultural extension']],
  ['0812', 'Horticulture', ['horticulture']],
  ['0821', 'Forestry', ['forestry', 'foresterie', 'forest']],
  ['0831', 'Fisheries', ['fisheries', 'aquaculture', 'peche']],
  ['0841', 'Veterinary', ['veterinary', 'veterinaire']],
  ['0911', 'Dental studies', ['dentistry', 'dental', 'odontologie']],
  ['0912', 'Medicine', ['medicine', 'medecine', 'surgery', 'mbbs', 'medical', 'clinical sciences']],
  ['0913', 'Nursing and midwifery', ['nursing', 'soins infirmiers', 'midwifery', 'sage femme', 'nurse']],
  ['0914', 'Medical diagnostic and treatment technology', ['medical laboratory', 'radiography', 'medical imaging', 'laboratory science', 'biomedical', 'optometry', 'anatomy', 'physiology']],
  ['0915', 'Therapy and rehabilitation', ['physiotherapy', 'kinesitherapie', 'occupational therapy', 'rehabilitation', 'speech therapy']],
  ['0916', 'Pharmacy', ['pharmacy', 'pharmacie', 'pharmaceutical', 'pharmacology']],
  ['0917', 'Traditional and complementary medicine and therapy', ['traditional medicine', 'herbal medicine', 'complementary medicine']],
  ['0923', 'Social work and counselling', ['social work', 'travail social', 'counselling', 'counseling', 'social welfare']],
  ['0988', 'Inter-disciplinary programmes and qualifications involving health and welfare', ['public health', 'sante publique', 'community health', 'health education', 'epidemiology', 'health management', 'environmental health']],
  ['1013', 'Hotel, restaurants and catering', ['hospitality', 'hotel', 'catering', 'hotellerie']],
  ['1014', 'Sports', ['sport', 'sports', 'physical education', 'kinesiology', 'human kinetics', 'staps']],
  ['1015', 'Travel, tourism and leisure', ['tourism', 'tourisme', 'leisure', 'travel']],
  ['1022', 'Occupational health and safety', ['occupational health', 'safety', 'hse']],
  ['1032', 'Protection of persons and property', ['security studies', 'policing', 'fire service']],
  ['1041', 'Transport services', ['transport', 'maritime', 'aviation management']],
];
const fold = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** The ISCED-F 2013 detailed field a programme/department NAME belongs to (best keyword match, longer
 *  phrases win; EN + FR). → { code, label, broad, confidence } or null. */
function iscedFieldFor(name) {
  const f = ' ' + fold(name) + ' ';
  if (!f.trim()) return null;
  let best = null;
  for (const [code, label, kws] of ISCED_F) {
    for (const k of kws) {
      if (f.indexOf(' ' + k + ' ') === -1 && f.indexOf(' ' + k) === -1) continue;
      const exact = f.indexOf(' ' + k + ' ') !== -1;
      // a keyword that IS the whole name ("Law", "Nursing") is the strongest possible match
      const score = k.split(' ').length * 10 + k.length + (exact ? 5 : 0) + (f.trim() === k ? 40 : 0);
      if (!best || score > best.score) best = { code, label, score };
    }
  }
  if (!best) return null;
  return { code: best.code, label: best.label, broad: ISCED_BROAD[best.code.slice(0, 2)] || '', confidence: Math.min(95, 40 + best.score) };
}
function iscedLabel(code) { const r = ISCED_F.find(x => x[0] === String(code)); return r ? r[1] : ''; }
function iscedList() { return ISCED_F.map(([code, label]) => ({ code, label, broad: ISCED_BROAD[code.slice(0, 2)] || '' })); }

// ---------------------------------------------------------------------------------------------------
// AWARD TYPES → ISCED 2011 level · EQF level · Open Badges 3.0 achievementType
// ---------------------------------------------------------------------------------------------------
const ISCED_LEVELS = { 5: 'Short-cycle tertiary education', 6: "Bachelor's or equivalent level", 7: "Master's or equivalent level", 8: 'Doctoral or equivalent level' };
// UNESCO's official French titles (CITE 2011)
const ISCED_LEVELS_FR = { 5: 'Enseignement supérieur de cycle court', 6: 'Niveau licence ou équivalent', 7: 'Niveau master ou équivalent', 8: 'Niveau doctorat ou équivalent' };
const AWARDS = {
  diploma: { label: 'Diploma (short-cycle tertiary)', isced: 5, eqf: 5, obType: 'Diploma', cycle: 'Short cycle' },
  associate: { label: 'Associate degree', isced: 5, eqf: 5, obType: 'AssociateDegree', cycle: 'Short cycle' },
  hnd: { label: 'Higher National Diploma', isced: 6, eqf: 6, obType: 'Diploma', cycle: 'First cycle' },
  bachelor: { label: "Bachelor's degree", isced: 6, eqf: 6, obType: 'BachelorDegree', cycle: 'First cycle (Bologna)' },
  honours: { label: "Bachelor's degree with honours", isced: 6, eqf: 6, obType: 'BachelorDegree', cycle: 'First cycle (Bologna)' },
  licence: { label: 'Licence (LMD)', isced: 6, eqf: 6, obType: 'BachelorDegree', cycle: 'First cycle (Bologna/LMD)' },
  pgd: { label: 'Postgraduate diploma', isced: 7, eqf: 7, obType: 'Diploma', cycle: 'Second cycle' },
  master: { label: "Master's degree", isced: 7, eqf: 7, obType: 'MasterDegree', cycle: 'Second cycle (Bologna/LMD)' },
  doctor: { label: 'Doctoral degree', isced: 8, eqf: 8, obType: 'DoctoralDegree', cycle: 'Third cycle (Bologna/LMD)' },
  certificate: { label: 'Certificate', isced: 5, eqf: 5, obType: 'Certificate', cycle: 'Short cycle' },
};
// National qualifications frameworks with a WELL-ESTABLISHED numbering (others are left blank on purpose)
const NATIONAL_QF = {
  GB: { name: 'FHEQ (England, Wales & Northern Ireland)', levels: { diploma: 5, hnd: 5, bachelor: 6, honours: 6, pgd: 7, master: 7, doctor: 8 } },
  ZA: { name: 'South African NQF (HEQSF)', levels: { diploma: 6, bachelor: 7, honours: 8, pgd: 8, master: 9, doctor: 10 } },
  AU: { name: 'Australian Qualifications Framework (AQF)', levels: { diploma: 5, associate: 6, bachelor: 7, honours: 8, pgd: 8, master: 9, doctor: 10 } },
};
function awardInfo(award, country) {
  const a = AWARDS[award] || AWARDS.bachelor;
  const nq = NATIONAL_QF[String(country || '').toUpperCase()];
  return Object.assign({ key: AWARDS[award] ? award : 'bachelor' }, a, { iscedLabel: ISCED_LEVELS[a.isced] || '', national: nq && nq.levels[award] != null ? { framework: nq.name, level: nq.levels[award] } : null });
}
/** The customary degree TITLE for a field under a standard's conventions (editable by the institution). */
function defaultTitle(award, field, standardId) {
  const f = String(field || '').trim();
  const broad = iscedFieldFor(f);
  const c = broad ? broad.code : '';
  if (award === 'licence' || /^lmd/.test(String(standardId || ''))) return `Licence en ${f}`;
  if (award === 'master') return /^lmd/.test(String(standardId || '')) ? `Master en ${f}` : `Master of Science in ${f}`;
  if (award === 'doctor') return `Doctor of Philosophy in ${f}`;
  if (award === 'hnd') return `Higher National Diploma in ${f}`;
  if (award === 'diploma') return `National Diploma in ${f}`;
  if (c === '0421') return 'Bachelor of Laws (LL.B.)';
  if (c === '0912') return 'Bachelor of Medicine, Bachelor of Surgery (MBBS)';
  if (c === '0913') return 'Bachelor of Nursing Science (B.N.Sc.)';
  if (c === '0916') return 'Bachelor of Pharmacy (B.Pharm.)';
  if (/^07/.test(c)) return `Bachelor of Engineering (B.Eng.) in ${f}`;
  if (/^01/.test(c)) return `Bachelor of Education (B.Ed.) in ${f}`;
  if (/^08/.test(c)) return `Bachelor of Agriculture (B.Agric.) in ${f}`;
  if (/^02/.test(c)) return `Bachelor of Arts (B.A.) in ${f}`;
  return `Bachelor of Science (B.Sc.) in ${f}`;
}

// ---------------------------------------------------------------------------------------------------
// SECTION 8 — the national higher-education system (factual starting text; institutions may replace)
// ---------------------------------------------------------------------------------------------------
const NATIONAL_SYSTEM = {
  NG: 'University education in Nigeria is regulated by the National Universities Commission (NUC); polytechnic education by the National Board for Technical Education (NBTE). Universities award first degrees after four to five years of full-time study (six for medicine), classified First Class, Second Class (Upper or Lower Division), Third Class or Pass on a cumulative grade point average; polytechnics award the National Diploma (ND) and the Higher National Diploma (HND).',
  GH: 'Tertiary education in Ghana is regulated by the Ghana Tertiary Education Commission (GTEC). Bachelor\'s degrees normally require four years of full-time study; the class of degree is determined by the final grade point average.',
  BJ: 'Higher education follows the Licence–Master–Doctorat (LMD) system adopted by the member states of CAMES (Conseil Africain et Malgache pour l\'Enseignement Supérieur). A Licence requires 180 credits over six semesters, a Master a further 120 credits, and a Doctorate normally three further years. A teaching unit is validated at 10/20; a semester may be validated by compensation when its average is at least 10/20.',
  GB: 'Higher education qualifications in England, Wales and Northern Ireland are described by the Framework for Higher Education Qualifications (FHEQ). A Bachelor\'s degree with honours is at FHEQ level 6 and normally requires 360 credits; a Master\'s degree is at level 7 and a doctorate at level 8. Degrees are classified First, Upper Second (2:1), Lower Second (2:2) and Third Class.',
  KE: 'University education in Kenya is regulated by the Commission for University Education (CUE). Bachelor\'s degrees normally take four years of full-time study and are classified First Class, Second Class (Upper or Lower Division) and Pass.',
  ZA: 'Higher education qualifications in South Africa are registered on the National Qualifications Framework (NQF) under the Higher Education Qualifications Sub-Framework (HEQSF); quality assurance is the responsibility of the Council on Higher Education (CHE). A Bachelor\'s degree is at NQF level 7, an Honours degree at level 8, a Master\'s degree at level 9 and a doctorate at level 10.',
  US: 'There is no federal ministry that accredits institutions in the United States; quality is assured by accrediting agencies recognized by the U.S. Department of Education or the Council for Higher Education Accreditation (CHEA). A bachelor\'s degree normally requires about 120 semester credit hours (four years of full-time study).',
  IN: 'Higher education in India is regulated by the University Grants Commission (UGC); many universities follow the Choice Based Credit System (CBCS) with a 10-point grade scale, reporting a Semester Grade Point Average (SGPA) and a Cumulative Grade Point Average (CGPA).',
  AU: 'Qualifications in Australia are defined by the Australian Qualifications Framework (AQF); higher-education providers are regulated by the Tertiary Education Quality and Standards Agency (TEQSA). A Bachelor Degree is at AQF level 7, a Bachelor Honours Degree at level 8, a Master\'s degree at level 9 and a Doctoral Degree at level 10.',
  SA: 'Higher education in Saudi Arabia is overseen by the Ministry of Education; institutional and programme accreditation is provided by the Education and Training Evaluation Commission (ETEC). Grades are reported on a 5.0 (or 4.0) grade point scale.',
};
const COUNTRY_NAMES = { NG: 'Nigeria', GH: 'Ghana', BJ: 'Benin', GB: 'United Kingdom', KE: 'Kenya', ZA: 'South Africa', US: 'United States', IN: 'India', AU: 'Australia', SA: 'Saudi Arabia', TG: 'Togo', SN: 'Senegal', CI: "Côte d'Ivoire", BF: 'Burkina Faso', CM: 'Cameroon' };
const NATIONAL_SYSTEM_FR = {
  BJ: 'L’enseignement supérieur suit le système Licence–Master–Doctorat (LMD) adopté par les États membres du CAMES (Conseil Africain et Malgache pour l’Enseignement Supérieur). La Licence requiert 180 crédits répartis sur six semestres, le Master 120 crédits supplémentaires et le Doctorat, en règle générale, trois années supplémentaires. Une unité d’enseignement est validée à 10/20 ; un semestre peut être validé par compensation lorsque sa moyenne est d’au moins 10/20.',
};
const CAMES = ['TG', 'SN', 'CI', 'BF', 'ML', 'NE', 'CM', 'GA', 'CG', 'TD', 'MG', 'CF', 'GN', 'RW', 'BI', 'CD'];
/** Section 8 text for a country; French where a French text exists, else the English one. */
function nationalSystem(country, lang) {
  const c = String(country || '').toUpperCase(); const k = NATIONAL_SYSTEM[c] ? c : (CAMES.includes(c) ? 'BJ' : '');
  return (lang === 'fr' && NATIONAL_SYSTEM_FR[k]) || NATIONAL_SYSTEM[k] || '';
}
const COUNTRY_NAMES_FR = { NG: 'Nigeria', GH: 'Ghana', BJ: 'Bénin', GB: 'Royaume-Uni', KE: 'Kenya', ZA: 'Afrique du Sud', US: 'États-Unis', IN: 'Inde', AU: 'Australie', SA: 'Arabie saoudite', TG: 'Togo', SN: 'Sénégal', CI: 'Côte d’Ivoire', BF: 'Burkina Faso', CM: 'Cameroun' };
const AWARD_LABELS_FR = { diploma: 'Diplôme de l’enseignement supérieur de cycle court', associate: 'Diplôme de cycle court (associate degree)', hnd: 'Higher National Diploma (HND)', bachelor: 'Licence (bachelor’s degree)', honours: 'Licence avec honours (bachelor’s degree with honours)', licence: 'Licence (LMD)', pgd: 'Diplôme d’études supérieures (postgraduate diploma)', master: 'Master', doctor: 'Doctorat', certificate: 'Certificat' };
const CYCLES_FR = { 'Short cycle': 'Cycle court', 'First cycle': 'Premier cycle', 'First cycle (Bologna)': 'Premier cycle (Bologne)', 'First cycle (Bologna/LMD)': 'Premier cycle (Bologne/LMD)', 'Second cycle': 'Deuxième cycle', 'Second cycle (Bologna/LMD)': 'Deuxième cycle (Bologne/LMD)', 'Third cycle (Bologna/LMD)': 'Troisième cycle (Bologne/LMD)' };
const LANGUAGES_FR = { english: 'Anglais', french: 'Français', arabic: 'Arabe', spanish: 'Espagnol', portuguese: 'Portugais', german: 'Allemand', hausa: 'Haoussa', yoruba: 'Yoruba', igbo: 'Igbo', swahili: 'Swahili' };
const LANGUAGES_EN = { francais: 'French', anglais: 'English', arabe: 'Arabic', espagnol: 'Spanish', portugais: 'Portuguese', allemand: 'German', haoussa: 'Hausa' };
const countryName = (c, lang) => { const k = String(c || '').toUpperCase(); return (lang === 'fr' && COUNTRY_NAMES_FR[k]) || COUNTRY_NAMES[k] || k; };
const iscedLevelName = (n, lang) => (lang === 'fr' ? ISCED_LEVELS_FR : ISCED_LEVELS)[n] || '';
const awardName = (award, lang) => (lang === 'fr' && AWARD_LABELS_FR[award]) || (AWARDS[award] || AWARDS.bachelor).label;
const cycleName = (cycle, lang) => (lang === 'fr' && CYCLES_FR[cycle]) || cycle || '';
/** "English, French" → "Anglais, Français" (and back); unknown names pass through unchanged. */
function languageNames(list, lang) {
  const map = lang === 'fr' ? LANGUAGES_FR : LANGUAGES_EN;
  return String(list || '').split(/(\s*[,/;&]\s*|\s+(?:and|et)\s+)/).map(t => (/^(and|et)$/.test(fold(t)) ? (lang === 'fr' ? ' et ' : ' and ') : map[fold(t)] || t)).join('');
}

module.exports = { ISCED_BROAD, ISCED_F, ISCED_LEVELS, ISCED_LEVELS_FR, AWARDS, NATIONAL_QF, COUNTRY_NAMES, iscedFieldFor, iscedLabel, iscedList, awardInfo, defaultTitle, nationalSystem, fold,
  countryName, iscedLevelName, awardName, cycleName, languageNames };
