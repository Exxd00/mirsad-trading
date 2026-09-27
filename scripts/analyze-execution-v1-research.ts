/** Offline signal study. Imports only the existing pure strategy/model/replay. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { CONFIG, decimal, type Candle } from '../src/lib/execution/v1/model';
import { processCandles, validateCandle } from '../src/lib/execution/v1/strategy';
import { replaySignals, ambiguousExit } from '../src/lib/execution/v1/historical';

type Manifest = { symbols: string[]; requestedStart: number; requestedEnd: number; createdAt: string;
  collectionFinishedAt: string; archiveFollowupFinishedAt?: string; gitHead: string; strategyFiles: Record<string, string>;
  predefinedAnalysis: { currentTakerFee: string; feeSource: string } };
type RequestRecord = { name: string; status: number | null; sha256?: string; observedAt: string; url: string; returnedRows?: number };
type RawBar = { start: number; open: string; high: string; low: string; close: string; volume: string };
type RawCandles = { data: RawBar[]; metadata: { region: string; timestamp: number } };
type Level = { price: string; quantity: string };
type Pair = { base: string; quote: string; status: string; min_order_size_quote: string };
type Phase = { name: string; start: number; end: number };
const root = resolve(import.meta.dirname, '..');
const folder = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !folder.startsWith(join(root, 'reports', 'execution-v1') + '/')) throw new Error('research_directory_required');
const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const save = (name: string, value: unknown) => writeFileSync(join(folder, name), JSON.stringify(value, null, 2) + '\n');
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const manifest = read<Manifest>(join(folder, 'manifest.json'));
const requests = read<RequestRecord[]>(join(folder, 'requests.json'));
const iso = (s: number) => new Date(s * 1000).toISOString();
const pct = (price: string, base: string) => decimal(price).div(base).sub(1).mul(100).toNumber();
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const format = (n: number | null, digits = 3) => n === null ? 'غير متاح' : n.toFixed(digits);
const percentText = (n: number | null) => n === null ? 'غير متاح' : format(n) + '%';
const csv = (name: string, rows: Record<string, unknown>[]) => {
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const cell = (v: unknown) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
  writeFileSync(join(folder, name), [columns.map(cell).join(','), ...rows.map(row => columns.map(c => cell(row[c])).join(','))].join('\n') + '\n');
};
const describe = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { n, meanPercent: mean(values), medianPercent: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null,
    minPercent: n ? sorted[0] : null, maxPercent: n ? sorted[n - 1] : null,
    positivePriceChangePercent: n ? values.filter(v => v > 0).length * 100 / n : null };
};
for (const [path, expected] of Object.entries(manifest.strategyFiles)) assert.equal(sha(join(root, path)), expected, 'strategy_changed_since_collection:' + path);
assert.equal(CONFIG.warmupCandles, 1000);
assert.equal(CONFIG.timeframeSeconds, 900);
assert.equal(CONFIG.stopFraction, '0.02');
assert.equal(CONFIG.targetFraction, '0.04');
for (const record of requests.filter(r => r.status === 200)) assert.equal(sha(join(folder, 'raw', record.name + '.json')), record.sha256, 'raw_hash_mismatch');
const pairs = Object.values(read<Record<string, Pair>>(join(folder, 'raw', 'pairs.json')));
mkdirSync(join(folder, 'candles'), { recursive: true });

const all: Record<string, Candle[]> = {};
const quality: { symbol: string; candles: number; firstOpen: string | null; lastClose: string | null;
  missingWithinObservedRange: number; missingInRequested31Days: number; identicalBoundaryDuplicates: number;
  zeroVolumeCandles: number; zeroVolumePercent: number | null; requestedWindowFailures: number;
  currentListingStatus: string; issues: string[]; usableForCommonStudy: boolean }[] = [];
for (const symbol of manifest.symbols) {
  const unique = new Map<number, Candle>();
  const issues: string[] = []; let duplicates = 0;
  const windows = requests.filter(r => r.name.startsWith(symbol + '-window-'));
  for (const request of windows.filter(r => r.status === 200)) {
    const raw = read<RawCandles>(join(folder, 'raw', request.name + '.json'));
    assert.equal(raw.metadata.region, 'EEA', 'region_mismatch');
    assert(Number.isSafeInteger(raw.metadata.timestamp), 'source_timestamp_invalid');
    const url = new URL(request.url), lower = Number(url.searchParams.get('since')) / 1000, upper = Number(url.searchParams.get('until')) / 1000;
    for (const row of raw.data) {
      const openTime = row.start / 1000, closeTime = openTime + 900;
      // Source until is inclusive; discard the open bar at each upper boundary.
      if (openTime < lower || closeTime > upper || closeTime > manifest.requestedEnd || closeTime * 1000 > raw.metadata.timestamp) continue;
      const candle: Candle = { source: CONFIG.candleSource, symbol, openTime, closeTime,
        open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume, complete: true };
      try { validateCandle(candle, symbol, manifest.requestedEnd); }
      catch (error) { issues.push(String(error) + ':' + row.start); continue; }
      const prior = unique.get(openTime);
      if (prior && JSON.stringify(prior) !== JSON.stringify(candle)) issues.push('conflicting_candle:' + openTime);
      else if (prior) duplicates++;
      unique.set(openTime, candle);
    }
  }
  const bars = [...unique.values()].sort((a, b) => a.openTime - b.openTime);
  const missing = bars.slice(1).reduce((n, c, index) => n + Math.max(0, (c.openTime - bars[index].openTime) / 900 - 1), 0);
  const zeroVolume = bars.filter(c => decimal(c.volume).eq(0)).length;
  const failures = windows.filter(r => r.status !== 200).length;
  all[symbol] = bars;
  save('candles/' + symbol + '.json', bars);
  quality.push({ symbol, candles: bars.length, firstOpen: bars.length ? iso(bars[0].openTime) : null,
    lastClose: bars.length ? iso(bars.at(-1)!.closeTime) : null, missingWithinObservedRange: missing,
    missingInRequested31Days: (manifest.requestedEnd - manifest.requestedStart) / 900 - bars.length,
    identicalBoundaryDuplicates: duplicates, zeroVolumeCandles: zeroVolume,
    zeroVolumePercent: bars.length ? zeroVolume * 100 / bars.length : null,
    requestedWindowFailures: failures, currentListingStatus: pairs.find(p => p.base + '-' + p.quote === symbol)?.status ?? 'unknown',
    issues, usableForCommonStudy: bars.length >= 1000 && issues.length === 0 && failures === 0 });
}
const included = quality.filter(q => q.usableForCommonStudy).map(q => q.symbol);
assert(included.length > 0, 'no_symbol_has_valid_warmup');
let common = new Set(all[included[0]].map(c => c.openTime));
for (const symbol of included.slice(1)) {
  const times = new Set(all[symbol].map(c => c.openTime));
  common = new Set([...common].filter(t => times.has(t)));
}
const ordered = [...common].sort((a, b) => a - b), segments: number[][] = [];
for (const t of ordered) {
  if (!segments.length || t !== segments.at(-1)!.at(-1)! + 900) segments.push([]);
  segments.at(-1)!.push(t);
}
const times = segments.sort((a, b) => b.length - a.length || a[0] - b[0])[0];
assert(times && times.length > 1000, 'no_common_contiguous_evaluation_after_warmup');
const commonStart = times[0], commonEnd = times.at(-1)! + 900;
const calibrationUntil = commonStart + 1000 * 900;
const splitAt = calibrationUntil + Math.floor((times.length - 1000) / 2) * 900;
const phases: Phase[] = [{ name: 'all', start: calibrationUntil, end: commonEnd },
  { name: 'earlier', start: calibrationUntil, end: splitAt }, { name: 'later', start: splitAt, end: commonEnd }];
const outputs: Record<string, unknown>[] = [], metrics: Record<string, unknown>[] = [];
const results: { symbol: string; buySignals: number; reverseCrossSignals: number; forward: Record<string, ReturnType<typeof describe>>;
  barriers: Record<string, number>; costPercent: number | null; zeroVolumePercent: number | null }[] = [];
const checks: Record<string, unknown>[] = [];

for (const symbol of included) {
  const bars = all[symbol].filter(c => c.openTime >= commonStart && c.closeTime <= commonEnd);
  assert.equal(bars.length, times.length, 'common_window_mismatch');
  const replay = replaySignals(symbol, bars, calibrationUntil, commonEnd);
  assert.equal(replay.profitability, null, 'research_must_not_invent_profitability');
  const batch = processCandles(symbol, bars, null, commonEnd).signals.filter(s => s.at > calibrationUntil);
  assert.deepEqual(replay.signals, batch, 'batch_vs_sequential_mismatch');
  // Truncating all later bars must not change earlier signals or indicator values.
  const prefixes = [Math.floor(1000 + (bars.length - 1000) / 2), Math.floor(1000 + (bars.length - 1000) * 3 / 4)];
  for (const length of prefixes) {
    const end = bars[length - 1].closeTime;
    const partial = replaySignals(symbol, bars.slice(0, length), calibrationUntil, end);
    assert.deepEqual(partial.signals, replay.signals.filter(s => s.at <= end), 'future_data_changed_past_signals');
  }
  const shorterWarmup = processCandles(symbol, bars.slice(200), null, commonEnd).signals;
  const compareFrom = bars[1199].closeTime;
  const initialIds = new Set(batch.filter(s => s.at > compareFrom).map(s => s.id));
  const restartedIds = new Set(shorterWarmup.filter(s => s.at > compareFrom).map(s => s.id));
  const seedMismatches = [...initialIds].filter(id => !restartedIds.has(id)).length + [...restartedIds].filter(id => !initialIds.has(id)).length;
  checks.push({ symbol, batchMatchesSequential: true, noFutureDataPrefixChecks: prefixes.length,
    sourceCandlesValidated: bars.length, omittedFirst200WarmupBarsSignalMismatches: seedMismatches });
  const atIndex = new Map(bars.map((c, index) => [c.closeTime, index]));
  const buys = replay.signals.filter(s => s.side === 'buy');
  const reverse = replay.signals.filter(s => s.side === 'sell');
  const forward: Record<string, ReturnType<typeof describe>> = {};
  const barriers: Record<string, number> = { upper_4_percent_first: 0, lower_2_percent_first: 0, both_in_same_bar: 0, neither_within_24h: 0, incomplete_24h: 0 };
  for (const signal of replay.signals) {
    const i = atIndex.get(signal.at)!;
    const row: Record<string, unknown> = { symbol, signalId: signal.id, side: signal.side,
      signalCloseUtc: iso(signal.at), referenceClose: signal.close, phase: signal.at <= splitAt ? 'earlier' : 'later',
      sourceCandleVolume: bars[i].volume, sourceCandleMayBeMidPrice: decimal(bars[i].volume).eq(0) };
    for (const horizon of [4, 16, 96]) row['forward_' + horizon / 4 + 'h_price_percent'] = i + horizon < bars.length ? pct(bars[i + horizon].close, signal.close) : null;
    if (signal.side === 'buy') {
      let outcome = 'incomplete_24h';
      if (i + 96 < bars.length) {
        outcome = 'neither_within_24h';
        const future = bars.slice(i + 1, i + 97), stop = decimal(signal.close).mul('0.98').toFixed(), target = decimal(signal.close).mul('1.04').toFixed();
        row.max_upward_price_excursion_24h_percent = Math.max(0, ...future.map(c => pct(c.high, signal.close)));
        row.max_downward_price_excursion_24h_percent = Math.min(0, ...future.map(c => pct(c.low, signal.close)));
        for (const c of future) {
          const hitLow = decimal(c.low).lte(stop), hitHigh = decimal(c.high).gte(target);
          if (ambiguousExit(c, stop, target).ambiguous) { outcome = 'both_in_same_bar'; break; }
          if (hitLow || hitHigh) { outcome = hitLow ? 'lower_2_percent_first' : 'upper_4_percent_first'; break; }
        }
      }
      barriers[outcome]++;
      row.price_barrier_observation_24h = outcome;
    }
    outputs.push(row);
  }
  for (const phase of phases) {
    const phaseBuys = buys.filter(s => s.at > phase.start && s.at <= phase.end);
    for (const horizon of [4, 16, 96]) {
      const complete = phaseBuys.filter(s => s.at + horizon * 900 <= phase.end);
      const values = complete.map(s => pct(bars[atIndex.get(s.at)! + horizon].close, s.close));
      const baseline = bars.filter(c => c.closeTime > phase.start && c.closeTime + horizon * 900 <= phase.end)
        .map(c => pct(bars[atIndex.get(c.closeTime)! + horizon].close, c.close));
      const summary = describe(values), baselineMean = mean(baseline);
      if (phase.name === 'all') forward[String(horizon / 4)] = summary;
      metrics.push({ symbol, phase: phase.name, horizonHours: horizon / 4, totalBuySignals: phaseBuys.length,
        incompleteHorizonSignals: phaseBuys.length - complete.length, ...summary,
        unconditionalObservations: baseline.length, unconditionalMeanPercent: baselineMean,
        signalMinusUnconditionalMeanPercentagePoints: summary.meanPercent === null || baselineMean === null ? null : summary.meanPercent - baselineMean });
    }
  }
  const bookRequest = requests.find(r => r.name === symbol + '-book');
  let costPercent: number | null = null;
  if (bookRequest?.status === 200) {
    const book = read<{ data: { bids: Level[]; asks: Level[] }; metadata: { timestamp: number; region: string } }>(join(folder, 'raw', symbol + '-book.json'));
    assert.equal(book.metadata.region, 'EEA');
    const bids = book.data.bids.filter(l => decimal(l.quantity).gt(0)).sort((a, b) => decimal(b.price).cmp(a.price));
    const asks = book.data.asks.filter(l => decimal(l.quantity).gt(0)).sort((a, b) => decimal(a.price).cmp(b.price));
    assert(bids.length && asks.length && decimal(asks[0].price).gt(bids[0].price), 'invalid_or_crossed_book');
    const spread = decimal(asks[0].price).sub(bids[0].price).div(asks[0].price).mul(100);
    costPercent = spread.add(decimal(manifest.predefinedAnalysis.currentTakerFee).mul(200)).toNumber();
  }
  results.push({ symbol, buySignals: buys.length, reverseCrossSignals: reverse.length, forward, barriers,
    costPercent, zeroVolumePercent: quality.find(q => q.symbol === symbol)!.zeroVolumePercent });
}

const archiveChecks = read<{ symbol: string; firstPageRows?: number; secondPageRows?: number; completeDay?: boolean;
  requestedFrom?: string; requestedUntil?: string; rows?: number; alternativeCandleQuery?: string }[]>(join(folder, 'older-archive-checks.json'));
const olderTrades = archiveChecks.filter(c => c.firstPageRows !== undefined);
const completedOldDays = olderTrades.filter(c => c.completeDay).map(c => `${c.symbol} (${(c.firstPageRows ?? 0) + (c.secondPageRows ?? 0)} صفقة)`).join('، ') || 'لا توجد عينة يوم مكتملة';
const summary = { kind: 'signal_price_study_not_executed_trade_performance', generatedAt: new Date().toISOString(),
  source: CONFIG.candleSource, version: CONFIG.strategyVersion, manifest, includedSymbols: included,
  commonWindow: { from: iso(commonStart), until: iso(commonEnd), candlesPerSymbol: times.length,
    warmupUntil: iso(calibrationUntil), evaluationDays: (commonEnd - calibrationUntil) / 86400, splitAt: iso(splitAt) },
  quality, results, temporalAndHorizonMetrics: metrics, verification: checks, olderArchiveChecks: archiveChecks,
  researchToolHashes: Object.fromEntries(['scripts/collect-execution-v1-research.py', 'scripts/analyze-execution-v1-research.ts'].map(path => [path, sha(join(root, path))])),
  executionPnl: null, accountDrawdown: null, tradeWinRate: null, reason: 'historical_execution_and_costs_not_available',
  olderArchiveProbes: requests.filter(r => r.name.includes('-probe-')),
  limitations: ['Present-day candidate universe; no first-launch or delisted-token cohort.',
    'No balance, position, order, fill, or historical bid/ask simulation.',
    'Price changes start from a candle close, not an executable entry fill.',
    'Zero-volume source candles may represent mid prices.',
    'Same-symbol and cross-symbol observations can overlap and are correlated.',
    'Chronological halves are short descriptive checks, not proof across market regimes.',
    'Current book/fees are separated from historical price results; no historical net return is inferred.',
    'Strategy signals do not apply live account, position, cost, TTL, or allocation gates.'] };
save('summary.json', summary);
save('verification.json', checks);
csv('coverage.csv', quality.map(q => ({ ...q, issues: q.issues.join(';') })));
csv('signals.csv', outputs);
csv('horizon-metrics.csv', metrics);
csv('summary.csv', results.map(r => ({ symbol: r.symbol, buySignals: r.buySignals, reverseCrossSignals: r.reverseCrossSignals,
  mean1hPricePercent: r.forward['1'].meanPercent, mean4hPricePercent: r.forward['4'].meanPercent,
  complete24hSignals: r.forward['24'].n, mean24hPricePercent: r.forward['24'].meanPercent,
  snapshotSpreadPlusTwoTakerFeesPercent: r.costPercent, zeroVolumeCandlesPercent: r.zeroVolumePercent, ...r.barriers })));

const totalBuys = results.reduce((n, r) => n + r.buySignals, 0);
const zeroProbes = requests.filter(r => r.name.includes('-probe-') && r.status === 200 && r.returnedRows === 0).length;
const rows = results.map(r => `| ${r.symbol} | ${r.buySignals} | ${percentText(r.forward['4'].meanPercent)} | ${percentText(r.forward['24'].meanPercent)} | ${percentText(r.forward['24'].medianPercent)} | ${r.forward['24'].n} |`).join('\n');
const costRows = results.map(r => `| ${r.symbol} | ${percentText(r.costPercent)} |`).join('\n');
const barrierRows = results.map(r => `| ${r.symbol} | ${r.barriers.upper_4_percent_first} | ${r.barriers.lower_2_percent_first} | ${r.barriers.both_in_same_bar} | ${r.barriers.neither_within_24h} | ${r.barriers.incomplete_24h} |`).join('\n');
const halves = results.map(r => {
  const get = (phase: string) => metrics.find(m => m.symbol === r.symbol && m.phase === phase && m.horizonHours === 24)!;
  const a = get('earlier'), b = get('later');
  return `| ${r.symbol} | ${percentText(a.meanPercent as number | null)} (${a.n}) | ${percentText(b.meanPercent as number | null)} (${b.n}) |`;
}).join('\n');
const coverageRows = quality.map(q => `| ${q.symbol} | ${q.candles} | ${q.firstOpen ?? 'غير متاح'} | ${q.missingWithinObservedRange} | ${format(q.zeroVolumePercent, 1)}% |`).join('\n');
const report = `# مرصاد — تقييم أولي للإشارات على بيانات المصدر

تاريخ الجمع: ${manifest.createdAt} إلى ${manifest.archiveFollowupFinishedAt ?? manifest.collectionFinishedAt}. جميع الأوقات أدناه UTC؛ برلين في هذا التقرير UTC+2.

## النتيجة وحدودها

جُمعت بيانات ${manifest.symbols.length} أزواج مرشحة، وحُللت ${included.length} أزواج بقواعد الإصدار ${CONFIG.strategyVersion} دون تغييرها. ظهرت ${totalBuys} إشارة شراء في نافذة التقييم المشتركة. هذه إشارات حسابية وليست صفقات مؤكدة أو أوامر جاهزة للتنفيذ.

النافذة المشتركة: ${iso(commonStart)} إلى ${iso(commonEnd)}، بعدد ${times.length} شمعة لكل أصل. استُخدمت أول 1,000 شمعة للتهيئة حتى ${iso(calibrationUntil)}؛ تبقى ${format((commonEnd - calibrationUntil) / 86400, 2)} يومًا للتقييم. المقارنة الممتدة لأشهر غير مكتملة: أعاد ${zeroProbes} طلب استطلاع للشموع الأقدم استجابات ناجحة خالية من البيانات. ومع ذلك، أثبت فحص مستقل وجود صفقات سوقية أقدم لدى المصدر، كما هو موضح أدناه.

الربح الصافي، وتراجع رصيد الحساب، ونسبة نجاح الصفقات: **غير متاحة**. لا توجد في هذا التقرير تعبئات مفترضة أو محفظة أو أرصدة بديلة. لم تُقرأ بيانات الحساب ولم يُرسل طلب تداول.

## حركة السعر بعد إشارات الشراء

القيم تغير إغلاق المصدر من سعر شمعة الإشارة بعد 4 و24 ساعة، قبل تكاليف التنفيذ. لا تدخل الإشارات المبتورة في المتوسط أو الوسيط. عدد الإشارات الكلي يشمل غير مكتملة الأفق. يتضمن CSV أيضًا أفق ساعة وإشارات الانعكاس الهابط؛ هذه ليست عمليات بيع منفذة ولا بيعًا على المكشوف.

| الزوج | إشارات شراء | متوسط بعد 4 ساعات | متوسط بعد 24 ساعة | وسيط بعد 24 ساعة | العينة المكتملة 24 ساعة |
|---|---:|---:|---:|---:|---:|
${rows}

المتوسط قد يتأثر بحركة واحدة كبيرة. مثلًا في PEPE بلغ أفضل تغير بعد 24 ساعة ${percentText(results.find(r => r.symbol === 'PEPE-EUR')?.forward['24'].maxPercent ?? null)}، بينما كان وسيط تغير السعر ${percentText(results.find(r => r.symbol === 'PEPE-EUR')?.forward['24'].medianPercent ?? null)}. لذلك لا تعني مشاهدة قفزة كبيرة أن أغلب الإشارات كانت جيدة، أو أن الوقف كان سيسمح بالبقاء حتى القفزة.

## لمس حدود السعر الحالية خلال 24 ساعة

المرجع هنا سعر إغلاق شمعة الإشارة؛ في التداول الحقيقي يبدأ الوقف والهدف من متوسط التعبئة. هذه ملاحظات عن مسار السعر، لا نتائج تنفيذ للحماية. قد يغلق المحرك عند انعكاس هابط قبل أي من هذه الأحداث، وهو غير ممثل هنا.

| الزوج | +4% أولًا | −2% أولًا | الحدّان في شمعة واحدة | لم يلمس أي حد | أفق غير مكتمل |
|---|---:|---:|---:|---:|---:|
${barrierRows}

توضح هذه المقارنة أثر مسار السعر: ارتفاع الإغلاق لاحقًا لا يلغي احتمال لمس حد −2% قبله. ولا تثبت الشمعة أن أمرًا كان سينفذ عند ذلك الحد دون انزلاق.

## تكلفة التنفيذ — لقطة منفصلة عن التاريخ

مؤشر التكلفة = فرق ask/bid مقسومًا على ask + رسم taker الحالي للطرفين (0.09% لكل طرف). هو لقطة من وقت الجمع، لا يشمل أثر كمية الأمر أو تأخر الشبكة أو التنفيذ المستقبلي، ولم يُطرح من النتائج التاريخية. الأسعار والمعرّفات الزمنية الأصلية محفوظة في raw. الحد الحالي في الإعدادات 0.4% يطبّق أيضًا متطلبات تنفيذ أخرى لا يختبرها هذا المؤشر.

| الزوج | مؤشر فرق السعر والرسم للطرفين |
|---|---:|
${costRows}

## فحص الثبات الزمني

قُسمت فترة ما بعد التهيئة إلى نصفين عند ${iso(splitAt)}. لم تُضبط معاملات الاستراتيجية على أي منهما. تُستبعد النتائج التي يمتد أفقها خارج النصف نفسه. قصر الفترتين وتداخل الإشارات يمنعان اعتبار المقارنة إثباتًا إحصائيًا للاستقرار.

| الزوج | متوسط تغير السعر 24 ساعة — النصف الأول (العينة) | النصف الثاني (العينة) |
|---|---:|---:|
${halves}

يتضمن horizon-metrics.csv مرجعًا وصفيًا هو متوسط تغير السعر على الأفق نفسه من جميع الشموع المؤهلة في الأصل والفترة نفسيهما. الفرق عن هذا المرجع ليس دليلًا سببيًا أو ربحًا قابلًا للتنفيذ.

## جودة الأرشيف

| الزوج | الشموع المكتملة المجموعة | أول شمعة UTC | شموع مفقودة داخل النطاق المشاهد | حجم صفر |
|---|---:|---|---:|---:|
${coverageRows}

تصف Revolut شموع انعدام الحجم بأنها قد تعتمد على متوسط bid/ask. لم نملأ الفجوات أو نستبدل بيانات منصة أخرى. نافذة المقارنة هي أطول تسلسل مشترك متصل. أي عيوب واستبعادات موثقة في coverage.csv وsummary.json. اختيرت العملات التسع قبل الجمع من مرشحي النقاش الحالي؛ هذه ليست عينة إطلاقات جديدة أو عينة تشمل العملات المشطوبة والفاشلة.

## التحقق من مسار الأرشيف الأقدم

نجحت قراءة صفقات السوق العامة من نافذة يوم واحد قبل 90 يومًا للأزواج ${olderTrades.length}، وتطابقت تواريخها وأزواجها ومنطقة EEA مع الطلب. تحققنا من صفحتين متتاليتين لـ BTC دون تكرار معرّفات. العينات المكتملة إلى نهاية اليوم بحسب انتهاء ترقيم الصفحات: ${completedOldDays}؛ أما بقية العينات فلم تُستكمل إلى نهاية اليوم. بقي طلب شموع BTC بفاصل 15 دقيقة مع until فقط عند ذلك التاريخ فارغًا.

هذا يثبت إمكانية قراءة عينات أقدم من المصدر، ولا يثبت اكتمال أرشيف ثلاثة أشهر. واجهة الصفقات موثقة بحد 100 سجل للصفحة وطلب واحد في الثانية. لم نحول الصفحات الجزئية إلى شموع أو نخلطها بالأرشيف الحالي؛ إعادة بناء شموع من الصفقات وحدها ستختلف عن شموع المصدر التي قد تستخدم mid عند انعدام الحجم. تفاصيل نطاق كل طلب وحالة اكتماله في older-archive-checks.json والبيانات الأصلية في raw.

## القواعد والتحقق

- شراء عند تقاطع EMA20 صعودًا فوق EMA50 مع إغلاق فوق EMA200 واتجاه EMA200 صاعد مقارنة بأربع شمعات سابقة؛ الانعكاس الهابط ينتج إشارة بيع.
- استُخدمت strategy.ts وhistorical.ts الموجودتان مباشرة، مع بصمات الملفات والإعدادات والبيانات الخام في manifest.json وrequests.json.
- تحققت مطابقة الحساب المتسلسل لحساب الدفعة، وثبات الإشارات عند حذف البيانات اللاحقة، وصحة الشموع وتوقيتها. نتائج الحساسية لبدء التهيئة بعد حذف أول 200 شمعة في verification.json.
- تتابع signals.csv لمس حدود السعر +4% و−2% خلال 24 ساعة بعد إشارة الشراء. لمس الحدين في شمعة واحدة يبقى غامض الترتيب. هذه ملاحظات سعرية لا تثبت خروجًا فعليًا؛ الحماية الحية تبدأ من متوسط التعبئة الفعلي، وقد تنزلق أو تتأخر.
- لا تطبق هذه الدراسة شروط الحساب الحي أو المراكز القائمة أو حجم التخصيص أو عمر الإشارة أو تكلفة كل أمر. لذلك لا تساوي أعداد الإشارات عدد الصفقات التي كان المحرك سينفذها.

## القرار العملي

تستخدم هذه النتائج لتحديد ما يستحق بحثًا إضافيًا. لا تكفي نافذة قصيرة لتوسيع التداول أو اختيار عملة رابحة أو تعديل وقف 2% وهدف 4%. يلزم تاريخ أطول من المصدر، وتوثيق تكلفة التنفيذ عند كل إشارة، وعدد أكبر من المشاهدات قبل تقييم الربحية. لم يُضف جدول جمع دوري؛ هذا الأرشيف لقطة بحثية واحدة قابلة لإعادة التحليل دون شبكة.

## إعادة إنتاج التقرير

من جذر المستودع: node --import tsx scripts/analyze-execution-v1-research.ts reports/execution-v1/${folder.split('/').at(-1)}

الجمع العام لمرة جديدة: python3 scripts/collect-execution-v1-research.py (ينشئ مجلدًا جديدًا، ويحترم أكثر من ثانية بين الطلبات).

## المصادر

- [توثيق الشموع ودفتر الأوامر والصفقات العامة](https://developer.revolut.com/docs/api/revolut-x-crypto-exchange).
- [رسوم Revolut X — المصدر الحالي](https://www.revolut.com/en-DE/legal/crypto-exchange-fees/)؛ [جدول الرسوم المستخدم](${manifest.predefinedAnalysis.feeSource}).
- المصدر البرمجي: الالتزام ${manifest.gitHead}، مع الإعدادات وبصمات الملفات المحفوظة في manifest.json.
`;
writeFileSync(join(folder, 'README.md'), report);
console.log(JSON.stringify({ report: join(folder, 'README.md'), symbols: included, candlesPerSymbol: times.length,
  evaluationDays: (commonEnd - calibrationUntil) / 86400, totalBuySignals: totalBuys, qualityIssues: quality.filter(q => q.issues.length), checks,
  results: results.map(r => ({ symbol: r.symbol, buys: r.buySignals, complete24h: r.forward['24'].n,
    mean24hPricePercent: r.forward['24'].meanPercent, snapshotCostPercent: r.costPercent })) }, null, 2));
