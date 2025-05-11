import express from 'express';
import { supabase } from './supabaseClient.js';
import { baseShopifyApi as shopify } from './shopify.js';
import { validateSession } from './apiMiddlewares.js';
// Note: io, broadcastRefreshInstruction, broadcastScheduledDrops, broadcastCompletedDrops, \
// updateShopMetafield, and lastActiveProductHandleSet are external dependencies
// that will need to be passed to this module or refactored.

const router = express.Router();

// Placeholder for io object and other shared functions - these would ideally be passed in or handled via a service layer
let ioInstance;
let sharedFunctions = {};

export function initializeDropRoutes(io, functions) {
    ioInstance = io;
    sharedFunctions = functions; // e.g., { broadcastRefreshInstruction, ... updateShopMetafield, getLastActiveProductHandle, setLastActiveProductHandle }
}

// GET /api/drops - Retrieve all drops for the shop
router.get('/', validateSession, async (req, res) => {
    const shop = req.query.shop;
    console.log(`[/api/drops GET] Request received for shop: ${shop}`);
    try {
        const { data, error } = await supabase
            .from('drops')
            .select('*')
            .eq('shop', shop)
            .order('start_time', { ascending: true });
        if (error) throw error;
        console.log(`[/api/drops GET] Found ${data?.length || 0} drops from Supabase.`);
        res.status(200).json(data || []);
    } catch (error) {
        console.error('[/api/drops GET] Server Error:', error);
        const errorMessage = error.message || 'Internal server error retrieving drops.';
        const errorCode = error.code || 500;
        res.status(errorCode === 'PGRST116' ? 404 : 500).json({ error: errorMessage });
    }
});

// GET /api/drops/active - Retrieve the currently active drop
router.get('/active', validateSession, async (req, res) => {
    const shop = req.query.shop;
    console.log(`[/api/drops/active GET] Request received for shop: ${shop}`);
    try {
        const { data, error } = await supabase
            .from('drops')
            .select('*')
            .eq('shop', shop)
            .eq('status', 'active')
            .order('start_time', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error) throw error;
        if (data) {
            console.log('[/api/drops/active GET] Found active drop:', data);
            res.status(200).json(data);
        } else {
            console.log(`[/api/drops/active GET] No active drop found for shop: ${shop}.`);
            res.status(200).json(null);
        }
    } catch (error) {
        console.error('[/api/drops/active GET] Server Error:', error);
        const errorMessage = error.message || 'Internal server error retrieving active drop.';
        let statusCode = error.status || 500;
        if (error.code === '42501') statusCode = 403; // permission denied
        res.status(statusCode).json({ error: errorMessage });
    }
});

// GET /api/drops/completed - Retrieve recently completed drops
router.get('/completed', validateSession, async (req, res) => {
    const shop = req.query.shop;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 5, 50);
    const offset = (page - 1) * limit;
    console.log(`[/api/drops/completed GET] Request for shop: ${shop}, page: ${page}, limit: ${limit}`);
    try {
        const { data, error, count } = await supabase
            .from('drops')
            .select('*', { count: 'exact' })
            .eq('shop', shop)
            .eq('status', 'completed')
            .order('end_time', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) throw error;
        console.log(`[/api/drops/completed GET] Found ${data?.length || 0} drops on page ${page}. Total count: ${count}`);
        res.status(200).json({ data: data || [], totalCount: count });
    } catch (error) {
        console.error('[/api/drops/completed GET] Server Error:', error);
        const errorMessage = error.message || 'Internal server error retrieving completed drops.';
        let statusCode = error.status || 500;
        if (error.code === '42501') statusCode = 403;
        res.status(statusCode).json({ error: errorMessage });
    }
});

// GET /api/drops/queued - Retrieve upcoming queued drops
router.get('/queued', validateSession, async (req, res) => {
    const shop = req.query.shop;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 5, 100);
    const offset = (page - 1) * limit;
    console.log(`[/api/drops/queued GET] Request for shop: ${shop}, page: ${page}, limit: ${limit}`);
    try {
        const { data, error, count } = await supabase
            .from('drops')
            .select('*', { count: 'exact' })
            .eq('shop', shop)
            .eq('status', 'queued')
            .order('start_time', { ascending: true })
            .range(offset, offset + limit - 1);
        if (error) throw error;
        console.log(`[/api/drops/queued GET] Found ${data?.length || 0} drops on page ${page}. Total count: ${count}`);
        res.status(200).json({ data: data || [], totalCount: count });
    } catch (error) {
        console.error('[/api/drops/queued GET] Server Error:', error);
        const errorMessage = error.message || 'Internal server error retrieving queued drops.';
        let statusCode = error.status || 500;
        if (error.code === '42501') statusCode = 403;
        res.status(statusCode).json({ error: errorMessage });
    }
});

