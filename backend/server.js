import 'dotenv/config'; 
// --- ALL OTHER IMPORTS GO BELOW THIS LINE ---
import express from 'express';
import path from 'path';
import fs from 'fs/promises'; // Import fs.promises for reading the HTML file
import { fileURLToPath } from 'url'; // Needed for __dirname in ES modules
import { Buffer } from 'buffer'; // Needed for Base64 encoding
import cookieParser from 'cookie-parser'; // Import cookie-parser
import crypto from 'crypto'; // Import crypto for nonce generation
import cookie from 'cookie'; // Import the cookie library here
// Import the creator function and the base API
import createShopifyAppInstance, { baseShopifyApi as shopify } from './shopify.js'; 
import { Session } from '@shopify/shopify-api'; // Import Session class
// REMOVE import db from './db.js'; // Import the database connection
import { supabase } from './supabaseClient.js'; // ADD Supabase client import

// Define __dirname for ES module scope
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ADDED: Log loaded HOST right after dotenv
console.log(`[dotenv] Loaded HOST: ${process.env.HOST}`); 
// ADDED: Log loaded API Key
console.log(`[dotenv] Loaded API Key: ${process.env.SHOPIFY_API_KEY ? 'Exists' : 'MISSING!'}`); 

// --- BEGIN ADDED DEBUG LOGS ---
console.log(`DEBUG: SHOPIFY_API_KEY loaded: ${process.env.SHOPIFY_API_KEY ? 'Yes' : 'NO!'}`);
console.log(`DEBUG: SHOPIFY_API_SECRET loaded: ${process.env.SHOPIFY_API_SECRET ? 'Yes' : 'NO!'}`);
console.log(`DEBUG: Scopes: ${process.env.SHOPIFY_API_SCOPES}`);
// --- END ADDED DEBUG LOGS ---

// Validate essential env vars on startup
const { PORT, HOST, SHOPIFY_API_KEY } = process.env; // Add SHOPIFY_API_KEY here
if (!HOST) {
    console.error('Error: HOST environment variable is not set in backend/.env (or failed to load)');
    process.exit(1);
}
// Add validation for API Key
if (!SHOPIFY_API_KEY) {
    console.error('Error: SHOPIFY_API_KEY environment variable is not set in backend/.env');
    process.exit(1);
}

const app = express();

// --- Use cookie-parser middleware ---
app.use(cookieParser());

// --- Middleware for parsing JSON bodies --- 
app.use(express.json()); // Apply globally or specifically to POST routes

// --- Middleware for API Route Token Validation ---
const verifyApiRequest = async (req, res, next) => {
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

    let shopDetailsResponse = null; // Define outside try block
    try {
        // Attempt a simple authenticated call to verify the token
        console.log(`[verifyApiRequest] Verifying token for ${shop} via API call...`);
        
        const client = new shopify.clients.Rest({
            session: { 
              shop: shop,
              accessToken: token,
              isOnline: false, 
            }
        });

        shopDetailsResponse = await client.get({ path: 'shop' });

        // --- Log the entire response object immediately (KEEP FOR DEBUGGING) --- 
        console.log('[verifyApiRequest] Raw shopDetailsResponse structure:', shopDetailsResponse ? Object.keys(shopDetailsResponse) : 'null/undefined');
        try {
            console.log('[verifyApiRequest] Raw shopDetailsResponse content:', JSON.stringify(shopDetailsResponse, null, 2));
        } catch (e) {
            console.error('[verifyApiRequest] Could not stringify shopDetailsResponse:', e);
            console.log('[verifyApiRequest] Raw shopDetailsResponse (direct):', shopDetailsResponse);
        }
        // --- End Log ---

        // --- ADJUSTED CHECK: Assume success if body exists and no exception was thrown --- 
        if (shopDetailsResponse && shopDetailsResponse.body && shopDetailsResponse.body.shop) {
            // The call succeeded and returned the expected shop data
            console.log(`[verifyApiRequest] Token verified successfully for ${shop} (found shop body).`);
            req.shop = shop;
            req.token = token; 
            next(); // Token is valid, proceed
        } else {
            // The call completed but didn't return the expected structure, treat as failure.
            console.error(`[verifyApiRequest] Token verification API call succeeded but response lacked expected body.shop for ${shop}. Response:`, shopDetailsResponse);
            return res.status(502).send('Bad Gateway: Could not verify token with Shopify due to unexpected API response structure.');
        }
        // --- END ADJUSTED CHECK ---

    } catch (error) {
        // --- ENHANCED CATCH BLOCK --- 
        console.error(`[verifyApiRequest] Exception during token verification process for ${shop}.`);
        console.error('[verifyApiRequest] Error Name:', error.name);
        console.error('[verifyApiRequest] Error Message:', error.message);
        if (error.stack) {
            console.error('[verifyApiRequest] Error Stack:', error.stack);
        }

        // Check if it looks like a Shopify API response error
        if (error.response && error.response.status) { 
             console.error('[verifyApiRequest] Caught error with response status:', error.response.status);
             return res.status(error.response.status).send(`Unauthorized: Verification failed (${error.message})`);
        } 
        // Check for fetch/network related errors explicitly
        else if (error.name === 'FetchError' || error instanceof TypeError) { 
             console.error(`[verifyApiRequest] Network or fetch-related error during verification.`);
             return res.status(503).send(`Service Unavailable: Could not reach Shopify API for verification (${error.message})`);
        }
        // Generic fallback if it's not clearly a response or network error
        else {
             console.error('[verifyApiRequest] Caught non-response, non-network error.');
             return res.status(500).send('Internal Server Error during token verification.');
        }
        // --- END ENHANCED CATCH BLOCK --- 
    }
};

// --- Middleware for API Route Session Validation --- 
const validateSession = async (req, res, next) => {
    const shop = req.query.shop || req.body.shop; // Get shop from query or body
    console.log(`[validateSession] Checking session for shop: ${shop}`);
    if (!shop) {
        return res.status(400).send('Bad Request: Shop parameter missing.');
    }

    try {
        const sessionStorage = shopify.config.sessionStorage;
        const sessions = await sessionStorage.findSessionsByShop(shop);
        if (sessions && sessions.length > 0) {
            req.shopifySession = sessions[0]; // <-- Add this line to attach session
            console.log(`[validateSession] Session found for shop ${shop}. Proceeding.`);
            // Optionally attach session to request for later use: req.shopifySession = sessions[0];
            next(); // Session exists, continue to the actual route handler
        } else {
            console.log(`[validateSession] No session found for shop ${shop}. Sending 401.`);
            return res.status(401).send('Unauthorized: No active session found.');
        }
    } catch (error) {
        console.error(`[validateSession] Error checking session for shop ${shop}:`, error);
        return res.status(500).send('Internal Server Error during session validation.');
    }
};

// --- Create the instance by calling the function --- 
const shopifyAppInstance = createShopifyAppInstance();
console.log('[server.js] Received shopifyAppInstance:', typeof shopifyAppInstance);

// --- Define constants ---
const OAUTH_STATE_COOKIE_NAME = 'shopify_oauth_state';

// --- Add Shopify Auth Routes explicitly --- 
// These need to be defined *before* the wildcard '*'
app.get('/auth', async (req, res) => {
    const shop = req.query.shop;
    if (!shop) {
        // If shop is missing, we can't redirect. Send back to the enter-shop page or show error.
        // Re-serving enter-shop.html might be the simplest.
        console.log('[/auth] Shop parameter missing. Cannot initiate OAuth. Serving enter-shop page.');
        try {
            const enterShopHtmlPath = path.join(__dirname, 'enter-shop.html');
            return res.status(200).set('Content-Type', 'text/html').sendFile(enterShopHtmlPath);
        } catch (error) {
            console.error(`[/auth] Error sending enter-shop.html: ${error.message}`, error.stack);
            return res.status(500).send("Internal Server Error: Could not load shop entry page.");
        }
    }

    console.log(`[/auth] Initiating OAuth for shop: ${shop}`);
    try {
        const apiKey = shopify.config.apiKey;
        // --- MODIFIED: Get scopes from the configured library instance --- 
        const scopesString = shopify.config.scopes.toString(); // Get scopes from the library config
        // const scopesString = process.env.SHOPIFY_SCOPES || ''; // <-- OLD line to remove/comment out
        // --- END MODIFICATION ---
        const encodedScopes = encodeURIComponent(scopesString);
        const redirectUri = `${HOST}/auth/callback`;
        const encodedRedirectUri = encodeURIComponent(redirectUri);

        // --- Generate and set state cookie --- 
        const state = crypto.randomBytes(16).toString('hex'); // Generate random state
        console.log(`[/auth] Generated state nonce: ${state}`);
        res.cookie(OAUTH_STATE_COOKIE_NAME, state, {
            maxAge: 600000, // 10 minutes expiry
            httpOnly: true, // Prevent client-side JS access
            secure: true,   // Send only over HTTPS
            sameSite: 'None' // RESTORED: Required for cross-domain contexts
        });
        // --- End state cookie --- 

        // Construct the authorization URL (including state)
        const authUrl = `https://${encodeURIComponent(shop)}/admin/oauth/authorize?client_id=${apiKey}&scope=${encodedScopes}&redirect_uri=${encodedRedirectUri}&state=${state}`;

        console.log(`[/auth] Redirecting to Shopify OAuth URL. Scopes requested: ${scopesString}. State included.`); // Updated log
        res.redirect(authUrl);

    } catch (error) {
        console.error('[/auth] Error constructing OAuth URL:', error);
        res.status(500).send('Internal Server Error during authentication initiation.');
    }
});

