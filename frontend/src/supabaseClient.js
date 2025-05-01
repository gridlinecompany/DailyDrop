import { createClient } from '@supabase/supabase-js';

// Import environment variables
const supabaseUrl = import.meta.env.VITE_SUPABASE_PROJECT_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Validate that the variables are set
if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    'Supabase URL or Anon Key is missing. ' +
    'Make sure you have VITE_SUPABASE_PROJECT_URL and VITE_SUPABASE_ANON_KEY in your .env file.'
  );
  // You might want to throw an error or handle this case differently
  // depending on your application's needs.
}

// Create and export the Supabase client instance
export const supabase = createClient(supabaseUrl, supabaseAnonKey); 