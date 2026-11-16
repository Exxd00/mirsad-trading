import 'server-only';
import type { QuoteConversion } from '../execution/v1/model';
import { CoinbaseMarketClient, type CoinbaseMarketMapping, type CoinbaseReferenceBook } from './coinbase-market';
import { GnosisMarketClient, parseGnosisMarketMapping, type GnosisMarketMapping, type GnosisMarketOptions, type GnosisProvisionalConversion } from './gnosis-market';
import { sqlGnosisEurStateStore } from './gnosis-eur-state-store';
import { cowNetwork } from './cow-network';
import type { CowOrderChainId } from './cow-order';

export type CowMarketMapping = CoinbaseMarketMapping | GnosisMarketMapping;
export interface CowMarketPort {
  catalog(): Promise<CowMarketMapping[]>;
  candles(mapping: CowMarketMapping, now: number, after: number | null): Promise<import('../execution/v1/model').Candle[]>;
  referenceBook(currency: string): Promise<CoinbaseReferenceBook>;
  fundingConversion(now: number): Promise<QuoteConversion>;
  valuationCandles(currency: string, since: number, until: number): Promise<{ at: number; price: string }[]>;
  nativeGasReference?(): Promise<CoinbaseReferenceBook>;
  provisionalConversionAt?(currency: string, at: number, previous?: GnosisProvisionalConversion): Promise<GnosisProvisionalConversion>;
}
export function validateCowMarketMappings(chainId: CowOrderChainId, raw: unknown[]): CowMarketMapping[] {
  if (chainId === 100) return raw.map(parseGnosisMarketMapping);
  const mappings = raw as CoinbaseMarketMapping[];
  new CoinbaseMarketClient({ mappings });
  return mappings;
}
export function createCowMarketClient(chainId: CowOrderChainId, mappings?: CowMarketMapping[],
  options?: ConstructorParameters<typeof CoinbaseMarketClient>[0], gnosisOptions?: GnosisMarketOptions): CowMarketPort {
  cowNetwork(chainId);
  return chainId === 1 ? new CoinbaseMarketClient({ ...options, ...(mappings ? { mappings: mappings as CoinbaseMarketMapping[] } : {}) }) as CowMarketPort
    : new GnosisMarketClient({ historyStore: sqlGnosisEurStateStore, ...gnosisOptions,
      ...(mappings ? { mappings: mappings as GnosisMarketMapping[] } : {}) }) as CowMarketPort;
}
