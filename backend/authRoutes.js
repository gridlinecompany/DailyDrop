import express from 'express';
import crypto from 'crypto';
import cookie from 'cookie';
import { baseShopifyApi as shopify } from './shopify.js'; // Assuming shopify API is exported as baseShopifyApi
import { Session } from '@shopify/shopify-api';

const router = express.Router();

const OAUTH_STATE_COOKIE_NAME = 'shopify_oauth_state';
const HOST = process.env.HOST;

// Middleware to validate OAuth state parameter against cookie
const validateOAuthState = (req, res, next) => {
    console.log('[/auth/callback] Running validateOAuthState middleware...');
    const { state: queryState } = req.query;
    const rawCookieHeader = req.headers.cookie || '';
    console.log('[/auth/callback] Raw Cookie Header:', rawCookieHeader);

    const cookies = cookie.parse(rawCookieHeader);
    const stateCookie = cookies[OAUTH_STATE_COOKIE_NAME];
    console.log('[/auth/callback] Parsed Cookies:', cookies);
    console.log(`[/auth/callback] Query State: ${queryState}`);
    console.log(`[/auth/callback] Cookie State (${OAUTH_STATE_COOKIE_NAME}): ${stateCookie}`);

    console.log(`[/auth/callback] Clearing cookie: ${OAUTH_STATE_COOKIE_NAME}`);
    res.clearCookie(OAUTH_STATE_COOKIE_NAME, {
        httpOnly: true,
        secure: true,
        sameSite: 'None'
    });

    if (!queryState || !stateCookie || queryState !== stateCookie) {
        console.error('[/auth/callback] OAuth state validation FAILED.', {
             queryState: queryState,
             cookieState: stateCookie,
        });
        return res.status(403).send('Invalid OAuth state: CSRF detected or cookie missing/mismatch.');
    }

    console.log('[/auth/callback] OAuth state validated successfully via manual parse.');
    next();
};

// Shopify Auth Initiation Route
router.get('/', async (req, res) => {
    const shop = req.query.shop;
    const APPROVED_SHOP_DOMAIN = process.env.APPROVED_SHOP_DOMAIN || 'your-store-name.myshopify.com';
    
    if (shop !== APPROVED_SHOP_DOMAIN) {
        console.log(`[/auth] Rejected unauthorized shop: ${shop}. Only ${APPROVED_SHOP_DOMAIN} is allowed.`);
        return res.status(403).send('This application is private and not available for this store.');
    }
    
    if (!shop) {
        console.log('[/auth] Shop parameter missing. Cannot initiate OAuth. Serving enter-shop page.');
        // This part depends on how enter-shop.html is served. Assuming it's not part of this router for now.
        // For simplicity, returning an error. This might need adjustment based on where enter-shop.html lives.
        return res.status(400).send("Shop parameter missing. Cannot initiate OAuth.");
    }

    console.log(`[/auth] Initiating OAuth for shop: ${shop}`);
    try {
        const apiKey = shopify.config.apiKey;
        const scopesString = shopify.config.scopes.toString();
        const encodedScopes = encodeURIComponent(scopesString);
        const redirectUri = `${HOST}/auth/callback`;
        const encodedRedirectUri = encodeURIComponent(redirectUri);

        const state = crypto.randomBytes(16).toString('hex');
        console.log(`[/auth] Generated state nonce: ${state}`);
        res.cookie(OAUTH_STATE_COOKIE_NAME, state, {
            maxAge: 600000,
            httpOnly: true,
            secure: true,
            sameSite: 'None'
        });

        const authUrl = `https://${encodeURIComponent(shop)}/admin/oauth/authorize?client_id=${apiKey}&scope=${encodedScopes}&redirect_uri=${encodedRedirectUri}&state=${state}`;
        console.log(`[/auth] Redirecting to Shopify OAuth URL. Scopes requested: ${scopesString}. State included.`);
        res.redirect(authUrl);

    } catch (error) {
        console.error('[/auth] Error constructing OAuth URL:', error);
        res.status(500).send('Internal Server Error during authentication initiation.');
    }
});

