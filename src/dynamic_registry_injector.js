// dynamic_registry_injector.js

class DynamicRegistryInjector {
    constructor(registry) {
        this.registry = registry;
    }

    readVarInt(buffer, offset) {
        let numRead = 0;
        let result = 0;
        let read;
        do {
            if (offset + numRead >= buffer.length) throw new Error('Buffer overflow');
            read = buffer.readUInt8(offset + numRead);
            let value = (read & 0b01111111);
            result |= (value << (7 * numRead));
            numRead++;
        } while ((read & 0b10000000) != 0);
        return { value: result, bytesRead: numRead };
    }

    parseRegistryPayload(payloadBuffers) {
        console.log(`[DynamicRegistry] Parsing ${payloadBuffers.length} registry payload buffers...`);
        const parsedEntries = [];
        
        for (const buf of payloadBuffers) {
            try {
                const str = buf.toString('utf8');
                // Simple regex to find ResourceLocations
                const matches = str.match(/[a-z0-9_.-]+:[a-z0-9_.-]+/g);
                
                if (matches) {
                    for (const match of matches) {
                        const matchIndex = buf.indexOf(Buffer.from(match, 'utf8'));
                        if (matchIndex === -1) continue;
                        
                        let offset = matchIndex + Buffer.from(match, 'utf8').length;
                        
                        try {
                            const { value: entryId, bytesRead } = this.readVarInt(buf, offset);
                            const type = match.includes('block') || match.includes('ore') ? 'block' : 'item';
                            
                            if (!parsedEntries.find(e => e.name === match)) {
                                parsedEntries.push({ id: entryId, name: match, type });
                            }
                        } catch (e) {
                            // ID reading failed, likely not a registry entry entry point
                        }
                    }
                }
            } catch (e) {
                console.warn(`[DynamicRegistry] Failed to parse a registry buffer: ${e.message}`);
            }
        }
        
        console.log(`[DynamicRegistry] Discovered ${parsedEntries.length} entries via heuristic.`);
        return parsedEntries;
    }

    injectBlockToRegistry(parsedEntries) {
        console.log(`[DynamicRegistry] Injecting ${parsedEntries.length} entries into bot registry.`);

        for (const entry of parsedEntries) {
            if (entry.type === 'block') {
                if (this.registry.blocksByName[entry.name]) continue;

                this.registry.blocks[entry.id] = {
                    id: entry.id,
                    name: entry.name,
                    displayName: entry.name,
                    hardness: 1.0,
                    diggable: true,
                    boundingBox: 'block',
                    material: 'rock',
                    harvestTools: {},
                    states: []
                };
                this.registry.blocksByName[entry.name] = this.registry.blocks[entry.id];
            } else if (entry.type === 'item') {
                if (this.registry.itemsByName[entry.name]) continue;

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
