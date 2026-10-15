// Asynchronous file helpers shared by the monitors. GNOME Shell runs
// extensions on the compositor thread, so even the small reads from /proc
// and /sys go through Gio's asynchronous API and never hold a frame back.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');

const decoder = new TextDecoder();
const ENUMERATE_BATCH = 100;

/**
 * @param {string} path
 * @param {Gio.Cancellable} [cancellable]
 * @returns {Promise<Uint8Array|null>} the contents, null when unreadable
 */
export async function readBytes(path, cancellable = null) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        return bytes;
    } catch {
        return null;
    }
}

/**
 * @param {string} path
 * @param {Gio.Cancellable} [cancellable]
 * @param {object} [options]
 * @param {boolean} [options.trim] strip surrounding whitespace (sysfs values end with a newline)
 * @returns {Promise<string|null>} the text, null when unreadable
 */
export async function readFile(path, cancellable = null, {trim = false} = {}) {
    const bytes = await readBytes(path, cancellable);
    if (bytes === null)
        return null;
    const text = decoder.decode(bytes);
    return trim ? text.trim() : text;
}

/**
 * @param {string} path a directory
 * @param {Gio.Cancellable} [cancellable]
 * @returns {Promise<string[]>} the entry names, unsorted; empty when the directory is missing
 */
export async function listDir(path, cancellable = null) {
    const names = [];
    let enumerator = null;
    try {
        enumerator = await Gio.File.new_for_path(path).enumerate_children_async(
            'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        for (;;) {
            const infos = await enumerator.next_files_async(ENUMERATE_BATCH, GLib.PRIORITY_DEFAULT, cancellable);
            if (!infos.length)
                break;
            for (const info of infos)
                names.push(info.get_name());
        }
    } catch {
        // missing or unreadable directory
    } finally {
        try {
            await enumerator?.close_async(GLib.PRIORITY_DEFAULT, null);
        } catch {
            // already closed
        }
    }
    return names;
}

async function fileInfo(path, attributes, cancellable) {
    try {
        return await Gio.File.new_for_path(path).query_info_async(
            attributes, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
    } catch {
        return null;
    }
}

/**
 * @returns {Promise<number|null>} the modification time in unix seconds, null when missing
 */
export async function fileTime(path, cancellable = null) {
    const info = await fileInfo(path, 'time::modified', cancellable);
    return info?.get_attribute_uint64('time::modified') || null;
}

/**
 * @returns {Promise<number|null>} the id of the device holding the path (st_dev), null when missing
 */
export async function deviceOf(path, cancellable = null) {
    const info = await fileInfo(path, 'unix::device', cancellable);
    return info ? info.get_attribute_uint32('unix::device') : null;
}
