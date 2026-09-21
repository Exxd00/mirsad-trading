import 'server-only';
import { headers } from 'next/headers';
import { getSession } from './auth';
export async function pageSession(){return getSession(new Request(process.env.APP_ORIGIN??'http://localhost:3000',{headers:await headers()}));}
