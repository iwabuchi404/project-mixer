const DEFAULT_BASE_URL = 'https://api.devin.ai';

function normalizeDevinSessionId(value) {
  const text = String(value || '').trim();
  const match = text.match(/(?:^|[/\s])(devin-[A-Za-z0-9_-]+)(?:$|[/?#\s])/)
    || text.match(/^(devin-[A-Za-z0-9_-]+)$/);
  return match ? match[1] : null;
}

function mapDevinSessionStatus(session) {
  const detail = session?.status_detail || null;
  if (detail === 'working') {
    return { kind: 'turn_started', reason: null, eventType: 'working' };
  }
  if (detail === 'waiting_for_user') {
    return { kind: 'needs_attention', reason: 'input', eventType: detail };
  }
  if (detail === 'waiting_for_approval') {
    return { kind: 'needs_attention', reason: 'approval', eventType: detail };
  }
  if (detail === 'finished') {
    return { kind: 'turn_completed', reason: null, eventType: detail };
  }
  if (session?.status === 'error' || detail === 'error') {
    return { kind: 'turn_failed', reason: 'error', eventType: detail || 'error' };
  }
  const failedSuspension = session?.status === 'suspended'
    && detail
    && !['inactivity', 'user_request'].includes(detail);
  if (failedSuspension) {
    return { kind: 'turn_failed', reason: detail || 'suspended', eventType: detail || 'suspended' };
  }
  return null;
}

class DevinSessionMonitor {
  constructor({
    token,
    orgId,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    intervalMs = 10000,
    onLifecycleEvent = () => {},
    onError = () => {},
  } = {}) {
    this.token = token || '';
    this.orgId = orgId || '';
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.intervalMs = intervalMs;
    this.onLifecycleEvent = onLifecycleEvent;
    this.onError = onError;
    this.bindings = new Map();
    this.timer = null;
  }

  validateConfiguration() {
    if (!this.token || !this.orgId) {
      return { ok: false, error: 'Set DEVIN_API_TOKEN and DEVIN_ORG_ID before starting Project Mixer.' };
    }
    if (!this.orgId.startsWith('org-')) {
      return { ok: false, error: 'DEVIN_ORG_ID must start with org-.' };
    }
    if (typeof this.fetchImpl !== 'function') {
      return { ok: false, error: 'HTTP fetch is unavailable in this runtime.' };
    }
    return { ok: true };
  }

  async bind({ ptyId, sessionId: input }) {
    const configuration = this.validateConfiguration();
    if (!configuration.ok) return configuration;
    const sessionId = normalizeDevinSessionId(input);
    if (!sessionId) {
      return { ok: false, error: 'Enter a Devin Cloud session ID such as devin-abc123.' };
    }

    const binding = {
      ptyId,
      provider: 'devin',
      sessionId,
      lastStatusKey: null,
      inFlight: false,
      reportedError: null,
    };
    const previous = this.bindings.get(ptyId);
    this.bindings.set(ptyId, binding);
    const result = await this.pollBinding(binding);
    if (!result.ok) {
      if (previous) this.bindings.set(ptyId, previous);
      else this.bindings.delete(ptyId);
      return result;
    }
    this.ensureTimer();
    return {
      ok: true,
      binding: { provider: 'devin', sessionId, status: result.status },
    };
  }

  unbind(ptyId) {
    const removed = this.bindings.delete(ptyId);
    if (this.bindings.size === 0) this.stopTimer();
    return removed;
  }

  ensureTimer() {
    if (this.timer || this.bindings.size === 0) return;
    this.timer = setInterval(() => { void this.pollAll(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stopTimer() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  dispose() {
    this.stopTimer();
    this.bindings.clear();
  }

  async pollAll() {
    await Promise.all(Array.from(this.bindings.values(), (binding) => this.pollBinding(binding)));
  }

  async pollBinding(binding) {
    if (binding.inFlight) return { ok: true, skipped: true };
    binding.inFlight = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const url = `${this.baseUrl}/v3/organizations/${encodeURIComponent(this.orgId)}/sessions/${encodeURIComponent(binding.sessionId)}`;
      const response = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = `Devin API returned ${response.status}.`;
        this.reportErrorOnce(binding, error);
        return { ok: false, error };
      }
      const session = await response.json();
      const lifecycle = mapDevinSessionStatus(session);
      const status = session.status_detail || session.status || 'unknown';
      binding.reportedError = null;
      if (lifecycle) {
        const statusKey = `${lifecycle.kind}:${lifecycle.reason || ''}:${lifecycle.eventType}`;
        if (statusKey !== binding.lastStatusKey) {
          binding.lastStatusKey = statusKey;
          this.onLifecycleEvent({
            ...lifecycle,
            source: 'devin',
            ptyId: binding.ptyId,
            sessionId: binding.sessionId,
          });
        }
      }
      return { ok: true, status };
    } catch (error) {
      const message = error?.name === 'AbortError'
        ? 'Devin API request timed out.'
        : 'Could not reach the Devin API.';
      this.reportErrorOnce(binding, message);
      return { ok: false, error: message };
    } finally {
      clearTimeout(timeout);
      binding.inFlight = false;
    }
  }

  reportErrorOnce(binding, message) {
    if (binding.reportedError === message) return;
    binding.reportedError = message;
    this.onError({
      source: 'devin',
      ptyId: binding.ptyId,
      sessionId: binding.sessionId,
      message,
    });
  }
}

module.exports = {
  DevinSessionMonitor,
  mapDevinSessionStatus,
  normalizeDevinSessionId,
};
