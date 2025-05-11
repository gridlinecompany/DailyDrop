import express from 'express';
import { baseShopifyApi as shopify } from './shopify.js';
import { verifyApiRequest } from './apiMiddlewares.js'; // Assuming verifyApiRequest is here

const router = express.Router();

// Simple API endpoint to verify session validity (uses token validation)
router.get('/verify-session', verifyApiRequest, (req, res) => {
    console.log(`[/api/verify-session] Token verified for shop: ${req.shop}`);
    res.status(200).send('Session/Token is valid');
});

// Endpoint to get collections
router.get('/collections', verifyApiRequest, async (req, res) => {
    const shop = req.shop; 
    const token = req.token;
    console.log(`[/api/collections] Request for shop: ${shop}`);
    try {
        const client = new shopify.clients.Rest({
            session: { shop: shop, accessToken: token, isOnline: false }
        });
        const smartCollectionsResponse = await client.get({
            path: 'smart_collections',
            query: { fields: 'id,handle,title' }
        });
        console.log('[/api/collections] Raw smartCollectionsResponse:', JSON.stringify(smartCollectionsResponse, null, 2));
        const customCollectionsResponse = await client.get({
            path: 'custom_collections',
            query: { fields: 'id,handle,title' }
        });
        console.log('[/api/collections] Raw customCollectionsResponse:', JSON.stringify(customCollectionsResponse, null, 2));

        const smartOK = smartCollectionsResponse && smartCollectionsResponse.body && typeof smartCollectionsResponse.body.smart_collections !== 'undefined';
        const customOK = customCollectionsResponse && customCollectionsResponse.body && typeof customCollectionsResponse.body.custom_collections !== 'undefined';

        if (!smartOK || !customOK) {
             console.error(`[/api/collections] Failed to fetch collections or response structure invalid for shop ${shop}. Smart Valid: ${smartOK}, Custom Valid: ${customOK}`);
             if (!smartOK) console.error('[/api/collections] Invalid smartCollectionsResponse:', JSON.stringify(smartCollectionsResponse));
             if (!customOK) console.error('[/api/collections] Invalid customCollectionsResponse:', JSON.stringify(customCollectionsResponse));
             return res.status(502).send('Error fetching collections from Shopify (Bad Gateway or invalid response).'); 
        }

        const smartCollections = smartCollectionsResponse.body.smart_collections || [];
        const customCollections = customCollectionsResponse.body.custom_collections || [];
        const allCollections = [
            ...smartCollections.map(col => ({ label: col.title, value: `gid://shopify/Collection/${col.id}` })),
            ...customCollections.map(col => ({ label: col.title, value: `gid://shopify/Collection/${col.id}` }))
        ];
        console.log(`[/api/collections] Found ${allCollections.length} collections for shop ${shop}`);
        res.status(200).json(allCollections);
    } catch (error) {
        console.error(`[/api/collections] Exception during collection fetch process for ${shop}.`);
        console.error('[/api/collections] Error Name:', error.name);
        console.error('[/api/collections] Error Message:', error.message);
        if (error.stack) console.error('[/api/collections] Error Stack:', error.stack);
        if (error.response && error.response.status) {
             return res.status(error.response.status).send(`Error fetching collections: ${error.message}`);
        } else if (error.name === 'FetchError' || error instanceof TypeError) {
             return res.status(503).send(`Service Unavailable: Could not reach Shopify API for collections (${error.message})`);
        } else {
             return res.status(500).send('Internal Server Error fetching collections.');
        }
    }
});

// Endpoint to get products by collection ID
router.get('/products-by-collection', verifyApiRequest, async (req, res) => {
    const shop = req.shop; 
    const token = req.token;
    const collectionIdQuery = req.query.collectionId;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 50);
    console.log(`[/api/products-by-collection] Request for shop: ${shop}, collectionIdQuery: ${collectionIdQuery}, limit: ${limit}`);

    if (!collectionIdQuery) {
        return res.status(400).send('Bad Request: collectionId parameter is missing.');
    }
    const collectionIdMatch = collectionIdQuery.match(/\d+$/);
    if (!collectionIdMatch) {
        console.error(`[/api/products-by-collection] Invalid collectionId format: ${collectionIdQuery}`);
        return res.status(400).send('Bad Request: Invalid collectionId format.');
    }
    const collectionId = collectionIdMatch[0];
    console.log(`[/api/products-by-collection] Extracted numeric collection ID: ${collectionId}`);

    try {
        const client = new shopify.clients.Rest({
             session: { shop: shop, accessToken: token, isOnline: false }});
        const productsResponse = await client.get({
            path: 'products',
            query: { collection_id: collectionId, fields: 'id,title,image', status: 'active', limit: limit }
        });
        console.log('[\/api\/products-by-collection] Raw productsResponse:', JSON.stringify(productsResponse, null, 2));

        if (productsResponse && productsResponse.body && typeof productsResponse.body.products !== 'undefined') {
            const products = productsResponse.body.products || []; 
            const formattedProducts = products.map(product => ({
                id: product.id, 
                title: product.title,
                imageUrl: product.image?.src || null 
            }));
            console.log(`[/api/products-by-collection] Found ${formattedProducts.length} products (limit: ${limit}) for collection ${collectionId}.`);
            res.status(200).json(formattedProducts);
        } else {
            console.error(`[\/api\/products-by-collection] API call succeeded but response lacked expected body.products for collection ${collectionId}. Response:`, JSON.stringify(productsResponse));
            return res.status(502).send('Error fetching products from Shopify (Bad Gateway or invalid response structure).');
        }
    } catch (error) {
        console.error(`[\/api\/products-by-collection] Exception during product fetch for shop ${shop}, collection ${collectionId}.`);
        // ... (condensed error handling for brevity, similar to /api/collections) ...
        if (error.response && error.response.status) {
             return res.status(error.response.status).send(`Error fetching products: ${error.message}`);
        } else if (error.name === 'FetchError' || error instanceof TypeError) {
             return res.status(503).send(`Service Unavailable: Could not reach Shopify API for products (${error.message})`);
        } else {
             return res.status(500).send('Internal Server Error fetching products.');
        }
    }
});

