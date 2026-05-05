// ============================================================
// grasse-apps-proxy — Supabase Proxy + Claude API Relay
//
// ⚠️  THIS WORKER SERVES MULTIPLE APPS. READ BEFORE EDITING.
//
// APP REGISTRY (appId → Cloudflare Secret → purpose):
//   mybff        → MYBFF_SERVICE_KEY        MyBFF Donation Tracker (production)
//   mybff-dev    → MYBFF_DEV_SERVICE_KEY    MyBFF Donation Tracker (dev/sandbox)
//   mealplanner  → MEALPLANNER_SERVICE_KEY  Meal Planner app
//   fleet        → FLEET_SERVICE_KEY        Fleet Manager app
//   bills        → MYBFF_SERVICE_KEY        Bills app (shares MyBFF Supabase key)
//   app3         → APP3_SERVICE_KEY         Unused placeholder — do not delete yet
//   fishinglog   → FISHINGLOG_SERVICE_KEY   Fish Log app
//   travelstrong → TRAVELSTRONG_SERVICE_KEY Travel Strong fitness app
//
// TO ADD A NEW APP:
//   1. Add an else-if block in the appId routing section below
//   2. Add the corresponding Secret in Cloudflare dashboard:
//      Workers & Pages → grasse-apps-proxy → Settings → Variables and Secrets
//   3. Update this comment block with the new entry
//   Never hardcode a key. Never remove an appId without
//   confirming that app is fully retired.
//
// SUPABASE PROJECT:
//   URL: https://viprflxaudxjwsvytrnn.supabase.co
//   All apps above (except egcw) share this one Supabase project.
//   Each app uses its own table prefix to avoid collisions:
//     MyBFF*        → MyBFF Donation Tracker
//     Fleet*        → Fleet Manager
//     Meals*        → Meal Planner
//     BILLS*        → Bills app
//     Fishing*      → Fish Log app
//     TravelStrong* → Travel Strong fitness app
//   RLS must be DISABLED on all app tables (Worker uses service key).
//
// CLAUDE API:
//   FLEET_ANTHROPIC_KEY → used by Fleet app Claude features (CLAUDE_API method)
//   To add Claude support to another app, add its own key secret and
//   update handleClaudeAPIRequest() to route by appId.
//
// SECRETS (manage in Cloudflare dashboard — never paste keys here):
//   MYBFF_SERVICE_KEY, MYBFF_DEV_SERVICE_KEY, MEALPLANNER_SERVICE_KEY,
//   FLEET_SERVICE_KEY, APP3_SERVICE_KEY, FLEET_ANTHROPIC_KEY,
//   FISHINGLOG_SERVICE_KEY, TRAVELSTRONG_SERVICE_KEY
//
// SESSION HISTORY:
//   Session 11 — Added: travelstrong app routing (Travel Strong fitness app)
//   Session 10 — Added: fishinglog app routing (Fish Log app)
//   Session 9  — Fixed: mybffAnalyze result handling (callClaude returns string not object)
//   Session 8  — Added: mybff-dev routing; shared Worker header comment block
//   Session 7  — Added: motor_engine, trolling_motor, radio_electronics types
//   Session 6  — Added: readUrlManual Claude method (fetch + summarize URL)
//   Session 5  — Added: STORAGE_UPLOAD handler
//             Fixed: trailer classification in extractVehicleFromDocument
// ============================================================

const SUPABASE_URL = "https://viprflxaudxjwsvytrnn.supabase.co";

