// Network state without external tools: the primary connection, Wi-Fi
// details, VPN, local address, gateway and DNS come from NetworkManager over
// D-Bus (with a /proc and /sys fallback when it is not running); listening
// ports and established connections are parsed from /proc/net; the latency
// is the time to open a TCP connection, which needs no privileges.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {_} from './i18n.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.SocketClient.prototype, 'connect_to_host_async');

const decoder = new TextDecoder();

const NM = 'org.freedesktop.NetworkManager';
const NM_PATH = '/org/freedesktop/NetworkManager';
const NM_CONNECTIVITY_FULL = 4;
const DEVICE_ETHERNET = 1;
const DEVICE_WIFI = 2;
const AP_FLAGS_PRIVACY = 0x1;
const KEY_MGMT_PSK = 0x100;
const KEY_MGMT_802_1X = 0x200;
const KEY_MGMT_SAE = 0x400;
const KEY_MGMT_OWE = 0x800;
const KEY_MGMT_OWE_TM = 0x1000;
const KEY_MGMT_EAP_SUITE_B_192 = 0x2000;

const VPN_TYPES = ['vpn', 'wireguard', 'tun', 'ip-tunnel'];
// tap* (virtual machines) and ppp* (PPPoE uplinks) are deliberately not here
const VPN_IFACES = /^(tun|wg|proton|nordlynx|nordtun|tailscale|mullvad|utun|zt|ipsec)/;
// after a NetworkManager restart (or upgrade) try D-Bus again this much later
const NM_RETRY_US = 60 * 1e6;
const VPN_SERVICES = {
    openvpn: 'OpenVPN', wireguard: 'WireGuard', openconnect: 'OpenConnect', vpnc: 'Cisco',
    l2tp: 'L2TP', pptp: 'PPTP', sstp: 'SSTP', fortisslvpn: 'Fortinet', strongswan: 'IPsec',
    libreswan: 'IPsec', iodine: 'iodine', ssh: 'SSH',
};
const IFACE_KIND = [
    [/^(wg|nordlynx|mullvad)/, 'WireGuard'], [/^tailscale/, 'Tailscale'], [/^zt/, 'ZeroTier'],
    [/^proton/, 'Proton VPN'], [/^(tun|utun)/, 'OpenVPN/tun'],
];

// well known TCP ports, shown next to the number
const SERVICES = {
    21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'dns', 80: 'http', 110: 'pop3',
    111: 'rpc', 139: 'smb', 143: 'imap', 443: 'https', 445: 'smb', 465: 'smtps', 587: 'smtp',
    631: 'ipp', 993: 'imaps', 995: 'pop3s', 1080: 'socks', 1433: 'mssql', 1883: 'mqtt',
    2049: 'nfs', 2222: 'ssh', 3000: 'dev', 3306: 'mysql', 3389: 'rdp', 4000: 'dev',
    5000: 'dev', 5432: 'postgres', 5900: 'vnc', 5901: 'vnc', 6379: 'redis', 8000: 'http',
    8080: 'http', 8443: 'https', 8888: 'jupyter', 9000: 'dev', 9090: 'http', 9100: 'metrics',
    11434: 'ollama', 27017: 'mongo',
};
const TCP_LISTEN = '0A';
const TCP_ESTABLISHED = '01';

async function read(path, cancellable) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        return decoder.decode(bytes);
    } catch {
        return null;
    }
}

function readSync(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes).trim() : null;
    } catch {
        return null;
    }
}

function listDir(path) {
    const names = [];
    let enumerator = null;
    try {
        enumerator = Gio.File.new_for_path(path).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)))
            names.push(info.get_name());
    } catch {
        // missing directory
    } finally {
        try {
            enumerator?.close(null);
        } catch {
            // already closed
        }
    }
    return names.sort();
}

/**
 * Formats an IPv6 address given as 16 bytes (NetworkManager's IP6Config
 * Nameservers property is "aay").
 *
 * @param {Uint8Array|number[]} bytes the address
 * @returns {string}
 */
