import { triggersMap as liveTriggersMap } from './index.mjs';
import { buildProperties } from './alexaStateProperties.mjs';
import { defaultGetTokens, defaultPutTokens, refreshAccessToken } from './alexaEventGatewayAuth.mjs';

const EVENT_GATEWAY_URL = 'https://api.amazonalexa.com/v3/events';

// --- No-op filter / noise-damping tunables ------------------------------------------------
// Apollo's poll sweep (see documentation/mqtt-implementation-plan.md's Stage 3 poll/Optimistic
// State Verification sections) re-reports a device's unchanged state to its shadow every
// ~60-90s. Without a no-op filter, every poll cycle would fire a ChangeReport at Amazon for
// every stateful device even when nothing changed -- wasted Event Gateway quota and exactly
// the kind of proactive-event spam Alexa's Smart Home guidance warns against.

// Canonical fields eligible to trigger a ChangeReport at all. Deliberately excludes
// timestamp/source (which differ on every poll by definition) and reachable (a reachability
// flip alone is EndpointHealth's concern -- it always rides along in context.properties, never
// as a `change`).
const CHANGE_REPORT_FIELDS = ['power', 'brightness', 'position'];

// Shades report position on every tick while moving and dimmers can drift a point or two
// between polls -- skip a brightness/position delta smaller than this so e.g. a shade closing
// from 100 to 0 doesn't fire ~20 ChangeReports along the way. (tunable)
const MIN_SIGNIFICANT_DELTA = 5;

// ...unless the new value lands on one of these boundaries (fully open/closed position, fully
// off/on brightness) -- those matter even as a sub-threshold delta (e.g. 96 -> 100). (tunable)
const BOUNDARY_VALUES = new Set([0, 100]);

// Refresh the access token this many seconds before its actual expiry, so a ChangeReport in
// flight doesn't race a token that expires mid-request. (tunable)
const TOKEN_REFRESH_SKEW_SECONDS = 60;
// -------------------------------------------------------------------------------------------

/**
 * Determines which canonical fields (drawn from CHANGE_REPORT_FIELDS) changed meaningfully
 * between `reported` and `previous`, applying the no-op filter and noise damping described
 * above.
 * @param {object} reported - canonical state from the shadow's new `reported` document
 * @param {object|null} previous - canonical state from the shadow's previous `reported`
 *   document, or null if this is the first-ever report for the thing
 * @returns {Set<string>} subset of CHANGE_REPORT_FIELDS; empty means "nothing worth reporting"
 */
function computeChangedKeys(reported, previous) {
    const prev = previous || {};
    const changed = new Set();

    if (reported.power !== undefined && reported.power !== prev.power) {
        changed.add('power');
    }

    const powerChanged = changed.has('power');

    for (const key of ['brightness', 'position']) {
        if (reported[key] === undefined) {
            continue;
        }
        const prevValue = prev[key];
        if (prevValue === undefined) {
            // No baseline to diff against (first report, or the field is new) -- report it
            // rather than silently swallowing the endpoint's first observed value.
            changed.add(key);
            continue;
        }
        if (reported[key] === prevValue) {
            continue;
        }
        const delta = Math.abs(reported[key] - prevValue);
        const landsOnBoundary = BOUNDARY_VALUES.has(reported[key]);
        if (delta >= MIN_SIGNIFICANT_DELTA || landsOnBoundary || powerChanged) {
            changed.add(key);
        }
    }

    return changed;
}

/**
 * @param {string} source - reported.source ("command" | "event" | "poll")
 * @returns {"APP_INTERACTION"|"PHYSICAL_INTERACTION"}
 */
function causeTypeFor(source) {
    return source === 'command' ? 'APP_INTERACTION' : 'PHYSICAL_INTERACTION';
}

/**
 * @param {string} thingName - e.g. "apollo-kitchen"
 * @returns {string|null} the endpointId (thingName with the "apollo-" prefix stripped), or
 *   null if thingName doesn't match the expected shape
 */
function endpointIdFromThingName(thingName) {
    return typeof thingName === 'string' && thingName.startsWith('apollo-')
        ? thingName.slice('apollo-'.length)
        : null;
}

