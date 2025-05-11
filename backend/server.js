import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import fs from 'fs/promises';

// Shopify & Supabase specific imports
import { baseShopifyApi as shopify } from './shopify.js'; // Assuming this is the configured shopifyApi object
import { supabase } from './supabaseClient.js';

// Route Modules
import authRoutes from './authRoutes.js';
import shopifyApiRoutes from './shopifyApiRoutes.js';
import dropRoutes, { initializeDropRoutes } from './dropRoutes.js';
import settingsRoutes from './settingsRoutes.js';
import debugRoutes from './debugRoutes.js';

// Service/Manager Modules
import { getValidShopSession, setValidShopSession } from './apiMiddlewares.js'; // verifyApiRequest and validateSession are used by routers directly
import { updateShopMetafield, resetMetafieldCacheForShop } from './metafieldManager.js';
import { initializeStatusMonitor } from './statusMonitor.js';
import { initializeSocketManager } from './socketManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initial console logs for environment variables
console.log(`[dotenv] Loaded HOST: ${process.env.HOST}`);
console.log(`[dotenv] Loaded API Key: ${process.env.SHOPIFY_API_KEY ? 'Exists' : 'MISSING!'}`);
console.log(`DEBUG: SHOPIFY_API_KEY loaded: ${process.env.SHOPIFY_API_KEY ? 'Yes' : 'NO!'}`);
console.log(`DEBUG: SHOPIFY_API_SECRET loaded: ${process.env.SHOPIFY_API_SECRET ? 'Yes' : 'NO!'}`);
console.log(`DEBUG: Scopes: ${process.env.SHOPIFY_API_SCOPES}`);

// Validate essential env vars from process.env (HOST and SHOPIFY_API_KEY already used by shopify.js)
const { PORT } = process.env;
if (!process.env.HOST) { // Re-check since shopify.js also checks, but good for server.js context
    console.error('Error: HOST environment variable is not set in backend/.env');
    process.exit(1);
}

const app = express();

// --- Core Middleware ---
app.set('trust proxy', 1); // For proxies like Render
app.use(cors()); // Enable CORS for all routes
app.use(cookieParser());
app.use(express.json()); // Parse JSON bodies

// --- Rate Limiting (applied to specific Shopify API proxy routes if needed) ---
const shopifyProxyLimiter = rateLimit({
  windowMs: 1000, // 1 second
  max: 2, // Adjusted slightly, was 1. Consider Shopify's overall limits.
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests to Shopify proxied endpoints, please try again after a short delay.' }
});

// Apply this limiter to routes that directly proxy to Shopify and might be hit frequently
// Routers themselves will apply verifyApiRequest or validateSession as needed.
// app.use('/api/collections', shopifyProxyLimiter); // Example
// app.use('/api/products', shopifyProxyLimiter); // Example

// --- Mount Routers ---
app.use('/auth', authRoutes);
app.use('/api/shopify', shopifyApiRoutes); // Prefixed for clarity, e.g., /api/shopify/collections
app.use('/api/drops', dropRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/debug', debugRoutes);


// --- HTTP Server and Socket.IO Server ---
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"], credentials: true }
});

// --- Shared Broadcast Functions (using the created 'io' instance) ---
// These are passed to modules that need to emit socket events.
async function broadcastRefreshInstruction(shop) {
    if (io) io.to(shop).emit('refresh_needed', { target: 'all', reason: 'Data updated', timestamp: new Date().toISOString() });
}
async function broadcastScheduledDrops(shop) {
    if (io) {
        try {
            const { data, count } = await supabase.from('drops').select('*', { count: 'exact' }).eq('shop', shop).eq('status', 'queued').order('start_time', { ascending: true }).range(0, 4);
            io.to(shop).emit('scheduled_drops', { drops: data || [], totalCount: count || 0 });
        } catch (e) { console.error(`[BroadcastError] Failed to broadcastScheduledDrops for ${shop}:`, e.message); }
    }
}
async function broadcastCompletedDrops(shop) {
    if (io) {
        try {
            const { data, count } = await supabase.from('drops').select('*', { count: 'exact' }).eq('shop', shop).eq('status', 'completed').order('end_time', { ascending: false }).range(0, 4);
            io.to(shop).emit('completed_drops', { drops: data || [], totalCount: count || 0 });
        } catch (e) { console.error(`[BroadcastError] Failed to broadcastCompletedDrops for ${shop}:`, e.message); }
    }
}
async function broadcastSettings(shop) { // Used by dropRoutes after clearing queue/settings
    if (io) {
        try {
            const { data } = await supabase.from('app_settings').select('queued_collection_id, drop_time, default_drop_duration_minutes, default_drop_date').eq('shop', shop).maybeSingle();
            io.to(shop).emit('settings', data || { queued_collection_id: null, drop_time: '10:00', default_drop_duration_minutes: 60, default_drop_date: null });
        } catch (e) { console.error(`[BroadcastError] Failed to broadcastSettings for ${shop}:`, e.message); }
    }
}
async function broadcastActiveDrop(shop, activeDropData) { // Used by statusMonitor
     if (io) io.to(shop).emit('active_drop', activeDropData);
}
async function broadcastStatusChange(shop, eventData) { // Used by statusMonitor
    if(io) io.to(shop).emit('status_change', eventData);
}


// --- Initialize Modules with Dependencies ---
const sharedFunctionsForModules = {
    updateShopMetafield,
    broadcastRefreshInstruction,
    broadcastScheduledDrops,
    broadcastCompletedDrops,
    broadcastSettings,
    broadcastActiveDrop,
    broadcastStatusChange,
    getValidShopSession, // From apiMiddlewares, useful for background tasks
    // shopifyInstance: shopify, // Pass the configured Shopify API instance if modules need it directly
    // supabaseInstance: supabase, // Pass Supabase client if modules need it directly (they mostly import it)
};

if (typeof initializeDropRoutes === 'function') {
    initializeDropRoutes(io, sharedFunctionsForModules);
} else {
    console.error('[Server.js] initializeDropRoutes is not a function.');
}

if (typeof initializeStatusMonitor === 'function') {
    initializeStatusMonitor(io, sharedFunctionsForModules);
} else {
    console.error('[Server.js] initializeStatusMonitor is not a function.');
}

if (typeof initializeSocketManager === 'function') {
    initializeSocketManager(io); // SocketManager imports its other dependencies like start/stopStatusMonitoring
} else {
    console.error('[Server.js] initializeSocketManager is not a function.');
}

// --- Static Frontend Files ---
const FRONTEND_BUILD_PATH = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(FRONTEND_BUILD_PATH, { index: false }));

// Serve enter-shop.html for the root, otherwise serve main app for SPA routing
app.get('/', async (req, res) => {
    const enterShopHtmlPath = path.join(__dirname, 'enter-shop.html');
    try {
        await fs.access(enterShopHtmlPath); // Check if file exists
        res.status(200).set('Content-Type', 'text/html').sendFile(enterShopHtmlPath);
    } catch {
        // Fallback to index.html if enter-shop.html is not found or for other root requests
        res.sendFile(path.join(FRONTEND_BUILD_PATH, 'index.html'));
    }
});

// All other /app/* routes should serve the SPA's index.html
app.get(['/app', '/app/*'], (req, res) => {
    res.sendFile(path.join(FRONTEND_BUILD_PATH, 'index.html'));
});


// --- Server Listen ---
const PORT_TO_USE = PORT || '8081';
server.listen(PORT_TO_USE, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT_TO_USE}`);
});

export { app, server };