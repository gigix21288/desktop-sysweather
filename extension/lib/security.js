// Security posture of the machine, read without privileges: pending
// updates, failed logins, remote sessions, failed systemd units, Secure
// Boot, disk encryption, firewall, SSH server, AppArmor/SELinux, pending
// reboots and running containers. Every probe also collects the details
// shown in the hover popups (package names, login attempts, unit list…).
// Slow probes (apt-check, journalctl, docker) run as subprocesses and are
// cached, so a sample never blocks the compositor.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {fileTime, listDir, readBytes, readFile} from './files.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const MINUTE = 60 * 1e6;

const APT_CHECK = '/usr/lib/update-notifier/apt-check';
const UPDATES_AVAILABLE = '/var/lib/update-notifier/updates-available';
const SECURE_BOOT_VAR = '/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c';
const LOGIN_FAILURE = 'authentication failure|Failed password|FAILED LOGIN|Invalid user|invalid password';
const LOGIN_LIMIT = 1000;
const LOGIN_RECENT = 5;
const PACKAGE_LIMIT = 40;
const REBOOT_REQUIRED = '/var/run/reboot-required';
const REBOOT_PACKAGES = '/var/run/reboot-required.pkgs';
const APT_HISTORY = '/var/log/apt/history.log';
const SSHD_CONFIG = '/etc/ssh/sshd_config';
const APPARMOR_ENABLED = '/sys/module/apparmor/parameters/enabled';
const SELINUX_ENFORCE = '/sys/fs/selinux/enforce';
const SYSTEMD = 'org.freedesktop.systemd1';
const SYSTEMD_PATH = '/org/freedesktop/systemd1';
const LOGIN1 = 'org.freedesktop.login1';

/**
 * Compares two dotted/dashed version strings numerically ("7.0.0-38" > "6.17.0-20").
 *
 * @returns {number} negative, zero or positive
 */
export function compareVersions(a, b) {
    const parse = v => v.match(/\d+/g)?.map(Number) ?? [];
    const [x, y] = [parse(a), parse(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0);
        if (d)
            return d;
    }
    return 0;
}

/**
 * Picks the user, source host and service out of a PAM / sshd failure line.
 *
 * @param {string} line a journal line in short-iso format
 * @returns {{time: number|null, service: string, user: string, host: string}}
 */
