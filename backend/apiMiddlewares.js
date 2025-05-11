import { baseShopifyApi as shopify } from './shopify.js';

// In-memory cache for valid Shopify sessions for background tasks
// Consider replacing with a more persistent cache if scaling or long-term persistence is needed
const validShopSessions = {};

// Middleware for API Route Token Validation
export const verifyApiRequest = async (req, res, next) => {
    const shop = req.query.shop;
    const authHeader = req.headers.authorization;
    console.log(`[verifyApiRequest] Checking token for shop: ${shop}`);

    if (!shop) {
        return res.status(400).send('Bad Request: Shop parameter missing.');
    }
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.log('[verifyApiRequest] Missing or invalid Authorization header.');
        console.log('[verifyApiRequest] Raw Authorization Header Received:', req.headers.authorization);
        return res.status(401).send('Unauthorized: Missing or invalid token.');
    }

    const token = authHeader.split(' ')[1];
    console.log('[verifyApiRequest] Extracted token from header:', token);
    if (!token) {
        console.log('[verifyApiRequest] Token could not be extracted or is empty after split.');
        return res.status(401).send('Unauthorized: Malformed token.');
    }

    let shopDetailsResponse = null;
    try {
        console.log(`[verifyApiRequest] Verifying token for ${shop} via API call...`);
        const client = new shopify.clients.Rest({
            session: { 
              shop: shop,
              accessToken: token,
              isOnline: false, 
            }
        });
        shopDetailsResponse = await client.get({ path: 'shop' });

        console.log('[verifyApiRequest] Raw shopDetailsResponse structure:', shopDetailsResponse ? Object.keys(shopDetailsResponse) : 'null/undefined');
        try {
            console.log('[verifyApiRequest] Raw shopDetailsResponse content:', JSON.stringify(shopDetailsResponse, null, 2));
        } catch (e) {
            console.error('[verifyApiRequest] Could not stringify shopDetailsResponse:', e);
            console.log('[verifyApiRequest] Raw shopDetailsResponse (direct):', shopDetailsResponse);
        }

        if (shopDetailsResponse && shopDetailsResponse.body && shopDetailsResponse.body.shop) {
            console.log(`[verifyApiRequest] Token verified successfully for ${shop} (found shop body).`);
            req.shop = shop;
            req.token = token; 
            next();
        } else {
            console.error(`[verifyApiRequest] Token verification API call succeeded but response lacked expected body.shop for ${shop}. Response:`, shopDetailsResponse);
            return res.status(502).send('Bad Gateway: Could not verify token with Shopify due to unexpected API response structure.');
        }
    } catch (error) {
        console.error(`[verifyApiRequest] Exception during token verification process for ${shop}.`);
        console.error('[verifyApiRequest] Error Name:', error.name);
        console.error('[verifyApiRequest] Error Message:', error.message);
        if (error.stack) {
            console.error('[verifyApiRequest] Error Stack:', error.stack);
        }
        if (error.response && error.response.status) { 
             console.error('[verifyApiRequest] Caught error with response status:', error.response.status);
             return res.status(error.response.status).send(`Unauthorized: Verification failed (${error.message})`);
        } else if (error.name === 'FetchError' || error instanceof TypeError) { 
             console.error(`[verifyApiRequest] Network or fetch-related error during verification.`);
             return res.status(503).send(`Service Unavailable: Could not reach Shopify API for verification (${error.message})`);
        } else {
             console.error('[verifyApiRequest] Caught non-response, non-network error.');
             return res.status(500).send('Internal Server Error during token verification.');
        }
    }
};

// Middleware for API Route Session Validation from Shopify session storage
export const validateSession = async (req, res, next) => {
    const shop = req.query.shop || req.body.shop;
    console.log(`[validateSession] Checking session for shop: ${shop}`);
    if (!shop) {
        return res.status(400).send('Bad Request: Shop parameter missing.');
    }

    try {
        const sessionStorage = shopify.config.sessionStorage;
        const sessions = await sessionStorage.findSessionsByShop(shop);
        if (sessions && sessions.length > 0) {
            req.shopifySession = sessions[0]; // Attach the first found session (usually the offline one)

            // Store/update the session in our in-memory cache for background tasks
            if (sessions[0].accessToken) {
                validShopSessions[shop] = sessions[0];
                console.log(`[validateSession] Stored/refreshed valid session for background tasks (shop: ${shop})`);
            }

            console.log(`[validateSession] Session found for shop ${shop}. Proceeding.`);
            next();
        } else {
            console.log(`[validateSession] No session found for shop ${shop}. Sending 401.`);
            return res.status(401).send('Unauthorized: No active session found.');
        }
    } catch (error) {
        console.error(`[validateSession] Error checking session for shop ${shop}:`, error);
        return res.status(500).send('Internal Server Error during session validation.');
    }
};

// Function to get a valid session from the cache (used by background processes like statusMonitor)
export function getValidShopSession(shop) {
    return validShopSessions[shop] || null;
}

// Function to set/update a session in the cache (could be used after explicit re-auth or token refresh)
export function setValidShopSession(shop, session) {
    if (shop && session && session.accessToken) {
        validShopSessions[shop] = session;
        console.log(`[SessionCache] Manually set/updated session for shop ${shop}.`);
    } else {
        console.warn(`[SessionCache] Attempted to set invalid session for shop ${shop}.`);
    }
} 