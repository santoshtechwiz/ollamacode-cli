

/** Which Ollama backend a session prefers. */
export type ProviderMode = 'cloud-first' | 'cloud-only' | 'local-first' | 'local-only';

const DEFAULT_PROVIDER_MODE: ProviderMode = 'cloud-first';

export function parseProviderMode(value: unknown): ProviderMode {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'cloud-first' || v === 'cloud-only' || v === 'local-first' || v === 'local-only') return v;
  return DEFAULT_PROVIDER_MODE;
}

/** What the provider layer (never the loop) observed about Ollama Cloud. `offline` is the caller's stand-in for "this mode never consults the cloud" — only cloud-only/cloud-first receive a real status. */
export type CloudStatus = 'available' | 'unavailable' | 'error' | 'offline';

interface ModeResolution {
  /** The provider id to use. */
  providerId: string;
}

/** The pure policy behind session resolution. */
export function resolveProviderForMode({
  mode,
  cloud,
  explicitProviderId,
  storedProviderId,
}: {
  mode: ProviderMode;
  cloud: CloudStatus;
  explicitProviderId?: string | null;
  storedProviderId?: string | null;
}): ModeResolution | { error: string; } {
  // A direct order always wins: flag, then the user's own stored choice — except under a lock, where automatic resolution must not cross over.
  if (explicitProviderId) return { providerId: explicitProviderId };
  if (mode === 'cloud-only') {
    if (cloud === 'available') return { providerId: 'ollama-cloud' };
    return { error: `Ollama Cloud is ${cloud} and provider mode is cloud-only — refusing to fall back to local` };
  }
  if (mode === 'local-only') {
    return { providerId: 'ollama' };
  }
  if (storedProviderId) return { providerId: storedProviderId };
  if (mode === 'local-first') return { providerId: 'ollama' };
  // cloud-first (the default): somebody else's GPU when reachable.
  if (cloud === 'available') return { providerId: 'ollama-cloud' };
  return { providerId: 'ollama' };
}
