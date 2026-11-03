import { config } from '../../config.ts';
import { normalizeCode } from '../../services/code.ts';
import { JavMetadata, parseSearchResults, parseVideoPage } from './parser.ts';

export class ProviderNotFoundError extends Error {
  constructor(code: string) {
    super(`No Javtiful video found for ${code}`);
    this.name = 'ProviderNotFoundError';
  }
}

export class ProviderTemporaryError extends Error {
  public statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'ProviderTemporaryError';
    this.statusCode = statusCode;
  }
}

interface CacheEntry {
  data: JavMetadata | null; // null represents negative/not-found cache
  expiresAt: number;
}

export class JavtifulProvider {
  public readonly name = 'javtiful';
  private cache = new Map<string, CacheEntry>();
  private readonly SUCCESS_TTL_MS = 10 * 60 * 1000; // 10 minutes
  private readonly NEGATIVE_TTL_MS = 2 * 60 * 1000; // 2 minutes
  private readonly MAX_CACHE_ENTRIES = 5000;

  /** Keep the per-process cache bounded and discard expired entries on writes. */
  private setCacheEntry(code: string, entry: CacheEntry): void {
    const now = Date.now();
    for (const [key, cached] of this.cache) {
      if (cached.expiresAt <= now) this.cache.delete(key);
    }

    if (!this.cache.has(code) && this.cache.size >= this.MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(code, entry);
  }

  /**
   * Fetches metadata for a given JAV code from Javtiful.
   * Concept interface: provider.getMetadata(code)
   */
  async getMetadata(rawCode: string): Promise<JavMetadata> {
    const code = normalizeCode(rawCode);
    if (!code) {
      throw new Error(`Invalid JAV code format: ${rawCode}`);
    }

    // 1. Check in-memory cache
    const cached = this.cache.get(code);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      if (cached.data === null) {
        throw new ProviderNotFoundError(code);
      }
      return cached.data;
    }

    try {
      // 2. Perform search on Javtiful
      const searchUrl = `${config.javtifulBaseUrl}/search?q=${encodeURIComponent(code)}`;
      const searchResponse = await this.fetchWithTimeout(searchUrl);

      if (searchResponse.status === 429) {
        throw new ProviderTemporaryError('Javtiful rate limited (HTTP 429)', 429);
      }
      if (searchResponse.status >= 500) {
        throw new ProviderTemporaryError(`Javtiful server error (HTTP ${searchResponse.status})`, searchResponse.status);
      }
      if (!searchResponse.ok) {
        throw new ProviderTemporaryError(`Javtiful search returned HTTP ${searchResponse.status}`, searchResponse.status);
      }

      const searchHtml = await searchResponse.text();
      const videoUrls = parseSearchResults(searchHtml, config.javtifulBaseUrl);

      // Look for the best matching result
      let targetPageUrl: string | null = null;
      const normalizedQuery = code.toLowerCase().replace(/[^a-z0-9]/g, '');

      for (const url of videoUrls) {
        const cleanUrl = url.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (cleanUrl.includes(normalizedQuery)) {
          targetPageUrl = url;
          break;
        }
      }

      // Never fall back to the first search result. That can silently index a
      // completely different video under the requested code.
      if (!targetPageUrl) {
        // Cache negative result for 2 minutes
        this.setCacheEntry(code, { data: null, expiresAt: now + this.NEGATIVE_TTL_MS });
        throw new ProviderNotFoundError(code);
      }

      // 3. Fetch video detail page
      const pageResponse = await this.fetchWithTimeout(targetPageUrl);
      if (pageResponse.status === 429) {
        throw new ProviderTemporaryError('Javtiful rate limited on detail page (HTTP 429)', 429);
      }
      if (pageResponse.status >= 500) {
        throw new ProviderTemporaryError(`Javtiful server error on detail page (HTTP ${pageResponse.status})`, pageResponse.status);
      }
      if (!pageResponse.ok) {
        throw new ProviderTemporaryError(`Javtiful detail page returned HTTP ${pageResponse.status}`, pageResponse.status);
      }

      const pageHtml = await pageResponse.text();

      let metadata: JavMetadata;
      try {
        metadata = parseVideoPage(pageHtml, targetPageUrl, code);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('does not match requested code')) {
          this.setCacheEntry(code, { data: null, expiresAt: now + this.NEGATIVE_TTL_MS });
          throw new ProviderNotFoundError(code);
        }
        throw err;
      }

      // Cache successful result for 10 minutes
      this.setCacheEntry(code, { data: metadata, expiresAt: now + this.SUCCESS_TTL_MS });

      return metadata;
    } catch (err: unknown) {
      if (err instanceof ProviderNotFoundError || err instanceof ProviderTemporaryError) {
        throw err;
      }
      // Network failures or timeouts
      const errMessage = err instanceof Error ? err.message : String(err);
      if (errMessage.includes('timeout') || errMessage.includes('ECONNREFUSED') || errMessage.includes('fetch failed')) {
        throw new ProviderTemporaryError(`Network failure contacting Javtiful: ${errMessage}`);
      }
      throw err;
    }
  }

  private async fetchWithTimeout(url: string, timeoutMs = 12000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

export const javtifulProvider = new JavtifulProvider();
