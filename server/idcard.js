'use strict';
/**
 * 🪪 ID CARDS — ONE renderer for every identity card the university issues (students, staff, lecturers), shared by the
 * desktop (print), the portal (the soft copy, the verification page) and the app. Pure: rows in, SVG / text out.
 *
 *  DESIGN   the look, as data: colours, the institution's lines, the flag, logo / seal / signature images, which fields
 *           show, the two languages of the labels (en · fr · es · pt · ar · sw · ha). The built-in design mirrors the
 *           university's own card (front + back, CR80 85.6 × 53.98 mm); an uploaded template is read into the same shape.
 *  RENDER   renderFront / renderBack → a self-contained SVG on a 2022 × 1275 grid (600 dpi CR80) that prints crisp at any
 *           size; cardHtml() lays cards out for a CR80 card printer (front page, back page) or an A4 sheet with crop marks.
 *  SECURITY what makes a forgery visible —
 *           • a card SERIAL with a check character; a 6-character SECURITY CODE printed only on the physical card;
 *           • FRONT QR = the online check (a signed link → live status, photo, the genuine card side by side);
 *           • BACK QR = an OFFLINE credential: the holder's essentials SIGNED with the university's Ed25519 key — any desk or
 *             phone verifies it with no network; the signature also binds the PHOTO (a hash of the photo on record);
 *           • personalised MICROTEXT (the holder's number and the serial, repeated), a guilloche ROSETTE seeded by the serial
 *             (no two cards share it), a GHOST copy of the photo, a Code 128 barcode of the serial.
 *  SECURITY v2 (security model of ICAO 9303 part 13 "visible digital seals" + the overt / covert layers of card-printer vendors):
 *           • every PRINT is numbered: the print number is SIGNED into the back QR (UB2), the front link and the security code,
 *             so an earlier print kept back, or a photocopy of one, is recognised as a DUPLICATE the moment a reprint exists;
 *           • ONE SESSION: a card is valid for the session it was issued (and paid) for and expires when that session ends —
 *             a SESSION COLOUR tab (a different colour every year) lets a guard see an old card at a glance;
 *           • a VOID PANTOGRAPH: the background tint hides the word COPY in coarse dots among fine ones — invisible on the card,
 *             it appears on a photocopy or a scan-and-reprint;
 *           • MICROTEXT round the photo (name · number · serial · session) and fine lines CROSSING the photo (a pasted photo
 *             breaks them);
 *           • CLONE detection from the scan log (one card checked in to two exams at once), a signed STATUS LIST so a phone
 *             offline still knows the lost, stolen and reprinted cards; the fee state is derived from the money (feeState).
 *  DATA     studentData / staffData turn the record into what is printed — always from the live record, so the card can
 *           never say something the record does not; dataHash() fingerprints it (a changed record → "reprint").
 */
const crypto = require('crypto');
let QR = null; try { QR = require('./qrcode'); } catch (_) { QR = null; }
let BC = null; try { BC = require('./barcode'); } catch (_) { BC = null; }
let NFC = null; try { NFC = require('./nfcsun'); } catch (_) { NFC = null; }   // 📶 NTAG 424 DNA secure taps

const W = 2022, H = 1275, BL = 71;                    // the CR80 grid at 600 dpi, and a 3 mm bleed
const HEADER = 276, FOOTER = 1082, FOOT_END = 1232;
// the student photo circle (front): centre + outer ring radius — the photo, its rings, the microtext and the lines follow it
const PHX = 1570, PHY = 650, PHR = 266;
const KINDS = { student: { code: 'S' }, staff: { code: 'T' }, lecturer: { code: 'L' } };
const KIND_OF = { S: 'student', T: 'staff', L: 'lecturer' };
const LANG_CODES = ['en', 'fr', 'es', 'pt', 'ar', 'sw', 'ha'];

// ───────────────────────────────────────────────────────────────────────────── labels, in seven languages
const L = {
  title_student: ['STUDENT IDENTIFICATION CARD', "CARTE D'ÉTUDIANT", 'CARNÉ DE ESTUDIANTE', 'CARTÃO DE ESTUDANTE', 'بطاقة هوية الطالب', 'KITAMBULISHO CHA MWANAFUNZI', 'KATIN SHAIDAR DALIBI'],
  title_staff: ['STAFF IDENTITY CARD', 'CARTE PROFESSIONNELLE', 'CARNÉ DE PERSONAL', 'CARTÃO DE FUNCIONÁRIO', 'بطاقة هوية الموظف', 'KITAMBULISHO CHA MFANYAKAZI', "KATIN SHAIDAR MA'AIKACI"],
  title_lecturer: ['LECTURER IDENTITY CARD', "CARTE D'ENSEIGNANT", 'CARNÉ DE DOCENTE', 'CARTÃO DE DOCENTE', 'بطاقة هوية المحاضر', 'KITAMBULISHO CHA MHADHIRI', 'KATIN SHAIDAR MALAMI'],
  short_student: ['STUDENT ID CARD', "CARTE D'ÉTUDIANT", 'CARNÉ ESTUDIANTIL', 'CARTÃO DE ESTUDANTE', 'بطاقة الطالب', 'KITAMBULISHO CHA MWANAFUNZI', 'KATIN DALIBI'],
  short_staff: ['STAFF ID CARD', 'CARTE PROFESSIONNELLE', 'CARNÉ DE PERSONAL', 'CARTÃO DE FUNCIONÁRIO', 'بطاقة الموظف', 'KITAMBULISHO CHA MFANYAKAZI', "KATIN MA'AIKACI"],
  short_lecturer: ['LECTURER ID CARD', "CARTE D'ENSEIGNANT", 'CARNÉ DE DOCENTE', 'CARTÃO DE DOCENTE', 'بطاقة المحاضر', 'KITAMBULISHO CHA MHADHIRI', 'KATIN MALAMI'],
  back_side: ['BACK SIDE', 'VERSO', 'REVERSO', 'VERSO', 'الوجه الخلفي', 'UPANDE WA NYUMA', 'BAYA'],
  surname: ['SURNAME', 'NOM', 'APELLIDOS', 'APELIDO', 'اللقب', 'JINA LA UKOO', 'SUNAN IYALI'],
  other_names: ['OTHER NAMES', 'AUTRES NOMS', 'NOMBRES', 'NOMES', 'الأسماء الأخرى', 'MAJINA MENGINE', 'SAURAN SUNAYE'],
  course: ['COURSE', 'FILIÈRE', 'CARRERA', 'CURSO', 'التخصص', 'KOZI', 'KWAS'],
  level: ['LEVEL', "NIVEAU D'ÉTUDE", 'NIVEL', 'NÍVEL', 'المستوى', 'NGAZI', 'MATAKI'],
  matric: ['MATRIC NO.', 'NO MATRICULE', 'N.º DE MATRÍCULA', 'N.º DE MATRÍCULA', 'رقم القيد', 'NAMBA YA USAJILI', 'LAMBAR RAJISTA'],
  session: ['SESSION', 'ANNÉE', 'CURSO ACADÉMICO', 'ANO LETIVO', 'العام الدراسي', 'MWAKA WA MASOMO', 'ZANGO'],
  staff_no: ['STAFF NO.', 'MATRICULE', 'N.º DE EMPLEADO', 'N.º DE FUNCIONÁRIO', 'الرقم الوظيفي', 'NAMBA YA MFANYAKAZI', "LAMBAR MA'AIKACI"],
  position: ['POSITION', 'FONCTION', 'CARGO', 'CARGO', 'الوظيفة', 'CHEO', 'MUKAMI'],
  rank: ['RANK', 'GRADE', 'CATEGORÍA', 'CATEGORIA', 'الرتبة', 'CHEO', 'MATSAYI'],
  department: ['DEPARTMENT', 'DÉPARTEMENT', 'DEPARTAMENTO', 'DEPARTAMENTO', 'القسم', 'IDARA', 'SASHE'],
  since: ['SINCE', 'DEPUIS', 'DESDE', 'DESDE', 'منذ', 'TANGU', 'TUN'],
  photo_student: ['STUDENT PHOTO', 'PHOTO ÉTUDIANT', 'FOTO DEL ESTUDIANTE', 'FOTO DO ESTUDANTE', 'صورة الطالب', 'PICHA YA MWANAFUNZI', 'HOTON DALIBI'],
  photo: ['PHOTO', 'PHOTO', 'FOTO', 'FOTO', 'الصورة', 'PICHA', 'HOTO'],
  verify: ['VERIFY', 'VÉRIFIER', 'VERIFICAR', 'VERIFICAR', 'تحقق', 'THIBITISHA', 'TABBATAR'],
  issued: ['ISSUED', 'ÉMISE', 'EMITIDO', 'EMITIDO', 'الإصدار', 'IMETOLEWA', 'AN BAYAR'],
  valid_through: ['VALID THROUGH', "VALABLE JUSQU'AU", 'VÁLIDO HASTA', 'VÁLIDO ATÉ', 'صالحة حتى', 'INATUMIKA HADI', 'YANA AIKI HAR'],
  property: ['This card is the property of', 'Cette carte est la propriété de', 'Este carné es propiedad de', 'Este cartão é propriedade de', 'هذه البطاقة ملك لـ', 'Kitambulisho hiki ni mali ya', 'Wannan kati mallakar'],
  if_found: ['If found, please return to the above address.', "Si vous la trouvez, veuillez la retourner à l'adresse ci-dessus.", 'Si lo encuentra, devuélvalo a la dirección indicada.', 'Se encontrado, devolva-o ao endereço acima.', 'إذا وجدتها، يرجى إعادتها إلى العنوان أعلاه.', 'Ukikiokota, tafadhali kirudishe kwenye anwani iliyo hapo juu.', 'Idan kun tsinta, ku mayar da ita adireshin da ke sama.'],
  property_line: ['THIS CARD IS THE PROPERTY OF', 'CETTE CARTE EST LA PROPRIÉTÉ DE', 'ESTE CARNÉ ES PROPIEDAD DE', 'ESTE CARTÃO É PROPRIEDADE DE', 'هذه البطاقة ملك لـ', 'KITAMBULISHO HIKI NI MALI YA', 'WANNAN KATI MALLAKAR'],
  barcode: ['BARCODE', 'CODE-BARRES', 'CÓDIGO DE BARRAS', 'CÓDIGO DE BARRAS', 'الرمز الشريطي', 'MSIMBO PAU', 'LAMBAR BARCODE'],
  qr: ['QR CODE', 'CODE QR', 'CÓDIGO QR', 'CÓDIGO QR', 'رمز QR', 'MSIMBO QR', 'LAMBAR QR'],
  verify_auth: ['Verify Authenticity', "Vérifier l'authenticité", 'Verificar autenticidad', 'Verificar autenticidade', 'التحقق من الأصالة', 'Thibitisha uhalali', 'Tabbatar da sahihanci'],
  scan_line: ['Scan to verify — works even offline', 'Scannez pour vérifier — même hors ligne', 'Escanee para verificar — incluso sin conexión', 'Digitalize para verificar — mesmo offline', 'امسح للتحقق — حتى دون اتصال', 'Changanua kuthibitisha — hata bila mtandao', 'Duba don tabbatarwa — ko babu intanet'],
  holder_signature: ["HOLDER'S SIGNATURE", 'SIGNATURE DU TITULAIRE', 'FIRMA DEL TITULAR', 'ASSINATURA DO TITULAR', 'توقيع حامل البطاقة', 'SAHIHI YA MWENYE KITAMBULISHO', 'SA HANNUN MAI KATI'],
  identity: ['IDENTITY', 'IDENTITÉ', 'IDENTIDAD', 'IDENTIDADE', 'الهوية', 'UTAMBULISHO', 'SHAIDA'],
  name: ['NAME', 'NOM', 'NOMBRE', 'NOME', 'الاسم', 'JINA', 'SUNA'],
  faculty: ['FACULTY', 'FAC', 'FACULTAD', 'FACULDADE', 'الكلية', 'KITIVO', 'TSANGAYA'],
  medical: ['MEDICAL & CONTACT', 'INFORMATIONS MÉDICALES & CONTACT', 'DATOS MÉDICOS Y CONTACTO', 'DADOS MÉDICOS E CONTACTO', 'المعلومات الطبية والاتصال', 'AFYA NA MAWASILIANO', 'LAFIYA DA TUNTUƁA'],
  blood_group: ['BLOOD GROUP', 'GROUPE SANGUIN', 'GRUPO SANGUÍNEO', 'GRUPO SANGUÍNEO', 'فصيلة الدم', 'KUNDI LA DAMU', 'RUKUNIN JINI'],
  emergency: ['EMERGENCY CONTACT', "CONTACT D'URGENCE", 'CONTACTO DE EMERGENCIA', 'CONTACTO DE EMERGÊNCIA', 'جهة الاتصال للطوارئ', 'MAWASILIANO YA DHARURA', 'LAMBAR GAGGAWA'],
  emergency_name: ['EMERGENCY CONTACT NAME', 'NOM DU CONTACT', 'NOMBRE DEL CONTACTO', 'NOME DO CONTACTO', 'اسم جهة الاتصال', 'JINA LA MTU WA DHARURA', 'SUNAN MAI TUNTUƁA'],
  library: ['LIBRARY ACCESS', 'ACCÈS BIBLIOTHÈQUE', 'ACCESO A LA BIBLIOTECA', 'ACESSO À BIBLIOTECA', 'الوصول إلى المكتبة', 'MATUMIZI YA MAKTABA', 'SHIGA LABURARE'],
  library_access: ['Access: Central Library • {unit} library', 'Accès autorisé : Bibliothèque centrale • Bibliothèque {unit}', 'Acceso: Biblioteca central • Biblioteca {unit}', 'Acesso: Biblioteca central • Biblioteca {unit}', 'الدخول: المكتبة المركزية • مكتبة {unit}', 'Ruhusa: Maktaba Kuu • Maktaba ya {unit}', 'Izini: Babban laburare • Laburaren {unit}'],
  library_loan: ['Book loans: max {n} items • {d} days', 'Prêt de livres : max {n} ouvrages • {d} jours', 'Préstamo: máx. {n} libros • {d} días', 'Empréstimo: máx. {n} livros • {d} dias', 'إعارة الكتب: {n} كحد أقصى • {d} يومًا', 'Kuazima vitabu: hadi {n} • siku {d}', 'Aron littattafai: har {n} • kwana {d}'],
  instructions: ['USAGE INSTRUCTIONS', "INSTRUCTIONS D'USAGE", 'INSTRUCCIONES DE USO', 'INSTRUÇÕES DE USO', 'تعليمات الاستخدام', 'MAELEKEZO YA MATUMIZI', 'UMARNIN AMFANI'],
  instr1: ['This card is personal and non-transferable.', 'Cette carte est personnelle et non transférable.', 'Este carné es personal e intransferible.', 'Este cartão é pessoal e intransmissível.', 'هذه البطاقة شخصية وغير قابلة للتحويل.', 'Kitambulisho hiki ni cha binafsi na hakihamishwi.', 'Wannan kati na mutum ɗaya ne, ba a mika shi ga wani.'],
  instr2: ['Must be shown on request to university authorities.', 'Doit être présentée sur demande aux autorités universitaires.', 'Debe presentarse a las autoridades universitarias cuando lo soliciten.', 'Deve ser apresentado às autoridades universitárias quando solicitado.', 'يجب إبرازها عند طلب سلطات الجامعة.', 'Lazima kionyeshwe kwa mamlaka za chuo kikiombwa.', "Dole a nuna shi idan hukumomin jami'a sun bukata."],
  instr3: ['Report a loss immediately to {office}.', 'En cas de perte, signaler immédiatement au {office}.', 'Comunique la pérdida de inmediato a {office}.', 'Comunique a perda de imediato a {office}.', 'أبلغ عن الفقدان فورًا إلى {office}.', 'Ripoti upotevu mara moja kwa {office}.', 'A sanar da ɓacewa nan take ga {office}.'],
  instr4: ['Valid until {date} only.', "Valable jusqu'au {date} uniquement.", 'Válido solo hasta {date}.', 'Válido apenas até {date}.', 'صالحة حتى {date} فقط.', 'Inatumika hadi {date} pekee.', 'Tana aiki har {date} kawai.'],
  card_no: ['CARD NO.', 'N° DE CARTE', 'N.º DE CARNÉ', 'N.º DO CARTÃO', 'رقم البطاقة', 'NAMBA YA KITAMBULISHO', 'LAMBAR KATI'],
  security_code: ['SECURITY CODE', 'CODE DE SÉCURITÉ', 'CÓDIGO DE SEGURIDAD', 'CÓDIGO DE SEGURANÇA', 'رمز الأمان', 'MSIMBO WA USALAMA', 'LAMBAR TSARO'],
  authentic: ['AUTHENTIC', 'AUTHENTIQUE', 'AUTÉNTICO', 'AUTÊNTICO', 'أصلية', 'HALISI', 'INGANTACCE'],
  digital_copy: ['DIGITAL COPY', 'COPIE NUMÉRIQUE', 'COPIA DIGITAL', 'CÓPIA DIGITAL', 'نسخة رقمية', 'NAKALA YA KIDIJITALI', 'KWAFIN DIJITAL'],
  specimen: ['SPECIMEN', 'SPÉCIMEN', 'ESPÉCIMEN', 'ESPÉCIME', 'نموذج', 'SAMPULI', 'SAMFURI'],
  physical_only: ['on the physical card', 'sur la carte physique', 'en el carné físico', 'no cartão físico', 'على البطاقة المادية', 'kwenye kitambulisho halisi', 'a kan ainihin kati'],
  void_word: ['COPY', 'COPIE', 'COPIA', 'CÓPIA', 'نسخة', 'NAKALA', 'KWAFI'],
  print_no: ['PRINT', 'TIRAGE', 'IMPRESIÓN', 'IMPRESSÃO', 'الطبعة', 'CHAPA', 'BUGU'],
  instr_session: ['Valid for the {s} session only — it expires on {date}.', "Valable uniquement pour l'année {s} — expire le {date}.", 'Válido solo para el curso {s}; caduca el {date}.', 'Válido apenas para o ano letivo {s}; expira em {date}.', 'صالحة للعام الدراسي {s} فقط — تنتهي في {date}.', 'Inatumika kwa mwaka wa masomo {s} pekee — inaisha {date}.', 'Tana aiki ne a zangon {s} kawai — za ta ƙare {date}.'],
};
const li = (lang) => Math.max(0, LANG_CODES.indexOf(lang));
const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : ''));
/** A label's text in one language: the design's own table for a CUSTOM language (added in the studio — AI-translated or typed),
 *  else the built-in seven (en · fr · es · pt · ar · sw · ha); a word missing in a custom table falls back to English. */
function labelText(design, key, code) {
  const ed = design && design.label_edits && design.label_edits[code];
  if (ed && typeof ed[key] === 'string' && ed[key].trim()) return ed[key];
  const cl = design && design.custom_labels && design.custom_labels[code];
  if (cl && typeof cl[key] === 'string' && cl[key].trim()) return cl[key];
  const row = L[key]; if (!row) return key; const i = LANG_CODES.indexOf(code); return row[i >= 0 ? i : 0];
}
/** A label in the design's language(s): one, or "PRIMARY / SECOND" (sep ' • ' for headings). */
function label(design, key, vars, sep) {
  if (!L[key]) return key;
  const langs = (design && design.langs) || ['en'];
  const a = fill(labelText(design, key, langs[0]), vars), b = langs[1] && langs[1] !== langs[0] ? fill(labelText(design, key, langs[1]), vars) : '';
  return b && b !== a ? a + (sep || ' / ') + b : a;
}
const one = (design, key, vars, i) => fill(labelText(design, key, ((design && design.langs) || ['en'])[i || 0] || 'en'), vars);

// ───────────────────────────────────────────────────────────────────────────── designs
const PALETTES = {
  student: { navy: '#0E2048', navyDeep: '#091631', navyLift: '#1B3170' },
  staff: { navy: '#0B3B2E', navyDeep: '#06241C', navyLift: '#145A45' },
  lecturer: { navy: '#4A0F1E', navyDeep: '#2C0811', navyLift: '#6E1A2E' },
};
function defaultDesign(kind, inst) {
  const k = KINDS[kind] ? kind : 'student'; const i = inst || {}; const p = PALETTES[k];
  const name = String(i.name || 'University').toUpperCase();
  return {
    id: 'builtin-' + k, name: 'Classic bilingual — ' + k, kind: k, source: 'builtin', langs: ['en', 'fr'],
    colors: { navy: p.navy, navyDeep: p.navyDeep, navyLift: p.navyLift, gold: '#C9A55A', goldText: '#E6CE8D', goldTitle: '#DDBB6C', goldCaption: '#AE8742', micro: '#B19455',
      ink: '#0D1A42', label: '#1C2B58', value: '#0B1534', muted: '#5B6683', foot: '#E4E8F2', paper: '#FFFFFF', swoosh: '#6FAA45', seal: '#B3262C' },
    stripe: ['#008751', '#FCD116', '#E8112D'],
    flag: { code: 'bj', image: null, caption: 'BENIN • BJ' },
    texts: { name, name2: String(i.name2 || i.motto || '').toUpperCase(), address: String(i.address || ''), seal_top: name, seal_bottom: String(i.city_line || 'COTONOU BENIN').toUpperCase(),
      seal_lines: k === 'student' ? 'The Office of\nThe Director\nStudents Affairs' : 'The Office of\nThe Registrar\nHuman Resources', seal_office: k === 'student' ? 'Admission' : 'Personnel',
      office: k === 'student' ? 'Students Affairs office' : 'Human Resources office', director_title: '', director_name: '', director_phone: '' },
    images: { logo: null, seal: null, signature: null },
    show: { blood: true, emergency: true, library: true, signature: true, ghost: true, micro: true, rosette: true, flag: true, csc: true, swoosh: true, pantograph: true, session_tab: true, photo_lines: true, holo: true, guilloche: true, ir: true },
    // ONE SESSION: every card is valid for the session it was issued for (staff / lecturer designs may switch to N months)
    validity: { mode: 'session', months: k === 'student' ? 12 : 24 },
  };
}
/** The security layers every card carries — locked on, whatever the design or the uploaded template says. */
const SECURITY_LOCKED = ['micro', 'rosette', 'ghost', 'csc', 'pantograph', 'session_tab', 'photo_lines', 'holo', 'guilloche', 'ir'];
/** The security features of a card, in layers (overt · covert · machine · physical) — what the desk lists, what the verifier checks.
 *  `needs` = what it takes beyond a standard dye-sublimation card printer. */
