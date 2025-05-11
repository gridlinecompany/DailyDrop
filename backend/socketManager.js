import { baseShopifyApi as shopify } from './shopify.js';
import { supabase } from './supabaseClient.js';
import { getValidShopSession, setValidShopSession } from './apiMiddlewares.js'; // Assuming setValidShopSession is exported if needed here
import { startStatusMonitoring, stopStatusMonitoring } from './statusMonitor.js';

let ioInstance;

export function initializeSocketManager(io) {
    ioInstance = io;

    // Socket.io authentication middleware
    ioInstance.use(async (socket, next) => {
        const token = socket.handshake.auth.token;
        const shop = socket.handshake.auth.shop;
        console.log(`[SocketManager Auth] Attempting for shop: ${shop}, token present: ${!!token}`);

        if (!token || !shop) {
            return next(new Error('Authentication error: Missing token or shop.'));
        }

        try {
            let session = getValidShopSession(shop);
            if (session && session.accessToken && session.accessToken === token) { // Check if token matches cached session
                socket.shop = shop;
                socket.token = session.accessToken;
                socket.shopifySession = session;
                console.log(`[SocketManager Auth] Authenticated (using matched cached session) for shop: ${shop}`);
                return next();
            } else {
                 // If not in cache or token mismatch, try to load from DB and verify against passed token
                 const sessionsFromDb = await shopify.config.sessionStorage.findSessionsByShop(shop);
                 const dbSession = sessionsFromDb.find(s => s.accessToken === token && !s.isOnline);

                 if (dbSession) {
                    socket.shop = shop;
                    socket.token = dbSession.accessToken;
                    socket.shopifySession = dbSession;
                    setValidShopSession(shop, dbSession); // Update cache with this validated session
                    console.log(`[SocketManager Auth] Authenticated (loaded and validated session from DB) for shop: ${shop}`);
                    return next();
                 } else {
                    console.warn(`[SocketManager Auth] No valid session found or token mismatch for shop: ${shop}`);
                    return next(new Error('Authentication failed: No valid session or token mismatch.'));
                 }
            }
        } catch (error) {
            console.error(`[SocketManager Auth] Error during socket authentication for shop ${shop}:`, error.message);
            return next(new Error('Authentication error during processing.'));
        }
    });

    // Socket.io connection handling
    ioInstance.on('connection', (socket) => {
        const shop = socket.shop; // Relies on shop being attached by the auth middleware
        if (!shop) {
            console.error('[SocketManager Connection] Shop not found on socket after auth attempt, disconnecting.');
            socket.disconnect(true);
            return;
        }

        console.log(`[SocketManager] Client connected for shop: ${shop}`);
        socket.join(shop);

        socket.on('join_shop_room', () => {
            socket.join(shop);
            console.log(`[SocketManager] Client explicitly re-joined room for shop: ${shop}`);
        });

        const heartbeatInterval = setInterval(() => {
            socket.emit('heartbeat', { timestamp: new Date().toISOString() });
        }, 60000);

        if (shop) startStatusMonitoring(shop); // Uses imported function

        socket.on('ping_server', (callback) => {
            if (typeof callback === 'function') {
                callback({ status: 'ok', timestamp: new Date().toISOString() });
            } else {
                socket.emit('pong_response', { status: 'ok', timestamp: new Date().toISOString() });
            }
        });

        socket.on('disconnect', () => {
            console.log(`[SocketManager] Client disconnected for shop: ${shop}`);
            clearInterval(heartbeatInterval);
            const room = ioInstance.sockets.adapter.rooms.get(shop);
            if (!room || room.size === 0) {
                console.log(`[SocketManager] Last client disconnected for shop ${shop}.`);
                if (shop) stopStatusMonitoring(shop); // Uses imported function
            } else {
                console.log(`[SocketManager] ${room.size} clients still connected for shop ${shop}. Monitoring continues.`);
            }
        });

        // --- Event Handlers ---
        socket.on('get_active_drop', async () => {
            try {
                console.log(`[SocketManager] Event: get_active_drop for shop: ${socket.shop}`);
                const { data, error } = await supabase.from('drops').select('*').eq('shop', socket.shop).eq('status', 'active').limit(1).maybeSingle();
                if (error) throw error;
                socket.emit('active_drop', data || null);
            } catch (error) {
                console.error(`[SocketManager] Error in get_active_drop for ${socket.shop}:`, error.message);
                socket.emit('error', { event: 'get_active_drop', message: 'Failed to fetch active drop' });
            }
        });

        socket.on('get_queued_products', async (collectionIdGid) => {
            if (!socket.shopifySession || !socket.shopifySession.accessToken) {
                console.error(`[SocketManager] Event: get_queued_products - No session for shop ${socket.shop}`);
                return socket.emit('error', { event: 'get_queued_products', message: 'Authentication required.'});
            }
            try {
                console.log(`[SocketManager] Event: get_queued_products for collection: ${collectionIdGid}, shop: ${socket.shop}`);
                const collectionIdMatch = collectionIdGid.match(/\d+$/);
                if (!collectionIdMatch) {
                    return socket.emit('error', { event: 'get_queued_products', message: 'Invalid collection ID format' });
                }
                const numericCollectionId = collectionIdMatch[0];
                const client = new shopify.clients.Rest({ session: socket.shopifySession });
                const response = await client.get({
                    path: 'products',
                    query: { collection_id: numericCollectionId, fields: 'id,title,image', status: 'active' }
                });
                if (!response.body || !response.body.products) throw new Error('Invalid product response structure from Shopify');
                const products = response.body.products.map(p => ({ id: p.id, title: p.title, imageUrl: p.image?.src || null }));
                socket.emit('queued_products', products);
            } catch (error) {
                console.error(`[SocketManager] Error in get_queued_products for ${socket.shop}, collection ${collectionIdGid}:`, error.message);
                socket.emit('error', { event: 'get_queued_products', message: 'Failed to fetch queued products' });
            }
        });

        socket.on('get_scheduled_drops', async ({ page = 1, limit = 5 }) => {
            try {
                console.log(`[SocketManager] Event: get_scheduled_drops for shop: ${socket.shop}, page: ${page}, limit: ${limit}`);
                const offset = (page - 1) * limit;
                const { data, error, count } = await supabase.from('drops').select('*', { count: 'exact' })
                    .eq('shop', socket.shop).eq('status', 'queued')
                    .order('start_time', { ascending: true }).range(offset, offset + limit - 1);
                if (error) throw error;
                socket.emit('scheduled_drops', { drops: data || [], totalCount: count || 0 });
            } catch (error) {
                console.error(`[SocketManager] Error in get_scheduled_drops for ${socket.shop}:`, error.message);
                socket.emit('error', { event: 'get_scheduled_drops', message: 'Failed to fetch scheduled drops' });
            }
        });

        socket.on('get_completed_drops', async ({ page = 1, limit = 5 }) => {
            try {
                console.log(`[SocketManager] Event: get_completed_drops for shop: ${socket.shop}, page: ${page}, limit: ${limit}`);
                const offset = (page - 1) * limit;
                const { data, error, count } = await supabase.from('drops').select('*', { count: 'exact' })
                    .eq('shop', socket.shop).eq('status', 'completed')
                    .order('end_time', { ascending: false }).range(offset, offset + limit - 1);
                if (error) throw error;
                socket.emit('completed_drops', { drops: data || [], totalCount: count || 0 });
            } catch (error) {
                console.error(`[SocketManager] Error in get_completed_drops for ${socket.shop}:`, error.message);
                socket.emit('error', { event: 'get_completed_drops', message: 'Failed to fetch completed drops' });
            }
        });

        socket.on('get_collections', async () => {
             if (!socket.shopifySession || !socket.shopifySession.accessToken) {
                console.error(`[SocketManager] Event: get_collections - No session for shop ${socket.shop}`);
                return socket.emit('error', { event: 'get_collections', message: 'Authentication required.'});
            }
            try {
                console.log(`[SocketManager] Event: get_collections for shop: ${socket.shop}`);
                const client = new shopify.clients.Rest({ session: socket.shopifySession });
                const smartCollectionsResponse = await client.get({ path: 'smart_collections', query: { fields: 'id,handle,title' } });
                const customCollectionsResponse = await client.get({ path: 'custom_collections', query: { fields: 'id,handle,title' } });
                const smartCollections = smartCollectionsResponse.body.smart_collections || [];
                const customCollections = customCollectionsResponse.body.custom_collections || [];
                const allCollections = [
                    ...smartCollections.map(col => ({ label: col.title, value: `gid://shopify/Collection/${col.id}` })),
                    ...customCollections.map(col => ({ label: col.title, value: `gid://shopify/Collection/${col.id}` }))
                ];
                socket.emit('collections', allCollections);
            } catch (error) {
                console.error(`[SocketManager] Error in get_collections for ${socket.shop}:`, error.message);
                socket.emit('error', { event: 'get_collections', message: 'Failed to fetch collections' });
            }
        });

        socket.on('get_settings', async () => {
            try {
                console.log(`[SocketManager] Event: get_settings for shop: ${socket.shop}`);
                const { data, error } = await supabase.from('app_settings')
                    .select('queued_collection_id, drop_time, default_drop_duration_minutes, default_drop_date')
                    .eq('shop', socket.shop).maybeSingle();
                if (error) throw error;
                socket.emit('settings', data || { queued_collection_id: null, drop_time: '10:00', default_drop_duration_minutes: 60, default_drop_date: null });
            } catch (error) {
                console.error(`[SocketManager] Error in get_settings for ${socket.shop}:`, error.message);
                socket.emit('error', { event: 'get_settings', message: 'Failed to fetch settings' });
            }
        });
    });
} 