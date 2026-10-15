// Feeds for the technically minded, all free and without API keys: the
// public IP address (ipwho.is, ifconfig.co, ipify), the CISA catalogue of
// Known Exploited Vulnerabilities, the CERT-AGID news feed, NOAA space
// weather and the position of the International Space Station.
import {getJson, getText, newSession} from './http.js';

const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const CERT_AGID_URL = 'https://cert-agid.gov.it/feed/';
const NOAA_SCALES_URL = 'https://services.swpc.noaa.gov/products/noaa-scales.json';
const NOAA_KP_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
const ISS_URL = 'https://api.wheretheiss.at/v1/satellites/25544';
const METEOALARM_FEED_URL = 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-';
export const METEOALARM_URL = 'https://meteoalarm.org';
// ISO country code -> feed name, for the countries whose feed was verified
export const METEOALARM_COUNTRIES = {
    AT: 'austria', BA: 'bosnia-herzegovina', BE: 'belgium', BG: 'bulgaria', CH: 'switzerland',
    CY: 'cyprus', CZ: 'czechia', DE: 'germany', DK: 'denmark', EE: 'estonia', ES: 'spain',
    FI: 'finland', FR: 'france', GB: 'united-kingdom', GR: 'greece', HR: 'croatia',
    HU: 'hungary', IE: 'ireland', IL: 'israel', IS: 'iceland', IT: 'italy', LT: 'lithuania',
    LU: 'luxembourg', LV: 'latvia', MD: 'moldova', ME: 'montenegro', MT: 'malta',
    NL: 'netherlands', NO: 'norway', PL: 'poland', PT: 'portugal', RO: 'romania',
    RS: 'serbia', SE: 'sweden', SI: 'slovenia', SK: 'slovakia',
};
const KEV_RECENT = 5;
export const NVD_URL = 'https://nvd.nist.gov/vuln/detail/';
export const KEV_CATALOGUE_URL = 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog';
const WEEK = 7 * 86400 * 1000;

const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' '};

function decodeEntities(text) {
    // markup is stripped before the entities are decoded, so that an escaped
    // "&lt;b&gt;" in a title survives as literal text
    return text
        .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
        .trim();
}

/**
 * Pulls the items out of an RSS 2.0 document without an XML parser.
 *
 * @param {string} xml the feed
 * @param {number} limit how many items to return
 * @returns {Array<{title: string, link: string, time: number|null, summary: string}>}
 *   time in unix seconds; summary: the description without markup, cut to a few hundred characters
 */
export function parseRss(xml, limit) {
    const items = [];
    const tag = (block, name) => {
        const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
        return match ? decodeEntities(match[1]) : '';
    };
    for (const match of xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)) {
        const block = match[1];
        const date = tag(block, 'pubDate') || tag(block, 'dc:date');
        const parsed = Date.parse(date);
        const summary = tag(block, 'description').replace(/\s+/g, ' ');
        items.push({
            title: tag(block, 'title'),
            link: tag(block, 'link'),
            time: Number.isFinite(parsed) ? parsed / 1000 : null,
            summary: summary.length > 360 ? `${summary.slice(0, 357).trimEnd()}…` : summary,
        });
        if (items.length >= limit)
            break;
    }
    return items;
}

/**
 * Parses a MeteoAlarm Atom feed (one entry per warning and area).
 *
 * @param {string} xml the feed
 * @returns {Array<{id: string, area: string, code: string|null, event: string,
 *   severity: string, onset: number|null, expires: number|null, link: string}>}
 *   onset / expires in unix seconds; link opens the area on meteoalarm.org
 */
