// Shared Login-with-Amazon (LWA) token exchange/refresh + SSM Parameter Store persistence
// for the Alexa Event Gateway (proactive events -- POST https://api.amazonalexa.com/v3/events).
// Both handleAcceptGrant.mjs (initial account-linking exchange) and changeReport.mjs (reading
// + refreshing the stored tokens before sending a ChangeReport) need this, so it lives in one
// place rather than being forked between them.

// SSM Parameter Store (SecureString) holding the current token set as JSON:
// {access_token, refresh_token, expires_in, obtained_at}. `obtained_at` is epoch seconds and
// is stamped by whichever caller last wrote the parameter (handleAcceptGrant.mjs on initial
// link, changeReport.mjs on refresh).
const SSM_PARAMETER_NAME = '/apollo/alexa/eventgateway-tokens';

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

let cachedSsmClient = null;

/**
 * Lazily builds (and caches) the SSM client. Not called at module load time -- only when a
 * real (non-injected) getTokens/putTokens path actually runs -- so importing this module
 * never requires AWS credentials or makes a network call. Tests inject their own
 * getTokens/putTokens and never exercise this.
 */
async function getSsmClient() {
    if (!cachedSsmClient) {
        const { SSMClient } = await import('@aws-sdk/client-ssm');
        cachedSsmClient = new SSMClient({ region: process.env.sqsRegion || 'us-east-1' });
    }
    return cachedSsmClient;
}

/**
 * Reads and JSON-parses the Event Gateway tokens from SSM Parameter Store. Returns null
 * (rather than throwing) when the parameter doesn't exist yet -- that's the normal state
 * before AcceptGrant has ever run, and callers (changeReport.mjs) treat it as "account not
 * linked yet, quietly skip" rather than an error.
 * @returns {Promise<{access_token:string, refresh_token:string, expires_in:number, obtained_at:number}|null>}
 */
async function defaultGetTokens() {
    const client = await getSsmClient();
    const { GetParameterCommand } = await import('@aws-sdk/client-ssm');
    try {
        const response = await client.send(
            new GetParameterCommand({ Name: SSM_PARAMETER_NAME, WithDecryption: true })
        );
        return JSON.parse(response.Parameter.Value);
    } catch (err) {
        if (err && (err.name === 'ParameterNotFound' || err.name === 'ParameterNotFoundError')) {
            return null;
        }
        throw err;
    }
}

/**
 * Overwrites the Event Gateway tokens SecureString parameter with a fresh token set.
 * @param {{access_token:string, refresh_token:string, expires_in:number, obtained_at:number}} tokens
 * @returns {Promise<void>}
 */
async function defaultPutTokens(tokens) {
    const client = await getSsmClient();
    const { PutParameterCommand } = await import('@aws-sdk/client-ssm');
    await client.send(new PutParameterCommand({
        Name: SSM_PARAMETER_NAME,
        Value: JSON.stringify(tokens),
        Type: 'SecureString',
        Overwrite: true
    }));
}

/**
 * POSTs a form-encoded body to the LWA token endpoint and returns the parsed JSON response.
 * Throws (with the response body included in the message -- LWA error bodies are the only
 * useful debugging signal when a grant/refresh fails) on any non-2xx response.
 * @param {URLSearchParams} body
 * @param {function} doFetch - injectable fetch
 * @returns {Promise<object>}
 */
async function postToLwa(body, doFetch) {
    const response = await doFetch(LWA_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });

    const text = await response.text();

    if (!response.ok) {
        throw new Error(`LWA token endpoint returned ${response.status}: ${text}`);
    }

    return JSON.parse(text);
}

function requireLwaCredentials() {
    const clientId = process.env.ALEXA_CLIENT_ID;
    const clientSecret = process.env.ALEXA_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('ALEXA_CLIENT_ID / ALEXA_CLIENT_SECRET environment variables are not set');
    }
    return { clientId, clientSecret };
}

/**
 * Exchanges an AcceptGrant authorization `code` for an access/refresh token pair at the LWA
 * token endpoint.
 * @param {string} code
 * @param {function} doFetch - injectable fetch
 * @returns {Promise<{access_token:string, refresh_token:string, expires_in:number}>}
 */
async function exchangeAuthorizationCode(code, doFetch) {
    const { clientId, clientSecret } = requireLwaCredentials();
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret
    });
    return postToLwa(body, doFetch);
}

/**
 * Exchanges a stored refresh_token for a fresh access_token (and possibly a new
 * refresh_token -- LWA doesn't always rotate it, so callers should fall back to the old one
 * when the response omits it).
 * @param {string} refreshToken
 * @param {function} doFetch - injectable fetch
 * @returns {Promise<{access_token:string, refresh_token:string, expires_in:number}>}
 */
async function refreshAccessToken(refreshToken, doFetch) {
    const { clientId, clientSecret } = requireLwaCredentials();
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret
    });
    return postToLwa(body, doFetch);
}

export {
    SSM_PARAMETER_NAME,
    LWA_TOKEN_URL,
    defaultGetTokens,
    defaultPutTokens,
    exchangeAuthorizationCode,
    refreshAccessToken
};