// Custom middleware to validate OAuth state parameter against cookie
const validateOAuthState = (req, res, next) => {
    console.log('[/auth/callback] Running validateOAuthState middleware...');
    const { state: queryState } = req.query;
    const rawCookieHeader = req.headers.cookie || '';
    console.log('[/auth/callback] Raw Cookie Header:', rawCookieHeader);

    // Manually parse cookies
    const cookies = cookie.parse(rawCookieHeader);
    const stateCookie = cookies[OAUTH_STATE_COOKIE_NAME]; // Use the constant
    console.log('[/auth/callback] Parsed Cookies:', cookies); // Log all parsed cookies
    console.log(`[/auth/callback] Query State: ${queryState}`);
    console.log(`[/auth/callback] Cookie State (${OAUTH_STATE_COOKIE_NAME}): ${stateCookie}`);

    // Clear the state cookie (it's single-use) regardless of outcome
    console.log(`[/auth/callback] Clearing cookie: ${OAUTH_STATE_COOKIE_NAME}`);
    res.clearCookie(OAUTH_STATE_COOKIE_NAME);

    if (!queryState || !stateCookie || queryState !== stateCookie) {
        console.error('[/auth/callback] OAuth state validation FAILED.', {
             queryState: queryState,
             cookieState: stateCookie,
        });
        return res.status(403).send('Invalid OAuth state: CSRF detected or cookie missing/mismatch.');
    }

    console.log('[/auth/callback] OAuth state validated successfully via manual parse.');
    next(); // State is valid, proceed to the next middleware (auth.callback)
};

app.get(
  '/auth/callback',
  validateOAuthState, // 1. Validate state first
  // 2. Replace library callback with manual token exchange
  async (req, res) => {
    console.log('[/auth/callback] State validated. Proceeding with manual token exchange.');
    const { shop, code } = req.query;
    
    // Ensure we clear the state cookie again just in case
    res.clearCookie(OAUTH_STATE_COOKIE_NAME);

    if (!shop || !code) {
        console.error('[/auth/callback] Missing shop or code query parameter for token exchange.');
        return res.status(400).send('Invalid callback request: Missing shop or code.');
    }

    try {
        // Prepare request to Shopify token endpoint
        const tokenUrl = `https://${shop}/admin/oauth/access_token`;
        const tokenPayload = {
            client_id: shopify.config.apiKey,
            client_secret: shopify.config.apiSecretKey,
            code: code,
        };

        console.log(`[/auth/callback] Exchanging code for token at: ${tokenUrl}`);
        const tokenResponse = await fetch(tokenUrl, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Accept': 'application/json' 
            },
            body: JSON.stringify(tokenPayload),
        });

        const tokenData = await tokenResponse.json();

        if (!tokenResponse.ok || !tokenData.access_token) {
            console.error('[/auth/callback] Failed to exchange code for token:', tokenData);
            return res.status(tokenResponse.status).send(`Failed to get access token: ${JSON.stringify(tokenData)}`);
        }

        // --- ADD LOGGING: What scopes did Shopify return? ---
        console.log('[/auth/callback] Token exchange successful.');
        console.log(`[/auth/callback] ====> SCOPES RECEIVED FROM SHOPIFY: ${tokenData.scope}`); 
        // --- END LOGGING ---
        
        // --- Manually construct a proper Session instance --- 
        const sessionId = `${shop}_${tokenData.access_token}`;
        const session = new Session({
            id: sessionId,
            shop: shop,
            state: 'SOME_STATE_PLACEHOLDER', // Required by Session constructor, actual value might not matter for offline
            isOnline: false,
            accessToken: tokenData.access_token,
            scope: tokenData.scope, 
        });
        // --- ADD LOGGING: What session are we storing? ---
        console.log(`[/auth/callback] Session object PREPARED for storage:`, {
            id: session.id,
            shop: session.shop,
            isOnline: session.isOnline,
            accessTokenPrefix: session.accessToken?.substring(0,5),
            scope: session.scope // Log the scope we are putting in the session object
        });
        // --- END LOGGING ---
        // -----------------------------------------------------

        // Manually store the session instance
        console.log(`[/auth/callback] Storing session instance manually. ID: ${sessionId}`);
        const sessionStorage = shopify.config.sessionStorage;
        const stored = await sessionStorage.storeSession(session);
        if (!stored) {
            console.error('[/auth/callback] Failed to store session manually! storeSession returned false.');
            // Optionally, try loading right after storing to see if it failed silently
            const checkSession = await sessionStorage.loadSession(sessionId);
            console.log('[/auth/callback] Session check immediately after failed storeSession:', checkSession);
            return res.status(500).send('Failed to save session data.');
        }
        console.log('[/auth/callback] storeSession call completed successfully (returned true).');

        // --- ADD LOGGING: Load session immediately after storing to verify scope --- 
        console.log(`[/auth/callback] Attempting to load session ${sessionId} immediately after storing...`);
        const loadedSession = await sessionStorage.loadSession(sessionId);
        if (loadedSession) {
            console.log(`[/auth/callback] ====> Session loaded immediately AFTER storeSession has SCOPE: ${loadedSession.scope}`);
        } else {
            console.error(`[/auth/callback] FAILED to load session ${sessionId} immediately after storing!`);
        }
        // --- END LOGGING ---

        // --- Redirect to App --- 
        const redirectUrl = `/?shop=${encodeURIComponent(shop)}&token=${encodeURIComponent(tokenData.access_token)}`;
        console.log(`[/auth/callback] Redirecting to ${redirectUrl}`);
        res.redirect(redirectUrl);

    } catch (error) {
        console.error('[/auth/callback] Error during manual token exchange or session storage:', error);
        res.status(500).send('Internal Server Error during authentication callback.');
    }
  }
);

// --- REMOVE ALL API/WEBHOOK/AUTH MIDDLEWARE FOR SIMPLIFICATION ---
/*
// --- Webhook Route --- 
if (shopifyAppInstance?.config?.webhooks?.path && shopifyAppInstance?.processWebhooks) { ... }

// --- Logging Middleware for API routes ---
app.use('/api/*', (req, res, next) => { ... });

// --- Authenticated API Routes ---
if (shopifyAppInstance?.validateAuthenticatedSession) { ... }

// --- Add a simple /api/verify endpoint ---
app.get('/api/verify', (req, res) => { ... });

// Example API endpoint
app.get('/api/products', async (req, res) => { ... });
*/
// --- END REMOVED MIDDLEWARE ---

// --- Add a simple API endpoint to verify session validity (uses token validation now) ---
app.get('/api/verify-session', verifyApiRequest, (req, res) => {
    // If verifyApiRequest middleware passes, the token is valid.
    console.log(`[/api/verify-session] Token verified for shop: ${req.shop}`);
    res.status(200).send('Session/Token is valid');
});

// --- Endpoint to get collections (uses token validation now) ---
app.get('/api/collections', verifyApiRequest, async (req, res) => {
    const shop = req.shop; // Get from middleware
    const token = req.token; // Get from middleware
    console.log(`[/api/collections] Request for shop: ${shop}`);

    try {
        const client = new shopify.clients.Rest({
            session: { shop: shop, accessToken: token, isOnline: false }
        });

        // Fetch Smart Collections
        const smartCollectionsResponse = await client.get({
            path: 'smart_collections',
            query: { fields: 'id,handle,title' }
        });
        // --- Add Logging ---
        console.log('[/api/collections] Raw smartCollectionsResponse:', JSON.stringify(smartCollectionsResponse, null, 2));
        // Fetch Custom Collections
        const customCollectionsResponse = await client.get({
            path: 'custom_collections',
            query: { fields: 'id,handle,title' }
        });
        // --- Add Logging ---
        console.log('[/api/collections] Raw customCollectionsResponse:', JSON.stringify(customCollectionsResponse, null, 2));

        // --- ADJUSTED CHECK: Assume success if body exists and no exception was thrown --- 
        // Check if *both* responses seem valid by checking for their expected body structure
        const smartOK = smartCollectionsResponse && smartCollectionsResponse.body && typeof smartCollectionsResponse.body.smart_collections !== 'undefined';
        const customOK = customCollectionsResponse && customCollectionsResponse.body && typeof customCollectionsResponse.body.custom_collections !== 'undefined';

        if (!smartOK || !customOK) {
             console.error(`[/api/collections] Failed to fetch collections or response structure invalid for shop ${shop}. Smart Valid: ${smartOK}, Custom Valid: ${customOK}`);
             // Log the responses again on failure
             if (!smartOK) console.error('[/api/collections] Invalid smartCollectionsResponse:', JSON.stringify(smartCollectionsResponse));
             if (!customOK) console.error('[/api/collections] Invalid customCollectionsResponse:', JSON.stringify(customCollectionsResponse));
             // Use 502 for bad gateway / unexpected response from Shopify
             return res.status(502).send('Error fetching collections from Shopify (Bad Gateway or invalid response).'); 
        }
        // --- END ADJUSTED CHECK ---

        // Extract data (safe due to checks above)
        const smartCollections = smartCollectionsResponse.body.smart_collections || []; // Use default if key exists but is null/undefined
        const customCollections = customCollectionsResponse.body.custom_collections || []; // Use default if key exists but is null/undefined

        const allCollections = [
            ...smartCollections.map(col => ({ label: col.title, value: `gid://shopify/Collection/${col.id}` })), // Use GID format
            ...customCollections.map(col => ({ label: col.title, value: `gid://shopify/Collection/${col.id}` }))  // Use GID format
        ];

        console.log(`[/api/collections] Found ${allCollections.length} collections for shop ${shop}`);
        res.status(200).json(allCollections);

    } catch (error) {
        // --- ENHANCED CATCH BLOCK --- 
        console.error(`[/api/collections] Exception during collection fetch process for ${shop}.`);
        console.error('[/api/collections] Error Name:', error.name);
        console.error('[/api/collections] Error Message:', error.message);
        if (error.stack) {
            console.error('[/api/collections] Error Stack:', error.stack);
        }

        // Check if it looks like a Shopify API response error from the underlying client library
        // (Error structure might vary, check based on observed errors)
        if (error.response && error.response.status) { 
             console.error('[/api/collections] Caught error with response status:', error.response.status);
             return res.status(error.response.status).send(`Error fetching collections: ${error.message}`);
        } 
        // Check for fetch/network related errors explicitly (less likely here if client handles it, but good practice)
        else if (error.name === 'FetchError' || error instanceof TypeError) { 
             console.error(`[/api/collections] Network or fetch-related error during collection fetch.`);
             return res.status(503).send(`Service Unavailable: Could not reach Shopify API for collections (${error.message})`);
        }
        // Generic fallback
        else {
             console.error('[/api/collections] Caught non-response, non-network error.');
             return res.status(500).send('Internal Server Error fetching collections.');
        }
        // --- END ENHANCED CATCH BLOCK --- 
    }
});

