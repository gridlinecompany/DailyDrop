import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { io } from 'socket.io-client';
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
  Icon,
  Modal
} from '@shopify/polaris';
import { 
  RefreshIcon,
  DeleteIcon
} from '@shopify/polaris-icons';
import enTranslations from "@shopify/polaris/locales/en.json";
import '@shopify/polaris/build/esm/styles.css';
// import './index.css'; // Assuming you might have base styles - Comment out if not present

// --- Define Backend URL --- 
const backendBaseUrl = import.meta.env.VITE_BACKEND_URL || ''; // Use env var or empty string for local dev
console.log(`[App.jsx] Using backend base URL: ${backendBaseUrl || '(current origin)'}`);
// ------------------------

// Add the PageMark component outside the App component
function PageMark({ isVisible }) {
  if (!isVisible) return null;
  
  return (
    <div style={{
      position: 'fixed',
      top: '10px',
      right: '10px',
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      backgroundColor: '#008060', // Shopify green
      opacity: 0.8,
      zIndex: 1000,
      transition: 'opacity 0.3s ease-in-out'
    }} />
  );
}

function App() {
  // --- State Variables (Minimal Base) ---
  const [isLoading, setIsLoading] = useState(true);
  const [promptForShop, setPromptForShop] = useState(false);
  const [enteredShop, setEnteredShop] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [sessionToken, setSessionToken] = useState(null); // Store JWT
  const [socket, setSocket] = useState(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [socketError, setSocketError] = useState(null);

  // State for Drop Settings Card
  const [allCollections, setAllCollections] = useState([]);
  const [queuedCollection, setQueuedCollection] = useState('placeholder');
  const [dropDateString, setDropDateString] = useState('');
  const [dropTime, setDropTime] = useState('10:00');
  const [dropDuration, setDropDuration] = useState('60'); // Keep as string for input field

  // State for fetched product data - ensure default values
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
  const [isBulkScheduling, setIsBulkScheduling] = useState(false); 
  const [isAppending, setIsAppending] = useState(false); 
  const [isDeleting, setIsDeleting] = useState(false); 
  const [isClearingCompleted, setIsClearingCompleted] = useState(false);
  
  // --- Confirmation Modal State ---
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);
  const [confirmModalContent, setConfirmModalContent] = useState({
    title: '',
    body: '',
    confirmAction: () => {},
    confirmLabel: '',
    destructive: false
  });

  // --- Pagination State ---
  const [scheduledPage, setScheduledPage] = useState(1);
  const [scheduledTotalCount, setScheduledTotalCount] = useState(0);
  const [completedPage, setCompletedPage] = useState(1);
  const [completedTotalCount, setCompletedTotalCount] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(5); // Default page size

  // Add this right after the rowsPerPage state
  const [forceUpdateKey, setForceUpdateKey] = useState(0);

  // Create refs for fetch functions
  const fetchScheduledDropsRef = useRef(null);
  const fetchCompletedDropsRef = useRef(null);
  const fetchActiveDropRef = useRef(null);
  const fetchQueuedProductsRef = useRef(null);

  const { smUp } = useBreakpoints();

  // --- Generate options for Select components from fetched state ---
  const collectionOptions = useMemo(() => {
    const options = allCollections.map(col => ({ label: col.label, value: col.value }));
    // Add the placeholder option at the beginning
    return [{ label: 'Select a collection', value: 'placeholder' }, ...options];
  }, [allCollections]);

  // --- Utility Functions ---
  const getShop = useCallback(() => new URLSearchParams(window.location.search).get('shop'), []);
  
  // --- Simplified Debouncing Mechanism ---
  const updateWithDebounce = useCallback((action) => {
    setIsUpdating(true);
    action();
    setTimeout(() => setIsUpdating(false), 500);
  }, []);
  
  // --- Toast Utilities (Define Before Use) ---
  const toggleToastActive = useCallback(() => setToastActive((active) => !active), []);

  const showToast = useCallback((message, isError = false) => {
    setToastMessage(message);
    setToastIsError(isError);
    setToastActive(true);
  }, []);

  // Add a visible notification when data is refreshed
  const showRefreshToast = useCallback((dataType) => {
    setToastMessage(`${dataType} refreshed successfully`);
    setToastIsError(false);
    setToastActive(true);
  }, []);

  // Add state for the updating indicator
  const [isUpdating, setIsUpdating] = useState(false);

  // Replace debounced functions with direct updates
  const handleActiveDropUpdate = (data) => {
    setIsUpdating(true);
    setActiveDropData(data || null);
    setIsFetchingActiveDrop(false);
    setForceUpdateKey(prev => prev + 1);
    setTimeout(() => setIsUpdating(false), 500);
  };

  const handleScheduledDropsUpdate = (data) => {
    setIsUpdating(true);
    setScheduledDropsData((data && Array.isArray(data.drops)) ? data.drops : []);
    setScheduledTotalCount((data && typeof data.totalCount === 'number') ? data.totalCount : 0);
    setIsFetchingScheduledDrops(false);
    setForceUpdateKey(prev => prev + 1);
    setTimeout(() => setIsUpdating(false), 500);
  };

  const handleCompletedDropsUpdate = (data) => {
    setIsUpdating(true);
    setCompletedDropsData((data && Array.isArray(data.drops)) ? data.drops : []);
    setCompletedTotalCount((data && typeof data.totalCount === 'number') ? data.totalCount : 0);
    setIsFetchingCompletedDrops(false);
    setForceUpdateKey(prev => prev + 1);
    setTimeout(() => setIsUpdating(false), 500);
  };

  // --- ADDED: Handler for submitting entered shop ---
  const handleShopSubmit = useCallback(() => {
    const trimmedShop = enteredShop.trim();
    // Basic validation - check if it includes .myshopify.com and isn't empty
    if (!trimmedShop || !trimmedShop.includes('.myshopify.com')) {
      showToast('Please enter a valid .myshopify.com domain', true);
      return;
    }
    // Redirect to backend auth route
    console.log(`[App.jsx Shop Prompt] Redirecting to auth for shop: ${trimmedShop}`);
    window.location.href = `${backendBaseUrl}/auth?shop=${encodeURIComponent(trimmedShop)}`;
  }, [enteredShop, showToast]); // Add backendBaseUrl if needed, but it's top-level scope
  // --- END ADDED HANDLER ---

  // --- WebSocket-based fetch functions (define before use) ---
  const setupSocketFunctions = useCallback((socketInstance) => {
    if (!socketInstance) return;
    
    const fetchCollections = () => {
      console.log('[App.jsx WebSocket] Requesting collections');
      socketInstance.emit('get_collections');
    };
    
    const fetchSettings = () => {
      console.log('[App.jsx WebSocket] Requesting settings');
      socketInstance.emit('get_settings');
    };
    
    const fetchScheduledDrops = (page, limit) => {
      console.log(`[App.jsx WebSocket] Requesting scheduled drops page ${page}, limit ${limit}`);
      setIsFetchingScheduledDrops(true);
      setScheduledPage(page);
      socketInstance.emit('get_scheduled_drops', { page, limit });
    };
    
    const fetchCompletedDrops = (page, limit) => {
      console.log(`[App.jsx WebSocket] Requesting completed drops page ${page}, limit ${limit}`);
      setIsFetchingCompletedDrops(true);
      setCompletedPage(page);
      socketInstance.emit('get_completed_drops', { page, limit });
    };
    
    const fetchActiveDrop = () => {
      console.log('[App.jsx WebSocket] Requesting active drop');
      setIsFetchingActiveDrop(true);
      socketInstance.emit('get_active_drop');
    };
    
    const fetchQueuedProducts = (collectionId) => {
      if (!collectionId || collectionId === 'placeholder') return;
      console.log(`[App.jsx WebSocket] Requesting queued products for collection ${collectionId}`);
      setIsFetchingQueuedProducts(true);
      socketInstance.emit('get_queued_products', collectionId);
    };
    
    // Store fetch functions in refs so they can be accessed in render
    fetchScheduledDropsRef.current = fetchScheduledDrops;
    fetchCompletedDropsRef.current = fetchCompletedDrops;
    fetchActiveDropRef.current = fetchActiveDrop;
    fetchQueuedProductsRef.current = fetchQueuedProducts;
    
    return {
      fetchCollections,
      fetchSettings,
      fetchScheduledDrops,
      fetchCompletedDrops,
      fetchActiveDrop,
      fetchQueuedProducts
    };
  }, [
    setIsFetchingScheduledDrops, 
    setScheduledPage, 
    setIsFetchingCompletedDrops, 
    setCompletedPage, 
    setIsFetchingActiveDrop, 
    setIsFetchingQueuedProducts
  ]);

  // --- Authentication Effect ---
  useEffect(() => {
    console.log('[App.jsx Base] Auth useEffect triggered.');
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    const shop = getShop();

    if (!shop) {
      console.log('[App.jsx Base] Shop parameter missing. Prompting user.');
      setPromptForShop(true);
      setIsLoading(false); // Stop loading to show the prompt
      return; // Don't proceed further in this effect run
    }

    // If shop exists, ensure we are not prompting
    setPromptForShop(false); 

    if (urlToken) {
      console.log('[App.jsx Base] Found token in URL.');
      setSessionToken(urlToken);
      params.delete('token');
      window.history.replaceState({}, document.title, `${window.location.pathname}?${params.toString()}`);
    } else if (!sessionToken) {
      console.log('[App.jsx Base] No token found. Redirecting to auth.');
      window.location.href = `${backendBaseUrl}/auth?shop=${encodeURIComponent(shop)}`;
      return;
    }

    const currentToken = sessionToken || urlToken;
    if (!currentToken) {
      console.error('[App.jsx Base] Token check inconsistency. Redirecting.');
      window.location.href = `${backendBaseUrl}/auth?shop=${encodeURIComponent(shop)}`;
      return;
    }

    console.log('[App.jsx Base] Verifying session...');
    const verificationHeaders = {
      'Authorization': `Bearer ${currentToken}`,
    };
    console.log('[App.jsx Base] Token being sent:', currentToken);
    console.log('[App.jsx Base] Headers being sent:', verificationHeaders);
    fetch(`${backendBaseUrl}/api/verify-session?shop=${encodeURIComponent(shop)}`, {
      headers: verificationHeaders,
    })
      .then(response => {
        console.log('[App.jsx Base] Verification response status:', response.status);
        if (response.ok) {
          setIsAuthenticated(true);
          setSessionToken(currentToken);
          console.log('[App.jsx Base] Session verified.');
          
          // Set loading state to true but let the WebSocket handle completing it
          setIsLoading(true);

          // We'll initialize the WebSocket and let it handle all data loading instead of HTTP fetches
        } else {
          setIsAuthenticated(false);
          console.error('[App.jsx Base] Session verification failed. Status:', response.status);
          setSessionToken(null);
          window.location.href = `${backendBaseUrl}/auth?shop=${encodeURIComponent(shop)}`;
          setIsLoading(false);
        }
      })
      .catch((error) => {
        console.error('[App.jsx Base] Error during verification fetch:', error);
        setIsAuthenticated(false);
        setSessionToken(null);
        setIsLoading(false);
      });

  }, [sessionToken, getShop, showToast]);

  // --- WebSocket Connection Effect ---
  useEffect(() => {
    if (!isAuthenticated || !sessionToken) return;
    
    console.log('[App.jsx WebSocket] Setting up WebSocket connection...');
    
    // --- ADDED LOGGING ---
    const shopDomain = getShop(); // Assuming getShop() returns the current shop identifier
    const apiToken = sessionToken; // Assuming sessionToken holds the auth token
    console.log(`[App.jsx WebSocket] Initializing with auth: shop=${shopDomain}, token=${apiToken ? 'Exists' : 'MISSING!'}`);
    // --- END ADDED LOGGING ---
    
    const socketInstance = io(backendBaseUrl, {
      auth: {
        token: sessionToken,
        shop: getShop()
      },
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000
    });
    
    // Set up ping interval to keep connection alive
    const pingInterval = setInterval(() => {
      if (socketInstance.connected) {
        console.log('[App.jsx WebSocket] Sending ping to server');
        socketInstance.emit('ping_server', (response) => {
          console.log('[App.jsx WebSocket] Received ping response:', response);
        });
      }
    }, 50000); // Ping every 50 seconds
    
    // Create a signal flag for forcing data refresh
    let needsRefresh = false;
    
    // --- Define all event handlers ---
    
    // Connection handlers
    const handleConnect = () => {
      console.log('[App.jsx WebSocket] Connected successfully');
      setSocketConnected(true);
      setSocketError(null);
      
      // Explicitly join shop room on connection
      socketInstance.emit('join_shop_room');
      
      // Request data on connect with staggered requests
      setTimeout(() => {
        if (fetchActiveDropRef.current) {
          console.log('[App.jsx WebSocket] Auto-requesting active drop on connect');
          fetchActiveDropRef.current();
        }
      }, 0);
      
      setTimeout(() => {
        if (fetchScheduledDropsRef.current) {
          console.log('[App.jsx WebSocket] Auto-requesting scheduled drops on connect');
          fetchScheduledDropsRef.current(scheduledPage, rowsPerPage);
        }
      }, 300);
      
      setTimeout(() => {
        if (fetchCompletedDropsRef.current) {
          console.log('[App.jsx WebSocket] Auto-requesting completed drops on connect');
          fetchCompletedDropsRef.current(completedPage, rowsPerPage);
        }
      }, 600);
    };
    
    const handleConnectError = (error) => {
      console.error('[App.jsx WebSocket] Connection error:', error.message);
      setSocketConnected(false);
      setSocketError(error.message);
      showToast(`Connection error: ${error.message}. Trying to reconnect...`, true);
      
      // Mark that we need a refresh when we reconnect
      needsRefresh = true;
    };
    
    const handleDisconnect = (reason) => {
      console.log('[App.jsx WebSocket] Disconnected:', reason);
      setSocketConnected(false);
      
      // Mark that we need a refresh when we reconnect
      needsRefresh = true;
      
      if (reason === 'io server disconnect') {
        // Server disconnected us, need to reconnect manually
        console.log('[App.jsx WebSocket] Server disconnected us, reconnecting manually...');
        socketInstance.connect();
      }
    };
    
    // Data handlers
    const handleActiveDrop = (data) => {
      console.log('[App.jsx WebSocket] Received active drop update:', data);
      handleActiveDropUpdate(data);
    };
    
    const handleScheduledDrops = (data) => {
      console.log('[App.jsx WebSocket] Received scheduled drops update:', data);
      handleScheduledDropsUpdate(data);
    };
    
    const handleCompletedDrops = (data) => {
      console.log('[App.jsx WebSocket] Received completed drops update:', data);
      handleCompletedDropsUpdate(data);
    };
    
    const handleQueuedProducts = (data) => {
      console.log('[App.jsx WebSocket] Received queued products update:', data);
      setQueuedProductsData(Array.isArray(data) ? data : []);
      setIsFetchingQueuedProducts(false);
    };
    
    const handleCollections = (data) => {
      console.log('[App.jsx WebSocket] Received collections update:', data);
      setAllCollections(Array.isArray(data) ? data : []);
    };
    
    const handleSettings = (data) => {
      console.log('[App.jsx WebSocket] Received settings update:', data);
      if (data) {
        setQueuedCollection(data.queued_collection_id || 'placeholder');
        const newDropTime = data.drop_time || '10:00';
        setDropTime(newDropTime);
        setDropDuration(String(data.default_drop_duration_minutes || '60')); 
        setDropDateString(data.default_drop_date || '');

        // --- ADDED: Log state in next tick ---
        setTimeout(() => {
          // Note: This will log the value of dropTime from the *next render* closure,
          // so we read it directly from a ref or a new state variable if we wanted to be 100% sure
          // of the immediate post-set value. However, for debugging if the update is happening at all,
          // logging the new value directly is a good indicator.
          console.log(`[App.jsx WebSocket] handleSettings: dropTime should be '${newDropTime}' after update.`);
        }, 0);
        // --- END ADDED ---
      }
    };
    
    const handleRefreshNeeded = (data) => {
      if (!data || !data.target) return;
      
      console.log('[App.jsx WebSocket] Received refresh instruction:', data);
      
      // Add a small delay before processing to debounce multiple refresh requests
      setTimeout(() => {
        if (data.target === 'all') {
          console.log('[App.jsx WebSocket] Performing full refresh of all data');
          
          // Show the updating indicator
          setIsUpdating(true);
          
          // Stagger requests to avoid overwhelming the server
          setTimeout(() => {
            if (fetchActiveDropRef.current) {
              fetchActiveDropRef.current();
            }
          }, 0);
          
          setTimeout(() => {
            if (fetchScheduledDropsRef.current) {
              fetchScheduledDropsRef.current(scheduledPage, rowsPerPage);
            }
          }, 300);
          
          setTimeout(() => {
            if (fetchCompletedDropsRef.current) {
              fetchCompletedDropsRef.current(completedPage, rowsPerPage);
            }
            
            // Force UI update and hide indicator after all requests
            setTimeout(() => {
              setForceUpdateKey(prev => prev + 1);
              setIsUpdating(false);
            }, 500);
          }, 600);
        }
        else if (data.target === 'active_drop' && fetchActiveDropRef.current) {
          console.log('[App.jsx WebSocket] Auto-refreshing active drop');
          setIsUpdating(true);
          fetchActiveDropRef.current();
          if (data.reason) {
            showToast(`Active drop status changed: ${data.reason}`);
          }
          setTimeout(() => setIsUpdating(false), 1000);
        }
        else if (data.target === 'scheduled_drops' && fetchScheduledDropsRef.current) {
          console.log('[App.jsx WebSocket] Auto-refreshing scheduled drops');
          setIsUpdating(true);
          fetchScheduledDropsRef.current(scheduledPage, rowsPerPage);
          setTimeout(() => setIsUpdating(false), 1000);
        }
        else if (data.target === 'completed_drops' && fetchCompletedDropsRef.current) {
          console.log('[App.jsx WebSocket] Auto-refreshing completed drops');
          setIsUpdating(true);
          fetchCompletedDropsRef.current(completedPage, rowsPerPage);
          setTimeout(() => setIsUpdating(false), 1000);
        }
      }, 200);
    };
    
    const handleStatusChange = (data) => {
      if (!data || !data.type) return;
      
      if (data.type === 'activated') {
        console.log('[App.jsx WebSocket] Received automatic activation:', data);
        showToast(`Product "${data.title || 'Unknown'}" has been activated automatically`);
        
        // Refresh data by fetching it, not by passing the status data
        setIsUpdating(true);
        
        if (fetchActiveDropRef.current) {
          fetchActiveDropRef.current();
        }
        
        if (fetchScheduledDropsRef.current) {
          fetchScheduledDropsRef.current(scheduledPage, rowsPerPage);
        }
        
        // Set a timer to hide the updating indicator
        setTimeout(() => setIsUpdating(false), 1000);
      } 
      else if (data.type === 'completed') {
        console.log('[App.jsx WebSocket] Received automatic completion:', data);
        showToast(`Product "${data.title || 'Unknown'}" has completed its drop period`);
        
        // Refresh all data by fetching it
        setIsUpdating(true);
        
        if (fetchActiveDropRef.current) {
          fetchActiveDropRef.current();
        }
        
        if (fetchScheduledDropsRef.current) {
          fetchScheduledDropsRef.current(scheduledPage, rowsPerPage);
        }
        
        if (fetchCompletedDropsRef.current) {
          fetchCompletedDropsRef.current(completedPage, rowsPerPage);
        }
        
        // Set a timer to hide the updating indicator
        setTimeout(() => setIsUpdating(false), 1000);
      }
    };

    // Register all event handlers
    socketInstance.on('connect', handleConnect);
    socketInstance.on('connect_error', handleConnectError);
    socketInstance.on('disconnect', handleDisconnect);
    socketInstance.on('active_drop', handleActiveDrop);
    socketInstance.on('scheduled_drops', handleScheduledDrops);
    socketInstance.on('completed_drops', handleCompletedDrops);
    socketInstance.on('queued_products', handleQueuedProducts);
    socketInstance.on('collections', handleCollections);
    socketInstance.on('settings', handleSettings);
    socketInstance.on('refresh_needed', handleRefreshNeeded);
    socketInstance.on('status_change', handleStatusChange);
    
    // Set socket state
    setSocket(socketInstance);

    // Setup socket functions 
    const socketFunctions = setupSocketFunctions(socketInstance);

    // Initial data load if we have a collection set
    if (queuedCollection && queuedCollection !== 'placeholder' && socketFunctions?.fetchQueuedProducts) {
      socketFunctions.fetchQueuedProducts(queuedCollection);
    }

    // Clean up on unmount
    return () => {
      console.log('[App.jsx WebSocket] Cleaning up WebSocket connection');
      clearInterval(pingInterval);
      
      // Remove all event listeners
      socketInstance.off('connect', handleConnect);
      socketInstance.off('connect_error', handleConnectError);
      socketInstance.off('disconnect', handleDisconnect);
      socketInstance.off('active_drop', handleActiveDrop);
      socketInstance.off('scheduled_drops', handleScheduledDrops);
      socketInstance.off('completed_drops', handleCompletedDrops);
      socketInstance.off('queued_products', handleQueuedProducts);
      socketInstance.off('collections', handleCollections);
      socketInstance.off('settings', handleSettings);
      socketInstance.off('refresh_needed', handleRefreshNeeded);
      socketInstance.off('status_change', handleStatusChange);
      
      if (socketInstance) {
        socketInstance.disconnect();
      }
    };
  }, [isAuthenticated, sessionToken, getShop, showToast, updateWithDebounce, scheduledPage, completedPage, rowsPerPage, queuedCollection, setupSocketFunctions]);

  // --- Effect to fetch initial data once socket is connected ---
  useEffect(() => {
    if (!socket || !socketConnected) return;
    
    console.log('[App.jsx WebSocket] Loading initial data...');
    
    // Stagger requests to avoid overwhelming the server
    const loadInitialData = async () => {
      console.log('[App.jsx WebSocket] Requesting all data types for initial load');
      
      // First fetch collections and settings
      socket.emit('get_collections');
      await new Promise(r => setTimeout(r, 300));
      
      socket.emit('get_settings');
      await new Promise(r => setTimeout(r, 300));
      
      // Always fetch active drop on initial load
      console.log('[App.jsx WebSocket] Requesting active drop');
      socket.emit('get_active_drop');
      await new Promise(r => setTimeout(r, 300));
      
      // Always fetch scheduled drops on initial load
      console.log('[App.jsx WebSocket] Requesting scheduled drops');
      socket.emit('get_scheduled_drops', { page: scheduledPage, limit: rowsPerPage });
      await new Promise(r => setTimeout(r, 300));
      
      // Always fetch completed drops on initial load
      console.log('[App.jsx WebSocket] Requesting completed drops');
      socket.emit('get_completed_drops', { page: completedPage, limit: rowsPerPage });
      
      // Mark loading as complete even if we're still waiting for some data
      setIsLoading(false);
    };
    
    loadInitialData();
  }, [socket, socketConnected, scheduledPage, completedPage, rowsPerPage]);

  // --- Effect to fetch queued products when collection changes ---
  useEffect(() => {
    if (!socket || !socketConnected || !queuedCollection || queuedCollection === 'placeholder') return;
    
    console.log(`[App.jsx WebSocket] Collection changed to ${queuedCollection}, fetching products...`);
    if (fetchQueuedProductsRef.current) {
      fetchQueuedProductsRef.current(queuedCollection);
    }
  }, [socket, socketConnected, queuedCollection]);

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
        drop_time: dropTime,
        default_drop_duration_minutes: parseInt(dropDuration, 10) || 60, // <-- Send duration to settings
        default_drop_date: dropDateString || null // <-- Send date to settings
    };

    console.log('[App.jsx Settings] Saving Settings Payload:', settingsPayload);

    try {
      const response = await fetch(`${backendBaseUrl}/api/settings?shop=${encodeURIComponent(shop)}`, {
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

      // --- ADDED: Explicitly refetch settings via WebSocket ---
      if (socket && socket.connected) {
        console.log('[App.jsx Settings] Save successful, explicitly requesting settings update via WebSocket.');
        socket.emit('get_settings');
      } else {
        console.warn('[App.jsx Settings] Socket not available or not connected, cannot explicitly refetch settings post-save.');
      }
      // --- END ADDED --- 

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
      const response = await fetch(`${backendBaseUrl}/api/drops/schedule-all`, { // <-- Use backendBaseUrl
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
      fetchScheduledDropsRef.current(1, rowsPerPage);
      fetchActiveDropRef.current(); // <-- ADD THIS LINE
      
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
    fetchScheduledDropsRef,
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
      const response = await fetch(`${backendBaseUrl}/api/drops/append`, { // <-- Use backendBaseUrl
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
      fetchScheduledDropsRef.current(1, rowsPerPage);
      fetchActiveDropRef.current(); // <-- ADD THIS LINE
      
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
    fetchScheduledDropsRef,
    rowsPerPage // Add rowsPerPage
  ]);

  // --- NEW: Function to handle deletion of selected drops ---
  const handleDeleteSelectedDrops = useCallback(async (dropIdsToDelete) => {
    if (!dropIdsToDelete || dropIdsToDelete.length === 0) {
      showToast('No drops selected to delete.', true);
      return;
    }

    // --- Open Confirmation Modal --- 
    setConfirmModalContent({
        title: 'Delete Scheduled Drops?',
        body: `Are you sure you want to delete ${dropIdsToDelete.length} selected queued drop(s)? This action cannot be undone.`,
        confirmAction: async () => { // Wrap the actual deletion logic
            setIsConfirmModalOpen(false);
            setIsDeleting(true);
            console.log('[App.jsx Delete] Deleting drop IDs:', dropIdsToDelete);
            const shop = getShop(); // Get shop inside confirmAction
            try {
                const response = await fetch(`${backendBaseUrl}/api/drops?shop=${encodeURIComponent(shop)}`, {
                    method: 'DELETE',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${sessionToken}`,
                    },
                    body: JSON.stringify({ drop_ids: dropIdsToDelete }),
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || `HTTP error! status: ${response.status}`);
                console.log('[App.jsx Delete] Drops deleted successfully:', result);
                fetchScheduledDropsRef.current(1, rowsPerPage);
            } catch (error) {
                console.error('[App.jsx Delete] Error deleting drops:', error);
                showToast(`Error deleting drops: ${error.message}`, true);
            } finally {
                setIsDeleting(false);
            }
        },
        confirmLabel: 'Delete Drops',
        destructive: true
    });
    setIsConfirmModalOpen(true);
    // --- Actual deletion logic moved inside confirmAction --- 

  }, [sessionToken, isAuthenticated, showToast, fetchScheduledDropsRef, rowsPerPage]);

  // --- NEW: Callback to clear ALL completed drops --- 
  const handleClearCompletedDrops = useCallback(async () => {
    // This function will be called AFTER confirmation
    const shop = getShop();
    if (!shop || !sessionToken || !isAuthenticated) {
      showToast('Authentication error. Cannot clear drops.', true);
      return;
    }

    setIsClearingCompleted(true);
    setIsConfirmModalOpen(false); // Close modal after confirming
    console.log('[App.jsx Clear Completed] Clearing completed drops...');

    try {
      const response = await fetch(`${backendBaseUrl}/api/drops/completed?shop=${encodeURIComponent(shop)}`, { // <-- Use backendBaseUrl
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${sessionToken}`,
        },
      });

      const result = await response.json(); 

      if (!response.ok) {
        throw new Error(result.error || `HTTP error! status: ${response.status}`);
      }

      console.log('[App.jsx Clear Completed] Drops cleared successfully:', result);
      showToast(`${result.deleted_count ?? 0} completed drop(s) cleared successfully!`);

      // Refetch completed drops to update the UI
      fetchCompletedDropsRef.current(1, rowsPerPage); 
      
    } catch (error) {
      console.error('[App.jsx Clear Completed] Error clearing drops:', error);
      showToast(`Error clearing completed drops: ${error.message}`, true);
    } finally {
      setIsClearingCompleted(false); 
    }
  }, [sessionToken, isAuthenticated, showToast, fetchCompletedDropsRef, rowsPerPage]);

  // --- Callback to open confirm modal for clearing completed drops --- 
  const openClearCompletedConfirmModal = useCallback(() => {
    setConfirmModalContent({
      title: 'Clear Completed Drops?',
      body: 'Are you sure you want to clear ALL completed drops? This action cannot be undone.',
      confirmAction: handleClearCompletedDrops, // Point to the clearing function
      confirmLabel: 'Clear Completed',
      destructive: true
    });
    setIsConfirmModalOpen(true);
  }, [handleClearCompletedDrops]);

  // --- Add selection handling for Scheduled Drops IndexTable ---
  const {
      selectedResources,
      allResourcesSelected,
      handleSelectionChange,
  } = useIndexResourceState(scheduledDropsData); // Using just the array without || [] since it's initialized as []

  // --- Define Promoted Bulk Actions for IndexTable ---
  const promotedBulkActions = [
      {
          content: 'Delete selected queued drops',
          onAction: () => handleDeleteSelectedDrops(selectedResources), // Call the function that opens the modal
          disabled: selectedResources.length === 0 || isDeleting, // Keep disabled state
          // Remove loading state from here as it's handled after confirmation
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

  // --- Define Row Markup for Completed Products Table (Add Link) ---
  const completedDropsRowMarkup = completedDropsData.map(drop => {
      const startDate = drop.start_time ? new Date(drop.start_time).toLocaleDateString() : '-';
      const startTime = drop.start_time ? new Date(drop.start_time).toLocaleTimeString([], { hour: '2-digit', minute:'2-digit', hour12: true }) : '-';
      const endTime = drop.end_time ? new Date(drop.end_time).toLocaleTimeString([], { hour: '2-digit', minute:'2-digit', hour12: true }) : '-';
      const productIdNumeric = drop.product_id ? drop.product_id.split('/').pop() : null; // Extract numeric ID
      const productAdminUrl = productIdNumeric ? `/admin/products/${productIdNumeric}` : null;

      return [
          <Thumbnail
              source={drop.thumbnail_url || 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_medium.png?format=webp&v=1530129081'}
              alt={drop.title || 'Completed product'}
              size="small"
              key={`${drop.id}-thumb`}
          />,
          // --- ADD LINK to Product Title --- 
          productAdminUrl ? (
              <a href={productAdminUrl} target="_blank" rel="noopener noreferrer" style={{textDecoration: 'underline', color: 'var(--p-color-text-interactive)'}}>
                  {drop.title || 'N/A'}
              </a>
          ) : (
              drop.title || 'N/A' // Fallback if no ID/URL
          ),
          // --- END LINK ---
          startDate,
          startTime,
          endTime
      ];
  });

  // Update render methods to use the WebSocket ref functions
  const handlePageChange = useCallback((newPage) => {
    if (fetchScheduledDropsRef.current) {
      fetchScheduledDropsRef.current(newPage, rowsPerPage);
    }
  }, [rowsPerPage]);

  const handleCompletedPageChange = useCallback((newPage) => {
    if (fetchCompletedDropsRef.current) {
      fetchCompletedDropsRef.current(newPage, rowsPerPage);
    }
  }, [rowsPerPage]);

  const refreshScheduledDrops = useCallback(() => {
    if (fetchScheduledDropsRef.current) {
      fetchScheduledDropsRef.current(scheduledPage, rowsPerPage);
      showRefreshToast('Scheduled drops');
    }
  }, [scheduledPage, rowsPerPage, showRefreshToast]);

  const refreshCompletedDrops = useCallback(() => {
    if (fetchCompletedDropsRef.current) {
      fetchCompletedDropsRef.current(completedPage, rowsPerPage);
      showRefreshToast('Completed drops');
    }
  }, [completedPage, rowsPerPage, showRefreshToast]);

  const refreshActiveDrop = useCallback(() => {
    if (fetchActiveDropRef.current) {
      fetchActiveDropRef.current();
      showRefreshToast('Active drop');
    }
  }, [showRefreshToast]);

  // --- Error handling and loading timeout ---
  useEffect(() => {
    // Set a maximum loading time to prevent the app from getting stuck
    if (isLoading && socketConnected) {
      const loadingTimeout = setTimeout(() => {
        console.log('[App.jsx] Loading timeout reached, forcing app to render');
        setIsLoading(false);
      }, 5000); // 5 second timeout
      
      return () => clearTimeout(loadingTimeout);
    }
  }, [isLoading, socketConnected]);

  // --- WebSocket error handler effect ---
  useEffect(() => {
    if (socketError && isLoading) {
      console.error('[App.jsx] WebSocket error during loading, rendering app anyway:', socketError);
      setIsLoading(false);
    }
  }, [socketError, isLoading]);

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
  
  // --- ADDED: Render Enter Shop Prompt --- 
  if (promptForShop) {
      return (
          <AppProvider i18n={enTranslations}>
              <Frame>{/* Frame for potential early Toasts */}
                <Page title="Enter Your Shop Domain">
                  <Layout>
                    <Layout.Section>
                      <Card>
                        <BlockStack gap="400">
                          <Text as="p" tone="subdued">
                            Please enter your shop's .myshopify.com domain to connect.
                          </Text>
                          <TextField
                            label="Shop Domain"
                            labelHidden
                            value={enteredShop}
                            onChange={setEnteredShop}
                            placeholder="your-store-name.myshopify.com"
                            autoComplete="off"
                          />
                          <Button variant="primary" onClick={handleShopSubmit}>
                            Continue
                          </Button>
                        </BlockStack>
                      </Card>
                    </Layout.Section>
                  </Layout>
                </Page>
              </Frame>
          </AppProvider>
      );
  }
  // --- END ADDED RENDER --- 

  // Auth Failed State (This might be less likely to show now, but keep for edge cases)
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

  const toastMarkup = toastActive ? (
    <Toast content={toastMessage} onDismiss={toggleToastActive} error={toastIsError} />
  ) : null;

  console.log('[App.jsx Render Check]', {
    isLoading,
    isAuthenticated,
    activeDropData, // Log the current active drop state
    scheduledDropsDataLength: scheduledDropsData?.length, // Log length of scheduled drops
    // You could log the full scheduledDropsData array too, but length is often enough for initial check
    // scheduledDropsData, 
  });

  // *** DEFINE pageContent HERE, before confirmationModalMarkup ***
  const pageContent = (
    <Page 
      title="Daily Drop Manager"
      primaryAction={{ 
          content: "Save Settings", 
          onAction: handleSaveSettings, 
          loading: isSaving, 
          disabled: isBulkScheduling
      }}
      secondaryActions={[
          {
              content: "Schedule All Queued",
              onAction: handleScheduleAllDrops,
              loading: isBulkScheduling,
              disabled: isSaving || 
                        queuedCollection === 'placeholder' || 
                        !dropDateString || 
                        !dropTime || 
                        !dropDuration || 
                        queuedProductsData.length === 0 
          },
          {
            content: "Append New Products",
            onAction: handleAppendDrops,
            loading: isAppending,
            disabled: isSaving || 
                      isBulkScheduling || 
                      queuedCollection === 'placeholder' || 
                      !dropDuration || 
                      queuedProductsData.length === 0 
          }
      ]}
    >
        <Layout>
            {/* --- Settings Section --- */}
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
                          </BlockStack>
                      </Card>
                  </InlineGrid>

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
             
            <Layout.Section>
              <BlockStack gap="400">
                {/* Active Product - ADD Refresh Button */} 
                <LegacyCard 
                  title={isFetchingActiveDrop ? "Active Product (Loading...)" : "Active Product"}
                  actions={[{ 
                    icon: RefreshIcon, 
                    onAction: refreshActiveDrop,
                    accessibilityLabel: 'Refresh Active Drop' 
                  }]}
                >
                  <LegacyCard.Section>
                    {isFetchingActiveDrop ? (
                       <Spinner accessibilityLabel="Loading active product..." size="small" /> 
                    ) : (
                      <DataTable
                        columnContentTypes={[
                          'text',
                          'text', 
                          'text', 
                          'text', 
                          'text'  
                        ]}
                        headings={[
                          'Image',
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
                        hideScrollIndicator={!activeDropData}
                      />
                    )}
                  </LegacyCard.Section>
                </LegacyCard>

                {/* Queued Products (Available to Schedule) */}
                <LegacyCard title={isFetchingQueuedProducts ? "Queued Products (Loading...)" : "Queued Products (Available to Schedule)"}>
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
                      headings={[
                           { title: 'Image' },
                           { title: 'Product Title' },
                         ]}
                         emptyState={ 
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

                {/* Scheduled Drops - ADD Refresh Button & Total Count */} 
                <LegacyCard 
                  title={`Scheduled Drops ${isFetchingScheduledDrops ? "(Loading...)" : `(Total: ${scheduledTotalCount})`}`}
                  actions={[{ 
                      icon: RefreshIcon, 
                      onAction: refreshScheduledDrops,
                      accessibilityLabel: 'Refresh Scheduled Drops'
                  }]}
                >
                    {isFetchingScheduledDrops ? (
                        <LegacyCard.Section> 
                      <Spinner accessibilityLabel="Loading scheduled drops..." size="small" />
                        </LegacyCard.Section>
                    ) : (
                        <IndexTable
                            resourceName={{
                                singular: 'scheduled drop',
                                plural: 'scheduled drops',
                            }}
                            itemCount={scheduledTotalCount}
                            selectedItemsCount={
                                allResourcesSelected ? 'All' : selectedResources.length
                            }
                            onSelectionChange={handleSelectionChange}
                            promotedBulkActions={promotedBulkActions} 
                        headings={[
                                { title: 'Image' },
                                { title: 'Title' },
                                { title: 'Starts' },
                                { title: 'Starts At' },
                                { title: 'Ends At' },
                                { title: 'Status' }, 
                            ]}
                            emptyState={ 
                                <Box paddingBlock="2000" paddingInline="2000" style={{ textAlign: 'center' }}>
                                    <Text as="p" tone="subdued">
                                        No drops currently scheduled.
                                    </Text>
                                </Box>
                            }
                        >
                            {scheduledDropsRowMarkup}
                        </IndexTable>
                    )}
                    {scheduledTotalCount > 0 && (
                       <Box paddingBlockStart="400" paddingInlineStart="200" paddingInlineEnd="200">
                           <Pagination
                               hasPrevious={scheduledPage > 1}
                               onPrevious={() => {
                                   const newPage = scheduledPage - 1;
                                   handlePageChange(newPage);
                               }}
                               hasNext={scheduledPage * rowsPerPage < scheduledTotalCount}
                               onNext={() => {
                                   const newPage = scheduledPage + 1;
                                   handlePageChange(newPage);
                               }}
                               label={`Page ${scheduledPage} of ${Math.ceil(scheduledTotalCount / rowsPerPage)}`}
                           />
                        </Box>
                    )}
                </LegacyCard>

                {/* Completed Products - ADD Refresh & Clear Buttons & Total Count */} 
                <LegacyCard 
                  title={`Completed Drops ${isFetchingCompletedDrops ? "(Loading...)" : `(Total: ${completedTotalCount})`}`}
                  actions={[
                      { 
                          icon: RefreshIcon, 
                          onAction: refreshCompletedDrops,
                          accessibilityLabel: 'Refresh Completed Drops'
                      },
                      {
                          content: 'Clear All Completed', 
                          onAction: openClearCompletedConfirmModal, 
                          destructive: true,
                          disabled: completedTotalCount === 0 || isClearingCompleted,
                          loading: isClearingCompleted
                      }
                  ]}
                >
                  <LegacyCard.Section>
                    {isFetchingCompletedDrops ? (
                      <Spinner accessibilityLabel="Loading completed products..." size="small" />
                    ) : (
                      <DataTable
                        columnContentTypes={[
                          'text', 
                          'text', 
                          'text', 
                          'text', 
                          'text'  
                        ]}
                        headings={[
                          'Image',
                          'Product Title',
                          'Start Date',
                          'Start Time',
                          'End Time'
                        ]}
                        rows={completedDropsRowMarkup} 
                        footerContent={completedDropsData.length === 0 ? 'No completed drops found.' : ``} 
                        hideScrollIndicator={completedDropsData.length === 0}
                      />
                    )}
                  </LegacyCard.Section>
                  {completedTotalCount > 0 && (
                     <Box paddingBlockStart="400" paddingInlineStart="200" paddingInlineEnd="200">
                         <Pagination
                             hasPrevious={completedPage > 1}
                             onPrevious={() => {
                                 const newPage = completedPage - 1;
                                 handleCompletedPageChange(newPage);
                             }}
                             hasNext={completedPage * rowsPerPage < completedTotalCount}
                             onNext={() => {
                                 const newPage = completedPage + 1;
                                 handleCompletedPageChange(newPage);
                             }}
                             label={`Page ${completedPage} of ${Math.ceil(completedTotalCount / rowsPerPage)}`}
                         />
                      </Box>
                  )}
                </LegacyCard>
              </BlockStack>
              <Box paddingBlockStart="400" paddingBlockEnd="400">
                <Text as="p" variant="bodySm" tone="subdued" alignment="center">
                  © {new Date().getFullYear()} Daily Drop Manager. All rights reserved.
                </Text>
              </Box>
            </Layout.Section>
        </Layout>
    </Page>
  );
  // *** END pageContent DEFINITION ***

  const confirmationModalMarkup = (
    <Modal
      open={isConfirmModalOpen}
      onClose={() => setIsConfirmModalOpen(false)}
      title={confirmModalContent.title}
      primaryAction={{
        content: confirmModalContent.confirmLabel,
        onAction: confirmModalContent.confirmAction,
        destructive: confirmModalContent.destructive,
        loading: isDeleting || isClearingCompleted // Show loading on confirm button
      }}
      secondaryActions={[
        {
          content: 'Cancel',
          onAction: () => setIsConfirmModalOpen(false),
          disabled: isDeleting || isClearingCompleted // Disable cancel while loading
        },
      ]}
    >
      <Modal.Section>
        <Text as="p">{confirmModalContent.body}</Text>
      </Modal.Section>
    </Modal>
  );

  // Main App Render
  return (
    <AppProvider i18n={enTranslations}>
      <Frame key={forceUpdateKey}>
        {pageContent}
        {toastMarkup}
        {confirmationModalMarkup}
        <PageMark isVisible={isUpdating} />
      </Frame>
    </AppProvider>
  );
}

export default App;