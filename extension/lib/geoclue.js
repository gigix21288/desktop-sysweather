// Precise location through the system location service (GeoClue 2), the
// same service GNOME uses for the weather in the calendar. It is loaded
// lazily so the extension still works where the GeoClue typelib is missing.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {distanceKm} from './weather.js';

const DESKTOP_ID = 'desktop-sysweather';
const LOCATION_SCHEMA = 'org.gnome.system.location';
// How long the first weather update waits for GeoClue. Later updates never
// wait: a fix that arrives afterwards is reported through onMoved and the
// caller refreshes, so there is no point in delaying the IP fallback again.
const FIX_TIMEOUT_SECONDS = 12;

/**
 * @returns {Gio.Settings|null} the GNOME "location services" settings, or
 *   null when the schema is not installed
 */
export function systemLocationSettings() {
    const schema = Gio.SettingsSchemaSource.get_default()?.lookup(LOCATION_SCHEMA, true);
    return schema ? new Gio.Settings({settings_schema: schema}) : null;
}

/**
 * Keeps one GeoClue client alive and reports its fixes.
 */
export class GeoclueLocator {
    /**
     * @param {Function} onMoved called with the new fix when the location
     *   changes by more than a couple of kilometres
     */
    constructor(onMoved) {
        this._onMoved = onMoved;
        this._simple = null;
        this._signalId = 0;
        this._pending = null;
        this._fix = null;
        this._unavailable = false;
        this._timedOut = false;
        this._cancellable = new Gio.Cancellable();
    }

    /** @returns {boolean} true once loading the GeoClue library has failed */
    get unavailable() {
        return this._unavailable;
    }

    /** @returns {{latitude: number, longitude: number, accuracy: number}|null} the last fix */
    get fix() {
        return this._fix;
    }

    _read(simple) {
        const location = simple.get_location();
        if (!location)
            return null;
        return {
            latitude: location.latitude,
            longitude: location.longitude,
            accuracy: location.accuracy, // metres, may be very large (IP fallback)
            description: location.description ?? '',
        };
    }

    async _connect() {
        let Geoclue;
        try {
            ({default: Geoclue} = await import('gi://Geoclue?version=2.0'));
        } catch (e) {
            this._unavailable = true;
            throw new Error(`GeoClue library not available: ${e.message}`);
        }
        const simple = await new Promise((resolve, reject) => {
            Geoclue.Simple.new(DESKTOP_ID, Geoclue.AccuracyLevel.EXACT, this._cancellable, (_o, res) => {
                try {
                    resolve(Geoclue.Simple.new_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
        if (this._cancellable.is_cancelled()) {
            // destroyed while connecting: do not leave a started client in geoclued
            try {
                simple.get_client()?.call_stop(null, null);
            } catch {
                // the daemon drops it anyway
            }
            throw new Error('cancelled');
        }
        const client = simple.get_client();
        if (client) {
            // only wake us up for real moves, and not more than every 10 min
            client.distance_threshold = 2000;
            try {
                client.time_threshold = 600;
            } catch {
                // older GeoClue
            }
        }
        this._simple = simple;
        this._fix = this._read(simple);
        this._signalId = simple.connect('notify::location', () => {
            const next = this._read(simple);
            if (!next)
                return;
            const moved = !this._fix ||
                distanceKm(this._fix.latitude, this._fix.longitude, next.latitude, next.longitude) > 2;
            this._fix = next;
            if (moved)
                this._onMoved?.(next);
        });
        if (!this._fix)
            throw new Error('GeoClue returned no location');
        return this._fix;
    }

    /**
     * The current fix, waiting a limited time for the first one. A fix that
     * arrives after the timeout is reported through onMoved.
     *
     * @param {Gio.Cancellable} cancellable cancels the wait (not the client)
     * @returns {Promise<object>} the fix
     */
    locate(cancellable) {
        if (this._fix)
            return Promise.resolve(this._fix);
        if (this._pending && this._timedOut) {
            // still connecting since the first attempt: the late fix will come
            // through onMoved, don't hold the caller up again
            const error = new Error('GeoClue has not answered yet');
            error.silent = true;
            return Promise.reject(error);
        }
        if (!this._pending) {
            this._pending = this._connect().catch(e => {
                this._pending = null;
                throw e;
            });
        }
        return new Promise((resolve, reject) => {
            let done = false;
            let cancelId = 0;
            const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, FIX_TIMEOUT_SECONDS, () => {
                if (!done) {
                    done = true;
                    this._timedOut = true;
                    if (cancelId)
                        cancellable.disconnect(cancelId);
                    reject(new Error(`no GeoClue fix within ${FIX_TIMEOUT_SECONDS} s`));
                }
                return GLib.SOURCE_REMOVE;
            });
            cancelId = cancellable?.connect(() => {
                if (!done) {
                    done = true;
                    GLib.source_remove(timeoutId);
                    reject(new Error('cancelled'));
                }
            }) ?? 0;
            const finish = () => {
                GLib.source_remove(timeoutId);
                if (cancelId)
                    cancellable.disconnect(cancelId);
            };
            this._pending.then(fix => {
                if (done) {
                    // late fix: the caller already fell back, let it refresh
                    this._onMoved?.(fix);
                    return;
                }
                done = true;
                finish();
                resolve(fix);
            }, e => {
                if (done)
                    return;
                done = true;
                finish();
                reject(e);
            });
        });
    }

    destroy() {
        this._cancellable.cancel();
        this._onMoved = null;
        if (this._simple) {
            if (this._signalId)
                this._simple.disconnect(this._signalId);
            try {
                this._simple.get_client()?.call_stop(null, null);
            } catch {
                // the daemon drops the client anyway when we go away
            }
        }
        this._simple = null;
        this._signalId = 0;
        this._fix = null;
        this._pending = null;
    }
}
