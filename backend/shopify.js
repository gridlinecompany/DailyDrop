import { shopifyApi, LogSeverity, LATEST_API_VERSION, ApiVersion } from '@shopify/shopify-api';
import { shopifyApp } from '@shopify/shopify-app-express';
import '@shopify/shopify-api/adapters/node'; // Import Node adapter
import dotenv from 'dotenv'; // Use import for dotenv
import path from 'path';     // Use import for path
import { fileURLToPath } from 'url'; // Needed for __dirname workaround
import { PostgreSQLSessionStorage } from '@shopify/shopify-app-session-storage-postgresql'; // ADD THIS

// Workaround for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env variables using import
dotenv.config({ path: path.join(__dirname, '.env') });

const { SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_SCOPES, HOST } = process.env;

// Validate essential env vars
if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET || !SHOPIFY_SCOPES || !HOST) {
    console.error('CRITICAL ERROR: Missing required environment variables in backend/.env');
    console.error('Ensure SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_SCOPES, and HOST are set.');
    process.exit(1);
}

// --- Supabase/PostgreSQL Setup ---
const { 
    SUPABASE_DB_HOST, 
    SUPABASE_DB_DATABASE, 
    SUPABASE_DB_PORT, 
    SUPABASE_DB_USER, 
    SUPABASE_DB_PASSWORD 
} = process.env;

// Basic validation for Supabase DB Env Vars
if (!SUPABASE_DB_HOST || !SUPABASE_DB_DATABASE || !SUPABASE_DB_PORT || !SUPABASE_DB_USER || !SUPABASE_DB_PASSWORD) {
    console.error("Error: Missing one or more Supabase DB environment variables (SUPABASE_DB_HOST, SUPABASE_DB_DATABASE, SUPABASE_DB_PORT, SUPABASE_DB_USER, SUPABASE_DB_PASSWORD).");
    process.exit(1);
}

// --- Build the correct Postgres URL --- 
const dbUrl = `postgresql://${SUPABASE_DB_USER}:${encodeURIComponent(SUPABASE_DB_PASSWORD)}@${SUPABASE_DB_HOST}:${SUPABASE_DB_PORT}/${SUPABASE_DB_DATABASE}?sslmode=require`;

console.log(`[shopify.js] Configuring PostgreSQLSessionStorage with dbUrl: ${dbUrl.replace(SUPABASE_DB_PASSWORD, '********')}`); // Log masked URL
// -----------------------------------------

// const sessionDb = new PostgreSQLSessionStorage(dbConfig); // Pass config object
const sessionDb = new PostgreSQLSessionStorage(dbUrl); // Pass URL string

console.log('[shopify.js] Using PostgreSQLSessionStorage for Shopify sessions.');
// --------------------------------

// Initialize the Shopify API library
// See https://github.com/Shopify/shopify-api-js/blob/main/docs/reference/shopifyApi.md
const shopify = shopifyApi({
    apiKey: SHOPIFY_API_KEY,
    apiSecretKey: SHOPIFY_API_SECRET,
    scopes: SHOPIFY_SCOPES.split(','), // Read from .env again
    // scopes: ['write_products'], // Keep ONLY write_products hardcoded
    // Use only hostname for hostName, as per docs examples
    hostName: HOST.replace(/^https?:\/\//, ''),
    // hostScheme: 'https', // Keep commented out, let library infer
    // Use specific API version matching template
    apiVersion: ApiVersion.January25, 
    // RE-ADD isEmbeddedApp: true explicitly
    isEmbeddedApp: false, 
    sessionStorage: sessionDb,
    // Explicitly set cookie options for cross-domain iframe context
    cookieOptions: {
        sameSite: "None", // Required for cross-domain cookies
        secure: true,      // Required for SameSite=None
    },
    // Enable debug logging
    logger: {
        level: LogSeverity.Debug, 
        timestamps: true 
    },
});

// Create the Shopify App middleware instance using the initialized shopifyApi object
// This provides helpful middleware for auth, session validation, etc.
// --- REMOVE THIS OLD INSTANCE CREATION ---
/*
const shopifyAppInstance = shopifyApp({
    api: shopify,
    auth: {
        path: '/auth', // Matches the path we'll use in server.js
        callbackPath: '/auth/callback', // Matches the path we'll use in server.js
    },
    webhooks: {
        path: '/api/webhooks', // Standard path for Shopify webhooks
    },
    sessionStorage: sessionStorage,
});
*/
// ----------------------------------------

// REMOVED: Log to confirm instance creation (No longer needed here)
// console.log('[shopify.js] shopifyAppInstance created:', typeof shopifyAppInstance, shopifyAppInstance !== undefined && shopifyAppInstance !== null);

// --- Wrap instance creation in a function ---
function createShopifyAppInstance() {
    const scopesArray = SHOPIFY_SCOPES ? SHOPIFY_SCOPES.split(',') : [];
    console.log(`[shopify.js] Scopes passed to shopifyApp: ${scopesArray.join(',')}`); // Log scopes being passed
    
    const shopifyAppInstance = shopifyApp({
        api: shopify, // Pass the main api instance
        // Explicitly pass scopes here as well, reading from .env
        scopes: scopesArray,
        auth: {
            path: '/auth', 
            callbackPath: '/auth/callback',
        },
        sessionStorage: sessionDb,
    });
    return shopifyAppInstance;
}
// -------------------------------------------

// Export the creator function as default
export default createShopifyAppInstance;

// Also export the base api instance if needed for direct calls outside middleware
export const baseShopifyApi = shopify; 