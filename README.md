# Flow Image Generator

A Chrome extension built with [WXT](https://wxt.dev/) and React. It reads a scene-based JSON script, sends each image prompt to Google Flow, tracks generation progress, and downloads the resulting images.

## Requirements

- Node.js (version 22 recommended)
- npm

## Install dependencies

```bash
npm ci
```

## Development

Start the development browser with hot reload:

```bash
npm run dev
```

WXT opens a dedicated browser profile with the development extension installed. If you close that browser, press `o` and then Enter in the terminal to reopen it.

## Build for Chrome

Create a production build:

```bash
npm run build
```

The unpacked extension is generated in `.output/chrome-mv3`.

To install it in Chrome:

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `.output/chrome-mv3` directory.

## Type-check

Run the TypeScript compiler without emitting files:

```bash
npm run compile
```

## Using the extension

1. Open Google Flow and enter a project.
2. Open the Flow Image Generator extension.
3. Upload a JSON script containing a `scenes` array.
4. Start generation and monitor each scene in the queue.
5. Generated images are downloaded automatically when Flow returns the corresponding results.

> Note: Google Flow integration requires an authenticated browser session. Flow's interface and internal response formats may change over time.
