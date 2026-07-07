import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleDiscovery, isStatefulTrigger, reportsPower } from '../handleDiscovery.mjs';

// Fixture triggers list, shaped like real config/triggers.json entries: one dimmable
// light (with location/mqttName, per the task), one lighting scene, one macro, and one
// shades device.
const LIGHT = {
    endpointId: 'kitchen',
    friendlyName: 'Kitchen',
    displayCategories: ['LIGHT'],
    apiModule: 'LIGHTS',
    apiDevice: 'kitchen',
    isDimmable: true,
    location: 'home',
    mqttName: 'kitchen',
    statefulMqtt: true
};

// A LIGHTS trigger apollo-home-control did NOT stamp statefulMqtt on -- e.g. a DMX light,
// whose ecosystem doesn't publish MQTT state yet (see mqttTopics.js's ALEXA_STATEFUL_TYPES
// on the Apollo side). Shaped just like LIGHT except for the missing flag, to isolate what
// the flag alone controls.
const UNSTATEFUL_LIGHT = {
    endpointId: 'ceiling',
    friendlyName: 'Ceiling',
    displayCategories: ['LIGHT'],
    apiModule: 'LIGHTS',
    apiDevice: 'ceiling',
    isDimmable: true,
    location: 'home',
    mqttName: 'ceiling'
};

const SCENE = {
    endpointId: 'allLights',
    friendlyName: 'All Lights',
    displayCategories: ['SCENE_TRIGGER'],
    apiModule: 'LIGHTINGSCENES',
    apiDevice: 'allLights',
    isDimmable: false,
    location: 'home',
    mqttName: 'allLights'
};

const MACRO = {
    endpointId: 'bedtimeMacro',
    friendlyName: 'Bed Time',
    displayCategories: ['ACTIVITY_TRIGGER'],
    apiModule: 'MACROS',
    apiDevice: 'bedtimeMacro',
    location: 'home',
    mqttName: 'bedtimeMacro'
};

const SHADES = {
    endpointId: 'shades',
    friendlyName: 'Blackout Shades',
    displayCategories: ['EXTERIOR_BLIND'],
    apiModule: 'DEVICES',
    apiDevice: 'shades',
    apiCommand: false,
    isLock: false,
    isAC: false,
    isSpeaker: false,
    isPercentageController: true,
    location: 'home',
    mqttName: 'shades',
    statefulMqtt: true
};

const FIXTURE_TRIGGERS = [LIGHT, SCENE, MACRO, SHADES, UNSTATEFUL_LIGHT];

function endpointFor(response, endpointId) {
    return response.event.payload.endpoints.find((e) => e.endpointId === endpointId);
}

function capabilityFor(endpoint, iface) {
    return endpoint.capabilities.find((c) => c.interface === iface);
}

test('isStatefulTrigger: trusts the statefulMqtt flag exactly -- true only when it is === true', () => {
    assert.equal(isStatefulTrigger(LIGHT), true);
    assert.equal(isStatefulTrigger(SHADES), true);
    assert.equal(isStatefulTrigger(SCENE), false);
    assert.equal(isStatefulTrigger(MACRO), false);
    // A LIGHTS trigger without the flag (e.g. a DMX light -- Apollo doesn't stamp
    // statefulMqtt on ecosystems that don't publish MQTT state) must NOT be treated as
    // stateful just because apiModule === 'LIGHTS'.
    assert.equal(isStatefulTrigger(UNSTATEFUL_LIGHT), false);
    assert.equal(isStatefulTrigger(undefined), false);
    assert.equal(isStatefulTrigger(null), false);
    assert.equal(isStatefulTrigger({ statefulMqtt: 'true' }), false, 'must be === true, not truthy');
});

test('reportsPower: only LIGHTS entries report a power field', () => {
    assert.equal(reportsPower(LIGHT), true);
    assert.equal(reportsPower(SHADES), false);
    assert.equal(reportsPower(SCENE), false);
});

