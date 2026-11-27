/*
 * The Hindu calendar, computed (no outside service): festivals, auspicious
 * days and the periods when families don't hold weddings, per language
 * region. The agent reads it before writing posts, stories and ads, so it
 * never guesses festival dates.
 *
 * How:
 *  - Sun and Moon positions: Meeus, "Astronomical Algorithms" (ch. 25 and 47,
 *    the main Moon terms): about 0.01°, i.e. tithi and new-moon times to a few
 *    minutes. Venus and Jupiter (for Shukra / Guru moudhya): JPL's
 *    approximate Keplerian elements, good to a fraction of a degree.
 *  - Sidereal (nirayana) positions with the Lahiri ayanamsa.
 *  - Lunar months are amanta (new moon to new moon; Karnataka, Andhra,
 *    Telangana, Maharashtra). A month with no sankranti is adhika. Tithis are
 *    taken at sunrise in Bengaluru, or at midday / evening / midnight for
 *    festivals kept then (Ganesha at midday, Deepavali Lakshmi puja in the
 *    evening, Janmashtami and Shivaratri at midnight).
 *
 * Local custom can move a day by one; the prompts say so, and ads never
 * print dates anyway.
 */

const DEG = Math.PI / 180;
const DAY_MS = 86400000;
const IST_MS = 5.5 * 3600000;
const norm = (x) => ((x % 360) + 360) % 360;
const sin = (d) => Math.sin(d * DEG);
const cos = (d) => Math.cos(d * DEG);

const jdOf = (ms) => ms / DAY_MS + 2440587.5;
const centuries = (ms) => (jdOf(ms) - 2451545) / 36525;

/* ------------------------------ Sun and Moon ------------------------------ */

const nutation = (T) => -0.00478 * sin(125.04452 - 1934.136261 * T);

/** The Sun's apparent tropical longitude (degrees). */
export const sunLongitude = (ms) => {
  const T = centuries(ms);
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sin(M) + (0.019993 - 0.000101 * T) * sin(2 * M) + 0.000289 * sin(3 * M);
  return norm(L0 + C - 0.00569 + nutation(T));
};

// Meeus table 47.A (longitude): D, M, M', F, coefficient in 1e-6 degrees.
const MOON_TERMS = [
  [0, 0, 1, 0, 6288774], [2, 0, -1, 0, 1274027], [2, 0, 0, 0, 658314], [0, 0, 2, 0, 213618],
  [0, 1, 0, 0, -185116], [0, 0, 0, 2, -114332], [2, 0, -2, 0, 58793], [2, -1, -1, 0, 57066],
  [2, 0, 1, 0, 53322], [2, -1, 0, 0, 45758], [0, 1, -1, 0, -40923], [1, 0, 0, 0, -34720],
  [0, 1, 1, 0, -30383], [2, 0, 0, -2, 15327], [0, 0, 1, 2, -12528], [0, 0, 1, -2, 10980],
  [4, 0, -1, 0, 10675], [0, 0, 3, 0, 10034], [4, 0, -2, 0, 8548], [2, 1, -1, 0, -7888],
  [2, 1, 0, 0, -6766], [1, 0, -1, 0, -5163], [1, 1, 0, 0, 4987], [2, -1, 1, 0, 4036],
  [2, 0, 2, 0, 3994], [4, 0, 0, 0, 3861], [2, 0, -3, 0, 3665], [0, 1, -2, 0, -2689],
  [2, 0, -1, 2, -2602], [2, -1, -2, 0, 2390], [1, 0, 1, 0, -2348], [2, -2, 0, 0, 2236],
  [0, 1, 2, 0, -2120], [0, 2, 0, 0, -2069], [2, -2, -1, 0, 2048], [2, 0, 1, -2, -1773],
  [2, 0, 0, 2, -1595], [4, -1, -1, 0, 1215], [0, 0, 2, 2, -1110], [3, 0, -1, 0, -892],
  [2, 1, 1, 0, -810], [4, -1, -2, 0, 759], [0, 2, -1, 0, -713], [2, 2, -1, 0, -700],
  [2, 1, -2, 0, 691], [2, -1, 0, -2, 596], [4, 0, 1, 0, 549], [0, 0, 4, 0, 537],
  [4, -1, 0, 0, 520], [1, 0, -2, 0, -487],
];

