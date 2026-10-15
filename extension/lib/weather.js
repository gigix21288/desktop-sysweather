// Weather and location lookups. Uses only free services that need no API key:
// Open-Meteo (forecast, air quality, geocoding), ipwho.is and geojs.io (IP
// geolocation), Nominatim (reverse geocoding), INGV and USGS (earthquakes).
import Soup from 'gi://Soup?version=3.0';

import {getJson, newSession} from './http.js';
import {_, uiLanguage} from './i18n.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
const INGV_URL = 'https://webservices.ingv.it/fdsnws/event/1/query';
const USGS_URL = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const QUAKE_DAYS = 7;

/**
 * Maps a WMO weather code to an icon, a description and a color class.
 *
 * @param {number} code WMO weather interpretation code
 * @param {boolean} isDay whether the sun is up
 * @returns {{icon: string, text: string, kind: string}}
 */
export function weatherInfo(code, isDay = true) {
    const sky = (day, night) => (isDay ? day : night);
    switch (code) {
    case 0:
        return {icon: sky('weather-clear-symbolic', 'weather-clear-night-symbolic'), text: _('Clear sky'), kind: sky('sun', 'moon')};
    case 1:
        return {icon: sky('weather-clear-symbolic', 'weather-clear-night-symbolic'), text: _('Mainly clear'), kind: sky('sun', 'moon')};
    case 2:
        return {icon: sky('weather-few-clouds-symbolic', 'weather-few-clouds-night-symbolic'), text: _('Partly cloudy'), kind: sky('sun', 'moon')};
    case 3:
        return {icon: 'weather-overcast-symbolic', text: _('Overcast'), kind: 'cloud'};
    case 45: case 48:
        return {icon: 'weather-fog-symbolic', text: _('Fog'), kind: 'cloud'};
    case 51: case 53: case 55:
        return {icon: 'weather-showers-scattered-symbolic', text: _('Drizzle'), kind: 'rain'};
    case 56: case 57:
        return {icon: 'weather-showers-scattered-symbolic', text: _('Freezing drizzle'), kind: 'rain'};
    case 61:
        return {icon: 'weather-showers-scattered-symbolic', text: _('Light rain'), kind: 'rain'};
    case 63:
        return {icon: 'weather-showers-symbolic', text: _('Rain'), kind: 'rain'};
    case 65:
        return {icon: 'weather-showers-symbolic', text: _('Heavy rain'), kind: 'rain'};
    case 66: case 67:
        return {icon: 'weather-showers-symbolic', text: _('Freezing rain'), kind: 'rain'};
    case 71:
        return {icon: 'weather-snow-symbolic', text: _('Light snow'), kind: 'snow'};
    case 73:
        return {icon: 'weather-snow-symbolic', text: _('Snow'), kind: 'snow'};
    case 75:
        return {icon: 'weather-snow-symbolic', text: _('Heavy snow'), kind: 'snow'};
    case 77:
        return {icon: 'weather-snow-symbolic', text: _('Snow grains'), kind: 'snow'};
    case 80:
        return {icon: 'weather-showers-scattered-symbolic', text: _('Light showers'), kind: 'rain'};
    case 81:
        return {icon: 'weather-showers-symbolic', text: _('Showers'), kind: 'rain'};
    case 82:
        return {icon: 'weather-showers-symbolic', text: _('Violent showers'), kind: 'rain'};
    case 85: case 86:
        return {icon: 'weather-snow-symbolic', text: _('Snow showers'), kind: 'snow'};
    case 95:
        return {icon: 'weather-storm-symbolic', text: _('Thunderstorm'), kind: 'storm'};
    case 96: case 99:
        return {icon: 'weather-storm-symbolic', text: _('Thunderstorm with hail'), kind: 'storm'};
    default:
        return {icon: 'weather-severe-alert-symbolic', text: _('Unknown'), kind: 'cloud'};
    }
}

/**
 * Builds a human readable place name from a geocoding result.
 *
 * @param {object} place an Open-Meteo geocoding result
 * @returns {string}
 */
export function placeLabel(place) {
    return [place.name, place.admin1, place.country]
        .filter((v, i, all) => v && all.indexOf(v) === i)
        .join(', ');
}

