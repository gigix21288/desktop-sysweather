import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {_, availableLanguages, fmt, languageName, setLanguage} from './lib/i18n.js';
import {systemLocationSettings} from './lib/geoclue.js';
import {WeatherClient, placeLabel} from './lib/weather.js';

// Signal connections made while the pages are built, so they can be dropped
// when the pages are rebuilt (language change) or the window closes.
let connectionSink = null;

function track(object, id) {
    connectionSink?.push([object, id]);
    return id;
}

/**
 * A combo row bound to a string setting with a fixed set of values.
 *
 * @param {Gio.Settings} settings the settings object
 * @param {string} key the string key
 * @param {string} title row title
 * @param {Array<[string, string]>} choices [value, label] pairs
 * @param {string} [subtitle] row subtitle
 * @returns {Adw.ComboRow}
 */
function comboRow(settings, key, title, choices, subtitle = '', integer = false) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(([, text]) => text)),
    });
    const current = () => (integer ? String(settings.get_int(key)) : settings.get_string(key));
    const sync = () => {
        const index = choices.findIndex(([value]) => value === current());
        row.selected = Math.max(0, index);
    };
    sync();
    row.connect('notify::selected', () => {
        const value = choices[row.selected]?.[0];
        if (value && value !== current()) {
            if (integer)
                settings.set_int(key, Number(value));
            else
                settings.set_string(key, value);
        }
    });
    track(settings, settings.connect(`changed::${key}`, sync));
    return row;
}

function spinRow(settings, key, title, lower, upper, step, subtitle = '', digits = 0) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        digits,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/**
 * The monitors connected right now, as [connector, label] pairs for the
 * monitor combo, plus the configured one when it is currently unplugged.
 *
 * @param {string} current the connector stored in the settings
 * @returns {Array<[string, string]>}
 */
function monitorChoices(current) {
    const choices = [['', _('Primary monitor')]];
    try {
        const monitors = Gdk.Display.get_default()?.get_monitors();
        for (let i = 0; i < (monitors?.get_n_items() ?? 0); i++) {
            const m = monitors.get_item(i);
            const connector = m.connector;
            if (!connector)
                continue;
            const name = [m.manufacturer, m.model].filter(Boolean).join(' ');
            const g = m.geometry;
            choices.push([connector, [connector, name, `${g.width}×${g.height}`].filter(Boolean).join(' · ')]);
        }
    } catch (e) {
        console.warn(`[desktop-sysweather] cannot list monitors: ${e.message ?? e}`);
    }
    if (current && !choices.some(([value]) => value === current))
        choices.push([current, fmt(_('%s (not connected)'), current)]);
    return choices;
}

/**
 * Asks for a confirmation before a destructive action. Adw.AlertDialog
 * (libadwaita 1.5, GNOME 46) with Adw.MessageDialog as the GNOME 45 fallback.
 *
 * @param {Gtk.Window} window the preferences window
 * @param {string} heading the question
 * @param {string} body what will happen
 * @param {string} action the label of the destructive button
 * @param {Function} onConfirm called when the user confirms
 */
