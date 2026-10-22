'use strict';
/**
 * 🌍 COUNTRY PACKS — what a university in a given country needs configured before day one.
 *
 * Pure data + pure helpers (no DB, no I/O) so the desktop, the portal and the Supabase edge share
 * ONE source of truth (vendored to the edge by scripts/build-edge.js).
 *
 * Each pack answers "we are a university in <country>":
 *   currency (ISO 4217) · official/teaching language(s) · IANA timezone · international dialling code ·
 *   weekend days (0=Sun … 6=Sat) and first day of the week · the month the academic year usually starts ·
 *   the CLOSEST published academic standard (server/standards.js preset — `approx` when it is only the
 *   nearest shape, never a claim that the country uses it) · the local word for the student ID ·
 *   the national data-protection law (named only where it is well established; null ⇒ "check locally") ·
 *   the higher-education regulator (where well known) · the payment gateways that operate there.
 *
 * Everything here is a DEFAULT the institution can change — the Launchpad shows it as a preview first.
 */

const GDPR = 'GDPR — Regulation (EU) 2016/679';

// [code, name, currency, languages, timezone, dial, weekend, weekStart, yearStartMonth, standard, approx, idLabel, privacy, regulator, gateways]
const ROWS = [
  // ---------------------------------------------------------------- Africa — anglophone
  ['NG', 'Nigeria', 'NGN', ['en'], 'Africa/Lagos', '234', [6, 0], 1, 10, 'ng-nuc-5', false, 'Matric No.', 'Nigeria Data Protection Act, 2023 (NDPA)', 'National Universities Commission (NUC)', ['paystack', 'flutterwave']],
  ['GH', 'Ghana', 'GHS', ['en'], 'Africa/Accra', '233', [6, 0], 1, 8, 'gh-4', false, 'Index No.', 'Data Protection Act, 2012 (Act 843)', 'Ghana Tertiary Education Commission (GTEC)', ['paystack', 'flutterwave']],
  ['KE', 'Kenya', 'KES', ['en', 'sw'], 'Africa/Nairobi', '254', [6, 0], 1, 9, 'ke-cue', false, 'Registration No.', 'Data Protection Act, 2019', 'Commission for University Education (CUE)', ['paystack', 'flutterwave']],
  ['UG', 'Uganda', 'UGX', ['en'], 'Africa/Kampala', '256', [6, 0], 1, 8, 'ng-nuc-5', true, 'Registration No.', 'Data Protection and Privacy Act, 2019', 'National Council for Higher Education (NCHE)', ['flutterwave']],
  ['TZ', 'Tanzania', 'TZS', ['sw', 'en'], 'Africa/Dar_es_Salaam', '255', [6, 0], 1, 10, 'ng-nuc-5', true, 'Registration No.', 'Personal Data Protection Act, 2022', 'Tanzania Commission for Universities (TCU)', ['flutterwave']],
  ['RW', 'Rwanda', 'RWF', ['en', 'fr', 'rw'], 'Africa/Kigali', '250', [6, 0], 1, 9, 'ke-cue', true, 'Registration No.', 'Law No. 058/2021 on the protection of personal data and privacy', 'Higher Education Council (HEC)', ['flutterwave']],
  ['ZA', 'South Africa', 'ZAR', ['en'], 'Africa/Johannesburg', '27', [6, 0], 1, 2, 'za-pct', false, 'Student Number', 'Protection of Personal Information Act, 2013 (POPIA)', 'Council on Higher Education (CHE)', ['paystack', 'stripe']],
  ['ZM', 'Zambia', 'ZMW', ['en'], 'Africa/Lusaka', '260', [6, 0], 1, 1, 'za-pct', true, 'Student Number', 'Data Protection Act, 2021', 'Higher Education Authority (HEA)', ['flutterwave']],
  ['ZW', 'Zimbabwe', 'USD', ['en'], 'Africa/Harare', '263', [6, 0], 1, 8, 'uk-honours', true, 'Registration No.', 'Cyber and Data Protection Act, 2021', 'Zimbabwe Council for Higher Education (ZIMCHE)', ['flutterwave']],
  ['BW', 'Botswana', 'BWP', ['en'], 'Africa/Gaborone', '267', [6, 0], 1, 8, 'za-pct', true, 'Student ID', 'Data Protection Act, 2018', 'Botswana Qualifications Authority (BQA)', ['flutterwave']],
  ['NA', 'Namibia', 'NAD', ['en'], 'Africa/Windhoek', '264', [6, 0], 1, 2, 'za-pct', true, 'Student Number', null, 'National Council for Higher Education (NCHE)', ['flutterwave']],
  ['MW', 'Malawi', 'MWK', ['en'], 'Africa/Blantyre', '265', [6, 0], 1, 9, 'za-pct', true, 'Registration No.', null, 'National Council for Higher Education (NCHE)', ['flutterwave']],
  ['ET', 'Ethiopia', 'ETB', ['en', 'am'], 'Africa/Addis_Ababa', '251', [6, 0], 1, 9, 'us-4', true, 'ID No.', null, 'Education and Training Authority (ETA)', ['flutterwave']],
  ['MU', 'Mauritius', 'MUR', ['en', 'fr'], 'Indian/Mauritius', '230', [6, 0], 1, 8, 'uk-honours', true, 'Student ID', 'Data Protection Act 2017', 'Higher Education Commission (HEC)', ['stripe']],
  ['SL', 'Sierra Leone', 'SLE', ['en'], 'Africa/Freetown', '232', [6, 0], 1, 10, 'ng-nuc-5', true, 'Student ID', null, 'Tertiary Education Commission (TEC)', ['flutterwave']],
  ['LR', 'Liberia', 'LRD', ['en'], 'Africa/Monrovia', '231', [6, 0], 0, 3, 'us-4', true, 'Student ID', null, 'National Commission on Higher Education (NCHE)', ['flutterwave']],
  ['GM', 'The Gambia', 'GMD', ['en'], 'Africa/Banjul', '220', [6, 0], 1, 10, 'gh-4', true, 'Student ID', null, 'National Accreditation and Quality Assurance Authority (NAQAA)', ['flutterwave']],
  ['SD', 'Sudan', 'SDG', ['ar', 'en'], 'Africa/Khartoum', '249', [5, 6], 6, 7, 'us-4', true, 'University ID', null, 'Ministry of Higher Education and Scientific Research', []],
  ['EG', 'Egypt', 'EGP', ['ar', 'en'], 'Africa/Cairo', '20', [5, 6], 6, 9, 'us-4', true, 'Student ID', 'Personal Data Protection Law No. 151 of 2020', 'Supreme Council of Universities', ['stripe']],
  // ---------------------------------------------------------------- Africa — francophone / lusophone (LMD)
  ['BJ', 'Benin', 'XOF', ['fr'], 'Africa/Porto-Novo', '229', [6, 0], 1, 10, 'lmd-cames-20', false, 'Matricule', 'Code du numérique (Loi n° 2017-20)', null, ['momopay', 'flutterwave']],
  ['TG', 'Togo', 'XOF', ['fr'], 'Africa/Lome', '228', [6, 0], 1, 10, 'lmd-cames-20', false, 'Matricule', 'Loi n° 2019-014 relative à la protection des données à caractère personnel', null, ['momopay', 'flutterwave']],
  ['SN', 'Senegal', 'XOF', ['fr'], 'Africa/Dakar', '221', [6, 0], 1, 10, 'lmd-cames-20', false, 'Matricule', 'Loi n° 2008-12 sur la protection des données à caractère personnel', 'Autorité nationale d’assurance qualité (ANAQ-Sup)', ['momopay', 'flutterwave']],
  ['CI', 'Côte d’Ivoire', 'XOF', ['fr'], 'Africa/Abidjan', '225', [6, 0], 1, 10, 'lmd-cames-20', false, 'Matricule', 'Loi n° 2013-450 relative à la protection des données à caractère personnel', null, ['paystack', 'momopay', 'flutterwave']],
  ['BF', 'Burkina Faso', 'XOF', ['fr'], 'Africa/Ouagadougou', '226', [6, 0], 1, 10, 'lmd-cames-20', false, 'Matricule', null, null, ['momopay', 'flutterwave']],
  ['ML', 'Mali', 'XOF', ['fr'], 'Africa/Bamako', '223', [6, 0], 1, 10, 'lmd-cames-20', false, 'Matricule', 'Loi n° 2013-015 portant protection des données à caractère personnel', null, ['momopay']],
  ['NE', 'Niger', 'XOF', ['fr'], 'Africa/Niamey', '227', [6, 0], 1, 10, 'lmd-cames-20', false, 'Matricule', 'Loi n° 2017-28 relative à la protection des données à caractère personnel', null, ['momopay']],
  ['GN', 'Guinea', 'GNF', ['fr'], 'Africa/Conakry', '224', [6, 0], 1, 10, 'lmd-cames-20', false, 'Matricule', null, null, ['momopay']],
  ['CM', 'Cameroon', 'XAF', ['fr', 'en'], 'Africa/Douala', '237', [6, 0], 1, 10, 'lmd-cames-20', false, 'Matricule', null, null, ['flutterwave']],
  ['GA', 'Gabon', 'XAF', ['fr'], 'Africa/Libreville', '241', [6, 0], 1, 10, 'lmd-cames-20', false, 'Matricule', null, null, []],
  ['CG', 'Republic of the Congo', 'XAF', ['fr'], 'Africa/Brazzaville', '242', [6, 0], 1, 10, 'lmd-cames-20', false, 'Matricule', null, null, []],
  ['CD', 'DR Congo', 'CDF', ['fr'], 'Africa/Kinshasa', '243', [6, 0], 1, 10, 'lmd-cames-20', false, 'Matricule', null, null, []],
  ['TD', 'Chad', 'XAF', ['fr', 'ar'], 'Africa/Ndjamena', '235', [6, 0], 1, 10, 'lmd-cames-20', false, 'Matricule', null, null, []],
  ['CF', 'Central African Republic', 'XAF', ['fr'], 'Africa/Bangui', '236', [6, 0], 1, 10, 'lmd-cames-20', false, 'Matricule', null, null, []],
  ['MG', 'Madagascar', 'MGA', ['fr', 'mg'], 'Indian/Antananarivo', '261', [6, 0], 1, 10, 'lmd-cames-20', false, 'Matricule', null, null, []],
  ['BI', 'Burundi', 'BIF', ['fr', 'rn'], 'Africa/Bujumbura', '257', [6, 0], 1, 10, 'lmd-cames-20', false, 'Matricule', null, null, []],
  ['MA', 'Morocco', 'MAD', ['fr', 'ar'], 'Africa/Casablanca', '212', [6, 0], 1, 9, 'lmd-cames-20', true, 'Code étudiant', 'Loi n° 09-08 relative à la protection des personnes physiques à l’égard du traitement des données à caractère personnel', null, ['stripe']],
  ['DZ', 'Algeria', 'DZD', ['fr', 'ar'], 'Africa/Algiers', '213', [5, 6], 6, 9, 'lmd-cames-20', true, 'Matricule', 'Loi n° 18-07 relative à la protection des personnes physiques dans le traitement des données à caractère personnel', null, []],
  ['TN', 'Tunisia', 'TND', ['fr', 'ar'], 'Africa/Tunis', '216', [6, 0], 1, 9, 'lmd-cames-20', true, 'Numéro d’inscription', 'Loi organique n° 2004-63 portant sur la protection des données à caractère personnel', null, []],
  ['AO', 'Angola', 'AOA', ['pt'], 'Africa/Luanda', '244', [6, 0], 1, 3, 'lmd-cames-20', true, 'Número de estudante', null, null, []],
  ['MZ', 'Mozambique', 'MZN', ['pt'], 'Africa/Maputo', '258', [6, 0], 1, 2, 'lmd-cames-20', true, 'Número de estudante', null, null, []],
  // ---------------------------------------------------------------- Europe
  ['GB', 'United Kingdom', 'GBP', ['en'], 'Europe/London', '44', [6, 0], 1, 9, 'uk-honours', false, 'Student Number', 'UK GDPR and the Data Protection Act 2018', 'Office for Students (OfS) / QAA', ['stripe', 'paypal']],
  ['IE', 'Ireland', 'EUR', ['en', 'ga'], 'Europe/Dublin', '353', [6, 0], 1, 9, 'uk-honours', true, 'Student Number', GDPR, 'Quality and Qualifications Ireland (QQI)', ['stripe', 'paypal']],
  ['FR', 'France', 'EUR', ['fr'], 'Europe/Paris', '33', [6, 0], 1, 9, 'lmd-cames-20', true, 'Numéro étudiant (INE)', GDPR, 'Hcéres', ['stripe', 'paypal']],
  ['BE', 'Belgium', 'EUR', ['fr', 'nl', 'de'], 'Europe/Brussels', '32', [6, 0], 1, 9, 'lmd-cames-20', true, 'Matricule', GDPR, null, ['stripe', 'paypal']],
  ['LU', 'Luxembourg', 'EUR', ['fr', 'de', 'lb'], 'Europe/Luxembourg', '352', [6, 0], 1, 9, 'lmd-cames-20', true, 'Matricule', GDPR, null, ['stripe', 'paypal']],
  ['CH', 'Switzerland', 'CHF', ['de', 'fr', 'it'], 'Europe/Zurich', '41', [6, 0], 1, 9, 'us-4', true, 'Matrikelnummer', 'Federal Act on Data Protection (nFADP)', 'Swiss Accreditation Council', ['stripe', 'paypal']],
  ['DE', 'Germany', 'EUR', ['de'], 'Europe/Berlin', '49', [6, 0], 1, 10, 'us-4', true, 'Matrikelnummer', GDPR, 'Accreditation Council (Akkreditierungsrat)', ['stripe', 'paypal']],
  ['AT', 'Austria', 'EUR', ['de'], 'Europe/Vienna', '43', [6, 0], 1, 10, 'us-4', true, 'Matrikelnummer', GDPR, 'AQ Austria', ['stripe', 'paypal']],
  ['NL', 'Netherlands', 'EUR', ['nl', 'en'], 'Europe/Amsterdam', '31', [6, 0], 1, 9, 'us-4', true, 'Studentnummer', GDPR, 'NVAO', ['stripe', 'paypal']],
  ['ES', 'Spain', 'EUR', ['es'], 'Europe/Madrid', '34', [6, 0], 1, 9, 'us-4', true, 'Número de expediente', GDPR, 'ANECA', ['stripe', 'paypal']],
  ['PT', 'Portugal', 'EUR', ['pt'], 'Europe/Lisbon', '351', [6, 0], 1, 9, 'lmd-cames-20', true, 'Número de estudante', GDPR, 'A3ES', ['stripe', 'paypal']],
  ['IT', 'Italy', 'EUR', ['it'], 'Europe/Rome', '39', [6, 0], 1, 10, 'us-4', true, 'Matricola', GDPR, 'ANVUR', ['stripe', 'paypal']],
  ['GR', 'Greece', 'EUR', ['el'], 'Europe/Athens', '30', [6, 0], 1, 9, 'us-4', true, 'Αριθμός Μητρώου (Student No.)', GDPR, 'HAHE', ['stripe', 'paypal']],
  ['SE', 'Sweden', 'SEK', ['sv', 'en'], 'Europe/Stockholm', '46', [6, 0], 1, 8, 'us-4', true, 'Student ID', GDPR, 'Swedish Higher Education Authority (UKÄ)', ['stripe', 'paypal']],
  ['NO', 'Norway', 'NOK', ['nb', 'en'], 'Europe/Oslo', '47', [6, 0], 1, 8, 'us-4', true, 'Student Number', GDPR + ' (EEA)', 'NOKUT', ['stripe', 'paypal']],
  ['DK', 'Denmark', 'DKK', ['da', 'en'], 'Europe/Copenhagen', '45', [6, 0], 1, 9, 'us-4', true, 'Student Number', GDPR, 'Danish Accreditation Institution', ['stripe', 'paypal']],
  ['FI', 'Finland', 'EUR', ['fi', 'sv', 'en'], 'Europe/Helsinki', '358', [6, 0], 1, 8, 'us-4', true, 'Student Number', GDPR, 'FINEEC', ['stripe', 'paypal']],
  ['PL', 'Poland', 'PLN', ['pl'], 'Europe/Warsaw', '48', [6, 0], 1, 10, 'us-4', true, 'Numer albumu', GDPR, 'Polish Accreditation Committee (PKA)', ['stripe', 'paypal']],
  ['CZ', 'Czechia', 'CZK', ['cs'], 'Europe/Prague', '420', [6, 0], 1, 9, 'us-4', true, 'Student ID', GDPR, 'National Accreditation Bureau for Higher Education', ['stripe', 'paypal']],
  ['RO', 'Romania', 'RON', ['ro'], 'Europe/Bucharest', '40', [6, 0], 1, 10, 'us-4', true, 'Număr matricol', GDPR, 'ARACIS', ['stripe', 'paypal']],
  ['HU', 'Hungary', 'HUF', ['hu'], 'Europe/Budapest', '36', [6, 0], 1, 9, 'us-4', true, 'Neptun code', GDPR, 'Hungarian Accreditation Committee (MAB)', ['stripe', 'paypal']],
  ['TR', 'Türkiye', 'TRY', ['tr'], 'Europe/Istanbul', '90', [6, 0], 1, 9, 'us-4', true, 'Öğrenci numarası', 'Personal Data Protection Law No. 6698 (KVKK)', 'Council of Higher Education (YÖK)', ['stripe']],
  ['UA', 'Ukraine', 'UAH', ['uk'], 'Europe/Kyiv', '380', [6, 0], 1, 9, 'us-4', true, 'Student ID', 'Law on Personal Data Protection', 'National Agency for Higher Education Quality Assurance (NAQA)', []],
  // ---------------------------------------------------------------- Americas
  ['US', 'United States', 'USD', ['en', 'es'], 'America/New_York', '1', [6, 0], 0, 8, 'us-4', false, 'Student ID', 'FERPA — Family Educational Rights and Privacy Act (20 U.S.C. § 1232g)', 'Recognized accreditor (U.S. Department of Education / CHEA)', ['stripe', 'paypal']],
  ['CA', 'Canada', 'CAD', ['en', 'fr'], 'America/Toronto', '1', [6, 0], 0, 9, 'us-4', true, 'Student Number', 'PIPEDA and provincial privacy laws', 'Provincial ministries of higher education', ['stripe', 'paypal']],
  ['MX', 'Mexico', 'MXN', ['es'], 'America/Mexico_City', '52', [6, 0], 1, 8, 'us-4', true, 'Matrícula', 'Ley Federal de Protección de Datos Personales en Posesión de los Particulares', 'Secretaría de Educación Pública (SEP)', ['stripe', 'paypal']],
  ['BR', 'Brazil', 'BRL', ['pt'], 'America/Sao_Paulo', '55', [6, 0], 0, 2, 'us-4', true, 'Matrícula', 'LGPD — Lei Geral de Proteção de Dados (Lei nº 13.709/2018)', 'Ministério da Educação (MEC)', ['stripe', 'paypal']],
  ['AR', 'Argentina', 'ARS', ['es'], 'America/Argentina/Buenos_Aires', '54', [6, 0], 1, 3, 'us-4', true, 'Legajo', 'Ley 25.326 de Protección de los Datos Personales', 'CONEAU', ['paypal']],
  ['CO', 'Colombia', 'COP', ['es'], 'America/Bogota', '57', [6, 0], 1, 2, 'us-4', true, 'Código estudiantil', 'Ley 1581 de 2012', 'Consejo Nacional de Acreditación (CNA)', ['paypal']],
  ['CL', 'Chile', 'CLP', ['es'], 'America/Santiago', '56', [6, 0], 1, 3, 'us-4', true, 'Número de matrícula', 'Ley 19.628 sobre protección de la vida privada', 'Comisión Nacional de Acreditación (CNA)', ['paypal']],
  ['PE', 'Peru', 'PEN', ['es'], 'America/Lima', '51', [6, 0], 1, 3, 'us-4', true, 'Código de estudiante', 'Ley N° 29733 de Protección de Datos Personales', 'SUNEDU', ['paypal']],
  ['JM', 'Jamaica', 'JMD', ['en'], 'America/Jamaica', '1', [6, 0], 0, 8, 'us-4', true, 'ID Number', 'Data Protection Act, 2020', 'University Council of Jamaica', ['paypal']],
  ['TT', 'Trinidad and Tobago', 'TTD', ['en'], 'America/Port_of_Spain', '1', [6, 0], 0, 9, 'us-4', true, 'Student ID', null, 'Accreditation Council of Trinidad and Tobago', ['paypal']],
  // ---------------------------------------------------------------- Asia & the Middle East
  ['IN', 'India', 'INR', ['en', 'hi'], 'Asia/Kolkata', '91', [0], 1, 7, 'in-ugc-10', false, 'Enrolment No.', 'Digital Personal Data Protection Act, 2023', 'University Grants Commission (UGC)', ['razorpay', 'stripe']],
  ['PK', 'Pakistan', 'PKR', ['en', 'ur'], 'Asia/Karachi', '92', [6, 0], 1, 9, 'us-4', true, 'Registration No.', null, 'Higher Education Commission (HEC)', []],
  ['BD', 'Bangladesh', 'BDT', ['bn', 'en'], 'Asia/Dhaka', '880', [5, 6], 6, 1, 'us-4', true, 'Student ID', null, 'University Grants Commission of Bangladesh (UGC)', []],
  ['LK', 'Sri Lanka', 'LKR', ['en', 'si', 'ta'], 'Asia/Colombo', '94', [6, 0], 1, 1, 'us-4', true, 'Registration No.', 'Personal Data Protection Act, No. 9 of 2022', 'University Grants Commission (UGC)', []],
  ['NP', 'Nepal', 'NPR', ['ne', 'en'], 'Asia/Kathmandu', '977', [6], 0, 9, 'us-4', true, 'Registration No.', 'Individual Privacy Act, 2018', 'University Grants Commission (UGC)', []],
  ['PH', 'Philippines', 'PHP', ['en', 'fil'], 'Asia/Manila', '63', [6, 0], 0, 8, 'us-4', true, 'Student Number', 'Data Privacy Act of 2012', 'Commission on Higher Education (CHED)', ['paypal']],
  ['MY', 'Malaysia', 'MYR', ['ms', 'en'], 'Asia/Kuala_Lumpur', '60', [6, 0], 1, 9, 'us-4', true, 'Matric No.', 'Personal Data Protection Act 2010', 'Malaysian Qualifications Agency (MQA)', ['stripe', 'paypal']],
  ['SG', 'Singapore', 'SGD', ['en', 'zh', 'ms', 'ta'], 'Asia/Singapore', '65', [6, 0], 1, 8, 'us-4', true, 'Matriculation No.', 'Personal Data Protection Act 2012 (PDPA)', 'Ministry of Education', ['stripe', 'paypal']],
  ['ID', 'Indonesia', 'IDR', ['id'], 'Asia/Jakarta', '62', [6, 0], 1, 8, 'us-4', true, 'NIM', 'Personal Data Protection Law (UU PDP) No. 27 of 2022', 'BAN-PT', ['paypal']],
  ['VN', 'Vietnam', 'VND', ['vi'], 'Asia/Ho_Chi_Minh', '84', [6, 0], 1, 9, 'us-4', true, 'Mã số sinh viên (Student ID)', 'Decree 13/2023/ND-CP on personal data protection', 'Ministry of Education and Training', ['paypal']],
  ['TH', 'Thailand', 'THB', ['th'], 'Asia/Bangkok', '66', [6, 0], 0, 6, 'us-4', true, 'Student ID', 'Personal Data Protection Act B.E. 2562 (2019)', 'Office of the Permanent Secretary for Higher Education', ['stripe', 'paypal']],
  ['CN', 'China', 'CNY', ['zh'], 'Asia/Shanghai', '86', [6, 0], 1, 9, 'us-4', true, '学号 (Student No.)', 'Personal Information Protection Law (PIPL)', 'Ministry of Education', []],
  ['JP', 'Japan', 'JPY', ['ja'], 'Asia/Tokyo', '81', [6, 0], 0, 4, 'us-4', true, '学籍番号 (Student No.)', 'Act on the Protection of Personal Information (APPI)', 'Ministry of Education (MEXT)', ['stripe', 'paypal']],
  ['KR', 'South Korea', 'KRW', ['ko'], 'Asia/Seoul', '82', [6, 0], 0, 3, 'us-4', true, '학번 (Student No.)', 'Personal Information Protection Act (PIPA)', 'Ministry of Education', ['paypal']],
  ['KZ', 'Kazakhstan', 'KZT', ['kk', 'ru'], 'Asia/Almaty', '7', [6, 0], 1, 9, 'us-4', true, 'Student ID', 'Law on Personal Data and Their Protection', 'Ministry of Science and Higher Education', []],
  ['SA', 'Saudi Arabia', 'SAR', ['ar', 'en'], 'Asia/Riyadh', '966', [5, 6], 0, 8, 'sa-5', false, 'University ID', 'Personal Data Protection Law (PDPL)', 'Education & Training Evaluation Commission (ETEC)', ['stripe']],
  ['AE', 'United Arab Emirates', 'AED', ['ar', 'en'], 'Asia/Dubai', '971', [6, 0], 1, 9, 'us-4', true, 'Student ID', 'Federal Decree-Law No. 45 of 2021 (PDPL)', 'Commission for Academic Accreditation (CAA)', ['stripe', 'paypal']],
  ['QA', 'Qatar', 'QAR', ['ar', 'en'], 'Asia/Qatar', '974', [5, 6], 0, 8, 'us-4', true, 'Student ID', 'Law No. 13 of 2016 on Personal Data Privacy Protection', 'Ministry of Education and Higher Education', ['stripe']],
  ['KW', 'Kuwait', 'KWD', ['ar', 'en'], 'Asia/Kuwait', '965', [5, 6], 0, 9, 'us-4', true, 'Student ID', null, 'Private Universities Council', []],
  ['BH', 'Bahrain', 'BHD', ['ar', 'en'], 'Asia/Bahrain', '973', [5, 6], 0, 9, 'us-4', true, 'Student ID', 'Law No. 30 of 2018 (Personal Data Protection)', 'Higher Education Council', ['stripe']],
  ['OM', 'Oman', 'OMR', ['ar', 'en'], 'Asia/Muscat', '968', [5, 6], 0, 9, 'us-4', true, 'Student ID', 'Royal Decree 6/2022 (Personal Data Protection Law)', 'Oman Authority for Academic Accreditation and Quality Assurance (OAAAQA)', []],
  ['JO', 'Jordan', 'JOD', ['ar', 'en'], 'Asia/Amman', '962', [5, 6], 0, 9, 'us-4', true, 'University No.', 'Personal Data Protection Law No. 24 of 2023', 'Accreditation and Quality Assurance Commission for Higher Education Institutions', []],
  ['LB', 'Lebanon', 'LBP', ['ar', 'fr', 'en'], 'Asia/Beirut', '961', [6, 0], 1, 9, 'us-4', true, 'Student ID', null, 'Ministry of Education and Higher Education', []],
  ['IQ', 'Iraq', 'IQD', ['ar'], 'Asia/Baghdad', '964', [5, 6], 6, 9, 'us-4', true, 'Student ID', null, 'Ministry of Higher Education and Scientific Research', []],
  ['IL', 'Israel', 'ILS', ['he', 'ar', 'en'], 'Asia/Jerusalem', '972', [5, 6], 0, 10, 'us-4', true, 'Student ID', 'Protection of Privacy Law, 5741-1981', 'Council for Higher Education', ['stripe', 'paypal']],
  ['IR', 'Iran', 'IRR', ['fa'], 'Asia/Tehran', '98', [5], 6, 9, 'lmd-cames-20', true, 'Student No.', null, 'Ministry of Science, Research and Technology', []],
  // ---------------------------------------------------------------- Oceania
  ['AU', 'Australia', 'AUD', ['en'], 'Australia/Sydney', '61', [6, 0], 1, 2, 'au-7', false, 'Student ID', 'Privacy Act 1988 (Australian Privacy Principles)', 'Tertiary Education Quality and Standards Agency (TEQSA)', ['stripe', 'paypal']],
  ['NZ', 'New Zealand', 'NZD', ['en', 'mi'], 'Pacific/Auckland', '64', [6, 0], 1, 2, 'au-7', true, 'Student ID', 'Privacy Act 2020', 'NZQA / Universities New Zealand', ['stripe', 'paypal']],
  ['FJ', 'Fiji', 'FJD', ['en'], 'Pacific/Fiji', '679', [6, 0], 1, 2, 'us-4', true, 'Student ID', null, 'Fiji Higher Education Commission', ['paypal']],
  ['PG', 'Papua New Guinea', 'PGK', ['en'], 'Pacific/Port_Moresby', '675', [6, 0], 1, 2, 'us-4', true, 'Student ID', null, 'Department of Higher Education, Research, Science and Technology', []],
];

