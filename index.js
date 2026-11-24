import crypto from 'node:crypto';

let LoggingClass = null;
let loggingClientOverride = null;

export function setLoggingClientOverride(override) {
  loggingClientOverride = override;
}

export async function getLoggingClient() {
  if (loggingClientOverride) {
    return loggingClientOverride;
  }
  if (!LoggingClass) {
    const mod = await import('@google-cloud/logging');
    LoggingClass = mod.Logging || mod.default?.Logging || mod.default;
  }
  return new LoggingClass();
}

/**
 * ============================================================================
 * SECURITY & PRIVACY AUDIT: ALLOWLISTED SAFE HEADERS
 * ============================================================================
 * The Voight Trace GCP Collector executes within the customer's Google Cloud project.
 * Under ZERO circumstances does it capture sensitive client headers.
 *
 * EXPLICITLY FORBIDDEN / NEVER COLLECTED:
 * - authorization / proxy-authorization (Bearer tokens, JWTs, Basic Auth)
 * - cookie / set-cookie (Session identifiers, tracking cookies)
 * - x-api-key / api-key / x-auth-token / x-access-token
 * - any custom credentials, secrets, or password headers
 *
 * ONLY the following deterministic, non-sensitive headers strictly necessary
 * for AI bot classification, client hints, content negotiation, and routing
 * are extracted. All others are completely filtered out.
 */
export const SAFE_AUDIT_HEADERS = Object.freeze([
  // Core AI & Traffic Identification (Required for bot classification & GEO referrals)
  'user-agent',
  'referer',
  'host',
  'origin',

  // Content Negotiation
  'accept',
  'accept-encoding',
  'accept-language',
  'content-type',

  // Client Hints (Browser & Device Architecture)
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-ch-ua-platform-version',
  'sec-ch-ua-model',
  'sec-ch-ua-arch',

  // Request & Fetch Context
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user'
]);

const SAFE_HEADERS_SET = new Set(SAFE_AUDIT_HEADERS);

/**
 * Extracts ONLY safe, allowlisted headers from an incoming headers structure.
 * Checks header keys case-insensitively and standardizes on lowercase keys.
 * Guaranteed to never capture authorization tokens, cookies, or credentials.
 *
 * Supports:
 * - Plain JavaScript object: { 'User-Agent': '...', 'Authorization': '...' }
 * - Fetch Headers / Map object (via .get() or .entries())
 * - Array of header strings: ['User-Agent: FooBot', 'Authorization: Bearer secret']
 *
 * @param {Object|Headers|Map|Array<string>} headers - Headers structure
 * @returns {Record<string, string>} Sanitized allowlisted headers
 */
export function filterSafeHeaders(headers) {
  if (!headers) return {};
  const filtered = {};

  // Case 1: Array of header lines e.g. ["User-Agent: bot", "Cookie: sid=123"]
  if (Array.isArray(headers)) {
    for (const item of headers) {
      if (typeof item === 'string') {
        const colonIndex = item.indexOf(':');
        if (colonIndex > 0) {
          const key = item.slice(0, colonIndex).trim().toLowerCase();
          const val = item.slice(colonIndex + 1).trim();
          if (SAFE_HEADERS_SET.has(key) && val) {
            filtered[key] = val;
          }
        }
      }
    }
    return filtered;
  }

  // Case 2: Fetch Headers or Map instance with entries() or get()
  if (typeof headers.entries === 'function') {
    for (const [rawKey, rawVal] of headers.entries()) {
      const key = String(rawKey).toLowerCase();
      if (SAFE_HEADERS_SET.has(key) && rawVal) {
        filtered[key] = String(rawVal);
      }
    }
    return filtered;
  }

  // Case 3: Standard Object
  for (const [rawKey, rawVal] of Object.entries(headers)) {
    const key = String(rawKey).toLowerCase();
    if (SAFE_HEADERS_SET.has(key) && rawVal !== undefined && rawVal !== null && rawVal !== '') {
      filtered[key] = Array.isArray(rawVal) ? rawVal.join(', ') : String(rawVal);
    }
  }

  return filtered;
}

/**
 * Cleans IP addresses reported by Google Cloud Load Balancer.
 * Strips port numbers if present (e.g. "198.51.100.25:48210" -> "198.51.100.25"
 * or "[2001:db8::1]:8080" -> "2001:db8::1").
 *
 * @param {string} rawIp
 * @returns {string} Clean IPv4 or IPv6 address
 */
export function cleanIp(rawIp) {
  if (!rawIp || typeof rawIp !== 'string') return '127.0.0.1';
  let ip = rawIp.trim();

  // IPv6 bracketed format with port: [2001:db8::1]:8080
  if (ip.startsWith('[')) {
    const closingBracket = ip.indexOf(']');
    if (closingBracket !== -1) {
      return ip.slice(1, closingBracket);
    }
  }

  // IPv4 with port: 198.51.100.25:48210 (contains single colon)
  const parts = ip.split(':');
  if (parts.length === 2 && !ip.includes('::')) {
    return parts[0];
  }

  return ip;
}