export function parseMeteoalarm(xml) {
    const warnings = [];
    const tag = (block, name) => {
        const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
        return match ? decodeEntities(match[1]) : '';
    };
    const time = text => {
        const parsed = Date.parse(text);
        return Number.isFinite(parsed) ? parsed / 1000 : null;
    };
    for (const match of xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/gi)) {
        const block = match[1];
        const geocode = block.match(/<cap:geocode>[\s\S]*?<value>([^<]+)<\/value>/i)?.[1]?.trim() ?? null;
        const area = tag(block, 'cap:areaDesc') || block.match(/<link title="([^"]*)" href="https:\/\/meteoalarm\.org\?geocode/i)?.[1] || '';
        const event = tag(block, 'cap:event');
        if (!area || !event)
            continue;
        // the current status of a warning is the only one worth showing
        if (/cancel/i.test(tag(block, 'cap:message_type')) || /test|exercise/i.test(tag(block, 'cap:status')))
            continue;
        warnings.push({
            id: tag(block, 'cap:identifier') || tag(block, 'id'),
            area: decodeEntities(area),
            code: geocode,
            event,
            severity: tag(block, 'cap:severity'),
            onset: time(tag(block, 'cap:onset') || tag(block, 'cap:effective')),
            expires: time(tag(block, 'cap:expires')),
            link: geocode ? `${METEOALARM_URL}?geocode=EMMA_ID:${geocode}` : METEOALARM_URL,
        });
    }
    return warnings;
}

export class FeedClient {
    constructor() {
        this._session = newSession();
        this._kevModified = null;
        this._kevList = null;
        this._kevReleased = null;
    }

    /** The summary shown by the widget, recomputed so the "this week" count decays. */
    _kevSummary() {
        const list = this._kevList;
        const since = Date.now() - WEEK;
        return {
            recent: list.slice(0, KEV_RECENT),
            week: list.filter(v => v.date * 1000 >= since).length,
            total: list.length,
            released: this._kevReleased,
        };
    }

    /**
     * The public IP address and who it belongs to.
     *
     * @param {Gio.Cancellable} cancellable cancels the requests
     * @returns {Promise<{ip: string, org: string|null, country: string|null}>}
     */
    async publicIp(cancellable) {
        try {
            const data = await getJson(this._session, 'https://ipwho.is/', {}, cancellable);
            if (data?.success && data.ip) {
                return {
                    ip: data.ip,
                    org: data.connection?.isp || data.connection?.org || null,
                    country: data.country_code || null,
                };
            }
        } catch (e) {
            if (cancellable?.is_cancelled())
                throw e;
        }
        try {
            const data = await getJson(this._session, 'https://ifconfig.co/json', {}, cancellable);
            if (data?.ip)
                return {ip: data.ip, org: data.asn_org || null, country: data.country_iso || null};
        } catch (e) {
            if (cancellable?.is_cancelled())
                throw e;
        }
        const data = await getJson(this._session, 'https://api.ipify.org', {format: 'json'}, cancellable);
        if (!data?.ip)
            throw new Error('no public IP service answered');
        return {ip: data.ip, org: null, country: null};
    }

    /**
     * The newest entries of the CISA Known Exploited Vulnerabilities
     * catalogue. The catalogue is only downloaded again when it changed.
     *
     * @param {Gio.Cancellable} cancellable cancels the request
     * @returns {Promise<{recent: object[], week: number, total: number, released: number}>}
     *   recent: newest first, {id, vendor, product, name, date (unix seconds), ransomware,
     *   description, action, due (unix seconds or null), link}
     */
    async knownExploited(cancellable) {
        const headers = this._kevModified ? {'If-Modified-Since': this._kevModified} : {};
        const {text, headers: response} = await getText(this._session, KEV_URL, {}, cancellable, {headers});
        if (text === null && this._kevList)
            return this._kevSummary();
        if (text === null)
            throw new Error('empty KEV catalogue');
        const data = JSON.parse(text);
        const list = (data.vulnerabilities ?? []).map(v => ({
            id: v.cveID,
            vendor: v.vendorProject ?? '',
            product: v.product ?? '',
            name: v.vulnerabilityName ?? '',
            date: Date.parse(`${v.dateAdded}T12:00:00Z`) / 1000,
            ransomware: /^known$/i.test(v.knownRansomwareCampaignUse ?? ''),
            description: (v.shortDescription ?? '').trim(),
            action: (v.requiredAction ?? '').trim(),
            due: Date.parse(`${v.dueDate}T12:00:00Z`) / 1000 || null,
            link: `${NVD_URL}${v.cveID}`,
        })).filter(v => Number.isFinite(v.date));
        list.sort((a, b) => b.date - a.date);
        this._kevList = list;
        this._kevReleased = Date.parse(data.dateReleased ?? '') / 1000 || Date.now() / 1000;
        this._kevModified = response.get_one('Last-Modified');
        return this._kevSummary();
    }

