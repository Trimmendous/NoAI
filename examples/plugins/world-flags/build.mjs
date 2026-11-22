// Builds the plugin from countries.mjs: one SVG flag and one theme per country.
// Run from this folder: node build.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { COUNTRIES } from './countries.mjs';
import { MORE } from './more-places.mjs';

// Judgement calls among the first 100 (the rest carry their note in more-places.mjs).
const NOTES = {
  tw: 'Limited recognition: governed as the Republic of China; claimed by the People\'s Republic of China and recognised by few UN members',
  af: 'Flag choice: the black, red and green tricolour is shown; the Taliban government uses a white flag with the Shahada',
  sy: 'Flag choice: the green, white and black flag with three red stars, adopted after the fall of the Assad government',
  il: 'UN member not recognised by some other UN members',
  am: 'UN member not recognised by Pakistan',
  kp: 'UN member; North and South Korea each claim the whole peninsula',
  kr: 'UN member; North and South Korea each claim the whole peninsula',
  cn: 'UN member; the People\'s Republic of China and the Republic of China (Taiwan) each claim to be China',
};
const PLACES = [...COUNTRIES, ...MORE].map(place => ({ ...place, note: place.note || NOTES[place.code] }));

const hex = value => value.replace('#', '').match(/../g).map(part => parseInt(part, 16));
const toHex = rgb => `#${rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => toHex(hex(a).map((v, i) => v + (hex(b)[i] - v) * t));
const rgba = (color, alpha) => `rgba(${hex(color).join(', ')}, ${alpha})`;
const luminance = color => {
  const [r, g, b] = hex(color).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// Accents sit on dark panels: a navy or forest-green lead colour is lifted
// until it stands out, keeping its hue.
function visible(color) {
  let out = color;
  for (let step = 0; step < 10 && luminance(out) < 0.12; step++) out = mix(out, '#ffffff', 0.12);
  return out;
}

// A dark theme in the flag's colours, with see-through panels so the flag shows.
function colors({ accent: lead, tint }) {
  const accent = visible(lead);
  const deep = mix(tint, '#000000', 0.78);
  return {
    '--canvas': rgba(deep, 0.5),
    '--surface': rgba(mix(deep, '#ffffff', 0.05), 0.84),
    '--surface-subtle': rgba(mix(deep, '#ffffff', 0.09), 0.86),
    '--surface-hover': rgba(mix(deep, '#ffffff', 0.15), 0.9),
    '--surface-selected': rgba(accent, 0.26),
    '--sidebar': rgba(deep, 0.74),
    '--topbar': rgba(deep, 0.7),
    '--fill': 'rgba(255, 255, 255, 0.1)',
    '--fill-hover': 'rgba(255, 255, 255, 0.16)',
    '--ink': '#f7f7f4',
    '--ink-soft': '#dedcd4',
    '--ink-muted': '#aeaca4',
    '--line': 'rgba(255, 255, 255, 0.13)',
    '--line-strong': 'rgba(255, 255, 255, 0.24)',
    '--accent': accent,
    '--accent-hover': mix(accent, '#ffffff', 0.15),
    '--accent-soft': rgba(accent, 0.22),
    '--accent-ink': luminance(accent) > 0.4 ? '#141414' : '#ffffff',
    '--focus': rgba(accent, 0.5),
    '--backdrop-halo': rgba(deep, 0.8),
  };
}

function flagSvg({ flag }) {
  const [width, height] = flag.size || [900, 600];
  const body = flag.kind === 'stripes'
    ? flag.colors.map((color, i, all) => flag.direction === 'vertical'
      ? `<rect x="${(i * width / all.length).toFixed(2)}" width="${(width / all.length).toFixed(2)}" height="${height}" fill="${color}"/>`
      : `<rect y="${(i * height / all.length).toFixed(2)}" width="${width}" height="${(height / all.length).toFixed(2)}" fill="${color}"/>`).join('')
    : flag.draw();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid slice">${body}</svg>\n`;
}

const codes = new Set(PLACES.map(place => place.code));
if (codes.size !== PLACES.length) throw new Error('Two places share a code');
mkdirSync('flags', { recursive: true });
for (const place of PLACES) writeFileSync(`flags/${place.code}.svg`, flagSvg(place));

const manifest = {
  id: 'world-flags',
  name: 'World flags',
  version: '1.0.0',
  description: `Themes for ${PLACES.length} places around the world: the flag fills the background, and every colour matches it.`,
  author: 'Noai',
  permissions: [],
  themes: PLACES.map(place => ({
    id: place.code, name: place.name, base: 'dark',
    background: `flags/${place.code}.svg`, backgroundOpacity: 0.4,
    colors: colors(place),
  })),
};
writeFileSync('plugin.json', `${JSON.stringify(manifest, null, 2)}\n`);

// README: what the plugin is, and every judgement call, so it's easy to review.
const groups = [
  ['Limited recognition or disputed status', note => /^Limited recognition|Sovereignty disputed|sovereignty disputed/.test(note)],
  ['Flag choices', note => /^Flag choice|French flag|Kanak/.test(note)],
  ['UN members not recognised by every other member', note => /^UN member/.test(note)],
  ['Not sovereign countries (territories, dependencies and regions)', note => /not a country|not a sovereign state|not a UN member/.test(note)],
  ['Other notes', () => true],
];
const used = new Set();
const sections = groups.map(([title, test]) => {
  const rows = PLACES.filter(place => place.note && !used.has(place.code) && test(place.note));
  rows.forEach(place => used.add(place.code));
  return rows.length ? `### ${title}\n\n${rows.map(place => `- **${place.name}**: ${place.note}`).join('\n')}\n` : '';
}).join('\n');
writeFileSync('README.md', `# World flags

Themes for ${PLACES.length} places around the world, in population order, from Wikipedia's
"List of countries and dependencies by population". Each puts the place's flag faintly
behind the whole app and matches every colour to it: the accent is the flag's lead colour,
and the panels are tinted with a deep shade of it.

Turn the plugin on in **Settings › Plugins**, then pick a place under **Settings › Appearance**
(search by name).

Flags with detailed coats of arms or emblems use a simplified emblem in the right colours.
They're backgrounds, shown faintly, not reference drawings.

## Judgement calls

Places whose status is debated, flags where there was a choice to make, and places that
aren't sovereign countries. All of them are included.

${sections}
## Adding or changing a place

Edit \`countries.mjs\` (the first 100) or \`more-places.mjs\`, then rebuild:

\`\`\`
node build.mjs
\`\`\`
`);
console.log(`Built ${PLACES.length} place themes; ${PLACES.filter(place => place.note).length} judgement calls listed in README.md.`);
