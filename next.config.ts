import type { NextConfig } from 'next';
const config: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  serverExternalPackages: ['@electric-sql/pglite'],
  async headers() {
    return [{source:'/:path*',headers:[
      {key:'X-Content-Type-Options',value:'nosniff'},
      {key:'X-Frame-Options',value:'DENY'},
      {key:'Referrer-Policy',value:'no-referrer'},
      {key:'Permissions-Policy',value:'camera=(), microphone=(), geolocation=(), payment=()'},
      {key:'Strict-Transport-Security',value:'max-age=31536000; includeSubDomains'},
      {key:'X-Robots-Tag',value:'noindex, nofollow, noarchive'},
    ]}];
  },
};
export default config;
