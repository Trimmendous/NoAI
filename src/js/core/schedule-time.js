// Validate wall-clock fields before Date can normalize them into another day/hour.
function fields(value, offsetRequired) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match || Boolean(match[8]) !== offsetRequired) throw new Error(offsetRequired
    ? 'Use ISO-8601 with a timezone, such as 2027-01-15T09:00:00-05:00.'
    : 'Choose a valid local date and time.');
  const [, y, m, d, h, min, sec = '0'] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]
      || Number(h) > 23 || Number(min) > 59 || Number(sec) > 59) {
    throw new Error('Choose a valid calendar date and time; values are not rolled into another day.');
  }
  if (match[8] && match[8] !== 'Z') {
    const [hours, minutes] = match[8].slice(1).split(':').map(Number);
    if (hours > 23 || minutes > 59) throw new Error('Choose a valid timezone offset.');
  }
  return [year, month, day, Number(h), Number(min), Number(sec)];
}

export function parseOffsetTime(value) {
  fields(value, true);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('Choose a valid date and timezone offset.');
  return Math.floor(time / 1000);
}

export function parseLocalTime(value) {
  const expected = fields(value, false);
  const date = new Date(value);
  const actual = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
  if (expected.some((part, index) => part !== actual[index])) {
    throw new Error('This local time does not exist because the clock changes. Choose a time before or after the change.');
  }
  // Date selects the first occurrence of an ambiguous fall-back hour.
  return Math.floor(date.getTime() / 1000);
}