const SECURITY_FEATURES = [
  { k: 'guilloche', layer: 'overt', name: 'Guilloche rosette + ribbons', note: 'fine interlaced line patterns seeded by the serial — no two cards share them; a copier blurs them' },
  { k: 'holo', layer: 'overt', name: 'Holographic OVD medallion', note: 'an iridescent medallion overlapping the photo (a pasted photo breaks it); it moves on the live digital card. A holographic laminate adds the real optical hologram', needs: 'holographic laminate for a true hologram' },
  { k: 'ovi', layer: 'overt', name: 'Colour-shifting session tab', note: 'a different colour every session, with a colour-shift band — an old card shows at a glance' },
  { k: 'micro', layer: 'overt', name: 'Microtext', note: 'under the header, round the photo, along the rules — the holder’s name, number and the serial; a solid line to the eye' },
  { k: 'photo_lines', layer: 'overt', name: 'Lines across the photo', note: 'fine lines run from the card across the photo — a replaced photo breaks them' },
  { k: 'ghost', layer: 'overt', name: 'Ghost images', note: 'two smaller translucent copies of the photo (front and back)' },
  { k: 'pantograph', layer: 'covert', name: 'Void pantograph (anti-copy)', note: 'the background hides the word COPY: invisible on the card, it appears on a photocopy or scan-and-reprint' },
  { k: 'uv', layer: 'covert', name: 'UV fluorescent layer', note: 'the seal, the number and the session glow under a UV lamp', needs: 'a printer with a UV (F) panel' },
  { k: 'ir', layer: 'covert', name: 'Infrared-only text', note: 'the serial in carbon black over the dark footer: faint to the eye, sharp under an infrared camera', needs: 'black (K) panel used for pure black' },
  { k: 'qr', layer: 'machine', name: 'Signed QR codes (visible digital seal)', note: 'Ed25519 signature over the holder’s data, the print number and the session — checked offline' },
  { k: 'barcode', layer: 'machine', name: 'Code 128 barcode', note: 'the serial, for any barcode scanner' },
  { k: 'csc', layer: 'machine', name: 'Security code per print', note: '6 characters bound to the print — printed on the card only' },
  { k: 'chip', layer: 'machine', name: 'Contactless chip', note: 'the chip’s UID is bound to the card and a signed credential is written on it — a copied chip has another UID', needs: 'NFC / MIFARE card stock' },
  { k: 'mag', layer: 'machine', name: 'Magnetic stripe', note: 'track 1 carries the serial, the print and a keyed check — a swipe verifies it', needs: 'card stock with a stripe + a printer encoder' },
  { k: 'laser', layer: 'physical', name: 'Laser engraving + clear window', note: 'the personal data and photo engraved into polycarbonate (tactile), a window image', needs: 'polycarbonate cards + a laser engraver' },
  { k: 'substrate', layer: 'physical', name: 'Card body', note: 'PVC, composite or polycarbonate (delaminates if tampered with) — recorded on every print', needs: 'the card stock chosen' },
];
const HEX = /^#[0-9a-fA-F]{6}$/;
const IMG = /^(data:image\/(png|jpe?g|webp|svg\+xml);base64,[A-Za-z0-9+/=]+|https?:\/\/[^\s"'<>]+)$/;   // a data URL, or a web address (the portal's branding)
/** A design made safe to render (unknown keys dropped, colours / images / languages checked). */
function normalizeDesign(d, kind, inst) {
  const base = defaultDesign((d && d.kind) || kind, inst); const x = d || {};
  const out = Object.assign({}, base, { id: String(x.id || base.id).slice(0, 80), name: String(x.name || base.name).slice(0, 120), source: ['builtin', 'scan', 'manual'].includes(x.source) ? x.source : base.source });
  out.custom_labels = {}; out.custom_names = {};
  if (x.custom_labels && typeof x.custom_labels === 'object') for (const [code0, tbl] of Object.entries(x.custom_labels)) {
    const code = String(code0).toLowerCase(); if (!/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(code) || LANG_CODES.includes(code) || !tbl || typeof tbl !== 'object') continue;
    const t = {}; for (const kk of Object.keys(L)) if (typeof tbl[kk] === 'string' && tbl[kk].trim()) t[kk] = tbl[kk].slice(0, 220);
    if (Object.keys(t).length) { out.custom_labels[code] = t; out.custom_names[code] = String((x.custom_names && x.custom_names[code]) || code).slice(0, 40); }
  }
  out.langs = (Array.isArray(x.langs) ? x.langs : base.langs).filter(l => LANG_CODES.includes(l) || out.custom_labels[l]).slice(0, 2); if (!out.langs.length) out.langs = ['en'];
  // ✏️ the wording edited in the studio (any built-in or added language): { code: { key: text } }
  out.label_edits = {}; if (x.label_edits && typeof x.label_edits === 'object') for (const [code0, tbl] of Object.entries(x.label_edits)) {
    const code = String(code0).toLowerCase(); if (!(LANG_CODES.includes(code) || out.custom_labels[code]) || !tbl || typeof tbl !== 'object') continue;
    const t = {}; for (const kk of Object.keys(L)) if (typeof tbl[kk] === 'string' && tbl[kk].trim()) t[kk] = tbl[kk].slice(0, 220); if (Object.keys(t).length) out.label_edits[code] = t;
  }
  // 🖼 an IMAGE template: the uploaded artwork is the card, the fields placed on it (landscape or portrait)
  out.mode = x.mode === 'image' ? 'image' : 'classic'; out.orientation = x.orientation === 'portrait' ? 'portrait' : 'landscape';
  out.bg = { front: null, back: null }; for (const sd of ['front', 'back']) { const v = x.bg && x.bg[sd]; out.bg[sd] = IMG.test(String(v || '')) && String(v).length < 6000000 ? v : null; }
  out.fields = out.mode === 'image' ? normalizeFields(x.fields, out.orientation, out.kind) : [];
  // 🧽 NO BACKGROUND PICTURES by default: the uploaded card is the TEMPLATE (its layout, colours, logo), not a picture printed under
  // the data — a photographed sample card carries someone else's details and its own paper. bg_show = print it anyway (a blank artwork).
  out.bg_show = x.bg_show === true; out.images_clean = !!x.images_clean;
  out.colors = Object.assign({}, base.colors); for (const k of Object.keys(base.colors)) if (x.colors && HEX.test(String(x.colors[k] || ''))) out.colors[k] = x.colors[k];
  out.stripe = Array.isArray(x.stripe) && x.stripe.length && x.stripe.every(c => HEX.test(c)) ? x.stripe.slice(0, 4) : base.stripe;
  const f = x.flag || {}; out.flag = { code: FLAGS[f.code] || f.code === 'none' ? f.code : base.flag.code, image: IMG.test(String(f.image || '')) && String(f.image).length < 1600000 ? f.image : null, caption: String(f.caption == null ? base.flag.caption : f.caption).slice(0, 40) };
  out.texts = Object.assign({}, base.texts); for (const k of Object.keys(base.texts)) if (x.texts && typeof x.texts[k] === 'string') out.texts[k] = x.texts[k].slice(0, k === 'address' ? 220 : 140);
  out.images = {}; for (const k of ['logo', 'seal', 'signature']) { const v = x.images && x.images[k]; out.images[k] = IMG.test(String(v || '')) && String(v).length < 1600000 ? v : null; }
  out.show = Object.assign({}, base.show); for (const k of Object.keys(base.show)) if (x.show && typeof x.show[k] === 'boolean') out.show[k] = x.show[k];
  const v = x.validity || {}; out.validity = { mode: v.mode === 'months' || v.mode === 'session' ? v.mode : base.validity.mode, months: Math.max(1, Math.min(72, Math.round(Number(v.months) || base.validity.months))) };
  if (out.kind === 'student') out.validity.mode = 'session';   // a student card is ALWAYS valid for one session — the one paid for
  out.pantograph = [1, 2, 3].includes(Number(x.pantograph)) ? Number(x.pantograph) : 1;   // the hidden-COPY strength (1 light … 3 strong) — tune it with a test photocopy
  // the SECURITY LAYERS are part of every card, whatever template it was made from — a design cannot switch them off
  for (const k of SECURITY_LOCKED) out.show[k] = true;
  return out;
}

// ───────────────────────────────────────────────────────────────────────────── svg helpers
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r1 = (n) => Math.round(n * 10) / 10;
function rng(seed) { let s = seed | 0; return () => { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const seedOf = (str) => crypto.createHash('sha256').update(String(str || '')).digest().readInt32BE(0);
const FONT = { M: 'fm', O: 'fo', B: 'fb' };
const WIDTH = { M: { up: 0.72, lo: 0.58, dg: 0.66 }, O: { up: 0.48, lo: 0.41, dg: 0.49 }, B: { up: 0.54, lo: 0.46, dg: 0.51 } };
/** Estimated advance width (slightly generous, so text is shrunk rather than spilling). */
function estWidth(str, font, size, track, weight) {
  const f = WIDTH[font] || WIDTH.M; let w = 0;
  for (const ch of String(str)) {
    if (ch === ' ') w += 0.28; else if (/[.,:;'|!iIlj()\[\]•]/.test(ch)) w += 0.3; else if (/[0-9]/.test(ch)) w += f.dg;
    else if (/[MW@]/.test(ch)) w += f.up * 1.3; else if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) w += f.up; else if (/[؀-ۿ]/.test(ch)) w += 0.5; else w += f.lo;
  }
  const len = [...String(str)].length;
  return (w * size + Math.max(0, len - 1) * (track || 0) / 1000 * size) * (weight && weight < 600 ? 0.96 : 1);
}
/** <text> — lines, anchor, tracking; shrunk to maxW (down to 55 %, then squeezed). */
function T(x, y, str, o) {
  const lines = String(str == null ? '' : str).split('\n'); const font = o.font || 'M';
  let size = o.size; const track = o.track || 0;
  if (o.maxW) { const widest = Math.max(...lines.map(l => estWidth(l, font, size, track, o.weight))); if (widest > o.maxW) size = Math.max(o.size * 0.55, size * o.maxW / widest); }
  const lead = o.leading ? o.leading * size / o.size : size * 1.2;
  const anchor = o.anchor === 'middle' ? 'middle' : o.anchor === 'end' ? 'end' : 'start';
  const squeeze = (l) => { const w = estWidth(l, font, size, track, o.weight); return o.maxW && w > o.maxW * 1.02 ? ` textLength="${r1(o.maxW)}" lengthAdjust="spacingAndGlyphs"` : ''; };
  const ls = track ? ` letter-spacing="${r1(track / 1000 * size)}"` : '';
  // a HALO (o.halo = its colour): a thin contrasting outline painted behind the letters — the text stays readable on any artwork
  const halo = o.halo ? ` stroke="${o.halo}" stroke-width="${r1(Math.max(2, size * 0.16))}" stroke-opacity="0.88" stroke-linejoin="round" paint-order="stroke"` : '';
  const attrs = `class="${FONT[font] || 'fm'}" font-size="${r1(size)}" font-weight="${o.weight || 700}" fill="${o.color || '#000'}" text-anchor="${anchor}"${ls}${o.opacity != null ? ` fill-opacity="${o.opacity}"` : ''}${halo}`;
  if (lines.length === 1) return `<text x="${r1(x)}" y="${r1(y)}" ${attrs}${squeeze(lines[0])}>${esc(lines[0])}</text>`;
  return `<text ${attrs}>` + lines.map((l, i) => `<tspan x="${r1(x)}" y="${r1(y + i * lead)}"${squeeze(l)}>${esc(l)}</tspan>`).join('') + '</text>';
}
/** A value that FITS its place (x, centred on cy, at most maxW wide): one line, the font shrunk down to minSize; still too long → two
 *  lines split at the word break that balances them, shrunk to fit; never wider than its place (squeezed as a last resort). */
function fitText(x, cy, str, o) {
  const t = String(str == null || str === '' ? '—' : str); const font = o.font || 'M'; const wOf = (v, sz) => estWidth(v, font, sz, o.track || 0, o.weight);
  const maxW = o.maxW * 0.97; const size = o.size; const min = o.minSize || size * 0.6; const w1 = wOf(t, size);
  const line = (sz) => T(x, cy + sz * 0.36, t, Object.assign({}, o, { size: sz, maxW: o.maxW }));
  if (w1 <= maxW) return line(size);
  const one = size * maxW / w1;
  if (one >= min || o.lines === 1 || !/\s/.test(t.trim())) return line(Math.max(one, min));
  const words = t.trim().split(/\s+/); let best = null;
  for (let i = 1; i < words.length; i++) { const a = words.slice(0, i).join(' '), b = words.slice(i).join(' '); const m = Math.max(wOf(a, size), wOf(b, size)); if (!best || m < best.m) best = { a, b, m }; }
  const sz = Math.max(min * 0.82, Math.min(size * 0.8, size * maxW / best.m)); const lead = sz * 1.06;
  return T(x, cy - lead / 2 + sz * 0.36, best.a + '\n' + best.b, Object.assign({}, o, { size: sz, leading: lead, maxW: o.maxW }));
}
const rect = (x, y, w, h, fill, extra) => `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" fill="${fill}"${extra || ''}/>`;

/** QR as one compact path inside a box (s × s, quiet zone q). */
function qrSvg(text, x, y, s, q, ec) {
  if (!QR || !text) return '';
  let m; try { m = QR.encode(String(text), ec || 'M'); } catch (_) { try { m = QR.encode(String(text), 'L'); } catch (__) { return ''; } }
  // a QR that scans after ANY print: each module a WHOLE number of card dots (an even number when it can — exact at 300 dpi too),
  // the standard white quiet zone of 4 modules all round, pure black on white, crisp edges
  const n = m.n; const QZ = 4; let cell = Math.floor(s / (n + 2 * QZ)); if (cell < 2) cell = s / (n + 2 * QZ);
  const side = cell * n; const ox = Math.round(x + (s - side) / 2), oy = Math.round(y + (s - side) / 2); let d = '';
  for (let r = 0; r < n; r++) { let c = 0; while (c < n) { if (m.isDark(r, c)) { const c0 = c; while (c < n && m.isDark(r, c)) c++; d += `M${c0} ${r}h${c - c0}v1h-${c - c0}z`; } else c++; } }
  return `<rect x="${r1(ox - QZ * cell)}" y="${r1(oy - QZ * cell)}" width="${r1(side + 2 * QZ * cell)}" height="${r1(side + 2 * QZ * cell)}" fill="#FFFFFF"/><g transform="translate(${ox} ${oy}) scale(${+cell.toFixed(4)})"><path d="${d}" fill="#000" shape-rendering="crispEdges"/></g>`;
}
/** Code 128 bars centred on cx (bar height h): the module (the narrowest bar, X) a WHOLE number of card dots — 6 dots = 0.254 mm at
 *  600 dpi, the GS1 floor — and a white QUIET ZONE of 10 modules on each side (the scanner finds where the code starts). The card
 *  number (cardCode) is 14 digits in set C (two digits a symbol): 112 modules, 28 mm with its quiet zones. */
function barcodeSvg(text, cx, y, h, mod0, maxW) {
  const w = BC && BC.modules ? BC.modules(String(text || '')) : null; if (!w) return '';
  const n = w.reduce((a, b) => a + b, 0); let mod = maxW ? Math.min(mod0, maxW / (n + 20)) : mod0; if (mod >= 2) mod = Math.floor(mod);
  const total = n * mod; let x = Math.round(cx - total / 2); const qz = 10 * mod; let d = '';
  w.forEach((v, i) => { if (i % 2 === 0) d += `M${r1(x)} ${r1(y)}h${r1(v * mod)}v${r1(h)}h-${r1(v * mod)}z`; x += v * mod; });
  return `<rect x="${r1(cx - total / 2 - qz)}" y="${r1(y - 4)}" width="${r1(total + 2 * qz)}" height="${r1(h + 8)}" fill="#FFFFFF"/><path d="${d}" fill="#000" shape-rendering="crispEdges"/>`;
}

// ───────────────────────────────────────────────────────────────────────────── flags (drawn, so they print sharp)
function star(cx, cy, r, fill) { let d = ''; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.4 : r; d += (i ? 'L' : 'M') + r1(cx + rr * Math.cos(a)) + ' ' + r1(cy + rr * Math.sin(a)); } return `<path d="${d}z" fill="${fill}"/>`; }
const V3 = (a, b, c) => (x, y, w, h) => rect(x, y, w / 3, h, a) + rect(x + w / 3, y, w / 3, h, b) + rect(x + 2 * w / 3, y, w / 3 + 0.5, h, c);
const H3 = (a, b, c) => (x, y, w, h) => rect(x, y, w, h / 3, a) + rect(x, y + h / 3, w, h / 3, b) + rect(x, y + 2 * h / 3, w, h / 3 + 0.5, c);
const FLAGS = {
  bj: { colors: ['#008751', '#FCD116', '#E8112D'], draw: (x, y, w, h) => rect(x, y, w * 0.4, h, '#008751') + rect(x + w * 0.4, y, w * 0.6, h / 2, '#FCD116') + rect(x + w * 0.4, y + h / 2, w * 0.6, h / 2, '#E8112D') },
  ng: { colors: ['#008751', '#FFFFFF', '#008751'], draw: V3('#008751', '#FFFFFF', '#008751') },
  gh: { colors: ['#CE1126', '#FCD116', '#006B3F'], draw: (x, y, w, h) => H3('#CE1126', '#FCD116', '#006B3F')(x, y, w, h) + star(x + w / 2, y + h / 2, h * 0.16, '#000') },
  ci: { colors: ['#F77F00', '#FFFFFF', '#009E60'], draw: V3('#F77F00', '#FFFFFF', '#009E60') },
  sn: { colors: ['#00853F', '#FDEF42', '#E31B23'], draw: (x, y, w, h) => V3('#00853F', '#FDEF42', '#E31B23')(x, y, w, h) + star(x + w / 2, y + h / 2, h * 0.16, '#00853F') },
  cm: { colors: ['#007A5E', '#CE1126', '#FCD116'], draw: (x, y, w, h) => V3('#007A5E', '#CE1126', '#FCD116')(x, y, w, h) + star(x + w / 2, y + h / 2, h * 0.16, '#FCD116') },
  ml: { colors: ['#14B53A', '#FCD116', '#CE1126'], draw: V3('#14B53A', '#FCD116', '#CE1126') },
  gn: { colors: ['#CE1126', '#FCD116', '#009460'], draw: V3('#CE1126', '#FCD116', '#009460') },
  fr: { colors: ['#0055A4', '#FFFFFF', '#EF4135'], draw: V3('#0055A4', '#FFFFFF', '#EF4135') },
  bf: { colors: ['#EF2B2D', '#009E49', '#FCD116'], draw: (x, y, w, h) => rect(x, y, w, h / 2, '#EF2B2D') + rect(x, y + h / 2, w, h / 2, '#009E49') + star(x + w / 2, y + h / 2, h * 0.17, '#FCD116') },
  ne: { colors: ['#E05206', '#FFFFFF', '#0DB02B'], draw: (x, y, w, h) => H3('#E05206', '#FFFFFF', '#0DB02B')(x, y, w, h) + `<circle cx="${r1(x + w / 2)}" cy="${r1(y + h / 2)}" r="${r1(h * 0.12)}" fill="#E05206"/>` },
  tg: { colors: ['#006A4E', '#FFCE00', '#D21034'], draw: (x, y, w, h) => { let s = ''; for (let i = 0; i < 5; i++) s += rect(x, y + i * h / 5, w, h / 5 + 0.5, i % 2 ? '#FFCE00' : '#006A4E'); return s + rect(x, y, h * 0.6, h * 0.6, '#D21034') + star(x + h * 0.3, y + h * 0.3, h * 0.18, '#FFFFFF'); } },
  ke: { colors: ['#000000', '#BB0000', '#006600'], draw: (x, y, w, h) => rect(x, y, w, h * 0.3, '#000') + rect(x, y + h * 0.3, w, h * 0.05, '#FFF') + rect(x, y + h * 0.35, w, h * 0.3, '#BB0000') + rect(x, y + h * 0.65, w, h * 0.05, '#FFF') + rect(x, y + h * 0.7, w, h * 0.3, '#006600') },
};
function flagSvg(design, uid) {
  const f = design.flag || {}; if (!design.show.flag || f.code === 'none') return '';
  const x = 1603, y = 46, w = 306, h = 166, c = design.colors;
  const inner = FLAGS[f.code] ? FLAGS[f.code].draw(x, y, w, h) : f.image ? `<image href="${f.image}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>` : '';
  // the flag sits ON the header band — no white plate behind it — framed by a fine gold rule, its caption in gold below it
  return `<g filter="url(#sh${uid})"><g clip-path="url(#flagclip${uid})">${inner}<rect x="${x}" y="${y}" width="${w}" height="${h / 2}" fill="#FFFFFF" fill-opacity="0.10"/></g></g>`
    + `<rect x="${x - 2}" y="${y - 2}" width="${w + 4}" height="${h + 4}" rx="10" fill="none" stroke="url(#gold${uid})" stroke-width="4"/>`
    + (f.caption ? T(1756, 250, f.caption, { font: 'M', size: 27, color: '#E8CF86', anchor: 'middle', track: 70, maxW: 330 }) : '');
}

// ───────────────────────────────────────────────────────────────────────────── art
function defs(design, uid) {
  const c = design.colors;
  return `<defs><style>.fm{font-family:'UB Montserrat',Montserrat,'Segoe UI',Arial,sans-serif}.fo{font-family:'UB Oswald',Oswald,'Arial Narrow',Impact,sans-serif}.fb{font-family:'UB Barlow','Barlow Semi Condensed','Arial Narrow',Arial,sans-serif}</style>`
    + `<linearGradient id="band${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.navyDeep}"/><stop offset="0.55" stop-color="${c.navy}"/><stop offset="1" stop-color="${c.navyDeep}"/></linearGradient>`
    + `<radialGradient id="glow${uid}" cx="0.48" cy="0.45" r="0.45"><stop offset="0" stop-color="#2E488C" stop-opacity="0.38"/><stop offset="1" stop-color="#2E488C" stop-opacity="0"/></radialGradient>`
    + `<linearGradient id="gold${uid}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#9A7631"/><stop offset="0.22" stop-color="#E8CF86"/><stop offset="0.48" stop-color="#B48C3C"/><stop offset="0.74" stop-color="#F3DF9C"/><stop offset="1" stop-color="#A3803A"/></linearGradient>`
    + `<linearGradient id="foot${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.navyLift}"/><stop offset="0.5" stop-color="${c.navy}"/><stop offset="1" stop-color="${c.navyDeep}"/></linearGradient>`
    + `<radialGradient id="seal${uid}" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stop-color="#FBF0C8"/><stop offset="0.45" stop-color="#EBD39A"/><stop offset="0.8" stop-color="#D6B56E"/><stop offset="1" stop-color="#B38F45"/></radialGradient>`
    + `<linearGradient id="fadeL${uid}" gradientUnits="userSpaceOnUse" x1="${-BL}" y1="0" x2="560" y2="0"><stop offset="0" stop-color="#D9BC72" stop-opacity="0.55"/><stop offset="1" stop-color="#D9BC72" stop-opacity="0"/></linearGradient>`
    + `<linearGradient id="fadeR${uid}" gradientUnits="userSpaceOnUse" x1="1380" y1="0" x2="${W + BL}" y2="0"><stop offset="0" stop-color="#D9BC72" stop-opacity="0"/><stop offset="1" stop-color="#D9BC72" stop-opacity="0.55"/></linearGradient>`
    + `<filter id="sh${uid}" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="5" stdDeviation="8" flood-color="#000" flood-opacity="0.4"/></filter>`
    + `<filter id="gray${uid}"><feColorMatrix type="saturate" values="0"/></filter>`
    + `<clipPath id="hdr${uid}"><rect x="${-BL}" y="${-BL}" width="${W + 2 * BL}" height="${HEADER + BL}"/></clipPath>`
    + `<clipPath id="body${uid}"><rect x="${-BL}" y="${HEADER + 14}" width="${W + 2 * BL}" height="${FOOTER - HEADER - 14}"/></clipPath>`
    + `<clipPath id="flagclip${uid}"><rect x="1603" y="46" width="306" height="166" rx="9"/></clipPath>`
    + `<clipPath id="photo${uid}"><circle cx="${PHX}" cy="${PHY}" r="${PHR - 30}"/></clipPath>`
    + `<clipPath id="ghost${uid}"><ellipse cx="930" cy="1000" rx="58" ry="66"/></clipPath></defs>`;
}
function headerArt(design, uid, seed) {
  const c = design.colors;
  let g = `<rect x="${-BL}" y="${-BL}" width="${W + 2 * BL}" height="${HEADER + BL}" fill="url(#band${uid})"/><rect x="${-BL}" y="${-BL}" width="${W + 2 * BL}" height="${HEADER + BL}" fill="url(#glow${uid})"/>`;
  // guilloche: fading wave families from both corners
  const fam = (x0, x1, left, count, base, step, amp, freq, ph) => {
    let d = ''; for (let k = 0; k < count; k++) { let p = ''; for (let x = x0; x <= x1; x += 14) { const y = base + k * step + amp * Math.sin(x * freq + k * ph) + (left ? -1 : 1) * (x - x0) * 0.18; p += (p ? 'L' : 'M') + Math.round(x) + ' ' + Math.round(y); } d += p; }
    return `<path d="${d}" fill="none" stroke="url(#${left ? 'fadeL' : 'fadeR'}${uid})" stroke-width="1.6"/>`;
  };
  g += `<g clip-path="url(#hdr${uid})">` + fam(-BL, 560, true, 26, -130, 15, 34, 0.010, 0.21) + fam(-BL, 520, true, 18, 40, 16, 26, 0.014, -0.17) + fam(1380, W + BL, false, 22, -60, 14, 30, 0.011, 0.19) + fam(1420, W + BL, false, 15, 120, 15, 22, 0.015, -0.23);
  let mesh = ''; for (let k = 0; k < 22; k++) mesh += `M${-BL} ${70 + k * 18}L${420 - k * 6} ${-BL}M${W + BL} ${60 + k * 17}L${W - 470 + k * 8} ${-BL}`;
  g += `<path d="${mesh}" data-art="1" stroke="#E3C77E" stroke-opacity="0.18" stroke-width="1.1" fill="none"/>`;
  const rnd = rng(seed); let dust = '';
  for (let i = 0; i < 140; i++) { const x = 380 + rnd() * 1300, y = rnd() * 70 - 10; dust += `<circle cx="${Math.round(x)}" cy="${Math.round(y)}" r="${r1(0.8 + rnd() * 1.8)}"/>`; }
  g += `<g fill="#F1D990" fill-opacity="0.35">${dust}</g></g>`;
  g += `<rect x="${-BL}" y="${HEADER - 1}" width="${W + 2 * BL}" height="7" fill="url(#gold${uid})"/>`;
  return g;
}
function microLine(y, text, color) {
  const unit = String(text); let s = ''; while (s.length < 420) s += unit;
  return `<text x="${-BL}" y="${y}" class="fm" data-sec="micro" font-size="9.5" font-weight="600" fill="${color}" letter-spacing="0.6">${esc(s.slice(0, 420))}</text>`;
}
function rosette(cx, cy, seed, opacity) {
  const rnd = rng(seed); const ph0 = rnd() * 6.28, nShift = Math.floor(rnd() * 5), aShift = rnd() * 3;
  let a = '', b = '';
  for (let ring = 0; ring < 18; ring++) {
    const R = 90 + ring * 20, amp = 9 + (ring % 4) * 3 + aShift, n = 30 + (ring % 3) * 6 + nShift, ph = ring * 0.37 + ph0;
    let p = ''; for (let i = 0; i <= 180; i++) { const t = i / 180 * Math.PI * 2, rr = R + amp * Math.cos(n * t + ph) + amp * 0.5 * Math.sin((n + 7) * t); p += (i ? 'L' : 'M') + Math.round(cx + rr * Math.cos(t)) + ' ' + Math.round(cy + rr * Math.sin(t) * 0.92); }
    if (ring % 2) a += p + 'z'; else b += p + 'z';
  }
  let w = ''; for (let k = 0; k < 10; k++) { let p = ''; for (let x = -BL; x <= W + BL; x += 16) { const y = 300 + k * 72 + 22 * Math.sin(x * 0.011 + k * 0.8 + ph0) + 10 * Math.sin(x * 0.031 - k); p += (p ? 'L' : 'M') + Math.round(x) + ' ' + Math.round(y); } w += p; }
  return `<g class="ubid-rosette" opacity="${opacity}" fill="none" stroke-width="1.5"><path d="${a}" stroke="#B08C3E"/><path d="${b}" stroke="#5E8F3A"/><path d="${w}" stroke="#7E9A55"/></g>`;
}
function swoosh(p0, p1, p2, p3, seed, color, opacity) {
  const rnd = rng(seed); let s = '';
  for (const [w, a] of [[70, 0.05], [36, 0.07], [16, 0.08]]) s += `<path d="M${p0}C${p1} ${p2} ${p3}" stroke="${color}" stroke-opacity="${a}" stroke-width="${w}" fill="none" stroke-linecap="round"/>`;
  const P0 = p0.split(' ').map(Number), P1 = p1.split(' ').map(Number), P2 = p2.split(' ').map(Number), P3 = p3.split(' ').map(Number);
  for (let i = 0; i < 18; i++) {
    const t = i / 17, off = (t - 0.5) * 90, o2 = (t - 0.5) * 150 + (rnd() - 0.5) * 30; const col = i % 3 === 0 ? '#D6BE72' : (i % 3 === 1 ? color : '#A9D07A');
    s += `<path d="M${r1(P0[0] + off * 0.4)} ${P0[1]}C${r1(P1[0] + off * 0.3)} ${r1(P1[1] + o2 * 0.5)} ${P2[0]} ${r1(P2[1] + o2)} ${P3[0]} ${r1(P3[1] + o2 * 1.4)}" data-art="1" stroke="${col}" stroke-opacity="${r1(0.45 + rnd() * 0.35)}" stroke-width="${r1(1.2 + rnd() * 2.2)}" fill="none"/>`;
  }
  return `<g opacity="${opacity}">${s}</g>`;
}
/** The office seal: gold disc, red rings, the institution's name on the arc, the office in the centre (or an uploaded seal). */
function sealSvg(design, uid, cx, cy, R) {
  const c = design.colors, t = design.texts;
  if (design.images.seal) return `<image href="${design.images.seal}" x="${cx - R}" y="${cy - R}" width="${2 * R}" height="${2 * R}" filter="url(#sh${uid})"/>`;
  const rt = R * 0.72, rb = R * 0.835; const id = 'sa' + uid + Math.round(cx) + Math.round(cy);
  const lines = String(t.seal_lines || '').split('\n').slice(0, 3);
  return `<g><circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#seal${uid})" filter="url(#sh${uid})"/><circle cx="${cx}" cy="${cy}" r="${r1(R * 0.975)}" fill="none" stroke="url(#gold${uid})" stroke-width="${r1(R * 0.05)}"/>`
    + [[0.92, 0.045], [0.865, 0.012], [0.69, 0.028], [0.655, 0.01]].map(([rad, lw]) => `<circle cx="${cx}" cy="${cy}" r="${r1(R * rad)}" fill="none" stroke="${c.seal}" stroke-width="${r1(R * lw)}"/>`).join('')
    + `<path id="${id}t" d="M${r1(cx - rt)} ${cy}A${rt} ${rt} 0 0 1 ${r1(cx + rt)} ${cy}" fill="none"/><path id="${id}b" d="M${r1(cx - rb)} ${cy}A${rb} ${rb} 0 0 0 ${r1(cx + rb)} ${cy}" fill="none"/>`
    + `<text class="fo" font-size="${r1(R * 0.13)}" font-weight="600" fill="${c.seal}" letter-spacing="0.6"><textPath href="#${id}t" startOffset="50%" text-anchor="middle">${esc(String(t.seal_top || '').slice(0, 44))}</textPath></text>`
    + `<text class="fo" font-size="${r1(R * 0.13)}" font-weight="600" fill="${c.seal}" letter-spacing="2"><textPath href="#${id}b" startOffset="50%" text-anchor="middle">${esc(String(t.seal_bottom || '').slice(0, 30))}</textPath></text>`
    + lines.map((l, i) => T(cx, cy - 30 + i * 19, l, { font: 'B', size: 17, weight: 600, color: c.seal, anchor: 'middle', maxW: 116 })).join('')
    + T(cx, cy + 34, t.seal_office || '', { font: 'B', size: 22, weight: 700, color: c.seal, anchor: 'middle', maxW: 112 }) + '</g>';
}
function footerArt(design, uid) {
  const c = design.colors; const st = design.stripe;
  let s = `<rect x="${-BL}" y="${FOOTER}" width="${W + 2 * BL}" height="${FOOT_END - FOOTER}" fill="url(#foot${uid})"/>`;
  let rays = ''; for (let k = 0; k < 30; k++) { const a = -Math.PI / 2 + (k / 29) * Math.PI; rays += `M226 1150L${Math.round(226 + Math.cos(a) * 520)} ${Math.round(1150 + Math.sin(a) * 520)}`; }
  for (let k = 0; k < 24; k++) rays += `M${W + BL} ${FOOTER - 40 + k * 11}L${W - 330 + k * 7} ${FOOT_END + 10}`;
  s += `<g><clipPath id="fc${uid}"><rect x="${-BL}" y="${FOOTER + 3}" width="${W + 2 * BL}" height="${FOOT_END - FOOTER - 6}"/></clipPath><path d="${rays}" data-art="1" clip-path="url(#fc${uid})" stroke="#D9BC72" stroke-opacity="0.13" stroke-width="1.2" fill="none"/></g>`;
  s += `<rect x="${-BL}" y="${FOOTER - 2}" width="${W + 2 * BL}" height="5" fill="url(#gold${uid})"/><rect x="${-BL}" y="${FOOT_END - 3}" width="${W + 2 * BL}" height="4" fill="url(#gold${uid})"/>`;
  const y0 = FOOT_END + 1, n = st.length; const bandH = n >= 3 ? 13 : 20;
  for (let i = 0; i < n - 1; i++) s += rect(-BL, y0 + i * bandH, W + 2 * BL, bandH, st[i]);
  s += rect(-BL, y0 + (n - 1) * bandH, W + 2 * BL, H + BL - y0 - (n - 1) * bandH, st[n - 1]);
  return s;
}
function logoSvg(design, x, y, d, uid) {
  const src = design.images.logo; if (!src) return `<circle cx="${x}" cy="${y}" r="${d / 2}" fill="url(#seal${uid})" filter="url(#sh${uid})"/>` + T(x, y + 26, (design.texts.name || 'U').split(/\s+/).filter(w => w.length > 2).map(w => w[0]).join('').slice(0, 4), { font: 'O', size: 72, weight: 600, color: design.colors.navy, anchor: 'middle' });
  return `<image href="${src}" x="${x - d / 2}" y="${y - d / 2}" width="${d}" height="${d}" preserveAspectRatio="xMidYMid meet" filter="url(#sh${uid})"/>`;
}
function stamp(text, color) {
  return `<g transform="rotate(-24 1011 680)" opacity="0.16"><text x="1011" y="740" class="fm" font-size="210" font-weight="800" fill="${color}" text-anchor="middle" letter-spacing="20">${esc(text)}</text></g>`;
}
/** VOID PANTOGRAPH — the body's background tint is a screen of FINE dots, with the word COPY hidden in it as COARSE dots of the
 *  same average tone. On the card it is an even tint; a photocopier or a scan-and-reprint drops the fine dots and keeps the
 *  coarse ones, so COPY appears all over the copy. (Tune the strength to the card printer — a test copy shows it.) */
function pantograph(uid, word, ink, strength) {
  const op = [0.14, 0.1, 0.14, 0.2][Math.max(0, Math.min(3, Number(strength) || 2))];
  const area = `x="${-BL}" y="${HEADER + 14}" width="${W + 2 * BL}" height="${FOOTER - HEADER - 14}"`;
  let words = ''; let row = 0;
  for (let y = 240; y < H + 260; y += 170, row++) for (let x = row % 2 ? -420 : -140; x < W + 420; x += 560) words += `<text x="${x}" y="${y}" class="fo" font-size="132" font-weight="600" letter-spacing="10">${esc(word)}</text>`;
  const g = (fill) => `<g fill="${fill}" transform="rotate(-14 1011 680)">${words}</g>`;
  // ~0.2 mm fine screen (two 0.06 mm dots a cell) vs ~0.42 mm coarse screen (one 0.18 mm dot) — the same ~14 % tone
  return `<defs><pattern id="pf${uid}" width="5" height="5" patternUnits="userSpaceOnUse"><circle cx="1.25" cy="1.25" r="0.75" fill="${ink}"/><circle cx="3.75" cy="3.75" r="0.75" fill="${ink}"/></pattern>`
    + `<pattern id="pc${uid}" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="5" cy="5" r="2.1" fill="${ink}"/></pattern>`
    + `<mask id="pw${uid}" maskUnits="userSpaceOnUse" ${area}><rect ${area} fill="#000"/>${g('#fff')}</mask><mask id="pb${uid}" maskUnits="userSpaceOnUse" ${area}><rect ${area} fill="#fff"/>${g('#000')}</mask></defs>`
    + `<g class="ubid-void" opacity="${op}"><rect ${area} fill="url(#pf${uid})" mask="url(#pb${uid})"/><rect ${area} fill="url(#pc${uid})" mask="url(#pw${uid})"/></g>`;
}
/** The SESSION COLOUR — a different colour every academic year (from the session's first year), so an old card shows at a glance. */
const SESSION_COLORS = [['#C62828', 'red', '#FFB300'], ['#1565C0', 'blue', '#00E5FF'], ['#2E7D32', 'green', '#C6FF00'], ['#6A1B9A', 'purple', '#FF4081'], ['#EF6C00', 'orange', '#FFEA00'], ['#00838F', 'teal', '#76FF03']];
function sessionColor(name) { const m = /(\d{4})/.exec(String(name || '')); if (!m) return null; const c = SESSION_COLORS[Number(m[1]) % SESSION_COLORS.length]; return { hex: c[0], name: c[1], shift: c[2] }; }
function sessionTab(session, uid, live) {
  const sc = sessionColor(session); if (!sc) return '';
  const x = 1932, y = 300, h = 530; const u = uid || 's';
  const anim = live ? `<animate attributeName="y1" values="0;1;0" dur="4s" repeatCount="indefinite"/>` : '';
  return `<g class="ubid-session"><defs><linearGradient id="ovi${u}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sc.hex}"/><stop offset="0.45" stop-color="${sc.hex}"/><stop offset="0.5" stop-color="${sc.shift}"/><stop offset="0.55" stop-color="${sc.hex}"/><stop offset="1" stop-color="${sc.hex}"/>${anim}</linearGradient></defs><path d="M${x + 18} ${y}H${W + BL}V${y + h}H${x + 18}Q${x} ${y + h} ${x} ${y + h - 18}V${y + 18}Q${x} ${y} ${x + 18} ${y}z" fill="url(#ovi${u})"/>`
    + `<text transform="translate(${x + 58} ${y + h / 2}) rotate(-90)" class="fo" font-size="46" font-weight="600" fill="#FFFFFF" text-anchor="middle" letter-spacing="4">${esc(String(session).slice(0, 12))}</text></g>`;
}
/** Personalised MICROTEXT round the photo, on the navy ring (a loupe reads it; a copier smears it). */
function photoRing(uid, PX, PY, text, color, R) {
  const r = R || 281; let s = ''; while (s.length < 260) s += text;
  return `<path id="pr${uid}" d="M${PX - r} ${PY}a${r} ${r} 0 1 1 ${2 * r} 0a${r} ${r} 0 1 1 ${-2 * r} 0" fill="none"/><text class="fm" data-sec="micro" font-size="12.5" font-weight="700" fill="${color}" letter-spacing="0.8"><textPath href="#pr${uid}">${esc(s.slice(0, 260))}</textPath></text>`;
}
/** The photo placed by its FACE: crop = { iw, ih, x, y, s } (source pixels — the square the face-framing chose) mapped onto a
 *  box centred at (cx, cy) of w × h; without a crop the photo is centred and sliced as before. */
function cropOk(c) { return !!c && [c.iw, c.ih, c.x, c.y, c.s].every(v => Number.isFinite(Number(v))) && Number(c.s) > 8 && Number(c.iw) > 0 && Number(c.ih) > 0; }
function photoImg(href, crop, cx, cy, w, h, clip, extra) {
  if (cropOk(crop)) {
    const k = Math.max(w, h) / Number(crop.s);
    return `<image href="${href}" x="${r1(cx - (Number(crop.x) + Number(crop.s) / 2) * k)}" y="${r1(cy - (Number(crop.y) + Number(crop.s) / 2) * k)}" width="${r1(Number(crop.iw) * k)}" height="${r1(Number(crop.ih) * k)}" preserveAspectRatio="none" clip-path="url(#${clip})"${extra || ''}/>`;
  }
  return `<image href="${href}" x="${r1(cx - w / 2)}" y="${r1(cy - h / 2)}" width="${r1(w)}" height="${r1(h)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clip})"${extra || ''}/>`;
}
/** A dark photo is lifted so the face is visible (the framing measured it): a linear gain, at most ×1.7. */
function brightFilter(uid, crop) {
  const g = cropOk(crop) ? Math.max(1, Math.min(1.7, Number(crop.gain) || 1)) : 1; if (g < 1.03) return '';
  const f = (c) => `<feFunc${c} type="linear" slope="${g.toFixed(3)}" intercept="0.02"/>`;
  return `<filter id="lift${uid}"><feComponentTransfer>${f('R')}${f('G')}${f('B')}</feComponentTransfer></filter>`;
}
/** The HOLOGRAPHIC medallion (an optically-variable look): rainbow foil, radial guilloche, the institution's initials, a microtext
 *  ring. It overlaps the photo's edge (a pasted photo breaks it). On the live digital card it shimmers — a screenshot does not. */
function holoPatch(uid, cx, cy, r, initials, ring, live) {
  const anim = live ? `<animateTransform attributeName="gradientTransform" type="rotate" values="0 .5 .5;360 .5 .5" dur="5s" repeatCount="indefinite"/>` : '';
  const stops = [['#FF6EC7', 0], ['#FFD36E', 0.2], ['#7DFFB3', 0.4], ['#6EC8FF', 0.6], ['#B18CFF', 0.8], ['#FF6EC7', 1]].map(([c, o]) => `<stop offset="${o}" stop-color="${c}"/>`).join('');
  let rays = ''; for (let i = 0; i < 96; i++) { const a = i / 96 * Math.PI * 2, r0 = r * (0.3 + 0.12 * (i % 3)); rays += `M${r1(cx + r0 * Math.cos(a))} ${r1(cy + r0 * Math.sin(a))}L${r1(cx + r * 0.96 * Math.cos(a + 0.18))} ${r1(cy + r * 0.96 * Math.sin(a + 0.18))}`; }
  let s = ''; while (s.length < 120) s += ring;
  const id = 'hr' + uid;
  return `<g class="ubid-holo"><defs><linearGradient id="holo${uid}" x1="0" y1="0" x2="1" y2="1">${stops}${anim}</linearGradient><path id="${id}" d="M${cx - r * 0.8} ${cy}a${r * 0.8} ${r * 0.8} 0 1 1 ${r * 1.6} 0a${r * 0.8} ${r * 0.8} 0 1 1 ${-r * 1.6} 0" fill="none"/></defs>`
    + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#holo${uid})" fill-opacity="0.62" stroke="#FFFFFF" stroke-opacity="0.7" stroke-width="2"/>`
    + `<path d="${rays}" stroke="#FFFFFF" stroke-opacity="0.45" stroke-width="1.1" fill="none"/>`
    + [0.94, 0.68, 0.32].map(k => `<circle cx="${cx}" cy="${cy}" r="${r1(r * k)}" fill="none" stroke="#FFFFFF" stroke-opacity="0.55" stroke-width="1.3"/>`).join('')
    + `<text class="fm" data-sec="micro" font-size="${r1(r * 0.13)}" font-weight="700" fill="#FFFFFF" fill-opacity="0.85" letter-spacing="1"><textPath href="#${id}">${esc(s.slice(0, 120))}</textPath></text>`
    + `<text x="${cx}" y="${r1(cy + r * 0.17)}" class="fo" font-size="${r1(r * 0.48)}" font-weight="600" fill="#FFFFFF" fill-opacity="0.9" text-anchor="middle" letter-spacing="2">${esc(String(initials || '').slice(0, 4))}</text></g>`;
}
/** A GUILLOCHE RIBBON — interlaced sine waves down a band (seeded per card). */
function ribbon(x0, x1, y0, y1, seed, c1, c2) {
  const rnd = rng(seed); const mid = (x0 + x1) / 2, half = (x1 - x0) / 2; let a = '', b = '';
  for (let k = 0; k < 6; k++) { const ph = rnd() * 6.28, f = 0.011 + k * 0.0032, amp = half * (0.45 + 0.55 * ((k % 3) / 2)); let p = ''; for (let y = y0; y <= y1; y += 7) p += (p ? 'L' : 'M') + r1(mid + amp * Math.sin(y * f + ph)) + ' ' + y; if (k % 2) a += p; else b += p; }
  return `<g class="ubid-ribbon" fill="none" stroke-width="1.1"><path d="${a}" stroke="${c1}" stroke-opacity="0.55"/><path d="${b}" stroke="${c2}" stroke-opacity="0.45"/></g>`;
}
/** A MICRO-RULE: what looks like a thin rule is a line of microtext (the institution + the serial). */
function microRule(x, y, w, text, color) {
  let s = ''; while (s.length < Math.ceil(w / 4.2)) s += text;
  return `<text x="${r1(x)}" y="${r1(y)}" class="fm" data-sec="micro" font-size="7" font-weight="700" fill="${color}" textLength="${r1(w)}" lengthAdjust="spacingAndGlyphs">${esc(s.slice(0, Math.ceil(w / 4.2)))}</text>`;
}
const initialsOf = (name) => String(name || '').split(/\s+/).filter(w => w.length > 2 && !/^(THE|OF|AND|DE|DU|LA|LE|DES)$/i.test(w)).map(w => w[0]).join('').toUpperCase().slice(0, 4);
/** Fine guilloche lines CROSSING the photo onto the card (seeded by the serial): a pasted-over photo breaks them. */
function photoLines(PX, PY, seed, color, R) {
  const rnd = rng(seed); let d = ''; const rr = R || 300;
  for (let k = 0; k < 5; k++) { const ph = rnd() * 6.28, amp = 10 + rnd() * 12, base = PY + rr * 0.4 + k * rr * 0.087; let p = ''; for (let x = PX - rr; x <= PX + rr; x += 12) p += (p ? 'L' : 'M') + Math.round(x) + ' ' + Math.round(base + amp * Math.sin(x * 0.02 + ph)); d += p; }
  return `<path class="ubid-xlines" d="${d}" fill="none" stroke="${color}" stroke-opacity="0.55" stroke-width="1.4"/>`;
}
/** Simple line icons on a 24-unit grid. */
const ICONS = {
  person: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 9c-3.3 0-8 1.7-8 5v2h16v-2c0-3.3-4.7-5-8-5z',
  book: 'M3 5c3-1.4 6-1.4 9 .8 3-2.2 6-2.2 9-.8v14c-3-1.4-6-1.4-9 .8-3-2.2-6-2.2-9-.8z M12 5.8v14',
  cap: 'M12 3 1 9l11 6 9-4.9V17h2V9z M5 13.2v4L12 21l7-3.8v-4L12 17z',
  idcard: 'M2 5h20v14H2z M7 9.5a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z M4 17c.5-2.4 5.5-2.4 6 0 M13 9h6 M13 12h6 M13 15h4',
  calendar: 'M3 5h18v16H3z M3 10h18 M8 3v4 M16 3v4',
  barcode: 'M2 5h20v14H2z M5 8v8 M7 8v8 M10 8v8 M12 8v8 M15 8v8 M18 8v8',
  cross: 'M9 3h6v6h6v6h-6v6H9v-6H3V9h6z',
  drop: 'M12 2c3.5 5.4 7 9.6 7 13.6A7 7 0 0 1 5 15.6C5 11.6 8.5 7.4 12 2z',
  phone: 'M20 15.4c-1.2 0-2.4-.2-3.5-.6-.4-.1-.7 0-1 .2l-1.6 2c-2.8-1.4-5.5-3.9-6.9-6.8l2-1.7c.3-.3.4-.7.2-1-.4-1.1-.6-2.3-.6-3.5 0-.5-.4-1-1-1H4.2C3.6 3 3 3.2 3 4c0 9.3 7.7 17 17 17 .7 0 1-.6 1-1.2v-3.4c0-.5-.5-1-1-1z',
  books: 'M3 3h5v18H3z M10 5h4.6v16H10z M16.6 4.4l4.2-1.1 3.4 17-4.2 1.1z',
  briefcase: 'M3 7h18v13H3z M8 7V4h8v3 M3 12h18',
  building: 'M4 21V4h11v17 M15 9h5v12 M7 8h2 M11 8h2 M7 12h2 M11 12h2 M7 16h2 M11 16h2',
};
function icon(name, cx, cy, s, color, solid) {
  const d = ICONS[name] || ICONS.person; const k = s / 24;
  return `<path d="${d}" transform="translate(${r1(cx - s / 2)} ${r1(cy - s / 2)}) scale(${k.toFixed(4)})" fill="${solid ? color : 'none'}" stroke="${color}" stroke-width="${(1.7).toFixed(1)}" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
}

// ───────────────────────────────────────────────────────────────────────────── the two sides
/** The FRONT. data = studentData()/staffData() output; sec = { serial, ver, pno, qr_front, csc, digital, specimen, status, print }. */
function renderFront(design0, data0, sec, opts) {
  const design = design0 && design0.colors ? design0 : normalizeDesign(design0); const o = opts || {}; const s = sec || {};
  const data = data0 && data0.photo_print ? Object.assign({}, data0, { photo: data0.photo_print, photo_crop: null }) : data0;   // the photo enhanced for print (already framed)
  if (design.mode === 'image') return renderImageSide(design, data, s, o, 'front');
  const c = design.colors, t = design.texts, k = KINDS[data.kind] ? data.kind : 'student';
  const uid = 'f' + (Math.abs(seedOf(s.serial || data.number || 'x')) % 1e6).toString(36);
  const seed = seedOf((s.serial || '') + '|front');
  const vb = o.bleed ? `${-BL} ${-BL} ${W + 2 * BL} ${H + 2 * BL}` : `0 0 ${W} ${H}`;
  let g = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" class="ubid-side" role="img" aria-label="${esc(label(design, 'title_' + k))} — ${esc(data.full_name)}" preserveAspectRatio="xMidYMid meet">` + defs(design, uid);
  g += rect(-BL, -BL, W + 2 * BL, H + 2 * BL, c.paper);
  if (design.show.rosette) g += `<g clip-path="url(#body${uid})">${rosette(620, 760, seed, 0.1)}</g>`;
  if (s.uvVisible && s.print && !s.digital) g += uvVisible(design, data, 880, 760, 270, true);
  if (design.show.pantograph && s.print && !s.digital) g += pantograph(uid, one(design, 'void_word'), c.navy, design.pantograph);   // print jobs only: a screen shows the dots, a copier shows the word
  if (design.show.guilloche) g += `<g clip-path="url(#body${uid})">${ribbon(26, 98, 300, 1075, seed ^ 0x2f17, c.gold, c.swoosh)}</g>`;
  if (design.show.swoosh) g += swoosh('1000 1092', '1380 930', '1720 690', `${W + BL + 30} 410`, seed & 255, c.swoosh, 1);
  g += headerArt(design, uid, seed);
  if (design.show.micro) g += microLine(294, (t.name || '') + ' • ' + one(design, 'authentic') + ' ' + one(design, 'short_' + k) + ' • ' + (data.number || '') + ' • ' + (s.serial || '') + ' • ', c.micro);
  if (design.show.session_tab && data.session) g += sessionTab(data.session, uid, !!s.digital);
  g += logoSvg(design, 234, 140, 238, uid);
  g += T(975, 116, t.name, { font: 'O', size: 82, weight: 600, color: '#FFFFFF', anchor: 'middle', track: 5, maxW: 1070 });
  if (t.name2) g += T(975, 166, t.name2, { font: 'M', size: 34, weight: 500, color: '#FFFFFF', anchor: 'middle', track: 25, maxW: 860 });
  if (t.address) g += T(975, 214, t.address, { font: 'B', size: 30, weight: 500, color: c.foot, anchor: 'middle', maxW: 1150 });
  g += flagSvg(design, uid);
  // title
  const titleA = one(design, 'title_' + k), titleB = design.langs[1] ? one(design, 'title_' + k, null, 1) : '';
  g += T(114, 384, titleB && titleB !== titleA ? titleA + ' /\n' + titleB : titleA, { font: 'M', size: 45, color: c.ink, leading: 50, maxW: 880 });
  g += `<rect x="116" y="452" width="789" height="4" fill="url(#gold${uid})"/>`;
  if (design.show.micro) g += microRule(116, 469, 789, (t.name || '') + ' • ' + (s.serial || '') + ' • ', c.micro);
  // THE DETAILS — one row each: the icon, the label (both languages), and the value IN FRONT OF it, in one column; a long value
  // (a long name, a department's full name) shrinks, then wraps to two lines — it never runs into the photo
  const dept = data.unit_name ? data.unit_name + (data.unit && data.unit_name.indexOf(data.unit) < 0 ? ' (' + data.unit + ')' : '') : data.unit;
  const rows = k === 'student'
    ? [['surname', 'person', data.surname], ['other_names', 'person', data.other_names], ['course', 'book', dept], ['level', 'cap', data.level], ['matric', 'idcard', data.number], ['session', 'calendar', data.session]]
    : [['surname', 'person', data.surname], ['other_names', 'person', data.other_names], [k === 'lecturer' ? 'rank' : 'position', 'briefcase', data.position], ['department', 'building', data.unit], ['staff_no', 'idcard', data.number], ['since', 'calendar', data.since]];
  const R0 = 482, RH = 98, LX = 222, VX = 520;
  rows.forEach(([key, ic, val], i) => {
    const cy = R0 + RH * i + RH / 2; const lab = label(design, key); const right = i >= 4 ? 1196 : 1262;   // the last rows stop before the ghost image
    const twoLines = lab.indexOf(' / ') > 0 && estWidth(lab, 'M', 24, 8, 600) > VX - LX - 22;
    g += icon(ic, 160, cy - 2, 54, c.label);
    g += twoLines ? T(LX, cy - 7, lab.replace(' / ', ' /\n'), { font: 'M', size: 28, weight: 600, color: c.label, track: 6, leading: 30, maxW: VX - LX - 22 }) : T(LX, cy + 9, lab, { font: 'M', size: 28, weight: 600, color: c.label, track: 6, maxW: VX - LX - 22 });
    g += fitText(VX, cy, val || '—', { font: 'M', size: 50, minSize: 28, weight: 800, color: c.value, maxW: right - VX });
    if (i < rows.length - 1) g += `<rect x="${LX}" y="${R0 + RH * (i + 1) - 1}" width="${right - LX}" height="1.4" fill="${c.label}" fill-opacity="0.16"/>`;
  });
  // photo
  const PX = PHX, PY = PHY, R = PHR;
  g += T(PX, 362, label(design, k === 'student' ? 'photo_student' : 'photo'), { font: 'M', size: 26, color: c.ink, anchor: 'middle', track: 10, maxW: 600 });
  g += `<circle cx="${PX}" cy="${PY}" r="${R}" fill="${c.navy}" filter="url(#sh${uid})"/><circle cx="${PX}" cy="${PY}" r="${R - 24}" fill="#FFFFFF"/><circle cx="${PX}" cy="${PY}" r="${R - 29}" fill="url(#gold${uid})"/><circle cx="${PX}" cy="${PY}" r="${R - 35}" fill="#E9ECF3"/>`;
  const lift = data.photo ? brightFilter(uid, data.photo_crop) : '';
  if (lift) g += '<defs>' + lift + '</defs>';
  g += data.photo ? photoImg(data.photo, data.photo_crop, PX, PY, 2 * (R - 30), 2 * (R - 30), 'photo' + uid, lift ? ` filter="url(#lift${uid})"` : '') : icon('person', PX, PY + 20, 300, '#AEB6C8', true);
  if (design.show.micro) g += photoRing(uid, PX, PY, (data.full_name || '') + ' • ' + (data.number || '') + ' • ' + (s.serial || '') + (data.session ? ' • ' + data.session : '') + ' • ', c.goldText, R - 12);
  if (design.show.photo_lines) g += photoLines(PX, PY, seed ^ 0x5bd1e995, c.gold, R);
  const GX = 1262, GY = 1004;   // the ghost image: below-left of the photo, clear of the details
  if (design.show.ghost && data.photo) g += `<defs><clipPath id="gf${uid}"><ellipse cx="${GX}" cy="${GY}" rx="52" ry="60"/></clipPath></defs><g class="ubid-ghost" opacity="0.27" filter="url(#gray${uid})">${photoImg(data.photo, data.photo_crop, GX, GY, 104, 120, 'gf' + uid)}</g><ellipse cx="${GX}" cy="${GY}" rx="52" ry="60" fill="none" stroke="${c.gold}" stroke-opacity="0.55" stroke-width="1.6"/>`
    + `<text x="${GX}" y="${GY + 4}" class="fm" font-size="8.5" font-weight="700" fill="${c.ink}" fill-opacity="0.55" text-anchor="middle">${esc(String(data.number || '').slice(0, 26))}</text>`;
  if (design.show.holo) g += holoPatch(uid, PX - R * 0.7, PY + R * 0.72, 86, initialsOf(t.name) || 'ID', (t.name || '') + ' • ' + one(design, 'authentic') + ' • ', !!s.digital);
  g += T(PX - 20, PY + R + 46, s.serial ? one(design, 'card_no') + ' ' + s.serial : label(design, 'verify', null, ' • '), { font: 'M', size: 24, color: c.label, anchor: 'middle', track: 20, maxW: 390 });
  // THE QR (the camera's check): big enough to scan after any print — 222 card dots square, whole dots per module, a white quiet zone
  const QX = 1790, QY = 846, QS = 222;
  g += `<rect x="${QX - 4}" y="${QY - 4}" width="${QS + 8}" height="${QS + 8}" rx="12" fill="#FFFFFF" stroke="rgba(176,138,72,0.75)" stroke-width="2"/>` + qrSvg(s.qr_front, QX, QY, QS, 0, 'M');
  g += T(QX + QS / 2, QY - 12, label(design, 'verify', null, ' • '), { font: 'M', size: 17, color: c.label, anchor: 'middle', track: 20, maxW: QS + 20 });
  // footer
  g += footerArt(design, uid) + sealSvg(design, uid, 226, 1150, 112);
  if (design.images.signature && design.show.signature) g += `<image href="${design.images.signature}" x="300" y="1106" width="150" height="70" preserveAspectRatio="xMidYMid meet"/>`;
  if (design.show.ir && !s.digital && s.serial) g += `<text class="ubid-ir fm" x="470" y="1127" font-size="24" font-weight="700" fill="#000000" letter-spacing="3">${esc('IR • ' + s.serial + ' • ' + (data.number || ''))}</text>`;
  g += T(470, 1169, `${one(design, 'issued')}: ${data.issued || '—'}  •  ${one(design, 'valid_through')}: ${data.valid_through || '—'}`, { font: 'M', size: 31, weight: 600, color: '#FFFFFF', maxW: 860 });
  g += T(1668, 1132, one(design, 'property') + '\n' + (t.name || '') + '.\n' + one(design, 'if_found'), { font: 'B', size: 28.5, weight: 500, color: c.goldText, anchor: 'middle', leading: 31, maxW: 600 });
  if (s.digital) g += stamp(one(design, 'digital_copy'), c.navy);
  if (s.specimen) g += stamp(one(design, 'specimen'), '#B3262C');
  if (s.status && s.status !== 'active') g += stamp(String(s.status).toUpperCase(), '#B3262C');
  return g + '</svg>';
}
/** The BACK. */
function renderBack(design0, data0, sec, opts) {
  const design = design0 && design0.colors ? design0 : normalizeDesign(design0); const o = opts || {}; const s = sec || {};
  const data = data0 && data0.photo_print ? Object.assign({}, data0, { photo: data0.photo_print, photo_crop: null }) : data0;
  if (design.mode === 'image') return renderImageSide(design, data, s, o, 'back');
  const c = design.colors, t = design.texts, k = KINDS[data.kind] ? data.kind : 'student';
  const uid = 'b' + (Math.abs(seedOf(s.serial || data.number || 'x')) % 1e6).toString(36);
  const seed = seedOf((s.serial || '') + '|back');
  const vb = o.bleed ? `${-BL} ${-BL} ${W + 2 * BL} ${H + 2 * BL}` : `0 0 ${W} ${H}`;
  let g = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" class="ubid-side" role="img" aria-label="${esc(label(design, 'short_' + k))} — ${esc(label(design, 'back_side'))}" preserveAspectRatio="xMidYMid meet">` + defs(design, uid);
  g += rect(-BL, -BL, W + 2 * BL, H + 2 * BL, c.paper);
  if (design.show.rosette) g += `<g clip-path="url(#body${uid})">${rosette(560, 720, seed, 0.09)}</g>`;
  if (s.uvVisible && s.print && !s.digital) g += uvVisible(design, data, 560, 720, 260, true);
  if (design.show.swoosh) g += swoosh('1080 1092', '1460 930', '1760 760', `${W + BL + 30} 520`, seed & 255, c.swoosh, 0.55);
  g += headerArt(design, uid, seed);
  if (design.show.micro) g += microLine(294, (t.name || '') + ' • ' + (data.number || '') + ' • ' + (s.serial || '') + ' • ' + one(design, 'authentic') + ' • ', c.micro);
  if (design.show.guilloche) g += `<g clip-path="url(#body${uid})">${ribbon(26, 112, 300, 1075, seed ^ 0x2f17, c.gold, c.swoosh)}${ribbon(1046, 1098, 318, 1062, seed ^ 0x77, c.gold, c.swoosh)}</g>`;
  g += sealSvg(design, uid, 226, 140, 112);
  g += T(975, 136, label(design, 'short_' + k, null, ' • '), { font: 'O', size: 86, weight: 600, color: c.goldTitle, anchor: 'middle', track: 5, maxW: 1020 });
  g += T(975, 196, label(design, 'back_side', null, ' • '), { font: 'M', size: 32, weight: 600, color: c.goldTitle, anchor: 'middle', track: 60, maxW: 900 });
  g += flagSvg(design, uid);
  // left column: barcode, QR, signature
  g += icon('barcode', 180, 340, 52, c.label) + T(220, 355, label(design, 'barcode', null, ' • '), { font: 'M', size: 42, color: c.ink, track: 5, maxW: 820 }) + `<rect x="220" y="372" width="640" height="3" fill="url(#gold${uid})"/>`;
  if (design.show.micro) g += microRule(220, 387, 640, (data.number || '') + ' • ' + (s.serial || '') + ' • ', c.micro);
  g += barcodeSvg(s.barcode || s.serial || data.number, 595, 398, 116, 6, 820);
  g += T(595, 555, codeText(s.barcode || s.serial || data.number || ''), { font: 'M', size: 37, weight: 600, color: '#0B1534', anchor: 'middle', track: 80, maxW: 880 }) + `<rect x="200" y="574" width="790" height="3" fill="url(#gold${uid})" opacity="0.8"/>`;
  g += icon('idcard', 180, 622, 50, c.label) + T(220, 637, label(design, 'qr', null, ' • '), { font: 'M', size: 42, color: c.ink, track: 5, maxW: 700 }) + `<rect x="220" y="654" width="540" height="3" fill="url(#gold${uid})"/>`;
  if (design.show.micro) g += microRule(220, 669, 540, (t.name || '') + ' • ' + (data.session || '') + ' • ', c.micro);
  // THE BACK QR (the offline check): 390 card dots square — with the compact credential (UB3) its modules are 7 dots (0.30 mm)
  g += `<rect x="112" y="676" width="354" height="354" rx="14" fill="#FFFFFF" stroke="rgba(176,138,72,0.75)" stroke-width="2"/>` + qrSvg(s.qr_back, 116, 680, 346, 0, 'L');
  g += T(530, 742, one(design, 'verify_auth') + (design.langs[1] ? '\n' + one(design, 'verify_auth', null, 1) : ''), { font: 'B', size: 34, weight: 600, color: c.label, leading: 38, maxW: 520 });
  g += T(530, 832, one(design, 'scan_line'), { font: 'B', size: 25, weight: 500, color: c.muted, maxW: 520 });
  if (design.show.csc) g += T(530, 874, label(design, 'security_code') + ': ' + (s.csc && !s.digital ? s.csc + (s.pno ? '  •  ' + one(design, 'print_no') + ' ' + s.pno : '') : '— (' + one(design, 'physical_only') + ')'), { font: 'M', size: 21, weight: 600, color: c.ink, track: 20, maxW: 520 });
  g += `<rect x="530" y="914" width="380" height="3" fill="url(#gold${uid})"/>` + T(530, 956, label(design, 'holder_signature', null, ' • '), { font: 'M', size: 25, color: c.ink, maxW: 380 });
  if (data.signature) g += `<image href="${data.signature}" x="540" y="972" width="360" height="72" preserveAspectRatio="xMidYMid meet"/>`;
  g += rect(530, 1052, 380, 2.5, '#9BA2B4');
  if (design.show.ghost && data.photo) g += `<g class="ubid-ghost" opacity="0.24" filter="url(#gray${uid})">${photoImg(data.photo, data.photo_crop, 990, 1000, 116, 132, 'ghost' + uid)}</g><ellipse cx="990" cy="1000" rx="58" ry="66" fill="none" stroke="${c.gold}" stroke-opacity="0.6" stroke-width="2"/>`;
  g += `<rect x="1072" y="318" width="3" height="744" fill="url(#gold${uid})" opacity="0.9"/>`;
  // right column: identity, medical & contact, library
  const RX = 1112, RI = 1142, RT = 1194;
  g += T(RX + 18, 356, label(design, 'identity', null, ' • '), { font: 'M', size: 42, color: c.ink, track: 5, maxW: 860 });
  const inline = (key, y, val, size, weight, lines) => { const lab = label(design, key) + ':'; const lw = Math.min(330, estWidth(lab, 'M', 27, 10, 600) + 16); return T(RI, y, lab, { font: 'M', size: 27, weight: 600, color: c.label, track: 10, maxW: 320 }) + fitText(RI + lw, y - size * 0.36, val || '—', { font: 'M', size, minSize: size * 0.62, weight: weight || 700, color: c.value, maxW: 1985 - RI - lw, lines: lines || 1 }); };
  g += inline('name', 419, data.full_name, 40, 700, 2) + inline(k === 'student' ? 'matric' : 'staff_no', 474, data.number, 40) + inline(k === 'student' ? 'faculty' : 'department', 527, [data.faculty_line].filter(Boolean).join(''), 31, 600, 2);
  let y = 604;
  const showMed = (design.show.blood && data.blood_group) || (design.show.emergency && (data.emergency_phone || data.emergency_name));
  if (showMed) {
    g += icon('cross', RX + 30, 589, 52, c.label) + T(RT - 14, 604, label(design, 'medical', null, ' • '), { font: 'M', size: 42, color: c.ink, track: 5, maxW: 790 });
    const med = (ic, key, val, size) => { const out = icon(ic, RI + 4, y + 69, 56, c.label) + T(RT, y + 57, label(design, key) + ':', { font: 'M', size: 25, weight: 600, color: c.label, track: 10, maxW: 790 }) + fitText(RT, y + 92, val, { font: 'M', size, minSize: size * 0.6, color: c.value, maxW: 780, lines: 1 }); y += 97; return out; };
    if (design.show.blood && data.blood_group) g += med('drop', 'blood_group', data.blood_group, 46);
    if (design.show.emergency && data.emergency_phone) g += med('phone', 'emergency', data.emergency_phone, 46);
    if (design.show.emergency && data.emergency_name) g += med('person', 'emergency_name', data.emergency_name, 40);
  }
  const dirName = String(t.director_name || '').trim(); const DY = 1018;
  if (design.show.library && data.library_access && y <= 940 && (!dirName || y + 60 + 86 < DY - 62)) {
    const ly = dirName ? y + 60 : Math.max(961, y + 70);
    g += icon('books', RI + 4, ly + 23, 60, c.label, true) + T(RT, ly, label(design, 'library', null, ' • '), { font: 'M', size: 33, color: c.ink, maxW: 775 });
    g += T(RT, ly + 44, data.library_access, { font: 'B', size: 30, weight: 500, color: c.label, maxW: 775 });
    if (data.library_loan && ly + 86 < 1076) g += T(RT + 6, ly + 86, '• ' + data.library_loan, { font: 'B', size: 28, weight: 500, color: c.label, maxW: 760 });
  }
  if (dirName) {
    g += `<rect x="${RI}" y="${DY - 58}" width="${1985 - RI}" height="2" fill="url(#gold${uid})" opacity="0.85"/>` + icon('person', RI + 4, DY - 6, 48, c.label);
    g += T(RT, DY - 20, (String(t.director_title || '').trim() || 'DIRECTOR').toUpperCase() + ':', { font: 'M', size: 23, weight: 700, color: c.label, track: 10, maxW: 790 });
    g += fitText(RT, DY + 22, dirName + (t.director_phone ? '  •  ' + String(t.director_phone).trim() : ''), { font: 'M', size: 34, minSize: 20, weight: 700, color: c.value, maxW: 1985 - RT, lines: 1 });
  }
  // footer
  g += footerArt(design, uid) + sealSvg(design, uid, 226, 1150, 112);
  g += T(412, 1124, one(design, 'property_line') + '\n' + (t.name || ''), { font: 'M', size: 30, weight: 600, color: '#FFFFFF', track: 10, leading: 33, maxW: 880 });
  g += T(412, 1190, (t.address || '') + '\n' + one(design, 'if_found'), { font: 'B', size: 25, weight: 500, color: c.foot, leading: 26, maxW: 880 });
  g += T(1352, 1114, label(design, 'instructions') + ':', { font: 'B', size: 25, weight: 700, color: c.goldText, track: 10, maxW: 625 });
  g += T(1352, 1141, ['instr1', 'instr2', 'instr3', data.session ? 'instr_session' : 'instr4'].map(kk => '• ' + one(design, kk, { office: t.office || '', date: data.valid_through || '', s: data.session || '' })).join('\n'), { font: 'B', size: 23, weight: 500, color: c.foot, leading: 24, maxW: 625 });
  if (s.digital) g += stamp(one(design, 'digital_copy'), c.navy);
  if (s.specimen) g += stamp(one(design, 'specimen'), '#B3262C');
  if (s.status && s.status !== 'active') g += stamp(String(s.status).toUpperCase(), '#B3262C');
  return g + '</svg>';
}

// ───────────────────────────────────────────────────────────────────────────── photo framing · printer layers
/** FACE FRAMING — the square of the photo the card's circle shows, from a detected face box { x, y, width, height } (source pixels):
 *  head and shoulders, the face a little above the centre, never past the photo's edges. Without a face: the upper-centre square
 *  (where a passport photo's head is). → { iw, ih, x, y, s, src } */
function cropFromFace(iw, ih, box, src) {
  iw = Number(iw); ih = Number(ih); if (!(iw > 0 && ih > 0)) return null;
  let cx, cy, side; const hasBox = !!box && Number(box.width) > 4 && Number(box.height) > 4;
  // the face takes ~half the circle (head + a little of the shoulders), its eyes just above the centre — the circle crops the corners
  if (hasBox) { const bw = Number(box.width), bh = Number(box.height); const eyes = box.eyes && Number(box.eyes.x) > 0 ? box.eyes : null; side = Math.max(bw, bh) * 2.05; cx = eyes ? Number(eyes.x) : Number(box.x) + bw / 2; cy = (eyes ? Number(eyes.y) + bh * 0.32 : Number(box.y) + bh / 2) + bh * 0.12; }
  else { side = Math.min(iw, ih); cx = iw / 2; cy = ih > iw ? side / 2 + (ih - side) * 0.22 : ih / 2; }
  // the face CENTRED: the frame may reach past the photo's edge by up to 12 % (a cleaned photo is white there) rather than slide off the face
  side = Math.max(16, Math.min(side, iw, ih)); const ov = side * 0.12;
  const fit = (c, len) => { const lo = -ov, hi = len - side + ov; return hi < lo ? (len - side) / 2 : Math.max(lo, Math.min(hi, c - side / 2)); };
  const x = fit(cx, iw), y = fit(cy, ih);
  return { iw: Math.round(iw), ih: Math.round(ih), x: Math.round(x), y: Math.round(y), s: Math.round(side), src: src || (hasBox ? 'face' : 'centre') };
}
// ───────────────────────────────────────────────────────────────────────────── image templates (the design studio)
/** IMAGE-TEMPLATE designs: the university's own artwork (an uploaded template, front + back) IS the card; the data and every security
 *  layer are placed on it where the studio (or the AI reading the template) puts each field. Landscape or portrait. */
const FIELD_KEYS = ['photo', 'surname', 'other_names', 'full_name', 'number', 'unit', 'faculty_line', 'level', 'session', 'position', 'since', 'issued', 'valid_through', 'blood_group', 'emergency_phone', 'emergency_name',
  'serial', 'qr_front', 'qr_back', 'barcode', 'csc', 'signature', 'ghost', 'title', 'text', 'session_tab', 'ir', 'holo', 'image', 'director'];
// the layers every image card carries — added where the layout has none
const REQUIRED_FIELDS = [['photo', 'front'], ['serial', 'front'], ['qr_front', 'front'], ['session_tab', 'front'], ['ir', 'front'], ['qr_back', 'back'], ['barcode', 'back'], ['csc', 'back'], ['ghost', 'back']];
const FIELD_LABEL = { surname: 'surname', other_names: 'other_names', full_name: 'name', unit: 'department', faculty_line: 'faculty', level: 'level', session: 'session', position: 'position', since: 'since', issued: 'issued', valid_through: 'valid_through', blood_group: 'blood_group', emergency_phone: 'emergency', emergency_name: 'emergency_name', serial: 'card_no', csc: 'security_code' };
function gridOf(design) { return design && design.mode === 'image' && design.orientation === 'portrait' ? [H, W] : [W, H]; }
/** A starting layout for a template (the AI's reading replaces it; the studio adjusts it by dragging). */
function defaultImageFields(orientation, kind) {
  const P = orientation === 'portrait'; const f = (key, side, x, y, w, h, o) => Object.assign({ key, side, x, y, w, h }, o || {});
  const staff = kind === 'staff' || kind === 'lecturer';
  if (P) return [
    f('photo', 'front', 387, 430, 500, 600, { shape: 'rounded' }), f('full_name', 'front', 90, 1090, 1095, 80, { align: 'middle', weight: 800 }), f('number', 'front', 90, 1190, 1095, 64, { align: 'middle', label: true }),
    f(staff ? 'position' : 'unit', 'front', 90, 1280, 1095, 56, { align: 'middle', label: true }), f(staff ? 'unit' : 'level', 'front', 90, 1360, 1095, 56, { align: 'middle', label: true }), f('session', 'front', 90, 1440, 1095, 56, { align: 'middle', label: true }),
    f('valid_through', 'front', 90, 1520, 1095, 48, { align: 'middle', label: true }), f('serial', 'front', 90, 1600, 700, 40, { label: true }), f('qr_front', 'front', 935, 1680, 250, 250), f('session_tab', 'front', 935, 290, 250, 90), f('ir', 'front', 90, 1940, 800, 34),
    f('qr_back', 'back', 90, 300, 420, 420), f('csc', 'back', 90, 760, 1095, 40, { label: true }), f('blood_group', 'back', 560, 330, 620, 60, { label: true }), f('emergency_phone', 'back', 560, 450, 620, 60, { label: true }),
    f('emergency_name', 'back', 560, 570, 620, 52, { label: true }), f('signature', 'back', 90, 1150, 600, 120), f('ghost', 'back', 900, 1100, 260, 300), f('barcode', 'back', 90, 1720, 1095, 150)];
  return [
    f('photo', 'front', 1470, 330, 470, 560, { shape: 'rounded' }), f('surname', 'front', 110, 380, 1250, 76, { weight: 800, label: true }), f('other_names', 'front', 110, 500, 1250, 64, { label: true }),
    f('number', 'front', 110, 610, 1250, 62, { label: true }), f(staff ? 'position' : 'unit', 'front', 110, 720, 1250, 56, { label: true }), f(staff ? 'unit' : 'level', 'front', 110, 830, 600, 56, { label: true }),
    f('session', 'front', 760, 830, 600, 56, { label: true }), f('valid_through', 'front', 110, 940, 900, 46, { label: true }), f('serial', 'front', 1470, 930, 470, 36, { align: 'middle' }), f('qr_front', 'front', 1760, 990, 180, 180),
    f('session_tab', 'front', 1700, 170, 300, 84), f('ir', 'front', 110, 1180, 1000, 32),
    f('qr_back', 'back', 120, 300, 420, 420), f('csc', 'back', 120, 760, 900, 40, { label: true }), f('blood_group', 'back', 1100, 320, 820, 60, { label: true }), f('emergency_phone', 'back', 1100, 440, 820, 60, { label: true }),
    f('emergency_name', 'back', 1100, 560, 820, 52, { label: true }), f('signature', 'back', 600, 520, 420, 110), f('ghost', 'back', 1700, 700, 220, 260), f('barcode', 'back', 120, 1000, 1200, 150)];
}
const n0 = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; };
/** A field list made safe (known keys, inside the card, sane sizes) — and the required security fields added where missing. */
/** A name as typed, word by word — a word typed all in capitals or all in small letters becomes Title Case ("LOKOSU joseph" →
 *  "Lokosu Joseph"); a word typed in mixed case is kept ("McDonald", "N'Diaye"). */
function asTyped(v) {
  return String(v || '').trim().split(/\s+/).map(w => (/\p{Ll}/u.test(w) && /\p{Lu}/u.test(w) ? w : w.toLowerCase().replace(/(^|[\-'’])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()))).join(' ');
}
function normalizeFields(list, orientation, kind) {
  const P = orientation === 'portrait'; const gw = P ? H : W, gh = P ? W : H; const out = [];
  for (const f of Array.isArray(list) ? list.slice(0, 60) : []) {
    if (!f || !FIELD_KEYS.includes(f.key)) continue;
    const x = n0(f.x, 0, gw - 8, 0), y = n0(f.y, 0, gh - 8, 0);
    const g = { key: f.key, side: f.side === 'back' ? 'back' : 'front', x, y, w: n0(f.w, 8, gw - x, 200), h: n0(f.h, 8, gh - y, 50) };
    if (f.size != null) g.size = n0(f.size, 6, 240, null);
    if (HEX.test(String(f.color || ''))) g.color = f.color;
    if (f.weight != null) g.weight = Math.round(n0(f.weight, 300, 900, 700) / 100) * 100;
    if (['start', 'middle', 'end'].includes(f.align)) g.align = f.align;
    if (f.label) g.label = true; if (f.upper === false) g.upper = false;
    if (['circle', 'rounded', 'rect'].includes(f.shape)) g.shape = f.shape;
    if (f.key === 'text') g.text = String(f.text || '').slice(0, 120);
    if (f.key === 'image') { if (!IMG.test(String(f.src || '')) || String(f.src).length > 3000000) continue; g.src = f.src; }
    if (f.stack === true) g.stack = true;
    out.push(g);
  }
  const defs = defaultImageFields(orientation, kind);
  for (const [k, side] of REQUIRED_FIELDS) if (!out.some(f => f.key === k)) { const d = defs.find(x => x.key === k && x.side === side); if (d) out.push(Object.assign({ auto: true }, placeAuto(d, out, gw, gh))); }
  return out;
}
/** A box added by itself, moved off the boxes already on its side: the free place nearest its usual one (narrower if it must) — the
 *  words of one box never run into another's. */
function placeAuto(d, fields, gw, gh) {
  const same = fields.filter(f => f.side === d.side); const hits = (a) => same.some(f => a.x < f.x + f.w + 6 && a.x + a.w + 6 > f.x && a.y < f.y + f.h + 6 && a.y + a.h + 6 > f.y);
  if (!hits(d)) return d;
  for (const w of [d.w, Math.round(d.w * 0.7), Math.round(d.w * 0.5)]) {
    let best = null; for (let y = Math.round(gh * 0.2); y + d.h <= gh * 0.95; y += 20) for (let x = Math.round(gw * 0.03); x + w <= gw * 0.97; x += 20) { if (hits({ x, y, w, h: d.h })) continue; const dist = Math.hypot(x - d.x, y - d.y); if (!best || dist < best.dist) best = { x, y, dist }; }
    if (best) return Object.assign({}, d, { x: best.x, y: best.y, w });
  }
  return d;
}
/** The value a field shows. */
function fieldValue(design, data, s, f, k) {
  switch (f.key) {
    case 'title': return label(design, 'title_' + k);
    case 'text': return f.text || '';
    case 'director': return [String((design.texts || {}).director_name || '').trim(), String((design.texts || {}).director_phone || '').trim()].filter(Boolean).join('  •  ');
    case 'serial': return s.serial || '';
    case 'csc': return s.csc && !s.digital ? s.csc + (s.pno ? '  •  ' + one(design, 'print_no') + ' ' + s.pno : '') : '— (' + one(design, 'physical_only') + ')';
    case 'issued': return data.issued || '';
    case 'valid_through': return data.valid_through || '';
    default: return data[f.key] == null ? '' : String(data[f.key]);
  }
}
/** One side of an image-template card. o.laser = the personal data alone (the engraving layer). */
/** The CLEAN card body of a layout design (no background picture): the institution's band at the top — its logo (background
 *  removed, so it blends), name and the card's title — a gold rule, and the colour stripe at the foot; everything in the design's
 *  own colours, crisp at any resolution. */
function cleanKit(design, data, side, gw, gh, uid, k) {
  const c = design.colors; const t = design.texts; const P = gh > gw; const hb = Math.round(gh * (P ? 0.13 : 0.17)); const fh = Math.round(gh * (P ? 0.035 : 0.05));
  let g = `<rect x="0" y="0" width="${gw}" height="${hb}" fill="url(#band${uid})"/>` + `<rect x="0" y="${hb - 4}" width="${gw}" height="6" fill="url(#gold${uid})"/>`;
  const d = Math.round(hb * 0.78); const lx = Math.round(hb * 0.12 + d / 2); g += logoSvg(design, lx, Math.round(hb / 2), d, uid);
  const x0 = lx + d / 2 + 24, w0 = gw - x0 - 30; const name = String(t.name || '').toUpperCase(); const two = !!t.name2 && !P;
  g += T(x0 + w0 / 2, Math.round(hb * (two ? 0.46 : 0.6)), name, { font: 'O', size: Math.round(hb * (P ? 0.24 : 0.34)), weight: 600, color: '#FFFFFF', anchor: 'middle', maxW: w0 });
  if (two) g += T(x0 + w0 / 2, Math.round(hb * 0.78), String(t.name2), { font: 'M', size: Math.round(hb * 0.13), weight: 600, color: '#E8CF86', anchor: 'middle', maxW: w0 });
  // the title clears the session tab (top right of a portrait card)
  if (side === 'front' && P) g += T((gw - 340) / 2 + 40, hb + 62, label(design, 'title_' + k), { font: 'M', size: 40, weight: 800, color: c.navy, anchor: 'middle', maxW: gw - 420 });
  const st = (design.stripe && design.stripe.length ? design.stripe : [c.navy, c.gold]); const bh = fh / st.length;
  g += `<rect x="0" y="${gh - fh - 6}" width="${gw}" height="5" fill="url(#gold${uid})"/>`; st.forEach((col, i) => { g += rect(0, gh - fh + i * bh, gw, bh + 0.5, col); });
  return g;
}
/** A free place for a box on a side (the bottom band first, then the middle, then the top) — the one overlapping the fewest fields. */
function freeSpot(fields, gw, gh) {
  const P = gh > gw; const w = Math.round(P ? gw * 0.86 : gw * 0.46), h = Math.round(P ? gh * 0.06 : gh * 0.1); const mx = Math.round(gw * 0.04);
  const ys = (P ? [0.8, 0.72, 0.64, 0.4] : [0.76, 0.66, 0.5, 0.3]).map(f => Math.round(gh * f)); const xs = P ? [Math.round((gw - w) / 2)] : [gw - w - mx, mx];
  const hit = (a) => fields.reduce((n, f) => { const ix = Math.max(0, Math.min(a.x + a.w, f.x + f.w) - Math.max(a.x, f.x)), iy = Math.max(0, Math.min(a.y + a.h, f.y + f.h) - Math.max(a.y, f.y)); return n + ix * iy; }, 0);
  let best = null; for (const y of ys) for (const x of xs) { const c = { x, y, w, h }; const n = hit(c); if (!best || n < best.n) best = Object.assign(c, { n }); if (!n) return { x, y, w, h }; }
  return best ? { x: best.x, y: best.y, w: best.w, h: best.h } : null;
}
function renderImageSide(design, data, sec, opts, side) {
  const o = opts || {}; const s = sec || {}; const c = design.colors; const t = design.texts; const k = KINDS[data.kind] ? data.kind : 'student';
  const [gw, gh] = gridOf(design); const uid = 'i' + side[0] + (Math.abs(seedOf(s.serial || data.number || 'x')) % 1e6).toString(36);
  const seed = seedOf((s.serial || '') + '|' + side); const fields = (design.fields || []).filter(f => f.side === side);
  // the DIRECTOR typed in the studio shows on the back even when the layout has no box for it — placed where nothing else is
  if (side === 'back' && String(t.director_name || '').trim() && !(design.fields || []).some(f => f.key === 'director')) { const spot = freeSpot(fields, gw, gh); if (spot) fields.push(Object.assign({ key: 'director', side: 'back', label: true, stack: true, size: Math.round(spot.h * 0.36), plate: true, auto: true }, spot)); }
  let g = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${gw} ${gh}" class="ubid-side ubid-image" role="img" aria-label="${esc(label(design, 'title_' + k))} — ${esc(data.full_name || '')}" preserveAspectRatio="xMidYMid meet">` + defs(design, uid);
  g += `<defs><filter id="gray2${uid}"><feColorMatrix type="saturate" values="0"/></filter></defs>`;
  g += rect(0, 0, gw, gh, o.laser ? '#FFFFFF' : c.paper);
  const bg = design.bg_show && design.bg && design.bg[side];
  if (bg && !o.laser) g += `<image href="${bg}" x="0" y="0" width="${gw}" height="${gh}" preserveAspectRatio="xMidYMid slice"/>`;
  else if (!o.laser) g += cleanKit(design, data, side, gw, gh, uid, k);
  if (!o.laser) {
    if (design.show.rosette) g += `<g opacity="0.75">${rosette(gw * 0.42, gh * 0.55, seed, 0.06)}</g>`;
    if (s.uvVisible && s.print && !s.digital) g += uvVisible(design, data, gw * 0.42, gh * 0.55, Math.min(gw, gh) * 0.22, true);
    if (design.show.pantograph && s.print && !s.digital) g += `<svg x="0" y="0" width="${gw}" height="${gh}" viewBox="0 290 2022 790" preserveAspectRatio="none">${pantograph(uid, one(design, 'void_word'), c.navy, design.pantograph)}</svg>`;
    if (design.show.guilloche) g += ribbon(8, 58, gh * 0.12, gh * 0.9, seed ^ 0x2f17, c.gold, c.swoosh);
    if (design.show.micro) { let m = ''; const unit = (t.name || '') + ' • ' + (data.number || '') + ' • ' + (s.serial || '') + ' • '; while (m.length < gw / 5) m += unit; g += `<text x="0" y="${gh - 6}" class="fm" data-sec="micro" font-size="9.5" font-weight="600" fill="${c.micro}" textLength="${gw}" lengthAdjust="spacingAndGlyphs">${esc(m.slice(0, Math.round(gw / 5)))}</text>`; }
  }
  const box = (f) => ({ cx: f.x + f.w / 2, cy: f.y + f.h / 2 });
  // the label each text field shows, and ONE value column for the inline fields that share a left edge — the values line up
  const labOf = (f) => { const lk = f.key === 'number' ? (k === 'student' ? 'matric' : 'staff_no') : FIELD_LABEL[f.key]; return f.key === 'director' ? ((String((design.texts || {}).director_title || '').trim() || 'DIRECTOR').toUpperCase() + ':') : lk ? label(design, lk) : ''; };
  const colW = {}; for (const f of fields) { if (!f.label || f.stack || (f.align && f.align !== 'start') || !labOf(f)) continue; const lsz = Math.max(14, (f.size || f.h * 0.72) * 0.42); const kx = Math.round(f.x / 40); colW[kx] = Math.max(colW[kx] || 0, Math.min(f.w * 0.42, estWidth(labOf(f) + ' ', 'M', lsz, 10, 600) + 18)); }
  for (const f of fields) {
    const { cx, cy } = box(f); const fid = uid + f.key + Math.round(f.x);
    if (f.key === 'photo') {
      const r = f.shape === 'circle' ? Math.min(f.w, f.h) / 2 : 0; const rr = f.shape === 'rounded' ? Math.min(f.w, f.h) * 0.08 : 0;
      g += `<defs><clipPath id="ph${fid}">${f.shape === 'circle' ? `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r)}"/>` : `<rect x="${r1(f.x)}" y="${r1(f.y)}" width="${r1(f.w)}" height="${r1(f.h)}" rx="${r1(rr)}"/>`}</clipPath></defs>`;
      if (!o.laser) g += f.shape === 'circle' ? `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r + 10)}" fill="url(#gold${uid})"/>` : `<rect x="${r1(f.x - 8)}" y="${r1(f.y - 8)}" width="${r1(f.w + 16)}" height="${r1(f.h + 16)}" rx="${r1(rr + 6)}" fill="url(#gold${uid})"/>`;
      const lift = data.photo && !o.laser ? brightFilter(uid, data.photo_crop) : ''; if (lift) g += '<defs>' + lift + '</defs>';
      g += data.photo ? `<g${o.laser ? ` filter="url(#gray2${uid})"` : ''}>${photoImg(data.photo, data.photo_crop, cx, cy, f.w, f.h, 'ph' + fid, lift ? ` filter="url(#lift${uid})"` : '')}</g>` : rect(f.x, f.y, f.w, f.h, '#E9ECF3') + icon('person', cx, cy, Math.min(f.w, f.h) * 0.6, '#AEB6C8', true);
      if (o.laser) continue;
      if (design.show.micro) {
        const ring = f.shape === 'circle' ? `M${r1(cx - r - 5)} ${r1(cy)}a${r1(r + 5)} ${r1(r + 5)} 0 1 1 ${r1(2 * (r + 5))} 0a${r1(r + 5)} ${r1(r + 5)} 0 1 1 ${r1(-2 * (r + 5))} 0` : `M${r1(f.x - 4)} ${r1(f.y - 3)}H${r1(f.x + f.w + 4)}V${r1(f.y + f.h + 4)}H${r1(f.x - 4)}Z`;
        let mt = ''; while (mt.length < 300) mt += (data.full_name || '') + ' • ' + (data.number || '') + ' • ' + (s.serial || '') + ' • ';
        g += `<path id="pr${fid}" d="${ring}" fill="none"/><text class="fm" font-size="11" font-weight="700" fill="${c.ink}" fill-opacity="0.75" letter-spacing="0.6"><textPath href="#pr${fid}">${esc(mt.slice(0, 300))}</textPath></text>`;
      }
      if (design.show.photo_lines) { const rnd = rng(seed ^ 0x5bd1e995); let d = ''; for (let n = 0; n < 5; n++) { const ph = rnd() * 6.28, amp = f.h * (0.02 + rnd() * 0.02), base = f.y + f.h * (0.68 + n * 0.05); let p = ''; for (let x = f.x - f.w * 0.1; x <= f.x + f.w * 1.1; x += 12) p += (p ? 'L' : 'M') + Math.round(x) + ' ' + Math.round(base + amp * Math.sin(x * 0.02 + ph)); d += p; } g += `<path class="ubid-xlines" d="${d}" fill="none" stroke="${c.gold}" stroke-opacity="0.6" stroke-width="1.4"/>`; }
      if (design.show.holo && !fields.some(x => x.key === 'holo')) { const hr = Math.max(50, Math.min(f.w, f.h) * 0.17); g += holoPatch(uid, r1(f.x + hr * 0.4), r1(f.y + f.h - hr * 0.4), r1(hr), initialsOf(t.name) || 'ID', (t.name || '') + ' • ' + one(design, 'authentic') + ' • ', !!s.digital); }
      continue;
    }
    if (o.laser && !['surname', 'other_names', 'full_name', 'number', 'unit', 'level', 'session', 'position', 'serial', 'ghost'].includes(f.key)) continue;
    if (f.key === 'holo') { if (design.show.holo) g += holoPatch(uid, r1(cx), r1(cy), r1(Math.min(f.w, f.h) / 2), initialsOf(t.name) || 'ID', (t.name || '') + ' • ' + one(design, 'authentic') + ' • ', !!s.digital); continue; }
    if (f.key === 'qr_front' || f.key === 'qr_back') { const sz = Math.min(f.w, f.h); g += `<rect x="${r1(cx - sz / 2)}" y="${r1(cy - sz / 2)}" width="${r1(sz)}" height="${r1(sz)}" rx="8" fill="#FFFFFF"/>` + qrSvg(f.key === 'qr_front' ? s.qr_front : s.qr_back, cx - sz / 2, cy - sz / 2, sz, Math.max(6, sz * 0.04), f.key === 'qr_back' ? 'L' : 'M'); continue; }
    if (f.key === 'barcode') { g += rect(f.x, f.y, f.w, f.h, '#FFFFFF') + barcodeSvg(s.barcode || s.serial || data.number, cx, f.y + f.h * 0.08, f.h * 0.66, 6, f.w * 0.98) + T(cx, f.y + f.h * 0.96, codeText(s.barcode || s.serial || ''), { font: 'M', size: f.h * 0.18, weight: 600, color: '#141A2E', anchor: 'middle', maxW: f.w * 0.94 }); continue; }
    if (f.key === 'signature') { if (data.signature) g += `<image href="${data.signature}" x="${r1(f.x)}" y="${r1(f.y)}" width="${r1(f.w)}" height="${r1(f.h)}" preserveAspectRatio="xMidYMid meet"/>`; continue; }
    if (f.key === 'image') { if (f.src && !o.laser) g += `<image href="${f.src}" x="${r1(f.x)}" y="${r1(f.y)}" width="${r1(f.w)}" height="${r1(f.h)}" preserveAspectRatio="xMidYMid meet"/>`; continue; }
    if (f.key === 'ghost') { if (design.show.ghost && data.photo) g += `<defs><clipPath id="gh${fid}"><ellipse cx="${r1(cx)}" cy="${r1(cy)}" rx="${r1(f.w / 2)}" ry="${r1(f.h / 2)}"/></clipPath></defs><g class="ubid-ghost" opacity="${o.laser ? 0.6 : 0.28}" filter="url(#gray2${uid})">${photoImg(data.photo, data.photo_crop, cx, cy, f.w, f.h, 'gh' + fid)}</g>`; continue; }
    if (f.key === 'session_tab') { if (design.show.session_tab && data.session) { const sc = sessionColor(data.session); if (sc) { const anim = s.digital ? `<animate attributeName="x1" values="0;1;0" dur="4s" repeatCount="indefinite"/>` : ''; g += `<defs><linearGradient id="ovi${fid}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${sc.hex}"/><stop offset="0.45" stop-color="${sc.hex}"/><stop offset="0.5" stop-color="${sc.shift}"/><stop offset="0.55" stop-color="${sc.hex}"/><stop offset="1" stop-color="${sc.hex}"/>${anim}</linearGradient></defs><g class="ubid-session"><rect x="${r1(f.x)}" y="${r1(f.y)}" width="${r1(f.w)}" height="${r1(f.h)}" rx="${r1(Math.min(f.w, f.h) * 0.2)}" fill="url(#ovi${fid})"/>` + T(cx, cy + f.h * 0.18, data.session, { font: 'O', size: f.h * 0.5, weight: 600, color: '#FFFFFF', anchor: 'middle', track: 30, maxW: f.w * 0.9 }) + '</g>'; } } continue; }
    if (f.key === 'ir') { if (design.show.ir && !s.digital && s.serial) g += `<text class="ubid-ir fm" x="${r1(f.x)}" y="${r1(f.y + f.h * 0.8)}" font-size="${r1(f.size || f.h * 0.72)}" font-weight="700" fill="#000000" letter-spacing="3">${esc('IR • ' + s.serial + ' • ' + (data.number || ''))}</text>`; continue; }
    const val = fieldValue(design, data, s, f, k); if (!val && !f.label) continue;
    if (f.plate && !o.laser) { const top = f.stack ? f.y - Math.max(14, (f.size || f.h * 0.72) * 0.42) - 14 : f.y - 6; g += `<rect x="${r1(f.x - 12)}" y="${r1(top)}" width="${r1(f.w + 24)}" height="${r1(f.y + f.h + 6 - top)}" rx="14" fill="#FFFFFF" fill-opacity="0.86"/>`; }
    const anchor = f.align || 'start'; const ax = anchor === 'middle' ? cx : anchor === 'end' ? f.x + f.w : f.x;
    const size = f.size || f.h * 0.72; const col = o.laser ? '#000000' : f.color || c.value;
    // 👁 readable on the uploaded artwork, whatever is behind the box: a halo of the opposite tone (design.halo === false: none)
    const hal = o.laser || design.halo === false || f.plate ? null : (lum(col) > 0.5 ? '#0B1534' : '#FFFFFF');
    const lk = f.key === 'number' ? (k === 'student' ? 'matric' : 'staff_no') : FIELD_LABEL[f.key];
    const labTxt = labOf(f); void lk;
    // CAPITALS off: the name as typed (Title Case when it was typed all in one case)
    const rawV = f.upper === false && data.raw && typeof data.raw[f.key] === 'string' && data.raw[f.key].trim() && String(val) === String(val).toUpperCase() ? asTyped(data.raw[f.key]) : null;
    const shown = f.upper === false ? (rawV || val) : String(val).toUpperCase(); const lsize = Math.max(14, size * 0.42);
    if (f.label && labTxt && !o.laser && anchor === 'start' && !f.stack) {
      // INLINE: the label, then the value in front of it on the same line — the value shrinks (or wraps) to fit what is left
      const lw = colW[Math.round(f.x / 40)] || Math.min(f.w * 0.42, estWidth(labTxt + ' ', 'M', lsize, 10, 600) + 18);
      g += T(f.x, f.y + f.h / 2 + lsize * 0.36, labTxt, { font: 'M', size: lsize, weight: 600, color: f.color ? f.color : c.label, track: 10, maxW: lw - 10, halo: hal });
      g += fitText(f.x + lw, f.y + f.h / 2, shown, { font: 'M', size, minSize: size * 0.55, weight: f.weight || 700, color: col, maxW: f.w - lw, lines: f.h >= size * 1.9 ? 2 : 1, halo: hal });
    } else {
      if (f.label && labTxt && !o.laser) g += T(ax, f.y - size * 0.12, labTxt, { font: 'M', size: lsize, weight: 600, color: f.color ? f.color : c.label, anchor, track: 10, maxW: f.w, halo: hal });
      g += anchor === 'start' ? fitText(f.x, f.y + f.h / 2, shown, { font: 'M', size, minSize: size * 0.55, weight: f.weight || 700, color: col, maxW: f.w, lines: f.h >= size * 1.9 ? 2 : 1, halo: hal })
        : T(ax, f.y + f.h * 0.8, shown, { font: 'M', size, weight: f.weight || 700, color: col, anchor, maxW: f.w, halo: hal });
    }
  }
  if (!o.laser) {
    if (s.digital) g += `<g transform="rotate(-24 ${gw / 2} ${gh / 2})" opacity="0.16"><text x="${gw / 2}" y="${gh / 2 + 60}" class="fm" font-size="${r1(Math.min(gw, gh) * 0.16)}" font-weight="800" fill="${c.navy}" text-anchor="middle" letter-spacing="14">${esc(one(design, 'digital_copy'))}</text></g>`;
    if (s.specimen) g += `<g transform="rotate(-24 ${gw / 2} ${gh / 2})" opacity="0.16"><text x="${gw / 2}" y="${gh / 2 + 60}" class="fm" font-size="${r1(Math.min(gw, gh) * 0.16)}" font-weight="800" fill="#B3262C" text-anchor="middle" letter-spacing="14">${esc(one(design, 'specimen'))}</text></g>`;
    if (s.status && s.status !== 'active') g += `<g transform="rotate(-24 ${gw / 2} ${gh / 2})" opacity="0.16"><text x="${gw / 2}" y="${gh / 2 + 60}" class="fm" font-size="${r1(Math.min(gw, gh) * 0.16)}" font-weight="800" fill="#B3262C" text-anchor="middle" letter-spacing="14">${esc(String(s.status).toUpperCase())}</text></g>`;
  }
  return g + '</svg>';
}
/** Where each security feature sits on a side (the desk's "show the security features" overlay, the inspector's guide). */
function securityMap(design0, side) {
  const design = design0 && design0.colors ? design0 : normalizeDesign(design0); const out = [];
  const add = (k, name, x, y, w, h) => out.push({ k, name, x: r1(x), y: r1(y), w: r1(w), h: r1(h) });
  if (design.mode === 'image') {
    const [gw, gh] = gridOf(design); const F = (design.fields || []).filter(f => f.side === side);
    const NAMES = { photo: 'Photo — microtext round it, lines across it', qr_front: 'Signed link QR (print number)', qr_back: 'Signed credential QR (checked offline)', barcode: 'Barcode — serial + print number', csc: 'Security code (this print only)', ghost: 'Ghost image', session_tab: 'Session colour tab (colour-shift)', ir: 'Infrared-only text', holo: 'Holographic medallion', serial: 'Card serial (check character)' };
    for (const f of F) if (NAMES[f.key]) add(f.key, NAMES[f.key], f.x, f.y, f.w, f.h);
    if (side === 'front') { const p = F.find(f => f.key === 'photo'); if (p && !F.some(f => f.key === 'holo')) { const hr = Math.max(50, Math.min(p.w, p.h) * 0.17); add('holo', 'Holographic medallion', p.x - hr * 0.6, p.y + p.h - hr * 1.4, hr * 2, hr * 2); } }
    add('guilloche', 'Guilloche ribbon + rosette', 8, gh * 0.12, 50, gh * 0.78); add('micro', 'Microtext band', 0, gh - 20, gw, 18);
    if (side === 'front') add('pantograph', 'Void pantograph — COPY appears on a photocopy', gw * 0.02, gh * 0.25, gw * 0.3, gh * 0.2);
    return out;
  }
  if (side === 'front') {
    add('micro', 'Microtext (institution · number · serial)', 0, 284, W, 16); add('micro', 'Micro-rule (a line of microtext)', 116, 458, 789, 14);
    add('guilloche', 'Guilloche ribbon + rosette', 26, 300, 72, 775); add('session_tab', 'Session colour tab (colour-shift)', 1932, 300, 90, 560);
    add('photo_ring', 'Microtext round the photo', 1298, 386, 588, 588); add('photo_lines', 'Lines across the photo', 1292, 790, 600, 140);
    add('holo', 'Holographic medallion', 1270, 803, 204, 204); add('ghost', 'Ghost image', 1149, 904, 112, 128);
    add('qr', 'Signed link QR (print number)', 1812, 884, 154, 154); add('ir', 'Infrared-only text', 470, 1100, 860, 32);
    add('pantograph', 'Void pantograph — COPY appears on a photocopy', 120, 500, 360, 160);
  } else {
    add('barcode', 'Barcode — serial + print number', 160, 390, 870, 180); add('qr', 'Signed credential QR (checked offline)', 150, 676, 232, 232);
    add('csc', 'Security code + print number (this print only)', 405, 856, 640, 32); add('ghost', 'Ghost image', 872, 934, 116, 132);
    add('micro', 'Microtext + micro-rules', 0, 284, W, 16); add('guilloche', 'Guilloche ribbons', 26, 300, 86, 775);
  }
  return out;
}
/** The overlay itself: numbered boxes round each feature (drawn over the card in the desk). */
function renderSecurityMap(design0, side) {
  const design = design0 && design0.colors ? design0 : normalizeDesign(design0); const [gw, gh] = gridOf(design); const list = securityMap(design, side);
  let g = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${gw} ${gh}" class="ubid-side ubid-secmap" preserveAspectRatio="xMidYMid meet"><defs>${STYLE}</defs>`;
  list.forEach((b, i) => { g += `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#E11D48" fill-opacity="0.07" stroke="#E11D48" stroke-width="5" stroke-dasharray="16 10" rx="10"/><circle cx="${r1(b.x + 6)}" cy="${r1(b.y + 6)}" r="30" fill="#E11D48"/><text x="${r1(b.x + 6)}" y="${r1(b.y + 17)}" class="fm" font-size="32" font-weight="800" fill="#FFFFFF" text-anchor="middle">${i + 1}</text>`; });
  return { svg: g + '</svg>', list };
}
/** The prompt the AI reads an IMAGE template with: where the photo, the data and the codes go (fractions of the image). */
const LAYOUT_PROMPT = `You are reading a photo of a university IDENTITY CARD TEMPLATE side. Find WHERE each item goes. Answer STRICT JSON only:
{"orientation":"landscape","fields":[{"key":"photo","x":0,"y":0,"w":0,"h":0,"shape":"rounded"}]}
Keys you may use: photo, surname, other_names, full_name, number (the matric / staff number), unit (department or course), faculty_line, level, session, position, issued, valid_through (expiry), blood_group, emergency_phone, emergency_name, signature, qr_front, qr_back, barcode, title.
x, y, w, h = the box where the VALUE is written (not its printed label), as FRACTIONS of the image (0..1). shape for photo: circle | rounded | rect. Only items the template has a place for. JSON only.`;

// ───────────────────────────────────────────────────────────────────────────── the ID-card fee invoice (desk + portal)
/** A printable ID-card fee invoice — one A4 page each: what is owed, for which session, how to pay, and that the card follows the
 *  payment. items = [{ inv, matric, dep, lvl, expires }] · ctx = { name, address, logo, portal, money(amount, currency) }. */
function invoiceHtml(items, ctx) {
  const c = ctx || {}; const money = c.money || ((a, cur) => (cur || '') + ' ' + Number(a || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const qr = (text) => { if (!QR || !text) return ''; try { const m = QR.encode(String(text), 'M'); let p = ''; for (let r = 0; r < m.n; r++) for (let cc = 0; cc < m.n; cc++) if (m.isDark(r, cc)) p += 'M' + cc + ' ' + r + 'h1v1h-1z'; return '<svg viewBox="-2 -2 ' + (m.n + 4) + ' ' + (m.n + 4) + '" width="110" height="110"><rect x="-2" y="-2" width="' + (m.n + 4) + '" height="' + (m.n + 4) + '" fill="#fff"/><path d="' + p + '" fill="#000" shape-rendering="crispEdges"/></svg>'; } catch (_) { return ''; } };
  const STAMP = { paid: ['PAID', '#15803d'], waived: ['WAIVED', '#15803d'], cancelled: ['CANCELLED', '#64748b'] };
  const page = (it) => {
    const inv = it.inv || {}; const [st, col] = STAMP[inv.status] || ['UNPAID', '#b91c1c'];
    const item = inv.purpose === 'replacement' ? 'Replacement student ID card' + (inv.reason ? ' — ' + inv.reason : '') : 'Student ID card — valid for the ' + (inv.session_name || '') + ' session only' + (it.expires ? ' (expires ' + it.expires + ')' : '');
    return '<section class="pg"><header>' + (c.logo ? '<img src="' + c.logo + '" alt="">' : '') + '<div><h1>' + esc(c.name || '') + '</h1><div class="m">' + esc(c.address || '') + '</div></div><div class="stamp" style="color:' + col + ';border-color:' + col + '">' + st + '</div></header>'
      + '<h2>ID CARD FEE INVOICE</h2><table class="kv"><tr><th>Invoice no.</th><td><b>' + esc(inv.invoice_no) + '</b></td><th>Date</th><td>' + esc(String(inv.created_at || '').slice(0, 10)) + '</td></tr><tr><th>Session</th><td>' + esc(inv.session_name || '') + '</td><th>Due</th><td>' + esc(inv.due_date || '') + '</td></tr></table>'
      + '<h3>Bill to</h3><table class="kv"><tr><th>Student</th><td><b>' + esc(inv.holder_name) + '</b></td><th>Matric no.</th><td>' + esc(inv.holder_number || it.matric || '') + '</td></tr><tr><th>Department</th><td>' + esc(it.dep || '') + '</td><th>Level</th><td>' + esc(it.lvl || '') + '</td></tr></table>'
      + '<table class="items"><tr><th>Description</th><th class="r">Amount</th></tr><tr><td>' + esc(item) + '</td><td class="r">' + esc(money(inv.amount, inv.currency)) + '</td></tr><tr class="tot"><td>Total due</td><td class="r">' + esc(money(['paid', 'waived', 'cancelled'].includes(inv.status) ? 0 : inv.amount, inv.currency)) + '</td></tr></table>'
      + (inv.status === 'paid' ? '<p class="ok">Paid on ' + esc(String(inv.paid_at || '').slice(0, 10)) + (inv.payment_ref ? ' — receipt ' + esc(inv.payment_ref) : '') + '.</p>' : '')
      + '<div class="how"><div><h3>How to pay</h3><ol><li><b>Online</b> — sign in to the student portal or the app → <i>Profile → My ID card → Pay my ID card fee</i>, or <i>Fees &amp; Payments → ID Card Fee</i>' + (c.portal ? ' (' + esc(c.portal) + ')' : '') + '.</li><li><b>At the Bursary</b> — quote the invoice number <b>' + esc(inv.invoice_no) + '</b>.</li></ol>'
      + '<p>Your ID card is issued as soon as the payment is confirmed: you are notified, the card appears on your profile on the portal and the app, and the ID card office prints the physical card. A student ID card is valid for <b>one session</b> and expires when the session ends.</p></div>' + (c.portal ? '<div class="qr">' + qr(c.portal) + '<div>Pay online</div></div>' : '') + '</div>'
      + '<footer>Billed by ' + esc(inv.created_by || 'the ID card office') + ' · ' + esc(c.name || '') + ' · ID card office</footer></section>';
  };
  const css = '*{box-sizing:border-box}body{margin:0;font-family:Segoe UI,Arial,sans-serif;color:#0f172a}@page{size:A4;margin:14mm}.pg{page-break-after:always;break-after:page}.pg:last-child{page-break-after:auto}header{display:flex;gap:14px;align-items:center;border-bottom:3px solid #0E2048;padding-bottom:10px}header img{width:64px;height:64px;object-fit:contain}header h1{margin:0;font-size:20px}.m{color:#475569;font-size:12px}.stamp{margin-left:auto;border:3px solid;border-radius:8px;padding:6px 14px;font-weight:900;font-size:20px;letter-spacing:3px;transform:rotate(-6deg)}h2{margin:18px 0 8px;font-size:18px;letter-spacing:2px;color:#0E2048}h3{margin:14px 0 6px;font-size:14px}table{width:100%;border-collapse:collapse;font-size:13px}.kv th{text-align:left;color:#475569;font-weight:600;width:18%;padding:4px 6px}.kv td{padding:4px 6px}.items{margin-top:14px}.items th,.items td{border-bottom:1px solid #e2e8f0;padding:8px 6px;text-align:left}.items .r{text-align:right}.tot td{font-weight:800;font-size:15px;border-top:2px solid #0f172a}.ok{color:#15803d;font-weight:700}.how{display:flex;gap:18px;align-items:flex-start;margin-top:16px;background:#f8fafc;border-radius:10px;padding:10px 14px;font-size:13px}.how ol{margin:4px 0 6px 18px;padding:0}.qr{text-align:center;font-size:11px;color:#475569}footer{margin-top:22px;color:#64748b;font-size:11px;border-top:1px solid #e2e8f0;padding-top:6px}@media screen{body{background:#eef1f6;padding:16px}.pg{background:#fff;max-width:820px;margin:0 auto 16px;padding:20px;border-radius:12px;box-shadow:0 6px 22px rgba(2,6,23,.12)}}';
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ID card fee invoice</title><style>' + css + '</style></head><body>' + (items || []).map(page).join('') + '</body></html>';
}

const STYLE = `<style>.fm{font-family:'UB Montserrat',Montserrat,'Segoe UI',Arial,sans-serif}.fo{font-family:'UB Oswald',Oswald,'Arial Narrow',Impact,sans-serif}.fb{font-family:'UB Barlow','Barlow Semi Condensed','Arial Narrow',Arial,sans-serif}</style>`;
/** The UV (fluorescent) LAYER of the front — what a card printer's UV / F panel prints: the seal, the institution, the holder's number,
 *  the serial and the session, invisible in daylight, glowing under a UV lamp. opts.ink / opts.bg: black on white = the panel mask
 *  for the printer; a fluorescent colour on 'none' = the "under UV light" preview over the card. */
function renderUV(design0, data, sec, opts) {
  const design = design0 && design0.colors ? design0 : normalizeDesign(design0); const s = sec || {}; const o = opts || {}; const t = design.texts;
  const ink = o.ink || '#000000'; const bg = o.bg === undefined ? '#FFFFFF' : o.bg; const uid = 'u' + (Math.abs(seedOf(s.serial || data.number || 'x')) % 1e6).toString(36);
  const cx = 1011, cy = 690, R = 300;
  let g = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" class="ubid-side ubid-uv" preserveAspectRatio="xMidYMid meet"><defs>${STYLE}<path id="ut${uid}" d="M${cx - R * 0.8} ${cy}A${R * 0.8} ${R * 0.8} 0 0 1 ${cx + R * 0.8} ${cy}" fill="none"/><path id="ub${uid}" d="M${cx - R * 0.86} ${cy}A${R * 0.86} ${R * 0.86} 0 0 0 ${cx + R * 0.86} ${cy}" fill="none"/></defs>`;
  if (bg && bg !== 'none') g += rect(0, 0, W, H, bg);
  g += `<g fill="none" stroke="${ink}">` + [[1, 10], [0.94, 3], [0.66, 6], [0.6, 2]].map(([k, w]) => `<circle cx="${cx}" cy="${cy}" r="${r1(R * k)}" stroke-width="${w}"/>`).join('');
  let rays = ''; for (let i = 0; i < 48; i++) { const a = i / 48 * Math.PI * 2; rays += `M${r1(cx + R * 0.66 * Math.cos(a))} ${r1(cy + R * 0.66 * Math.sin(a))}L${r1(cx + R * 0.94 * Math.cos(a))} ${r1(cy + R * 0.94 * Math.sin(a))}`; }
  g += `<path d="${rays}" stroke-width="2"/></g>`;
  g += `<text class="fo" font-size="40" font-weight="600" fill="${ink}" letter-spacing="3"><textPath href="#ut${uid}" startOffset="50%" text-anchor="middle">${esc(String(t.name || '').slice(0, 44))}</textPath></text>`;
  g += `<text class="fo" font-size="34" font-weight="600" fill="${ink}" letter-spacing="6"><textPath href="#ub${uid}" startOffset="50%" text-anchor="middle">${esc(one(design, 'authentic') + ' • ' + (data.session || one(design, 'short_' + (KINDS[data.kind] ? data.kind : 'student'))))}</textPath></text>`;
  g += T(cx, cy + 40, initialsOf(t.name) || 'ID', { font: 'O', size: 150, weight: 600, color: ink, anchor: 'middle' });
  if (data.session) g += T(cx, cy + 120, data.session, { font: 'O', size: 54, weight: 600, color: ink, anchor: 'middle', track: 40 });
  g += T(110, 1200, data.number || '', { font: 'O', size: 80, weight: 600, color: ink, track: 30, maxW: 900 });
  if (s.serial) g += T(W - 110, 400, s.serial, { font: 'O', size: 54, weight: 600, color: ink, anchor: 'end', track: 30, maxW: 800 });
  return g + '</svg>';
}
/** The LASER layer (polycarbonate cards + a laser engraver): the personal data alone — photo in grey, names, number, serial — at the
 *  very places the colour card prints them, for the engraver to burn into the card (tactile, cannot be scraped off). */
function renderPersonal(design0, data0, sec) {
  const design = design0 && design0.colors ? design0 : normalizeDesign(design0);
  const data = data0 && data0.photo_print ? Object.assign({}, data0, { photo: data0.photo_print, photo_crop: null }) : data0;
  if (design.mode === 'image') return renderImageSide(design, data, sec || {}, { laser: true }, 'front'); const s = sec || {}; const k = KINDS[data.kind] ? data.kind : 'student';
  const uid = 'l' + (Math.abs(seedOf(s.serial || data.number || 'x')) % 1e6).toString(36);
  let g = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" class="ubid-side ubid-laser" preserveAspectRatio="xMidYMid meet"><defs>${STYLE}<filter id="g${uid}"><feColorMatrix type="saturate" values="0"/></filter><clipPath id="p${uid}"><circle cx="1592" cy="680" r="262"/></clipPath><clipPath id="q${uid}"><ellipse cx="1205" cy="968" rx="56" ry="64"/></clipPath></defs>` + rect(0, 0, W, H, '#FFFFFF');
  if (data.photo) g += `<g filter="url(#g${uid})">${photoImg(data.photo, data.photo_crop, 1592, 680, 524, 524, 'p' + uid)}${photoImg(data.photo, data.photo_crop, 1205, 968, 112, 128, 'q' + uid)}</g>`;
  const vals = k === 'student' ? [data.surname, data.other_names, data.unit, data.level, data.number, data.session] : [data.surname, data.other_names, data.position, data.unit, data.number, data.since];
  const VY = [556, 636, 739, 835, 914, 1017]; const two = [false, true, false, false, true, false];
  vals.forEach((v, i) => { g += T(two[i] ? 500 : 228, VY[i], v || '', { font: 'M', size: 46, color: '#000000', maxW: two[i] ? 770 : 1000 }); });
  if (s.serial) g += T(1540, 1031, one(design, 'card_no') + ' ' + s.serial, { font: 'M', size: 24, color: '#000000', anchor: 'middle', track: 20, maxW: 470 });
  return g + '</svg>';
}

// ───────────────────────────────────────────────────────────────────────────── pages
const FONT_FILES = [['UB Montserrat', 500, 'Montserrat-Medium.ttf'], ['UB Montserrat', 600, 'Montserrat-SemiBold.ttf'], ['UB Montserrat', 700, 'Montserrat-Bold.ttf'], ['UB Montserrat', 800, 'Montserrat-Bold.ttf'],
  ['UB Oswald', 600, 'Oswald-SemiBold.ttf'], ['UB Barlow', 500, 'BarlowSemiCondensed-Medium.ttf'], ['UB Barlow', 600, 'BarlowSemiCondensed-SemiBold.ttf'], ['UB Barlow', 700, 'BarlowSemiCondensed-Bold.ttf']];
function fontFaces(base) { return base ? FONT_FILES.map(([f, w, file]) => `@font-face{font-family:'${f}';font-weight:${w};font-style:normal;font-display:block;src:url('${base.replace(/\/$/, '')}/${file}') format('truetype')}`).join('') : ''; }
/** A printable page set. cards = [{ front, back, mag }] (SVG strings).
 *  layout 'cr80' — a CARD PRINTER: the page IS the card (85.6 × 53.98 mm, no margins); sides 'both' (front, back, front, back… — the
 *    printer's duplex flips each card), 'front' (all fronts), 'back' (all backs — the second pass on a single-sided printer; reverse
 *    puts them in the order the cards come back out of the hopper);
 *  layout 'a4' — an office / inkjet printer or a PVC-card TRAY: cards placed on the sheet where the tray holds them (o.sheet = left, top,
 *    gap_x, gap_y in mm, columns, rows), crop marks, fronts then the mirrored backs (duplex long edge);
 *  layout 'screen' — side by side.
 *  o.overscan (0–4 %) prints a hair past the card's edge, so an edge-to-edge printer leaves no white rim; o.rotateBack turns the
 *  backs 180° for a printer that flips the card the other way. Colours and backgrounds are always printed exactly. */
function cardHtml(cards, opts) {
  const o = opts || {}; const layout = ['cr80', 'a4', 'screen'].includes(o.layout) ? o.layout : 'cr80';
  const title = esc(o.title || 'ID cards'); const sides = ['front', 'back'].includes(o.sides) ? o.sides : 'both';
  const P = o.orientation === 'portrait'; const CW = P ? 53.98 : 85.6, CH = P ? 85.6 : 53.98;   // the card on the page: landscape (85.6 × 53.98) or portrait
  const k = 1 + Math.max(0, Math.min(4, Number(o.overscan) || 0)) / 100;
  const tf = (rot) => (rot || k !== 1 ? 'transform:' + (rot ? 'rotate(180deg) ' : '') + (k !== 1 ? 'scale(' + k + ')' : '') + ';transform-origin:50% 50%' : '');
  const base = '*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact}' + fontFaces(o.fontsBase)
    + '.ubid-side{display:block;width:100%;height:100%;image-rendering:auto}.fr .ubid-side{' + tf(false) + '}.bk .ubid-side{' + tf(!!o.rotateBack) + '}';
  const back = (c) => (c.back || '') + (c.mag ? '<div class="mag">~1' + esc(c.mag) + '</div>' : '');
  if (layout === 'cr80') {
    const list = sides === 'back' && o.reverse ? cards.slice().reverse() : cards;
    const pages = list.flatMap(c => sides === 'front' ? [[c.front, 'fr']] : sides === 'back' ? [[back(c), 'bk']] : [[c.front, 'fr'], [back(c), 'bk']]).filter(p => p[0]).map(([svg, cls]) => '<div class="pg ' + cls + '">' + svg + '</div>').join('');
    return '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title><style>' + base + '@page{size:' + CW + 'mm ' + CH + 'mm;margin:0}.pg{position:relative;width:' + CW + 'mm;height:' + CH + 'mm;overflow:hidden;page-break-after:always;break-after:page}.mag{position:absolute;left:1mm;bottom:0.5mm;font:2pt monospace;color:#fff}.pg:last-child{page-break-after:auto;break-after:auto}</style></head><body>' + pages + '</body></html>';
  }
  if (layout === 'a4') {
    const sh = sheetOf(o.sheet, P); const per = sh.cols * sh.rows; const PW = sh.page_w, PH = sh.page_h;
    const sheets = []; for (let i = 0; i < cards.length; i += per) sheets.push(cards.slice(i, i + per));
    const grid = (list, side) => '<div class="sheet">' + list.map((c, i) => { const col = i % sh.cols, row = Math.floor(i / sh.cols); const x = side === 'back' && sh.mirror_back ? sh.cols - 1 - col : col;
      return '<div class="cell ' + (side === 'back' ? 'bk' : 'fr') + '" style="left:' + r1(sh.left + x * (CW + sh.gap_x)) + 'mm;top:' + r1(sh.top + row * (CH + sh.gap_y)) + 'mm">' + (side === 'back' ? c.back : c.front) + '</div>'; }).join('') + '</div>';
    const marks = '.cell::before,.cell::after{content:"";position:absolute;border:0 solid #999}.cell::before{left:-3mm;top:-3mm;width:2mm;height:2mm;border-right-width:.2mm;border-bottom-width:.2mm}.cell::after{right:-3mm;bottom:-3mm;width:2mm;height:2mm;border-left-width:.2mm;border-top-width:.2mm}';
    const body = sheets.map(g => (sides !== 'back' ? grid(g, 'front') : '') + (sides !== 'front' ? grid(g, 'back') : '')).join('');
    return '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title><style>' + base + '@page{size:' + PW + 'mm ' + PH + 'mm;margin:0}.sheet{position:relative;width:' + PW + 'mm;height:' + (PH - 0.5) + 'mm;overflow:hidden;page-break-after:always;break-after:page}.sheet:last-child{page-break-after:auto;break-after:auto}.cell{position:absolute;width:' + CW + 'mm;height:' + CH + 'mm;overflow:' + (k !== 1 ? 'hidden' : 'visible') + '}' + (o.marks === false || !sh.marks ? '' : marks) + '</style></head><body>' + body + '</body></html>';
  }
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><style>' + base + 'body{background:#eef1f6;padding:16px;font-family:Segoe UI,Arial,sans-serif}.row{display:flex;flex-wrap:wrap;gap:16px;justify-content:center}.side{width:min(520px,100%);aspect-ratio:85.6/53.98;border-radius:14px;overflow:hidden;box-shadow:0 10px 30px rgba(2,6,23,.18);background:#fff}@media print{body{background:#fff;padding:0}.side{box-shadow:none;border-radius:0;width:85.6mm}}</style></head><body>' + cards.map(c => '<div class="row"><div class="side">' + c.front + '</div><div class="side">' + c.back + '</div></div>').join('<br>') + '</body></html>';
}
/** 🧺 PVC-CARD TRAYS and sheets an inkjet prints ID cards on — 2, 10 or more cards in one pass (fronts, then the backs). Each has the PAGE the
 *  printer feeds (A4, Letter, the disc tray's 120 mm page, or a custom size), the PAPER SOURCE that holds the PVC cards (a Canon "Disc Tray",
 *  an Epson "CD/DVD" tray — a regular expression matched against the driver's sources), and where each card sits (mm). Calibrate the
 *  left / top / gaps with the tray outline print (the holders differ a little from maker to maker). */
const TRAY_PRESETS = {
  a4_10: { name: 'A4 sheet — 10 cards (2 × 5), cut along the crop marks', page: 'A4', source: '', cols: 2, rows: 5, left: 16, top: 12, gap_x: 6.4, gap_y: 2.02, marks: true, pt: { quality: '^high$' } },
  // Canon: Feed = the Multi-purpose Tray, Media = Printable disc, Page = the tray's 120 × 120 mm page (the driver's own options — the classic
  // printing API does not even list that tray, so without them the printer pulls plain A4 from the cassette)
  canon_disc_2: { name: 'Canon PIXMA multi-purpose / disc tray + PVC card holder — 2 cards (TS70x, TS8xxx, TS9xxx, iX6xxx…)', page: 'disc', source: 'disc|cd|dvd|multi', cols: 1, rows: 2, left: 17.2, top: 4, gap_x: 0, gap_y: 4, marks: false,
    pt: { bin: 'multi-?purpose|multitray|cd|dvd|disc', size: 'multi-?purpose|multitray|120 ?x ?120', type: 'printable disc$|^disc|disc1|printable', quality: '^high$' } },
  epson_tray_10: { name: 'Epson L805 / L8050 / L18050 PVC card tray — 10 cards (CD/DVD tray)', page: 'A4', source: 'cd|dvd|disc', cols: 2, rows: 5, left: 18, top: 15, gap_x: 6, gap_y: 3, marks: false,
    pt: { bin: 'cd|dvd|disc', type: 'cd|dvd|disc', quality: '^high$|best|fine' } },
  // Epson's own Disc/ID Card tray: Paper Source "Disc/ID Card Tray", Paper Type "PVC ID Card (Borderless)" (Epson's L8050 user's guide) — two card slots
  epson_idtray_2: { name: 'Epson Disc/ID Card tray — 2 PVC cards (L8050, L18050, L8160, L8180, ET-18100)', page: 'disc', source: 'id ?card|disc|cd', cols: 1, rows: 2, left: 17.2, top: 4, gap_x: 0, gap_y: 4, marks: false,
    pt: { bin: 'disc ?/ ?id|id ?card|disc|cd', type: 'pvc id card \\(borderless\\)|pvc id card|id ?card', quality: '^high$|best|fine' } },
  custom: { name: 'Custom tray / sheet', page: 'A4', source: '', cols: 2, rows: 5, left: 16, top: 12, gap_x: 6.4, gap_y: 2.02, marks: true, pt: { quality: '^high$' } },
};
const PAGES = { A4: [210, 297], Letter: [215.9, 279.4], disc: [120, 120] };
/** 📚 PRINTERS THAT PRINT BOTH A4 PAPER AND PVC CARDS (an inkjet with a disc / ID-card tray) — the model → its tray, the settings its
 *  driver needs and how the tray is loaded. Sources: Canon TS700-series manual ("Placing a Printable Disc"), Brainstorm ID Supply's tray
 *  compatibility lists, Epson's L8050 / L8100 user's guides. Card printers (Zebra, Evolis, Fargo…) print the card itself; others print
 *  the cards on an A4 sheet with crop marks. */
const CANON_MP_STEPS = ['Put 2 INKJET-PRINTABLE PVC cards (CR80, coated) in the PVC card holder, printable side up — plain PVC does not hold ink.',
  'Press Print with NO tray in the printer — it would damage the printer.',
  'When the printer’s screen asks for the disc: take the multi-purpose tray off the back of the cassette (if you use it), push the cassette back in and press OK.',
  'Push the paper output tray all the way in.',
  'Lay the tray (with the cards) on the multi-purpose tray guide and slide it straight in until the arrows line up — not past them.',
  'Be quick: if the tray waits too long the printer ejects it and cancels the job — print again.',
  'The fronts print; turn the cards over in the holder and print the backs the same way.'];
const CANON_DISC_STEPS = ['Put 2 INKJET-PRINTABLE PVC cards (CR80, coated) in the PVC card tray, printable side up.',
  'Press Print with no tray in the printer.',
  'When the printer asks for the disc tray: open the front cover / lower the disc tray guide, slide the tray in along the guide until its marks line up, press OK.',
  'The fronts print; turn the cards over in the tray and print the backs.'];
const EPSON_ID_STEPS = ['Put the INKJET-PRINTABLE PVC cards printable side up in slot 1 and slot 2 of the Disc/ID Card tray.',
  'Press Print; when the printer asks, insert the tray (cards towards the printer) until its marks line up with the front of the printer.',
  'The tray comes out by itself after printing. If the ink pools on the card, lower the colour density in the printer’s preferences.'];
const EPSON_CD_STEPS = ['Put the INKJET-PRINTABLE PVC cards in the PVC card tray (it replaces the CD/DVD tray).',
  'Open the CD/DVD tray guide, then press Print; insert the tray when the printer asks, its marks lined up with the guide.'];
const PRINTER_KB = [
  { family: 'canon_mp', re: /canon.*\bts ?(70\d|82\d\d|83\d\d|88\d\d|95\d\d)\b/i, preset: 'canon_disc_2', cards: 2, tray: 'Multi-purpose tray (MP)', supported: true, steps: CANON_MP_STEPS,
    note: 'Canon TS70x / TS82xx / TS83xx / TS95xx: the multi-purpose tray with a PVC card holder (2 cards). The driver is set to Multi-purpose Tray · Printable disc · High.' },
  { family: 'canon_m', re: /canon.*\bts ?(80[2-5]\d|81\d\d|90[2-5]\d|91\d\d)\b/i, preset: 'canon_disc_2', cards: 2, tray: 'Disc tray M', supported: true, steps: CANON_DISC_STEPS,
    note: 'Canon TS80xx / TS81xx / TS90xx / TS91xx: the disc tray M with a PVC card holder (2 cards).' },
  { family: 'canon_l', re: /canon.*\bip ?87\d\d\b/i, preset: 'canon_disc_2', cards: 2, tray: 'Disc tray L', supported: true, steps: CANON_DISC_STEPS, note: 'Canon iP87xx: the disc tray L with a PVC card holder (2 cards).' },
  { family: 'canon_j', re: /canon.*\b(ip ?72\d\d|mg ?5[4-6]\d\d|mg ?6[3-6]\d\d|mg ?7[1-7]\d\d)\b/i, preset: 'canon_disc_2', cards: 2, tray: 'Disc tray J', supported: true, steps: CANON_DISC_STEPS,
    note: 'Canon iP72xx / MG54xx–MG77xx: the disc tray J with a PVC card holder (2 cards) — check the letter printed on your own disc tray.' },
  { family: 'epson_idtray', re: /epson.*\b(l ?8050|l ?18050|l ?81[68]0|et-? ?18100)\b/i, preset: 'epson_idtray_2', cards: 2, tray: 'Disc/ID Card tray', supported: true, steps: EPSON_ID_STEPS,
    note: 'Epson L8050 / L18050 / L8160 / L8180: Epson’s own Disc/ID Card tray — Paper Source “Disc/ID Card Tray”, Paper Type “PVC ID Card (Borderless)”.' },
  { family: 'epson_cd', re: /epson.*\b(l ?8[0-5][05]|l ?1800|r ?2[6-9]0|r ?3[0-9]0|t ?[56]0|p ?50|artisan ?(50|7\d\d|8\d\d|1430))\b/i, preset: 'epson_tray_10', cards: 10, tray: 'PVC card tray (CD/DVD slot)', supported: true, steps: EPSON_CD_STEPS,
    note: 'Older Epson CD/DVD printers (L800, L805, L850, R2x0, T50, P50, Artisan): a PVC card tray in the CD/DVD slot — check how many cards your tray holds and calibrate.' },
  { family: 'epson_xp_et', re: /epson.*\b(xp|et)-? ?\d{3,5}\b/i, preset: null, cards: 0, tray: '', supported: false, steps: [],
    note: 'No PVC card tray fits the Epson XP / ET (EcoTank) line — the driver will not print near the edge of a disc. Cards print on an A4 sheet with crop marks, or use a card printer.' },
];
/** The knowledge-base entry of a printer (by its name / driver) → { family, preset, cards, tray, supported, steps, note } or null. */
function printerModel(name, driver) { const s = [name, driver].filter(Boolean).join(' '); const k = PRINTER_KB.find(x => x.re.test(s)); return k ? { family: k.family, preset: k.preset, cards: k.cards, tray: k.tray, supported: k.supported, steps: k.steps.slice(), note: k.note } : null; }
/** Where a tray / an A4 sheet holds the cards (mm): the classic sheet is 2 × 5 cards from 16 mm left, 12 mm top. */
function sheetOf(x, portrait) {
  const v = x || {}; const n = (a, d, lo, hi) => (Number.isFinite(Number(a)) && a !== '' && a != null ? Math.max(lo, Math.min(hi, Number(a))) : d);
  const preset = TRAY_PRESETS[v.preset] ? v.preset : 'a4_10'; const d = TRAY_PRESETS[preset]; const plain = !v.preset || preset === 'a4_10';
  const page = ['A4', 'Letter', 'disc', 'custom'].includes(v.page) ? v.page : d.page;
  const [pw, ph] = page === 'custom' ? [n(v.page_w, 210, 50, 330), n(v.page_h, 297, 50, 480)] : PAGES[page];
  const cols = Math.round(n(v.cols, plain && portrait ? 3 : d.cols, 1, 4)), rows = Math.round(n(v.rows, plain && portrait ? 3 : d.rows, 1, 6));
  return { preset, name: d.name, page, page_w: pw, page_h: ph, source: String(v.source != null ? v.source : d.source).slice(0, 60), left: n(v.left, d.left, 0, 60), top: n(v.top, d.top, 0, 60),
    gap_x: n(v.gap_x, d.gap_x, 0, 30), gap_y: n(v.gap_y, d.gap_y, 0, 30), cols, rows, marks: v.marks != null ? !!v.marks : d.marks, mirror_back: v.mirror_back !== false,
    pt: Object.assign({}, d.pt || {}, v.media_type ? { type: String(v.media_type).slice(0, 80) } : {}), media_type: v.media_type ? String(v.media_type).slice(0, 80) : '' };
}
/** The card slots of a tray / sheet, in mm on its page: [{ x, y, w, h }] (cards landscape 85.6 × 53.98, or portrait). */
function traySlots(sheet, portrait) { const sh = sheet || sheetOf(); const CW = portrait ? 53.98 : 85.6, CH = portrait ? 85.6 : 53.98; const out = []; for (let r = 0; r < sh.rows; r++) for (let c = 0; c < sh.cols; c++) out.push({ x: r1(sh.left + c * (CW + sh.gap_x)), y: r1(sh.top + r * (CH + sh.gap_y)), w: CW, h: CH, col: c, row: r }); return out; }

// ───────────────────────────────────────────────────────────────────────────── the printer
/** What kind of printer this is, from its name / driver: a CARD printer (dye-sublimation / retransfer / laser — Zebra ZC/ZXP, Evolis,
 *  HID Fargo, Magicard, Entrust Datacard, IDP Smart, Matica, Swiftpro, Nisca, HiTi, DNP…), an INKJET that takes a PVC-card tray
 *  (Epson L800-series, Canon…), an ordinary OFFICE printer, or a VIRTUAL one (PDF, XPS, OneNote, fax). The card printer prints the
 *  card itself as the page; the others print an A4 sheet / tray. */
const P_VIRTUAL = /\bpdf\b|xps(?! ?card)|onenote|\bfax\b|send to|print to file|document writer|cutepdf|bullzip|anydesk|teamviewer/i;
const P_LABEL = /zebra.*\b(z[dt]\d|gk\d|gx\d|lp ?\d|tlp|zm\d|105sl|zq\d)|dymo|brother ql|tsc |godex|xprinter/i;
const P_CARD = /zebra.*\b(zc ?\d|zxp|p1\d\d|p3\d\d|p4\d\d|p5\d\d|p6\d\d)|zebra.*card|evolis|primacy|zenius|badgy|elypso|avansia|securion|fargo|\bdtc ?\d|\bhdp ?\d|\bhid\b|magicard|enduro|pronto|rio ?pro|ultra electronics|datacard|entrust|\bcd ?8\d0|\bsd ?[2-4]60|\bcr ?805|sigma ds|\bidp\b|smart-? ?\d{2}|matica|swiftpro|\bk[36]0\b|nisca|\bpr-?c\d|hiti.*cs|\bcs-? ?2\d0|dnp.*cx|cx-?d80|edisecure|\bxid ?\d|card ?printer|id ?card printer|seaory|dascom|\bdc-? ?3[23]00|pointman|nuvia|javelin|eltron|atlantek|\bcr-?80\b|pvc ?card|card ?machine/i;
const P_TRAY = /epson.*\b(l ?8\d{2}|l ?8\d{3}|l ?18\d{2,3}|t50|t60|r2\d0|r3\d0|p50|xp-?\d+|et-?\d+)|canon.*\b(pixma|ts ?\d|ip ?\d|g ?\d{3,4})|pvc|card ?tray/i;
const P_BRANDS = ['Zebra', 'Evolis', 'Fargo', 'HID', 'Magicard', 'Entrust', 'Datacard', 'IDP', 'Matica', 'Swiftpro', 'Nisca', 'HiTi', 'DNP', 'Epson', 'Canon', 'HP', 'Brother', 'Kyocera', 'Ricoh', 'Xerox', 'Lexmark', 'Samsung', 'Konica', 'Sharp', 'Microsoft'];
function classifyPrinter(p) {
  const o = (p && p.options) || {};
  const all = [p && p.name, p && p.displayName, p && p.description, o['printer-make-and-model'], o.driver, o['printer-info']].filter(Boolean).join(' ');
  const kind = P_VIRTUAL.test(all) ? 'virtual' : P_LABEL.test(all) ? 'label' : P_CARD.test(all) ? 'card' : P_TRAY.test(all) ? 'inkjet' : 'office';
  const brand = P_BRANDS.find(b => new RegExp('\\b' + b + '\\b', 'i').test(all)) || '';
  const dual = kind === 'card' && /dual|duplex|zc ?3[05]0|zxp ?[37]|primacy|avansia|dtc ?[45]|hdp|cd ?8\d0|sd ?[34]60|pronto|enduro|rio ?pro|smart-? ?[357]\d/i.test(all);
  return { kind, brand, layout: kind === 'card' ? 'cr80' : 'a4', dual_hint: dual, label: { card: 'Card printer', inkjet: 'Inkjet — PVC card tray / A4 sheet', office: 'Office printer — A4 sheet', label: 'Label printer — not for cards', virtual: 'Virtual printer (PDF / XPS)' }[kind] };
}
/** Is the printer ready? (Windows printer status flags) → { state, ok } — offline, out of cards, jam, ribbon out, door open… stop a job. */
const P_STATES = [[0x80, 'offline'], [0x10, 'out of cards / paper'], [0x8, 'card jam'], [0x40000, 'ribbon / ink empty'], [0x400000, 'cover open'], [0x100000, 'needs attention'], [0x1000, 'not available'], [0x2, 'error'], [0x1, 'paused']];
function printerState(status) { const n = Number(status) || 0; if (!n) return { state: 'ready', ok: true }; for (const [bit, s] of P_STATES) if (n & bit) return { state: s, ok: false }; return { state: n & 0x400 ? 'printing' : 'busy', ok: true }; }
/** What the printer's driver reports (Windows Win32_Printer / Win32_PrinterConfiguration) → the facts the job needs:
 *  has a card-sized paper (CR80 / ID card / 54 × 86), how the driver defines it (portrait / landscape), the resolution, duplex, colour. */
function printerFacts(cfg, prn) {
  const c = cfg || {}, p = prn || {};
  const w = Number(c.PaperWidth) || 0, l = Number(c.PaperLength) || 0;   // tenths of a millimetre
  const cardDefault = w > 0 && l > 0 && Math.abs(Math.min(w, l) - 540) <= 30 && Math.abs(Math.max(w, l) - 856) <= 30;
  const names = [].concat(p.PrinterPaperNames || []).map(String); const cardPaper = cardDefault || names.some(n => /cr-?\s?80|\bid[- ]?card|54(\.0)? ?x ?8[56]|8[56](\.\d)? ?x ?54|credit ?card|pvc ?card/i.test(n));
  const caps = [].concat(p.CapabilityDescriptions || []).map(String); const q = Number(c.PrintQuality) || 0;
  const ok = (v) => { const x = Number(v) || 0; return x > 0 && x <= 4800 ? x : 0; };   // a negative 'quality' comes back as a huge unsigned number
  const dpi = Math.max(ok(q), ok(p.HorizontalResolution), ok(c.YResolution)) || null;
  return { card_paper: cardPaper, card_default: cardDefault, paper: cardDefault ? (w > l ? 'landscape' : 'portrait') : null, paper_name: c.PaperSize || null, paper_mm: w && l ? [w / 10, l / 10] : null,
    orientation: Number(c.Orientation) === 2 ? 'landscape' : Number(c.Orientation) === 1 ? 'portrait' : null, dpi: dpi && dpi >= 150 ? dpi : null,
    duplex: caps.some(x => /duplex/i.test(x)) || !!c.Duplex, color: caps.some(x => /colou?r/i.test(x)) || Number(c.Color) === 2, papers: names.slice(0, 40) };
}
/** The EXACT settings a card job goes to the printer with (Electron webContents.print): on a card printer the page is the card —
 *  CR80 (53.98 × 85.6 mm) turned landscape, as card-printer drivers define it — no margins, no scaling; colours and backgrounds on;
 *  the printer's resolution; duplex for front + back; straight to the chosen printer (no dialog to reset the paper to A4). */
function cardPrintOptions(x0) {
  const x = x0 || {}; const card = x.layout !== 'a4'; const dpi = [300, 600, 1200].includes(Number(x.dpi)) ? Number(x.dpi) : 300;
  // the CR80 paper as the driver defines it: portrait (53.98 × 85.6 — most card printers) unless the printer reported it landscape;
  // a landscape card on portrait paper prints landscape, a portrait card prints upright
  const paperLand = x.paper === 'landscape'; const cardPortrait = x.orientation === 'portrait';
  const pageSize = !card ? 'A4' : paperLand ? { width: 85600, height: 53980 } : { width: 53980, height: 85600 };
  const landscape = card ? (paperLand ? cardPortrait : !cardPortrait) : false;
  const out = { silent: !x.dialog && !!x.printer, printBackground: true, color: x.mono ? false : true, margins: { marginType: 'none' }, scaleFactor: 100, dpi: { horizontal: dpi, vertical: dpi },
    copies: Math.max(1, Math.min(10, Math.round(Number(x.copies) || 1))), collate: true, pageSize, landscape, duplexMode: x.duplex ? (x.flip === 'short' ? 'shortEdge' : 'longEdge') : 'simplex' };
  if (x.printer) out.deviceName = String(x.printer);
  return out;
}
/** A CALIBRATION card (the back of the test card): edge frames 0 / 1 / 2 mm in (does the printer reach the edge?), colour and grey
 *  patches, microtext at three sizes, the anti-copy strengths 1–3 to photocopy, fine lines, a QR and a barcode to scan. */
function calibrationSvg(info) {
  const i = info || {}; let g = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" class="ubid-side" preserveAspectRatio="xMidYMid meet"><defs>' + STYLE + '</defs>' + rect(0, 0, W, H, '#FFFFFF');
  const mm = W / 85.6;
  [[0, '#B91C1C', '0 mm'], [mm, '#1565C0', '1 mm'], [2 * mm, '#2E7D32', '2 mm']].forEach(([d, c, l], n) => { g += '<rect x="' + r1(d + 2) + '" y="' + r1(d + 2) + '" width="' + r1(W - 2 * d - 4) + '" height="' + r1(H - 2 * d - 4) + '" fill="none" stroke="' + c + '" stroke-width="4"/>' + T(70 + n * 150, 110, l, { font: 'M', size: 30, color: c }); });
  g += '<path d="M' + (W / 2) + ' ' + (H / 2 - 40) + 'V' + (H / 2 + 40) + 'M' + (W / 2 - 40) + ' ' + (H / 2) + 'H' + (W / 2 + 40) + '" stroke="#000" stroke-width="2"/>';
  const pal = ['#00AEEF', '#EC008C', '#FFF200', '#000000', '#0E2048', '#C9A55A'].concat(SESSION_COLORS.map(c => c[0]));
  pal.forEach((c, n) => { g += rect(120 + n * 120, 170, 110, 110, c); });
  for (let n = 0; n < 10; n++) g += rect(120 + n * 120, 300, 110, 60, '#000', ' fill-opacity="' + ((n + 1) / 10) + '"');
  g += T(120, 410, 'MICROTEXT 0.30 · 0.40 · 0.57 · 0.68 mm', { font: 'M', size: 26, color: '#000' });
  g += '<clipPath id="calmt"><rect x="120" y="420" width="1780" height="90"/></clipPath><g clip-path="url(#calmt)">';
  [7, 9.5, 13.5, 16].forEach((sz, n) => { g += '<text x="120" y="' + (440 + n * 22) + '" class="fm" data-cal="1" font-size="' + sz + '" font-weight="800" fill="#000">' + esc(('AUTHENTIC • ' + (i.name || 'UNIVERSITY') + ' • ').repeat(12)) + '</text>'; });
  g += '</g>';
  [1, 2, 3].forEach((st, n) => { const x0 = 120 + n * 420; g += '<svg x="' + x0 + '" y="540" width="380" height="250" viewBox="0 290 2022 790" preserveAspectRatio="xMidYMid slice">' + pantograph('cal' + st, 'COPY', '#0E2048', st) + '</svg><rect x="' + x0 + '" y="540" width="380" height="250" fill="none" stroke="#999" stroke-width="2"/>' + T(x0, 820, 'ANTI-COPY ' + st, { font: 'M', size: 26, color: '#000' }); });
  [1.5, 2.4, 3.4, 4.5].forEach((w, n) => { g += '<path data-art="1" d="M1420 ' + (560 + n * 40) + 'H1880" stroke="#000" stroke-width="' + w + '"/>' + T(1890, 566 + n * 40, (Math.round(w * 25.4 / 600 * 100) / 100) + ' mm', { font: 'M', size: 18, color: '#000' }); });
  g += '<rect x="1650" y="880" width="260" height="260" fill="#fff"/>' + qrSvg('UB-TEST ' + (i.serial || ''), 1650, 880, 260, 8, 'M') + barcodeSvg(i.serial || 'UBTEST', 760, 1085, 95, 3);
  g += T(120, 900, 'PRINTER CALIBRATION', { font: 'O', size: 54, weight: 600, color: '#0E2048' }) + T(120, 960, [i.printer || 'printer', (i.dpi || 300) + ' dpi', i.stock || '', i.date || ''].filter(Boolean).join(' · '), { font: 'M', size: 28, color: '#334155', maxW: 1000 });
  g += T(120, 1020, 'Edges: the red frame should touch the card edge, the green one sit 2 mm in. Photocopy the anti-copy squares:', { font: 'B', size: 24, weight: 500, color: '#334155', maxW: 1450 }) + T(120, 1052, 'COPY should appear on the copy of the strength you choose, and stay hidden on the card.', { font: 'B', size: 24, weight: 500, color: '#334155', maxW: 1450 });
  return g + '</svg>';
}

// ───────────────────────────────────────────────────────────────────────────── 🖨 PRINT QUALITY — what each kind of printer can lay down
/** The MEDIA a card is printed on, and what it can reproduce (600 dpi units: 1 px = 0.042 mm). An inkjet on coated PVC spreads each
 *  drop ~0.06 mm, so a 0.05 mm line or a 0.3 mm letter smears away: lines are thickened (≥ 0.14 mm) and darkened, microtext is set
 *  at ≥ 0.57 mm in heavy weight (a loupe still reads it), the ghost photo and the holographic medallion are strengthened, and the
 *  anti-copy DOT screen (which an inkjet cannot hold — its hidden word shows as specks) becomes a LATENT LINE image (same tone, the
 *  word in lines at another angle: it shows when the card is tilted or copied). A card printer (dye-sublimation) keeps fine detail. */
const PRINT_MEDIA = {
  card: { name: 'Card printer (dye-sublimation / retransfer)', line: 2.2, lineOp: 0.7, rule: 2.4, ruleDarken: 0.12, micro: 10.5, microW: 700, ghost: 0.3, holo: 0.78, rosette: 0.14, void: 'keep', voidOp: 0, label: 0.1, spread: 0.6 },
  office: { name: 'Office printer (laser) — A4 sheet', line: 2.4, lineOp: 0.8, rule: 2.6, ruleDarken: 0.18, micro: 11.5, microW: 700, ghost: 0.32, holo: 0.85, rosette: 0.13, void: 'keep', voidOp: 0, label: 0.15, spread: 0.9 },
  inkjet_paper: { name: 'Inkjet — A4 sheet', line: 2.8, lineOp: 0.82, rule: 3, ruleDarken: 0.22, micro: 12.5, microW: 800, ghost: 0.36, holo: 0.88, rosette: 0.14, void: 'off', voidOp: 0, label: 0.2, spread: 1.1 },
  inkjet_pvc: { name: 'Inkjet — PVC cards on a tray', line: 3, lineOp: 0.85, rule: 3.2, ruleDarken: 0.28, micro: 13.5, microW: 800, ghost: 0.38, holo: 0.92, rosette: 0.15, void: 'off', voidOp: 0, label: 0.25, spread: 1.4 },
};
/** The COLOUR LOOK of each media (applied to the card's image before it goes to the driver): an inkjet on PVC prints pale with
 *  brownish greys through its disc driver (Canon TS70x users report it), so colour is lifted, contrast deepened around mid-grey (white
 *  stays white — no ink), the greys neutralised and the edges sharpened. presets: natural · vivid (the default) · extra. */
const PRINT_LOOKS = {
  card: { sat: 1.06, contrast: 1.04, bright: 1, sharpen: 0.5, warm: 0 },
  office: { sat: 1.05, contrast: 1.06, bright: 1, sharpen: 0.6, warm: 0 },
  inkjet_paper: { sat: 1.12, contrast: 1.07, bright: 0.99, sharpen: 0.7, warm: 0 },
  inkjet_pvc: { sat: 1.22, contrast: 1.1, bright: 0.98, sharpen: 0.8, warm: -4 },
};
/** The media of a printer: a card printer → 'card'; an inkjet printing on its PVC tray → 'inkjet_pvc'; an inkjet on A4 → 'inkjet_paper';
 *  an office (laser) printer → 'office'; a virtual one (PDF) → 'screen' (nothing changed). */
function mediaFor(printer, tuned, layout) {
  const p = printer || {}; const t = tuned || {};
  if (p.kind === 'virtual' || !p.kind) return 'screen';
  if (p.kind === 'card' || t.kind === 'card') return 'card';
  if ((p.tray || t.tray_preset) && layout !== 'paper') return 'inkjet_pvc';
  if (p.kind === 'inkjet' || t.kind === 'inkjet') return 'inkjet_paper';
  return 'office';
}
/** The look in numbers: the media's preset (natural ×0.5 · vivid · extra ×1.5) adjusted by the office's sliders (each −50…+50). */
function lookFor(media, u) {
  const base = PRINT_LOOKS[media]; if (!base) return null; const x = u || {}; const k = x.preset === 'natural' ? 0.5 : x.preset === 'extra' ? 1.5 : 1;
  const n = (v) => Math.max(-50, Math.min(50, Number(v) || 0)) / 100;
  return { preset: ['natural', 'extra'].includes(x.preset) ? x.preset : 'vivid', sat: Math.max(0.5, 1 + (base.sat - 1) * k + n(x.saturation) * 0.8), contrast: Math.max(0.7, 1 + (base.contrast - 1) * k + n(x.contrast) * 0.6),
    bright: Math.max(0.6, base.bright + n(x.brightness) * 0.4), warm: base.warm * k + n(x.warmth) * 30, sharpen: Math.max(0, base.sharpen * (k > 1 ? 1.15 : k < 1 ? 0.8 : 1) + n(x.sharpness) * 1.2) };
}
const hexRgb = (h) => [1, 3, 5].map(i => parseInt(String(h).slice(i, i + 2), 16));
function lum(h) { const c = hexRgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
function shade(h, k) { return '#' + hexRgb(h).map(v => Math.round(v * (1 - k)).toString(16).padStart(2, '0')).join('').toUpperCase(); }
/** The contrast ratio of two colours (WCAG): 1 … 21 — text needs ≥ 4.5 to be read easily, ≥ 3 when large. */
function contrastRatio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
/** 🖨 TUNE A CARD SIDE (SVG) FOR ITS PRINTER — see PRINT_MEDIA. Only the print job is changed; the design, the screen and the PDF keep
 *  their fine detail. */
function printTune(svg, media) {
  const m = PRINT_MEDIA[media]; if (!m || !svg) return svg;
  let s = String(svg);
  // the line art: every thin stroke at least the media's line, and not faint
  s = s.replace(/<(path|circle|ellipse|line|polyline|polygon|rect|g)\b([^>]*)>/g, (all, tag, attrs) => {
    let a = attrs; const sw = /\sstroke-width="([\d.]+)"/.exec(a);
    if (/\sdata-art="1"/.test(a)) return all;   // decoration (the swoosh), not security line art
    if (sw && Number(sw[1]) > 0 && Number(sw[1]) < m.line) {
      a = a.replace(/\sstroke-width="[\d.]+"/, ' stroke-width="' + m.line + '"');
      a = a.replace(/\sstroke-opacity="([\d.]+)"/, (x, v) => ' stroke-opacity="' + Math.max(Number(v), m.lineOp) + '"');
    }
    if (tag === 'rect') {   // a pale hairline rule (between the details) → thick and dark enough to print
      const h = /\sheight="([\d.]+)"/.exec(a), f = /\sfill="(#[0-9A-Fa-f]{6})"/.exec(a);
      if (h && f && Number(h[1]) > 0 && Number(h[1]) <= 3 && lum(f[1]) > 0.55) a = a.replace(/\sheight="[\d.]+"/, ' height="' + Math.max(Number(h[1]), m.rule) + '"').replace(f[0], ' fill="' + shade(f[1], m.ruleDarken) + '"');
    }
    return '<' + tag + a + '>';
  });
  // microtext: big enough for this printer, heavy, so a loupe reads it
  s = s.replace(/<text\b([^>]*\sdata-sec="micro"[^>]*)>/g, (all, attrs) => '<text' + attrs.replace(/\sfont-size="([\d.]+)"/, (x, v) => ' font-size="' + Math.max(Number(v), m.micro) + '"').replace(/\sfont-weight="\d+"/, ' font-weight="' + m.microW + '"') + '>');
  // the guilloche rosette, the ghost photos, the holographic medallion: strong enough to be seen on the card
  s = s.replace(/(class="ubid-rosette" opacity=")([\d.]+)"/g, (x, p, v) => p + Math.max(Number(v), m.rosette) + '"');
  s = s.replace(/(class="ubid-ghost" opacity=")([\d.]+)"/g, (x, p, v) => p + Math.max(Number(v), m.ghost) + '"');
  s = s.replace(/(fill="url\(#holo[^"]*\)" fill-opacity=")([\d.]+)"/g, (x, p, v) => p + Math.max(Number(v), m.holo) + '"');
  // the anti-copy screen: an inkjet / laser cannot hold the 0.03 mm dots → a latent LINE image of the same tone
  if (m.void === 'lines') {
    s = s.replace(/<pattern id="(pf[^"]+)" width="5" height="5" patternUnits="userSpaceOnUse">([\s\S]*?)<\/pattern>/g, (x, id, body) => { const ink = (/fill="(#[0-9A-Fa-f]{6})"/.exec(body) || [])[1] || '#0E2048'; return '<pattern id="' + id + '" width="9" height="9" patternUnits="userSpaceOnUse"><rect x="0" y="0" width="9" height="3.4" fill="' + ink + '"/></pattern>'; });
    s = s.replace(/<pattern id="(pc[^"]+)" width="10" height="10" patternUnits="userSpaceOnUse">([\s\S]*?)<\/pattern>/g, (x, id, body) => { const ink = (/fill="(#[0-9A-Fa-f]{6})"/.exec(body) || [])[1] || '#0E2048'; return '<pattern id="' + id + '" width="9" height="9" patternUnits="userSpaceOnUse"><rect x="0" y="0" width="3.4" height="9" fill="' + ink + '"/></pattern>'; });
    s = s.replace(/(class="ubid-void" opacity=")([\d.]+)"/g, (x, p) => p + m.voidOp + '"');
  }
  if (m.void === 'off') s = s.replace(/<g class="ubid-void"[^>]*>[\s\S]*?<\/g>/g, '');
  // labels in a mid tone (grey, pale navy, muted gold on white) a little darker — white text on dark bands and dark text are left alone
  s = s.replace(/<(text|tspan)\b([^>]*)\sfill="(#[0-9A-Fa-f]{6})"/g, (all, tag, attrs, f) => { const L = lum(f); return L > 0.12 && L < 0.55 ? '<' + tag + attrs + ' fill="' + shade(f, m.label) + '"' : all; });
  return s.replace('<svg ', '<svg data-media="' + media + '" ');
}
/** 🟩 The UV layer, VISIBLE — a printer with no UV panel: the seal's rings and rays, the initials and the session in fine
 *  fluorescent-green lines, the pattern a UV lamp would show (a true UV feature needs a UV-panel printer or UV-printed card stock). */
function uvVisible(design, data, cx, cy, R, ringsOnly) {
  const ink = '#7CB342'; let g = '<g class="ubid-uvv" opacity="' + (ringsOnly ? 0.18 : 0.24) + '"><g fill="none" stroke="' + ink + '">' + [[1, 3.2], [0.94, 2.4], [0.66, 2.8], [0.6, 2.4]].map(([k, w]) => '<circle cx="' + r1(cx) + '" cy="' + r1(cy) + '" r="' + r1(R * k) + '" stroke-width="' + w + '"/>').join('');
  let rays = ''; for (let i = 0; i < 48; i++) { const a = i / 48 * Math.PI * 2; rays += 'M' + r1(cx + R * 0.66 * Math.cos(a)) + ' ' + r1(cy + R * 0.66 * Math.sin(a)) + 'L' + r1(cx + R * 0.94 * Math.cos(a)) + ' ' + r1(cy + R * 0.94 * Math.sin(a)); }
  g += '<path d="' + rays + '" stroke-width="2.4"/></g>';
  if (ringsOnly) return g + '</g>';
  g += T(cx, cy + R * 0.14, initialsOf(design.texts.name) || 'ID', { font: 'O', size: R * 0.45, weight: 600, color: ink, anchor: 'middle' });
  if (data.session) g += T(cx, cy + R * 0.42, data.session, { font: 'O', size: R * 0.16, weight: 600, color: ink, anchor: 'middle', track: 20 });
  return g + '</g>';
}
/** 🛡 WHAT THIS PRINTER GIVES each security feature: printed · a visible equivalent printed (and what makes the real one) · needs a
 *  card stock / printer. prof: the office's print profile (uv panel, holographic laminate, chip / stripe stock, polycarbonate). */
function securityPlan(media, prof) {
  const p = prof || {}; const m = PRINT_MEDIA[media] || PRINT_MEDIA.office; const mm = (px) => (Math.round(px * 25.4 / 600 * 100) / 100) + ' mm';
  const row = (k, status, text) => { const f = SECURITY_FEATURES.find(x => x.k === k) || { name: k, layer: '' }; return { k, name: f.name, layer: f.layer, status, text }; };
  const inkjet = /inkjet|office/.test(media);
  return [
    row('guilloche', 'printed', 'Fine-line rosette and ribbons, drawn at ' + mm(m.line) + ' for this printer so they show on the card.'),
    row('micro', 'printed', 'Microtext at ' + mm(m.micro * 0.72) + ' letters in heavy weight — a solid line to the eye, a loupe reads it' + (inkjet ? ' (true microprint below 0.3 mm needs a card printer or offset).' : '.')),
    row('photo_lines', 'printed', 'Fine lines across the photo onto the card.'),
    row('ghost', 'printed', 'Ghost copies of the photo at ' + Math.round(m.ghost * 100) + ' % so they stay visible.'),
    row('ovi', 'printed', 'The session colour tab — a different colour every session.'),
    row('holo', p.holo_laminate ? 'printed' : 'equivalent', p.holo_laminate ? 'Printed iridescent medallion under a holographic laminate (the real optical hologram).' : 'A printed iridescent medallion over the photo edge, strengthened for print. For a TRUE hologram apply a holographic overlay (laminate pouch or patch) on the printed card.'),
    row('pantograph', m.void === 'keep' ? 'printed' : m.void === 'off' ? 'equivalent' : 'equivalent', m.void === 'keep' ? 'Anti-copy dot screen: the hidden word appears on a photocopy.' : m.void === 'off' ? 'An inkjet cannot hold the anti-copy dot screen (its hidden word would print as specks), so it is left out — copies are exposed instead by the signed QR code and the security code of each print.' : 'A latent line image is printed instead of the dot screen: the word shows when the card is tilted or copied.'),
    row('uv', p.uv ? 'printed' : 'equivalent', p.uv ? 'Printed with the UV (F) panel — glows under a UV lamp.' : (p.uv_visible === false ? 'Not printed (no UV panel) — turn on the visible UV pattern, or use UV-printed card stock / a UV-panel printer.' : 'No UV ink here: the UV seal (its rings and rays) is printed VISIBLY in fine green lines behind the details. For a true UV glow use UV-printed card stock, invisible-UV inkjet ink, or a printer with a UV (F) panel.')),
    row('ir', 'printed', 'The serial in pure black — carbon black (K) ink absorbs infrared, so an IR camera reads it. Printing must use the black ink (not grey made of colours).'),
    row('qr', 'printed', 'Signed QR codes — whole printer dots per module and a 4-module quiet zone, readable on any print.'),
    row('barcode', 'printed', 'Code 128 barcode of the serial.'),
    row('csc', 'printed', 'Security code bound to this print.'),
    row('chip', p.chip ? 'printed' : 'needs', p.chip ? 'Contactless chip bound after printing.' : 'Needs NFC / MIFARE card stock (the chip is in the card, not printed).'),
    row('mag', p.mag ? 'printed' : 'needs', p.mag ? 'Magnetic stripe encoded.' : 'Needs card stock with a magnetic stripe and an encoder.'),
    row('laser', p.laser ? 'printed' : 'needs', p.laser ? 'Laser-engraved on polycarbonate.' : 'Needs polycarbonate cards and a laser engraver.'),
  ];
}

// ───────────────────────────────────────────────────────────────────────────── security
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';        // Crockford: no I, L, O, U
function checkChar(body) { let sum = 0; const s = String(body).toUpperCase().replace(/[^0-9A-Z]/g, ''); for (let i = 0; i < s.length; i++) { const v = B32.indexOf(s[i]) >= 0 ? B32.indexOf(s[i]) : s.charCodeAt(i) % 32; sum = (sum * 7 + v * (i + 3)) % 32; } return B32[sum]; }
function serialPrefix(inst) { const p = String((inst && (inst.short || inst.name)) || 'UNI').toUpperCase().replace(/[^A-Z0-9]/g, ''); return (p.length > 6 ? p.split('').filter((ch, i) => i < 6).join('') : p) || 'UNI'; }
/** WAUU-S26-K70004-C : prefix, kind + year, the issuing desk's 2-character LANE + a sequence (two desks issuing while
 *  offline never mint the same number), a check character. Without a lane: a 5-digit sequence. */
function makeSerial(prefix, kind, year, seq, lane) { const body = `${prefix}-${(KINDS[kind] || KINDS.student).code}${String(year).slice(-2)}-${lane ? String(lane).toUpperCase().slice(0, 2) + String(seq).padStart(4, '0') : String(seq).padStart(5, '0')}`; return body + '-' + checkChar(body); }
/** The issuing desk's lane, from its node id (2 Crockford characters). */
function laneOf(nodeId) { return b32(crypto.createHash('sha256').update(String(nodeId || 'desk')).digest(), 2); }
const SERIAL_RE = /^([A-Z0-9]{1,6})-([STL])(\d{2})-([0-9A-Z]{5,8})-([0-9A-Z])$/;
function serialOk(s) { const m = SERIAL_RE.exec(String(s || '').trim().toUpperCase()); return !!m && checkChar(String(s).trim().toUpperCase().slice(0, -2)) === m[5]; }
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(String(msg)).digest();
function b32(buf, n) { let bits = 0, val = 0, out = ''; for (const byte of buf) { val = (val << 8) | byte; bits += 8; while (bits >= 5 && out.length < n) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } if (out.length >= n) break; } return out; }
/** The 6-character security code printed on the physical card only (XXX-XXX). From print 1 on (pno) it is bound to the PRINT:
 *  every reprint carries a new code, so the code of an earlier print gives a kept-back or copied card away. */
function csc(key, serial, ver, number, pno) {
  const msg = Number(pno) >= 1 ? 'csc2|' + serial + '|' + ver + '|' + Number(pno) + '|' + String(number || '').toUpperCase() : 'csc|' + serial + '|' + ver + '|' + String(number || '').toUpperCase();
  const s = b32(hmac(key, msg), 6); return s.slice(0, 3) + '-' + s.slice(3);
}
const cscNorm = (v) => String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
function urlMac(key, serial, ver) { return b64u(hmac(key, 'vid|' + serial + '|' + ver)).slice(0, 12); }
/** The front QR's signed link — /vid/SERIAL.VERpPRINT.MAC for a numbered print, /vid/SERIAL.VERd.MAC for the soft copy on a screen,
 *  /vid/SERIAL.VER.MAC for the first cards. */
function frontUrl(base, key, serial, ver, pno, digital) {
  // v2 (2026-10): /V/SERIAL.VER[Pn|D].MAC — a 10-character base32 MAC, all in CAPITALS: the QR's alphanumeric mode packs it into fewer,
  // bigger modules (a phone reads it off a worn or poorly printed card). A bare host is upper-cased too (a host has no case); a base with a
  // path keeps its case. The old /vid/ links still verify.
  const v = digital ? ver + 'd' : Number(pno) >= 1 ? ver + 'p' + Number(pno) : String(ver);
  const b = String(base || '').replace(/\/+$/, ''); const bare = /^https?:\/\/[^/]+$/i.test(b);
  return (bare ? b.toUpperCase() : b) + '/V/' + String(serial).toUpperCase() + '.' + v.toUpperCase() + '.' + urlMac32(key, serial, v);
}
function urlMac32(key, serial, v) { return b32(hmac(key, 'v2|' + String(serial).toUpperCase() + '|' + String(v).toLowerCase()), 10); }
const keyCache = new Map();
/** The university's Ed25519 ID-signing key, derived from its institution key (the same on every desk and the portal). */
function edKeys(secret) {
  if (!secret) return null; const id = crypto.createHash('sha256').update('k|' + secret).digest('hex');
  if (keyCache.has(id)) return keyCache.get(id);
  try {
    const seed = hmac(secret, 'ubid-ed25519-v1');
    const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    const publicKey = crypto.createPublicKey(privateKey);
    const raw = publicKey.export({ format: 'der', type: 'spki' }).slice(-32);
    const out = { privateKey, publicKey, pub: b64u(raw), kid: b64u(crypto.createHash('sha256').update(raw).digest()).slice(0, 8) };
    keyCache.set(id, out); return out;
  } catch (_) { return null; }
}
function pubKeyFrom(pubB64u) { try { return crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), unb64u(pubB64u)]), format: 'der', type: 'spki' }); } catch (_) { return null; } }
const clean = (v, n) => String(v == null ? '' : v).replace(/[|\r\n]/g, ' ').trim().slice(0, n).trim();
/** A hash of the photo the card was printed with — so a verifier can tell a swapped photo. */
function photoHash(photo) { if (!photo) return '-'; return b64u(crypto.createHash('sha256').update(String(photo).replace(/^data:[^,]*,/, '')).digest()).slice(0, 8); }
// ── 🔢 base45 (RFC 9285): bytes written in the QR's ALPHANUMERIC alphabet (5.5 bits a character instead of 8)
const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
function b45enc(buf) { let s = ''; for (let i = 0; i < buf.length; i += 2) { if (i + 1 < buf.length) { let x = buf[i] * 256 + buf[i + 1]; const e = Math.floor(x / 2025); x %= 2025; s += B45[x % 45] + B45[Math.floor(x / 45)] + B45[e]; } else { const x = buf[i]; s += B45[x % 45] + B45[Math.floor(x / 45)]; } } return s; }
function b45dec(s) { const out = []; for (let i = 0; i < s.length; i += 3) { const c = s.slice(i, i + 3); const v = [...c].map(ch => B45.indexOf(ch)); if (v.some(x => x < 0)) return null; if (c.length === 3) { const x = v[0] + v[1] * 45 + v[2] * 2025; if (x > 65535) return null; out.push(x >> 8, x & 255); } else if (c.length === 2) { const x = v[0] + v[1] * 45; if (x > 255) return null; out.push(x); } else return null; } return Buffer.from(out); }
/** Text in the QR's alphanumeric alphabet (upper case, accents dropped, anything else → '-'): the compact credential's fields. */
const alnumText = (v, n) => String(v == null ? '' : v).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^0-9A-Z $%+\-./:]/g, '-').replace(/\s+/g, ' ').trim().slice(0, n).trim();
/** 🔢 The card's BARCODE number — 14 digits: 11 from a hash of the serial, the print number (2 digits), a Luhn check digit (a misread or
 *  mistyped number is caught). In Code 128 set C it prints with 0.25 mm bars where the serial needed 0.16 mm. */
function luhnDigit(d) { let s = 0; for (let i = 0; i < d.length; i++) { let x = Number(d[d.length - 1 - i]); if (i % 2 === 0) { x *= 2; if (x > 9) x -= 9; } s += x; } return String((10 - (s % 10)) % 10); }
function codeKey(serial) { const h = crypto.createHash('sha256').update('UBCODE|' + String(serial || '').toUpperCase()).digest(); let v = 0n; for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(h[i]); return (v % 100000000000n).toString().padStart(11, '0'); }
function cardCode(serial, pno) { const body = codeKey(serial) + String(Math.max(0, Math.min(99, Number(pno) || 0))).padStart(2, '0'); return body + luhnDigit(body); }
/** The number as printed under the bars: groups of four (0123 4567 8901 23) — the serial (an older card) as it is. */
function codeText(v) { const s = String(v || ''); return /^\d{14}$/.test(s) ? s.replace(/(\d{4})(?=\d)/g, '$1 ') : s; }
/** The OFFLINE credential in the back QR (a visible digital seal).
 *    UB2|kind|channel|serial|ver|print|NAME|number|session|exp(YYYY-MM-DD)|photoHash|sig   — every card issued now (print 0 = soft copy)
 *    UB1|kind|channel|serial|ver|NAME|number|exp(YYYY-MM)|photoHash|sig                    — the first cards (still verified) */
function offlineCredential(keys, card) {
  if (!keys) return null;
  // UB3 — the COMPACT credential (every card printed now): the same fields and Ed25519 signature, in the QR's alphanumeric alphabet
  //   UB3*kind*channel*serial*ver*print*NAME*NUMBER*SESSION*YYYYMMDD*photoHash(hex)*base45(signature):
  // — ~40 % fewer modules than UB2 (version 6 instead of 8), so the back QR's modules are bigger and survive any print.
  if (card.v3 && card.pno != null) {
    const k3 = (KINDS[card.kind] || KINDS.student).code, ch3 = card.channel === 'digital' ? 'D' : 'P';
    let ph = '-'; try { const b = unb64u(String(card.ph || '')); if (b && b.length) ph = b.toString('hex').toUpperCase().slice(0, 12); } catch (_) { ph = '-'; }
    const f3 = ['UB3', k3, ch3, alnumText(card.serial, 24), String(Math.max(1, Number(card.ver) || 1)), String(Math.max(0, Number(card.pno) || 0)), alnumText(card.name, 26), alnumText(card.number, 24), alnumText(card.session, 12), String(card.exp || '').replace(/-/g, '').slice(0, 8), ph];
    const body3 = f3.join('*');
    try { return body3 + '*' + b45enc(crypto.sign(null, Buffer.from(body3, 'ascii'), keys.privateKey)) + ':'; } catch (_) { return null; }
  }
  const k = (KINDS[card.kind] || KINDS.student).code, ch = card.channel === 'digital' ? 'D' : 'P', ver = String(Math.max(1, Number(card.ver) || 1));
  const f = card.pno != null
    ? ['UB2', k, ch, clean(card.serial, 24), ver, String(Math.max(0, Number(card.pno) || 0)), clean(card.name, 24).toUpperCase(), clean(card.number, 24), clean(card.session, 9), clean(card.exp, 10), clean(card.ph || '-', 8)]
    : ['UB1', k, ch, clean(card.serial, 24), ver, clean(card.name, 30).toUpperCase(), clean(card.number, 26), clean(card.exp, 7), clean(card.ph || '-', 8)];
  const body = f.join('|');
  try { return body + '|' + b64u(crypto.sign(null, Buffer.from(body, 'utf8'), keys.privateKey)); } catch (_) { return null; }
}
/** Verify an offline credential with the PUBLIC key (works with no network). → { ok, why, card } */
function verifyOffline(pub, text, today) {
  const s = String(text || '').trim();
  if (/^UB3\*/.test(s)) {
    const t = s.endsWith(':') ? s.slice(0, -1) : s; const parts = t.split('*'); if (parts.length < 12) return { ok: false, why: 'malformed' };
    const f3 = parts.slice(0, 11); const sig3 = b45dec(parts.slice(11).join('*')); if (!sig3 || sig3.length !== 64) return { ok: false, why: 'malformed' };
    const key3 = typeof pub === 'string' ? pubKeyFrom(pub) : (pub && pub.publicKey) || pub;
    let good3 = false; try { good3 = !!key3 && crypto.verify(null, Buffer.from(f3.join('*'), 'ascii'), key3, sig3); } catch (_) { good3 = false; }
    const ex = /^\d{8}$/.test(f3[9]) ? f3[9].slice(0, 4) + '-' + f3[9].slice(4, 6) + '-' + f3[9].slice(6, 8) : '';
    const card3 = { v: 3, kind: KIND_OF[f3[1]] || 'student', channel: f3[2] === 'D' ? 'digital' : 'physical', serial: f3[3], ver: Number(f3[4]) || 1, pno: Number(f3[5]) || 0, name: f3[6], number: f3[7], session: f3[8], exp: ex, ph: f3[10] };
    if (!good3) return { ok: false, why: 'forged', card: card3 };
    const d3 = String(today || new Date().toISOString().slice(0, 10)).slice(0, 10);
    if (card3.exp && card3.exp < d3) return { ok: false, why: 'expired', card: card3 };
    return { ok: true, card: card3 };
  }
  const v2 = /^UB2\|/.test(s); if (!v2 && !/^UB1\|/.test(s)) return { ok: false, why: 'not_ours' };
  const i = s.lastIndexOf('|'); const body = s.slice(0, i), sig = s.slice(i + 1); const f = body.split('|');
  if (f.length !== (v2 ? 11 : 9)) return { ok: false, why: 'malformed' };
  const key = typeof pub === 'string' ? pubKeyFrom(pub) : (pub && pub.publicKey) || pub;
  let good = false; try { good = !!key && crypto.verify(null, Buffer.from(body, 'utf8'), key, unb64u(sig)); } catch (_) { good = false; }
  const card = v2 ? { v: 2, kind: KIND_OF[f[1]] || 'student', channel: f[2] === 'D' ? 'digital' : 'physical', serial: f[3], ver: Number(f[4]) || 1, pno: Number(f[5]) || 0, name: f[6], number: f[7], session: f[8], exp: f[9], ph: f[10] }
    : { v: 1, kind: KIND_OF[f[1]] || 'student', channel: f[2] === 'D' ? 'digital' : 'physical', serial: f[3], ver: Number(f[4]) || 1, pno: null, name: f[5], number: f[6], session: '', exp: f[7], ph: f[8] };
  if (!good) return { ok: false, why: 'forged', card };
  const d = String(today || new Date().toISOString().slice(0, 10)).slice(0, v2 ? 10 : 7);
  if (card.exp && card.exp < d) return { ok: false, why: 'expired', card };
  return { ok: true, card };
}
/** What a scanner read: the offline credential, the online link, an older live / printed link, or a bare serial. */
function parseScan(text) {
  const s = String(text || '').trim();
  if (/^UB[12]\|/.test(s) || /^UB3\*/.test(s)) return { type: 'offline', text: s };
  if (NFC && NFC.parseSun(s)) return { type: 'sun', text: s };   // the chip's own signed link (a new one at every tap)
  { const dg = s.replace(/[ \-]/g, ''); if (/^\d{14}$/.test(dg) && luhnDigit(dg.slice(0, 13)) === dg[13]) return { type: 'code', key: dg.slice(0, 11), pno: Number(dg.slice(11, 13)), code: dg }; }
  let m = /\/v\/([A-Z0-9-]+)\.(\d+)(?:p(\d+)|(d))?\.([0-9A-Z]{10})(?=$|[?#/])/i.exec(s); if (m) return { type: 'url', v2: true, serial: m[1].toUpperCase(), ver: Number(m[2]), pno: m[3] != null ? Number(m[3]) : null, digital: !!m[4], mac: m[5].toUpperCase() };
  m = /\/vid\/([A-Z0-9-]+)\.(\d+)(?:p(\d+)|(d))?\.([A-Za-z0-9_-]{8,16})/i.exec(s); if (m) return { type: 'url', serial: m[1].toUpperCase(), ver: Number(m[2]), pno: m[3] != null ? Number(m[3]) : null, digital: !!m[4], mac: m[5] };
  if (/verify-id\?l=/.test(s)) return { type: 'live', text: s };
  if (/verify-id\?t=/.test(s)) return { type: 'legacy', text: s };
  if (serialOk(s)) return { type: 'serial', serial: s.toUpperCase() };
  { const mm = /^(.+)\.(\d{1,3})$/.exec(s); if (mm && serialOk(mm[1])) return { type: 'serial', serial: mm[1].toUpperCase(), pno: Number(mm[2]) }; }   // the barcode: serial.print
  if (/^UBC1\|/.test(s)) return { type: 'chip', text: s };
  m = MAG_RE.exec(s); if (m) return { type: 'mag', serial: m[1].toUpperCase(), ver: Number(m[2]), pno: Number(m[3]), mac: m[4].toUpperCase() };
  const uid = /^(UID|NFC)\s*[:=]/i.test(s) || /^[0-9A-F]{8}([0-9A-F]{6})?([0-9A-F]{6})?$/i.test(s) ? chipUid(s) : null; if (uid) return { type: 'uid', uid };
  return { type: 'unknown', text: s.slice(0, 200) };
}
/** SMART CHIP — a contactless chip's UID (4, 7 or 10 bytes, hex), as a USB NFC reader types it or a phone reads it. */
function chipUid(v) { const x = String(v || '').toUpperCase().replace(/^(UID|NFC)\s*[:=]\s*/, '').replace(/[^0-9A-F]/g, ''); return [8, 14, 20].includes(x.length) ? x : null; }
/** The signed CHIP CREDENTIAL written on the card's chip (an NDEF text record): UBC1|serial|ver|print|UID|sig — the UID is signed
 *  in, so the data copied onto another chip (another UID) is caught as a cloned chip. */
function chipCredential(keys, c) {
  if (!keys || !c) return null; const uid = chipUid(c.uid); if (!uid) return null;
  const body = ['UBC1', clean(c.serial, 24), String(Math.max(1, Number(c.ver) || 1)), String(Math.max(0, Number(c.pno) || 0)), uid].join('|');
  try { return body + '|' + b64u(crypto.sign(null, Buffer.from(body, 'utf8'), keys.privateKey)); } catch (_) { return null; }
}
/** Verify a chip credential against the UID the reader actually read → { ok, why: forged | cloned | malformed | not_ours, card } */
function verifyChip(pub, text, uid) {
  const s = String(text || '').trim(); if (!/^UBC1\|/.test(s)) return { ok: false, why: 'not_ours' };
  const i = s.lastIndexOf('|'); const body = s.slice(0, i), sig = s.slice(i + 1); const f = body.split('|'); if (f.length !== 5) return { ok: false, why: 'malformed' };
  const key = typeof pub === 'string' ? pubKeyFrom(pub) : (pub && pub.publicKey) || pub;
  let good = false; try { good = !!key && crypto.verify(null, Buffer.from(body, 'utf8'), key, unb64u(sig)); } catch (_) { good = false; }
  const card = { serial: f[1], ver: Number(f[2]) || 1, pno: Number(f[3]) || 0, uid: f[4] };
  if (!good) return { ok: false, why: 'forged', card };
  if (uid != null && chipUid(uid) !== card.uid) return { ok: false, why: 'cloned', card };
  return { ok: true, card };
}
/** MAGNETIC STRIPE — track 1 (ISO 7811 alphanumeric): %UB^SERIAL^VERpPRINT+keyed check?  → { track1, mac } */
const MAG_RE = /^%UB\^([A-Z0-9-]+)\^(\d+)P(\d+)([0-9A-Z]{6})\?/i;
function magMac(key, serial, ver, pno) { return b32(hmac(key, 'mag|' + serial + '|' + ver + '|' + pno), 6); }
function magTracks(key, serial, ver, pno) { const v = Math.max(1, Number(ver) || 1), n = Math.max(0, Number(pno) || 0); const mac = magMac(key, serial, v, n); return { track1: '%UB^' + serial + '^' + v + 'P' + n + mac + '?', mac }; }

/**
 * THE VERDICT on a scanned / typed card — the same rule on the desk, the portal and the app.
 *   o = { text, csc, today, key (institution key: links + security codes), pub (Ed25519 public key), cardBySerial(serial) → register row }
 * → { result: genuine | forged | revoked | lost | stolen | replaced | expired | mismatch | unknown, why, notes[], card, method, parsed }
 */
function decide(o) {
  const text = String(o.text || '').trim(); const p = parseScan(text); const notes = []; const today = String(o.today || new Date().toISOString()).slice(0, 10);
  const find = (s) => { try { return o.cardBySerial ? o.cardBySerial(String(s).toUpperCase()) : null; } catch (_) { return null; } };
  // the print in circulation, for cards printed under the numbered-print scheme (sec_v 2) — null for the first cards
  const curPno = (c) => (c && Number(c.sec_v) >= 2 ? Number(c.print_count) || 0 : null);
  const earlier = (n, c) => 'An EARLIER PRINT of this card (' + (n > 0 ? 'print ' + n : 'a print from before the reprint') + ' — the card in use is print ' + curPno(c) + (c.printed_at ? ', printed ' + String(c.printed_at).slice(0, 10) : '') + '). The earlier print is destroyed when a card is reprinted, so this one is a copy or was kept back — do not accept it; keep it and send the holder to the ICT office.';
  let card = null, result = 'unknown', why = '', method = p.type, offline = null;
  if (p.type === 'offline') {
    offline = verifyOffline(o.pub, p.text, today); method = 'offline';
    card = offline.card ? find(offline.card.serial) : null;
    if (!offline.ok && offline.why === 'forged') { result = 'forged'; why = 'The QR signature is not the university’s — this card was not issued by us.'; card = null; }
    else if (!offline.card) why = 'Not a card QR code.';
    else if (!card) { result = offline.ok ? 'genuine' : 'expired'; why = offline.ok ? 'Signed by the university (checked offline) — not yet on this register.' : 'The card has expired' + (offline.card.session ? ' (session ' + offline.card.session + ')' : '') + '.'; notes.push('On the card: ' + offline.card.name + ' · ' + offline.card.number + (offline.card.session ? ' · ' + offline.card.session : '')); }
    else {
      const cp = curPno(card);
      if (offline.card.ver < (Number(card.ver) || 1)) { result = 'replaced'; why = 'An older version of a card that was re-issued.'; }
      else if (offline.card.v === 3 ? offline.card.number !== alnumText(card.holder_number, 24) : String(offline.card.number).toUpperCase() !== String(card.holder_number || '').toUpperCase()) { result = 'mismatch'; why = 'The number in the QR (' + offline.card.number + ') is not the card holder’s (' + card.holder_number + ').'; }
      else if (offline.card.channel === 'physical' && cp != null && cp >= 1 && (offline.card.pno == null || offline.card.pno < cp)) { result = 'duplicate'; why = earlier(offline.card.pno || 0, card); }
      if (offline.card.channel === 'digital') notes.push('A DIGITAL copy (shown on a screen) — not a printed card.');
    }
  } else if (p.type === 'url') {
    method = 'online'; card = find(p.serial);
    const v = p.digital ? p.ver + 'd' : p.pno != null ? p.ver + 'p' + p.pno : String(p.ver); const cp = curPno(card);
    if (!o.key || (p.v2 ? urlMac32(o.key, p.serial, v) : urlMac(o.key, p.serial, v)) !== p.mac) { result = 'forged'; why = 'The verification link is not one the university signed.'; card = null; }
    else if (card && p.ver < (Number(card.ver) || 1)) { result = 'replaced'; why = 'An older version of a card that was re-issued.'; }
    else if (card && !p.digital && cp != null && cp >= 1 && (p.pno == null || p.pno < cp)) { result = 'duplicate'; why = earlier(p.pno || 0, card); }
    else if (!card) why = 'A link the university signed, but the card is not on this register yet (sync).';
    if (p.digital && result !== 'forged') notes.push('A DIGITAL copy (shown on a screen) — not a printed card.');
  } else if (p.type === 'sun') {
    // 📶 THE SECURE CHIP (NTAG 424 DNA): its link is signed by the chip's own key at every tap — checked, then the counter must grow
    method = 'nfc'; const v = NFC ? NFC.verifySun(o.key, p.text) : { ok: false, why: 'not_ours' };
    if (!v.ok) { result = 'forged'; why = v.why === 'forged' ? 'The chip’s secure message is not genuine — a copied or programmed chip.' : 'Not a chip of this university.'; }
    else {
      try { card = o.cardByChip ? o.cardByChip(v.uid) : null; } catch (_) { card = null; }
      if (!card) why = 'A genuine chip of the university, not bound to a card on this register yet (sync).';
      else if (o.nfcCounter && o.nfcCounter(card, v.uid, v.counter) === false) { result = 'forged'; why = 'A REPLAYED chip message — this tap’s counter (' + v.counter + ') went by already: a recording of an earlier tap, not the card.'; }
      else notes.push('Secure chip tap #' + v.counter + ' — it cannot be copied.');
    }
  } else if (p.type === 'code') {
    // the BARCODE: the card number (its 11-digit key → the card), the print number in it
    method = 'barcode'; try { card = o.cardByCode ? o.cardByCode(p.key) : null; } catch (_) { card = null; } const cp = curPno(card);
    if (!card) why = 'No card with this number in the register.';
    else if (cp != null && cp >= 1 && p.pno >= 1 && p.pno < cp) { result = 'duplicate'; why = earlier(p.pno, card); }
  } else if (p.type === 'serial') {
    method = o.csc ? 'csc' : 'serial'; card = find(p.serial); const cp = curPno(card);
    if (!card) why = 'No card with this number in the register.';
    else if (p.pno != null && cp != null && cp >= 1 && p.pno < cp) { result = 'duplicate'; why = earlier(p.pno, card); }
  }
  else if (p.type === 'chip') {
    method = 'chip'; const v = verifyChip(o.pub, p.text, o.uid != null ? o.uid : undefined); card = v.card ? find(v.card.serial) : null; const cp = curPno(card);
    if (!v.ok && v.why === 'forged') { result = 'forged'; why = 'The data on the chip is not signed by the university.'; card = null; }
    else if (!v.ok && v.why === 'cloned') { result = 'forged'; why = 'A CLONED chip — the card’s data was copied onto another chip (its UID is not the one the university bound).'; }
    else if (!v.card) why = 'Not a card chip.';
    else if (card && card.chip_uid && v.card.uid !== card.chip_uid) { result = 'forged'; why = 'This chip is not the one bound to card ' + card.serial + '.'; }
    else if (card && v.card.ver < (Number(card.ver) || 1)) { result = 'replaced'; why = 'An older version of a card that was re-issued.'; }
    else if (card && cp != null && cp >= 1 && v.card.pno >= 1 && v.card.pno < cp) { result = 'duplicate'; why = earlier(v.card.pno, card); }
    else if (!card) why = 'A chip the university signed, but the card is not on this register yet (sync).';
  } else if (p.type === 'uid') {
    method = 'chip'; try { card = o.cardByChip ? o.cardByChip(p.uid) : null; } catch (_) { card = null; }
    if (!card) why = 'This chip is not bound to any card of the university.';
  } else if (p.type === 'mag') {
    method = 'stripe'; card = find(p.serial); const cp = curPno(card);
    if (!o.key || magMac(o.key, p.serial, p.ver, p.pno) !== p.mac) { result = 'forged'; why = 'The magnetic stripe was not encoded by the university.'; card = null; }
    else if (card && p.ver < (Number(card.ver) || 1)) { result = 'replaced'; why = 'An older version of a card that was re-issued.'; }
    else if (card && cp != null && cp >= 1 && p.pno < cp) { result = 'duplicate'; why = earlier(p.pno, card); }
    else if (!card) why = 'A stripe the university encoded, but the card is not on this register yet (sync).';
  }
  else if (p.type === 'live' || p.type === 'legacy') why = 'A digital ID link — open it on a phone (it is checked live on the portal).';
  else { result = 'forged'; why = 'Not a card number of this university (the check character is wrong).'; }
  if (card && result === 'unknown') result = 'genuine';
  if (card && result === 'duplicate' && ['lost', 'stolen', 'revoked'].includes(card.status)) result = 'genuine';   // a blocked card: say WHY it is blocked (lost / stolen / revoked) — it fails either way
  if (card && (result === 'genuine' || result === 'expired')) {
    if (['lost', 'stolen', 'revoked', 'replaced'].includes(card.status)) { result = card.status; why = 'This card was ' + card.status + (card.status_at ? ' on ' + String(card.status_at).slice(0, 10) : '') + (card.reason ? ' — ' + card.reason : '') + '.'; }
    else if (card.status === 'expired' || (card.expires_at && String(card.expires_at).slice(0, 10) < today)) { result = 'expired'; why = 'The card expired on ' + String(card.expires_at || '').slice(0, 10) + (card.session_name ? ' — it was valid for the ' + card.session_name + ' session only' : '') + '.'; }
  }
  if (card && o.csc && !['forged', 'revoked', 'lost', 'stolen', 'mismatch', 'duplicate'].includes(result)) {
    const ver = Number(card.ver) || 1, cp = curPno(card), mine = (n) => !!o.key && cscNorm(o.csc) === cscNorm(csc(o.key, card.serial, ver, card.holder_number, n));
    if (mine(cp || undefined)) notes.push('✓ The security code matches the physical card' + (cp ? ' (print ' + cp + ')' : '') + '.');
    else {
      let n = 0; if (cp) { for (let k = cp - 1; k >= 1 && !n; k--) if (mine(k)) n = k; if (!n && mine(undefined)) n = -1; }
      if (n) { result = 'duplicate'; why = earlier(n > 0 ? n : 0, card); } else { result = 'forged'; why = 'The security code does not match this card.'; }
    }
  }
  if (card && result === 'genuine' && method === 'serial') notes.push('A card number alone only proves the number exists — compare the photo, or ask for the security code printed on the back.');
  if (card && result === 'genuine' && card.session_name) { const sc = sessionColor(card.session_name); notes.push('Valid for the ' + card.session_name + ' session only' + (sc ? ' — the session tab on the right edge of the card is ' + sc.name.toUpperCase() : '') + '.'); }
  if (result === 'genuine' && !why) why = 'Genuine, active card.';
  return { result, why, notes, card, method, parsed: p, offline };
}
const BAD_RESULTS = ['forged', 'revoked', 'lost', 'stolen', 'mismatch', 'duplicate'];

/** ONE CARD IN TWO PLACES. recent = this card's genuine scans of the last hours (any order); x = { at, context, context_id, by_id }.
 *  Checked in to two DIFFERENT exams within 90 minutes → a DUPLICATE (one card cannot sit two exams). The same exam again →
 *  a note. Scanned at another post by another officer within 2 minutes → a possible clone (an alert, not a refusal). */
function cloneCheck(recent, x) {
  const out = { result: null, why: '', notes: [], alert: false };
  const t = Date.parse((x && x.at) || new Date().toISOString()); const EX = ['exam', 'online_exam'];
  for (const r of (recent || []).slice().sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))) {
    if (!r || r.result !== 'genuine' || !r.at) continue;
    const mins = (t - Date.parse(r.at)) / 60000; if (!(mins >= 0) || mins > 180) continue;
    const hhmm = String(r.at).slice(11, 16);
    if (EX.includes(x.context) && EX.includes(r.context) && r.context_id && x.context_id && r.context_id !== x.context_id && mins <= 90) {
      return { result: 'duplicate', why: 'This card was already checked in to another exam at ' + hhmm + (r.by_name ? ' by ' + r.by_name : '') + ' — one card cannot sit two exams at once: one of the two is a duplicate.', notes: [], alert: true };
    }
    if (EX.includes(x.context) && r.context_id && r.context_id === x.context_id) { if (!out.notes.some(n => /Already checked in/.test(n))) out.notes.push('Already checked in to this exam at ' + hhmm + (r.by_name ? ' by ' + r.by_name : '') + ' — make sure it is the same person, not a second card.'); }
    else if (mins <= 2 && r.by_id && x.by_id && r.by_id !== x.by_id && (r.context || '') !== (x.context || '') && !out.alert) { out.alert = true; out.notes.push('⚠ Scanned ' + Math.max(1, Math.round(mins * 60)) + ' s ago at another post (' + (r.context || '?') + (r.by_name ? ', ' + r.by_name : '') + ') — possibly a cloned card: check the photo carefully.'); }
  }
  return out;
}

/** The signed STATUS LIST a scanner keeps for when it is offline: the blocked serials (still within their validity) and, for
 *  reprinted cards, the print in circulation.   UBSL1|issued|valid until|SERIAL:L,…|SERIAL:2,…|signature   (L lost · S stolen · R revoked · X replaced) */
const STATUS_CODE = { lost: 'L', stolen: 'S', revoked: 'R', replaced: 'X' };
const CODE_STATUS = { L: 'lost', S: 'stolen', R: 'revoked', X: 'replaced' };
function statusList(keys, cards, at, days) {
  if (!keys) return null; const now = String(at || new Date().toISOString()); const today = now.slice(0, 10);
  const until = new Date(Date.parse(now) + (Number(days) || 3) * 864e5).toISOString().slice(0, 10);
  const bad = [], prints = [];
  for (const c of cards || []) {
    if (!c || Number(c.deleted) || !c.serial || String(c.expires_at || '9999') < today) continue;
    const k = STATUS_CODE[c.status];
    if (k) bad.push(c.serial + ':' + k); else if (c.status === 'active' && Number(c.sec_v) >= 2 && Number(c.print_count) >= 2) prints.push(c.serial + ':' + Number(c.print_count));
  }
  const body = ['UBSL1', now.slice(0, 19), until, bad.sort().join(','), prints.sort().join(',')].join('|');
  try { return body + '|' + b64u(crypto.sign(null, Buffer.from(body, 'utf8'), keys.privateKey)); } catch (_) { return null; }
}
/** Read a status list with the PUBLIC key → { at, until, stale, bad: { serial: status }, prints: { serial: n } } — null if not genuine. */
function readStatusList(pub, text, today) {
  const s = String(text || '').trim(); if (!/^UBSL1\|/.test(s)) return null;
  const i = s.lastIndexOf('|'); const body = s.slice(0, i), sig = s.slice(i + 1); const f = body.split('|'); if (f.length !== 5) return null;
  const key = typeof pub === 'string' ? pubKeyFrom(pub) : (pub && pub.publicKey) || pub;
  let good = false; try { good = !!key && crypto.verify(null, Buffer.from(body, 'utf8'), key, unb64u(sig)); } catch (_) { good = false; }
  if (!good) return null;
  const bad = {}, prints = {}; const pair = (x) => { const j = x.lastIndexOf(':'); return j > 0 ? [x.slice(0, j), x.slice(j + 1)] : null; };
  for (const x of f[3] ? f[3].split(',') : []) { const q = pair(x); if (q) bad[q[0]] = CODE_STATUS[q[1]] || 'revoked'; }
  for (const x of f[4] ? f[4].split(',') : []) { const q = pair(x); if (q) prints[q[0]] = Number(q[1]) || 0; }
  return { at: f[1], until: f[2], stale: String(today || new Date().toISOString().slice(0, 10)).slice(0, 10) > f[2], bad, prints };
}

/** WHICH ID-CARD FEES ARE PAID — derived from the money, never typed in: the holder's charges of the fee category in the order they
 *  were billed, settled first-in-first-out by the COMPLETED payments of that category (a refund is a negative payment), per currency.
 *  invoices [{ id, charge_id }] · charges [{ id, category, currency, amount, created_at, deleted }] · payments [{ category, currency, amount, status, deleted }]
 *  → { [invoice id]: { state: 'paid' | 'part' | 'unpaid' | 'removed', paid, due } } */
function feeState(invoices, charges, payments, category) {
  const cat = category || 'id_card'; const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const live = (charges || []).filter(c => c && c.category === cat && !Number(c.deleted)).sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id)));
  const left = {}; for (const p of payments || []) if (p && p.category === cat && p.status === 'completed' && !Number(p.deleted)) left[p.currency] = r2((left[p.currency] || 0) + Number(p.amount));
  const cover = {};
  for (const c of live) { const amt = Math.max(0, r2(c.amount)); const have = Math.max(0, left[c.currency] || 0); const got = Math.min(amt, have); left[c.currency] = r2((left[c.currency] || 0) - got); cover[c.id] = { paid: r2(got), due: r2(amt - got) }; }
  const out = {};
  for (const inv of invoices || []) { if (!inv) continue; const cv = cover[inv.charge_id]; out[inv.id] = !cv ? { state: 'removed', paid: 0, due: 0 } : cv.due <= 0.005 ? { state: 'paid', paid: cv.paid, due: 0 } : { state: cv.paid > 0.005 ? 'part' : 'unpaid', paid: cv.paid, due: cv.due }; }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────── what a card says (always from the record)
const up = (v) => String(v == null ? '' : v).trim().toUpperCase();
function monthLabel(iso, lang) {
  if (!iso) return '';
  try { return new Date(String(iso).slice(0, 10) + 'T00:00:00Z').toLocaleDateString(lang || 'en', { month: 'short', year: 'numeric', timeZone: 'UTC' }).replace('.', '').toUpperCase(); } catch (_) { return String(iso).slice(0, 7); }
}
function dayLabel(iso, lang) {
  if (!iso) return '';
  try { return new Date(String(iso).slice(0, 10) + 'T00:00:00Z').toLocaleDateString(!lang || lang === 'en' ? 'en-GB' : lang, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).replace('.', '').toUpperCase(); } catch (_) { return String(iso).slice(0, 10); }
}
const addDays = (iso, n) => { const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + (Number(n) || 0)); return d.toISOString().slice(0, 10); };
/** The last day of a session: its own end date, else (from its name, "2026/2027") 31 August of the second year. */
function sessionEndOf(sessionName, sessionEnd) {
  if (sessionEnd && /^\d{4}-\d{2}-\d{2}/.test(String(sessionEnd))) return String(sessionEnd).slice(0, 10);
  const m = /(\d{4})\s*[/-]\s*(\d{2,4})/.exec(String(sessionName || '')); if (!m) return null;
  const y2 = m[2].length === 2 ? String(m[1]).slice(0, 2) + m[2] : m[2]; return y2 + '-08-31';
}
/** The expiry of a card: ONE SESSION — the last day of the session it is issued for (+ any grace days the university allows).
 *  No roll-forward: a session that is over issues no card (the desk / portal refuse). With no session known, or a staff design
 *  set to N months: N months from issue. */
function expiryFor(design, kind, sessionName, sessionEnd, issuedISO, graceDays) {
  const v = (design && design.validity) || {}; const issued = String(issuedISO || new Date().toISOString()).slice(0, 10);
  if (kind === 'student' || v.mode !== 'months') { const end = sessionEndOf(sessionName, sessionEnd); if (end) return addDays(end, Math.max(0, Math.min(90, Number(graceDays) || 0))); }
  const d = new Date(issued + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + (Number(v.months) || 12)); return d.toISOString().slice(0, 10);
}
function libraryLines(design, policy, kind, unit) {
  const p = policy || {}; const n = kind === 'student' ? p.student_max : p.staff_max, d = kind === 'student' ? p.student_days : p.staff_days;
  let access = one(design, 'library_access', { unit: unit || '' }); if (!unit) access = access.split(' • ')[0];
  return { library_access: access, library_loan: n && d ? one(design, 'library_loan', { n, d }) : '' };
}
/** The face framing stored for a photo (JSON or object) — only while it belongs to THIS photo (a new photo is framed again). */
function cropFor(crop, photo) { let c = crop; if (typeof c === 'string') { try { c = JSON.parse(c); } catch (_) { c = null; } } if (!c || !photo || !cropOk(c)) return null; if (c.ph && c.ph !== photoHash(photo)) return null; return c; }
/** A student record → what the card prints. */
function studentData(design, x) {
  const s = x.student || {}; const lang = (design.langs || ['en'])[0];
  const lvl0 = String((x.level && x.level.name) || ''); const lvl = String((x.glossary && x.glossary[lvl0]) || lvl0); const level = /^\d+$/.test(lvl) ? lvl + 'L' : up(lvl);
  const unitCode = up((x.department && (x.department.code || x.department.name)) || '');
  const tr = (v) => { const gl = x.glossary || {}; return (v && gl[v]) || v; };
  const exp = expiryFor(design, 'student', x.session && x.session.name, x.session && x.session.end_date, x.issued, x.grace);
  const lib = libraryLines(design, x.library, 'student', unitCode);
  return Object.assign({
    raw: { surname: s.last_name || '', other_names: [s.first_name, s.middle_name].filter(Boolean).join(' '), full_name: [s.last_name, s.first_name, s.middle_name].filter(Boolean).join(' '), unit_name: tr((x.department && x.department.name) || '') },
    kind: 'student', surname: up(s.last_name), other_names: up([s.first_name, s.middle_name].filter(Boolean).join(' ')), full_name: up([s.last_name, s.first_name, s.middle_name].filter(Boolean).join(' ')),
    number: String(s.matric_no || '').trim(), unit: unitCode, unit_name: up(tr((x.department && x.department.name) || '')), level, session: String((x.session && x.session.name) || ''),
    faculty_line: [up(tr((x.department && x.department.name) || '')), unitCode && !up(tr((x.department && x.department.name) || '')).includes(unitCode) ? '(' + unitCode + ')' : '', level ? '• ' + level : ''].filter(Boolean).join(' '),
    photo: s.photo || null, photo_crop: cropFor(x.photo_crop, s.photo), signature: x.signature || null, blood_group: x.blood_group || '', emergency_phone: String(s.parent_phone || '').trim(),
    emergency_name: [up(s.parent_name), String(s.parent_whatsapp || '').trim() && s.parent_whatsapp !== s.parent_phone ? s.parent_whatsapp : ''].filter(Boolean).join(' • '),
    issued: monthLabel(x.issued, lang), valid_through: dayLabel(exp, lang), expires: exp,
  }, lib);
}
/** A staff record (staff / lecturer) → what the card prints. */
function staffData(design, x) {
  const s = x.staff || {}; const lang = (design.langs || ['en'])[0];
  const kind = s.staff_type === 'lecturer' ? 'lecturer' : 'staff';
  const parts = String(s.full_name || '').trim().split(/\s+/); const surname = parts.length > 1 ? parts[parts.length - 1] : parts[0] || '';
  const bySession = ((design && design.validity) || {}).mode !== 'months' && x.session && x.session.name;
  const exp = expiryFor(design, kind, bySession ? x.session.name : null, bySession ? x.session.end_date : null, x.issued, x.grace);
  const lib = libraryLines(design, x.library, kind, up(s.department || ''));
  return Object.assign({
    raw: { surname, other_names: parts.slice(0, -1).join(' '), full_name: String(s.full_name || '').trim(), position: ((x.glossary || {})[s.position || s.title || '']) || s.position || s.title || '', unit: ((x.glossary || {})[s.department || '']) || s.department || '' },
    kind, surname: up(surname), other_names: up(parts.slice(0, -1).join(' ')), full_name: up(s.full_name), number: String(s.staff_no || '').trim(),
    position: up(((x.glossary || {})[s.position || s.title || '']) || s.position || s.title || ''), unit: up(((x.glossary || {})[s.department || '']) || s.department || ''), since: s.date_employed ? String(s.date_employed).slice(0, 4) : '', faculty_line: [up(s.department || ''), s.position ? '• ' + up(s.position) : ''].filter(Boolean).join(' '),
    photo: s.photo || null, photo_crop: cropFor(x.photo_crop, s.photo), signature: x.signature || null, blood_group: s.blood_group || '', emergency_phone: String(s.emergency_phone || '').trim(), emergency_name: up(s.emergency_name || ''),
    session: bySession ? String(x.session.name) : '', issued: monthLabel(x.issued, lang), valid_through: dayLabel(exp, lang), expires: exp,
  }, lib);
}
/** The fingerprint of what is printed: a change to the record after printing → "details changed — reprint". */
function dataHash(d) { return crypto.createHash('sha256').update([d.kind, d.full_name, d.number, d.unit, d.level || d.position || '', d.session || '', photoHash(d.photo), d.expires].join('|')).digest('hex').slice(0, 16); }

/** 📝 May the card holder SIT EXAMS AND TESTS? The card (genuine, active, its session not over), the holder's standing (an active student),
 *  and the Bursary's financial hold when its policy covers exams (server/holdrules.js 'exams'). x = { result, kind, status, hold } →
 *  { eligible, reasons[] } — the ONE rule for the desk, the portal's scan page and the app. */
/** ✏️ A person's CARD-ONLY edits laid over their record's details (a shorter name, the department as the office words it…) — the desk
 *  and the portal print the same card. */
function applyCardEdits(data, e) {
  if (!e || typeof e !== 'object') return data; const out = Object.assign({}, data); const up = (v) => String(v || '').trim().toUpperCase();
  for (const k of ['surname', 'other_names', 'unit_name', 'faculty_line', 'position']) if (typeof e[k] === 'string' && e[k].trim()) out[k] = up(e[k]).slice(0, 160);
  for (const k of ['level', 'blood_group', 'emergency_phone', 'emergency_name']) if (typeof e[k] === 'string' && e[k].trim()) out[k] = e[k].trim().slice(0, 120);
  if ((e.surname || e.other_names) && out.kind === 'student') out.full_name = [out.surname, out.other_names].filter(Boolean).join(' ');
  return out;
}
/** The DEFAULT design for a holder among the default rows of their kind: their department's, else their faculty's, else everyone's. */
function pickDesignRow(rows, dep, fac) {
  const l = (rows || []).filter(r => r && Number(r.is_default) === 1 && !Number(r.deleted)).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  return (dep && l.find(r => r.scope_type === 'department' && r.scope_id === dep)) || (fac && l.find(r => r.scope_type === 'faculty' && r.scope_id === fac)) || l.find(r => !r.scope_type || r.scope_type === 'all') || null;
}
function examEligibility(x) {
  const o = x || {}; const r = [];
  if (o.result && o.result !== 'genuine') r.push(o.result === 'expired' ? 'The ID card has expired (its session is over).' : 'The ID card is not valid (' + o.result + ').');
  if ((o.kind || 'student') === 'student' && o.status && String(o.status).toLowerCase() !== 'active') r.push('Not an active student (' + o.status + ').');
  if (o.hold && o.hold.held && Array.isArray(o.hold.services) && o.hold.services.includes('exams')) r.push('Fees outstanding — ' + (o.hold.reason || 'see the Bursary') + '.');
  return { eligible: !r.length, reasons: r };
}
module.exports = { nfcPersonalise: (key, base, uid) => (NFC ? NFC.personalisation(key, base, uid) : null), cardCode, codeKey, codeText, luhnDigit, b45enc, b45dec, alnumText,
  examEligibility, applyCardEdits, pickDesignRow, fitText, TRAY_PRESETS, PAGES, traySlots, PRINTER_KB, printerModel, freeSpot,
  PRINT_MEDIA, PRINT_LOOKS, mediaFor, lookFor, printTune, uvVisible, securityPlan, contrastRatio, lum,
  W, H, KINDS, LANG_CODES, LABELS: L, FLAGS, PALETTES, label, defaultDesign, normalizeDesign, renderFront, renderBack, cardHtml, fontFaces, FONT_FILES,
  decide, BAD_RESULTS, checkChar, serialPrefix, makeSerial, laneOf, serialOk, csc, cscNorm, urlMac, frontUrl, edKeys, pubKeyFrom, offlineCredential, verifyOffline, parseScan, photoHash,
  expiryFor, sessionEndOf, studentData, staffData, dataHash, monthLabel, dayLabel, estWidth,
  cloneCheck, statusList, readStatusList, feeState, sessionColor, SESSION_COLORS,
  SECURITY_FEATURES, SECURITY_LOCKED, chipUid, chipCredential, verifyChip, magTracks, renderUV, renderPersonal, cropFromFace,
  classifyPrinter, printerState, cardPrintOptions, calibrationSvg, sheetOf, printerFacts,
  invoiceHtml,
  FIELD_KEYS, REQUIRED_FIELDS, defaultImageFields, normalizeFields, gridOf, securityMap, renderSecurityMap, LAYOUT_PROMPT, labelText, LABEL_KEYS: Object.keys(L),
};