// --- Endpoint to get products by collection ID --- 
app.get('/api/products-by-collection', verifyApiRequest, async (req, res) => {
    // Token and shop are verified and attached by verifyApiRequest middleware
    const shop = req.shop; 
    const token = req.token;
    const collectionIdQuery = req.query.collectionId; // e.g., gid://shopify/Collection/12345

    // --- Pagination (REVERTED) --- 
    // const page = parseInt(req.query.page, 10) || 1; // Default to page 1
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 50); // Limit to 50, remove page
    // --- End Pagination ---

    console.log(`[/api/products-by-collection] Request for shop: ${shop}, collectionIdQuery: ${collectionIdQuery}, limit: ${limit}`); // Updated log

    if (!collectionIdQuery) {
        return res.status(400).send('Bad Request: collectionId parameter is missing.');
    }

    // Extract the numeric ID from the GID format
    const collectionIdMatch = collectionIdQuery.match(/\d+$/);
    if (!collectionIdMatch) {
        console.error(`[/api/products-by-collection] Invalid collectionId format: ${collectionIdQuery}`);
        return res.status(400).send('Bad Request: Invalid collectionId format.');
    }
    const collectionId = collectionIdMatch[0];
    console.log(`[/api/products-by-collection] Extracted numeric collection ID: ${collectionId}`);

    try {
        // Create authenticated REST client using verified token
        const client = new shopify.clients.Rest({
             session: { 
               shop: shop,
               accessToken: token,
               isOnline: false, 
             }
        });

        // --- Fetch products for the page using numeric ID and pagination --- 
        const productsResponse = await client.get({
            path: 'products',
            query: {
                collection_id: collectionId,
                fields: 'id,title,image', // Only fetch needed fields
                status: 'active',
                limit: limit, // <-- Keep limit
                // page: page    // <-- REMOVE page parameter
            }
        });

        // --- Add Logging ---
        console.log('[\/api\/products-by-collection] Raw productsResponse:', JSON.stringify(productsResponse, null, 2));
        // console.log('[\/api\/products-by-collection] Raw countResponse:', JSON.stringify(countResponse, null, 2)); // Removed count

        // --- NEW CHECK: Assume success if body exists and no exception was thrown --- 
         // Check product fetch response
         if (productsResponse && productsResponse.body && typeof productsResponse.body.products !== 'undefined') {
            const products = productsResponse.body.products || []; 
            // Cannot easily get total count with REST API without extra calls or Link header parsing

            // Map to the format expected by the frontend
            const formattedProducts = products.map(product => ({
                id: product.id, 
                title: product.title,
                imageUrl: product.image?.src || null 
            }));

            console.log(`[/api/products-by-collection] Found ${formattedProducts.length} products (limit: ${limit}) for collection ${collectionId}.`);
            // --- Return just the data array --- 
            res.status(200).json(formattedProducts); // Return the array directly
            // --- End Return ---
          } else {
              // Product fetch failed
             console.error(`[\/api\/products-by-collection] API call succeeded but response lacked expected body.products for collection ${collectionId}. Response:`, JSON.stringify(productsResponse));
             return res.status(502).send('Error fetching products from Shopify (Bad Gateway or invalid response structure).');
          }
        // --- END NEW CHECK ---

    } catch (error) {
        // --- ENHANCED CATCH BLOCK --- 
        console.error(`[\/api\/products-by-collection] Exception during product fetch for shop ${shop}, collection ${collectionId}.`);
        console.error('[\/api\/products-by-collection] Error Name:', error.name);
        console.error('[\/api\/products-by-collection] Error Message:', error.message);
        if (error.stack) {
            console.error('[\/api\/products-by-collection] Error Stack:', error.stack);
        }

        // Check if it looks like a Shopify API response error
        if (error.response && error.response.status) { 
             console.error('[\/api\/products-by-collection] Caught error with response status:', error.response.status);
             return res.status(error.response.status).send(`Error fetching products: ${error.message}`);
        } 
        // Check for fetch/network related errors
        else if (error.name === 'FetchError' || error instanceof TypeError) { 
             console.error(`[\/api\/products-by-collection] Network or fetch-related error.`);
             return res.status(503).send(`Service Unavailable: Could not reach Shopify API for products (${error.message})`);
        }
        // Generic fallback
        else {
             console.error('[\/api\/products-by-collection] Caught non-response, non-network error.');
             return res.status(500).send('Internal Server Error fetching products.');
        }
        // --- END ENHANCED CATCH BLOCK --- 
    }
});

// --- Serve Frontend Static Files --- 
const FRONTEND_BUILD_PATH = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(FRONTEND_BUILD_PATH, { index: false }));

// --- NEW: API endpoint to get shop info ---
app.get(
    '/api/shop-info',
    async (req, res) => {
        console.log('[/api/shop-info] Received request.');
        const shop = req.query.shop;

        if (!shop) {
            console.log('[/api/shop-info] Missing shop query parameter.');
            return res.status(400).send('Bad Request: Missing shop query parameter.');
        }

        let session = null;
        try {
            const sessionStorage = shopify.config.sessionStorage;
            const sessions = await sessionStorage.findSessionsByShop(shop);

            if (sessions && sessions.length > 0) {
                // Use the first session found (should typically be the offline one)
                session = sessions[0]; 
                console.log(`[/api/shop-info] Found session for shop ${shop}.`);
            } else {
                console.log(`[/api/shop-info] No session found for shop ${shop}. Cannot fetch shop info.`);
                return res.sendStatus(401); // Unauthorized
            }

            // Session found, create REST client
            const client = new shopify.clients.Rest({ session });
            console.log('[/api/shop-info] REST Client created. Fetching shop data...');

            // Make API call to get shop details
            const response = await client.get({ path: 'shop' });

            if (response.body?.shop) {
                console.log('[/api/shop-info] Successfully fetched shop data.');
                res.status(200).json(response.body.shop);
            } else {
                console.error('[/api/shop-info] Unexpected response structure from Shopify API:', response);
                res.status(502).send('Bad Gateway: Could not fetch shop data from Shopify.');
            }

        } catch (error) {
            console.error(`[/api/shop-info] Error processing request for shop ${shop}:`, error);
            // Distinguish between auth errors and other errors
            if (error.response && (error.response.code === 401 || error.response.code === 403)) { 
                 console.error('[/api/shop-info] Authentication/Authorization error identified. Sending specific status.');
                 // Send back the specific status code received from Shopify
                 return res.status(error.response.code).send('Unauthorized/Forbidden to fetch shop data.'); 
            } else {
                 console.error('[/api/shop-info] Error did not match 401/403 structure. Sending 500.');
                 return res.status(500).send('Internal Server Error while fetching shop data.');
            }
        }
    }
);
// --- End NEW API endpoint ---

// --- NEW: API endpoint to get products ---
app.get(
    '/api/products',
    async (req, res) => {
        console.log('[/api/products] Received request.');
        const shop = req.query.shop;
        const collectionId = req.query.collection_id; // Get collection_id from query

        if (!shop) {
            console.log('[/api/products] Missing shop query parameter.');
            return res.status(400).send('Bad Request: Missing shop query parameter.');
        }

        let session = null;
        try {
            const sessionStorage = shopify.config.sessionStorage;
            const sessions = await sessionStorage.findSessionsByShop(shop);

            if (sessions && sessions.length > 0) {
                session = sessions[0]; 
                console.log(`[/api/products] Found session for shop ${shop}.`);
                // --- ADD SESSION SCOPE LOGGING --- 
                console.log(`[/api/products] Scopes stored in session: ${session.scope}`);
                // --- END SESSION SCOPE LOGGING --- 
            } else {
                console.log(`[/api/products] No session found for shop ${shop}. Cannot fetch products.`);
                return res.sendStatus(401); // Unauthorized
            }

            // --- Get Access Token --- 
            const accessToken = session.accessToken;
            if (!accessToken) {
                console.error('[/api/products] AccessToken missing from session object!');
                return res.status(500).send('Internal Error: Session token missing.');
            }

            // --- Attempt MANUAL fetch (Will use REST Client for consistency) ---
            const client = new shopify.clients.Rest({ session });
            console.log('[/api/products] REST Client created. Fetching products...');

            // --- Build Query Parameters --- 
            const queryParams = { limit: 50 }; // Fetch more products
            let path = 'products';

            if (collectionId) {
                console.log(`[/api/products] Filtering by Collection ID: ${collectionId}`);
                // Use the endpoint for products within a specific collection
                // Note: Shopify REST API uses numeric IDs for collection filtering here.
                // Ensure collectionId is numeric if passed.
                path = `collections/${collectionId}/products`; 
                // queryParams.collection_id = collectionId; // This param is often for the main products endpoint, not the collection-specific one.
            } else {
                console.log('[/api/products] Fetching all products (no collection filter).');
            }
            // --- End Build Query --- 

            console.log(`[/api/products] Using path: ${path} with query:`, queryParams);

            const response = await client.get({ path: path, query: queryParams }); // Use dynamic path

            // --- Log Raw Response Body when Filtering ---
            if (collectionId) {
                console.log('[/api/products] Raw response body for collection fetch:', JSON.stringify(response.body, null, 2));
            }
            // --- End Log ---

            // --- Log Response Headers (for debugging rate limits etc.) ---
            if (response.headers) {
                console.log('[/api/products] Response Headers:', {
                    limit: response.headers['x-shopify-shop-api-call-limit'], 
                    // Add other relevant headers if needed
                });
            }
            // -----------------------------------------------------------

            // --- Adjust Product Extraction Logic --- 
            let products = []; // Default to empty array
            if (response.body) {
                if (collectionId) {
                    // If filtering by collection, the products might be directly in the body 
                    // or under a different key. Assuming direct array for now based on common patterns.
                    // If this fails, check the raw log above to see the actual structure.
                    if (Array.isArray(response.body)) { 
                        products = response.body; 
                        console.log(`[/api/products] Extracted ${products.length} products directly from body for collection.`);
                    } else if (response.body.products && Array.isArray(response.body.products)) {
                        // Fallback: check if it still uses the 'products' key like the general endpoint
                        products = response.body.products;
                        console.log(`[/api/products] Extracted ${products.length} products from 'products' key for collection.`);
                    } else {
                        console.warn('[/api/products] Unexpected response body structure for collection fetch. Logging body again:', response.body);
                    }
                } else {
                    // For the general endpoint, expect products under the 'products' key
                    if (response.body.products && Array.isArray(response.body.products)) {
                        products = response.body.products;
                        console.log(`[/api/products] Extracted ${products.length} products from 'products' key for general fetch.`);
                    } else {
                        console.warn('[/api/products] Unexpected response body structure for general product fetch.');
                    }
                }
            }
            
            // Send the extracted products
            res.status(200).json(products);

        } catch (error) {
            // Catch block might need adjustment if manual fetch throws different errors
            console.error(`[/api/products] Error processing request for shop ${shop}:`, error);
            // Original error handling might not apply perfectly if fetch was used
            if (error.response && (error.response.code === 401 || error.response.code === 403)) { 
                 console.error('[/api/products] Authentication/Authorization error identified. Sending specific status.');
                 return res.status(error.response.code).send('Unauthorized/Forbidden to fetch products.');
            } else {
                 console.error('[/api/products] Error did not match 401/403 structure or was network error. Sending 500.');
                 return res.status(500).send('Internal Server Error while fetching products.');
             }
        }
    }
);
// --- End NEW API endpoint ---

