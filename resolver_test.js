const mcData = require('minecraft-data')('1.20.1');
const { resolveRequiredMaterials } = require('./src/material_resolver');

console.log(resolveRequiredMaterials(mcData, 'iron_pickaxe', 1, { stick: 2 }));
console.log(resolveRequiredMaterials(mcData, 'dispenser', 1, { bow: 1 }));
console.log(resolveRequiredMaterials(mcData, 'iron_ingot', 1));
