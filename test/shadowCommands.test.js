import { test } from 'node:test';
import assert from 'node:assert/strict';

import { writeDesiredState, desiredStateFor, WRITE_TIMEOUT_MS } from '../shadowCommands.mjs';
import { isStatefulTrigger } from '../handleDiscovery.mjs';

function directive(namespace, name, payload = {}) {
    return {
        header: { namespace, name, payloadVersion: '3', messageId: 'msg-1', correlationToken: 'corr-1' },
        endpoint: { endpointId: 'kitchen', scope: { type: 'BearerToken', token: 'test-token' } },
        payload
    };
}

// --- desiredStateFor: pure directive -> desired mapping -------------------------------------

test('desiredStateFor: PowerController TurnOn maps to {power: ON}', () => {
    assert.deepEqual(desiredStateFor(directive('Alexa.PowerController', 'TurnOn')), { power: 'ON' });
});

test('desiredStateFor: PowerController TurnOff maps to {power: OFF}', () => {
    assert.deepEqual(desiredStateFor(directive('Alexa.PowerController', 'TurnOff')), { power: 'OFF' });
});

test('desiredStateFor: BrightnessController SetBrightness maps to {brightness: N}', () => {
    const d = directive('Alexa.BrightnessController', 'SetBrightness', { brightness: 70 });
    assert.deepEqual(desiredStateFor(d), { brightness: 70 });
});

test('desiredStateFor: PercentageController SetPercentage maps to {position: N}', () => {
    const d = directive('Alexa.PercentageController', 'SetPercentage', { percentage: 42 });
    assert.deepEqual(desiredStateFor(d), { position: 42 });
});

test('desiredStateFor: BrightnessController AdjustBrightness (relative) maps to null', () => {
    const d = directive('Alexa.BrightnessController', 'AdjustBrightness', { brightnessDelta: 10 });
    assert.equal(desiredStateFor(d), null);
});

test('desiredStateFor: Speaker/Lock/ThermostatController/scene-shaped directives map to null', () => {
    assert.equal(desiredStateFor(directive('Alexa.Speaker', 'SetVolume', { volume: 50 })), null);
    assert.equal(desiredStateFor(directive('Alexa.LockController', 'Lock')), null);
    assert.equal(desiredStateFor(directive('Alexa.ThermostatController', 'SetThermostatMode', { thermostatMode: { value: 'COOL' } })), null);
});

test('desiredStateFor: malformed/missing directive does not throw', () => {
    assert.equal(desiredStateFor(null), null);
    assert.equal(desiredStateFor({}), null);
});

// --- writeDesiredState: flag gating, mapping to UpdateThingShadowCommand, error handling ----

test('writeDesiredState: SHADOW_COMMANDS flag off (deps.enabled=false) is a no-op -- updateShadow never called', async () => {
    let called = false;
    await writeDesiredState('kitchen', { power: 'ON' }, {
        enabled: false,
        updateShadow: async () => { called = true; }
    });
    assert.equal(called, false);
});

test('writeDesiredState: desired=null is a no-op even when enabled -- updateShadow never called', async () => {
    let called = false;
    await writeDesiredState('kitchen', null, {
        enabled: true,
        updateShadow: async () => { called = true; }
    });
    assert.equal(called, false);
});

test('writeDesiredState: enabled writes call updateShadow with (endpointId, desired)', async () => {
    const calls = [];
    await writeDesiredState('kitchen', { power: 'ON' }, {
        enabled: true,
        updateShadow: async (endpointId, desired) => { calls.push({ endpointId, desired }); }
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].endpointId, 'kitchen');
    assert.deepEqual(calls[0].desired, { power: 'ON' });
});

test('writeDesiredState: brightness and position payloads pass through unchanged', async () => {
    const calls = [];
    const updateShadow = async (endpointId, desired) => { calls.push(desired); };

    await writeDesiredState('kitchen', { brightness: 55 }, { enabled: true, updateShadow });
    await writeDesiredState('blackout-shade-one', { position: 30 }, { enabled: true, updateShadow });

    assert.deepEqual(calls[0], { brightness: 55 });
    assert.deepEqual(calls[1], { position: 30 });
});

test('writeDesiredState: updateShadow throwing is caught and logged, never rejects', async () => {
    const originalError = console.error;
    let loggedEndpoint;
    console.error = (...args) => { loggedEndpoint = args[1]; };
    try {
        await assert.doesNotReject(writeDesiredState('kitchen', { power: 'ON' }, {
            enabled: true,
            updateShadow: async () => { throw new Error('IoT boom'); }
        }));
    } finally {
        console.error = originalError;
    }
    assert.equal(loggedEndpoint, 'kitchen');
});