// Names of the languages the packs reference (English + native) — for pickers and language-pack prompts.
const LANGUAGE_NAMES = {
  en: ['English', 'English'], fr: ['French', 'Français'], es: ['Spanish', 'Español'], pt: ['Portuguese', 'Português'], ar: ['Arabic', 'العربية'],
  ha: ['Hausa', 'Hausa'], sw: ['Swahili', 'Kiswahili'], rw: ['Kinyarwanda', 'Ikinyarwanda'], am: ['Amharic', 'አማርኛ'], mg: ['Malagasy', 'Malagasy'],
  rn: ['Kirundi', 'Ikirundi'], de: ['German', 'Deutsch'], nl: ['Dutch', 'Nederlands'], it: ['Italian', 'Italiano'], el: ['Greek', 'Ελληνικά'],
  sv: ['Swedish', 'Svenska'], nb: ['Norwegian', 'Norsk bokmål'], da: ['Danish', 'Dansk'], fi: ['Finnish', 'Suomi'], pl: ['Polish', 'Polski'],
  cs: ['Czech', 'Čeština'], ro: ['Romanian', 'Română'], hu: ['Hungarian', 'Magyar'], tr: ['Turkish', 'Türkçe'], uk: ['Ukrainian', 'Українська'],
  ga: ['Irish', 'Gaeilge'], lb: ['Luxembourgish', 'Lëtzebuergesch'], hi: ['Hindi', 'हिन्दी'], ur: ['Urdu', 'اردو'], bn: ['Bengali', 'বাংলা'],
  si: ['Sinhala', 'සිංහල'], ta: ['Tamil', 'தமிழ்'], ne: ['Nepali', 'नेपाली'], fil: ['Filipino', 'Filipino'], ms: ['Malay', 'Bahasa Melayu'],
  id: ['Indonesian', 'Bahasa Indonesia'], vi: ['Vietnamese', 'Tiếng Việt'], th: ['Thai', 'ไทย'], zh: ['Chinese', '中文'], ja: ['Japanese', '日本語'],
  ko: ['Korean', '한국어'], kk: ['Kazakh', 'Қазақ тілі'], ru: ['Russian', 'Русский'], he: ['Hebrew', 'עברית'], fa: ['Persian', 'فارسی'], mi: ['Māori', 'Te Reo Māori'],
};
const RTL = ['ar', 'he', 'fa', 'ur'];

