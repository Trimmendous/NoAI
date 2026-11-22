// The 100 most populous countries, in order (Wikipedia, "List of countries
// and dependencies by population"). Each has its flag, drawn as SVG on a
// 900×600 canvas unless `size` says otherwise, and the two colours its theme
// is built from: `accent` (buttons, highlights) and `tint` (the panels).
// Flags with detailed emblems use a simplified emblem; they're backgrounds,
// shown faintly, not reference drawings.
// To add a place: append an entry here or in more-places.mjs and run `node build.mjs`.

import { n, rect, circle, poly, bandsH, bandsV, star, towards, crescent, hoist, text, unionJack, nordic, mapleLeaf, c, ensign, shield, band, nordicBordered, starRing } from './draw.mjs';

export const COUNTRIES = [
  c('in', 'India', '#FF9933', '#0b1d51', () => {
    const spokes = Array.from({ length: 24 }, (_, i) => { const a = i * 15 * Math.PI / 180; return `<line x1="450" y1="300" x2="${n(450 + 88 * Math.cos(a))}" y2="${n(300 + 88 * Math.sin(a))}"/>`; }).join('');
    return bandsH(['#FF9933', '#FFFFFF', '#138808']) + `<g stroke="#000080" fill="none"><circle cx="450" cy="300" r="92" stroke-width="10"/><g stroke-width="4">${spokes}</g></g>` + circle(450, 300, 16, '#000080');
  }),
  c('cn', 'China', '#FFDE00', '#EE1C25', () => rect(0, 0, 900, 600, '#EE1C25') + star(150, 150, 90, '#FFDE00')
    + [[300, 60], [360, 120], [360, 210], [300, 270]].map(([x, y]) => star(x, y, 30, '#FFDE00', towards(x, y, 150, 150))).join('')),
  c('us', 'United States', '#B22234', '#3C3B6E', () => {
    const stripe = 1000 / 13;
    let out = rect(0, 0, 1900, 1000, '#FFFFFF');
    for (let i = 0; i < 13; i += 2) out += rect(0, i * stripe, 1900, stripe, '#B22234');
    out += rect(0, 0, 760, 7 * stripe, '#3C3B6E');
    for (let row = 0; row < 9; row++) for (let k = 0; k < (row % 2 ? 5 : 6); k++) out += star((row % 2 ? 2 * k + 2 : 2 * k + 1) * 63.33, (row + 1) * 53.85, 30.8, '#FFFFFF');
    return out;
  }, [1900, 1000]),
  c('id', 'Indonesia', '#E8222B', '#CE1126', () => bandsH(['#CE1126', '#FFFFFF'])),
  c('pk', 'Pakistan', '#2BA24C', '#01411C', () => rect(0, 0, 900, 600, '#01411C') + rect(0, 0, 225, 600, '#FFFFFF')
    + crescent(562.5, 300, 165, 44.5, -42, 150, '#FFFFFF', '#01411C') + star(660, 205, 55, '#FFFFFF', 35)),
  c('ng', 'Nigeria', '#22A35B', '#008751', () => bandsV(['#008751', '#FFFFFF', '#008751'], [1, 1, 1], 1200, 600), [1200, 600]),
  c('br', 'Brazil', '#FFDF00', '#009C3B', () => rect(0, 0, 1000, 700, '#009C3B') + poly([[85, 350], [500, 85], [915, 350], [500, 615]], '#FFDF00')
    + circle(500, 350, 175, '#002776') + `<path d="M330,318 Q500,270 668,388" stroke="#FFFFFF" stroke-width="28" fill="none"/>`
    + [[430, 420], [470, 460], [540, 440], [580, 400], [500, 500], [400, 470], [600, 470]].map(([x, y]) => star(x, y, 9, '#FFFFFF')).join(''), [1000, 700]),
  c('bd', 'Bangladesh', '#F42A41', '#006A4E', () => rect(0, 0, 1000, 600, '#006A4E') + circle(450, 300, 200, '#F42A41'), [1000, 600]),
  c('ru', 'Russia', '#2D6CDF', '#0039A6', () => bandsH(['#FFFFFF', '#0039A6', '#D52B1E'])),
  c('mx', 'Mexico', '#2E9E5B', '#006847', () => bandsV(['#006847', '#FFFFFF', '#CE1126'], [1, 1, 1], 1400, 800)
    + `<ellipse cx="700" cy="400" rx="105" ry="115" fill="#8C5A2B"/>` + `<path d="M610,470 Q700,540 790,470" stroke="#3A7D44" stroke-width="18" fill="none"/>`, [1400, 800]),
  c('jp', 'Japan', '#E0284F', '#BC002D', () => rect(0, 0, 900, 600, '#FFFFFF') + circle(450, 300, 180, '#BC002D')),
  c('cd', 'Democratic Republic of the Congo', '#F7D618', '#007FFF', () => rect(0, 0, 800, 600, '#007FFF')
    + poly([[0, 600], [0, 470], [650, 0], [800, 0], [800, 130], [150, 600]], '#F7D618') + poly([[0, 600], [0, 520], [700, 0], [800, 0], [800, 80], [100, 600]], '#CE1021')
    + star(130, 120, 95, '#F7D618'), [800, 600]),
  c('ph', 'Philippines', '#FCD116', '#0038A8', () => bandsH(['#0038A8', '#CE1126'], [1, 1], 1200, 600) + hoist(520, '#FFFFFF')
    + star(173, 300, 70, '#FCD116', 0, 8, 0.45) + circle(173, 300, 42, '#FCD116') + star(45, 55, 22, '#FCD116') + star(45, 545, 22, '#FCD116') + star(450, 300, 22, '#FCD116'), [1200, 600]),
  c('et', 'Ethiopia', '#FCDD09', '#078930', () => bandsH(['#078930', '#FCDD09', '#DA121A'], [1, 1, 1], 1200, 600) + circle(600, 300, 170, '#0F47AF') + star(600, 305, 120, '#FCDD09'), [1200, 600]),
  c('eg', 'Egypt', '#C09300', '#CE1126', () => bandsH(['#CE1126', '#FFFFFF', '#000000']) + poly([[450, 225], [400, 260], [410, 370], [450, 390], [490, 370], [500, 260]], '#C09300')),
  c('vn', 'Vietnam', '#FFCD00', '#DA251D', () => rect(0, 0, 900, 600, '#DA251D') + star(450, 310, 180, '#FFFF00')),
  c('ir', 'Iran', '#2FB24F', '#239F40', () => bandsH(['#239F40', '#FFFFFF', '#DA0000'], [1, 1, 1], 1050, 600)
    + `<g fill="none" stroke="#DA0000" stroke-width="12"><path d="M490,255 Q525,300 490,345"/><path d="M560,255 Q525,300 560,345"/><line x1="525" y1="250" x2="525" y2="350"/></g>`, [1050, 600]),
  c('tr', 'Turkey', '#F0313B', '#E30A17', () => rect(0, 0, 900, 600, '#E30A17') + crescent(337.5, 300, 150, 37.5, 0, 120, '#FFFFFF', '#E30A17') + star(512, 300, 75, '#FFFFFF', -90)),
  c('de', 'Germany', '#FFCE00', '#DD0000', () => bandsH(['#000000', '#DD0000', '#FFCE00'], [1, 1, 1], 1000, 600), [1000, 600]),
  c('th', 'Thailand', '#E0405A', '#2D2A4A', () => bandsH(['#A51931', '#F4F5F8', '#2D2A4A', '#F4F5F8', '#A51931'], [1, 1, 2, 1, 1])),
  c('tz', 'Tanzania', '#FCD116', '#00A3DD', () => rect(0, 0, 900, 600, '#00A3DD') + poly([[0, 0], [900, 0], [0, 600]], '#1EB53A')
    + poly([[0, 600], [0, 470], [705, 0], [900, 0], [900, 130], [195, 600]], '#FCD116') + poly([[0, 600], [0, 530], [795, 0], [900, 0], [900, 70], [105, 600]], '#000000')),
  c('gb', 'United Kingdom', '#C8102E', '#012169', () => unionJack(0, 0, 1200, 600), [1200, 600]),
  c('fr', 'France', '#2F6FD0', '#0055A4', () => bandsV(['#0055A4', '#FFFFFF', '#EF4135'])),
  c('za', 'South Africa', '#FFB81C', '#007749', () => rect(0, 0, 900, 300, '#E03C31') + rect(0, 300, 900, 300, '#001489')
    + `<path d="M0,0 L450,300 L900,300 M0,600 L450,300" stroke="#FFFFFF" stroke-width="200" fill="none"/><path d="M0,0 L450,300 L900,300 M0,600 L450,300" stroke="#007749" stroke-width="120" fill="none"/>`
    + poly([[0, 60], [360, 300], [0, 540]], '#FFB81C') + poly([[0, 120], [270, 300], [0, 480]], '#000000')),
  c('it', 'Italy', '#1FA35B', '#009246', () => bandsV(['#009246', '#FFFFFF', '#CE2B37'])),
  c('ke', 'Kenya', '#D62828', '#006600', () => bandsH(['#000000', '#FFFFFF', '#BB0000', '#FFFFFF', '#006600'], [6, 1, 6, 1, 6])
    + `<ellipse cx="450" cy="300" rx="75" ry="170" fill="#BB0000"/><ellipse cx="450" cy="300" rx="40" ry="120" fill="#000000"/>`
    + `<g stroke="#FFFFFF" stroke-width="10"><line x1="350" y1="90" x2="550" y2="510"/><line x1="550" y1="90" x2="350" y2="510"/></g>`),
  c('co', 'Colombia', '#FCD116', '#003893', () => bandsH(['#FCD116', '#003893', '#CE1126'], [2, 1, 1])),
  c('sd', 'Sudan', '#E23B55', '#007229', () => bandsH(['#D21034', '#FFFFFF', '#000000'], [1, 1, 1], 1200, 600) + hoist(400, '#007229'), [1200, 600]),
  c('mm', 'Myanmar', '#FECB00', '#34B233', () => bandsH(['#FECB00', '#34B233', '#EA2839']) + star(450, 330, 230, '#FFFFFF')),
  c('kr', 'South Korea', '#CD2E3A', '#0047A0', () => {
    const bars = (x, y, angle) => `<g transform="translate(${x} ${y}) rotate(${angle})" fill="#000000">${[0, 1, 2].map(i => rect(-75, -60 + i * 45, 150, 25, '#000000')).join('')}</g>`;
    return rect(0, 0, 900, 600, '#FFFFFF') + `<g transform="rotate(33.7 450 300)">${circle(450, 300, 150, '#CD2E3A')}<path d="M300,300 A150,150 0 0,0 600,300 A75,75 0 0,1 450,300 A75,75 0 0,0 300,300 Z" fill="#0047A0"/></g>`
      + bars(185, 125, -56.3) + bars(715, 475, -56.3) + bars(715, 125, 56.3) + bars(185, 475, 56.3);
  }),
  c('es', 'Spain', '#F1BF00', '#AA151B', () => bandsH(['#AA151B', '#F1BF00', '#AA151B'], [1, 2, 1]) + rect(230, 220, 120, 150, '#AA151B') + rect(250, 240, 80, 110, '#F1BF00') + circle(290, 205, 30, '#AA151B')),
  c('dz', 'Algeria', '#D21034', '#006233', () => bandsV(['#006233', '#FFFFFF']) + crescent(450, 300, 150, 37, 0, 125, '#D21034', '#FFFFFF') + star(500, 300, 70, '#D21034', -90)),
  c('ar', 'Argentina', '#74ACDF', '#74ACDF', () => bandsH(['#74ACDF', '#FFFFFF', '#74ACDF']) + star(450, 300, 75, '#F6B40E', 0, 16, 0.6) + circle(450, 300, 42, '#F6B40E')),
  c('iq', 'Iraq', '#E2384D', '#007A3D', () => bandsH(['#CE1126', '#FFFFFF', '#000000']) + text(450, 335, 110, '#007A3D', 'الله أكبر')),
  c('ug', 'Uganda', '#FCDC04', '#D90000', () => bandsH(['#000000', '#FCDC04', '#D90000', '#000000', '#FCDC04', '#D90000']) + circle(450, 300, 110, '#FFFFFF')
    + `<path d="M420,360 Q440,250 480,240 Q500,280 470,300 L470,370" stroke="#9CA3AF" stroke-width="18" fill="none"/>` + circle(482, 235, 14, '#D90000')),
  c('af', 'Afghanistan', '#E8343A', '#007A36', () => bandsV(['#000000', '#D32011', '#007A36']) + circle(450, 300, 110, '#FFFFFF') + circle(450, 300, 82, '#D32011') + rect(415, 270, 70, 70, '#FFFFFF')),
  c('ca', 'Canada', '#E8344B', '#D80621', () => bandsV(['#D80621', '#FFFFFF', '#D80621'], [1, 2, 1], 1200, 600) + mapleLeaf(600, 285, 20, '#D80621') + rect(592, 455, 16, 70, '#D80621'), [1200, 600]),
  c('uz', 'Uzbekistan', '#0099B5', '#0099B5', () => bandsH(['#0099B5', '#CE1126', '#FFFFFF', '#CE1126', '#1EB53A'], [10, 1, 10, 1, 10], 1000, 500)
    + crescent(120, 80, 55, 22, 0, 48, '#FFFFFF', '#0099B5') + [[1, 3], [2, 4], [3, 5]].flatMap(([row, count]) => Array.from({ length: count }, (_, k) => star(330 - k * 45, row * 40, 14, '#FFFFFF'))).join(''), [1000, 500]),
  c('ao', 'Angola', '#FFCB00', '#CC092F', () => bandsH(['#CC092F', '#000000']) + `<path d="M380,370 A110,110 0 1,1 540,350" stroke="#FFCB00" stroke-width="30" fill="none"/>` + star(470, 250, 40, '#FFCB00')
    + `<line x1="400" y1="390" x2="520" y2="230" stroke="#FFCB00" stroke-width="22"/>`),
  c('ma', 'Morocco', '#E0434A', '#C1272D', () => rect(0, 0, 900, 600, '#C1272D') + `<polygon points="450,170 488,288 612,288 512,361 550,479 450,406 350,479 388,361 288,288 412,288" fill="none" stroke="#006233" stroke-width="22" stroke-linejoin="round" transform="rotate(0 450 330)"/>`),
  c('pl', 'Poland', '#DC143C', '#DC143C', () => bandsH(['#FFFFFF', '#DC143C'], [1, 1], 1000, 625), [1000, 625]),
  c('sa', 'Saudi Arabia', '#1F9E59', '#006C35', () => rect(0, 0, 900, 600, '#006C35') + text(450, 280, 80, '#FFFFFF', 'لا إله إلا الله محمد رسول الله')
    + rect(250, 380, 400, 16, '#FFFFFF') + poly([[650, 372], [700, 388], [650, 404]], '#FFFFFF')),
  c('mz', 'Mozambique', '#FCE100', '#007168', () => bandsH(['#007168', '#FFFFFF', '#000000', '#FFFFFF', '#FCE100'], [6, 0.6, 6, 0.6, 6]) + hoist(420, '#D21034') + star(160, 300, 80, '#FCE100')),
  c('my', 'Malaysia', '#FFCC00', '#010066', () => {
    let out = '';
    for (let i = 0; i < 14; i++) out += rect(0, i * 600 / 14, 1200, 600 / 14 + 0.5, i % 2 ? '#FFFFFF' : '#CC0001');
    return out + rect(0, 0, 600, 600 / 14 * 8, '#010066') + crescent(220, 172, 120, 32, 0, 104, '#FFCC00', '#010066') + star(390, 172, 95, '#FFCC00', 0, 14, 0.45);
  }, [1200, 600]),
  c('gh', 'Ghana', '#FCD116', '#006B3F', () => bandsH(['#CE1126', '#FCD116', '#006B3F']) + star(450, 310, 105, '#000000')),
  c('pe', 'Peru', '#E8354A', '#D91023', () => bandsV(['#D91023', '#FFFFFF', '#D91023'])),
  c('ci', 'Ivory Coast', '#F77F00', '#009E60', () => bandsV(['#F77F00', '#FFFFFF', '#009E60'])),
  c('ye', 'Yemen', '#E2384D', '#CE1126', () => bandsH(['#CE1126', '#FFFFFF', '#000000'])),
  c('mg', 'Madagascar', '#FC3D32', '#007E3A', () => rect(0, 0, 900, 300, '#FC3D32') + rect(0, 300, 900, 300, '#007E3A') + rect(0, 0, 300, 600, '#FFFFFF')),
  c('ua', 'Ukraine', '#FFD700', '#0057B7', () => bandsH(['#0057B7', '#FFD700'])),
  c('np', 'Nepal', '#DC143C', '#003893', () => poly([[90, 20], [690, 300], [300, 300], [700, 580], [90, 580]], '#003893') + poly([[120, 70], [600, 280], [230, 280], [610, 555], [120, 555]], '#DC143C')
    + crescent(250, 200, 60, 0, -25, 55, '#FFFFFF', '#DC143C') + star(250, 205, 30, '#FFFFFF', 0, 12, 0.6) + star(250, 430, 70, '#FFFFFF', 0, 12, 0.6)),
  c('cm', 'Cameroon', '#FCD116', '#007A5E', () => bandsV(['#007A5E', '#CE1126', '#FCD116']) + star(450, 300, 90, '#FCD116')),
  c('ve', 'Venezuela', '#FFCC00', '#00247D', () => bandsH(['#FFCC00', '#00247D', '#CF142B'])
    + Array.from({ length: 8 }, (_, i) => { const a = (200 + i * 140 / 7) * Math.PI / 180; return star(450 + 130 * Math.cos(a), 330 + 130 * Math.sin(a), 22, '#FFFFFF'); }).join('')),
  c('au', 'Australia', '#E4002B', '#012169', () => rect(0, 0, 1200, 600, '#012169') + unionJack(0, 0, 600, 300) + star(300, 450, 70, '#FFFFFF', 0, 7, 0.45)
    + [[900, 480], [750, 280], [900, 110], [1040, 240], [970, 330]].map(([x, y], i) => star(x, y, i === 4 ? 22 : 34, '#FFFFFF', 0, i === 4 ? 5 : 7, i === 4 ? 0.38 : 0.45)).join(''), [1200, 600]),
  c('ne', 'Niger', '#E05206', '#0DB02B', () => bandsH(['#E05206', '#FFFFFF', '#0DB02B']) + circle(450, 300, 70, '#E05206')),
  c('sy', 'Syria', '#1FA35B', '#007A3D', () => bandsH(['#007A3D', '#FFFFFF', '#000000']) + [300, 450, 600].map(x => star(x, 305, 55, '#CE1126')).join('')),
  c('kp', 'North Korea', '#ED1C27', '#024FA2', () => bandsH(['#024FA2', '#FFFFFF', '#ED1C27', '#FFFFFF', '#024FA2'], [6, 1, 16, 1, 6], 1200, 600) + circle(400, 300, 120, '#FFFFFF') + star(400, 305, 115, '#ED1C27'), [1200, 600]),
  c('bf', 'Burkina Faso', '#FCD116', '#009E49', () => bandsH(['#EF2B2D', '#009E49']) + star(450, 300, 95, '#FCD116')),
  c('ml', 'Mali', '#FCD116', '#14B53A', () => bandsV(['#14B53A', '#FCD116', '#CE1126'])),
  c('tw', 'Taiwan', '#F2353F', '#000095', () => rect(0, 0, 900, 600, '#FE0000') + rect(0, 0, 450, 300, '#000095') + star(225, 150, 110, '#FFFFFF', 0, 12, 0.6) + circle(225, 150, 62, '#000095') + circle(225, 150, 54, '#FFFFFF')),
  c('zm', 'Zambia', '#EF7D00', '#198A00', () => rect(0, 0, 900, 600, '#198A00') + rect(675, 225, 75, 375, '#DE2010') + rect(750, 225, 75, 375, '#000000') + rect(825, 225, 75, 375, '#EF7D00')
    + `<path d="M700,150 Q760,90 820,150 Q760,130 700,150 Z" fill="#EF7D00"/>` + rect(752, 120, 16, 70, '#EF7D00')),
  c('lk', 'Sri Lanka', '#FFBE29', '#8D153A', () => rect(0, 0, 1200, 600, '#FFBE29') + rect(25, 25, 150, 550, '#00534E') + rect(175, 25, 150, 550, '#EB7400') + rect(350, 25, 825, 550, '#8D153A')
    + `<ellipse cx="760" cy="300" rx="190" ry="150" fill="#FFBE29"/>` + rect(600, 200, 40, 40, '#8D153A') + rect(880, 200, 40, 40, '#8D153A'), [1200, 600]),
  c('mw', 'Malawi', '#CE1126', '#339E35', () => bandsH(['#000000', '#CE1126', '#339E35']) + star(450, 200, 135, '#CE1126', 0, 31, 0.75) + rect(0, 200, 900, 200, '#CE1126') + circle(450, 200, 70, '#CE1126')),
  c('kz', 'Kazakhstan', '#FEC50C', '#00AFCA', () => rect(0, 0, 1000, 500, '#00AFCA') + star(500, 220, 120, '#FEC50C', 0, 32, 0.75) + circle(500, 220, 75, '#FEC50C')
    + `<path d="M380,350 Q500,290 620,350" stroke="#FEC50C" stroke-width="22" fill="none"/>` + rect(40, 0, 45, 500, '#FEC50C'), [1000, 500]),
  c('so', 'Somalia', '#4189DD', '#4189DD', () => rect(0, 0, 900, 600, '#4189DD') + star(450, 310, 150, '#FFFFFF')),
  c('cl', 'Chile', '#D52B1E', '#0039A6', () => rect(0, 0, 900, 300, '#FFFFFF') + rect(0, 300, 900, 300, '#D52B1E') + rect(0, 0, 300, 300, '#0039A6') + star(150, 155, 75, '#FFFFFF')),
  c('td', 'Chad', '#FECB00', '#002664', () => bandsV(['#002664', '#FECB00', '#C60C30'])),
  c('sn', 'Senegal', '#FDEF42', '#00853F', () => bandsV(['#00853F', '#FDEF42', '#E31B23']) + star(450, 305, 95, '#00853F')),
  c('ro', 'Romania', '#FCD116', '#002B7F', () => bandsV(['#002B7F', '#FCD116', '#CE1126'])),
  c('gt', 'Guatemala', '#4997D0', '#4997D0', () => bandsV(['#4997D0', '#FFFFFF', '#4997D0'], [1, 1, 1], 1200, 750)
    + `<path d="M510,470 A120,120 0 0,1 600,260 M690,470 A120,120 0 0,0 600,260" stroke="#2E7D32" stroke-width="22" fill="none"/>` + rect(545, 330, 110, 70, '#EFE4B0') + circle(600, 300, 26, '#2E7D32'), [1200, 750]),
  c('ec', 'Ecuador', '#FFDD00', '#034EA2', () => bandsH(['#FFDD00', '#034EA2', '#ED1C24'], [2, 1, 1]) + `<ellipse cx="450" cy="300" rx="70" ry="85" fill="#6FB7E4"/>` + poly([[395, 200], [450, 170], [505, 200]], '#6B4423')),
  c('nl', 'Netherlands', '#FF7F00', '#21468B', () => bandsH(['#AE1C28', '#FFFFFF', '#21468B'])),
  c('kh', 'Cambodia', '#E00025', '#032EA1', () => bandsH(['#032EA1', '#E00025', '#032EA1'], [1, 2, 1], 1000, 640)
    + rect(330, 380, 340, 60, '#FFFFFF') + [[380, 250], [440, 290], [500, 220], [560, 290], [620, 250]].map(([x, y]) => poly([[x - 28, 380], [x, y], [x + 28, 380]], '#FFFFFF')).join(''), [1000, 640]),
  c('gn', 'Guinea', '#FCD116', '#009460', () => bandsV(['#CE1126', '#FCD116', '#009460'])),
  c('zw', 'Zimbabwe', '#FFD200', '#006400', () => bandsH(['#006400', '#FFD200', '#D40000', '#000000', '#D40000', '#FFD200', '#006400'], [1, 1, 1, 1, 1, 1, 1], 1200, 600)
    + poly([[0, 0], [520, 300], [0, 600]], '#000000') + poly([[0, 20], [480, 300], [0, 580]], '#FFFFFF') + star(165, 300, 95, '#D40000') + rect(140, 260, 50, 90, '#FFD200'), [1200, 600]),
  c('ss', 'South Sudan', '#FCDD09', '#0F47AF', () => bandsH(['#000000', '#FFFFFF', '#DA121A', '#FFFFFF', '#078930'], [6, 1, 6, 1, 6], 1200, 600) + hoist(520, '#0F47AF') + star(170, 300, 90, '#FCDD09', 30), [1200, 600]),
  c('rw', 'Rwanda', '#FAD201', '#00A1DE', () => bandsH(['#00A1DE', '#FAD201', '#20603D'], [2, 1, 1]) + star(760, 120, 75, '#E5BE01', 0, 24, 0.7) + circle(760, 120, 40, '#00A1DE') + circle(760, 120, 33, '#E5BE01')),
  c('bj', 'Benin', '#FCD116', '#008751', () => rect(0, 0, 900, 300, '#FCD116') + rect(0, 300, 900, 300, '#E8112D') + rect(0, 0, 360, 600, '#008751')),
  c('bi', 'Burundi', '#CE1126', '#1EB53A', () => poly([[0, 0], [1000, 0], [500, 300]], '#CE1126') + poly([[0, 600], [1000, 600], [500, 300]], '#CE1126') + poly([[0, 0], [0, 600], [500, 300]], '#1EB53A') + poly([[1000, 0], [1000, 600], [500, 300]], '#1EB53A')
    + `<path d="M0,0 L1000,600 M1000,0 L0,600" stroke="#FFFFFF" stroke-width="90"/>` + circle(500, 300, 150, '#FFFFFF')
    + [[500, 230], [440, 340], [560, 340]].map(([x, y]) => star(x, y, 46, '#1EB53A', 0, 6, 0.55) + star(x, y, 38, '#CE1126', 0, 6, 0.55)).join(''), [1000, 600]),
  c('ae', 'United Arab Emirates', '#1F9E59', '#00732F', () => bandsH(['#00732F', '#FFFFFF', '#000000'], [1, 1, 1], 1200, 600) + rect(0, 0, 300, 600, '#FF0000'), [1200, 600]),
  c('tn', 'Tunisia', '#F03A45', '#E70013', () => rect(0, 0, 900, 600, '#E70013') + circle(450, 300, 150, '#FFFFFF') + crescent(450, 300, 112, 28, 0, 92, '#E70013', '#FFFFFF') + star(470, 300, 68, '#E70013', -90)),
  c('be', 'Belgium', '#FDDA24', '#EF3340', () => bandsV(['#000000', '#FDDA24', '#EF3340'], [1, 1, 1], 900, 780), [900, 780]),
  c('jo', 'Jordan', '#E2384D', '#007A3D', () => bandsH(['#000000', '#FFFFFF', '#007A3D'], [1, 1, 1], 1200, 600) + hoist(600, '#CE1126') + star(200, 300, 55, '#FFFFFF', 0, 7, 0.45), [1200, 600]),
  c('ht', 'Haiti', '#D21034', '#00209F', () => bandsH(['#00209F', '#D21034'], [1, 1], 1000, 600) + rect(380, 210, 240, 180, '#FFFFFF') + rect(492, 250, 16, 110, '#016A16') + poly([[440, 260], [500, 230], [560, 260], [500, 280]], '#016A16'), [1000, 600]),
  c('pt', 'Portugal', '#E8333A', '#006600', () => bandsV(['#006600', '#FF0000'], [2, 3]) + circle(360, 300, 105, '#FFCC00') + circle(360, 300, 80, '#FF0000') + rect(320, 250, 80, 100, '#FFFFFF') + rect(338, 268, 44, 64, '#003399')),
  c('bo', 'Bolivia', '#F9E300', '#007934', () => bandsH(['#D52B1E', '#F9E300', '#007934'])),
  c('cz', 'Czech Republic', '#D7141A', '#11457E', () => bandsH(['#FFFFFF', '#D7141A']) + hoist(450, '#11457E')),
  c('do', 'Dominican Republic', '#CE1126', '#002D62', () => rect(0, 0, 400, 250, '#002D62') + rect(500, 0, 400, 250, '#CE1126') + rect(0, 350, 400, 250, '#CE1126') + rect(500, 350, 400, 250, '#002D62')
    + rect(400, 0, 100, 600, '#FFFFFF') + rect(0, 250, 900, 100, '#FFFFFF') + rect(425, 265, 50, 70, '#002D62') + rect(440, 280, 20, 40, '#CE1126')),
  c('tj', 'Tajikistan', '#F8C300', '#006600', () => bandsH(['#CC0000', '#FFFFFF', '#006600'], [2, 3, 2], 1200, 600) + poly([[540, 330], [560, 280], [600, 300], [640, 280], [660, 330]], '#F8C300')
    + Array.from({ length: 7 }, (_, i) => { const a = (205 + i * 130 / 6) * Math.PI / 180; return star(600 + 110 * Math.cos(a), 330 + 110 * Math.sin(a), 18, '#F8C300'); }).join(''), [1200, 600]),
  c('se', 'Sweden', '#FECC00', '#006AA7', () => rect(0, 0, 1600, 1000, '#006AA7') + nordic(500, 200, '#FECC00', 1600, 1000), [1600, 1000]),
  c('gr', 'Greece', '#3D86D6', '#0D5EAF', () => {
    let out = '';
    for (let i = 0; i < 9; i++) out += rect(0, i * 600 / 9, 900, 600 / 9 + 0.5, i % 2 ? '#FFFFFF' : '#0D5EAF');
    return out + rect(0, 0, 333.33, 333.33, '#0D5EAF') + rect(133.33, 0, 66.67, 333.33, '#FFFFFF') + rect(0, 133.33, 333.33, 66.67, '#FFFFFF');
  }),
  c('il', 'Israel', '#3D6FE0', '#0038B8', () => rect(0, 0, 1100, 800, '#FFFFFF') + rect(0, 60, 1100, 120, '#0038B8') + rect(0, 620, 1100, 120, '#0038B8')
    + (() => {
      // Star of David: two equilateral triangles sharing the centre.
      const triangle = start => Array.from({ length: 3 }, (_, i) => { const a = (start + i * 120) * Math.PI / 180; return `${n(550 + 150 * Math.cos(a))},${n(400 + 150 * Math.sin(a))}`; }).join(' ');
      return `<g fill="none" stroke="#0038B8" stroke-width="22" stroke-linejoin="miter"><polygon points="${triangle(-90)}"/><polygon points="${triangle(90)}"/></g>`;
    })(), [1100, 800]),
  c('az', 'Azerbaijan', '#00AF66', '#0092BC', () => bandsH(['#0092BC', '#E4002B', '#00AF66'], [1, 1, 1], 1200, 600) + crescent(570, 300, 90, 23, 0, 75, '#FFFFFF', '#E4002B') + star(640, 300, 38, '#FFFFFF', 0, 8, 0.5), [1200, 600]),
  c('hn', 'Honduras', '#2F93E8', '#0073CF', () => bandsH(['#0073CF', '#FFFFFF', '#0073CF'], [1, 1, 1], 1200, 600) + [[600, 300], [500, 255], [500, 345], [700, 255], [700, 345]].map(([x, y]) => star(x, y, 32, '#0073CF')).join(''), [1200, 600]),
  c('pg', 'Papua New Guinea', '#FCD116', '#CE1126', () => poly([[0, 0], [800, 0], [800, 600]], '#CE1126') + poly([[0, 0], [0, 600], [800, 600]], '#000000')
    + `<path d="M480,220 Q600,110 700,180 Q620,190 590,260 Q560,330 480,330 Q530,280 480,220 Z" fill="#FCD116"/>`
    + [[200, 300], [140, 400], [260, 390], [200, 520], [175, 440]].map(([x, y], i) => star(x, y, i === 4 ? 16 : 26, '#FFFFFF')).join(''), [800, 600]),
  c('hu', 'Hungary', '#CE2939', '#477050', () => bandsH(['#CE2939', '#FFFFFF', '#477050'], [1, 1, 1], 1200, 600), [1200, 600]),
  c('cu', 'Cuba', '#CF142B', '#002A8F', () => bandsH(['#002A8F', '#FFFFFF', '#002A8F', '#FFFFFF', '#002A8F'], [1, 1, 1, 1, 1], 1000, 500) + hoist(433, '#CF142B', 500) + star(145, 250, 70, '#FFFFFF'), [1000, 500]),
  c('sl', 'Sierra Leone', '#1EB53A', '#0072C6', () => bandsH(['#1EB53A', '#FFFFFF', '#0072C6'])),
  c('at', 'Austria', '#ED2939', '#ED2939', () => bandsH(['#ED2939', '#FFFFFF', '#ED2939'])),
  c('ch', 'Switzerland', '#E8463A', '#DA291C', () => rect(0, 0, 900, 600, '#DA291C') + rect(390, 150, 120, 300, '#FFFFFF') + rect(300, 240, 300, 120, '#FFFFFF')),
];