export function formatIp6(bytes) {
    const b = Array.from(bytes);
    if (b.length !== 16)
        return '';
    const groups = [];
    for (let i = 0; i < 16; i += 2)
        groups.push(((b[i] << 8) | b[i + 1]).toString(16));
    // compress the longest run of zero groups, as inet_ntop does
    let best = {start: -1, length: 0};
    for (let i = 0; i < 8;) {
        if (groups[i] !== '0') {
            i++;
            continue;
        }
        let j = i;
        while (j < 8 && groups[j] === '0')
            j++;
        if (j - i > best.length)
            best = {start: i, length: j - i};
        i = j;
    }
    if (best.length < 2)
        return groups.join(':');
    const head = groups.slice(0, best.start).join(':');
    const tail = groups.slice(best.start + best.length).join(':');
    return `${head}::${tail}`;
}

async function dbusCall(bus, dest, path, iface, method, args, cancellable) {
    const result = await bus.call(dest, path, iface, method, args, null,
        Gio.DBusCallFlags.NONE, 5000, cancellable);
    return result.recursiveUnpack();
}

async function dbusProps(bus, dest, path, iface, cancellable) {
    const [props] = await dbusCall(bus, dest, path, 'org.freedesktop.DBus.Properties', 'GetAll',
        new GLib.Variant('(s)', [iface]), cancellable);
    return props;
}

/**
 * Describes the encryption of an access point from its NetworkManager flags.
 *
 * @param {number} flags AP flags
 * @param {number} wpa WPA (v1) flags
 * @param {number} rsn RSN (WPA2/WPA3) flags
 * @returns {{name: string, secure: boolean}}
 */
export function wifiSecurity(flags, wpa, rsn) {
    if (rsn & (KEY_MGMT_SAE | KEY_MGMT_EAP_SUITE_B_192))
        return {name: rsn & (KEY_MGMT_PSK | KEY_MGMT_802_1X) ? 'WPA2/WPA3' : 'WPA3', secure: true};
    if (rsn & (KEY_MGMT_OWE | KEY_MGMT_OWE_TM))
        return {name: 'OWE', secure: true};
    if (rsn)
        return {name: rsn & KEY_MGMT_802_1X ? 'WPA2 Enterprise' : 'WPA2', secure: true};
    if (wpa)
        return {name: 'WPA', secure: false};
    if (flags & AP_FLAGS_PRIVACY)
        return {name: 'WEP', secure: false};
    return {name: _('Open'), secure: false};
}

/**
 * @param {number} mhz channel frequency
 * @returns {string} "2.4 GHz", "5 GHz" or "6 GHz"
 */
export function wifiBand(mhz) {
    if (mhz >= 5925)
        return '6 GHz';
    return mhz >= 4900 ? '5 GHz' : '2.4 GHz';
}

/**
 * @param {number} port a TCP port
 * @returns {string} e.g. "22 ssh" or "8123"
 */
export function portLabel(port) {
    const name = SERVICES[port];
    return name ? `${port} ${name}` : String(port);
}

function hexToIp4(hex) {
    // little endian: "0100007F" -> 127.0.0.1
    const bytes = [];
    for (let i = 6; i >= 0; i -= 2)
        bytes.push(parseInt(hex.slice(i, i + 2), 16));
    return bytes.join('.');
}

function isLoopbackHex(hex) {
    if (hex.length === 8)
        return hex.endsWith('7F');
    // IPv6: ::1 or an IPv4-mapped 127.x address
    if (hex === '00000000000000000000000001000000')
        return true;
    const mapped = hex.slice(16, 24);
    return (mapped === 'FFFF0000' || mapped === '0000FFFF') && hex.endsWith('7F');
}

function remoteName(hex) {
    if (hex.length === 8)
        return hexToIp4(hex);
    if (hex.slice(16, 24) === '0000FFFF' || hex.slice(16, 24) === 'FFFF0000')
        return hexToIp4(hex.slice(24));
    return hex;
}

/**
 * Parses /proc/net/tcp and tcp6: listening ports and established
 * connections to other hosts.
 *
 * @param {string[]} tables the file contents
 * @returns {{listening: Array<{port: number, exposed: boolean}>,
 *   established: number, hosts: number}}
 */
