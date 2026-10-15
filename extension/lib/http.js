// Tiny HTTP helpers shared by the weather and feed clients (libsoup 3).
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const decoder = new TextDecoder();

/**
 * An identifying User-Agent built from metadata.json (Nominatim's usage
 * policy asks for the application name and a way to contact its author).
 */
function userAgent() {
    try {
        const dir = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
        const [, bytes] = dir.get_child('metadata.json').load_contents(null);
        const meta = JSON.parse(decoder.decode(bytes));
        return `desktop-sysweather/${meta['version-name']} (GNOME Shell extension; +${meta.url})`;
    } catch {
        return 'desktop-sysweather (GNOME Shell extension)';
    }
}

const USER_AGENT = userAgent();

export function newSession() {
    return new Soup.Session({
        user_agent: USER_AGENT,
        timeout: 25,
    });
}

function buildUrl(url, params) {
    const query = Object.entries(params)
        .map(([k, v]) => `${k}=${GLib.Uri.escape_string(String(v), null, false)}`)
        .join('&');
    return query ? `${url}?${query}` : url;
}

/**
 * Performs a GET request and returns the body as text.
 *
 * @param {Soup.Session} session the session
 * @param {string} url the URL
 * @param {object} params query parameters
 * @param {Gio.Cancellable} cancellable cancels the request
 * @param {object} [options]
 * @param {number[]} [options.emptyStatuses] statuses that yield null instead of an error
 * @param {object} [options.headers] extra request headers
 * @returns {Promise<{status: number, text: string|null, headers: Soup.MessageHeaders}>}
 */
export async function getText(session, url, params, cancellable, options = {}) {
    const message = Soup.Message.new('GET', buildUrl(url, params));
    for (const [name, value] of Object.entries(options.headers ?? {}))
        message.get_request_headers().append(name, value);
    const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
    const status = message.get_status();
    const headers = message.get_response_headers();
    if (status === Soup.Status.NOT_MODIFIED || (options.emptyStatuses ?? []).includes(status))
        return {status, text: null, headers};
    if (status !== Soup.Status.OK)
        throw new Error(`HTTP ${status} from ${url}`);
    // get_data() is null for an empty body and TextDecoder rejects null
    const text = bytes.get_size() > 0 ? decoder.decode(bytes.get_data()) : '';
    return {status, text, headers};
}

/**
 * Performs a GET request and parses the JSON body.
 *
 * @param {Soup.Session} session the session
 * @param {string} url the URL
 * @param {object} params query parameters
 * @param {Gio.Cancellable} cancellable cancels the request
 * @param {number[]} [emptyStatuses] statuses that yield null instead of an error
 * @returns {Promise<any>}
 */
export async function getJson(session, url, params, cancellable, emptyStatuses = []) {
    const {text} = await getText(session, url, params, cancellable, {emptyStatuses});
    if (text === null)
        return null;
    if (text.trim() === '')
        throw new Error(`empty body from ${url}`);
    return JSON.parse(text);
}