export function parseLoginFailure(line) {
    const time = Date.parse(line.match(/^\S+/)?.[0] ?? '') / 1000;
    const service = line.match(/^\S+ \S+ ([\w.-]+?)(?:\[|\]\[|:)/)?.[1] ??
        line.match(/pam_unix\(([\w-]+):/)?.[1] ?? '';
    const user = line.match(/(?:invalid user|Invalid user|for user|for) (\S+)(?: from| port|$)/)?.[1] ??
        line.match(/\buser=(\S+)/)?.[1] ?? '';
    const host = line.match(/\bfrom ([\w.:%-]+)/i)?.[1] ??
        line.match(/\brhost=(\S+)/)?.[1] ?? '';
    return {time: Number.isFinite(time) ? time : null, service, user, host};
}

/**
 * Parses the output of "dnf check-update": one "name.arch  version  repo"
 * line per package, plus "Obsoleting Packages" blocks that are skipped.
 *
 * @param {string} text stdout
 * @returns {Array<{name: string, version: string, security: boolean}>}
 */
export function parseDnfCheckUpdate(text) {
    const packages = [];
    let obsoleting = false;
    for (const line of text.split('\n')) {
        if (/^Obsoleting/i.test(line)) {
            obsoleting = true;
            continue;
        }
        if (obsoleting)
            continue;
        const match = line.match(/^(\S+)\.([\w-]+)\s+(\S+)\s+\S+\s*$/);
        if (match && !/^(Last metadata|Security:)/i.test(line))
            packages.push({name: match[1], version: match[3], security: false});
    }
    return packages;
}

/**
 * Parses a zypper table ("S | Repository | Name | Current | Available | Arch"
 * for list-updates, "Repository | Name | Category | Severity | …" for
 * list-patches).
 *
 * @param {string} text stdout
 * @param {string} kind "updates" or "patches"
 * @returns {Array<{name: string, version: string, security: boolean}>}
 */
export function parseZypperTable(text, kind) {
    const rows = [];
    for (const line of text.split('\n')) {
        if (!line.includes('|') || /^-+\+|^\s*S\s*\||^Repository\s*\|/i.test(line))
            continue;
        const cols = line.split('|').map(c => c.trim());
        if (kind === 'updates') {
            // v | repo | name | current | available | arch
            if (cols.length >= 6 && cols[0] === 'v')
                rows.push({name: cols[2], version: cols[4], security: false});
        } else if (cols.length >= 3 && cols[1]) {
            rows.push({name: cols[1], version: '', security: true});
        }
    }
    return rows;
}

const RUN_TIMEOUT_SECONDS = 20;

/**
 * Runs a command and collects its output. A command that hangs (a wedged
 * container daemon, a slow mirror) is killed after RUN_TIMEOUT_SECONDS so
 * that the security sample never gets stuck.
 *
 * @param {string[]} argv the command line
 * @param {Gio.Cancellable} cancellable cancels the wait (and kills the child)
 * @returns {Promise<{status: number, stdout: string, stderr: string}|null>}
 *   null when the program cannot be started or did not finish in time
 */
export async function run(argv, cancellable) {
    let process;
    try {
        process = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    } catch {
        return null;
    }
    let timedOut = false;
    let timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RUN_TIMEOUT_SECONDS, () => {
        timedOut = true;
        timeoutId = 0;
        process.force_exit();
        return GLib.SOURCE_REMOVE;
    });
    const cancelId = cancellable?.connect(() => process.force_exit()) ?? 0;
    try {
        const [stdout, stderr] = await process.communicate_utf8_async(null, cancellable);
        if (timedOut) {
            console.warn(`[desktop-sysweather] ${argv[0]} did not finish within ${RUN_TIMEOUT_SECONDS} s`);
            return null;
        }
        const status = process.get_if_exited() ? process.get_exit_status() : -1;
        return {status, stdout: stdout ?? '', stderr: stderr ?? ''};
    } finally {
        if (timeoutId)
            GLib.source_remove(timeoutId);
        if (cancelId)
            cancellable.disconnect(cancelId);
    }
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

/** A value refreshed at most every `ttl` microseconds. */
class Cached {
    constructor(ttl, producer) {
        this._ttl = ttl;
        this._producer = producer;
        this._time = null;
        this._value = null;
        this._pending = null;
    }

    async get(cancellable) {
        const now = GLib.get_monotonic_time();
        if (this._time !== null && now - this._time < this._ttl)
            return this._value;
        if (!this._pending) {
            this._pending = this._producer(cancellable).then(value => {
                this._value = value;
                this._time = GLib.get_monotonic_time();
                return value;
            }).finally(() => {
                this._pending = null;
            });
        }
        return this._pending;
    }

    invalidate() {
        this._time = null;
    }
}

export class SecurityMonitor {
    constructor() {
        this.hasEfi = GLib.file_test('/sys/firmware/efi', GLib.FileTest.IS_DIR);
        this._hasAptCheck = GLib.file_test(APT_CHECK, GLib.FileTest.IS_EXECUTABLE);
        this._checkupdates = GLib.find_program_in_path('checkupdates');
        this._dnf = GLib.find_program_in_path('dnf5') ?? GLib.find_program_in_path('dnf');
        this._zypper = GLib.find_program_in_path('zypper');
        this._flatpak = GLib.find_program_in_path('flatpak');
        this._docker = GLib.find_program_in_path('docker');
        this._podman = GLib.find_program_in_path('podman');
        this._journalctl = GLib.find_program_in_path('journalctl');
        this._apt = GLib.find_program_in_path('apt');
        this._journalRestricted = false;

        this._updates = new Cached(30 * MINUTE, c => this._readUpdates(c));
        this._logins = new Cached(5 * MINUTE, c => this._readFailedLogins(c));
        this._containers = new Cached(1 * MINUTE, c => this._readContainers(c));
        this._static = null;
    }

    /**
     * @param {Gio.Cancellable} cancellable cancels pending work
     * @returns {Promise<object>}
     */
    async sample(cancellable) {
        const quiet = (promise, fallback = null) => promise.catch(e => {
            if (cancellable?.is_cancelled())
                throw e;
            return fallback;
        });
        const [updates, failedLogins, sessions, failedUnits, firewall, sshServer, containers] =
            await Promise.all([
                quiet(this._updates.get(cancellable)),
                quiet(this._logins.get(cancellable)),
                quiet(this._sessions(cancellable)),
                quiet(this._failedUnits(cancellable), []),
                quiet(this._firewall(cancellable)),
                // Ubuntu 22.10+ starts sshd on demand from ssh.socket: the
                // service is inactive while port 22 already accepts logins
                quiet(this._unitActive(Gio.DBus.system,
                    ['ssh.service', 'sshd.service', 'ssh.socket', 'sshd.socket'], cancellable)),
                quiet(this._containers.get(cancellable)),
            ]);
        if (!this._static) {
            const [secureBoot, encrypted, mac] = await Promise.all([
                this._secureBoot(cancellable),
                this._rootEncrypted(cancellable),
                this._mandatoryAccess(cancellable),
            ]);
            this._static = {secureBoot, encrypted, mac};
        }
        const [ssh, reboot] = await Promise.all([
            sshServer ? this._sshConfig(cancellable) : null,
            this._rebootRequired(cancellable),
        ]);
        return {
            updates,
            failedLogins,
            sessions,
            failedUnits,
            firewall,
            sshServer,
            ssh,
            containers,
            reboot,
            ...this._static,
        };
    }

    /** Forces the slow probes to run again at the next sample. */
    invalidate() {
        this._updates.invalidate();
        this._logins.invalidate();
        this._containers.invalidate();
    }

    // ---- updates ---------------------------------------------------------

    /**
     * Pending updates of the distribution's package manager (apt, pacman,
     * dnf or zypper) plus the Flatpak applications with a newer version.
     *
     * @returns {Promise<{total: number, security: number, flatpak: number, packages: object[],
     *   lastUpgrade: number|null}|null>} packages: {name, version, security, flatpak},
     *   at most PACKAGE_LIMIT of them, security ones first; null when no
     *   package manager could be asked
     */
    async _readUpdates(cancellable) {
        const [native, flatpak] = await Promise.all([
            this._nativeUpdates(cancellable),
            this._flatpakUpdates(cancellable),
        ]);
        if (!native && !flatpak)
            return null;
        const packages = [...(native?.packages ?? []), ...(flatpak ?? [])];
        return {
            total: (native?.total ?? 0) + (flatpak?.length ?? 0),
            security: native?.security ?? 0,
            flatpak: flatpak?.length ?? 0,
            packages: packages.slice(0, PACKAGE_LIMIT),
            lastUpgrade: await this._lastUpgrade(cancellable),
        };
    }

    /** @returns {Promise<{total: number, security: number, packages: object[]}|null>} */
    async _nativeUpdates(cancellable) {
        const counts = await this._readUpdateCounts(cancellable);
        if (counts) {
            const packages = counts.total > 0 ? await this._listUpgradable(cancellable) : [];
            return {...counts, packages};
        }
        let packages = null;
        if (this._checkupdates) {
            // Arch: one checkupdates run (it syncs a database copy) gives both the count and the names
            packages = await this._pacmanUpdates(cancellable);
        } else if (this._dnf) {
            packages = await this._dnfUpdates(cancellable);
        } else if (this._zypper) {
            packages = await this._zypperUpdates(cancellable);
        }
        if (!packages)
            return null;
        return {
            total: packages.length,
            security: packages.filter(p => p.security).length,
            packages: packages.slice(0, PACKAGE_LIMIT),
        };
    }

    /**
     * Fedora / RHEL: "dnf check-update" lists the packages with a newer
     * version (exit status 100), from the cached metadata so that the
     * check never downloads repositories; a second call with --security
     * tells which of them close an advisory.
     *
     * @returns {Promise<object[]|null>} null when dnf could not answer (no cache yet)
     */
    async _dnfUpdates(cancellable) {
        const all = await run([this._dnf, '-q', '--cacheonly', 'check-update'], cancellable);
        if (!all || (all.status !== 0 && all.status !== 100))
            return null;
        const packages = parseDnfCheckUpdate(all.stdout);
        if (packages.length) {
            const security = await run([this._dnf, '-q', '--cacheonly', 'check-update', '--security'], cancellable);
            if (security && (security.status === 0 || security.status === 100)) {
                const names = new Set(parseDnfCheckUpdate(security.stdout).map(p => p.name));
                for (const p of packages)
                    p.security = names.has(p.name);
            }
        }
        packages.sort((a, b) => Number(b.security) - Number(a.security) || a.name.localeCompare(b.name));
        return packages;
    }

    /**
     * openSUSE: "zypper list-updates" (works without root on the cached
     * metadata); the security patches come from "zypper list-patches".
     *
     * @returns {Promise<object[]|null>} null when zypper failed
     */
    async _zypperUpdates(cancellable) {
        const common = [this._zypper, '--non-interactive', '--quiet'];
        const updates = await run([...common, 'list-updates'], cancellable);
        if (!updates || updates.status !== 0)
            return null;
        const packages = parseZypperTable(updates.stdout, 'updates');
        if (packages.length) {
            const patches = await run([...common, 'list-patches', '--category', 'security'], cancellable);
            if (patches && patches.status === 0) {
                // patches name the packages they touch only in their detail: flag
                // as many packages as there are security patches, newest first
                const count = parseZypperTable(patches.stdout, 'patches').length;
                packages.slice(0, count).forEach(p => {
                    p.security = true;
                });
            }
        }
        packages.sort((a, b) => Number(b.security) - Number(a.security) || a.name.localeCompare(b.name));
        return packages;
    }

    /**
     * Flatpak applications and runtimes with an update available, in the
     * system and the user installation.
     *
     * @returns {Promise<object[]|null>} null when flatpak is missing or failed
     */
    async _flatpakUpdates(cancellable) {
        if (!this._flatpak)
            return null;
        const result = await run([this._flatpak, 'remote-ls', '--updates', '--columns=application,version,origin'], cancellable);
        if (!result || result.status !== 0)
            return null;
        const packages = [];
        for (const line of result.stdout.split('\n')) {
            const [name, version = '', origin = ''] = line.split('\t').map(c => c.trim());
            if (name)
                packages.push({name, version: version || origin, security: false, flatpak: true});
        }
        packages.sort((a, b) => a.name.localeCompare(b.name));
        return packages;
    }

    async _readUpdateCounts(cancellable) {
        if (this._hasAptCheck) {
            const result = await run([APT_CHECK], cancellable);
            const match = result?.stderr.trim().match(/^(\d+);(\d+)/);
            if (match)
                return {total: Number(match[1]), security: Number(match[2])};
        }
        const text = await readFile(UPDATES_AVAILABLE, cancellable);
        if (text !== null) {
            const numbers = text.match(/\d+/g)?.map(Number) ?? [];
            if (numbers.length)
                return {total: numbers[0], security: numbers[1] ?? 0};
        }
        return null;
    }

    /** The names of the packages waiting for an upgrade (apt). */
    async _listUpgradable(cancellable) {
        const packages = [];
        if (this._apt) {
            const result = await run([this._apt, 'list', '--upgradable'], cancellable);
            if (!result || result.status !== 0)
                return [];
            // "firefox/noble-security 130.0 amd64 [upgradable from: 129.0]"
            for (const line of result.stdout.split('\n')) {
                const match = line.match(/^([^/\s]+)\/(\S+)\s+(\S+)/);
                if (match)
                    packages.push({name: match[1], version: match[3], security: /security/i.test(match[2])});
            }
        }
        packages.sort((a, b) => Number(b.security) - Number(a.security) || a.name.localeCompare(b.name));
        return packages.slice(0, PACKAGE_LIMIT);
    }

    /** @returns {Promise<object[]|null>} pacman packages with an update, null when unknown */
    async _pacmanUpdates(cancellable) {
        const result = await run([this._checkupdates], cancellable);
        // exit 2 = no updates available
        if (!result || (result.status !== 0 && result.status !== 2))
            return null;
        const packages = [];
        for (const line of result.stdout.split('\n')) {
            const match = line.match(/^(\S+)\s+\S+\s+->\s+(\S+)/);
            if (match)
                packages.push({name: match[1], version: match[2], security: false});
        }
        packages.sort((a, b) => a.name.localeCompare(b.name));
        return packages;
    }

    /**
     * When packages were last upgraded: the newest apt history entry, or the
     * modification time of the dpkg/pacman database.
     *
     * @returns {Promise<number|null>} unix seconds
     */
    async _lastUpgrade(cancellable) {
        const history = await readFile(APT_HISTORY, cancellable);
        if (history) {
            const dates = [...history.matchAll(/^Start-Date: (\S+)\s+(\S+)/gm)];
            const last = dates[dates.length - 1];
            if (last) {
                const time = Date.parse(`${last[1]}T${last[2]}`) / 1000;
                if (Number.isFinite(time))
                    return time;
            }
        }
        for (const path of ['/var/lib/dpkg/status', '/var/lib/pacman/local', '/var/lib/rpm/rpmdb.sqlite',
            '/var/lib/rpm/Packages', '/var/log/zypp/history']) {
            const time = await fileTime(path, cancellable);
            if (time)
                return time;
        }
        return null;
    }

    /**
     * Whether the machine should be rebooted: the distribution says so
     * (update-notifier's flag) or a newer kernel than the running one is
     * installed in /boot.
     *
     * @returns {Promise<{packages: string[], kernel: string|null, running: string}|null>}
     *   null when no reboot is needed
     */
    async _rebootRequired(cancellable) {
        const flagged = GLib.file_test(REBOOT_REQUIRED, GLib.FileTest.EXISTS);
        const packages = flagged
            ? [...new Set((await readFile(REBOOT_PACKAGES, cancellable) ?? '').split('\n').map(l => l.trim()).filter(Boolean))]
            : [];
        const running = (await readFile('/proc/sys/kernel/osrelease', cancellable) ?? '').trim();
        let kernel = null;
        if (running) {
            const installed = (await listDir('/boot', cancellable))
                .filter(n => n.startsWith('vmlinuz-'))
                .map(n => n.slice('vmlinuz-'.length))
                .filter(v => /^\d/.test(v));
            const newest = installed.sort(compareVersions).pop();
            if (newest && compareVersions(newest, running) > 0)
                kernel = newest;
        }
        if (!flagged && !kernel)
            return null;
        return {packages, kernel, running};
    }

    // ---- logins and sessions --------------------------------------------

    /**
     * @returns {Promise<{count: number, capped: boolean, recent: object[], hosts: object[]}|null>}
     *   recent: the newest LOGIN_RECENT attempts {time, service, user, host};
     *   hosts: [{host, count}] most active first
     */
    async _readFailedLogins(cancellable) {
        if (!this._journalctl || this._journalRestricted)
            return null;
        // no -q: it would silence the very hint that tells us the system
        // journal is not readable by this user
        const result = await run([
            this._journalctl, '--since=-24h', '--no-pager', '-o', 'short-iso',
            '-n', String(LOGIN_LIMIT), '-g', LOGIN_FAILURE,
        ], cancellable);
        if (!result)
            return null;
        if (/not seeing messages from other users|No journal files/i.test(result.stderr)) {
            // without the adm / systemd-journal group the count would be meaningless
            this._journalRestricted = true;
            return null;
        }
        if (result.status !== 0 && result.status !== 1)
            return null;
        const lines = result.stdout.split('\n').filter(l => /^\d{4}-/.test(l));
        const attempts = lines.map(parseLoginFailure);
        const byHost = new Map();
        for (const a of attempts) {
            const key = a.host || (a.service ? `${a.service} (local)` : 'local');
            byHost.set(key, (byHost.get(key) ?? 0) + 1);
        }
        const hosts = [...byHost].map(([host, count]) => ({host, count})).sort((a, b) => b.count - a.count);
        return {
            count: attempts.length,
            capped: attempts.length >= LOGIN_LIMIT,
            recent: attempts.slice(-LOGIN_RECENT).reverse(),
            hosts: hosts.slice(0, 5),
        };
    }

    async _sessions(cancellable) {
        const bus = Gio.DBus.system;
        const [list] = await dbusCall(bus, LOGIN1, '/org/freedesktop/login1', `${LOGIN1}.Manager`,
            'ListSessions', null, cancellable);
        const users = new Set();
        const remote = [];
        const all = [];
        const details = await Promise.all(list.map(([, , user, , path]) =>
            dbusProps(bus, LOGIN1, path, `${LOGIN1}.Session`, cancellable)
                .then(props => ({user, props}))
                .catch(() => null)));
        for (const entry of details) {
            if (!entry || entry.props.Class !== 'user')
                continue;
            const p = entry.props;
            const session = {
                user: entry.user,
                host: p.RemoteHost || '',
                service: p.Service || '',
                type: p.Type || '',
                tty: p.TTY || '',
                remote: Boolean(p.Remote),
                since: Number(p.Timestamp) ? Number(p.Timestamp) / 1e6 : null,
            };
            users.add(entry.user);
            all.push(session);
            if (session.remote)
                remote.push({...session, host: session.host || '?'});
        }
        all.sort((a, b) => (a.since ?? 0) - (b.since ?? 0));
        return {users: users.size, remote, sessions: all};
    }

    // ---- systemd ---------------------------------------------------------

    /** @returns {Promise<Array<{name: string, description: string, scope: string}>>} */
    async _failedUnits(cancellable) {
        const names = [];
        for (const bus of [Gio.DBus.system, Gio.DBus.session]) {
            try {
                const [units] = await dbusCall(bus, SYSTEMD, SYSTEMD_PATH, `${SYSTEMD}.Manager`,
                    'ListUnitsFiltered', new GLib.Variant('(as)', [['failed']]), cancellable);
                names.push(...units.map(u => ({
                    name: u[0],
                    description: u[1],
                    scope: bus === Gio.DBus.system ? 'system' : 'user',
                })));
            } catch (e) {
                if (cancellable?.is_cancelled())
                    throw e;
            }
        }
        return names;
    }

    /**
     * Whether any of the given units is active.
     *
     * @returns {Promise<boolean|null>} null when none of them is installed
     */
    async _unitActive(bus, names, cancellable) {
        let installed = false;
        for (const name of names) {
            try {
                // LoadUnit (unlike GetUnit) also answers for units that exist on
                // disk but are not loaded, e.g. after "systemctl disable --now"
                const [path] = await dbusCall(bus, SYSTEMD, SYSTEMD_PATH, `${SYSTEMD}.Manager`,
                    'LoadUnit', new GLib.Variant('(s)', [name]), cancellable);
                const prop = async p => (await dbusCall(bus, SYSTEMD, path, 'org.freedesktop.DBus.Properties',
                    'Get', new GLib.Variant('(ss)', [`${SYSTEMD}.Unit`, p]), cancellable))[0];
                if (await prop('LoadState') !== 'loaded')
                    continue;
                installed = true;
                if (await prop('ActiveState') === 'active')
                    return true;
            } catch (e) {
                if (cancellable?.is_cancelled())
                    throw e;
                // not available: try the next name
            }
        }
        return installed ? false : null;
    }

    async _firewall(cancellable) {
        const bus = Gio.DBus.system;
        const ufw = await this._unitActive(bus, ['ufw.service'], cancellable);
        if (ufw !== null) {
            const [conf, defaults] = await Promise.all([
                readFile('/etc/ufw/ufw.conf', cancellable),
                readFile('/etc/default/ufw', cancellable),
            ]).then(texts => texts.map(t => t ?? ''));
            const enabled = /^ENABLED=yes/m.test(conf);
            const policy = name => defaults.match(new RegExp(`^DEFAULT_${name}_POLICY="?(\\w+)`, 'm'))?.[1]?.toLowerCase() ?? null;
            return {
                name: 'ufw',
                active: ufw && enabled,
                incoming: policy('INPUT'),
                outgoing: policy('OUTPUT'),
            };
        }
        const firewalld = await this._unitActive(bus, ['firewalld.service'], cancellable);
        if (firewalld !== null)
            return {name: 'firewalld', active: firewalld};
        const nftables = await this._unitActive(bus, ['nftables.service'], cancellable);
        if (nftables !== null)
            return {name: 'nftables', active: nftables};
        return null;
    }

    // ---- static facts ----------------------------------------------------

    async _secureBoot(cancellable) {
        if (!this.hasEfi)
            return null;
        const bytes = await readBytes(SECURE_BOOT_VAR, cancellable);
        // 4 bytes of attributes followed by the value
        return bytes && bytes.length >= 5 ? bytes[4] === 1 : null;
    }

    /**
     * Mandatory access control: AppArmor (Ubuntu, Debian, SUSE) or SELinux (Fedora, RHEL).
     *
     * @returns {Promise<{name: string, active: boolean, mode: string|null}|null>} null when neither is built in
     */
    async _mandatoryAccess(cancellable) {
        const [selinux, apparmor, lsm] = await Promise.all([
            readFile(SELINUX_ENFORCE, cancellable),
            readFile(APPARMOR_ENABLED, cancellable),
            readFile('/sys/kernel/security/lsm', cancellable),
        ]);
        let selinuxState = null;
        if (selinux !== null) {
            const enforcing = selinux.trim() === '1';
            selinuxState = {name: 'SELinux', active: enforcing, mode: enforcing ? 'enforcing' : 'permissive'};
        }
        const apparmorState = apparmor === null ? null : {name: 'AppArmor', active: apparmor.trim() === 'Y', mode: null};
        // The kernel lists the LSMs it actually booted with: a Fedora kernel
        // has AppArmor built in (its sysfs parameter exists) but runs SELinux.
        const active = (lsm ?? '').split(',').map(s => s.trim());
        if (active.includes('apparmor') && !active.includes('selinux'))
            return apparmorState ?? selinuxState;
        return selinuxState ?? apparmorState;
    }

    /**
     * The settings of the SSH server that matter most, from sshd_config and
     * its drop-in directory (OpenSSH defaults when unset).
     *
     * @returns {Promise<{port: string, passwordAuth: boolean, rootLogin: string}|null>}
     *   null when the configuration is not readable
     */
    async _sshConfig(cancellable) {
        // OpenSSH keeps the first occurrence of a keyword, and Debian/Ubuntu
        // include sshd_config.d/*.conf at the top of sshd_config: the drop-ins
        // come first, the main file last
        const dropIns = await listDir(`${SSHD_CONFIG}.d`, cancellable);
        const files = [
            ...dropIns.filter(n => n.endsWith('.conf')).sort().map(n => `${SSHD_CONFIG}.d/${n}`),
            SSHD_CONFIG,
        ];
        const texts = (await Promise.all(files.map(f => readFile(f, cancellable)))).filter(t => t !== null);
        if (!texts.length)
            return null;
        // settings inside "Match" blocks are conditional: ignore them
        const text = texts.map(t => t.split(/^\s*Match\b.*$/m)[0]).join('\n');
        const option = (name, fallback) => {
            const value = text.match(new RegExp(`^\\s*${name}\\s+(\\S+)`, 'im'))?.[1];
            return value ? value.toLowerCase() : fallback;
        };
        return {
            port: option('Port', '22'),
            passwordAuth: option('PasswordAuthentication', 'yes') !== 'no',
            rootLogin: option('PermitRootLogin', 'prohibit-password'),
        };
    }

    /**
     * Whether the root file system sits on a LUKS volume (also through LVM).
     *
     * @returns {Promise<boolean|null>}
     */
    async _rootEncrypted(cancellable) {
        const mounts = await readFile('/proc/mounts', cancellable) ?? '';
        const root = mounts.split('\n').map(l => l.split(' ')).find(cols => cols[1] === '/');
        if (!root)
            return null;
        let device = root[0];
        try {
            // /dev/mapper/vg-root -> ../dm-1
            device = GLib.canonicalize_filename(GLib.file_read_link(device), GLib.path_get_dirname(device));
        } catch {
            // a plain block device
        }
        const name = GLib.path_get_basename(device);
        if (!GLib.file_test(`/sys/class/block/${name}`, GLib.FileTest.IS_DIR))
            return null;
        const isLuks = async dev => (await readFile(`/sys/class/block/${dev}/dm/uuid`, cancellable) ?? '').startsWith('CRYPT-LUKS');
        const queue = [name];
        const seen = new Set();
        while (queue.length) {
            const dev = queue.shift();
            if (seen.has(dev))
                continue;
            seen.add(dev);
            if (await isLuks(dev))
                return true;
            queue.push(...await listDir(`/sys/class/block/${dev}/slaves`, cancellable));
        }
        return false;
    }

    // ---- containers ------------------------------------------------------

    /**
     * @returns {Promise<{docker: object|null, podman: object|null}|null>}
     *   each engine: {count, list: [{name, image, ports}]}
     */
    async _readContainers(cancellable) {
        const runtime = GLib.get_user_runtime_dir();
        const exists = path => GLib.file_test(path, GLib.FileTest.EXISTS);
        // Only ask an engine that is actually in use here: "docker ps" with a
        // remote context would go over the network, and "podman ps" for a user
        // who never ran podman initialises its storage.
        const dockerInUse = exists('/var/run/docker.sock') || exists(`${runtime}/docker.sock`);
        const podmanInUse = exists(`${GLib.get_user_data_dir()}/containers/storage`) ||
            exists(`${runtime}/containers`) || exists('/run/podman/podman.sock');
        const list = async program => {
            if (!program)
                return null;
            const result = await run([program, 'ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Ports}}'], cancellable);
            if (!result || result.status !== 0)
                return null;
            const containers = result.stdout.split('\n').filter(l => l.trim()).map(line => {
                const [name = '', image = '', ports = ''] = line.split('\t');
                return {name, image, ports: ports.trim()};
            });
            return {count: containers.length, list: containers.slice(0, 10)};
        };
        const [docker, podman] = await Promise.all([
            list(dockerInUse ? this._docker : null),
            list(podmanInUse ? this._podman : null),
        ]);
        if (docker === null && podman === null)
            return null;
        return {docker, podman};
    }
}