export default {
  async fetch(request, env) {

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, request);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400, request);
    }

    // Handle URL fetch/proxy (used for OneDrive downloads)
    if (body.method === 'FETCH_URL') {
      return await handleFetchUrl(body.url, request);
    }

    // Handle Supabase Storage uploads
    if (body.method === 'STORAGE_UPLOAD') {
      return await handleStorageUpload(body, env, request);
    }

    // Generate a presigned upload URL for direct browser-to-storage upload
    if (body.method === 'STORAGE_SIGN') {
      return await handleStorageSign(body, env, request);
    }

    // Handle Claude API requests
    if (body.method === 'CLAUDE_API') {
      return handleClaudeAPIRequest(body, env, request);
    }

    // ── APP ROUTING ──────────────────────────────────────────
    // Pick the right Supabase service key based on appId.
    // See APP REGISTRY in the header comment above.
    // ─────────────────────────────────────────────────────────
    const appId = (body.appId || "").toLowerCase();
    let serviceKey;

    if (appId === "mybff") {
      serviceKey = env.MYBFF_SERVICE_KEY;
    } else if (appId === "mybff-dev") {
      serviceKey = env.MYBFF_DEV_SERVICE_KEY;
    } else if (appId === "mealplanner") {
      serviceKey = env.MEALPLANNER_SERVICE_KEY;
    } else if (appId === 'fleet') {
      serviceKey = env.FLEET_SERVICE_KEY;
    } else if (appId === "app3") {
      serviceKey = env.APP3_SERVICE_KEY;
    } else if (appId === "bills") {
      serviceKey = env.MYBFF_SERVICE_KEY;
    } else if (appId === "fishinglog") {
      serviceKey = env.FISHINGLOG_SERVICE_KEY;
    } else if (appId === "travelstrong") {
      serviceKey = env.TRAVELSTRONG_SERVICE_KEY;
    } else {
      return jsonResponse({ error: "Unknown appId: " + appId }, 403, request);
    }

    if (!serviceKey) {
      return jsonResponse({ error: "Service key not configured for: " + appId }, 500, request);
    }

    const { method, table, filters, data, idField, idValue, column, value } = body;
    if (!table) return jsonResponse({ error: "Missing table" }, 400, request);

    const sbHeaders = {
      "apikey": serviceKey,
      "Authorization": "Bearer " + serviceKey,
      "Content-Type": "application/json",
      "Prefer": "return=representation"
    };

    let url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}`;
    let fetchOptions = { headers: sbHeaders };

    try {
      if (method === "SELECT") {
        url += "?select=*" + (filters ? "&" + filters : "");
        fetchOptions.method = "GET";

      } else if (method === "INSERT") {
        fetchOptions.method = "POST";
        fetchOptions.body = JSON.stringify(data);

      } else if (method === "UPSERT") {
        url += filters ? "?on_conflict=" + filters : "";
        fetchOptions.method = "POST";
        fetchOptions.headers = { ...sbHeaders, "Prefer": "resolution=merge-duplicates,return=representation" };
        fetchOptions.body = JSON.stringify(data);

      } else if (method === "UPDATE") {
        url += `?${idField || "id"}=eq.${encodeURIComponent(idValue)}`;
        fetchOptions.method = "PATCH";
        fetchOptions.body = JSON.stringify(data);

      } else if (method === "UPDATE_WHERE") {
        url += `?${column}=eq.${encodeURIComponent(value)}`;
        fetchOptions.method = "PATCH";
        fetchOptions.body = JSON.stringify(data);

      } else if (method === "DELETE") {
        url += `?${idField || "id"}=eq.${encodeURIComponent(idValue)}`;
        fetchOptions.method = "DELETE";
        fetchOptions.headers = { ...sbHeaders, "Prefer": "" };

      } else {
        return jsonResponse({ error: "Unknown method: " + method }, 400, request);
      }

      const resp = await fetch(url, fetchOptions);
      const text = await resp.text();

      // 204 No Content (successful DELETE) — return clean success
      if (!text || text.trim() === '') {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders(request) }
        });
      }

      let result;
      try { result = JSON.parse(text); } catch { result = text; }

      return new Response(JSON.stringify(result), {
        status: resp.status,
        headers: { "Content-Type": "application/json", ...corsHeaders(request) }
      });

    } catch (err) {
      return jsonResponse({ error: err.message }, 500, request);
    }
  }
};

// ============================================================================
// STORAGE_SIGN — return upload credentials for direct browser-to-Supabase upload
// Browser uploads directly to Supabase, bypassing Worker body size limits entirely
// Returns: { uploadUrl, serviceKey, publicUrl }
// ============================================================================
async function handleStorageSign(body, env, request) {
  const { appId, bucket, filePath } = body;
  if (!filePath || !bucket) {
    return jsonResponse({ error: 'Missing filePath or bucket' }, 400, request);
  }
  let serviceKey;
  if (appId === 'mybff') serviceKey = env.MYBFF_SERVICE_KEY;
  else if (appId === 'mybff-dev') serviceKey = env.MYBFF_DEV_SERVICE_KEY || env.MYBFF_SERVICE_KEY;
  else if (appId === 'fleet') serviceKey = env.FLEET_SERVICE_KEY;
  else if (appId === 'fishinglog') serviceKey = env.FISHINGLOG_SERVICE_KEY;
  else if (appId === 'travelstrong') serviceKey = env.TRAVELSTRONG_SERVICE_KEY;
  else serviceKey = env.FLEET_SERVICE_KEY;
  if (!serviceKey) return jsonResponse({ error: 'Service key not configured' }, 500, request);

  const encodedPath = filePath.split('/').map(s => encodeURIComponent(s)).join('/');
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${bucket}/${encodedPath}`;
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${encodedPath}`;
  return jsonResponse({ uploadUrl, serviceKey, publicUrl }, 200, request);
}

// ============================================================================
// STORAGE_UPLOAD — upload a file to Supabase Storage via Worker
// Expects body: { appId, bucket, filePath, base64Data, contentType }
// Returns: { publicUrl }
// ============================================================================
async function handleStorageUpload(body, env, request) {
  const { appId, bucket, filePath, base64Data, contentType } = body;

  if (!filePath || !base64Data) {
    return jsonResponse({ error: 'Missing filePath or base64Data' }, 400, request);
  }

  let serviceKey;
  if (appId === 'mybff') {
    serviceKey = env.MYBFF_SERVICE_KEY;
  } else if (appId === 'mybff-dev') {
    serviceKey = env.MYBFF_DEV_SERVICE_KEY || env.MYBFF_SERVICE_KEY;
  } else if (appId === 'fleet') {
    serviceKey = env.FLEET_SERVICE_KEY;
  } else if (appId === 'fishinglog') {
    serviceKey = env.FISHINGLOG_SERVICE_KEY;
  } else if (appId === 'travelstrong') {
    serviceKey = env.TRAVELSTRONG_SERVICE_KEY;
  } else {
    serviceKey = env.FLEET_SERVICE_KEY; // fallback
  }

  if (!serviceKey) {
    return jsonResponse({ error: `Service key not configured for appId: ${appId}` }, 500, request);
  }

  try {
    const binary = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
    const encodedPath = filePath.split('/').map(s => encodeURIComponent(s)).join('/');
    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${bucket}/${encodedPath}`;

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': 'Bearer ' + serviceKey,
        'Content-Type': contentType || 'application/octet-stream',
        'x-upsert': 'true',
      },
      body: binary,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      return jsonResponse({ error: 'Storage upload failed: ' + err }, uploadRes.status, request);
    }

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${encodedPath}`;
    return jsonResponse({ publicUrl }, 200, request);

  } catch (err) {
    return jsonResponse({ error: err.message }, 500, request);
  }
}

// ============================================================================
// FETCH_URL — proxy-fetch a URL and return as base64 (used for OneDrive files)
// ============================================================================
async function handleFetchUrl(url, request) {
  if (!url || !url.startsWith('https://')) {
    return jsonResponse({ error: 'Invalid URL' }, 400, request);
  }
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Fetch failed: ' + resp.status);
    const buffer = await resp.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);
    return jsonResponse({ base64 }, 200, request);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500, request);
  }
}

function corsHeaders(request) {
  const origin = request ? (request.headers.get("Origin") || "*") : "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

function jsonResponse(obj, status, request) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) }
  });
}

// ============================================================================
// Claude API Handler — routes to the right method
// ============================================================================
async function handleClaudeAPIRequest(body, env, request) {
  const { claudeMethod, base64Data, mediaType, prompt } = body;

  if (!env.FLEET_ANTHROPIC_KEY) {
    return jsonResponse({ error: 'Claude API key not configured (FLEET_ANTHROPIC_KEY)' }, 500, request);
  }

  try {
    if (claudeMethod === 'extractVehicleDocument') {
      return await extractVehicleFromDocument(base64Data, mediaType, env.FLEET_ANTHROPIC_KEY, request);
    } else if (claudeMethod === 'extractVehiclePhoto') {
      return await extractVehicleFromPhoto(base64Data, env.FLEET_ANTHROPIC_KEY, request);
    } else if (claudeMethod === 'extractReceipt') {
      return await extractReceipt(base64Data, mediaType, env.FLEET_ANTHROPIC_KEY, request);
    } else if (claudeMethod === 'generateChecklist') {
      return await generateChecklist(prompt, env.FLEET_ANTHROPIC_KEY, request);
    } else if (claudeMethod === 'advisorChat') {
      return await advisorChat(body.messages, body.systemPrompt, env.FLEET_ANTHROPIC_KEY, request);
    } else if (claudeMethod === 'readUrlManual') {
      return await readUrlManual(body.url, body.vehicleName, env.FLEET_ANTHROPIC_KEY, request);
    } else if (claudeMethod === 'mybffAnalyze') {
      return await mybffAnalyzeSource(body.prompt, body.base64Data, body.mediaType, body.url, env.FLEET_ANTHROPIC_KEY, request);
    } else {
      return jsonResponse({ error: 'Unknown Claude method: ' + claudeMethod }, 400, request);
    }
  } catch (err) {
    return jsonResponse({ error: err.message }, 500, request);
  }
}

// ============================================================================
// Shared Claude API call helper
// ============================================================================
async function callClaude(apiKey, messages, maxTokens = 1000) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      messages
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Claude API error');
  return data.content[0].text;
}

function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not extract JSON from response');
  return JSON.parse(match[0]);
}

// ============================================================================
// MyBFF — Brand Brain AI Analysis
// ============================================================================
function extractSuggestionsFromMalformedJSON(text) {
  const suggestions = [];
  let depth = 0;
  let objStart = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        const objStr = text.substring(objStart, i + 1);
        const suggestion = extractFieldsFromObject(objStr);
        if (suggestion.field) suggestions.push(suggestion);
        objStart = -1;
      }
    }
  }
  return suggestions;
}

function extractFieldsFromObject(objStr) {
  const fields = ["field","value","source_quote","confidence","conflict","conflict_note"];
  const result = {};
  for (const f of fields) {
    const marker = `"${f}"`;
    const idx = objStr.indexOf(marker);
    if (idx === -1) continue;
    const afterColon = objStr.indexOf(":", idx + marker.length) + 1;
    let valStart = afterColon;
    while (valStart < objStr.length && (objStr[valStart] === " " || objStr[valStart] === "\n" || objStr[valStart] === "\r")) valStart++;
    if (objStr[valStart] === '"') {
      let valEnd = valStart + 1;
      const nextFieldPatterns = fields.filter(ff => ff !== f).map(ff => `",\n    "${ff}"`).concat(['"\n  }','"\n}']);
      let found = objStr.length;
      for (const pat of nextFieldPatterns) {
        const pi = objStr.indexOf(pat, valStart + 1);
        if (pi !== -1 && pi < found) found = pi;
      }
      result[f] = objStr.substring(valStart + 1, found).replace(/\\"/g, '"').replace(/\\/g, '');
    } else if (objStr[valStart] === 'f' || objStr[valStart] === 't') {
      result[f] = objStr.startsWith('true', valStart);
    }
  }
  return result;
}

