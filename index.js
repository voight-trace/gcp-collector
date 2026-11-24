import crypto from 'node:crypto';

let LoggingClass = null;
async function getLoggingClient() {
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

/**
 * Extracts ONLY safe, allowlisted headers from an incoming headers structure.
 * Guaranteed to never capture authorization tokens, cookies, or credentials.
 *
 * @param {Object|Headers|Map} headers - Headers object or Map
 * @returns {Record<string, string>} Sanitized allowlisted headers
 */
export function filterSafeHeaders(headers) {
  if (!headers) return {};
  const filtered = {};

  if (typeof headers.get === 'function') {
    for (const name of SAFE_AUDIT_HEADERS) {
      const val = headers.get(name);
      if (val) filtered[name] = val;
    }
    return filtered;
  }

  for (const name of SAFE_AUDIT_HEADERS) {
    const val = headers[name];
    if (val !== undefined && val !== null && val !== '') {
      filtered[name] = Array.isArray(val) ? val.join(', ') : String(val);
    }
  }
  return filtered;
}

/**
 * Converts Google Cloud Logging latency string (e.g. "0.045120s") to integer milliseconds.
 *
 * @param {string|number} latency
 * @returns {number} Latency in milliseconds
 */
export function parseLatencyMs(latency) {
  if (typeof latency === 'number') {
    return Math.round(latency * 1000);
  }
  if (typeof latency === 'string') {
    const parsed = parseFloat(latency.replace('s', ''));
    return Number.isFinite(parsed) ? Math.round(parsed * 1000) : 0;
  }
  return 0;
}

/**
 * Transforms a single Cloud Logging LogEntry into a Voight Trace Event Contract observation.
 *
 * @param {Object} entry - Google Cloud LogEntry
 * @param {Object} config - { siteId, tenantId, collectorId }
 * @returns {Object|null} Transformed observation or null if invalid
 */
export function transformLogEntry(entry, config) {
  if (!entry || !entry.metadata) return null;

  const metadata = entry.metadata;
  const http = metadata.httpRequest || {};
  const requestUrlStr = http.requestUrl || '/';

  let parsedUrl;
  try {
    parsedUrl = new URL(requestUrlStr, 'https://unknown-host');
  } catch {
    parsedUrl = { protocol: 'https:', hostname: 'unknown-host', pathname: '/', searchParams: new URLSearchParams() };
  }

  const insertId = metadata.insertId || crypto.randomUUID();
  const occurredAt = metadata.timestamp ? new Date(metadata.timestamp).toISOString() : new Date().toISOString();

  // Extract custom headers if logged in jsonPayload
  const rawHeaders = metadata.jsonPayload?.customHeaders || {};
  if (http.userAgent) rawHeaders['user-agent'] = http.userAgent;
  if (http.referer) rawHeaders['referer'] = http.referer;
  if (parsedUrl.hostname) rawHeaders['host'] = parsedUrl.hostname;

  const selectedHeaders = filterSafeHeaders(rawHeaders);

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
      referer: http.referer || '',
      user_agent: http.userAgent || '',
      selected_headers: selectedHeaders
    },
    network: {
      ip_hash: http.remoteIp || '127.0.0.1',
      country: (metadata.resource?.labels?.zone || 'XX').slice(0, 2).toUpperCase(),
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
 * Invoked periodically by Cloud Scheduler or manual trigger.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function collectLogs(req, res) {
  const startTime = Date.now();

  // Healthcheck support
  if (req.method === 'GET' && (req.path === '/health' || req.path === '/healthz')) {
    return res.status(200).json({ status: 'healthy', collector: 'gcp-collector', version: '1.0.0' });
  }

  const apiKey = process.env.VOIGHT_TRACE_API_KEY;
  const siteId = process.env.VOIGHT_TRACE_SITE_ID;
  const tenantId = process.env.VOIGHT_TRACE_TENANT_ID || siteId;
  const collectorId = process.env.VOIGHT_TRACE_COLLECTOR_ID || `gcp_${process.env.K_SERVICE || 'glb'}`;
  const ingestUrl = process.env.VOIGHT_TRACE_INGEST_URL || 'https://api.voighttrace.com/api/v1/ingestion/events';
  const lookbackSeconds = Number(process.env.LOOKBACK_SECONDS || 75);

  if (!apiKey || !siteId) {
    const errorMsg = 'VOIGHT_TRACE_API_KEY or VOIGHT_TRACE_SITE_ID is missing in environment variables.';
    console.error(`[Voight Trace GCP Collector] Error: ${errorMsg}`);
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