test('dimmable light: PowerController + BrightnessController retrievable, EndpointHealth present', () => {
    const response = handleDiscovery(null, {}, FIXTURE_TRIGGERS);
    const endpoint = endpointFor(response, 'kitchen');

    const power = capabilityFor(endpoint, 'Alexa.PowerController');
    assert.equal(power.properties.retrievable, true);
    // proactivelyReported stays false until the ChangeReport leg ships
    // (CHANGE_REPORTS_ENABLED in handleDiscovery.mjs) -- claiming it early
    // makes Alexa poll ReportState LESS and show staler state.
    assert.equal(power.properties.proactivelyReported, false);

    const brightness = capabilityFor(endpoint, 'Alexa.BrightnessController');
    assert.equal(brightness.properties.retrievable, true);
    assert.equal(brightness.properties.proactivelyReported, false);

    const health = capabilityFor(endpoint, 'Alexa.EndpointHealth');
    assert.ok(health, 'expected Alexa.EndpointHealth interface to be present');
    assert.equal(health.properties.retrievable, true);
});

test('scene: PowerController stays non-retrievable, no EndpointHealth interface added', () => {
    const response = handleDiscovery(null, {}, FIXTURE_TRIGGERS);
    const endpoint = endpointFor(response, 'allLights');

    const power = capabilityFor(endpoint, 'Alexa.PowerController');
    assert.equal(power.properties.retrievable, false);
    assert.equal(power.properties.proactivelyReported, false);

    const health = capabilityFor(endpoint, 'Alexa.EndpointHealth');
    assert.equal(health, undefined);
});

test('macro: PowerController stays non-retrievable, no EndpointHealth interface added', () => {
    const response = handleDiscovery(null, {}, FIXTURE_TRIGGERS);
    const endpoint = endpointFor(response, 'bedtimeMacro');

    const power = capabilityFor(endpoint, 'Alexa.PowerController');
    assert.equal(power.properties.retrievable, false);
    assert.equal(power.properties.proactivelyReported, false);

    const health = capabilityFor(endpoint, 'Alexa.EndpointHealth');
    assert.equal(health, undefined);
});

test('shades: PercentageController retrievable + EndpointHealth present, but PowerController stays non-retrievable', () => {
    const response = handleDiscovery(null, {}, FIXTURE_TRIGGERS);
    const endpoint = endpointFor(response, 'shades');

    const percentage = capabilityFor(endpoint, 'Alexa.PercentageController');
    assert.equal(percentage.properties.retrievable, true);
    // false until CHANGE_REPORTS_ENABLED flips (see comment on the kitchen test above)
    assert.equal(percentage.properties.proactivelyReported, false);

    // Apollo's shades driver never publishes a `power` field (src/somfyBridge.js), so
    // PowerController is intentionally NOT marked retrievable here even though the shades
    // endpoint is otherwise "stateful" -- see reportsPower() in handleDiscovery.mjs.
    const power = capabilityFor(endpoint, 'Alexa.PowerController');
    assert.equal(power.properties.retrievable, false);
    assert.equal(power.properties.proactivelyReported, false);

    const health = capabilityFor(endpoint, 'Alexa.EndpointHealth');
    assert.ok(health, 'expected Alexa.EndpointHealth interface to be present');
});

test('LIGHTS trigger WITHOUT statefulMqtt (e.g. a DMX light) gets no retrievable properties and no EndpointHealth', () => {
    const response = handleDiscovery(null, {}, FIXTURE_TRIGGERS);
    const endpoint = endpointFor(response, 'ceiling');

    const power = capabilityFor(endpoint, 'Alexa.PowerController');
    assert.equal(power.properties.retrievable, false);
    assert.equal(power.properties.proactivelyReported, false);

    const brightness = capabilityFor(endpoint, 'Alexa.BrightnessController');
    assert.equal(brightness.properties.retrievable, false);
    assert.equal(brightness.properties.proactivelyReported, false);

    const health = capabilityFor(endpoint, 'Alexa.EndpointHealth');
    assert.equal(health, undefined, 'EndpointHealth should only be added for stateful endpoints');
});

test('discovery response shape is otherwise unchanged (header/payload envelope)', () => {
    const response = handleDiscovery(null, {}, FIXTURE_TRIGGERS);
    assert.equal(response.event.header.namespace, 'Alexa.Discovery');
    assert.equal(response.event.header.name, 'Discover.Response');
    assert.equal(response.event.header.payloadVersion, '3');
    assert.equal(response.event.payload.endpoints.length, FIXTURE_TRIGGERS.length);
});
