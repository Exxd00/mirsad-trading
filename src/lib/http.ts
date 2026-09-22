import 'server-only';
import { NextResponse } from 'next/server';
import { AuthError } from './auth';
import { AppError } from './errors';
import { BrokerApiError } from './brokers/revolut';
export function json(data:unknown,status=200,extra:Record<string,string>={}){return NextResponse.json(data,{status,headers:{'Cache-Control':'private, no-store, max-age=0','Pragma':'no-cache','Vary':'Cookie',...extra}});}
export function failure(error:unknown){
 if(error instanceof AuthError)return json({error:error.message,code:error.code},error.status,error.retryAfter?{'Retry-After':String(error.retryAfter)}:{});
 if(error instanceof AppError)return json({error:error.message,code:error.code},error.status);
 if(error instanceof BrokerApiError)return json({error:error.status===401||error.status===403?'تعذر التحقق من بيانات الربط التجريبي أو الصلاحيات.':error.code==='CONFIGURATION'?'صيغة المفتاح التجريبي غير صالحة. استخدم مفتاح Ed25519 بصيغة PEM.':error.code==='RATE_LIMIT'?'تم بلوغ حد طلبات مصدر البيانات التجريبي. حاول بعد قليل.':'تعذر الحصول على بيانات المحاكاة التعليمية؛ لن تُعرض أرقام بديلة.',code:error.code},error.status===429?429:502);
 // Never log request bodies, raw provider errors, database URLs, or credentials.
 return json({error:'تعذر إكمال الطلب. تحقق من إعداد قاعدة البيانات والاتصال ثم حاول مجدداً.',code:'SERVICE_UNAVAILABLE'},503);
}
export async function body(request:Request){
 if(!request.headers.get('content-type')?.startsWith('application/json'))throw new AppError('CONTENT_TYPE',415,'صيغة الطلب غير صالحة.');
 const length=Number(request.headers.get('content-length')??0);if(length>16384)throw new AppError('TOO_LARGE',413,'الطلب كبير جداً.');
 const reader=request.body?.getReader();let bytes=0;const chunks:Uint8Array[]=[];
 if(reader){try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>16384){await reader.cancel();throw new AppError('TOO_LARGE',413,'الطلب كبير جداً.');}chunks.push(value);}}finally{reader.releaseLock();}}
 const text=Buffer.concat(chunks).toString('utf8');
 try{return JSON.parse(text);}catch{throw new AppError('INVALID_JSON',400,'صيغة الطلب غير صالحة.');}
}
