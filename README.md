# Flow Image Generator

Flow Image Generator is a Chrome extension built with [WXT](https://wxt.dev/) and React. It reads a JSON scene script, sends each scene's image prompt to the Flow interface, tracks generation progress, and downloads the resulting images into organized folders.

## Requirements

- Node.js (LTS recommended)
- npm or pnpm
- Google Chrome
- Access to the Google Flow website

## Installation

Clone the repository and install its dependencies:

```bash
git clone https://github.com/Paralon2024/flow-image-generator.git
cd flow-image-generator
npm install
```

You can use `pnpm install` if you prefer pnpm.

## Development

Start the development browser with:

```bash
npm run dev
```

WXT starts a local development server and opens a dedicated browser profile with the extension installed. Changes are reloaded during development.

To reopen the test browser after closing it, press `o` and then Enter in the terminal running the development command.

## Build for Chrome

Create a production build:

```bash
npm run build
```

The Chrome extension build is generated in:

```
.output/chrome-mv3
```

To create a distributable ZIP archive, run:

```bash
npm run zip
```

## Load the extension manually

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `.output/chrome-mv3` directory.

The extension will now appear in Chrome.

## Using the extension

1. Open Google Flow in Chrome.
2. Click the Flow Image Generator extension icon.
3. Upload a JSON script containing a top-level `scenes` array.
4. Each scene must include a `scene_number` and an `image_prompt` object.
5. Click **Start Generation** and monitor the queue in the popup.
6. Generated images are downloaded under `Flow_Generations/Scene_XX/`.

See `script.json` for a complete example of the expected JSON structure.

## Available scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Chrome development environment |
| `npm run build` | Build the Chrome extension |
| `npm run zip` | Package the Chrome extension as a ZIP |
| `npm run compile` | Run the TypeScript compiler checks |
| `npm run dev:firefox` | Start the Firefox development environment |
| `npm run build:firefox` | Build the Firefox extension |

## Notes

This project interacts with the Google Flow website. Changes to Flow's interface or internal request format may affect compatibility.
