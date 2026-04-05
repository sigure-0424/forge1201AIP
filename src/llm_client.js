// src/llm_client.js
require('dotenv').config();
const fs = require('fs');

// In WSL2, 'localhost' / '127.0.0.1' resolves inside the Linux VM — not Windows.
// If Ollama is running on the Windows host, replace localhost with the WSL2
// default-gateway IP, which is the Windows host on the virtual network.
function resolveWslUrl(url) {
    if (!url.includes('localhost') && !url.includes('127.0.0.1')) return url;
    try {
        const version = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
        if (!version.includes('microsoft') && !version.includes('wsl')) return url;
        // /proc/net/route: fields are tab-separated hex values, IPs in little-endian.
        // Default route = Destination '00000000', Mask '00000000'.
        for (const line of fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
            const f = line.trim().split(/\s+/);
            if (f.length < 8 || f[1] !== '00000000' || f[7] !== '00000000') continue;
            // Gateway field (f[2]) is 4-byte little-endian hex → reverse byte order for IP
            const hex = f[2].padStart(8, '0');
            const ip = [3, 2, 1, 0].map(i => parseInt(hex.slice(i * 2, i * 2 + 2), 16)).join('.');
            if (ip === '0.0.0.0') continue;
            const resolved = url.replace(/localhost|127\.0\.0\.1/, ip);
            console.log(`[LLMClient] WSL2 detected — remapped localhost → ${ip}`);
            return resolved;
        }
    } catch (_) {}
    return url;
}

class LLMClient {
    constructor(model = process.env.OLLAMA_MODEL || 'gpt-oss:20b-cloud', url = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate') {
        this.model = model;
        this.url = url; // Use URL exactly as provided, bypassing WSL remapping per user request
        console.log(`[LLMClient] Endpoint: ${this.url}  Model: ${this.model}`);
    }

    // Extract the text content from any known API response shape:
    //   Ollama /api/generate  → data.response
    //   OpenAI chat          → data.choices[0].message.content
    //   OpenAI completions   → data.choices[0].text
    //   Raw string fallback  → JSON.stringify(data)
    static extractText(data) {
        if (typeof data.response === 'string' && data.response.length > 0) return data.response;
        if (Array.isArray(data.choices) && data.choices.length > 0) {
            const c = data.choices[0];
            if (c.message?.content) return c.message.content;
            if (typeof c.text === 'string') return c.text;
        }
        return JSON.stringify(data);
    }

    // Extract and parse the first valid JSON object/array from a free-form LLM response.
    // Handles direct JSON, fenced blocks, and mixed prose+JSON outputs.
    static extractFirstJson(rawText) {
        const text = String(rawText || '').trim();
        if (!text) return null;

        // Fast path: response is pure JSON.
        try {
            return JSON.parse(text);
        } catch (_) {}

        // Common pattern: JSON in a fenced code block.
        const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (fenceMatch && fenceMatch[1]) {
            try {
                return JSON.parse(fenceMatch[1].trim());
            } catch (_) {}
        }

        // General scan: find the first balanced {...} or [...] and parse candidates.
        const starts = [];
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (ch === '{' || ch === '[') starts.push(i);
        }

        const tryParseBalanced = (startIdx) => {
            const open = text[startIdx];
            const close = open === '{' ? '}' : ']';
            let depth = 0;
            let inString = false;
            let escaped = false;
            for (let i = startIdx; i < text.length; i++) {
                const ch = text[i];
                if (inString) {
                    if (escaped) {
                        escaped = false;
                    } else if (ch === '\\') {
                        escaped = true;
                    } else if (ch === '"') {
                        inString = false;
                    }
                    continue;
                }
                if (ch === '"') {
                    inString = true;
                    continue;
                }
                if (ch === open) depth++;
                if (ch === close) {
                    depth--;
                    if (depth === 0) {
                        const candidate = text.slice(startIdx, i + 1).trim();
                        try {
                            return JSON.parse(candidate);
                        } catch (_) {
                            return null;
                        }
                    }
                }
            }
            return null;
        };

        for (const idx of starts) {
            const parsed = tryParseBalanced(idx);
            if (parsed !== null) return parsed;
        }

        return null;
    }

    async generateAction(prompt) {
        try {
            const headers = { 'Content-Type': 'application/json' };
            // Strip BOM, control chars, and surrounding whitespace — invisible
            // characters can survive dotenv parsing and silently break auth.
            const apiKey = (process.env.OLLAMA_API_KEY || '')
                .replace(/[\u0000-\u001F\u007F-\u00A0\uFEFF]/g, '').trim();
            // OLLAMA_AUTH_SCHEME controls the Authorization header prefix.
            // Default: "Bearer".  Set to "" to send the raw key with no prefix.
            // Examples: Bearer, ApiKey, Token, ""
            const authScheme = Object.prototype.hasOwnProperty.call(process.env, 'OLLAMA_AUTH_SCHEME')
                ? process.env.OLLAMA_AUTH_SCHEME.trim()
                : 'Bearer';
            if (apiKey) {
                headers['Authorization'] = authScheme ? `${authScheme} ${apiKey}` : apiKey;
                console.log(`[LLMClient] Auth: ${authScheme || '<no prefix>'} ${apiKey.substring(0, 8)}...`);
            }

            let response;
            try {
                response = await fetch(this.url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        model: this.model,
                        prompt: prompt,
                        stream: false,
                        format: 'json'
                    })
                });
            } catch (netErr) {
                throw new Error(`Cannot reach LLM at ${this.url} — ${netErr.message}. Check OLLAMA_URL in .env.`);
            }

            if (!response.ok) {
                const body = await response.text().catch(() => '');
                if (response.status === 401) {
                    const hint = apiKey
                        ? `Sent: "${authScheme || '<no prefix>'} ${apiKey.substring(0, 8)}...". ` +
                          `If the scheme is wrong, set OLLAMA_AUTH_SCHEME in .env (e.g. ApiKey, Token, or "" for no prefix).`
                        : `No key found — set OLLAMA_API_KEY in .env.`;
                    throw new Error(`LLM HTTP 401 Unauthorized. ${hint}`);
                }
                throw new Error(`LLM HTTP ${response.status}: ${body.substring(0, 200)}`);
            }

            const data = await response.json();

            if (data.error) {
                console.error(`[LLMClient] API error: ${data.error}`);
                return null;
            }

            const rawText = LLMClient.extractText(data);
            console.log(`\n[LLMClient] --- LLM Response ---\n${rawText}\n[LLMClient] --- END ---\n`);

            const parsedResponse = LLMClient.extractFirstJson(rawText);
            if (parsedResponse === null) {
                throw new Error('Response contains no valid JSON object or array.');
            }
            return parsedResponse;

        } catch (err) {
            console.error("[LLMClient] Failed to generate action:", err.message);
            return null;
        }
    }
}

module.exports = LLMClient;