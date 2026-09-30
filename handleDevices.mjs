import { triggers, triggersMap } from './index.mjs';

import { sendMessageToSQS } from './sendSQS.mjs';

/**
 * Handles Alexa smart home directives related to thermostat control.
 * @param {Object} event - The event object containing the directive information.
 * @param {Object} context - The context object containing the execution environment information.
 * @returns {Promise<Object>} - A promise that resolves to the response object.
 */
async function handleAC(event, context) {
    const devCommand = event.directive.header.name;
    let contextProperties = [];
    let devMode = "COOL";
    let devTemperature = 72;

    // Undefined value means this is a SetThermostatMode or AdjustTargetTemperature directive
    if(event.directive.payload.targetSetpointDelta){
        devTemperature=event.directive.payload.targetSetpointDelta.value;
    }

    // Undefined value means this is a SetThermostatMode directive
    if(event.directive.payload.thermostatMode){
        devMode=event.directive.payload.thermostatMode.value;
    }

    // Define Alexa response properties
    contextProperties.push({
        namespace: 'Alexa.ThermostatController',
        name: 'thermostatMode',
        value: devMode,
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0
    });

    contextProperties.push({
        namespace: 'Alexa.ThermostatController',
        name: 'targetSetpoint',
        value: {
            value: devTemperature,
            scale: 'FAHRENHEIT'
        },
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0
    });

    // Translate directive to API command

    const applianceId = event.directive.endpoint.endpointId;
    const trigger = triggersMap.get(applianceId);
    if (!trigger) {
        console.error("No matching trigger found for applianceId:", applianceId);
        throw new Error("No matching trigger found");
    }

    const apiModule = trigger.apiModule;
    const apiDevice = trigger.apiDevice;

    let apiCommand = `/${apiModule}/${apiDevice}`;
    apiCommand += `/${devCommand}`;
    if (devCommand === "SetThermostatMode") { apiCommand += `/${devMode}` }
    if (devCommand === "AdjustTargetTemperature") { apiCommand += `/${devTemperature}` }

    console.log(apiCommand);

    const response = await sendMessageToSQS(event, apiCommand, contextProperties);

    return response;


}


async function handleLock(event, context) {

    // Breakdown Alexa directive and prepare response
    const devCommand = event.directive.header.name;
    let contextProperties = [];

    switch(event.directive.header.name) {
        case "Lock":
            contextProperties.push({
                namespace: 'Alexa.LockController',
                name: 'lockState',
                value: 'LOCKED',
                timeOfSample: new Date().toISOString(),
                uncertaintyInMilliseconds: 1000
            });
            break;
        case "Unlock":
            contextProperties.push({
                namespace: 'Alexa.LockController',
                name: 'lockState',
                value: 'UNLOCKED',
                timeOfSample: new Date().toISOString(),
                uncertaintyInMilliseconds: 1000
            });
            break;
        default:
            throw new Error("Unsupported directive");
    }

    // Translate directive to API command

    const applianceId = event.directive.endpoint.endpointId;
    const trigger = triggersMap.get(applianceId);
    if (!trigger) {
        console.error("No matching trigger found for applianceId:", applianceId);
        throw new Error("No matching trigger found");
    }

    const apiModule = trigger.apiModule;
    const apiDevice = trigger.apiDevice;
    const curCommand = trigger.apiCommand;

    let apiCommand = `/${apiModule}/${apiDevice}`;
    apiCommand += `/${curCommand}`;
    apiCommand += `/${devCommand}`;

    console.log(apiCommand);

    const response = await sendMessageToSQS(event, apiCommand, contextProperties);

    return response;

}

/**
 * Handles the Alexa speaker directive and prepares a response.
 * @param {Object} event - The Alexa directive event object.
 * @param {Object} context - The AWS Lambda context object.
 * @returns {Promise<Object>} - A promise that resolves to the response object.
 */
