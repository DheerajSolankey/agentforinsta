import axios from 'axios';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const INSTAGRAM_API = 'https://graph.instagram.com';
const POSTED_FILE = './config/posted-history.json';

export class InstagramPublisher {
  constructor(accessToken, userId) {
    this.accessToken = accessToken;
    this.userId = userId;
  }

  async publishImageDirect(imageUrl, caption, slug) {
    console.log(`  📤 Creating container...`);
    console.log(`  🖼 Image URL: ${imageUrl}`);
    
    try {
      const createResp = await axios.post(`${INSTAGRAM_API}/${this.userId}/media`, null, {
        params: {
          image_url: imageUrl,
          caption: caption,
          access_token: this.accessToken
        }
      });
      console.log(`  📦 Container: ${createResp.data.id}`);
      return await this.waitForAndPublish(createResp.data.id);
    } catch (err) {
      if (err.response?.data?.error?.message) {
        console.log(`  ❌ API Error: ${err.response.data.error.message}`);
      }
      throw err;
    }
  }

  async waitForAndPublish(containerId) {
    let status = '';
    let attempts = 0;
    while (attempts < 40) {
      const checkResp = await axios.get(`${INSTAGRAM_API}/${containerId}`, {
        params: { fields: 'status_code', access_token: this.accessToken }
      });
      status = checkResp.data.status_code;
      
      if (status === 'FINISHED') break;
      if (status === 'ERROR') throw new Error('Container processing error');
      
      await new Promise(r => setTimeout(r, 2000));
      attempts++;
    }

    if (status !== 'FINISHED') throw new Error('Container timeout');

    console.log(`  🚀 Publishing...`);
    const pubResp = await axios.post(`${INSTAGRAM_API}/${this.userId}/media_publish`, null, {
      params: { creation_id: containerId, access_token: this.accessToken }
    });

    return pubResp.data.id;
  }

  async getRecentPosts() {
    const resp = await axios.get(`${INSTAGRAM_API}/${this.userId}/media`, {
      params: {
        fields: 'id,caption,media_type,timestamp,like_count,comments_count',
        limit: 10,
        access_token: this.accessToken
      }
    });
    return resp.data.data;
  }

  async getInsights() {
    try {
      const resp = await axios.get(`${INSTAGRAM_API}/${this.userId}/insights`, {
        params: {
          metric: 'impressions,reach,follower_count',
          period: 'day',
          access_token: this.accessToken
        }
      });
      return resp.data.data;
    } catch (err) {
      return null;
    }
  }
}
