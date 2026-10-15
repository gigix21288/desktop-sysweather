#!/usr/bin/env python3
"""Builds the distributable packages into dist/:

  * <uuid>.shell-extension.zip  - for `gnome-extensions install` / any distro
  * gnome-shell-extension-desktop-sysweather_<ver>_all.deb - Debian/Ubuntu/Zorin

Usage: ./build.py [zip|deb|all]
"""
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / 'extension'
BUILD = ROOT / 'build'
DIST = ROOT / 'dist'

META = json.loads((SRC / 'metadata.json').read_text())
UUID = META['uuid']
DOMAIN = META['gettext-domain']
VERSION = META['version-name']
PACKAGE = 'gnome-shell-extension-desktop-sysweather'
MAINTAINER = 'Pierluigi Iorio <pierluigi.iorio@gmail.com>'


def compile_mo(po, mo):
    mo.parent.mkdir(parents=True, exist_ok=True)
    if shutil.which('msgfmt'):
        subprocess.run(['msgfmt', '--check', '-o', str(mo), str(po)], check=True)
    else:
        subprocess.run([sys.executable, str(ROOT / 'tools' / 'msgfmt.py'), str(po), str(mo)], check=True)


def stage():
    """Copies the extension into build/<uuid> with schemas and translations compiled."""
    target = BUILD / UUID
    shutil.rmtree(target, ignore_errors=True)
    shutil.copytree(SRC, target, ignore=shutil.ignore_patterns('*~', '.*', 'gschemas.compiled'))
    subprocess.run(['glib-compile-schemas', '--strict', str(target / 'schemas')], check=True)
    for po in sorted((ROOT / 'po').glob('*.po')):
        compile_mo(po, target / 'locale' / po.stem / 'LC_MESSAGES' / f'{DOMAIN}.mo')
    return target


def build_zip(staged):
    DIST.mkdir(exist_ok=True)
    out = DIST / f'{UUID}.shell-extension.zip'
    out.unlink(missing_ok=True)
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(staged.rglob('*')):
            if path.is_file():
                zf.write(path, path.relative_to(staged))
    shutil.copy(ROOT / 'install.sh', DIST / 'install.sh')
    print(f'built {out.relative_to(ROOT)}')


def build_deb(staged):
    root = BUILD / 'deb'
    shutil.rmtree(root, ignore_errors=True)
    dest = root / 'usr/share/gnome-shell/extensions' / UUID
    shutil.copytree(staged, dest)
    doc = root / 'usr/share/doc' / PACKAGE
    doc.mkdir(parents=True)
    shutil.copy(ROOT / 'README.md', doc / 'README.md')
    # Debian policy: every package documents its copyright and license
    (doc / 'copyright').write_text(f"""Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: desktop-sysweather
Source: {META['url']}

Files: *
Copyright: 2026 {MAINTAINER}
License: GPL-2+
 This program is free software; you can redistribute it and/or modify
 it under the terms of the GNU General Public License as published by
 the Free Software Foundation; either version 2 of the License, or
 (at your option) any later version.
 .
 On Debian systems, the complete text of the GNU General Public
 License version 2 can be found in "/usr/share/common-licenses/GPL-2".
""")

    size_kb = sum(p.stat().st_size for p in root.rglob('*') if p.is_file()) // 1024 + 1
    debian = root / 'DEBIAN'
    debian.mkdir()
    (debian / 'control').write_text(f"""Package: {PACKAGE}
Version: {VERSION}
Section: gnome
Priority: optional
Architecture: all
Depends: gnome-shell (>= 45), gir1.2-soup-3.0
Recommends: gir1.2-geoclue-2.0, geoclue-2.0
Installed-Size: {size_kb}
Maintainer: {MAINTAINER}
Homepage: {META['url']}
Description: {META['name']} for GNOME Shell
 A transparent desktop widget showing CPU usage and temperature, memory,
 swap, disk, network speed, fans and battery, together with the current
 weather and a 4 day forecast from Open-Meteo (no API key required).
 .
 The background is tinted like the real sky (day, dusk, night with stars,
 rain, snow); it shows rain expected in the next two hours, the sun arc
 with sunrise/sunset and the moon phase, air quality, UV and pollen, a
 tip of the day and recent earthquakes (INGV / USGS).
 .
 .
 For IT and security people: public IP and ISP, VPN watch, Wi-Fi
 encryption, local address/gateway/DNS, listening and exposed ports,
 latency graph, firewall, pending updates, failed logins, remote sessions,
 Secure Boot, disk encryption, containers, top processes, the CISA KEV and
 CERT-AGID feeds, space weather and the ISS, a UTC/Unix clock.
 .
 Dark, light and two terminal themes, one or two columns, 7 desktop
 positions, location from the system location services (GeoClue), from
 the IP address, or a city of your choice.
""")
    (debian / 'postinst').write_text(f"""#!/bin/sh
set -e
if [ "$1" = "configure" ]; then
    echo ""
    echo "  {META['name']} installed."
    echo "  Log out and back in, then enable it in the Extensions app"
    echo "  or run:  gnome-extensions enable {UUID}"
    echo ""
fi
exit 0
""")
    (debian / 'postinst').chmod(0o755)

    for path in root.rglob('*'):
        if path.parent != debian or path.name != 'postinst':
            path.chmod(0o755 if path.is_dir() else 0o644)

    DIST.mkdir(exist_ok=True)
    out = DIST / f'{PACKAGE}_{VERSION}_all.deb'
    subprocess.run(['dpkg-deb', '--root-owner-group', '-Zxz', '--build', str(root), str(out)],
                   check=True, stdout=subprocess.DEVNULL)
    print(f'built {out.relative_to(ROOT)}')


def main():
    what = sys.argv[1] if len(sys.argv) > 1 else 'all'
    staged = stage()
    if what in ('zip', 'all'):
        build_zip(staged)
    if what in ('deb', 'all'):
        if shutil.which('dpkg-deb'):
            build_deb(staged)
        else:
            print('dpkg-deb not found: skipping .deb')


if __name__ == '__main__':
    main()
