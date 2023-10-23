import { triggers, triggersMap } from './index.mjs';


function handleDiscovery(accessToken, context) {
    // Define the namespace and name according to the v3 Smart Home Skill API
    const header = {
        namespace: 'Alexa.Discovery',
        name: 'Discover.Response',
        payloadVersion: '3'
    };

    // Initialize the array for discovered devices
    const endpoints = [];

    for (let trigger of triggers) {
        try {
            const capabilities = [];

            if (!trigger.isLock){
                capabilities.push({
                        type: 'AlexaInterface',
                        interface: 'Alexa.PowerController',
                        version: '3',
                        properties: {
                            supported: [{ name: 'powerState' }],
                            proactivelyReported: false,
                            retrievable: false
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
                        proactivelyReported: false,
                        retrievable: false
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

export { handleDiscovery };
