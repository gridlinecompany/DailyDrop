import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
// Temporarily comment out legacy plugin import
// import legacy from '@vitejs/plugin-legacy'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Load env variables based on the mode (development/production)
  // process.cwd() should point to the 'frontend' directory when running npm run build
  // The third argument '' loads all env vars, not just those prefixed with VITE_
  const env = loadEnv(mode, process.cwd(), '');
  // Get the ngrok host from environment variable or replace manually
  // IMPORTANT: Make sure this matches your CURRENT ngrok URL subdomain!
  const HMR_HOST = env.VITE_HMR_HOST || '4383-47-145-133-162.ngrok-free.app'; 

  return {
    // Explicitly pre-bundle @shopify/polaris to avoid potential dev server issues
    optimizeDeps: {
      include: ['@shopify/polaris'],
    },
    plugins: [
      react({
        jsxRuntime: 'automatic',
        jsxImportSource: 'react'
      }),
      // Temporarily comment out legacy plugin usage
      /*
      legacy({
        targets: ['defaults', 'not IE 11']
      })
      */
    ],
    // Restore the define block
    define: {
      'import.meta.env.SHOPIFY_API_KEY': JSON.stringify(env.SHOPIFY_API_KEY)
    },
    // Add build configuration
    build: {
      target: 'es2015', // Target older browsers
      polyfillModulePreload: true, // Add polyfill for module preloading
    },
    // Add server configuration
    server: {
      host: '0.0.0.0', // Listen on all network interfaces
      cors: true, 
      // Optional: If Vite is running on a different machine or Docker, expose it
      // host: true, 
      port: 5173, // Default Vite port
      // Temporarily disable HMR configuration
      /*
      hmr: {
        protocol: 'wss', // Use secure websockets
        host: HMR_HOST,  // Your ngrok public host
        // port: 443,    // REMOVE: Let ngrok handle port mapping
        path: '/vite-hmr', // Use a specific path for HMR WebSocket
      },
      */
    }
  }
})
