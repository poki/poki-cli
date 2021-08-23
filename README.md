poki-cli
========
[![npm](https://img.shields.io/npm/v/@poki/cli.svg?style=flat-square)](https://www.npmjs.com/package/@poki/cli)
[![node](https://img.shields.io/node/v/@poki/cli.svg?style=flat-square)](https://nodejs.org/)
[![license](https://img.shields.io/github/license/poki/poki-cli.svg?style=flat-square)](LICENSE)

Poki for Developers command line utility.

Usage
-----

You can run the command using `npx`:
```sh
npx @poki/cli --help
```

Or you can add this to your `package.json`:
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
And then run:
```sh
npm install
npm run-script poki-upload
```
Or if you are using `yarn`:
```
yarn install
yarn poki-upload
```

Before you can use the `upload` command you will need to create a `poki.json` file with the following content:
```json
{
  "game_id": "c7bfd2ba-e23b-486f-9504-a6f196cb44df",
  "build_dir": "dist"
}
```
Replace `c7bfd2ba-e23b-486f-9504-a6f196cb44df` with your game ID (can be found in the address bar on your game page on https://developers.poki.com/).
And replace `dist` with your build directory. This is the directory that will be uploaded to Poki for Developers.

This can also be done using:
```sh
npx @poki/cli init --game c7bfd2ba-e23b-486f-9504-a6f196cb44df --build-dir dist
```

Or alternatively you can add this to your `package.json`:
```json
{
  "poki": {
    "game_id": "c7bfd2ba-e23b-486f-9504-a6f196cb44df",
    "build_dir": "dist"
  }
}
```

When using the `upload` command for the first time your browser will be opened and you'll be asked to authenticate.
The authentication credentials will be stored in a `$XDG_CONFIG_HOME/poki/auth.json`, `$HOME/.config/poki/auth.json` or `%LOCALAPPDATA%\Poki\auth.json`.

Full usage:
```sh
$ npx @poki/cli --help

Commands:
  poki init    Create a poki.json configuration file
  poki upload  Upload a new version to Poki for Developers

Options:
      --version  Show version number                                                 [boolean]
  -h, --help     Show help                                                           [boolean]

Examples:
  poki init --game c7bfd2ba-e23b-486f-9504-a6f196cb44df --build-dir dist
  poki upload --name "New Version Name"
  poki upload --name "$(git rev-parse --short HEAD)" --notes "$(git log -1 --pretty=%B)"
```
