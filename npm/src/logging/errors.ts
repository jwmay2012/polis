/** Preserve ordinary errors, including saml20's older `inner` cause convention. */
export function serializeError(error: unknown, seen = new Set<unknown>(), depth = 0): Record<string, any> {
  if (error === null || error === undefined) return { type: 'Error', message: String(error) };
  if (typeof error !== 'object') return { type: typeof error, message: String(error) };
  if (seen.has(error) || depth >= 5) return { type: 'Error', message: 'Cause chain truncated' };
  seen.add(error);
  const value = error as Record<string, any>;
  const result: Record<string, any> = {
    type: value.type || value.name || value.constructor?.name || 'Error',
    message: value.message || value.error_description || value.error || 'Unknown error',
  };
  for (const key of [
    'code',
    'statusCode',
    'status',
    'internalError',
    'stack',
    'error',
    'error_description',
    'claim',
  ]) {
    if (['string', 'number', 'boolean'].includes(typeof value[key])) result[key] = value[key];
  }
  // These are the provider's own diagnostics, not another error classification.
  for (const key of ['error_codes', 'trace_id', 'correlation_id', 'timestamp']) {
    const field = value[key];
    if (typeof field === 'string' || Array.isArray(field)) result[key] = field;
  }
  if (value.cause !== undefined) result.cause = serializeError(value.cause, seen, depth + 1);
  if (value.inner !== undefined) result.inner = serializeError(value.inner, seen, depth + 1);
  if (Array.isArray(value.errors))
    result.errors = value.errors.map((err) => serializeError(err, seen, depth + 1));
  return result;
}
