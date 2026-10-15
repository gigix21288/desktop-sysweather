// The desktop card: pure presentation, fed by extension.js.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import Cairo from 'cairo';

import {_, fmt, nfmt} from './i18n.js';
import {KEV_CATALOGUE_URL} from './feeds.js';
import {portLabel} from './network.js';
import {weatherInfo} from './weather.js';
import {
    airInfo, clockLabel, clockTimeLabel, dailyAdvice, dateLabel, formatDuration, hourMinuteLabel, issInfo, kpInfo, localToUnix,
    mix, moonPhase, nextMoonLabel, rainNowcast, skyColors, sunState, timeAgo, uvInfo, warningInfo, weekdayLabel,
} from './sky.js';

const HISTORY_LENGTH = 60;
const LATENCY_HISTORY = 40;
const LATENCY_LOSS_WINDOW = 20;
const FORECAST_DAYS = 4;
// the next hours strip: HOURLY_SLOTS columns, HOURLY_STEP hours apart
const HOURLY_SLOTS = 6;
const HOURLY_STEP = 2;
const NOWCAST_SLOTS = 8;
const STARS = 42;
const KEV_ROWS = 2;
const CERT_AGID_URL = 'https://cert-agid.gov.it/';
const POPUP_PACKAGES = 18;
const ALERT_SECONDS = 30 * 60;
const THEMES = {
    dark: {className: 'sw-dark', rgb: [14, 17, 27], skyMix: [14 / 255, 17 / 255, 27 / 255], skyMixAmount: 0.22},
    // The light theme keeps the card at least 60% opaque: dark text on a half-transparent
    // card over a dark wallpaper is unreadable. The opacity preference maps to 60..100%.
    light: {className: 'sw-light', rgb: [250, 251, 254], skyMix: [1, 1, 1], skyMixAmount: 0.8, alphaFloor: 0.6},
    // "terminal" themes: monospace, phosphor colours, blocky graphs, scanlines
    terminal: {className: 'sw-terminal', rgb: [4, 10, 6], skyMix: [4 / 255, 10 / 255, 6 / 255], skyMixAmount: 0.84, mono: true},
    amber: {className: 'sw-amber', rgb: [12, 8, 2], skyMix: [12 / 255, 8 / 255, 2 / 255], skyMixAmount: 0.84, mono: true},
};

/**
 * St.BoxLayout's orientation API differs between GNOME versions; a plain
 * St.Widget with a Clutter.BoxLayout works the same everywhere.
 *
 * @param {boolean} vertical stack children vertically
 * @param {object} params St.Widget properties
 * @param {object} layout Clutter.BoxLayout properties
 * @returns {St.Widget}
 */
function box(vertical, params = {}, layout = {}) {
    return new St.Widget({
        layout_manager: new Clutter.BoxLayout({
            orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
            ...layout,
        }),
        ...params,
    });
}

function label(styleClass, params = {}) {
    return new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...params});
}

function wrappingLabel(styleClass, params = {}) {
    const l = label(styleClass, {x_expand: true, ...params});
    l.clutter_text.line_wrap = true;
    l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return l;
}

function themeColor(node, name, fallback) {
    const [found, color] = node.lookup_color(name, false);
    if (!found)
        return fallback;
    return [color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255];
}

function roundedRect(cr, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

/** Deterministic pseudo random number in [0, 1) for star/rain placement. */
function noise(i, salt) {
    const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
    return x - Math.floor(x);
}

function levelName(percent) {
    if (percent >= 90)
        return 'crit';
    return percent >= 70 ? 'warn' : 'ok';
}

function formatBytes(bytes) {
    return GLib.format_size(Math.round(bytes));
}

/** "3h05" or "40 min": a duration short enough for a tile value. */
function compactDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    return hours > 0 ? `${hours}h${String(minutes).padStart(2, '0')}` : fmt(_('%d min'), minutes);
}

/**
 * Local date and time for the popups: "13 Oct 15:01", or "13 Oct 2026" without the time.
 *
 * @param {number} unix seconds
 * @param {boolean} withTime include the hour
 * @returns {string}
 */
function formatDate(unix, withTime = true) {
    return dateLabel(unix, {time: withTime, year: !withTime});
}

/** The current local time, in the user's 12/24 hour format. */
function nowLabel() {
    const dt = GLib.DateTime.new_now_local();
    return hourMinuteLabel(dt.get_hour(), dt.get_minute());
}

/**
 * When something happens, briefly: the time alone within the next
 * (or last) 20 hours, the date and time otherwise.
 *
 * @param {number} unix seconds
 * @returns {string}
 */
function whenLabel(unix) {
    const dt = GLib.DateTime.new_from_unix_local(Math.round(unix));
    if (!dt)
        return '';
    if (Math.abs(unix - Date.now() / 1000) < 20 * 3600)
        return hourMinuteLabel(dt.get_hour(), dt.get_minute());
    return formatDate(unix);
}

/** The first sentence of a long text, for the popups. */
function firstSentence(text, limit = 180) {
    const sentence = text.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? text;
    return sentence.length > limit ? `${sentence.slice(0, limit - 1).trimEnd()}…` : sentence;
}

/** A chip whose colour follows a level: good, fair, moderate, poor, very-poor, hazardous or none. */
function setChip(actor, text, level = 'none', extraClass = '') {
    actor.text = text;
    actor.style_class = `sw-chip ${extraClass} ${level === 'none' ? '' : `sw-level-${level}`}`.replace(/\s+/g, ' ').trim();
}

/** Rounds a chart ceiling up to a friendly value: 50, 100, 250, 500, 1000… */
function niceCeiling(value) {
    const steps = [25, 50, 100, 150, 250, 500, 1000, 2000, 5000];
    return steps.find(v => v >= value) ?? Math.ceil(value / 5000) * 5000;
}

function sectionTitle(iconName, text) {
    const row = box(false, {style_class: 'sw-section-head'});
    row.add_child(new St.Icon({style_class: 'sw-section-icon', icon_name: iconName, y_align: Clutter.ActorAlign.CENTER}));
    row.add_child(label('sw-section-title', {text, x_expand: true}));
    return row;
}

/** Paints a sky gradient (with stars, dawn glow, rain or snow) behind the card. */
const Sky = GObject.registerClass(
class SysWeatherSky extends St.DrawingArea {
    _init() {
        super._init({style_class: 'sw-sky', x_expand: true, y_expand: true});
        this._state = null;
    }

    /**
     * @param {object|null} state {top, bottom, alpha, stars, glow, glowRight, precip, minute}
     */
    setState(state) {
        this._state = state;
        this.queue_repaint();
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const s = this._state;
        const [w, h] = this.get_surface_size();
        if (!s || w <= 0 || h <= 0) {
            cr.$dispose();
            return;
        }
        const card = this.get_parent();
        const node = card.get_theme_node();
        const px = this.width > 0 ? w / this.width : 1;
        const border = node.get_border_width(St.Side.TOP) * px;
        const radius = Math.max(0, node.get_border_radius(St.Corner.TOPLEFT) * px - border);
        const x0 = border;
        const y0 = border;
        const iw = w - 2 * border;
        const ih = h - 2 * border;

        roundedRect(cr, x0, y0, iw, ih, radius);
        cr.clip();

        const gradient = new Cairo.LinearGradient(0, y0, 0, y0 + ih);
        gradient.addColorStopRGBA(0, s.top[0], s.top[1], s.top[2], s.alpha);
        gradient.addColorStopRGBA(1, s.bottom[0], s.bottom[1], s.bottom[2], s.alpha);
        cr.setSource(gradient);
        cr.paint();

        const unit = Math.max(1, w / 320);
        if (s.glow > 0) {
            const gx = x0 + (s.glowRight ? 0.85 : 0.15) * iw;
            const gy = y0 + ih * 0.95;
            const gr = iw * 0.55;
            const glow = new Cairo.RadialGradient(gx, gy, 0, gx, gy, gr);
            glow.addColorStopRGBA(0, 1, 0.72, 0.35, 0.55 * s.glow * s.alpha);
            glow.addColorStopRGBA(0.5, 1, 0.55, 0.3, 0.18 * s.glow * s.alpha);
            glow.addColorStopRGBA(1, 1, 0.5, 0.3, 0);
            cr.setSource(glow);
            cr.paint();
        }

        if (s.stars > 0) {
            for (let i = 0; i < STARS; i++) {
                const sx = x0 + noise(i, 1) * iw;
                const sy = y0 + noise(i, 2) * ih * 0.75;
                const size = (0.5 + noise(i, 3)) * unit;
                const twinkle = 0.55 + 0.45 * Math.sin(s.minute * 1.7 + i * 2.3);
                cr.setSourceRGBA(1, 1, 1, s.stars * s.alpha * twinkle * (0.3 + 0.5 * noise(i, 4)));
                cr.arc(sx, sy, size, 0, 2 * Math.PI);
                cr.fill();
            }
        }

        if (s.scanlines) {
            cr.setSourceRGBA(0, 0, 0, 0.16 * s.alpha);
            cr.setLineWidth(1);
            for (let y = y0 + 1.5; y < y0 + ih; y += 3) {
                cr.moveTo(x0, y);
                cr.lineTo(x0 + iw, y);
                cr.stroke();
            }
        }

        if (s.precip === 'rain') {
            cr.setLineWidth(unit * 0.9);
            cr.setLineCap(Cairo.LineCap.ROUND);
            for (let i = 0; i < 26; i++) {
                const rx = x0 + ((noise(i, 5) + s.minute * 0.013) % 1) * iw;
                const ry = y0 + ((noise(i, 6) + s.minute * 0.031) % 1) * ih;
                const len = (6 + 10 * noise(i, 7)) * unit;
                cr.setSourceRGBA(0.75, 0.87, 1, (0.08 + 0.1 * noise(i, 8)) * s.alpha);
                cr.moveTo(rx, ry);
                cr.lineTo(rx - len * 0.25, ry + len);
                cr.stroke();
            }
        } else if (s.precip === 'snow') {
            for (let i = 0; i < 30; i++) {
                const fx = x0 + ((noise(i, 5) + s.minute * 0.007) % 1) * iw;
                const fy = y0 + ((noise(i, 6) + s.minute * 0.017) % 1) * ih;
                cr.setSourceRGBA(1, 1, 1, (0.18 + 0.3 * noise(i, 8)) * s.alpha);
                cr.arc(fx, fy, (0.8 + 1.2 * noise(i, 7)) * unit, 0, 2 * Math.PI);
                cr.fill();
            }
        }
        cr.$dispose();
    }
});

/** A rounded progress bar with a gradient fill that changes color with load. */
const Bar = GObject.registerClass(
class SysWeatherBar extends St.DrawingArea {
    _init() {
        super._init({style_class: 'sw-bar', x_expand: true});
        this._percent = 0;
    }

    setPercent(percent) {
        this._percent = Math.max(0, Math.min(100, percent));
        this.queue_repaint();
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const node = this.get_theme_node();
        const level = levelName(this._percent);

        cr.setSourceRGBA(...themeColor(node, '-sw-track', [1, 1, 1, 0.12]));
        roundedRect(cr, 0, 0, w, h, h / 2);
        cr.fill();

        if (this._percent > 0) {
            const fill = Math.max(h, w * this._percent / 100);
            const gradient = new Cairo.LinearGradient(0, 0, fill, 0);
            gradient.addColorStopRGBA(0, ...themeColor(node, `-sw-${level}-start`, [0.3, 0.8, 0.9, 1]));
            gradient.addColorStopRGBA(1, ...themeColor(node, `-sw-${level}-end`, [0.4, 0.5, 1, 1]));
            cr.setSource(gradient);
            roundedRect(cr, 0, 0, fill, h, h / 2);
            cr.fill();
        }
        cr.$dispose();
    }
});

