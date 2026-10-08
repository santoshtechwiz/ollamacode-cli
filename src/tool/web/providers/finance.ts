import type { SearchHit, SearchProvider } from '../types';
import { getJson, getText, makeHit, toIso } from './shared';

export const stooq: SearchProvider = {
  id: 'stooq',
  weight: (intent) => (intent.tickers.length ? 0.9 : 0),
  async search(intent, limit, signal) {
    const symbols = intent.tickers.map((t) => `${t.toLowerCase()}.us`).join(',');
    const text = await getText(`https://stooq.com/q/l/?s=${encodeURIComponent(symbols)}&f=sd2t2ohlcv&h&e=csv`, 'stooq', signal);
    const hits: SearchHit[] = [];
    for (const line of text.trim().split('\n').slice(1)) {
      const [symbol, date, time, open, high, low, close, volume] = line.split(',');
      if (!close || close === 'N/D') continue;
      const ticker = symbol.split('.')[0].toUpperCase();
      const hit = makeHit({
        source: 'Stooq',
        title: `${ticker} — close ${close}`,
        url: `https://stooq.com/q/?s=${symbol.toLowerCase()}`,
        snippet: `${ticker} closed at ${close} on ${date}; open ${open}, high ${high}, low ${low}, volume ${volume}.`,
        freshness: 'delayed',
        publishedAt: toIso(`${date}T${time || '00:00:00'}Z`) ?? toIso(date),
        delayNote: 'delayed quote (≈15 min / end of day)',
      });
      if (hit) hits.push(hit);
      if (hits.length >= limit) break;
    }
    return hits;
  },
};

export const yahooChart: SearchProvider = {
  id: 'yahoo-chart',
  weight: (intent) => (intent.tickers.length ? 1 : 0),
  async search(intent, limit, signal) {
    // One request per ticker, all at once: a slow symbol must not hold up the others.
    const settled = await Promise.allSettled(intent.tickers.slice(0, limit).map(async (ticker) => {
      const data = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`, 'yahoo-chart', signal);
      const result = data?.chart?.result?.[0];
      const closes: unknown[] = result?.indicators?.quote?.[0]?.close ?? [];
      const price = result?.meta?.regularMarketPrice ?? [...closes].reverse().find((c) => typeof c === 'number');
      if (typeof price !== 'number') return null;
      // regularMarketTime is the last trade; the chart timestamps mark each daily bar's open, which reads like a stale quote.
      const lastStamp = result?.meta?.regularMarketTime ?? [...(result?.timestamp ?? [])].reverse().find((s) => typeof s === 'number');
      return makeHit({
        source: 'Yahoo Finance',
        title: `${ticker} — last ${price}`,
        url: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}`,
        snippet: `${ticker} last traded around ${price}${result?.meta?.exchangeName ? ` (${result.meta.exchangeName})` : ''}.`,
        freshness: 'delayed',
        publishedAt: lastStamp ? toIso(lastStamp) : undefined,
        delayNote: 'delayed market data',
      });
    }));
    const hits = settled.flatMap((s) => (s.status === 'fulfilled' && s.value ? [s.value] : []));
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (hits.length === 0 && failed) throw failed.reason;
    return hits;
  },
};

export const coingecko: SearchProvider = {
  id: 'coingecko',
  weight: (intent) => (intent.coins.length ? 1 : 0),
  async search(intent, limit, signal) {
    const data = await getJson(
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(intent.coins.join(','))}&vs_currencies=usd&include_last_updated_at=true`,
      'coingecko', signal,
    );
    return intent.coins
      .filter((coin) => typeof data?.[coin]?.usd === 'number')
      .slice(0, limit)
      .map((coin) => makeHit({
        source: 'CoinGecko',
        title: `${coin} — $${data[coin].usd}`,
        url: `https://www.coingecko.com/en/coins/${encodeURIComponent(coin)}`,
        snippet: `${coin} is trading around $${data[coin].usd}.`,
        freshness: 'live',
        publishedAt: toIso(data[coin].last_updated_at),
      }))
      .filter((h): h is SearchHit => h !== null);
  },
};

export const frankfurter: SearchProvider = {
  id: 'frankfurter',
  weight: (intent) => (intent.fx ? 1 : 0),
  async search(intent, _limit, signal) {
    const pair = intent.fx;
    if (!pair) return [];
    const data = await getJson(`https://api.frankfurter.app/latest?from=${pair.from}&to=${pair.to}`, 'frankfurter', signal);
    const rate = data?.rates?.[pair.to];
    if (typeof rate !== 'number') return [];
    const hit = makeHit({
      source: 'Frankfurter (ECB)',
      title: `${pair.from}/${pair.to} — ${rate}`,
      url: 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/',
      snippet: `1 ${pair.from} = ${rate} ${pair.to} (ECB reference rate${data?.date ? ` for ${data.date}` : ''}).`,
      freshness: 'delayed',
      publishedAt: toIso(data?.date),
      delayNote: 'ECB daily reference rate',
    });
    return hit ? [hit] : [];
  },
};
