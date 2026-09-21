import 'server-only';
import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { query, transaction } from './db';
import { encryptSecret, decryptSecret } from './secrets';
import { AppError, fail } from './errors';
import { getPublicInstruments, getPublicMarket, RevolutXClient, BrokerApiError, type RevolutMarket, type RevolutInstrument, type RevolutOrder } from './brokers/revolut';
import type { Draft, NormalOrder, TradingPort } from './trading';

export async function setting<T>(key:string,fallback:T):Promise<T>{const r=await query<{value:T}>('SELECT value FROM app_settings WHERE key=$1',[key]);return r.rows[0]?.value??fallback;}
export async function setSetting(key:string,value:unknown){await query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()',[key,JSON.stringify(value)]);}
export const isPreview=()=>!!process.env.VERCEL_ENV&&process.env.VERCEL_ENV!=='production';
export async function audit(event:string,detail:Record<string,unknown>={}){await query('INSERT INTO audit_events(event,detail) VALUES($1,$2)',[event,JSON.stringify(detail)]);}

// Durable coalescing/venue pacing across concurrent serverless instances and tabs.
async function cached<T>(key:string,ttl:number,load:()=>Promise<T>):Promise<T>{
 const cacheKey=`public:${key}`;
 const prior=await setting<{at:number;data:T}|null>(cacheKey,null);
 if(prior&&Date.now()-prior.at<ttl)return prior.data;
 return transaction(async tx=>{
  await tx.query("INSERT INTO app_settings(key,value) VALUES('public_feed_lock','0') ON CONFLICT DO NOTHING");
  const lock=(await tx.query<{value:number}>("SELECT value FROM app_settings WHERE key='public_feed_lock' FOR UPDATE")).rows[0];
  const existing=(await tx.query<{value:{at:number;data:T}}>('SELECT value FROM app_settings WHERE key=$1',[cacheKey])).rows[0]?.value;
  if(existing&&Date.now()-existing.at<ttl)return existing.data;
  const delay=Math.max(0,Number(lock.value)+1100-Date.now());if(delay)await new Promise(r=>setTimeout(r,delay));
  const data=await load();
  await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()',[cacheKey,JSON.stringify({at:Date.now(),data})]);
  await tx.query("UPDATE app_settings SET value=$1,updated_at=NOW() WHERE key='public_feed_lock'",[JSON.stringify(Date.now())]);
  return data;
 });
}
export const instruments=()=>cached<RevolutInstrument[]>('instruments',600000,()=>getPublicInstruments());
export async function market(symbol:string,interval:number){
 if(!/^[A-Z0-9]{2,16}-[A-Z0-9]{2,12}$/.test(symbol)||![1,5,15,60].includes(interval))fail('INVALID_MARKET',400,'الأداة أو الفاصل غير صالح.');
 const list=await instruments();if(!list.some(i=>i.symbol===symbol&&i.status==='active'))fail('UNKNOWN_MARKET',404,'الأداة غير متاحة ضمن أسواق EEA.');
 const m=await cached<RevolutMarket>(`market:${symbol}:${interval}`,3000,()=>getPublicMarket(symbol,interval));
 const age=Date.now()-m.sourceTimestamp;
 const status=age<=15000?'current':age<=60000?'delayed':'stale';
 return {quote:{symbol:m.symbol,last:Number(m.last),bid:Number(m.bid),ask:Number(m.ask),spread:new Decimal(m.ask).sub(m.bid).toNumber(),updatedAt:new Date(m.sourceTimestamp).toISOString(),receivedAt:m.observedAt,source:m.source,status,change24h:Number(m.change24h),low24h:Number(m.low24h),high24h:Number(m.high24h)},candles:m.candles.slice(-200).map(c=>({time:c.start/1000,open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close),volume:Number(c.volume),complete:c.complete,mayBeMidPrice:c.mayBeMidPrice})),instruments:list.map(i=>({symbol:i.symbol,base:i.base,quote:i.quote,status:i.status,minQuantity:i.minOrderSize,quantityStep:i.baseStep,priceStep:i.quoteStep,minNotional:Decimal.max(i.minOrderSizeQuote,'1').toString(),maxQuantity:i.maxOrderSize})),source:'Revolut X · EEA · بيانات سوق عامة',interval,polled:true,candleTimestamp:new Date(m.candleSourceTimestamp).toISOString()};
}
type CredentialMeta={version:string;verifiedAt:string;readVerified:boolean;tradePermissionAcknowledged:boolean;regionConfirmed:boolean};
async function credentials(){
 if(isPreview())return null;
 const row=(await query<{ciphertext:string;metadata:CredentialMeta}>('SELECT ciphertext,metadata FROM broker_credentials WHERE broker=$1',['revolut-x'])).rows[0];
 if(!row)return null;
 const secret=z.object({apiKey:z.string(),privateKey:z.string()}).parse(JSON.parse(decryptSecret(row.ciphertext,'broker:revolut-x')));
 return {client:new RevolutXClient(secret),metadata:row.metadata};
}
export async function connectRevolut(raw:unknown){
 if(isPreview())fail('PREVIEW_LOCKED',403,'إدخال بيانات الوسيط متاح في الموقع الرئيسي فقط.');
 const parsed=z.object({broker:z.literal('revolut-x'),apiKey:z.string().trim().min(8).max(512),privateKey:z.string().min(64).max(8192),tradePermissionAcknowledged:z.boolean().default(false),regionConfirmed:z.literal(true)}).safeParse(raw);
 if(!parsed.success)fail('INVALID_CREDENTIALS',400,'أدخل مفتاح API والمفتاح الخاص وأكد منطقة EEA.');
 const {apiKey,privateKey,tradePermissionAcknowledged,regionConfirmed}=parsed.data;
 const client=new RevolutXClient({apiKey,privateKey});
 // Only read endpoints validate supplied credentials. No probe trade is ever made.
 await client.getBalances();await client.getOrders();
 const metadata:CredentialMeta={version:createHash('sha256').update(apiKey).digest('hex'),verifiedAt:new Date().toISOString(),readVerified:true,tradePermissionAcknowledged,regionConfirmed};
 await transaction(async tx=>{
  await tx.query("INSERT INTO app_settings(key,value) VALUES('order_account_lock:revolut-x','false') ON CONFLICT DO NOTHING");
  await tx.query("SELECT value FROM app_settings WHERE key='order_account_lock:revolut-x' FOR UPDATE");
  const unresolved=await tx.query("SELECT id FROM order_intents WHERE account_id='revolut-x' AND state IN ('SUBMITTING','UNKNOWN') LIMIT 1");
  if(unresolved.rowCount)fail('UNRESOLVED_ORDER',409,'احسم نتيجة الإرسال السابق قبل تغيير الربط.');
  await tx.query('INSERT INTO broker_credentials(broker,ciphertext,metadata) VALUES($1,$2,$3) ON CONFLICT(broker) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,metadata=EXCLUDED.metadata,updated_at=NOW()',['revolut-x',encryptSecret(JSON.stringify({apiKey,privateKey}),'broker:revolut-x'),JSON.stringify(metadata)]);
  await tx.query("INSERT INTO app_settings(key,value) VALUES('live_enabled','false') ON CONFLICT(key) DO UPDATE SET value='false',updated_at=NOW()");
 });
 await audit('broker.read_verified',{broker:'revolut-x'});
 return {connected:true,readVerified:true,tradePermission:'user-declared-not-execution-tested',liveEnabled:false,verifiedAt:metadata.verifiedAt};
}
const emptyAccount=(id:string,name:string,reason:string)=>({id,broker:id,name,status:'disconnected',reason,permissions:{read:false,trade:false},balances:[],positions:[],orders:[],fills:[],updatedAt:null});
function normalized(order:RevolutOrder):NormalOrder{return {...order,status:({pending_new:'PENDING',new:'OPEN',partially_filled:'PARTIALLY_FILLED',filled:'FILLED',cancelled:'CANCELLED',rejected:'REJECTED',replaced:'REPLACED'} as const)[order.status]};}
export async function dashboard(mode='live'){
 const watchlist=await setting<string[]>('watchlist',['BTC-EUR','ETH-EUR','SOL-EUR']);
 if(mode==='simulation'){
  const orders=(await query<{id:string;response:NormalOrder|null;state:string;request:{draft:Draft}}>("SELECT id,response,state,request FROM order_intents WHERE broker='simulation' AND state<>'PREVIEW' ORDER BY created_at DESC LIMIT 100")).rows.map(r=>r.response??{id:r.id,clientOrderId:r.id,symbol:r.request.draft.symbol,side:r.request.draft.side,type:r.request.draft.type,quantity:r.request.draft.quantity,filledQuantity:'0',status:r.state,createdAt:new Date().toISOString()});
  const balances=await simulationBalances();
  return {accounts:[{id:'simulation',broker:'simulation',name:'محفظة المحاكاة المعزولة',status:'simulation',reason:'أموال افتراضية بالكامل؛ لا اتصال بحساب تداول حقيقي.',permissions:{read:true,trade:true},balances,positions:balances.filter(b=>b.currency!=='EUR'&&new Decimal(b.total).gt(0)).map(b=>({symbol:`${b.currency}-EUR`,quantity:b.total,currency:'EUR'})),orders,fills:orders.filter(o=>new Decimal(o.filledQuantity).gt(0)).map(o=>({...o,orderId:o.id,quantity:o.filledQuantity})) ,updatedAt:new Date().toISOString()}],liveEnabled:false,watchlist,audit:[],serverTime:new Date().toISOString(),mode:'simulation'};
 }
 let revolut:Record<string,unknown>=emptyAccount('revolut-x','Revolut X','لم يُربط حساب API. رصيد البنك ومحفظة الأسهم منفصلان عن Revolut X.');
 const connection=await credentials();
 if(connection){
  try{
   const balances=await connection.client.getBalances();
   const brokerOrders=await connection.client.getOrders();
   const orders=brokerOrders.map(normalized);
   const fillResult=await connection.client.getFillsForOrders(brokerOrders,20);
   revolut={id:'revolut-x',broker:'revolut-x',name:'Revolut X',status:'connected',reason:'تمت قراءة الحساب عبر API؛ صلاحية الإرسال لم تختبر بصفقة.',permissions:{read:true,trade:connection.metadata.tradePermissionAcknowledged,tradeVerification:'user-declared'},balances,positions:balances.filter(b=>!['EUR','USD','GBP'].includes(b.currency)&&new Decimal(b.total).gt(0)).map(b=>({symbol:b.currency,quantity:b.total,currency:b.currency,unrealizedPnl:null,pnlNote:'تكلفة الاقتناء الكاملة غير متاحة؛ لم تُخمن الأرباح.'})),orders,fills:fillResult.fills,historyTruncated:fillResult.truncated,historyNote:fillResult.truncated?'سجل التنفيذ يغطي أحدث 20 أمراً منفذاً؛ بقية السجل في منصة الوسيط.':'سجل التنفيذ مستمد من الأوامر المتاحة لدى الوسيط.',updatedAt:new Date().toISOString()};
  }catch{revolut={...emptyAccount('revolut-x','Revolut X','تعذر تحديث الحساب؛ تحقق من المفتاح أو الاتصال أو حدود الطلبات.'),status:'error'};}
 }
 const unresolved=(await query("SELECT id,state,created_at FROM order_intents WHERE broker='revolut-x' AND state IN ('SUBMITTING','UNKNOWN') ORDER BY created_at DESC")).rows;
 const events=(await query('SELECT event,created_at FROM audit_events ORDER BY id DESC LIMIT 15')).rows;
 return {accounts:[revolut,emptyAccount('ibkr','Interactive Brokers','لم يُثبت وجود حساب أو تفويض API. يحتاج الحساب الفردي بوابة مستمرة وجلسة دخول واشتراكات بيانات بحسب المنتج.')],liveEnabled:!isPreview()&&await setting('live_enabled',false),watchlist,audit:events,unresolved,serverTime:new Date().toISOString(),mode:'live'};
}
async function simulationBalances(){return setting<{currency:string;available:string;total:string}[]>('simulation:balances',[{currency:'EUR',available:'10000',total:'10000'}]);}
function simulationOrder(draft:Draft,id:string,price:string,status:string):NormalOrder{return {id,clientOrderId:id,symbol:draft.symbol,side:draft.side,type:draft.type,quantity:draft.quantity,filledQuantity:status==='FILLED'?draft.quantity:status==='PARTIALLY_FILLED'?new Decimal(draft.quantity).div(2).toString():'0',status,price,createdAt:new Date().toISOString(),mode:'simulation'};}
async function settleSimulation(draft:Draft,id:string,status:string){
 const m=await market(draft.symbol,15);const price=draft.type==='limit'?draft.limitPrice!:String(draft.side==='buy'?m.quote.ask:m.quote.bid);
 return transaction(async tx=>{
  const key=`simulation:order:${id}`;
  const old=(await tx.query<{value:NormalOrder}>('SELECT value FROM app_settings WHERE key=$1',[key])).rows[0]?.value;if(old)return old;
  await tx.query("INSERT INTO app_settings(key,value) VALUES('simulation:balances',$1) ON CONFLICT DO NOTHING",[JSON.stringify([{currency:'EUR',available:'10000',total:'10000'}])]);
  const balances=(await tx.query<{value:{currency:string;available:string;total:string}[]}>("SELECT value FROM app_settings WHERE key='simulation:balances' FOR UPDATE")).rows[0].value;
  const order=simulationOrder(draft,id,price,status);
  const qty=new Decimal(order.filledQuantity),amount=qty.mul(price),fee=amount.mul('.0009');
  if(qty.gt(0)){
   const [base,quote]=draft.symbol.split('-');
   for(const currency of [base,quote])if(!balances.some(b=>b.currency===currency))balances.push({currency,available:'0',total:'0'});
   const baseBalance=balances.find(b=>b.currency===base)!,quoteBalance=balances.find(b=>b.currency===quote)!;
   const b=new Decimal(baseBalance.total).add(draft.side==='buy'?qty:qty.negated()),q=new Decimal(quoteBalance.total).add(draft.side==='buy'?amount.add(fee).negated():amount.sub(fee));
   if(b.lt(0)||q.lt(0))throw new AppError('BROKER_REJECTED',400,'رصيد المحاكاة غير كافٍ.');
   baseBalance.total=baseBalance.available=b.toString();quoteBalance.total=quoteBalance.available=q.toString();order.fee=fee.toString();order.feeCurrency=quote;
  }
  await tx.query("UPDATE app_settings SET value=$1,updated_at=NOW() WHERE key='simulation:balances'",[JSON.stringify(balances)]);
  await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2)',[key,JSON.stringify(order)]);
  return order;
 });
}
export function createTradingPort():TradingPort{
 let boundConnection:Awaited<ReturnType<typeof credentials>>=null;
 return {
 async identity(draft,sessionId){
  if(draft.mode==='simulation')return {accountId:'simulation',sessionId,credentialVersion:'simulation-v1'};
  boundConnection=await credentials();if(!boundConnection)fail('NOT_CONNECTED',409,'اربط نفس حساب الوسيط أولاً.');
  return {accountId:'revolut-x',sessionId,credentialVersion:boundConnection.metadata.version};
 },
 async context(draft,sessionId){
  const m=await market(draft.symbol,15),i=m.instruments.find(i=>i.symbol===draft.symbol)!;
  if(draft.mode==='simulation')return {accountId:'simulation',sessionId,credentialVersion:'simulation-v1',liveEnabled:false,readVerified:true,tradeAcknowledged:true,regionConfirmed:true,balances:await simulationBalances(),instrument:i,quote:m.quote};
  const c=await credentials();boundConnection=c;if(!c)fail('NOT_CONNECTED',409,'اربط Revolut X أولاً.');
  return {accountId:'revolut-x',sessionId,credentialVersion:c.metadata.version,liveEnabled:await setting('live_enabled',false),readVerified:c.metadata.readVerified,tradeAcknowledged:c.metadata.tradePermissionAcknowledged,regionConfirmed:c.metadata.regionConfirmed,balances:await c.client.getBalances(),instrument:i,quote:m.quote};
 },
 async submit(draft,id){
  if(draft.mode==='simulation'){
   if(draft.scenario==='reject')throw new AppError('BROKER_REJECTED',400,'رفض محاكى.');
   const status=draft.scenario==='partial'?'PARTIALLY_FILLED':'FILLED';
   const order=await settleSimulation(draft,id,status);
   if(draft.scenario==='unknown')throw new Error('Simulated connection loss after venue acceptance');
   return order;
  }
  const c=boundConnection;if(!c)fail('NOT_CONNECTED',409,'انقطع ربط الوسيط.');
  try{return normalized(await c.client.submitOrder({clientOrderId:id,symbol:draft.symbol,side:draft.side,type:draft.type,quantity:draft.quantity,limitPrice:draft.limitPrice}));}
  catch(error){if(error instanceof BrokerApiError&&error.status&&[400,401,403,404,422,429].includes(error.status))throw new AppError('BROKER_REJECTED',error.status,'رفض الوسيط الطلب.');throw error;}
 },
 async lookup(draft,id){if(draft.mode==='simulation')return setting<NormalOrder|null>(`simulation:order:${id}`,null);const c=boundConnection;if(!c)fail('NOT_CONNECTED',409,'اربط نفس حساب الوسيط للاستعلام.');const order=await c.client.findOrderByClientId(id);return order?normalized(order):null;},
 };
}
export async function settings(){
 const row=(await query<{metadata:CredentialMeta}>("SELECT metadata FROM broker_credentials WHERE broker='revolut-x'")).rows[0];
 return {databaseReady:true,encryptionReady:!!process.env.ENCRYPTION_KEY,preview:isPreview(),liveEnabled:!isPreview()&&await setting('live_enabled',false),revolut:{configured:!!row&&!isPreview(),readVerified:row?.metadata.readVerified??false,tradePermissionAcknowledged:row?.metadata.tradePermissionAcknowledged??false,regionConfirmed:row?.metadata.regionConfirmed??false,verifiedAt:row?.metadata.verifiedAt??null},ibkr:{configured:false,requiresGateway:true,reason:'لا توجد بوابة دائمة أو جلسة API متحققة.'}};
}
export async function toggleLive(enabled:boolean){
 if(isPreview()){if(enabled)fail('PREVIEW_LOCKED',403,'الإرسال الحقيقي محظور في المعاينة.');return {liveEnabled:false};}
 if(enabled){if(isPreview())fail('PREVIEW_LOCKED',403,'الإرسال الحقيقي محظور في المعاينة.');const c=await credentials();if(!c||!c.metadata.regionConfirmed||!c.metadata.tradePermissionAcknowledged)fail('PERMISSIONS_REQUIRED',409,'تحقق من الحساب ونطاق مفتاح التداول ومنطقة EEA أولاً.');await c.client.getBalances();}
 await setSetting('live_enabled',enabled);await audit(enabled?'live.enabled':'live.disabled');return {liveEnabled:enabled};
}