/**
 * History sparkline with a fading area fill (CPU, latency…). The range is
 * fixed (0..max) or automatic; null values are gaps (lost probes); the
 * terminal themes draw it as discrete blocks.
 */
const Sparkline = GObject.registerClass(
class SysWeatherSparkline extends St.DrawingArea {
    /**
     * @param {object} [params]
     * @param {number|null} [params.max] top of the range, null = automatic
     * @param {number} [params.length] how many samples to keep
     * @param {string} [params.styleClass] CSS class
     */
    _init(params = {}) {
        super._init({style_class: params.styleClass ?? 'sw-sparkline', x_expand: true});
        this._values = [];
        this._max = params.max === undefined ? 100 : params.max;
        this._length = params.length ?? HISTORY_LENGTH;
        this._blocks = false;
    }

    push(value) {
        this._values.push(value);
        if (this._values.length > this._length)
            this._values.shift();
        this.queue_repaint();
    }

    setBlocks(blocks) {
        if (this._blocks === blocks)
            return;
        this._blocks = blocks;
        this.queue_repaint();
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const node = this.get_theme_node();
        const line = themeColor(node, '-sw-line', [0.45, 0.7, 1, 1]);
        const grid = themeColor(node, '-sw-track', [1, 1, 1, 0.12]);
        const lineWidth = Math.max(1.5, h / 22);

        // baseline + 50% guide
        cr.setSourceRGBA(...grid);
        cr.setLineWidth(1);
        cr.moveTo(0, h - 0.5);
        cr.lineTo(w, h - 0.5);
        cr.stroke();
        cr.setDash([2, 3], 0);
        cr.moveTo(0, Math.round(h / 2) + 0.5);
        cr.lineTo(w, Math.round(h / 2) + 0.5);
        cr.stroke();
        cr.setDash([], 0);

        const values = this._values;
        const known = values.filter(v => v !== null);
        if (values.length >= 2 && known.length > 0) {
            const max = this._max ?? niceCeiling(Math.max(...known) * 1.15);
            const step = w / (this._length - 1);
            const x0 = w - (values.length - 1) * step;
            const top = lineWidth;
            const yOf = v => top + (h - top - lineWidth / 2) * (1 - Math.min(max, Math.max(0, v)) / max);

            if (this._blocks) {
                const bw = Math.max(1, step - 1);
                values.forEach((v, i) => {
                    if (v === null)
                        return;
                    const y = Math.round(yOf(v));
                    cr.setSourceRGBA(line[0], line[1], line[2], 0.85);
                    cr.rectangle(x0 + i * step - bw / 2, y, bw, h - y);
                    cr.fill();
                });
                cr.$dispose();
                return;
            }

            // one polyline per run of known values
            const runs = [];
            let run = null;
            values.forEach((v, i) => {
                if (v === null) {
                    run = null;
                    return;
                }
                if (!run)
                    runs.push(run = []);
                run.push([x0 + i * step, yOf(v)]);
            });
            for (const points of runs) {
                if (points.length === 1)
                    points.push([points[0][0] + 0.01, points[0][1]]);
                cr.moveTo(points[0][0], points[0][1]);
                points.forEach(([x, y]) => cr.lineTo(x, y));
                cr.lineTo(points[points.length - 1][0], h);
                cr.lineTo(points[0][0], h);
                cr.closePath();
                const gradient = new Cairo.LinearGradient(0, 0, 0, h);
                gradient.addColorStopRGBA(0, line[0], line[1], line[2], 0.45);
                gradient.addColorStopRGBA(1, line[0], line[1], line[2], 0.02);
                cr.setSource(gradient);
                cr.fill();

                cr.setSourceRGBA(...line);
                cr.setLineWidth(lineWidth);
                cr.setLineJoin(Cairo.LineJoin.ROUND);
                cr.moveTo(points[0][0], points[0][1]);
                points.forEach(([x, y]) => cr.lineTo(x, y));
                cr.stroke();
            }
        }
        cr.$dispose();
    }
});

/**
 * Draws a moon disc with its phase (lit side on the right while waxing, as
 * seen from the northern hemisphere).
 */
function drawMoon(cr, x, y, r, moon, lit, dark) {
    const k = Math.cos(2 * Math.PI * moon.phase); // 1 = new, -1 = full
    const sign = moon.waxing ? 1 : -1;
    const half = side => {
        cr.newSubPath();
        cr.arc(x, y, r, side > 0 ? -Math.PI / 2 : Math.PI / 2, side > 0 ? Math.PI / 2 : 3 * Math.PI / 2);
        cr.closePath();
    };
    const halfEllipse = (side, sx) => {
        cr.save();
        cr.translate(x, y);
        cr.scale(Math.max(0.001, sx), 1);
        cr.newSubPath();
        cr.arc(0, 0, r, side > 0 ? -Math.PI / 2 : Math.PI / 2, side > 0 ? Math.PI / 2 : 3 * Math.PI / 2);
        cr.closePath();
        cr.restore();
    };

    cr.setSourceRGBA(...dark);
    cr.arc(x, y, r, 0, 2 * Math.PI);
    cr.fill();
    cr.setSourceRGBA(...lit);
    half(sign);
    cr.fill();
    if (k > 0) {
        cr.setSourceRGBA(...dark);
        halfEllipse(sign, k);
        cr.fill();
    } else {
        cr.setSourceRGBA(...lit);
        halfEllipse(-sign, -k);
        cr.fill();
    }
    cr.setSourceRGBA(lit[0], lit[1], lit[2], 0.55);
    cr.setLineWidth(Math.max(1, r / 8));
    cr.arc(x, y, r, 0, 2 * Math.PI);
    cr.stroke();
}

/** The sun (or the moon at night) travelling along an arc from sunrise to sunset. */
const SunArc = GObject.registerClass(
class SysWeatherSunArc extends St.DrawingArea {
    _init() {
        super._init({style_class: 'sw-sun-arc', x_expand: true});
        this._state = null;
    }

    /**
     * @param {object|null} state {isDay, progress, moon}
     */
    setState(state) {
        this._state = state;
        this.queue_repaint();
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const node = this.get_theme_node();
        const track = themeColor(node, '-sw-track', [1, 1, 1, 0.12]);
        const sun = themeColor(node, '-sw-sun', [0.98, 0.75, 0.14, 1]);
        const moonLit = themeColor(node, '-sw-moon', [0.9, 0.92, 0.97, 1]);
        const moonDark = themeColor(node, '-sw-moon-dark', [0.25, 0.28, 0.38, 1]);
        const lineWidth = Math.max(1, h / 26);
        const r = h * 0.14;
        const cy = h - r - lineWidth;
        const cx = w / 2;
        const rx = w / 2 - r - lineWidth;
        const ry = cy - r - lineWidth;
        const ellipse = (a0, a1) => {
            cr.save();
            cr.translate(cx, cy);
            cr.scale(rx, ry);
            cr.newSubPath();
            cr.arc(0, 0, 1, a0, a1);
            cr.restore();
        };

        cr.setSourceRGBA(...track);
        cr.setLineWidth(1);
        cr.moveTo(0, Math.round(cy) + 0.5);
        cr.lineTo(w, Math.round(cy) + 0.5);
        cr.stroke();

        cr.setLineWidth(lineWidth);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setDash([lineWidth * 1.2, lineWidth * 2.2], 0);
        ellipse(Math.PI, 2 * Math.PI);
        cr.stroke();
        cr.setDash([], 0);

        const s = this._state;
        if (s) {
            const angle = Math.PI + Math.PI * s.progress;
            const px = cx + rx * Math.cos(angle);
            const py = cy + ry * Math.sin(angle);
            if (s.isDay) {
                cr.setSourceRGBA(sun[0], sun[1], sun[2], 0.85);
                ellipse(Math.PI, angle);
                cr.stroke();
                const glow = new Cairo.RadialGradient(px, py, r * 0.6, px, py, r * 3);
                glow.addColorStopRGBA(0, sun[0], sun[1], sun[2], 0.45);
                glow.addColorStopRGBA(1, sun[0], sun[1], sun[2], 0);
                cr.setSource(glow);
                cr.arc(px, py, r * 3, 0, 2 * Math.PI);
                cr.fill();
                cr.setSourceRGBA(...sun);
                cr.arc(px, py, r, 0, 2 * Math.PI);
                cr.fill();
            } else {
                cr.setSourceRGBA(moonLit[0], moonLit[1], moonLit[2], 0.35);
                ellipse(Math.PI, angle);
                cr.stroke();
                drawMoon(cr, px, py, r * 1.05, s.moon, moonLit, moonDark);
            }
        }
        cr.$dispose();
    }
});

/** Eight bars, one per 15 minutes, showing the expected precipitation. */
const RainBars = GObject.registerClass(
class SysWeatherRainBars extends St.DrawingArea {
    _init() {
        super._init({style_class: 'sw-rain-bars', y_align: Clutter.ActorAlign.CENTER});
        this._bars = [];
    }

    setBars(bars) {
        this._bars = bars;
        this.queue_repaint();
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const node = this.get_theme_node();
        const track = themeColor(node, '-sw-track', [1, 1, 1, 0.12]);
        const rain = themeColor(node, '-sw-rain', [0.22, 0.74, 0.97, 1]);
        const n = NOWCAST_SLOTS;
        const gap = Math.max(1, w * 0.025);
        const bw = (w - gap * (n - 1)) / n;
        for (let i = 0; i < n; i++) {
            const mm = this._bars[i] ?? 0;
            const frac = Math.min(1, Math.sqrt(mm / 2));
            const bh = Math.max(h * 0.14, h * frac);
            const x = i * (bw + gap);
            if (mm >= 0.05)
                cr.setSourceRGBA(rain[0], rain[1], rain[2], 0.45 + 0.55 * frac);
            else
                cr.setSourceRGBA(...track);
            roundedRect(cr, x, h - bh, bw, bh, Math.min(bw, bh) / 3);
            cr.fill();
        }
        cr.$dispose();
    }
});

/** A labelled usage meter: "Memory ........ 6.2 / 15.5 GB" plus a bar. */
class Meter {
    constructor(title) {
        this.actor = box(true, {style_class: 'sw-meter', x_expand: true});
        const row = box(false, {x_expand: true});
        row.add_child(label('sw-meter-title', {text: title, x_expand: true}));
        this._value = label('sw-meter-value');
        this._percent = label('sw-meter-percent');
        row.add_child(this._value);
        row.add_child(this._percent);
        this.actor.add_child(row);
        this._bar = new Bar();
        this.actor.add_child(this._bar);
    }

