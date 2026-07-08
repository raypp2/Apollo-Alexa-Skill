import { test } from 'node:test';
import assert from 'node:assert/strict';

import { changeReport, computeChangedKeys, causeTypeFor, endpointIdFromThingName } from '../changeReport.mjs';

process.env.ALEXA_CLIENT_ID = 'test-client-id';
process.env.ALEXA_CLIENT_SECRET = 'test-client-secret';

// Fixture triggers, shaped like real config/triggers.json entries (see
// apollo-home-control/src/alexaTriggers.js for how these are generated).
const DIMMABLE_LIGHT = {
    endpointId: 'kitchen',
    friendlyName: 'Kitchen',
    apiModule: 'LIGHTS',
    apiDevice: 'kitchen',
    isDimmable: true,
    location: 'home',
    mqttName: 'kitchen',
    statefulMqtt: true
};

const SHADES = {
    endpointId: 'blackout-shade-one',
    friendlyName: 'Blackout Shade One',
    apiModule: 'DEVICES',
    apiDevice: 'shades',
    isPercentageController: true,
    location: 'home',
    mqttName: 'shades',
    statefulMqtt: true
};

// A LIGHTS trigger apollo-home-control did NOT stamp statefulMqtt on (e.g. a DMX light).
const UNFLAGGED_LIGHT = {
    endpointId: 'ceiling',
    friendlyName: 'Ceiling',
    apiModule: 'LIGHTS',
    apiDevice: 'ceiling',
    isDimmable: true,
    location: 'home',
    mqttName: 'ceiling'
};

function triggersMapWith(...triggers) {
    return new Map(triggers.map((t) => [t.endpointId, t]));
}

const VALID_TOKENS = {
    access_token: 'AT-valid',
    refresh_token: 'RT-valid',
    expires_in: 3600,
    obtained_at: 1000
};

function baseDeps(overrides = {}) {
    return {
        triggers: triggersMapWith(DIMMABLE_LIGHT, SHADES, UNFLAGGED_LIGHT),
        getTokens: async () => VALID_TOKENS,
        putTokens: async () => {},
        now: () => 1010, // well within VALID_TOKENS' expiry (obtained_at 1000 + expires_in 3600)
        fetch: async () => ({ status: 202, text: async () => '' }),
        ...overrides
    };
}

// --- computeChangedKeys / causeTypeFor / endpointIdFromThingName (pure helpers) ------------

test('computeChangedKeys: power flip alone is reported', () => {
    const changed = computeChangedKeys({ power: 'ON' }, { power: 'OFF' });
    assert.deepEqual([...changed], ['power']);
});

test('computeChangedKeys: identical state is a no-op', () => {
    const state = { power: 'ON', brightness: 80 };
    const changed = computeChangedKeys(state, { ...state });
    assert.equal(changed.size, 0);
});

test('computeChangedKeys: small position delta (20 -> 23) is damped', () => {
    const changed = computeChangedKeys({ position: 23 }, { position: 20 });
    assert.equal(changed.size, 0);
});

test('computeChangedKeys: position delta landing on a boundary (20 -> 100) is reported despite being small in count of ticks', () => {
    const changed = computeChangedKeys({ position: 100 }, { position: 20 });
    assert.deepEqual([...changed], ['position']);
});

test('computeChangedKeys: sub-threshold delta is reported anyway when power also changed', () => {
    const changed = computeChangedKeys({ power: 'ON', brightness: 42 }, { power: 'OFF', brightness: 40 });
    assert.deepEqual([...changed].sort(), ['brightness', 'power']);
});

test('causeTypeFor: command -> APP_INTERACTION, event/poll -> PHYSICAL_INTERACTION', () => {
    assert.equal(causeTypeFor('command'), 'APP_INTERACTION');
    assert.equal(causeTypeFor('event'), 'PHYSICAL_INTERACTION');
    assert.equal(causeTypeFor('poll'), 'PHYSICAL_INTERACTION');
});

test('endpointIdFromThingName: strips the apollo- prefix, rejects anything else', () => {
    assert.equal(endpointIdFromThingName('apollo-kitchen'), 'kitchen');
    assert.equal(endpointIdFromThingName('kitchen'), null);
    assert.equal(endpointIdFromThingName(undefined), null);
});

