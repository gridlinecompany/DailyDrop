import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
// AppProvider is not used if not using App Bridge
// import { AppProvider } from '@shopify/polaris'; 
// import enTranslations from '@shopify/polaris/locales/en.json'; 
import '@shopify/polaris/build/esm/styles.css'; // Keep styles
import './index.css';

// --- REMOVED window.shopify CHECK --- 
// The necessary shop parameter is retrieved from the URL within App.jsx
// The API key is handled by the backend during API calls using the session token.

console.log('[main.jsx] Rendering App component.');

ReactDOM.createRoot(document.getElementById('root')).render(
    // Render App directly
    // <React.StrictMode> // Optional: Add StrictMode if desired
        <App />
    // </React.StrictMode>
);