function confirm(window, heading, body, action, onConfirm) {
    const modern = typeof Adw.AlertDialog === 'function';
    const dialog = modern
        ? new Adw.AlertDialog({heading, body})
        : new Adw.MessageDialog({heading, body, transient_for: window, modal: true});
    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('confirm', action);
    dialog.set_response_appearance('confirm', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.set_default_response('cancel');
    dialog.set_close_response('cancel');
    dialog.connect('response', (_dialog, response) => {
        if (response === 'confirm')
            onConfirm();
    });
    if (modern)
        dialog.present(window);
    else
        dialog.present();
}

function scaleRow(settings, key, title, lower, upper, subtitle = '') {
    const row = new Adw.ActionRow({title, subtitle});
    const scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, lower, upper, 5);
    scale.set_hexpand(true);
    scale.set_size_request(220, -1);
    scale.set_draw_value(true);
    scale.set_value_pos(Gtk.PositionType.LEFT);
    scale.set_format_value_func((_s, value) => `${Math.round(value)}%`);
    settings.bind(key, scale.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(scale);
    return row;
}

export default class DesktopSysWeatherPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this.initTranslations();
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(640, 760);
        const localeDir = `${this.path}/locale`;
        setLanguage(settings.get_string('language'), localeDir);

        // the city search client outlives the pages, which are rebuilt when
        // the language changes
        const client = new WeatherClient();
        window.connect('close-request', () => {
            client.destroy();
            return false;
        });

        let pages = [];
        let connections = [];
        const dropConnections = () => {
            for (const [object, id] of connections)
                object.disconnect(id);
            connections = [];
        };
        const build = () => {
            dropConnections();
            pages.forEach(p => window.remove(p));
            connectionSink = connections;
            try {
                pages = [
                    this._appearancePage(settings, window, localeDir),
                    this._weatherPage(settings, window, client),
                    this._contentPage(settings),
                    this._networkPage(settings),
                ];
            } finally {
                connectionSink = null;
            }
            pages.forEach(p => window.add(p));
        };
        build();
        const languageId = settings.connect('changed::language', () => {
            setLanguage(settings.get_string('language'), localeDir);
            build();
            window.set_visible_page(pages[0]);
        });
        window.connect('close-request', () => {
            dropConnections();
            settings.disconnect(languageId);
            return false;
        });
    }

    _appearancePage(settings, window, localeDir) {
        const page = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });

        const style = new Adw.PreferencesGroup({title: _('Style')});
        style.add(comboRow(settings, 'language', _('Language'), [
            ['auto', _('System language')],
            ...availableLanguages(localeDir).map(code => [code, languageName(code)]),
        ], _('Applies to the widget and to this window')));
        style.add(comboRow(settings, 'theme', _('Theme'), [
            ['dark', _('Dark')],
            ['light', _('Light')],
            ['terminal', _('Terminal (green phosphor)')],
            ['amber', _('Terminal (amber phosphor)')],
        ]));
        style.add(comboRow(settings, 'columns', _('Layout'), [
            ['1', _('One column')],
            ['2', _('Two columns: weather on the left, system on the right')],
        ], '', true));
        style.add(scaleRow(settings, 'background-opacity', _('Background opacity'), 0, 100,
            _('0% = fully transparent')));
        style.add(scaleRow(settings, 'scale', _('Size'), 70, 160));
        style.add(switchRow(settings, 'sky-background', _('Living sky background'),
            _('The card is tinted like the sky: day, dusk, night with stars, rain and snow')));
        page.add(style);

        const placement = new Adw.PreferencesGroup({title: _('Position on the desktop')});
        placement.add(comboRow(settings, 'position', _('Position'), [
            ['top-left', _('Top left')],
            ['top-center', _('Top center')],
            ['top-right', _('Top right')],
            ['center', _('Center')],
            ['bottom-left', _('Bottom left')],
            ['bottom-center', _('Bottom center')],
            ['bottom-right', _('Bottom right')],
        ]));
        placement.add(comboRow(settings, 'monitor', _('Monitor'),
            monitorChoices(settings.get_string('monitor')),
            _('The widget moves back to the primary monitor while the chosen one is unplugged')));
        placement.add(spinRow(settings, 'margin', _('Margin'), 0, 400, 4,
            _('Distance from the screen edges, in pixels')));
        page.add(placement);

        const reset = new Adw.PreferencesGroup();
        const resetRow = new Adw.ActionRow({
            title: _('Restore the default settings'),
            subtitle: _('Every option on every page goes back to its default, including the chosen city'),
        });
        const resetButton = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        resetButton.connect('clicked', () => confirm(window,
            _('Restore the default settings?'),
            _('The widget goes back to its initial appearance, position and content. This cannot be undone.'),
            _('Reset'),
            () => {
                for (const key of settings.settings_schema.list_keys())
                    settings.reset(key);
            }));
        resetRow.add_suffix(resetButton);
        resetRow.activatable_widget = resetButton;
        reset.add(resetRow);
        page.add(reset);

        return page;
    }

    _weatherPage(settings, window, client) {
        const page = new Adw.PreferencesPage({
            title: _('Weather'),
            icon_name: 'weather-few-clouds-symbolic',
        });

        const location = new Adw.PreferencesGroup({
            title: _('Location'),
            description: _('Weather data by Open-Meteo.com. Automatic location uses the system location services (GeoClue) when they are enabled, otherwise it is estimated from your public IP address.'),
        });
        location.add(comboRow(settings, 'location-mode', _('Location'), [
            ['auto', _('Automatic')],
            ['manual', _('Manual')],
        ]));

        const systemLocation = systemLocationSettings();
        if (systemLocation) {
            const services = new Adw.ActionRow({title: _('System location services')});
            const icon = new Gtk.Image({valign: Gtk.Align.CENTER});
            services.add_prefix(icon);
            const syncServices = () => {
                const enabled = systemLocation.get_boolean('enabled');
                services.subtitle = enabled
                    ? _('Enabled: the position comes from Wi-Fi, GPS or the network')
                    : _('Disabled: the position is estimated from your IP address');
                icon.icon_name = enabled ? 'location-services-active-symbolic' : 'location-services-disabled-symbolic';
            };
            syncServices();
            track(systemLocation, systemLocation.connect('changed::enabled', syncServices));
            const open = new Gtk.Button({label: _('Open Settings'), valign: Gtk.Align.CENTER});
            open.connect('clicked', () => {
                try {
                    Gio.Subprocess.new(['gnome-control-center', 'location'], Gio.SubprocessFlags.NONE);
                } catch (e) {
                    console.warn(`[desktop-sysweather] cannot open Settings: ${e.message ?? e}`);
                }
            });
            services.add_suffix(open);
            location.add(services);
            window._systemLocation = systemLocation;
        }

        const current = new Adw.ActionRow({title: _('Selected city')});
        const syncCurrent = () => {
            const name = settings.get_string('city-name');
            current.subtitle = name || _('None — search a city below');
        };
        syncCurrent();
        track(settings, settings.connect('changed::city-name', syncCurrent));
        location.add(current);

        const search = new Adw.EntryRow({title: _('Search city'), show_apply_button: true});
        location.add(search);
        page.add(location);

        const results = new Adw.PreferencesGroup();
        page.add(results);
        let resultRows = [];
        let cancellable = null;
        window.connect('close-request', () => {
            cancellable?.cancel();
            return false;
        });

        const showMessage = text => {
            resultRows.forEach(r => results.remove(r));
            resultRows = [new Adw.ActionRow({title: text})];
            results.add(resultRows[0]);
        };

        search.connect('apply', async () => {
            const query = search.text.trim();
            if (!query)
                return;
            cancellable?.cancel();
            cancellable = new Gio.Cancellable();
            const mine = cancellable;
            showMessage(_('Searching…'));
            try {
                const places = await client.searchCity(query, mine);
                if (mine.is_cancelled())
                    return;
                if (places.length === 0) {
                    showMessage(_('No city found'));
                    return;
                }
                resultRows.forEach(r => results.remove(r));
                resultRows = places.map(place => {
                    const row = new Adw.ActionRow({
                        title: place.name,
                        subtitle: placeLabel(place).split(', ').slice(1).join(', '),
                        activatable: true,
                    });
                    row.add_suffix(new Gtk.Image({icon_name: 'object-select-symbolic', opacity: 0.4}));
                    row.connect('activated', () => {
                        settings.set_double('latitude', place.latitude);
                        settings.set_double('longitude', place.longitude);
                        settings.set_string('city-name', placeLabel(place));
                        // region and country select the weather warnings (MeteoAlarm)
                        settings.set_string('city-region', place.admin1 ?? '');
                        settings.set_string('city-country', (place.country_code ?? '').toUpperCase());
                        settings.set_string('location-mode', 'manual');
                        resultRows.forEach(r => results.remove(r));
                        resultRows = [];
                        search.text = '';
                    });
                    results.add(row);
                    return row;
                });
            } catch (e) {
                if (mine.is_cancelled())
                    return; // superseded by a newer search
                showMessage(_('Search failed: check your internet connection'));
                console.warn(`[desktop-sysweather] city search failed: ${e.message ?? e}`);
            }
        });

        const options = new Adw.PreferencesGroup({title: _('Options')});
        options.add(comboRow(settings, 'units', _('Units'), [
            ['metric', _('Metric (°C, km/h)')],
            ['imperial', _('Imperial (°F, mph)')],
        ]));
        options.add(spinRow(settings, 'weather-interval', _('Refresh every (minutes)'), 10, 180, 5));
        page.add(options);

        const quakes = new Adw.PreferencesGroup({
            title: _('Earthquakes'),
            description: _('Events of the last 7 days around the weather location. Data from INGV in Italy and from USGS elsewhere.'),
        });
        quakes.add(spinRow(settings, 'quake-min-magnitude', _('Minimum magnitude'), 1.0, 6.0, 0.1, '', 1));
        quakes.add(spinRow(settings, 'quake-radius', _('Search radius (km)'), 25, 500, 25));
        page.add(quakes);

        return page;
    }

    _contentPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Content'),
            icon_name: 'utilities-system-monitor-symbolic',
        });

        const sections = new Adw.PreferencesGroup({title: _('Sections')});
        sections.add(switchRow(settings, 'show-header', _('Computer name and uptime')));
        sections.add(switchRow(settings, 'show-clock', _('Clock and Unix time'),
            _('Shown under the computer name')));
        sections.add(comboRow(settings, 'clock-mode', _('Clock'), [
            ['local', _('System time')],
            ['location', _('Time at the weather location')],
            ['utc', _('UTC')],
            ['local-utc', _('System time and UTC')],
        ], _('The Unix time always follows')));
        sections.add(switchRow(settings, 'show-weather', _('Current weather')));
        sections.add(switchRow(settings, 'show-alerts', _('Weather warnings'),
            _('Alerts of the national weather service for your region, relayed by MeteoAlarm (Europe)')));
        sections.add(switchRow(settings, 'show-rain', _('Rain in the next two hours')));
        sections.add(switchRow(settings, 'show-sun', _('Sun arc, moon phase, sunrise and sunset')));
        sections.add(switchRow(settings, 'show-air', _('Air quality, UV index and pollen')));
        sections.add(switchRow(settings, 'show-advice', _('Tip of the day')));
        sections.add(switchRow(settings, 'show-hourly', _('Next hours'),
            _('Six steps of two hours with temperature and chance of rain')));
        sections.add(switchRow(settings, 'show-forecast', _('Next days forecast')));
        sections.add(switchRow(settings, 'show-quakes', _('Recent earthquakes nearby')));
        sections.add(switchRow(settings, 'show-space', _('Space weather and the ISS'),
            _('Geomagnetic activity (NOAA Kp index, aurora alerts) and how far the ISS is')));
        sections.add(switchRow(settings, 'show-system', _('CPU, memory and disk')));
        sections.add(switchRow(settings, 'show-details', _('Network speed, load, GPU, fans and battery')));
        sections.add(switchRow(settings, 'show-processes', _('Top processes by CPU and memory')));
        page.add(sections);

        const refresh = new Adw.PreferencesGroup({title: _('Refresh')});
        refresh.add(spinRow(settings, 'refresh-interval', _('System data every (seconds)'), 1, 30, 1));
        page.add(refresh);

        return page;
    }

    _networkPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Network & security'),
            icon_name: 'security-high-symbolic',
        });

        const network = new Adw.PreferencesGroup({
            title: _('Network'),
            description: _('Everything is read locally from NetworkManager and /proc. The public IP address is looked up at ipwho.is; the latency is the time to open a TCP connection to the chosen host.'),
        });
        network.add(switchRow(settings, 'show-network', _('Public IP, VPN, Wi-Fi, local address, gateway and DNS'),
            _('Warns when the VPN drops or the public IP changes')));
        network.add(switchRow(settings, 'mask-public-ip', _('Mask the public IP'),
            _('Shows 151.43.•.• instead of the full address: handy for screenshots and screen sharing')));
        network.add(switchRow(settings, 'show-ports', _('Listening ports and connections'),
            _('TCP ports open to the network are listed explicitly')));
        network.add(switchRow(settings, 'show-latency', _('Latency graph')));
        const host = new Adw.EntryRow({title: _('Latency host')});
        settings.bind('latency-host', host, 'text', Gio.SettingsBindFlags.DEFAULT);
        network.add(host);
        network.add(spinRow(settings, 'network-interval', _('Network data every (seconds)'), 5, 120, 5));
        network.add(spinRow(settings, 'public-ip-interval', _('Public IP every (minutes)'), 2, 120, 1));
        page.add(network);

        const security = new Adw.PreferencesGroup({
            title: _('Security'),
            description: _('Firewall, pending updates, reboot required, failed logins in the last 24 hours, remote sessions, SSH server, failed systemd units, Secure Boot, disk encryption, AppArmor/SELinux and running containers. Failed logins need the journal to be readable (adm or systemd-journal group).'),
        });
        security.add(switchRow(settings, 'show-security', _('Security status')));
        security.add(switchRow(settings, 'hover-details', _('Details on hover'),
            _('A popup with the details of a chip, a CVE or a news item when the pointer rests on it')));
        security.add(spinRow(settings, 'security-interval', _('Check every (minutes)'), 1, 60, 1));
        page.add(security);

        const notifications = new Adw.PreferencesGroup({
            title: _('Notifications'),
            description: _('Desktop notifications for the events that matter even when the widget is covered by windows.'),
        });
        notifications.add(switchRow(settings, 'notify-vpn', _('VPN dropped'),
            _('When an active VPN connection goes away')));
        notifications.add(switchRow(settings, 'notify-ransomware', _('New ransomware vulnerability'),
            _('When CISA adds a vulnerability known to be used in ransomware campaigns to the KEV catalogue')));
        notifications.add(switchRow(settings, 'notify-logins', _('Burst of failed logins'),
            _('When five or more logins fail between two security checks')));
        notifications.add(switchRow(settings, 'notify-weather-alerts', _('Orange and red weather warnings'),
            _('When the national weather service issues a severe warning for your region')));
        page.add(notifications);

        const feeds = new Adw.PreferencesGroup({
            title: _('Feeds'),
            description: _('CISA KEV is the US catalogue of vulnerabilities known to be exploited in the wild; CERT-AGID is the Italian government CSIRT.'),
        });
        feeds.add(switchRow(settings, 'show-feeds', _('CISA Known Exploited Vulnerabilities')));
        feeds.add(switchRow(settings, 'show-cert-agid', _('CERT-AGID news (Italian)')));
        feeds.add(spinRow(settings, 'feeds-interval', _('Refresh every (minutes)'), 15, 360, 15));
        page.add(feeds);

        return page;
    }
}