// --- changeReport (full integration with injected deps) -----------------------------------

test('power OFF -> ON sends a ChangeReport with changed powerState and PHYSICAL_INTERACTION for source event', async () => {
    let sentUrl;
    let sentHeaders;
    let sentBody;
    const fetch = async (url, options) => {
        sentUrl = url;
        sentHeaders = options.headers;
        sentBody = JSON.parse(options.body);
        return { status: 202, text: async () => '' };
    };

    await changeReport({
        thingName: 'apollo-kitchen',
        reported: { power: 'ON', brightness: 80, reachable: true, timestamp: 2000, source: 'event' },
        previous: { power: 'OFF', brightness: 80, reachable: true, timestamp: 1900, source: 'event' }
    }, {}, baseDeps({ fetch }));

    assert.equal(sentUrl, 'https://api.amazonalexa.com/v3/events');
    assert.equal(sentHeaders.Authorization, 'Bearer AT-valid');
    assert.equal(sentBody.event.header.namespace, 'Alexa');
    assert.equal(sentBody.event.header.name, 'ChangeReport');
    assert.equal(sentBody.event.endpoint.endpointId, 'kitchen');
    assert.equal(sentBody.event.endpoint.scope.token, 'AT-valid');
    assert.equal(sentBody.event.payload.change.cause.type, 'PHYSICAL_INTERACTION');

    const changedNames = sentBody.event.payload.change.properties.map((p) => p.name);
    assert.deepEqual(changedNames, ['powerState']);

    const contextNames = sentBody.context.properties.map((p) => p.name);
    assert.ok(contextNames.includes('brightness'), 'unchanged brightness should ride along in context.properties');
    assert.ok(contextNames.includes('connectivity'), 'EndpointHealth should always be in context.properties');
    assert.ok(!contextNames.includes('powerState'), 'changed property must not also appear in context.properties');
});

test('source: command uses APP_INTERACTION cause', async () => {
    let sentBody;
    const fetch = async (url, options) => {
        sentBody = JSON.parse(options.body);
        return { status: 202, text: async () => '' };
    };

    await changeReport({
        thingName: 'apollo-kitchen',
        reported: { power: 'ON', brightness: 80, reachable: true, timestamp: 2000, source: 'command' },
        previous: { power: 'OFF', brightness: 80, reachable: true, timestamp: 1900, source: 'command' }
    }, {}, baseDeps({ fetch }));

    assert.equal(sentBody.event.payload.change.cause.type, 'APP_INTERACTION');
});

test('identical reported/previous state is a no-op: fetch is never called', async () => {
    let fetchCalled = false;
    const fetch = async () => { fetchCalled = true; return { status: 202, text: async () => '' }; };

    const state = { power: 'ON', brightness: 80, reachable: true, timestamp: 2000, source: 'poll' };
    await changeReport({
        thingName: 'apollo-kitchen',
        reported: state,
        previous: { ...state, timestamp: 1000 }
    }, {}, baseDeps({ fetch }));

    assert.equal(fetchCalled, false);
});

test('position delta below the noise threshold (20 -> 23) is skipped, no fetch', async () => {
    let fetchCalled = false;
    const fetch = async () => { fetchCalled = true; return { status: 202, text: async () => '' }; };

    await changeReport({
        thingName: 'apollo-blackout-shade-one',
        reported: { position: 23, reachable: true, timestamp: 2000, source: 'poll' },
        previous: { position: 20, reachable: true, timestamp: 1000, source: 'poll' }
    }, {}, baseDeps({ fetch }));

    assert.equal(fetchCalled, false);
});

test('position hitting a boundary (20 -> 100) is sent even though the same-sized non-boundary delta would be damped', async () => {
    let sentBody;
    const fetch = async (url, options) => {
        sentBody = JSON.parse(options.body);
        return { status: 202, text: async () => '' };
    };

    await changeReport({
        thingName: 'apollo-blackout-shade-one',
        reported: { position: 100, reachable: true, timestamp: 2000, source: 'poll' },
        previous: { position: 20, reachable: true, timestamp: 1000, source: 'poll' }
    }, {}, baseDeps({ fetch }));

    const changedNames = sentBody.event.payload.change.properties.map((p) => p.name);
    assert.deepEqual(changedNames, ['percentage']);
});