async function handleSpeaker(event, context) {
    // Breakdown Alexa directive and prepare response

    const devCommand = event.directive.header.name;
    let contextProperties = [];
    let devMuted = false;
    let devVolume = 50;

    // Undefined value means this is a SetVolume or AdjustVolume directive
    if(event.directive.payload.mute)
        devMuted=event.directive.payload.mute;

    // Undefined value means this is a SetMute directive
    if(event.directive.payload.volume)
        devVolume=event.directive.payload.volume;


    // Define Alexa response properties
    contextProperties.push({
        namespace: 'Alexa.Speaker',
        name: 'volume',
        value: devVolume,
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0
    });

    contextProperties.push({
        namespace: 'Alexa.Speaker',
        name: 'muted',
        value: devMuted,
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0
    });

    contextProperties.push({
        namespace: 'Alexa.PowerController',
        name: 'powerState',
        value: 'ON',
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 500
    });

    // Translate directive to API command

    const applianceId = event.directive.endpoint.endpointId;
    const trigger = triggersMap.get(applianceId);
    if (!trigger) {
        console.error("No matching trigger found for applianceId:", applianceId);
        throw new Error("No matching trigger found");
    }

    const apiModule = trigger.apiModule;
    const apiDevice = trigger.apiDevice;

    let apiCommand = `/${apiModule}/${apiDevice}`;
    apiCommand += `/${devCommand}`;

    if(devCommand === "SetMute"){
        apiCommand += `/${devMuted}`;
    } else if(devCommand === "SetVolume") {
        apiCommand += `/${devVolume}`;
    } else if(devCommand === "AdjustVolume") {
        apiCommand += `/${devVolume}`;
        apiCommand += `/${event.directive.payload.volumeDefault}`;            
    }
    

    console.log(apiCommand);

    const response = await sendMessageToSQS(event, apiCommand, contextProperties);

    return response;
}



async function handlePowerOrLight(event, context) {
    //TODO Confirm if it's needed to perform another error checking here
    if (event.directive.header.namespace === 'Alexa.PowerController' || event.directive.header.namespace === 'Alexa.BrightnessController' || event.directive.header.namespace === 'Alexa.PercentageController') {

        // Breakdown Alexa directive and prepare response

        let devCommand;
        let percentageState = false;
        let nameResponse;
        let contextProperties = [];

        switch(event.directive.header.name) {
            case "TurnOn":
                devCommand = "on";
                nameResponse = "TurnOn";
                contextProperties.push({
                    namespace: 'Alexa.PowerController',
                    name: 'powerState',
                    value: 'ON',
                    timeOfSample: new Date().toISOString(),
                    uncertaintyInMilliseconds: 500
                });
                break;
            case "TurnOff":
                devCommand = "off";
                nameResponse = "TurnOff";
                contextProperties.push({
                    namespace: 'Alexa.PowerController',
                    name: 'powerState',
                    value: 'OFF',
                    timeOfSample: new Date().toISOString(),
                    uncertaintyInMilliseconds: 500
                });
                break;
            case "SetBrightness":
                percentageState = event.directive.payload.brightness;
                nameResponse = "Brightness";
                contextProperties.push({
                    namespace: 'Alexa.BrightnessController',
                    name: 'brightness',
                    value: percentageState,
                    timeOfSample: new Date().toISOString(),
                    uncertaintyInMilliseconds: 500
                });
                break;
            case "SetPercentage":
                percentageState = event.directive.payload.percentage;
                nameResponse = "Percentage";
                contextProperties.push({
                    namespace: 'Alexa.PercentageController',
                    name: 'percentage',
                    value: percentageState,
                    timeOfSample: new Date().toISOString(),
                    uncertaintyInMilliseconds: 500
                });
                break;
            default:
                throw new Error("Unsupported directive");
        }

        // Translate directive to API command

        const applianceId = event.directive.endpoint.endpointId;
        const trigger = triggersMap.get(applianceId);
        if (!trigger) {
            console.error("No matching trigger found for applianceId:", applianceId);
            throw new Error("No matching trigger found");
        }

        const apiModule = trigger.apiModule;
        const apiDevice = trigger.apiDevice;

        let apiCommand = `/${apiModule}/${apiDevice}`;
        if (trigger.apiCommand) { apiCommand += `/${trigger.apiCommand}` }
        if (devCommand) { apiCommand += `/${devCommand}` }
        if (percentageState) { apiCommand += `/${percentageState}` }

        console.log(apiCommand);

        const response = await sendMessageToSQS(event, apiCommand, contextProperties);

        return response;
    } else {
        throw new Error("Invalid namespace");
    }
}

export { handleAC, handleLock, handleSpeaker, handlePowerOrLight };