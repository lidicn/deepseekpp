import type { SyncConfig, WebdavSyncConfig } from '../types';
import { createGDriveBackend } from './gdrive-client';
import { createOneDriveBackend } from './onedrive-client';
import {
  defaultSyncErrorTranslator,
  type SyncErrorTranslator,
} from './oauth-client';
import type { StorageBackend } from './storage-backend';
import { webdavGet, webdavMkcol, webdavPut, webdavTest } from './webdav-client';

export function createStorageBackend(
  config: SyncConfig,
  t: SyncErrorTranslator = defaultSyncErrorTranslator,
): StorageBackend {
  switch (config.provider) {
    case 'webdav':
      return new WebdavBackend(config);
    case 'gdrive':
      return createGDriveBackend(config, t);
    case 'onedrive':
      return createOneDriveBackend(config, t);
  }
}

class WebdavBackend implements StorageBackend {
  constructor(private readonly config: WebdavSyncConfig) {}

  async test(): Promise<void> {
    await webdavTest(this.config);
  }

  async ensureStore(): Promise<void> {
    await webdavMkcol(this.config);
  }

  async get(key: string): Promise<string | null> {
    return webdavGet(this.config, key);
  }

  async put(key: string, content: string): Promise<void> {
    // #77: put 前确保远程目录存在 —— 上次 ensureStore 可能是很久之前，
    // 管理员删了远程目录、或跨设备首次 put 都会 409。webdavMkcol 幂等
    // （405 已存在也放行），每次 put 前调一次代价可忽略。
    await webdavMkcol(this.config);
    await webdavPut(this.config, key, content);
  }
}