// POST /api/drops - Create a new drop
router.post('/', validateSession, async (req, res) => {
    const { 
        product_id, 
        title, 
        thumbnail_url, 
        start_time, 
        duration_minutes,
        shop 
    } = req.body;
    
    console.log(`[/api/drops POST] Request received for shop: ${shop}`);
    console.log(`[/api/drops POST] Received payload:`, req.body);

    if (!product_id || !title || !start_time || typeof duration_minutes === 'undefined' || duration_minutes === null || !shop) {
        console.log('[/api/drops POST] Missing required fields.');
        return res.status(400).json({ error: 'Missing required fields: product_id, title, start_time, duration_minutes, shop.' });
    }

    const dropData = {
        product_id, 
        title,
        thumbnail_url: thumbnail_url || null,
        start_time, 
        duration_minutes,
        shop,
        status: 'queued',
    };

    try {
        const { data, error } = await supabase
            .from('drops')
            .insert([dropData])
            .select()
            .single();
        if (error) throw error;
        console.log('[/api/drops POST] Drop created successfully in Supabase:', data);
        res.status(201).json(data);
    } catch (error) {
        console.error('[/api/drops POST] Server Error:', error);
        const errorMessage = error.message || 'Internal server error creating drop.';
        const errorCode = error.code;
        res.status(errorCode === '23505' ? 409 : 500).json({ error: errorMessage });
    }
});

