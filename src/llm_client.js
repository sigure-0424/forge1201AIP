// src/llm_client.js
class LLMClient {
    constructor(model = 'llama3', url = 'http://localhost:11434/api/generate') {
        this.model = model;
        this.url = url;
    }

    async generateAction(prompt) {
        try {
            const response = await fetch(this.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.model,
                    prompt: prompt,
                    stream: false,
                    format: 'json'
                })
            });
            
            const data = await response.json();

            if (data.error) {
                console.error(`[LLMClient] Ollama API Error: ${data.error}`);
                return { action: "chat", message: `Ollama API Error: ${data.error}` };
            }

            let rawText = data.response || "";
            // debug :wat response
            console.log(`\n[LLMClient] --- LLM Response --- \n${rawText}\n[LLMClient] --- LLM Response END ---\n`);

            // important: extract the JSON object or array from the response, which may contain additional text
            const match = rawText.match(/(\{|\[)[\s\S]*(\}|\])/);
            
            if (match) {
                return JSON.parse(match[0]);
            } else {
                throw new Error("Response does not contain a valid JSON object or array.");
            }

        } catch (err) {
            console.error("[LLMClient] Failed to generate action:", err.message);
            return { action: "chat", message: "Failed to interpret AI reasoning results." };
        }
    }
}

module.exports = LLMClient;