/** The Moon's apparent tropical longitude (degrees). */
export const moonLongitude = (ms) => {
  const T = centuries(ms);
  const Lp = 218.3164477 + 481267.88123421 * T - 0.0015786 * T * T;
  const D = 297.8501921 + 445267.1114034 * T - 0.0018819 * T * T;
  const M = 357.5291092 + 35999.0502909 * T - 0.0001536 * T * T;
  const Mp = 134.9633964 + 477198.8675055 * T + 0.0087414 * T * T;
  const F = 93.272095 + 483202.0175233 * T - 0.0036539 * T * T;
  const E = 1 - 0.002516 * T - 0.0000074 * T * T;
  let sum = 0;
  for (const [d, m, mp, f, c] of MOON_TERMS) {
    const e = Math.abs(m) === 1 ? E : Math.abs(m) === 2 ? E * E : 1;
    sum += c * e * sin(d * D + m * M + mp * Mp + f * F);
  }
  const A1 = 119.75 + 131.849 * T;
  const A2 = 53.09 + 479264.29 * T;
  sum += 3958 * sin(A1) + 1962 * sin(Lp - F) + 318 * sin(A2);
  return norm(Lp + sum / 1e6 + nutation(T));
};

/** Lahiri ayanamsa (degrees): 23°51′25″ at 2000.0, precessing 50.27″ a year. */
export const ayanamsa = (ms) => 23.8571 + (jdOf(ms) - 2451545) / 365.25 * 0.0139639;

/** The Sun's sidereal (nirayana) longitude. */
export const siderealSun = (ms) => norm(sunLongitude(ms) - ayanamsa(ms));

/** Tithi 1–30 at a moment: 1–15 Shukla (15 = Purnima), 16–30 Krishna (30 = Amavasya). */
export const tithiAt = (ms) => Math.floor(norm(moonLongitude(ms) - sunLongitude(ms)) / 12) + 1;

/** The moment in [a, b] where f changes, by bisection (f(a) !== f(b)), to a minute. */
const bisect = (f, a, b) => {
  const fa = f(a);
  while (b - a > 60000) {
    const m = (a + b) / 2;
    if (f(m) === fa) a = m;
    else b = m;
  }
  return b;
};

/** New moons (exact moments) between two times. */
export const newMoons = (fromMs, toMs) => {
  const out = [];
  const phase = (t) => norm(moonLongitude(t) - sunLongitude(t));
  for (let t = fromMs; t < toMs; t += 6 * 3600000) {
    if (phase(t) > 300 && phase(t + 6 * 3600000) < 60) out.push(bisect((x) => phase(x) > 180, t, t + 6 * 3600000));
  }
  return out;
};

/** Sankrantis (the Sun entering a sidereal sign) between two times: [{ at, sign }], sign 0 = Mesha. */
export const sankrantis = (fromMs, toMs) => {
  const out = [];
  const sign = (t) => Math.floor(siderealSun(t) / 30);
  for (let t = fromMs; t < toMs; t += DAY_MS) {
    if (sign(t) !== sign(t + DAY_MS)) {
      const at = bisect(sign, t, t + DAY_MS);
      out.push({ at, sign: sign(at + 60000) });
    }
  }
  return out;
};

/* -------------------------------- sunrise -------------------------------- */

const PLACE = { lat: 12.9716, lon: 77.5946 }; // Bengaluru

/** Sunrise and sunset (ms) on an IST calendar day "YYYY-MM-DD". */
export const sunTimes = (date) => {
  const noonIst = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), 12) - IST_MS;
  const at = (approx, rising) => {
    let t = approx;
    for (let i = 0; i < 3; i++) {
      const T = centuries(t);
      const lambda = sunLongitude(t);
      const eps = 23.439291 - 0.0130042 * T;
      const dec = Math.asin(sin(eps) * sin(lambda)) / DEG;
      const ra = norm(Math.atan2(cos(eps) * sin(lambda), cos(lambda)) / DEG);
      const L0 = norm(280.46646 + 36000.76983 * T);
      let eot = L0 - 0.0057183 - ra;
      eot = ((eot + 540) % 360) - 180; // degrees, -180..180
      const cosH = (sin(-0.833) - sin(PLACE.lat) * sin(dec)) / (cos(PLACE.lat) * cos(dec));
      const H = Math.acos(Math.max(-1, Math.min(1, cosH))) / DEG;
      // Local solar noon in UTC hours, then ± the half-day arc.
      const dayStartUtc = Date.UTC(new Date(noonIst).getUTCFullYear(), new Date(noonIst).getUTCMonth(), new Date(noonIst).getUTCDate());
      const noonUtcH = 12 - PLACE.lon / 15 - eot / 15;
      t = dayStartUtc + (noonUtcH + (rising ? -H : H) / 15) * 3600000;
    }
    return t;
  };
  return { sunrise: at(noonIst - 6 * 3600000, true), sunset: at(noonIst + 6 * 3600000, false) };
};

