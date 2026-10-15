import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PointerWatcher from 'resource:///org/gnome/shell/ui/pointerWatcher.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {_, fmt, nfmt, setLanguage} from './lib/i18n.js';
import {FeedClient} from './lib/feeds.js';
import {GeoclueLocator, systemLocationSettings} from './lib/geoclue.js';
import {NetworkMonitor} from './lib/network.js';
import {SecurityMonitor} from './lib/security.js';
import {dateLabel, regionMatches, setClockFormat, warningInfo} from './lib/sky.js';
import {GpuMonitor, ProcessMonitor, SystemMonitor} from './lib/system.js';
import {WeatherClient} from './lib/weather.js';
import {DesktopWidget} from './lib/widget.js';

const WEATHER_RETRY_SECONDS = [15, 60, 120, 300];
const WARNINGS_INTERVAL_SECONDS = 30 * 60;
// new failed logins between two security checks that trigger a notification
const LOGIN_SPIKE = 5;
const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';
const POINTER_POLL_MS = 120;
const GEAR_FADE_MS = 150;
const POPUP_FADE_MS = 120;
const POPUP_GAP = 6;
// pointer polls over the same chip before its popup opens (~250 ms)
const POPUP_HOVER_POLLS = 2;
const AUTO_LOCATION_TTL_US = 3 * 3600 * 1e6;
const TICK_SECONDS = 60;
const PROCESS_EVERY_SAMPLES = 3;
const FEED_RETRY_SECONDS = 300;
const SPACE_INTERVAL_SECONDS = 30 * 60;
const ISS_INTERVAL_SECONDS = 120;
const PUBLIC_IP_DEBOUNCE_SECONDS = 6;

const APPEARANCE_KEYS = ['theme', 'background-opacity', 'scale', 'sky-background', 'columns'];
const SECTION_KEYS = [
    'show-header', 'show-weather', 'show-forecast', 'show-hourly', 'show-system', 'show-details',
    'show-rain', 'show-sun', 'show-air', 'show-advice', 'show-quakes', 'show-clock',
    'show-processes', 'show-network', 'show-ports', 'show-latency', 'show-security',
    'show-feeds', 'show-cert-agid', 'show-space', 'show-alerts',
];
const WEATHER_KEYS = ['location-mode', 'city-name', 'city-region', 'city-country', 'latitude', 'longitude', 'units'];
const QUAKE_KEYS = ['quake-min-magnitude', 'quake-radius'];
const TIMER_NAMES = [
    '_systemSourceId', '_weatherSourceId', '_repositionId', '_tickSourceId',
    '_networkSourceId', '_publicIpSourceId', '_securitySourceId', '_feedsSourceId',
    '_spaceSourceId', '_issSourceId', '_quakeSourceId', '_warningsSourceId',
];

export default class DesktopSysWeatherExtension extends Extension {
    enable() {
        this.initTranslations();
        this._settings = this.getSettings();
        // a chosen language overrides the system locale for every label
        setLanguage(this._settings.get_string('language'), `${this.path}/locale`);
        this._cancellable = new Gio.Cancellable();
        this._monitor = new SystemMonitor();
        this._processMonitor = new ProcessMonitor();
        this._gpuMonitor = new GpuMonitor();
        this._gpuSampling = false;
        this._networkMonitor = new NetworkMonitor();
        this._securityMonitor = new SecurityMonitor();
        this._weatherClient = new WeatherClient();
        this._feeds = new FeedClient();
        this._sampleCount = 0;
        this._processing = false;
        this._networking = false;
        this._securing = false;
        this._lastVpn = undefined;
        this._lastVpnName = null;
        this._lastPublicIp = null;
        this._publicIpRequest = 0;
        this._geoclue = new GeoclueLocator(fix => this._onSystemLocationMoved(fix));
        this._locationSettings = systemLocationSettings();
        this._placeNames = new Map();
        this._autoLocation = null;
        this._lastLocation = null;
        this._weatherOk = false;
        this._weatherFailures = 0;
        this._weatherRequest = 0;
        this._quakeRequest = 0;
        this._warningsRequest = 0;
        this._notifiedWarnings = new Set();
        this._lastLoginCount = undefined;
        this._sampling = false;
        this._lastSample = null;
        // the 12/24 hour clock follows the GNOME setting
        const interfaceSchema = Gio.SettingsSchemaSource.get_default()?.lookup(INTERFACE_SCHEMA, true);
        this._interfaceSettings = interfaceSchema ? new Gio.Settings({settings_schema: interfaceSchema}) : null;
        this._applyClockFormat();

        this._widget = new DesktopWidget();
        // The background group sits below every window (including the desktop
        // icons window), so the card behaves like part of the wallpaper.
        Main.layoutManager._backgroundGroup.add_child(this._widget);
        this._buildGear();
        this._buildPopup();

        this._signals = [
            [this._settings, this._settings.connect('changed', (_s, key) => this._onSettingChanged(key))],
            [this._widget, this._widget.connect('notify::width', () => this._queueReposition())],
            [this._widget, this._widget.connect('notify::height', () => this._queueReposition())],
            [global.display, global.display.connect('workareas-changed', () => this._queueReposition())],
            [Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => this._queueReposition())],
            [Gio.NetworkMonitor.get_default(), Gio.NetworkMonitor.get_default().connect(
                'network-changed', (_m, available) => {
                    if (available && !this._weatherOk)
                        this._scheduleWeather(5);
                    // a new network usually means a new public address
                    this._schedulePublicIp(PUBLIC_IP_DEBOUNCE_SECONDS);
                    if (available && !this._feedsOk)
                        this._scheduleFeeds(10);
                })],
        ];
        if (this._locationSettings) {
            this._signals.push([this._locationSettings, this._locationSettings.connect(
                'changed::enabled', () => this._onLocationServicesChanged())]);
        }
        if (this._interfaceSettings) {
            this._signals.push([this._interfaceSettings, this._interfaceSettings.connect(
                'changed::clock-format', () => {
                    this._applyClockFormat();
                    this._widget?.tick();
                })]);
        }

