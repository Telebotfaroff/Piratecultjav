export type TelegramErrorKind =
  | 'rate_limit'
  | 'blocked'
  | 'not_found'
  | 'invalid_chat'
  | 'timeout'
  | 'network'
  | 'unknown'
  | 'not_modified';

export interface TelegramErrorInfo {
  kind: TelegramErrorKind;
  message: string;
  retryAfterSeconds?: number;
  errorCode?: number;
}

export function classifyTelegramError(error: unknown): TelegramErrorInfo {
  const e = error as any;
  const errorCode = Number(e?.response?.error_code ?? e?.error_code);
  const description = String(e?.response?.description ?? e?.description ?? e?.message ?? error);

  const retryAfter = Number(e?.response?.parameters?.retry_after ?? e?.parameters?.retry_after);
  if (errorCode === 429 || Number.isFinite(retryAfter)) {
    return { kind: 'rate_limit', message: description, retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : 1, errorCode };
  }

  if (errorCode === 403 || /bot was blocked|user is deactivated/i.test(description)) {
    return { kind: 'blocked', message: description, errorCode };
  }

  if (errorCode === 400 && /chat not found|invalid chat|wrong chat|peer/i.test(description)) {
    return { kind: 'invalid_chat', message: description, errorCode };
  }

  if (errorCode === 400 && /message to delete not found|message can't be deleted|message not found/i.test(description)) {
    return { kind: 'not_found', message: description, errorCode };
  }

  if (errorCode === 400 && /message is not modified/i.test(description)) {
    return { kind: 'not_modified', message: description, errorCode };
  }

  if (errorCode >= 500 && errorCode < 600) {
    return { kind: 'network', message: description, errorCode };
  }

  if (/timeout|timed out|etimedout|econnreset|econnaborted|socket hang up|und_err_connect_timeout/i.test(description)) {
    return { kind: 'timeout', message: description, errorCode };
  }

  if (/network|enotfound|eai_again|econnrefused|ehostunreach|enetunreach|epipe|fetch failed|connection/i.test(description)) {
    return { kind: 'network', message: description, errorCode };
  }

  return { kind: 'unknown', message: description, errorCode };
}

export function isRetryableTelegramError(info: TelegramErrorInfo): boolean {
  return info.kind === 'rate_limit' || info.kind === 'timeout' || info.kind === 'network';
}

export async function withTelegramRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxRetries?: number;
    label?: string;
    initialDelaySeconds?: number;
    maxDelaySeconds?: number;
  } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelaySeconds = Math.max(1, options.initialDelaySeconds ?? 1);
  const maxDelaySeconds = Math.max(initialDelaySeconds, options.maxDelaySeconds ?? 8);

  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const info = classifyTelegramError(error);
      if (!isRetryableTelegramError(info) || attempt >= maxRetries) throw error;

      const waitSeconds = info.kind === 'rate_limit'
        ? Math.max(1, info.retryAfterSeconds ?? 1)
        : Math.min(maxDelaySeconds, initialDelaySeconds * (2 ** attempt));

      console.warn(
        '[Telegram]',
        options.label ?? 'request',
        info.kind,
        'retrying in',
        waitSeconds,
        'seconds',
      );
      await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
    }
  }
}
