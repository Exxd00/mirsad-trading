import type { Metadata, Viewport } from 'next';
import './globals.css';
export const metadata:Metadata={title:'مرصاد | محاكاة تداول تعليمية',description:'بيئة تجريبية تعليمية بأرصدة وأوامر افتراضية بلا قيمة مالية.',manifest:'/manifest.webmanifest',robots:{index:false,follow:false},appleWebApp:{capable:true,statusBarStyle:'black-translucent',title:'مرصاد التجريبية'}};
export const viewport:Viewport={width:'device-width',initialScale:1,themeColor:'#0b111a'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="ar" dir="rtl"><body>{children}</body></html>;}
