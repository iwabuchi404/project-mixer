export function normalizeLocalBrowserUrl(value) {
  const input = String(value || '').trim();
  if (!input) return null;
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `http://${input}`;
  try {
    const url = new URL(candidate);
    const isHttp = url.protocol === 'http:' || url.protocol === 'https:';
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    return isHttp && isLocal ? url.href : null;
  } catch {
    return null;
  }
}

export function getBrowserTabLabel(value) {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return String(value);
  }
}
