import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleReportState } from '../handleReportState.mjs';

// Fixture triggers, shaped like real config/triggers.json entries (see
// apollo-home-control/src/alexaTriggers.js for how these are generated).
const DIMMABLE_LIGHT = {
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

const NON_DIMMABLE_LIGHT = {
    endpointId: 'hall',
    friendlyName: 'Hall',
    displayCategories: ['LIGHT'],
    apiModule: 'LIGHTS',
    apiDevice: 'hall',
    isDimmable: false,
    location: 'home',
    mqttName: 'hall',
    statefulMqtt: true
};

const SHADES = {
    endpointId: 'blackout-shade-one',
    friendlyName: 'Blackout Shade One',
    displayCategories: ['EXTERIOR_BLIND'],
    apiModule: 'DEVICES',
    apiDevice: 'shades',
    isPercentageController: true,
    location: 'home',
    mqttName: 'shades',
    statefulMqtt: true
};

// A LIGHTS trigger apollo-home-control did NOT stamp statefulMqtt on (e.g. a DMX light --
// see handleDiscovery.mjs's isStatefulTrigger() doc comment). ReportState must refuse to
// read a shadow for it.
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
    endpointId: 'all_lights',
    friendlyName: 'All Lights',
    displayCategories: ['SCENE_TRIGGER'],
    apiModule: 'LIGHTINGSCENES',
    apiDevice: 'allLights',
    location: 'home',
    mqttName: 'allLights'
};

function triggersMapWith(...triggers) {
    return new Map(triggers.map((t) => [t.endpointId, t]));
}

function reportStateDirective(endpointId) {
    return {
        directive: {
            header: {
                namespace: 'Alexa',
                name: 'ReportState',
                payloadVersion: '3',
                messageId: 'msg-1',
                correlationToken: 'corr-1'
            },
            endpoint: {
                scope: { type: 'BearerToken', token: 'test-token' },
                endpointId,
                cookie: {}
            },
            payload: {}
        }
    };
}

function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}

function propByNamespace(properties, namespace, name) {
    return properties.find((p) => p.namespace === namespace && p.name === name);
}

test('dimmable light ON@70 reports powerState + brightness + healthy EndpointHealth', async () => {
    const triggers = triggersMapWith(DIMMABLE_LIGHT);
    const getShadow = async () => ({
        state: {
            reported: { power: 'ON', brightness: 70, reachable: true, timestamp: nowSeconds(), source: 'event' }
        }
    });

    const response = await handleReportState(reportStateDirective('kitchen'), {}, { getShadow, triggers });

    assert.equal(response.event.header.namespace, 'Alexa');
    assert.equal(response.event.header.name, 'StateReport');
    assert.equal(response.event.endpoint.endpointId, 'kitchen');

    const power = propByNamespace(response.context.properties, 'Alexa.PowerController', 'powerState');
    assert.equal(power.value, 'ON');

    const brightness = propByNamespace(response.context.properties, 'Alexa.BrightnessController', 'brightness');
    assert.equal(brightness.value, 70);

    const health = propByNamespace(response.context.properties, 'Alexa.EndpointHealth', 'connectivity');
    assert.deepEqual(health.value, { value: 'OK' });
});

test('non-dimmable light ON reports powerState only (no brightness property)', async () => {
    const triggers = triggersMapWith(NON_DIMMABLE_LIGHT);
    const getShadow = async () => ({
        state: { reported: { power: 'ON', reachable: true, timestamp: nowSeconds(), source: 'event' } }
    });

    const response = await handleReportState(reportStateDirective('hall'), {}, { getShadow, triggers });

    const power = propByNamespace(response.context.properties, 'Alexa.PowerController', 'powerState');
    assert.equal(power.value, 'ON');

    const brightness = propByNamespace(response.context.properties, 'Alexa.BrightnessController', 'brightness');
    assert.equal(brightness, undefined);
});

test('shades report percentage from position (no power field in canonical shade state)', async () => {
    const triggers = triggersMapWith(SHADES);
    const getShadow = async () => ({
        state: { reported: { position: 42, reachable: true, timestamp: nowSeconds(), source: 'event' } }
    });

    const response = await handleReportState(reportStateDirective('blackout-shade-one'), {}, { getShadow, triggers });

    const percentage = propByNamespace(response.context.properties, 'Alexa.PercentageController', 'percentage');
    assert.equal(percentage.value, 42);

    // Apollo's shades driver (src/somfyBridge.js) never publishes a `power` field, so no
    // powerState property should be synthesized.
    const power = propByNamespace(response.context.properties, 'Alexa.PowerController', 'powerState');
    assert.equal(power, undefined);

    const health = propByNamespace(response.context.properties, 'Alexa.EndpointHealth', 'connectivity');
    assert.deepEqual(health.value, { value: 'OK' });
});

