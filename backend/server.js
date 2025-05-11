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
// Add near the top of the file with other imports
import rateLimit from 'express-rate-limit';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors'; // <-- ADDED

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

// --- Trust Proxy --- 
// Necessary for express-rate-limit to work correctly behind Render's proxy
app.set('trust proxy', 1); // Trust the first hop (Render's proxy)
// -------------------

// --- Add CORS Middleware ---
// WARNING: Allow all origins for now. Restrict this in production!
// Replace with: app.use(cors({ origin: 'YOUR_FRONTEND_RENDER_URL' }));
app.use(cors()); // <-- ADDED
// -------------------------

app.use(cookieParser());
app.use(express.json());

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
    
    // Add hardcoded shop domain check - only allow one specific store
    const APPROVED_SHOP_DOMAIN = process.env.APPROVED_SHOP_DOMAIN || 'your-store-name.myshopify.com';
    
    if (shop !== APPROVED_SHOP_DOMAIN) {
        console.log(`[/auth] Rejected unauthorized shop: ${shop}. Only ${APPROVED_SHOP_DOMAIN} is allowed.`);
        return res.status(403).send('This application is private and not available for this store.');
    }
    
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
            secure: process.env.NODE_ENV === 'production', // Secure in production only
            sameSite: 'lax' // Changed from 'None' to 'lax' to work better across browsers
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
    res.clearCookie(OAUTH_STATE_COOKIE_NAME, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    });

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

// Add before app.use statements
// Configure API rate limiter to stay well under Shopify's limits
const apiLimiter = rateLimit({
  windowMs: 1000, // 1 second
  max: 1, // Limit each IP to 1 request per second for Shopify-bound endpoints
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again after a short delay.' }
});

// Apply rate limiting to all Shopify-bound API routes
app.use('/api/products', apiLimiter);
app.use('/api/products-by-collection', apiLimiter);
app.use('/api/collections', apiLimiter);
app.use('/api/drops', apiLimiter);