// API endpoint to get shop info (primarily uses session from DB, not verifyApiRequest token initially)
router.get('/shop-info', async (req, res) => { // Note: Not using verifyApiRequest here, relies on findSessionsByShop
    console.log('[/api/shop-info] Received request.');
    const shop = req.query.shop;
    if (!shop) {
        console.log('[/api/shop-info] Missing shop query parameter.');
        return res.status(400).send('Bad Request: Missing shop query parameter.');
    }
    try {
        const sessionStorage = shopify.config.sessionStorage;
        const sessions = await sessionStorage.findSessionsByShop(shop);
        let session = null;
        if (sessions && sessions.length > 0) {
            session = sessions[0]; 
            console.log(`[/api/shop-info] Found session for shop ${shop}.`);
        } else {
            console.log(`[/api/shop-info] No session found for shop ${shop}. Cannot fetch shop info.`);
            return res.sendStatus(401); 
        }
        const client = new shopify.clients.Rest({ session });
        console.log('[/api/shop-info] REST Client created. Fetching shop data...');
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
        if (error.response && (error.response.code === 401 || error.response.code === 403)) { 
             return res.status(error.response.code).send('Unauthorized/Forbidden to fetch shop data.'); 
        } else {
             return res.status(500).send('Internal Server Error while fetching shop data.');
        }
    }
});

// API endpoint to get products (primarily uses session from DB)
router.get('/products', async (req, res) => { // Note: Not using verifyApiRequest here
    console.log('[/api/products] Received request.');
    const shop = req.query.shop;
    const collectionIdQuery = req.query.collection_id; // GID format e.g. gid://shopify/Collection/12345

    if (!shop) {
        return res.status(400).send('Bad Request: Missing shop query parameter.');
    }
    try {
        const sessionStorage = shopify.config.sessionStorage;
        const sessions = await sessionStorage.findSessionsByShop(shop);
        let session = null;
        if (sessions && sessions.length > 0) {
            session = sessions[0]; 
            console.log(`[/api/products] Found session for shop ${shop}. Scopes: ${session.scope}`);
        } else {
            return res.sendStatus(401);
        }
        if (!session.accessToken) {
            return res.status(500).send('Internal Error: Session token missing.');
        }
        const client = new shopify.clients.Rest({ session });
        console.log('[/api/products] REST Client created. Fetching products...');
        const queryParams = { limit: 50, fields: 'id,title,image,status' }; // Added status
        let apiPath = 'products';

        if (collectionIdQuery) {
            const collectionIdMatch = collectionIdQuery.match(/\d+$/);
            if (!collectionIdMatch) {
                return res.status(400).send('Bad Request: Invalid collectionId format.');
            }
            const numericCollectionId = collectionIdMatch[0];
            console.log(`[/api/products] Filtering by Collection ID: ${numericCollectionId}`);
            apiPath = `collections/${numericCollectionId}/products`;
            // queryParams.collection_id = numericCollectionId; // Not needed when using collections/.../products path
        } else {
            console.log('[/api/products] Fetching all products (no collection filter).');
        }
        console.log(`[/api/products] Using path: ${apiPath} with query:`, queryParams);
        const response = await client.get({ path: apiPath, query: queryParams });

        let products = [];
        if (response.body) {
            // The products array might be directly in response.body or response.body.products
            if (Array.isArray(response.body)) { 
                products = response.body; 
            } else if (response.body.products && Array.isArray(response.body.products)) {
                products = response.body.products;
            } else {
                console.warn('[/api/products] Unexpected response body structure. Logging body:', response.body);
            }
        }
        console.log(`[/api/products] Extracted ${products.length} products.`);
        res.status(200).json(products);
    } catch (error) {
        console.error(`[/api/products] Error processing request for shop ${shop}:`, error);
        if (error.response && (error.response.code === 401 || error.response.code === 403)) { 
             return res.status(error.response.code).send('Unauthorized/Forbidden to fetch products.');
        } else {
             return res.status(500).send('Internal Server Error while fetching products.');
        }
    }
});

export default router; 