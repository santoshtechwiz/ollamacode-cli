import type { SearchProvider } from '../types';
import { duckduckgo, wikipedia } from './general';
import { bingNews, hackerNews } from './news';
import { coingecko, frankfurter, stooq, yahooChart } from './finance';
import { openMeteo } from './weather';

/** Every web-search provider; each decides from the query intent whether it is asked. */
export const PROVIDERS: readonly SearchProvider[] = [
  yahooChart, stooq, coingecko, frankfurter, openMeteo, wikipedia, duckduckgo, bingNews, hackerNews,
];
