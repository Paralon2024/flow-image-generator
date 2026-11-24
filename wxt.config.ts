import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Flow Image Generator',
    version: '1.0.0',
    description: 'Generate images in Google Flow from scene prompts and automatically organize downloads.',
    permissions: ['scripting', 'activeTab', 'downloads', 'debugger'],
    action: {
      default_popup: 'popup.html',
      default_title: 'Flow Image Generator'
    }
  }
});
