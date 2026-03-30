const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { config, patch, savePreset, listPresets } = require('../src/runtime_config');

const PRESETS_FILE = path.join(process.cwd(), 'data', 'system_presets.json');
let presetsBackup = null;

function backupPresets() {
    if (fs.existsSync(PRESETS_FILE)) {
        presetsBackup = fs.readFileSync(PRESETS_FILE, 'utf8');
    }
}

function restorePresets() {
    if (presetsBackup !== null) {
        fs.writeFileSync(PRESETS_FILE, presetsBackup);
    } else if (fs.existsSync(PRESETS_FILE)) {
        fs.unlinkSync(PRESETS_FILE);
    }
}

function testPatchValidObject() {
    console.log('--- Testing patch with valid object ---');
    const originalMeleeRange = config.MELEE_RANGE;
    const newMeleeRange = originalMeleeRange + 1;

    const result = patch({ MELEE_RANGE: newMeleeRange });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(config.MELEE_RANGE, newMeleeRange);
    assert.strictEqual(result.applied.MELEE_RANGE, newMeleeRange);
    console.log('[OK] patch with valid object verified.');
}

function testPatchValidPreset() {
    console.log('--- Testing patch with valid preset name ---');
    const presets = listPresets();
    if (presets.length === 0) {
        console.log('[SKIP] No presets found in data/system_presets.json');
        return;
    }

    const presetName = presets[0];
    const result = patch(presetName);

    assert.strictEqual(result.ok, true);
    assert.ok(Object.keys(result.applied).length > 0);
    console.log(`[OK] patch with valid preset "${presetName}" verified.`);
}

function testPatchInvalidPreset() {
    console.log('--- Testing patch with invalid preset name ---');
    const invalidPresetName = 'non_existent_preset_12345';
    const result = patch(invalidPresetName);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.message, `Preset "${invalidPresetName}" not found.`);
    assert.deepStrictEqual(result.applied, {});
    console.log('[OK] patch with invalid preset verified.');
}

function testSaveAndApplyPreset() {
    console.log('--- Testing savePreset and then patch ---');
    const presetName = 'test_new_preset_temporary';
    const presetData = { MELEE_RANGE: 12.0, RETREAT_HEALTH_PCT: 0.6 };

    savePreset(presetName, presetData);

    const presets = listPresets();
    assert.ok(presets.includes(presetName));

    const result = patch(presetName);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(config.MELEE_RANGE, 12.0);
    assert.strictEqual(config.RETREAT_HEALTH_PCT, 0.6);
    console.log('[OK] savePreset and patch verified.');
}

function testListPresets() {
    console.log('--- Testing listPresets ---');
    const presets = listPresets();
    assert.ok(Array.isArray(presets));
    console.log('[OK] listPresets verified.');
}

function runTests() {
    backupPresets();
    try {
        testPatchValidObject();
        testPatchValidPreset();
        testPatchInvalidPreset();
        testSaveAndApplyPreset();
        testListPresets();
        console.log('--- All Runtime Config Tests Passed ---');
    } catch (err) {
        console.error('[Test Failed]', err);
        process.exit(1);
    } finally {
        restorePresets();
        console.log('--- Restored data/system_presets.json ---');
    }
}

runTests();