export function parseSockets(tables) {
    const listening = new Map();
    const remotes = new Set();
    let established = 0;
    for (const table of tables) {
        for (const line of (table ?? '').split('\n').slice(1)) {
            const cols = line.trim().split(/\s+/);
            if (cols.length < 4)
                continue;
            const [localHex, localPortHex] = cols[1].split(':');
            const [remoteHex] = cols[2].split(':');
            const state = cols[3];
            if (state === TCP_LISTEN) {
                const port = parseInt(localPortHex, 16);
                const exposed = !isLoopbackHex(localHex);
                const prev = listening.get(port);
                listening.set(port, {port, exposed: exposed || prev?.exposed === true});
            } else if (state === TCP_ESTABLISHED && !isLoopbackHex(remoteHex)) {
                established++;
                remotes.add(remoteName(remoteHex));
            }
        }
    }
    return {
        listening: [...listening.values()].sort((a, b) => a.port - b.port),
        established,
        hosts: remotes.size,
    };
}

const ARP_COMPLETE = 0x2;

/**
 * The devices of the local network that talked to this machine recently,
 * from the kernel's ARP cache (IPv4). Nothing is probed: a device that has
 * been silent for a while is simply not listed.
 *
 * @param {string|null} arp the content of /proc/net/arp
 * @param {object|null} primary the primary connection (iface, gateway)
 * @returns {{count: number, devices: Array<{ip: string, mac: string, iface: string, gateway: boolean}>}|null}
 */
export function parseArp(arp, primary) {
    if (arp === null)
        return null;
    const devices = [];
    for (const line of arp.split('\n').slice(1)) {
        // IP address  HW type  Flags  HW address  Mask  Device
        const cols = line.trim().split(/\s+/);
        if (cols.length < 6)
            continue;
        const [ip, , flags, mac, , iface] = cols;
        if (!(parseInt(flags, 16) & ARP_COMPLETE) || mac === '00:00:00:00:00:00')
            continue;
        if (primary?.iface && iface !== primary.iface)
            continue;
        if (!isPhysicalIface(iface))
            continue;
        devices.push({ip, mac, iface, gateway: ip === primary?.gateway});
    }
    const key = ip => ip.split('.').map(n => n.padStart(3, '0')).join('.');
    devices.sort((a, b) => key(a.ip).localeCompare(key(b.ip)));
    return {count: devices.length, devices};
}

// virtual interfaces (docker bridges, VPN tunnels) have no "device" link in sysfs
const physicalIfaces = new Map();
function isPhysicalIface(iface) {
    let physical = physicalIfaces.get(iface);
    if (physical === undefined) {
        physical = GLib.file_test(`/sys/class/net/${iface}/device`, GLib.FileTest.EXISTS);
        physicalIfaces.set(iface, physical);
    }
    return physical;
}

export class NetworkMonitor {
    constructor() {
        // monotonic time before which NetworkManager is not asked again, 0 = ask
        this._nmRetryAt = 0;
    }

    /**
     * @param {Gio.Cancellable} cancellable cancels pending reads
     * @returns {Promise<object>} {online, primary, vpn, sockets}
     */
    async sample(cancellable) {
        const [state, sockets, arp] = await Promise.all([
            this._connectionState(cancellable),
            this._sockets(cancellable),
            read('/proc/net/arp', cancellable),
        ]);
        return {...state, sockets, lan: parseArp(arp, state.primary)};
    }

    async _sockets(cancellable) {
        const tables = await Promise.all([
            read('/proc/net/tcp', cancellable),
            read('/proc/net/tcp6', cancellable),
        ]);
        return parseSockets(tables);
    }