// --- NEW: API Routes for Daily Drops ---

// GET /api/drops - Retrieve all drops for the shop
app.get('/api/drops', validateSession, async (req, res) => {
    const shop = req.query.shop; // We know shop exists because validateSession passed
    console.log(`[/api/drops GET] Request received for shop: ${shop}`);
    try {
        // Use Supabase client
        const { data, error } = await supabase
            .from('drops')
            .select('*')
            .eq('shop', shop)
            .order('start_time', { ascending: true }); // Keep sorting

        if (error) {
            console.error('[/api/drops GET] Supabase Error:', error);
            // Throw the error to be caught by the main catch block
            throw error; 
        }

        console.log(`[/api/drops GET] Found ${data?.length || 0} drops from Supabase.`);
        res.status(200).json(data || []); // Return data or empty array

        /* REMOVE SQLite logic
        db.all('SELECT * FROM daily_drops ORDER BY dropDate DESC', [], (err, rows) => {
            if (err) {
                console.error('[/api/drops GET] DB Error:', err.message);
                return res.status(500).json({ error: 'Failed to retrieve drops from database.' });
            }
            console.log(`[/api/drops GET] Found ${rows.length} drops.`);
            res.status(200).json(rows);
        });
        */
    } catch (error) {
        console.error('[/api/drops GET] Server Error:', error);
        // Provide a more specific error if possible
        const errorMessage = error.message || 'Internal server error retrieving drops.';
        const errorCode = error.code || 500; // Use Supabase error code if available
        res.status(errorCode === 'PGRST116' ? 404 : 500).json({ error: errorMessage });
    }
});

// GET /api/drops/active - Retrieve the currently active drop for the shop
app.get('/api/drops/active', validateSession, async (req, res) => {
    const shop = req.query.shop;
    console.log(`[/api/drops/active GET] Request received for shop: ${shop}`);
    try {
        const { data, error } = await supabase
            .from('drops')
            .select('*') // Select all columns for now
            .eq('shop', shop)
            .eq('status', 'active')
            .order('start_time', { ascending: false }) // Get the most recent if multiple somehow exist
            .limit(1)
            .maybeSingle(); // Returns the single row or null

        if (error) {
            console.error('[/api/drops/active GET] Supabase Error:', error);
            throw error;
        }

        if (data) {
            console.log('[/api/drops/active GET] Found active drop:', data);
            res.status(200).json(data);
        } else {
            console.log(`[/api/drops/active GET] No active drop found for shop: ${shop}.`);
            res.status(200).json(null); // Return null explicitly if no active drop
        }

    } catch (error) {
        console.error('[/api/drops/active GET] Server Error:', error);
        // Use similar error handling as other GET routes
        const errorMessage = error.message || 'Internal server error retrieving active drop.';
        const errorCode = error.code;
        let statusCode = 500;
        if (errorCode === '42501') { // permission denied
             statusCode = 403;
        } else if (error.status) {
             statusCode = error.status;
        } 
        res.status(statusCode).json({ error: errorMessage });
    }
});

// --- NEW: GET /api/drops/completed - Retrieve recently completed drops ---
app.get('/api/drops/completed', validateSession, async (req, res) => {
    const shop = req.query.shop;
    // --- Pagination --- 
    const page = parseInt(req.query.page, 10) || 1; // Default to page 1
    const limit = Math.min(parseInt(req.query.limit, 10) || 5, 50); // Default to 5, max 50
    const offset = (page - 1) * limit;
    console.log(`[/api/drops/completed GET] Request for shop: ${shop}, page: ${page}, limit: ${limit}`);
    // --- End Pagination ---

    try {
        const { data, error, count } = await supabase
            .from('drops')
            .select('*', { count: 'exact' }) // <-- Request total count
            .eq('shop', shop)
            .eq('status', 'completed')
            .order('end_time', { ascending: false }) // Order by completion time, newest first
            .range(offset, offset + limit - 1); // <-- Use range for pagination

        if (error) {
            console.error('[/api/drops/completed GET] Supabase Error:', error);
            throw error;
        }

        console.log(`[/api/drops/completed GET] Found ${data?.length || 0} drops on page ${page}. Total count: ${count}`);
        res.status(200).json({ data: data || [], totalCount: count }); // <-- Return data and total count

    } catch (error) {
        console.error('[/api/drops/completed GET] Server Error:', error);
        const errorMessage = error.message || 'Internal server error retrieving completed drops.';
        const errorCode = error.code;
        let statusCode = 500;
        if (errorCode === '42501') { // permission denied
             statusCode = 403;
        } else if (error.status) {
             statusCode = error.status;
        } 
        res.status(statusCode).json({ error: errorMessage });
    }
});

// --- NEW: GET /api/drops/queued - Retrieve upcoming queued drops ---
app.get('/api/drops/queued', validateSession, async (req, res) => {
    const shop = req.query.shop;
    // --- Pagination --- 
    const page = parseInt(req.query.page, 10) || 1; // Default to page 1
    const limit = Math.min(parseInt(req.query.limit, 10) || 5, 100); // Default to 5, max 100
    const offset = (page - 1) * limit;
    console.log(`[/api/drops/queued GET] Request for shop: ${shop}, page: ${page}, limit: ${limit}`);
    // --- End Pagination ---

    try {
        const { data, error, count } = await supabase
            .from('drops')
            .select('*', { count: 'exact' }) // <-- Request total count
            .eq('shop', shop)
            .eq('status', 'queued')
            .order('start_time', { ascending: true }) // Order by start time, soonest first
            .range(offset, offset + limit - 1); // <-- Use range for pagination

        if (error) {
            console.error('[/api/drops/queued GET] Supabase Error:', error);
            throw error;
        }

        console.log(`[/api/drops/queued GET] Found ${data?.length || 0} drops on page ${page}. Total count: ${count}`);
        res.status(200).json({ data: data || [], totalCount: count }); // <-- Return data and total count

    } catch (error) {
        console.error('[/api/drops/queued GET] Server Error:', error);
        const errorMessage = error.message || 'Internal server error retrieving queued drops.';
        const errorCode = error.code;
        let statusCode = 500;
        if (errorCode === '42501') { // permission denied
             statusCode = 403;
        } else if (error.status) {
             statusCode = error.status;
        } 
        res.status(statusCode).json({ error: errorMessage });
    }
});

// POST /api/drops - Create a new drop
app.post('/api/drops', validateSession, async (req, res) => {
    // Use field names consistent with Supabase 'drops' table & Project Brief
    const { 
        product_id, 
        title, 
        thumbnail_url, 
        start_time, 
        duration_minutes,
        shop // Passed from frontend modal
    } = req.body;
    
    console.log(`[/api/drops POST] Request received for shop: ${shop}`);
    console.log(`[/api/drops POST] Received payload:`, req.body);

    // Basic validation (adjust based on required fields for Supabase table)
    if (!product_id || !title || !start_time || typeof duration_minutes === 'undefined' || duration_minutes === null || !shop) {
        console.log('[/api/drops POST] Missing required fields.');
        return res.status(400).json({ error: 'Missing required fields: product_id, title, start_time, duration_minutes, shop.' });
    }

    // Prepare data for Supabase insert
    const dropData = {
        product_id, 
        title,
        thumbnail_url: thumbnail_url || null, // Allow null thumbnail
        start_time, 
        duration_minutes,
        shop,
        status: 'queued', // Default status
        // next_collection_id: null, // Handle later if needed
        // current_collection_id: null, // Handle later if needed
        // end_time is calculated by the trigger in Supabase
    };

    try {
        // Use Supabase client
        const { data, error } = await supabase
            .from('drops')
            .insert([dropData]) // Pass data as an array
            .select() // Select the inserted row to return it
            .single(); // Expect only one row inserted

        if (error) {
            console.error('[/api/drops POST] Supabase Error:', error);
            throw error; // Let the main catch block handle it
        }

        console.log('[/api/drops POST] Drop created successfully in Supabase:', data);
        res.status(201).json(data); // Return the newly created drop object

        /* REMOVE SQLite logic
        const sql = `INSERT INTO daily_drops (productId, variantId, dropDate) VALUES (?, ?, ?)`;
        const params = [productId, variantId || null, dropDate]; // Use null if variantId is not provided

        db.run(sql, params, function(err) { // Use function() to access this.lastID
            if (err) {
                console.error('[/api/drops POST] DB Error:', err.message);
                return res.status(500).json({ error: 'Failed to save drop to database.' });
            }
            console.log(`[/api/drops POST] Drop created successfully. ID: ${this.lastID}`);
            res.status(201).json({ id: this.lastID, productId, variantId, dropDate });
        });
        */
    } catch (error) {
        console.error('[/api/drops POST] Server Error:', error);
        const errorMessage = error.message || 'Internal server error creating drop.';
        const errorCode = error.code; // Use Supabase error code if available
        // Check for common Supabase errors like unique constraint violation (23505)
        res.status(errorCode === '23505' ? 409 : 500).json({ error: errorMessage });
    }
});

