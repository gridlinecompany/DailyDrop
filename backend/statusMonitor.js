import { supabase } from './supabaseClient.js';
// import { baseShopifyApi as shopify } from './shopify.js'; // Might not be needed if session passed to updateShopMetafield is sufficient
import { getValidShopSession } from './apiMiddlewares.js'; // To get sessions for background tasks
import { updateShopMetafield } from './metafieldManager.js';

let ioInstance;
let sharedBroadcastFunctions = {}; // For broadcastScheduledDrops, etc.

const statusMonitoringIntervals = {};

export function initializeStatusMonitor(io, broadcastFunctions) {
    ioInstance = io;
    sharedBroadcastFunctions = broadcastFunctions;
    // console.log('[StatusMonitor] Initialized with io and broadcast functions.');
}

// Main function to start monitoring for a specific shop
export function startStatusMonitoring(shop) {
    if (statusMonitoringIntervals[shop]) {
        console.log(`[StatusMonitor] Monitoring already active for shop ${shop}`);
        return;
    }
    console.log(`[StatusMonitor] Starting monitor for shop ${shop}`);
    // Initial check shortly after start
    setTimeout(() => {
        console.log(`[StatusMonitor] Running initial status check for shop ${shop}`);
        checkAndActivateScheduledDrops(shop);
        checkAndCompleteActiveDrops(shop);
    }, 500); // 500ms delay

    statusMonitoringIntervals[shop] = setInterval(async () => {
        // console.log(`[StatusMonitor] Running periodic check for shop ${shop}`);
        await checkAndActivateScheduledDrops(shop);
        await checkAndCompleteActiveDrops(shop);
        // Consider if broadcastRefreshInstruction should be here or handled by specific change events
        if (Math.random() < 0.2) { // Reduce frequency of generic refresh
             if (sharedBroadcastFunctions.broadcastRefreshInstruction) {
                // sharedBroadcastFunctions.broadcastRefreshInstruction(shop);
             } else {
                // console.warn('[StatusMonitor] broadcastRefreshInstruction not available in shared functions.');
             }
        }
    }, 10000); // Check every 10 seconds
}

// Main function to stop monitoring for a specific shop
export function stopStatusMonitoring(shop) {
    if (statusMonitoringIntervals[shop]) {
        console.log(`[StatusMonitor] Stopping monitor for shop ${shop}`);
        clearInterval(statusMonitoringIntervals[shop]);
        delete statusMonitoringIntervals[shop];
    }
}

async function checkAndActivateScheduledDrops(shop) {
    // console.log(`[StatusMonitor DEBUG] Checking to activate scheduled drops for ${shop} at ${new Date().toISOString()}`);
    try {
        const now = new Date();
        const { data: dropsToPotentiallyActivate, error: queryError } = await supabase
            .from('drops')
            .select('*')
            .eq('shop', shop)
            .eq('status', 'queued')
            .lte('start_time', now.toISOString()) // Drops whose start time is now or in the past
            .order('start_time', { ascending: true });

        if (queryError) {
            console.error(`[StatusMonitor] Error querying queued drops for shop ${shop}:`, queryError.message);
            return;
        }

        if (dropsToPotentiallyActivate && dropsToPotentiallyActivate.length > 0) {
            console.log(`[StatusMonitor] Found ${dropsToPotentiallyActivate.length} queued drops whose start time has passed for ${shop}.`);
            const { data: currentActiveDrop, error: activeQueryError } = await supabase
                .from('drops')
                .select('id')
                .eq('shop', shop)
                .eq('status', 'active')
                .maybeSingle();
            if (activeQueryError) {
                console.error(`[StatusMonitor] Error querying current active drop for ${shop}:`, activeQueryError.message);
                return; // Don't proceed if we can't confirm current active state
            }

            if (currentActiveDrop) {
                console.log(`[StatusMonitor] Shop ${shop} already has an active drop (ID: ${currentActiveDrop.id}). Will not activate another yet.`);
                // Potentially, complete this active drop if its end_time is also passed (handled by checkAndCompleteActiveDrops)
                return;
            }
            
            // No currently active drop, proceed to activate the earliest one that should be active
            const dropToActivate = dropsToPotentiallyActivate[0]; // Already sorted by start_time
            console.log(`[StatusMonitor] Attempting to activate drop ${dropToActivate.id} (${dropToActivate.title}) for shop ${shop}.`);
            await activateDrop(shop, dropToActivate.id);
        }
    } catch (error) {
        console.error(`[StatusMonitor] Error in checkAndActivateScheduledDrops for shop ${shop}:`, error.message, error.stack);
    }
}

