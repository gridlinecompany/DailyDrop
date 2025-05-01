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
  const [dropDuration, setDropDuration] = useState('60');

  const { smUp } = useBreakpoints(); // <-- Use breakpoints hook

  // --- Generate options for Select components from fetched state ---
  const collectionOptions = useMemo(() => {
    const options = allCollections.map(col => ({ label: col.label, value: col.value }));
    // Add the placeholder option at the beginning
    return [{ label: 'Select a collection', value: 'placeholder' }, ...options];
  }, [allCollections]);

  // --- Utility Functions ---
  const getShop = () => new URLSearchParams(window.location.search).get('shop');

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
    fetch(`/api/verify-session?shop=${encodeURIComponent(shop)}`, {
      headers: {
        'Authorization': `Bearer ${currentToken}`,
      },
    })
      .then(response => {
        console.log('[App.jsx Base] Verification response status:', response.status);
        if (response.ok) {
          setIsAuthenticated(true);
          setSessionToken(currentToken);
          console.log('[App.jsx Base] Session verified.');
          
          // ---> Fetch Collections AFTER session is verified <--- 
          console.log('[App.jsx Settings] Attempting to fetch collections...');
          fetch(`/api/collections?shop=${encodeURIComponent(shop)}`, { // Pass shop param
              headers: { 
                  'Authorization': `Bearer ${currentToken}`, // Send token
              },
          })
          .then(collectionResponse => {
              if (!collectionResponse.ok) {
                  throw new Error(`HTTP error! status: ${collectionResponse.status}`);
              }
              return collectionResponse.json();
          })
          .then(data => {
              console.log('[App.jsx Settings] Successfully fetched collections:', data);
              setAllCollections(data); // Update state with fetched collections
          })
          .catch(error => {
              console.error('[App.jsx Settings] Error fetching collections:', error);
              // TODO: Show error to user? (e.g., using a Banner)
          });
          // ---> End Fetch Collections <---

        } else {
          setIsAuthenticated(false);
          console.error('[App.jsx Base] Session verification failed. Status:', response.status);
          setSessionToken(null);
          window.location.href = `/auth?shop=${encodeURIComponent(shop)}`;
        }
      })
      .catch((error) => {
        console.error('[App.jsx Base] Error during verification fetch:', error);
          setIsAuthenticated(false);
        setSessionToken(null);
      })
      .finally(() => {
        console.log('[App.jsx Base] Verification fetch finished.');
          setIsLoading(false);
      });

  }, [sessionToken]);

  // --- Callbacks for Drop Settings ---
  const handleSaveSettings = () => {
    console.log('Saving Settings:', {
      queuedCollection,
      activeCollection,
      completedCollection,
      dropDateString,
      dropTime,
      dropDuration,
    });
    alert('Save Settings clicked (functionality pending).');
  };

  // --- Render Logic ---

  // Loading State
  if (isLoading) {
    return (
      <AppProvider i18n={enTranslations}>
        <Page>
          <Spinner accessibilityLabel="Loading app data..." size="large" />
    </Page>
      </AppProvider>
    );
  }

  // Auth Failed State
  if (!isAuthenticated) {
    return (
      <AppProvider i18n={enTranslations}>
        <Page>
          <Text variant="headingLg" as="h1" tone='critical'>Authentication Required</Text>
          <p>Please wait while we redirect you or <a href={`/auth?shop=${encodeURIComponent(getShop())}`}>click here to authenticate</a>.</p>
    </Page>
      </AppProvider>
    );
  }

  // --- Authenticated App UI (Settings Layout Example Style) ---
  return (
    <AppProvider i18n={enTranslations}>
      <Page 
        title="Daily Drop Manager"
        primaryAction={{ content: "Save Settings", onAction: handleSaveSettings }}
        // secondaryActions={[{ content: "Cancel", onAction: () => alert('Cancel clicked') }]} // Optional secondary
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
                  {/* Active Product - Added Section */}
                  <LegacyCard title="Active Product">
                    <LegacyCard.Section>
                      <DataTable
                        columnContentTypes={[
                          'text',
                          'text',
                          'numeric',
                          'numeric',
                          'text'
                        ]}
                        headings={[
                          'Product Image',
                          'Product Title',
                          'Start Date',
                          'Start Time',
                          'End Time'
                        ]}
                        rows={[
                          [
                            'https://via.placeholder.com/150',
                            'Space Man T-Shirt',
                            '04/28/2025',
                            '12:00pm',
                            '12:00am'
                          ]
                        ]}
                      />
                    </LegacyCard.Section>
                  </LegacyCard>

                  {/* Queued Products - Standardized to LegacyCard with Section */}
                  <LegacyCard title="Queued Products">
                    <LegacyCard.Section>
                      <DataTable
                        columnContentTypes={[
                          'text',
                          'text',
                          'numeric',
                          'numeric',
                          'text'
                        ]}
                        headings={[
                          'Product Image',
                          'Product Title',
                          'Start Date',
                          'Start Time',
                          'End Time'
                        ]}
                        rows={[
                          [
                            'https://via.placeholder.com/150',
                            'Space Man T-Shirt',
                            '04/29/2025',
                            '12:00am',
                            '12:00pm'
                          ],
                          [
                            'https://via.placeholder.com/150',
                            'Vintage Band Tees',
                            '04/30/2025',
                            '12:00pm',
                            '12:00am'
                          ],
                          [
                            'https://via.placeholder.com/150',
                            'Absract T-Shirt',
                            '05/01/2025',
                            '12:00am',
                            '12:00pm'
                          ],
                        ]}
                      />
                    </LegacyCard.Section>
                  </LegacyCard>

                  {/* Completed Products - Standardized to LegacyCard with Section */}
                  <LegacyCard title="Completed Products">
                    <LegacyCard.Section>
                      <Text as="p" tone="subdued">
                        Completed Product Placeholder.
                      </Text>
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
    </AppProvider>
  );
}

export default App;