import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../index.mjs';

function discoverDirective() {
    return {
        directive: {
            header: {
                namespace: 'Alexa.Discovery',
                name: 'Discover',
                payloadVersion: '3',
                messageId: 'msg-discover-1'
            },
            payload: {
                scope: { type: 'BearerToken', token: 'test-token' }
            }
        }
    };
}

// Regression guard for Stage 7's ChangeReport routing (index.mjs's handler now checks
// `thingName` before `directive`, since the IoT Rule invokes this same Lambda with a
// non-directive event shape). This test process never loads a real triggers.json (it's
// gitignored and absent here), so triggersMap is empty and every endpointId lookup misses --
// that's fine, these tests only assert routing, not device-specific behavior.

test('directive routing is unaffected: an Alexa.Discovery directive still returns Discover.Response', async () => {
    const response = await handler(discoverDirective(), {});
    assert.equal(response.event.header.namespace, 'Alexa.Discovery');
    assert.equal(response.event.header.name, 'Discover.Response');
});

test('a non-directive shadow-change event ({thingName, reported, previous}) does not fall into directive dispatch', async () => {
    // If the thingName branch in index.mjs were missing (or ordered after the directive
    // checks), `request.directive.header.namespace` would throw a TypeError here, since this
    // event shape has no `directive` key at all. The real routing target (changeReport)
    // quietly no-ops for an endpoint with no matching trigger.
    await assert.doesNotReject(handler({
        thingName: 'apollo-some-endpoint',
        reported: { power: 'ON', reachable: true, timestamp: Math.floor(Date.now() / 1000), source: 'event' },
        previous: null
    }, {}));
});

test('a directive event is never routed to changeReport, even if it happens to carry extra keys', async () => {
    // Belt-and-suspenders: a directive-shaped event augmented with unrelated keys must still
    // go through the normal directive dispatch, not the thingName branch (which requires the
    // ABSENCE of `directive`, not just the presence of some other key).
    const directiveWithExtraKeys = discoverDirective();
    directiveWithExtraKeys.someUnrelatedKey = 'noise';

    const response = await handler(directiveWithExtraKeys, {});
    assert.equal(response.event.header.namespace, 'Alexa.Discovery');
});