async function checkAndCompleteActiveDrops(shop) {
    // console.log(`[StatusMonitor DEBUG] Checking to complete active drops for ${shop} at ${new Date().toISOString()}`);
    try {
        const now = new Date();
        const { data: activeDrops, error: queryError } = await supabase
            .from('drops')
            .select('*')
            .eq('shop', shop)
            .eq('status', 'active')
            .lte('end_time', now.toISOString()); // Drops whose end_time is now or in the past

        if (queryError) {
            console.error(`[StatusMonitor] Error querying active drops to complete for ${shop}:`, queryError.message);
            return;
        }

        if (activeDrops && activeDrops.length > 0) {
            console.log(`[StatusMonitor] Found ${activeDrops.length} active drop(s) to complete for shop ${shop}.`);
            for (const drop of activeDrops) {
                console.log(`[StatusMonitor] Attempting to complete drop ${drop.id} (${drop.title}) for shop ${shop}.`);
                await completeActiveDrop(shop, drop.id);
            }
        }
    } catch (error) {
        console.error(`[StatusMonitor] Error in checkAndCompleteActiveDrops for shop ${shop}:`, error.message, error.stack);
    }
}

async function activateDrop(shop, dropId) {
    console.log(`[StatusMonitor] Activating drop ${dropId} for ${shop} at ${new Date().toISOString()}`);
    try {
        const { data: dropDataToActivate, error: fetchError } = await supabase
            .from('drops')
            .select('*')
            .eq('id', dropId)
            .eq('shop', shop)
            .single(); // Expect one specific drop
            
        if (fetchError || !dropDataToActivate) {
            console.error(`[StatusMonitor] Error fetching drop ${dropId} for activation or drop not found:`, fetchError?.message);
            return null;
        }

        const activationTime = new Date();
        const calculatedEndTime = new Date(activationTime.getTime() + dropDataToActivate.duration_minutes * 60 * 1000);

        const { data: activatedDrop, error: updateError } = await supabase
            .from('drops')
            .update({
                status: 'active',
                start_time: activationTime.toISOString(), 
                end_time: calculatedEndTime.toISOString()
            })
            .eq('id', dropId)
            .eq('shop', shop)
            // .eq('status', 'queued') // Ensure we only activate a queued drop
            .select()
            .single();

        if (updateError) {
            console.error(`[StatusMonitor] Error updating drop ${dropId} to active for ${shop}:`, updateError.message);
            return null;
        }

        console.log(`[StatusMonitor] Successfully activated drop ${dropId} (${activatedDrop.title}) for shop ${shop}.`);

        if (ioInstance) {
            ioInstance.to(shop).emit('active_drop', activatedDrop);
            ioInstance.to(shop).emit('status_change', { type: 'activated', id: activatedDrop.id, title: activatedDrop.title, timestamp: new Date().toISOString() });
        }
        if (sharedBroadcastFunctions.broadcastScheduledDrops) sharedBroadcastFunctions.broadcastScheduledDrops(shop);
        if (sharedBroadcastFunctions.broadcastRefreshInstruction) sharedBroadcastFunctions.broadcastRefreshInstruction(shop); // Notify for general UI update

        const session = getValidShopSession(shop);
        if (session) {
            await updateShopMetafield(shop, session, true, 'activateDrop');
        } else {
            console.warn(`[StatusMonitor] No valid session found for shop ${shop} when trying to update metafield after activation.`);
        }
        return activatedDrop;
    } catch (error) {
        console.error(`[StatusMonitor] Overall error in activateDrop for ${dropId}, shop ${shop}:`, error.message, error.stack);
        return null;
    }
}

async function completeActiveDrop(shop, dropId) {
    console.log(`[StatusMonitor] Completing drop ${dropId} for ${shop} at ${new Date().toISOString()}`);
    try {
        const { data: completedDrop, error: updateError } = await supabase
            .from('drops')
            .update({ status: 'completed' }) // end_time should have been set at activation or by trigger
            .eq('id', dropId)
            .eq('shop', shop)
            .eq('status', 'active') // Only complete if it was active
            .select()
            .single();

        if (updateError) {
            console.error(`[StatusMonitor] Error updating drop ${dropId} to completed for ${shop}:`, updateError.message);
            return null;
        }
        if (!completedDrop) {
            console.warn(`[StatusMonitor] Drop ${dropId} was not found or not active when trying to complete for ${shop}.`);
            return null;
        }

        console.log(`[StatusMonitor] Successfully completed drop ${dropId} (${completedDrop.title}) for shop ${shop}.`);

        if (ioInstance) {
            ioInstance.to(shop).emit('active_drop', null);
            ioInstance.to(shop).emit('status_change', { type: 'completed', id: completedDrop.id, title: completedDrop.title, timestamp: new Date().toISOString() });
        }
        if (sharedBroadcastFunctions.broadcastCompletedDrops) sharedBroadcastFunctions.broadcastCompletedDrops(shop);
        if (sharedBroadcastFunctions.broadcastRefreshInstruction) sharedBroadcastFunctions.broadcastRefreshInstruction(shop); // Notify for general UI update

        const session = getValidShopSession(shop);
        if (session) {
            await updateShopMetafield(shop, session, true, 'completeActiveDrop');
        } else {
            console.warn(`[StatusMonitor] No valid session found for shop ${shop} when trying to update metafield after completion.`);
        }
        return completedDrop;
    } catch (error) {
        console.error(`[StatusMonitor] Overall error in completeActiveDrop for ${dropId}, shop ${shop}:`, error.message, error.stack);
        return null;
    }
} 