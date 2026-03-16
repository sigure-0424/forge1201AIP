// inventory_nbt_patch.js

class InventoryNBTPatch {
    constructor(bot) {
        this.bot = bot;
    }

    applyPatches() {
        this.patchGlobalStackSize();
        this.interceptNBT();
    }

    patchGlobalStackSize() {
        // Sets stackSize for all items to the Java 32-bit integer maximum (2147483647) 
        // to bypass internal 64-limit checks.
        console.log('[InventoryPatch] Applying global stack size override (Max 32-bit Integer).');
        const MAX_INT = 2147483647;

        for (const itemKey in this.bot.registry.items) {
            if (this.bot.registry.items.hasOwnProperty(itemKey)) {
                this.bot.registry.items[itemKey].stackSize = MAX_INT;
            }
        }
    }

    interceptNBT() {
        // Extracts the "true total" count from mod-specific NBT metadata to provide accurate context
        this.bot.inventory.on('windowUpdate', (slot, oldItem, newItem) => {
            if (newItem && newItem.nbt) {
                const trueCount = this.extractTrueCountFromNBT(newItem.nbt);
                if (trueCount !== null) {
                    newItem.count = trueCount;
                    console.log(`[InventoryPatch] Extracted true count for ${newItem.name}: ${trueCount}`);
                }
            }
        });
    }

    extractTrueCountFromNBT(nbt) {
        // Mock NBT extraction. In real usage, use prismarine-nbt methods.
        // E.g., looking for a specific Mod tag like 'StorageCount'
        if (nbt && nbt.value && nbt.value.StorageCount) {
            return nbt.value.StorageCount.value;
        }
        return null;
    }
}

module.exports = InventoryNBTPatch;