    update(used, total) {
        this.actor.visible = total > 0;
        if (total <= 0)
            return;
        const percent = 100 * used / total;
        this._value.text = `${formatBytes(used)} / ${formatBytes(total)}`;
        this._percent.text = `${Math.round(percent)}%`;
        this._bar.setPercent(percent);
    }
}

/** A small caption/value pair used in the bottom grid. */
class Tile {
    constructor(caption) {
        this.actor = box(true, {style_class: 'sw-tile', x_expand: true});
        this._caption = label('sw-tile-caption', {text: caption});
        this._value = label('sw-tile-value', {text: '–'});
        this.actor.add_child(this._caption);
        this.actor.add_child(this._value);
    }

    set(value, caption = null, level = null) {
        this._value.text = value;
        if (caption !== null)
            this._caption.text = caption;
        if (level !== null)
            this.actor.style_class = `sw-tile ${level === 'none' ? '' : `sw-level-${level}`}`.trim();
    }
}

export const DesktopWidget = GObject.registerClass(
class SysWeatherDesktopWidget extends St.Widget {
    _init() {
        super._init({
            style_class: 'sysweather-widget sw-dark',
            layout_manager: new Clutter.BinLayout(),
            reactive: false,
        });
        this._units = 'metric';
        this._appearance = {theme: 'dark', opacity: 55, scale: 100, sky: true, columns: 1};
        this._sections = {};
        this._weatherData = null;
        this._weatherKind = 'cloud';
        this._location = null;
        this._air = null;
        this._quakes = null;
        this._quakeOptions = {radius: 100, minMagnitude: 2.5};
        this._space = null;
        this._iss = null;
        this._networkData = null;
        this._publicIp = null;
        this._latency = [];
        this._latencyHost = '';
        this._alert = null;
        this._securityData = null;
        this._processes = null;
        this._gpu = null;
        this._kev = null;
        this._cert = null;
        this._clockSourceId = 0;
        // actors with a hover popup: actor -> () => {title, body, link?} | null
        this._hotspots = new Map();
        this._securityDetails = {};

        this._sky = new Sky();
        this.add_child(this._sky);
        this._content = box(true, {style_class: 'sw-content', x_expand: true, y_expand: true});
        this.add_child(this._content);

        this._buildHeader();
        // the sections live in one or two columns (see setAppearance)
        this._columnsRow = box(false, {style_class: 'sw-columns', x_expand: true});
        this._columns = [
            box(true, {style_class: 'sw-column sw-column-left', x_expand: true}),
            box(true, {style_class: 'sw-column sw-column-right', x_expand: true, visible: false}),
        ];
        this._columns.forEach(c => this._columnsRow.add_child(c));
        this._content.add_child(this._columnsRow);
        this._buildWeather();
        this._buildSystem();
        this._buildDetails();
        this._buildNetwork();
        this._buildSecurity();
        this._buildFeeds();
        this._placeSections(1);
        this.connect('destroy', () => this._stopClock());
    }

    /** Distributes the sections over one or two columns. */
    _placeSections(columns) {
        const left = [this._weather, this._feeds];
        const right = [this._system, this._details, this._network, this._security];
        const target = columns === 2 ? [left, right] : [[...left, ...right], []];
        this._columns.forEach((column, i) => {
            column.remove_all_children();
            target[i].forEach(section => column.add_child(section));
            column.visible = target[i].length > 0;
        });
        this._columns[1].visible = columns === 2;
        this._sectionColumns = columns;
        this._syncSectionBorders();
    }

    /** The first visible section of a column needs no separator above it. */
    _syncSectionBorders() {
        for (const column of this._columns) {
            let first = true;
            for (const section of column.get_children()) {
                if (!section.visible)
                    continue;
                if (first)
                    section.add_style_class_name('sw-first');
                else
                    section.remove_style_class_name('sw-first');
                first = false;
            }
        }
    }

    // ---- construction -------------------------------------------------

    _buildHeader() {
        this._header = box(true, {style_class: 'sw-header'});
        const row = box(false);
        this._host = label('sw-host', {x_expand: true});
        this._uptime = label('sw-uptime');
        // Decorative gear: the clickable button is a separate actor managed by
        // extension.js (see DesktopSysWeatherExtension._buildGear) and is laid
        // over this icon, because nothing in the background layer gets clicks.
        this._gearMark = new St.Icon({
            style_class: 'sw-gear-mark',
            icon_name: 'emblem-system-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(this._host);
        row.add_child(this._uptime);
        row.add_child(this._gearMark);
        this._distro = label('sw-subtitle');
        this._clock = label('sw-clock', {visible: false});
        this._header.add_child(row);
        this._header.add_child(this._distro);
        this._header.add_child(this._clock);
        this._content.add_child(this._header);
    }

    _startClock() {
        if (this._clockSourceId)
            return;
        this._updateClock();
        this._clockSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateClock();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopClock() {
        if (this._clockSourceId)
            GLib.source_remove(this._clockSourceId);
        this._clockSourceId = 0;
    }

    _updateClock() {
        const unix = Math.floor(Date.now() / 1000);
        const mode = this._sections?.clockMode ?? 'local';
        const parts = [];
        if (mode === 'location')
            parts.push(clockTimeLabel(unix, this._weatherData?.timezone));
        else if (mode !== 'utc')
            parts.push(clockTimeLabel(unix));
        if (mode === 'utc' || mode === 'local-utc')
            parts.push(`UTC ${clockTimeLabel(unix, 'UTC')}`);
        parts.push(String(unix));
        this._clock.text = parts.join(' · ');
    }

    _buildWeather() {
        this._weather = box(true, {style_class: 'sw-section sw-weather'});

        const current = box(false, {style_class: 'sw-current'});
        this._weatherIcon = new St.Icon({
            style_class: 'sw-weather-icon',
            icon_name: 'weather-few-clouds-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._temperature = label('sw-temperature', {text: '--°'});
        const info = box(true, {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const cityRow = box(false, {x_align: Clutter.ActorAlign.END});
        this._locationIcon = new St.Icon({
            style_class: 'sw-location-icon',
            icon_name: 'find-location-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._city = label('sw-city');
        cityRow.add_child(this._locationIcon);
        cityRow.add_child(this._city);
        this._condition = label('sw-condition', {x_align: Clutter.ActorAlign.END});
        this._range = label('sw-range', {x_align: Clutter.ActorAlign.END});
        info.add_child(cityRow);
        info.add_child(this._condition);
        info.add_child(this._range);
        current.add_child(this._weatherIcon);
        current.add_child(this._temperature);
        current.add_child(info);
        this._weather.add_child(current);

        const chip = () => label('sw-chip', {x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        this._weatherDetails = box(false, {style_class: 'sw-chips'}, {homogeneous: true});
        this._feels = chip();
        this._humidity = chip();
        this._wind = chip();
        for (const actor of [this._feels, this._humidity, this._wind])
            this._weatherDetails.add_child(actor);
        this._weather.add_child(this._weatherDetails);

        // weather warnings in force for the region (MeteoAlarm)
        this._warningRow = box(false, {style_class: 'sw-chips sw-warnings', visible: false});
        this._warningChip = wrappingLabel('sw-chip sw-warning', {x_align: Clutter.ActorAlign.START});
        this._warningRow.add_child(this._warningChip);
        this._weather.add_child(this._warningRow);
        this._warnings = [];
        this._hotspots.set(this._warningChip, () => this._warningDetail());

        // rain in the next two hours
        this._rainRow = box(false, {style_class: 'sw-rain-row', visible: false});
        this._rainIcon = new St.Icon({
            style_class: 'sw-rain-icon sw-kind-rain',
            icon_name: 'weather-showers-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._rainText = wrappingLabel('sw-rain-text');
        this._rainBars = new RainBars();
        this._rainRow.add_child(this._rainIcon);
        this._rainRow.add_child(this._rainText);
        this._rainRow.add_child(this._rainBars);
        this._weather.add_child(this._rainRow);

        // sun arc, sunrise / sunset
        this._sunBox = box(true, {style_class: 'sw-sun'});
        this._sunArc = new SunArc();
        const sunRow = box(false, {style_class: 'sw-sun-row'});
        const sunrise = box(false);
        sunrise.add_child(new St.Icon({style_class: 'sw-sun-icon', icon_name: 'daytime-sunrise-symbolic', y_align: Clutter.ActorAlign.CENTER}));
        this._sunrise = label('sw-sun-time');
        sunrise.add_child(this._sunrise);
        this._sunCenter = label('sw-sun-center', {x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        const sunset = box(false);
        this._sunset = label('sw-sun-time');
        sunset.add_child(this._sunset);
        sunset.add_child(new St.Icon({style_class: 'sw-sun-icon', icon_name: 'daytime-sunset-symbolic', y_align: Clutter.ActorAlign.CENTER}));
        sunRow.add_child(sunrise);
        sunRow.add_child(this._sunCenter);
        sunRow.add_child(sunset);
        this._sunBox.add_child(this._sunArc);
        this._sunBox.add_child(sunRow);
        this._weather.add_child(this._sunBox);

        // air quality and UV, pollen on its own row when there is any
        this._airRow = box(false, {style_class: 'sw-chips sw-air'}, {homogeneous: true});
        this._airChip = chip();
        this._uvChip = chip();
        this._airRow.add_child(this._airChip);
        this._airRow.add_child(this._uvChip);
        this._weather.add_child(this._airRow);
        this._pollenRow = box(false, {style_class: 'sw-chips sw-pollen'}, {homogeneous: true});
        this._pollenChip = chip();
        this._pollenRow.add_child(this._pollenChip);
        this._weather.add_child(this._pollenRow);

        // space weather and the ISS
        this._spaceRow = box(false, {style_class: 'sw-chips sw-space', visible: false}, {homogeneous: true});
        this._kpChip = chip();
        this._issChip = chip();
        this._spaceRow.add_child(this._kpChip);
        this._spaceRow.add_child(this._issChip);
        this._weather.add_child(this._spaceRow);

        // tip of the day
        this._adviceRow = box(false, {style_class: 'sw-advice'});
        this._adviceRow.add_child(new St.Icon({
            style_class: 'sw-advice-icon',
            icon_name: 'dialog-information-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._advice = wrappingLabel('sw-advice-text');
        this._adviceRow.add_child(this._advice);
        this._weather.add_child(this._adviceRow);

        // the next hours, every two hours: time, icon, temperature, chance of rain
        this._hourly = box(false, {style_class: 'sw-hourly'}, {homogeneous: true});
        this._hourSlots = [];
        for (let i = 0; i < HOURLY_SLOTS; i++) {
            const col = box(true, {style_class: 'sw-hour', x_expand: true});
            const slot = {
                col,
                time: label('sw-day-name sw-hour-time', {x_align: Clutter.ActorAlign.CENTER}),
                icon: new St.Icon({style_class: 'sw-hour-icon', x_align: Clutter.ActorAlign.CENTER}),
                temp: label('sw-hour-temp', {x_align: Clutter.ActorAlign.CENTER}),
                prob: label('sw-hour-prob', {x_align: Clutter.ActorAlign.CENTER}),
            };
            for (const actor of [slot.time, slot.icon, slot.temp, slot.prob])
                col.add_child(actor);
            this._hourly.add_child(col);
            this._hourSlots.push(slot);
        }
        this._hourlyAny = false;
        this._weather.add_child(this._hourly);

        this._forecast = box(false, {style_class: 'sw-forecast'}, {homogeneous: true});
        this._forecastDays = [];
        for (let i = 0; i < FORECAST_DAYS; i++) {
            const col = box(true, {style_class: 'sw-day', x_expand: true});
            const day = {
                name: label('sw-day-name', {x_align: Clutter.ActorAlign.CENTER}),
                icon: new St.Icon({style_class: 'sw-day-icon', x_align: Clutter.ActorAlign.CENTER}),
                max: label('sw-day-max'),
                min: label('sw-day-min'),
                prob: label('sw-day-prob', {x_align: Clutter.ActorAlign.CENTER}),
            };
            const temps = box(false, {x_align: Clutter.ActorAlign.CENTER});
            temps.add_child(day.max);
            temps.add_child(day.min);
            col.add_child(day.name);
            col.add_child(day.icon);
            col.add_child(temps);
            col.add_child(day.prob);
            this._forecast.add_child(col);
            this._forecastDays.push(day);
        }
        this._weather.add_child(this._forecast);

        // recent earthquakes
        this._quakeBox = box(true, {style_class: 'sw-quakes', visible: false});
        this._quakeCaption = label('sw-tile-caption');
        const quakeRow = box(false, {style_class: 'sw-quake-row'});
        this._quakeMag = label('sw-mag');
        this._quakeText = wrappingLabel('sw-quake-text');
        quakeRow.add_child(this._quakeMag);
        quakeRow.add_child(this._quakeText);
        this._quakeBox.add_child(this._quakeCaption);
        this._quakeBox.add_child(quakeRow);
        this._weather.add_child(this._quakeBox);

        this._weatherStatus = label('sw-status', {x_align: Clutter.ActorAlign.END});
        this._weather.add_child(this._weatherStatus);

        this._weatherContent = [
            current, this._weatherDetails, this._warningRow, this._rainRow, this._sunBox, this._airRow,
            this._pollenRow, this._spaceRow, this._adviceRow, this._hourly, this._forecast, this._quakeBox,
        ];
        this.setWeatherMessage(_('Locating…'));
    }

    _buildSystem() {
        this._system = box(true, {style_class: 'sw-section sw-system'});

        const cpuRow = box(false, {style_class: 'sw-cpu-row'});
        cpuRow.add_child(label('sw-meter-title', {text: _('CPU'), x_expand: true}));
        this._cpuTemp = label('sw-temp-chip');
        this._cpuValue = label('sw-cpu-value');
        cpuRow.add_child(this._cpuTemp);
        cpuRow.add_child(this._cpuValue);
        this._system.add_child(cpuRow);

        this._sparkline = new Sparkline();
        this._system.add_child(this._sparkline);

        this._memory = new Meter(_('Memory'));
        this._swap = new Meter(_('Swap'));
        this._disk = new Meter(_('Disk'));
        // only shown when /home is a file system of its own
        this._home = new Meter(_('Home'));
        for (const meter of [this._memory, this._swap, this._disk, this._home])
            this._system.add_child(meter.actor);
    }

    _buildDetails() {
        this._grid = new Clutter.GridLayout({column_homogeneous: true});
        this._details = new St.Widget({style_class: 'sw-section sw-details', layout_manager: this._grid});
        this._tiles = {
            down: new Tile(_('Download')),
            up: new Tile(_('Upload')),
            load: new Tile(_('CPU load')),
            gpu: new Tile(_('GPU')),
            vram: new Tile(_('VRAM')),
            fan: new Tile(_('Fan')),
            battery: new Tile(_('Battery')),
        };
        this._tileLayout = '';
    }

    _layoutTiles(visibleKeys) {
        const key = visibleKeys.join(',');
        if (key === this._tileLayout)
            return;
        this._tileLayout = key;
        this._details.remove_all_children();
        const columns = 3;
        visibleKeys.forEach((name, i) =>
            this._grid.attach(this._tiles[name].actor, i % columns, Math.floor(i / columns), 1, 1));
    }

    _buildNetwork() {
        this._network = box(true, {style_class: 'sw-section sw-network'});

        const head = sectionTitle('network-wireless-symbolic', _('Network'));
        this._networkIcon = head.get_first_child();
        this._vpnChip = label('sw-chip sw-vpn', {visible: false});
        head.add_child(this._vpnChip);
        this._network.add_child(head);

        const ipRow = box(false, {style_class: 'sw-ip-row'});
        this._publicIpLabel = label('sw-ip', {text: '–'});
        this._publicIpOrg = label('sw-subtitle sw-ip-org', {x_expand: true, x_align: Clutter.ActorAlign.END});
        ipRow.add_child(this._publicIpLabel);
        ipRow.add_child(this._publicIpOrg);
        this._network.add_child(ipRow);

        this._alertChip = label('sw-chip sw-alert', {visible: false, x_align: Clutter.ActorAlign.START});
        this._network.add_child(this._alertChip);

        this._linkRow = box(false, {style_class: 'sw-chips sw-link-row'});
        this._linkChip = label('sw-chip', {x_expand: true});
        this._signalChip = label('sw-chip sw-signal');
        this._linkRow.add_child(this._linkChip);
        this._linkRow.add_child(this._signalChip);
        this._network.add_child(this._linkRow);

        this._netGrid = new Clutter.GridLayout({column_homogeneous: true});
        const tiles = new St.Widget({style_class: 'sw-net-tiles', layout_manager: this._netGrid});
        this._netTiles = {
            ip: new Tile(_('Local IP')),
            gateway: new Tile(_('Gateway')),
            dns: new Tile(_('DNS')),
            iface: new Tile(_('Interface')),
        };
        ['ip', 'gateway', 'dns', 'iface'].forEach((name, i) =>
            this._netGrid.attach(this._netTiles[name].actor, i % 2, Math.floor(i / 2), 1, 1));
        this._network.add_child(tiles);

        // devices seen on the local network, with the list in the hover popup
        this._lanRow = box(false, {style_class: 'sw-chips sw-lan-row', visible: false});
        this._lanChip = label('sw-chip sw-lan', {x_align: Clutter.ActorAlign.START});
        this._lanRow.add_child(this._lanChip);
        this._network.add_child(this._lanRow);
        this._lanDetail = null;
        this._hotspots.set(this._lanChip, () => this._lanDetail);

        this._portsBox = box(true, {style_class: 'sw-ports'});
        this._portsText = wrappingLabel('sw-net-text');
        this._exposedChip = wrappingLabel('sw-chip sw-exposed', {visible: false});
        this._portsBox.add_child(this._portsText);
        this._portsBox.add_child(this._exposedChip);
        this._network.add_child(this._portsBox);

        this._latencyRow = box(false, {style_class: 'sw-latency-row'});
        this._latencySpark = new Sparkline({max: null, length: LATENCY_HISTORY, styleClass: 'sw-sparkline sw-latency-spark'});
        this._latencyText = wrappingLabel('sw-net-text', {y_align: Clutter.ActorAlign.CENTER});
        this._latencyRow.add_child(this._latencySpark);
        this._latencyRow.add_child(this._latencyText);
        this._network.add_child(this._latencyRow);
    }

    _buildSecurity() {
        this._security = box(true, {style_class: 'sw-section sw-security'});
        const head = sectionTitle('security-high-symbolic', _('Security'));
        this._securityIcon = head.get_first_child();
        this._securitySummary = label('sw-chip', {visible: false});
        head.add_child(this._securitySummary);
        this._security.add_child(head);

        // chips in a two column grid (Clutter's FlowLayout misbehaves with hidden children)
        this._securityGrid = new Clutter.GridLayout({column_homogeneous: true});
        this._securityFlow = new St.Widget({style_class: 'sw-flow', x_expand: true, layout_manager: this._securityGrid});
        this._securityChips = {};
        for (const name of ['firewall', 'updates', 'reboot', 'logins', 'remote', 'ssh', 'units', 'secureBoot', 'encrypted', 'mac', 'containers', 'users']) {
            this._securityChips[name] = label('sw-chip sw-flow-chip', {visible: false, x_expand: true});
            this._hotspots.set(this._securityChips[name], () => this._securityDetails[name] ?? null);
        }
        this._hotspots.set(this._securitySummary, () => this._securitySummaryDetail());
        this._securityLayout = '';
        this._security.add_child(this._securityFlow);

        this._processBox = box(true, {style_class: 'sw-processes', visible: false});
        const cpuRow = box(false);
        cpuRow.add_child(label('sw-proc-caption', {text: _('CPU'), y_align: Clutter.ActorAlign.START}));
        this._procCpu = wrappingLabel('sw-net-text');
        cpuRow.add_child(this._procCpu);
        const memRow = box(false);
        memRow.add_child(label('sw-proc-caption', {text: _('RAM'), y_align: Clutter.ActorAlign.START}));
        this._procMem = wrappingLabel('sw-net-text');
        memRow.add_child(this._procMem);
        this._processBox.add_child(cpuRow);
        this._processBox.add_child(memRow);
        this._security.add_child(this._processBox);
    }

    _buildFeeds() {
        this._feeds = box(true, {style_class: 'sw-section sw-feeds'});

        this._kevBox = box(true, {style_class: 'sw-kev', visible: false});
        const head = sectionTitle('dialog-warning-symbolic', 'CISA KEV');
        this._kevCaption = label('sw-tile-caption');
        head.add_child(this._kevCaption);
        this._kevBox.add_child(head);
        this._hotspots.set(head, () => this._kevSummaryDetail());
        this._kevRows = [];
        for (let i = 0; i < KEV_ROWS; i++) {
            const row = box(false, {style_class: 'sw-feed-row'});
            const id = label('sw-cve', {y_align: Clutter.ActorAlign.START});
            const text = wrappingLabel('sw-feed-text');
            row.add_child(id);
            row.add_child(text);
            this._kevBox.add_child(row);
            this._kevRows.push({row, id, text});
            this._hotspots.set(row, () => this._kevDetail(this._kev?.recent[i]));
        }
        this._feeds.add_child(this._kevBox);

        this._certBox = box(true, {style_class: 'sw-cert', visible: false});
        const certHead = sectionTitle('emblem-important-symbolic', 'CERT-AGID');
        this._certCaption = label('sw-tile-caption');
        certHead.add_child(this._certCaption);
        this._certBox.add_child(certHead);
        this._certText = wrappingLabel('sw-feed-text sw-cert-text');
        this._certBox.add_child(this._certText);
        this._feeds.add_child(this._certBox);
        this._hotspots.set(certHead, () => this._certSummaryDetail());
        this._hotspots.set(this._certText, () => this._certDetail(this._cert?.[0]));
    }

    // ---- appearance ---------------------------------------------------

    setAppearance({theme, opacity, scale, sky, columns = 1}) {
        for (const t of Object.values(THEMES))
            this.remove_style_class_name(t.className);
        const def = THEMES[theme] ?? THEMES.dark;
        const {className, rgb} = def;
        this.add_style_class_name(className);
        if (columns === 2)
            this.add_style_class_name('sw-double');
        else
            this.remove_style_class_name('sw-double');
        this._appearance = {theme: THEMES[theme] ? theme : 'dark', opacity, scale, sky, columns};
        const background = sky
            ? 'background-color: transparent;'
            : `background-color: rgba(${rgb.join(', ')}, ${this._alpha().toFixed(2)});`;
        this.set_style(`font-size: ${(10.5 * scale / 100).toFixed(2)}pt;${background}`);
        this._sky.visible = sky;
        this._sparkline.setBlocks(def.mono === true);
        this._latencySpark.setBlocks(def.mono === true);
        if (columns !== this._sectionColumns)
            this._placeSections(columns);
        this._updateTimeDependent();
    }

    /** Card opacity 0..1, honouring the theme's minimum. */
    _alpha() {
        const opacity = this._appearance.opacity / 100;
        const floor = THEMES[this._appearance.theme].alphaFloor ?? 0;
        return floor + (1 - floor) * opacity;
    }

    setSections(sections) {
        this._sections = sections;
        this._header.visible = sections.header;
        this._clock.visible = sections.header && sections.clock === true;
        if (this._clock.visible) {
            this._updateClock();
            this._startClock();
        } else {
            this._stopClock();
        }
        this._weather.visible = sections.weather;
        this._system.visible = sections.system;
        this._details.visible = sections.details;
        this._network.visible = sections.network === true;
        this._portsBox.visible = sections.ports !== false;
        this._latencyRow.visible = sections.latency !== false;
        this._security.visible = sections.security === true || sections.processes === true;
        this._securityFlow.visible = sections.security === true;
        this._processBox.visible = sections.processes === true && this._processes !== null;
        this._applyFeedVisibility();
        this._applyWeatherVisibility();
        this._syncSectionBorders();
    }

    _applyWeatherVisibility() {
        const s = this._sections;
        const has = this._hasWeather;
        this._forecast.visible = has && s.forecast !== false;
        this._hourly.visible = has && s.hourly !== false && this._hourlyAny;
        this._sunBox.visible = has && s.sun !== false;
        this._airRow.visible = has && s.air !== false && this._air !== null;
        this._pollenRow.visible = this._airRow.visible && Boolean(this._air?.pollen?.name);
        this._adviceRow.visible = has && s.advice !== false;
        this._rainRow.visible = has && s.rain !== false && this._nowcastActive === true;
        this._warningRow.visible = has && s.alerts !== false && this._warnings.length > 0;
        this._quakeBox.visible = has && s.quakes !== false && this._quakes !== null;
        this._spaceRow.visible = has && s.space === true && (this._kpChip.visible || this._issChip.visible);
    }

    _applyFeedVisibility() {
        const s = this._sections;
        this._kevBox.visible = s.feeds === true && this._kev !== null;
        this._certBox.visible = s.certAgid === true && this._cert !== null && this._cert.length > 0;
        this._feeds.visible = this._kevBox.visible || this._certBox.visible;
    }

    /**
     * Where the settings button should be drawn, in stage coordinates.
     *
     * @returns {{x: number, y: number, width: number, height: number}|null}
     *   the gear mark's rectangle, or null when the header is hidden
     */
    gearRect() {
        if (!this._header.visible || !this._gearMark.mapped)
            return null;
        const [x, y] = this._gearMark.get_transformed_position();
        const [width, height] = this._gearMark.get_transformed_size();
        return {x, y, width, height};
    }

    /**
     * Fallback anchor used when the header is hidden: the top right corner of
     * the content box, in stage coordinates.
     *
     * @returns {{x: number, y: number}}
     */
    contentCorner() {
        const node = this._content.get_theme_node();
        const [x, y] = this._content.get_transformed_position();
        return {
            x: x + this._content.width - node.get_padding(St.Side.RIGHT),
            y: y + node.get_padding(St.Side.TOP),
        };
    }

    /**
     * The hover popup for the given stage point, if a chip or feed row with
     * details is drawn there.
     *
     * @param {number} x stage x
     * @param {number} y stage y
     * @returns {{actor: Clutter.Actor, rect: object, title: string, body: string, link?: string}|null}
     */
    hotspotAt(x, y) {
        for (const [actor, detail] of this._hotspots) {
            if (!actor.mapped || !actor.visible)
                continue;
            const [ax, ay] = actor.get_transformed_position();
            const [width, height] = actor.get_transformed_size();
            if (x < ax || x >= ax + width || y < ay || y >= ay + height)
                continue;
            const info = detail();
            if (!info)
                continue;
            return {actor, rect: {x: ax, y: ay, width, height}, ...info};
        }
        return null;
    }

    // ---- data ---------------------------------------------------------

    _temp(value) {
        return `${Math.round(value)}°`;
    }

    get hasWeather() {
        return this._hasWeather;
    }

    get publicIp() {
        return this._publicIp;
    }

    setWeatherStatus(text) {
        this._weatherStatus.text = text;
    }

    setWeatherMessage(text) {
        this._hasWeather = false;
        for (const actor of this._weatherContent)
            actor.visible = false;
        this._weatherStatus.text = text;
    }

    /**
     * @param {object} data the Open-Meteo forecast
     * @param {string} placeName the place name to show
     * @param {string} units "metric" or "imperial"
     * @param {object} [location] {source: 'system'|'ip'|'manual', accuracy: metres}
     */
    setWeather(data, placeName, units, location = {}) {
        const cur = data.current;
        const daily = data.daily;
        const info = weatherInfo(cur.weather_code, cur.is_day === 1);
        const windUnit = units === 'imperial' ? 'mph' : 'km/h';
        this._weatherData = data;
        this._weatherKind = info.kind;
        this._units = units;
        if (Number.isFinite(location.latitude) && Number.isFinite(location.longitude))
            this._location = {latitude: location.latitude, longitude: location.longitude};

        this._weatherIcon.icon_name = info.icon;
        this._weatherIcon.style_class = `sw-weather-icon sw-kind-${info.kind}`;
        this._temperature.text = this._temp(cur.temperature_2m);
        this._city.text = placeName;
        this._locationIcon.visible = location.source === 'system' && (location.accuracy ?? Infinity) <= 5000;
        this._condition.text = info.text;
        this._range.text = fmt(_('Max %s · Min %s'),
            this._temp(daily.temperature_2m_max[0]), this._temp(daily.temperature_2m_min[0]));

        this._feels.text = fmt(_('Feels %s'), this._temp(cur.apparent_temperature));
        this._humidity.text = fmt(_('Humidity %s'), `${Math.round(cur.relative_humidity_2m)}%`);
        this._wind.text = fmt(_('Wind %s'), `${Math.round(cur.wind_speed_10m)} ${windUnit}`);

        this._forecastDays.forEach((day, i) => {
            const idx = i + 1;
            if (idx >= daily.time.length) {
                day.name.get_parent().visible = false;
                return;
            }
            day.name.get_parent().visible = true;
            const [y, m, d] = daily.time[idx].split('-').map(Number);
            const dayInfo = weatherInfo(daily.weather_code[idx], true);
            day.name.text = weekdayLabel(y, m, d);
            day.icon.icon_name = dayInfo.icon;
            day.icon.style_class = `sw-day-icon sw-kind-${dayInfo.kind}`;
            day.max.text = this._temp(daily.temperature_2m_max[idx]);
            day.min.text = this._temp(daily.temperature_2m_min[idx]);
            // chance of rain for the day; a non-breaking space keeps the columns aligned
            const prob = daily.precipitation_probability_max?.[idx];
            day.prob.text = Number.isFinite(prob) && prob >= 20 ? `${Math.round(prob)}%` : ' ';
        });

        this._hasWeather = true;
        for (const actor of this._weatherContent)
            actor.visible = true;
        const time = nowLabel();
        let source = '';
        if (location.source === 'system') {
            source = _('system location');
            if ((location.accuracy ?? 0) >= 1000)
                source += ` ±${Math.round(location.accuracy / 1000)} km`;
        } else if (location.source === 'ip') {
            source = _('IP location');
        }
        this._weatherStatus.text = source ? fmt(_('Updated %s · %s'), time, source) : fmt(_('Updated %s'), time);
        this._updateTimeDependent();
    }

    /**
     * @param {object|null} current the Open-Meteo air quality "current" block
     */
    setAir(current) {
        this._air = airInfo(current);
        const level = (actor, lvl) => {
            actor.style_class = `sw-chip sw-level-${lvl}`;
        };
        if (this._air) {
            this._airChip.text = this._air.text;
            level(this._airChip, this._air.level);
            const uv = Number.isFinite(current.uv_index) ? current.uv_index : this._weatherData?.current?.uv_index;
            if (Number.isFinite(uv)) {
                const u = uvInfo(uv, this._weatherData?.daily?.uv_index_max?.[0] ?? null);
                this._uvChip.text = u.text;
                level(this._uvChip, u.level);
                this._uvChip.visible = true;
            } else {
                this._uvChip.visible = false;
            }
            if (this._air.pollen?.name) {
                this._pollenChip.text = this._air.pollen.text;
                level(this._pollenChip, this._air.pollen.level);
            }
        }
        this._updateTimeDependent();
    }

    /**
     * @param {object[]} warnings the MeteoAlarm warnings for the user's region
     *   (see FeedClient.weatherWarnings), an empty list when there are none
     */
    setWeatherWarnings(warnings) {
        const now = Date.now() / 1000;
        this._warnings = (warnings ?? [])
            .map(w => ({...w, info: warningInfo(w)}))
            .sort((a, b) => b.info.rank - a.info.rank || (a.expires ?? Infinity) - (b.expires ?? Infinity));
        const top = this._warnings[0];
        if (top) {
            const parts = [`⚠ ${top.info.text}`];
            if (top.onset && top.onset > now)
                parts.push(fmt(_('from %s'), whenLabel(top.onset)));
            else if (top.expires)
                parts.push(fmt(_('until %s'), whenLabel(top.expires)));
            if (this._warnings.length > 1)
                parts.push(`+${this._warnings.length - 1}`);
            setChip(this._warningChip, parts.join(' · '), top.info.level, 'sw-warning');
        }
        this._applyWeatherVisibility();
    }

    _warningDetail() {
        if (!this._warnings.length)
            return null;
        const now = Date.now() / 1000;
        const lines = this._warnings.map(w => {
            const when = [];
            if (w.onset && w.onset > now)
                when.push(fmt(_('from %s'), formatDate(w.onset)));
            if (w.expires)
                when.push(fmt(_('until %s'), formatDate(w.expires)));
            return `• ${w.info.text} · ${w.area}${when.length ? ` · ${when.join(' ')}` : ''}`;
        });
        lines.push('', _('Issued by the national weather service and relayed by MeteoAlarm. Click for the details.'));
        return {title: _('Weather warnings'), body: lines.join('\n'), link: this._warnings[0].link};
    }

    /**
     * @param {{list: object[], source: string}|null} quakes result of WeatherClient.earthquakes
     * @param {{radius: number, minMagnitude: number}} options the search parameters
     */
    setQuakes(quakes, options) {
        this._quakes = quakes;
        this._quakeOptions = options;
        this._updateTimeDependent();
    }

    /** Refreshes everything that depends on the clock; call once a minute. */
    tick() {
        this._updateTimeDependent();
    }

    _updateTimeDependent() {
        const now = Date.now() / 1000;
        const data = this._weatherData;
        const sun = data ? sunState(data, now) : null;
        this._updateSky(sun, now);
        this._updateClockIndependent(now);
        if (!data || !this._hasWeather) {
            this._applyWeatherVisibility();
            return;
        }

        // sun and moon
        if (sun) {
            const moon = moonPhase(now);
            this._sunArc.setState({isDay: sun.isDay, progress: sun.progress, moon});
            this._sunrise.text = sun.sunriseLabel;
            this._sunset.text = sun.sunsetLabel;
            if (sun.polar && sun.isDay)
                this._sunCenter.text = _('Midnight sun');
            else if (sun.isDay) {
                this._sunCenter.text = fmt(_('Sunset in %s'), formatDuration(sun.end - now));
            } else {
                const next = nextMoonLabel(moon);
                this._sunCenter.text = `${moon.name} · ${Math.round(moon.illumination * 100)}%${next ? ` · ${next}` : ''}`;
            }
        }

        // rain nowcast
        const nowcast = rainNowcast(data, now);
        this._nowcastActive = nowcast?.active === true;
        if (nowcast?.active) {
            this._rainText.text = nowcast.text;
            this._rainBars.setBars(nowcast.bars);
            const snow = /snow/i.test(nowcast.text) || this._weatherKind === 'snow';
            this._rainIcon.icon_name = snow ? 'weather-snow-symbolic' : 'weather-showers-symbolic';
            this._rainIcon.style_class = `sw-rain-icon sw-kind-${snow ? 'snow' : 'rain'}`;
        }

        // advice
        this._advice.text = dailyAdvice({data, air: this._air, sun, now, units: this._units});

        this._updateHourly(data, now);

        // space weather and the ISS
        const kp = kpInfo(this._space);
        this._kpChip.visible = kp !== null;
        if (kp)
            setChip(this._kpChip, kp.text, kp.level);
        if (this._iss && this._location && now - this._iss.time < 20 * 60) {
            const iss = issInfo(this._iss, this._location.latitude, this._location.longitude, sun ? !sun.isDay : false);
            setChip(this._issChip, iss.text, iss.level);
            this._issChip.visible = true;
        } else {
            this._issChip.visible = false;
        }

        // earthquakes
        if (this._quakes) {
            const o = this._quakeOptions;
            this._quakeCaption.text = fmt(_('Earthquakes · %d km · 7 days · %s'), o.radius, this._quakes.source);
            const q = this._quakes.list[0];
            if (q) {
                this._quakeMag.visible = true;
                this._quakeMag.text = `M ${q.magnitude.toFixed(1)}`;
                const lvl = q.magnitude >= 4 ? 'crit' : q.magnitude >= 3 ? 'warn' : 'ok';
                this._quakeMag.style_class = `sw-mag sw-${lvl}`;
                const where = q.place || fmt(_('%d km away'), Math.round(q.distanceKm));
                this._quakeText.text = `${where} · ${timeAgo(now - q.time)}`;
            } else {
                this._quakeMag.visible = false;
                this._quakeText.text = fmt(_('No earthquakes ≥ M%s'), o.minMagnitude.toFixed(1));
            }
        }
        this._applyWeatherVisibility();
    }

    /** Fills the next hours strip from the hourly forecast, starting at the next full hour. */
    _updateHourly(data, now) {
        const h = data.hourly;
        this._hourlyAny = false;
        if (!h?.time?.length)
            return;
        const off = data.utc_offset_seconds ?? 0;
        const times = h.time.map(t => localToUnix(t, off));
        const first = times.findIndex(t => t > now);
        if (first < 0)
            return;
        let shown = 0;
        this._hourSlots.forEach((slot, i) => {
            const idx = first + i * HOURLY_STEP;
            if (idx >= times.length) {
                slot.col.visible = false;
                return;
            }
            slot.col.visible = true;
            shown++;
            const info = weatherInfo(h.weather_code?.[idx] ?? 0, (h.is_day?.[idx] ?? 1) === 1);
            slot.time.text = clockLabel(times[idx], data.timezone, {short: true});
            slot.icon.icon_name = info.icon;
            slot.icon.style_class = `sw-hour-icon sw-kind-${info.kind}`;
            const temp = h.temperature_2m?.[idx];
            slot.temp.text = Number.isFinite(temp) ? this._temp(temp) : '–';
            const prob = h.precipitation_probability?.[idx];
            // a non-breaking space keeps the columns the same height when there is no rain
            slot.prob.text = Number.isFinite(prob) && prob >= 20 ? `${Math.round(prob)}%` : ' ';
        });
        this._hourlyAny = shown > 0;
    }

    _updateClockIndependent(now) {
        if (this._alert && now > this._alert.until) {
            this._alert = null;
            this._alertChip.visible = false;
        }
        this._updateFeedAges(now);
    }

    _updateSky(sun, now) {
        const a = this._appearance;
        if (!a.sky) {
            this._sky.setState(null);
            return;
        }
        const theme = THEMES[a.theme];
        const colors = skyColors(sun, this._hasWeather ? this._weatherKind : 'cloud');
        this._sky.setState({
            top: mix(colors.top, theme.skyMix, theme.skyMixAmount),
            bottom: mix(colors.bottom, theme.skyMix, theme.skyMixAmount),
            alpha: this._alpha(),
            stars: a.theme === 'light' ? colors.stars * 0.5 : colors.stars,
            glow: colors.glow,
            glowRight: colors.glowRight,
            precip: this._hasWeather ? colors.precip : null,
            minute: Math.floor(now / 60),
            scanlines: theme.mono === true,
        });
    }

    // ---- space ----------------------------------------------------------

    /**
     * @param {object|null} space result of FeedClient.spaceWeather()
     */
    setSpace(space) {
        this._space = space;
        this._updateTimeDependent();
    }

    /**
     * @param {object|null} iss result of FeedClient.iss()
     */
    setIss(iss) {
        this._iss = iss;
        this._updateTimeDependent();
    }

    /**
     * @param {object|null} gpu result of GpuMonitor.sample(); shown at the next system sample
     */
    setGpu(gpu) {
        this._gpu = gpu;
    }

    // ---- network --------------------------------------------------------

    /**
     * @param {object} net result of NetworkMonitor.sample()
     */
    setNetwork(net) {
        this._networkData = net;
        const primary = net.primary;
        const wifi = primary?.wifi;
        this._networkIcon.icon_name = primary?.type === 'wifi' ? 'network-wireless-symbolic'
            : primary?.type === 'wired' ? 'network-wired-symbolic' : 'network-offline-symbolic';

        if (net.vpn) {
            setChip(this._vpnChip, `VPN · ${net.vpn.kind === 'VPN' ? net.vpn.name : net.vpn.kind}`, 'good', 'sw-vpn');
            this._vpnChip.visible = true;
        } else {
            setChip(this._vpnChip, _('No VPN'), 'none', 'sw-vpn');
            this._vpnChip.visible = true;
        }

        if (!primary) {
            setChip(this._linkChip, net.online ? _('Connected') : _('Offline'), net.online ? 'none' : 'poor');
            this._signalChip.visible = false;
        } else if (wifi) {
            const sec = wifi.security;
            setChip(this._linkChip, `Wi-Fi ${wifi.ssid} · ${wifi.band} · ${sec.name}`, sec.secure ? 'none' : 'poor');
            setChip(this._signalChip, `${wifi.strength}%`, wifi.strength >= 60 ? 'good' : wifi.strength >= 35 ? 'moderate' : 'poor', 'sw-signal');
            this._signalChip.visible = true;
        } else {
            const kind = primary.type === 'wired' ? _('Ethernet') : primary.id;
            setChip(this._linkChip, `${kind} · ${primary.iface ?? ''}`.replace(/ · $/, ''), 'none');
            this._signalChip.visible = false;
        }

        const t = this._netTiles;
        t.ip.set(primary?.ip ?? '–', primary?.prefix ? `${_('Local IP')} /${primary.prefix}` : _('Local IP'));
        t.gateway.set(primary?.gateway ?? '–');
        const dns = primary?.dns ?? [];
        t.dns.set(dns.length ? dns[0] : '–', dns.length > 1 ? fmt(_('DNS (+%d)'), dns.length - 1) : _('DNS'));
        const ifaceText = primary?.iface
            ? `${primary.iface}${wifi?.bitrate ? ` · ${Math.round(wifi.bitrate)} Mb/s` : ''}`
            : '–';
        t.iface.set(ifaceText);

        const lan = net.lan;
        if (lan && lan.count > 0) {
            setChip(this._lanChip, nfmt('%d device on the local network', '%d devices on the local network', lan.count), 'none', 'sw-lan');
            const lines = lan.devices.slice(0, 24).map(d =>
                `${d.ip} · ${d.mac}${d.gateway ? ` · ${_('gateway')}` : ''}`);
            if (lan.devices.length > 24)
                lines.push(nfmt('+%d more', '+%d more', lan.devices.length - 24));
            this._lanDetail = {
                title: _('Devices on the local network'),
                body: `${lines.join('\n')}\n${_('From the ARP cache: only devices that talked to this computer recently are listed.')}`,
            };
            this._lanRow.visible = true;
        } else {
            this._lanRow.visible = false;
            this._lanDetail = null;
        }

        const sockets = net.sockets;
        if (sockets) {
            const exposed = sockets.listening.filter(p => p.exposed);
            this._portsText.text = `${fmt(_('%d listening'), sockets.listening.length)} · ` +
                `${nfmt('%d exposed', '%d exposed', exposed.length)} · ` +
                `${nfmt('%d connection', '%d connections', sockets.established)} ` +
                nfmt('to %d host', 'to %d hosts', sockets.hosts);
            if (exposed.length) {
                setChip(this._exposedChip, `${_('Exposed:')} ${exposed.slice(0, 8).map(p => portLabel(p.port)).join(', ')}${exposed.length > 8 ? '…' : ''}`,
                    exposed.some(p => [21, 23, 3389, 5900, 5901, 445, 139].includes(p.port)) ? 'very-poor' : 'poor', 'sw-exposed');
                this._exposedChip.visible = true;
            } else {
                this._exposedChip.visible = false;
            }
        }
        this._refreshSecuritySummary();
    }

    /**
     * @param {{ip: string, org: string|null, country: string|null}|null} info the public address
     */
    setPublicIp(info, mask = this._maskPublicIp === true) {
        this._publicIp = info;
        this._maskPublicIp = mask;
        if (!info) {
            this._publicIpLabel.text = '–';
            this._publicIpOrg.text = _('Public IP unavailable');
            return;
        }
        let ip = info.ip;
        if (mask) {
            ip = ip.includes(':')
                ? `${ip.split(':').slice(0, 2).join(':')}:•••`
                : `${ip.split('.').slice(0, 2).join('.')}.•.•`;
        }
        this._publicIpLabel.text = ip;
        this._publicIpOrg.text = [info.org, info.country].filter(Boolean).join(' · ');
    }

    /**
     * Shows a transient warning in the network section (VPN dropped, IP changed).
     *
     * @param {string|null} text the message, null clears it
     * @param {string} [level] chip level
     */
    setNetworkAlert(text, level = 'poor') {
        if (!text) {
            this._alert = null;
            this._alertChip.visible = false;
            return;
        }
        this._alert = {until: Date.now() / 1000 + ALERT_SECONDS};
        setChip(this._alertChip, `${text} · ${nowLabel()}`, level, 'sw-alert');
        this._alertChip.visible = true;
    }

    /**
     * @param {number|null} ms a latency probe result, null when it failed
     * @param {string} host the probed host
     */
    pushLatency(ms, host) {
        this._latencyHost = host;
        this._latency.push(ms);
        if (this._latency.length > LATENCY_HISTORY)
            this._latency.shift();
        this._latencySpark.push(ms);
        const window = this._latency.slice(-LATENCY_LOSS_WINDOW);
        const lost = window.filter(v => v === null).length;
        const loss = Math.round(100 * lost / window.length);
        const known = window.filter(v => v !== null);
        const last = ms !== null ? ms : known.length ? known[known.length - 1] : null;
        if (last === null) {
            this._latencyText.text = fmt(_('%s unreachable'), host);
            return;
        }
        const avg = known.reduce((a, b) => a + b, 0) / known.length;
        const parts = [host, fmt(_('%d ms'), Math.round(last))];
        if (known.length >= 3)
            parts.push(fmt(_('avg %d'), Math.round(avg)));
        parts.push(fmt(_('%d%% loss'), loss));
        this._latencyText.text = parts.join(' · ');
    }

    // ---- security -------------------------------------------------------

    /**
     * @param {object} sec result of SecurityMonitor.sample()
     */
    setSecurity(sec) {
        this._securityData = sec;
        const c = this._securityChips;
        const details = {};
        const show = (name, text, level, detail = null) => {
            setChip(c[name], text, level, 'sw-flow-chip');
            c[name].visible = true;
            details[name] = detail;
        };
        const hide = name => {
            c[name].visible = false;
        };
        const list = (items, limit) => (items.length > limit
            ? [...items.slice(0, limit), nfmt('+%d more', '+%d more', items.length - limit)]
            : items);

        if (sec.firewall) {
            const {name, active, incoming, outgoing} = sec.firewall;
            const policies = incoming
                ? `\n${fmt(_('Default policy · incoming %s · outgoing %s'), incoming, outgoing ?? '?')}`
                : '';
            show('firewall', active ? fmt(_('Firewall %s'), name) : fmt(_('Firewall %s off'), name),
                active ? 'good' : 'poor', {
                    title: fmt(_('Firewall %s'), name),
                    body: active
                        ? `${_('Active: unsolicited incoming connections are filtered.')}${policies}`
                        : _('Installed but not enabled: every listening port is reachable from the network. Enable it with "sudo ufw enable" or from the firewall settings.'),
                });
        } else {
            show('firewall', _('No firewall'), 'moderate', {
                title: _('No firewall'),
                body: _('No ufw, firewalld or nftables service found: listening ports are reachable from the local network unless the router blocks them.'),
            });
        }

        if (sec.updates) {
            const {total, security, packages, lastUpgrade} = sec.updates;
            const flatpak = sec.updates.flatpak ?? 0;
            const lines = [];
            if (packages?.length) {
                lines.push(...list(packages.map(p => {
                    if (p.flatpak)
                        return `${p.name} · Flatpak`;
                    return p.security ? `${p.name} · ${_('security')}` : p.name;
                }), POPUP_PACKAGES));
            } else if (total > 0) {
                lines.push(nfmt('%d package can be upgraded.', '%d packages can be upgraded.', total));
            }
            if (lastUpgrade)
                lines.push('', fmt(_('Last upgrade: %s'), formatDate(lastUpgrade)));
            const titleParts = [nfmt('%d update pending', '%d updates pending', total), fmt(_('%d security'), security)];
            if (flatpak > 0)
                titleParts.push(fmt(_('%d Flatpak'), flatpak));
            const detail = {
                title: total === 0 ? _('System up to date') : titleParts.join(' · '),
                body: lines.join('\n') || _('No package is waiting for an upgrade.'),
            };
            const count = nfmt('%d update', '%d updates', total);
            if (total === 0)
                show('updates', _('Up to date'), 'good', detail);
            else if (security > 0)
                show('updates', `${count} · ${fmt(_('%d security'), security)}`, 'poor', detail);
            else if (total === flatpak)
                show('updates', `${count} · Flatpak`, 'moderate', detail);
            else
                show('updates', count, 'moderate', detail);
        } else {
            hide('updates');
        }

        if (sec.reboot) {
            const {packages, kernel, running} = sec.reboot;
            const lines = [];
            if (kernel)
                lines.push(fmt(_('Kernel %s is installed but %s is still running.'), kernel, running));
            if (packages.length)
                lines.push(fmt(_('Updated packages: %s'), list(packages, 8).join(', ')));
            if (!lines.length)
                lines.push(_('The system asked for a reboot after the last updates.'));
            show('reboot', kernel ? _('Reboot · new kernel') : _('Reboot required'), 'moderate', {
                title: _('Reboot required'),
                body: `${lines.join('\n')}\n${_('Security fixes only take effect after a restart.')}`,
            });
        } else {
            hide('reboot');
        }

        const logins = sec.failedLogins;
        if (logins !== null && logins !== undefined) {
            const count = typeof logins === 'number' ? logins : logins.count;
            const lines = [];
            for (const a of logins.recent ?? []) {
                const who = a.host ? fmt(_('%s from %s'), a.user || '?', a.host) : a.user || '?';
                lines.push(`${a.time ? formatDate(a.time) : '–'} · ${a.service || '?'} · ${who}`);
            }
            if (logins.hosts?.length > 1 || logins.hosts?.[0]?.count > 1)
                lines.push('', `${_('Sources')}: ${logins.hosts.map(h => `${h.host} ×${h.count}`).join(', ')}`);
            show('logins', nfmt('%d failed login · 24 h', '%d failed logins · 24 h', count),
                count === 0 ? 'good' : count >= 5 ? 'very-poor' : 'moderate', {
                    title: nfmt('%d failed login in the last 24 hours', '%d failed logins in the last 24 hours', count) + (logins.capped ? '+' : ''),
                    body: lines.join('\n') || _('No failed authentication (login screen, sudo, SSH) in the journal.'),
                });
        } else {
            hide('logins');
        }

        if (sec.sessions) {
            const remote = sec.sessions.remote;
            const describe = ses => {
                const where = ses.remote ? fmt(_('%s from %s'), ses.user, ses.host || '?') : ses.user;
                const how = [ses.service, ses.type, ses.tty].filter(Boolean).join(' · ');
                return `${where} · ${how}${ses.since ? ` · ${fmt(_('since %s'), formatDate(ses.since))}` : ''}`;
            };
            if (remote.length) {
                show('remote', nfmt('%d remote session: %s', '%d remote sessions: %s', remote.length, [...new Set(remote.map(r => r.host))].slice(0, 3).join(', ')), 'poor', {
                    title: _('Remote sessions'),
                    body: `${remote.map(describe).join('\n')}\n${_('Someone is logged in from another machine. If it is not you, close the session and change the password.')}`,
                });
            } else {
                hide('remote');
            }
            if (sec.sessions.users > 1) {
                show('users', fmt(_('%d users logged in'), sec.sessions.users), 'moderate', {
                    title: fmt(_('%d users logged in'), sec.sessions.users),
                    body: (sec.sessions.sessions ?? []).map(describe).join('\n'),
                });
            } else {
                hide('users');
            }
        } else {
            hide('remote');
            hide('users');
        }

        if (sec.sshServer === true) {
            const cfg = sec.ssh;
            const lines = [_('The SSH server accepts remote logins on this machine.')];
            if (cfg) {
                lines.push(fmt(_('Port %s · password authentication %s · root login %s'), cfg.port,
                    cfg.passwordAuth ? _('yes') : _('no'), cfg.rootLogin));
                if (cfg.passwordAuth)
                    lines.push(_('Passwords can be brute forced: prefer keys only (PasswordAuthentication no).'));
            }
            show('ssh', _('SSH server on'), 'fair', {title: _('SSH server'), body: lines.join('\n')});
        } else {
            hide('ssh');
        }

        const units = (sec.failedUnits ?? []).map(u => (typeof u === 'string' ? {name: u, description: '', scope: ''} : u));
        if (units.length) {
            show('units', `${nfmt('%d failed unit', '%d failed units', units.length)} · ${units[0].name.replace(/\.service$/, '').slice(0, 28)}`, 'moderate', {
                title: nfmt('%d systemd unit in failed state', '%d systemd units in failed state', units.length),
                body: `${list(units.map(u => `${u.name}${u.description ? ` · ${u.description}` : ''}${u.scope === 'user' ? ` (${_('user')})` : ''}`), 8).join('\n')}\n${_('See why with: systemctl status <unit>')}`,
            });
        } else {
            show('units', _('systemd OK'), 'good', {
                title: _('systemd OK'),
                body: _('No system or user unit is in failed state.'),
            });
        }

        if (sec.secureBoot !== null) {
            show('secureBoot', sec.secureBoot ? _('Secure Boot on') : _('Secure Boot off'), sec.secureBoot ? 'good' : 'moderate', {
                title: _('Secure Boot'),
                body: sec.secureBoot
                    ? _('The firmware only runs signed bootloaders and kernels, so a bootkit cannot replace them unnoticed.')
                    : _('The firmware runs unsigned boot code: malware with root could replace the bootloader. It can be enabled in the UEFI setup if the system supports it.'),
            });
        } else {
            hide('secureBoot');
        }

        if (sec.encrypted !== null) {
            show('encrypted', sec.encrypted ? _('Disk encrypted') : _('Disk not encrypted'), sec.encrypted ? 'good' : 'moderate', {
                title: _('Disk encryption'),
                body: sec.encrypted
                    ? _('The root file system sits on a LUKS volume: without the passphrase the data is unreadable if the disk is lost or stolen.')
                    : _('The root file system is not on a LUKS volume: anyone who gets hold of the disk can read every file.'),
            });
        } else {
            hide('encrypted');
        }

        if (sec.mac) {
            const {name, active, mode} = sec.mac;
            show('mac', active ? fmt(_('%s on'), name) : fmt(_('%s off'), name), active ? 'good' : 'moderate', {
                title: name,
                body: active
                    ? fmt(_('%s confines system services and browsers with per-program profiles, limiting what a compromised program can touch.'), name) + (mode ? ` (${mode})` : '')
                    : fmt(_('%s is built into the kernel but disabled: programs run without mandatory access control.'), name) + (mode ? ` (${mode})` : ''),
            });
        } else {
            hide('mac');
        }

        if (sec.containers) {
            const parts = [];
            const lines = [];
            for (const [engine, data] of [['Docker', sec.containers.docker], ['Podman', sec.containers.podman]]) {
                if (!data)
                    continue;
                const count = typeof data === 'number' ? data : data.count;
                parts.push(`${engine} ${count}`);
                for (const ct of data.list ?? [])
                    lines.push(`${engine} · ${ct.name} · ${ct.image}${ct.ports ? ` · ${ct.ports}` : ''}`);
            }
            show('containers', fmt(_('Containers · %s'), parts.join(' · ')), 'none', {
                title: _('Running containers'),
                body: lines.join('\n') || _('No container is running.'),
            });
        } else {
            hide('containers');
        }
        this._securityDetails = details;
        this._layoutSecurityChips();
        this._refreshSecuritySummary();
    }

    _securitySummaryDetail() {
        const warnings = Object.values(this._securityChips)
            .filter(c => c.visible && /sw-level-(moderate|poor|very-poor|hazardous)/.test(c.style_class))
            .map(c => c.text);
        if (this._exposedChip.visible)
            warnings.push(this._exposedChip.text);
        if (this._linkChip.visible && /sw-level-poor/.test(this._linkChip.style_class))
            warnings.push(this._linkChip.text);
        return {
            title: _('Security summary'),
            body: warnings.length
                ? `${warnings.map(w => `• ${w}`).join('\n')}\n${_('Hover a chip for the details.')}`
                : _('Every check passed: firewall, updates, logins, sessions, systemd, Secure Boot, encryption.'),
        };
    }

    _layoutSecurityChips() {
        const visible = Object.entries(this._securityChips).filter(([, c]) => c.visible);
        const key = visible.map(([name]) => name).join(',');
        if (key === this._securityLayout)
            return;
        this._securityLayout = key;
        this._securityFlow.remove_all_children();
        visible.forEach(([, chip], i) => this._securityGrid.attach(chip, i % 2, Math.floor(i / 2), 1, 1));
    }

    _refreshSecuritySummary() {
        const chips = Object.values(this._securityChips).filter(c => c.visible);
        const bad = chips.filter(c => /sw-level-(moderate|poor|very-poor|hazardous)/.test(c.style_class)).length +
            (this._exposedChip.visible ? 1 : 0) +
            (this._linkChip.visible && /sw-level-poor/.test(this._linkChip.style_class) ? 1 : 0);
        if (chips.length === 0) {
            this._securitySummary.visible = false;
            this._securityIcon.icon_name = 'security-high-symbolic';
            return;
        }
        this._securitySummary.visible = true;
        if (bad === 0) {
            setChip(this._securitySummary, _('All good'), 'good');
            this._securityIcon.icon_name = 'security-high-symbolic';
        } else {
            setChip(this._securitySummary, nfmt('%d warning', '%d warnings', bad), bad >= 3 ? 'poor' : 'moderate');
            this._securityIcon.icon_name = bad >= 3 ? 'security-low-symbolic' : 'security-medium-symbolic';
        }
    }

    /**
     * @param {{cpu: object[], mem: object[]}|null} processes result of ProcessMonitor.sample()
     */
    setProcesses(processes) {
        if (!processes)
            return;
        this._processes = processes;
        const name = n => (n.length > 14 ? `${n.slice(0, 13)}…` : n);
        this._procCpu.text = processes.cpu.length
            ? processes.cpu.map(p => `${name(p.name)} ${p.percent.toFixed(p.percent >= 10 ? 0 : 1)}%`).join(' · ')
            : _('idle');
        this._procMem.text = processes.mem.map(p => `${name(p.name)} ${formatBytes(p.bytes)}`).join(' · ');
        this._processBox.visible = this._sections.processes === true;
        this._security.visible = this._sections.security === true || this._processBox.visible;
        this._syncSectionBorders();
    }

    // ---- feeds ----------------------------------------------------------

    /**
     * @param {object|null} kev result of FeedClient.knownExploited()
     */
    setKev(kev) {
        this._kev = kev;
        this._updateFeedAges(Date.now() / 1000);
        this._applyFeedVisibility();
        this._syncSectionBorders();
    }

    /**
     * @param {object[]|null} items result of FeedClient.certAgid()
     */
    setCertAgid(items) {
        this._cert = items;
        this._updateFeedAges(Date.now() / 1000);
        this._applyFeedVisibility();
        this._syncSectionBorders();
    }

    _updateFeedAges(now) {
        const kev = this._kev;
        if (kev) {
            this._kevCaption.text = `${nfmt('%d new this week', '%d new this week', kev.week)} · ${fmt(_('%d total'), kev.total)}`;
            this._kevRows.forEach((row, i) => {
                const v = kev.recent[i];
                row.row.visible = Boolean(v);
                if (!v)
                    return;
                row.id.text = v.id.replace(/^CVE-/, '');
                row.id.style_class = `sw-cve ${v.ransomware ? 'sw-crit' : now - v.date < 2 * 86400 ? 'sw-warn' : 'sw-ok'}`;
                const product = [v.vendor, v.product].filter((x, j, all) => x && all.indexOf(x) === j).join(' ');
                const age = now - v.date < 86400 ? _('today') : timeAgo(now - v.date);
                row.text.text = `${product} · ${age}${v.ransomware ? ` · ${_('ransomware')}` : ''}`;
            });
        }
        const cert = this._cert?.[0];
        if (cert) {
            this._certCaption.text = cert.time ? timeAgo(now - cert.time) : '';
            this._certText.text = cert.title;
        }
    }

    _kevDetail(v) {
        if (!v)
            return null;
        const now = Date.now() / 1000;
        const lines = [v.name.trim()];
        if (v.description)
            lines.push('', v.description);
        if (v.action) {
            // CISA's boilerplate for most entries, replaced by its gist
            const boilerplate = /^Apply (mitigations|updates|remediations) (per|in accordance with) (the )?vendor('s)? instructions/i.test(v.action);
            lines.push('', `${_('Required action')}: ${boilerplate
                ? _('Apply the vendor\'s updates or mitigations, or stop using the product.')
                : firstSentence(v.action)}`);
        }
        const when = [fmt(_('Added %s'), formatDate(v.date, false))];
        if (v.due)
            when.push(fmt(_('due %s'), formatDate(v.due, false)));
        lines.push('', when.join(' · '));
        if (v.ransomware)
            lines.push(_('Used in known ransomware campaigns.'));
        if (now - v.date < 2 * 86400)
            lines.push(_('Added in the last two days: patch exposed systems first.'));
        return {
            title: `${v.id} · ${[v.vendor, v.product].filter((x, j, all) => x && all.indexOf(x) === j).join(' ')}`,
            body: lines.join('\n'),
            link: v.link,
        };
    }

    _kevSummaryDetail() {
        const kev = this._kev;
        if (!kev)
            return null;
        const now = Date.now() / 1000;
        const lines = kev.recent.map(v =>
            `${v.id} · ${[v.vendor, v.product].filter((x, j, all) => x && all.indexOf(x) === j).join(' ')} · ${now - v.date < 86400 ? _('today') : timeAgo(now - v.date)}${v.ransomware ? ` · ${_('ransomware')}` : ''}`);
        lines.push('', fmt(_('Catalogue of %d vulnerabilities exploited in the wild, updated %s.'), kev.total, formatDate(kev.released, false)));
        return {title: _('CISA Known Exploited Vulnerabilities'), body: lines.join('\n'), link: KEV_CATALOGUE_URL};
    }

    _certDetail(item) {
        if (!item)
            return null;
        const lines = [];
        if (item.summary)
            lines.push(item.summary);
        if (item.time)
            lines.push('', formatDate(item.time));
        return {title: item.title, body: lines.join('\n'), link: item.link || CERT_AGID_URL};
    }

    _certSummaryDetail() {
        if (!this._cert?.length)
            return null;
        const now = Date.now() / 1000;
        const lines = this._cert.map(i => `• ${i.title}${i.time ? ` · ${timeAgo(now - i.time)}` : ''}`);
        return {title: _('CERT-AGID · latest news'), body: lines.join('\n'), link: CERT_AGID_URL};
    }

    setSystem(monitor, s, units) {
        this._host.text = monitor.hostname;
        this._distro.text = monitor.kernel ? `${monitor.distro} · Linux ${monitor.kernel}` : monitor.distro;
        if (s.uptime !== null)
            this._uptime.text = fmt(_('up %s'), formatDuration(s.uptime));

        const toUnit = c => (units === 'imperial' ? c * 9 / 5 + 32 : c);
        const tempText = c => `${Math.round(toUnit(c))}°${units === 'imperial' ? 'F' : 'C'}`;

        if (s.cpu !== null) {
            this._cpuValue.text = `${Math.round(s.cpu)}%`;
            this._sparkline.push(s.cpu);
        }
        this._cpuTemp.visible = s.cpuTemp !== null;
        if (s.cpuTemp !== null) {
            this._cpuTemp.text = tempText(s.cpuTemp);
            const heat = s.cpuTemp >= 85 ? 'crit' : s.cpuTemp >= 70 ? 'warn' : 'ok';
            this._cpuTemp.style_class = `sw-temp-chip sw-${heat}`;
        }

        this._memory.update(s.mem.used, s.mem.total);
        this._swap.update(s.swap.used, s.swap.total);
        if (s.disk)
            this._disk.update(s.disk.used, s.disk.total);
        this._home.update(s.home?.used ?? 0, s.home?.total ?? 0);

        const t = this._tiles;
        // the interface of the primary connection when the network section
        // knows it, otherwise every physical interface together
        const iface = this._networkData?.primary?.iface;
        const rate = (iface && s.net.ifaces?.[iface]) ?? s.net;
        t.down.set(`${formatBytes(rate.rx)}/s`);
        t.up.set(`${formatBytes(rate.tx)}/s`);
        if (s.load !== null) {
            // 1-minute load average: runnable (or disk-waiting) tasks, relative to the core count
            const cores = s.cores || 1;
            // shown as "load / cores" so the number is readable at a glance
            t.load.set(`${s.load.toFixed(2)} / ${cores}`, null, levelName(100 * s.load / cores));
        } else {
            t.load.set('–', null, 'none');
        }

        const visible = ['down', 'up', 'load'];
        const gpuLoad = this._gpu?.load ?? null;
        const gpuTemp = s.gpuTemp ?? this._gpu?.temp ?? null;
        if (gpuLoad !== null || gpuTemp !== null) {
            const parts = [];
            if (gpuLoad !== null)
                parts.push(`${Math.round(gpuLoad)}%`);
            if (gpuTemp !== null)
                parts.push(tempText(gpuTemp));
            const freq = this._gpu?.freq;
            t.gpu.set(parts.join(' · '), freq ? `GPU · ${freq} MHz` : _('GPU'));
            visible.push('gpu');
        }
        const vram = this._gpu?.vram;
        if (vram) {
            const percent = vram.total ? Math.round(100 * vram.used / vram.total) : null;
            t.vram.set(formatBytes(vram.used),
                percent !== null ? fmt(_('VRAM · %d%%'), percent) : _('VRAM'),
                percent !== null ? levelName(percent) : null);
            visible.push('vram');
        }
        if (s.fan !== null) {
            t.fan.set(fmt(_('%d RPM'), Math.round(s.fan)));
            visible.push('fan');
        }
        if (s.battery) {
            const {status, timeLeft} = s.battery;
            const charging = status === 'Charging' || status === 'Full';
            // "41% · 3h05" = time to empty while discharging, time to full while charging (⚡)
            const value = `${Math.round(s.battery.level)}%${timeLeft ? ` · ${compactDuration(timeLeft)}` : ''}`;
            t.battery.set(value, charging ? _('Battery ⚡') : _('Battery'));
            visible.push('battery');
        }
        this._layoutTiles(visible);
    }
});