test('writeDesiredState: a hung updateShadow resolves via the timeout race within ~WRITE_TIMEOUT_MS and never rejects', async () => {
    const start = Date.now();
    await assert.doesNotReject(writeDesiredState('kitchen', { power: 'ON' }, {
        enabled: true,
        // Never resolves/rejects on its own -- only the race's timeout can settle this call.
        updateShadow: () => new Promise(() => {})
    }));
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= WRITE_TIMEOUT_MS, `expected to wait out the ${WRITE_TIMEOUT_MS}ms timeout, only waited ${elapsed}ms`);
    // Generous upper bound -- just confirms the race, not a hung real IoT call, is what settled it.
    assert.ok(elapsed < WRITE_TIMEOUT_MS + 1000, `timeout race took far longer than expected: ${elapsed}ms`);
});

test('writeDesiredState: default enabled resolution reads process.env.SHADOW_COMMANDS when deps.enabled is omitted', async () => {
    const original = process.env.SHADOW_COMMANDS;
    try {
        delete process.env.SHADOW_COMMANDS;
        let called = false;
        await writeDesiredState('kitchen', { power: 'ON' }, { updateShadow: async () => { called = true; } });
        assert.equal(called, false, 'unset SHADOW_COMMANDS must not write');

        process.env.SHADOW_COMMANDS = 'true'; // anything other than the literal '1' stays off
        called = false;
        await writeDesiredState('kitchen', { power: 'ON' }, { updateShadow: async () => { called = true; } });
        assert.equal(called, false, "SHADOW_COMMANDS='true' (not '1') must not write");

        process.env.SHADOW_COMMANDS = '1';
        called = false;
        await writeDesiredState('kitchen', { power: 'ON' }, { updateShadow: async () => { called = true; } });
        assert.equal(called, true, "SHADOW_COMMANDS='1' must write");
    } finally {
        if (original === undefined) {
            delete process.env.SHADOW_COMMANDS;
        } else {
            process.env.SHADOW_COMMANDS = original;
        }
    }
});

// --- handleDevices.mjs's gating conditional, exercised inline -------------------------------
//
// handleDevices.mjs isn't independently testable with injected triggers -- like every other
// handle* module (handleAC, handleLock, handleSpeaker), it imports triggersMap directly from
// index.mjs rather than taking it as a parameter, and index.mjs's triggersMap is populated
// once at module load from a real (gitignored, absent in this repo) triggers.json. Per the
// task's fallback guidance, the directive -> desired mapping is covered above as the pure
// desiredStateFor() function; this test instead reproduces handleDevices.mjs's exact gating
// line --
//     if (isStatefulTrigger(trigger)) { await writeDesiredState(applianceId, desiredStateFor(event.directive)); }
// -- verbatim, against real triggers.json-shaped fixtures, so the "non-stateful endpoint: no
// write" behavior is verified against the real isStatefulTrigger() rather than re-implemented.

const STATEFUL_LIGHT = { endpointId: 'kitchen', apiModule: 'LIGHTS', isDimmable: true, statefulMqtt: true };
const NON_STATEFUL_LIGHT = { endpointId: 'ceiling', apiModule: 'LIGHTS', isDimmable: true }; // no statefulMqtt flag

async function runHandleDevicesGate(trigger, directiveObj, updateShadow) {
    // Mirrors handlePowerOrLight's post-SQS-send gate in handleDevices.mjs.
    if (isStatefulTrigger(trigger)) {
        await writeDesiredState(trigger.endpointId, desiredStateFor(directiveObj), { enabled: true, updateShadow });
    }
}

test('handleDevices gate: non-stateful endpoint (no statefulMqtt flag) never calls writeDesiredState', async () => {
    let called = false;
    await runHandleDevicesGate(NON_STATEFUL_LIGHT, directive('Alexa.PowerController', 'TurnOn'), async () => { called = true; });
    assert.equal(called, false);
});

test('handleDevices gate: stateful endpoint with an absolute-value directive calls writeDesiredState', async () => {
    let called = false;
    await runHandleDevicesGate(STATEFUL_LIGHT, directive('Alexa.PowerController', 'TurnOn'), async () => { called = true; });
    assert.equal(called, true);
});

test('handleDevices gate: stateful endpoint with AdjustBrightness (no absolute value) does not call updateShadow', async () => {
    let called = false;
    const d = directive('Alexa.BrightnessController', 'AdjustBrightness', { brightnessDelta: 10 });
    await runHandleDevicesGate(STATEFUL_LIGHT, d, async () => { called = true; });
    assert.equal(called, false);
});
