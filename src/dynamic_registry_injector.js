// src/dynamic_registry_injector.js
class DynamicRegistryInjector {
    constructor(registry) {
        this.registry = registry;
    }

    readVarInt(buffer, offset) {
        let numRead = 0, result = 0, read;
        do {
            if (offset + numRead >= buffer.length) throw new Error('Buffer overflow');
            read = buffer.readUInt8(offset + numRead);
            result |= ((read & 0x7F) << (7 * numRead++));
        } while ((read & 0x80) !== 0);
        return { value: result, bytesRead: numRead };
    }

    parseRegistryPayload(payloadBuffers) {
        console.log(`[DynamicRegistry] Scanning ${payloadBuffers.length} buffers...`);
        const parsedEntries = [];
        for (const buf of payloadBuffers) {
            let offset = 0;
            while (offset < buf.length) {
                const colonIndex = buf.indexOf(0x3A, offset); // ':'
                if (colonIndex === -1) break;
                let start = colonIndex - 1;
                while (start >= 0 && /[a-z0-9_.-]/.test(String.fromCharCode(buf[start]))) start--;
                start++;
                let end = colonIndex + 1;
                while (end < buf.length && /[a-z0-9_/.-]/.test(String.fromCharCode(buf[end]))) end++;
                
                const name = buf.toString('utf8', start, end);
                if (name.includes(':')) {
                    let entryId = undefined;
                    try {
                        const { value } = this.readVarInt(buf, end);
                        if (value >= 0 && value < 32767) entryId = value;
                    } catch (e) {}
                    
                    if (entryId !== undefined) {
                        // Simple block/item discrimination
                        const lower = name.toLowerCase();
                        const isBlock = lower.includes('block') || lower.includes('stone') || lower.includes('ore') || 
                                        lower.includes('dirt') || lower.includes('grass') || lower.includes('planks') ||
                                        lower.includes('log') || lower.includes('plate') || lower.includes('base') ||
                                        lower.includes('air') || lower.includes('water') || lower.includes('lava');
                        parsedEntries.push({ id: entryId, name, type: isBlock ? 'block' : 'item' });
                    }
                }
                offset = end;
            }
        }
        return parsedEntries;
    }

    injectBlockToRegistry(parsedEntries) {
        console.log(`[DynamicRegistry] Mod-Compatible Mode: Mapping vanilla blocks and injecting dummy mod blocks.`);
        let mappedCount = 0;
        let dummyCount = 0;

        for (const entry of parsedEntries) {
            // Remove the namespace (e.g., minecraft:) to get the pure block/item name
            const shortName = entry.name.replace(/^[^:]+:/, '');

            if (entry.type === 'block') {
                // Retrieve the vanilla block definition already held by Mineflayer
                const vanillaBlock = this.registry.blocksByName[shortName];

                if (vanillaBlock) {
                    // Do not touch the array (blocksArray); only rewire the reference from the ID to the vanilla definition
                    // This corrects Forge-specific ID shifts while preventing Pathfinder crashes
                    this.registry.blocks[entry.id] = vanillaBlock;
                    if (this.registry.blocksByStateId) {
                        this.registry.blocksByStateId[entry.id] = vanillaBlock;
                    }
                    mappedCount++;
                } else {
                    // Mod block - inject dummy block definition
                    const dummyBlock = {
                        id: entry.id,
                        name: entry.name,
                        displayName: shortName,
                        hardness: 1.0,
                        resistance: 1.0,
                        diggable: true,
                        boundingBox: "block",
                        transparent: false,
                        emitLight: 0,
                        filterLight: 0,
                        defaultState: entry.id,
                        minStateId: entry.id,
                        maxStateId: entry.id,
                        states: [],
                        drops: [],
                        material: "rock",
                        harvestTools: {},
                        shapes: [ [0, 0, 0, 1, 1, 1] ]
                    };

                    this.registry.blocks[entry.id] = dummyBlock;

                    if (this.registry.blocksByStateId) {
                        this.registry.blocksByStateId[entry.id] = dummyBlock;
                    }

                    if (this.registry.blocksArray) {
                        this.registry.blocksArray.push(dummyBlock);
                    }

                    // Prismarine-block will dynamically overwrite shapes on initialization based on blockCollisionShapes.
                    // If we don't add the mod block name to blockCollisionShapes, it gets overwritten with undefined.
                    if (this.registry.blockCollisionShapes && this.registry.blockCollisionShapes.blocks) {
                        // Inherit stone's collision shape mapping to ensure a solid full block
                        this.registry.blockCollisionShapes.blocks[dummyBlock.name] = this.registry.blockCollisionShapes.blocks['stone'];
                    }

                    dummyCount++;
                }
            } else if (entry.type === 'item') {
                // Inject dummy item definitions for tests and possible inventory compatibility
                const dummyItem = {
                    id: entry.id,
                    name: entry.name,
                    displayName: shortName,
                    stackSize: 64
                };
                if (!this.registry.items) this.registry.items = {};
                this.registry.items[entry.id] = dummyItem;
                dummyCount++;
            }
        }
        console.log(`[DynamicRegistry] Mapped ${mappedCount} vanilla blocks. Injected ${dummyCount} dummy MOD blocks.`);
    }
}

module.exports = DynamicRegistryInjector;