/* ------------------------- Venus and Jupiter (moudhya) ------------------------- */

// JPL approximate elements (1800–2050): a, e, I, L, long. perihelion, long. node; and rates per century.
const ELEMENTS = {
  venus: [[0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255], [0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418]],
  earth: [[1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0], [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0]],
  jupiter: [[5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909], [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]],
};

const helio = (planet, T) => {
  const [base, rate] = ELEMENTS[planet];
  const [a, e, I, L, wbar, node] = base.map((v, i) => v + rate[i] * T);
  const w = wbar - node;
  const M = norm(L - wbar);
  let E = M + (e / DEG) * sin(M);
  for (let i = 0; i < 6; i++) E -= (E - (e / DEG) * sin(E) - M) / (1 - e * cos(E));
  const xp = a * (cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * sin(E);
  return [
    (cos(w) * cos(node) - sin(w) * sin(node) * cos(I)) * xp + (-sin(w) * cos(node) - cos(w) * sin(node) * cos(I)) * yp,
    (cos(w) * sin(node) + sin(w) * cos(node) * cos(I)) * xp + (-sin(w) * sin(node) + cos(w) * cos(node) * cos(I)) * yp,
    sin(w) * sin(I) * xp + cos(w) * sin(I) * yp,
  ];
};

/** Angle (degrees) between a planet and the Sun, seen from the Earth. */
export const elongation = (planet, ms) => {
  const T = centuries(ms);
  const earth = helio("earth", T);
  const p = helio(planet, T).map((v, i) => v - earth[i]);
  const s = earth.map((v) => -v);
  const dot = p[0] * s[0] + p[1] * s[1] + p[2] * s[2];
  return Math.acos(dot / (Math.hypot(...p) * Math.hypot(...s))) / DEG;
};

/* ------------------------------- the calendar ------------------------------- */

export const MONTHS = ["Chaitra", "Vaishakha", "Jyeshtha", "Ashadha", "Shravana", "Bhadrapada", "Ashvija", "Kartika", "Margashira", "Pushya", "Magha", "Phalguna"];
const SIGNS = ["Mesha", "Vrishabha", "Mithuna", "Karka", "Simha", "Kanya", "Tula", "Vrischika", "Dhanu", "Makara", "Kumbha", "Meena"];
export const REGIONS = ["Kannada", "Telugu", "Tamil", "Hindi"];
const SOUTH = ["Kannada", "Telugu", "Tamil"];

const dayOf = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const addDays = (date, n) => dayOf(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), 12) - IST_MS + n * DAY_MS);

/** Amanta lunar months overlapping [from, to]: { name, adhika, start, end } (moments). */
export const lunarMonths = (fromMs, toMs) => {
  const moons = newMoons(fromMs - 70 * DAY_MS, toMs + 70 * DAY_MS);
  const raw = [];
  for (let i = 0; i + 1 < moons.length; i++) {
    const r = Math.floor(siderealSun(moons[i]) / 30);
    raw.push({ start: moons[i], end: moons[i + 1], idx: (r + 1) % 12 });
  }
  return raw
    .map((m, i) => ({ name: MONTHS[m.idx], idx: m.idx, adhika: raw[i + 1]?.idx === m.idx, start: m.start, end: m.end }))
    .filter((m) => m.end >= fromMs && m.start <= toMs);
};

/**
 * The moment a festival is kept on a day: sunrise, forenoon (purvahna),
 * midday (madhyahna), afternoon (aparahna), evening (pradosha) or midnight (nishita).
 */
