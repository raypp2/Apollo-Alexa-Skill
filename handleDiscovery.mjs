import { triggers, triggersMap } from './index.mjs';

// Stage 7 (ReportState leg): endpoints backed by a live IoT Core device shadow get
// `retrievable`/`proactivelyReported` capability properties plus an EndpointHealth
// interface. See isStatefulTrigger() below for exactly which endpoints qualify, and
// handleReportState.mjs for the code that actually answers ReportState directives for
// them.

// Flipped true 2026-07-07: the ChangeReport leg is live (Send Alexa Events permission
// granted, AcceptGrant tokens stored in SSM, changeReport.mjs posting to the Event
// Gateway via the apolloShadowChangeReport IoT Rule). If ChangeReports ever have to be
// disabled (e.g. token loss), flip this back to false AND re-discover -- leaving it
// true without working ChangeReports makes Alexa poll ReportState less and show staler
// state.
const CHANGE_REPORTS_ENABLED = true;

/**
 * Whether Apollo publishes a live, shadow-backed canonical state for this endpoint.
 *
 * Trusts the `statefulMqtt` flag stamped into triggers.json by apollo-home-control's
 * src/alexaTriggers.js, which computes it from the same isAlexaStateful(entry) helper
 * that gates apollo-home-control's src/mqttTopics.js shadow-envelope publishing (entry has
 * an `alexa` config block AND is one of the ecosystems that actually publishes MQTT state:
 * insteon, hue-group, shelly, Somfy-Bridge). That's a single source of truth on the Apollo
 * side, so this skill no longer needs its own apiModule/isPercentageController heuristics
 * to infer statefulness -- Apollo tells us directly, on the first (index 0) trigger only
 * (alias endpoints like "shades-2" are intentionally left unstamped and stay stateless).
 * @param {object} trigger - a triggers.json entry
 * @returns {boolean}
 */
function isStatefulTrigger(trigger) {
    return trigger?.statefulMqtt === true;
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
                            proactivelyReported: powerRetrievable && CHANGE_REPORTS_ENABLED,
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
                        proactivelyReported: stateful && CHANGE_REPORTS_ENABLED,
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
                        proactivelyReported: stateful && CHANGE_REPORTS_ENABLED,
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
                        proactivelyReported: CHANGE_REPORTS_ENABLED,
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