/**
 * Converts Google Cloud Logging latency representations to integer milliseconds.
 *
 * Supported formats:
 * - Second string with 's' suffix: "0.045120s" -> 45
 * - Numeric seconds: 0.045 -> 45, 1.5 -> 1500
 * - Protobuf Duration object: { seconds: 1, nanos: 250000000 } -> 1250
 * - Number string without 's': "1.25" -> 1250
 *
 * @param {string|number|Object} latency
 * @returns {number} Latency in milliseconds
 */
export function parseLatencyMs(latency) {
  if (!latency) return 0;

  // Protobuf Duration representation: { seconds, nanos }
  if (typeof latency === 'object' && latency !== null) {
    const seconds = Number(latency.seconds || 0);
    const nanos = Number(latency.nanos || 0);
    return Math.max(0, Math.round(seconds * 1000 + nanos / 1e6));
  }

  if (typeof latency === 'number') {
    return Number.isFinite(latency) ? Math.max(0, Math.round(latency * 1000)) : 0;
  }

  if (typeof latency === 'string') {
    const cleanStr = latency.trim();
    if (!cleanStr) return 0;
    const parsed = parseFloat(cleanStr.replace(/s$/i, ''));
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 1000)) : 0;
  }

  return 0;
}

/**
 * Transforms a single Cloud Logging LogEntry into a Voight Trace Event Contract observation.
 * Accurately extracts fields from both @google-cloud/logging SDK entries and raw JSON logs.
 *
 * @param {Object} entry - Google Cloud LogEntry
 * @param {Object} config - { siteId, tenantId, collectorId }
 * @returns {Object|null} Transformed observation or null if invalid
 */
export function transformLogEntry(entry, config) {
  if (!entry) return null;

  // SDK may expose fields directly on entry or under entry.metadata
  const metadata = entry.metadata || entry;
  const http = metadata.httpRequest || entry.httpRequest || {};
  const jsonPayload = metadata.jsonPayload || entry.data || entry.jsonPayload || {};
  const resource = metadata.resource || entry.resource || {};
  const labels = resource.labels || {};

  const requestUrlStr = http.requestUrl || '/';
  const rawHeaders = {};

  // Extract custom headers from jsonPayload if configured on customer GLB
  const payloadHeaders = jsonPayload.httpRequest?.headers || jsonPayload.customHeaders || jsonPayload.headers || {};
  if (Array.isArray(payloadHeaders)) {
    Object.assign(rawHeaders, filterSafeHeaders(payloadHeaders));
  } else if (typeof payloadHeaders === 'object') {
    Object.assign(rawHeaders, payloadHeaders);
  }

  if (http.userAgent) rawHeaders['user-agent'] = http.userAgent;
  if (http.referer) rawHeaders['referer'] = http.referer;

  // Parse URL safely
  let parsedUrl;
  try {
    parsedUrl = new URL(requestUrlStr, 'https://unknown-host');
  } catch {
    parsedUrl = { protocol: 'https:', hostname: 'unknown-host', pathname: '/', searchParams: new URLSearchParams() };
  }

  if (parsedUrl.hostname && parsedUrl.hostname !== 'unknown-host') {
    rawHeaders['host'] = parsedUrl.hostname;
  } else if (rawHeaders['host']) {
    // If requestUrl was relative and host header was captured
    try {
      parsedUrl = new URL(requestUrlStr, `https://${rawHeaders['host']}`);
    } catch {
      // fallback
    }
  }

  const selectedHeaders = filterSafeHeaders(rawHeaders);
  const insertId = metadata.insertId || entry.insertId || crypto.randomUUID();
  const rawTimestamp = metadata.timestamp || entry.timestamp;
  const occurredAt = rawTimestamp ? new Date(rawTimestamp).toISOString() : new Date().toISOString();

  // Extract client IP and sanitize port
  const clientIp = cleanIp(http.remoteIp);

  // Geographic country code resolution:
  // 1. Prioritize Cloud Armor clientRegion if present (e.g., "US", "BR")
  // 2. Fallback to resource zone or default "XX"
  let countryCode = 'XX';
  const armorRegion = jsonPayload.securityPolicyRequestData?.clientRegion;
  if (armorRegion && typeof armorRegion === 'string' && armorRegion.length === 2) {
    countryCode = armorRegion.toUpperCase();
  } else if (labels.zone && typeof labels.zone === 'string' && labels.zone !== 'global') {
    countryCode = labels.zone.slice(0, 2).toUpperCase();
  }

  return {
    event_id: crypto.randomUUID(),
    event_type: 'http.request',
    schema_version: 1,
    tenant_id: config.tenantId || config.siteId,
    site_id: config.siteId,
    collector_id: config.collectorId || 'gcp_glb_collector',
    collector_type: 'gcp_collector',
    observation_id: insertId,
    correlation_id: `vgt_${insertId}`,
    occurred_at: occurredAt,
    request: {
      method: (http.requestMethod || 'GET').toUpperCase(),
      scheme: parsedUrl.protocol ? parsedUrl.protocol.replace(':', '') : 'https',
      host: parsedUrl.hostname || 'unknown-host',
      path: parsedUrl.pathname || '/',
      query_params: Object.fromEntries(parsedUrl.searchParams ? parsedUrl.searchParams.entries() : []),
      referer: http.referer || selectedHeaders['referer'] || '',
      user_agent: http.userAgent || selectedHeaders['user-agent'] || '',
      selected_headers: selectedHeaders
    },
    network: {
      ip_hash: clientIp,
      country: countryCode,
      asn: 0
    },
    response: {
      status_code: Number(http.status || 200),
      duration_ms: parseLatencyMs(http.latency),
      bytes_sent: Number(http.responseSize || 0)
    }
  };
}

