import axios from 'axios';
import { createReadStream, statSync } from 'fs';

const GRAPH = () => `https://graph.facebook.com/${process.env.GRAPH_API_VERSION || 'v26.0'}`;
const RUPLOAD = (version, containerId) =>
  `https://rupload.facebook.com/ig-api-upload/${version}/${containerId}`;

/**
 * Publish a local Reel via Meta resumable upload:
 * 1) POST /{ig-user-id}/media?media_type=REELS&upload_type=resumable
 * 2) POST rupload.facebook.com/ig-api-upload/... (file binary)
 * 3) poll status_code until FINISHED
 * 4) POST /media_publish
 */
export class InstagramPublisher {
  constructor(accessToken, userId) {
    this.accessToken = accessToken;
    this.userId = userId;
    this.version = process.env.GRAPH_API_VERSION || 'v26.0';
  }

  async createResumableContainer(caption, { thumbOffset, coverUrl, audioName } = {}) {
    const params = {
      media_type: 'REELS',
      upload_type: 'resumable',
      access_token: this.accessToken,
    };
    if (caption) params.caption = caption;
    if (thumbOffset != null) params.thumb_offset = thumbOffset;
    if (coverUrl) params.cover_url = coverUrl;
    if (audioName) params.audio_name = audioName;

    const { data } = await axios.post(`${GRAPH()}/${this.userId}/media`, null, {
      params,
      timeout: 30000,
    });
    if (!data?.id) throw new Error('No container id returned');
    return data;
  }

  async uploadFile(containerId, filePath) {
    const size = statSync(filePath).size;
    const version = this.version;
    const resp = await axios.post(RUPLOAD(version, containerId), createReadStream(filePath), {
      headers: {
        Authorization: `OAuth ${this.accessToken}`,
        offset: '0',
        file_size: String(size),
        'Content-Type': 'application/octet-stream',
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 600000,
    });
    return resp.data;
  }

  async waitForFinished(containerId, { attempts = 60, delayMs = 2000 } = {}) {
    let status = '';
    for (let i = 0; i < attempts; i++) {
      const { data } = await axios.get(`${GRAPH()}/${containerId}`, {
        params: { fields: 'status_code,status', access_token: this.accessToken },
        timeout: 15000,
      });
      status = data.status_code;
      if (status === 'FINISHED' || status === 'PUBLISHED') return status;
      if (status === 'ERROR') throw new Error(data.status || 'Container processing error');
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error(`Container timeout (last status: ${status || 'unknown'})`);
  }

  async publish(containerId) {
    const { data } = await axios.post(
      `${GRAPH()}/${this.userId}/media_publish`,
      null,
      {
        params: { creation_id: containerId, access_token: this.accessToken },
        timeout: 30000,
      }
    );
    return data.id;
  }

  /** Full flow: local mp4 → published media id */
  async publishReel(videoPath, caption, coverPath) {
    console.log(`  📦 Creating REELS container…`);
    const container = await this.createResumableContainer(caption);
    const containerId = container.id;
    console.log(`  📦 Container: ${containerId}`);

    console.log(`  ⬆️  Uploading ${(statSync(videoPath).size / 1e6).toFixed(1)} MB…`);
    await this.uploadFile(containerId, videoPath);
    console.log(`  ⬆️  Upload sent`);

    console.log(`  ⏳ Waiting for processing…`);
    await this.waitForFinished(containerId);
    console.log(`  🚀 Publishing…`);

    const mediaId = await this.publish(containerId);
    return mediaId;
  }

  async getRecentPosts(limit = 10) {
    const { data } = await axios.get(`${GRAPH()}/${this.userId}/media`, {
      params: {
        fields: 'id,caption,media_type,media_product_type,timestamp,like_count,comments_count',
        limit,
        access_token: this.accessToken,
      },
      timeout: 15000,
    });
    return data.data || [];
  }
}
