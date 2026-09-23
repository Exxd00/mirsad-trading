import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateConfig, runResearch, csv, hash } from './engine.mjs';
import { pageCandles } from './feed.mjs';

const dir=dirname(fileURLToPath(import.meta.url));
const config=validateConfig(JSON.parse(await fs.readFile(join(dir,'config.json'),'utf8')));
const now=Date.now(), step=config.intervalMinutes*60000, until=Math.floor(now/step)*step;
const since=Date.parse(config.start)-(config.slow+2)*step;
const out=join(dir,'output'); await fs.mkdir(out,{recursive:true});
let report;
const requests=[];
try {
  if (until<=since || (until-since)/step>config.maxCandles) throw Error('HISTORY_LIMIT_REQUIRES_NEW_BATCH');
  const all=[];
  for(let from=since;from<until;from+=99*step){
    if(from>since)await new Promise(r=>setTimeout(r,1200));
    const end=Math.min(from+99*step,until);
    const url=new URL('https://revx.revolut.com/api/1.0/public/candles/'+config.symbol);
    url.search=new URLSearchParams({interval:String(config.intervalMinutes),region:'EEA',since:String(from),until:String(end)}).toString();
    // This process has no broker credentials and only performs public GETs.
    const res=await fetch(url,{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!res.ok)throw Error('PUBLIC_FEED_HTTP_'+res.status);
    if(!res.headers.get('content-type')?.includes('application/json'))throw Error('PUBLIC_FEED_NOT_JSON');
    const data=await res.json();
    if(data.metadata?.region!=='EEA'||!Array.isArray(data.data))throw Error('PUBLIC_FEED_SCHEMA');
    requests.push({since:from,until:end,count:data.data.length,first:data.data[0]?.start,last:data.data.at(-1)?.start});
    all.push(...pageCandles(data,from,end));
  }
  // Reject truncated/old or missing history rather than making up continuity.
  const starts=new Set(all.map(c=>c.start));
  for(let t=since;t<until;t+=step)if(!starts.has(t))throw Error('PUBLIC_FEED_MISSING_CANDLES');
  report=runResearch(all,config,now);
  await fs.writeFile(join(out,'candles.json'),JSON.stringify({source:report.source,asOf:report.generatedAt,candles:all}));
  await fs.writeFile(join(out,'results.csv'),csv(report));
} catch(error) {
  // Publish explicit failure; consumers keep prior successful records unchanged.
  const code=/^[A-Z0-9_]+$/.test(error.message)?error.message:'PUBLIC_FEED_UNAVAILABLE';
  report={schemaVersion:1,status:'unavailable',mode:'paper-research',generatedAt:new Date(now).toISOString(),config,configHash:hash(config),error:code,diagnostics:{requests,...error.diagnostics},records:[]};
}
await fs.writeFile(join(out,'latest.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,records:report.records.length,error:report.error}));
