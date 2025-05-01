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
        const scopesString = process.env.SHOPIFY_SCOPES || ''; 
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

        console.log(`[/auth] Redirecting to Shopify OAuth URL. Scopes: ${scopesString}. State included.`);
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

        console.log('[/auth/callback] Successfully exchanged code for token. Scopes received:', tokenData.scope);
        
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
        // -----------------------------------------------------

        // Manually store the session instance
        console.log(`[/auth/callback] Storing session instance manually. ID: ${sessionId}`);
        const sessionStorage = shopify.config.sessionStorage;
        const stored = await sessionStorage.storeSession(session);
        if (!stored) {
            console.error('[/auth/callback] Failed to store session manually!');
            return res.status(500).send('Failed to save session data.');
        }
        console.log('[/auth/callback] Session stored successfully.');

        // --- Redirect to App --- 
        console.log(`[/auth/callback] Redirecting to /?shop=${shop}&token=PRESENT`);
        res.redirect(`/?shop=${encodeURIComponent(shop)}&token=${encodeURIComponent(tokenData.access_token)}`);

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

// --- Add a simple API endpoint to verify session validity ---
// This will be called by the frontend using authenticatedFetch
app.get(
    '/api/verify-session', 
    async (req, res) => {
        console.log('[/api/verify-session] Received request. Checking for existing session in DB...');
        const shop = req.query.shop; 

        if (!shop) {
             console.log('[/api/verify-session] Missing shop query parameter.');
             return res.status(400).send('Bad Request: Missing shop query parameter.');
        }

        try {
            // Access the configured session storage adapter
            const sessionStorage = shopify.config.sessionStorage;
            
            // Check if any sessions exist for this shop
            // Use findSessionsByShop which should return an array of sessions
            const sessions = await sessionStorage.findSessionsByShop(shop);

            if (sessions && sessions.length > 0) {
                 console.log(`[/api/verify-session] Found ${sessions.length} existing session(s) for shop ${shop} in DB.`);
                 // We only care that *a* session exists, implying successful auth previously
                 return res.sendStatus(200); // OK
            } else {
                 console.log(`[/api/verify-session] No session found for shop ${shop} in DB via findSessionsByShop.`);
                 return res.sendStatus(401); // Unauthorized
            }

        } catch (error) {
            console.error(`[/api/verify-session] Error checking session for shop ${shop} using findSessionsByShop:`, error);
            return res.sendStatus(500); // Internal Server Error on DB error
        }
    }
);

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

// --- NEW: API endpoint to get collections ---
app.get(
    '/api/collections',
    async (req, res) => {
        console.log('[/api/collections] Received request.');
        const shop = req.query.shop;

        if (!shop) {
            console.log('[/api/collections] Missing shop query parameter.');
            return res.status(400).send('Bad Request: Missing shop query parameter.');
        }

        let session = null;
        try {
            const sessionStorage = shopify.config.sessionStorage;
            const sessions = await sessionStorage.findSessionsByShop(shop);

            if (sessions && sessions.length > 0) {
                session = sessions[0]; 
                console.log(`[/api/collections] Found session for shop ${shop}.`);
                // Log the scopes associated with this specific session
                console.log(`[/api/collections] Scopes in found session: ${session.scope}`); 
            } else {
                console.log(`[/api/collections] No session found for shop ${shop}. Cannot fetch collections.`);
                return res.sendStatus(401); // Unauthorized
            }

            const client = new shopify.clients.Rest({ session });
            console.log('[/api/collections] REST Client created. Fetching collections...');

            // Fetch both custom and smart collections (or choose one type if preferred)
            // We'll fetch a limited number for now, add pagination if needed
            const [customCollectionsResponse, smartCollectionsResponse] = await Promise.all([
                client.get({ path: 'custom_collections', query: { limit: 50 } }),
                client.get({ path: 'smart_collections', query: { limit: 50 } })
            ]);

            const customCollections = customCollectionsResponse.body?.custom_collections || [];
            const smartCollections = smartCollectionsResponse.body?.smart_collections || [];

            // Combine and format the results for Polaris Select
            const allCollections = [...customCollections, ...smartCollections].map(col => ({
                label: col.title, // Use 'label' key
                value: col.admin_graphql_api_id || col.id.toString() // Use 'value' key, prefer GID
            })); 
            
            // Sort collections alphabetically by label
            allCollections.sort((a, b) => a.label.localeCompare(b.label)); // Sort by label

            console.log(`[/api/collections] Successfully fetched ${allCollections.length} collections.`);
            res.status(200).json(allCollections);

        } catch (error) {
             console.error(`[/api/collections] Error processing request for shop ${shop}:`, error);
             // Add similar error handling as other endpoints
             if (error.response && (error.response.code === 401 || error.response.code === 403)) { 
                 return res.status(error.response.code).send('Unauthorized/Forbidden to fetch collections.');
             } else {
                 return res.status(500).send('Internal Server Error while fetching collections.');
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

// POST /api/drops - Create a new drop
app.post('/api/drops', validateSession, async (req, res) => {
    // Use field names consistent with Supabase 'drops' table & Project Brief
    const { 
        product_id, 
        title, 
        thumbnail_url, 
        start_time, 
        duration_hours, 
        shop // Passed from frontend modal
    } = req.body;
    
    console.log(`[/api/drops POST] Request received for shop: ${shop}`);
    console.log(`[/api/drops POST] Received payload:`, req.body);

    // Basic validation (adjust based on required fields for Supabase table)
    if (!product_id || !title || !start_time || !duration_hours || !shop) {
        console.log('[/api/drops POST] Missing required fields.');
        return res.status(400).json({ error: 'Missing required fields: product_id, title, start_time, duration_hours, shop.' });
    }

    // Prepare data for Supabase insert
    const dropData = {
        product_id, 
        title,
        thumbnail_url: thumbnail_url || null, // Allow null thumbnail
        start_time, 
        duration_hours,
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

// --- End Daily Drops API Routes ---

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
    const HMR_HOST = process.env.VITE_HMR_HOST || 'c81a-47-145-133-162.ngrok-free.app'; 
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
    `connect-src ${connectSrc}; ` 
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

  // If session invalid, redirect to auth (This part might not be reachable anymore)
  // ... rest of the middleware ...
});

// --- Start Server --- 
app.listen(PORT, () => {
    console.log(`----------------------------------------------------`);
    console.log(`Backend server started using @shopify/shopify-api!`);
    console.log(`  - Listening on port: ${PORT}`);
    console.log(`  - App Host URL: ${HOST}`);
    console.log(`----------------------------------------------------`);
    console.log(`➡️  To install/run app:`);
    console.log(`   ${HOST}/auth?shop=your-development-store.myshopify.com`);
    console.log(`----------------------------------------------------`);
});