import express from 'express';
import { supabase } from './supabaseClient.js';
import { validateSession } from './apiMiddlewares.js'; // Assuming validateSession is in apiMiddlewares.js

const router = express.Router();

// GET /api/settings
router.get('/', validateSession, async (req, res) => {
    const shop = req.query.shop; // shop is attached by validateSession if successful, or use req.shopifySession.shop
    console.log(`[/api/settings GET] Request received for shop: ${shop}`);

    try {
        const { data, error } = await supabase
            .from('app_settings')
            .select('queued_collection_id, drop_time, default_drop_duration_minutes, default_drop_date')
            .eq('shop', shop)
            .maybeSingle();

        if (error) {
            console.error('[/api/settings GET] Supabase Error:', error);
            throw error;
        }

        if (data) {
            console.log('[/api/settings GET] Found settings:', data);
            res.status(200).json(data);
        } else {
            console.log(`[/api/settings GET] No settings found for shop: ${shop}. Returning defaults.`);
            res.status(200).json({
                queued_collection_id: null,
                drop_time: '10:00',
                default_drop_duration_minutes: 60,
                default_drop_date: null
            }); 
        }
    } catch (error) {
        console.error('[/api/settings GET] Server Error:', error);
        const errorMessage = error.message || 'Internal server error retrieving settings.';
        let statusCode = error.status || 500;
        if (error.code === '42501') { // permission denied (RLS)
             statusCode = 403;
        } 
        res.status(statusCode).json({ error: errorMessage });
    }
});

// POST /api/settings
router.post('/', validateSession, async (req, res) => {
    const shop = req.shopifySession?.shop; // Get shop from the validated session
    console.log(`[/api/settings POST] Request received for shop: ${shop}`);

    if (!shop) {
        console.error('[/api/settings POST] Critical: Shop could not be determined from validated session.');
        return res.status(400).json({ error: 'Shop could not be determined. Session may be invalid.' });
    }
    
    const {
        queued_collection_id,
        drop_time,
        default_drop_duration_minutes,
        default_drop_date
    } = req.body;

    console.log(`[/api/settings POST] Received payload:`, req.body);

    const settingsData = {
        shop: shop, // Primary key
        queued_collection_id: queued_collection_id || null,
        drop_time: drop_time || null,
        default_drop_duration_minutes: default_drop_duration_minutes || 60, 
        default_drop_date: default_drop_date || null,
    };

    console.log('[/api/settings POST] Data being upserted to Supabase:', settingsData);

    try {
        const { data, error } = await supabase
            .from('app_settings')
            .upsert(settingsData, { onConflict: 'shop' })
            .select()
            .single();

        if (error) {
            console.error('[/api/settings POST] Supabase Error:', error);
            throw error; 
        }

        console.log('[/api/settings POST] Settings saved/updated successfully in Supabase:', data);
        res.status(200).json(data); 

    } catch (error) {
        console.error('[/api/settings POST] Server Error:', error);
        const errorMessage = error.message || 'Internal server error saving settings.';
        let statusCode = error.status || 500;
        if (error.code === '42501') { 
             statusCode = 403;
        } 
        res.status(statusCode).json({ error: errorMessage });
    }
});

export default router; 