// POST /api/drops/schedule-all - Bulk schedule drops from a collection
router.post('/schedule-all', validateSession, async (req, res) => {
    const { shop, queued_collection_id, initial_start_time_utc, duration_minutes } = req.body;
    console.log(`[/api/drops/schedule-all POST] Start Handler. Shop: ${shop}, Collection GID: ${queued_collection_id}`);
    
    if (!initial_start_time_utc || typeof initial_start_time_utc !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(initial_start_time_utc)) {
        console.error('[/api/drops/schedule-all POST] Invalid or missing initial_start_time_utc:', initial_start_time_utc);
        return res.status(400).json({ error: 'Invalid or missing initial start time (UTC). Expected UTC ISO string.' });
    }
    const durationMinsInt = parseInt(duration_minutes, 10);
    if (isNaN(durationMinsInt) || durationMinsInt <= 0) {
        console.error('[/api/drops/schedule-all POST] Invalid duration_minutes:', duration_minutes);
        return res.status(400).json({ error: 'Invalid duration. Must be a positive number.' });
    }

    let initialStartTime;
    try {
        initialStartTime = new Date(initial_start_time_utc);
        if (isNaN(initialStartTime.getTime())) throw new Error('Invalid date/time combination after parsing UTC string.');
    } catch (e) { 
        console.error('[/api/drops/schedule-all POST] Error parsing date/time', e);
        return res.status(400).json({ error: `Invalid start date/time: ${e.message}` });
    }
    console.log(`[/api/drops/schedule-all POST] Parsed initialStartTime: ${initialStartTime?.toISOString()}`);

    try {
        const session = req.shopifySession;
        if (!session || !session.accessToken) { throw new Error('Session or accessToken missing.'); }
        
        const client = new shopify.clients.Graphql({ session });
        const productsQuery = `
          query getCollectionProducts($id: ID!, $first: Int!) {
            collection(id: $id) {
              id
              title
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
        const productsResponse = await client.request(productsQuery, { variables: { id: queued_collection_id, first: 250 } });
        
        if (productsResponse?.data?.errors) {
             throw new Error(`GraphQL error fetching products: ${productsResponse.data.errors[0].message}`); 
        }
        const shopifyProductsData = productsResponse?.data?.collection?.products?.nodes;
        if (!shopifyProductsData) { 
            if (!productsResponse?.data?.collection) {
                return res.status(404).json({ error: `Collection with ID ${queued_collection_id} not found or access denied.` });
            }
            return res.status(502).json({ error: 'Failed to parse products from Shopify GraphQL response.' });
        }
        const shopifyProducts = shopifyProductsData.map(node => ({
            id: node.id, 
            title: node.title,
            image: { src: node.featuredImage?.url || null } 
        }));
        if (shopifyProducts.length === 0) { return res.status(200).json({ message: 'No products found in the specified collection to schedule.', scheduled_count: 0 }); }

        const activeShopifyProducts = [];
        const restClient = new shopify.clients.Rest({ session });
        for (const product of shopifyProducts) {
            try {
                const productIdNumeric = product.id.split('/').pop();
                if (!productIdNumeric) {
                    console.warn(`[/api/drops/schedule-all POST] Could not extract numeric ID from GID ${product.id}`);
                    continue;
                }
                const productDetailsResponse = await restClient.get({
                    path: `products/${productIdNumeric}`,
                    query: { fields: 'id,status' }
                });
                if (productDetailsResponse?.body?.product?.status === 'active') {
                    activeShopifyProducts.push(product); 
                } else {
                    console.log(`[/api/drops/schedule-all POST] Product ${product.title} (ID: ${product.id}) is not active. Skipping.`);
                }
            } catch (statusError) {
                console.error(`[/api/drops/schedule-all POST] Error fetching status for product ${product.id}:`, statusError.message);
            }
        }
        if (activeShopifyProducts.length === 0) { 
            return res.status(200).json({ message: 'No ACTIVE products found in the specified collection to schedule.', scheduled_count: 0 }); 
        }

        const { data: existingQueuedDrops, error: fetchError } = await supabase
            .from('drops')
            .select('product_id')
            .eq('shop', shop)
            .eq('status', 'queued');
        if (fetchError) { throw fetchError; }
        const existingQueuedProductIds = new Set(existingQueuedDrops.map(d => d.product_id));
        const productsToSchedule = activeShopifyProducts.filter(p => !existingQueuedProductIds.has(p.id));
        if (productsToSchedule.length === 0) { return res.status(200).json({ message: 'All active products in the collection are already scheduled.', scheduled_count: 0 }); }

        let currentStartTime = initialStartTime;
        const dropsToInsert = productsToSchedule.map(product => {
            const dropData = {
                product_id: product.id, 
                title: product.title,
                thumbnail_url: product.image?.src || null,
                start_time: currentStartTime.toISOString(),
                duration_minutes: durationMinsInt,
                shop: shop,
                status: 'queued'
            };
            currentStartTime = new Date(currentStartTime.getTime() + durationMinsInt * 60000);
            return dropData;
        });

        const { data: insertedData, error: insertError } = await supabase.from('drops').insert(dropsToInsert).select();
        if (insertError) { throw insertError; }

        if (ioInstance && sharedFunctions.broadcastRefreshInstruction) sharedFunctions.broadcastRefreshInstruction(shop);
        if (ioInstance && sharedFunctions.broadcastScheduledDrops) sharedFunctions.broadcastScheduledDrops(shop);
        res.status(201).json({ 
            message: `Successfully scheduled ${insertedData?.length || 0} new drops.`, 
            scheduled_count: insertedData?.length || 0,
        });
    } catch (error) {
        console.error('[/api/drops/schedule-all POST] CAUGHT ERROR:', error);
        res.status(500).json({ error: error.message || 'Internal server error scheduling drops.' });
    }
});

// POST /api/drops/append - Add only new products to the end of the queue
router.post('/append', validateSession, async (req, res) => {
    const { shop, queued_collection_id } = req.body;
    console.log(`[/api/drops/append POST] Request received for shop: ${shop}, Collection: ${queued_collection_id}`);
    if (!shop || !queued_collection_id) return res.status(400).json({ error: 'Missing required fields: shop, queued_collection_id.'});
    const collectionIdMatch = queued_collection_id.match(/\d+$/);
    if (!collectionIdMatch) return res.status(400).json({ error: 'Invalid queued_collection_id format.' });
    const numericCollectionId = collectionIdMatch[0];

    try {
        const sessions = await shopify.config.sessionStorage.findSessionsByShop(shop);
        if (!sessions || sessions.length === 0 || !sessions[0].accessToken) {
             throw new Error('Could not retrieve valid session token for append operation.');
        }
        const shopifyClient = new shopify.clients.Rest({ session: sessions[0] });

        const { data: settingsData, error: settingsError } = await supabase
            .from('app_settings')
            .select('default_drop_duration_minutes')
            .eq('shop', shop)
            .maybeSingle();
        if (settingsError) throw new Error('Could not fetch app settings to determine duration for append.');
        const durationMinsInt = settingsData?.default_drop_duration_minutes || 60;

        const productsResponse = await shopifyClient.get({
            path: 'products',
            query: { collection_id: numericCollectionId, fields: 'id,title,image', status: 'active' }
        });
        if (!productsResponse?.body?.products) {
            return res.status(502).send('Error fetching products from Shopify for append (Invalid Response).');
        }
        const shopifyProducts = productsResponse.body.products || [];

        const { data: existingQueuedDrops, error: fetchDbError } = await supabase
            .from('drops')
            .select('id, product_id, start_time, end_time')
            .eq('shop', shop)
            .eq('status', 'queued')
            .order('start_time', { ascending: false }); 
        if (fetchDbError) throw fetchDbError;
        const existingQueuedProductIds = new Set(existingQueuedDrops.map(d => d.product_id));

        let nextStartTime;
        if (existingQueuedDrops.length > 0 && existingQueuedDrops[0].end_time) {
            nextStartTime = new Date(existingQueuedDrops[0].end_time);
        } else {
            nextStartTime = new Date(); 
        }

        const productsToAppend = shopifyProducts.filter(p => 
            !existingQueuedProductIds.has(`gid://shopify/Product/${p.id}`)
        );

        if (productsToAppend.length === 0) {
            return res.status(200).json({ message: 'All products in the collection are already scheduled.', scheduled_count: 0 });
        }

        const dropsToInsert = [];
        let currentStartTimeForAppend = nextStartTime;
        for (const product of productsToAppend) {
            const dropData = {
                product_id: `gid://shopify/Product/${product.id}`, 
                title: product.title,
                thumbnail_url: product.image?.src || null,
                start_time: currentStartTimeForAppend.toISOString(),
                duration_minutes: durationMinsInt,
                shop: shop,
                status: 'queued'
            };
            dropsToInsert.push(dropData);
            currentStartTimeForAppend = new Date(currentStartTimeForAppend.getTime() + durationMinsInt * 60000); 
        }

        const { data: insertedData, error: insertError } = await supabase
            .from('drops')
            .insert(dropsToInsert) 
            .select(); 
        if (insertError) throw insertError;

        res.status(201).json({ 
            message: `Successfully appended ${insertedData?.length || 0} new drops.`, 
            scheduled_count: insertedData?.length || 0,
        });
    } catch (error) {
        console.error('[/api/drops/append POST] Server Error:', error);
        res.status(500).json({ error: error.message || 'Internal server error appending drops.'});
    }
});

