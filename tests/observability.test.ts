import test from 'node:test';
import assert from 'node:assert/strict';
import { getHttpMetrics, recordHttpRequest, resetHttpMetricsForTests } from '../src/services/observability.ts';

test('aggregates request counts, status codes and latency buckets', () => {
  resetHttpMetricsForTests();
  recordHttpRequest('get', '/api/videos', 200, 42);
  recordHttpRequest('GET', '/api/videos', 503, 750);
  recordHttpRequest('POST', '/api/jobs', 201, 120);

  const metrics = getHttpMetrics();
  assert.equal(metrics.requests, 3);
  assert.equal(metrics.serverErrors, 1);
  assert.equal(metrics.averageDurationMs, 304);
  const videos = metrics.routes.find(route => route.route === '/api/videos');
  assert.ok(videos);
  assert.equal(videos.requests, 2);
  assert.equal(videos.serverErrors, 1);
  assert.equal(videos.statusCounts['200'], 1);
  assert.equal(videos.statusCounts['503'], 1);
  assert.equal(videos.durationBuckets['50'], 1);
  assert.equal(videos.durationBuckets['1000'], 1);
});

test('bounds route cardinality for dynamic or untrusted paths', () => {
  resetHttpMetricsForTests();
  for (let index = 0; index < 150; index++) {
    recordHttpRequest('GET', '/unmatched/' + index, 200, 1);
  }
  const metrics = getHttpMetrics();
  assert.ok(metrics.routes.length <= 100);
  assert.equal(metrics.requests, 150);
});
