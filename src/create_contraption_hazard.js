// create_contraption_hazard.js

class CreateContraptionHazard {
    constructor(pathfinder) {
        this.pathfinder = pathfinder;
        this.contraptions = [];
    }

    updateContraptions(newContraptions) {
        this.contraptions = newContraptions;
    }

    applyHeuristicOverride() {
        console.log('[ContraptionHazard] Patching pathfinder movements for dynamic hazard avoidance.');
        
        const movements = this.pathfinder.movements;
        if (!movements) return;

        const originalGetBlockInfo = movements.getBlockInfo;
        const self = this;

        movements.getBlockInfo = function(block) {
            const info = originalGetBlockInfo.call(this, block);
            
            // Check if this block is within any contraption's bounding box
            if (block && self.isInHazardZone(block.position.x, block.position.y, block.position.z)) {
                info.safe = false;
                info.physical = false; // Treat as non-walkable
                info.height = 0;
            }
            
            // Check if this block is a modded gravestone
            if (block && block.name === 'gravestones:modded_gravestone') {
                info.safe = true; // Gravestones are interactable
                info.physical = true; // Treat as walkable
                info.height = 1; // Default block height
            }
            
            return info;
        };
    }

    isInHazardZone(x, y, z) {
        for (const contraption of this.contraptions) {
            if (x >= contraption.minX && x <= contraption.maxX &&
                y >= contraption.minY && y <= contraption.maxY &&
                z >= contraption.minZ && z <= contraption.maxZ) {
                return true;
            }
        }
        return false;
    }
}

module.exports = CreateContraptionHazard;
