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
            return JSON.parse(data.response);
        } catch (err) {
            console.error("[LLMClient] Failed to generate action:", err.message);
            return { action: "chat", message: "Failed to connect to the inference engine." };
        }
    }
}

module.exports = LLMClient;