// Shopify Auth Callback Route
router.get(
  '/callback',
  validateOAuthState, // 1. Validate state first
  async (req, res) => {
    console.log('[/auth/callback] State validated. Proceeding with manual token exchange.');
    const { shop, code } = req.query;
    const APPROVED_SHOP_DOMAIN = process.env.APPROVED_SHOP_DOMAIN || 'your-store-name.myshopify.com';
    
    if (shop !== APPROVED_SHOP_DOMAIN) {
        console.log(`[/auth/callback] Rejected unauthorized shop: ${shop}. Only ${APPROVED_SHOP_DOMAIN} is allowed.`);
        return res.status(403).send('This application is private and not available for this store.');
    }
    
    res.clearCookie(OAUTH_STATE_COOKIE_NAME, {
        httpOnly: true,
        secure: true,
        sameSite: 'None'
    });

    if (!shop || !code) {
        console.error('[/auth/callback] Missing shop or code query parameter for token exchange.');
        return res.status(400).send('Invalid callback request: Missing shop or code.');
    }

    try {
        const tokenUrl = `https://${shop}/admin/oauth/access_token`;
        const tokenPayload = {
            client_id: shopify.config.apiKey,
            client_secret: shopify.config.apiSecretKey,
            code: code,
        };

        console.log(`[/auth/callback] Exchanging code for token at: ${tokenUrl}`);
        const tokenResponse = await fetch(tokenUrl, { // Make sure to use 'node-fetch' or ensure global fetch is available
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Accept': 'application/json' 
            },
            body: JSON.stringify(tokenPayload),
        });

        const tokenData = await tokenResponse.json();

        if (!tokenResponse.ok || !tokenData.access_token) {
            console.error('[/auth/callback] Failed to exchange code for token:', tokenData);
            return res.status(tokenResponse.status).send(`Failed to get access token: ${JSON.stringify(tokenData)}`);
        }

        console.log('[/auth/callback] Token exchange successful.');
        console.log(`[/auth/callback] ====> SCOPES RECEIVED FROM SHOPIFY: ${tokenData.scope}`); 
        
        const sessionId = `${shop}_${tokenData.access_token}`; // Simplified session ID for this example
        const session = new Session({
            id: sessionId,
            shop: shop,
            state: 'SOME_STATE_PLACEHOLDER', 
            isOnline: false,
            accessToken: tokenData.access_token,
            scope: tokenData.scope, 
        });
        console.log(`[/auth/callback] Session object PREPARED for storage:`, {
            id: session.id,
            shop: session.shop,
            isOnline: session.isOnline,
            accessTokenPrefix: session.accessToken?.substring(0,5),
            scope: session.scope
        });

        const sessionStorage = shopify.config.sessionStorage; // Access session storage from shopifyApi config
        const stored = await sessionStorage.storeSession(session);
        if (!stored) {
            console.error('[/auth/callback] Failed to store session manually! storeSession returned false.');
            const checkSession = await sessionStorage.loadSession(sessionId);
            console.log('[/auth/callback] Session check immediately after failed storeSession:', checkSession);
            return res.status(500).send('Failed to save session data.');
        }
        console.log('[/auth/callback] storeSession call completed successfully (returned true).');

        const loadedSession = await sessionStorage.loadSession(sessionId);
        if (loadedSession) {
            console.log(`[/auth/callback] ====> Session loaded immediately AFTER storeSession has SCOPE: ${loadedSession.scope}`);
        } else {
            console.error(`[/auth/callback] FAILED to load session ${sessionId} immediately after storing!`);
        }

        const frontendUrl = process.env.FRONTEND_URL;
        if (!frontendUrl) {
            console.error("CRITICAL: FRONTEND_URL environment variable is not set!");
            return res.status(500).send("Internal Server Error: Application frontend URL is not configured.");
        }
        const redirectUrl = `${frontendUrl}/?shop=${encodeURIComponent(shop)}&token=${encodeURIComponent(tokenData.access_token)}`;
        console.log(`[/auth/callback] Redirecting to Frontend URL: ${redirectUrl}`);
        res.redirect(redirectUrl);

    } catch (error) {
        console.error('[/auth/callback] Error during manual token exchange or session storage:', error);
        // Check if fetch is undefined, which can happen if node-fetch is not polyfilled or imported in older Node versions
        if (typeof fetch === 'undefined' && error instanceof TypeError && error.message.includes('fetch is not defined')) {
             console.error('[/auth/callback] \'fetch\' is not defined. Ensure you are using Node.js 18+ or have a fetch polyfill (like node-fetch).');
             return res.status(500).send('Internal Server Error: Fetch API not available.');
        }
        res.status(500).send('Internal Server Error during authentication callback.');
    }
  }
);

export default router; 