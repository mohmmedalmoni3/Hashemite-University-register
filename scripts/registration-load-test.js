import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

// Safety rail: this load test can only call a local server, never production.
const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:10000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(BASE_URL)) {
  throw new Error('BASE_URL must point to localhost. Production/remote targets are blocked.');
}

const RUN_ID = String(__ENV.RUN_ID || Date.now()).replace(/[^a-zA-Z0-9-]/g, '');
const RUN_SEED = Array.from(RUN_ID).reduce((value, char) => (value * 31 + char.charCodeAt(0)) % 10000000, 0);
const created = new Counter('registrations_created');
const duplicates = new Counter('duplicate_emails_rejected');
const unexpected = new Counter('unexpected_responses');

export const options = {
  scenarios: {
    registration_burst: {
      executor: 'per-vu-iterations',
      vus: 400,
      iterations: 1,
      maxDuration: '2m'
    }
  }
};

export default function () {
  const slot = __VU - 1;
  const expectedDuplicate = slot >= 320;
  const emailSlot = expectedDuplicate ? slot - 320 : slot;
  const email = `ieee-loadtest-${RUN_ID}-${emailSlot}@example.invalid`;
  const payload = JSON.stringify({
    fullName: `Load Test User ${slot + 1}`,
    phone: `079${String((RUN_SEED + slot) % 10000000).padStart(7, '0')}`,
    email,
    major: 'Engineering',
    year: 'First year',
    consent: true,
    deviceId: `00000000-0000-4000-8000-${String(RUN_SEED * 1000 + slot + 1).padStart(12, '0')}`
  });

  const response = http.post(`${BASE_URL}/api/register`, payload, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: BASE_URL },
    timeout: '30s',
    tags: { endpoint: 'registration' }
  });

  const expectedStatus = expectedDuplicate ? 409 : 201;
  const passed = check(response, {
    [`expected ${expectedStatus}`]: res => res.status === expectedStatus,
    'response is JSON': res => String(res.headers['Content-Type'] || '').includes('application/json')
  });

  if (!passed) unexpected.add(1);
  else if (expectedDuplicate) duplicates.add(1);
  else created.add(1);
}

export function handleSummary(data) {
  const metric = name => data.metrics[name]?.values?.count || 0;
  const latency = data.metrics.http_req_duration?.values || {};
  const summary = {
    target: BASE_URL,
    expected: { concurrentRequests: 400, created: 320, duplicateEmailRejections: 80 },
    observed: {
      created: metric('registrations_created'),
      duplicateEmailRejections: metric('duplicate_emails_rejected'),
      unexpectedResponses: metric('unexpected_responses'),
      p95LatencyMs: latency['p(95)'] ?? null,
      httpRequestFailures: data.metrics.http_req_failed?.values?.rate ?? null
    }
  };
  return { stdout: `${JSON.stringify(summary, null, 2)}\n` };
}