app.get(
  '/auth/callback',
  validateOAuthState, // 1. Validate state first
  // 2. Replace library callback with manual token exchange
  async (req, res) => {
    console.log('[/auth/callback] State validated. Proceeding with manual token exchange.');
    const { shop, code } = req.query;
    
    // Add hardcoded shop domain check - only allow callbacks from approved store
    const APPROVED_SHOP_DOMAIN = process.env.APPROVED_SHOP_DOMAIN || 'your-store-name.myshopify.com';
    
    if (shop !== APPROVED_SHOP_DOMAIN) {
        console.log(`[/auth/callback] Rejected unauthorized shop: ${shop}. Only ${APPROVED_SHOP_DOMAIN} is allowed.`);
        return res.status(403).send('This application is private and not available for this store.');
    }
    
    // Ensure we clear the state cookie again just in case
    res.clearCookie(OAUTH_STATE_COOKIE_NAME, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    });

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

        // --- Redirect to FRONTEND App --- 
        const frontendUrl = process.env.FRONTEND_URL; // Read from environment variable
        if (!frontendUrl) {
            console.error("CRITICAL: FRONTEND_URL environment variable is not set!");
            return res.status(500).send("Internal Server Error: Application frontend URL is not configured.");
        }
        const redirectUrl = `${frontendUrl}/?shop=${encodeURIComponent(shop)}&token=${encodeURIComponent(tokenData.access_token)}`;
        console.log(`[/auth/callback] Redirecting to Frontend URL: ${redirectUrl}`);
        res.redirect(redirectUrl);
        // --- END Redirect ---

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
    // --- MODIFIED: Expect initial_start_time_utc --- 
    const { shop, queued_collection_id, initial_start_time_utc, duration_minutes } = req.body;
    console.log(`[/api/drops/schedule-all POST] Start Handler. Shop: ${shop}, Collection GID: ${queued_collection_id}`);
    
    // --- MODIFIED: Validate initial_start_time_utc and duration --- 
    if (!initial_start_time_utc || typeof initial_start_time_utc !== 'string') {
        console.error('[/api/drops/schedule-all POST] Invalid or missing initial_start_time_utc:', initial_start_time_utc);
        return res.status(400).json({ error: 'Invalid or missing initial start time (UTC).' });
    }
    // Basic ISO string check (can be more robust if needed)
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(initial_start_time_utc)) {
        console.error('[/api/drops/schedule-all POST] Invalid initial_start_time_utc format:', initial_start_time_utc);
        return res.status(400).json({ error: 'Invalid initial start time format. Expected UTC ISO string.' });
    }
    const durationMinsInt = parseInt(duration_minutes, 10);
    if (isNaN(durationMinsInt) || durationMinsInt <= 0) {
        console.error('[/api/drops/schedule-all POST] Invalid duration_minutes:', duration_minutes);
        return res.status(400).json({ error: 'Invalid duration. Must be a positive number.' });
    }
    // --- END MODIFIED VALIDATION ---

    let initialStartTime;
    try {
        // --- CORRECTED: Parse initial_start_time_utc directly --- 
        console.log(`[/api/drops/schedule-all POST] Parsing initial_start_time_utc: ${initial_start_time_utc}`);
        initialStartTime = new Date(initial_start_time_utc);
        // --- END CORRECTION ---
        
        if (isNaN(initialStartTime.getTime())) throw new Error('Invalid date/time combination after parsing UTC string.');
    } catch (e) { 
        console.error('[/api/drops/schedule-all POST] Error parsing date/time', e);
        return res.status(400).json({ error: `Invalid start date/time: ${e.message}` });
    }
    console.log(`[/api/drops/schedule-all POST] Parsed initialStartTime: ${initialStartTime?.toISOString()}`);

    try {
        // 1. Get session
        const session = req.shopifySession;
        if (!session || !session.accessToken) { throw new Error('Session or accessToken missing.'); }
        console.log(`[/api/drops/schedule-all POST] Step 1: Session retrieved. Token prefix: ${session.accessToken.substring(0,5)}...`);

        // 2. Setup GraphQL Client
        const client = new shopify.clients.Graphql({ session });
        console.log(`[/api/drops/schedule-all POST] Step 2: GraphQL Client created.`);

        // 3. Execute GraphQL Query
        const productsQuery = `
          query getCollectionProducts($id: ID!, $first: Int!) {
            collection(id: $id) {
              id
              title
              # Changed sortKey to CREATED
              products(first: $first, sortKey: CREATED) { 
                nodes {
                  id
                  title
                  featuredImage {
                    url
                  }
                }
              }
            }
          }
        `;
        const variables = { id: queued_collection_id, first: 250 };
        // Updated log message
        console.log(`[/api/drops/schedule-all POST] Step 3a: Executing GraphQL request for collection ${queued_collection_id}, sorting by CREATED ASC...`);
        
        const productsResponse = await client.request(productsQuery, { variables });
        
        console.log(`[/api/drops/schedule-all POST] Step 3b: GraphQL request completed.`);
        
        // 4. Process GraphQL Response
        if (productsResponse?.data?.errors) {
             console.error('[/api/drops/schedule-all POST] GraphQL Errors fetching products:', JSON.stringify(productsResponse.data.errors, null, 2));
             throw new Error(`GraphQL error fetching products: ${productsResponse.data.errors[0].message}`); 
         }
        const shopifyProductsData = productsResponse?.data?.collection?.products?.nodes;
        if (!shopifyProductsData) { 
            console.error('[/api/drops/schedule-all POST] Unexpected GraphQL response structure:', JSON.stringify(productsResponse?.data, null, 2));
            if (!productsResponse?.data?.collection) {
                console.error(`[/api/drops/schedule-all POST] Collection GID ${queued_collection_id} likely not found or access denied.`);
                return res.status(404).json({ error: `Collection with ID ${queued_collection_id} not found or access denied.` });
            }
            return res.status(502).json({ error: 'Failed to parse products from Shopify GraphQL response.' });
         }
        const shopifyProducts = shopifyProductsData.map(node => ({
            id: node.id, // Keep GID format
            title: node.title,
            image: { src: node.featuredImage?.url || null } // Adapt to match REST structure expected later
        }));
        console.log(`[/api/drops/schedule-all POST] Step 4: Processed GraphQL response. Found ${shopifyProducts.length} products.`);
        if (shopifyProducts.length === 0) { return res.status(200).json({ message: 'No products found in the specified collection to schedule.', scheduled_count: 0 }); } // MODIFIED message

        // --- NEW Step 4.5: Filter products by active status via REST API ---
        console.log(`[/api/drops/schedule-all POST] Step 4.5a: Filtering ${shopifyProducts.length} products by active status...`);
        const activeShopifyProducts = [];
        const restClient = new shopify.clients.Rest({ session }); // Create REST client once

        for (const product of shopifyProducts) {
            try {
                const productIdNumeric = product.id.split('/').pop();
                if (!productIdNumeric) {
                    console.warn(`[/api/drops/schedule-all POST] Could not extract numeric ID from GID ${product.id}`);
                    continue; // Skip if ID is invalid
                }
                // console.log(`[/api/drops/schedule-all POST] Checking status for product ID: ${productIdNumeric}`);
                const productDetailsResponse = await restClient.get({
                    path: `products/${productIdNumeric}`,
                    query: { fields: 'id,status' } // Only fetch status
                });

                if (productDetailsResponse?.body?.product?.status === 'active') {
                    activeShopifyProducts.push(product); 
                } else {
                    console.log(`[/api/drops/schedule-all POST] Product ${product.title} (ID: ${product.id}) is not active (status: ${productDetailsResponse?.body?.product?.status}). Skipping.`);
                }
            } catch (statusError) {
                console.error(`[/api/drops/schedule-all POST] Error fetching status for product ${product.id}:`, statusError.message);
                // Decide if you want to skip or include on error. Skipping is safer.
            }
        }
        console.log(`[/api/drops/schedule-all POST] Step 4.5b: Found ${activeShopifyProducts.length} active products after filtering.`);
        if (activeShopifyProducts.length === 0) { 
            return res.status(200).json({ message: 'No ACTIVE products found in the specified collection to schedule.', scheduled_count: 0 }); 
        }
        // --- END NEW Step 4.5 ---

        // 5. Fetch Existing Queued Drops from Supabase
        console.log(`[/api/drops/schedule-all POST] Step 5a: Fetching existing queued drops from Supabase...`);
        const { data: existingQueuedDrops, error: fetchError } = await supabase
            .from('drops')
            .select('product_id')
            .eq('shop', shop)
            .eq('status', 'queued');
        if (fetchError) { 
            console.error('[/api/drops/schedule-all POST] Error fetching existing drops:', fetchError);
            throw fetchError; 
        }
        const existingQueuedProductIds = new Set(existingQueuedDrops.map(d => d.product_id));
        console.log(`[/api/drops/schedule-all POST] Step 5b: Fetched ${existingQueuedDrops.length} existing drops.`);

        // 6. Filter Products
        const productsToSchedule = activeShopifyProducts.filter(p => !existingQueuedProductIds.has(p.id)); // Use activeShopifyProducts
        console.log(`[/api/drops/schedule-all POST] Step 6: Filtered products. ${productsToSchedule.length} active products need scheduling.`);
        if (productsToSchedule.length === 0) { return res.status(200).json({ message: 'All active products in the collection are already scheduled.', scheduled_count: 0 }); }

        // 7. Prepare Bulk Insert Data
        const dropsToInsert = [];
        let currentStartTime = initialStartTime;
        console.log(`[/api/drops/schedule-all POST] Step 7a: Preparing data for bulk insert...`);
        for (const product of productsToSchedule) {
            const durationMinsInt = parseInt(duration_minutes, 10); // Ensure duration is parsed here too
            const dropData = {
                product_id: product.id, 
                title: product.title,
                thumbnail_url: product.image?.src || null,
                start_time: currentStartTime.toISOString(),
                duration_minutes: durationMinsInt,
                shop: shop,
                status: 'queued'
            };
            dropsToInsert.push(dropData);
            currentStartTime = new Date(currentStartTime.getTime() + durationMinsInt * 60000);
        }
        console.log(`[/api/drops/schedule-all POST] Step 7b: Prepared ${dropsToInsert.length} objects for insert.`);

        // 8. Perform Bulk Insert
        console.log(`[/api/drops/schedule-all POST] Step 8a: Performing Supabase bulk insert...`);
        const { data: insertedData, error: insertError } = await supabase.from('drops').insert(dropsToInsert).select();
        if (insertError) { 
            console.error('[/api/drops/schedule-all POST] Error during bulk insert:', insertError);
            throw insertError; 
        }
        console.log(`[/api/drops/schedule-all POST] Step 8b: Bulk insert successful. Inserted ${insertedData?.length || 0} drops.`);

        // 9. Send Success Response
        console.log(`[/api/drops/schedule-all POST] Step 9: Sending success response.`);
        broadcastRefreshInstruction(shop);
        broadcastScheduledDrops(shop);
        res.status(201).json({ 
            message: `Successfully scheduled ${insertedData?.length || 0} new drops.`, 
            scheduled_count: insertedData?.length || 0,
        });

    } catch (error) {
        console.error('[/api/drops/schedule-all POST] CAUGHT ERROR:', error); // Log the full error object
        const errorMessage = error.message || 'Internal server error scheduling drops.';
        let statusCode = 500;
        // ... existing status code logic ...
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
    const shop = req.shopifySession?.shop; // Get shop from the validated session
    console.log(`[/api/settings POST] Request received for shop: ${shop}`);

    if (!shop) {
        // This should ideally not be reached if validateSession is working correctly
        // and req.shopifySession is always populated with a valid session.
        console.error('[/api/settings POST] Critical: Shop could not be determined from validated session.');
        return res.status(400).json({ error: 'Shop could not be determined. Session may be invalid.' });
    }
    
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

    // --- ADDED: Log settingsData before upsert ---
    console.log('[/api/settings POST] Data being upserted to Supabase:', settingsData);
    // --- END ADDED ---

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

// --- NEW: POST /api/drops/stop-and-clear-queue - Complete active, clear queue, reset settings ---
app.post('/api/drops/stop-and-clear-queue', validateSession, async (req, res) => {
    const shop = req.shopifySession?.shop;
    console.log(`[/api/drops/stop-and-clear-queue POST] Request received for shop: ${shop}`);

    if (!shop) {
        console.error('[/api/drops/stop-and-clear-queue POST] Critical: Shop could not be determined from validated session.');
        return res.status(400).json({ error: 'Shop could not be determined. Session may be invalid.' });
    }

    let activeDropCompletedTitle = null;
    let queuedDropsDeletedCount = 0;
    let settingsUpdated = false;

    try {
        // Step 1: Handle Active Drop (if any)
        console.log(`[/api/drops/stop-and-clear-queue POST] Step 1: Checking for active drop for shop ${shop}...`);
        const { data: activeDrop, error: activeDropError } = await supabase
            .from('drops')
            .select('id, title')
            .eq('shop', shop)
            .eq('status', 'active')
            .maybeSingle();

        if (activeDropError) {
            console.error(`[/api/drops/stop-and-clear-queue POST] Supabase error fetching active drop for ${shop}:`, activeDropError);
            throw activeDropError;
        }

        if (activeDrop) {
            console.log(`[/api/drops/stop-and-clear-queue POST] Active drop found (ID: ${activeDrop.id}, Title: ${activeDrop.title}). Marking as completed.`);
            const { error: updateActiveError } = await supabase
                .from('drops')
                .update({ status: 'completed', end_time: new Date().toISOString() })
                .eq('id', activeDrop.id)
                .eq('shop', shop);

            if (updateActiveError) {
                console.error(`[/api/drops/stop-and-clear-queue POST] Supabase error updating active drop ${activeDrop.id} to completed:`, updateActiveError);
                throw updateActiveError;
            }
            activeDropCompletedTitle = activeDrop.title;
            console.log(`[/api/drops/stop-and-clear-queue POST] Active drop ${activeDrop.id} marked as completed.`);

            // Trigger metafield update and broadcast
            if (req.shopifySession) {
                console.log(`[/api/drops/stop-and-clear-queue POST] Triggering metafield update for shop ${shop} after completing active drop.`);
                updateShopMetafield(shop, req.shopifySession, true); // Force update
            }
            io.to(shop).emit('active_drop', null); // Broadcast that there's no active drop
            broadcastCompletedDrops(shop); // Broadcast updated completed drops list
        } else {
            console.log(`[/api/drops/stop-and-clear-queue POST] No active drop found for shop ${shop}.`);
        }

        // Step 2: Clear Queued Drops
        console.log(`[/api/drops/stop-and-clear-queue POST] Step 2: Deleting queued drops for shop ${shop}...`);
        const { count: deletedCount, error: deleteQueuedError } = await supabase
            .from('drops')
            .delete()
            .eq('shop', shop)
            .eq('status', 'queued');

        if (deleteQueuedError) {
            console.error(`[/api/drops/stop-and-clear-queue POST] Supabase error deleting queued drops for ${shop}:`, deleteQueuedError);
            throw deleteQueuedError;
        }
        queuedDropsDeletedCount = deletedCount || 0;
        console.log(`[/api/drops/stop-and-clear-queue POST] Deleted ${queuedDropsDeletedCount} queued drops for shop ${shop}.`);

        // Step 3: Reset Queued Collection in Settings
        console.log(`[/api/drops/stop-and-clear-queue POST] Step 3: Resetting queued_collection_id in app_settings for shop ${shop}...`);
        const { error: updateSettingsError } = await supabase
            .from('app_settings')
            .update({ queued_collection_id: null })
            .eq('shop', shop);

        if (updateSettingsError) {
            console.error(`[/api/drops/stop-and-clear-queue POST] Supabase error updating app_settings for ${shop}:`, updateSettingsError);
            // Don't throw, as prior actions might have succeeded. Log and continue.
            console.warn('Continuing after settings update error to allow response.');
        } else {
            settingsUpdated = true;
            console.log(`[/api/drops/stop-and-clear-queue POST] Successfully reset queued_collection_id for shop ${shop}.`);
        }

        // Step 4: Broadcast Updates
        console.log(`[/api/drops/stop-and-clear-queue POST] Step 4: Broadcasting updates to shop ${shop}...`);
        broadcastScheduledDrops(shop); // Should be empty now
        if (settingsUpdated) {
            // Fetch and broadcast the updated settings to ensure client has the latest (especially the null collection_id)
            const { data: currentSettings, error: fetchSettingsError } = await supabase
                .from('app_settings')
                .select('queued_collection_id, drop_time, default_drop_duration_minutes, default_drop_date')
                .eq('shop', shop)
                .maybeSingle();
            if (fetchSettingsError) {
                console.error(`[/api/drops/stop-and-clear-queue POST] Error fetching settings for broadcast after update for ${shop}:`, fetchSettingsError);
            } else {
                io.to(shop).emit('settings', currentSettings || {
                    queued_collection_id: null,
                    drop_time: '10:00',
                    default_drop_duration_minutes: 60,
                    default_drop_date: null
                });
            }
        }

        // Construct success message
        let message = "Queue and settings updated.";
        if (activeDropCompletedTitle) {
            message = `Active drop '${activeDropCompletedTitle}' completed. `;
        } else {
            message = "No active drop to complete. ";
        }
        message += `${queuedDropsDeletedCount} scheduled drops cleared.`;
        if (settingsUpdated) {
            message += " Queued collection setting reset.";
        }

        console.log(`[/api/drops/stop-and-clear-queue POST] Operation successful for shop ${shop}. Message: ${message}`);
        res.status(200).json({ 
            message: message,
            activeDropCompleted: !!activeDropCompletedTitle,
            queuedDropsCleared: queuedDropsDeletedCount,
            settingsReset: settingsUpdated
        });

    } catch (error) {
        console.error(`[/api/drops/stop-and-clear-queue POST] Overall error for shop ${shop}:`, error);
        res.status(500).json({ error: 'An error occurred while stopping the queue and clearing drops.' });
    }
});

// --- Metafield Update Logic ---
// ADD: In-memory cache for shop GIDs and metafield instance GIDs
let shopMetafieldCache = {}; // Structure: { shop: { shopGid: '...', instanceGid: '...' } }
// ADD: In-memory map for last active handle set per shop
let lastActiveProductHandleSet = {}; // Structure: { shop: 'handle-string-or-null' }
// Track failed updates to prevent infinite retries
let lastMetafieldUpdateFailed = {}; // Structure: { shop: boolean }

// Function to check Supabase for active product and update Shopify shop metafield
// REFACTOR SIGNATURE
// async function updateShopMetafield() {
async function updateShopMetafield(shop, session, forceUpdate = false) { // <-- ADD force update parameter
    // VALIDATE INPUTS
    if (!shop || !session || !session.accessToken) {
        console.error(`[Metafield Updater DEBUG] Invalid arguments: Shop='${shop}', Session Valid=${session && session.accessToken ? 'Yes' : 'No'}, AccessToken Exists: ${!!session?.accessToken}`);
        return; // Cannot proceed without shop and a valid session
    }
    console.log(`[Metafield Updater DEBUG] Running update for shop: ${shop}, forceUpdate=${forceUpdate}. Session ID: ${session.id}, Expires: ${session.expires}`);

    try {
        // --- Get Shop GID and Metafield Instance GID (use cache) ---
        let cachedData = shopMetafieldCache[shop];
        if (!cachedData || !cachedData.shopGid) {
            console.log(`[Metafield Updater DEBUG] Cache miss for shop ${shop}. Querying GIDs...`);
            try {
                // Initialize GraphQL client using the passed session
                const client = new shopify.clients.Graphql({ session });
                console.log("[Metafield Updater DEBUG] GraphQL client initialized for GID fetching.");

                // Query 1: Get Shop GID
                const shopGidQuery = `{ shop { id } }`;
                console.log("[Metafield Updater DEBUG] Querying Shop GID...");
                const shopGidResponse = await client.query({ data: shopGidQuery });
                const fetchedShopGid = shopGidResponse?.body?.data?.shop?.id;
                console.log(`[Metafield Updater DEBUG] Shop GID Response: ${JSON.stringify(shopGidResponse?.body)}`);

                if (!fetchedShopGid) {
                    console.error(`[Metafield Updater DEBUG] Failed to fetch Shop GID for ${shop}.`);
                    return; // Cannot proceed without Shop GID
                }
                console.log(`[Metafield Updater DEBUG] Fetched Shop GID for ${shop}: ${fetchedShopGid}`);

                // Query 2: Find existing Metafield Instance GID
                const metafieldQuery = `
                  query GetShopMetafield { 
                    shop {
                      metafield(namespace: \"custom\", key: \"active_drop_product_handle\") {
                        id
                        value
                      }
                    }
                  }
                `;
                console.log("[Metafield Updater DEBUG] Querying existing metafield...");
                const metafieldResponse = await client.query({ data: { query: metafieldQuery } }); 
                console.log(`[Metafield Updater DEBUG] Existing Metafield Response: ${JSON.stringify(metafieldResponse?.body)}`);
                const fetchedInstanceGid = metafieldResponse?.body?.data?.shop?.metafield?.id;
                const initialValue = metafieldResponse?.body?.data?.shop?.metafield?.value; 

                if (fetchedInstanceGid) {
                     console.log(`[Metafield Updater DEBUG] Found existing metafield instance GID for ${shop}: ${fetchedInstanceGid}, Value: ${initialValue}`);
                     shopMetafieldCache[shop] = { shopGid: fetchedShopGid, instanceGid: fetchedInstanceGid };
                     if (lastActiveProductHandleSet[shop] === undefined) {
                          lastActiveProductHandleSet[shop] = initialValue || null; 
                          console.log(`[Metafield Updater DEBUG] Initialized lastActiveProductHandleSet[${shop}] from existing metafield: ${lastActiveProductHandleSet[shop]}`);
                     }
                } else {
                     console.log(`[Metafield Updater DEBUG] Metafield 'custom.active_drop_product_handle' not found for ${shop}.`);
                     shopMetafieldCache[shop] = { shopGid: fetchedShopGid, instanceGid: null };
                     if (lastActiveProductHandleSet[shop] === undefined) {
                          lastActiveProductHandleSet[shop] = null;
                          console.log(`[Metafield Updater DEBUG] Initialized lastActiveProductHandleSet[${shop}] to null (metafield not found).`);
                     }
                }
                cachedData = shopMetafieldCache[shop];
            } catch (error) {
                console.error(`[Metafield Updater DEBUG] Error during GID initialization for ${shop}:`, error.message, error.stack);
                return; 
            }
        } else {
             console.log(`[Metafield Updater DEBUG] Using cached GIDs for ${shop}: ShopGID=${cachedData.shopGid}, InstanceGID=${cachedData.instanceGid}`);
        }

        const currentShopGid = cachedData?.shopGid;
        if (!currentShopGid) {
            console.error(`[Metafield Updater DEBUG] Cannot proceed without Shop GID for ${shop}. Cache data: ${JSON.stringify(cachedData)}`);
            return;
        }
        // const currentMetafieldInstanceGid = cachedData?.instanceGid; // Not directly used in mutation if creating

        if (lastActiveProductHandleSet[shop] === undefined) {
            lastActiveProductHandleSet[shop] = null; 
            console.log(`[Metafield Updater DEBUG] Initialized lastActiveProductHandleSet[${shop}] to null (default after cache check).`);
        }
        const currentLastSetHandle = lastActiveProductHandleSet[shop];
        console.log(`[Metafield Updater DEBUG] Current last set handle for ${shop}: ${currentLastSetHandle}`);

        // Step 1: Query Supabase for the currently active product drop FOR THIS SHOP
        let activeProductGid = null;
        console.log(`[Metafield Updater DEBUG] Querying Supabase for active drop for shop ${shop}...`);
        try {
            const { data: activeDrop, error: dbError } = await supabase
                .from('drops')
                .select('product_id')
                .eq('status', 'active')
                .eq('shop', shop)
                .maybeSingle(); 

            if (dbError) {
                console.error(`[Metafield Updater DEBUG] Supabase error querying active drop for ${shop}:`, dbError);
                return; 
            }
            console.log(`[Metafield Updater DEBUG] Supabase active drop response for ${shop}: ${JSON.stringify(activeDrop)}`);

            if (activeDrop && activeDrop.product_id) { 
                activeProductGid = activeDrop.product_id;
                console.log(`[Metafield Updater DEBUG] Found active drop GID for ${shop}: ${activeProductGid}`);
            } else {
                console.log(`[Metafield Updater DEBUG] No active drop found in Supabase for ${shop}.`);
                activeProductGid = null; 
            }
        } catch (error) {
            console.error(`[Metafield Updater DEBUG] Exception querying Supabase active drop for ${shop}:`, error.message, error.stack);
            return;
        }

        let activeProductHandleValue = null;
        if (activeProductGid) {
            console.log(`[Metafield Updater DEBUG] Fetching handle for active product GID: ${activeProductGid}`);
            try {
                const client = new shopify.clients.Graphql({ session });
                console.log("[Metafield Updater DEBUG] GraphQL client initialized for handle fetching.");
                const handleQuery = `
                    query getProductHandle($id: ID!) {
                        product(id: $id) {
                            handle
                        }
                    }
                `;
                const handleVariables = { id: activeProductGid };
                console.log(`[Metafield Updater DEBUG] Querying product handle with GID: ${activeProductGid}`);
                const handleResponse = await client.query({ data: { query: handleQuery, variables: handleVariables } });
                console.log(`[Metafield Updater DEBUG] Product Handle Response: ${JSON.stringify(handleResponse?.body)}`);
                const fetchedHandle = handleResponse?.body?.data?.product?.handle;

                if (fetchedHandle) {
                    activeProductHandleValue = fetchedHandle;
                    console.log(`[Metafield Updater DEBUG] Successfully fetched handle: ${activeProductHandleValue}`);
                } else {
                    console.error(`[Metafield Updater DEBUG] Failed to fetch handle for GID ${activeProductGid}.`);
                }
            } catch (handleError) {
                 console.error(`[Metafield Updater DEBUG] Exception fetching handle for GID ${activeProductGid}:`, handleError.message, handleError.stack);
            }
        } else {
            console.log("[Metafield Updater DEBUG] No active product GID, so no handle to fetch.");
        }
        
        console.log(`[Metafield Updater DEBUG] Final activeProductHandleValue: '${activeProductHandleValue}'`);
        console.log(`[Metafield Updater DEBUG] Comparing for ${shop}: Current Handle='${activeProductHandleValue}', Last Set Handle='${currentLastSetHandle}', ForceUpdate=${forceUpdate}`);
        
        if (forceUpdate || activeProductHandleValue !== currentLastSetHandle) {
            console.log("[Metafield Updater DEBUG] Condition met: Proceeding with metafield update.");
            try {
                const client = new shopify.clients.Graphql({ session });
                console.log("[Metafield Updater DEBUG] GraphQL client initialized for metafield SET.");

                const mutation = ` 
                    mutation SetShopMetafield($metafields: [MetafieldsSetInput!]!) {
                      metafieldsSet(metafields: $metafields) {
                        metafields {
                          id
                          key
                          namespace
                          value
                          ownerType
                        }
                        userErrors {
                          field
                          message
                        }
                      }
                    }
                `; 

                let metafieldValueToSet;
                if (activeProductHandleValue !== null) {
                    metafieldValueToSet = activeProductHandleValue;
                    console.log(`[Metafield Updater DEBUG] ${forceUpdate ? "Force updating" : "Updating"} metafield to '${metafieldValueToSet}' for ${shop}`);
                } else {
                    metafieldValueToSet = ""; // Set to empty string if no active handle
                    console.log(`[Metafield Updater DEBUG] ${forceUpdate ? "Force clearing" : "Clearing"} metafield (setting to empty string) for ${shop}.`);
                }
                
                const variables = {
                    metafields: [
                        {
                            key: "active_drop_product_handle",
                            namespace: "custom",
                            ownerId: currentShopGid, 
                            type: "single_line_text_field",
                            value: metafieldValueToSet
                        }
                    ]
                };

                console.log(`[Metafield Updater DEBUG] Calling metafieldsSet with variables: ${JSON.stringify(variables)}`);
                const response = await client.query({ data: { query: mutation, variables } });
                console.log(`[Metafield Updater DEBUG] Metafield SET Response: ${JSON.stringify(response?.body, null, 2)}`);
                
                if (response?.body?.data?.metafieldsSet?.userErrors?.length > 0) {
                    console.error(`[Metafield Updater DEBUG] UserErrors during metafield SET for ${shop}:`, JSON.stringify(response.body.data.metafieldsSet.userErrors, null, 2));
                    lastMetafieldUpdateFailed[shop] = true;
                    return; 
                }
                if (response?.body?.errors) {
                    console.error(`[Metafield Updater DEBUG] GraphQL Errors during metafield SET for ${shop}:`, JSON.stringify(response.body.errors, null, 2));
                    lastMetafieldUpdateFailed[shop] = true;
                    return;
                }

                if (response?.body?.data?.metafieldsSet?.metafields) {
                    console.log(`[Metafield Updater DEBUG] Successfully SET metafield for ${shop}. New value: '${metafieldValueToSet}'`);
                    lastActiveProductHandleSet[shop] = metafieldValueToSet; // Update cache with the value we just set
                    lastMetafieldUpdateFailed[shop] = false;
                    // Update shopMetafieldCache with new/confirmed instance GID if available
                    const newInstanceGid = response.body.data.metafieldsSet.metafields[0]?.id;
                    if (newInstanceGid && cachedData) {
                        cachedData.instanceGid = newInstanceGid;
                        console.log(`[Metafield Updater DEBUG] Updated/confirmed instance GID in cache: ${newInstanceGid}`);
                    }
                } else {
                    console.error(`[Metafield Updater DEBUG] Failed to SET metafield for ${shop}. No metafields returned in response, but no explicit errors either.`);
                    lastMetafieldUpdateFailed[shop] = true; // Treat as failure
                }

            } catch (mutationError) {
                console.error(`[Metafield Updater DEBUG] Exception during metafield SET for ${shop}:`, mutationError.message, mutationError.stack);
                if (mutationError.response && mutationError.response.errors) {
                     console.error(`[Metafield Updater DEBUG] GraphQL error details from exception:`, JSON.stringify(mutationError.response.errors, null, 2));
                }
                lastMetafieldUpdateFailed[shop] = true;
            }
        } else {
            console.log(`[Metafield Updater DEBUG] Condition NOT met: No update needed for shop ${shop}. Handle '${activeProductHandleValue}' is same as last set '${currentLastSetHandle}' and forceUpdate is false.`);
            lastMetafieldUpdateFailed[shop] = false; // Reset failure flag as no update was attempted
        }
    } catch (error) {
        console.error(`[Metafield Updater DEBUG] UNHANDLED EXCEPTION in updateShopMetafield for ${shop}:`, error.message, error.stack);
        lastMetafieldUpdateFailed[shop] = true; // Mark as failed if an unexpected error occurs
    }
}

// --- END: Metafield Update Logic ---


// --- Main App Route (Non-Embedded) --- 

// --- Start Server --- 
// Replace app.listen with http.createServer for Socket.io support
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    // WARNING: Allow all origins for now. Restrict this in production!
    // Replace with: origin: "YOUR_FRONTEND_RENDER_URL",
    origin: "*", // <-- Kept permissive for now
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Socket.io authentication middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  const shop = socket.handshake.auth.shop;
  
  if (!token || !shop) {
    return next(new Error('Authentication error'));
  }
  
  // Verify the token - similar to verifyApiRequest middleware
  try {
    const client = new shopify.clients.Rest({
      session: { 
        shop: shop,
        accessToken: token,
        isOnline: false, 
      }
    });
    
    // Store shop and token in socket for use in event handlers
    socket.shop = shop;
    socket.token = token;
    next();
  } catch (error) {
    console.error('[Socket.io] Authentication error:', error);
    next(new Error('Authentication failed'));
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  // Store shop and token from the auth object for this connection
  const shop = socket.handshake.auth.shop;
  const token = socket.handshake.auth.token;
  
  if (!shop || !token) {
    socket.disconnect(true);
    return;
  }
  
  // Attach shop and token to socket object for use in event handlers
  socket.shop = shop;
  socket.token = token;
  
  console.log(`[Socket.io] Client connected for shop: ${shop}`);
  
  // --- Add real-time status monitoring ---
  // Add this socket to a room specific to this shop for targeted broadcasts
  socket.join(shop);
  
  // Add explicit join event that client can call to ensure they're in the room
  socket.on('join_shop_room', () => {
    socket.join(shop);
    console.log(`[Socket.io] Client explicitly joined room for shop: ${shop}`);
  });
  
  // Set up a heartbeat for this connection
  const heartbeatInterval = setInterval(() => {
    socket.emit('heartbeat', { timestamp: new Date().toISOString() });
  }, 60000); // Send a heartbeat every 60 seconds (was 30)
  
  // Start monitoring if needed - check if monitoring is already active
  if (!statusMonitoringIntervals[shop]) {
    console.log(`[Socket.io] Starting status monitoring for shop ${shop}`);
    startStatusMonitoring(shop);
  } else {
    console.log(`[Socket.io] Status monitoring already active for shop ${shop}`);
  }
  
  // Add a ping handler to keep the connection alive
  socket.on('ping_server', (callback) => {
    if (typeof callback === 'function') {
      callback({ status: 'ok', timestamp: new Date().toISOString() });
    } else {
      socket.emit('pong_response', { status: 'ok', timestamp: new Date().toISOString() });
    }
  });
  
  // When socket disconnects
  socket.on('disconnect', () => {
    console.log(`[Socket.io] Client disconnected for shop: ${shop}`);
    
    // Clear heartbeat interval
    clearInterval(heartbeatInterval);
    
    // Only stop monitoring if no clients left for this shop
    const roomExists = io.sockets.adapter.rooms.get(shop);
    const clientsLeft = roomExists ? roomExists.size : 0;
    
    if (clientsLeft === 0) {
      console.log(`[Socket.io] Last client disconnected for shop ${shop}, stopping status monitoring`);
      stopStatusMonitoring(shop);
    } else {
      console.log(`[Socket.io] ${clientsLeft} clients still connected for shop ${shop}, monitoring continues`);
    }
  });
  
  // --- Event Handlers ---
  
  // Get active drop
  socket.on('get_active_drop', async () => {
    try {
      console.log(`[Socket.io] Getting active drop for shop: ${socket.shop}`);
      
      // Fetch from your database or Shopify API
      const { data, error } = await supabase
        .from('drops')
        .select('*')
        .eq('shop', socket.shop)
        .eq('status', 'active')
        .limit(1); // Use limit instead of single to avoid PGRST116 error
        
      if (error) {
        console.error(`[Socket.io] Database error fetching active drop:`, error);
        throw error;
      }
      
      // Return the first item or null
      const activeDrop = data && data.length > 0 ? data[0] : null;
      console.log(`[Socket.io] Active drop found:`, activeDrop ? 'Yes' : 'No');
      
      socket.emit('active_drop', activeDrop);
    } catch (error) {
      console.error(`[Socket.io] Error fetching active drop:`, error);
      socket.emit('error', { message: 'Failed to fetch active drop' });
    }
  });
  
  // Get queued products for a collection
  socket.on('get_queued_products', async (collectionId) => {
    try {
      console.log(`[Socket.io] Getting queued products for collection: ${collectionId}`);
      
      // Extract numeric ID from GID format
      const collectionIdMatch = collectionId.match(/\d+$/);
      if (!collectionIdMatch) {
        console.error(`[Socket.io] Invalid collectionId format: ${collectionId}`);
        socket.emit('error', { message: 'Invalid collection ID format' });
        return;
      }
      const numericCollectionId = collectionIdMatch[0];
      
      const client = new shopify.clients.Rest({
        session: { 
          shop: socket.shop,
          accessToken: socket.token,
          isOnline: false, 
        }
      });
      
      // Use the correct endpoint - products with collection_id filter
      const response = await client.get({
        path: 'products',
        query: {
          collection_id: numericCollectionId,
          fields: 'id,title,image',
          status: 'active'
        }
      });
      
      if (!response.body || !response.body.products) {
        throw new Error('Invalid response format from Shopify');
      }
      
      // Map products to required format
      const products = response.body.products.map(product => ({
        id: product.id,
        title: product.title,
        imageUrl: product.image?.src || null
      }));
      
      socket.emit('queued_products', products);
    } catch (error) {
      console.error(`[Socket.io] Error fetching queued products:`, error);
      socket.emit('error', { message: 'Failed to fetch queued products' });
    }
  });
  
  // Get scheduled drops with pagination
  socket.on('get_scheduled_drops', async ({ page, limit }) => {
    try {
      console.log(`[Socket.io] Getting scheduled drops for shop: ${socket.shop}, page: ${page}, limit: ${limit}`);
      
      // Calculate offset
      const offset = (page - 1) * limit;
      
      // Fetch from your database
      const { data, error, count } = await supabase
        .from('drops')
        .select('*', { count: 'exact' })
        .eq('shop', socket.shop)
        .eq('status', 'queued')  // "scheduled" drops are "queued" in the database
        .order('start_time', { ascending: true })  // Use start_time instead of drop_date
        .range(offset, offset + limit - 1);
        
      if (error) throw error;
      
      socket.emit('scheduled_drops', { 
        drops: data || [], 
        totalCount: count || 0 
      });
    } catch (error) {
      console.error(`[Socket.io] Error fetching scheduled drops:`, error);
      socket.emit('error', { message: 'Failed to fetch scheduled drops' });
    }
  });
  
  // Get completed drops with pagination
  socket.on('get_completed_drops', async ({ page, limit }) => {
    try {
      console.log(`[Socket.io] Getting completed drops for shop: ${socket.shop}, page: ${page}, limit: ${limit}`);
      
      // Calculate offset
      const offset = (page - 1) * limit;
      
      // Fetch from your database
      const { data, error, count } = await supabase
        .from('drops')
        .select('*', { count: 'exact' })
        .eq('shop', socket.shop)
        .eq('status', 'completed')
        .order('end_time', { ascending: false })  // Use end_time instead of drop_date
        .range(offset, offset + limit - 1);
        
      if (error) throw error;
      
      socket.emit('completed_drops', { 
        drops: data || [], 
        totalCount: count || 0 
      });
    } catch (error) {
      console.error(`[Socket.io] Error fetching completed drops:`, error);
      socket.emit('error', { message: 'Failed to fetch completed drops' });
    }
  });
  
  // Get collections
  socket.on('get_collections', async () => {
    try {
      console.log(`[Socket.io] Getting collections for shop: ${socket.shop}`);
      
      const client = new shopify.clients.Rest({
        session: { 
          shop: socket.shop,
          accessToken: socket.token,
          isOnline: false, 
        }
      });
      
      // Fetch Smart Collections
      const smartCollectionsResponse = await client.get({
        path: 'smart_collections',
        query: { fields: 'id,handle,title' }
      });
      
      // Fetch Custom Collections
      const customCollectionsResponse = await client.get({
        path: 'custom_collections',
        query: { fields: 'id,handle,title' }
      });
      
      const smartCollections = smartCollectionsResponse.body.smart_collections || [];
      const customCollections = customCollectionsResponse.body.custom_collections || [];
      
      const allCollections = [
        ...smartCollections.map(col => ({ label: col.title, value: `gid://shopify/Collection/${col.id}` })),
        ...customCollections.map(col => ({ label: col.title, value: `gid://shopify/Collection/${col.id}` }))
      ];
      
      socket.emit('collections', allCollections);
    } catch (error) {
      console.error(`[Socket.io] Error fetching collections:`, error);
      socket.emit('error', { message: 'Failed to fetch collections' });
    }
  });
  
  // Get settings
  socket.on('get_settings', async () => {
    try {
      console.log(`[Socket.io] Getting settings for shop: ${socket.shop}`);
      
      const { data, error } = await supabase
        .from('app_settings')
        .select('queued_collection_id, drop_time, default_drop_duration_minutes, default_drop_date')
        .eq('shop', socket.shop)
        .maybeSingle();
        
      if (error) throw error;
      
      // Return data or default settings if none found
      socket.emit('settings', data || {
        queued_collection_id: null,
        drop_time: '10:00',
        default_drop_duration_minutes: 60,
        default_drop_date: null
      });
    } catch (error) {
      console.error(`[Socket.io] Error fetching settings:`, error);
      socket.emit('error', { message: 'Failed to fetch settings' });
    }
  });
});

