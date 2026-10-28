import type { JacksonOption } from '../../src/typings';
import { jacksonOptions } from '../utils';

const url = process.env.DSYNC_TEST_DATABASE_URL;
if (url && !['localhost', '127.0.0.1'].includes(new URL(url).hostname)) {
  throw new Error('Directory-sync regression databases must be local disposable fixtures.');
}

export const dsyncOptions: JacksonOption = url
  ? {
      ...jacksonOptions,
      db: { engine: 'sql', type: 'postgres', url, encryptionKey: '0123456789abcdef0123456789abcdef' },
    }
  : jacksonOptions;
