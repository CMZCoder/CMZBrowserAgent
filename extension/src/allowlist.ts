const ALLOWED_HOSTS = ['github.com', 'vercel.com', 'cloudflare.com', 'neon.tech', 'comerzio.ch'];

export function isAllowedHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return ALLOWED_HOSTS.some((host) => normalized === host || normalized.endsWith(`.${host}`));
}

export function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return false;
    }

    return isAllowedHost(parsed.hostname);
  } catch {
    return false;
  }
}