async function mybffAnalyzeSource(prompt, base64Data, mediaType, url, apiKey, request) {
  try {
    let messages;

    if (base64Data && mediaType) {
      const isImage = mediaType.startsWith("image/");
      const isPdf   = mediaType === "application/pdf" || mediaType.includes("pdf");

      if (isImage) {
        messages = [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
            { type: "text", text: prompt }
          ]
        }];
      } else if (isPdf) {
        messages = [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } },
            { type: "text", text: prompt }
          ]
        }];
      } else {
        return jsonResponse({
          error: "Word documents (.docx) cannot be sent directly to Claude. Please save the document as a PDF and re-upload, or paste the text content into the Notes field when adding to the Brand Library."
        }, 400, request);
      }
    } else if (url) {
      let pageContent = "";
      let fetchStatus = "";
      try {
        const pageRes = await fetch(url, {
          redirect: "follow",
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5"
          }
        });
        fetchStatus = `HTTP ${pageRes.status} from ${pageRes.url}`;
        const html = await pageRes.text();
        pageContent = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
          .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, " ")
          .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, " ")
          .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/\s{2,}/g, " ")
          .trim()
          .substring(0, 10000);
        if (pageContent.length < 100) {
          pageContent = `Page fetched but content was minimal (${pageContent.length} chars). The site may block crawlers or require JavaScript. Raw snippet: ${pageContent}`;
        }
      } catch(fetchErr) {
        pageContent = `Could not fetch URL: ${fetchErr.message}`;
        fetchStatus = fetchErr.message;
      }
      const fullPrompt = prompt + `\n\nURL fetch status: ${fetchStatus}\nPage content (${pageContent.length} chars):\n\n${pageContent}`;
      messages = [{ role: "user", content: fullPrompt }];
    } else {
      messages = [{ role: "user", content: prompt }];
    }

    const result = await callClaude(apiKey, messages, 4000);
    const text = (typeof result === "string" ? result : (result.content || []).map(b => b.text || "").join("")).trim();
    let clean = text.replace(/```json|```/g, "").trim();

    if (!clean || clean.length < 2) {
      return jsonResponse({
        error: "AI returned no content — the document may not contain enough readable text. Try adding the content as pasted text instead.",
        raw: text.substring(0, 200)
      }, 500, request);
    }

    const startIdx = clean.indexOf("[");
    const endIdx = clean.lastIndexOf("]");
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      clean = clean.substring(startIdx, endIdx + 1);
    }

    let suggestions;
    try {
      suggestions = JSON.parse(clean);
    } catch(e) {
      try {
        suggestions = extractSuggestionsFromMalformedJSON(clean);
        if (!suggestions.length) throw new Error("No suggestions extracted");
      } catch(e2) {
        return jsonResponse({ error: "Could not parse AI response as JSON", rawLength: clean.length, raw: clean }, 500, request);
      }
    }
    return jsonResponse({ suggestions: suggestions || [] }, 200, request);
  } catch(err) {
    return jsonResponse({ error: err.message }, 500, request);
  }
}