    /**
     * The latest CERT-AGID (Italian government CSIRT) news items.
     *
     * @param {Gio.Cancellable} cancellable cancels the request
     * @returns {Promise<Array<{title: string, link: string, time: number|null}>>}
     */
    async certAgid(cancellable) {
        const {text} = await getText(this._session, CERT_AGID_URL, {}, cancellable);
        return parseRss(text ?? '', 3);
    }

    /**
     * The weather warnings in force in a country, from the national
     * weather service through MeteoAlarm. Expired warnings are dropped.
     *
     * @param {string} country ISO 3166-1 alpha-2 code
     * @param {Gio.Cancellable} cancellable cancels the request
     * @returns {Promise<object[]|null>} see parseMeteoalarm(); null when the
     *   country has no MeteoAlarm feed
     */
    async weatherWarnings(country, cancellable) {
        const feed = METEOALARM_COUNTRIES[(country ?? '').toUpperCase()];
        if (!feed)
            return null;
        const {text} = await getText(this._session, `${METEOALARM_FEED_URL}${feed}`, {}, cancellable);
        const now = Date.now() / 1000;
        return parseMeteoalarm(text ?? '').filter(w => w.expires === null || w.expires > now);
    }

    /**
     * Current geomagnetic activity from NOAA SWPC.
     *
     * @param {Gio.Cancellable} cancellable cancels the requests
     * @returns {Promise<{kp: number|null, g: number, r: number, s: number, time: number|null}>}
     */
    async spaceWeather(cancellable) {
        const [scales, kpList] = await Promise.all([
            getJson(this._session, NOAA_SCALES_URL, {}, cancellable).catch(() => null),
            getJson(this._session, NOAA_KP_URL, {}, cancellable).catch(() => null),
        ]);
        const now = scales?.['0'] ?? {};
        const scale = s => Number(s?.Scale) || 0;
        const latest = Array.isArray(kpList) ? kpList[kpList.length - 1] : null;
        const kp = Number(latest?.Kp);
        if (!scales && !latest)
            throw new Error('NOAA space weather unavailable');
        const time = latest?.time_tag ? Date.parse(`${latest.time_tag}Z`) / 1000 : null;
        return {kp: Number.isFinite(kp) ? kp : null, g: scale(now.G), r: scale(now.R), s: scale(now.S), time};
    }

    /**
     * Where the ISS is right now.
     *
     * @param {Gio.Cancellable} cancellable cancels the request
     * @returns {Promise<{latitude: number, longitude: number, altitude: number,
     *   footprint: number, daylight: boolean, time: number}>} distances in km
     */
    async iss(cancellable) {
        const data = await getJson(this._session, ISS_URL, {units: 'kilometers'}, cancellable);
        if (!Number.isFinite(data?.latitude))
            throw new Error('ISS position unavailable');
        return {
            latitude: data.latitude,
            longitude: data.longitude,
            altitude: data.altitude,
            footprint: data.footprint,
            daylight: data.visibility === 'daylight',
            time: data.timestamp,
        };
    }

    destroy() {
        this._session.abort();
        this._session = null;
    }
}
