import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
// Comment out AppProvider import and usage
// import { AppProvider } from '@shopify/polaris'; 
// import enTranslations from '@shopify/polaris/locales/en.json'; 
//import '@shopify/polaris/build/esm/styles.css'; // Keep styles for now
import './index.css';

// --- Get config from injected window object --- 
const shopifyConfig = window.shopify; // Added by backend server.js

// Basic check for essential parameters from window.shopify
// For non-embedded, we only strictly NEED apiKey and shop from the *initial* load
if (!shopifyConfig || !shopifyConfig.apiKey || !shopifyConfig.shop) {
    console.error('App Initialization Error: Missing initial config from window.shopify.');
    console.error('window.shopify object AT TIME OF CHECK:', window.shopify);
    // Render an error message if configuration is missing
    ReactDOM.createRoot(document.getElementById('root')).render(
        <React.StrictMode>
            <div>Error: App configuration incomplete. Missing API Key or Shop parameter from initial load. Try reinstalling.</div>
        </React.StrictMode>
    );
} else {
    // Log the config we received, but we don't need AppBridgeProvider
    console.log('[main.jsx] Received initial config:', shopifyConfig);

    ReactDOM.createRoot(document.getElementById('root')).render(
        // Render App directly, without AppProvider
        <App />
    );
}
