import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SAFE_AUDIT_HEADERS, filterSafeHeaders, parseLatencyMs, transformLogEntry } from './index.js';

describe('GCP Collector: Unit Tests & Verification', () => {
  describe('Security & Privacy: Header Sanitization', () => {
    test('filterSafeHeaders drops authorization, cookies, and secret tokens', () => {
      const untrusted = {
        authorization: 'Bearer secret_token_xyz',
        cookie: 'session_id=12345; remember_me=true',
        'set-cookie': 'id=999',
        'x-api-key': 'customer_private_key',
        password: 'super_secret_password',
        'user-agent': 'GPTBot/1.2 (+https://openai.com/gptbot)',
        referer: 'https://chatgpt.com/',
        host: 'example.com',
        accept: 'text/html,application/xhtml+xml',
        'sec-ch-ua': '"Chromium";v="132"'
      };

      const sanitized = filterSafeHeaders(untrusted);

      // Verify prohibited headers are stripped
      assert.equal(sanitized.authorization, undefined);
      assert.equal(sanitized.cookie, undefined);
      assert.equal(sanitized['set-cookie'], undefined);
      assert.equal(sanitized['x-api-key'], undefined);
      assert.equal(sanitized.password, undefined);

      // Verify safe AI and content headers are retained
      assert.equal(sanitized['user-agent'], 'GPTBot/1.2 (+https://openai.com/gptbot)');
      assert.equal(sanitized.referer, 'https://chatgpt.com/');
      assert.equal(sanitized.host, 'example.com');
      assert.equal(sanitized.accept, 'text/html,application/xhtml+xml');
      assert.equal(sanitized['sec-ch-ua'], '"Chromium";v="132"');
    });

    test('SAFE_AUDIT_HEADERS contains core AI headers and client hints', () => {
      assert.ok(SAFE_AUDIT_HEADERS.includes('user-agent'));
      assert.ok(SAFE_AUDIT_HEADERS.includes('referer'));
      assert.ok(SAFE_AUDIT_HEADERS.includes('host'));
      assert.ok(SAFE_AUDIT_HEADERS.includes('sec-ch-ua'));
      assert.equal(SAFE_AUDIT_HEADERS.includes('authorization'), false);
      assert.equal(SAFE_AUDIT_HEADERS.includes('cookie'), false);
    });
  });

  describe('Latency Parsing', () => {
    test('parseLatencyMs converts GCP latency string to integer milliseconds', () => {
      assert.equal(parseLatencyMs('0.045120s'), 45);
      assert.equal(parseLatencyMs('1.250s'), 1250);
      assert.equal(parseLatencyMs('0.001s'), 1);
      assert.equal(parseLatencyMs('0s'), 0);
      assert.equal(parseLatencyMs(0.024), 24);
      assert.equal(parseLatencyMs(null), 0);
    });
  });

  describe('LogEntry Transformation to Voight Trace Event Contract', () => {
    test('transformLogEntry correctly maps GCP LogEntry fields', () => {
      const gcpLogEntry = {
        metadata: {
          insertId: 'log_insert_987654321',
          timestamp: '2026-11-24T09:25:00.500Z',
          httpRequest: {
            requestMethod: 'GET',
            requestUrl: 'https://example.com/pricing?ref=chatgpt',
            status: 200,
            userAgent: 'Mozilla/5.0 (compatible; PerplexityBot/1.0)',
            referer: 'https://www.perplexity.ai/',
            remoteIp: '198.51.100.25',
            latency: '0.035000s',
            responseSize: '8450'
          },
          resource: {
            type: 'http_load_balancer',
            labels: {
              zone: 'us-central1'
            }
          }
        }
      };

      const config = {
        siteId: 'site_test_gcp_001',
        tenantId: 'tenant_test_gcp_001',
        collectorId: 'gcp_glb_us_central1'
      };

      const event = transformLogEntry(gcpLogEntry, config);

      assert.ok(event);
      assert.equal(event.event_type, 'http.request');
      assert.equal(event.collector_type, 'gcp_collector');
      assert.equal(event.observation_id, 'log_insert_987654321');
      assert.equal(event.correlation_id, 'vgt_log_insert_987654321');
      assert.equal(event.occurred_at, '2026-11-24T09:25:00.500Z');
      assert.equal(event.request.method, 'GET');
      assert.equal(event.request.host, 'example.com');
      assert.equal(event.request.path, '/pricing');
      assert.equal(event.request.query_params.ref, 'chatgpt');
      assert.equal(event.request.user_agent, 'Mozilla/5.0 (compatible; PerplexityBot/1.0)');
      assert.equal(event.request.referer, 'https://www.perplexity.ai/');
      assert.equal(event.response.status_code, 200);
      assert.equal(event.response.duration_ms, 35);
      assert.equal(event.response.bytes_sent, 8450);
      assert.equal(event.network.ip_hash, '198.51.100.25');
    });
  });
});
