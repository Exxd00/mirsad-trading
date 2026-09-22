import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest {
  return { name:"مرصاد · محاكاة تداول تعليمية", short_name:"مرصاد تجريبي", description:"تجربة تعليمية بحسابات وأرصدة وأوامر افتراضية بلا قيمة مالية", lang:"ar", dir:"rtl", start_url:"/", scope:"/", display:"standalone", background_color:"#0b100e", theme_color:"#0b100e", orientation:"any", icons:[{src:"/icon-192.png",sizes:"192x192",type:"image/png",purpose:"any"},{src:"/icon-512.png",sizes:"512x512",type:"image/png",purpose:"maskable"},{src:"/icon.svg",sizes:"any",type:"image/svg+xml",purpose:"any"}] };
}
