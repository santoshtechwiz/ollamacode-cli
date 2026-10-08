import { PROVIDER_ERROR_CODE } from '../../protocol';
import { TcError } from '../../core/errors';

const REQUIRED_METHODS = ['detect', 'ensureAuth', 'listModels', 'streamChat'];

export function validateProvider(p: unknown): import('../../types.ts').ProviderDef {
  if (!p || typeof p !== 'object') {
    throw new TcError('Provider must be an object', { code: PROVIDER_ERROR_CODE.EPROVIDER_INVALID });
  }
  const provider = (p as Record<string, unknown>);
  const id = provider.id;

  if (typeof id !== 'string' || id.trim() === '') {
    throw new TcError('Provider is missing a string "id"', { code: PROVIDER_ERROR_CODE.EPROVIDER_INVALID });
  }
  if (typeof provider.label !== 'string' || provider.label.trim() === '') {
    throw new TcError(`Provider "${id}" is missing a string "label"`, {
      code: PROVIDER_ERROR_CODE.EPROVIDER_INVALID,
    });
  }

  const bad = REQUIRED_METHODS.filter((k) => typeof provider[k] !== 'function');
  if (bad.length > 0) {
    throw new TcError(
      `Provider "${id}" is missing or has non-function: ${bad.join(', ')}`,
      { code: PROVIDER_ERROR_CODE.EPROVIDER_INVALID }
    );
  }
  return (p as import('../../types.ts').ProviderDef);
}

export function looksLikeProvider(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = (value as Record<string, unknown>);
  return typeof v.id === 'string' && REQUIRED_METHODS.every((k) => typeof v[k] === 'function');
}