// --- Real-time status monitoring implementation ---
// Store intervals by shop to allow stopping them when needed
const statusMonitoringIntervals = {};

// Start monitoring for a specific shop
function startStatusMonitoring(shop) {
  if (statusMonitoringIntervals[shop]) {
    console.log(`[Status Monitor] Monitoring already active for shop ${shop}`);
    return;
  }
  
  console.log(`[Status Monitor] Starting monitor for shop ${shop}`);
  
  // Force initial check immediately
  setTimeout(() => {
    console.log(`[Status Monitor] Running initial status check for shop ${shop}`);
    checkAndActivateScheduledDrops(shop);
    checkAndCompleteActiveDrops(shop);
  }, 500);
  
  // Check less frequently for status changes
  statusMonitoringIntervals[shop] = setInterval(async () => {
    try {
      console.log(`[Status Monitor] Running periodic check for shop ${shop}`);
      
      // Check for drops that should be active but aren't yet
      await checkAndActivateScheduledDrops(shop);
      
      // Check for drops that should be completed but are still active
      await checkAndCompleteActiveDrops(shop);
      
      // After checks complete, broadcast a refresh instruction less frequently
      // Only broadcast every 3rd check to reduce UI updates
      if (Math.random() < 0.33) { // ~33% chance to broadcast on each check
        broadcastRefreshInstruction(shop);
      }
    } catch (error) {
      console.error(`[Status Monitor] Error in status check for shop ${shop}:`, error);
    }
  }, 10000); // Check every 10 seconds (instead of 3)
}

