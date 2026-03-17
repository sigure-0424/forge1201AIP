// config_rag_parser.js
const fs = require('fs');
const toml = require('smol-toml');

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
                const parsed = toml.parse(content);
                this.extractConstraints(file, parsed);
            } catch (err) {
                console.error(`[ConfigRAG] Failed to parse ${file}: ${err.message}`);
            }
        }
    }

    extractConstraints(filename, parsed) {
        if (filename.includes('create')) {
            this.constraints.createMod = {
                maxStress: parsed.stress?.maxStress || 2048,
                baseSpeed: parsed.general?.baseSpeed || 16
            };
        }
        
        if (filename.includes('veinminer')) {
            this.constraints.veinMiner = {
                maxBlocks: parsed.general?.maxBlocks || 64,
                cooldownTicks: parsed.general?.cooldown || 20
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
