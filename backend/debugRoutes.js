import express from 'express';
import { supabase } from './supabaseClient.js';
import { baseShopifyApi as shopify } from './shopify.js';
import { verifyApiRequest, validateSession } from './apiMiddlewares.js';
import { 
    updateShopMetafield, 
    resetMetafieldCacheForShop, 
    // Directly accessing these caches from outside is generally not ideal,
    // but for debug routes, it might be permissible if carefully handled.
    // Consider adding dedicated getter functions in metafieldManager.js if needed for cleaner access.
    shopMetafieldCache, 
    lastActiveProductHandleSet, 
    lastMetafieldUpdateFailed 
} from './metafieldManager.js';

const router = express.Router();

// GET /api/debug/metafield
router.get('/metafield', verifyApiRequest, validateSession, async (req, res) => {
  try {
    const shop = req.query.shop || req.shopifySession?.shop;
    if (!shop || !req.shopifySession) {
      return res.status(400).json({ success: false, error: 'Shop or session missing' });
    }
    const client = new shopify.clients.Graphql({ session: req.shopifySession });
    const query = `
      query GetShopMetafield { 
        shop {
          metafield(namespace: "custom", key: "active_drop_product_handle") {
            id value createdAt updatedAt
          }
        }
      }
    `;
    const response = await client.query({ data: { query } }); // Use client.request for shopify-api v9+
    if (response.body?.errors) {
      console.error(`[Debug Metafield] GraphQL errors for shop ${shop}:`, response.body.errors);
      return res.status(500).json({ success: false, error: 'GraphQL errors', details: response.body.errors });
    }
    const metafield = response.body?.data?.shop?.metafield;
    const cacheState = {
      shopGid: shopMetafieldCache[shop]?.shopGid || null,
      instanceGid: shopMetafieldCache[shop]?.instanceGid || null,
      lastActiveProductHandle: lastActiveProductHandleSet[shop] === undefined ? null : lastActiveProductHandleSet[shop],
      lastUpdateFailed: lastMetafieldUpdateFailed[shop] === undefined ? null : lastMetafieldUpdateFailed[shop]
    };
    res.json({ success: true, current_metafield: metafield, cache_state: cacheState });
  } catch (error) {
    console.error(`[Debug Metafield] Error for shop ${req.query.shop}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/debug/metafield/update
router.post('/metafield/update', verifyApiRequest, validateSession, async (req, res) => {
  try {
    const shop = req.query.shop || req.shopifySession?.shop;
    if (!shop || !req.shopifySession) {
      return res.status(400).json({ success: false, error: 'Shop or session missing' });
    }
    if (req.body.reset_cache) {
      console.log(`[Debug Metafield Update] Resetting metafield cache for shop ${shop}`);
      resetMetafieldCacheForShop(shop);
    }
    console.log(`[Debug Metafield Update] Forcing metafield update for shop ${shop} via debug endpoint.`);
    await updateShopMetafield(shop, req.shopifySession, true, 'debug_metafield_update_post');
    res.json({ success: true, message: 'Metafield update triggered' });
  } catch (error) {
    console.error(`[Debug Metafield Update] Error for shop ${req.query.shop}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/debug/cache-session (validateSession already handles caching in apiMiddlewares.js)
router.post('/cache-session', validateSession, async (req, res) => {
  try {
    const shop = req.shopifySession?.shop;
    if (!shop || !req.shopifySession?.accessToken) {
      return res.status(400).json({ success: false, message: 'Invalid session for caching operation.' });
    }
    console.log(`[Debug Session Cache] Session for shop ${shop} ensured in cache via validateSession middleware.`);
    res.json({ success: true, message: 'Session ensured in cache (handled by validateSession)' });
  } catch (error) {
    console.error('[Debug Session Cache] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/debug/metafield-test
router.get('/metafield-test', verifyApiRequest, validateSession, async (req, res) => {
  try {
    const shop = req.query.shop || req.shopifySession?.shop;
    if (!shop || !req.shopifySession) return res.status(400).json({ success: false, error: 'Shop/session missing' });
    
    console.log(`[Metafield Test Debug] Starting full metafield test for shop ${shop}`);
    const client = new shopify.clients.Graphql({ session: req.shopifySession });
    const gqlQuery = `{ shop { id metafield(namespace:"custom",key:"active_drop_product_handle"){id value} } }`;
    
    console.log(`[Metafield Test Debug] Fetching initial metafield state for ${shop}`);
    const initialResponse = await client.query({ data: { query: gqlQuery } });
    const initialMetafield = initialResponse?.body?.data?.shop?.metafield;
    console.log(`[Metafield Test Debug] Initial metafield for ${shop}: ${JSON.stringify(initialMetafield)}`);

    console.log(`[Metafield Test Debug] Calling updateShopMetafield for ${shop}`);
    await updateShopMetafield(shop, req.shopifySession, true, 'debug_metafield_test');
    
    console.log(`[Metafield Test Debug] Fetching metafield state after updateShopMetafield call for ${shop}`);
    const verifyResponse = await client.query({ data: { query: gqlQuery } });
    const verifiedMetafield = verifyResponse?.body?.data?.shop?.metafield;
    console.log(`[Metafield Test Debug] Metafield for ${shop} after update call: ${JSON.stringify(verifiedMetafield)}`);
    
    res.json({ 
        success: true, 
        message: "Metafield test process completed.", 
        initial: initialMetafield, 
        after_update_attempt: verifiedMetafield 
    });
  } catch (error) {
    console.error(`[Metafield Test Debug] Error for shop ${req.query.shop}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/debug/force-metafield-update 
router.get('/force-metafield-update', verifyApiRequest, validateSession, async (req, res) => {
  try {
    const shop = req.query.shop || req.shopifySession?.shop;
    if (!shop || !req.shopifySession) return res.status(400).json({ success: false, error: 'Shop/session missing' });
    console.log(`[Force Metafield Debug] Forcing metafield update for shop ${shop} via GET request.`);
    await updateShopMetafield(shop, req.shopifySession, true, 'debug_force_metafield_get');
    // It might be good to also fetch and return the metafield state here like in metafield-test
    res.json({ success: true, message: 'Force metafield update triggered.' });
  } catch (error) {
    console.error(`[Force Metafield Debug] Error for shop ${req.query.shop}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router; 