// Stop monitoring for a specific shop
function stopStatusMonitoring(shop) {
  if (statusMonitoringIntervals[shop]) {
    console.log(`[Status Monitor] Stopping monitor for shop ${shop}`);
    clearInterval(statusMonitoringIntervals[shop]);
    delete statusMonitoringIntervals[shop];
  }
}

// Check for drops that should be activated
async function checkAndActivateScheduledDrops(shop) {
  console.log(`!!!!!!!!!! CHECKING TO ACTIVATE SCHEDULED DROPS FOR ${shop} AT ${new Date().toISOString()} !!!!!!!!!!`); 
  try {
    const now = new Date();
    console.log(`[checkAndActivateScheduledDrops DEBUG] Current time for check: ${now.toISOString()}`);
    
    // MODIFIED QUERY: Temporarily remove the start_time < now condition
    console.log(`[checkAndActivateScheduledDrops DEBUG] RUNNING MODIFIED QUERY (ignoring start_time)`); // <-- ADD THIS LOG
    const { data: dropsToActivate, error } = await supabase
      .from('drops')
      .select('*')
      .eq('shop', shop)
      .eq('status', 'queued')
      // .lt('start_time', now.toISOString()) // <-- TEMPORARILY COMMENTED OUT
      .order('start_time', { ascending: true });
    
    // Log the raw result of the query
    console.log(`[checkAndActivateScheduledDrops DEBUG] Supabase query (MODIFIED) for dropsToActivate result:`, JSON.stringify({ data: dropsToActivate, error }, null, 2)); // Log MODIFIED query result
    
    if (error) {
        console.error(`[checkAndActivateScheduledDrops DEBUG] Supabase error directly from query:`, error);
        throw error; 
    }
    
    if (dropsToActivate && dropsToActivate.length > 0) {
      console.log(`[Status Monitor] Found ${dropsToActivate.length} drops to activate for shop ${shop}`);
      
      // Get current active drop if any
      const { data: currentActive } = await supabase
        .from('drops')
        .select('id')
        .eq('shop', shop)
        .eq('status', 'active')
        .maybeSingle();
      
      // If there's already an active drop, complete it first
      if (currentActive) {
        console.log(`[Status Monitor] Completing current active drop ${currentActive.id} before activating new one`);
        await completeActiveDrop(shop, currentActive.id);
      }
      
      // Activate the earliest scheduled drop
      const dropToActivate = dropsToActivate[0];
      await activateDrop(shop, dropToActivate.id);
    }
  } catch (error) {
    console.error(`[Status Monitor] Error checking scheduled drops for shop ${shop}:`, error);
  }
}

