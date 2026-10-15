import {equal, ok, done} from './assert.js';
import {
    clockTimeLabel, clockLabel, formatDuration, hourMinuteLabel, localToUnix,
    moonPhase, normalizeName, regionMatches, setClockFormat, uvInfo,
} from '../extension/lib/sky.js';

const t = 1792061689; // 2026-10-15 10:54:49 UTC

setClockFormat('24h');
equal(clockTimeLabel(t, 'UTC'), '10:54:49', 'seconds in UTC');
equal(clockTimeLabel(t, 'Asia/Tokyo'), '19:54:49', 'seconds in Tokyo');
equal(clockTimeLabel(t, 'Nowhere/Land'), clockTimeLabel(t), 'unknown zone falls back to the system zone');
equal(clockLabel(t, 'Europe/Rome'), '12:54', 'hour and minute in Rome');
equal(hourMinuteLabel(15, 5), '15:05', '24 h label');

setClockFormat('12h');
equal(clockTimeLabel(t, 'America/New_York'), '6:54:49 AM', '12 h with seconds');
equal(hourMinuteLabel(0, 7), '12:07 AM', 'midnight in 12 h');
equal(hourMinuteLabel(15, 0, {short: true}), '3 PM', 'short 12 h label');
setClockFormat('24h');

equal(localToUnix('2026-10-15T12:54', 7200), t - 49, 'Open-Meteo local time to unix');
equal(formatDuration(3 * 3600 + 20 * 60), '3 h 20 min', 'duration');

const moon = moonPhase(t);
ok(moon.illumination >= 0 && moon.illumination <= 1, 'moon illumination in range');
ok(typeof moon.name === 'string' && moon.name.length > 0, 'moon phase has a name');

equal(normalizeName('Vallée d\'Aoste'), normalizeName('vallee d aoste'), 'accents and punctuation ignored');
ok(regionMatches('Campania', 'Campania'), 'same region');
ok(regionMatches('Friuli Venezia Giulia', 'Friuli-Venezia Giulia'), 'hyphen vs space');
ok(!regionMatches('Lazio', 'Campania'), 'different regions');

ok(uvInfo(0).level !== uvInfo(8).level, 'uv 0 and uv 8 have different levels');
ok(typeof uvInfo(8).text === 'string' || typeof uvInfo(8).label === 'string', 'uv info carries a text');

done('sky');