/**
 * Cloud Run Function HTTP Entry Point: collectLogs
 * Invoked periodically by Cloud Scheduler (cron: * /1 * * * *) or manual trigger.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function collectLogs(req, res) {
  const startTime = Date.now();

  // Healthcheck endpoints
  if (req.method === 'GET' && (req.path === '/health' || req.path === '/healthz' || req.path === '/')) {
    return res.status(200).json({ status: 'healthy', collector: 'gcp-collector', version: '1.0.0' });
  }

  const apiKey = process.env.VOIGHT_TRACE_API_KEY;
  const siteId = process.env.VOIGHT_TRACE_SITE_ID;
  const tenantId = process.env.VOIGHT_TRACE_TENANT_ID || siteId;
  const collectorId = process.env.VOIGHT_TRACE_COLLECTOR_ID || `gcp_${process.env.K_SERVICE || 'glb'}`;
  const ingestUrl = process.env.VOIGHT_TRACE_INGEST_URL || 'https://voighttrace.vercel.app/api/v1/ingestion/events';
  const lookbackSeconds = Number(process.env.LOOKBACK_SECONDS || 75);

  if (!apiKey || !siteId) {
    const errorMsg = 'VOIGHT_TRACE_API_KEY or VOIGHT_TRACE_SITE_ID is missing in environment variables.';
    console.error(`[Voight Trace GCP Collector] Configuration Error: ${errorMsg}`);
    return res.status(500).json({ error: 'ConfigurationError', message: errorMsg });
  }

  // Calculate sliding time window
  const now = new Date();
  const windowStart = new Date(now.getTime() - lookbackSeconds * 1000);
  const startTimeISO = windowStart.toISOString();
  const endTimeISO = now.toISOString();

  // Filter Cloud Logging for GLB access logs within the sliding window
  const filter = `resource.type="http_load_balancer" AND timestamp >= "${startTimeISO}" AND timestamp <= "${endTimeISO}"`;

  try {
    console.log(`[Voight Trace GCP Collector] Querying GLB logs from ${startTimeISO} to ${endTimeISO}...`);
    
    // Application Default Credentials (ADC) automatically resolves authentication
    const logging = await getLoggingClient();
    const [entries] = await logging.getEntries({
      filter,
      pageSize: 1000,
      orderBy: 'timestamp asc'
    });

    console.log(`[Voight Trace GCP Collector] Retrieved ${entries.length} log entries from Cloud Logging.`);

    if (entries.length === 0) {
      return res.status(200).json({
        status: 'success',
        retrieved: 0,
        dispatched: 0,
        window: { start: startTimeISO, end: endTimeISO },
        duration_ms: Date.now() - startTime
      });
    }

    // Transform entries into Voight Trace Event Contract
    const config = { siteId, tenantId, collectorId };
    const observations = [];

    for (const entry of entries) {
      const observation = transformLogEntry(entry, config);
      if (observation) {
        observations.push(observation);
      }
    }

    // Dispatch batch to Voight Trace Ingestion API
    console.log(`[Voight Trace GCP Collector] Dispatching batch of ${observations.length} observations to ${ingestUrl}...`);

    const ingestResponse = await fetch(ingestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'x-voight-collector-type': 'gcp_collector',
        'x-voight-collector-version': '1.0.0'
      },
      body: JSON.stringify({ events: observations })
    });

    if (!ingestResponse.ok) {
      const errorText = await ingestResponse.text();
      console.error(`[Voight Trace GCP Collector] Ingestion API error (HTTP ${ingestResponse.status}):`, errorText);
      return res.status(502).json({
        error: 'IngestionError',
        statusCode: ingestResponse.status,
        details: errorText
      });
    }

    const ingestResult = await ingestResponse.json();
    console.log(`[Voight Trace GCP Collector] Successfully dispatched ${observations.length} observations.`);

    return res.status(200).json({
      status: 'success',
      retrieved: entries.length,
      dispatched: observations.length,
      ingestResponse: ingestResult,
      window: { start: startTimeISO, end: endTimeISO },
      duration_ms: Date.now() - startTime
    });
  } catch (err) {
    console.error('[Voight Trace GCP Collector] Unexpected execution error:', err);
    return res.status(500).json({
      error: 'ExecutionError',
      message: err.message
    });
  }
}

export default collectLogs;
