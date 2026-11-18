import { keccak256, stringToHex } from 'viem';
import { CONFIG, decimal, type Candle } from '../../src/lib/execution/v1/model';
import type { CowMarketPort } from '../../src/lib/wallet/cow-market-port';
import { GNOSIS_MARKET_PROVIDER, GNOSIS_WETH_MAPPING,
  parseGnosisMarketMapping, type GnosisProvisionalConversion } from '../../src/lib/wallet/gnosis-market';

/** An explicitly synthetic external reference-data boundary for composed
 * chain100 software tests. It performs no network IO and does not certify
 * GnosisMarketClient, real oracle/pool history, liquidity or any live fill.
 * USDCE and XDAI deliberately have different EUR values; no peg is assumed.
 * Actual factory, authority, execution, cancellation and reporting guards must
 * remain unmocked by callers of this helper. All clock values are seconds. */
export function syntheticGnosisReference(clock: () => number, spot: () => string): CowMarketPort {
  const sourceId = 'synthetic-gnosis-reference-port-v1';
  const step = 900, minute = 60;
  const timestamp = (value: number) => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('synthetic_reference_time_invalid');
    return value;
  };
  const initialClose = Math.floor(timestamp(clock()) / step) * step;
  const initialOpen = initialClose - CONFIG.warmupCandles * step;
  if (initialOpen < 0) throw new Error('synthetic_reference_time_invalid');
  const rateAt = Math.max(0, initialClose - minute);
  const historicalPrice = (currency: string) => {
    if (currency === 'USDCE') return '0.91';
    if (currency === 'XDAI') return '0.83';
    if (currency === 'WETH') return '150';
    throw new Error('synthetic_reference_currency_unscoped');
  };
  const currentPrice = (currency: string) => {
    if (currency !== 'WETH') return historicalPrice(currency);
    const value = decimal(spot());
    if (!value.gt(0)) throw new Error('synthetic_reference_price_invalid');
    return value.toFixed();
  };
  const book = async (currency: string) => {
    const now = timestamp(clock()), price = currentPrice(currency);
    return { currency, productId: `synthetic-gnosis-${currency.toLowerCase()}-eur`,
      bid: price, ask: price, tradeId: 'synthetic-current-reference',
      sourceId, tradeAt: now, readAt: now, referenceOnly: true as const };
  };
  return {
    catalog: async () => [{ ...GNOSIS_WETH_MAPPING }],
    async candles(mapping, now, after) {
      const parsed = parseGnosisMarketMapping(mapping);
      if (parsed.sourceId !== GNOSIS_WETH_MAPPING.sourceId) throw new Error('synthetic_reference_mapping_unscoped');
      const close = Math.floor(timestamp(now) / step) * step;
      if (after === close) return [];
      const start = after === null ? close - CONFIG.warmupCandles * step : timestamp(after);
      if (start < 0 || start % step || start >= close || close - start > CONFIG.warmupCandles * step)
        throw new Error('synthetic_reference_range_invalid');
      const bars: Candle[] = [];
      for (let openTime = start; openTime < close; openTime += step) {
        const index = (openTime - initialOpen) / step;
        // Same synthetic EMA-cross shape as the original composed fixture:
        // gradual rise, a short plateau, then a final 150 EUR completed bar.
        // It is independent of the current quote spot used to trigger exits.
        const price = index < 989 ? decimal('100').add(decimal(String(index)).div('100')).toFixed()
          : index < 999 ? '106' : '150';
        bars.push({ source: CONFIG.candleSource, symbol: 'WETH-EUR', openTime,
          closeTime: openTime + step, open: price, high: price, low: price,
          close: price, volume: '1', complete: true });
      }
      return bars;
    },
    referenceBook: book,
    nativeGasReference: () => book('XDAI'),
    async fundingConversion(now) {
      timestamp(now);
      const observedAt = timestamp(clock());
      return { currency: 'USDCE', eurPerUnit: '0.91', sourceAt: observedAt,
        sourceId: `${sourceId}:funding`, rateAt, rateMaxAgeSeconds: 86400 };
    },
    async valuationCandles(currency, since, until) {
      const price = historicalPrice(currency);
      if (!Number.isSafeInteger(since) || !Number.isSafeInteger(until) || since < 0
        || since % 60000 || until % 60000 || until <= since || until - since > 86400000
        || until > Math.floor(timestamp(clock()) / minute) * 60000)
        throw new Error('synthetic_reference_range_invalid');
      const points: { at: number; price: string }[] = [];
      for (let at = since / 1000 + minute; at <= until / 1000; at += minute) points.push({ at, price });
      return points;
    },
    async provisionalConversionAt(currency, fillAt, previous) {
      if (currency !== 'USDCE' || timestamp(fillAt) > timestamp(clock()))
        throw new Error('synthetic_reference_range_invalid');
      const at = Math.floor(fillAt / minute) * minute, blockTime = at - 1;
      if (blockTime < 0) throw new Error('synthetic_reference_range_invalid');
      const point: GnosisProvisionalConversion = { price: '0.91', at,
        sourceId: GNOSIS_MARKET_PROVIDER,
        fxBlock: { number: String(blockTime), timestamp: blockTime,
          hash: keccak256(stringToHex(`synthetic-gnosis-fx-block:${blockTime}`)) },
        provenanceId: keccak256(stringToHex(`${sourceId}:provisional:${at}:0.91`)),
        referenceOnly: true, finality: 'canonical' };
      if (previous && (previous.price !== point.price || previous.at !== point.at
        || previous.sourceId !== point.sourceId || previous.provenanceId !== point.provenanceId
        || previous.referenceOnly !== true || previous.finality !== 'canonical'
        || previous.fxBlock.number !== point.fxBlock.number || previous.fxBlock.hash !== point.fxBlock.hash
        || previous.fxBlock.timestamp !== point.fxBlock.timestamp))
        throw new Error('synthetic_reference_previous_basis_changed');
      return point;
    },
  };
}
