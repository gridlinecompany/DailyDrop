import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

// Workaround for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use the same database file as the session storage
const DB_PATH = path.join(__dirname, 'database.sqlite'); 

// Use verbose mode for detailed logging during development
const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error('[db.js] Error connecting to SQLite database:', err.message);
    } else {
        console.log('[db.js] Connected to the SQLite database.');
        initializeDatabase();
    }
});

// Function to initialize tables if they don't exist
function initializeDatabase() {
    db.run(`
        CREATE TABLE IF NOT EXISTS daily_drops (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            productId TEXT NOT NULL,  -- Using TEXT for GID format like gid://shopify/Product/12345
            variantId TEXT,           -- Optional variant GID
            dropDate TEXT NOT NULL,   -- Store as ISO 8601 date string (YYYY-MM-DD)
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) {
            console.error('[db.js] Error creating daily_drops table:', err.message);
        } else {
            console.log('[db.js] daily_drops table verified/created successfully.');
        }
    });

    // Add other table initializations here if needed later
}

// Export the database connection instance
export default db; 