// --- NEW: POST /api/drops/schedule-all - Bulk schedule drops from a collection ---
app.post('/api/drops/schedule-all', validateSession, async (req, res) => {
    // --- BEGIN ADDED DEBUG LOGS ---
    // Assuming 'validateSession' adds the session to req, e.g., req.shopifySession
    const sessionForLog = req.shopifySession || null; // Get session attached by middleware
    console.log(`DEBUG /api/drops/schedule-all: Middleware provided session? ${sessionForLog ? 'Yes' : 'No - API calls WILL fail!'}`); // Added emphasis
    console.log(`DEBUG /api/drops/schedule-all: Session details: shop=${sessionForLog?.shop}, Active=${sessionForLog?.isActive()}, Online=${sessionForLog?.isOnline}`);
    if (sessionForLog?.accessToken) {
         console.log(`DEBUG /api/drops/schedule-all: Access Token starts with: ${sessionForLog.accessToken.substring(0, 5)}... Scope: ${sessionForLog.scope}`);
    } else {
         console.log(`DEBUG /api/drops/schedule-all: NO Access Token found in session provided by middleware!`);
    }
    // --- END ADDED DEBUG LOGS ---

    const { shop, queued_collection_id, start_date_string, start_time_string, duration_minutes } = req.body; // Get body params AFTER logging session

    console.log(`[/api/drops/schedule-all POST] Request received for shop: ${shop}`);
    console.log(`[/api/drops/schedule-all POST] Payload:`, req.body);

    // --- Input Validation ---
    if (!shop || !queued_collection_id || !start_date_string || !start_time_string || typeof duration_minutes === 'undefined' || duration_minutes === null) {
        return res.status(400).json({ error: 'Missing required fields: shop, queued_collection_id, start_date_string, start_time_string, duration_minutes.' });
    }
    const durationMinsInt = parseInt(duration_minutes, 10);
    if (isNaN(durationMinsInt) || durationMinsInt <= 0) {
        return res.status(400).json({ error: 'Invalid duration_minutes. Must be a positive integer.' });
    }
    const collectionIdMatch = queued_collection_id.match(/\d+$/);
    if (!collectionIdMatch) {
        return res.status(400).json({ error: 'Invalid queued_collection_id format.' });
    }
    const numericCollectionId = collectionIdMatch[0];

    let initialStartTime;
    try {
        if (!/^\d{1,2}:\d{2}$/.test(start_time_string)) throw new Error('Invalid time format. Use HH:MM.');
        initialStartTime = new Date(`${start_date_string}T${start_time_string}:00`);
        if (isNaN(initialStartTime.getTime())) throw new Error('Invalid date/time combination.');
    } catch (e) {
        return res.status(400).json({ error: `Invalid start date/time: ${e.message}` });
    }
    // --- End Validation ---

    try {
        // 1. Get session/token (validateSession middleware ensures session exists)
        const sessionStorage = shopify.config.sessionStorage;
        const sessions = await sessionStorage.findSessionsByShop(shop);
        if (!sessions || sessions.length === 0 || !sessions[0].accessToken) {
             throw new Error('Could not retrieve valid session token.');
        }
        const token = sessions[0].accessToken;
        const client = new shopify.clients.Rest({ session: { shop, accessToken: token, isOnline: false } });

        // 2. Fetch products from the specified Shopify collection
        console.log(`[/api/drops/schedule-all POST] Fetching products for collection ID: ${numericCollectionId}`);
        const productsResponse = await client.get({
            path: 'products',
            query: {
                collection_id: numericCollectionId,
                fields: 'id,title,image', // Only fetch needed fields
                status: 'active' // <-- ADD: Explicitly request only active products
            }
        });

        if (!productsResponse || !productsResponse.body || typeof productsResponse.body.products === 'undefined') {
            console.error(`[/api/drops/schedule-all POST] Invalid response fetching products:`, productsResponse);
            return res.status(502).send('Error fetching products from Shopify (Invalid Response).');
        }
        const productsToSchedule = productsResponse.body.products || [];
        if (productsToSchedule.length === 0) {
             console.log(`[/api/drops/schedule-all POST] No products found in collection ${numericCollectionId}. Nothing to schedule.`);
             return res.status(200).json({ message: 'No products found in the selected collection to schedule.', scheduled_count: 0 });
        }
        console.log(`[/api/drops/schedule-all POST] Found ${productsToSchedule.length} products to schedule.`);

        // --- NEW: Fetch existing queued/active product IDs --- 
        console.log(`[/api/drops/schedule-all POST] Fetching existing queued/active product IDs...`);
        const { data: existingDrops, error: existingDropsError } = await supabase
            .from('drops')
            .select('product_id')
            .eq('shop', shop)
            .in('status', ['queued', 'active']); // Check against both queued and active

        if (existingDropsError) {
            console.error('[/api/drops/schedule-all POST] Error fetching existing drops:', existingDropsError);
            throw new Error('Could not verify existing scheduled drops.');
        }
        const existingProductIds = new Set(existingDrops.map(d => d.product_id));
        console.log(`[/api/drops/schedule-all POST] Found ${existingProductIds.size} existing product IDs.`);
        // --- END Fetch existing --- 

        // 3. Prepare bulk insert data (Filter out existing products)
        const dropsToInsert = [];
        let currentStartTime = initialStartTime;

        // --- Filter productsToSchedule --- 
        const newProductsToSchedule = productsToSchedule.filter(product => 
            !existingProductIds.has(`gid://shopify/Product/${product.id}`)
        );
        console.log(`[/api/drops/schedule-all POST] Filtered down to ${newProductsToSchedule.length} new products to schedule.`);
        // --- End Filter ---

        if (newProductsToSchedule.length === 0) {
            console.log(`[/api/drops/schedule-all POST] No new products to schedule after filtering.`);
             return res.status(200).json({ message: 'All products in the collection are already scheduled or active.', scheduled_count: 0 });
        }

        for (const product of newProductsToSchedule) { // <-- Iterate over filtered list
            const dropData = {
                product_id: `gid://shopify/Product/${product.id}`, 
                title: product.title,
                thumbnail_url: product.image?.src || null,
                start_time: currentStartTime.toISOString(), // Use calculated start time
                duration_minutes: durationMinsInt,
                shop: shop,
                status: 'queued'
                // end_time is calculated by the trigger
            };
            dropsToInsert.push(dropData);

            // Calculate start time for the *next* drop
            currentStartTime = new Date(currentStartTime.getTime() + durationMinsInt * 60000); // Add duration in milliseconds
        }

        // 4. Perform bulk insert into Supabase
        console.log(`[/api/drops/schedule-all POST] Attempting to bulk insert ${dropsToInsert.length} drops...`);
        const { data: insertedData, error: insertError } = await supabase
            .from('drops')
            .insert(dropsToInsert) 
            .select(); // Select the inserted rows

        if (insertError) {
            console.error('[/api/drops/schedule-all POST] Supabase Insert Error:', insertError);
            throw insertError; // Let the main catch block handle it
        }

        console.log(`[/api/drops/schedule-all POST] Successfully bulk inserted ${insertedData?.length || 0} drops.`);
        res.status(201).json({ 
            message: `Successfully scheduled ${insertedData?.length || 0} drops.`, 
            scheduled_count: insertedData?.length || 0, 
            // data: insertedData // Optionally return the created drops
        });

    } catch (error) {
        console.error('[/api/drops/schedule-all POST] Server Error:', error);
        const errorMessage = error.message || 'Internal server error scheduling drops.';
        let statusCode = 500;
        if (error.response && error.response.status) { // Shopify API errors
             statusCode = error.response.status;
        } else if (error.code) { // Supabase errors
             if (error.code === '23505') statusCode = 409; // unique constraint violation
             else if (error.code === '42501') statusCode = 403; // permission denied
        }
        res.status(statusCode).json({ error: errorMessage });
    }
});

