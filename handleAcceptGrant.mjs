import { exchangeAuthorizationCode, defaultPutTokens } from './alexaEventGatewayAuth.mjs';

/**
 * Builds the spec-required Alexa.Authorization ErrorResponse for a failed AcceptGrant.
 * @param {object} directive - request.directive (may lack a payload/grant if the failure is
 *   "the directive itself was malformed")
 * @param {string} message
 * @returns {object}
 */
function buildErrorResponse(directive, message) {
    return {
        event: {
            header: {
                namespace: 'Alexa.Authorization',
                name: 'ErrorResponse',
                payloadVersion: '3',
                messageId: (directive && directive.header && directive.header.messageId) || undefined
            },
            payload: {
                type: 'ACCEPT_GRANT_FAILED',
                message
            }
        }
    };
}

/**
 * Handles `namespace: "Alexa.Authorization", name: "AcceptGrant"` directives: exchanges the
 * grant code Alexa hands us during account linking for an Alexa Event Gateway access/refresh
 * token pair, and persists them to SSM Parameter Store so changeReport.mjs can use them later.
 * Without this, account linking "succeeds" from Alexa's point of view but no tokens ever
 * exist, so ChangeReport can never authenticate to the Event Gateway.
 * @param {object} event - the Alexa directive event
 * @param {object} context - the Lambda context (unused, kept for signature parity with the
 *   other handle* functions)
 * @param {object} [deps] - injection point for tests
 * @param {function} [deps.fetch] - defaults to global fetch
 * @param {function(object): Promise<void>} [deps.putTokens] - defaults to defaultPutTokens (SSM)
 * @param {function(): number} [deps.now] - defaults to current epoch seconds; used to stamp
 *   `obtained_at`
 * @returns {Promise<object>} AcceptGrant.Response or Alexa.Authorization ErrorResponse
 */
async function handleAcceptGrant(event, context, deps = {}) {
    const doFetch = deps.fetch || fetch;
    const putTokens = deps.putTokens || defaultPutTokens;
    const now = deps.now || (() => Math.floor(Date.now() / 1000));

    const directive = event && event.directive;
    const code = directive && directive.payload && directive.payload.grant && directive.payload.grant.code;

    if (!code) {
        console.error('AcceptGrant directive missing payload.grant.code:', JSON.stringify(event));
        return buildErrorResponse(directive, 'AcceptGrant directive is missing payload.grant.code');
    }

    let tokenResponse;
    try {
        tokenResponse = await exchangeAuthorizationCode(code, doFetch);
    } catch (err) {
        // Log the LWA error body -- debugging grant failures blind (with only "it failed") is
        // miserable, and this is the one place that body is available.
        console.error('LWA authorization_code exchange failed:', err.message);
        return buildErrorResponse(directive, `LWA token exchange failed: ${err.message}`);
    }

    const tokens = {
        access_token: tokenResponse.access_token,
        refresh_token: tokenResponse.refresh_token,
        expires_in: tokenResponse.expires_in,
        obtained_at: now()
    };

    try {
        await putTokens(tokens);
    } catch (err) {
        console.error('Failed to persist Alexa Event Gateway tokens to SSM:', err.message);
        return buildErrorResponse(directive, `Failed to store Event Gateway tokens: ${err.message}`);
    }

    const header = { ...directive.header, name: 'AcceptGrant.Response' };
    console.log('AcceptGrant.Response:', JSON.stringify({ header, payload: {} }));
    return { event: { header, payload: {} } };
}

export { handleAcceptGrant };