// Check for active drops that should be completed
async function checkAndCompleteActiveDrops(shop) {
  try {
    const now = new Date();
    
    // Find active drops that should be completed based on end_time
    const { data: dropsToComplete, error } = await supabase
      .from('drops')
      .select('*')
      .eq('shop', shop)
      .eq('status', 'active')
      .lt('end_time', now.toISOString());
    
    if (error) throw error;
    
    if (dropsToComplete && dropsToComplete.length > 0) {
      console.log(`[Status Monitor] Found ${dropsToComplete.length} active drops to complete for shop ${shop}`);
      
      // Complete each drop
      for (const drop of dropsToComplete) {
        await completeActiveDrop(shop, drop.id);
      }
    }
  } catch (error) {
    console.error(`[Status Monitor] Error checking active drops for shop ${shop}:`, error);
  }
}

// Activate a drop by ID
async function activateDrop(shop, dropId) {
  console.log(`!!!!!!!!!! ATTEMPTING TO ACTIVATE DROP ${dropId} FOR ${shop} AT ${new Date().toISOString()} !!!!!!!!!!`); // <-- ADD THIS LOG
  try {
    console.log(`[Status Monitor] Attempting to activate drop ${dropId} for shop ${shop}`);
    
    // Update drop status to active
    const { data, error } = await supabase
      .from('drops')
      .update({ status: 'active' })
      .eq('id', dropId)
      .eq('shop', shop)
      .select()
      .single();
    
    if (error) throw error;
    
    console.log(`[Status Monitor] Successfully activated drop ${dropId} for shop ${shop}`);
    
    // Check if there are any connected clients for this shop
    const roomExists = io.sockets.adapter.rooms.get(shop);
    const clientCount = roomExists ? roomExists.size : 0;
    console.log(`[Status Monitor] Broadcasting to ${clientCount} clients in room ${shop}`);
    
    // Broadcast to all clients for this shop
    io.to(shop).emit('active_drop', data);
    
    // Also send status change notification
    io.to(shop).emit('status_change', {
      type: 'activated',
      id: data.id,
      title: data.title || 'Unknown Product',
      timestamp: new Date().toISOString()
    });
    
    // Also broadcast an explicit refresh instruction
    io.to(shop).emit('refresh_needed', {
      target: 'active_drop',
      reason: 'Drop activated',
      timestamp: new Date().toISOString()
    });
    
    // Also send scheduled drops update to reflect the change
    broadcastScheduledDrops(shop);
    
    // Reset the metafield cache to force a fresh update
    if (lastActiveProductHandleSet[shop] !== undefined) {
      console.log(`[Status Monitor] Reset metafield cache for shop ${shop} to force update on new activation.`);
      lastActiveProductHandleSet[shop] = null;
    }
    
    // Update shop metafield to clear the active product
    try {
      const offlineSessionId = shopify.session.getOfflineId(shop);
      console.log(`[Status Monitor DEBUG] In activateDrop: Attempting to load offline session ID: ${offlineSessionId} for shop ${shop}`); // MODIFIED LOG CONTEXT
      const offlineSession = await shopify.config.sessionStorage.loadSession(offlineSessionId);
      
      if (offlineSession && offlineSession.accessToken) {
        console.log(`[Status Monitor DEBUG] In activateDrop: Offline session loaded for ${shop}. AccessToken present: ${!!offlineSession.accessToken}. Triggering metafield update.`); // MODIFIED LOG CONTEXT
        updateShopMetafield(shop, offlineSession, true); // Force update
      } else {
        // Log the entire offlineSession object if it exists, otherwise just log that it's null/undefined
        const sessionDetailsForLog = offlineSession ? JSON.stringify(offlineSession) : String(offlineSession);
        console.error(`[Status Monitor DEBUG] In activateDrop: FAILED to load offline session or accessToken missing for shop ${shop}. Session Details: ${sessionDetailsForLog}`); // MODIFIED LOG CONTEXT
      }
    } catch (metafieldError) {
      console.error(`[Status Monitor] Error updating metafield after drop activation:`, metafieldError);
    }
    
    return data; // This should be here, before the main catch
  } catch (error) { // This is the main catch for activateDrop
    console.error(`[Status Monitor] Error activating drop ${dropId} for shop ${shop}:`, error);
    throw error; // Re-throw or handle as appropriate
  }
}