const momentOn = (date, when) => {
  const { sunrise, sunset } = sunTimes(date);
  const day = sunset - sunrise;
  if (when === "forenoon") return sunrise + 0.4 * day;
  if (when === "midday") return sunrise + 0.5 * day;
  if (when === "afternoon") return sunrise + 0.6 * day + 60000;
  if (when === "evening") return sunset + 1.2 * 3600000;
  if (when === "midnight") return (sunset + sunTimes(addDays(date, 1)).sunrise) / 2 - 20 * 60000;
  return sunrise + 60000;
};

/**
 * The day of a lunar date: the first day of that (nija) month on which the
 * tithi holds at the moment it is kept; if it never does (a skipped tithi),
 * the day it begins.
 */
const lunarDay = (months, monthName, tithi, when = "sunrise") => {
  const out = [];
  for (const m of months.filter((x) => x.name === monthName && !x.adhika)) {
    const first = dayOf(m.start);
    let found = null;
    for (let i = 0; i < 32 && !found; i++) {
      const d = addDays(first, i);
      const t = momentOn(d, when);
      if (t >= m.start && t < m.end && tithiAt(t) === tithi) found = d;
    }
    if (!found) {
      // The tithi never holds at that moment (a kshaya tithi): keep it on the day it begins.
      const prev = tithi === 1 ? 30 : tithi - 1;
      const next = tithi === 30 ? 1 : tithi + 1;
      for (let i = -1; i < 32 && !found; i++) {
        const d = addDays(first, i);
        if (tithiAt(momentOn(d, "sunrise")) === prev && tithiAt(momentOn(addDays(d, 1), "sunrise")) === next) found = d;
      }
    }
    if (found) out.push(found);
  }
  return out;
};

/** Spans of days when a planet is within `deg` of the Sun (combust): [{ start, end }]. */
const combust = (planet, deg, fromMs, toMs) => {
  const spans = [];
  let open = null;
  for (let t = fromMs; t <= toMs; t += DAY_MS) {
    const c = elongation(planet, t) < deg;
    if (c && !open) open = dayOf(t);
    if (!c && open) {
      spans.push({ start: open, end: dayOf(t - DAY_MS) });
      open = null;
    }
  }
  if (open) spans.push({ start: open, end: dayOf(toMs) });
  return spans;
};

/**
 * Festivals and periods between two IST dates ("YYYY-MM-DD").
 * kind: "festival" · "auspicious" (good days to start things, weddings) ·
 * "no_weddings" (families don't hold weddings; matchmaking goes on).
 * @returns {Array<{ key: string, name: string, start: string, end: string, kind: string, regions: string[], note: string }>}
 */