// --- NEW: POST /api/drops/append - Add only new products to the end of the queue ---
app.post('/api/drops/append', validateSession, async (req, res) => {
    const { 
        shop, 
        queued_collection_id // GID format
    } = req.body;

    console.log(`[/api/drops/append POST] Request received for shop: ${shop}`);
    console.log(`[/api/drops/append POST] Payload:`, req.body);

    // --- Input Validation ---
    if (!shop || !queued_collection_id) {
        return res.status(400).json({ error: 'Missing required fields: shop, queued_collection_id.' });
    }
    const collectionIdMatch = queued_collection_id.match(/\d+$/);
    if (!collectionIdMatch) {
        return res.status(400).json({ error: 'Invalid queued_collection_id format.' });
    }
    const numericCollectionId = collectionIdMatch[0];
    // --- End Validation ---

    try {
        // 1. Get session/token
        const sessionStorage = shopify.config.sessionStorage;
        const sessions = await sessionStorage.findSessionsByShop(shop);
        if (!sessions || sessions.length === 0 || !sessions[0].accessToken) {
             throw new Error('Could not retrieve valid session token.');
        }
        const token = sessions[0].accessToken;
        const shopifyClient = new shopify.clients.Rest({ session: { shop, accessToken: token, isOnline: false } });

        // --- NEW: Fetch default duration from settings --- 
        console.log(`[/api/drops/append POST] Fetching settings for shop: ${shop}`);
        const { data: settingsData, error: settingsError } = await supabase
            .from('app_settings')
            .select('default_drop_duration_minutes')
            .eq('shop', shop)
            .maybeSingle();
        
        if (settingsError) {
            console.error('[/api/drops/append POST] Error fetching settings:', settingsError);
            throw new Error('Could not fetch app settings to determine duration.');
        }

        const durationMinsInt = settingsData?.default_drop_duration_minutes || 60; // Use saved duration or default to 60
        console.log(`[/api/drops/append POST] Using duration from settings: ${durationMinsInt} minutes.`);
        // --- END Fetch settings --- 

        // 2. Fetch products from Shopify collection
        console.log(`[/api/drops/append POST] Fetching products for collection ID: ${numericCollectionId}`);
        const productsResponse = await shopifyClient.get({
            path: 'products',
            query: { collection_id: numericCollectionId, fields: 'id,title,image', status: 'active' }
        });
        if (!productsResponse?.body?.products) {
            console.error(`[/api/drops/append POST] Invalid response fetching products:`, productsResponse);
            return res.status(502).send('Error fetching products from Shopify (Invalid Response).');
        }
        const shopifyProducts = productsResponse.body.products || [];
        const shopifyProductIds = new Set(shopifyProducts.map(p => `gid://shopify/Product/${p.id}`));
        console.log(`[/api/drops/append POST] Found ${shopifyProducts.length} products in Shopify collection.`);

        // 3. Fetch existing *queued* drops from DB
        console.log(`[/api/drops/append POST] Fetching existing queued drops from DB...`);
        const { data: existingQueuedDrops, error: fetchError } = await supabase
            .from('drops')
            .select('id, product_id, start_time, end_time') // Select necessary fields
            .eq('shop', shop)
            .eq('status', 'queued')
            .order('start_time', { ascending: false }); // Get latest first

        if (fetchError) {
            console.error('[/api/drops/append POST] Supabase fetch Error:', fetchError);
            throw fetchError;
        }
        const existingQueuedProductIds = new Set(existingQueuedDrops.map(d => d.product_id));
        console.log(`[/api/drops/append POST] Found ${existingQueuedDrops.length} existing queued drops in DB.`);

        // 4. Determine the next start time
        let nextStartTime;
        if (existingQueuedDrops.length > 0 && existingQueuedDrops[0].end_time) {
            // Start after the last scheduled drop's end time
            nextStartTime = new Date(existingQueuedDrops[0].end_time);
            console.log(`[/api/drops/append POST] Next start time based on last drop: ${nextStartTime.toISOString()}`);
        } else {
            // No existing queued drops, start now (or maybe prompt user? For now, start 'now')
            nextStartTime = new Date(); 
            console.log(`[/api/drops/append POST] No existing drops, next start time set to now: ${nextStartTime.toISOString()}`);
            // ALTERNATIVE: Could fetch settings drop_time and combine with today's date? Requires more logic.
        }

        // 5. Filter Shopify products to find only those not already queued
        const productsToAppend = shopifyProducts.filter(p => 
            !existingQueuedProductIds.has(`gid://shopify/Product/${p.id}`)
        );

        if (productsToAppend.length === 0) {
            console.log(`[/api/drops/append POST] No new products found in collection to append.`);
            return res.status(200).json({ message: 'All products in the collection are already scheduled.', scheduled_count: 0 });
        }
        console.log(`[/api/drops/append POST] Found ${productsToAppend.length} new products to append.`);

        // 6. Prepare bulk insert data for only the new products
        const dropsToInsert = [];
        let currentStartTime = nextStartTime; // Start from the determined time

        for (const product of productsToAppend) {
            const dropData = {
                product_id: `gid://shopify/Product/${product.id}`, 
                title: product.title,
                thumbnail_url: product.image?.src || null,
                start_time: currentStartTime.toISOString(),
                duration_minutes: durationMinsInt, // <-- Use duration fetched from settings
                shop: shop,
                status: 'queued'
            };
            dropsToInsert.push(dropData);
            // Calculate start time for the next appended drop
            currentStartTime = new Date(currentStartTime.getTime() + durationMinsInt * 60000); 
        }

        // 7. Perform bulk insert for new drops
        console.log(`[/api/drops/append POST] Attempting to bulk insert ${dropsToInsert.length} new drops...`);
        const { data: insertedData, error: insertError } = await supabase
            .from('drops')
            .insert(dropsToInsert) 
            .select(); 

        if (insertError) {
            console.error('[/api/drops/append POST] Supabase Insert Error:', insertError);
            throw insertError;
        }

        console.log(`[/api/drops/append POST] Successfully appended ${insertedData?.length || 0} drops.`);
        res.status(201).json({ 
            message: `Successfully appended ${insertedData?.length || 0} new drops.`, 
            scheduled_count: insertedData?.length || 0,
        });

    } catch (error) {
        console.error('[/api/drops/append POST] Server Error:', error);
        const errorMessage = error.message || 'Internal server error appending drops.';
        let statusCode = 500;
        // Add similar detailed error status handling as schedule-all
        if (error.response && error.response.status) { 
             statusCode = error.response.status;
        } else if (error.code) { 
             if (error.code === '23505') statusCode = 409; 
             else if (error.code === '42501') statusCode = 403; 
        }
        res.status(statusCode).json({ error: errorMessage });
    }
});

// --- NEW: API endpoint to GET settings ---
app.get('/api/settings', validateSession, async (req, res) => {
    const shop = req.query.shop;
    console.log(`[/api/settings GET] Request received for shop: ${shop}`);

    try {
        const { data, error } = await supabase
            .from('app_settings')
            // .select('queued_collection_id, active_collection_id, completed_collection_id, drop_time, default_drop_duration_minutes, default_drop_date') // <-- Commented out active/completed
            .select('queued_collection_id, drop_time, default_drop_duration_minutes, default_drop_date') // <-- Select only used fields
            .eq('shop', shop)
            .maybeSingle(); // Returns single row or null, doesn't error if not found

        if (error) {
            console.error('[/api/settings GET] Supabase Error:', error);
            throw error;
        }

        if (data) {
            console.log('[/api/settings GET] Found settings:', data);
            res.status(200).json(data);
        } else {
            console.log(`[/api/settings GET] No settings found for shop: ${shop}. Returning defaults.`);
            // Return a default structure or empty object if no settings are found
            res.status(200).json({
                queued_collection_id: null,
                // active_collection_id: null, // <-- COMMENT OUT
                // completed_collection_id: null, // <-- COMMENT OUT
                drop_time: '10:00', // Or whatever your default time is
                default_drop_duration_minutes: 60, // <-- ADD duration
                default_drop_date: null // <-- ADD date
            }); 
            // Alternatively, could send 404: res.status(404).json({ message: 'No settings found for this shop.' });
        }

    } catch (error) {
        console.error('[/api/settings GET] Server Error:', error);
        const errorMessage = error.message || 'Internal server error retrieving settings.';
        const errorCode = error.code;
        let statusCode = 500;
        if (errorCode === '42501') { // permission denied
             statusCode = 403;
        } else if (error.status) {
             statusCode = error.status;
        } 
        res.status(statusCode).json({ error: errorMessage });
    }
});

// --- NEW: API endpoint to save settings --- 
app.post('/api/settings', validateSession, async (req, res) => {
    const shop = req.query.shop; // From validateSession or could be passed in body
    console.log(`[/api/settings POST] Request received for shop: ${shop}`);
    
    // Extract expected settings fields from the request body
    const {
        queued_collection_id,
        // active_collection_id, // <-- COMMENT OUT
        // completed_collection_id, // <-- COMMENT OUT
        drop_time,
        default_drop_duration_minutes, // <-- ADD duration field
        default_drop_date // <-- ADD date field
    } = req.body;

    console.log(`[/api/settings POST] Received payload:`, req.body);

    // Basic validation (optional, depends on frontend guarantees)
    // if (!queued_collection_id || !active_collection_id || !completed_collection_id || !drop_time) {
    //     console.log('[/api/settings POST] Missing required settings fields.');
    //     return res.status(400).json({ error: 'Missing required settings fields.' });
    // }

    // Prepare data for Supabase upsert
    // We use the shop domain as the primary key to ensure only one settings row per shop
    const settingsData = {
        shop: shop, // Primary key
        queued_collection_id: queued_collection_id || null,
        // active_collection_id: active_collection_id || null, // <-- COMMENT OUT
        // completed_collection_id: completed_collection_id || null, // <-- COMMENT OUT
        drop_time: drop_time || null,
        default_drop_duration_minutes: default_drop_duration_minutes || 60, // <-- ADD duration, default to 60 if not provided
        default_drop_date: default_drop_date || null, // <-- ADD date, allow null
        // created_at and updated_at are handled by defaults/triggers in Supabase
    };

    try {
        // Use Supabase client's upsert
        // Upsert will insert if the shop doesn't exist, or update if it does.
        const { data, error } = await supabase
            .from('app_settings')
            .upsert(settingsData, { onConflict: 'shop' }) // Specify the conflict column
            .select() // Select the upserted row to return it
            .single(); // Expect only one row

        if (error) {
            console.error('[/api/settings POST] Supabase Error:', error);
            throw error; // Let the main catch block handle it
        }

        console.log('[/api/settings POST] Settings saved/updated successfully in Supabase:', data);
        res.status(200).json(data); // Return the saved/updated settings object

    } catch (error) {
        console.error('[/api/settings POST] Server Error:', error);
        const errorMessage = error.message || 'Internal server error saving settings.';
        const errorCode = error.code; // Use Supabase error code if available
        // Check for common Supabase errors like RLS violations (403) or others
        let statusCode = 500;
        if (errorCode === '42501') { // permission denied (RLS potentially)
             statusCode = 403;
        } else if (error.status) { // Use error status if available
             statusCode = error.status;
        } 
        res.status(statusCode).json({ error: errorMessage });
    }
});
// --- End NEW API endpoint --- 