    async _connectionState(cancellable) {
        if (GLib.get_monotonic_time() >= this._nmRetryAt) {
            try {
                const state = await this._fromNetworkManager(cancellable);
                this._nmRetryAt = 0;
                return state;
            } catch (e) {
                if (cancellable?.is_cancelled())
                    throw e;
                if (e.matches?.(Gio.DBusError, Gio.DBusError.SERVICE_UNKNOWN) ||
                    e.matches?.(Gio.DBusError, Gio.DBusError.NAME_HAS_NO_OWNER)) {
                    if (this._nmRetryAt === 0)
                        console.log('[desktop-sysweather] NetworkManager not available, reading /proc instead');
                    this._nmRetryAt = GLib.get_monotonic_time() + NM_RETRY_US;
                } else {
                    console.warn(`[desktop-sysweather] NetworkManager query failed: ${e.message ?? e}`);
                }
            }
        }
        return this._fromProc(cancellable);
    }

    async _fromNetworkManager(cancellable) {
        const bus = Gio.DBus.system;
        const manager = await dbusProps(bus, NM, NM_PATH, NM, cancellable);
        const result = {
            online: manager.Connectivity === NM_CONNECTIVITY_FULL,
            primary: null,
            vpn: null,
        };
        const actives = manager.ActiveConnections ?? [];
        const connections = await Promise.all(actives.map(path =>
            dbusProps(bus, NM, path, `${NM}.Connection.Active`, cancellable)
                .then(props => ({path, props}))
                .catch(() => null)));

        for (const entry of connections) {
            if (!entry)
                continue;
            const {path, props} = entry;
            if (props.Vpn || VPN_TYPES.includes(props.Type)) {
                if (!result.vpn || props.Vpn)
                    result.vpn = {name: props.Id, kind: await this._vpnKind(bus, props, cancellable)};
                continue;
            }
            if (path === manager.PrimaryConnection)
                result.primary = await this._primary(bus, props, cancellable);
        }
        if (!result.vpn)
            result.vpn = this._vpnFromSysfs();
        return result;
    }

    async _vpnKind(bus, props, cancellable) {
        if (props.Type === 'wireguard')
            return 'WireGuard';
        if (props.Type === 'vpn' && props.Connection) {
            try {
                const [settings] = await dbusCall(bus, NM, props.Connection,
                    `${NM}.Settings.Connection`, 'GetSettings', null, cancellable);
                const service = settings?.vpn?.['service-type'] ?? '';
                const key = service.split('.').pop();
                return VPN_SERVICES[key] ?? 'VPN';
            } catch {
                return 'VPN';
            }
        }
        return 'VPN';
    }

    async _primary(bus, props, cancellable) {
        const primary = {
            id: props.Id,
            type: 'other',
            iface: null,
            ip: null,
            prefix: null,
            gateway: null,
            dns: [],
            wifi: null,
        };
        const devicePath = props.Devices?.[0];
        if (devicePath && devicePath !== '/') {
            try {
                const device = await dbusProps(bus, NM, devicePath, `${NM}.Device`, cancellable);
                primary.iface = device.Interface ?? null;
                if (device.DeviceType === DEVICE_WIFI) {
                    primary.type = 'wifi';
                    primary.wifi = await this._wifi(bus, devicePath, cancellable);
                } else if (device.DeviceType === DEVICE_ETHERNET) {
                    primary.type = 'wired';
                }
            } catch (e) {
                if (cancellable?.is_cancelled())
                    throw e;
                // the device went away between two calls (roaming, unplug): keep the rest
            }
        }
        if (props.Ip4Config && props.Ip4Config !== '/') {
            try {
                const ip4 = await dbusProps(bus, NM, props.Ip4Config, `${NM}.IP4Config`, cancellable);
                const address = ip4.AddressData?.[0];
                primary.ip = address?.address ?? null;
                primary.prefix = address?.prefix ?? null;
                primary.gateway = ip4.Gateway || null;
                primary.dns = (ip4.NameserverData ?? []).map(n => n.address).filter(Boolean);
            } catch {
                // no IPv4: fall through to the IPv6 configuration below
            }
        }
        if (!primary.ip && props.Ip6Config && props.Ip6Config !== '/') {
            try {
                const ip6 = await dbusProps(bus, NM, props.Ip6Config, `${NM}.IP6Config`, cancellable);
                const address = (ip6.AddressData ?? []).find(a => !a.address.startsWith('fe80'));
                primary.ip = address?.address ?? null;
                primary.prefix = address?.prefix ?? null;
                primary.gateway = primary.gateway ?? (ip6.Gateway || null);
                if (primary.dns.length === 0) {
                    primary.dns = (ip6.Nameservers ?? [])
                        .map(n => (typeof n === 'string' ? n : formatIp6(n)))
                        .filter(Boolean);
                }
            } catch {
                // nothing more to learn
            }
        }
        return primary;
    }

