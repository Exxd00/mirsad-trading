export const HOUR = 3_600_000;
export const CONFIG = Object.freeze({
  mode: 'paper-forward', batchId: 'PAPER-BTC-EUR-FWD-20260924-v1', strategyVersion: 'sma-10-30-forward-v1',
  symbol: 'BTC-EUR', currency: 'EUR', region: 'EEA', intervalMs: HOUR, fast: 10, slow: 30,
  maxHoldBars: 48, initialCash: 1000, notional: 100, feeBps: 10, slippageBps: 5,
  maxSignalDelayMs: 120_000, maxQuoteAgeMs: 60_000, maxCatchupBars: 48,
  reviewTrades: 30, reviewDays: 14, executionModel: 'observed-ask-bid-plus-slippage-v1',
  source: 'Revolut X public EEA',
});
const API = 'https://revx.revolut.com/api/1.0/public';
const iso = (ms: number) => new Date(ms).toISOString();
const round = (n: number) => Math.round(n * 1e8) / 1e8;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: {'cache-control': 'no-store'} });
export async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export type Candle = {start: number; open: number; high: number; low: number; close: number; volume: number};
type Quote = {bid: number; ask: number; sourceMs: number; observedMs: number};
type Position = {entryId: string; executionMs: number; price: number; quantity: number; fee: number; slippage: number};
type Run = {id: string; observedMs: number; finishedMs: number; scheduledMs: number; status: string; error: string | null; processed: number};
type State = {batchId: string; configHash: string; startedMs: number | null; lastClosed: number | null;
  cash: number; position: Position | null; closedCount: number; slot: number; reviewDue: boolean; lastRun: Run | null};
type Event = {id: string; batchId: string; side: 'BUY' | 'SELL'; signalMs: number; observedMs: number;
  executionMs: number | null; quoteSourceMs: number | null; quoteObservedMs: number | null;
  referencePrice: number | null; price: number | null; quantity: number | null; fee: number | null;
  slippage: number | null; delayMs: number; reason: string; status: string};
type Result = {id: string; batchId: string; strategyVersion: string; symbol: string; currency: string;
  entryId: string; exitId: string; closedAt: string; closedMs: number; quantity: number;
  entryPrice: number; exitPrice: number; gross: number; fees: number; slippage: number; net: number};
