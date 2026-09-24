import { analyse, berlinDay, POLICY } from './engine.mjs';
import { authorizedReport } from './report-auth.mjs';
const ORIGIN='https://revx.revolut.com';
const MAX_BYTES=256_000;
const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
async function publicJson(path,fetcher=fetch) {
  // Deliberately restricted to public market GETs. No account or order paths.
  if (!/^\/api\/1\.0\/public\/(tickers\?|candles\/(BTC|ETH|SOL)-EUR\?)/.test(path)) throw new Error('path_not_allowed');
  const response=await fetcher(ORIGIN+path,{method:'GET',redirect:'error',headers:{Accept:'application/json'},signal:AbortSignal.timeout(12_000)});
  if (!response.ok) throw new Error(response.status===429?'feed_rate_limited':'feed_unavailable');
  if (Number(response.headers.get('Content-Length')||0)>MAX_BYTES) {await response.body?.cancel();throw new Error('feed_too_large');}
  const reader=response.body?.getReader();if(!reader)throw new Error('feed_empty');
  const chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES){await reader.cancel();throw new Error('feed_too_large');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function runMonitor(env,scheduledTime=Date.now(),fetcher=fetch) {
  const started=Date.now(),owner=crypto.randomUUID();
  const lock=await env.DB.prepare("INSERT INTO monitor_locks(id,owner,expires) VALUES('scan',?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE monitor_locks.expires<? RETURNING owner").bind(owner,started+60_000,started).first();
  if (!lock) return {status:'busy'};
  const symbol=POLICY.symbols[Math.floor(scheduledTime/300_000)%POLICY.symbols.length];
  try {
    let report;
    try {
      const [tickers,candles]=await Promise.all([
        publicJson(`/api/1.0/public/tickers?symbols=${symbol}&region=EEA`,fetcher),
        publicJson(`/api/1.0/public/candles/${symbol}?interval=60&region=EEA`,fetcher),
      ]);
      report=analyse(symbol,tickers,candles,Date.now());
    } catch(error) {
      const known=['feed_rate_limited','feed_unavailable','feed_too_large','feed_empty'];
      const reason=known.includes(error?.message)?error.message:error?.name==='SyntaxError'?'feed_invalid_json':['TimeoutError','AbortError'].includes(error?.name)?'feed_timeout':'feed_error';
      report={version:POLICY.version,symbol,observedAt:Date.now(),decision:'blocked',reason,executionEnabled:false};
      // All fetches above are public and carry no credentials. Persist only the
      // exception class to distinguish transport/format errors without bodies.
      report.errorClass=String(error?.name??'Unknown').slice(0,40);
    }
    if(report.decision==='candidate') {
      const id=`${POLICY.version}:${symbol}:${report.candleEnd}`;
      const day=berlinDay(report.observedAt);
      const admitted=await env.DB.prepare('INSERT OR IGNORE INTO monitor_candidates(id,symbol,candle_end,day,observed_at,expires_at,report) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM monitor_candidates WHERE day=?) < ? RETURNING id')
        .bind(id,symbol,report.candleEnd,day,report.observedAt,report.candleEnd+900_000,JSON.stringify(report),day,POLICY.maxIdeasPerDay).first();
      if(admitted)report={...report,ideaId:id,reason:'idea_recorded_for_review'};
      else report={...report,decision:'wait',reason:'duplicate_or_daily_limit'};
    }
    await env.DB.batch([
      env.DB.prepare('INSERT INTO monitor_runs(id,at,symbol,status,reason) VALUES(?,?,?,?,?)').bind(owner,report.observedAt,symbol,report.decision,report.reason),
      env.DB.prepare('INSERT INTO monitor_latest(symbol,updated_at,report) VALUES(?,?,?) ON CONFLICT(symbol) DO UPDATE SET updated_at=excluded.updated_at,report=excluded.report').bind(symbol,report.observedAt,JSON.stringify(report)),
    ]);
    // Bounded cleanup of monitor data only. Historical paper records untouched.
    if(Math.floor(scheduledTime/300_000)%288===0){
      const cutoff=started-90*86_400_000;
      await env.DB.batch([
        env.DB.prepare('DELETE FROM monitor_runs WHERE id IN (SELECT id FROM monitor_runs WHERE at<? ORDER BY at LIMIT 400)').bind(cutoff),
        env.DB.prepare('DELETE FROM monitor_candidates WHERE id IN (SELECT id FROM monitor_candidates WHERE observed_at<? ORDER BY observed_at LIMIT 50)').bind(cutoff),
      ]);
    }
    return report;
  } finally {
    await env.DB.prepare("DELETE FROM monitor_locks WHERE id='scan' AND owner=?").bind(owner).run();
  }
}
export async function getReport(env,now=Date.now()) {
  const day=berlinDay(now),since=now-86_400_000;
  const [latest,counts,ideas]=await env.DB.batch([
    env.DB.prepare('SELECT symbol,updated_at,report FROM monitor_latest ORDER BY symbol'),
    env.DB.prepare('SELECT status,COUNT(*) AS count FROM monitor_runs WHERE at>=? GROUP BY status').bind(since),
    env.DB.prepare('SELECT id,observed_at,expires_at,report FROM monitor_candidates WHERE day=? ORDER BY observed_at').bind(day),
  ]);
  return {version:POLICY.version,mode:'signals-only',executionEnabled:false,capital:null,performance:null,generatedAt:now,day,policy:POLICY,
    markets:latest.results.map(row=>({...JSON.parse(row.report),stale:now-row.updated_at>20*60_000})),
    runCounts24h:counts.results,ideas:ideas.results.map(row=>({id:row.id,observedAt:row.observed_at,expired:row.expires_at<now,...JSON.parse(row.report)})),
    actualOrdersSubmitted:0,notes:['No broker credentials or private endpoints are used.','Ideas are not fills; no fabricated capital or profit.','Loss limits and scaling require reconciled performance evidence; they are not currently managing positions.']};
}
export default {
  async scheduled(controller,env){await runMonitor(env,controller.scheduledTime);},
  async fetch(request,env){
    const path=new URL(request.url).pathname;
    if(request.method!=='GET')return json({error:'method_not_allowed'},405);
    if(path!=='/report')return json({error:'not_found'},404);
    if(!await authorizedReport(request))return json({error:'authentication_required'},401);
    try{return json(await getReport(env));}catch{return json({mode:'signals-only',executionEnabled:false,error:'report_unavailable'},503);}
  },
};