    async _wifi(bus, devicePath, cancellable) {
        try {
            const wireless = await dbusProps(bus, NM, devicePath, `${NM}.Device.Wireless`, cancellable);
            const apPath = wireless.ActiveAccessPoint;
            if (!apPath || apPath === '/')
                return null;
            const ap = await dbusProps(bus, NM, apPath, `${NM}.AccessPoint`, cancellable);
            const ssid = decoder.decode(new Uint8Array(ap.Ssid ?? []));
            return {
                ssid,
                strength: ap.Strength ?? 0,
                frequency: ap.Frequency ?? 0,
                band: wifiBand(ap.Frequency ?? 0),
                security: wifiSecurity(ap.Flags ?? 0, ap.WpaFlags ?? 0, ap.RsnFlags ?? 0),
                bitrate: wireless.Bitrate ? wireless.Bitrate / 1000 : null,
            };
        } catch {
            return null;
        }
    }

    _vpnFromSysfs() {
        for (const iface of listDir('/sys/class/net')) {
            if (!VPN_IFACES.test(iface))
                continue;
            const state = readSync(`/sys/class/net/${iface}/operstate`);
            if (state === 'down')
                continue;
            const kind = IFACE_KIND.find(([re]) => re.test(iface))?.[1] ?? 'VPN';
            return {name: iface, kind};
        }
        return null;
    }

    async _fromProc(cancellable) {
        const route = await read('/proc/net/route', cancellable);
        const result = {online: Gio.NetworkMonitor.get_default().network_available, primary: null, vpn: this._vpnFromSysfs()};
        // the default route with the lowest metric wins (the file is not sorted by metric)
        const cols = (route ?? '').split('\n').slice(1)
            .map(l => l.trim().split(/\s+/))
            .filter(c => c.length >= 7 && c[1] === '00000000')
            .sort((a, b) => Number(a[6]) - Number(b[6]))[0];
        if (!cols)
            return result;
        const iface = cols[0];
        const wireless = listDir(`/sys/class/net/${iface}`).includes('wireless');
        const nameservers = path => (readSync(path) ?? '').split('\n')
            .filter(l => l.startsWith('nameserver'))
            .map(l => l.split(/\s+/)[1])
            .filter(a => a && !a.startsWith('127.') && a !== '::1');
        // with systemd-resolved /etc/resolv.conf only lists the 127.0.0.53
        // stub: the upstream servers are in resolved's own file
        let dns = nameservers('/etc/resolv.conf');
        if (!dns.length)
            dns = nameservers('/run/systemd/resolve/resolv.conf');
        result.primary = {
            id: iface,
            type: wireless ? 'wifi' : 'wired',
            iface,
            ip: null,
            prefix: null,
            gateway: hexToIp4(cols[2]),
            dns,
            wifi: null,
        };
        return result;
    }

    /**
     * Measures the time to open a TCP connection to a host.
     *
     * @param {string} host host name or address
     * @param {number} port TCP port
     * @param {Gio.Cancellable} cancellable cancels the probe
     * @returns {Promise<number|null>} milliseconds, or null when unreachable
     */
    async probe(host, port, cancellable) {
        const client = new Gio.SocketClient({timeout: 4});
        const start = GLib.get_monotonic_time();
        try {
            const connection = await client.connect_to_host_async(host, port, cancellable);
            const elapsed = (GLib.get_monotonic_time() - start) / 1000;
            try {
                connection.close(null);
            } catch {
                // already gone
            }
            return elapsed;
        } catch (e) {
            if (cancellable?.is_cancelled())
                throw e;
            return null;
        }
    }
}