async function extractVehicleFromDocument(base64Data, mediaType, apiKey, request) {
  const isImage = mediaType.startsWith('image');
  const text = await callClaude(apiKey, [{
    role: 'user',
    content: [
      {
        type: isImage ? 'image' : 'document',
        source: { type: 'base64', media_type: mediaType, data: base64Data }
      },
      {
        type: 'text',
        text: `Extract vehicle information from this document. Return ONLY valid JSON:
{
  "name": "descriptive name (e.g., 'Sea Ray 240' or '2018 EZ Loader Trailer')",
  "type": "boat|snowmobile|jet_ski|boat_lift|truck|trailer|fish_finder|atv|motor_engine|trolling_motor|radio_electronics|other",
  "make": "manufacturer or null",
  "model": "model or null",
  "year": year_as_number or null,
  "engine_type": "engine description or null",
  "hull_vin": "VIN/HIN or null",
  "concerns": [],
  "notes": "any relevant details or null"
}

TYPE RULES — pick the most specific match:
- motor_engine: outboard motor, inboard engine, sterndrive, or any standalone marine/vehicle engine
- trolling_motor: trolling motor or electric motor
- radio_electronics: VHF radio, marine radio, chartplotter, or communication device
- trailer: boat trailer, utility trailer, car hauler, or any towed trailer
- boat: watercraft (powerboat, sailboat, pontoon, etc.)
- snowmobile: snowmobile or sled
- jet_ski: personal watercraft / PWC / Sea-Doo / Waverunner
- boat_lift: boat lift or hoist
- truck: truck, SUV, van, or tow vehicle
- fish_finder: marine electronics, fish finders, or GPS units (not radios)
- atv: ATV, UTV, side-by-side, or off-road vehicle
- other: only if nothing above matches

Return ONLY the JSON object.`
      }
    ]
  }]);
  const result = extractJSON(text);
  return jsonResponse({ result }, 200, request);
}