/** The DEFAULT vocabulary each tradition uses for its units (the Launchpad offers these as one-click presets). */
const VOCABULARIES = {
  commonwealth: { label: 'Faculty · Department (Commonwealth)', terms: {} },
  college: { label: 'College · Department (US style)', terms: { Faculty: 'College', Faculties: 'Colleges', 'Faculty Overview': 'College Overview', Dean: 'Dean', 'Heads of Dept': 'Department Chairs', 'Head of Department': 'Department Chair', HOD: 'Chair' } },
  school: { label: 'School · Department', terms: { Faculty: 'School', Faculties: 'Schools', 'Faculty Overview': 'School Overview' } },
  ufr: { label: 'UFR · Département (francophone)', terms: { Faculty: 'UFR', Faculties: 'UFR', 'Faculty Overview': 'Aperçu des UFR', Department: 'Département', Level: 'Niveau' } },
};

const toPack = (r) => ({
  code: r[0], name: r[1], currency: r[2], languages: r[3], language: r[3][0], timezone: r[4], dial: r[5], weekend: r[6], weekStart: r[7],
  yearStartMonth: r[8], standard: r[9], standardApprox: !!r[10], idLabel: r[11], privacyLaw: r[12], regulator: r[13], gateways: r[14],
  locale: `${r[3][0]}-${r[0]}`, rtl: RTL.includes(r[3][0]),
  vocabulary: r[9] === 'lmd-cames-20' && r[3][0] === 'fr' ? 'ufr' : r[9] === 'us-4' && r[0] === 'US' ? 'college' : 'commonwealth',
});
const PACKS = ROWS.map(toPack);
// other names people write (local-language / unaccented / common short forms) — for guess() and search()
const ALIASES = {
  BJ: ['bénin'], SN: ['sénégal'], CI: ['cote d ivoire', 'ivory coast'], CM: ['cameroun'], TD: ['tchad'], MA: ['maroc'], DZ: ['algérie', 'algerie'], TN: ['tunisie'],
  GN: ['guinée', 'guinee'], CD: ['rdc', 'drc', 'république démocratique du congo', 'democratic republic of the congo'], CG: ['congo-brazzaville', 'congo'], CF: ['centrafrique'],
  NG: ['nigéria'], EG: ['égypte', 'egypte'], ZA: ['afrique du sud', 'rsa'], GB: ['uk', 'great britain', 'england', 'scotland', 'wales', 'northern ireland', 'royaume-uni'],
  US: ['usa', 'united states of america', 'états-unis', 'etats-unis', 'america'], AE: ['uae', 'emirates', 'émirats arabes unis'], SA: ['ksa', 'arabie saoudite'],
  DE: ['deutschland', 'allemagne'], ES: ['españa', 'espagne'], IT: ['italia', 'italie'], CH: ['suisse', 'schweiz', 'svizzera'], BE: ['belgique', 'belgië'],
  NL: ['holland', 'nederland', 'pays-bas'], BR: ['brasil', 'brésil'], MX: ['méxico', 'mexique'], TR: ['turkey', 'turquie'], GM: ['gambia'], KR: ['korea'],
  CZ: ['czech republic'], MG: ['madagasikara'], BI: ['burundi'], MZ: ['moçambique'], AO: ['angola'], CV: [],
};
const foldTxt = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’'`]/g, ' ');
const NAMES = PACKS.flatMap(p => [p.name].concat(ALIASES[p.code] || []).map(n => ({ p, n: foldTxt(n) })));
// nationality ADJECTIVES people write in a "Nationality" field that are not simply the name + a suffix
const DEMONYMS = {
  ivorian: 'CI', moroccan: 'MA', british: 'GB', english: 'GB', scottish: 'GB', welsh: 'GB', american: 'US', french: 'FR', german: 'DE', dutch: 'NL', swiss: 'CH', belgian: 'BE',
  chinese: 'CN', japanese: 'JP', korean: 'KR', filipino: 'PH', filipina: 'PH', burkinabe: 'BF', burkinabè: 'BF', malagasy: 'MG', leonean: 'SL', sierraleonean: 'SL', gambian: 'GM',
  emirati: 'AE', saudi: 'SA', qatari: 'QA', kuwaiti: 'KW', bahraini: 'BH', omani: 'OM', jordanian: 'JO', lebanese: 'LB', iraqi: 'IQ', iranian: 'IR', israeli: 'IL', turkish: 'TR',
  pakistani: 'PK', bangladeshi: 'BD', indian: 'IN', nepali: 'NP', nepalese: 'NP', 'sri lankan': 'LK', malaysian: 'MY', singaporean: 'SG', indonesian: 'ID', vietnamese: 'VN', thai: 'TH',
  brazilian: 'BR', mexican: 'MX', argentine: 'AR', argentinian: 'AR', colombian: 'CO', chilean: 'CL', peruvian: 'PE', jamaican: 'JM', trinidadian: 'TT', canadian: 'CA',
  spanish: 'ES', portuguese: 'PT', italian: 'IT', greek: 'GR', swedish: 'SE', norwegian: 'NO', danish: 'DK', finnish: 'FI', polish: 'PL', czech: 'CZ', romanian: 'RO', hungarian: 'HU', ukrainian: 'UA', irish: 'IE',
  australian: 'AU', 'new zealander': 'NZ', kiwi: 'NZ', fijian: 'FJ', motswana: 'BW', batswana: 'BW', basotho: 'LS', swazi: 'SZ', congolese: 'CD', 'south african': 'ZA', 'south sudanese': 'SS', cabo: 'CV',
  nigerien: 'NE', nigerian: 'NG', 'bissau-guinean': 'GW', guinean: 'GN', beninese: 'BJ', togolese: 'TG', senegalese: 'SN', sudanese: 'SD', mauritian: 'MU', malian: 'ML', chadian: 'TD', gabonese: 'GA',
};
/** A nationality adjective → its pack ("Ghanaian" → GH): an explicit word first, then the country name + a suffix. */
function demonym(t) {
  const words = foldTxt(t).replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(Boolean);
  const joined = words.join(' ');
  for (const [w, code] of Object.entries(DEMONYMS)) { const fw = foldTxt(w); if ((' ' + joined + ' ').includes(' ' + fw + ' ') && BY_CODE[code]) return BY_CODE[code]; }
  for (const word of words) {
    if (word.length < 5) continue;
    const hit = NAMES.filter(x => !x.n.includes(' ') && x.n.length >= 4 && word.startsWith(x.n.slice(0, Math.max(4, x.n.length - 1))) && word.length - x.n.length <= 4).sort((a, b) => b.n.length - a.n.length)[0];
    if (hit) return hit.p;
  }
  return null;
}
const BY_CODE = Object.fromEntries(PACKS.map(p => [p.code, p]));

