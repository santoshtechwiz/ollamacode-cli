import type { SearchProvider } from '../types';
import { getJson, makeHit, toIso } from './shared';

const WMO_CODE: Record<number, string> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'depositing rime fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle', 56: 'light freezing drizzle', 57: 'freezing drizzle',
  61: 'slight rain', 63: 'rain', 65: 'heavy rain', 66: 'light freezing rain', 67: 'freezing rain',
  71: 'slight snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'slight showers', 81: 'showers',
  82: 'violent showers', 85: 'slight snow showers', 86: 'snow showers', 95: 'thunderstorm',
  96: 'thunderstorm with slight hail', 99: 'thunderstorm with hail',
};

interface Spot {
  lat: number;
  lon: number;
  label: string;
}

async function geocode(place: string, signal: AbortSignal): Promise<Spot | null> {
  const geo = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`, 'open-meteo', signal);
  const best = geo?.results?.[0];
  return typeof best?.latitude === 'number' && typeof best?.longitude === 'number'
    ? { lat: best.latitude, lon: best.longitude, label: [...new Set([best.name, best.country].filter(Boolean))].join(', ') }
    : null;
}

// All candidate names are asked at once; the longest one the geocoder knows wins, so "Kuala Lumpur" beats "Kuala".
async function geocodeFirst(places: string[], signal: AbortSignal): Promise<Spot | null> {
  const found = await Promise.all(places.map((p) => geocode(p, signal).catch(() => null)));
  return found.find(Boolean) ?? null;
}

// No place named: estimate from the IP, asking both services at once and taking whichever answers.
async function locateByIp(signal: AbortSignal): Promise<Spot | null> {
  const viaIpApi = async (): Promise<Spot> => {
    const ip = await getJson('http://ip-api.com/json/?fields=status,city,country,lat,lon', 'open-meteo', signal);
    if (ip?.status !== 'success') throw new Error('no location');
    return { lat: ip.lat, lon: ip.lon, label: [ip.city, ip.country].filter(Boolean).join(', ') };
  };
  const viaIpapi = async (): Promise<Spot> => {
    const ip = await getJson('https://ipapi.co/json/', 'open-meteo', signal);
    if (typeof ip?.latitude !== 'number') throw new Error('no location');
    return { lat: ip.latitude, lon: ip.longitude, label: [ip.city, ip.country_name].filter(Boolean).join(', ') };
  };
  return Promise.any([viaIpApi(), viaIpapi()]).catch(() => null);
}

export const openMeteo: SearchProvider = {
  id: 'open-meteo',
  weight: (intent) => (intent.weather ? 1 : 0),
  async search(intent, _limit, signal) {
    const named = intent.places ? await geocodeFirst(intent.places, signal) : null;
    const spot = named ?? (await locateByIp(signal));
    if (!spot) return [];
    const fc = await getJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${spot.lat}&longitude=${spot.lon}` +
        '&current=temperature_2m,precipitation,weathercode&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
        '&timezone=auto&forecast_days=1',
      'open-meteo', signal,
    );
    const cur = fc?.current;
    const daily = fc?.daily;
    if (!cur || !daily) return [];
    const desc = WMO_CODE[Number(cur.weathercode)] ?? 'unknown conditions';
    const [prob] = daily.precipitation_probability_max ?? [];
    const [tmax] = daily.temperature_2m_max ?? [];
    const [tmin] = daily.temperature_2m_min ?? [];
    const unit = fc?.current_units?.temperature_2m ?? '°C';
    const where = spot.label || 'the area';
    const snippet =
      `In ${where} today: ${desc}, ${cur.temperature_2m}${unit} now` +
      (tmax !== undefined && tmin !== undefined ? ` (high ${tmax}, low ${tmin})` : '') +
      (typeof prob === 'number' ? `, precipitation probability ${prob}%.` : '.') +
      (named
        ? ''
        : intent.places
          ? ` No place called "${intent.places[0]}" was found, so the location is estimated from the IP address; ask for a city for a precise forecast.`
          : ' Location is estimated from the IP address; ask for a city for a precise forecast.');
    const hit = makeHit({
      source: 'Open-Meteo',
      title: `Weather in ${where} — ${desc}`,
      url: 'https://open-meteo.com/en/docs',
      snippet,
      freshness: 'live',
      publishedAt: toIso(cur.time),
    });
    return hit ? [hit] : [];
  },
};