test('brightness-only change on a dimmable light is sent; power stays in context.properties', async () => {
    let sentBody;
    const fetch = async (url, options) => {
        sentBody = JSON.parse(options.body);
        return { status: 202, text: async () => '' };
    };

    await changeReport({
        thingName: 'apollo-kitchen',
        reported: { power: 'ON', brightness: 90, reachable: true, timestamp: 2000, source: 'event' },
        previous: { power: 'ON', brightness: 40, reachable: true, timestamp: 1000, source: 'event' }
    }, {}, baseDeps({ fetch }));

    const changedNames = sentBody.event.payload.change.properties.map((p) => p.name);
    assert.deepEqual(changedNames, ['brightness']);

    const contextNames = sentBody.context.properties.map((p) => p.name);
    assert.ok(contextNames.includes('powerState'));
    assert.ok(contextNames.includes('connectivity'));
});

test('unflagged endpoint (no statefulMqtt) is skipped without ever reading tokens', async () => {
    let tokensRead = false;
    const getTokens = async () => { tokensRead = true; return VALID_TOKENS; };
    let fetchCalled = false;
    const fetch = async () => { fetchCalled = true; return { status: 202, text: async () => '' }; };

    await changeReport({
        thingName: 'apollo-ceiling',
        reported: { power: 'ON', reachable: true, timestamp: 2000, source: 'event' },
        previous: { power: 'OFF', reachable: true, timestamp: 1000, source: 'event' }
    }, {}, baseDeps({ getTokens, fetch }));

    assert.equal(tokensRead, false);
    assert.equal(fetchCalled, false);
});

test('missing SSM tokens (account not linked yet) is a quiet no-op', async () => {
    let fetchCalled = false;
    const fetch = async () => { fetchCalled = true; return { status: 202, text: async () => '' }; };

    await changeReport({
        thingName: 'apollo-kitchen',
        reported: { power: 'ON', reachable: true, timestamp: 2000, source: 'event' },
        previous: { power: 'OFF', reachable: true, timestamp: 1000, source: 'event' }
    }, {}, baseDeps({ getTokens: async () => null, fetch }));

    assert.equal(fetchCalled, false);
});

test('expired token is refreshed before sending, and SSM is updated with the new tokens', async () => {
    const calls = [];
    const fetch = async (url, options) => {
        calls.push({ url, body: options.body });
        if (url === 'https://api.amazon.com/auth/o2/token') {
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ access_token: 'AT-new', refresh_token: 'RT-new', expires_in: 3600 })
            };
        }
        return { status: 202, text: async () => '' };
    };

    let putTokensCall;
    const putTokens = async (tokens) => { putTokensCall = tokens; };

    const expiredTokens = { access_token: 'AT-old', refresh_token: 'RT-old', expires_in: 100, obtained_at: 0 };

    await changeReport({
        thingName: 'apollo-kitchen',
        reported: { power: 'ON', reachable: true, timestamp: 2000, source: 'event' },
        previous: { power: 'OFF', reachable: true, timestamp: 1000, source: 'event' }
    }, {}, baseDeps({
        getTokens: async () => expiredTokens,
        putTokens,
        fetch,
        now: () => 1000
    }));

    assert.equal(calls.length, 2, 'expected one refresh call and one ChangeReport POST');
    assert.equal(calls[0].url, 'https://api.amazon.com/auth/o2/token');
    assert.match(calls[0].body, /grant_type=refresh_token/);
    assert.match(calls[0].body, /refresh_token=RT-old/);
    assert.equal(calls[1].url, 'https://api.amazonalexa.com/v3/events');

    const sentEventBody = JSON.parse(calls[1].body);
    assert.equal(sentEventBody.event.endpoint.scope.token, 'AT-new', 'the ChangeReport itself should use the refreshed token');

    assert.equal(putTokensCall.access_token, 'AT-new');
    assert.equal(putTokensCall.refresh_token, 'RT-new');
    assert.equal(putTokensCall.obtained_at, 1000);
});

