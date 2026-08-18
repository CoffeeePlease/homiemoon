// netlify/functions/scan-receipt.js
//
// Serverless OCR endpoint for the Homiemoon "Split the Bill" tab.
// Receives a base64 image, asks Claude vision to extract line items,
// and returns clean JSON: { restaurant, items:[{name,price}], tax, tip }.
//
// SETUP (one-time):
//   1. In Netlify: Site settings > Environment variables > add
//        ANTHROPIC_API_KEY = sk-ant-...   (from console.anthropic.com)
//   2. Commit this file at:  netlify/functions/scan-receipt.js
//   3. Deploy. The front-end calls it at /.netlify/functions/scan-receipt

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-3-5-sonnet-20241022';

const PROMPT = `You are a receipt-scanning assistant. Read this receipt image and extract the data.
Return ONLY a valid JSON object (no markdown, no code fences, no commentary) with this exact shape:
{
  "restaurant": "string or empty",
  "items": [ { "name": "string", "price": number } ],
  "tax": number,
  "tip": number
}
Rules:
- "price" and "tax" and "tip" must be plain numbers (e.g. 12.5), never strings or with a $ sign.
- Only include actual purchased line items in "items" (skip subtotals/totals/tax/tip lines).
- If tax or tip is not present, use 0.
- If you cannot read the receipt, return {"restaurant":"","items":[],"tax":0,"tip":0}.`;

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server not configured: ANTHROPIC_API_KEY is missing in Netlify environment variables.' }),
    };
  }

  // Parse incoming request
  let image_base64, media_type;
  try {
    const parsed = JSON.parse(event.body || '{}');
    image_base64 = parsed.image_base64;
    media_type = parsed.media_type || 'image/jpeg';
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }
  if (!image_base64) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No image_base64 provided' }) };
  }

  // Anthropic only accepts these media types for images
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!allowed.includes(media_type)) media_type = 'image/jpeg';

  try {
    const aiRes = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type, data: image_base64 } },
              { type: 'text', text: PROMPT },
            ],
          },
        ],
      }),
    });

    const raw = await aiRes.text();
    if (!aiRes.ok) {
      // Surface the real upstream error (e.g. 401 bad key, 429 rate limit)
      return {
        statusCode: aiRes.status,
        headers,
        body: JSON.stringify({ error: `AI request failed (${aiRes.status}): ${raw.slice(0, 500)}` }),
      };
    }

    const data = JSON.parse(raw);
    let text = (data.content && data.content[0] && data.content[0].text) || '';

    // Strip any accidental code fences, then parse the JSON payload
    text = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'AI returned unreadable output' }) };
    }

    const result = JSON.parse(match[0]);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        restaurant: result.restaurant || '',
        items: Array.isArray(result.items) ? result.items : [],
        tax: Number(result.tax) || 0,
        tip: Number(result.tip) || 0,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Function error: ' + err.message }) };
  }
};
