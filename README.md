# poki-cli
[![npm](https://img.shields.io/npm/v/@poki/cli.svg?style=flat-square)](https://www.npmjs.com/package/@poki/cli)
[![node](https://img.shields.io/node/v/@poki/cli.svg?style=flat-square)](https://nodejs.org/)
[![license](https://img.shields.io/github/license/poki/poki-cli.svg?style=flat-square)](LICENSE)

The [Poki for Developers](https://developers.poki.com/) command line utility allows you to upload game builds directly from your terminal or CI-pipeline.

## Installation

You can run it directly the command using `npx`:
```sh
npx @poki/cli --help
```

Or you can add this to your project's `package.json`:
```json
{
  "scripts": {
    "poki-upload": "poki upload"
  },
  "devDependencies": {
    "@poki/cli": "*"
  }
}
```
And then run `npm install` or `yarn install` to install the dependency.


## Configuration

Before you can upload a build you will need to configure your game ID using the following command:
```sh
npx @poki/cli init --game c7bfd2ba-e23b-486f-9504-a6f196cb44df --build-dir dist
```

Replace `c7bfd2ba-e23b-486f-9504-a6f196cb44df` with your game ID (can be found in the address bar on your game page on https://developers.poki.com/).
And replace `dist` with your build directory. This is the directory that will be uploaded to Poki for Developers.

This will create a `poki.json` file in the root of your project containing the following: 
```json
{
  "game_id": "c7bfd2ba-e23b-486f-9504-a6f196cb44df",
  "build_dir": "dist"
}
```

Alternatively you can add this to your `package.json`:
```json
{
  "poki": {
    "game_id": "c7bfd2ba-e23b-486f-9504-a6f196cb44df",
    "build_dir": "dist"
  }
}
```

## Uploading a build

To upload a new build you can simply run:
```sh
npx @poki/cli upload --name "$(git rev-parse --short HEAD)" --notes "$(git log -1 --pretty=%B)"

# Or if you've configured the scripts in the package.json using npm:
npm run-script poki-upload
# Using yarn
yarn poki-upload
```
Do make sure your game is built correctly in the configured build_dir.

When using the upload command for the first time your browser will be opened and you'll be asked to authenticate.
The authentication credentials will be stored in a `$XDG_CONFIG_HOME/poki/auth.json`, `$HOME/.config/poki/auth.json` or `%LOCALAPPDATA%\Poki\auth.json`.

Also note that a Review still needs to be requested manually on the Poki for Developers platform (for now).

## Full usage

```sh
$ npx @poki/cli --help

Commands:
  poki init    Create a poki.json configuration file
  poki upload  Upload a new version to Poki for Developers

Options:
      --version  Show version number
  -h, --help     Show help

Examples:
  poki init --game c7bfd2ba-e23b-486f-9504-a6f196cb44df --build-dir dist
  poki upload --name "New Version Name"
  poki upload --name "$(git rev-parse --short HEAD)" --notes "$(git log -1 --pretty=%B)"
```