export type Dependencies = {clock: () => number; fetch: typeof fetch};
const live: Dependencies = {clock: () => Date.now(), fetch: (...args) => fetch(...args)};
class FeedError extends Error {}
const reject = (code: string): never => {throw new FeedError(code);};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject('SOURCE_SCHEMA');
  return value as Record<string, unknown>;
}
function numeric(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return reject('SOURCE_NUMBER');
  const n = Number(value);
  if (!Number.isFinite(n)) return reject('SOURCE_NUMBER');
  return n;
}
function timestamp(value: unknown, now: number): number {
  const n = numeric(value);
  if (!Number.isSafeInteger(n) || n > now + 5000 || now - n > CONFIG.maxQuoteAgeMs) return reject('SOURCE_STALE_TIMESTAMP');
  return n;
}
async function readJSON(url: URL, deps: Dependencies): Promise<unknown> {
  let response: Response;
  try { response = await deps.fetch(url, {headers: {accept: 'application/json'}, redirect: 'error', signal: AbortSignal.timeout(10000)}); }
  catch { return reject('SOURCE_NETWORK'); }
  if (!response.ok) return reject(`SOURCE_HTTP_${response.status}`);
  if (!response.headers.get('content-type')?.includes('application/json') || !response.body) return reject('SOURCE_NOT_JSON');
  const reader = response.body.getReader(), parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > 262144) { await reader.cancel(); return reject('SOURCE_TOO_LARGE'); }
      parts.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) {bytes.set(part, offset); offset += part.length;}
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {if (error instanceof FeedError) throw error; return reject('SOURCE_JSON_OR_READ');}
}
export function parseCandles(input: unknown, from: number, until: number, now: number): {bars: Candle[]; sourceMs: number} {
  const data = object(input), meta = object(data.metadata);
  if (meta.region !== CONFIG.region || !Array.isArray(data.data) || data.data.length > 100) return reject('SOURCE_SCHEMA');
  const sourceMs = timestamp(meta.timestamp, now), by = new Map<number, Candle>();
  for (const raw of data.data) {
    const x = object(raw), c: Candle = {start: numeric(x.start), open: numeric(x.open), high: numeric(x.high), low: numeric(x.low), close: numeric(x.close), volume: numeric(x.volume)};
    if (!Number.isSafeInteger(c.start) || c.start % HOUR || c.start < from || c.start > until ||
      [c.open,c.high,c.low,c.close].some(p => p <= 0) || c.volume < 0 ||
      c.high < Math.max(c.open,c.close,c.low) || c.low > Math.min(c.open,c.close,c.high)) return reject('SOURCE_INVALID_CANDLE');
    // Public pages can include the still-open candle exactly at `until`.
    if (c.start === until) continue;
    const previous = by.get(c.start);
    if (previous && JSON.stringify(previous) !== JSON.stringify(c)) return reject('SOURCE_CONFLICTING_CANDLE');
    by.set(c.start, c);
  }
  const bars: Candle[] = [];
  for (let t = from; t < until; t += HOUR) {
    const c = by.get(t); if (!c) return reject('SOURCE_GAP'); bars.push(c);
  }
  return {bars, sourceMs};
}
async function getCandles(from: number, until: number, deps: Dependencies) {
  const url = new URL(`${API}/candles/${CONFIG.symbol}`);
  url.search = new URLSearchParams({interval:'60',region:CONFIG.region,since:String(from),until:String(until)}).toString();
  return parseCandles(await readJSON(url, deps), from, until, deps.clock());
}
async function getQuote(deps: Dependencies): Promise<Quote> {
  const url = new URL(`${API}/tickers`);
  url.search = new URLSearchParams({symbols:CONFIG.symbol,region:CONFIG.region}).toString();
  const data = object(await readJSON(url, deps)), observedMs = deps.clock();
  if (!Array.isArray(data.data)) return reject('QUOTE_SCHEMA');
  const rows = data.data.map(object).filter(t => String(t.symbol).replace('/', '-') === CONFIG.symbol && t.region === CONFIG.region);
  if (rows.length !== 1) return reject('QUOTE_SYMBOL_OR_REGION');
  const bid = numeric(rows[0].bid), ask = numeric(rows[0].ask);
  if (bid <= 0 || ask < bid) return reject('QUOTE_PRICE');
  return {bid,ask,observedMs,sourceMs:timestamp(object(data.metadata).timestamp, observedMs)};
}
const sma = (bars: Candle[], end: number, count: number) => bars.slice(end-count+1,end+1).reduce((s,b)=>s+b.close,0)/count;
export function signal(bars: Candle[], i: number): 'BUY' | 'SELL' | null {
  if (i < CONFIG.slow) return null;
  const pf=sma(bars,i-1,CONFIG.fast), ps=sma(bars,i-1,CONFIG.slow), cf=sma(bars,i,CONFIG.fast), cs=sma(bars,i,CONFIG.slow);
  return pf<=ps && cf>cs ? 'BUY' : pf>=ps && cf<cs ? 'SELL' : null;
}
function emptyState(configHash: string): State {
  return {batchId:CONFIG.batchId,configHash,startedMs:null,lastClosed:null,cash:CONFIG.initialCash,position:null,closedCount:0,slot:-1,reviewDue:false,lastRun:null};
}
async function commit(db: D1Database, version: number, state: State, bars: Candle[], sourceMs: number | null, events: Event[], results: Result[], run: Run) {
  const records = bars.map(c => ({...c, observedMs:run.observedMs, sourceMs}));
  // The CHECK guard is evaluated inside the SAME transaction as all mutations. A stale
  // invocation (including one that stalled for minutes) cannot commit or release another run.
  await db.batch([
    db.prepare('INSERT INTO commit_guard(id,ok) VALUES(1,(SELECT version=? FROM state WHERE id=1))').bind(version),
    db.prepare("INSERT OR IGNORE INTO candles(start_ms,payload) SELECT json_extract(value,'$.start'),value FROM json_each(?)").bind(JSON.stringify(records)),
    db.prepare("INSERT INTO events(id,batch_id,signal_ms,status,payload) SELECT json_extract(value,'$.id'),json_extract(value,'$.batchId'),json_extract(value,'$.signalMs'),json_extract(value,'$.status'),value FROM json_each(?)").bind(JSON.stringify(events)),
    db.prepare("INSERT INTO results(id,batch_id,closed_ms,payload) SELECT json_extract(value,'$.id'),json_extract(value,'$.batchId'),json_extract(value,'$.closedMs'),value FROM json_each(?)").bind(JSON.stringify(results)),
    db.prepare('INSERT INTO runs(id,observed_ms,status,payload) VALUES(?,?,?,?)').bind(run.id,run.observedMs,run.status,JSON.stringify(run)),
    db.prepare('UPDATE state SET version=version+1,payload=? WHERE id=1').bind(JSON.stringify(state)),
    db.prepare('DELETE FROM commit_guard WHERE id=1'),
  ]);
}
export async function runTick(db: D1Database, scheduledMs: number, deps: Dependencies = live): Promise<{status: string; error?: string | null}> {
  const observedMs = deps.clock(), slot = Math.floor(observedMs/60000);
  const snapshot = await db.prepare('SELECT version,payload FROM state WHERE id=1').first<{version:number;payload:string}>();
  if (!snapshot) throw new Error('SCHEMA_MISSING');
  const configHash = await digest(CONFIG);
  const original: State = JSON.parse(snapshot.payload) ?? emptyState(configHash);
  if (original.configHash !== configHash || original.batchId !== CONFIG.batchId) throw new Error('CONFIG_REQUIRES_NEW_DATABASE_BATCH');
  if (original.slot >= slot) return {status:'duplicate'};
  let state: State = structuredClone(original), bars: Candle[] = [], sourceMs: number | null = null;
  const events: Event[] = [], results: Result[] = [];
  const run: Run = {id:`${CONFIG.batchId}:${slot}`,scheduledMs,observedMs,finishedMs:observedMs,status:'ok',error:null,processed:0};
  try {
    const end = Math.floor(observedMs/HOUR)*HOUR;
    if (state.lastClosed !== null && state.lastClosed + HOUR >= end) {
      run.status = 'idle';
    } else {
      const until = state.lastClosed === null ? end : Math.min(end,state.lastClosed+(CONFIG.maxCatchupBars+1)*HOUR);
      const from = state.lastClosed === null ? until-(CONFIG.slow+1)*HOUR : state.lastClosed-CONFIG.slow*HOUR;
      ({bars,sourceMs} = await getCandles(from, until, deps));
      const stored = await db.prepare('SELECT start_ms,payload FROM candles WHERE start_ms>=? AND start_ms<? ORDER BY start_ms').bind(from,until).all<{start_ms:number;payload:string}>();
      for (const old of stored.results) {
        const c: Candle = JSON.parse(old.payload), fresh = bars.find(b=>b.start===old.start_ms);
        if (!fresh || ['open','high','low','close','volume'].some(k=>c[k as keyof Candle]!==fresh[k as keyof Candle])) reject('SOURCE_STORED_CONFLICT');
      }
      if (state.startedMs === null) {
        state.startedMs = deps.clock(); state.lastClosed = bars.at(-1)!.start; run.status='initialized';
        // Warm-up establishes the baseline; it never creates historical fills.
      } else {
        for (let i=0;i<bars.length;i++) {
          const bar=bars[i]; if (bar.start<=state.lastClosed!) continue;
          const signalMs=bar.start+HOUR, cross=signal(bars,i), position=state.position;
          const aged=position!==null && signalMs-position.executionMs>=CONFIG.maxHoldBars*HOUR;
          const side=position && (cross==='SELL'||aged) ? 'SELL' : !position&&cross==='BUY' ? 'BUY' : null;
          if (side) {
            const reason=side==='BUY'?'SMA_CROSS_UP':cross==='SELL'?'SMA_CROSS_DOWN':'MAX_HOLD';
            const observedSignal=deps.clock();
            const event: Event={id:await digest([configHash,CONFIG.batchId,side,bar.start]),batchId:CONFIG.batchId,side,
              signalMs,observedMs:observedSignal,executionMs:null,quoteSourceMs:null,quoteObservedMs:null,
              referencePrice:null,price:null,quantity:null,fee:null,slippage:null,
              delayMs:observedSignal-signalMs,reason,status:'missed_delay'};
            if (signalMs>state.startedMs && event.delayMs>=0 && event.delayMs<=CONFIG.maxSignalDelayMs) {
              if (bar.volume===0) event.status='skipped_zero_volume';
              else {
                const quote=await getQuote(deps), executionMs=deps.clock();
                // Recheck after network latency; never stamp the earlier invocation time as a fill.
                event.delayMs=executionMs-signalMs;
                if (event.delayMs<=CONFIG.maxSignalDelayMs && executionMs-quote.sourceMs<=CONFIG.maxQuoteAgeMs) {
                  const referencePrice=side==='BUY'?quote.ask:quote.bid;
                  const price=referencePrice*(1+(side==='BUY'?1:-1)*CONFIG.slippageBps/10000);
                  const quantity=side==='BUY'?CONFIG.notional/price:position!.quantity;
                  const fee=price*quantity*CONFIG.feeBps/10000, slippage=Math.abs(price-referencePrice)*quantity;
                  if (side==='BUY' && state.cash<CONFIG.notional+fee) event.status='skipped_cash';
                  else {
                    Object.assign(event,{status:'paper_filled',executionMs,quoteSourceMs:quote.sourceMs,quoteObservedMs:quote.observedMs,referencePrice,price,quantity,fee,slippage});
                    if (side==='BUY') {
                      state.position={entryId:event.id,executionMs,price,quantity,fee,slippage}; state.cash-=CONFIG.notional+fee;
                    } else {
                      const gross=(price-position!.price)*quantity, fees=position!.fee+fee;
                      results.push({id:await digest([position!.entryId,event.id]),batchId:CONFIG.batchId,strategyVersion:CONFIG.strategyVersion,
                        symbol:CONFIG.symbol,currency:CONFIG.currency,entryId:position!.entryId,exitId:event.id,closedAt:iso(executionMs),closedMs:executionMs,
                        quantity,entryPrice:position!.price,exitPrice:price,gross:round(gross),fees:round(fees),
                        slippage:round(position!.slippage+slippage),net:round(gross-fees)});
                      state.cash+=price*quantity-fee; state.position=null; state.closedCount++;
                    }
                  }
                }
              }
            }
            events.push(event);
          }
          state.lastClosed=bar.start; run.processed++;
        }
      }
    }
  } catch (error) {
    if (!(error instanceof FeedError)) throw error;
    state=structuredClone(original); bars=[]; sourceMs=null; events.length=0; results.length=0;
    run.status='blocked'; run.error=error.message; run.processed=0;
  }
  run.finishedMs=deps.clock(); state.slot=slot; state.lastRun=run;
  state.reviewDue=state.closedCount>=CONFIG.reviewTrades || (state.startedMs!==null && run.finishedMs-state.startedMs>=CONFIG.reviewDays*24*HOUR);
  try {await commit(db,snapshot.version,state,bars,sourceMs,events,results,run);}
  catch (error) {
    const current=await db.prepare('SELECT version FROM state WHERE id=1').first<{version:number}>();
    if (current && current.version!==snapshot.version) return {status:'superseded'};
    throw error;
  }
  return {status:run.status,error:run.error};
}
export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runTick(env.DB,event.scheduledTime).then(result=>{console.log(JSON.stringify(result));}));
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname!=='/health' || request.method!=='GET') return new Response('Not found',{status:404});
    try {
      const row=await env.DB.prepare('SELECT payload FROM state WHERE id=1').first<{payload:string}>();
      const s: State | null=row?JSON.parse(row.payload):null;
      const age=s?.lastRun?Date.now()-s.lastRun.finishedMs:Infinity;
      const status=!s?.startedMs?'not_initialized':age>180000?'stale':s.lastRun?.status==='blocked'?'blocked':'ok';
      return json({status,mode:CONFIG.mode,batchId:CONFIG.batchId,strategy:CONFIG.strategyVersion,
        startedAt:s?.startedMs?iso(s.startedMs):null,lastRunAt:s?.lastRun?iso(s.lastRun.finishedMs):null,
        lastClosed:s?.lastClosed?iso(s.lastClosed):null,error:s?.lastRun?.error??null,
        closedResults:s?.closedCount??0,openPositions:s?.position?1:0,reviewDue:s?.reviewDue??false},status==='ok'?200:503);
    } catch {return json({status:'database_unavailable',mode:CONFIG.mode},503);}
  },
} satisfies ExportedHandler<Env>;