function randomMessageId() {
    return (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
        ? globalThis.crypto.randomUUID()
        : `changereport-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Handles a non-directive IoT Rule event shaped `{thingName, reported, previous}` (from SQL
 * over $aws/things/+/shadow/update/documents -- the IoT Rule itself is configured outside this
 * repo) by sending a proactive Alexa ChangeReport to the Event Gateway when the shadow's
 * canonical state changed meaningfully. Never throws -- this Lambda also serves live voice
 * directives, and an unhandled rejection here must not take those down.
 * @param {{thingName:string, reported:object, previous:(object|null)}} event
 * @param {object} context - unused, kept for signature parity with the other handle* functions
 * @param {object} [deps] - injection point for tests
 * @param {Map<string,object>} [deps.triggers] - defaults to the live triggersMap from index.mjs
 * @param {function} [deps.fetch] - defaults to global fetch
 * @param {function(): Promise<object|null>} [deps.getTokens] - defaults to defaultGetTokens (SSM)
 * @param {function(object): Promise<void>} [deps.putTokens] - defaults to defaultPutTokens (SSM)
 * @param {function(): number} [deps.now] - defaults to current epoch seconds
 * @returns {Promise<void>}
 */
async function changeReport(event, context, deps = {}) {
    try {
        await changeReportInner(event, deps);
    } catch (err) {
        // Belt-and-suspenders: changeReportInner already handles every expected failure mode
        // without throwing, but an unanticipated bug here must still not propagate out of a
        // handler shared with live voice directives.
        console.error('changeReport: unexpected error, swallowing:', err);
    }
}

async function changeReportInner(event, deps) {
    const triggers = deps.triggers || liveTriggersMap;
    const doFetch = deps.fetch || fetch;
    const getTokens = deps.getTokens || defaultGetTokens;
    const putTokens = deps.putTokens || defaultPutTokens;
    const now = deps.now || (() => Math.floor(Date.now() / 1000));

    const thingName = event && event.thingName;
    const endpointId = endpointIdFromThingName(thingName);
    if (!endpointId) {
        console.error('changeReport: malformed event, expected thingName like "apollo-<endpointId>":', JSON.stringify(event));
        return;
    }

    const trigger = triggers.get(endpointId);
    if (!trigger || trigger.statefulMqtt !== true) {
        console.log(`changeReport: ${endpointId} is not statefulMqtt, skipping`);
        return;
    }

    const reported = event.reported;
    if (!reported || typeof reported !== 'object') {
        console.error('changeReport: event missing `reported` state for', endpointId);
        return;
    }

    const changedKeys = computeChangedKeys(reported, event.previous);
    if (changedKeys.size === 0) {
        console.log(`changeReport: no meaningful change for ${endpointId}, skipping`);
        return;
    }

    let tokens;
    try {
        tokens = await getTokens();
    } catch (err) {
        console.error('changeReport: failed to read Event Gateway tokens for', endpointId, err.message);
        return;
    }

    if (!tokens) {
        console.log(`changeReport: no Event Gateway tokens stored yet (account not linked), skipping ${endpointId}`);
        return;
    }

    const nowSeconds = now();
    if (tokens.obtained_at + tokens.expires_in - TOKEN_REFRESH_SKEW_SECONDS < nowSeconds) {
        try {
            const refreshed = await refreshAccessToken(tokens.refresh_token, doFetch);
            tokens = {
                access_token: refreshed.access_token,
                refresh_token: refreshed.refresh_token || tokens.refresh_token,
                expires_in: refreshed.expires_in,
                obtained_at: nowSeconds
            };
            await putTokens(tokens);
        } catch (err) {
            console.error('changeReport: token refresh failed for', endpointId, err.message);
            return;
        }
    }

    const entries = buildProperties(trigger, reported, Date.now());
    const changedProperties = entries.filter((entry) => changedKeys.has(entry.key)).map((entry) => entry.property);
    const contextProperties = entries.filter((entry) => !changedKeys.has(entry.key)).map((entry) => entry.property);

    if (changedProperties.length === 0) {
        console.log(`changeReport: changed keys [${[...changedKeys].join(',')}] produced no reportable properties for ${endpointId}, skipping`);
        return;
    }

    const requestBody = {
        event: {
            header: {
                namespace: 'Alexa',
                name: 'ChangeReport',
                payloadVersion: '3',
                messageId: randomMessageId()
            },
            endpoint: {
                scope: { type: 'BearerToken', token: tokens.access_token },
                endpointId
            },
            payload: {
                change: {
                    cause: { type: causeTypeFor(reported.source) },
                    properties: changedProperties
                }
            }
        },
        context: { properties: contextProperties }
    };

    let response;
    try {
        response = await doFetch(EVENT_GATEWAY_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${tokens.access_token}`
            },
            body: JSON.stringify(requestBody)
        });
    } catch (err) {
        console.error('changeReport: Event Gateway request threw for', endpointId, err.message);
        return;
    }

    if (response.status === 202) {
        console.log(`changeReport: sent for ${endpointId} (${[...changedKeys].join(',')})`);
        return;
    }

    const bodyText = await response.text().catch(() => '<unreadable body>');

    if (response.status === 401 || response.status === 403) {
        console.error(`changeReport: Event Gateway auth error ${response.status} for ${endpointId} -- not retrying:`, bodyText);
        return;
    }

    console.error(`changeReport: Event Gateway returned ${response.status} for ${endpointId} -- not retrying:`, bodyText);
}

export { changeReport, computeChangedKeys, causeTypeFor, endpointIdFromThingName };
