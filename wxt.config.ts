import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Flow Image Generator',
    description: 'Generate and download images from Google Flow using JSON scene scripts.',
    permissions: ['scripting', 'activeTab', 'downloads']
  }
});
