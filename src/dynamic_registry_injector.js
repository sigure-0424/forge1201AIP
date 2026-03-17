// dynamic_registry_injector.js

class DynamicRegistryInjector {
    constructor(registry) {
        this.registry = registry;
    }

    parseRegistryPayload(payloadBuffers) {
        console.log(`[DynamicRegistry] Parsing ${payloadBuffers.length} registry payload buffers...`);
        const parsedEntries = [];
        
        // FML3 Registry packets often contain NBT snapshots.
        // For now, we perform a heuristic scan for strings like "modid:item_name"
        for (const buf of payloadBuffers) {
            const str = buf.toString('utf8');
            const matches = str.match(/[a-z0-9_.-]+:[a-z0-9_.-]+/g);
            if (matches) {
                for (const match of matches) {
                    if (match.includes(':')) {
                        // Avoid duplicates
                        if (!parsedEntries.find(e => e.name === match)) {
                            // Assign a high ID range for modded items to avoid Vanilla collisions
                            const id = 10000 + parsedEntries.length;
                            const type = match.includes('block') || match.includes('ore') ? 'block' : 'item';
                            parsedEntries.push({ id, name: match, type });
                        }
                    }
                }
            }
        }
        
        console.log(`[DynamicRegistry] Heuristically discovered ${parsedEntries.length} modded entries.`);
        return parsedEntries;
    }

    injectBlockToRegistry(parsedEntries) {
        console.log(`[DynamicRegistry] Injecting ${parsedEntries.length} entries into bot registry.`);

        for (const entry of parsedEntries) {
            if (entry.type === 'block') {
                // Heuristic for bounding box
                let boundingBox = 'block';
                if (entry.name.includes('slab') || entry.name.includes('panel') || entry.name.includes('plate')) {
                    boundingBox = 'empty'; // Slabs are often pathable
                }

                this.registry.blocks[entry.id] = {
                    id: entry.id,
                    name: entry.name,
                    displayName: entry.name,
                    hardness: 1.0,
                    diggable: true,
                    boundingBox: boundingBox,
                    material: 'rock',
                    harvestTools: {}
                };
                this.registry.blocksByName[entry.name] = this.registry.blocks[entry.id];
            } else if (entry.type === 'item') {
                this.registry.items[entry.id] = {
                    id: entry.id,
                    name: entry.name,
                    displayName: entry.name,
                    stackSize: 64
                };
                this.registry.itemsByName[entry.name] = this.registry.items[entry.id];
            }
        }
        console.log('[DynamicRegistry] Injection complete.');
    }
}

module.exports = DynamicRegistryInjector;