/** One country's pack (case-insensitive ISO 3166-1 alpha-2), or null. */
function pack(code) { return BY_CODE[String(code || '').toUpperCase()] || null; }
/** Every pack, sorted by name (for pickers). */
function list() { return PACKS.slice().sort((a, b) => a.name.localeCompare(b.name)); }
/** Find packs by name / code / currency / language — for the search box. */
function search(q) {
  const f = foldTxt(q).trim();
  if (!f) return list();
  const rank = (p) => {
    const names = NAMES.filter(x => x.p === p).map(x => x.n);
    if (p.code.toLowerCase() === f || names.some(n => n === f)) return 0;
    if (names.some(n => n.startsWith(f))) return 1;
    if (names.some(n => n.includes(f))) return 2;
    if (p.currency.toLowerCase() === f) return 3;
    if (p.languages.some(l => l === f || (LANGUAGE_NAMES[l] || []).some(n => foldTxt(n).includes(f)))) return 4;
    return 9;
  };
  return list().map(p => [rank(p), p]).filter(x => x[0] < 9).sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).map(x => x[1]);
}
/** Best guess of a country from free text (a name, a code, an address line, a phone number). */
function guess(text) {
  const t = String(text || '');
  const dial = /^\s*\+?(\d{1,3})[\s-]/.exec(t);
  const lower = ' ' + foldTxt(t).replace(/[^a-z0-9]+/g, ' ') + ' ';
  const hit = NAMES.filter(x => lower.includes(' ' + x.n.replace(/[^a-z0-9]+/g, ' ').trim() + ' ')).sort((a, b) => b.n.length - a.n.length)[0];
  if (hit) return hit.p;
  const dem = demonym(t); if (dem) return dem;
  const code = /\b([A-Z]{2})\b/.exec(t); if (code && BY_CODE[code[1]]) return BY_CODE[code[1]];
  if (dial) { const m = PACKS.filter(p => p.dial === dial[1]); if (m.length === 1) return m[0]; }
  return null;
}
/** Human name of a language code ("fr" → "French · Français"). */
function languageName(code) { const n = LANGUAGE_NAMES[String(code || '').toLowerCase()]; return n ? (n[0] === n[1] ? n[0] : `${n[0]} · ${n[1]}`) : String(code || ''); }
const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** A one-paragraph, human description of a pack (for previews and the AI brain). */
function describe(p) {
  if (!p) return '';
  return `${p.name}: currency ${p.currency}; language ${p.languages.map(languageName).join(', ')}; time zone ${p.timezone}; dialling code +${p.dial}; weekend ${p.weekend.map(d => DAY[d]).join(' & ')}; `
    + `academic year usually starts in ${MONTH[p.yearStartMonth - 1]}; student ID called "${p.idLabel}"`
    + (p.privacyLaw ? `; data protection: ${p.privacyLaw}` : '') + (p.regulator ? `; regulator: ${p.regulator}` : '') + '.';
}

