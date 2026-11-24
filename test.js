import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  SAFE_AUDIT_HEADERS,
  filterSafeHeaders,
  cleanIp,
  parseLatencyMs,
  transformLogEntry,
  collectLogs,
  setLoggingClientOverride
} from './index.js';

describe('Voight Trace GCP Collector — Comprehensive Unit Tests', () => {

  // ==========================================================================
  // 1. SECURITY & PRIVACY: SAFE AUDIT HEADERS & SANITIZATION
  // ==========================================================================
  describe('Security & Privacy: Header Allowlist & Sanitization', () => {
    test('filterSafeHeaders strips authorization, cookies, and secret tokens from standard object', () => {
      const untrusted = {
        authorization: 'Bearer secret_token_xyz',
        cookie: 'session_id=12345; remember_me=true',
        'set-cookie': 'id=999; Secure; HttpOnly',
        'x-api-key': 'customer_private_key_456',
        'x-auth-token': 'jwt_super_secret',
        password: 'admin_password',
        'user-agent': 'GPTBot/1.2 (+https://openai.com/gptbot)',
        referer: 'https://chatgpt.com/',
        host: 'example.com',
        origin: 'https://chatgpt.com',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
        'content-type': 'application/json',
        'sec-ch-ua': '"Chromium";v="132"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'cross-site'
      };

      const sanitized = filterSafeHeaders(untrusted);

      // Verify prohibited headers are strictly stripped
      assert.equal(sanitized.authorization, undefined);
      assert.equal(sanitized.cookie, undefined);
      assert.equal(sanitized['set-cookie'], undefined);
      assert.equal(sanitized['x-api-key'], undefined);
      assert.equal(sanitized['x-auth-token'], undefined);
      assert.equal(sanitized.password, undefined);

      // Verify safe headers are retained
      assert.equal(sanitized['user-agent'], 'GPTBot/1.2 (+https://openai.com/gptbot)');
      assert.equal(sanitized.referer, 'https://chatgpt.com/');
      assert.equal(sanitized.host, 'example.com');
      assert.equal(sanitized.origin, 'https://chatgpt.com');
      assert.equal(sanitized.accept, 'text/html,application/xhtml+xml');
      assert.equal(sanitized['accept-language'], 'en-US,en;q=0.9');
      assert.equal(sanitized['content-type'], 'application/json');
      assert.equal(sanitized['sec-ch-ua'], '"Chromium";v="132"');
      assert.equal(sanitized['sec-ch-ua-platform'], '"macOS"');
      assert.equal(sanitized['sec-fetch-dest'], 'document');
    });

    test('filterSafeHeaders performs case-insensitive filtering on mixed-case headers', () => {
      const mixed = {
        'User-Agent': 'ClaudeBot/1.0',
        'Referer': 'https://claude.ai/',
        'Host': 'api.example.com',
        'AUTHORIZATION': 'Bearer secret_jwt',
        'Cookie': 'sid=abc',
        'Sec-CH-UA': '"Google Chrome";v="130"'
      };

      const sanitized = filterSafeHeaders(mixed);
      assert.equal(sanitized['user-agent'], 'ClaudeBot/1.0');
      assert.equal(sanitized.referer, 'https://claude.ai/');
      assert.equal(sanitized.host, 'api.example.com');
      assert.equal(sanitized['sec-ch-ua'], '"Google Chrome";v="130"');
      assert.equal(sanitized.authorization, undefined);
      assert.equal(sanitized.cookie, undefined);
    });

    test('filterSafeHeaders parses array of string headers (e.g. from GLB customHeaders)', () => {
      const arrayHeaders = [
        'User-Agent: PerplexityBot/1.0',
        'Authorization: Bearer confidential_token',
        'Referer: https://www.perplexity.ai/',
        'Cookie: session=xyz',
        'Accept-Language: pt-BR,pt;q=0.9',
        'X-Custom-Secret: forbidden'
      ];

      const sanitized = filterSafeHeaders(arrayHeaders);
      assert.equal(sanitized['user-agent'], 'PerplexityBot/1.0');
      assert.equal(sanitized.referer, 'https://www.perplexity.ai/');
      assert.equal(sanitized['accept-language'], 'pt-BR,pt;q=0.9');
      assert.equal(sanitized.authorization, undefined);
      assert.equal(sanitized.cookie, undefined);
      assert.equal(sanitized['x-custom-secret'], undefined);
    });

    test('filterSafeHeaders handles Map or Headers instance with entries()', () => {
      const headerMap = new Map([
        ['User-Agent', 'Bytespider'],
        ['Authorization', 'Basic dXNlcjpwYXNz'],
        ['Referer', 'https://bytedance.com'],
        ['Cookie', 'uid=42']
      ]);

      const sanitized = filterSafeHeaders(headerMap);
      assert.equal(sanitized['user-agent'], 'Bytespider');
      assert.equal(sanitized.referer, 'https://bytedance.com');
      assert.equal(sanitized.authorization, undefined);
      assert.equal(sanitized.cookie, undefined);
    });

    test('filterSafeHeaders handles empty, null, or undefined gracefully', () => {
      assert.deepEqual(filterSafeHeaders(null), {});
      assert.deepEqual(filterSafeHeaders(undefined), {});
      assert.deepEqual(filterSafeHeaders({}), {});
    });

    test('SAFE_AUDIT_HEADERS constants strictly forbid sensitive keywords', () => {
      for (const header of SAFE_AUDIT_HEADERS) {
        assert.equal(header.includes('auth'), false, `header ${header} must not contain auth`);
        assert.equal(header.includes('cookie'), false, `header ${header} must not contain cookie`);
        assert.equal(header.includes('pass'), false, `header ${header} must not contain pass`);
        assert.equal(header.includes('token'), false, `header ${header} must not contain token`);
        assert.equal(header.includes('key'), false, `header ${header} must not contain key`);
      }
    });
  });

  // ==========================================================================
  // 2. IP SANITIZATION & NORMALIZATION
  // ==========================================================================
  describe('Network: cleanIp port removal and IPv4/IPv6 handling', () => {
    test('cleanIp removes port suffix from IPv4 addresses', () => {
      assert.equal(cleanIp('198.51.100.25:48210'), '198.51.100.25');
      assert.equal(cleanIp('203.0.113.195:80'), '203.0.113.195');
      assert.equal(cleanIp('10.0.0.1'), '10.0.0.1');
    });

    test('cleanIp handles bracketed IPv6 addresses with port', () => {
      assert.equal(cleanIp('[2001:db8::1]:8080'), '2001:db8::1');
      assert.equal(cleanIp('[::1]:443'), '::1');
    });

    test('cleanIp preserves unbracketed IPv6 addresses', () => {
      assert.equal(cleanIp('2001:db8:85a3::8a2e:370:7334'), '2001:db8:85a3::8a2e:370:7334');
      assert.equal(cleanIp('::1'), '::1');
    });

    test('cleanIp falls back to 127.0.0.1 on invalid or empty inputs', () => {
      assert.equal(cleanIp(null), '127.0.0.1');
      assert.equal(cleanIp(undefined), '127.0.0.1');
      assert.equal(cleanIp(''), '127.0.0.1');
    });
  });

  // ==========================================================================
  // 3. LATENCY PARSING
  // ==========================================================================
  describe('Latency Parsing: parseLatencyMs across GCP formats', () => {
    test('parses standard GCP latency string with seconds suffix', () => {
      assert.equal(parseLatencyMs('0.045120s'), 45);
      assert.equal(parseLatencyMs('1.250s'), 1250);
      assert.equal(parseLatencyMs('0.001s'), 1);
      assert.equal(parseLatencyMs('0.000100s'), 0);
      assert.equal(parseLatencyMs('0s'), 0);
      assert.equal(parseLatencyMs('10.000000s'), 10000);
    });

    test('parses numeric seconds (float and integer)', () => {
      assert.equal(parseLatencyMs(0.045), 45);
      assert.equal(parseLatencyMs(1.5), 1500);
      assert.equal(parseLatencyMs(2), 2000);
      assert.equal(parseLatencyMs(0), 0);
    });

    test('parses protobuf Duration object format { seconds, nanos }', () => {
      assert.equal(parseLatencyMs({ seconds: 1, nanos: 500000000 }), 1500);
      assert.equal(parseLatencyMs({ seconds: 0, nanos: 45000000 }), 45);
      assert.equal(parseLatencyMs({ seconds: 0, nanos: 1000000 }), 1);
      assert.equal(parseLatencyMs({ seconds: 5, nanos: 0 }), 5000);
    });

    test('handles number string without s suffix', () => {
      assert.equal(parseLatencyMs('0.050'), 50);
      assert.equal(parseLatencyMs('2.1'), 2100);
    });

    test('gracefully handles missing, empty, or malformed inputs', () => {
      assert.equal(parseLatencyMs(null), 0);
      assert.equal(parseLatencyMs(undefined), 0);
      assert.equal(parseLatencyMs(''), 0);
      assert.equal(parseLatencyMs('not-a-number'), 0);
    });
  });

  // ==========================================================================
  // 4. LOG ENTRY TRANSFORMATION: GLB SCENARIOS
  // ==========================================================================
  describe('LogEntry Transformation: GLB Scenarios & Event Contract', () => {
    const baseConfig = {
      siteId: '018f2d5e-7a91-7f82-a312-d81b9542a301',
      tenantId: '018f2d5e-7a91-7f82-a312-d81b9542a301',
      collectorId: 'gcp_glb_us_central1'
    };

    test('Scenario 1: Standard 200 OK request proxied to backend', () => {
      const gcpLogEntry = {
        metadata: {
          insertId: 'log_insert_standard_001',
          timestamp: '2026-11-24T10:00:00.123456Z',
          httpRequest: {
            requestMethod: 'GET',
            requestUrl: 'https://example.com/products/ai-agent?sort=asc',
            status: 200,
            userAgent: 'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
            referer: 'https://www.perplexity.ai/',
            remoteIp: '198.51.100.25:48210',
            latency: '0.048500s',
            responseSize: '18450',
            protocol: 'HTTP/2'
          },
          jsonPayload: {
            '@type': 'type.googleapis.com/google.cloud.loadbalancing.type.LoadBalancerLogEntry',
            statusDetails: 'response_sent_by_backend'
          },
          resource: {
            type: 'http_load_balancer',
            labels: {
              project_id: 'prod-customer-project',
              zone: 'us-central1'
            }
          }
        }
      };

      const event = transformLogEntry(gcpLogEntry, baseConfig);

      assert.ok(event);
      assert.equal(event.event_type, 'http.request');
      assert.equal(event.collector_type, 'gcp_collector');
      assert.equal(event.observation_id, 'log_insert_standard_001');
      assert.equal(event.correlation_id, 'vgt_log_insert_standard_001');
      assert.equal(event.occurred_at, '2026-11-24T10:00:00.123Z');

      // Request details
      assert.equal(event.request.method, 'GET');
      assert.equal(event.request.scheme, 'https');
      assert.equal(event.request.host, 'example.com');
      assert.equal(event.request.path, '/products/ai-agent');
      assert.equal(event.request.query_params.sort, 'asc');
      assert.equal(event.request.user_agent, 'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)');
      assert.equal(event.request.referer, 'https://www.perplexity.ai/');

      // Network & Geo
      assert.equal(event.network.ip_hash, '198.51.100.25');
      assert.equal(event.network.country, 'US');

      // Response
      assert.equal(event.response.status_code, 200);
      assert.equal(event.response.duration_ms, 49);
      assert.equal(event.response.bytes_sent, 18450);
    });

    test('Scenario 2: Cloud Armor blocked request (403 denied_by_security_policy)', () => {
      const gcpLogEntry = {
        metadata: {
          insertId: 'log_insert_armor_blocked',
          timestamp: '2026-11-24T10:05:00.000Z',
          httpRequest: {
            requestMethod: 'POST',
            requestUrl: 'https://api.example.com/login',
            status: 403,
            userAgent: 'BadBot/0.1 (malicious crawler)',
            remoteIp: '203.0.113.88:34212',
            latency: '0.002000s',
            responseSize: '256'
          },
          jsonPayload: {
            statusDetails: 'denied_by_security_policy',
            enforcedSecurityPolicy: {
              name: 'edge-block-rate-limit',
              outcome: 'DENY',
              priority: 1000
            },
            securityPolicyRequestData: {
              clientRegion: 'BR'
            }
          },
          resource: {
            type: 'http_load_balancer',
            labels: { zone: 'global' }
          }
        }
      };

      const event = transformLogEntry(gcpLogEntry, baseConfig);

      assert.ok(event);
      assert.equal(event.response.status_code, 403);
      assert.equal(event.response.duration_ms, 2);
      assert.equal(event.network.ip_hash, '203.0.113.88');
      assert.equal(event.network.country, 'BR'); // Resolved from securityPolicyRequestData.clientRegion
      assert.equal(event.request.user_agent, 'BadBot/0.1 (malicious crawler)');
    });

    test('Scenario 3: Cloud CDN cache hit (200 response_from_cache)', () => {
      const gcpLogEntry = {
        insertId: 'log_insert_cdn_hit',
        timestamp: '2026-11-24T10:10:00.000Z',
        httpRequest: {
          requestMethod: 'GET',
          requestUrl: 'https://example.com/assets/bundle.js',
          status: 200,
          userAgent: 'Mozilla/5.0 (compatible; ChatGPT-User/1.0)',
          remoteIp: '198.51.100.99',
          latency: '0.000500s',
          responseSize: '512000'
        },
        jsonPayload: {
          statusDetails: 'response_from_cache',
          cacheStatus: 'HIT'
        }
      };

      const event = transformLogEntry(gcpLogEntry, baseConfig);

      assert.ok(event);
      assert.equal(event.response.status_code, 200);
      assert.equal(event.response.duration_ms, 1);
      assert.equal(event.response.bytes_sent, 512000);
      assert.equal(event.request.path, '/assets/bundle.js');
    });

    test('Scenario 4: Backend timeout (504 backend_timeout)', () => {
      const gcpLogEntry = {
        metadata: {
          insertId: 'log_insert_timeout',
          httpRequest: {
            requestMethod: 'GET',
            requestUrl: 'https://example.com/api/heavy-calculation',
            status: 504,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            remoteIp: '192.0.2.1',
            latency: '30.000100s',
            responseSize: '120'
          },
          jsonPayload: {
            statusDetails: 'backend_timeout'
          }
        }
      };

      const event = transformLogEntry(gcpLogEntry, baseConfig);

      assert.ok(event);
      assert.equal(event.response.status_code, 504);
      assert.equal(event.response.duration_ms, 30000);
    });

    test('Scenario 5: Custom logged headers in jsonPayload.httpRequest.headers', () => {
      const gcpLogEntry = {
        metadata: {
          insertId: 'log_insert_custom_headers',
          httpRequest: {
            requestMethod: 'GET',
            requestUrl: 'https://example.com/docs',
            status: 200,
            remoteIp: '198.51.100.10',
            latency: '0.015s'
          },
          jsonPayload: {
            httpRequest: {
              headers: {
                'accept': 'text/html',
                'accept-language': 'fr-FR,fr;q=0.9',
                'sec-ch-ua': '"Not_A Brand";v="8"',
                'authorization': 'Bearer MUST_NOT_BE_LOGGED',
                'cookie': 'session=MUST_NOT_BE_LOGGED'
              }
            }
          }
        }
      };

      const event = transformLogEntry(gcpLogEntry, baseConfig);

      assert.ok(event);
      assert.equal(event.request.selected_headers.accept, 'text/html');
      assert.equal(event.request.selected_headers['accept-language'], 'fr-FR,fr;q=0.9');
      assert.equal(event.request.selected_headers['sec-ch-ua'], '"Not_A Brand";v="8"');
      // Verify forbidden headers are completely absent
      assert.equal(event.request.selected_headers.authorization, undefined);
      assert.equal(event.request.selected_headers.cookie, undefined);
    });

    test('Scenario 6: Relative URL with Host header fallback', () => {
      const gcpLogEntry = {
        httpRequest: {
          requestMethod: 'GET',
          requestUrl: '/api/v1/search?q=machine-learning',
          status: 200,
          remoteIp: '198.51.100.5'
        },
        jsonPayload: {
          httpRequest: {
            headers: {
              host: 'search.internal.example.com'
            }
          }
        }
      };

      const event = transformLogEntry(gcpLogEntry, baseConfig);

      assert.ok(event);
      assert.equal(event.request.host, 'search.internal.example.com');
      assert.equal(event.request.path, '/api/v1/search');
      assert.equal(event.request.query_params.q, 'machine-learning');
    });

    test('Scenario 7: Null or undefined entry returns null', () => {
      assert.equal(transformLogEntry(null, baseConfig), null);
      assert.equal(transformLogEntry(undefined, baseConfig), null);
    });
  });

  // ==========================================================================
  // 5. END-TO-END HANDLER (collectLogs) EXECUTION & INGESTION FLOW
  // ==========================================================================
  describe('End-to-End Function Handler: collectLogs', () => {
    const originalEnv = { ...process.env };
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      process.env.VOIGHT_TRACE_API_KEY = 'vt_live_test_key_12345';
      process.env.VOIGHT_TRACE_SITE_ID = 'site_test_glb_001';
      process.env.VOIGHT_TRACE_INGEST_URL = 'https://api.voighttrace.com/api/v1/ingestion/events';
    });

    afterEach(() => {
      process.env = { ...originalEnv };
      globalThis.fetch = originalFetch;
      setLoggingClientOverride(null);
    });

    test('Health check endpoint returns HTTP 200 with collector status', async () => {
      let responseStatus = 0;
      let responseBody = null;

      const mockReq = { method: 'GET', path: '/health' };
      const mockRes = {
        status: (code) => {
          responseStatus = code;
          return {
            json: (body) => { responseBody = body; return body; }
          };
        }
      };

      await collectLogs(mockReq, mockRes);
      assert.equal(responseStatus, 200);
      assert.equal(responseBody.status, 'healthy');
      assert.equal(responseBody.collector, 'gcp-collector');
    });

    test('Missing VOIGHT_TRACE_API_KEY returns HTTP 500 ConfigurationError', async () => {
      delete process.env.VOIGHT_TRACE_API_KEY;

      let responseStatus = 0;
      let responseBody = null;

      const mockReq = { method: 'POST', path: '/' };
      const mockRes = {
        status: (code) => {
          responseStatus = code;
          return {
            json: (body) => { responseBody = body; return body; }
          };
        }
      };

      await collectLogs(mockReq, mockRes);
      assert.equal(responseStatus, 500);
      assert.equal(responseBody.error, 'ConfigurationError');
    });

    test('Empty Cloud Logging result returns HTTP 200 with 0 dispatched', async () => {
      setLoggingClientOverride({
        getEntries: async (options) => {
          assert.ok(options.filter.includes('resource.type="http_load_balancer"'));
          return [[]]; // 0 entries
        }
      });

      let responseStatus = 0;
      let responseBody = null;

      const mockReq = { method: 'POST', path: '/' };
      const mockRes = {
        status: (code) => {
          responseStatus = code;
          return {
            json: (body) => { responseBody = body; return body; }
          };
        }
      };

      await collectLogs(mockReq, mockRes);
      assert.equal(responseStatus, 200);
      assert.equal(responseBody.status, 'success');
      assert.equal(responseBody.retrieved, 0);
      assert.equal(responseBody.dispatched, 0);
    });

    test('End-to-end: queries GLB logs, transforms observations, and dispatches batch to Voight API', async () => {
      const mockEntries = [
        {
          metadata: {
            insertId: 'glb_log_entry_001',
            timestamp: '2026-11-24T10:14:30.000Z',
            httpRequest: {
              requestMethod: 'GET',
              requestUrl: 'https://example.com/api/pricing?ref=openai',
              status: 200,
              userAgent: 'ChatGPT-User/1.0',
              referer: 'https://chatgpt.com/',
              remoteIp: '198.51.100.25:48210',
              latency: '0.038000s',
              responseSize: '4096'
            },
            resource: {
              type: 'http_load_balancer',
              labels: { zone: 'us-central1' }
            }
          }
        },
        {
          metadata: {
            insertId: 'glb_log_entry_002',
            timestamp: '2026-11-24T10:14:31.000Z',
            httpRequest: {
              requestMethod: 'GET',
              requestUrl: 'https://example.com/docs/ai-integration',
              status: 200,
              userAgent: 'ClaudeBot/1.0',
              referer: 'https://claude.ai/',
              remoteIp: '203.0.113.50:54120',
              latency: '0.042000s',
              responseSize: '8192'
            },
            resource: {
              type: 'http_load_balancer',
              labels: { zone: 'us-central1' }
            }
          }
        }
      ];

      setLoggingClientOverride({
        getEntries: async (options) => {
          assert.ok(options.filter.includes('resource.type="http_load_balancer"'));
          return [mockEntries];
        }
      });

      let capturedUrl = null;
      let capturedHeaders = null;
      let capturedBody = null;

      globalThis.fetch = async (url, options) => {
        capturedUrl = url;
        capturedHeaders = options.headers;
        capturedBody = JSON.parse(options.body);

        return {
          ok: true,
          status: 200,
          json: async () => ({ accepted: 2, errors: [] })
        };
      };

      let responseStatus = 0;
      let responseBody = null;

      const mockReq = { method: 'POST', path: '/' };
      const mockRes = {
        status: (code) => {
          responseStatus = code;
          return {
            json: (body) => { responseBody = body; return body; }
          };
        }
      };

      await collectLogs(mockReq, mockRes);

      // Verify collector HTTP response
      assert.equal(responseStatus, 200);
      assert.equal(responseBody.status, 'success');
      assert.equal(responseBody.retrieved, 2);
      assert.equal(responseBody.dispatched, 2);

      // Verify Ingestion API call contract
      assert.equal(capturedUrl, 'https://api.voighttrace.com/api/v1/ingestion/events');
      assert.equal(capturedHeaders['Authorization'], 'Bearer vt_live_test_key_12345');
      assert.equal(capturedHeaders['Content-Type'], 'application/json');
      assert.equal(capturedHeaders['x-voight-collector-type'], 'gcp_collector');

      // Verify payload events
      assert.equal(capturedBody.events.length, 2);
      const [ev1, ev2] = capturedBody.events;

      assert.equal(ev1.observation_id, 'glb_log_entry_001');
      assert.equal(ev1.correlation_id, 'vgt_glb_log_entry_001');
      assert.equal(ev1.collector_type, 'gcp_collector');
      assert.equal(ev1.request.method, 'GET');
      assert.equal(ev1.request.host, 'example.com');
      assert.equal(ev1.request.path, '/api/pricing');
      assert.equal(ev1.request.user_agent, 'ChatGPT-User/1.0');
      assert.equal(ev1.network.ip_hash, '198.51.100.25'); // Port stripped
      assert.equal(ev1.response.duration_ms, 38);

      assert.equal(ev2.observation_id, 'glb_log_entry_002');
      assert.equal(ev2.request.user_agent, 'ClaudeBot/1.0');
      assert.equal(ev2.network.ip_hash, '203.0.113.50');
      assert.equal(ev2.response.duration_ms, 42);
    });

    test('Ingestion API error returns HTTP 502 with error details', async () => {
      setLoggingClientOverride({
        getEntries: async () => [[{
          metadata: {
            insertId: 'log_err_01',
            httpRequest: { requestUrl: 'https://example.com/', status: 200 }
          }
        }]]
      });

      globalThis.fetch = async () => ({
        ok: false,
        status: 500,
        text: async () => 'Internal Ingestion API Error'
      });

      let responseStatus = 0;
      let responseBody = null;

      const mockReq = { method: 'POST', path: '/' };
      const mockRes = {
        status: (code) => {
          responseStatus = code;
          return {
            json: (body) => { responseBody = body; return body; }
          };
        }
      };

      await collectLogs(mockReq, mockRes);
      assert.equal(responseStatus, 502);
      assert.equal(responseBody.error, 'IngestionError');
      assert.equal(responseBody.statusCode, 500);
      assert.equal(responseBody.details, 'Internal Ingestion API Error');
    });

    test('Cloud Logging exception returns HTTP 500 with ExecutionError', async () => {
      setLoggingClientOverride({
        getEntries: async () => {
          throw new Error('GCP Logging API: 403 PermissionDenied');
        }
      });

      let responseStatus = 0;
      let responseBody = null;

      const mockReq = { method: 'POST', path: '/' };
      const mockRes = {
        status: (code) => {
          responseStatus = code;
          return {
            json: (body) => { responseBody = body; return body; }
          };
        }
      };

      await collectLogs(mockReq, mockRes);
      assert.equal(responseStatus, 500);
      assert.equal(responseBody.error, 'ExecutionError');
      assert.equal(responseBody.message, 'GCP Logging API: 403 PermissionDenied');
    });
  });
});
