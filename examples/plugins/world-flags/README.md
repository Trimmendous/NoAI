# World flags

Themes for 239 places around the world, in population order, from Wikipedia's
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

### Limited recognition or disputed status

- **Taiwan**: Limited recognition: governed as the Republic of China; claimed by the People's Republic of China and recognised by few UN members
- **Palestine**: Limited recognition: recognised by most UN members; a UN observer state, not a full member
- **Kosovo**: Limited recognition: recognised by about half of UN members; Serbia considers it part of its territory
- **Western Sahara**: Sovereignty disputed: claimed by Morocco and by the Sahrawi Arab Democratic Republic. The flag shown is the Sahrawi Republic's
- **Northern Cyprus**: Limited recognition: recognised only by Turkey
- **Transnistria**: Limited recognition: not recognised by any UN member; internationally part of Moldova
- **Abkhazia**: Limited recognition: recognised by a handful of states; internationally part of Georgia
- **South Ossetia**: Limited recognition: recognised by a handful of states; internationally part of Georgia
- **Gibraltar**: Overseas territory of the United Kingdom; sovereignty disputed (claimed by Spain)
- **Falkland Islands**: Overseas territory of the United Kingdom; sovereignty disputed (claimed by Argentina as the Malvinas)

### Flag choices

- **Afghanistan**: Flag choice: the black, red and green tricolour is shown; the Taliban government uses a white flag with the Shahada
- **Syria**: Flag choice: the green, white and black flag with three red stars, adopted after the fall of the Assad government
- **New Caledonia**: French territory with two official flags; the Kanak flag is shown, not the French tricolour
- **Saint Martin**: Officially uses the French flag; overseas collectivity of France
- **Wallis and Futuna**: Flag choice: the French flag is the official flag; the local flag is shown. Overseas collectivity of France
- **Saint Barthélemy**: Officially uses the French flag; overseas collectivity of France
- **Saint Pierre and Miquelon**: Flag choice: the French flag is the official flag; the local flag is shown. Overseas collectivity of France

### UN members not recognised by every other member

- **China**: UN member; the People's Republic of China and the Republic of China (Taiwan) each claim to be China
- **South Korea**: UN member; North and South Korea each claim the whole peninsula
- **North Korea**: UN member; North and South Korea each claim the whole peninsula
- **Israel**: UN member not recognised by some other UN members
- **Armenia**: UN member not recognised by Pakistan

### Not sovereign countries (territories, dependencies and regions)

- **Hong Kong**: Special administrative region of China, not a country
- **Puerto Rico**: Territory of the United States, not a country
- **Macau**: Special administrative region of China, not a country
- **French Polynesia**: Overseas collectivity of France, not a country
- **Curaçao**: Constituent country of the Kingdom of the Netherlands, not a sovereign state
- **Guam**: Territory of the United States, not a country
- **Aruba**: Constituent country of the Kingdom of the Netherlands, not a sovereign state
- **Jersey**: Crown dependency of the United Kingdom, not a country
- **Cayman Islands**: Overseas territory of the United Kingdom, not a country
- **U.S. Virgin Islands**: Territory of the United States, not a country
- **Isle of Man**: Crown dependency of the United Kingdom, not a country
- **Guernsey**: Crown dependency of the United Kingdom, not a country
- **Bermuda**: Overseas territory of the United Kingdom, not a country
- **Greenland**: Autonomous territory of the Kingdom of Denmark, not a sovereign state
- **Faroe Islands**: Autonomous territory of the Kingdom of Denmark, not a sovereign state
- **Turks and Caicos Islands**: Overseas territory of the United Kingdom, not a country
- **American Samoa**: Territory of the United States, not a country
- **Northern Mariana Islands**: Territory of the United States, not a country
- **Sint Maarten**: Constituent country of the Kingdom of the Netherlands, not a sovereign state
- **British Virgin Islands**: Overseas territory of the United Kingdom, not a country
- **Anguilla**: Overseas territory of the United Kingdom, not a country
- **Cook Islands**: Self-governing in free association with New Zealand; not a UN member
- **Saint Helena, Ascension and Tristan da Cunha**: Overseas territory of the United Kingdom, not a country
- **Montserrat**: Overseas territory of the United Kingdom, not a country
- **Tokelau**: Territory of New Zealand, not a country
- **Norfolk Island**: External territory of Australia, not a country
- **Christmas Island**: External territory of Australia, not a country
- **Niue**: Self-governing in free association with New Zealand; not a UN member
- **Cocos (Keeling) Islands**: External territory of Australia, not a country
- **Pitcairn Islands**: Overseas territory of the United Kingdom, not a country

### Other notes

- **Cyprus**: Sovereign UN member; the north of the island is administered by Northern Cyprus
- **Palau**: Sovereign UN member in free association with the United States

## Adding or changing a place

Edit `countries.mjs` (the first 100) or `more-places.mjs`, then rebuild:

```
node build.mjs
```