test('token refresh keeps the old refresh_token when LWA omits one from the response', async () => {
    const fetch = async (url) => {
        if (url === 'https://api.amazon.com/auth/o2/token') {
            return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'AT-new', expires_in: 3600 }) };
        }
        return { status: 202, text: async () => '' };
    };

    let putTokensCall;
    const putTokens = async (tokens) => { putTokensCall = tokens; };
    const expiredTokens = { access_token: 'AT-old', refresh_token: 'RT-keep-me', expires_in: 100, obtained_at: 0 };

    await changeReport({
        thingName: 'apollo-kitchen',
        reported: { power: 'ON', reachable: true, timestamp: 2000, source: 'event' },
        previous: { power: 'OFF', reachable: true, timestamp: 1000, source: 'event' }
    }, {}, baseDeps({ getTokens: async () => expiredTokens, putTokens, fetch, now: () => 1000 }));

    assert.equal(putTokensCall.refresh_token, 'RT-keep-me');
});

test('gateway 401 is logged and not retried, and never throws', async () => {
    let fetchCallCount = 0;
    const fetch = async () => { fetchCallCount += 1; return { status: 401, text: async () => 'invalid token' }; };

    await assert.doesNotReject(changeReport({
        thingName: 'apollo-kitchen',
        reported: { power: 'ON', reachable: true, timestamp: 2000, source: 'event' },
        previous: { power: 'OFF', reachable: true, timestamp: 1000, source: 'event' }
    }, {}, baseDeps({ fetch })));

    assert.equal(fetchCallCount, 1, 'a 401/403 must not be retried');
});

test('gateway 500 is logged and not retried, and never throws', async () => {
    let fetchCallCount = 0;
    const fetch = async () => { fetchCallCount += 1; return { status: 500, text: async () => 'server error' }; };

    await assert.doesNotReject(changeReport({
        thingName: 'apollo-kitchen',
        reported: { power: 'ON', reachable: true, timestamp: 2000, source: 'event' },
        previous: { power: 'OFF', reachable: true, timestamp: 1000, source: 'event' }
    }, {}, baseDeps({ fetch })));

    assert.equal(fetchCallCount, 1);
});

test('a fetch that throws (network failure) is caught and never propagates', async () => {
    const fetch = async () => { throw new Error('ECONNRESET'); };

    await assert.doesNotReject(changeReport({
        thingName: 'apollo-kitchen',
        reported: { power: 'ON', reachable: true, timestamp: 2000, source: 'event' },
        previous: { power: 'OFF', reachable: true, timestamp: 1000, source: 'event' }
    }, {}, baseDeps({ fetch })));
});

test('unknown endpoint (no matching trigger) is a quiet no-op', async () => {
    let fetchCalled = false;
    const fetch = async () => { fetchCalled = true; return { status: 202, text: async () => '' }; };

    await changeReport({
        thingName: 'apollo-nonexistent',
        reported: { power: 'ON', reachable: true, timestamp: 2000, source: 'event' },
        previous: null
    }, {}, baseDeps({ fetch }));

    assert.equal(fetchCalled, false);
});

test('malformed event (no thingName) is a quiet no-op, never throws', async () => {
    let fetchCalled = false;
    const fetch = async () => { fetchCalled = true; return { status: 202, text: async () => '' }; };

    await assert.doesNotReject(changeReport({ reported: { power: 'ON' } }, {}, baseDeps({ fetch })));
    assert.equal(fetchCalled, false);
});

test('shades: first-ever report (previous null) reports position with no baseline to diff against', async () => {
    let sentBody;
    const fetch = async (url, options) => {
        sentBody = JSON.parse(options.body);
        return { status: 202, text: async () => '' };
    };

    await changeReport({
        thingName: 'apollo-blackout-shade-one',
        reported: { position: 42, reachable: true, timestamp: 2000, source: 'event' },
        previous: null
    }, {}, baseDeps({ fetch }));

    const changedNames = sentBody.event.payload.change.properties.map((p) => p.name);
    assert.deepEqual(changedNames, ['percentage']);
});