async function extractVehicleFromPhoto(base64Data, apiKey, request) {
  const text = await callClaude(apiKey, [{
    role: 'user',
    content: [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: base64Data }
      },
      {
        type: 'text',
        text: `Analyze this photo of a vehicle nameplate, sticker, or hull markings. Return ONLY valid JSON:
{
  "name": "descriptive name based on what you see",
  "type": "boat|snowmobile|jet_ski|boat_lift|truck|trailer|fish_finder|atv|motor_engine|trolling_motor|radio_electronics|other",
  "make": "manufacturer/brand or null",
  "model": "model name or null",
  "year": year_as_number_or_null,
  "engine_type": "engine details if visible or null",
  "hull_vin": "HIN/VIN if visible or null",
  "concerns": [],
  "notes": "any other details or null"
}

TYPE RULES — pick the most specific match:
- motor_engine: if you see an outboard motor, engine label, or sterndrive
- trolling_motor: if you see a trolling motor or electric motor
- radio_electronics: if you see a VHF radio, marine radio, or chartplotter
- trailer: if you see a boat trailer, utility trailer, or any towed trailer
- boat: if you see a watercraft nameplate or hull
- snowmobile: if you see a snowmobile
- jet_ski: if you see a personal watercraft / PWC
- boat_lift: if you see a boat lift
- truck: if you see a truck, SUV, or tow vehicle
- fish_finder: if you see a fish finder, GPS unit, or sonar display
- atv: if you see an ATV, UTV, or off-road vehicle
- other: only if nothing above matches

Return ONLY the JSON object.`
      }
    ]
  }]);
  const result = extractJSON(text);
  return jsonResponse({ result }, 200, request);
}

