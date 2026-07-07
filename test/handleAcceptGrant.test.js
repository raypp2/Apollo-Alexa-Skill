import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleAcceptGrant } from '../handleAcceptGrant.mjs';

process.env.ALEXA_CLIENT_ID = 'test-client-id';
process.env.ALEXA_CLIENT_SECRET = 'test-client-secret';

function acceptGrantDirective(code) {
    const payload = {
        grantee: { type: 'BearerToken', token: 'grantee-access-token' }
    };
    if (code !== undefined) {
        payload.grant = { type: 'OAuth2.AuthorizationCode', code };
    } else {
        payload.grant = { type: 'OAuth2.AuthorizationCode' };
    }
    return {
        directive: {
            header: {
                namespace: 'Alexa.Authorization',
                name: 'AcceptGrant',
                payloadVersion: '3',
                messageId: 'msg-accept-grant-1'
            },
            payload
        }
    };
}

test('happy path: exchanges the grant code, writes tokens to SSM, returns AcceptGrant.Response', async () => {
    let fetchCall;
    const fetch = async (url, options) => {
        fetchCall = { url, options };
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 })
        };
    };

    let putTokensCall;
    const putTokens = async (tokens) => { putTokensCall = tokens; };

    const response = await handleAcceptGrant(
        acceptGrantDirective('grant-code-123'),
        {},
        { fetch, putTokens, now: () => 1000 }
    );

    assert.equal(fetchCall.url, 'https://api.amazon.com/auth/o2/token');
    assert.equal(fetchCall.options.method, 'POST');
    assert.match(fetchCall.options.body, /grant_type=authorization_code/);
    assert.match(fetchCall.options.body, /code=grant-code-123/);
    assert.match(fetchCall.options.body, /client_id=test-client-id/);
    assert.match(fetchCall.options.body, /client_secret=test-client-secret/);

    assert.deepEqual(putTokensCall, {
        access_token: 'AT1',
        refresh_token: 'RT1',
        expires_in: 3600,
        obtained_at: 1000
    });

    assert.equal(response.event.header.namespace, 'Alexa.Authorization');
    assert.equal(response.event.header.name, 'AcceptGrant.Response');
    assert.equal(response.event.header.messageId, 'msg-accept-grant-1');
    assert.deepEqual(response.event.payload, {});
});

test('LWA rejection returns an Alexa.Authorization ErrorResponse with ACCEPT_GRANT_FAILED', async () => {
    const fetch = async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'bad code' })
    });

    let putTokensCalled = false;
    const putTokens = async () => { putTokensCalled = true; };

    const response = await handleAcceptGrant(acceptGrantDirective('bad-code'), {}, { fetch, putTokens });

    assert.equal(response.event.header.namespace, 'Alexa.Authorization');
    assert.equal(response.event.header.name, 'ErrorResponse');
    assert.equal(response.event.payload.type, 'ACCEPT_GRANT_FAILED');
    assert.ok(response.event.payload.message, 'expected a useful error message');
    assert.equal(putTokensCalled, false, 'must not attempt to store tokens after a failed exchange');
});

test('SSM write failure after a successful exchange still returns ACCEPT_GRANT_FAILED', async () => {
    const fetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 })
    });

    const putTokens = async () => { throw new Error('SSM unavailable'); };

    const response = await handleAcceptGrant(acceptGrantDirective('grant-code-123'), {}, { fetch, putTokens });

    assert.equal(response.event.header.name, 'ErrorResponse');
    assert.equal(response.event.payload.type, 'ACCEPT_GRANT_FAILED');
});

test('missing payload.grant.code returns ACCEPT_GRANT_FAILED without calling fetch', async () => {
    const fetch = async () => { throw new Error('fetch should not be called'); };

    const response = await handleAcceptGrant(acceptGrantDirective(undefined), {}, { fetch });

    assert.equal(response.event.header.name, 'ErrorResponse');
    assert.equal(response.event.payload.type, 'ACCEPT_GRANT_FAILED');
});
