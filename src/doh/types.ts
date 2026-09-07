// src/doh/types.ts
// RFC 8484 §6: Content-Type for DoH wire format
export const DOH_CONTENT_TYPE = 'application/dns-message';

// RFC 8484 §4.1: DNS ID SHOULD be 0 in DoH (HTTP correlates)
export const DOH_DNS_ID = 0;

// RFC 8484 §4.2: Successful responses are 2xx regardless of DNS rcode
export const DOH_CACHE_TTL_SECONDS = 30;

// Upstream DoH resolver (Cloudflare 1.1.1.1)
export const UPSTREAM_DOH_URL = 'https://cloudflare-dns.com/dns-query';