// DELETE /api/drops - Delete one or more queued drops
router.delete('/', validateSession, async (req, res) => {
    const shop = req.query.shop;
    const { dropIds } = req.body;
    if (!Array.isArray(dropIds) || dropIds.length === 0) {
        return res.status(400).json({ error: 'Missing or invalid dropIds array in request body.' });
    }
    try {
        const { count, error } = await supabase
            .from('drops')
            .delete()
            .in('id', dropIds)
            .eq('shop', shop)
            .eq('status', 'queued');
        if (error) throw error;
        console.log(`[/api/drops DELETE] Successfully deleted ${count ?? 0} queued drops for shop ${shop}.`);
        res.status(200).json({ message: `Successfully deleted ${count ?? 0} queued drops.`, deleted_count: count ?? 0 });
    } catch (error) {
        console.error('[/api/drops DELETE] Server Error:', error);
        res.status(500).json({ error: error.message || 'Internal server error deleting drops.' });
    }
});

// DELETE /api/drops/completed - Clear all completed drops
router.delete('/completed', validateSession, async (req, res) => {
    const shop = req.query.shop;
    console.log(`[/api/drops/completed DELETE] Request received for shop: ${shop}`);
    try {
        const { count, error } = await supabase
            .from('drops')
            .delete()
            .eq('shop', shop)
            .eq('status', 'completed');
        if (error) throw error;
        console.log(`[/api/drops/completed DELETE] Successfully deleted ${count ?? 0} completed drops for shop ${shop}.`);
        res.status(200).json({ message: `Successfully cleared ${count ?? 0} completed drops.`, deleted_count: count ?? 0 });
    } catch (error) {
        console.error('[/api/drops/completed DELETE] Server Error:', error);
        res.status(500).json({ error: error.message || 'Internal server error clearing completed drops.'});
    }
});

