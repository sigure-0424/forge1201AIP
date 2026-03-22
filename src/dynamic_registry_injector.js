// src/dynamic_registry_injector.js
const fs = require('fs');
const path = require('path');

class DynamicRegistryInjector {
    constructor(registry) {
        this.registry = registry;
        this.modBlocksDictionary = {};
        this.loadDictionary();
    }

    loadDictionary() {
        try {
            const dictPath = path.resolve(__dirname, '../data/sample/configs/mod_blocks_dictionary.json');
            if (fs.existsSync(dictPath)) {
                const data = fs.readFileSync(dictPath, 'utf8');
                this.modBlocksDictionary = JSON.parse(data);
                console.log(`[DynamicRegistry] Loaded ${Object.keys(this.modBlocksDictionary).length} modded block definitions.`);
            } else {
                console.warn(`[DynamicRegistry] mod_blocks_dictionary.json not found at ${dictPath}. Using fallbacks.`);
            }
        } catch (e) {
            console.error(`[DynamicRegistry] Failed to load mod_blocks_dictionary.json: ${e.message}`);
        }
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
        console.log(`[DynamicRegistry] Mod-Compatible Mode: Injecting Mod properties from Dictionary.`);
        let mappedCount = 0;
        let dummyCount = 0;

        // Retrieve the complete physical properties of already loaded "stone" as the ultimate safety template
        const stoneTemplate = this.registry.blocksByName['stone'];
        const airTemplate = this.registry.blocksByName['air'];

        // Forge 1.20.1 sends legacy block names that were removed in vanilla 1.13+.
        // Map them to their modern equivalents so they get vanilla properties instead
        // of being treated as unknown mod blocks (which default to stone template).
        // Without this, flowing_water becomes a solid block and the bot floats on water.
        const LEGACY_TO_MODERN = {
            'flowing_water': 'water',
            'flowing_lava': 'lava',
            'lit_furnace': 'furnace',
            'lit_redstone_lamp': 'redstone_lamp',
            'unlit_redstone_torch': 'redstone_torch',
            'standing_sign': 'oak_sign',
            'wall_sign': 'oak_wall_sign',
            'standing_banner': 'white_banner',
            'wall_banner': 'white_wall_banner',
            'double_stone_slab': 'stone_slab',
            'double_wooden_slab': 'oak_slab',
            'daylight_detector_inverted': 'daylight_detector',
            'unpowered_comparator': 'comparator',
            'powered_comparator': 'comparator',
            'unpowered_repeater': 'repeater',
            'powered_repeater': 'repeater',
            'piston_extension': 'piston_head',
        };

        for (const entry of parsedEntries) {
            const shortName = entry.name.replace(/^[^:]+:/, '');

            if (entry.type === 'block') {
                const modernName = LEGACY_TO_MODERN[shortName];
                const vanillaBlock = this.registry.blocksByName[modernName || shortName];

                if (vanillaBlock) {
                    // Re-mapping vanilla blocks: map ALL state variants so the Proxy binary-search
                    // fallback cannot resolve an intermediate state ID to the wrong (mod) block.
                    // Without this, beds (16 states), logs (4 states), etc. would appear as stone/air
                    // whenever a mod block was mapped to an ID between the base and its variants.
                    const numStates = (vanillaBlock.maxStateId !== undefined && vanillaBlock.minStateId !== undefined)
                        ? (vanillaBlock.maxStateId - vanillaBlock.minStateId + 1)
                        : 1;
                    for (let s = 0; s < numStates; s++) {
                        this.registry.blocks[entry.id + s] = vanillaBlock;
                        if (this.registry.blocksByStateId) {
                            this.registry.blocksByStateId[entry.id + s] = vanillaBlock;
                        }
                    }
                    mappedCount++;
                } else {
                    const dictEntry = this.modBlocksDictionary[entry.name];
                    const baseTemplate = dictEntry && dictEntry.boundingBox === 'empty' ? airTemplate : stoneTemplate;

                    // Modded blocks: Deep copy base properties and overwrite ID, names, and specific properties
                    const modBlock = {
                        ...baseTemplate,
                        id: entry.id,
                        name: entry.name,
                        displayName: shortName,
                        defaultState: entry.id,
                        minStateId: entry.id,
                        maxStateId: entry.id
                    };

                    if (dictEntry) {
                        if (dictEntry.hardness !== undefined) modBlock.hardness = dictEntry.hardness;
                        if (dictEntry.transparent !== undefined) modBlock.transparent = dictEntry.transparent;
                        if (dictEntry.boundingBox !== undefined) modBlock.boundingBox = dictEntry.boundingBox;
                    }

                    // Unknown mod blocks keep boundingBox='block' from the stone template.
                    // This ensures the pathfinder and physics engine AGREE: both see these
                    // blocks as solid.  The pathfinder will walk ON them (as ground) and
                    // around them (as walls at body height), while physics correctly
                    // collides with them.
                    //
                    // Setting boundingBox='empty' while keeping solid collision shapes
                    // BREAKS movement: the pathfinder plans paths through the block
                    // (safe=true), but the physics simulator blocks it (solid shapes).
                    // The bot then sets forward=false every tick and never moves.
                    //
                    // The tradeoff: mod blocks at body height ARE treated as diggable
                    // walls.  This adds cost to A* but produces correct, walkable paths.

                    this.registry.blocks[entry.id] = modBlock;
                    if (this.registry.blocksByStateId) {
                        this.registry.blocksByStateId[entry.id] = modBlock;
                    }

                    // [CRITICAL] Explicitly signal to the physics engine (prismarine-physics) that this is a solid full block
                    if (this.registry.blockCollisionShapes && this.registry.blockCollisionShapes.blocks) {
                        const isBlock = !dictEntry || dictEntry.boundingBox !== 'empty';
                        this.registry.blockCollisionShapes.blocks[entry.name] = isBlock ? 1 : 0; // 1 = Full cube collision shape, 0 = Air
                    }

                    dummyCount++;
                }
            } else if (entry.type === 'item') {
                const dummyItem = {
                    id: entry.id,
                    name: entry.name,
                    displayName: shortName,
                    stackSize: 64
                };
                if (!this.registry.items) this.registry.items = {};
                this.registry.items[entry.id] = dummyItem;
                if (!this.registry.itemsByName) this.registry.itemsByName = {};
                this.registry.itemsByName[entry.name] = dummyItem;
                this.registry.itemsByName[shortName] = dummyItem;
                dummyCount++;
            }
        }

        // Apply a JS Proxy on blocksByStateId to resolve unknown state IDs correctly based on base block ID
        if (this.registry.blocksByStateId) {
            // Precompute keys for faster lookup
            let sortedKeys = Object.keys(this.registry.blocksByStateId)
                                   .map(k => parseInt(k, 10))
                                   .filter(k => !isNaN(k))
                                   .sort((a, b) => a - b);

            const LIQUID_NAMES = new Set(['water', 'lava', 'flowing_water', 'flowing_lava']);
            this.registry.blocksByStateId = new Proxy(this.registry.blocksByStateId, {
                get(target, prop) {
                    if (prop in target) {
                        return Reflect.get(target, prop);
                    }

                    const stateId = parseInt(prop, 10);
                    if (isNaN(stateId)) {
                        return Reflect.get(target, prop);
                    }

                    // Fallback to finding the block that owns this state ID based on block IDs
                    let bestKey = undefined;
                    for (let i = 0; i < sortedKeys.length; i++) {
                        if (sortedKeys[i] <= stateId) {
                            bestKey = sortedKeys[i];
                        } else {
                            break;
                        }
                    }

                    if (bestKey !== undefined) {
                        const resolved = target[bestKey];
                        // CRITICAL: Never return a liquid block as a fallback for unknown
                        // Forge stateIds. Forge remaps stateIds at runtime; an unknown stone
                        // stateId can land just above the vanilla water stateId range (80-95),
                        // causing the binary search to return the water block object (registry
                        // id=32). prismarine-physics then sets isInWater=true on solid ground,
                        // disabling sprint and making the bot spin in place.
                        const safeFallback = (resolved && LIQUID_NAMES.has(resolved.name))
                            ? stoneTemplate
                            : resolved;
                        // Cache the result for future O(1) lookups
                        target[prop] = safeFallback;
                        return safeFallback;
                    }

                    return Reflect.get(target, prop); // fallback
                }
            });
            console.log(`[DynamicRegistry] State ID Proxy applied to blocksByStateId.`);
        }

        console.log(`[DynamicRegistry] Mapped ${mappedCount} vanilla blocks. Injected ${dummyCount} MOD blocks.`);
    }
}

module.exports = DynamicRegistryInjector;
