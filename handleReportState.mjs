import { triggersMap as liveTriggersMap } from './index.mjs';
import { isStatefulTrigger } from './handleDiscovery.mjs';
import { isValidReportedState, buildProperties } from './alexaStateProperties.mjs';

let cachedClient = null;

/**
 * Lazily builds (and caches) the IoT data-plane client. Not called at module load time --
 * only when the real (non-injected) getShadow path actually runs -- so importing this
 * module, or running it against an injected fake getShadow (as the tests do), never
 * requires IOT_DATA_ENDPOINT to be set or the AWS SDK to make a network call.
 */
async function getIotDataClient() {
    if (!process.env.IOT_DATA_ENDPOINT) {
        throw new Error(
            "IOT_DATA_ENDPOINT environment variable is not set. Set it to this AWS account's " +
            'IoT data-plane endpoint (Lambda console -> Configuration -> Environment variables; ' +
            'find the value with `aws iot describe-endpoint --endpoint-type iot:Data-ATS`), e.g. ' +
            '"xxxxxxxxxxxxxx-ats.iot.us-east-1.amazonaws.com". ReportState cannot read device ' +
            'shadows without it.'
        );
    }
    if (!cachedClient) {
        const { IoTDataPlaneClient } = await import('@aws-sdk/client-iot-data-plane');
        cachedClient = new IoTDataPlaneClient({
            region: process.env.sqsRegion || 'us-east-1',
            endpoint: `https://${process.env.IOT_DATA_ENDPOINT}`
        });
    }
    return cachedClient;
}

/**
 * Reads a Uint8Array/stream-ish SDK response body into a UTF-8 string, tolerant of the
 * couple of shapes @aws-sdk/client-iot-data-plane's GetThingShadowCommand can return
 * `payload` as depending on runtime (Node stream vs. plain Uint8Array).
 * @param {*} body
 * @returns {Promise<string>}
 */
async function bodyToString(body) {
    if (body == null) {
        return '';
    }
    if (typeof body.transformToString === 'function') {
        return body.transformToString();
    }
    if (body instanceof Uint8Array) {
        return Buffer.from(body).toString('utf8');
    }
    const chunks = [];
    for await (const chunk of body) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/**
 * Production shadow getter: reads the classic shadow for IoT thing `apollo-<endpointId>`
 * and returns the parsed shadow document (`{ state: { reported: {...} }, ... }`).
 * Throws if the shadow doesn't exist (AWS SDK raises ResourceNotFoundException) or the
 * request otherwise fails -- handleReportState treats any throw here as "shadow missing"
 * and answers with an ErrorResponse.
 * @param {string} endpointId
 * @returns {Promise<object>}
 */
async function defaultGetShadow(endpointId) {
    const client = await getIotDataClient();
    const { GetThingShadowCommand } = await import('@aws-sdk/client-iot-data-plane');
    const command = new GetThingShadowCommand({ thingName: `apollo-${endpointId}` });
    const response = await client.send(command);
    const raw = await bodyToString(response.payload);
    return JSON.parse(raw);
}

function buildErrorResponse(event, type, message) {
    const directive = event.directive;
    const endpointId = directive.endpoint && directive.endpoint.endpointId;
    return {
        event: {
            header: {
                namespace: 'Alexa',
                name: 'ErrorResponse',
                payloadVersion: '3',
                messageId: directive.header.messageId,
                correlationToken: directive.header.correlationToken
            },
            endpoint: endpointId ? { endpointId } : undefined,
            payload: { type, message }
        }
    };
}

/**
 * Handles `namespace: "Alexa", name: "ReportState"` directives by reading the endpoint's
 * IoT classic shadow and mapping its canonical reported state onto Alexa context
 * properties.
 * @param {object} event - the Alexa directive event
 * @param {object} context - the Lambda context (unused directly, kept for signature parity
 *   with the other handle* functions)
 * @param {object} [deps] - injection point for tests
 * @param {function(string, object): Promise<object>} [deps.getShadow] - defaults to
 *   defaultGetShadow; called as getShadow(endpointId, trigger)
 * @param {Map<string, object>} [deps.triggers] - defaults to the live triggersMap from
 *   index.mjs
 * @returns {Promise<object>} StateReport or ErrorResponse event
 */
async function handleReportState(event, context, deps = {}) {
    const getShadow = deps.getShadow || defaultGetShadow;
    const triggers = deps.triggers || liveTriggersMap;

    const endpointId = event.directive.endpoint.endpointId;
    const trigger = triggers.get(endpointId);

    if (!trigger) {
        console.error('No matching trigger found for applianceId:', endpointId);
        return buildErrorResponse(event, 'NO_SUCH_ENDPOINT', `No trigger configured for endpoint ${endpointId}`);
    }

    if (!isStatefulTrigger(trigger)) {
        console.error('ReportState requested for a non-stateful endpoint:', endpointId);
        return buildErrorResponse(event, 'INVALID_DIRECTIVE', `Endpoint ${endpointId} does not report state`);
    }

    let shadow;
    try {
        shadow = await getShadow(endpointId, trigger);
    } catch (err) {
        console.error('Shadow fetch failed for', endpointId, err);
        return buildErrorResponse(event, 'ENDPOINT_UNREACHABLE', `No shadow found for endpoint ${endpointId}`);
    }

    const reported = shadow && shadow.state && shadow.state.reported;
    if (!isValidReportedState(trigger, reported)) {
        console.error('Malformed shadow for', endpointId, JSON.stringify(shadow));
        return buildErrorResponse(event, 'INTERNAL_ERROR', `Malformed shadow document for endpoint ${endpointId}`);
    }

    const nowMs = Date.now();
    const properties = buildProperties(trigger, reported, nowMs).map((entry) => entry.property);

    return {
        context: { properties },
        event: {
            header: {
                namespace: 'Alexa',
                name: 'StateReport',
                payloadVersion: '3',
                messageId: event.directive.header.messageId,
                correlationToken: event.directive.header.correlationToken
            },
            endpoint: {
                endpointId,
                scope: event.directive.endpoint.scope
            },
            payload: {}
        }
    };
}

export { handleReportState, defaultGetShadow, isValidReportedState };
