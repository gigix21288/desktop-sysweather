// Collects system statistics from /proc and /sys without external tools.
// Sensor paths are discovered once; periodic reads are asynchronous so that
// slow drivers (e.g. dell_smm fan readings) never block the compositor.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {deviceOf, listDir as listDirUnsorted, readFile} from './files.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'query_filesystem_info_async');

const decoder = new TextDecoder();

// hwmon chip names, in order of preference
const CPU_CHIPS = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'soc_thermal', 'acpitz'];
const CPU_LABELS = ['Package id 0', 'Tdie', 'Tctl', 'CPU'];
const GPU_CHIPS = ['amdgpu', 'radeon', 'nouveau', 'xe'];
const NVIDIA_VENDOR = '0x10de';

/** A sysfs value: the file's text without the trailing newline, null when missing. */
function readValue(path, cancellable) {
    return readFile(path, cancellable, {trim: true});
}

async function read(path, cancellable) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        return decoder.decode(bytes);
    } catch {
        return null;
    }
}

async function readNumber(path, cancellable) {
    if (!path)
        return null;
    const text = await read(path, cancellable);
    const value = text === null ? NaN : parseFloat(text);
    return Number.isFinite(value) ? value : null;
}

/** Directory entries in natural order (card1 before card10). */
async function listDir(path, cancellable) {
    const names = await listDirUnsorted(path, cancellable);
    return names.sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
}

/**
 * Whether a network interface is backed by hardware. Virtual devices (lo,
 * bridges, veth, tun/wg/tailscale tunnels…) have no "device" link in sysfs;
 * counting them would add tunnel traffic on top of the NIC carrying it.
 */
const physicalIfaces = new Map();
function isPhysicalIface(iface) {
    let physical = physicalIfaces.get(iface);
    if (physical === undefined) {
        physical = GLib.file_test(`/sys/class/net/${iface}/device`, GLib.FileTest.EXISTS);
        physicalIfaces.set(iface, physical);
    }
    return physical;
}

async function findTempInput(dir, cancellable) {
    const inputs = (await listDir(dir, cancellable)).filter(n => /^temp\d+_input$/.test(n));
    if (inputs.length === 0)
        return null;
    for (const wanted of CPU_LABELS) {
        for (const input of inputs) {
            const label = await readValue(`${dir}/${input.replace('_input', '_label')}`, cancellable);
            if (label === wanted)
                return `${dir}/${input}`;
        }
    }
    return `${dir}/${inputs[0]}`;
}

async function discoverSensors(cancellable) {
    const chips = new Map();
    const fans = [];
    for (const hw of await listDir('/sys/class/hwmon', cancellable)) {
        const dir = `/sys/class/hwmon/${hw}`;
        const name = await readValue(`${dir}/name`, cancellable);
        if (name && !chips.has(name))
            chips.set(name, dir);
        for (const entry of await listDir(dir, cancellable)) {
            if (/^fan\d+_input$/.test(entry))
                fans.push(`${dir}/${entry}`);
        }
    }

    let cpuTemp = null;
    for (const chip of CPU_CHIPS) {
        // ACPI zones are named e.g. "acpitz" or "acpitz_0"
        const dir = chips.get(chip) ??
            [...chips.entries()].find(([n]) => n.startsWith(`${chip}_`))?.[1];
        if (dir && (cpuTemp = await findTempInput(dir, cancellable)))
            break;
    }
    if (!cpuTemp) {
        for (const zone of await listDir('/sys/class/thermal', cancellable)) {
            const type = await readValue(`/sys/class/thermal/${zone}/type`, cancellable);
            if (type === 'x86_pkg_temp' || type === 'cpu-thermal') {
                cpuTemp = `/sys/class/thermal/${zone}/temp`;
                break;
            }
        }
    }

    let gpuTemp = null;
    for (const chip of GPU_CHIPS) {
        const dir = chips.get(chip);
        if (dir && (gpuTemp = await findTempInput(dir, cancellable)))
            break;
    }

    const batteries = [];
    for (const n of await listDir('/sys/class/power_supply', cancellable)) {
        const dir = `/sys/class/power_supply/${n}`;
        const [type, scope, capacity] = await Promise.all([
            readValue(`${dir}/type`, cancellable),
            readValue(`${dir}/scope`, cancellable),
            readValue(`${dir}/capacity`, cancellable),
        ]);
        if (type !== 'Battery' || scope === 'Device' || capacity === null)
            continue;
        // energy_* (µWh) with power_now (µW), or charge_* (µAh) with
        // current_now (µA): the ratio is hours either way
        const energy = await readValue(`${dir}/energy_now`, cancellable) !== null;
        const prefix = energy ? 'energy' : 'charge';
        const has = async f => (await readValue(`${dir}/${f}`, cancellable) !== null ? `${dir}/${f}` : null);
        batteries.push({
            dir,
            now: await has(`${prefix}_now`),
            full: await has(`${prefix}_full`),
            rate: await has(energy ? 'power_now' : 'current_now'),
        });
    }

    return {cpuTemp, gpuTemp, fans, batteries};
}

