// Shared gettext helpers, usable both inside GNOME Shell and in the
// preferences process. By default the text domain bound by
// initTranslations() follows the system locale; setLanguage() can force
// one of the shipped languages instead, reading the .mo catalogue directly
// (gettext itself cannot switch language per domain at run time).
import GLib from 'gi://GLib';
import Gettext from 'gettext';

const DOMAIN = 'desktop-sysweather';
// the language of the source strings
const SOURCE_LANGUAGE = 'en';

// null = system locale through gettext; otherwise {language, catalog, plural}
let override = null;

/**
 * Parses a GNU .mo catalogue.
 *
 * @param {Uint8Array} bytes the file content
 * @returns {Map<string, string>} msgid (with "\0" + plural for plural
 *   entries) -> translation (forms joined by "\0")
 */
export function parseMo(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = view.getUint32(0, true);
    const little = magic === 0x950412de;
    if (!little && magic !== 0xde120495)
        throw new Error('not a .mo catalogue');
    const u32 = offset => view.getUint32(offset, little);
    const count = u32(8);
    const originals = u32(12);
    const translations = u32(16);
    const decoder = new TextDecoder();
    const read = (table, i) => decoder.decode(bytes.subarray(u32(table + i * 8 + 4), u32(table + i * 8 + 4) + u32(table + i * 8)));
    const catalog = new Map();
    for (let i = 0; i < count; i++)
        catalog.set(read(originals, i), read(translations, i));
    return catalog;
}

/**
 * The plural rule of a catalogue, from its "Plural-Forms" header. Only the
 * common rules are understood; anything else falls back to "n != 1".
 *
 * @param {string} header the translation of the empty msgid
 * @returns {Function} n -> index of the form
 */
export function pluralRule(header) {
    const expr = (header.match(/plural\s*=\s*([^;\n]+)/)?.[1] ?? '').replace(/\s+/g, '');
    if (expr === '0')
        return () => 0;
    if (expr === '(n>1)' || expr === 'n>1')
        return n => (n > 1 ? 1 : 0);
    return n => (n !== 1 ? 1 : 0);
}

/**
 * Forces the language of every string, or goes back to the system locale.
 *
 * @param {string} language "auto" (system), "en" or a shipped language code
 * @param {string} [localeDir] the extension's locale directory
 */
export function setLanguage(language, localeDir = null) {
    if (!language || language === 'auto') {
        override = null;
        return;
    }
    const catalog = new Map();
    let plural = n => (n !== 1 ? 1 : 0);
    if (language !== SOURCE_LANGUAGE && localeDir) {
        try {
            const [ok, bytes] = GLib.file_get_contents(`${localeDir}/${language}/LC_MESSAGES/${DOMAIN}.mo`);
            if (ok) {
                for (const [id, text] of parseMo(bytes))
                    catalog.set(id, text);
                plural = pluralRule(catalog.get('') ?? '');
            }
        } catch (e) {
            console.warn(`[desktop-sysweather] cannot load the ${language} catalogue: ${e.message ?? e}`);
        }
    }
    override = {language, catalog, plural};
}

/**
 * The languages that can be chosen: the source language plus every
 * catalogue shipped in the locale directory.
 *
 * @param {string} localeDir the extension's locale directory
 * @returns {string[]} language codes, the source language first
 */
export function availableLanguages(localeDir) {
    const languages = [SOURCE_LANGUAGE];
    try {
        const dir = GLib.Dir.open(localeDir, 0);
        let name;
        while ((name = dir.read_name()) !== null) {
            if (name !== SOURCE_LANGUAGE && GLib.file_test(`${localeDir}/${name}/LC_MESSAGES/${DOMAIN}.mo`, GLib.FileTest.EXISTS))
                languages.push(name);
        }
        dir.close();
    } catch {
        // no translations shipped
    }
    return languages;
}

/**
 * A language name in its own language ("italiano", "English").
 *
 * @param {string} language a language code
 * @returns {string}
 */
export function languageName(language) {
    try {
        const name = new Intl.DisplayNames([language], {type: 'language'}).of(language);
        if (name && name !== language)
            return name.charAt(0).toUpperCase() + name.slice(1);
    } catch {
        // Intl.DisplayNames missing or unknown code
    }
    return language;
}

function systemLocale() {
    const name = GLib.get_language_names().find(l => /^[a-z]{2}/.test(l) && l !== 'C') ?? 'en';
    // "it_IT.UTF-8" -> "it-IT"
    return name.split('.')[0].split('@')[0].replace('_', '-');
}

/** @returns {string} the two-letter language of the texts, e.g. "it" */
export function uiLanguage() {
    return (override?.language ?? systemLocale()).slice(0, 2);
}

/** @returns {string} a BCP 47 locale for Intl formatting, e.g. "it-IT" */
export function uiLocale() {
    return override?.language ?? systemLocale();
}

export const _ = msgid => {
    if (!override)
        return Gettext.dgettext(DOMAIN, msgid);
    return override.catalog.get(msgid) || msgid;
};

/**
 * Plural-aware translation: picks the singular or plural form for n.
 *
 * @param {string} singular the English singular (with %d)
 * @param {string} plural the English plural
 * @param {number} n the count
 * @returns {string} the translated format string, to be passed to fmt()
 */
export const ngettext = (singular, plural, n) => {
    if (!override)
        return Gettext.dngettext(DOMAIN, singular, plural, n);
    const forms = override.catalog.get(`${singular}\0${plural}`)?.split('\0');
    if (!forms?.length)
        return n === 1 ? singular : plural;
    return forms[override.plural(n)] ?? forms[0];
};

/**
 * Minimal printf-style formatter: replaces each %s / %d in order.
 *
 * @param {string} format the (translated) format string
 * @param {...any} args the values
 * @returns {string}
 */
export function fmt(format, ...args) {
    let i = 0;
    return format.replace(/%[sd%]/g, m => (m === '%%' ? '%' : String(args[i++])));
}

/** Translates a plural string and formats it with the count: nfmt('%d update', '%d updates', n). */
export const nfmt = (singular, plural, n, ...args) => fmt(ngettext(singular, plural, n), n, ...args);
