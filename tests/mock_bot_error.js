const assert = require('assert');
const mineflayer = require('mineflayer');
const { Movements } = require('mineflayer-pathfinder');
const DynamicRegistryInjector = require('../src/dynamic_registry_injector');
const mcData = require('minecraft-data')('1.20.1');

const registry = require('prismarine-registry')('1.20.1');
const injector = new DynamicRegistryInjector(registry);

const parsed = [
    { type: 'block', name: 'create:andesite_alloy', id: 30000 }
];

injector.injectBlockToRegistry(parsed);

const bot = { registry: registry, version: '1.20.1' };
try {
    const movements = new Movements(bot, mcData);
    console.log("Movements init successful. No crash!");
} catch(e) {
    console.log(e);
}