// --- NEW: DELETE /api/drops - Delete one or more queued drops ---
app.delete('/api/drops', validateSession, async (req, res) => {
    const shop = req.query.shop; // From validateSession
    const { dropIds } = req.body; // Expect an array of UUIDs: { dropIds: ["uuid1", "uuid2"] }

    console.log(`[/api/drops DELETE] Request received for shop: ${shop}`);
    console.log(`[/api/drops DELETE] Received payload:`, req.body);

    // --- Input Validation ---
    if (!shop) {
        // Should not happen due to validateSession, but good practice
        return res.status(400).json({ error: 'Shop parameter missing.' });
    }
    if (!Array.isArray(dropIds) || dropIds.length === 0) {
        return res.status(400).json({ error: 'Missing or invalid dropIds array in request body.' });
    }
    // Optional: Add UUID validation for each ID if needed
    // --- End Validation ---

    try {
        // Use Supabase client to delete ONLY queued drops matching the IDs for the shop
        const { count, error } = await supabase
            .from('drops')
            .delete()
            .in('id', dropIds)       // Match IDs in the provided array
            .eq('shop', shop)         // Ensure it's for the correct shop
            .eq('status', 'queued'); // IMPORTANT: Only delete if status is 'queued'

        if (error) {
            console.error('[/api/drops DELETE] Supabase Error:', error);
            throw error; // Let the main catch block handle it
        }

        console.log(`[/api/drops DELETE] Successfully deleted ${count ?? 0} queued drops for shop ${shop}.`);
        res.status(200).json({ message: `Successfully deleted ${count ?? 0} queued drops.`, deleted_count: count ?? 0 });

    } catch (error) {
        console.error('[/api/drops DELETE] Server Error:', error);
        const errorMessage = error.message || 'Internal server error deleting drops.';
        const errorCode = error.code; // Use Supabase error code if available
        let statusCode = 500;
        if (errorCode === '42501') { // permission denied (RLS potentially)
             statusCode = 403;
        } else if (error.status) { // Use error status if available
             statusCode = error.status;
        } 
        res.status(statusCode).json({ error: errorMessage });
    }
});
// --- End NEW DELETE endpoint ---

// --- NEW: DELETE /api/drops/completed - Clear all completed drops ---
app.delete('/api/drops/completed', validateSession, async (req, res) => {
    const shop = req.query.shop; // From validateSession
    console.log(`[/api/drops/completed DELETE] Request received for shop: ${shop}`);

    if (!shop) {
        return res.status(400).json({ error: 'Shop parameter missing.' });
    }

    try {
        // Use Supabase client to delete ALL drops with status 'completed' for the shop
        const { count, error } = await supabase
            .from('drops')
            .delete()
            .eq('shop', shop)         // Ensure it's for the correct shop
            .eq('status', 'completed'); // IMPORTANT: Target only completed drops

        if (error) {
            console.error('[/api/drops/completed DELETE] Supabase Error:', error);
            throw error; 
        }

        console.log(`[/api/drops/completed DELETE] Successfully deleted ${count ?? 0} completed drops for shop ${shop}.`);
        res.status(200).json({ message: `Successfully cleared ${count ?? 0} completed drops.`, deleted_count: count ?? 0 });

    } catch (error) {
        console.error('[/api/drops/completed DELETE] Server Error:', error);
        const errorMessage = error.message || 'Internal server error clearing completed drops.';
        const errorCode = error.code;
        let statusCode = 500;
        if (errorCode === '42501') statusCode = 403; 
        else if (error.status) statusCode = error.status; 
        res.status(statusCode).json({ error: errorMessage });
    }
});
// --- End NEW DELETE /completed endpoint ---

// --- Metafield Update Logic ---
const TARGET_SHOP_DOMAIN = 'dailydropmanager.myshopify.com'; // <-- HARDCODED: Replace if shop changes!
// Global variable to track the last handle set in the metafield
let lastActiveProductHandleSet = null;
// Global variable to store Shop GID
let shopGid = null; // e.g., "gid://shopify/Shop/12345"
// Global variable to store the *instance ID* of the shop metafield
let shopMetafieldInstanceGid = null; // e.g., "gid://shopify/Metafield/67890"

// Function to get Shop GID and find the existing Metafield GID instance
async function initializeMetafieldUpdater() {
    console.log('[Metafield Updater] Initializing...');
    
    // Explicitly define shopDomain from the constant
    const shopDomain = TARGET_SHOP_DOMAIN; 

    if (!shopDomain) {
        console.error('[Metafield Updater] Target shop domain is not defined (Constant is empty?).');
        return;
    }
    console.log(`[Metafield Updater] Attempting initialization for hardcoded shop: ${shopDomain}`);

    // Now, proceed with the try block
    try {
        const sessionStorage = shopify.config.sessionStorage;
        console.log(`[Metafield Updater] Finding sessions for ${shopDomain}...`); // Add log before find
        const sessions = await sessionStorage.findSessionsByShop(shopDomain);
        
        if (!sessions || sessions.length === 0) {
            console.error(`[Metafield Updater] No session found for shop ${shopDomain}. Cannot complete initialization.`);
            return;
        }
        const session = sessions[0]; // Use the first found session

        if (!session.accessToken) {
            console.error(`[Metafield Updater] Found session for ${shopDomain} but it lacks an access token.`);
            return;
        }
        
        console.log(`[Metafield Updater] Using session with accessToken (prefix: ${session.accessToken.substring(0,5)}...) for shop ${session.shop} to initialize.`);
        const client = new shopify.clients.Graphql({ session });

        // 1. Get Shop GID (remains the same)
        console.log('[Metafield Updater] Fetching Shop GID...');
        const shopQuery = `query { shop { id } }`;
        const shopResponse = await client.query({ data: shopQuery });
        shopGid = shopResponse?.body?.data?.shop?.id;
        if (!shopGid) {
            console.error('[Metafield Updater] Failed to retrieve Shop GID.', shopResponse?.body?.errors || 'No body/data/shop');
            return;
        }
        console.log(`[Metafield Updater] Got Shop GID: ${shopGid}`);

        // 2. Find *existing* Metafield instance ID for this shop
        console.log('[Metafield Updater] Fetching existing Metafield instance ID...');
        const metafieldInstanceQuery = `
            query {
                shop {
                    metafield(namespace: "custom", key: "active_drop_product_handle") {
                        id
                        value
                    }
                }
            }
        `;
        const metafieldInstanceResponse = await client.query({ data: metafieldInstanceQuery });
        const existingMetafield = metafieldInstanceResponse?.body?.data?.shop?.metafield;
        
        if (existingMetafield) {
            shopMetafieldInstanceGid = existingMetafield.id;
            // Initialize last handle value based on current metafield value
            lastActiveProductHandleSet = existingMetafield.value;
            console.log(`[Metafield Updater] Found existing Metafield instance GID: ${shopMetafieldInstanceGid} with value: '${lastActiveProductHandleSet}'`);
        } else {
            shopMetafieldInstanceGid = null; // No existing metafield found
            lastActiveProductHandleSet = null;
            console.log('[Metafield Updater] No existing Metafield instance found for custom.active_drop_product_handle.');
        }

        console.log(`[Metafield Updater] Initialization successful! Shop GID: ${shopGid}, Initial Metafield Instance GID: ${shopMetafieldInstanceGid}, Initial Handle: '${lastActiveProductHandleSet}'`);

    } catch (error) {
        console.error('[Metafield Updater] Error during initialization try block:', error); 
        shopGid = null;
        shopMetafieldInstanceGid = null;
        lastActiveProductHandleSet = null;
    }
}