/**
 * Great-circle distance between two points.
 *
 * @param {number} lat1 latitude of the first point
 * @param {number} lon1 longitude of the first point
 * @param {number} lat2 latitude of the second point
 * @param {number} lon2 longitude of the second point
 * @returns {number} kilometres
 */
export function distanceKm(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export class WeatherClient {
    constructor() {
        this._session = newSession();
    }

    _getJson(url, params, cancellable, emptyStatuses = []) {
        return getJson(this._session, url, params, cancellable, emptyStatuses);
    }

    /**
     * Searches cities by name.
     *
     * @param {string} name the text to search
     * @param {Gio.Cancellable} cancellable cancels the request
     * @param {object} [extra] additional query parameters
     * @returns {Promise<object[]>}
     */
    async searchCity(name, cancellable, extra = {}) {
        const data = await this._getJson(GEOCODING_URL, {
            name, count: 10, language: uiLanguage(), format: 'json', ...extra,
        }, cancellable);
        return data.results ?? [];
    }

    async _ipLocate(cancellable) {
        try {
            const data = await this._getJson('https://ipwho.is/', {}, cancellable);
            if (data.success) {
                return {
                    city: data.city,
                    region: data.region || null,
                    country: data.country_code,
                    latitude: data.latitude,
                    longitude: data.longitude,
                };
            }
        } catch (e) {
            if (cancellable?.is_cancelled())
                throw e;
        }
        const data = await this._getJson('https://get.geojs.io/v1/ip/geo.json', {}, cancellable);
        return {
            city: data.city,
            region: data.region || null,
            country: data.country_code,
            latitude: parseFloat(data.latitude),
            longitude: parseFloat(data.longitude),
        };
    }

    /**
     * Estimates the current location from the public IP address and
     * resolves a localized place name for it.
     *
     * @param {Gio.Cancellable} cancellable cancels the requests
     * @returns {Promise<{name: string, latitude: number, longitude: number,
     *   region: string|null, country: string|null}>} country as ISO 3166-1 alpha-2
     */
    async locateByIp(cancellable) {
        const ip = await this._ipLocate(cancellable);
        if (!Number.isFinite(ip.latitude) || !Number.isFinite(ip.longitude))
            throw new Error('IP geolocation returned no coordinates');

        let name = ip.city || _('Current location');
        let region = ip.region ?? null;
        if (ip.city) {
            try {
                // Look up the localized city name (e.g. "Naples" -> "Napoli")
                const extra = ip.country ? {countryCode: ip.country} : {};
                const results = await this.searchCity(ip.city, cancellable, extra);
                const near = results.find(r =>
                    Math.abs(r.latitude - ip.latitude) < 0.5 && Math.abs(r.longitude - ip.longitude) < 0.5);
                if (near) {
                    name = near.name;
                    region = near.admin1 || region;
                }
            } catch (e) {
                if (cancellable?.is_cancelled())
                    throw e;
            }
        }
        return {name, latitude: ip.latitude, longitude: ip.longitude, region, country: ip.country?.toUpperCase() || null};
    }

    /**
     * Resolves a localized place name for coordinates (OpenStreetMap data).
     *
     * @param {number} latitude latitude
     * @param {number} longitude longitude
     * @param {Gio.Cancellable} cancellable cancels the request
     * @returns {Promise<{name: string, region: string|null, country: string|null}|null>}
     *   the town name with its region (state) and ISO country code, or null when unknown
     */
    async reverseGeocode(latitude, longitude, cancellable) {
        // ~1 km is plenty for a town name (zoom 10) and reveals less
        const data = await this._getJson(NOMINATIM_URL, {
            lat: latitude.toFixed(2),
            lon: longitude.toFixed(2),
            format: 'jsonv2',
            zoom: 10,
            'accept-language': uiLanguage(),
        }, cancellable);
        const a = data?.address ?? {};
        const name = a.city || a.town || a.village || a.municipality || a.suburb ||
            a.county || data?.name || null;
        if (!name)
            return null;
        return {
            name,
            region: a.state || a.region || a.province || null,
            country: a.country_code ? a.country_code.toUpperCase() : null,
        };
    }

    /**
     * Fetches current conditions, the next two hours in 15 minute steps, the
     * next 24 hours and a 5 day forecast.
     *
     * @param {number} latitude latitude
     * @param {number} longitude longitude
     * @param {string} units "metric" or "imperial"
     * @param {Gio.Cancellable} cancellable cancels the request
     * @returns {Promise<object>}
     */
    forecast(latitude, longitude, units, cancellable) {
        const imperial = units === 'imperial';
        // 3 decimals (~100 m) is finer than any Open-Meteo model grid
        return this._getJson(FORECAST_URL, {
            latitude: latitude.toFixed(3),
            longitude: longitude.toFixed(3),
            current: 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,' +
                'weather_code,is_day,precipitation,uv_index',
            minutely_15: 'precipitation,weather_code',
            forecast_minutely_15: 8,
            hourly: 'temperature_2m,precipitation_probability,precipitation,weather_code,uv_index,wind_speed_10m,is_day',
            forecast_hours: 24,
            daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max,uv_index_max',
            timezone: 'auto',
            forecast_days: 5,
            temperature_unit: imperial ? 'fahrenheit' : 'celsius',
            wind_speed_unit: imperial ? 'mph' : 'kmh',
        }, cancellable);
    }

    /**
     * Fetches the current air quality, UV index and pollen (pollen is only
     * available in Europe and comes back as null elsewhere).
     *
     * @param {number} latitude latitude
     * @param {number} longitude longitude
     * @param {Gio.Cancellable} cancellable cancels the request
     * @returns {Promise<object|null>} the "current" block
     */
    async airQuality(latitude, longitude, cancellable) {
        const data = await this._getJson(AIR_QUALITY_URL, {
            latitude: latitude.toFixed(3),
            longitude: longitude.toFixed(3),
            current: 'european_aqi,us_aqi,pm2_5,pm10,uv_index,alder_pollen,birch_pollen,' +
                'grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen',
            timezone: 'auto',
        }, cancellable);
        return data?.current ?? null;
    }

    /**
     * Recent earthquakes around a point: INGV for Italy, USGS elsewhere.
     *
     * @param {number} latitude latitude
     * @param {number} longitude longitude
     * @param {number} radiusKm search radius
     * @param {number} minMagnitude smallest magnitude to report
     * @param {Gio.Cancellable} cancellable cancels the request
     * @returns {Promise<{list: object[], source: string}>} newest first, each
     *   {time (unix seconds), magnitude, place, distanceKm, depthKm}
     */
    async earthquakes(latitude, longitude, radiusKm, minMagnitude, cancellable) {
        const inItaly = latitude >= 35 && latitude <= 47.5 && longitude >= 6 && longitude <= 19;
        const start = new Date(Date.now() - QUAKE_DAYS * 86400 * 1000).toISOString().slice(0, 19);
        let data;
        let source;
        if (inItaly) {
            source = 'INGV';
            data = await this._getJson(INGV_URL, {
                starttime: start,
                lat: latitude.toFixed(3),
                lon: longitude.toFixed(3),
                maxradiuskm: radiusKm,
                minmag: minMagnitude,
                format: 'geojson',
                orderby: 'time',
                limit: 10,
            }, cancellable, [Soup.Status.NO_CONTENT, Soup.Status.NOT_FOUND]);
        } else {
            source = 'USGS';
            data = await this._getJson(USGS_URL, {
                format: 'geojson',
                starttime: start,
                latitude: latitude.toFixed(3),
                longitude: longitude.toFixed(3),
                maxradiuskm: radiusKm,
                minmagnitude: minMagnitude,
                orderby: 'time',
                limit: 10,
            }, cancellable, [Soup.Status.NO_CONTENT]);
        }
        const list = (data?.features ?? []).map(f => {
            const p = f.properties ?? {};
            const [lon, lat, depth] = f.geometry?.coordinates ?? [longitude, latitude, 0];
            let time = NaN;
            if (typeof p.time === 'number')
                time = p.time / 1000;
            else if (typeof p.time === 'string')
                time = Date.parse(p.time.endsWith('Z') ? p.time : `${p.time}Z`) / 1000;
            return {
                time,
                magnitude: Number(p.mag),
                place: p.place ?? '',
                distanceKm: distanceKm(latitude, longitude, lat, lon),
                depthKm: Number(depth) || 0,
            };
        }).filter(q => Number.isFinite(q.time) && Number.isFinite(q.magnitude));
        list.sort((a, b) => b.time - a.time);
        return {list, source};
    }

    destroy() {
        this._session.abort();
        this._session = null;
    }
}