export const hinduCalendar = (from, to) => {
  const fromMs = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10)) - IST_MS;
  const toMs = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10), 23, 59) - IST_MS;
  const scanFrom = fromMs - 60 * DAY_MS;
  const scanTo = toMs + 60 * DAY_MS;
  const months = lunarMonths(scanFrom, scanTo);
  const ingress = sankrantis(scanFrom - 40 * DAY_MS, scanTo + 40 * DAY_MS);
  const events = [];
  const add = (key, name, start, end, kind, regions, note = "") => events.push({ key: `${key}:${start}`, name, start, end: end ?? start, kind, regions, note });

  // Solar: the day of a sankranti (Tamil custom: before sunset that day, else the next day).
  const solarDay = (at) => (at < sunTimes(dayOf(at)).sunset ? dayOf(at) : addDays(dayOf(at), 1));
  const signSpan = (sign) => {
    const spans = [];
    for (const s of ingress.filter((x) => x.sign === sign)) {
      const next = ingress.find((x) => x.at > s.at);
      if (next) spans.push({ start: solarDay(s.at), end: addDays(solarDay(next.at), -1) });
    }
    return spans;
  };
  for (const s of ingress.filter((x) => x.sign === 9)) add("sankranti", "Makara Sankranti (Pongal in Tamil Nadu)", solarDay(s.at), null, "festival", REGIONS, "Harvest festival; the wedding season opens after it in the South.");
  for (const s of ingress.filter((x) => x.sign === 0)) add("puthandu", "Tamil New Year (Puthandu)", solarDay(s.at), null, "festival", ["Tamil"]);
  for (const sp of signSpan(8)) add("dhanurmasa", "Dhanurmasa (Margazhi)", sp.start, sp.end, "no_weddings", SOUTH, "No weddings in South Indian families; a time for prayer. Matchmaking goes on: find the match now, marry after Sankranti.");
  for (const sp of signSpan(8)) add("kharmas", "Kharmas", sp.start, sp.end, "no_weddings", ["Hindi"], "No weddings in North Indian families until Makar Sankranti.");
  for (const sp of signSpan(11)) add("kharmas", "Kharmas", sp.start, sp.end, "no_weddings", ["Hindi"], "No weddings in North Indian families until Mesha Sankranti (mid-April).");
  for (const sp of signSpan(3)) add("aadi", "Aadi month", sp.start, sp.end, "no_weddings", ["Tamil"], "Tamil families don't hold weddings in Aadi.");

  // Lunar months.
  for (const m of months) {
    const start = dayOf(m.start + 60000);
    const end = addDays(dayOf(m.end), -1);
    if (m.adhika) add("adhika", `Adhika ${m.name} masa`, start, end, "no_weddings", REGIONS, "An extra lunar month; no weddings.");
    else if (m.name === "Ashadha") add("ashadha", "Ashadha masa", start, end, "no_weddings", ["Kannada", "Telugu"], "No weddings or new beginnings; families wait for Shravana.");
    else if (m.name === "Shravana") add("shravana", "Shravana masa", start, end, "auspicious", ["Kannada", "Telugu"], "A wedding month after Ashadha.");
    else if (m.name === "Kartika") add("kartika", "Kartika masa", start, end, "auspicious", ["Kannada", "Telugu"], "A holy month; weddings resume.");
    else if (m.name === "Magha") add("magha", "Magha masa", start, end, "auspicious", ["Kannada", "Telugu"], "A main wedding month.");
  }

  const lunar = (key, name, month, tithi, when, kind, regions, note) => {
    for (const d of lunarDay(months, month, tithi, when)) add(key, name, d, null, kind, regions, note);
  };
  const lunarSpan = (key, name, month, t1, t2, kind, regions, note) => {
    const a = lunarDay(months, month, t1);
    const b = lunarDay(months, month, t2);
    a.forEach((d, i) => b[i] && add(key, name, d, b[i], kind, regions, note));
  };
  lunar("ugadi", "Ugadi (new year)", "Chaitra", 1, "sunrise", "festival", ["Kannada", "Telugu"]);
  lunarSpan("chaitra_navratri", "Chaitra Navratri", "Chaitra", 1, 9, "festival", ["Hindi"]);
  lunar("ramanavami", "Sri Rama Navami", "Chaitra", 9, "midday", "festival", REGIONS, "Sita and Rama's wedding is celebrated soon after; a fitting day for this site.");
  lunar("akshaya", "Akshaya Tritiya", "Vaishakha", 3, "forenoon", "auspicious", REGIONS, "One of the most auspicious days to begin things, including weddings.");
  lunarSpan("chaturmas", "Chaturmas", "Ashadha", 11, 11, "no_weddings", [], "");
  lunar("rakhi", "Raksha Bandhan", "Shravana", 15, "sunrise", "festival", ["Hindi"]);
  lunar("varamahalakshmi_hint", "Shravana Purnima", "Shravana", 15, "sunrise", "festival", ["Kannada", "Telugu", "Tamil"], "Varamahalakshmi Vrata falls on the Friday before it.");
  lunar("janmashtami", "Krishna Janmashtami", "Shravana", 23, "midnight", "festival", REGIONS);
  lunar("ganesha", "Ganesh Chaturthi", "Bhadrapada", 4, "midday", "festival", REGIONS);
  lunarSpan("pitru", "Pitru Paksha (Mahalaya)", "Bhadrapada", 16, 30, "no_weddings", REGIONS, "A fortnight for ancestors; no weddings or celebrations. Avoid festive or 'register today' tones.");
  lunarSpan("navaratri", "Navaratri (Dasara)", "Ashvija", 1, 9, "festival", REGIONS);
  lunar("dasara", "Vijayadashami (Dasara)", "Ashvija", 10, "afternoon", "festival", REGIONS, "An auspicious day to begin new things.");
  lunar("naraka", "Naraka Chaturdashi (Deepavali)", "Ashvija", 29, "sunrise", "festival", SOUTH);
  lunar("deepavali", "Deepavali (Lakshmi Puja)", "Ashvija", 30, "evening", "festival", REGIONS);
  lunar("balipadyami", "Bali Padyami", "Kartika", 1, "sunrise", "festival", ["Kannada"]);
  lunar("devuthani", "Dev Uthani Ekadashi (Tulsi Vivah)", "Kartika", 11, "sunrise", "auspicious", ["Hindi"], "The North Indian wedding season begins.");
  lunar("shivaratri", "Maha Shivaratri", "Magha", 29, "midnight", "festival", REGIONS);
  lunarSpan("holashtak", "Holashtak", "Phalguna", 8, 15, "no_weddings", ["Hindi"], "Eight days before Holi; no weddings.");
  for (const d of lunarDay(months, "Phalguna", 15, "sunrise")) {
    add("holika", "Holika Dahan", d, null, "festival", ["Hindi"]);
    add("holi", "Holi", addDays(d, 1), null, "festival", ["Hindi"]);
  }

  // Chaturmas (North): Devshayani Ekadashi (Ashadha S11) to Dev Uthani Ekadashi (Kartika S11).
  const chat = events.filter((e) => e.key.startsWith("chaturmas:"));
  for (const c of chat) {
    events.splice(events.indexOf(c), 1);
    const end = events.find((e) => e.key.startsWith("devuthani:") && e.start > c.start);
    if (end) add("chaturmas", "Chaturmas", c.start, addDays(end.start, -1), "no_weddings", ["Hindi"], "No weddings in North Indian families until Dev Uthani Ekadashi.");
  }

  // Vaikuntha Ekadashi: the Shukla Ekadashi while the Sun is in Dhanu.
  for (const sp of signSpan(8)) {
    for (let d = sp.start; d <= sp.end; d = addDays(d, 1)) {
      if (tithiAt(momentOn(d, "sunrise")) === 11) {
        add("vaikuntha", "Vaikuntha Ekadashi", d, null, "festival", SOUTH);
        break;
      }
    }
  }

  // Guru and Shukra moudhya (combust): no wedding muhurthams.
  for (const s of combust("venus", 10, scanFrom, scanTo)) add("shukra", "Shukra moudhya (Venus combust)", s.start, s.end, "no_weddings", REGIONS, "No wedding muhurthams; dates approximate (panchangs differ by a few days).");
  for (const s of combust("jupiter", 11, scanFrom, scanTo)) add("guru", "Guru moudhya (Jupiter combust)", s.start, s.end, "no_weddings", REGIONS, "No wedding muhurthams; dates approximate (panchangs differ by a few days).");

  return events
    .filter((e) => e.end >= from && e.start <= to && e.regions.length)
    .sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name));
};