async function parseOsRelease(cancellable) {
    const text = await readFile('/etc/os-release', cancellable) ?? '';
    const match = text.match(/^PRETTY_NAME="?([^"\n]*)"?/m);
    return match ? match[1] : 'Linux';
}

export class SystemMonitor {
    constructor() {
        this._sensors = {cpuTemp: null, gpuTemp: null, fans: [], batteries: []};
        this._ready = null;
        this._prevCpu = null;
        this._prevNet = null;

        this.hostname = GLib.get_host_name();
        this.distro = 'Linux';
        this.kernel = '';
        this.hasBattery = false;
        this.hasFans = false;
        this.hasGpuTemp = false;
        this._separateHome = false;
    }

    /** Sensor discovery and the static facts, once, before the first sample. */
    async _init(cancellable) {
        const [sensors, distro, kernel, root, home] = await Promise.all([
            discoverSensors(cancellable),
            parseOsRelease(cancellable),
            readValue('/proc/sys/kernel/osrelease', cancellable),
            deviceOf('/', cancellable),
            deviceOf(GLib.get_home_dir(), cancellable),
        ]);
        this._sensors = sensors;
        this.distro = distro;
        this.kernel = (kernel ?? '').replace(/-generic$/, '');
        this.hasBattery = sensors.batteries.length > 0;
        this.hasFans = sensors.fans.length > 0;
        this.hasGpuTemp = sensors.gpuTemp !== null;
        this._separateHome = root !== null && home !== null && root !== home;
    }

    _cpuUsage(stat) {
        const fields = stat?.split('\n')[0].trim().split(/\s+/).slice(1, 9).map(Number);
        if (!fields || fields.length < 4)
            return null;
        const idle = fields[3] + (fields[4] ?? 0);
        const total = fields.reduce((a, b) => a + b, 0);
        const prev = this._prevCpu;
        this._prevCpu = {idle, total};
        if (!prev || total <= prev.total)
            return null;
        return 100 * (1 - (idle - prev.idle) / (total - prev.total));
    }

    _memory(meminfo) {
        const kb = key => {
            const m = meminfo?.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
            return m ? Number(m[1]) * 1024 : 0;
        };
        const total = kb('MemTotal');
        const swapTotal = kb('SwapTotal');
        return {
            mem: {used: total - kb('MemAvailable'), total},
            swap: {used: swapTotal - kb('SwapFree'), total: swapTotal},
        };
    }

    /**
     * Throughput in bytes per second: the sum over the physical interfaces
     * plus the rate of each one, so the widget can show the interface that
     * carries the primary connection on a machine with several NICs.
     *
     * @returns {{rx: number, tx: number, ifaces: Object<string, {rx: number, tx: number}>,
     *   all: Object<string, {rx: number, tx: number, physical: boolean}>}}
     *   rx/tx and ifaces cover the physical interfaces (a VPN over Wi-Fi would
     *   count twice); all lists every interface but the loopback that has
     *   carried traffic, tunnels and bridges included, for the hover panel
     */
    _network(netdev, now) {
        const counters = new Map();
        for (const line of (netdev ?? '').split('\n').slice(2)) {
            const [iface, data] = line.split(':');
            const name = iface?.trim();
            if (!data || !name || name === 'lo')
                continue;
            const cols = data.trim().split(/\s+/).map(Number);
            counters.set(name, {rx: cols[0], tx: cols[8], physical: isPhysicalIface(name)});
        }
        const prev = this._prevNet;
        this._prevNet = {counters, now};
        const result = {rx: 0, tx: 0, ifaces: {}, all: {}};
        if (!prev || now <= prev.now)
            return result;
        const seconds = (now - prev.now) / 1e6;
        for (const [name, c] of counters) {
            const p = prev.counters.get(name);
            if (!p || c.rx + c.tx === 0)
                continue;
            const rate = {rx: Math.max(0, (c.rx - p.rx) / seconds), tx: Math.max(0, (c.tx - p.tx) / seconds)};
            result.all[name] = {...rate, physical: c.physical};
            if (!c.physical)
                continue;
            result.ifaces[name] = rate;
            result.rx += rate.rx;
            result.tx += rate.tx;
        }
        return result;
    }

