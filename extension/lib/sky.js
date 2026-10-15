// Pure computations shared by the widget: local time handling, sun and moon
// state, sky colours, the 2 hour rain nowcast, air quality bands and the
// "tip of the day". No GNOME Shell imports here so it can be unit tested with
// plain gjs.
import {_, fmt, uiLocale} from './i18n.js';

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;
const SYNODIC_MONTH = 29.530588853;
const NEW_MOON_EPOCH = 947182440; // 2000-01-06 18:14 UTC

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function smoothstep(edge0, edge1, x) {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}

function hex(color) {
    const n = parseInt(color.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

/**
 * Linear blend of two RGB triplets.
 *
 * @param {number[]} a first colour
 * @param {number[]} b second colour
 * @param {number} t 0 = a, 1 = b
 * @returns {number[]}
 */
export function mix(a, b, t) {
    return a.map((v, i) => v + (b[i] - v) * t);
}

/**
 * Converts an Open-Meteo local time ("2026-10-13T17:15") to unix seconds.
 *
 * @param {string} iso local time in the forecast's time zone
 * @param {number} offsetSeconds utc_offset_seconds of the forecast
 * @returns {number}
 */
export function localToUnix(iso, offsetSeconds) {
    const [date, time = '00:00'] = iso.split('T');
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    return Date.UTC(y, m - 1, d, hh, mm) / 1000 - offsetSeconds;
}

const clockFormats = new Map();
// "24h" or "12h", mirrored from org.gnome.desktop.interface clock-format
let clockFormat = '24h';

/**
 * Chooses between the 24 hour ("15:05") and the 12 hour ("3:05 PM") clock
 * for every time label of the widget.
 *
 * @param {string} format "12h" or "24h"
 */
export function setClockFormat(format) {
    clockFormat = format === '12h' ? '12h' : '24h';
}

/** @returns {boolean} whether the 12 hour clock is in use */
export function twelveHourClock() {
    return clockFormat === '12h';
}

const pad2 = n => String(n).padStart(2, '0');

/**
 * Formats a wall clock time in the user's clock format.
 *
 * @param {number} hour 0..23
 * @param {number} minute 0..59
 * @param {object} [options]
 * @param {boolean} [options.short] drop the minutes in the 12 hour format ("3 PM")
 * @returns {string}
 */
export function hourMinuteLabel(hour, minute, {short = false} = {}) {
    if (clockFormat !== '12h')
        return `${pad2(hour)}:${pad2(minute)}`;
    const h = hour % 12 || 12;
    const suffix = hour < 12 ? 'AM' : 'PM';
    return short ? `${h} ${suffix}` : `${h}:${pad2(minute)} ${suffix}`;
}

const dateFormats = new Map();

/** An Intl date formatter for the widget's language (system time zone). */
function dateFormat(options) {
    const locale = uiLocale();
    const key = `${locale}|${JSON.stringify(options)}`;
    let format = dateFormats.get(key);
    if (!format) {
        try {
            format = new Intl.DateTimeFormat(locale, options);
        } catch {
            format = new Intl.DateTimeFormat('en', options);
        }
        dateFormats.set(key, format);
    }
    return format;
}

/**
 * The abbreviated weekday name of a calendar day ("Thu", "gio" -> "Gio").
 *
 * @param {number} year the year
 * @param {number} month 1..12
 * @param {number} day 1..31
 * @returns {string}
 */
export function weekdayLabel(year, month, day) {
    const text = dateFormat({weekday: 'short'}).format(new Date(year, month - 1, day, 12)).replace(/\.$/, '');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A short local date for the popups: "14 Oct", "14 Oct 2026" or
 * "14 Oct 15:01" (the time in the user's clock format).
 *
 * @param {number} unix seconds
 * @param {object} [options]
 * @param {boolean} [options.time] append the time
 * @param {boolean} [options.year] include the year
 * @returns {string}
 */
export function dateLabel(unix, {time = false, year = false} = {}) {
    const date = new Date(unix * 1000);
    const spec = {day: 'numeric', month: 'short'};
    if (year)
        spec.year = 'numeric';
    const text = dateFormat(spec).format(date);
    return time ? `${text} ${hourMinuteLabel(date.getHours(), date.getMinutes())}` : text;
}

/**
 * Formats an instant as a wall clock time in the forecast's time zone.
 * Open-Meteo's local time strings all use one fixed UTC offset, so around
 * a DST change they are off by an hour; the zone name gets it right.
 *
 * @param {number} unix seconds
 * @param {string} [timezone] IANA zone of the forecast (data.timezone)
 * @param {object} [options] see hourMinuteLabel()
 * @returns {string}
 */
export function clockLabel(unix, timezone, options = {}) {
    const key = timezone ?? '';
    let format = clockFormats.get(key);
    if (!format) {
        const spec = {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'};
        try {
            format = new Intl.DateTimeFormat('en-GB', {...spec, timeZone: timezone || undefined});
        } catch {
            format = new Intl.DateTimeFormat('en-GB', spec); // unknown zone: system zone
        }
        clockFormats.set(key, format);
    }
    const [hour, minute] = format.format(new Date(unix * 1000)).split(':').map(Number);
    return hourMinuteLabel(hour % 24, minute, options);
}

const secondFormats = new Map();

/**
 * Formats an instant as "15:05:09" (or "3:05:09 PM") in a time zone.
 *
 * @param {number} unix seconds
 * @param {string} [timezone] IANA zone; empty or unknown means the system zone
 * @returns {string}
 */
export function clockTimeLabel(unix, timezone) {
    const key = timezone ?? '';
    let format = secondFormats.get(key);
    if (!format) {
        const spec = {hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'};
        try {
            format = new Intl.DateTimeFormat('en-GB', {...spec, timeZone: timezone || undefined});
        } catch {
            format = new Intl.DateTimeFormat('en-GB', spec);
        }
        secondFormats.set(key, format);
    }
    const [hour, minute, second] = format.format(new Date(unix * 1000)).split(':').map(Number);
    const label = hourMinuteLabel(hour % 24, minute);
    // "15:05" -> "15:05:09", "3:05 PM" -> "3:05:09 PM"
    return label.replace(/^(\d{1,2}:\d{2})/, `$1:${pad2(second)}`);
}

/**
 * @param {number} seconds a duration
 * @returns {string} e.g. "3 h 20 min"
 */
export function formatDuration(seconds) {
    const days = Math.floor(seconds / DAY);
    const hours = Math.floor(seconds % DAY / HOUR);
    const minutes = Math.floor(seconds % HOUR / MINUTE);
    if (days > 0)
        return fmt(_('%d d %d h'), days, hours);
    if (hours > 0)
        return fmt(_('%d h %d min'), hours, minutes);
    return fmt(_('%d min'), minutes);
}

/**
 * @param {number} seconds how long ago
 * @returns {string} e.g. "3 h ago"
 */
export function timeAgo(seconds) {
    if (seconds < MINUTE)
        return _('just now');
    if (seconds < HOUR)
        return fmt(_('%d min ago'), Math.floor(seconds / MINUTE));
    if (seconds < DAY)
        return fmt(_('%d h ago'), Math.floor(seconds / HOUR));
    return fmt(_('%d d ago'), Math.floor(seconds / DAY));
}

// ---- sun ---------------------------------------------------------------

/**
 * Where the sun is in its daily cycle.
 *
 * @param {object} data an Open-Meteo forecast with daily sunrise/sunset
 * @param {number} now unix seconds
 * @returns {{isDay: boolean, polar: boolean, progress: number, start: number, end: number,
 *   sunrise: number, sunset: number, sunriseLabel: string, sunsetLabel: string,
 *   minutesFromHorizon: number, nearestIsSunrise: boolean}|null}
 *   progress runs 0..1 from sunrise to sunset (day) or sunset to sunrise
 *   (night); minutesFromHorizon is positive while the sun is up; polar is
 *   true during the midnight sun or the polar night (labels are "—")
 */
export function sunState(data, now) {
    const daily = data?.daily;
    if (!daily?.sunrise?.length || !daily?.sunset?.length)
        return null;
    const off = data.utc_offset_seconds ?? 0;
    const zone = data.timezone;
    const allRises = daily.sunrise.map(t => localToUnix(t, off));
    const allSets = daily.sunset.map(t => localToUnix(t, off));
    // Open-Meteo reports "T00:00" for both events during the polar night and
    // a sunset a whole day after the sunrise during the midnight sun
    const polar = allRises.map((r, i) =>
        (allSets[i] - r <= 0 ? 'night' : allSets[i] - r >= DAY - MINUTE ? 'day' : null));

    if (daily.time?.length) {
        const today = daily.time.findIndex(t => {
            const midnight = localToUnix(t, off);
            return now >= midnight && now < midnight + DAY;
        });
        if (today >= 0 && polar[today]) {
            const isDay = polar[today] === 'day';
            const midnight = localToUnix(daily.time[today], off);
            return {
                isDay,
                polar: true,
                start: midnight,
                end: midnight + DAY,
                sunrise: midnight,
                sunset: midnight + DAY,
                progress: clamp((now - midnight) / DAY, 0, 1),
                sunriseLabel: '—',
                sunsetLabel: '—',
                minutesFromHorizon: isDay ? 720 : -720,
                nearestIsSunrise: true,
            };
        }
    }

    // the midnight pseudo-events of polar days must not count as sunrises
    let rises = allRises.filter((_r, i) => polar[i] === null);
    let sets = allSets.filter((_s, i) => polar[i] === null);
    if (!rises.length) {
        rises = allRises;
        sets = allSets;
    }

    let state = null;
    for (let i = 0; i < rises.length; i++) {
        if (now >= rises[i] && now < sets[i]) {
            state = {isDay: true, start: rises[i], end: sets[i], sunrise: rises[i], sunset: sets[i]};
            break;
        }
    }
    if (!state) {
        let prevSet = null;
        let nextRise = null;
        for (const s of sets) {
            if (s <= now)
                prevSet = s;
        }
        for (const r of rises) {
            if (r > now) {
                nextRise = r;
                break;
            }
        }
        if (prevSet === null)
            prevSet = sets[0] - DAY;
        if (nextRise === null)
            nextRise = rises[rises.length - 1] + DAY;
        const nextSet = sets.find(s => s > nextRise) ?? nextRise + 12 * HOUR;
        state = {isDay: false, start: prevSet, end: nextRise, sunrise: nextRise, sunset: nextSet};
    }
    state.polar = false;
    state.progress = clamp((now - state.start) / Math.max(1, state.end - state.start), 0, 1);
    state.sunriseLabel = clockLabel(state.sunrise, zone);
    state.sunsetLabel = clockLabel(state.sunset, zone);

    const events = [
        ...rises.map(t => [t, true]),
        ...sets.map(t => [t, false]),
        [sets[0] - DAY, false],
        [rises[rises.length - 1] + DAY, true],
    ];
    let nearest = Infinity;
    let nearestIsSunrise = true;
    for (const [t, isRise] of events) {
        if (Math.abs(now - t) < nearest) {
            nearest = Math.abs(now - t);
            nearestIsSunrise = isRise;
        }
    }
    state.minutesFromHorizon = (state.isDay ? 1 : -1) * nearest / MINUTE;
    state.nearestIsSunrise = nearestIsSunrise;
    return state;
}

// ---- moon --------------------------------------------------------------

/**
 * @param {number} now unix seconds
 * @returns {{phase: number, illumination: number, waxing: boolean, name: string,
 *   daysToFull: number, daysToNew: number}} phase runs 0 (new) .. 0.5 (full) .. 1;
 *   daysToFull / daysToNew count to the next such phase (0 when it is now)
 */
export function moonPhase(now) {
    const age = ((now - NEW_MOON_EPOCH) / DAY) % SYNODIC_MONTH;
    const phase = (age < 0 ? age + SYNODIC_MONTH : age) / SYNODIC_MONTH;
    const names = [
        _('New moon'), _('Waxing crescent'), _('First quarter'), _('Waxing gibbous'),
        _('Full moon'), _('Waning gibbous'), _('Last quarter'), _('Waning crescent'),
    ];
    return {
        phase,
        illumination: (1 - Math.cos(2 * Math.PI * phase)) / 2,
        waxing: phase < 0.5,
        name: names[Math.round(phase * 8) % 8],
        daysToFull: ((0.5 - phase + 1) % 1) * SYNODIC_MONTH,
        daysToNew: ((1 - phase) % 1) * SYNODIC_MONTH,
    };
}

/**
 * "full moon in 4 d" / "new moon in 12 d": the next notable phase, or null
 * when it is tonight (the phase name already says so).
 *
 * @param {object} moon result of moonPhase()
 * @returns {string|null}
 */
export function nextMoonLabel(moon) {
    // the name already says "Full moon" / "New moon" around those phases
    const octant = Math.round(moon.phase * 8) % 8;
    if (octant === 0 || octant === 4)
        return null;
    const toFull = Math.round(moon.daysToFull);
    const toNew = Math.round(moon.daysToNew);
    if (moon.waxing)
        return toFull >= 1 ? fmt(_('full moon in %d d'), toFull) : null;
    return toNew >= 1 ? fmt(_('new moon in %d d'), toNew) : null;
}

// ---- sky colours -------------------------------------------------------

const PALETTE = {
    day: {
        sun: ['#2b6ccc', '#8cc3f4'],
        cloud: ['#5c6d83', '#9aa9bd'],
        rain: ['#3e4d68', '#66788f'],
        snow: ['#7d93b2', '#c5d3e5'],
        storm: ['#2d3252', '#585e82'],
    },
    night: {
        sun: ['#070c24', '#1a2447'],
        cloud: ['#13171f', '#272d3a'],
        rain: ['#0f1521', '#1f2838'],
        snow: ['#1a2438', '#36465f'],
        storm: ['#100d24', '#27234a'],
    },
    horizon: {
        clear: ['#2f2d6b', '#f08b4f'],
        dull: ['#3b3f5a', '#8a6c68'],
    },
};

/**
 * The sky behind the card for the current sun position and weather.
 *
 * @param {object|null} sun result of sunState()
 * @param {string} kind weather kind from weatherInfo(): sun, moon, cloud, rain, snow, storm
 * @returns {{top: number[], bottom: number[], stars: number, glow: number,
 *   glowRight: boolean, precip: string|null}} colours as RGB 0..1
 */
export function skyColors(sun, kind) {
    const k = kind === 'moon' || !PALETTE.day[kind] ? 'sun' : kind;
    const m = sun ? sun.minutesFromHorizon : 300;
    const dayFactor = smoothstep(-35, 35, m);
    const twilight = 1 - smoothstep(20, 75, Math.abs(m));
    const day = PALETTE.day[k].map(hex);
    const night = PALETTE.night[k].map(hex);
    const horizon = PALETTE.horizon[k === 'sun' ? 'clear' : 'dull'].map(hex);
    const dull = k !== 'sun';

    let top = mix(night[0], day[0], dayFactor);
    let bottom = mix(night[1], day[1], dayFactor);
    top = mix(top, horizon[0], twilight * (dull ? 0.4 : 0.7));
    bottom = mix(bottom, horizon[1], twilight * (dull ? 0.5 : 0.9));

    return {
        top,
        bottom,
        stars: (1 - dayFactor) * (k === 'sun' ? 1 : k === 'cloud' ? 0.3 : 0.08),
        glow: twilight * (k === 'sun' ? 1 : k === 'cloud' ? 0.45 : 0),
        glowRight: !(sun?.nearestIsSunrise ?? true),
        precip: k === 'rain' || k === 'storm' ? 'rain' : k === 'snow' ? 'snow' : null,
    };
}

// ---- rain nowcast ------------------------------------------------------

const WET_MM = 0.05;
const SNOW_CODES = [71, 73, 75, 77, 85, 86];

/**
 * Precipitation over the next two hours from the 15 minute forecast.
 *
 * @param {object} data an Open-Meteo forecast with minutely_15 data
 * @param {number} now unix seconds
 * @returns {{active: boolean, raining: boolean, bars: number[], text: string|null}|null}
 *   bars holds mm per 15 minute slot; active is false when it stays dry
 */
export function rainNowcast(data, now) {
    const m = data?.minutely_15;
    if (!m?.time?.length)
        return null;
    const off = data.utc_offset_seconds ?? 0;
    const slots = m.time.map((t, i) => ({
        start: localToUnix(t, off),
        mm: m.precipitation?.[i] ?? 0,
        code: m.weather_code?.[i] ?? 0,
    }));
    const first = slots.findIndex(s => s.start + 15 * MINUTE > now);
    if (first < 0)
        return null;
    const next = slots.slice(first, first + 8);
    const wet = s => s.mm >= WET_MM;
    const snowy = c => SNOW_CODES.includes(c);
    const bars = next.map(s => s.mm);
    const minutesTo = t => Math.max(1, Math.round((t - now) / MINUTE));

    const current = data.current ?? {};
    if (wet(next[0]) || (current.precipitation ?? 0) >= WET_MM) {
        const snow = snowy(next[0].code) || snowy(current.weather_code);
        const endIdx = next.findIndex((s, i) => i > 0 && !wet(s));
        let text;
        if (endIdx < 0)
            text = snow ? _('Snowing · for more than 2 h') : _('Raining · for more than 2 h');
        else
            text = fmt(snow ? _('Snowing · stops in %d min') : _('Raining · stops in %d min'), minutesTo(next[endIdx].start));
        return {active: true, raining: true, bars, text};
    }

    const startIdx = next.findIndex(wet);
    if (startIdx < 0)
        return {active: false, raining: false, bars, text: null};
    const snow = snowy(next[startIdx].code);
    let endIdx = startIdx;
    while (endIdx < next.length && wet(next[endIdx]))
        endIdx++;
    const duration = (endIdx - startIdx) * 15;
    const startMin = minutesTo(next[startIdx].start);
    const text = endIdx < next.length
        ? fmt(snow ? _('Snow in %d min · for ~%d min') : _('Rain in %d min · for ~%d min'), startMin, duration)
        : fmt(snow ? _('Snow in %d min · over %d min') : _('Rain in %d min · over %d min'), startMin, duration);
    return {active: true, raining: false, bars, text};
}

// ---- air quality, UV and pollen ---------------------------------------

const EAQI_BANDS = [[20, 'good'], [40, 'fair'], [60, 'moderate'], [80, 'poor'], [100, 'very-poor'], [Infinity, 'hazardous']];
const USAQI_BANDS = [[50, 'good'], [100, 'fair'], [150, 'moderate'], [200, 'poor'], [300, 'very-poor'], [Infinity, 'hazardous']];
const AIR_TEXT = {
    good: () => _('Air good'),
    fair: () => _('Air fair'),
    moderate: () => _('Air moderate'),
    poor: () => _('Air poor'),
    'very-poor': () => _('Air very poor'),
    hazardous: () => _('Air hazardous'),
};
// grains/m³ thresholds for moderate and high, per species
const POLLEN = [
    ['alder_pollen', () => _('alder'), 10, 50],
    ['birch_pollen', () => _('birch'), 10, 50],
    ['grass_pollen', () => _('grass'), 20, 50],
    ['mugwort_pollen', () => _('mugwort'), 10, 50],
    ['olive_pollen', () => _('olive'), 10, 50],
    ['ragweed_pollen', () => _('ragweed'), 5, 20],
];

/**
 * @param {number} uv UV index now
 * @param {number|null} [max] the day's maximum UV index, mentioned when it is still to come
 * @returns {{level: string, text: string}}
 */
export function uvInfo(uv, max = null) {
    const v = Math.round(uv);
    let info;
    if (uv < 3)
        info = {level: 'good', text: fmt(_('UV %d · low'), v)};
    else if (uv < 6)
        info = {level: 'moderate', text: fmt(_('UV %d · moderate'), v)};
    else if (uv < 8)
        info = {level: 'poor', text: fmt(_('UV %d · high'), v)};
    else if (uv < 11)
        info = {level: 'very-poor', text: fmt(_('UV %d · very high'), v)};
    else
        info = {level: 'hazardous', text: fmt(_('UV %d · extreme'), v)};
    if (Number.isFinite(max) && Math.round(max) > v)
        info.text += ` · ${fmt(_('max %d'), Math.round(max))}`;
    return info;
}

// ---- weather warnings (MeteoAlarm) -------------------------------------

const WARNING_TYPES = {
    wind: () => _('wind'),
    rain: () => _('rain'),
    'rain-flood': () => _('rain and flooding'),
    flood: () => _('flooding'),
    flooding: () => _('flooding'),
    thunderstorm: () => _('thunderstorms'),
    thunderstorms: () => _('thunderstorms'),
    snow: () => _('snow'),
    'snow-ice': () => _('snow and ice'),
    'snow/ice': () => _('snow and ice'),
    ice: () => _('ice'),
    fog: () => _('fog'),
    'high-temperature': () => _('heat'),
    heat: () => _('heat'),
    'low-temperature': () => _('cold'),
    cold: () => _('cold'),
    'coastal-event': () => _('coastal event'),
    'coastalevent': () => _('coastal event'),
    'forest-fire': () => _('forest fire'),
    forestfire: () => _('forest fire'),
    avalanche: () => _('avalanches'),
    avalanches: () => _('avalanches'),
};
const WARNING_COLORS = {
    yellow: {level: 'moderate', rank: 1, name: () => _('Yellow')},
    orange: {level: 'poor', rank: 2, name: () => _('Orange')},
    red: {level: 'very-poor', rank: 3, name: () => _('Red')},
};

/**
 * Describes a MeteoAlarm warning for the chip: colour, level and a
 * translated label such as "Orange alert · wind".
 *
 * @param {{event: string, severity: string}} warning parsed feed entry
 * @returns {{level: string, rank: number, text: string, color: string|null}}
 */
export function warningInfo(warning) {
    // "Orange Wind Warning", "Yellow Rain-Flood Warning", "Red Snow/Ice Warning"
    const m = warning.event.match(/^\s*(yellow|orange|red)\s+(.+?)\s+warning\s*$/i);
    let colorKey = m?.[1]?.toLowerCase() ?? null;
    if (!colorKey) {
        const severity = (warning.severity ?? '').toLowerCase();
        colorKey = severity === 'extreme' ? 'red' : severity === 'severe' ? 'orange' : severity === 'moderate' ? 'yellow' : null;
    }
    const color = WARNING_COLORS[colorKey] ?? null;
    const typeKey = (m?.[2] ?? '').toLowerCase().replace(/\s+/g, '-');
    const type = WARNING_TYPES[typeKey]?.() ?? (m?.[2] ?? warning.event);
    const text = color && m ? fmt(_('%s alert · %s'), color.name(), type) : warning.event;
    return {level: color?.level ?? 'moderate', rank: color?.rank ?? 1, text, color: colorKey};
}

/** Lower case, accents and punctuation stripped, for comparing region names. */
export function normalizeName(text) {
    return (text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// English names of Italian regions as some geocoders spell them
const REGION_ALIASES = {
    sicily: 'sicilia', sardinia: 'sardegna', tuscany: 'toscana', lombardy: 'lombardia',
    piedmont: 'piemonte', apulia: 'puglia', 'aosta valley': 'valle d aosta', marches: 'marche',
    'trentino south tyrol': 'trentino alto adige', 'emilia romagna': 'emilia romagna',
};

/**
 * Whether a warning's area is the user's region. Names are compared loosely
 * ("Emilia-Romagna" vs "Emilia Romagna", "Valle d'Aosta/Vallée d'Aoste").
 *
 * @param {string} area the feed's areaDesc
 * @param {string} region the region name of the user's location
 * @returns {boolean}
 */
export function regionMatches(area, region) {
    let a = normalizeName(area);
    let r = normalizeName(region);
    if (!a || !r)
        return false;
    a = REGION_ALIASES[a] ?? a;
    r = REGION_ALIASES[r] ?? r;
    if (a === r)
        return true;
    // whole-word containment: "valle d aosta vallee d aoste" holds "valle d aosta"
    const [shorter, longer] = a.length <= r.length ? [a, r] : [r, a];
    return shorter.length >= 5 && ` ${longer} `.includes(` ${shorter} `);
}

/**
 * Summarises the Open-Meteo air quality "current" block.
 *
 * @param {object|null} current the current block of the air quality response
 * @returns {{aqi: number, level: string, text: string,
 *   pollen: {name: string, level: string, text: string}|null}|null}
 */
export function airInfo(current) {
    if (!current)
        return null;
    let aqi = current.european_aqi;
    let bands = EAQI_BANDS;
    if (!Number.isFinite(aqi)) {
        aqi = current.us_aqi;
        bands = USAQI_BANDS;
    }
    if (!Number.isFinite(aqi))
        return null;
    const level = bands.find(([max]) => aqi <= max)[1];
    const info = {aqi: Math.round(aqi), level, text: `${AIR_TEXT[level]()} · ${Math.round(aqi)}`, pollen: null};

    let best = null;
    let any = false;
    for (const [key, name, moderate, high] of POLLEN) {
        const v = current[key];
        if (!Number.isFinite(v))
            continue;
        any = true;
        const rank = v >= high ? 3 : v >= moderate ? 2 : v >= 1 ? 1 : 0;
        const score = rank + Math.min(0.99, v / high);
        if (!best || score > best.score)
            best = {name: name(), rank, score};
    }
    if (any) {
        if (!best || best.rank === 0) {
            info.pollen = {name: '', level: 'good', text: _('No pollen')};
        } else {
            const level = ['good', 'good', 'moderate', 'poor'][best.rank];
            const text = [null, _('Pollen %s · low'), _('Pollen %s · moderate'), _('Pollen %s · high')][best.rank];
            info.pollen = {name: best.name, level, text: fmt(text, best.name)};
        }
    }
    return info;
}

// ---- tip of the day ---------------------------------------------------

const isRainCode = c => (c >= 51 && c <= 67) || (c >= 80 && c <= 82);
const isSnowCode = c => (c >= 71 && c <= 77) || c === 85 || c === 86;
const isStormCode = c => c >= 95;
const isFogCode = c => c === 45 || c === 48;

/**
 * One line of practical advice built from the next hours.
 *
 * @param {object} params
 * @param {object} params.data the forecast (with hourly data)
 * @param {object|null} params.air result of airInfo()
 * @param {object|null} params.sun result of sunState()
 * @param {number} params.now unix seconds
 * @param {string} params.units "metric" or "imperial"
 * @returns {string}
 */
export function dailyAdvice({data, air, sun, now, units}) {
    const imperial = units === 'imperial';
    const off = data.utc_offset_seconds ?? 0;
    const h = data.hourly ?? {};
    const cur = data.current ?? {};
    const kmh = v => (imperial ? v * 1.609344 : v);
    const celsius = v => (imperial ? (v - 32) * 5 / 9 : v);
    const windText = v => `${Math.round(v)} ${imperial ? 'mph' : 'km/h'}`;
    const degrees = v => `${Math.round(v)}°`;

    const hours = (h.time ?? []).map((t, i) => {
        const time = localToUnix(t, off);
        return {
            time,
            label: clockLabel(time, data.timezone),
            prob: h.precipitation_probability?.[i] ?? 0,
            mm: h.precipitation?.[i] ?? 0,
            code: h.weather_code?.[i] ?? 0,
            uv: h.uv_index?.[i] ?? 0,
            wind: h.wind_speed_10m?.[i] ?? 0,
            temp: h.temperature_2m?.[i] ?? 0,
        };
    }).filter(x => x.time + HOUR > now);
    const soon = hours.slice(0, 12);
    const code = cur.weather_code ?? 0;
    const feels = celsius(cur.apparent_temperature ?? 15);

    if (isStormCode(code))
        return _('Thunderstorm: stay indoors if you can');
    if (isSnowCode(code))
        return _('Snowing: mind the roads');
    if (isRainCode(code) || (cur.precipitation ?? 0) >= 0.1)
        return _('Raining: take an umbrella if you go out');

    const storm = soon.find(x => isStormCode(x.code));
    if (storm)
        return fmt(_('Thunderstorms expected around %s'), storm.label);
    const snow = soon.find(x => isSnowCode(x.code) && x.prob >= 40);
    if (snow)
        return fmt(_('Snow expected around %s'), snow.label);
    const rain = soon.find(x => (x.prob >= 50 && x.mm >= 0.1) || (isRainCode(x.code) && x.prob >= 40));
    if (rain)
        return fmt(_('Umbrella: rain likely from %s'), rain.label);
    if (feels <= 0)
        return _('Freezing: bundle up');
    if (feels >= 32)
        return _('Heat: drink water and seek shade');
    if (isFogCode(code))
        return _('Fog: drive carefully');
    const windy = soon.find(x => kmh(x.wind) >= 40);
    if (windy)
        return fmt(_('Strong wind around %s (%s)'), windy.label, windText(windy.wind));
    const uvPeak = soon.reduce((best, x) => (x.uv > (best?.uv ?? 0) ? x : best), null);
    if (uvPeak && uvPeak.uv >= 6)
        return fmt(_('High UV around %s: sunscreen'), uvPeak.label);
    if (air && ['poor', 'very-poor', 'hazardous'].includes(air.level))
        return _('Poor air: avoid outdoor sports');
    if (air?.pollen?.level === 'poor')
        return fmt(_('High %s pollen today'), air.pollen.name);

    if (!sun || sun.isDay) {
        const sunset = sun?.end ?? now + 6 * HOUR;
        const daylight = sunset - now;
        const dryTillSunset = !hours.some(x => x.time < sunset && (x.prob >= 40 || x.mm >= 0.1));
        const humidity = cur.relative_humidity_2m ?? 100;
        if (sun && daylight >= 3 * HOUR && dryTillSunset && humidity < 65 &&
            kmh(cur.wind_speed_10m ?? 0) >= 6 && celsius(cur.temperature_2m ?? 0) >= 14)
            return fmt(_('Great for drying laundry until %s'), sun.sunsetLabel);
        if (code <= 2 && feels >= 15 && feels <= 27 && kmh(cur.wind_speed_10m ?? 0) < 25)
            return _('Perfect weather for a walk');
        return _('Calm day, no alerts');
    }
    if (code <= 1)
        return _('Clear night: look up at the stars');
    const night = hours.filter(x => x.time < sun.end).map(x => x.temp);
    if (night.length)
        return fmt(_('Quiet night, min %s'), degrees(Math.min(...night)));
    return _('Quiet night');
}

// ---- space weather and the ISS ---------------------------------------

/**
 * Describes geomagnetic activity for the chip in the sky section.
 *
 * @param {{kp: number|null, g: number}} space result of FeedClient.spaceWeather()
 * @returns {{level: string, text: string, aurora: boolean}|null}
 */
export function kpInfo(space) {
    if (!space || (space.kp === null && !space.g))
        return null;
    const g = space.g || (space.kp >= 5 ? Math.min(5, Math.floor(space.kp) - 4) : 0);
    const kp = space.kp === null ? '' : `Kp ${space.kp.toFixed(space.kp % 1 ? 1 : 0)} · `;
    if (g >= 4)
        return {level: 'hazardous', text: `${kp}${fmt(_('G%d severe storm · aurora'), g)}`, aurora: true};
    if (g >= 3)
        return {level: 'very-poor', text: `${kp}${_('G3 strong storm · aurora')}`, aurora: true};
    if (g >= 2)
        return {level: 'poor', text: `${kp}${_('G2 moderate storm')}`, aurora: true};
    if (g >= 1)
        return {level: 'moderate', text: `${kp}${_('G1 minor storm')}`, aurora: false};
    if (space.kp !== null && space.kp >= 4)
        return {level: 'fair', text: `${kp}${_('unsettled')}`, aurora: false};
    return {level: 'good', text: `${kp}${_('quiet')}`, aurora: false};
}

/**
 * Great-circle distance in km (duplicated from weather.js to keep this file
 * free of GNOME imports).
 */
function distance(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * How far the ISS is from the observer and whether it could be seen.
 *
 * @param {object} iss result of FeedClient.iss()
 * @param {number} latitude observer latitude
 * @param {number} longitude observer longitude
 * @param {boolean} observerDark whether it is night at the observer
 * @returns {{distanceKm: number, overhead: boolean, visible: boolean, text: string, level: string}}
 */
export function issInfo(iss, latitude, longitude, observerDark) {
    const distanceKm = distance(latitude, longitude, iss.latitude, iss.longitude);
    const overhead = distanceKm <= iss.footprint / 2;
    // visible to the eye when it is lit by the sun while the observer is in the dark
    const visible = overhead && iss.daylight && observerDark;
    let text;
    if (visible)
        text = _('ISS overhead now · look up!');
    else if (overhead)
        text = _('ISS overhead now');
    else if (distanceKm < 1000)
        text = fmt(_('ISS %s km away'), Math.round(distanceKm));
    else
        text = fmt(_('ISS %s km away'), `${(distanceKm / 1000).toFixed(1).replace(/\.0$/, '')}k`);
    return {distanceKm, overhead, visible, text, level: visible ? 'good' : overhead ? 'fair' : 'none'};
}