// POST /api/drops/stop-and-clear-queue - Complete active, clear queue, reset settings
router.post('/stop-and-clear-queue', validateSession, async (req, res) => {
    const shop = req.shopifySession?.shop;
    if (!shop) {
        console.error('[/api/drops/stop-and-clear-queue POST] Critical: Shop could not be determined from validated session.');
        return res.status(400).json({ error: 'Shop could not be determined. Session may be invalid.' });
    }
    console.log(`[/api/drops/stop-and-clear-queue POST] Request received for shop: ${shop}`);
    let activeDropCompletedTitle = null;
    let queuedDropsDeletedCount = 0;
    let settingsUpdated = false;

    try {
        const { data: activeDrop, error: activeDropError } = await supabase
            .from('drops')
            .select('id, title')
            .eq('shop', shop)
            .eq('status', 'active')
            .maybeSingle();
        if (activeDropError) throw activeDropError;

        if (activeDrop) {
            const { error: updateActiveError } = await supabase
                .from('drops')
                .update({ status: 'completed', end_time: new Date().toISOString() })
                .eq('id', activeDrop.id)
                .eq('shop', shop); // ensure we only update for the correct shop
            if (updateActiveError) throw updateActiveError;
            activeDropCompletedTitle = activeDrop.title;
            console.log(`[/api/drops/stop-and-clear-queue POST] Active drop ${activeDrop.id} marked as completed.`);
            
            if (ioInstance) ioInstance.to(shop).emit('active_drop', null);
            if (sharedFunctions.broadcastCompletedDrops) sharedFunctions.broadcastCompletedDrops(shop);
            // Call updateShopMetafield if available in sharedFunctions
            if (req.shopifySession && sharedFunctions.updateShopMetafield) {
                console.log(`[/api/drops/stop-and-clear-queue POST] Triggering metafield update (clear) for shop ${shop} after completing active drop.`);
                // The 'source' parameter is added to distinguish calls
                await sharedFunctions.updateShopMetafield(shop, req.shopifySession, true, 'stop_and_clear_queue_complete'); 
            }
        }

        const { count: deletedCount, error: deleteQueuedError } = await supabase
            .from('drops')
            .delete()
            .eq('shop', shop)
            .eq('status', 'queued');
        if (deleteQueuedError) throw deleteQueuedError;
        queuedDropsDeletedCount = deletedCount || 0;
        console.log(`[/api/drops/stop-and-clear-queue POST] Deleted ${queuedDropsDeletedCount} queued drops for shop ${shop}.`);

        const { error: updateSettingsError } = await supabase
            .from('app_settings')
            .update({ queued_collection_id: null })
            .eq('shop', shop);
        if (updateSettingsError) {
            console.warn('[/api/drops/stop-and-clear-queue POST] Continuing after settings update error:', updateSettingsError.message);
        } else {
            settingsUpdated = true;
            console.log(`[/api/drops/stop-and-clear-queue POST] Successfully reset queued_collection_id for shop ${shop}.`);
        }

        if (ioInstance && sharedFunctions.broadcastScheduledDrops) sharedFunctions.broadcastScheduledDrops(shop);
        // Fetch and broadcast settings only if they were updated and broadcastSettings function exists
        if (ioInstance && settingsUpdated && sharedFunctions.broadcastSettings) {
             await sharedFunctions.broadcastSettings(shop); // Assuming broadcastSettings might be async
        }
        
        let message = activeDropCompletedTitle ? `Active drop '${activeDropCompletedTitle}' completed. ` : "No active drop to complete. ";
        message += `${queuedDropsDeletedCount} scheduled drops cleared.`;
        if (settingsUpdated) message += " Queued collection setting reset.";

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

export default router;
 