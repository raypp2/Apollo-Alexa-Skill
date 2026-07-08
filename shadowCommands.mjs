// Stage 10 (Alexa shadow commands leg): dual-writes each Alexa directive's absolute desired
// state onto the endpoint's IoT classic shadow `desired` node, alongside (never instead of)
// the existing SQS command dispatch in handleDevices.mjs. This lets Apollo's forthcoming
// shadow-delta command listener (COMMAND_SOURCE switch, parallel-run phase -- see
// Apollo-Home-Control#23) observe the same commands Alexa sends today without touching the
// SQS path, its message shape, or its latency at all.
//
// Fully gated behind SHADOW_COMMANDS=1: unset (or any other value) makes writeDesiredState a
// same-tick no-op with no client construction and no logging, so until the env var is flipped
// in the Lambda console today's behavior (SQS-only) is bit-identical to pre-Stage-10.
//
// Client/endpoint pattern (lazy client, cached at module scope, IOT_DATA_ENDPOINT env var,
// region from sqsRegion falling back to us-east-1) is copied from handleReportState.mjs's
// getIotDataClient() rather than importing it from there -- that function isn't exported, and
// forking a two-line lazy-init is simpler than exporting a client factory across an
// unrelated concern (ReportState reads shadows; this writes them).

let cachedClient = null;

// How long a shadow write is allowed to run before this module gives up on it and lets the
// caller proceed anyway. This matters because of how Lambda execution environments behave:
// once the handler's returned Promise resolves, Lambda is free to freeze the execution
// environment (pause the process) as soon as the platform is done flushing the response. A
// truly un-awaited "fire and forget" write (started but never awaited by the handler) can be
// frozen mid-flight -- its socket write, its response parsing, its .catch -- and then resumed
// arbitrarily later (on the next invocation of a warm container) or never resumed at all if
// the environment is torn down first. Awaiting the write avoids that, but an unbounded await
// would let a slow/hung IoT Data Plane call add unbounded latency to the Alexa response, which
// the task explicitly rules out. Promise.race against this timeout gives the best of both:
// the write is awaited (so it can't be silently frozen mid-flight while still in progress),
// but it can never add more than WRITE_TIMEOUT_MS to the response, win or lose.
const WRITE_TIMEOUT_MS = 1500;

/**
 * Lazily builds (and caches) the IoT data-plane client. Mirrors handleReportState.mjs's
 * getIotDataClient(). Not called at module load time, and not called at all when
 * SHADOW_COMMANDS isn't '1' or when a test injects its own updateShadow -- so importing this
 * module never requires IOT_DATA_ENDPOINT to be set or the AWS SDK to make a network call.
 */
async function getIotDataClient() {
    if (!process.env.IOT_DATA_ENDPOINT) {
        throw new Error(
            "IOT_DATA_ENDPOINT environment variable is not set. Set it to this AWS account's " +
            'IoT data-plane endpoint (Lambda console -> Configuration -> Environment variables; ' +
            'find the value with `aws iot describe-endpoint --endpoint-type iot:Data-ATS`), e.g. ' +
            '"xxxxxxxxxxxxxx-ats.iot.us-east-1.amazonaws.com". Shadow command writes cannot run ' +
            'without it.'
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
 * Production shadow writer: merges `desired` onto IoT thing `apollo-<endpointId>`'s classic
 * shadow `desired` node via UpdateThingShadowCommand. A classic shadow update only touches the
 * keys present in the payload (it's a merge, not a replace), so this never clobbers unrelated
 * desired fields another command may have set.
 * @param {string} endpointId
 * @param {object} desired - e.g. {power: 'ON'} or {brightness: 70} or {position: 42}
 * @returns {Promise<void>}
 */
async function defaultUpdateShadow(endpointId, desired) {
    const client = await getIotDataClient();
    const { UpdateThingShadowCommand } = await import('@aws-sdk/client-iot-data-plane');
    const command = new UpdateThingShadowCommand({
        thingName: `apollo-${endpointId}`,
        payload: Buffer.from(JSON.stringify({ state: { desired } }))
    });
    await client.send(command);
}

function timeoutAfter(ms) {
    return new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Shadow desired-state write timed out after ${ms}ms`)), ms);
    });
}

/**
 * Dual-writes `desired` onto the endpoint's IoT classic shadow, gated behind SHADOW_COMMANDS.
 * Never throws and never delays its caller by more than WRITE_TIMEOUT_MS: any failure
 * (disabled flag aside) is caught and logged, not propagated, so a shadow-write problem can
 * never turn into a failed or slow Alexa directive response. Callers should still `await`
 * this (see WRITE_TIMEOUT_MS's doc comment for why un-awaited "fire and forget" is unsafe in
 * Lambda) -- the bound is enforced here, not by the caller declining to await.
 * @param {string} endpointId
 * @param {object|null} desired - fields to merge into shadow.state.desired, or null/undefined
 *   to skip the write entirely (e.g. the directive had no absolute target -- AdjustBrightness,
 *   locks, AC, speakers, scenes). Passing null is a convenience for callers that compute
 *   `desiredStateFor(directive)` inline.
 * @param {object} [deps] - injection point for tests
 * @param {boolean} [deps.enabled] - defaults to `process.env.SHADOW_COMMANDS === '1'`
 * @param {function(string, object): Promise<void>} [deps.updateShadow] - defaults to
 *   defaultUpdateShadow
 * @returns {Promise<void>}
 */
async function writeDesiredState(endpointId, desired, deps = {}) {
    const enabled = deps.enabled !== undefined ? deps.enabled : process.env.SHADOW_COMMANDS === '1';
    if (!enabled || !desired) {
        return;
    }

    const updateShadow = deps.updateShadow || defaultUpdateShadow;

    try {
        await Promise.race([
            updateShadow(endpointId, desired),
            timeoutAfter(WRITE_TIMEOUT_MS)
        ]);
    } catch (err) {
        console.error('Shadow desired-state write failed for', endpointId, err);
    }
}

/**
 * Maps an Alexa directive to the shadow `desired` fields it expresses -- the same "one
 * directive, one field" shape the SQS apiCommand string already encodes -- or null when the
 * directive has no absolute target to write. Pure and side-effect-free so it can be unit
 * tested without touching AWS or the SHADOW_COMMANDS flag, and so handleDevices.mjs can call
 * it directly to decide whether writeDesiredState has anything to do.
 *
 * Deliberately narrow: only PowerController TurnOn/TurnOff, BrightnessController
 * SetBrightness, and PercentageController SetPercentage express an absolute value. Everything
 * else (AdjustBrightness -- relative, no absolute value to write; locks; AC; speakers; scenes)
 * returns null and is SQS-only, matching the task's mapping table exactly.
 * @param {object} directive - event.directive
 * @returns {{power: string}|{brightness: number}|{position: number}|null}
 */
function desiredStateFor(directive) {
    if (!directive || !directive.header) {
        return null;
    }
    const { namespace, name } = directive.header;

    if (namespace === 'Alexa.PowerController') {
        if (name === 'TurnOn') return { power: 'ON' };
        if (name === 'TurnOff') return { power: 'OFF' };
        return null;
    }

    if (namespace === 'Alexa.BrightnessController' && name === 'SetBrightness') {
        return { brightness: directive.payload.brightness };
    }

    if (namespace === 'Alexa.PercentageController' && name === 'SetPercentage') {
        return { position: directive.payload.percentage };
    }

    return null;
}

export { writeDesiredState, desiredStateFor, defaultUpdateShadow, WRITE_TIMEOUT_MS };