test('reachable:false reports EndpointHealth UNREACHABLE but keeps last-known state', async () => {
    const triggers = triggersMapWith(DIMMABLE_LIGHT);
    const getShadow = async () => ({
        state: {
            reported: { power: 'OFF', brightness: 0, reachable: false, timestamp: nowSeconds(), source: 'event' }
        }
    });

    const response = await handleReportState(reportStateDirective('kitchen'), {}, { getShadow, triggers });

    const health = propByNamespace(response.context.properties, 'Alexa.EndpointHealth', 'connectivity');
    assert.deepEqual(health.value, { value: 'UNREACHABLE' });

    const power = propByNamespace(response.context.properties, 'Alexa.PowerController', 'powerState');
    assert.equal(power.value, 'OFF');
});

test('missing shadow (getShadow throws) returns ErrorResponse ENDPOINT_UNREACHABLE', async () => {
    const triggers = triggersMapWith(DIMMABLE_LIGHT);
    const getShadow = async () => {
        throw new Error('ResourceNotFoundException: No shadow exists for thing: apollo-kitchen');
    };

    const response = await handleReportState(reportStateDirective('kitchen'), {}, { getShadow, triggers });

    assert.equal(response.event.header.name, 'ErrorResponse');
    assert.equal(response.event.payload.type, 'ENDPOINT_UNREACHABLE');
});

test('stale timestamp (>24h old) reports UNREACHABLE health but state is still present', async () => {
    const triggers = triggersMapWith(DIMMABLE_LIGHT);
    const staleTimestamp = nowSeconds() - (25 * 60 * 60); // 25h old
    const getShadow = async () => ({
        state: {
            reported: { power: 'ON', brightness: 55, reachable: true, timestamp: staleTimestamp, source: 'event' }
        }
    });

    const response = await handleReportState(reportStateDirective('kitchen'), {}, { getShadow, triggers });

    assert.equal(response.event.header.name, 'StateReport');

    const health = propByNamespace(response.context.properties, 'Alexa.EndpointHealth', 'connectivity');
    assert.deepEqual(health.value, { value: 'UNREACHABLE' });

    const power = propByNamespace(response.context.properties, 'Alexa.PowerController', 'powerState');
    assert.equal(power.value, 'ON');

    const brightness = propByNamespace(response.context.properties, 'Alexa.BrightnessController', 'brightness');
    assert.equal(brightness.value, 55);
});

test('malformed shadow (no reported.power) returns ErrorResponse without throwing', async () => {
    const triggers = triggersMapWith(DIMMABLE_LIGHT);
    const getShadow = async () => ({ state: { reported: { brightness: 50 } } });

    const response = await handleReportState(reportStateDirective('kitchen'), {}, { getShadow, triggers });

    assert.equal(response.event.header.name, 'ErrorResponse');
    assert.equal(response.event.payload.type, 'INTERNAL_ERROR');
});

test('malformed shadow (state.reported entirely missing) returns ErrorResponse without throwing', async () => {
    const triggers = triggersMapWith(DIMMABLE_LIGHT);
    const getShadow = async () => ({});

    const response = await handleReportState(reportStateDirective('kitchen'), {}, { getShadow, triggers });

    assert.equal(response.event.header.name, 'ErrorResponse');
    assert.equal(response.event.payload.type, 'INTERNAL_ERROR');
});

test('unknown endpointId (no trigger configured) returns ErrorResponse NO_SUCH_ENDPOINT', async () => {
    const triggers = triggersMapWith(DIMMABLE_LIGHT);
    const getShadow = async () => { throw new Error('should not be called'); };

    const response = await handleReportState(reportStateDirective('nonexistent'), {}, { getShadow, triggers });

    assert.equal(response.event.header.name, 'ErrorResponse');
    assert.equal(response.event.payload.type, 'NO_SUCH_ENDPOINT');
});

test('non-stateful endpoint (scene) returns ErrorResponse INVALID_DIRECTIVE rather than reading a shadow', async () => {
    const triggers = triggersMapWith(SCENE);
    const getShadow = async () => { throw new Error('should not be called'); };

    const response = await handleReportState(reportStateDirective('all_lights'), {}, { getShadow, triggers });

    assert.equal(response.event.header.name, 'ErrorResponse');
    assert.equal(response.event.payload.type, 'INVALID_DIRECTIVE');
});

test('LIGHTS trigger WITHOUT statefulMqtt (e.g. a DMX light) returns ErrorResponse INVALID_DIRECTIVE rather than reading a shadow', async () => {
    const triggers = triggersMapWith(UNSTATEFUL_LIGHT);
    const getShadow = async () => { throw new Error('should not be called'); };

    const response = await handleReportState(reportStateDirective('ceiling'), {}, { getShadow, triggers });

    assert.equal(response.event.header.name, 'ErrorResponse');
    assert.equal(response.event.payload.type, 'INVALID_DIRECTIVE');
});
