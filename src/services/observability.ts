import type { NextFunction, Request, Response } from 'express';

const DURATION_BUCKETS_MS = [50, 100, 250, 500, 1_000, 3_000, 10_000] as const;
const MAX_ROUTE_METRICS = 100;

interface RouteMetric {
  method: string;
  route: string;
  requests: number;
  errors: number;
  totalDurationMs: number;
  maxDurationMs: number;
  statusCounts: Record<string, number>;
  durationBuckets: number[];
}

const routeMetrics = new Map<string, RouteMetric>();
let totalRequests = 0;
let totalErrors = 0;

function boundedRoute(method: string, route: string): { method: string; route: string } {
  const safeMethod = method.toUpperCase().slice(0, 12);
  // Route templates are preferred; dynamic path segments are normalized as a fallback.
  const safeRoute = route.startsWith('/')
    ? route.replace(/\/(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27,}) (?=\/|$)/gi, '/:id').slice(0, 160)
    : '/unmatched';
  return { method: safeMethod, route: safeRoute || '/' };
}

export function recordHttpRequest(method: string, route: string, statusCode: number, durationMs: number): void {
  const normalized = boundedRoute(method, route);
  const key = normalized.method + ' ' + normalized.route;
  let metric = routeMetrics.get(key);
  if (!metric && routeMetrics.size >= MAX_ROUTE_METRICS - 1) {
    metric = routeMetrics.get('OTHER /other');
    if (!metric) {
      metric = {
        method: 'OTHER', route: '/other', requests: 0, errors: 0,
        totalDurationMs: 0, maxDurationMs: 0, statusCounts: {},
        durationBuckets: Array(DURATION_BUCKETS_MS.length + 1).fill(0) as number[],
      };
      routeMetrics.set('OTHER /other', metric);
    }
  }
  if (!metric) {
    metric = {
      ...normalized, requests: 0, errors: 0, totalDurationMs: 0,
      maxDurationMs: 0, statusCounts: {},
      durationBuckets: Array(DURATION_BUCKETS_MS.length + 1).fill(0) as number[],
    };
    routeMetrics.set(key, metric);
  }

  const safeDuration = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
  metric.requests++;
  metric.totalDurationMs += safeDuration;
  metric.maxDurationMs = Math.max(metric.maxDurationMs, safeDuration);
  const status = String(Math.max(100, Math.min(599, Math.floor(statusCode))));
  metric.statusCounts[status] = (metric.statusCounts[status] || 0) + 1;
  if (statusCode >= 500) {
    metric.errors++;
    totalErrors++;
  }
  const bucketIndex = DURATION_BUCKETS_MS.findIndex((bound) => safeDuration <= bound);
  metric.durationBuckets[bucketIndex === -1 ? DURATION_BUCKETS_MS.length : bucketIndex]++;
  totalRequests++;
}

export function getHttpMetrics(): {
  requests: number;
  serverErrors: number;
  averageDurationMs: number;
  routes: Array<{
    method: string;
    route: string;
    requests: number;
    serverErrors: number;
    averageDurationMs: number;
    maxDurationMs: number;
    statusCounts: Record<string, number>;
    durationBuckets: Record<string, number>;
  }>;
} {
  return {
    requests: totalRequests,
    serverErrors: totalErrors,
    averageDurationMs: routeMetrics.size
      ? Number((Array.from(routeMetrics.values()).reduce((sum, metric) => sum + metric.totalDurationMs, 0) / Math.max(1, totalRequests)).toFixed(2))
      : 0,
    routes: Array.from(routeMetrics.values()).map((metric) => ({
      method: metric.method,
      route: metric.route,
      requests: metric.requests,
      serverErrors: metric.errors,
      averageDurationMs: Number((metric.totalDurationMs / metric.requests).toFixed(2)),
      maxDurationMs: Number(metric.maxDurationMs.toFixed(2)),
      statusCounts: { ...metric.statusCounts },
      durationBuckets: Object.fromEntries([
        ...DURATION_BUCKETS_MS.map((bound, index) => [String(bound), metric.durationBuckets[index]]),
        ['gt_10000', metric.durationBuckets[DURATION_BUCKETS_MS.length]],
      ]),
    })),
  };
}

export function resetHttpMetricsForTests(): void {
  routeMetrics.clear();
  totalRequests = 0;
  totalErrors = 0;
}

export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();
  res.once('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const routePath = typeof req.route?.path === 'string'
      ? (req.baseUrl + req.route.path) || '/'
      : req.path.replace(/\/(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27,})(?=\/|$)/gi, '/:id');
    recordHttpRequest(req.method, routePath, res.statusCode, elapsedMs);
    if (res.statusCode >= 500) {
      logEvent('error', 'http.server_error', {
        method: req.method,
        route: routePath,
        statusCode: res.statusCode,
        durationMs: Number(elapsedMs.toFixed(2)),
      });
    }
  });
  next();
}

export function logEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  context: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...context,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
