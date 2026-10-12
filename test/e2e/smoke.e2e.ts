import { expect } from '@wdio/globals';
import { pluginId, reloadPlugin } from './load';
describe('Standard Notes Import load', () => {
 it('loads and reloads without console errors', async () => {
  expect(await reloadPlugin(pluginId)).toEqual({ enabled: true, reloaded: true, errors: [] });
 });
});
