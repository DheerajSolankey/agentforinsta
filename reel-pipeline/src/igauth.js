import axios from 'axios';

const GRAPH = () => `https://graph.facebook.com/${process.env.GRAPH_API_VERSION || 'v26.0'}`;

/**
 * Verify token + user id. Optionally exchange for a long-lived token.
 * Usage:
 *   node src/index.js check-auth
 *   node src/index.js check-auth refresh
 */
export async function checkAuth(mode = 'check') {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const userId = process.env.INSTAGRAM_USER_ID;

  if (!token || !userId) {
    console.error('❌ Missing INSTAGRAM_ACCESS_TOKEN or INSTAGRAM_USER_ID in .env');
    process.exit(1);
  }

  if (mode === 'refresh') {
    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    if (!appId || !appSecret) {
      console.error('❌ refresh needs FACEBOOK_APP_ID and FACEBOOK_APP_SECRET in .env');
      process.exit(1);
    }
    try {
      const { data } = await axios.get(`${GRAPH()}/oauth/access_token`, {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: appId,
          client_secret: appSecret,
          fb_exchange_token: token,
        },
        timeout: 15000,
      });
      console.log('✅ Long-lived token (≈60 days):');
      console.log(data.access_token);
      console.log('\nPaste it into .env as INSTAGRAM_ACCESS_TOKEN');
      return data;
    } catch (err) {
      console.error('❌ Refresh failed:', err.response?.data || err.message);
      process.exit(1);
    }
  }

  try {
    const { data } = await axios.get(`${GRAPH()}/debug_token`, {
      params: { input_token: token, access_token: token },
      timeout: 15000,
    });
    const info = data.data || {};
    console.log(`Valid: ${info.is_valid ? '✅' : '❌'}`);
    console.log(`App ID: ${info.app_id || '-'}`);
    console.log(`User ID: ${info.user_id || '-'}`);
    console.log(`Expires: ${info.expires_at ? new Date(info.expires_at * 1000).toISOString() : 'never/unknown'}`);
    console.log(`Scopes: ${(info.scopes || []).join(', ') || '-'}`);

    if (!info.is_valid) {
      console.error('\nToken invalid — run: node src/index.js check-auth refresh');
      process.exit(1);
    }

    const need = ['instagram_content_publish', 'instagram_basic'];
    const scopes = info.scopes || [];
    const missing = need.filter((s) => !scopes.includes(s));
    if (missing.length) {
      console.warn(`⚠ Missing scopes: ${missing.join(', ')}`);
    }

    // Verify user id responds
    const { data: user } = await axios.get(`${GRAPH()}/${userId}`, {
      params: { fields: 'id,username,media_count', access_token: token },
      timeout: 15000,
    });
    console.log(`Account: @${user.username || '?'} media=${user.media_count ?? '?'}`);
    console.log('✅ Auth OK');
  } catch (err) {
    console.error('❌ Auth check failed:', err.response?.data || err.message);
    process.exit(1);
  }
}
