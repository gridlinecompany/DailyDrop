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
  const [activeCollection, setActiveCollection] = useState('placeholder');
  const [completedCollection, setCompletedCollection] = useState('placeholder');
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
  const fetchScheduledDrops = useCallback(async () => {
      const shop = getShop();
      if (!shop || !sessionToken || !isAuthenticated) return; // Need token/auth

      console.log('[App.jsx Scheduled] Refetching scheduled drops...');
      setIsFetchingScheduledDrops(true);
      try {
          const response = await fetch(`/api/drops/queued?shop=${encodeURIComponent(shop)}`, {
              headers: { 'Authorization': `Bearer ${sessionToken}` }
          });
          if (!response.ok) throw new Error(`Scheduled drops refetch failed: ${response.status}`);
          const data = await response.json();
          setScheduledDropsData(data || []);
      } catch (error) {
          console.error('[App.jsx Scheduled] Error refetching scheduled drops:', error);
          showToast('Error loading scheduled drops.', true); 
          setScheduledDropsData([]); // Clear on error
      } finally {
          setIsFetchingScheduledDrops(false);
      }
  }, [sessionToken, isAuthenticated, showToast]); // Dependencies for the fetch function

  // --- NEW: Callback to delete selected queued drops ---
  const handleDeleteSelectedDrops = useCallback(async (selectedIds) => { // Accepts selected IDs
      const shop = getShop();
      if (!shop || !sessionToken || !isAuthenticated) {
          showToast('Authentication error. Cannot delete drops.', true);
          return;
      }
      if (!selectedIds || selectedIds.length === 0) {
          showToast('No drops selected to delete.', true);
          return;
      }

      console.log(`[App.jsx Delete] Attempting to delete ${selectedIds.length} drops:`, selectedIds);
      setIsDeleting(true);

      try {
          const response = await fetch(`/api/drops?shop=${encodeURIComponent(shop)}`, {
              method: 'DELETE',
              headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${sessionToken}`,
              },
              body: JSON.stringify({ dropIds: selectedIds }),
          });

          const result = await response.json(); // Try parsing JSON

          if (!response.ok) {
              throw new Error(result.error || `HTTP error! status: ${response.status}`);
          }

          console.log('[App.jsx Delete] Drops deleted successfully:', result);
          showToast(result.message || `${result.deleted_count || 0} queued drops deleted successfully!`);

          // Refetch scheduled drops to update the list AND clear selection
          fetchScheduledDrops(); 
          // Selection state is managed by useIndexResourceState, refetching data should reset it if items disappear

      } catch (error) {
          console.error('[App.jsx Delete] Error deleting drops:', error);
          showToast(`Error deleting drops: ${error.message}`, true);
      } finally {
          setIsDeleting(false);
      }
  }, [sessionToken, isAuthenticated, showToast, fetchScheduledDrops]); // Dependencies

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
          Promise.all([
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
            // Fetch Queued Drops <-- NEW
            fetch(`/api/drops/queued?shop=${encodeURIComponent(shop)}`, { headers: { 'Authorization': `Bearer ${currentToken}` } }).then(res => {
              if (!res.ok) throw new Error(`Queued drops fetch failed: ${res.status}`);
              return res.json(); // Should return an array
            }),
            // Fetch Active Drop
            fetch(`/api/drops/active?shop=${encodeURIComponent(shop)}`, { headers: { 'Authorization': `Bearer ${currentToken}` } }).then(res => {
              if (!res.ok) throw new Error(`Active drop fetch failed: ${res.status}`);
              return res.json();
            }),
            // Fetch Completed Drops
            fetch(`/api/drops/completed?shop=${encodeURIComponent(shop)}&limit=10`, { headers: { 'Authorization': `Bearer ${currentToken}` } }).then(res => {
              if (!res.ok) throw new Error(`Completed drops fetch failed: ${res.status}`);
              return res.json();
            })
          ])
          .then(([collectionsData, settingsData, queuedDrops, activeDrop, completedDrops]) => {
              console.log('[App.jsx Init] Fetched Collections:', collectionsData);
              setAllCollections(collectionsData || []);
              
              console.log('[App.jsx Init] Fetched Settings:', settingsData);
              setQueuedCollection(settingsData?.queued_collection_id || 'placeholder');
              setActiveCollection(settingsData?.active_collection_id || 'placeholder');
              setCompletedCollection(settingsData?.completed_collection_id || 'placeholder');
              setDropTime(settingsData?.drop_time || '10:00');
              setDropDuration(String(settingsData?.default_drop_duration_minutes || '60')); // <-- Set duration from settings
              setDropDateString(settingsData?.default_drop_date || ''); // <-- Set date from settings
              
              console.log('[App.jsx Init] Fetched Queued Drops:', queuedDrops);
              setScheduledDropsData(queuedDrops || []);

              console.log('[App.jsx Init] Fetched Active Drop:', activeDrop);
              setActiveDropData(activeDrop);

              console.log('[App.jsx Init] Fetched Completed Drops:', completedDrops);
              setCompletedDropsData(completedDrops || []);

          })
          .catch(error => {
              console.error('[App.jsx Init] Error fetching initial data (Collections, Settings, Queued, Active, or Completed Drops):', error);
              showToast(`Error loading initial app data: ${error.message}`, true);
              // Reset states on error
              setAllCollections([]);
              setQueuedCollection('placeholder');
              setActiveCollection('placeholder');
              setCompletedCollection('placeholder');
              setDropTime('10:00');
              setDropDuration('60');
              setDropDateString(''); // <-- Reset date string on error
              setScheduledDropsData([]);
              setActiveDropData(null);
              setCompletedDropsData([]);
          })
          .finally(() => {
              setIsLoading(false);
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

  // --- Effect to fetch Queued Products when collection changes ---
  useEffect(() => {
    const shop = getShop();
    // Ensure we have a valid collection selected (not placeholder) and a token
    if (queuedCollection && queuedCollection !== 'placeholder' && sessionToken && shop && isAuthenticated) {
      console.log(`[App.jsx Queued] Fetching products for collection ID: ${queuedCollection}`);
      setIsFetchingQueuedProducts(true);
      setQueuedProductsData([]); // Clear previous data

      fetch(`/api/products-by-collection?shop=${encodeURIComponent(shop)}&collectionId=${queuedCollection}`, {
        headers: {
          'Authorization': `Bearer ${sessionToken}`,
        },
      })
        .then(response => {
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
          return response.json();
        })
        .then(data => {
          console.log('[App.jsx Queued] Successfully fetched products:', data);
          setQueuedProductsData(data || []); // Ensure data is an array
        })
        .catch(error => {
          console.error('[App.jsx Queued] Error fetching products:', error);
          setQueuedProductsData([]); // Clear data on error
          // TODO: Show error to user (e.g., Banner)
        })
        .finally(() => {
          setIsFetchingQueuedProducts(false);
        });
    } else {
      // If collection is placeholder or auth fails, clear the data
      setQueuedProductsData([]);
    }
  }, [queuedCollection, sessionToken, isAuthenticated]); // Rerun when collection, token or auth status changes

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
        active_collection_id: activeCollection === 'placeholder' ? null : activeCollection,
        completed_collection_id: completedCollection === 'placeholder' ? null : completedCollection,
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
    activeCollection, 
    completedCollection, 
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
      fetchScheduledDrops();
      
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
    fetchScheduledDrops
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
      fetchScheduledDrops();
      
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
    fetchScheduledDrops
  ]);

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
                              <Select
                                  label="Active Product Collection"
                                  options={collectionOptions}
                                  onChange={setActiveCollection}
                                  value={activeCollection}
                                  disabled={allCollections.length === 0}
                              />
                              <Select
                                  label="Completed Products Collection"
                                  options={collectionOptions}
                                  onChange={setCompletedCollection}
                                  value={completedCollection}
                                  disabled={allCollections.length === 0}
                              />
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
                <LegacyCard title="Queued Products (Available to Schedule)" sectioned>
                   {isFetchingQueuedProducts ? (
                      <Spinner accessibilityLabel="Loading queued products..." size="small" />
                   ) : (
                     <DataTable
                      columnContentTypes={[
                        'text', // Thumbnail
                        'text', // Title
                        // Remove placeholder date/time columns
                      ]}
                      headings={[
                        'Product Image',
                        'Product Title',
                        // Remove placeholder date/time headings
                      ]}
                      rows={queuedProductsData.map(product => ([
                          <Thumbnail
                              key={`${product.id}-thumb`}
                              source={product.imageUrl || 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_medium.png?format=webp&v=1530129081'}
                              alt={product.title}
                              size="small"
                          />,
                          product.title,
                          // Remove placeholder data cells
                      ]))}
                      footerContent={queuedProductsData.length === 0 ? 'No products found in selected collection.' : `Total products: ${queuedProductsData.length}`}
                    />
                   )}
                </LegacyCard>

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