    async _fsUsage(path, cancellable) {
        try {
            const info = await Gio.File.new_for_path(path).query_filesystem_info_async(
                'filesystem::size,filesystem::free', GLib.PRIORITY_DEFAULT, cancellable);
            const total = info.get_attribute_uint64('filesystem::size');
            const free = info.get_attribute_uint64('filesystem::free');
            return total > 0 ? {used: total - free, total} : null;
        } catch {
            return null;
        }
    }

    _disk(cancellable) {
        return this._fsUsage('/', cancellable);
    }

    /** The home directory when it lives on its own file system (a separate /home partition). */
    _homeDisk(cancellable) {
        if (!this._separateHome)
            return Promise.resolve(null);
        return this._fsUsage(GLib.get_home_dir(), cancellable);
    }

    /**
     * All batteries combined (dual-battery laptops): the level is the total
     * stored energy over the total capacity when the driver reports it;
     * timeLeft is the estimated time to empty (discharging) or to full
     * (charging) in seconds, from the current drain/charge rate.
     *
     * @returns {Promise<{level: number, status: string, timeLeft: number|null}|null>}
     */
    async _battery(cancellable) {
        const batteries = this._sensors.batteries;
        if (!batteries.length)
            return null;
        const readings = await Promise.all(batteries.map(async b => {
            const [capacity, status, now, full, rate] = await Promise.all([
                readNumber(`${b.dir}/capacity`, cancellable),
                read(`${b.dir}/status`, cancellable),
                readNumber(b.now, cancellable),
                readNumber(b.full, cancellable),
                readNumber(b.rate, cancellable),
            ]);
            return {capacity, status: status?.trim() ?? 'Unknown', now, full, rate};
        }));
        const valid = readings.filter(r => r.capacity !== null);
        if (!valid.length)
            return null;
        let level;
        if (valid.every(r => r.now !== null && r.full > 0))
            level = 100 * valid.reduce((a, r) => a + r.now, 0) / valid.reduce((a, r) => a + r.full, 0);
        else
            level = valid.reduce((a, r) => a + r.capacity, 0) / valid.length;
        const statuses = valid.map(r => r.status);
        let status = statuses[0];
        if (statuses.includes('Charging'))
            status = 'Charging';
        else if (statuses.includes('Discharging'))
            status = 'Discharging';
        else if (statuses.every(s => s === 'Full'))
            status = 'Full';

        // the rate is the sum of the batteries that are actually (dis)charging
        let timeLeft = null;
        const moving = valid.filter(r => r.status === status && r.rate > 0 && r.now !== null);
        const rate = moving.reduce((a, r) => a + Math.abs(r.rate), 0);
        if (rate > 0 && (status === 'Discharging' || status === 'Charging')) {
            const amount = status === 'Discharging'
                ? valid.reduce((a, r) => a + (r.now ?? 0), 0)
                : valid.reduce((a, r) => a + Math.max(0, (r.full ?? 0) - (r.now ?? 0)), 0);
            const hours = amount / rate;
            // a rate read right after (un)plugging can be nonsense: ignore absurd estimates
            if (Number.isFinite(hours) && hours > 0 && hours < 48)
                timeLeft = Math.round(hours * 3600);
        }
        return {level: Math.min(100, Math.max(0, level)), status, timeLeft};
    }

    async _fanSpeed(cancellable) {
        if (!this.hasFans)
            return null;
        const speeds = await Promise.all(this._sensors.fans.map(f => readNumber(f, cancellable)));
        const valid = speeds.filter(s => s !== null);
        return valid.length ? Math.max(...valid) : null;
    }

