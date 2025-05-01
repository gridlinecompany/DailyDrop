import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const supabaseUrl = process.env.SUPABASE_PROJECT_URL;
// Use the SERVICE_ROLE_KEY for backend operations that need full access
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; 

// Validate environment variables
if (!supabaseUrl) {
  console.error('Error: SUPABASE_PROJECT_URL environment variable is not set in backend/.env');
  process.exit(1);
}
if (!supabaseKey) {
  console.error('Error: SUPABASE_SERVICE_ROLE_KEY environment variable is not set in backend/.env');
  // Consider if you want to exit(1) here or allow falling back to anon key for some operations
  console.warn('Warning: SUPABASE_SERVICE_ROLE_KEY is not set. Backend operations requiring elevated privileges might fail.');
  // Optionally fall back to anon key if needed for specific use cases, but generally service key is preferred for backend.
  // supabaseKey = process.env.SUPABASE_ANON_KEY; 
  // if (!supabaseKey) { ... handle missing anon key ... }
  process.exit(1); // Exit if service key is essential
}

// Log the URL being used (without the key)
console.log(`[SupabaseClient] Initializing Supabase client for URL: ${supabaseUrl}`);

// Initialize the Supabase client
// Note: It's often better to create and export the client directly
// rather than a function, to ensure a single instance is reused.
export const supabase = createClient(supabaseUrl, supabaseKey, {
    // Optional: Configure auth persistence if needed for backend scenarios,
    // though typically not required when using service key.
    // auth: {
    //   persistSession: false 
    // }
});

console.log('[SupabaseClient] Backend Supabase client initialized.'); 