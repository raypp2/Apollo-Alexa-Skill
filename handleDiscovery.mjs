import { triggers, triggersMap } from './index.mjs';

// Stage 7 (ReportState leg): endpoints backed by a live IoT Core device shadow get
// `retrievable`/`proactivelyReported` capability properties plus an EndpointHealth
// interface. See isStatefulTrigger() below for exactly which endpoints qualify, and
// handleReportState.mjs for the code that actually answers ReportState directives for
// them.
//
// NOTE on the `mqttName` field: apollo-home-control's src/alexaTriggers.js stamps
// "mqttName": entry.mqttName || entry.id onto EVERY trigger it writes -- lights, shades,
// scenes, macros, deviceScenes, locks, speakers, AC, all of it (verified against the live
// config/triggers.json on 2026-07-07: 58/58 entries carry a non-empty mqttName). So
// "trigger has a truthy mqttName" is not a usable signal for "this endpoint has a real
// MQTT-backed shadow" -- it's true for stateless SCENE_TRIGGER/ACTIVITY_TRIGGER endpoints
// too, and using it as-is would wrongly mark those endpoints retrievable. Apollo only
// actually publishes canonical MQTT state (see src/mqttTopics.js publishState() callers)
// for LIGHTS entries and the shades DEVICES entry -- nothing else has a shadow to read.
// `STATEFUL_FLAG` below is a placeholder future opt-in field that alexaTriggers.js does
// not emit today, so it is inert until a future device type deliberately sets it.
const STATEFUL_FLAG = 'statefulMqtt';

/**
 * Whether Apollo publishes a live, shadow-backed canonical state for this endpoint.
 * Today that's exactly: LIGHTS (every ecosystem driver publishes `power` on every
 * change -- see src/lightingInsteon.js, lightingPhilipsHue.js, lightingShelly.js) and the
 * shades DEVICES entry (isPercentageController: true, publishes `position`).
 * Scenes/macros/deviceScenes and every other DEVICES entry (locks, AC, speakers, the
 * projectors, Find My, etc.) fire a one-shot command and have no ongoing device state to
 * report, so they are intentionally excluded and keep today's discovery behavior exactly.
 * @param {object} trigger - a triggers.json entry
 * @returns {boolean}
 */
function isStatefulTrigger(trigger) {
    return !!trigger && (
        trigger.apiModule === 'LIGHTS' ||
        trigger.isPercentageController === true ||
        trigger[STATEFUL_FLAG] === true
    );
}

/**
 * Whether this endpoint's shadow actually carries a `power` field Apollo can report.
 * Only LIGHTS entries publish `power` (see src/lightingInsteon.js, lightingPhilipsHue.js,
 * lightingShelly.js, lightingInsteonListener.js -- every publishState() call for a light
 * includes `power`). The shades DEVICES entry only ever publishes `position`
 * (src/somfyBridge.js never sets a `power` key), so PowerController is declared
 * retrievable there today but Apollo has nothing to answer with -- see the discovery-shape
 * risk noted in the Stage 7 ReportState commit/report. Scoping retrievability to LIGHTS
 * only (rather than every isStatefulTrigger()) avoids Discovery claiming a capability
 * ReportState can't fulfill.
 * @param {object} trigger
 * @returns {boolean}
 */
function reportsPower(trigger) {
    return !!trigger && trigger.apiModule === 'LIGHTS';
}

function handleDiscovery(accessToken, context, triggersList = triggers) {
    // Define the namespace and name according to the v3 Smart Home Skill API
    const header = {
        namespace: 'Alexa.Discovery',
        name: 'Discover.Response',
        payloadVersion: '3'
    };

    // Initialize the array for discovered devices
    const endpoints = [];

    for (let trigger of triggersList) {
        try {
            const capabilities = [];
            const stateful = isStatefulTrigger(trigger);
            const powerRetrievable = stateful && reportsPower(trigger);

            if (!trigger.isLock){
                capabilities.push({
                        type: 'AlexaInterface',
                        interface: 'Alexa.PowerController',
                        version: '3',
                        properties: {
                            supported: [{ name: 'powerState' }],
                            proactivelyReported: powerRetrievable,
                            retrievable: powerRetrievable
                        }
                });
            }

            if (trigger.isDimmable) {
                capabilities.push({
                    type: 'AlexaInterface',
                    interface: 'Alexa.BrightnessController',
                    version: '3',
                    properties: {
                        supported: [{ name: 'brightness' }],
                        proactivelyReported: stateful,
                        retrievable: stateful
                    }
                });
            }

            if (trigger.isPercentageController) {
                capabilities.push({
                    type: 'AlexaInterface',
                    interface: 'Alexa.PercentageController',
                    version: '3',
                    properties: {
                        supported: [{ name: 'percentage' }],
                        proactivelyReported: stateful,
                        retrievable: stateful
                    }
                });
            }

            if (trigger.isLock) {
                capabilities.push({
                    type: 'AlexaInterface',
                    interface: 'Alexa.LockController',
                    version: '3',
                    properties: {
                        supported: [{ name: 'lockState' }],
                        proactivelyReported: false,
                        retrievable: false
                    }
                });
            }

            if (trigger.isSpeaker) {
                capabilities.push({
                    type: 'AlexaInterface',
                    interface: 'Alexa.Speaker',
                    version: '3',
                    properties: {
                        supported: [
                            { name: 'volume' },
                            { name: 'muted' }
                        ],
                        proactivelyReported: false,
                        retrievable: false
                    }
                });
            }

            if (trigger.isAC) {
                capabilities.push({
                    type: 'AlexaInterface',
                    interface: 'Alexa.ThermostatController',
                    version: '3.2',
                    properties: {
                        supported: [
                            { name: 'AdjustTargetTemperature' },
                            { name: 'SetThermostatMode' }
                        ],
                        proactivelyReported: false,
                        retrievable: false
                    },
                    configuration: {
                        supportedModes: ['COOL', 'ECO']
                    }
                });
            }

            if (stateful) {
                capabilities.push({
                    type: 'AlexaInterface',
                    interface: 'Alexa.EndpointHealth',
                    version: '3',
                    properties: {
                        supported: [{ name: 'connectivity' }],
                        proactivelyReported: true,
                        retrievable: true
                    }
                });
            }

            const endpoint = {
                endpointId: trigger.endpointId,
                manufacturerName: 'Perfetti Enterprises',
                friendlyName: trigger.friendlyName,
                description: trigger.friendlyName,
                displayCategories: trigger.displayCategories,
                capabilities: capabilities
            };

            endpoints.push(endpoint);

        } catch (error) {
            console.error('Error processing trigger with endpointId:', trigger.endpointId, error);
        }
    }

    const payload = {
        endpoints: endpoints
    };

    const response = {
        event: {
            header: header,
            payload: payload
        }
    };

    console.log('Discovery', response);
    return response;
}

export { handleDiscovery, isStatefulTrigger, reportsPower };