async function extractReceipt(base64Data, mediaType, apiKey, request) {
  const isImage = mediaType.startsWith('image');
  const text = await callClaude(apiKey, [{
    role: 'user',
    content: [
      {
        type: isImage ? 'image' : 'document',
        source: { type: 'base64', media_type: mediaType, data: base64Data }
      },
      {
        type: 'text',
        text: `Extract maintenance receipt information. Return ONLY valid JSON:
{
  "maintenance_type": "oil_change|winterization|commissioning|inspection|repair|other",
  "date": "YYYY-MM-DD format if found, or null",
  "cost": cost_as_number_no_dollar_sign_or_null,
  "description": "summary of work performed",
  "completed_by": "shop name or technician name or null"
}

For maintenance_type, choose the best match:
- oil_change: if receipt mentions oil, filters, lubrication
- winterization: if receipt mentions winterization, fogging, antifreeze
- commissioning: if receipt mentions spring, launch, commissioning
- inspection: if receipt mentions inspection, survey, annual service
- repair: if receipt mentions repair, replacement, fix
- other: for anything else

Return ONLY the JSON object.`
      }
    ]
  }]);
  const result = extractJSON(text);
  return jsonResponse({ result }, 200, request);
}

async function advisorChat(messages, systemPrompt, apiKey, request) {
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages
  };
  if (systemPrompt) body.system = systemPrompt;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Claude API error');
  return jsonResponse({ result: data.content[0].text }, 200, request);
}

async function generateChecklist(prompt, apiKey, request) {
  const text = await callClaude(apiKey, [{ role: 'user', content: prompt }], 1500);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse checklist response');
  const parsed = JSON.parse(match[0]);
  const items = parsed.items || [];
  const normalized = items.map((item, idx) => ({
    id: idx.toString(),
    item_text: item.item_text || item.text || item,
    completed: false,
    notes: '',
    order: idx + 1
  }));
  return jsonResponse({ result: { items: normalized } }, 200, request);
}

async function readUrlManual(url, vehicleName, apiKey, request) {
  if (!url || !url.startsWith('https://')) {
    return jsonResponse({ error: 'Invalid URL' }, 400, request);
  }

  let pageText = '';
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 Fleet Manager Bot' },
      signal: AbortSignal.timeout(8000)
    });
    if (!resp.ok) throw new Error('Could not fetch: ' + resp.status);
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('pdf')) {
      return jsonResponse({ result: 'PDF manuals cannot be read directly via URL — download the PDF and upload it to the Documents tab for AI analysis.' }, 200, request);
    }
    const rawText = await resp.text();
    pageText = rawText.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0, 8000);
  } catch (err) {
    return jsonResponse({ error: 'Could not fetch URL: ' + err.message }, 500, request);
  }

  if (!pageText || pageText.length < 50) {
    return jsonResponse({ result: 'The page did not return readable text content. Try uploading a downloaded copy instead.' }, 200, request);
  }

  const text = await callClaude(apiKey, [{
    role: 'user',
    content: `You are helping a vehicle owner understand their manual or spec page. The vehicle is: ${vehicleName || 'unknown'}.

Here is the text content from the manual/page URL:
---
${pageText}
---

Provide a concise summary of the most useful maintenance-relevant information on this page: key specifications, service intervals, fluid types, capacities, torque specs, warnings, or any other actionable info a mechanic or owner would want. Keep it under 300 words.`
  }], 600);

  return jsonResponse({ result: text }, 200, request);
}