// Complete an active drop by ID
async function completeActiveDrop(shop, dropId) {
  try {
    console.log(`[Status Monitor] Attempting to complete drop ${dropId} for shop ${shop}`);
    
    // Update drop status to completed
    const { data, error } = await supabase
      .from('drops')
      .update({ status: 'completed' })
      .eq('id', dropId)
      .eq('shop', shop)
      .eq('status', 'active')
      .select()
      .single();
    
    if (error) throw error;
    
    console.log(`[Status Monitor] Successfully completed drop ${dropId} for shop ${shop}`);
    
    // Check if there are any connected clients for this shop
    const roomExists = io.sockets.adapter.rooms.get(shop);
    const clientCount = roomExists ? roomExists.size : 0;
    console.log(`[Status Monitor] Broadcasting to ${clientCount} clients in room ${shop}`);
    
    // Broadcast to all clients for this shop
    io.to(shop).emit('active_drop', null); // No active drop now
    
    // Also send status change notification
    io.to(shop).emit('status_change', {
      type: 'completed',
      id: data.id,
      title: data.title || 'Unknown Product',
      timestamp: new Date().toISOString()
    });
    
    // Also broadcast an explicit refresh instruction
    io.to(shop).emit('refresh_needed', {
      target: 'completed_drops',
      reason: 'Drop completed',
      timestamp: new Date().toISOString()
    });
    
    // Also send completed drops update to reflect the change
    broadcastCompletedDrops(shop);
    
    // Reset the metafield cache to force a fresh update
    if (lastActiveProductHandleSet[shop] !== undefined) {
      console.log(`[Status Monitor] Reset metafield cache for shop ${shop} to force update after completion.`);
      lastActiveProductHandleSet[shop] = null;
    }
    
    // Update shop metafield to clear the active product
    try {
      const offlineSessionId = shopify.session.getOfflineId(shop);
      console.log(`[Status Monitor DEBUG] In completeActiveDrop: Attempting to load offline session ID: ${offlineSessionId} for shop ${shop}`);
      const offlineSession = await shopify.config.sessionStorage.loadSession(offlineSessionId);
      
      if (offlineSession && offlineSession.accessToken) {
        console.log(`[Status Monitor DEBUG] In completeActiveDrop: Offline session loaded for ${shop}. AccessToken present: ${!!offlineSession.accessToken}. Triggering metafield update.`);
        updateShopMetafield(shop, offlineSession, true); // Force update
      } else {
        // Log the entire offlineSession object if it exists, otherwise just log that it's null/undefined
        const sessionDetailsForLog = offlineSession ? JSON.stringify(offlineSession) : String(offlineSession);
        console.error(`[Status Monitor DEBUG] In completeActiveDrop: FAILED to load offline session or accessToken missing for shop ${shop}. Session Details: ${sessionDetailsForLog}`);
      }
    } catch (metafieldError) {
      console.error(`[Status Monitor] Error updating metafield after drop completion:`, metafieldError);
    }
    
    return data; // This should be here, before the main catch
  } catch (error) { // This is the main catch for completeActiveDrop
    console.error(`[Status Monitor] Error completing drop ${dropId} for shop ${shop}:`, error);
    throw error; // Re-throw or handle as appropriate
  }
}

