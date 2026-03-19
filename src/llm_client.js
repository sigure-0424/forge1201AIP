// src/llm_client.js
require('dotenv').config();

class LLMClient {
    constructor(model = process.env.OLLAMA_MODEL || 'gpt-oss:20b-cloud', url = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate') {
        this.model = model;
        this.url = url;
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

    async generateAction(prompt) {
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (process.env.OLLAMA_API_KEY) {
                headers['Authorization'] = `Bearer ${process.env.OLLAMA_API_KEY}`;
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
                throw new Error(`LLM HTTP ${response.status}: ${body.substring(0, 200)}`);
            }

            const data = await response.json();

            if (data.error) {
                console.error(`[LLMClient] API error: ${data.error}`);
                return null;
            }

            const rawText = LLMClient.extractText(data);
            console.log(`\n[LLMClient] --- LLM Response ---\n${rawText}\n[LLMClient] --- END ---\n`);

            // Extract the first JSON object or array from the response text
            const match = rawText.match(/(\{|\[)[\s\S]*(\}|\])/);
            if (match) {
                return JSON.parse(match[0]);
            } else {
                throw new Error("Response contains no JSON object or array.");
            }

        } catch (err) {
            console.error("[LLMClient] Failed to generate action:", err.message);
            return null;
        }
    }
}

module.exports = LLMClient;