// config_rag_parser.js
const fs = require('fs');
const tomlParser = require('@toml-tools/parser');

class ConfigRAGParser {
    constructor(configDir) {
        this.configDir = configDir;
        this.constraints = {};
    }

    parseServerConfigs() {
        if (!fs.existsSync(this.configDir)) {
            console.warn(`[ConfigRAG] Config directory not found: ${this.configDir}`);
            return;
        }

        const files = fs.readdirSync(this.configDir).filter(f => f.endsWith('.toml'));
        
        for (const file of files) {
            const filePath = `${this.configDir}/${file}`;
            console.log(`[ConfigRAG] Parsing ${file}...`);
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const parsed = tomlParser.parse(content);
                this.extractConstraints(file, parsed);
            } catch (err) {
                console.error(`[ConfigRAG] Failed to parse ${file}: ${err.message}`);
            }
        }
    }

    extractConstraints(filename, parsedAst) {
        // Dummy logic to simulate extraction of limits (e.g., machine stress limits, cooldowns)
        // This injects physical constraints into the LLM system prompt.
        
        if (filename.includes('create')) {
            this.constraints.createMod = {
                maxStress: 2048, // Mocked
                baseSpeed: 16
            };
        }
        
        if (filename.includes('veinminer')) {
            this.constraints.veinMiner = {
                maxBlocks: 64, // Mocked
                cooldownTicks: 20
            };
        }
    }

    generateLLMPromptContext() {
        let context = "=== SERVER CONSTRAINTS ===\n";
        
        if (this.constraints.createMod) {
            context += `- Create Mod: Max Stress = ${this.constraints.createMod.maxStress}, Base Speed = ${this.constraints.createMod.baseSpeed}\n`;
        }
        
        if (this.constraints.veinMiner) {
            context += `- VeinMiner: Max Blocks per vein = ${this.constraints.veinMiner.maxBlocks}, Cooldown = ${this.constraints.veinMiner.cooldownTicks} ticks\n`;
        }

        return context;
    }
}

module.exports = ConfigRAGParser;
