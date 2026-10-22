import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const file of ['customer-api.node.test.mjs', 'dealer-feed-shapes.node.test.mjs', 'product-boundaries.node.test.mjs', 'full-case-simulation.mjs', 'connection-simulation.mjs', 'integration-access.node.test.mjs', 'service-session-integrity.node.test.mjs', 'network-integrity.node.test.mjs', 'finding-assist.node.test.mjs', 'obd-scan.node.test.mjs', 'obd-access.node.test.mjs', 'obd-bridge.node.test.mjs', 'obd-routes.node.test.mjs', 'obd-analysis.node.test.mjs', 'obd-outbox.node.test.mjs']) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url))], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
