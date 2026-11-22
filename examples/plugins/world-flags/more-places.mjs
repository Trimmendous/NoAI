// Places 101–239 on Wikipedia's "List of countries and dependencies by
// population": the rest of the countries, plus dependencies, territories and
// places whose status is disputed. `note` (last argument) records each
// judgement call; build.mjs lists them in the README.
import { n, rect, circle, poly, bandsH, bandsV, star, crescent, hoist, unionJack, nordic, c, ensign, shield, band, nordicBordered, starRing } from './draw.mjs';

const SOVEREIGNTY = 'Sovereignty disputed';
const RECOGNITION = 'Limited recognition';
const FRENCH = 'Officially uses the French flag';

export const MORE = [
  c('by', 'Belarus', '#E04150', '#C8313E', () => bandsH(['#C8313E', '#4AA657'], [2, 1], 900, 600) + rect(0, 0, 900 / 9, 600, '#FFFFFF')
    + Array.from({ length: 6 }, (_, i) => poly([[50, 20 + i * 100], [85, 70 + i * 100], [50, 120 + i * 100], [15, 70 + i * 100]], '#C8313E')).join(''), [900, 600]),
  c('tg', 'Togo', '#FFCE00', '#006A4E', () => bandsH(['#006A4E', '#FFCE00', '#006A4E', '#FFCE00', '#006A4E'], [1, 1, 1, 1, 1], 970, 600) + rect(0, 0, 360, 360, '#D21034') + star(180, 185, 110, '#FFFFFF'), [970, 600]),
  c('la', 'Laos', '#E0384A', '#002868', () => bandsH(['#CE1126', '#002868', '#CE1126'], [1, 2, 1]) + circle(450, 300, 120, '#FFFFFF')),
  c('ly', 'Libya', '#2DB458', '#239E46', () => bandsH(['#E70013', '#000000', '#239E46'], [1, 2, 1], 1200, 600) + crescent(570, 300, 75, 18, 0, 62, '#FFFFFF', '#000000') + star(640, 300, 36, '#FFFFFF', -90), [1200, 600]),
  c('hk', 'Hong Kong', '#E8473A', '#DE2910', () => rect(0, 0, 900, 600, '#DE2910')
    + Array.from({ length: 5 }, (_, i) => `<ellipse cx="450" cy="215" rx="55" ry="95" fill="#FFFFFF" transform="rotate(${i * 72} 450 300)"/>`).join('')
    + Array.from({ length: 5 }, (_, i) => `<g transform="rotate(${i * 72} 450 300)">${star(450, 200, 14, '#DE2910')}</g>`).join(''),
    undefined, 'Special administrative region of China, not a country'),
  c('kg', 'Kyrgyzstan', '#FFEF00', '#E8112D', () => rect(0, 0, 1000, 600, '#E8112D') + star(500, 300, 170, '#FFEF00', 0, 40, 0.75) + circle(500, 300, 100, '#E8112D') + circle(500, 300, 86, '#FFEF00')
    + `<g stroke="#E8112D" stroke-width="12" fill="none"><path d="M425,260 Q500,340 575,260"/><path d="M425,340 Q500,260 575,340"/><line x1="500" y1="214" x2="500" y2="386"/></g>`, [1000, 600]),
  c('tm', 'Turkmenistan', '#2EA35C', '#00843D', () => rect(0, 0, 900, 600, '#00843D') + rect(120, 0, 150, 600, '#D22630')
    + Array.from({ length: 5 }, (_, i) => circle(195, 70 + i * 115, 42, '#F9F9F9') + circle(195, 70 + i * 115, 26, '#D22630')).join('')
    + crescent(390, 110, 60, 22, 0, 52, '#FFFFFF', '#00843D') + [[455, 60], [490, 100], [455, 140], [520, 70], [520, 130]].map(([x, y]) => star(x, y, 14, '#FFFFFF')).join('')),
  c('ni', 'Nicaragua', '#2F86D6', '#0067C6', () => bandsH(['#0067C6', '#FFFFFF', '#0067C6'], [1, 1, 1], 1000, 600) + poly([[500, 235], [560, 345], [440, 345]], '#3FA2D8') + `<polygon points="500,235 560,345 440,345" fill="none" stroke="#C8A600" stroke-width="6"/>`, [1000, 600]),
  c('rs', 'Serbia', '#D94A50', '#0C4076', () => bandsH(['#C6363C', '#0C4076', '#FFFFFF']) + shield(220, 150, 160, 220, '#C6363C', '#D4AF37') + rect(292, 170, 16, 170, '#FFFFFF') + rect(240, 240, 120, 16, '#FFFFFF')),
  c('cf', 'Central African Republic', '#FFCE00', '#003082', () => bandsH(['#003082', '#FFFFFF', '#289728', '#FFCE00']) + rect(390, 0, 120, 600, '#D21034') + star(110, 75, 50, '#FFCE00')),
  c('bg', 'Bulgaria', '#25A27C', '#00966E', () => bandsH(['#FFFFFF', '#00966E', '#D62612'], [1, 1, 1], 1000, 600), [1000, 600]),
  c('sg', 'Singapore', '#EF3340', '#EF3340', () => bandsH(['#EF3340', '#FFFFFF']) + crescent(170, 150, 95, 35, 0, 90, '#FFFFFF', '#EF3340')
    + [[290, 90], [330, 140], [315, 200], [265, 200], [250, 140]].map(([x, y]) => star(x, y, 22, '#FFFFFF')).join('')),
  c('cg', 'Republic of the Congo', '#FBDE4A', '#009543', () => rect(0, 0, 900, 600, '#DC241F') + poly([[0, 0], [600, 0], [0, 600]], '#009543') + poly([[600, 0], [900, 0], [300, 600], [0, 600]], '#FBDE4A')
    + poly([[900, 0], [900, 600], [300, 600]], '#DC241F')),
  c('py', 'Paraguay', '#D52B1E', '#0038A8', () => bandsH(['#D52B1E', '#FFFFFF', '#0038A8'], [1, 1, 1], 1100, 600) + circle(550, 300, 80, '#FFFFFF') + `<circle cx="550" cy="300" r="70" fill="none" stroke="#2E7D32" stroke-width="8"/>` + star(550, 300, 30, '#FCD116'), [1100, 600]),
  c('dk', 'Denmark', '#E03A4F', '#C8102E', () => rect(0, 0, 1110, 840, '#C8102E') + nordic(360, 120, '#FFFFFF', 1110, 840), [1110, 840]),
  c('sv', 'El Salvador', '#2E6BD6', '#0F47AF', () => bandsH(['#0F47AF', '#FFFFFF', '#0F47AF'], [1, 1, 1], 1065, 600) + poly([[532, 240], [592, 345], [472, 345]], '#0F47AF') + `<circle cx="532" cy="305" r="80" fill="none" stroke="#D4AF37" stroke-width="7"/>`, [1065, 600]),
  c('lb', 'Lebanon', '#ED1C24', '#00A651', () => bandsH(['#ED1C24', '#FFFFFF', '#ED1C24'], [1, 2, 1]) + poly([[450, 170], [540, 300], [500, 300], [570, 400], [330, 400], [400, 300], [360, 300]], '#00A651') + rect(440, 400, 20, 35, '#00A651')),
  c('fi', 'Finland', '#2E66B8', '#002F6C', () => rect(0, 0, 1800, 1100, '#FFFFFF') + nordic(500, 300, '#002F6C', 1800, 1100), [1800, 1100]),
  c('no', 'Norway', '#E0384F', '#00205B', () => rect(0, 0, 1100, 800, '#BA0C2F') + nordicBordered(300, 200, 100, '#FFFFFF', '#00205B', 1100, 800), [1100, 800]),
  c('ps', 'Palestine', '#2FA35A', '#007A3D', () => bandsH(['#000000', '#FFFFFF', '#007A3D'], [1, 1, 1], 1200, 600) + hoist(400, '#CE1126'), [1200, 600], `${RECOGNITION}: recognised by most UN members; a UN observer state, not a full member`),
  c('ie', 'Ireland', '#FF883E', '#169B62', () => bandsV(['#169B62', '#FFFFFF', '#FF883E'], [1, 1, 1], 1200, 600), [1200, 600]),
  c('om', 'Oman', '#2EA35C', '#DB161B', () => rect(0, 0, 900, 450, '#DB161B') + rect(300, 0, 600, 150, '#FFFFFF') + rect(300, 300, 600, 150, '#008000')
    + `<g stroke="#FFFFFF" stroke-width="12" stroke-linecap="round"><line x1="80" y1="40" x2="220" y2="150"/><line x1="220" y1="40" x2="80" y2="150"/><line x1="150" y1="40" x2="150" y2="160"/></g>`, [900, 450]),
  c('sk', 'Slovakia', '#2E6AC0', '#0B4EA2', () => bandsH(['#FFFFFF', '#0B4EA2', '#EE1C25']) + shield(205, 135, 190, 260, '#EE1C25', '#FFFFFF')
    + rect(290, 165, 20, 170, '#FFFFFF') + rect(250, 205, 100, 16, '#FFFFFF') + rect(240, 250, 120, 16, '#FFFFFF') + poly([[220, 380], [260, 330], [300, 370], [340, 330], [380, 380], [300, 430]], '#0B4EA2')),
  c('nz', 'New Zealand', '#E03550', '#00247D', () => ensign('#00247D') + [[900, 150], [810, 290], [1010, 270], [900, 470]].map(([x, y], i) => star(x, y, i === 2 ? 38 : 48, '#FFFFFF') + star(x, y, i === 2 ? 28 : 36, '#CC142B')).join(''), [1200, 600]),
  c('lr', 'Liberia', '#E0384F', '#002868', () => {
    let out = '';
    for (let i = 0; i < 11; i++) out += rect(0, i * 600 / 11, 1140, 600 / 11 + 0.5, i % 2 ? '#FFFFFF' : '#BF0A30');
    return out + rect(0, 0, 275, 275, '#002868') + star(137, 140, 90, '#FFFFFF');
  }, [1140, 600]),
  c('cr', 'Costa Rica', '#E0384F', '#002B7F', () => bandsH(['#002B7F', '#FFFFFF', '#CE1126', '#FFFFFF', '#002B7F'], [1, 1, 2, 1, 1], 1000, 600), [1000, 600]),
  c('mr', 'Mauritania', '#FFD700', '#006233', () => bandsH(['#D01C1F', '#006233', '#D01C1F'], [1, 3, 1]) + crescent(450, 270, 130, 0, -45, 115, '#FFD700', '#006233') + star(450, 230, 45, '#FFD700')),
  c('kw', 'Kuwait', '#2FA35A', '#007A3D', () => bandsH(['#007A3D', '#FFFFFF', '#CE1126'], [1, 1, 1], 1200, 600) + poly([[0, 0], [300, 200], [300, 400], [0, 600]], '#000000'), [1200, 600]),
  c('pa', 'Panama', '#DA121A', '#072357', () => rect(0, 0, 450, 300, '#FFFFFF') + rect(450, 0, 450, 300, '#DA121A') + rect(0, 300, 450, 300, '#072357') + rect(450, 300, 450, 300, '#FFFFFF')
    + star(225, 150, 70, '#072357') + star(675, 450, 70, '#DA121A')),
  c('ge', 'Georgia', '#FF2D2D', '#FF0000', () => {
    const small = (x, y) => rect(x - 12, y - 50, 24, 100, '#FF0000') + rect(x - 50, y - 12, 100, 24, '#FF0000');
    return rect(0, 0, 900, 600, '#FFFFFF') + rect(390, 0, 120, 600, '#FF0000') + rect(0, 240, 900, 120, '#FF0000') + small(195, 120) + small(705, 120) + small(195, 480) + small(705, 480);
  }),
  c('hr', 'Croatia', '#2E2EB8', '#171796', () => {
    let out = bandsH(['#FF0000', '#FFFFFF', '#171796'], [1, 1, 1], 1200, 600);
    for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++) out += rect(525 + col * 30, 180 + row * 30, 30, 30, (row + col) % 2 ? '#FFFFFF' : '#FF0000');
    return out + `<rect x="525" y="180" width="150" height="150" fill="none" stroke="#171796" stroke-width="6"/>` + `<path d="M525,330 L525,345 Q600,420 675,345 L675,330 Z" fill="#FF0000"/>`;
  }, [1200, 600]),
  c('er', 'Eritrea', '#EA0437', '#12AD2B', () => poly([[0, 0], [1200, 0], [1200, 300]], '#12AD2B') + poly([[0, 600], [1200, 600], [1200, 300]], '#4189DD') + poly([[0, 0], [1200, 300], [0, 600]], '#EA0437')
    + `<circle cx="250" cy="300" r="115" fill="none" stroke="#FFC726" stroke-width="16"/><line x1="250" y1="200" x2="250" y2="420" stroke="#FFC726" stroke-width="14"/>`, [1200, 600]),
  c('mn', 'Mongolia', '#F9CF02', '#015197', () => bandsV(['#C4272F', '#015197', '#C4272F'], [1, 1, 1], 1200, 600)
    + circle(200, 160, 40, '#F9CF02') + crescent(200, 230, 45, 0, -18, 40, '#F9CF02', '#C4272F') + rect(150, 280, 100, 20, '#F9CF02') + circle(200, 360, 45, '#F9CF02') + rect(150, 420, 100, 20, '#F9CF02')
    + rect(110, 160, 25, 280, '#F9CF02') + rect(265, 160, 25, 280, '#F9CF02'), [1200, 600]),
  c('uy', 'Uruguay', '#2E6AD6', '#0038A8', () => {
    let out = '';
    for (let i = 0; i < 9; i++) out += rect(0, i * 600 / 9, 900, 600 / 9 + 0.5, i % 2 ? '#0038A8' : '#FFFFFF');
    return out + rect(0, 0, 333, 333, '#FFFFFF') + star(166, 166, 110, '#FCD116', 0, 16, 0.6) + circle(166, 166, 55, '#FCD116');
  }),
  c('ba', 'Bosnia and Herzegovina', '#FECB00', '#002395', () => rect(0, 0, 1000, 500, '#002395') + poly([[250, 0], [750, 0], [750, 500]], '#FECB00')
    + Array.from({ length: 9 }, (_, i) => star(185 + i * 60, -30 + i * 62, 30, '#FFFFFF')).join(''), [1000, 500]),
  c('qa', 'Qatar', '#B3365A', '#8A1538', () => rect(0, 0, 1100, 430, '#8A1538') + poly([[0, 0], [300, 0], ...Array.from({ length: 9 }, (_, i) => [[400, i * 430 / 9 + 430 / 18], [300, (i + 1) * 430 / 9]]).flat(), [0, 430]], '#FFFFFF'), [1100, 430]),
  c('pr', 'Puerto Rico', '#ED0000', '#0050F0', () => bandsH(['#ED0000', '#FFFFFF', '#ED0000', '#FFFFFF', '#ED0000']) + hoist(390, '#0050F0') + star(130, 300, 70, '#FFFFFF'),
    undefined, 'Territory of the United States, not a country'),
  c('am', 'Armenia', '#F2A800', '#0033A0', () => bandsH(['#D90012', '#0033A0', '#F2A800'], [1, 1, 1], 1200, 600), [1200, 600]),
  c('na', 'Namibia', '#FFCE00', '#003580', () => poly([[0, 0], [900, 0], [0, 600]], '#003580') + poly([[900, 0], [900, 600], [0, 600]], '#009543') + band(0, 600, 900, 0, 160, '#D21034', '#FFFFFF', 30)
    + star(150, 130, 85, '#FFCE00', 0, 12, 0.55) + circle(150, 130, 45, '#003580') + circle(150, 130, 38, '#FFCE00')),
  c('lt', 'Lithuania', '#FDB913', '#006A44', () => bandsH(['#FDB913', '#006A44', '#C1272D'], [1, 1, 1], 1000, 600), [1000, 600]),
  c('jm', 'Jamaica', '#FED100', '#009B3A', () => poly([[0, 0], [1200, 0], [600, 300]], '#009B3A') + poly([[0, 600], [1200, 600], [600, 300]], '#009B3A') + poly([[0, 0], [0, 600], [600, 300]], '#000000') + poly([[1200, 0], [1200, 600], [600, 300]], '#000000')
    + `<path d="M0,0 L1200,600 M1200,0 L0,600" stroke="#FED100" stroke-width="80"/>`, [1200, 600]),
  c('bw', 'Botswana', '#75AADB', '#75AADB', () => bandsH(['#75AADB', '#FFFFFF', '#000000', '#FFFFFF', '#75AADB'], [9, 1, 4, 1, 9])),
  c('ga', 'Gabon', '#FCD116', '#009E60', () => bandsH(['#009E60', '#FCD116', '#3A75C4'], [1, 1, 1], 800, 600), [800, 600]),
  c('gm', 'Gambia', '#3A7728', '#0C1C8C', () => bandsH(['#CE1126', '#FFFFFF', '#0C1C8C', '#FFFFFF', '#3A7728'], [6, 1, 4, 1, 6])),
  c('md', 'Moldova', '#FFD200', '#0046AE', () => bandsV(['#0046AE', '#FFD200', '#CC092F'], [1, 1, 1], 1200, 600) + shield(545, 230, 110, 150, '#CC092F', '#0046AE') + poly([[600, 150], [660, 200], [640, 230], [600, 210], [560, 230], [540, 200]], '#A0522D'), [1200, 600]),
  c('al', 'Albania', '#E41E20', '#E41E20', () => rect(0, 0, 980, 700, '#E41E20')
    + poly([[490, 200], [560, 150], [620, 190], [580, 230], [700, 220], [640, 330], [560, 330], [520, 420], [580, 520], [490, 470], [400, 520], [460, 420], [420, 330], [340, 330], [280, 220], [400, 230], [360, 190], [420, 150]], '#000000'), [980, 700]),
  c('si', 'Slovenia', '#2E7DC8', '#005DA4', () => bandsH(['#FFFFFF', '#005DA4', '#ED1C24'], [1, 1, 1], 1200, 600) + shield(220, 110, 160, 200, '#005DA4', '#ED1C24') + poly([[230, 260], [270, 200], [300, 240], [330, 200], [370, 260]], '#FFFFFF') + star(300, 150, 14, '#FFDD00'), [1200, 600]),
  c('ls', 'Lesotho', '#2E5BD6', '#00209F', () => bandsH(['#00209F', '#FFFFFF', '#009543'], [3, 4, 3]) + `<path d="M450,180 L560,370 Q450,400 340,370 Z" fill="#000000"/>` + rect(445, 160, 10, 30, '#000000')),
  c('gw', 'Guinea-Bissau', '#FCD116', '#009E49', () => rect(0, 0, 1200, 300, '#FCD116') + rect(0, 300, 1200, 300, '#009E49') + rect(0, 0, 400, 600, '#CE1126') + star(200, 300, 100, '#000000'), [1200, 600]),
  c('lv', 'Latvia', '#C0505A', '#9E3039', () => bandsH(['#9E3039', '#FFFFFF', '#9E3039'], [2, 1, 2], 1000, 500), [1000, 500]),
  c('mk', 'North Macedonia', '#FFE600', '#D20000', () => rect(0, 0, 1200, 600, '#D20000')
    + [[0, 0, 60], [600, 0, 60], [1200, 0, 60], [1200, 300, 70], [1200, 600, 60], [600, 600, 60], [0, 600, 60], [0, 300, 70]].map(([x, y, w]) => {
      const dx = x - 600, dy = y - 300, length = Math.hypot(dx, dy), px = -dy / length * w, py = dx / length * w;
      return poly([[600, 300], [x + px, y + py], [x - px, y - py]], '#FFE600');
    }).join('') + circle(600, 300, 85, '#D20000') + circle(600, 300, 70, '#FFE600'), [1200, 600]),
  c('gq', 'Equatorial Guinea', '#E32118', '#3E9A00', () => bandsH(['#3E9A00', '#FFFFFF', '#E32118']) + hoist(240, '#0073CE') + shield(420, 230, 60, 90, '#C0C0C0')),
  c('bh', 'Bahrain', '#E0384F', '#CE1126', () => rect(0, 0, 1000, 600, '#CE1126') + poly([[0, 0], [250, 0], ...Array.from({ length: 5 }, (_, i) => [[380, i * 120 + 60], [250, (i + 1) * 120]]).flat(), [0, 600]], '#FFFFFF'), [1000, 600]),
  c('xk', 'Kosovo', '#D0A650', '#244AA5', () => rect(0, 0, 840, 600, '#244AA5')
    + `<path d="M330,250 Q360,215 420,225 Q470,200 520,240 Q560,290 530,350 Q500,420 440,430 Q380,440 350,390 Q310,330 330,250 Z" fill="#D0A650"/>`
    + Array.from({ length: 6 }, (_, i) => { const a = (-150 + i * 24) * Math.PI / 180; return star(420 + 200 * Math.cos(a), 330 + 200 * Math.sin(a), 22, '#FFFFFF'); }).join(''), [840, 600], `${RECOGNITION}: recognised by about half of UN members; Serbia considers it part of its territory`),
  c('tl', 'Timor-Leste', '#FFC72C', '#DC241F', () => rect(0, 0, 1200, 600, '#DC241F') + hoist(600, '#FFC72C') + hoist(400, '#000000') + star(130, 300, 60, '#FFFFFF', -30), [1200, 600]),
  c('tt', 'Trinidad and Tobago', '#E0384F', '#CE1126', () => rect(0, 0, 900, 540, '#CE1126') + band(0, 0, 900, 540, 120, '#000000', '#FFFFFF', 20), [900, 540]),
  c('ee', 'Estonia', '#2E8BDE', '#0072CE', () => bandsH(['#0072CE', '#000000', '#FFFFFF'], [1, 1, 1], 1100, 700), [1100, 700]),
  c('mu', 'Mauritius', '#FFD500', '#1A206D', () => bandsH(['#EA2839', '#1A206D', '#FFD500', '#00A551'])),
  c('sz', 'Eswatini', '#FFD900', '#3E5EB9', () => bandsH(['#3E5EB9', '#FFD900', '#B10C0C', '#FFD900', '#3E5EB9'], [3, 1, 8, 1, 3])
    + `<ellipse cx="450" cy="300" rx="190" ry="90" fill="#000000"/><path d="M260,300 A190,90 0 0,0 640,300 Z" fill="#FFFFFF"/>` + rect(200, 295, 500, 10, '#FFD900')),
  c('dj', 'Djibouti', '#6AB2E7', '#12AD2B', () => bandsH(['#6AB2E7', '#12AD2B']) + hoist(520, '#FFFFFF') + star(175, 300, 65, '#D7141A')),
  c('cy', 'Cyprus', '#D57800', '#4E5B31', () => rect(0, 0, 900, 600, '#FFFFFF')
    + `<path d="M280,260 Q330,200 420,215 Q520,190 600,170 Q640,180 610,215 Q560,250 590,300 Q520,330 430,320 Q340,330 280,260 Z" fill="#D57800"/>`
    + `<g fill="none" stroke="#4E5B31" stroke-width="14" stroke-linecap="round"><path d="M330,420 Q420,460 445,430"/><path d="M570,420 Q480,460 455,430"/></g>`, undefined, 'Sovereign UN member; the north of the island is administered by Northern Cyprus'),
  c('gy', 'Guyana', '#FCD116', '#009E49', () => rect(0, 0, 1000, 600, '#009E49') + poly([[0, 0], [1000, 300], [0, 600]], '#FFFFFF') + poly([[0, 20], [950, 300], [0, 580]], '#FCD116')
    + poly([[0, 0], [500, 300], [0, 600]], '#000000') + poly([[0, 25], [460, 300], [0, 575]], '#CE1126'), [1000, 600]),
  c('km', 'Comoros', '#3D8E33', '#3A75C4', () => bandsH(['#FFC61E', '#FFFFFF', '#CE1126', '#3A75C4']) + hoist(400, '#3D8E33') + crescent(140, 300, 95, 35, 0, 85, '#FFFFFF', '#3D8E33')
    + [215, 265, 335, 385].map(y => star(190, y, 15, '#FFFFFF')).join('')),
  c('fj', 'Fiji', '#68BFE5', '#2A6F99', () => ensign('#68BFE5') + shield(810, 170, 230, 290, '#FFFFFF', '#68BFE5') + rect(810, 170, 230, 70, '#CE1126') + rect(915, 240, 20, 220, '#CE1126') + rect(810, 320, 230, 20, '#CE1126'), [1200, 600]),
  c('bt', 'Bhutan', '#FF7A3D', '#FF4E12', () => poly([[0, 0], [900, 0], [0, 600]], '#FFD520') + poly([[900, 0], [900, 600], [0, 600]], '#FF4E12')
    + `<path d="M180,470 Q300,380 380,400 Q460,420 520,330 Q580,240 700,170 Q640,280 560,330 Q500,380 420,430 Q320,490 180,470 Z" fill="#FFFFFF"/>`),
  c('sb', 'Solomon Islands', '#FCD116', '#0051BA', () => poly([[0, 0], [1200, 0], [0, 600]], '#0051BA') + poly([[1200, 0], [1200, 600], [0, 600]], '#215B33') + band(0, 600, 1200, 0, 45, '#FCD116')
    + [[90, 70], [250, 70], [170, 140], [90, 210], [250, 210]].map(([x, y]) => star(x, y, 32, '#FFFFFF')).join(''), [1200, 600]),
  c('lu', 'Luxembourg', '#51ADDA', '#51ADDA', () => bandsH(['#EA141D', '#FFFFFF', '#51ADDA'], [1, 1, 1], 1000, 600), [1000, 600]),
  c('mo', 'Macau', '#2E9E7E', '#00785E', () => rect(0, 0, 900, 600, '#00785E')
    + `<path d="M450,200 Q490,260 450,340 Q410,260 450,200 Z" fill="#FFFFFF"/><path d="M450,340 Q380,320 360,260 Q420,270 450,340 Z" fill="#FFFFFF"/><path d="M450,340 Q520,320 540,260 Q480,270 450,340 Z" fill="#FFFFFF"/>`
    + `<g fill="none" stroke="#FFFFFF" stroke-width="10"><path d="M340,380 Q450,340 560,380"/><path d="M360,410 Q450,390 540,410"/><path d="M380,440 Q450,425 520,440"/></g>`
    + [[330, 200], [380, 150], [450, 120], [520, 150], [570, 200]].map(([x, y], i) => star(x, y, i === 2 ? 30 : 18, '#FBD116')).join(''),
    undefined, 'Special administrative region of China, not a country'),
  c('me', 'Montenegro', '#D3AE3B', '#C40308', () => rect(0, 0, 1200, 600, '#D3AE3B') + rect(30, 30, 1140, 540, '#C40308')
    + poly([[600, 170], [660, 130], [700, 170], [670, 210], [760, 200], [720, 300], [660, 310], [640, 400], [600, 440], [560, 400], [540, 310], [480, 300], [440, 200], [530, 210], [500, 170], [540, 130]], '#D3AE3B'), [1200, 600]),
  c('sr', 'Suriname', '#ECC81D', '#377E3F', () => bandsH(['#377E3F', '#FFFFFF', '#B40A2D', '#FFFFFF', '#377E3F'], [2, 1, 4, 1, 2]) + star(450, 305, 95, '#ECC81D')),
  c('eh', 'Western Sahara', '#E0384F', '#007A3D', () => bandsH(['#000000', '#FFFFFF', '#007A3D'], [1, 1, 1], 1200, 600) + hoist(400, '#C4111B') + crescent(600, 300, 70, 18, 0, 58, '#C4111B', '#FFFFFF') + star(650, 300, 35, '#C4111B', -90), [1200, 600],
    `${SOVEREIGNTY}: claimed by Morocco and by the Sahrawi Arab Democratic Republic. The flag shown is the Sahrawi Republic's`),
  c('mt', 'Malta', '#CF142B', '#CF142B', () => bandsV(['#FFFFFF', '#CF142B']) + rect(70, 50, 130, 130, '#CF142B') + rect(80, 60, 110, 110, '#C0C0C0') + rect(120, 60, 30, 110, '#A0A0A0') + rect(80, 100, 110, 30, '#A0A0A0')),
  c('mv', 'Maldives', '#2EA35C', '#007E3A', () => rect(0, 0, 900, 600, '#D21034') + rect(150, 150, 600, 300, '#007E3A') + crescent(470, 300, 90, 30, 0, 80, '#FFFFFF', '#007E3A')),
  c('cv', 'Cape Verde', '#F7D116', '#003893', () => bandsH(['#003893', '#FFFFFF', '#CF2027', '#FFFFFF', '#003893'], [6, 1, 1, 1, 3], 1020, 600) + starRing(380, 350, 140, 10, 26, '#F7D116'), [1020, 600]),
  c('ncy', 'Northern Cyprus', '#E30A17', '#E30A17', () => rect(0, 0, 900, 600, '#FFFFFF') + rect(0, 60, 900, 60, '#E30A17') + rect(0, 480, 900, 60, '#E30A17')
    + crescent(400, 300, 110, 28, 0, 90, '#E30A17', '#FFFFFF') + star(520, 300, 55, '#E30A17', -90), undefined, `${RECOGNITION}: recognised only by Turkey`),
  c('bn', 'Brunei', '#F7E017', '#7A6A00', () => rect(0, 0, 1000, 500, '#F7E017') + band(0, 110, 1000, 360, 70, '#FFFFFF') + band(0, 175, 1000, 430, 60, '#000000')
    + crescent(500, 280, 90, 0, -35, 80, '#CF1126', '#F7E017') + rect(490, 150, 20, 130, '#CF1126') + poly([[440, 160], [500, 120], [560, 160]], '#CF1126'), [1000, 500]),
  c('bz', 'Belize', '#E0384F', '#171696', () => rect(0, 0, 900, 600, '#171696') + rect(0, 0, 900, 50, '#D90F19') + rect(0, 550, 900, 50, '#D90F19') + circle(450, 300, 180, '#FFFFFF')
    + `<circle cx="450" cy="300" r="150" fill="none" stroke="#2E7D32" stroke-width="22"/>` + shield(400, 240, 100, 120, '#4A7CC8')),
  c('bs', 'Bahamas', '#FFC72C', '#00778B', () => bandsH(['#00778B', '#FFC72C', '#00778B'], [1, 1, 1], 1200, 600) + hoist(520, '#000000'), [1200, 600]),
  c('is', 'Iceland', '#E03A4F', '#02529C', () => rect(0, 0, 1250, 900, '#02529C') + nordicBordered(350, 200, 100, '#FFFFFF', '#DC1E35', 1250, 900), [1250, 900]),
  c('pmr', 'Transnistria', '#2EAE5A', '#BB0000', () => bandsH(['#BB0000', '#00A651', '#BB0000'], [1, 1, 1], 1200, 600) + star(140, 60, 24, '#FFD700')
    + `<g stroke="#FFD700" stroke-width="12" fill="none" stroke-linecap="round"><path d="M100,150 Q140,95 185,140"/><line x1="105" y1="100" x2="175" y2="170"/></g>`, [1200, 600], `${RECOGNITION}: not recognised by any UN member; internationally part of Moldova`),
  c('vu', 'Vanuatu', '#FDCE12', '#009543', () => bandsH(['#D21034', '#009543'], [1, 1], 1200, 600) + rect(0, 255, 1200, 90, '#FDCE12') + rect(0, 270, 1200, 60, '#000000')
    + poly([[0, 0], [530, 300], [0, 600]], '#FDCE12') + poly([[0, 40], [470, 300], [0, 560]], '#000000') + `<circle cx="150" cy="300" r="75" fill="none" stroke="#FDCE12" stroke-width="18"/>`, [1200, 600]),
  c('pf', 'French Polynesia', '#E0384F', '#CE1126', () => bandsH(['#CE1126', '#FFFFFF', '#CE1126'], [1, 2, 1]) + `<path d="M330,300 A120,120 0 0,1 570,300 Z" fill="#FFC72C"/>` + `<path d="M330,300 A120,120 0 0,0 570,300 Z" fill="#083D9C"/>`
    + `<g stroke="#FFFFFF" stroke-width="10"><line x1="350" y1="330" x2="550" y2="330"/><line x1="370" y1="360" x2="530" y2="360"/></g>` + rect(380, 285, 140, 22, '#CE1126'),
    undefined, 'Overseas collectivity of France, not a country'),
  c('nc', 'New Caledonia', '#FFD200', '#0035AD', () => bandsH(['#0035AD', '#ED4135', '#00A651'], [1, 1, 1], 1200, 600) + circle(370, 300, 180, '#FFD200') + circle(370, 300, 172, '#000000') + circle(370, 300, 160, '#FFD200')
    + rect(360, 150, 20, 280, '#000000') + poly([[330, 230], [370, 150], [410, 230]], '#000000'), [1200, 600],
    'French territory with two official flags; the Kanak flag is shown, not the French tricolour'),
  c('bb', 'Barbados', '#FFC726', '#00267F', () => bandsV(['#00267F', '#FFC726', '#00267F'], [1, 1, 1], 900, 600)
    + `<path d="M380,190 Q400,300 440,320 L440,450 L460,450 L460,320 Q500,300 520,190 Q480,260 465,270 L465,170 L435,170 L435,270 Q420,260 380,190 Z" fill="#000000"/>`),
  c('abk', 'Abkhazia', '#2EAE5A', '#00A651', () => {
    let out = '';
    for (let i = 0; i < 7; i++) out += rect(0, i * 600 / 7, 1200, 600 / 7 + 0.5, i % 2 ? '#FFFFFF' : '#00A651');
    return out + rect(0, 0, 500, 257, '#C8312E') + `<path d="M230,90 L230,170 Q230,200 260,200 L300,200 Q330,200 330,170 L330,110 L310,110 L310,150 L300,150 L300,80 L285,80 L285,150 L275,150 L275,75 L260,75 L260,150 L250,150 L250,90 Z" fill="#FFFFFF"/>`
      + Array.from({ length: 7 }, (_, i) => { const a = (200 + i * 140 / 6) * Math.PI / 180; return star(280 + 120 * Math.cos(a), 160 + 120 * Math.sin(a), 13, '#FFFFFF'); }).join('');
  }, [1200, 600], `${RECOGNITION}: recognised by a handful of states; internationally part of Georgia`),
  c('st', 'São Tomé and Príncipe', '#FFCE00', '#12AD2B', () => bandsH(['#12AD2B', '#FFCE00', '#12AD2B'], [2, 3, 2], 1200, 600) + hoist(330, '#D21034') + star(550, 300, 60, '#000000') + star(850, 300, 60, '#000000'), [1200, 600]),
  c('ws', 'Samoa', '#E0384F', '#002B7F', () => rect(0, 0, 1000, 500, '#CE1126') + rect(0, 0, 500, 250, '#002B7F') + [[250, 50], [180, 115], [320, 110], [250, 205], [280, 150]].map(([x, y], i) => star(x, y, i === 4 ? 14 : 26, '#FFFFFF')).join(''), [1000, 500]),
  c('lc', 'Saint Lucia', '#FCD116', '#66CCFF', () => rect(0, 0, 900, 450, '#66CCFF') + poly([[450, 60], [590, 400], [310, 400]], '#FFFFFF') + poly([[450, 100], [565, 400], [335, 400]], '#000000') + poly([[450, 240], [590, 400], [310, 400]], '#FCD116'), [900, 450]),
  c('cw', 'Curaçao', '#F9E814', '#002B7F', () => rect(0, 0, 900, 600, '#002B7F') + rect(0, 375, 900, 75, '#F9E814') + star(80, 80, 32, '#FFFFFF') + star(180, 160, 45, '#FFFFFF'),
    undefined, 'Constituent country of the Kingdom of the Netherlands, not a sovereign state'),
  c('gu', 'Guam', '#E0384F', '#00297B', () => rect(0, 0, 1000, 600, '#C62139') + rect(25, 25, 950, 550, '#00297B')
    + `<path d="M500,140 Q620,300 500,460 Q380,300 500,140 Z" fill="#6FB2E0" stroke="#C62139" stroke-width="10"/>` + `<path d="M415,360 Q500,330 585,360 Q560,420 500,455 Q440,420 415,360 Z" fill="#D8B26E"/>`
    + rect(495, 260, 10, 110, '#6B4423'), [1000, 600], 'Territory of the United States, not a country'),
  c('sc', 'Seychelles', '#FCD856', '#003F87', () => rect(0, 0, 1200, 600, '#007A3D') + poly([[0, 600], [0, 0], [400, 0]], '#003F87') + poly([[0, 600], [400, 0], [800, 0]], '#FCD856')
    + poly([[0, 600], [800, 0], [1200, 0], [1200, 200]], '#D62828') + poly([[0, 600], [1200, 200], [1200, 400]], '#FFFFFF'), [1200, 600]),
  c('ki', 'Kiribati', '#FCD116', '#003F87', () => rect(0, 0, 1000, 330, '#CE1126') + rect(0, 330, 1000, 170, '#003F87') + star(500, 330, 150, '#FCD116', 0, 17, 0.55) + `<path d="M380,330 A120,120 0 0,1 620,330 Z" fill="#FCD116"/>`
    + `<path d="M380,110 Q450,60 520,100 Q580,70 640,110 Q570,120 520,135 Q450,125 380,110 Z" fill="#FCD116"/>`
    + [360, 410, 460].map(y => `<path d="M0,${y} Q125,${y - 25} 250,${y} T500,${y} T750,${y} T1000,${y}" stroke="#FFFFFF" stroke-width="16" fill="none"/>`).join(''), [1000, 500]),
  c('aw', 'Aruba', '#EF3340', '#418FDE', () => rect(0, 0, 900, 600, '#418FDE') + rect(0, 400, 900, 30, '#FBE122') + rect(0, 460, 900, 30, '#FBE122')
    + star(120, 120, 85, '#FFFFFF', 0, 4, 0.3) + star(120, 120, 72, '#EF3340', 0, 4, 0.3), undefined, 'Constituent country of the Kingdom of the Netherlands, not a sovereign state'),
  c('vc', 'Saint Vincent and the Grenadines', '#FCD116', '#002674', () => bandsV(['#002674', '#FCD116', '#009E60'], [1, 2, 1]) + [[380, 230], [520, 230], [450, 360]].map(([x, y]) => poly([[x, y - 70], [x + 45, y], [x, y + 70], [x - 45, y]], '#009E60')).join('')),
  c('gd', 'Grenada', '#FCD116', '#007A5E', () => rect(0, 0, 1000, 600, '#CE1126') + poly([[80, 80], [920, 80], [500, 300]], '#FCD116') + poly([[80, 520], [920, 520], [500, 300]], '#FCD116')
    + poly([[80, 80], [80, 520], [500, 300]], '#007A5E') + poly([[920, 80], [920, 520], [500, 300]], '#007A5E') + circle(500, 300, 80, '#CE1126') + star(500, 300, 60, '#FCD116')
    + [200, 500, 800].flatMap(x => [star(x, 40, 28, '#FCD116'), star(x, 560, 28, '#FCD116')]).join('') + circle(190, 300, 40, '#FCD116'), [1000, 600]),
  c('ag', 'Antigua and Barbuda', '#FCD116', '#0072C6', () => rect(0, 0, 900, 600, '#CE1126') + poly([[0, 0], [900, 0], [450, 600]], '#000000') + star(450, 200, 110, '#FCD116', 0, 16, 0.5)
    + poly([[155, 205], [745, 205], [450, 600]], '#0072C6') + poly([[245, 325], [655, 325], [450, 600]], '#FFFFFF') + rect(155, 205, 590, 30, '#0072C6')),
  c('je', 'Jersey', '#DF112D', '#DF112D', () => rect(0, 0, 1000, 600, '#FFFFFF') + `<path d="M0,0 L1000,600 M1000,0 L0,600" stroke="#DF112D" stroke-width="90"/>` + shield(455, 70, 90, 110, '#DF112D') + rect(470, 30, 60, 30, '#F9DD16'),
    [1000, 600], 'Crown dependency of the United Kingdom, not a country'),
  c('to', 'Tonga', '#E0384F', '#C10000', () => rect(0, 0, 1000, 500, '#C10000') + rect(0, 0, 400, 250, '#FFFFFF') + rect(170, 40, 60, 170, '#C10000') + rect(115, 95, 170, 60, '#C10000'), [1000, 500]),
  c('ky', 'Cayman Islands', '#E0384F', '#012169', () => ensign('#012169') + shield(830, 160, 210, 260, '#FFFFFF') + rect(830, 160, 210, 70, '#C8102E')
    + [270, 310, 350].map(y => `<path d="M840,${y} Q880,${y - 15} 935,${y} T1030,${y}" stroke="#012169" stroke-width="16" fill="none"/>`).join('') + `<ellipse cx="935" cy="135" rx="45" ry="25" fill="#2E7D32"/>`,
    [1200, 600], 'Overseas territory of the United Kingdom, not a country'),
  c('ad', 'Andorra', '#FEDF00', '#10069F', () => bandsV(['#10069F', '#FEDF00', '#D50032'], [8, 9, 8], 1000, 700) + shield(440, 250, 120, 150, '#FEDF00', '#C7A800') + rect(500, 255, 55, 75, '#D50032') + rect(445, 330, 55, 60, '#D50032'), [1000, 700]),
  c('vi', 'U.S. Virgin Islands', '#FCD116', '#162E6B', () => rect(0, 0, 900, 600, '#FFFFFF') + poly([[450, 160], [610, 230], [540, 270], [560, 380], [450, 330], [340, 380], [360, 270], [290, 230]], '#FCD116') + shield(410, 240, 80, 100, '#162E6B')
    + `<text x="200" y="360" font-size="140" font-family="Georgia, serif" font-weight="700" fill="#162E6B" text-anchor="middle">V</text><text x="700" y="360" font-size="140" font-family="Georgia, serif" font-weight="700" fill="#162E6B" text-anchor="middle">I</text>`,
    undefined, 'Territory of the United States, not a country'),
  c('im', 'Isle of Man', '#E0384F', '#CF142B', () => rect(0, 0, 1000, 500, '#CF142B')
    + [0, 120, 240].map(angle => `<g transform="rotate(${angle} 500 250)"><path d="M500,250 L500,120 Q500,95 530,95 L560,95" stroke="#FFFFFF" stroke-width="34" fill="none" stroke-linecap="round"/><rect x="550" y="80" width="30" height="30" fill="#F9DD16"/></g>`).join(''),
    [1000, 500], 'Crown dependency of the United Kingdom, not a country'),
  c('fm', 'Micronesia', '#75B2DD', '#75B2DD', () => rect(0, 0, 1000, 530, '#75B2DD') + [[500, 110], [380, 265], [620, 265], [500, 420]].map(([x, y]) => star(x, y, 45, '#FFFFFF')).join(''), [1000, 530]),
  c('dm', 'Dominica', '#FCD116', '#006B3F', () => rect(0, 0, 1000, 500, '#006B3F') + rect(0, 200, 1000, 100, '#FCD116') + rect(0, 233, 1000, 34, '#000000') + rect(0, 267, 1000, 33, '#FFFFFF')
    + rect(400, 0, 100, 500, '#FCD116') + rect(433, 0, 34, 500, '#000000') + rect(467, 0, 33, 500, '#FFFFFF') + circle(450, 250, 120, '#D41C30') + starRing(450, 250, 95, 10, 16, '#006B3F')
    + `<ellipse cx="450" cy="250" rx="28" ry="45" fill="#8E4B9C"/>`, [1000, 500]),
  c('gg', 'Guernsey', '#F9DD16', '#E8112D', () => rect(0, 0, 900, 600, '#FFFFFF') + rect(390, 0, 120, 600, '#E8112D') + rect(0, 240, 900, 120, '#E8112D') + rect(430, 140, 40, 320, '#F9DD16') + rect(350, 280, 200, 40, '#F9DD16'),
    undefined, 'Crown dependency of the United Kingdom, not a country'),
  c('bm', 'Bermuda', '#E0384F', '#CF142B', () => ensign('#CF142B') + shield(830, 160, 210, 270, '#FFFFFF') + `<path d="M860,330 Q935,240 1010,330" fill="#CF142B"/>` + rect(845, 360, 180, 50, '#3A75C4'),
    [1200, 600], 'Overseas territory of the United Kingdom, not a country'),
  c('gl', 'Greenland', '#E0384F', '#C8102E', () => rect(0, 0, 1200, 400, '#FFFFFF') + rect(0, 400, 1200, 400, '#C8102E') + `<path d="M200,400 A250,250 0 0,1 700,400 Z" fill="#C8102E"/><path d="M200,400 A250,250 0 0,0 700,400 Z" fill="#FFFFFF"/>`,
    [1200, 800], 'Autonomous territory of the Kingdom of Denmark, not a sovereign state'),
  c('sos', 'South Ossetia', '#FFDF00', '#FF0000', () => bandsH(['#FFFFFF', '#FF0000', '#FFDF00'], [1, 1, 1], 1000, 500), [1000, 500], `${RECOGNITION}: recognised by a handful of states; internationally part of Georgia`),
  c('fo', 'Faroe Islands', '#E0384F', '#005EB8', () => rect(0, 0, 1100, 800, '#FFFFFF') + nordicBordered(300, 200, 100, '#005EB8', '#EF303E', 1100, 800), [1100, 800], 'Autonomous territory of the Kingdom of Denmark, not a sovereign state'),
  c('tc', 'Turks and Caicos Islands', '#FCD116', '#012169', () => ensign('#012169') + shield(830, 160, 210, 270, '#FCD116') + poly([[850, 300], [880, 220], [910, 300]], '#E86A2C') + `<ellipse cx="935" cy="265" rx="20" ry="45" fill="#C0392B"/>` + rect(985, 220, 20, 80, '#2E7D32') + rect(972, 245, 46, 14, '#2E7D32'),
    [1200, 600], 'Overseas territory of the United Kingdom, not a country'),
  c('kn', 'Saint Kitts and Nevis', '#FCD116', '#009E49', () => poly([[0, 0], [900, 0], [0, 600]], '#009E49') + poly([[900, 0], [900, 600], [0, 600]], '#CE1126') + band(0, 600, 900, 0, 150, '#000000', '#FCD116', 30)
    + star(330, 385, 50, '#FFFFFF', 33) + star(570, 215, 50, '#FFFFFF', 33)),
  c('as', 'American Samoa', '#E0384F', '#002868', () => rect(0, 0, 1000, 500, '#002868') + poly([[1000, 0], [0, 250], [1000, 500]], '#BF0A30') + poly([[1000, 45], [100, 250], [1000, 455]], '#FFFFFF')
    + poly([[860, 160], [700, 260], [860, 330], [800, 250]], '#8B5A2B') + rect(700, 245, 170, 12, '#FCD116'), [1000, 500], 'Territory of the United States, not a country'),
  c('mp', 'Northern Mariana Islands', '#2E8FD6', '#0071BC', () => rect(0, 0, 1000, 500, '#0071BC') + `<circle cx="500" cy="250" r="190" fill="none" stroke="#7CBF4E" stroke-width="30"/>`
    + rect(470, 170, 60, 180, '#A0A0A0') + `<ellipse cx="500" cy="170" rx="75" ry="28" fill="#A0A0A0"/>` + star(500, 250, 60, '#FFFFFF'), [1000, 500], 'Territory of the United States, not a country'),
  c('sx', 'Sint Maarten', '#E0384F', '#012A87', () => bandsH(['#DC171D', '#012A87']) + hoist(450, '#FFFFFF') + circle(150, 300, 75, '#F9D90F') + circle(150, 300, 62, '#7CC6EA') + rect(125, 290, 50, 45, '#FFFFFF'),
    undefined, 'Constituent country of the Kingdom of the Netherlands, not a sovereign state'),
  c('mh', 'Marshall Islands', '#DD7500', '#003893', () => rect(0, 0, 1000, 525, '#003893') + poly([[0, 525], [1000, 0], [1000, 70]], '#DD7500') + poly([[0, 525], [1000, 70], [1000, 140]], '#FFFFFF')
    + star(200, 160, 110, '#FFFFFF', 0, 24, 0.45), [1000, 525]),
  c('li', 'Liechtenstein', '#2E5BD6', '#002B7F', () => bandsH(['#002B7F', '#CE1126'], [1, 1], 1000, 600) + poly([[180, 190], [190, 110], [230, 150], [260, 90], [290, 150], [330, 110], [340, 190]], '#FFD83D') + rect(180, 190, 160, 25, '#FFD83D'), [1000, 600]),
  c('vg', 'British Virgin Islands', '#2E8B57', '#012169', () => ensign('#012169') + shield(830, 160, 210, 270, '#007A3D') + rect(915, 200, 40, 160, '#FFFFFF') + circle(935, 190, 22, '#F2C6A0'),
    [1200, 600], 'Overseas territory of the United Kingdom, not a country'),
  c('mc', 'Monaco', '#E0384F', '#CE1126', () => bandsH(['#CE1126', '#FFFFFF'], [1, 1], 1000, 800), [1000, 800]),
  c('gi', 'Gibraltar', '#DA000C', '#DA000C', () => bandsH(['#FFFFFF', '#DA000C'], [2, 1], 1200, 600) + rect(470, 190, 260, 170, '#DA000C') + rect(470, 120, 70, 90, '#DA000C') + rect(565, 90, 70, 120, '#DA000C') + rect(660, 120, 70, 90, '#DA000C')
    + rect(585, 270, 30, 70, '#000000') + rect(588, 380, 24, 120, '#F9D90F') + circle(600, 380, 22, '#F9D90F'), [1200, 600], `Overseas territory of the United Kingdom; ${SOVEREIGNTY.toLowerCase()} (claimed by Spain)`),
  c('sm', 'San Marino', '#5EB6E4', '#3A8FC0', () => bandsH(['#FFFFFF', '#5EB6E4'], [1, 1], 800, 600) + shield(345, 200, 110, 140, '#5EB6E4', '#D4AF37') + [370, 400, 430].map(x => rect(x - 8, 230, 16, 50, '#FFFFFF')).join(''), [800, 600]),
  c('mf', 'Saint Martin', '#2F6FD0', '#0055A4', () => bandsV(['#0055A4', '#FFFFFF', '#EF4135']), undefined, `${FRENCH}; overseas collectivity of France`),
  c('pw', 'Palau', '#FFDE00', '#4AADD6', () => rect(0, 0, 1000, 625, '#4AADD6') + circle(450, 312, 190, '#FFDE00'), [1000, 625], 'Sovereign UN member in free association with the United States'),
  c('ai', 'Anguilla', '#F18A00', '#012169', () => ensign('#012169') + shield(830, 160, 210, 270, '#FFFFFF') + rect(830, 340, 210, 90, '#3B8FD3')
    + [[880, 230, 0], [985, 230, 0], [935, 300, 0]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="38" fill="none" stroke="#F18A00" stroke-width="16" stroke-dasharray="180 60"/>`).join(''),
    [1200, 600], 'Overseas territory of the United Kingdom, not a country'),
  c('ck', 'Cook Islands', '#E0384F', '#012169', () => ensign('#012169') + starRing(900, 300, 150, 15, 22, '#FFFFFF'), [1200, 600], 'Self-governing in free association with New Zealand; not a UN member'),
  c('nr', 'Nauru', '#FFC61E', '#002B7F', () => rect(0, 0, 1000, 500, '#002B7F') + rect(0, 230, 1000, 40, '#FFC61E') + star(250, 375, 75, '#FFFFFF', 0, 12, 0.55), [1000, 500]),
  c('wf', 'Wallis and Futuna', '#ED2939', '#ED2939', () => rect(0, 0, 900, 600, '#ED2939') + rect(0, 0, 300, 200, '#FFFFFF') + rect(10, 10, 94, 180, '#0055A4') + rect(104, 10, 93, 180, '#FFFFFF') + rect(197, 10, 93, 180, '#EF4135')
    + poly([[600, 220], [680, 300], [600, 380], [520, 300]], '#FFFFFF') + poly([[600, 270], [630, 300], [600, 330], [570, 300]], '#ED2939'), undefined, 'Flag choice: the French flag is the official flag; the local flag is shown. Overseas collectivity of France'),
  c('tv', 'Tuvalu', '#FCD116', '#009FCA', () => ensign('#009FCA') + [[700, 520], [790, 470], [880, 520], [790, 380], [880, 330], [970, 380], [1000, 230], [1090, 300], [1060, 140]].map(([x, y]) => star(x, y, 30, '#FCD116')).join(''), [1200, 600]),
  c('bl', 'Saint Barthélemy', '#2F6FD0', '#0055A4', () => bandsV(['#0055A4', '#FFFFFF', '#EF4135']), undefined, `${FRENCH}; overseas collectivity of France`),
  c('pm', 'Saint Pierre and Miquelon', '#F9D90F', '#1A5CA8', () => rect(0, 0, 1200, 800, '#1A5CA8') + `<path d="M380,520 L880,520 L820,600 L440,600 Z" fill="#F9D90F"/>` + rect(615, 220, 20, 300, '#F9D90F') + poly([[635, 240], [800, 480], [635, 480]], '#FFFFFF')
    + [650, 700, 750].map(y => `<path d="M300,${y} Q450,${y - 25} 600,${y} T900,${y} T1200,${y}" stroke="#FFFFFF" stroke-width="12" fill="none"/>`).join('')
    + rect(0, 0, 260, 800, '#FFFFFF') + rect(10, 10, 240, 250, '#D52B1E') + rect(10, 275, 240, 250, '#000000') + rect(10, 540, 240, 250, '#D52B1E'),
    [1200, 800], 'Flag choice: the French flag is the official flag; the local flag is shown. Overseas collectivity of France'),
  c('sh', 'Saint Helena, Ascension and Tristan da Cunha', '#E0384F', '#012169', () => ensign('#012169') + shield(830, 160, 210, 270, '#6FB2E0') + poly([[860, 380], [935, 250], [1010, 380]], '#6B4423') + rect(925, 280, 20, 80, '#FFFFFF'),
    [1200, 600], 'Overseas territory of the United Kingdom, not a country'),
  c('ms', 'Montserrat', '#2E8B57', '#012169', () => ensign('#012169') + shield(830, 160, 210, 270, '#6FB2E0') + rect(830, 360, 210, 70, '#8B5A2B') + rect(905, 230, 60, 140, '#2E7D32') + circle(935, 215, 22, '#6B4423'),
    [1200, 600], 'Overseas territory of the United Kingdom, not a country'),
  c('fk', 'Falkland Islands', '#E0384F', '#012169', () => ensign('#012169') + shield(830, 160, 210, 270, '#3B6FCF') + `<ellipse cx="935" cy="230" rx="55" ry="35" fill="#FFFFFF"/>` + rect(870, 260, 130, 20, '#2E7D32')
    + `<path d="M880,330 L990,330 L970,370 L900,370 Z" fill="#8B5A2B"/>` + rect(932, 290, 6, 40, '#8B5A2B'), [1200, 600], `Overseas territory of the United Kingdom; ${SOVEREIGNTY.toLowerCase()} (claimed by Argentina as the Malvinas)`),
  c('tk', 'Tokelau', '#FCD116', '#00247D', () => rect(0, 0, 1000, 500, '#00247D') + `<path d="M480,420 Q600,330 860,140 Q780,320 560,430 Z" fill="#FCD116"/>`
    + [[160, 100], [100, 200], [220, 210], [160, 330]].map(([x, y]) => star(x, y, 30, '#FFFFFF')).join(''), [1000, 500], 'Territory of New Zealand, not a country'),
  c('nf', 'Norfolk Island', '#2EA35C', '#007A3D', () => bandsV(['#007A3D', '#FFFFFF', '#007A3D'], [7, 9, 7], 1000, 500) + poly([[500, 70], [570, 200], [540, 200], [600, 320], [560, 320], [620, 420], [380, 420], [440, 320], [400, 320], [460, 200], [430, 200]], '#007A3D') + rect(488, 420, 24, 50, '#007A3D'),
    [1000, 500], 'External territory of Australia, not a country'),
  c('cx', 'Christmas Island', '#F7D116', '#0021AD', () => poly([[0, 0], [1000, 0], [1000, 500]], '#1C8A42') + poly([[0, 0], [0, 500], [1000, 500]], '#0021AD') + circle(500, 250, 110, '#F7D116')
    + `<path d="M450,210 Q500,190 540,220 Q560,270 520,300 Q470,310 455,270 Z" fill="#1C8A42"/>` + [[120, 120], [190, 230], [120, 340], [70, 230], [140, 410]].map(([x, y], i) => star(x, y, i === 4 ? 14 : 26, '#FFFFFF', 0, 7, 0.45)).join('')
    + `<path d="M720,180 Q800,90 880,140 Q830,170 790,210 Z" fill="#F7D116"/>`, [1000, 500], 'External territory of Australia, not a country'),
  c('nu', 'Niue', '#FEDD00', '#8A7300', () => rect(0, 0, 1200, 600, '#FEDD00') + unionJack(0, 0, 600, 300) + circle(300, 150, 50, '#012169') + star(300, 150, 36, '#FEDD00')
    + [[300, 45], [300, 255], [130, 150], [470, 150]].map(([x, y]) => star(x, y, 22, '#FEDD00')).join(''), [1200, 600], 'Self-governing in free association with New Zealand; not a UN member'),
  c('va', 'Vatican City', '#FFE000', '#8A7A00', () => bandsV(['#FFE000', '#FFFFFF'], [1, 1], 600, 600)
    + `<g stroke-width="22" stroke-linecap="round"><line x1="370" y1="420" x2="500" y2="250" stroke="#F1BF00"/><line x1="500" y1="420" x2="370" y2="250" stroke="#B5B5B5"/></g>`
    + poly([[395, 230], [435, 120], [475, 230]], '#B5B5B5') + rect(398, 200, 74, 20, '#F1BF00'), [600, 600]),
  c('cc', 'Cocos (Keeling) Islands', '#FFE000', '#00843D', () => rect(0, 0, 1000, 500, '#00843D') + circle(170, 160, 90, '#FFE000') + rect(160, 120, 20, 110, '#00843D') + `<path d="M120,110 Q170,70 220,110 Q170,95 120,110 Z" fill="#00843D"/>`
    + crescent(500, 250, 60, 22, 0, 52, '#FFE000', '#00843D') + [[820, 120], [740, 240], [880, 230], [820, 380], [850, 300]].map(([x, y], i) => star(x, y, i === 4 ? 14 : 28, '#FFE000', 0, 7, 0.45)).join(''),
    [1000, 500], 'External territory of Australia, not a country'),
  c('pn', 'Pitcairn Islands', '#2E8B57', '#012169', () => ensign('#012169') + shield(830, 160, 210, 270, '#3B8FD3') + poly([[830, 160], [1040, 160], [1040, 270], [935, 340], [830, 270]], '#2E7D32') + rect(925, 210, 20, 150, '#F9D90F') + rect(890, 300, 90, 16, '#F9D90F'),
    [1200, 600], 'Overseas territory of the United Kingdom, not a country'),
];