    async _temp(path, cancellable) {
        if (!path)
            return null;
        const milli = await readNumber(path, cancellable);
        return milli === null ? null : milli / 1000;
    }

    /**
     * Takes one sample of all statistics.
     *
     * @param {Gio.Cancellable} cancellable cancels pending reads
     * @returns {Promise<object>}
     */
    async sample(cancellable) {
        this._ready ??= this._init(cancellable);
        await this._ready;
        // the counters are stamped as soon as they are read, before the slow
        // sensor reads, so the rate uses the right elapsed time
        const netdev = await read('/proc/net/dev', cancellable);
        const netTime = GLib.get_monotonic_time();
        const [stat, meminfo, uptime, loadavg, disk, home, battery, fan, cpuTemp, gpuTemp] =
            await Promise.all([
                read('/proc/stat', cancellable),
                read('/proc/meminfo', cancellable),
                read('/proc/uptime', cancellable),
                read('/proc/loadavg', cancellable),
                this._disk(cancellable),
                this._homeDisk(cancellable),
                this._battery(cancellable),
                this._fanSpeed(cancellable),
                this._temp(this._sensors.cpuTemp, cancellable),
                this._temp(this._sensors.gpuTemp, cancellable),
            ]);

        return {
            cpu: this._cpuUsage(stat),
            cpuTemp,
            gpuTemp,
            ...this._memory(meminfo),
            disk,
            home,
            net: this._network(netdev, netTime),
            uptime: uptime ? parseFloat(uptime) : null,
            load: loadavg ? parseFloat(loadavg) : null,
            cores: GLib.get_num_processors(),
            fan,
            battery,
        };
    }
}

// ---- processes ---------------------------------------------------------

const PROCESS_CHUNK = 40;
const PROCESS_NAMES = {
    'Isolated Web Co': 'firefox', 'Web Content': 'firefox', 'WebExtensions': 'firefox',
    'Privileged Cont': 'firefox', 'RDD Process': 'firefox', 'Socket Process': 'firefox',
    'Utility Process': 'firefox', 'firefox-bin': 'firefox', 'chrome': 'chrome',
    'chromium': 'chromium', 'brave': 'brave', 'WebKitWebProces': 'webkit', 'code': 'code',
    'gnome-shell': 'gnome-shell', 'Xwayland': 'Xwayland',
};

