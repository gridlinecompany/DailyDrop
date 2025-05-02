import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AppProvider,
  Page,
  Text,
  Spinner,
  Layout,
  LegacyCard,
  DataTable,
  Card,
  BlockStack,
  Button,
  Select,
  TextField,
  Box,
  InlineGrid,
  Divider,
  useBreakpoints,
  Thumbnail,
  Toast,
  Frame,
  IndexTable,
  useIndexResourceState,
  Badge,
  Pagination,
} from '@shopify/polaris';
import enTranslations from "@shopify/polaris/locales/en.json";
import '@shopify/polaris/build/esm/styles.css';
// import './index.css'; // Assuming you might have base styles - Comment out if not present

function App() {
  // --- State Variables (Minimal Base) ---
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [sessionToken, setSessionToken] = useState(null); // Store JWT

  // State for Drop Settings Card
  const [allCollections, setAllCollections] = useState([]);
  const [queuedCollection, setQueuedCollection] = useState('placeholder');
  // const [activeCollection, setActiveCollection] = useState('placeholder'); // <-- COMMENT OUT
  // const [completedCollection, setCompletedCollection] = useState('placeholder'); // <-- COMMENT OUT
  const [dropDateString, setDropDateString] = useState('');
  const [dropTime, setDropTime] = useState('10:00');
  const [dropDuration, setDropDuration] = useState('60'); // Keep as string for input field

  // State for fetched product data
  const [queuedProductsData, setQueuedProductsData] = useState([]);
  const [isFetchingQueuedProducts, setIsFetchingQueuedProducts] = useState(false);
  const [scheduledDropsData, setScheduledDropsData] = useState([]);
  const [isFetchingScheduledDrops, setIsFetchingScheduledDrops] = useState(false);
  const [activeDropData, setActiveDropData] = useState(null);
  const [isFetchingActiveDrop, setIsFetchingActiveDrop] = useState(false);
  const [completedDropsData, setCompletedDropsData] = useState([]);
  const [isFetchingCompletedDrops, setIsFetchingCompletedDrops] = useState(false);

  // State for Toast messages
  const [toastActive, setToastActive] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [toastIsError, setToastIsError] = useState(false);
  
  // State for save button loading state
  const [isSaving, setIsSaving] = useState(false);
  const [isBulkScheduling, setIsBulkScheduling] = useState(false); // <-- Add bulk scheduling state
  const [isAppending, setIsAppending] = useState(false); // <-- NEW: Append loading state
  const [isDeleting, setIsDeleting] = useState(false); // <-- NEW: Delete loading state

  // --- NEW: Pagination State ---
  const [scheduledPage, setScheduledPage] = useState(1);
  const [scheduledTotalCount, setScheduledTotalCount] = useState(0);
  const [completedPage, setCompletedPage] = useState(1);
  const [completedTotalCount, setCompletedTotalCount] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(5); // Default page size
  // --- End Pagination State ---

  const { smUp } = useBreakpoints(); // <-- Use breakpoints hook

  // --- Generate options for Select components from fetched state ---
  const collectionOptions = useMemo(() => {
    const options = allCollections.map(col => ({ label: col.label, value: col.value }));
    // Add the placeholder option at the beginning
    return [{ label: 'Select a collection', value: 'placeholder' }, ...options];
  }, [allCollections]);

  // --- Utility Functions ---
  const getShop = () => new URLSearchParams(window.location.search).get('shop');
  
  // --- Toast Utilities (Define Before Use) ---
  const toggleToastActive = useCallback(() => setToastActive((active) => !active), []);

  const showToast = useCallback((message, isError = false) => { // Wrap showToast in useCallback too
    setToastMessage(message);
    setToastIsError(isError);
    setToastActive(true);
  }, []); // showToast itself doesn't have dependencies

  // --- Utility function to fetch scheduled drops ---
  // UPDATED to handle pagination
  const fetchScheduledDrops = useCallback(async (page = 1, limit = 5) => {
      const shop = getShop();
      if (!shop || !sessionToken || !isAuthenticated) return; // Need token/auth

      console.log(`[App.jsx Scheduled] Fetching scheduled drops page: ${page}, limit: ${limit}`);
      setIsFetchingScheduledDrops(true);
      setScheduledPage(page); // Update current page state

      try {
          // Pass page and limit to backend
          const response = await fetch(`/api/drops/queued?shop=${encodeURIComponent(shop)}&page=${page}&limit=${limit}`, {
              headers: { 'Authorization': `Bearer ${sessionToken}` }
          });
          if (!response.ok) throw new Error(`Scheduled drops fetch failed: ${response.status}`);
          
          const { data, totalCount } = await response.json(); // Expect { data: [], totalCount: number }
          console.log(`[App.jsx Scheduled] Received ${data?.length || 0} drops. Total count: ${totalCount}`);
          
          setScheduledDropsData(data || []);
          setScheduledTotalCount(totalCount || 0);

      } catch (error) {
          console.error('[App.jsx Scheduled] Error fetching scheduled drops:', error);
          showToast('Error loading scheduled drops.', true);
          setScheduledDropsData([]); // Clear on error
          setScheduledTotalCount(0);
      } finally {
          setIsFetchingScheduledDrops(false);
      }
  }, [sessionToken, isAuthenticated, showToast]); // Dependencies

  // --- NEW: Utility function to fetch completed drops (paginated) ---
  const fetchCompletedDrops = useCallback(async (page = 1, limit = 5) => {
      const shop = getShop();
      if (!shop || !sessionToken || !isAuthenticated) return; // Need token/auth

      console.log(`[App.jsx Completed] Fetching completed drops page: ${page}, limit: ${limit}`);
      setIsFetchingCompletedDrops(true);
      setCompletedPage(page); // Update current page state

      try {
          // Pass page and limit to backend
          const response = await fetch(`/api/drops/completed?shop=${encodeURIComponent(shop)}&page=${page}&limit=${limit}`, {
              headers: { 'Authorization': `Bearer ${sessionToken}` }
          });
          if (!response.ok) throw new Error(`Completed drops fetch failed: ${response.status}`);

          const { data, totalCount } = await response.json(); // Expect { data: [], totalCount: number }
          console.log(`[App.jsx Completed] Received ${data?.length || 0} drops. Total count: ${totalCount}`);

          setCompletedDropsData(data || []);
          setCompletedTotalCount(totalCount || 0);

      } catch (error) {
          console.error('[App.jsx Completed] Error fetching completed drops:', error);
          showToast('Error loading completed drops.', true);
          setCompletedDropsData([]); // Clear on error
          setCompletedTotalCount(0);
      } finally {
          setIsFetchingCompletedDrops(false);
      }
  }, [sessionToken, isAuthenticated, showToast]); // Dependencies

  // --- NEW: Utility function to fetch the active drop ---
  const fetchActiveDrop = useCallback(async () => {
    const shop = getShop();
    if (!shop || !sessionToken || !isAuthenticated) return; // Need token/auth

    console.log(`[App.jsx Active] Fetching active drop...`);
    setIsFetchingActiveDrop(true);

    try {
        const response = await fetch(`/api/drops/active?shop=${encodeURIComponent(shop)}`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!response.ok) throw new Error(`Active drop fetch failed: ${response.status}`);
        
        const activeData = await response.json(); // Can be null if none active
        console.log(`[App.jsx Active] Received active drop data:`, activeData);
        setActiveDropData(activeData); // Update state

    } catch (error) {
        console.error('[App.jsx Active] Error fetching active drop:', error);
        showToast('Error loading active drop.', true);
        setActiveDropData(null); // Clear on error
    } finally {
        setIsFetchingActiveDrop(false);
    }
  }, [sessionToken, isAuthenticated, showToast]); // Dependencies

  // --- Authentication Effect (Keep as is) ---
  useEffect(() => {
    console.log('[App.jsx Base] Auth useEffect triggered.'); // Updated log prefix
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    const shop = getShop();

    if (!shop) {
      console.error('[App.jsx Base] Critical Error: Shop parameter missing.');
        setIsLoading(false);
        return;
    }

    if (urlToken) {
      console.log('[App.jsx Base] Found token in URL.');
      setSessionToken(urlToken);
      params.delete('token');
      window.history.replaceState({}, document.title, `${window.location.pathname}?${params.toString()}`);
    } else if (!sessionToken) {
      console.log('[App.jsx Base] No token found. Redirecting to auth.');
        window.location.href = `/auth?shop=${encodeURIComponent(shop)}`;
      return;
    }

    const currentToken = sessionToken || urlToken;
    if (!currentToken) {
      console.error('[App.jsx Base] Token check inconsistency. Redirecting.');
        window.location.href = `/auth?shop=${encodeURIComponent(shop)}`;
        return;
    }

    console.log('[App.jsx Base] Verifying session...');
    const verificationHeaders = {
      'Authorization': `Bearer ${currentToken}`,
    };
    console.log('[App.jsx Base] Token being sent:', currentToken);
    console.log('[App.jsx Base] Headers being sent:', verificationHeaders);
    fetch(`/api/verify-session?shop=${encodeURIComponent(shop)}`, {
      headers: verificationHeaders,
    })
      .then(response => {
        console.log('[App.jsx Base] Verification response status:', response.status);
        if (response.ok) {
          setIsAuthenticated(true);
          setSessionToken(currentToken);
          console.log('[App.jsx Base] Session verified.');
          
          // ---> Fetch ALL initial data AFTER session is verified <--- 
          setIsLoading(true); 
          Promise.allSettled([ // Use allSettled to avoid one failure stopping others
            // Fetch Collections
            fetch(`/api/collections?shop=${encodeURIComponent(shop)}`, { headers: { 'Authorization': `Bearer ${currentToken}` } }).then(res => {
              if (!res.ok) throw new Error(`Collections fetch failed: ${res.status}`);
              return res.json();
            }),
            // Fetch Settings
            fetch(`/api/settings?shop=${encodeURIComponent(shop)}`, { headers: { 'Authorization': `Bearer ${currentToken}` } }).then(res => {
              if (!res.ok) throw new Error(`Settings fetch failed: ${res.status}`);
              return res.json();
            }),
          ])
          .then(async ([collectionsResult, settingsResult]) => { // <-- Make this async
              // Process Collections
              if (collectionsResult.status === 'fulfilled') {
                 console.log('[App.jsx Init] Fetched Collections:', collectionsResult.value);
                 setAllCollections(collectionsResult.value || []);
              } else {
                 console.error('[App.jsx Init] Error fetching Collections:', collectionsResult.reason);
                 showToast(`Error loading Collections: ${collectionsResult.reason.message}`, true);
                 setAllCollections([]);
              }

              // Process Settings
              if (settingsResult.status === 'fulfilled') {
                 const settingsData = settingsResult.value;
                 console.log('[App.jsx Init] Fetched Settings:', settingsData);
                 setQueuedCollection(settingsData?.queued_collection_id || 'placeholder');
                 // setActiveCollection(settingsData?.active_collection_id || 'placeholder'); // <-- COMMENT OUT
                 // setCompletedCollection(settingsData?.completed_collection_id || 'placeholder'); // <-- COMMENT OUT
                 setDropTime(settingsData?.drop_time || '10:00');
                 setDropDuration(String(settingsData?.default_drop_duration_minutes || '60')); 
                 setDropDateString(settingsData?.default_drop_date || ''); 
              } else {
                 console.error('[App.jsx Init] Error fetching Settings:', settingsResult.reason);
                 showToast(`Error loading Settings: ${settingsResult.reason.message}`, true);
                 // Reset relevant states on settings error
                 setQueuedCollection('placeholder');
                 // setActiveCollection('placeholder'); // <-- COMMENT OUT
                 // setCompletedCollection('placeholder'); // <-- COMMENT OUT
                 setDropTime('10:00');
                 setDropDuration('60');
                 setDropDateString('');
              }

              // --- Fetch initial drop states AFTER settings are processed ---
              console.log('[App.jsx Init] Fetching initial drop states...');
              try {
                  // Use Promise.allSettled again for the drop fetches
                  await Promise.allSettled([ // <-- await the drop fetches
                      fetchScheduledDrops(1, rowsPerPage), 
                      fetchCompletedDrops(1, rowsPerPage),
                      fetchActiveDrop() 
                  ]);
                  console.log('[App.jsx Init] Initial drop state fetches complete.');
              } catch (dropFetchError) {
                  // This catch might not be strictly necessary with allSettled,
                  // as individual errors are handled within the fetch functions.
                  // Log just in case something unexpected happens at this level.
                  console.error('[App.jsx Init] Error during initial drop fetch sequence:', dropFetchError);
                  showToast('Error loading initial drop data.', true);
              }
              // --- End Fetch Initial Drop States ---

          })
          .finally(() => {
              setIsLoading(false);
              console.log('[App.jsx Init] Initial data fetch sequence complete (Collections, Settings, Drops).'); 
          });
          // ---> End Fetch Initial Data <--- 

        } else {
          setIsAuthenticated(false);
          console.error('[App.jsx Base] Session verification failed. Status:', response.status);
          setSessionToken(null);
          window.location.href = `/auth?shop=${encodeURIComponent(shop)}`;
          setIsLoading(false); // Also set loading false here
        }
      })
      .catch((error) => {
        console.error('[App.jsx Base] Error during verification fetch:', error);
          setIsAuthenticated(false);
        setSessionToken(null);
        setIsLoading(false); // Also set loading false here
      });

  }, [sessionToken]);

  // --- Effect for Periodic Data Refresh ---
  useEffect(() => {
    if (!isAuthenticated || !sessionToken) return; // Only run if authenticated

    console.log('[App.jsx Refresh] Setting up periodic fetch...');

    const intervalId = setInterval(() => {
      console.log('[App.jsx Refresh] Interval triggered: fetching current pages...');
      // Fetch current pages for scheduled and completed drops
      fetchScheduledDrops(scheduledPage, rowsPerPage);
      fetchCompletedDrops(completedPage, rowsPerPage);
      fetchActiveDrop(); // <-- Add call to fetch active drop
    }, 30000); // Refresh every 30 seconds

    // Cleanup function to clear the interval when the component unmounts
    return () => {
      console.log('[App.jsx Refresh] Clearing interval.');
      clearInterval(intervalId);
    };
  }, [isAuthenticated, sessionToken, fetchScheduledDrops, fetchCompletedDrops, fetchActiveDrop, scheduledPage, completedPage, rowsPerPage]); 

  // --- Effect to fetch Queued Products when collection changes ---
  useEffect(() => {
    const shop = getShop();
    // Define the actual fetch function (simplified, no pagination)
    const fetchQueuedProducts = async (limit = 50) => { // Fetch up to limit (e.g., 50)
      if (!queuedCollection || queuedCollection === 'placeholder' || !sessionToken || !shop || !isAuthenticated) {
        setQueuedProductsData([]); // Clear data if not ready to fetch
        return;
      }

      console.log(`[App.jsx Queued] Fetching products for collection ID: ${queuedCollection}`);
      setIsFetchingQueuedProducts(true);

      try {
        const response = await fetch(`/api/products-by-collection?shop=${encodeURIComponent(shop)}&collectionId=${queuedCollection}&limit=${limit}`, {
          headers: {
            'Authorization': `Bearer ${sessionToken}`,
          },
        });
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json(); // Expect just the array now
        console.log(`[App.jsx Queued] Successfully fetched products. Count: ${data?.length || 0}.`);
        setQueuedProductsData(data || []); // Ensure data is an array
      } catch (error) {
        console.error('[App.jsx Queued] Error fetching products:', error);
        setQueuedProductsData([]); // Clear data on error
        showToast(`Error loading queued products: ${error.message}`, true);
      } finally {
        setIsFetchingQueuedProducts(false);
      }
    };

    // Call the simplified fetch function when the collection changes
    fetchQueuedProducts(50); // Fetch up to 50 items
    // We need fetchQueuedProductsForPage in dependency array if it's defined outside
    // But defining inside useEffect avoids needing it as dependency if it doesn't use outside props/state directly
    // OR we wrap it in useCallback and add dependencies
  }, [queuedCollection, sessionToken, isAuthenticated, showToast]); // Removed rowsPerPage dependency

  // --- Callbacks for Drop Settings ---
  const handleSaveSettings = useCallback(async () => {
    const shop = getShop();
    if (!shop || !sessionToken || !isAuthenticated) {
      console.error('[App.jsx Settings] Cannot save settings: Missing shop, token, or not authenticated.');
      showToast('Authentication error. Cannot save settings.', true);
      return;
    }

    setIsSaving(true); // Start loading indicator
    
    const settingsPayload = {
        queued_collection_id: queuedCollection === 'placeholder' ? null : queuedCollection,
        // active_collection_id: activeCollection === 'placeholder' ? null : activeCollection, // <-- COMMENT OUT
        // completed_collection_id: completedCollection === 'placeholder' ? null : completedCollection, // <-- COMMENT OUT
        drop_time: dropTime,
        default_drop_duration_minutes: parseInt(dropDuration, 10) || 60, // <-- Send duration to settings
        default_drop_date: dropDateString || null // <-- Send date to settings
    };

    console.log('[App.jsx Settings] Saving Settings Payload:', settingsPayload);

    try {
      const response = await fetch(`/api/settings?shop=${encodeURIComponent(shop)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`,
        },
        body: JSON.stringify(settingsPayload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Failed to parse error response' }));
        throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      console.log('[App.jsx Settings] Settings saved successfully:', result);
      showToast('Settings saved successfully!');

    } catch (error) {
      console.error('[App.jsx Settings] Error saving settings:', error);
      showToast(`Error saving settings: ${error.message}`, true);
    } finally {
      setIsSaving(false); // Stop loading indicator
    }
  }, [
    sessionToken, 
    isAuthenticated, 
    queuedCollection, 
    // activeCollection, // <-- COMMENT OUT
    // completedCollection, // <-- COMMENT OUT
    dropTime,
    dropDuration,
    dropDateString
  ]);

  // --- NEW: Callback to schedule ALL queued drops --- 
  const handleScheduleAllDrops = useCallback(async () => {
    const shop = getShop();
    if (!shop || !sessionToken || !isAuthenticated) {
      showToast('Authentication error. Cannot schedule drops.', true);
      return;
    }

    // --- Validation ---
    if (queuedCollection === 'placeholder') {
      showToast('Please select a "Queued Products Collection" first.', true);
      return;
    }
    if (!dropDateString || !dropTime || !dropDuration) {
      showToast('Please set Drop Date, Time, and Duration before scheduling.', true);
      return;
    }
    const durationMinutes = parseInt(dropDuration, 10);
    if (isNaN(durationMinutes) || durationMinutes <= 0) {
       showToast('Please enter a valid positive number for Duration (mins).', true);
       return;
    }
    // --- End Validation ---

    setIsBulkScheduling(true);

    const schedulePayload = {
        shop: shop,
        queued_collection_id: queuedCollection,
        start_date_string: dropDateString,
        start_time_string: dropTime,
        duration_minutes: durationMinutes
    };

    console.log('[App.jsx Schedule All] Scheduling Drops Payload:', schedulePayload);

    try {
      const response = await fetch(`/api/drops/schedule-all`, { // <-- Call the new endpoint
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`,
        },
        body: JSON.stringify(schedulePayload),
      });

      const result = await response.json(); // Try to parse JSON regardless of status for error messages

      if (!response.ok) {
        throw new Error(result.error || `HTTP error! status: ${response.status}`);
      }

      console.log('[App.jsx Schedule All] Drops scheduled successfully:', result);
      showToast(result.message || `${result.scheduled_count || 0} drops scheduled successfully!`);
      
      // Refetch scheduled drops to update the UI
      fetchScheduledDrops(1, rowsPerPage);
      fetchActiveDrop(); // <-- ADD THIS LINE
      
      // Clear the Queued Products list as they are now scheduled
      setQueuedProductsData([]); 
      
      // Optional: Clear schedule fields after success?
      // setDropDateString(''); setDropTime('10:00'); setDropDuration('60');

    } catch (error) {
      console.error('[App.jsx Schedule All] Error scheduling drops:', error);
      showToast(`Error scheduling drops: ${error.message}`, true);
    } finally {
      setIsBulkScheduling(false); // Clear loading state regardless of outcome
    }
  }, [
    sessionToken,
    isAuthenticated,
    queuedCollection, // Need collection GID
    dropDateString,
    dropTime,
    dropDuration,
    showToast, 
    fetchScheduledDrops,
    rowsPerPage // Add rowsPerPage
  ]);

  // --- NEW: Callback to append NEW queued drops --- 
  const handleAppendDrops = useCallback(async () => {
    const shop = getShop();
    if (!shop || !sessionToken || !isAuthenticated) {
      showToast('Authentication error. Cannot append drops.', true);
      return;
    }

    // --- Validation ---
    if (queuedCollection === 'placeholder') {
      showToast('Please select a "Queued Products Collection" first.', true);
      return;
    }
    // No longer need to validate duration here for the API call,
    // but good UI practice to ensure a valid duration setting exists before allowing append.
    const currentSavedDuration = parseInt(dropDuration, 10);
    if (isNaN(currentSavedDuration) || currentSavedDuration <= 0) {
        showToast('Please set and save a valid positive Drop Duration in settings first.', true);
        return;
    }
    // --- End Validation ---

    setIsAppending(true);

    const appendPayload = {
        shop: shop,
        queued_collection_id: queuedCollection
        // Duration is removed - backend gets it from settings
    };

    console.log('[App.jsx Append] Appending Drops Payload:', appendPayload);

    try {
      const response = await fetch(`/api/drops/append`, { // <-- Call the append endpoint
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`,
        },
        body: JSON.stringify(appendPayload),
      });

      const result = await response.json(); // Try to parse JSON regardless of status

      if (!response.ok) {
        throw new Error(result.error || `HTTP error! status: ${response.status}`);
      }

      console.log('[App.jsx Append] Drops appended successfully:', result);
      showToast(result.message || `${result.scheduled_count || 0} new drops appended successfully!`);
      
      // Refetch scheduled drops to update the UI
      fetchScheduledDrops(1, rowsPerPage);
      fetchActiveDrop(); // <-- ADD THIS LINE
      
      // We probably don't need to clear QueuedProductsData here, 
      // as some might still be legitimately queued and not yet scheduled.
      // Maybe trigger a refetch of queued products instead?
      // For now, just refetch scheduled drops.

    } catch (error) {
      console.error('[App.jsx Append] Error appending drops:', error);
      showToast(`Error appending drops: ${error.message}`, true);
    } finally {
      setIsAppending(false); // Clear loading state
    }
  }, [
    sessionToken,
    isAuthenticated,
    queuedCollection, 
    dropDuration, // Keep dropDuration dependency for validation check
    showToast, 
    fetchScheduledDrops,
    rowsPerPage // Add rowsPerPage
  ]);

  // --- NEW: Function to handle deletion of selected drops ---
  const handleDeleteSelectedDrops = useCallback(async (dropIdsToDelete) => {
    const shop = getShop();
    if (!shop || !sessionToken || !isAuthenticated) {
      showToast('Authentication error. Cannot delete drops.', true);
      return;
    }

    if (!dropIdsToDelete || dropIdsToDelete.length === 0) {
      showToast('No drops selected to delete.', true);
      return;
    }

    setIsDeleting(true);
    console.log('[App.jsx Delete] Deleting drop IDs:', dropIdsToDelete);

    try {
      const response = await fetch(`/api/drops?shop=${encodeURIComponent(shop)}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ drop_ids: dropIdsToDelete }),
      });

      const result = await response.json(); // Try to parse JSON regardless of status

      if (!response.ok) {
        throw new Error(result.error || `HTTP error! status: ${response.status}`);
      }

      console.log('[App.jsx Delete] Drops deleted successfully:', result);
      showToast(`${result.deleted_count || 0} queued drop(s) deleted successfully!`);

      // Refetch scheduled drops to update the UI
      // Go back to page 1 after deletion
      fetchScheduledDrops(1, rowsPerPage); 
      // Clear selection
      // Note: useIndexResourceState doesn't directly expose a clear selection function.
      // Re-fetching data and letting the hook re-initialize with new data (and thus empty selection) is the standard pattern.
      
    } catch (error) {
      console.error('[App.jsx Delete] Error deleting drops:', error);
      showToast(`Error deleting drops: ${error.message}`, true);
    } finally {
      setIsDeleting(false); // Clear loading state
    }
  }, [sessionToken, isAuthenticated, showToast, fetchScheduledDrops, rowsPerPage]);
  // --- END NEW Function ---

  // --- Add selection handling for Scheduled Drops IndexTable ---
  const {
      selectedResources,
      allResourcesSelected,
      handleSelectionChange,
  } = useIndexResourceState(scheduledDropsData || []); // Pass the data here

  // --- Define Promoted Bulk Actions for IndexTable ---
  const promotedBulkActions = [
      {
          content: 'Delete selected queued drops',
          onAction: () => handleDeleteSelectedDrops(selectedResources),
          disabled: selectedResources.length === 0 || isDeleting, // Disable if none selected or already deleting
          loading: isDeleting,
      },
  ];

  // --- Define Row Markup for IndexTable ---
  const scheduledDropsRowMarkup = scheduledDropsData.map(
      (
          { id, thumbnail_url, title, start_time, end_time, status }, // Add status here
          index,
      ) => {
          const startDate = start_time ? new Date(start_time).toLocaleDateString() : '-';
          const startTime = start_time ? new Date(start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true }) : '-';
          const endTime = end_time ? new Date(end_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true }) : '-';
          
          // Determine Badge status - only show for queued for clarity with delete action
          let statusBadge = null;
          if (status === 'queued') {
              statusBadge = <Badge tone="info">Queued</Badge>;
          } else if (status === 'active') {
               statusBadge = <Badge tone="success" progress="incomplete">Active</Badge>;
          } else if (status === 'completed') {
               statusBadge = <Badge tone="success" progress="complete">Completed</Badge>;
          }


          return (
              <IndexTable.Row
                  id={id}
                  key={id}
                  selected={selectedResources.includes(id)}
                  position={index}
              >
                  <IndexTable.Cell>
                      <Thumbnail
                          source={thumbnail_url || 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_medium.png?format=webp&v=1530129081'}
                          alt={title || 'Scheduled product'}
                          size="small"
                      />
                  </IndexTable.Cell>
                  <IndexTable.Cell>{title || 'N/A'}</IndexTable.Cell>
                  <IndexTable.Cell>{startDate}</IndexTable.Cell>
                  <IndexTable.Cell>{startTime}</IndexTable.Cell>
                  <IndexTable.Cell>{endTime}</IndexTable.Cell>
                  <IndexTable.Cell>{statusBadge}</IndexTable.Cell> 
              </IndexTable.Row>
          );
      },
  );

  // --- Define Row Markup for Queued Products Table ---
  const queuedProductsRowMarkup = queuedProductsData.map(
    (product, index) => (
      <IndexTable.Row
        id={product.id} // Assuming product has a unique ID from Shopify
        key={product.id}
        position={index}
        // Not selectable for now
      >
        <IndexTable.Cell>
          <Thumbnail
            source={product.imageUrl || 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_medium.png?format=webp&v=1530129081'}
            alt={product.title}
            size="small"
          />
        </IndexTable.Cell>
        <IndexTable.Cell>{product.title}</IndexTable.Cell>
      </IndexTable.Row>
    )
  );

  // --- Render Logic ---

  // Loading State
  if (isLoading) {
    return (
      <AppProvider i18n={enTranslations}>
         <Frame>{/* Frame for potential early Toasts if needed */}
           <Page>
              <Spinner accessibilityLabel="Loading app data..." size="large" />
           </Page>
         </Frame>
      </AppProvider>
    );
  }

  // Auth Failed State
  if (!isAuthenticated) {
    return (
      <AppProvider i18n={enTranslations}>
         <Frame>{/* Frame for potential early Toasts if needed */}
           <Page title="Authenticating...">
             <Text as="p">Please wait while we verify your session...</Text>
             <Spinner accessibilityLabel="Authenticating..." size="small" />
           </Page>
         </Frame>
      </AppProvider>
    );
  }

  // --- Authenticated App UI (Settings Layout Example Style) ---
  const toastMarkup = toastActive ? (
    <Toast content={toastMessage} onDismiss={toggleToastActive} error={toastIsError} />
  ) : null;

  // Wrap the Page content in a Frame to provide context for the Toast
  const pageContent = (
    <Page 
      title="Daily Drop Manager"
      primaryAction={{ 
          content: "Save Settings", 
          onAction: handleSaveSettings, 
          loading: isSaving, 
          disabled: isBulkScheduling // Disable while bulk scheduling
      }}
      secondaryActions={[ // Add Schedule All as a secondary action
          {
              content: "Schedule All Queued",
              onAction: handleScheduleAllDrops,
              loading: isBulkScheduling,
              disabled: isSaving || 
                        queuedCollection === 'placeholder' || 
                        !dropDateString || 
                        !dropTime || 
                        !dropDuration || 
                        queuedProductsData.length === 0 // Also disable if no products are loaded
          },
          {
            // --- NEW Append Button ---
            content: "Append New Products",
            onAction: handleAppendDrops,
            loading: isAppending,
            disabled: isSaving || 
                      isBulkScheduling || // Disable if other actions are running
                      queuedCollection === 'placeholder' || 
                      !dropDuration || // Keep UI check for duration
                      queuedProductsData.length === 0 // Disable if no products loaded in UI
          }
      ]}
    >
        <Layout>
            {/* --- Settings Section (Following Example Layout) --- */}
            {/* Restore first Layout.Section */}
            <Layout.Section>
              <BlockStack gap={{ xs: "800", sm: "400" }}>
                  {/* Collections Settings Group */}
                  <InlineGrid columns={{ xs: "1fr", md: "2fr 5fr" }} gap="400">
                      <Box
                          as="section"
                          paddingInlineStart={{ xs: 400, sm: 0 }}
                          paddingInlineEnd={{ xs: 400, sm: 0 }}
                      >
                          <BlockStack gap="400">
                          <Text as="h3" variant="headingMd">
                              Collections
                          </Text>
                          <Text as="p" variant="bodyMd" tone="subdued">
                              Select the collections to use for each drop stage.
                          </Text>
                          </BlockStack>
                      </Box>
                      <Card roundedAbove="sm">
                          <BlockStack gap="400">
                              <Select
                                  label="Queued Products Collection"
                                  options={collectionOptions}
                                  onChange={setQueuedCollection}
                                  value={queuedCollection}
                                  disabled={allCollections.length === 0}
                              />
                              {/* <Select
                                  label="Active Product Collection"
                                  options={collectionOptions}
                                  onChange={setActiveCollection}
                                  value={activeCollection}
                                  disabled={allCollections.length === 0}
                              /> */}
                              {/* <Select
                                  label="Completed Products Collection"
                                  options={collectionOptions}
                                  onChange={setCompletedCollection}
                                  value={completedCollection}
                                  disabled={allCollections.length === 0}
                              /> */}
                          </BlockStack>
                      </Card>
                  </InlineGrid>

                  {/* Divider */} 
                  {smUp ? <Divider /> : null}

                   {/* Drop Schedule Settings Group */}
                  <InlineGrid columns={{ xs: "1fr", md: "2fr 5fr" }} gap="400">
                      <Box
                          as="section"
                          paddingInlineStart={{ xs: 400, sm: 0 }}
                          paddingInlineEnd={{ xs: 400, sm: 0 }}
                      >
                          <BlockStack gap="400">
                          <Text as="h3" variant="headingMd">
                              Drop Schedule
                          </Text>
                          <Text as="p" variant="bodyMd" tone="subdued">
                              Set the date, time, and duration for the drops.
                          </Text>
                          </BlockStack>
                      </Box>
                      <Card roundedAbove="sm">
                          <BlockStack gap="400">
                              <TextField
                                  label="Date"
                                  type="date" 
                                  value={dropDateString} 
                                  onChange={setDropDateString}
                                  autoComplete="off"
                              />
                              <TextField
                                  label="Time (HH:MM)" 
                                  value={dropTime}
                                  onChange={setDropTime}
                                  placeholder="Enter time (HH:MM)"
                                  autoComplete="off"
                              />
                              <TextField
                                  label="Duration (mins)"
                                  value={dropDuration}
                                  onChange={setDropDuration}
                                  placeholder="Enter duration in minutes"
                                  type="number"
                                  autoComplete="off"
                              />
                           </BlockStack>
                      </Card>
                  </InlineGrid>
              </BlockStack>
            </Layout.Section>
            

            {/* --- Active/Queued/Completed Sections (Temporarily Commented Out) --- */}
             
            <Layout.Section>
              <BlockStack gap="400">
                {/* Active Product - Updated Section */}
                <LegacyCard title="Active Product">
                  <LegacyCard.Section>
                    {isFetchingActiveDrop ? (
                       <Spinner accessibilityLabel="Loading active product..." size="small" /> 
                    ) : (
                      <DataTable
                        columnContentTypes={[
                          'text', // Thumbnail
                          'text', // Title
                          'text', // Start Date
                          'text', // Start Time
                          'text'  // End Time
                        ]}
                        headings={[
                          'Product Image',
                          'Product Title',
                          'Start Date',
                          'Start Time',
                          'End Time'
                        ]}
                        rows={activeDropData ? [
                          [
                            <Thumbnail
                                source={activeDropData.thumbnail_url || 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_medium.png?format=webp&v=1530129081'}
                                alt={activeDropData.title || 'Active product'}
                                size="small"
                            />,
                            activeDropData.title || 'N/A',
                            activeDropData.start_time ? new Date(activeDropData.start_time).toLocaleDateString() : '-',
                            activeDropData.start_time ? new Date(activeDropData.start_time).toLocaleTimeString([], { hour: '2-digit', minute:'2-digit' }) : '-',
                            activeDropData.end_time ? new Date(activeDropData.end_time).toLocaleTimeString([], { hour: '2-digit', minute:'2-digit' }) : '-'
                          ]
                        ] : [[<Text tone="subdued" alignment="center" as="span" key="no-active">No active product</Text>, '', '', '', '']]}
                        // Hide footer if there's no active product to avoid empty footer
                        hideScrollIndicator={!activeDropData}
                      />
                    )}
                  </LegacyCard.Section>
                </LegacyCard>

                {/* Queued Products (Available to Schedule) - Remove Action Button */}
                <LegacyCard title="Queued Products (Available to Schedule)">
                    {isFetchingQueuedProducts ? (
                       <LegacyCard.Section>
                           <Spinner accessibilityLabel="Loading queued products..." size="small" />
                       </LegacyCard.Section>
                    ) : (
                       <IndexTable
                         resourceName={{
                           singular: 'available product',
                           plural: 'available products',
                         }}
                         itemCount={queuedProductsData.length}
                         // No selection needed for this table currently
                         headings={[
                           { title: 'Product Image' },
                           { title: 'Product Title' },
                         ]}
                         // No promoted actions needed
                         emptyState={ // Optional: Better empty state
                            <Box paddingBlock="2000" paddingInline="2000" style={{ textAlign: 'center' }}>
                                <Text as="p" tone="subdued">
                                    {queuedCollection === 'placeholder' ? 'Select a collection above to see available products.' : 'No products found in selected collection.'}
                                </Text>
                            </Box>
                         }
                       >
                         {queuedProductsRowMarkup}
                       </IndexTable>
                    )}
                </LegacyCard>
                {/* --- END MOVED Queued Products --- */}

                {/* --- NEW: Scheduled Drops (using IndexTable) --- */}
                <LegacyCard title="Scheduled Drops (Upcoming)">
                    {isFetchingScheduledDrops ? (
                        <LegacyCard.Section> {/* Keep section for spinner */}
                          <Spinner accessibilityLabel="Loading scheduled drops..." size="small" />
                        </LegacyCard.Section>
                    ) : (
                        <IndexTable
                            resourceName={{
                                singular: 'scheduled drop',
                                plural: 'scheduled drops',
                            }}
                            itemCount={scheduledDropsData.length}
                            selectedItemsCount={
                                allResourcesSelected ? 'All' : selectedResources.length
                            }
                            onSelectionChange={handleSelectionChange}
                            promotedBulkActions={promotedBulkActions} // <-- Add bulk actions here
                            headings={[
                                { title: 'Image' },
                                { title: 'Title' },
                                { title: 'Starts' },
                                { title: 'Starts At' },
                                { title: 'Ends At' },
                                { title: 'Status' }, // <-- Add Status heading
                            ]}
                            emptyState={ // Optional: Better empty state
                                <Box paddingBlock="2000" paddingInline="2000" style={{ textAlign: 'center' }}>
                                    <Text as="p" tone="subdued">
                                        No drops currently scheduled.
                                    </Text>
                                </Box>
                            }
                            // loading={isFetchingScheduledDrops} // Can use table loading state
                        >
                            {scheduledDropsRowMarkup}
                        </IndexTable>
                    )}
                    {/* --- Add Pagination --- */}
                    {scheduledTotalCount > 0 && (
                       <Box paddingBlockStart="400" paddingInlineStart="200" paddingInlineEnd="200">
                           <Pagination
                               hasPrevious={scheduledPage > 1}
                               onPrevious={() => {
                                   const newPage = scheduledPage - 1;
                                   fetchScheduledDrops(newPage, rowsPerPage);
                               }}
                               hasNext={scheduledPage * rowsPerPage < scheduledTotalCount}
                               onNext={() => {
                                   const newPage = scheduledPage + 1;
                                   fetchScheduledDrops(newPage, rowsPerPage);
                               }}
                               label={`Page ${scheduledPage} of ${Math.ceil(scheduledTotalCount / rowsPerPage)}`}
                           />
                        </Box>
                    )}
                    {/* --- End Pagination --- */}
                </LegacyCard>
                {/* --- END NEW Scheduled Drops --- */}

                {/* Completed Products - Updated */} 
                <LegacyCard title="Completed Products">
                  <LegacyCard.Section>
                    {isFetchingCompletedDrops ? (
                      <Spinner accessibilityLabel="Loading completed products..." size="small" />
                    ) : (
                      <DataTable
                        columnContentTypes={[
                          'text', // Thumbnail
                          'text', // Title
                          'text', // Start Date
                          'text', // Start Time
                          'text'  // End Time
                        ]}
                        headings={[
                          'Product Image',
                          'Product Title',
                          'Start Date',
                          'Start Time',
                          'End Time'
                        ]}
                        rows={completedDropsData.map(drop => {
                          // Format dates/times as needed
                          const startDate = drop.start_time ? new Date(drop.start_time).toLocaleDateString() : '-';
                          const startTime = drop.start_time ? new Date(drop.start_time).toLocaleTimeString([], { hour: '2-digit', minute:'2-digit', hour12: true }) : '-';
                          const endTime = drop.end_time ? new Date(drop.end_time).toLocaleTimeString([], { hour: '2-digit', minute:'2-digit', hour12: true }) : '-';

                          return [
                            <Thumbnail
                                source={drop.thumbnail_url || 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_medium.png?format=webp&v=1530129081'}
                                alt={drop.title || 'Completed product'}
                                size="small"
                                key={`${drop.id}-thumb`}
                            />,
                            drop.title || 'N/A',
                            startDate,
                            startTime,
                            endTime
                          ];
                        })}
                        footerContent={completedDropsData.length === 0 ? 'No completed drops found.' : `Showing last ${completedDropsData.length} completed drops.`}
                        hideScrollIndicator={completedDropsData.length === 0}
                      />
                    )}
                  </LegacyCard.Section>
                  {/* --- Add Pagination --- */}
                  {completedTotalCount > 0 && (
                     <Box paddingBlockStart="400" paddingInlineStart="200" paddingInlineEnd="200">
                         <Pagination
                             hasPrevious={completedPage > 1}
                             onPrevious={() => {
                                 const newPage = completedPage - 1;
                                 fetchCompletedDrops(newPage, rowsPerPage);
                             }}
                             hasNext={completedPage * rowsPerPage < completedTotalCount}
                             onNext={() => {
                                 const newPage = completedPage + 1;
                                 fetchCompletedDrops(newPage, rowsPerPage);
                             }}
                             label={`Page ${completedPage} of ${Math.ceil(completedTotalCount / rowsPerPage)}`}
                         />
                      </Box>
                  )}
                  {/* --- End Pagination --- */}
                </LegacyCard>
              </BlockStack>

              {/* Add Footer Section for spacing and copyright */}
              <Box paddingBlockStart="400" paddingBlockEnd="400"> {/* Add padding top and bottom */}
                <Text as="p" variant="bodySm" tone="subdued" alignment="center">
                  © {new Date().getFullYear()} Daily Drop Manager. All rights reserved.
                </Text>
              </Box>

            </Layout.Section>
                          
        </Layout>
    </Page>
  );

  // *** ADD LOGGING HERE ***
  console.log('[App.jsx Render Check]', {
    isLoading,
    isAuthenticated,
    activeDropData, // Log the current active drop state
    scheduledDropsDataLength: scheduledDropsData?.length, // Log length of scheduled drops
    // You could log the full scheduledDropsData array too, but length is often enough for initial check
    // scheduledDropsData, 
  });
  // *** END LOGGING ***

  // Main App Render
  return (
    <AppProvider i18n={enTranslations}>
      <Frame>{/* Ensure Frame wraps Page for Toast context */}
         {pageContent}
         {toastMarkup}
      </Frame>
    </AppProvider>
  );
}

export default App;