import { createRequire } from 'node:module';
import path from 'node:path';
import tap from 'tap';
import { register } from 'tsconfig-paths';

const root = path.resolve(__dirname, '../../..');
register({ baseUrl: root, paths: { '@lib/*': ['lib/*'] } });

// Exercise the API/SDK used by the existing metrics dependency, not a new
// application SDK dependency or a substitute implementation of the counters.
const metricsRequire = createRequire(require.resolve('@boxyhq/metrics'));
const { metrics } = metricsRequire('@opentelemetry/api') as typeof import('@opentelemetry/api');
const { resourceFromAttributes } = metricsRequire(
  '@opentelemetry/resources'
) as typeof import('@opentelemetry/resources');
const { MeterProvider, InMemoryMetricExporter, PeriodicExportingMetricReader, AggregationTemporality } =
  metricsRequire('@opentelemetry/sdk-metrics') as typeof import('@opentelemetry/sdk-metrics');

tap.test('Jackson uses the preloaded metrics provider and preserves its resource', async (t) => {
  const attributes = {
    'service.name': 'polis',
    'service.namespace': 'test',
    'service.instance.id': 'test.polis-a.polis',
    'k8s.namespace.name': 'test',
    'k8s.pod.name': 'polis-a',
  };
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = new MeterProvider({
    resource: resourceFromAttributes(attributes),
    readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
  });
  t.ok(metrics.setGlobalMeterProvider(provider), 'the preloaded SDK registers first');
  const g = global as any;
  const priorJackson = g.jacksonInstance;
  const priorMetricsInit = g.metricsInit;
  delete g.jacksonInstance;
  delete g.metricsInit;
  t.teardown(async () => {
    await provider.shutdown();
    metrics.disable();
    g.jacksonInstance = priorJackson;
    g.metricsInit = priorMetricsInit;
  });

  let bootstrapCalls = 0;
  let jacksonCalls = 0;
  const controller = {};
  const wrapper = t.mockRequire<typeof import('../../../lib/jackson')>('../../../lib/jackson.ts', {
    [path.join(root, 'lib/env.ts')]: { jacksonOptions: {} },
    [path.join(root, 'lib/logger.ts')]: { logger: {} },
    '@boxyhq/saml-jackson': async () => {
      jacksonCalls++;
      return controller;
    },
    '@boxyhq/metrics': {
      ...require('@boxyhq/metrics'),
      initializeMetrics: () => bootstrapCalls++,
    },
  });
  t.equal(await wrapper.default(), controller);
  t.equal(await wrapper.default(), controller);
  t.equal(jacksonCalls, 1, 'Jackson initialization is still shared');
  t.equal(bootstrapCalls, 0, 'Polis never starts a separate metrics provider/exporter');
  t.equal(metrics.getMeterProvider(), provider, 'the preloaded provider remains authoritative');

  const { increment } = require('../../src/opentelemetry/metrics');
  increment('oauthAuthorize');
  increment('oauthAuthorize');
  await provider.forceFlush();
  const batches = exporter.getMetrics();
  t.ok(batches.length, 'the real Jackson instrument reaches the external exporter');
  t.same(batches[0]?.resource.attributes, attributes, 'the SDK resource is not replaced by package metadata');
  const counter = batches
    .flatMap((batch) => batch.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .find((metric) => metric.descriptor.name === 'jackson.oauth.authorize');
  t.same(
    counter?.dataPoints.map((point) => point.value),
    [2],
    'the existing counter exports its actual value'
  );
});