function idle() {
    return new Promise(resolve => {
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

/**
 * Ranks processes by CPU share and resident memory. /proc is scanned in
 * small chunks between main loop iterations so the compositor never stalls.
 */
export class ProcessMonitor {
    constructor() {
        this._prev = new Map();
        this._prevTotal = null;
        this._pageSize = null;
    }

    async _detectPageSize(cancellable) {
        const [statm, status] = await Promise.all([
            readValue('/proc/self/statm', cancellable),
            readValue('/proc/self/status', cancellable),
        ]);
        const pages = Number(statm?.split(/\s+/)[0]);
        const kb = Number(status?.match(/^VmSize:\s+(\d+)/m)?.[1]);
        if (pages > 0 && kb > 0) {
            const size = Math.round(kb * 1024 / pages);
            return [4096, 16384, 65536].reduce((a, b) => (Math.abs(b - size) < Math.abs(a - size) ? b : a));
        }
        return 4096;
    }

    /** comm is cut at 15 characters: recover the program name from cmdline. */
    async _fullName(pid, comm, cancellable) {
        if (comm.length < 15)
            return comm;
        const cmdline = await readValue(`/proc/${pid}/cmdline`, cancellable);
        const program = GLib.path_get_basename((cmdline ?? '').split('\0')[0]);
        return program.startsWith(comm.slice(0, 10)) ? program : comm;
    }

    /**
     * @param {Gio.Cancellable} cancellable cancels the scan
     * @returns {Promise<{cpu: Array<{name: string, percent: number}>,
     *   mem: Array<{name: string, bytes: number}>}|null>} null on the first call
     */
    async sample(cancellable) {
        this._pageSize ??= await this._detectPageSize(cancellable);
        const stat = await readValue('/proc/stat', cancellable);
        // the first 8 fields, like SystemMonitor: guest time is already counted in user/nice
        const total = stat?.split('\n')[0].trim().split(/\s+/).slice(1, 9).map(Number).reduce((a, b) => a + b, 0);
        if (!total)
            return null;
        const pids = (await listDir('/proc', cancellable)).filter(n => /^\d+$/.test(n));
        const current = new Map();
        const byName = new Map();
        for (let i = 0; i < pids.length; i += PROCESS_CHUNK) {
            const chunk = pids.slice(i, i + PROCESS_CHUNK);
            const texts = await Promise.all(chunk.map(pid => readValue(`/proc/${pid}/stat`, cancellable)));
            for (const [j, pid] of chunk.entries()) {
                const text = texts[j];
                if (!text)
                    continue;
                const open = text.indexOf('(');
                const close = text.lastIndexOf(')');
                const comm = text.slice(open + 1, close);
                const fields = text.slice(close + 2).split(' ');
                const ticks = Number(fields[11]) + Number(fields[12]);
                const rss = Number(fields[21]) * this._pageSize;
                current.set(pid, ticks);
                const name = Object.hasOwn(PROCESS_NAMES, comm) ? PROCESS_NAMES[comm] : await this._fullName(pid, comm, cancellable);
                const entry = byName.get(name) ?? {name, ticks: 0, prevTicks: 0, bytes: 0};
                entry.ticks += ticks;
                entry.prevTicks += this._prev.get(pid) ?? ticks;
                entry.bytes += rss;
                byName.set(name, entry);
            }
            if (cancellable?.is_cancelled())
                return null;
            await idle();
        }
        const prevTotal = this._prevTotal;
        this._prev = current;
        this._prevTotal = total;
        if (prevTotal === null || total <= prevTotal)
            return null;
        const elapsed = total - prevTotal;
        const list = [...byName.values()];
        const cpu = list
            .map(e => ({name: e.name, percent: 100 * Math.max(0, e.ticks - e.prevTicks) / elapsed}))
            .filter(e => e.percent >= 0.5)
            .sort((a, b) => b.percent - a.percent)
            .slice(0, 3);
        const mem = list
            .map(e => ({name: e.name, bytes: e.bytes}))
            .sort((a, b) => b.bytes - a.bytes)
            .slice(0, 3);
        return {cpu, mem};
    }
}

// ---- GPU load ------------------------------------------------------------

const GPU_RENDER_ENGINES = ['render', 'gfx', '3d', 'gpu', 'fragment', 'rcs'];
const FD_BUDGET = 400;
const MEMORY_UNITS = {'': 1, 'b': 1, 'kib': 1024, 'mib': 1024 ** 2, 'gib': 1024 ** 3, 'tib': 1024 ** 4};

/** "429728 KiB" → bytes (fdinfo memory values). */
function parseMemory(text) {
    const m = /^(\d+)\s*([a-zA-Z]*)/.exec(text);
    if (!m)
        return 0;
    return parseInt(m[1], 10) * (MEMORY_UNITS[m[2].toLowerCase()] ?? 1);
}

/**
 * GPU utilisation without privileges, from the best source available:
 *  - amdgpu's gpu_busy_percent in sysfs (whole device),
 *  - nvidia-smi for the proprietary NVIDIA driver,
 *  - otherwise the per client DRM accounting the kernel publishes in
 *    /proc/<pid>/fdinfo (i915, xe, amdgpu, panfrost, msm, v3d…), summed
 *    over the user's own processes, which is what gputop/nvtop do.
 */
export class GpuMonitor {
    constructor() {
        this._busyPath = null;
        this._vramPaths = null;
        this._freqPath = null;
        this._freqScale = 1;
        this._nvidiaPower = null;
        this._nvidiaSmi = null;
        this._nvidiaFailures = 0;
        this._prevClients = new Map();
        this._prevTime = null;
        this._fdinfoFailures = 0;
        this._ready = null;
    }

    /** Finds the sysfs files of the GPU once, before the first sample. */
    async _discover(cancellable) {
        for (const card of (await listDir('/sys/class/drm', cancellable)).filter(n => /^card\d+$/.test(n))) {
            const dir = `/sys/class/drm/${card}`;
            if (!this._nvidiaPower && await readValue(`${dir}/device/vendor`, cancellable) === NVIDIA_VENDOR)
                this._nvidiaPower = `${dir}/device/power/runtime_status`;
            if (!this._busyPath && await readValue(`${dir}/device/gpu_busy_percent`, cancellable) !== null)
                this._busyPath = `${dir}/device/gpu_busy_percent`;
            if (!this._vramPaths && await readValue(`${dir}/device/mem_info_vram_used`, cancellable) !== null)
                this._vramPaths = [`${dir}/device/mem_info_vram_used`, `${dir}/device/mem_info_vram_total`];
            if (!this._freqPath) {
                const hwmon = (await listDir(`${dir}/device/hwmon`, cancellable))[0];
                for (const [path, scale] of [
                    [`${dir}/gt_act_freq_mhz`, 1],
                    [`${dir}/gt/gt0/rps_act_freq_mhz`, 1],
                    [`${dir}/device/hwmon/${hwmon}/freq1_input`, 1e-6],
                ]) {
                    if (await readValue(path, cancellable) !== null) {
                        this._freqPath = path;
                        this._freqScale = scale;
                        break;
                    }
                }
            }
        }
        // nvidia-smi only makes sense with the proprietary driver loaded
        const nvidiaDriver = GLib.file_test('/proc/driver/nvidia/version', GLib.FileTest.EXISTS);
        this._nvidiaSmi = this._busyPath || !nvidiaDriver ? null : GLib.find_program_in_path('nvidia-smi');
    }

    /**
     * @param {Gio.Cancellable} cancellable cancels the scan
     * @returns {Promise<{load: number|null, temp: number|null, freq: number|null,
     *   vram: {used: number, total: number|null}|null, source: string}>}
     *   load in percent, temp in °C (NVIDIA only), freq in MHz, vram in bytes
     *   (total is null for integrated GPUs sharing system memory)
     */
    async sample(cancellable) {
        this._ready ??= this._discover(cancellable);
        await this._ready;
        const freq = await readNumber(this._freqPath, cancellable);
        const result = {load: null, temp: null, freq: freq === null ? null : Math.round(freq * this._freqScale), vram: null, source: 'none'};
        if (this._vramPaths) {
            const used = await readNumber(this._vramPaths[0], cancellable);
            const total = await readNumber(this._vramPaths[1], cancellable);
            if (used !== null)
                result.vram = {used, total: total || null};
        }
        if (this._busyPath) {
            result.load = await readNumber(this._busyPath, cancellable);
            result.source = 'sysfs';
            return result;
        }
        if (this._nvidiaSmi) {
            const nv = await this._nvidia(cancellable);
            if (nv) {
                Object.assign(result, nv, {source: 'nvidia'});
                return result;
            }
        }
        const fd = await this._fdinfo(cancellable);
        if (fd) {
            result.source = 'fdinfo';
            result.load = fd.load;
            if (fd.memory !== null && !result.vram)
                result.vram = {used: fd.memory, total: null};
        }
        return result;
    }

    async _nvidia(cancellable) {
        // On Optimus laptops the discrete GPU sleeps (D3cold) when unused and
        // nvidia-smi would wake it up every few seconds: report it as idle.
        if (this._nvidiaPower && await readValue(this._nvidiaPower, cancellable) === 'suspended')
            return {load: 0, temp: null, freq: null, vram: null};
        let process = null;
        try {
            process = Gio.Subprocess.new([
                this._nvidiaSmi, '--query-gpu=utilization.gpu,temperature.gpu,clocks.gr,memory.used,memory.total',
                '--format=csv,noheader,nounits',
            ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            const [stdout] = await process.communicate_utf8_async(null, cancellable);
            const [load, temp, freq, memUsed, memTotal] = (stdout ?? '').split('\n')[0].split(',').map(v => parseFloat(v));
            if (!Number.isFinite(load)) {
                this._failNvidia();
                return null;
            }
            this._nvidiaFailures = 0;
            const MiB = 1024 * 1024;
            return {
                load,
                temp: Number.isFinite(temp) ? temp : null,
                freq: Number.isFinite(freq) ? freq : null,
                vram: Number.isFinite(memUsed) ? {used: memUsed * MiB, total: Number.isFinite(memTotal) ? memTotal * MiB : null} : null,
            };
        } catch {
            if (cancellable?.is_cancelled())
                process?.force_exit();
            else
                this._failNvidia();
            return null;
        }
    }

    /** After a few failures nvidia-smi is not spawned any more (driver not loaded, tool broken). */
    _failNvidia() {
        if (++this._nvidiaFailures >= 3)
            this._nvidiaSmi = null;
    }

    /**
     * Parses one fdinfo file: client id, busy nanoseconds of the render engine
     * and the memory the client keeps resident (bytes, summed over regions).
     */
    _parseFdinfo(text) {
        let id = null;
        let total = null;
        let cyclesUsed = null;
        let cyclesTotal = null;
        let resident = null;
        let allocated = null;
        const engines = {};
        for (const line of text.split('\n')) {
            const [key, value] = line.split(':');
            if (!value)
                continue;
            const v = value.trim();
            if (key === 'drm-client-id') {
                id = v;
            } else if (key.startsWith('drm-resident-')) {
                resident = (resident ?? 0) + parseMemory(v);
            } else if (key.startsWith('drm-total-') && !key.startsWith('drm-total-cycles-')) {
                allocated = (allocated ?? 0) + parseMemory(v);
            } else if (key.startsWith('drm-engine-')) {
                engines[key.slice(11)] = parseInt(v, 10);
            } else if (key.startsWith('drm-cycles-')) {
                cyclesUsed = (cyclesUsed ?? 0) + parseInt(v, 10);
            } else if (key.startsWith('drm-total-cycles-')) {
                cyclesTotal = Math.max(cyclesTotal ?? 0, parseInt(v, 10));
            }
        }
        if (id === null)
            return null;
        const render = GPU_RENDER_ENGINES.map(e => engines[e]).find(v => Number.isFinite(v));
        const values = Object.values(engines).filter(Number.isFinite);
        if (render !== undefined)
            total = render;
        else if (values.length)
            total = Math.max(...values);
        return {id, ns: total, cyclesUsed, cyclesTotal, memory: resident ?? allocated};
    }

    /** @returns {Promise<{load: number|null, memory: number|null}|null>} */
    async _fdinfo(cancellable) {
        if (this._fdinfoFailures >= 3)
            return null;
        const clients = new Map();
        const pids = (await listDir('/proc', cancellable)).filter(n => /^\d+$/.test(n));
        let found = false;
        // yield to the compositor every FD_BUDGET descriptors rather than every
        // N processes: a browser or an IDE alone can hold thousands of them
        let budget = FD_BUDGET;
        for (const pid of pids) {
            for (const fd of await listDir(`/proc/${pid}/fd`, cancellable)) {
                if (--budget <= 0) {
                    budget = FD_BUDGET;
                    if (cancellable?.is_cancelled())
                        return null;
                    await idle();
                }
                let target;
                try {
                    target = GLib.file_read_link(`/proc/${pid}/fd/${fd}`);
                } catch {
                    continue;
                }
                if (!target.startsWith('/dev/dri/'))
                    continue;
                const text = await readValue(`/proc/${pid}/fdinfo/${fd}`, cancellable);
                const info = text ? this._parseFdinfo(text) : null;
                if (!info)
                    continue;
                found = true;
                clients.set(info.id, info);
            }
        }
        if (cancellable?.is_cancelled())
            return null;
        const now = GLib.get_monotonic_time();
        const prev = this._prevClients;
        const prevTime = this._prevTime;
        this._prevClients = clients;
        this._prevTime = now;
        if (!found) {
            this._fdinfoFailures++;
            return null;
        }
        let memory = null;
        for (const c of clients.values()) {
            if (c.memory !== null)
                memory = (memory ?? 0) + c.memory;
        }
        if (prevTime === null)
            return {load: null, memory};
        const elapsedNs = (now - prevTime) * 1000;
        let busyNs = 0;
        let cyclesUsed = 0;
        let cyclesTotal = 0;
        for (const [id, c] of clients) {
            const p = prev.get(id);
            if (!p)
                continue;
            if (c.ns !== null && p.ns !== null)
                busyNs += Math.max(0, c.ns - p.ns);
            if (c.cyclesTotal !== null && p.cyclesTotal !== null) {
                cyclesUsed += Math.max(0, c.cyclesUsed - p.cyclesUsed);
                cyclesTotal = Math.max(cyclesTotal, c.cyclesTotal - p.cyclesTotal);
            }
        }
        const load = cyclesTotal > 0
            ? Math.min(100, 100 * cyclesUsed / cyclesTotal)
            : Math.min(100, 100 * busyNs / elapsedNs);
        return {load, memory};
    }
}