/**
 * Format money the way a country writes it — Intl-driven (grouping, decimal mark, minor units: JPY 0,
 * KWD 3…) with the institution's own symbol when it set one. Falls back to en-US grouping on engines
 * without full ICU.
 */
function formatMoney(amount, currency, locale, symbol) {
  const n = Number(amount || 0);
  const loc = latn(locale || 'en-US');
  try {
    // Intl places the symbol where the country writes it ("₦1,234.50", "1 234 568 F CFA", "1.234,50 €")
    // and knows each currency's minor units (JPY 0, KWD 3); the institution's own symbol replaces Intl's.
    const parts = new Intl.NumberFormat(loc, { style: 'currency', currency: currency || 'USD', currencyDisplay: 'narrowSymbol' }).formatToParts(n);
    return parts.map(x => x.type === 'currency' ? (symbol || x.value) : x.value).join('').replace(/\u00a0|\u202f/g, ' ').trim();
  } catch (_) {
    const body = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const sym = symbol || currency || '';
    return `${sym}${/^[A-Z]{3}$/.test(sym) ? ' ' : ''}${body}`;
  }
}
/** Western (latn) digits unless the locale already asks for a numbering system — records, documents and
 *  data entry use 0-9 even where the everyday script differs (e.g. ar-SA would otherwise print ١٢٣). */
function latn(locale) { const l = String(locale || 'en-US'); return /-u-.*nu-/.test(l) ? l : (l.includes('-u-') ? l + '-nu-latn' : l + '-u-nu-latn'); }
/** Format a number with the locale's grouping + decimal mark (Western digits). */
function formatNumber(n, locale, digits) {
  const o = digits == null ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits };
  try { return Number(n || 0).toLocaleString(latn(locale || 'en-US'), o); } catch (_) { return Number(n || 0).toLocaleString('en-US', o); }
}
/** The narrow symbol a locale uses for a currency ("₦", "CFA", "€", "KSh"…), or the ISO code. */
function currencySymbol(currency, locale) {
  try {
    const parts = new Intl.NumberFormat(locale || 'en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).formatToParts(0);
    const s = parts.find(x => x.type === 'currency');
    return s ? s.value : currency;
  } catch (_) { return currency || ''; }
}

module.exports = { PACKS, VOCABULARIES, LANGUAGE_NAMES, RTL, pack, list, search, guess, languageName, describe, formatMoney, formatNumber, currencySymbol, latn };