const cache = new Map();
/** The calendar from today (IST) for `days` days, cached for the day. */
export const upcomingCalendar = (days = 60, now = Date.now()) => {
  const from = dayOf(now);
  const to = addDays(from, days);
  const key = `${from}:${to}`;
  if (!cache.has(key)) {
    if (cache.size > 20) cache.clear();
    cache.set(key, hinduCalendar(from, to));
  }
  return cache.get(key);
};

const pretty = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

/**
 * The calendar as prompt lines for one language (or all), e.g.
 * "- 16 Dec – 14 Jan: Dhanurmasa (Margazhi) [no weddings; Kannada, Telugu, Tamil]: …"
 */
export const calendarNotes = ({ days = 21, language = null, now = Date.now() } = {}) => {
  const lang = language ? String(language).split(/[\s(]/)[0] : null;
  const rows = upcomingCalendar(days, now).filter((e) => !lang || lang === "English" || e.regions.includes(lang));
  const lines = rows.map((e) => {
    const when = e.start === e.end ? pretty(e.start) : `${pretty(e.start)} – ${pretty(e.end)}`;
    const kind = e.kind === "no_weddings" ? "no weddings" : e.kind;
    return `- ${when}: ${e.name} [${kind}; ${e.regions.length === REGIONS.length ? "all regions" : e.regions.join(", ")}]${e.note ? `: ${e.note}` : ""}`;
  });
  return `Hindu calendar, next ${days} days${lang && lang !== "English" ? ` (${lang} families)` : ""}, computed from the panchang (a day either way by local custom):
${lines.join("\n") || "- nothing notable"}
How to use it: name a festival or season only if it is on this list, and only in the days around it. During a "no weddings" period, don't speak of an upcoming wedding date or a wedding rush; families still look for matches, so the message is "find the right match now, for the wedding season ahead". During Pitru Paksha, avoid festive tones. Don't invent festivals or dates.`;
};

export { SIGNS };
