// tests/smoke.js
console.log('--- Smoke Test Starting ---');

try {
    const ForgeHandshakeStateMachine = require('../src/forge_handshake_state_machine');
    const DynamicRegistryInjector = require('../src/dynamic_registry_injector');
    const EventDebouncer = require('../src/event_debouncer');
    const InventoryNBTPatch = require('../src/inventory_nbt_patch');
    const CreateContraptionHazard = require('../src/create_contraption_hazard');
    const ConfigRAGParser = require('../src/config_rag_parser');
    const AgentManager = require('../src/agent_manager');
    const mcData = require('minecraft-data');

    console.log('[OK] All modules and minecraft-data required successfully.');

    const am = new AgentManager();
    console.log('[OK] AgentManager instantiated.');

    console.log('--- Smoke Test Passed ---');
    process.exit(0);
} catch (error) {
    console.error('--- Smoke Test Failed ---');
    console.error(error);
    process.exit(1);
}