// Function to check active drop and update metafield
async function updateShopMetafield() {
    if (!shopGid) {
        // Don't run if initialization failed (shopGid is essential)
        console.log('[Metafield Updater] Skipping update: Shop GID not initialized.')
        return; 
    }

    console.log('[Metafield Updater] Checking for active drop...');
    let activeProductHandleValue = null; // Renamed variable for clarity
    let fetchedActiveDropData = null; 
    let dbError = null;

    // --- Step 1: Fetch active drop data (product GID) --- 
    try {
        const { data, error } = await supabase
            .from('drops')
            .select('product_id') 
            .eq('status', 'active')
            .limit(1)
            .maybeSingle(); 

        if (error) {
            dbError = error;
        } else {
            fetchedActiveDropData = data; // Contains { product_id: "gid://..." } or null
        }
    } catch (fetchCatchError) {
        dbError = fetchCatchError;
    }

    // --- Step 2: Process fetched data, get Handle, and update/delete metafield --- 
    try {
        if (dbError) {
            console.error('[Metafield Updater] Error fetching active drop GID from Supabase:', dbError);
            return; 
        }

        // --- NEW: Get Product Handle using GID --- 
        if (fetchedActiveDropData && fetchedActiveDropData.product_id) {
            const activeProductGid = fetchedActiveDropData.product_id;
            console.log(`[Metafield Updater] Found active drop GID: ${activeProductGid}. Fetching handle...`);

            // Get session for GraphQL client
            const shopDomain = TARGET_SHOP_DOMAIN;
            const sessionStorage = shopify.config.sessionStorage;
            const sessions = await sessionStorage.findSessionsByShop(shopDomain);
            if (!sessions || sessions.length === 0 || !sessions[0].accessToken) {
                console.error(`[Metafield Updater] No valid session found for shop ${shopDomain} while fetching handle.`);
                return;
            }
            const session = sessions[0];
            const client = new shopify.clients.Graphql({ session });

            // Query for the product handle
            const handleQuery = `
                query getProductHandle($id: ID!) {
                    product(id: $id) {
                        handle
                    }
                }
            `;
            const handleVariables = { id: activeProductGid };
            const handleResponse = await client.query({ data: { query: handleQuery, variables: handleVariables } });
            
            const fetchedHandle = handleResponse?.body?.data?.product?.handle;
            if (fetchedHandle) {
                activeProductHandleValue = fetchedHandle;
                console.log(`[Metafield Updater] Successfully fetched handle: ${activeProductHandleValue}`);
            } else {
                console.error(`[Metafield Updater] Failed to fetch handle for GID ${activeProductGid}. Response:`, handleResponse?.body?.errors || handleResponse?.body);
                // Keep activeProductHandleValue as null if handle fetch fails
            }
        } else {
            console.log('[Metafield Updater] No active drop GID found in Supabase.');
            // activeProductHandleValue remains null
        }
        // --- END NEW: Get Product Handle --- 

        // Compare current state with last known state
        console.log(`[Metafield Updater] Comparing: Current Handle='${activeProductHandleValue}', Last Set Handle='${lastActiveProductHandleSet}'`);
        if (activeProductHandleValue !== lastActiveProductHandleSet) {
            
            // --- Only update if a NEW handle is found --- 
            if (activeProductHandleValue !== null) {
                // Get session again for GraphQL client
                const shopDomain = TARGET_SHOP_DOMAIN;
                const sessionStorage = shopify.config.sessionStorage;
                const sessions = await sessionStorage.findSessionsByShop(shopDomain);
                if (!sessions || sessions.length === 0 || !sessions[0].accessToken) {
                    console.error(`[Metafield Updater] No valid session found for shop ${shopDomain} during update.`);
                    return;
                }
                const session = sessions[0];
                const client = new shopify.clients.Graphql({ session });
                
                // Active drop exists - SET the metafield
                console.log(`[Metafield Updater] Active handle value changed to '${activeProductHandleValue}'. Setting metafield...`);
                const mutation = `
                    mutation SetShopMetafield($metafields: [MetafieldsSetInput!]!) {
                      metafieldsSet(metafields: $metafields) {
                        metafields {
                          id
                          key
                          namespace
                          value
                        }
                        userErrors {
                          field
                          message
                        }
                      }
                    }
                `;
                const variables = {
                    metafields: [
                        {
                            key: "active_drop_product_handle",
                            namespace: "custom",
                            ownerId: shopGid, 
                            type: "single_line_text_field",
                            value: activeProductHandleValue // Store the actual handle
                        }
                    ]
                };

                const response = await client.query({ data: { query: mutation, variables } });

                // Handle response
                const userErrors = response?.body?.data?.metafieldsSet?.userErrors;
                const createdOrUpdatedMetafield = response?.body?.data?.metafieldsSet?.metafields?.[0];

                if (userErrors && userErrors.length > 0) {
                    console.error('[Metafield Updater] Error setting shop metafield:', userErrors);
                } else if (createdOrUpdatedMetafield) {
                    console.log('[Metafield Updater] Shop metafield set successfully:', createdOrUpdatedMetafield);
                    lastActiveProductHandleSet = activeProductHandleValue; // Update tracked handle
                    shopMetafieldInstanceGid = createdOrUpdatedMetafield.id; // Store the new/updated instance ID
                } else {
                     console.error('[Metafield Updater] Unexpected response structure from metafieldsSet mutation:', response?.body);
                }
            } else {
                // No active drop found. activeProductHandleValue is null.
                // The comparison (activeProductHandleValue !== lastActiveProductHandleSet) was true, meaning the last active drop just ended.
                // We do nothing here to leave the metafield with the previous handle.
                console.log(`[Metafield Updater] Active drop ended. Metafield will retain last value: '${lastActiveProductHandleSet}'. No update needed.`);
            }
             // --- End Update Logic ---

        } else {
             console.log(`[Metafield Updater] Active product handle value ('${activeProductHandleValue}') has not changed. No update/delete needed.`);
        }

    } catch (processingError) {
        console.error('[Metafield Updater] Error during update processing/GraphQL call:', processingError);
    }
}

// --- End Metafield Update Logic ---


// --- Main App Route (Non-Embedded) --- 
// Serve the main app without checking session first. Frontend will handle auth check.
app.get(
  '*', 
  async (req, res) => {
  // This handler now runs immediately
  console.log('(APP *) Handling request for:', req.originalUrl);
  const shop = req.query.shop; 

  // --- Check for shop parameter --- 
  if (!shop) {
    console.log('(APP *) Missing shop query parameter. Serving enter-shop page.');
    // If shop is missing, send the user to a page where they can enter it.
    try {
      const enterShopHtmlPath = path.join(__dirname, 'enter-shop.html'); // Assuming it's in the backend directory
      res.status(200).set('Content-Type', 'text/html').sendFile(enterShopHtmlPath);
    } catch (error) {
      console.error(`(APP *) Error sending enter-shop.html: ${error.message}`, error.stack);
      res.status(500).send("Internal Server Error: Could not load shop entry page.");
    }
    return; // Stop further processing for this request
  }
  // --- END Check ---

  // If shop *is* present, proceed to serve the frontend app
  const hostFromQuery = req.query.host; // Although non-embedded, keep reading it in case it's used elsewhere unexpectedly

  // --- Set Content Security Policy --- 
  // Calculate wssHost separately
  const wssHost = HOST.replace(/^https?:\/\//, ''); 
  
  // Restore the development mode check for CSP
  let scriptSrc = "'self' 'unsafe-inline' 'unsafe-eval' https://cdn.shopify.com/ https://app.shopify.com/";
  let connectSrc = `'self' ${HOST} wss://${wssHost} https://*.shopify.com https://shopify.com https://monorail-edge.shopifysvc.com https://*.supabase.co`;

  // Allow Vite dev server in development
  if (process.env.NODE_ENV === 'development') {
    const vitePort = 5173; 
    const viteServerHttp = `http://localhost:${vitePort}`;
    const HMR_HOST = process.env.VITE_HMR_HOST || '7e2e-47-145-133-162.ngrok-free.app'; 
    const viteServerWssNgrokHostDefaultPort = `wss://${HMR_HOST}`; 
    const viteServerWssNgrokHostDevPort = `wss://${HMR_HOST}:${vitePort}`; 
    const viteServerWsLocalhost = `ws://localhost:${vitePort}`; // Add ws localhost back

    scriptSrc += ` ${viteServerHttp}`;
    // Allow ALL potential WS targets for now
    connectSrc += ` ${viteServerHttp} ${viteServerWssNgrokHostDefaultPort} ${viteServerWssNgrokHostDevPort} ${viteServerWsLocalhost}`;
    // Clean up duplicates just in case
    connectSrc = connectSrc.split(' ').filter((v, i, a) => a.indexOf(v) === i).join(' ').trim();
    console.log(`(APP *) [DEVELOPMENT] Modifying CSP for Vite. Allowed Connects: ${connectSrc}`); // Updated log
  }
  
  // Set the potentially modified CSP header
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self' ${HOST} 'unsafe-eval' 'unsafe-inline'; ` +
    `script-src ${scriptSrc}; ` +
    `style-src 'self' 'unsafe-inline' https://cdn.shopify.com/; ` +
    `img-src 'self' data: https://cdn.shopify.com/; ` +
    `font-src 'self' https://cdn.shopify.com/; ` +
    `connect-src ${connectSrc}; ` // Complete the CSP header
  );
  console.log(`(APP *) Set CSP Header (Dev mode: ${process.env.NODE_ENV === 'development'})`);

  // --- Conditional HTML Serving --- 
  try {
    // Config for both dev and prod
    const shopifyConfig = {
      apiKey: shopify.config.apiKey,
      shop: shop,
    };
    const shopifyConfigScript =
      `<script>window.shopify = ${JSON.stringify(shopifyConfig)};</script>`;

    if (process.env.NODE_ENV === 'development') {
      // DEVELOPMENT: Serve HTML pointing to Vite dev server
      console.log(`(APP *) [DEVELOPMENT] Serving HTML for Vite dev server for shop: ${shop}`);
      const vitePort = 5173; // ** Use the correct Vite port if different **
      const viteServer = `http://localhost:${vitePort}`;
      res.status(200).set('Content-Type', 'text/html').send(`
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <link rel="icon" type="image/svg+xml" href="/vite.svg" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>Vite Dev Server</title>
            
            <!-- Manually Inject React Refresh Preamble -->
            <script type="module">
              import RefreshRuntime from "${viteServer}/@react-refresh"
              RefreshRuntime.injectIntoGlobalHook(window)
              window.$RefreshReg$ = () => {}
              window.$RefreshSig$ = () => (type) => type
              window.__vite_plugin_react_preamble_installed__ = true
            </script>

            <!-- Inject Shopify config -->
            ${shopifyConfigScript}
          </head>
          <body>
            <div id="root"></div>
            <!-- Point to Vite dev server -->
            <script type="module" src="${viteServer}/@vite/client"></script>
            <script type="module" src="${viteServer}/src/main.jsx"></script>
          </body>
        </html>
      `);
    } else {
      // PRODUCTION: Serve built index.html from frontend/dist
      console.log(`(APP *) [PRODUCTION] Serving frontend from dist folder for shop: ${shop}`);
      const indexHtmlPath = path.join(__dirname, '..', 'frontend', 'dist', 'index.html');
      let html = await fs.readFile(indexHtmlPath, 'utf8');
      // Inject shop info into the production HTML
      html = html.replace(
          '<!-- SHOPIFY_CONFIG -->',
          shopifyConfigScript 
      );
      res.status(200).set('Content-Type', 'text/html').send(html);
    }
    // --- End Conditional HTML Serving ---

  } catch (error) {
    console.error(`(APP *) Error serving frontend HTML: ${error.message}`, error.stack);
    res.status(500).send('Internal Server Error: Cannot serve frontend.');
  }
  // Ensure we don't fall through if response was sent
  return; 
});

// --- Start Server --- 
app.listen(PORT, async () => {
    console.log(`----------------------------------------------------`);
    console.log(`Backend server started using @shopify/shopify-api!`);
    console.log(`  - Listening on port: ${PORT}`);
    console.log(`  - App Host URL: ${HOST}`);
    console.log(`----------------------------------------------------`);
    console.log(`➡️  To install/run app:`);
    console.log(`   ${HOST}/auth?shop=your-development-store.myshopify.com`);
    console.log(`----------------------------------------------------`);

    // --- Initialize and Start Metafield Updater ---
    await initializeMetafieldUpdater(); // Wait for initial setup
    setInterval(updateShopMetafield, 15000); // Check every 15 seconds
    // --- End Metafield Updater Start ---

});
// --- End of file ---