import {equal, ok, done} from './assert.js';
import {compareVersions, parseDnfCheckUpdate, parseLoginFailure, parseZypperTable} from '../extension/lib/security.js';
import {METEOALARM_COUNTRIES, parseMeteoalarm, parseRss} from '../extension/lib/feeds.js';

ok(compareVersions('7.0.0-38', '6.17.0-20') > 0, 'kernel versions');
ok(compareVersions('1.6.1', '1.6.10') < 0, 'numeric, not lexical');
equal(compareVersions('2.0', '2.0.0'), 0, 'missing parts are zero');

const ssh = parseLoginFailure('2026-10-14T09:12:33+0200 zorin sshd[4121]: Failed password for invalid user admin from 203.0.113.9 port 51234 ssh2');
equal([ssh.service, ssh.user, ssh.host], ['sshd', 'admin', '203.0.113.9'], 'sshd failure line');
ok(ssh.time > 1.7e9, 'timestamp parsed');
const pam = parseLoginFailure('2026-10-14T09:13:01+0200 zorin gdm-password][2210]: pam_unix(gdm-password:auth): authentication failure; logname= uid=0 euid=0 tty=/dev/tty1 ruser= rhost=  user=piorio');
equal([pam.service, pam.user], ['gdm-password', 'piorio'], 'PAM failure line');

const dnf = parseDnfCheckUpdate(`Last metadata expiration check: 0:12:01 ago on Tue 14 Oct 2026 09:00:00.
kernel.x86_64                      6.17.2-300.fc43                 updates
vim-minimal.x86_64                 2:9.1.1000-1.fc43               updates
Obsoleting Packages
foo.noarch                         1.0-1.fc43                      updates
    bar.noarch                     0.9-1.fc43                      @fedora
`);
equal(dnf.map(p => p.name), ['kernel', 'vim-minimal'], 'dnf packages, obsoleting block skipped');
equal(dnf[0].version, '6.17.2-300.fc43', 'dnf version');

const zypper = parseZypperTable(`S | Repository          | Name       | Current Version | Available Version | Arch
--+---------------------+------------+-----------------+-------------------+-------
v | Main Update Repo    | curl       | 8.9.0-1.1       | 8.9.1-1.1         | x86_64
v | Main Update Repo    | libcurl4   | 8.9.0-1.1       | 8.9.1-1.1         | x86_64
`, 'updates');
equal(zypper.map(p => `${p.name} ${p.version}`), ['curl 8.9.1-1.1', 'libcurl4 8.9.1-1.1'], 'zypper updates');
const patches = parseZypperTable(`Repository       | Name                  | Category | Severity  | Interactive | Status | Summary
-----------------+-----------------------+----------+-----------+-------------+--------+--------
Main Update Repo | openSUSE-2026-1234    | security | important | ---         | needed | Security update for curl
`, 'patches');
equal([patches.length, patches[0].name, patches[0].security], [1, 'openSUSE-2026-1234', true], 'zypper patches');

const atom = `<?xml version="1.0"?><feed><entry>
<id>urn:1</id><cap:identifier>2.49.0.1.380.0.IT.260001</cap:identifier>
<cap:event>Orange Wind Warning</cap:event><cap:severity>Severe</cap:severity>
<cap:status>Actual</cap:status><cap:message_type>Alert</cap:message_type>
<cap:onset>2026-10-14T18:00:00+02:00</cap:onset><cap:expires>2026-10-15T06:00:00+02:00</cap:expires>
<cap:areaDesc>Campania</cap:areaDesc><cap:geocode><valueName>EMMA_ID</valueName><value>IT015</value></cap:geocode>
</entry><entry>
<cap:event>Test warning</cap:event><cap:status>Test</cap:status><cap:areaDesc>Lazio</cap:areaDesc>
</entry></feed>`;
const warnings = parseMeteoalarm(atom);
equal(warnings.length, 1, 'test entries skipped');
equal([warnings[0].area, warnings[0].event, warnings[0].code], ['Campania', 'Orange Wind Warning', 'IT015'], 'warning fields');
ok(warnings[0].expires > warnings[0].onset, 'onset before expiry');
ok(warnings[0].link.includes('IT015'), 'link carries the geocode');

const rss = parseRss(`<rss><channel><item><title>Campagne &amp; malware</title><link>https://example.test/1</link>
<pubDate>Mon, 13 Oct 2026 10:00:00 +0200</pubDate><description><![CDATA[<p>Sintesi   della settimana</p>]]></description></item>
<item><title>Second</title><link>https://example.test/2</link></item></channel></rss>`, 1);
equal(rss.length, 1, 'rss limit');
equal(rss[0].title, 'Campagne & malware', 'entities decoded');
ok(rss[0].time > 1.7e9, 'rss date parsed');

const codes = Object.keys(METEOALARM_COUNTRIES);
ok(codes.every(c => /^[A-Z]{2}$/.test(c)), 'country codes are ISO alpha-2');
equal(new Set(Object.values(METEOALARM_COUNTRIES)).size, codes.length, 'feed names are unique');
ok(codes.includes('IT') && codes.includes('NO') && codes.includes('IL'), 'old and new countries present');

done('parsers');
