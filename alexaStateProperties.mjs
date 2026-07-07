// Shared canonical-state -> Alexa property mapping, used by both handleReportState.mjs
// (StateReport) and changeReport.mjs (ChangeReport). Kept in one place so the two response
// types can never drift on how a shadow's `reported` state maps onto Alexa.*Controller
// properties -- see the Stage 7 ChangeReport task note: "Property construction must reuse
// handleReportState.mjs's mapping (refactor its property-builder into a small shared module
// both import -- do not fork the logic."

// How old (in seconds) a shadow's `timestamp` can be before we consider it stale and report
// Alexa.EndpointHealth as UNREACHABLE even though `reachable` itself said true. Matches the
// "timestamp older than 24h" staleness window called out in the Stage 7 spec.
const STALE_SECONDS = 24 * 60 * 60;

// Cap on uncertaintyInMilliseconds. There's no hard spec ceiling for this value; capping it
// at the same 24h staleness window keeps it bounded and ties it to a concept the rest of this
// file already reasons about, rather than introducing a second unrelated constant.
const MAX_UNCERTAINTY_MS = STALE_SECONDS * 1000;

/**
 * Whether `reported` has the field(s) this trigger type needs to build a valid StateReport.
 * Deliberately per-trigger-type rather than "has power AND position": the shades canonical
 * MQTT state never carries a `power` field (src/somfyBridge.js only ever publishes
 * `position`), so requiring `power` there would make every shades ReportState "malformed".
 * See handleDiscovery.mjs's reportsPower() for the discovery-side twin of this same
 * asymmetry.
 * @param {object} trigger
 * @param {object} reported
 * @returns {boolean}
 */
function isValidReportedState(trigger, reported) {
    if (!reported || typeof reported !== 'object') {
        return false;
    }
    if (trigger.apiModule === 'LIGHTS') {
        return reported.power === 'ON' || reported.power === 'OFF';
    }
    if (trigger.isPercentageController) {
        return typeof reported.position === 'number' && reported.position >= 0 && reported.position <= 100;
    }
    // Any future STATEFUL_FLAG-only endpoint type has no known shape yet to validate -- treat
    // as malformed until this function is extended for it.
    return false;
}

/**
 * Maps a canonical `reported` state onto the Alexa properties this trigger type supports,
 * tagging each with the canonical field it was derived from so callers can partition them
 * (handleReportState.mjs uses the whole list as context.properties; changeReport.mjs splits
 * the list into payload.change.properties vs. context.properties based on which canonical
 * fields actually changed).
 *
 * `key` values: 'power' | 'brightness' | 'position' | 'health'. 'health' (EndpointHealth
 * connectivity) is always present and is never considered a "changed" field by
 * changeReport.mjs's no-op filter -- reachability alone changing is not something a
 * ChangeReport's `change.properties` should carry.
 *
 * @param {object} trigger - a triggers.json entry
 * @param {object} reported - canonical MQTT/shadow state, e.g. {power, brightness, position,
 *   reachable, timestamp, source}
 * @param {number} [nowMs] - reference "now" for staleness/uncertainty math; defaults to
 *   Date.now(). Callers pass this explicitly so tests are deterministic.
 * @returns {Array<{key: string, property: object}>}
 */
function buildProperties(trigger, reported, nowMs = Date.now()) {
    const timestampSeconds = typeof reported.timestamp === 'number' ? reported.timestamp : null;
    const isStale = timestampSeconds === null || (Math.floor(nowMs / 1000) - timestampSeconds) > STALE_SECONDS;
    const isUnreachable = reported.reachable === false || isStale;

    const timeOfSample = timestampSeconds !== null
        ? new Date(timestampSeconds * 1000).toISOString()
        : new Date(nowMs).toISOString();

    const uncertaintyInMilliseconds = timestampSeconds !== null
        ? Math.min(Math.max(nowMs - timestampSeconds * 1000, 0), MAX_UNCERTAINTY_MS)
        : MAX_UNCERTAINTY_MS;

    const entries = [];

    if (reported.power !== undefined) {
        entries.push({
            key: 'power',
            property: {
                namespace: 'Alexa.PowerController',
                name: 'powerState',
                value: reported.power === 'ON' ? 'ON' : 'OFF',
                timeOfSample,
                uncertaintyInMilliseconds
            }
        });
    }

    if (trigger.isDimmable && reported.brightness !== undefined) {
        entries.push({
            key: 'brightness',
            property: {
                namespace: 'Alexa.BrightnessController',
                name: 'brightness',
                value: reported.brightness,
                timeOfSample,
                uncertaintyInMilliseconds
            }
        });
    }

    if (trigger.isPercentageController && reported.position !== undefined) {
        entries.push({
            key: 'position',
            property: {
                namespace: 'Alexa.PercentageController',
                name: 'percentage',
                value: reported.position,
                timeOfSample,
                uncertaintyInMilliseconds
            }
        });
    }

    entries.push({
        key: 'health',
        property: {
            namespace: 'Alexa.EndpointHealth',
            name: 'connectivity',
            value: { value: isUnreachable ? 'UNREACHABLE' : 'OK' },
            timeOfSample,
            uncertaintyInMilliseconds
        }
    });

    return entries;
}

export { STALE_SECONDS, MAX_UNCERTAINTY_MS, isValidReportedState, buildProperties };