// Broadcast scheduled drops to all clients for a shop
async function broadcastScheduledDrops(shop) {
  try {
    // Fetch first page of scheduled drops
    const { data, error, count } = await supabase
      .from('drops')
      .select('*', { count: 'exact' })
      .eq('shop', shop)
      .eq('status', 'queued')
      .order('start_time', { ascending: true })
      .range(0, 4); // First page
    
    if (error) throw error;
    
    // Broadcast to all clients for this shop
    io.to(shop).emit('scheduled_drops', { 
      drops: data || [], 
      totalCount: count || 0 
    });
  } catch (error) {
    console.error(`[Status Monitor] Error broadcasting scheduled drops for shop ${shop}:`, error);
  }
}

// Broadcast completed drops to all clients for a shop
async function broadcastCompletedDrops(shop) {
  try {
    // Fetch first page of completed drops
    const { data, error, count } = await supabase
      .from('drops')
      .select('*', { count: 'exact' })
      .eq('shop', shop)
      .eq('status', 'completed')
      .order('end_time', { ascending: false })
      .range(0, 4); // First page
    
    if (error) throw error;
    
    // Broadcast to all clients for this shop
    io.to(shop).emit('completed_drops', { 
      drops: data || [], 
      totalCount: count || 0 
    });
  } catch (error) {
    console.error(`[Status Monitor] Error broadcasting completed drops for shop ${shop}:`, error);
  }
}