        this._applyAppearance();
        this._applySections();
        this._restartSystemTimer();
        this._restartNetworkTimer();
        this._restartSecurityTimer();
        this._tickSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
            this._widget?.tick();
            return GLib.SOURCE_CONTINUE;
        });
        this._refreshWeather();
        this._schedulePublicIp(2);
        this._scheduleFeeds(4);
        this._scheduleSpace(6);
        this._scheduleIss(8);
    }

    disable() {
        this._cancellable.cancel();
        this._cancellable = null;

        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = null;

        this._pointerWatch?.remove();
        this._pointerWatch = null;
        this._gear.destroy();
        this._gear = null;
        this._popup.destroy();
        this._popup = null;
        this._hotspot.destroy();
        this._hotspot = null;

        for (const name of TIMER_NAMES) {
            if (this[name]) {
                GLib.source_remove(this[name]);
                this[name] = 0;
            }
        }

        this._widget.destroy();
        this._widget = null;
        this._weatherClient.destroy();
        this._weatherClient = null;
        this._feeds.destroy();
        this._feeds = null;
        this._processMonitor = null;
        this._gpuMonitor = null;
        this._networkMonitor = null;
        this._securityMonitor = null;
        this._geoclue.destroy();
        this._geoclue = null;
        this._locationSettings = null;
        this._interfaceSettings = null;
        this._notifiedWarnings = null;
        this._placeNames = null;
        this._monitor = null;
        this._settings = null;
        this._autoLocation = null;
        this._lastLocation = null;
        this._lastSample = null;
    }

    _onSettingChanged(key) {
        if (key === 'language') {
            // every static label is built when the card is created: the
            // cheapest way to re-translate everything is a restart, deferred
            // out of the signal handler that disable() disconnects
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (this._settings) {
                    this.disable();
                    this.enable();
                }
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        if (APPEARANCE_KEYS.includes(key)) {
            this._applyAppearance();
        } else if (SECTION_KEYS.includes(key)) {
            this._applySections();
            if (key === 'show-quakes')
                this._scheduleQuakes(1);
            else if (key === 'show-air' || key === 'show-advice')
                this._refreshAirIfNeeded();
            else if (key === 'show-network' || key === 'show-ports' || key === 'show-latency')
                this._restartNetworkTimer();
            else if (key === 'show-security')
                this._restartSecurityTimer();
            else if (key === 'show-processes' && this._settings.get_boolean('show-processes'))
                this._refreshProcesses();
            else if (key === 'show-feeds' || key === 'show-cert-agid')
                this._scheduleFeeds(1);
            else if (key === 'show-space')
                this._scheduleSpace(1);
            else if (key === 'show-alerts' || key === 'show-weather')
                this._scheduleWarnings(1);
        } else if (key === 'position' || key === 'margin' || key === 'monitor') {
            this._queueReposition();
        } else if (key === 'refresh-interval') {
            this._restartSystemTimer();
        } else if (key === 'network-interval' || key === 'latency-host') {
            this._restartNetworkTimer();
        } else if (key === 'public-ip-interval') {
            this._schedulePublicIp(1);
        } else if (key === 'mask-public-ip') {
            this._widget.setPublicIp(this._widget.publicIp, this._settings.get_boolean('mask-public-ip'));
        } else if (key === 'security-interval') {
            this._restartSecurityTimer();
        } else if (key === 'feeds-interval') {
            this._scheduleFeeds(1);
        } else if (key === 'weather-interval') {
            if (this._weatherOk)
                this._scheduleWeather(this._settings.get_int('weather-interval') * 60);
        } else if (QUAKE_KEYS.includes(key)) {
            // a spin button writes the key at every step: coalesce the requests
            this._scheduleQuakes(1);
        } else if (WEATHER_KEYS.includes(key)) {
            if (key === 'units' && this._lastSample)
                this._widget.setSystem(this._monitor, this._lastSample, this._settings.get_string('units'));
            // the forecast on screen no longer matches: don't show stale data
            this._weatherOk = false;
            this._weatherFailures = 0;
            this._widget.setWeatherMessage(_('Loading weather…'));
            // several keys change together when a city is picked: coalesce
            this._scheduleWeather(1);
        }
    }

    _applyClockFormat() {
        setClockFormat(this._interfaceSettings?.get_string('clock-format') ?? '24h');
    }

    _applyAppearance() {
        const theme = this._settings.get_string('theme');
        const scale = this._settings.get_int('scale');
        this._widget.setAppearance({
            theme,
            opacity: this._settings.get_int('background-opacity'),
            scale,
            sky: this._settings.get_boolean('sky-background'),
            columns: this._settings.get_int('columns'),
        });
        const gearTheme = ['light', 'terminal', 'amber'].includes(theme) ? theme : 'dark';
        this._gear.style_class = `sw-gear sw-${gearTheme}`;
        this._gear.set_style(`font-size: ${(10.5 * scale / 100).toFixed(2)}pt;`);
        this._popup.style_class = `sw-popup sw-${gearTheme}`;
        this._popup.set_style(`font-size: ${(10.5 * scale / 100).toFixed(2)}pt;`);
        this._hotspot.style_class = `sw-hotspot sw-${gearTheme}`;
        this._hideGear();
        this._hidePopup();
    }

    // ---- settings button -------------------------------------------------
    //
    // The card lives in the background layer, where it never receives input:
    // on Zorin OS / Ubuntu the desktop icons program owns a full screen window
    // on top of it. The clickable gear is therefore a separate actor above the
    // windows, shown only while the pointer is over the card and no window
    // covers that spot, and placed exactly over the gear drawn in the card.

    _buildGear() {
        this._gear = new St.Button({
            style_class: 'sw-gear sw-dark',
            accessible_name: _('Preferences'),
            track_hover: true,
            can_focus: false,
            visible: false,
            opacity: 0,
        });
        this._gear.set_child(new St.Icon({
            style_class: 'sw-gear-icon',
            icon_name: 'emblem-system-symbolic',
        }));
        this._gear.connect('clicked', () => {
            this._hideGear();
            // openPreferences() is asynchronous: a failure (e.g. the dialog is
            // already open) must not surface as an unhandled rejection
            try {
                Promise.resolve(this.openPreferences()).catch(e =>
                    console.warn(`[desktop-sysweather] cannot open the preferences: ${e.message ?? e}`));
            } catch (e) {
                console.warn(`[desktop-sysweather] cannot open the preferences: ${e.message ?? e}`);
            }
        });
        Main.layoutManager.addTopChrome(this._gear, {affectsStruts: false, trackFullscreen: false});
        this._gearShown = false;
        this._pointerWatch = PointerWatcher.getPointerWatcher().addWatch(
            POINTER_POLL_MS, (x, y) => this._onPointerMoved(x, y));
    }

    _onPointerMoved(x, y) {
        if (!this._widget?.mapped || Main.overview.visible || Main.sessionMode.isLocked) {
            this._hideGear();
            this._hidePopup();
            return;
        }
        const [wx, wy] = this._widget.get_transformed_position();
        const inside = x >= wx && x < wx + this._widget.width && y >= wy && y < wy + this._widget.height;
        if (!inside || this._isCovered(x, y)) {
            this._hideGear();
            this._hidePopup();
            return;
        }
        this._updateGear();
        this._updatePopup(x, y);
    }

    _updateGear() {
        const [cx, cy] = this._placeGear();
        if (this._isCovered(cx, cy)) {
            this._hideGear();
            return;
        }
        if (this._gearShown)
            return;
        this._gearShown = true;
        this._gear.show();
        this._gear.ease({opacity: 255, duration: GEAR_FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    /**
     * Moves the button over the gear drawn in the card.
     *
     * @returns {[number, number]} the center of the button, in stage coordinates
     */
    _placeGear() {
        const [, , width, height] = this._gear.get_preferred_size();
        const rect = this._widget.gearRect();
        let cx, cy;
        if (rect) {
            cx = rect.x + rect.width / 2;
            cy = rect.y + rect.height / 2;
        } else {
            const corner = this._widget.contentCorner();
            cx = corner.x - width / 2;
            cy = corner.y + height / 2;
        }
        this._gear.set_position(Math.round(cx - width / 2), Math.round(cy - height / 2));
        return [cx, cy];
    }

    _hideGear() {
        if (!this._gear || !this._gearShown)
            return;
        this._gearShown = false;
        this._gear.ease({
            opacity: 0,
            duration: GEAR_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!this._gearShown)
                    this._gear?.hide();
            },
        });
    }

    // ---- hover details ---------------------------------------------------
    //
    // Like the gear, the popup with the details of a security chip or a feed
    // row cannot be a tooltip of the card (which never receives input): it is
    // a top chrome actor placed next to the chip while the pointer rests on
    // it. A second, translucent actor highlights the chip itself and, for the
    // rows that have a web page, takes the click.

    _buildPopup() {
        this._popup = new St.Widget({
            style_class: 'sw-popup sw-dark',
            layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.VERTICAL}),
            reactive: false,
            visible: false,
            opacity: 0,
        });
        this._popupTitle = new St.Label({style_class: 'sw-popup-title'});
        this._popupBody = new St.Label({style_class: 'sw-popup-body'});
        this._popupHint = new St.Label({style_class: 'sw-popup-hint', visible: false});
        for (const l of [this._popupTitle, this._popupBody]) {
            l.clutter_text.line_wrap = true;
            l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        }
        this._popup.add_child(this._popupTitle);
        this._popup.add_child(this._popupBody);
        this._popup.add_child(this._popupHint);
        Main.layoutManager.addTopChrome(this._popup, {affectsStruts: false, trackFullscreen: false});

        this._hotspot = new St.Button({
            style_class: 'sw-hotspot sw-dark',
            can_focus: false,
            track_hover: false,
            visible: false,
        });
        this._hotspot.connect('clicked', () => {
            const link = this._popupLink;
            this._hidePopup();
            if (link)
                this._openLink(link);
        });
        Main.layoutManager.addTopChrome(this._hotspot, {affectsStruts: false, trackFullscreen: false});

        this._popupActor = null;
        this._popupLink = null;
        this._popupCandidate = null;
        this._popupPolls = 0;
    }

    _updatePopup(x, y) {
        if (!this._settings.get_boolean('hover-details')) {
            this._hidePopup();
            return;
        }
        const hit = this._widget.hotspotAt(x, y);
        if (!hit) {
            this._hidePopup();
            return;
        }
        if (hit.actor === this._popupActor)
            return;
        if (hit.actor !== this._popupCandidate) {
            this._popupCandidate = hit.actor;
            this._popupPolls = 0;
        }
        if (++this._popupPolls < POPUP_HOVER_POLLS)
            return;
        this._showPopup(hit);
    }

    _showPopup(hit) {
        this._popupActor = hit.actor;
        this._popupLink = hit.link ?? null;
        this._popupTitle.text = hit.title;
        this._popupBody.text = hit.body;
        this._popupBody.visible = Boolean(hit.body);
        this._popupHint.visible = Boolean(hit.link);
        this._popupHint.text = _('Click to open in the browser');

        const {rect} = hit;
        this._hotspot.set_position(Math.round(rect.x), Math.round(rect.y));
        this._hotspot.set_size(Math.round(rect.width), Math.round(rect.height));
        this._hotspot.reactive = Boolean(hit.link);
        if (hit.link)
            this._hotspot.add_style_class_name('sw-link');
        else
            this._hotspot.remove_style_class_name('sw-link');
        this._hotspot.show();

        // below the chip, aligned to its left edge, kept on the monitor
        const monitor = Main.layoutManager.findMonitorForActor(this._widget) ?? Main.layoutManager.primaryMonitor;
        const [, , width, height] = this._popup.get_preferred_size();
        let px = rect.x;
        let py = rect.y + rect.height + POPUP_GAP;
        if (monitor) {
            if (px + width > monitor.x + monitor.width - POPUP_GAP)
                px = monitor.x + monitor.width - POPUP_GAP - width;
            px = Math.max(monitor.x + POPUP_GAP, px);
            if (py + height > monitor.y + monitor.height - POPUP_GAP)
                py = rect.y - POPUP_GAP - height;
            py = Math.max(monitor.y + POPUP_GAP, py);
        }
        this._popup.set_position(Math.round(px), Math.round(py));
        this._popup.show();
        this._popup.ease({opacity: 255, duration: POPUP_FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _hidePopup() {
        this._popupCandidate = null;
        this._popupPolls = 0;
        if (!this._popup || !this._popupActor)
            return;
        this._popupActor = null;
        this._popupLink = null;
        this._hotspot.hide();
        this._hotspot.reactive = false;
        this._popup.ease({
            opacity: 0,
            duration: POPUP_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!this._popupActor)
                    this._popup?.hide();
            },
        });
    }

    _openLink(uri) {
        try {
            Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
        } catch (e) {
            console.warn(`[desktop-sysweather] cannot open ${uri}: ${e.message ?? e}`);
        }
    }

    /**
     * Whether a regular window is drawn over the given point. Windows that
     * behave like the desktop (the desktop icons window, type DESKTOP windows)
     * do not count.
     *
     * @param {number} x stage x
     * @param {number} y stage y
     * @returns {boolean}
     */
    _isCovered(x, y) {
        const workspace = global.workspace_manager.get_active_workspace();
        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (!win || !actor.visible || win.minimized || !win.located_on_workspace(workspace))
                continue;
            const frame = win.get_frame_rect();
            if (x < frame.x || x >= frame.x + frame.width || y < frame.y || y >= frame.y + frame.height)
                continue;
            if (!this._isDesktopWindow(win, frame))
                return true;
        }
        return false;
    }

    _isDesktopWindow(win, frame) {
        if (win.window_type === Meta.WindowType.DESKTOP)
            return true;
        // Desktop icons (DING, also shipped by Zorin OS) is a plain GTK window
        // kept at the bottom of the stack.
        if (win.get_gtk_application_id() === 'com.rastersoft.ding' ||
            (win.get_title() ?? '').startsWith('Desktop Icons'))
            return true;
        // Other desktop-like programs: hidden from the task bar and as large
        // as the whole work area.
        if (!win.skip_taskbar)
            return false;
        const area = Main.layoutManager.getWorkAreaForMonitor(win.get_monitor());
        return frame.x <= area.x && frame.y <= area.y &&
            frame.x + frame.width >= area.x + area.width &&
            frame.y + frame.height >= area.y + area.height;
    }

    _applySections() {
        const s = this._settings;
        this._widget.setSections({
            header: s.get_boolean('show-header'),
            weather: s.get_boolean('show-weather'),
            forecast: s.get_boolean('show-forecast'),
            hourly: s.get_boolean('show-hourly'),
            rain: s.get_boolean('show-rain'),
            sun: s.get_boolean('show-sun'),
            air: s.get_boolean('show-air'),
            advice: s.get_boolean('show-advice'),
            quakes: s.get_boolean('show-quakes'),
            system: s.get_boolean('show-system'),
            details: s.get_boolean('show-details'),
            clock: s.get_boolean('show-clock'),
            processes: s.get_boolean('show-processes'),
            network: s.get_boolean('show-network'),
            ports: s.get_boolean('show-ports'),
            latency: s.get_boolean('show-latency'),
            security: s.get_boolean('show-security'),
            feeds: s.get_boolean('show-feeds'),
            certAgid: s.get_boolean('show-cert-agid'),
            space: s.get_boolean('show-space'),
            alerts: s.get_boolean('show-alerts'),
        });
    }

    // Moving the actor from inside a size notification would happen during
    // allocation, so defer it to the next main loop iteration.
    _queueReposition() {
        if (this._repositionId)
            return;
        this._repositionId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._repositionId = 0;
            this._reposition();
            return GLib.SOURCE_REMOVE;
        });
    }

    _reposition() {
        const layout = Main.layoutManager;
        if (!this._widget || !layout.primaryMonitor)
            return;

        const area = layout.getWorkAreaForMonitor(this._monitorIndex());
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const margin = this._settings.get_int('margin') * scale;
        const [w, h] = [this._widget.width, this._widget.height];
        const position = this._settings.get_string('position');

        let x = area.x + (area.width - w) / 2;
        let y = area.y + (area.height - h) / 2;
        if (position.endsWith('left'))
            x = area.x + margin;
        else if (position.endsWith('right'))
            x = area.x + area.width - w - margin;
        if (position.startsWith('top'))
            y = area.y + margin;
        else if (position.startsWith('bottom'))
            y = area.y + area.height - h - margin;

        this._widget.set_position(Math.round(x), Math.round(y));
        this._hideGear();
        this._hidePopup();
    }

    /**
     * The monitor chosen in the preferences, by connector name, falling back
     * to the primary one when it is not connected.
     *
     * @returns {number} a monitor index for LayoutManager
     */
    _monitorIndex() {
        const connector = this._settings.get_string('monitor');
        if (connector) {
            try {
                const index = global.backend.get_monitor_manager().get_monitor_for_connector(connector);
                if (index >= 0 && index < Main.layoutManager.monitors.length)
                    return index;
            } catch (e) {
                console.warn(`[desktop-sysweather] cannot look up monitor ${connector}: ${e.message ?? e}`);
            }
        }
        return Main.layoutManager.primaryIndex;
    }

    // ---- system statistics ---------------------------------------------

    _restartSystemTimer() {
        if (this._systemSourceId)
            GLib.source_remove(this._systemSourceId);
        this._systemSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            this._settings.get_int('refresh-interval'), () => {
                this._refreshSystem();
                return GLib.SOURCE_CONTINUE;
            });
        this._refreshSystem();
    }

    async _refreshSystem() {
        if (this._sampling)
            return;
        this._sampling = true;
        const cancellable = this._cancellable;
        try {
            const sample = await this._monitor.sample(cancellable);
            if (cancellable.is_cancelled())
                return;
            this._lastSample = sample;
            this._widget.setSystem(this._monitor, sample, this._settings.get_string('units'));
        } catch (e) {
            if (!cancellable.is_cancelled())
                console.error(`[desktop-sysweather] system sample failed: ${e}`);
        } finally {
            this._sampling = false;
        }
        if (++this._sampleCount % PROCESS_EVERY_SAMPLES === 0) {
            if (this._settings?.get_boolean('show-processes'))
                this._refreshProcesses();
            if (this._settings?.get_boolean('show-details'))
                this._refreshGpu();
        }
    }

    async _refreshGpu() {
        if (this._gpuSampling)
            return;
        this._gpuSampling = true;
        const cancellable = this._cancellable;
        try {
            const gpu = await this._gpuMonitor.sample(cancellable);
            if (!cancellable.is_cancelled())
                this._widget.setGpu(gpu);
        } catch (e) {
            if (!cancellable.is_cancelled())
                console.warn(`[desktop-sysweather] GPU sample failed: ${e.message ?? e}`);
        } finally {
            this._gpuSampling = false;
        }
    }

    async _refreshProcesses() {
        if (this._processing)
            return;
        this._processing = true;
        const cancellable = this._cancellable;
        try {
            const processes = await this._processMonitor.sample(cancellable);
            if (!cancellable.is_cancelled() && processes)
                this._widget.setProcesses(processes);
        } catch (e) {
            if (!cancellable.is_cancelled())
                console.warn(`[desktop-sysweather] process scan failed: ${e.message ?? e}`);
        } finally {
            this._processing = false;
        }
    }

    // ---- network ---------------------------------------------------------

    _restartNetworkTimer() {
        if (this._networkSourceId)
            GLib.source_remove(this._networkSourceId);
        this._networkSourceId = 0;
        if (!this._settings.get_boolean('show-network'))
            return;
        this._networkSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            this._settings.get_int('network-interval'), () => {
                this._refreshNetwork();
                return GLib.SOURCE_CONTINUE;
            });
        this._refreshNetwork();
    }

    async _refreshNetwork() {
        if (this._networking)
            return;
        this._networking = true;
        const cancellable = this._cancellable;
        try {
            const host = this._settings.get_string('latency-host').trim();
            const wantLatency = this._settings.get_boolean('show-latency') && host !== '';
            const [net, latency] = await Promise.all([
                this._networkMonitor.sample(cancellable),
                wantLatency ? this._networkMonitor.probe(host, 443, cancellable) : null,
            ]);
            if (cancellable.is_cancelled())
                return;
            this._widget.setNetwork(net);
            if (wantLatency)
                this._widget.pushLatency(latency, host);
            this._watchVpn(net.vpn);
            this._watchLan(net.lan);
        } catch (e) {
            if (!cancellable.is_cancelled())
                console.warn(`[desktop-sysweather] network sample failed: ${e.message ?? e}`);
        } finally {
            this._networking = false;
        }
    }

    /** Raises an alert when a VPN goes away and refreshes the public IP on any change. */
    _watchVpn(vpn) {
        const active = vpn !== null;
        if (this._lastVpn === undefined) {
            this._lastVpn = active;
            this._lastVpnName = vpn?.name ?? null;
            return;
        }
        if (active === this._lastVpn) {
            if (active)
                this._lastVpnName = vpn.name;
            return;
        }
        this._lastVpn = active;
        if (!active) {
            this._widget.setNetworkAlert(_('VPN disconnected'), 'very-poor');
            if (this._settings.get_boolean('notify-vpn')) {
                const name = this._lastVpnName;
                this._notify(_('VPN disconnected'), name
                    ? fmt(_('%s dropped: your traffic is no longer going through the VPN.'), name)
                    : _('The VPN dropped: your traffic is no longer going through it.'));
            }
        } else {
            this._widget.setNetworkAlert(null);
            this._lastVpnName = vpn.name;
        }
        this._schedulePublicIp(PUBLIC_IP_DEBOUNCE_SECONDS);
    }

    /**
     * Flags a device (MAC address) that was never seen on the local network
     * during this session. The first sample only records what is there.
     *
     * @param {{devices: object[]}|null} lan result of parseArp()
     */
    _watchLan(lan) {
        if (!lan)
            return;
        if (!this._knownDevices) {
            this._knownDevices = new Set(lan.devices.map(d => d.mac));
            return;
        }
        const fresh = lan.devices.filter(d => !this._knownDevices.has(d.mac));
        for (const d of fresh)
            this._knownDevices.add(d.mac);
        if (fresh.length)
            this._widget.setNetworkAlert(fmt(_('New device on the network: %s'), fresh.map(d => d.ip).join(', ')), 'moderate');
    }

    /** A desktop notification through the shell's message tray. */
    _notify(title, body) {
        try {
            Main.notify(title, body);
        } catch (e) {
            console.warn(`[desktop-sysweather] notification failed: ${e.message ?? e}`);
        }
    }

    /**
     * Notifies the CISA KEV entries used by ransomware that were added after
     * the last notified one. The date is kept in the settings so that a new
     * session does not repeat old alerts; on the very first run nothing is
     * announced, the current catalogue only sets the starting point.
     *
     * @param {{recent: object[]}} kev result of FeedClient.knownExploited()
     */
    _notifyRansomware(kev) {
        const s = this._settings;
        const ransomware = kev.recent.filter(v => v.ransomware);
        if (!ransomware.length)
            return;
        const newest = ransomware.reduce((a, v) => Math.max(a, v.date), 0);
        const notified = Number(s.get_string('kev-notified-date')) || 0;
        if (notified === 0) {
            s.set_string('kev-notified-date', String(newest));
            return;
        }
        const fresh = ransomware.filter(v => v.date > notified);
        if (!fresh.length)
            return;
        s.set_string('kev-notified-date', String(newest));
        if (!s.get_boolean('notify-ransomware'))
            return;
        const describe = v => `${v.id} · ${[v.vendor, v.product].filter((x, j, all) => x && all.indexOf(x) === j).join(' ')}`;
        const title = nfmt('%d new vulnerability exploited by ransomware',
            '%d new vulnerabilities exploited by ransomware', fresh.length);
        const lines = fresh.slice(0, 4).map(describe);
        if (fresh.length > 4)
            lines.push(nfmt('+%d more', '+%d more', fresh.length - 4));
        lines.push(_('Added to the CISA KEV catalogue: patch exposed systems first.'));
        this._notify(title, lines.join('\n'));
    }

    _schedulePublicIp(seconds) {
        if (this._publicIpSourceId)
            GLib.source_remove(this._publicIpSourceId);
        this._publicIpSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._publicIpSourceId = 0;
            this._refreshPublicIp();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refreshPublicIp() {
        if (!this._settings.get_boolean('show-network')) {
            this._schedulePublicIp(this._settings.get_int('public-ip-interval') * 60);
            return;
        }
        const request = ++this._publicIpRequest;
        const cancellable = this._cancellable;
        try {
            const info = await this._feeds.publicIp(cancellable);
            if (cancellable.is_cancelled() || request !== this._publicIpRequest)
                return;
            this._widget.setPublicIp(info, this._settings.get_boolean('mask-public-ip'));
            if (this._lastPublicIp && this._lastPublicIp !== info.ip && !this._lastVpn)
                this._widget.setNetworkAlert(_('Public IP changed'), 'moderate');
            this._lastPublicIp = info.ip;
            this._schedulePublicIp(this._settings.get_int('public-ip-interval') * 60);
        } catch (e) {
            if (cancellable.is_cancelled() || request !== this._publicIpRequest)
                return;
            console.warn(`[desktop-sysweather] public IP lookup failed: ${e.message ?? e}`);
            if (!this._lastPublicIp)
                this._widget.setPublicIp(null);
            this._schedulePublicIp(120);
        }
    }

    // ---- security --------------------------------------------------------

    _restartSecurityTimer() {
        if (this._securitySourceId)
            GLib.source_remove(this._securitySourceId);
        this._securitySourceId = 0;
        if (!this._settings.get_boolean('show-security'))
            return;
        this._securitySourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            this._settings.get_int('security-interval') * 60, () => {
                this._refreshSecurity();
                return GLib.SOURCE_CONTINUE;
            });
        this._refreshSecurity();
    }

    async _refreshSecurity() {
        if (this._securing)
            return;
        this._securing = true;
        const cancellable = this._cancellable;
        try {
            const sec = await this._securityMonitor.sample(cancellable);
            if (cancellable.is_cancelled())
                return;
            this._widget.setSecurity(sec);
            this._watchLogins(sec.failedLogins);
        } catch (e) {
            if (!cancellable.is_cancelled())
                console.warn(`[desktop-sysweather] security sample failed: ${e.message ?? e}`);
        } finally {
            this._securing = false;
        }
    }

    /**
     * Notifies a burst of failed logins: when the 24 hour count grew by
     * LOGIN_SPIKE or more since the previous check, someone is probably
     * guessing a password (SSH, the login screen, sudo). The first sample
     * only sets the baseline.
     *
     * @param {{count: number, hosts: object[]}|null} logins result of the journal probe
     */
    _watchLogins(logins) {
        if (!logins)
            return;
        const count = logins.count;
        if (this._lastLoginCount === undefined) {
            this._lastLoginCount = count;
            return;
        }
        const fresh = count - this._lastLoginCount;
        this._lastLoginCount = count;
        if (fresh < LOGIN_SPIKE || !this._settings.get_boolean('notify-logins'))
            return;
        const lines = [_('Someone may be guessing a password: check SSH and the login screen.')];
        const sources = (logins.hosts ?? []).slice(0, 3).map(h => `${h.host} ×${h.count}`);
        if (sources.length)
            lines.push(fmt(_('Sources in the last 24 hours: %s'), sources.join(', ')));
        this._notify(nfmt('%d new failed login since the last check', '%d new failed logins since the last check', fresh),
            lines.join('\n'));
    }

    // ---- feeds -----------------------------------------------------------

    _scheduleFeeds(seconds) {
        if (this._feedsSourceId)
            GLib.source_remove(this._feedsSourceId);
        this._feedsSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._feedsSourceId = 0;
            this._refreshFeeds();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refreshFeeds() {
        const s = this._settings;
        const cancellable = this._cancellable;
        const interval = s.get_int('feeds-interval') * 60;
        const wantKev = s.get_boolean('show-feeds');
        const wantCert = s.get_boolean('show-cert-agid');
        if (!wantKev && !wantCert) {
            this._feedsOk = true;
            this._scheduleFeeds(interval);
            return;
        }
        let ok = true;
        const attempt = async (wanted, fetch, apply, what) => {
            if (!wanted)
                return;
            try {
                const data = await fetch();
                if (!cancellable.is_cancelled())
                    apply(data);
            } catch (e) {
                if (cancellable.is_cancelled())
                    throw e;
                ok = false;
                console.warn(`[desktop-sysweather] ${what} feed failed: ${e.message ?? e}`);
            }
        };
        try {
            await Promise.all([
                attempt(wantKev, () => this._feeds.knownExploited(cancellable), d => {
                    this._widget.setKev(d);
                    this._notifyRansomware(d);
                }, 'CISA KEV'),
                attempt(wantCert, () => this._feeds.certAgid(cancellable), d => this._widget.setCertAgid(d), 'CERT-AGID'),
            ]);
        } catch {
            return; // cancelled
        }
        if (cancellable.is_cancelled())
            return;
        this._feedsOk = ok;
        this._scheduleFeeds(ok ? interval : FEED_RETRY_SECONDS);
    }

    _scheduleSpace(seconds) {
        if (this._spaceSourceId)
            GLib.source_remove(this._spaceSourceId);
        this._spaceSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._spaceSourceId = 0;
            this._refreshSpace();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refreshSpace() {
        const cancellable = this._cancellable;
        if (!this._settings.get_boolean('show-space')) {
            this._scheduleSpace(SPACE_INTERVAL_SECONDS);
            return;
        }
        try {
            const space = await this._feeds.spaceWeather(cancellable);
            if (cancellable.is_cancelled())
                return;
            this._widget.setSpace(space);
            this._scheduleSpace(SPACE_INTERVAL_SECONDS);
        } catch (e) {
            if (cancellable.is_cancelled())
                return;
            console.warn(`[desktop-sysweather] space weather failed: ${e.message ?? e}`);
            this._scheduleSpace(FEED_RETRY_SECONDS);
        }
    }

    _scheduleIss(seconds) {
        if (this._issSourceId)
            GLib.source_remove(this._issSourceId);
        this._issSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._issSourceId = 0;
            this._refreshIss();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refreshIss() {
        const cancellable = this._cancellable;
        if (!this._settings.get_boolean('show-space') || !this._lastLocation) {
            this._scheduleIss(ISS_INTERVAL_SECONDS);
            return;
        }
        try {
            const iss = await this._feeds.iss(cancellable);
            if (cancellable.is_cancelled())
                return;
            this._widget.setIss(iss);
            this._scheduleIss(ISS_INTERVAL_SECONDS);
        } catch (e) {
            if (cancellable.is_cancelled())
                return;
            console.warn(`[desktop-sysweather] ISS position failed: ${e.message ?? e}`);
            this._scheduleIss(FEED_RETRY_SECONDS);
        }
    }

    // ---- location --------------------------------------------------------

    _isManualLocation() {
        return this._settings.get_string('location-mode') === 'manual' &&
            this._settings.get_string('city-name') !== '';
    }

    _systemLocationEnabled() {
        return !this._locationSettings || this._locationSettings.get_boolean('enabled');
    }

    _needsLookup() {
        return !this._isManualLocation() && !this._autoLocation && !this._geoclue?.fix;
    }

    _onSystemLocationMoved(fix) {
        console.log(`[desktop-sysweather] system location changed (±${Math.round(fix.accuracy)} m)`);
        if (!this._isManualLocation())
            this._scheduleWeather(2);
    }

    _onLocationServicesChanged() {
        const enabled = this._systemLocationEnabled();
        console.log(`[desktop-sysweather] system location services ${enabled ? 'enabled' : 'disabled'}`);
        if (!enabled) {
            // drop the GeoClue client; a new one is created when re-enabled
            this._geoclue.destroy();
            this._geoclue = new GeoclueLocator(fix => this._onSystemLocationMoved(fix));
        }
        if (!this._isManualLocation())
            this._scheduleWeather(2);
    }

    async _systemFix(cancellable) {
        if (!this._geoclue || this._geoclue.unavailable || !this._systemLocationEnabled())
            return null;
        try {
            return await this._geoclue.locate(cancellable);
        } catch (e) {
            if (cancellable.is_cancelled())
                throw e;
            if (!e.silent)
                console.log(`[desktop-sysweather] system location unavailable, using the IP address: ${e.message ?? e}`);
            return null;
        }
    }

    /**
     * The place name, region and country of coordinates, cached per ~1 km.
     *
     * @returns {Promise<{name: string, region: string|null, country: string|null}>}
     */
    async _place(latitude, longitude, cancellable) {
        const key = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
        const cached = this._placeNames.get(key);
        if (cached)
            return cached;
        try {
            const place = await this._weatherClient.reverseGeocode(latitude, longitude, cancellable);
            if (place) {
                this._placeNames.set(key, place);
                return place;
            }
        } catch (e) {
            if (cancellable.is_cancelled())
                throw e;
            console.warn(`[desktop-sysweather] reverse geocoding failed: ${e.message ?? e}`);
        }
        return {name: _('Current location'), region: null, country: null};
    }

    async _location(cancellable) {
        const s = this._settings;
        if (this._isManualLocation()) {
            // "Napoli, Campania, Italia": the region and the country code are
            // stored by the preferences since 1.5; a city chosen with an
            // older version is looked up again once (Open-Meteo geocoding,
            // the same service the city search uses) and the result kept
            const parts = s.get_string('city-name').split(',').map(p => p.trim());
            const latitude = s.get_double('latitude');
            const longitude = s.get_double('longitude');
            let region = s.get_string('city-region');
            let country = s.get_string('city-country');
            if (!country && !this._manualLookupDone) {
                this._manualLookupDone = true;
                try {
                    const results = await this._weatherClient.searchCity(parts[0], cancellable);
                    const near = results.find(r =>
                        Math.abs(r.latitude - latitude) < 0.2 && Math.abs(r.longitude - longitude) < 0.2);
                    if (near) {
                        region = near.admin1 ?? '';
                        country = (near.country_code ?? '').toUpperCase();
                        s.set_string('city-region', region);
                        s.set_string('city-country', country);
                    }
                } catch (e) {
                    if (cancellable.is_cancelled())
                        throw e;
                    console.warn(`[desktop-sysweather] city lookup failed: ${e.message ?? e}`);
                }
            }
            return {
                name: parts[0],
                latitude,
                longitude,
                region: region || (parts.length >= 3 ? parts[1] : null),
                country: country || null,
                source: 'manual',
            };
        }
        const fix = await this._systemFix(cancellable);
        if (fix) {
            const place = await this._place(fix.latitude, fix.longitude, cancellable);
            return {
                name: place.name,
                region: place.region,
                country: place.country,
                latitude: fix.latitude,
                longitude: fix.longitude,
                source: 'system',
                accuracy: fix.accuracy,
            };
        }
        const now = GLib.get_monotonic_time();
        if (!this._autoLocation || now - this._autoLocation.time > AUTO_LOCATION_TTL_US) {
            const location = await this._weatherClient.locateByIp(cancellable);
            this._autoLocation = {...location, time: now};
        }
        return {...this._autoLocation, source: 'ip'};
    }

    // ---- weather ---------------------------------------------------------

    _scheduleWeather(seconds) {
        if (this._weatherSourceId)
            GLib.source_remove(this._weatherSourceId);
        this._weatherSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._weatherSourceId = 0;
            this._refreshWeather();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refreshWeather() {
        const request = ++this._weatherRequest;
        const cancellable = this._cancellable;
        const isCurrent = () => !cancellable.is_cancelled() && request === this._weatherRequest;
        try {
            if (!this._widget.hasWeather && this._needsLookup())
                this._widget.setWeatherMessage(_('Locating…'));
            const location = await this._location(cancellable);
            const units = this._settings.get_string('units');
            const data = await this._weatherClient.forecast(
                location.latitude, location.longitude, units, cancellable);
            if (!isCurrent())
                return;
            this._lastLocation = location;
            this._widget.setWeather(data, location.name, units, location);
            this._weatherOk = true;
            this._weatherFailures = 0;
            this._scheduleWeather(this._settings.get_int('weather-interval') * 60);
            // extras: a failure here must not hide the forecast
            this._refreshAirIfNeeded(request);
            this._refreshQuakes(request);
            this._refreshWarnings(request);
        } catch (e) {
            if (!isCurrent())
                return;
            console.warn(`[desktop-sysweather] weather update failed: ${e.message ?? e}`);
            this._weatherOk = false;
            // keep showing the last forecast if we have one
            if (this._widget.hasWeather)
                this._widget.setWeatherStatus(_('Update failed, retrying…'));
            else
                this._widget.setWeatherMessage(_('Weather unavailable, retrying…'));
            const retry = WEATHER_RETRY_SECONDS[
                Math.min(this._weatherFailures++, WEATHER_RETRY_SECONDS.length - 1)];
            this._scheduleWeather(retry);
        }
    }

    /**
     * Fetches the air quality when a section that shows it is enabled (the
     * air row itself, or the tip of the day which mentions poor air/pollen).
     *
     * @param {number} [request] the weather request this belongs to
     */
    _refreshAirIfNeeded(request = this._weatherRequest) {
        const s = this._settings;
        if (!this._lastLocation || !(s.get_boolean('show-air') || s.get_boolean('show-advice')))
            return;
        this._refreshAir(this._lastLocation, request);
    }

    async _refreshAir(location, request) {
        const cancellable = this._cancellable;
        try {
            const air = await this._weatherClient.airQuality(location.latitude, location.longitude, cancellable);
            if (!cancellable.is_cancelled() && request === this._weatherRequest)
                this._widget.setAir(air);
        } catch (e) {
            if (!cancellable.is_cancelled())
                console.warn(`[desktop-sysweather] air quality update failed: ${e.message ?? e}`);
        }
    }

    // ---- weather warnings ------------------------------------------------

    _scheduleWarnings(seconds) {
        if (this._warningsSourceId)
            GLib.source_remove(this._warningsSourceId);
        this._warningsSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._warningsSourceId = 0;
            this._refreshWarnings();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Fetches the MeteoAlarm warnings of the country of the weather location
     * and keeps those of its region. Refreshed with the weather and every
     * WARNINGS_INTERVAL_SECONDS in between.
     *
     * @param {number} [weatherRequest] the weather request this belongs to
     */
    async _refreshWarnings(weatherRequest = this._weatherRequest) {
        const location = this._lastLocation;
        const cancellable = this._cancellable;
        const s = this._settings;
        if (!location || !s.get_boolean('show-alerts') || !s.get_boolean('show-weather')) {
            this._widget.setWeatherWarnings([]);
            return;
        }
        const request = ++this._warningsRequest;
        try {
            const all = await this._feeds.weatherWarnings(location.country, cancellable);
            if (cancellable.is_cancelled() || request !== this._warningsRequest || weatherRequest !== this._weatherRequest)
                return;
            if (all === null) {
                // no MeteoAlarm feed for this country
                this._widget.setWeatherWarnings([]);
                return;
            }
            const mine = location.region ? all.filter(w => regionMatches(w.area, location.region)) : [];
            if (!location.region && all.length && !this._regionWarned) {
                this._regionWarned = true;
                console.log('[desktop-sysweather] weather warnings: the region of the location is unknown');
            }
            this._widget.setWeatherWarnings(mine);
            this._notifyWarnings(mine);
            this._scheduleWarnings(WARNINGS_INTERVAL_SECONDS);
        } catch (e) {
            if (cancellable.is_cancelled())
                return;
            console.warn(`[desktop-sysweather] weather warnings failed: ${e.message ?? e}`);
            this._scheduleWarnings(FEED_RETRY_SECONDS);
        }
    }

    /**
     * Notifies the orange and red warnings not announced yet in this
     * session (yellow ones only show in the card).
     *
     * @param {object[]} warnings the warnings of the user's region
     */
    _notifyWarnings(warnings) {
        const fresh = warnings.filter(w => !this._notifiedWarnings.has(w.id));
        for (const w of warnings)
            this._notifiedWarnings.add(w.id);
        if (!this._settings.get_boolean('notify-weather-alerts'))
            return;
        const severe = fresh.map(w => ({...w, info: warningInfo(w)})).filter(w => w.info.rank >= 2);
        if (!severe.length)
            return;
        const describe = w => {
            const until = w.expires ? ` · ${fmt(_('until %s'), dateLabel(w.expires, {time: true}))}` : '';
            return `${w.info.text} · ${w.area}${until}`;
        };
        const title = severe.length === 1
            ? `${_('Weather warning')} · ${severe[0].area}`
            : nfmt('%d weather warning', '%d weather warnings', severe.length);
        const lines = severe.slice(0, 4).map(describe);
        lines.push(_('Issued by the national weather service (MeteoAlarm).'));
        this._notify(title, lines.join('\n'));
    }

    _scheduleQuakes(seconds) {
        if (this._quakeSourceId)
            GLib.source_remove(this._quakeSourceId);
        this._quakeSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._quakeSourceId = 0;
            this._refreshQuakes();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refreshQuakes(weatherRequest = this._weatherRequest) {
        const location = this._lastLocation;
        const cancellable = this._cancellable;
        if (!location || !this._settings.get_boolean('show-quakes'))
            return;
        // only the newest request may update the widget: answers can overtake each other
        const request = ++this._quakeRequest;
        const options = {
            radius: this._settings.get_int('quake-radius'),
            minMagnitude: this._settings.get_double('quake-min-magnitude'),
        };
        try {
            const quakes = await this._weatherClient.earthquakes(
                location.latitude, location.longitude, options.radius, options.minMagnitude, cancellable);
            if (!cancellable.is_cancelled() && request === this._quakeRequest && weatherRequest === this._weatherRequest)
                this._widget.setQuakes(quakes, options);
        } catch (e) {
            if (!cancellable.is_cancelled())
                console.warn(`[desktop-sysweather] earthquake update failed: ${e.message ?? e}`);
        }
    }
}
