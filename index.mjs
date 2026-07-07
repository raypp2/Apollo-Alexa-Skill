import { handleDiscovery } from './handleDiscovery.mjs';
import { handleAC, handleLock, handleSpeaker, handlePowerOrLight } from './handleDevices.mjs';
import { handleReportState } from './handleReportState.mjs';
import { handleAcceptGrant } from './handleAcceptGrant.mjs';
import { changeReport } from './changeReport.mjs';


// Get triggers config from S3
// BUG: Async is causing a race condition where the command is being sent before the S3 bucket read is finished. 
// To fix this, the handler needs to be moved to the functions that use it and await the triggers.
// I'm not doing this because my triggers are not changing often enough to warrant the extra latency.
//
// import { getTriggersS3 } from './getTriggersS3.mjs';
// const triggers = await getTriggersS3();


// Get triggers config from local file system
import { getTriggers } from './getTriggersFs.mjs';
const triggers = await getTriggers();

const triggersMap = new Map(triggers.map(trigger => [trigger.endpointId, trigger]));
export { triggers, triggersMap };


export const handler = async function (request, context) {

    // Stage 7 ChangeReport leg: the IoT Rule invokes this same Lambda with a non-directive
    // event shaped `{thingName, reported, previous}` (SQL over
    // $aws/things/+/shadow/update/documents) rather than an Alexa directive envelope. Must be
    // checked first -- a directive-shaped request never has `thingName`, and this event shape
    // never has `directive`, so accessing `request.directive.header` below would throw for it.
    if (request && typeof request === 'object' && 'thingName' in request && !('directive' in request)) {
        console.log("DEBUG: " + "ChangeReport (shadow) event " + JSON.stringify(request));
        return await changeReport(request, context);
    }

    if (request.directive.header.namespace === 'Alexa.Discovery' && request.directive.header.name === 'Discover') {
        console.log("DEBUG: " + "Discover request " + JSON.stringify(request));
        return await handleDiscovery(request, context);
    }
    else if (request.directive.header.namespace === 'Alexa.PowerController') {
        // TODO Check that this doesn't exclude the BrightnessController
        if (request.directive.header.name === 'TurnOn' || request.directive.header.name === 'TurnOff') {
            console.log("DEBUG: " + "TurnOn or TurnOff Request " + JSON.stringify(request));
            return await handlePowerOrLight(request, context); 
        }
    }
    else if (request.directive.header.namespace === 'Alexa.BrightnessController') {
        console.log("DEBUG: " + "Brightness Request " + JSON.stringify(request));
        return await handlePowerOrLight(request, context); 
    }
    else if (request.directive.header.namespace === 'Alexa.PercentageController') {
        console.log("DEBUG: " + "Percentage Request " + JSON.stringify(request));
        return await handlePowerOrLight(request, context); 
    }
    else if (request.directive.header.namespace === 'Alexa.Speaker') {
        console.log("DEBUG: " + "Speaker Request " + JSON.stringify(request));
        return await handleSpeaker(request, context);    
    }
    else if (request.directive.header.namespace === 'Alexa.ThermostatController') {
        console.log("DEBUG: " + "Thermostat Request " + JSON.stringify(request));
        return await handleAC(request, context);
    }
    else if (request.directive.header.namespace === 'Alexa.LockController') {
        console.log("DEBUG: " + "Lock Request " + JSON.stringify(request));
        return await handleLock(request, context);
    }
    else if (request.directive.header.namespace === 'Alexa.Authorization' && request.directive.header.name === 'AcceptGrant') {
        console.log("DEBUG: " + "AcceptGrant Request " + JSON.stringify(request));
        return await handleAcceptGrant(request, context);
    }
    else if (request.directive.header.namespace === 'Alexa' && request.directive.header.name === 'ReportState') {
        console.log("DEBUG: " + "ReportState Request " + JSON.stringify(request));
        return await handleReportState(request, context);
    }

};