// Add a function to broadcast refresh instructions
function broadcastRefreshInstruction(shop) {
  try {
    const roomExists = io.sockets.adapter.rooms.get(shop);
    const clientCount = roomExists ? roomExists.size : 0;
    
    if (clientCount > 0) {
      // Only broadcast if there are clients listening
      console.log(`[Status Monitor] Broadcasting refresh instruction to ${clientCount} clients for shop ${shop}`);
      
      io.to(shop).emit('refresh_needed', {
        target: 'all',
        reason: 'Periodic refresh',
        timestamp: new Date().toISOString()
      });
    }
  } catch (err) {
    console.error(`[Status Monitor] Error broadcasting refresh instruction: ${err.message}`);
  }
}

// --- Server Listening Logic ---
const PORT_NUM = parseInt(process.env.PORT || '8081', 10); // Use Render's PORT or 8081 locally
// Listen on 0.0.0.0 to be accessible in container environments like Render
server.listen(PORT_NUM, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT_NUM}`);
  // Initialize monitoring or other startup tasks if needed
  // initializeAllShops(); // Example if you had this
});

// --- REMOVE ANY SERVERLESS HANDLER EXPORT ---
/*
const serverless = require('serverless-http');
const handler = serverless(app);
module.exports.handler = handler;
*/

// Add near verifyApiRequest function
// Retry logic for Shopify API calls
async function withRetry(fn, maxRetries = 3, initialDelay = 1000) {
  let retries = 0;
  
  while (true) {
    try {
      return await fn();
    } catch (error) {
      retries++;
      
      // If we've hit max retries or it's not a throttling error, rethrow
      if (retries >= maxRetries || !error.message.includes('throttling')) {
        throw error;
      }
      
      const delay = initialDelay * Math.pow(2, retries - 1);
      console.log(`[withRetry] Shopify throttled request. Retrying in ${delay}ms (attempt ${retries}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// --- Add a debugging endpoint to get and set shop metafield state ---
app.get('/api/debug/metafield', verifyApiRequest, validateSession, async (req, res) => {
  try {
    const shop = req.query.shop || req.shopifySession?.shop;
    
    if (!shop) {
      console.error(`[Debug Metafield] Missing shop parameter`);
      return res.status(400).json({ success: false, error: 'Missing shop parameter' });
    }
    
    if (!req.shopifySession) {
      console.error(`[Debug Metafield] No valid session for shop ${shop}`);
      return res.status(401).json({ success: false, error: 'No valid session' });
    }
    
    // Query Shopify for the current metafield value
    const client = new shopify.clients.Graphql({ session: req.shopifySession });
    
    const query = `
      query GetShopMetafield { 
        shop {
          metafield(namespace: "custom", key: "active_drop_product_handle") {
            id
            value
            createdAt
            updatedAt
          }
        }
      }
    `;
    
    const response = await client.query({ data: { query } });
    
    if (response.body?.errors) {
      console.error(`[Debug Metafield] GraphQL errors:`, response.body.errors);
      return res.status(500).json({ 
        success: false, 
        error: 'GraphQL errors', 
        details: response.body.errors 
      });
    }
    
    const metafield = response.body?.data?.shop?.metafield;
    
    // Get cache state
    const cacheState = {
      shopGid: shopMetafieldCache[shop]?.shopGid || null,
      instanceGid: shopMetafieldCache[shop]?.instanceGid || null,
      lastActiveProductHandle: lastActiveProductHandleSet[shop] || null,
      lastUpdateFailed: lastMetafieldUpdateFailed[shop] || false
    };
    
    return res.json({
      success: true,
      current_metafield: metafield,
      cache_state: cacheState
    });
  } catch (error) {
    console.error(`[Debug Metafield] Error:`, error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint to force metafield update
app.post('/api/debug/metafield/update', verifyApiRequest, validateSession, async (req, res) => {
  try {
    const shop = req.query.shop || req.shopifySession?.shop;
    
    if (!shop) {
      console.error(`[Debug Metafield Update] Missing shop parameter`);
      return res.status(400).json({ success: false, error: 'Missing shop parameter' });
    }
    
    if (!req.shopifySession) {
      console.error(`[Debug Metafield Update] No valid session for shop ${shop}`);
      return res.status(401).json({ success: false, error: 'No valid session' });
    }
    
    // Clear cache state to force a fresh fetch
    if (req.body.reset_cache) {
      console.log(`[Debug Metafield Update] Resetting cache for shop ${shop}`);
      delete shopMetafieldCache[shop];
      lastActiveProductHandleSet[shop] = null;
      lastMetafieldUpdateFailed[shop] = false;
    }
    
    console.log(`[Debug Metafield Update] Forcing metafield update for shop ${shop}`);
    
    // Call updateShopMetafield with forceUpdate=true
    await updateShopMetafield(shop, req.shopifySession, true);
    
    return res.json({
      success: true,
      message: 'Metafield update triggered'
    });
  } catch (error) {
    console.error(`[Debug Metafield Update] Error:`, error);
    return res.status(500).json({ success: false, error: error.message });
  }
});