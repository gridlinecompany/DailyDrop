import { baseShopifyApi as shopify } from './shopify.js';
import { supabase } from './supabaseClient.js';

// In-memory cache for shop GIDs and metafield instance GIDs
export let shopMetafieldCache = {}; // Structure: { shop: { shopGid: '...', instanceGid: '...' } }
// In-memory map for last active handle set per shop
export let lastActiveProductHandleSet = {}; // Structure: { shop: 'handle-string-or-null' }
// Track failed updates to prevent infinite retries
export let lastMetafieldUpdateFailed = {}; // Structure: { shop: boolean }

// Function to reset cache for a specific shop (e.g., for debugging or forced refresh)
export function resetMetafieldCacheForShop(shop) {
    console.log(`[MetafieldManager] Resetting metafield cache for shop: ${shop}`);
    delete shopMetafieldCache[shop];
    delete lastActiveProductHandleSet[shop];
    delete lastMetafieldUpdateFailed[shop];
}

export async function updateShopMetafield(shop, session, forceUpdate = false, source = 'unknown') {
    console.log(`[MetafieldManager] Source: ${source}. Updating metafield for shop: ${shop}, Force: ${forceUpdate}`);

    if (!shop || !session || !session.accessToken) {
        console.error(`[MetafieldManager] Source: ${source}. Invalid arguments: Shop='${shop}', Session Valid=${!!session?.accessToken}`);
        return;
    }

    try {
        let cachedShopData = shopMetafieldCache[shop];
        if (!cachedShopData || !cachedShopData.shopGid) {
            console.log(`[MetafieldManager] Source: ${source}. Cache miss for shop GID ${shop}. Querying...`);
            const client = new shopify.clients.Graphql({ session });
            const shopGidQuery = `{ shop { id } }`;
            const shopGidResponse = await client.query({ data: shopGidQuery }); // Consider .request for newer versions
            const fetchedShopGid = shopGidResponse?.body?.data?.shop?.id;

            if (!fetchedShopGid) {
                console.error(`[MetafieldManager] Source: ${source}. Failed to fetch Shop GID for ${shop}.`);
                return;
            }
            console.log(`[MetafieldManager] Source: ${source}. Fetched Shop GID for ${shop}: ${fetchedShopGid}`);
            // Initialize cache for this shop if it doesn't exist
            shopMetafieldCache[shop] = { ...(shopMetafieldCache[shop] || {}), shopGid: fetchedShopGid };
            cachedShopData = shopMetafieldCache[shop];
            // Attempt to get existing metafield to populate instanceGid and initial lastActiveProductHandleSet
            const metafieldQuery = `
              query GetShopMetafieldInstance {
                shop {
                  metafield(namespace: "custom", key: "active_drop_product_handle") {
                    id
                    value
                  }
                }
              }
            `;
            const metafieldResponse = await client.query({ data: { query: metafieldQuery } });
            const existingMetafield = metafieldResponse?.body?.data?.shop?.metafield;
            if (existingMetafield) {
                console.log(`[MetafieldManager] Source: ${source}. Found existing metafield for ${shop}: ID=${existingMetafield.id}, Value=${existingMetafield.value}`);
                shopMetafieldCache[shop].instanceGid = existingMetafield.id;
                if (lastActiveProductHandleSet[shop] === undefined) {
                    lastActiveProductHandleSet[shop] = existingMetafield.value || null;
                }
            } else {
                console.log(`[MetafieldManager] Source: ${source}. No existing 'active_drop_product_handle' metafield found for ${shop}.`);
                if (lastActiveProductHandleSet[shop] === undefined) {
                    lastActiveProductHandleSet[shop] = null;
                }
            }
        }

        const currentShopGid = cachedShopData?.shopGid;
        if (!currentShopGid) {
            console.error(`[MetafieldManager] Source: ${source}. Cannot proceed without Shop GID for ${shop}.`);
            return;
        }

        if (lastActiveProductHandleSet[shop] === undefined) {
            lastActiveProductHandleSet[shop] = null; 
        }
        const currentLastSetHandle = lastActiveProductHandleSet[shop];

        const { data: activeDrop, error: dbError } = await supabase
            .from('drops')
            .select('product_id, title') // Only select what's needed
            .eq('status', 'active')
            .eq('shop', shop)
            .maybeSingle();

        if (dbError) {
            console.error(`[MetafieldManager] Source: ${source}. Supabase error querying active drop for ${shop}:`, dbError);
            return;
        }

        let activeProductHandleValue = null;
        if (activeDrop && activeDrop.product_id) {
            console.log(`[MetafieldManager] Source: ${source}. Found active drop GID: ${activeDrop.product_id} (${activeDrop.title}) for ${shop}. Fetching handle.`);
            const client = new shopify.clients.Graphql({ session });
            const handleQuery = `query getProductHandle($id: ID!) { product(id: $id) { handle } }`;
            try {
                const handleResponse = await client.query({ data: { query: handleQuery, variables: { id: activeDrop.product_id } } });
                activeProductHandleValue = handleResponse?.body?.data?.product?.handle || null;
                if (activeProductHandleValue) {
                    console.log(`[MetafieldManager] Source: ${source}. Successfully fetched handle: ${activeProductHandleValue}`);
                } else {
                    console.warn(`[MetafieldManager] Source: ${source}. Failed to fetch handle for GID ${activeDrop.product_id} via GraphQL. Product might be deleted or inaccessible.`);
                }
            } catch (gqlError) {
                console.error(`[MetafieldManager] Source: ${source}. GraphQL error fetching handle for GID ${activeDrop.product_id}:`, gqlError.message);
                 // Optionally, attempt REST fallback here if critical
            }
        } else {
            console.log(`[MetafieldManager] Source: ${source}. No active drop found in Supabase for ${shop}. Metafield will be cleared.`);
        }
        
        const valueToSet = activeProductHandleValue === null ? "" : activeProductHandleValue;

        console.log(`[MetafieldManager] Source: ${source}. Comparing for ${shop}: New Value='${valueToSet}', Last Set Value='${currentLastSetHandle}', ForceUpdate=${forceUpdate}`);

        if (forceUpdate || valueToSet !== currentLastSetHandle) {
            console.log(`[MetafieldManager] Source: ${source}. Condition met for ${shop}. Proceeding with metafieldsSet to value: '${valueToSet}'.`);
            const client = new shopify.clients.Graphql({ session });
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
            const variables = {
                metafields: [{
                    key: "active_drop_product_handle",
                    namespace: "custom",
                    ownerId: currentShopGid,
                    type: "single_line_text_field",
                    value: valueToSet
                }]
            };
            try {
                const response = await client.query({ data: { query: mutation, variables } });
                if (response?.body?.data?.metafieldsSet?.userErrors?.length > 0) {
                    console.error(`[MetafieldManager] Source: ${source}. UserErrors during metafieldsSet for ${shop}:`, response.body.data.metafieldsSet.userErrors);
                    lastMetafieldUpdateFailed[shop] = true;
                } else if (response?.body?.errors) {
                    console.error(`[MetafieldManager] Source: ${source}. GraphQL errors during metafieldsSet for ${shop}:`, response.body.errors);
                    lastMetafieldUpdateFailed[shop] = true;
                } else if (response?.body?.data?.metafieldsSet?.metafields) {
                    console.log(`[MetafieldManager] Source: ${source}. Successfully SET metafield for ${shop}. New value: '${valueToSet}'`);
                    lastActiveProductHandleSet[shop] = valueToSet;
                    lastMetafieldUpdateFailed[shop] = false;
                    const newInstanceGid = response.body.data.metafieldsSet.metafields[0]?.id;
                    if (newInstanceGid) {
                        shopMetafieldCache[shop].instanceGid = newInstanceGid;
                    }
                } else {
                    console.error(`[MetafieldManager] Source: ${source}. Failed to SET metafield for ${shop}. Unexpected response:`, response?.body);
                    lastMetafieldUpdateFailed[shop] = true;
                }
            } catch (mutationError) {
                console.error(`[MetafieldManager] Source: ${source}. Exception during metafieldsSet for ${shop}:`, mutationError.message);
                lastMetafieldUpdateFailed[shop] = true;
            }
        } else {
            console.log(`[MetafieldManager] Source: ${source}. No update needed for ${shop}. Value '${valueToSet}' is same as last set '${currentLastSetHandle}'.`);
            lastMetafieldUpdateFailed[shop] = false; 
        }
    } catch (error) {
        console.error(`[MetafieldManager] Source: ${source}. UNHANDLED EXCEPTION in updateShopMetafield for ${shop}:`, error.message, error.stack);
        lastMetafieldUpdateFailed[shop] = true;
    }
} 